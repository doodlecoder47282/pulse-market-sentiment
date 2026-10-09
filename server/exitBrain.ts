// server/exitBrain.ts
//
// Exit Brain — tune-to-tick exit/stop engine for tracked 0DTE positions.
//
// Goal (user spec, verbatim):
//   "we need to be able to trade 100k to 200k with minimal losses"
//   "typically I do -20% stop outs max but this should be able to sense
//    when to get in and out before even hitting that ideally using SMAs
//    15 - 20 - 21 13 ema 15 min 5 min 1 min 30 min 1 hr 4 hr charts to
//    see how it's setting up with are model real time reversions over
//    extensions VIX levels all take into account"
//
// Architecture:
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ odteTracker.getTracked()  →  active positions (registry)        │
//   └────────────────────────────┬────────────────────────────────────┘
//                                │
//                                ▼  every 30s during RTH
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ for each active position:                                       │
//   │   1) live BID: Schwab stream quote, else tracker REST chain row  │
//   │   2) stop: bid <= 0.80 x entry ask (the alert's printed rule)   │
//   │   3) HARD STOP hit  →  EXIT (also swept on every skipped tick)  │
//   │   4) DYNAMIC STOP: 5-cat confluence score                       │
//   │      a) MTF stack collapse against side                         │
//   │      b) Reversion threat (VWAP bands + RSI(2))                  │
//   │      c) Realtime targets reached (compressed bull/bear hit)     │
//   │      d) VIX spike against side                                  │
//   │      e) Gamma-zone flip / wall break                            │
//   │   5) score → action: HOLD | TRIM | EXIT | TRAIL                 │
//   └─────────────────────────────────────────────────────────────────┘
//
// Read-only on tracker (uses getTracked + lastSnapshot.contracts to read marks).
// Eval results are kept in-memory + exposed via /api/exit-brain/snapshot.
// All Discord posting is gated behind an opt-in flag (default OFF until
// user wires the alert channel).
//
// Try/catch wrapped at every external surface. Pure-function eval per tick.

import { getTracked, getOdteSnapshot, type TrackedPosition, type Side } from "./odteTracker";
import { getMtfStack, isStackCollapse } from "./mtfStack";
import { getRevExtSnapshot, isReversionThreat } from "./revExtClassifier";
import { computeRealtimeTargets } from "./realtimeTargets";
import { streamOptionOverlay } from "./streamStore";
import { callInternal } from "./internalApi";
import { entryFillOf, liquidationReturn, optionStopHit, PLAN_OPTION_STOP_PCT, type EntryBasis } from "./exitValuation";
import { feeForProduct } from "./feeConfig";
import { exitBidUsable } from "./exitQuoteAge";

// ─── Types ────────────────────────────────────────────────────────────

/** NO_QUOTE: no bid to sell at, so the stop and P&L cannot be evaluated (never shown as HOLD at 0%). */
export type ExitAction = "HOLD" | "TRIM" | "EXIT" | "TRAIL" | "NO_QUOTE";

export interface ExitBrainEval {
  positionId: string;
  contractKey: string;
  side: Side;
  /** Price used for this eval: the live BID (what the position can be sold at). Null without a bid. */
  mark: number | null;
  /** "stream": Schwab Streamer LEVELONE_OPTIONS at its quote time; "rest_chain": tracker's last Schwab chain poll; null: no quote. */
  markSource?: "stream" | "rest_chain" | null;
  /** Schwab quote time behind the bid, epoch ms (null when unknown). */
  markQuoteTimeMs?: number | null;
  /** Age of that quote at eval time, ms (null when unknown). */
  markAgeMs?: number | null;
  /** Why no usable bid (NO_QUOTE): none, unknown age, or older than REST_BID_MAX_AGE_MS. */
  noQuoteReason?: string | null;
  /** Entry fill, $ per share: the ask at arm when logged, else the last print at arm (entryBasis). */
  entry: number;
  entryBasis?: EntryBasis;
  /** DISPLAYED P&L: net return if sold at the bid now, after the exit fee, on cash paid incl. the entry fee; FRACTION. Null without a bid or a configured fee (index roots). */
  drawdownPct: number | null;
  /** Decision basis (the alert's rule, before fees): (bid - entry) / entry. The -20% stop fires at <= -0.20. Null without a bid. */
  bidReturnPct?: number | null;
  feeBasis?: string;
  /** Live quote (additive). */
  bid?: number | null;
  ask?: number | null;
  /** "bid_net_of_exit_fee" (review item 6.6). */
  valuation?: string;
  feePerContract?: number;
  /** Peak unrealized return seen during the position's life, signed pct */
  peakReturnPct: number;
  /** Action verdict */
  action: ExitAction;
  /** 0..100 — higher = more reasons to exit. */
  exitScore: number;
  /** Per-category contributions (0..100 each) */
  categories: {
    hardStop: number;        // hit −20% → 100, else 0
    stackCollapse: number;   // 0..100 from mtfStack composite (against side)
    reversion: number;       // 0..100 from revExt reversionRiskForX
    targetsHit: number;      // 0/40/100 — at/past compressed bull or bear
    vixSpike: number;        // 0..100 based on VIX move % since entry
    gammaFlip: number;       // 0/60/100 — wall broken against side
    hazard: number;          // 0..100 — conditional win prob below breakeven (hazard engine)
  };
  /** Top 1–3 reasons in plain English */
  reasons: string[];
  /** Eval timestamp */
  asOf: number;
}

export interface ExitBrainSnapshot {
  asOf: number;
  running: boolean;
  intervalMs: number;
  evals: ExitBrainEval[];
  config: {
    hardStopPct: number;
    trimScore: number;
    exitScore: number;
    trailScore: number;
  };
  diagnostics: {
    lastTickMs: number;
    ticks: number;
    errors: number;
    lastError?: string;
    /** Ticks skipped because the previous full pass was still running. */
    skippedTicks?: number;
  };
  /** Positions at or past the hard stop, from live marks only (independent of /api/models). */
  hardStopHits?: Array<{ positionId: string; contractKey: string; mark: number; returnPct: number; asOf: number }>;
}

// ─── Config ───────────────────────────────────────────────────────────

const HARD_STOP_PCT = -PLAN_OPTION_STOP_PCT; // bid <= 0.80 x entry ask (alert's printed rule, before fees) → instant exit
const EVAL_INTERVAL_MS = 30_000;   // 30s cadence (user spec)

// Score thresholds (0..100):
//   < TRIM_SCORE       →  HOLD
//   TRIM_SCORE..EXIT   →  TRIM (cut half)
//   ≥ EXIT_SCORE       →  EXIT (close all)
//   any time peakReturn ≥ 0.40 AND drawdown ≤ peak − 0.15 → TRAIL takeover
const TRIM_SCORE = 55;
const EXIT_SCORE = 75;
const TRAIL_SCORE = 50; // when peakReturnPct ≥ 0.40 trim score floor drops

// Category weights (sum doesn't have to = 100 — the score is a weighted blend)
const W = {
  hardStop: 1.00,        // takes over completely when triggered
  stackCollapse: 0.30,
  reversion: 0.25,
  targetsHit: 0.20,
  vixSpike: 0.15,
  gammaFlip: 0.10,
  hazard: 0.20,          // survival-curve pressure from the hazard engine
} as const;

// ─── In-memory state ──────────────────────────────────────────────────

interface PositionMemory {
  peakReturnPct: number;
  vixAtEntry: number | null;
  lastEvalScore: number;
}

const memory = new Map<string, PositionMemory>();
let evals: ExitBrainEval[] = [];
let timer: NodeJS.Timeout | null = null;
let ticks = 0;
let errors = 0;
let lastError = "";
let lastTickMs = 0;
// In-process call timeouts (were unbounded local HTTP): /api/models is a heavy
// rebuild on a cold cache, quotes are light. Matches discordScheduler's bounds.
const MODELS_CALL_TIMEOUT_MS = 30_000;
const QUOTES_CALL_TIMEOUT_MS = 4_000;
// One evaluation pass at a time: a slow pass must not stack timers.
let evalInFlight = false;
let skippedTicks = 0;
// Hard-stop sweep: computed from the live marks only (no /api/models), every
// tick, including ticks skipped because a full pass is still running.
let hardStopHits: Array<{ positionId: string; contractKey: string; mark: number; returnPct: number; asOf: number }> = [];

// ─── Helpers ──────────────────────────────────────────────────────────

async function getVix(): Promise<number | null> {
  try {
    // In-process /api/quotes (internalApi.ts); body read as before.
    const d: any = (await callInternal("/api/quotes", { timeoutMs: QUOTES_CALL_TIMEOUT_MS })).body;
    return Number(d?.vix?.price ?? null) || null;
  } catch {
    return null;
  }
}

/**
 * Live bid/ask for a contract (the bid is what a long position can be sold
 * at): the Schwab Streamer LEVELONE_OPTIONS quote when the contract is
 * streamed and newer than the tracker's chain poll, else the tracker's last
 * Schwab chain row. No bid -> null (NO_QUOTE upstream), never a mid or last.
 */
function getLiveQuote(contractKey: string, nowMs: number = Date.now()): {
  bid: number | null; ask: number | null; source: "stream" | "rest_chain" | null; quoteTimeMs: number | null;
  ageMs: number | null; noQuoteReason: string | null;
} {
  const raw = getRawQuote(contractKey);
  // R3-2 item 9: a REST chain bid past REST_BID_MAX_AGE_MS (or of unknown
  // age) is not a bid to decide on: NO_QUOTE upstream.
  const u = exitBidUsable(raw.source, raw.bid, raw.quoteTimeMs, nowMs);
  if (!u.usable) return { bid: null, ask: null, source: null, quoteTimeMs: raw.quoteTimeMs, ageMs: u.ageMs, noQuoteReason: u.reason };
  return { ...raw, ageMs: u.ageMs, noQuoteReason: null };
}

function getRawQuote(contractKey: string): { bid: number | null; ask: number | null; source: "stream" | "rest_chain" | null; quoteTimeMs: number | null } {
  const snap = getOdteSnapshot();
  const row = snap.contracts.find((c) => c.key === contractKey);
  if (!row) return { bid: null, ask: null, source: null, quoteTimeMs: null };
  const clean = (b: number | null | undefined, a: number | null | undefined) => ({
    bid: b != null && Number.isFinite(b) && b >= 0 ? b : null,
    ask: a != null && Number.isFinite(a) && a > 0 ? a : null,
  });
  const sq = streamOptionOverlay(row.optionSymbol ?? null, row.quoteTimeMs ?? null);
  if (sq && sq.bid != null) {
    const q = clean(sq.bid, sq.ask ?? row.ask);
    if (q.bid != null) return { ...q, source: "stream", quoteTimeMs: sq.quoteTimeMs };
  }
  const q = clean(row.bid, row.ask);
  return { ...q, source: q.bid != null ? "rest_chain" : null, quoteTimeMs: row.quoteTimeMs ?? null };
}

// ─── Per-position eval ────────────────────────────────────────────────

async function evaluatePosition(pos: TrackedPosition): Promise<ExitBrainEval> {
  const asOf = Date.now();

  // Memory init
  if (!memory.has(pos.id)) {
    memory.set(pos.id, {
      peakReturnPct: 0,
      vixAtEntry: await getVix(),
      lastEvalScore: 0,
    });
  }
  const mem = memory.get(pos.id)!;

  // Review 6.6 / SF-3: decisions use the live BID (stream, else REST chain)
  // against the entry ask with the alert's rule, before fees (bid <= 0.80 x
  // ask stops); the displayed P&L is the bid net of both fees.
  const live = getLiveQuote(pos.contractKey);
  const quote = live;
  const { fill: entry, basis: entryBasis } = entryFillOf(pos);
  const feeRes = feeForProduct(pos.contractKey);
  const liq = liquidationReturn({ entryFill: entry, bid: quote.bid, feePerContract: feeRes.fee });
  const mark = quote.bid;
  const ret: number | null = mark != null && entry > 0 ? (mark - entry) / entry : null;
  const stopHit = optionStopHit(mark, entry);
  if (ret != null && ret > mem.peakReturnPct) mem.peakReturnPct = ret;

  // Map option side ("call"/"put") → underlying directional side ("long"/"short")
  const underlyingSide: "long" | "short" = pos.side === "call" ? "long" : "short";

  // ─── Category 1: HARD STOP ─────────────────────────────────────────
  const hardStop = stopHit === true ? 100 : 0;

  // ─── Category 2: MTF STACK COLLAPSE ────────────────────────────────
  let stackCollapseScore = 0;
  let stackReason = "";
  try {
    const stack = await getMtfStack("$SPX");
    const c = isStackCollapse(stack, underlyingSide);
    // Score: invert composite. composite=100 means perfect for side → 0 exit pressure.
    // composite=0 means total collapse → 100 exit pressure.
    const composite =
      underlyingSide === "long" ? stack.compositeForLong : stack.compositeForShort;
    stackCollapseScore = Math.max(0, Math.min(100, 100 - composite));
    if (c.collapsed) stackReason = c.reason;
  } catch {
    // skip silently
  }

  // ─── Category 3: REVERSION THREAT ──────────────────────────────────
  let reversionScore = 0;
  let reversionReason = "";
  try {
    const rx = await getRevExtSnapshot("$SPX");
    const r = isReversionThreat(rx, underlyingSide);
    reversionScore = r.score;
    if (r.threat) reversionReason = r.reason;
  } catch {
    // skip silently
  }

  // ─── Category 4: REALTIME TARGETS HIT ──────────────────────────────
  // If SPX has hit / passed the compressed bull (calls) or bear (puts)
  // target → strong exit signal. At 50% of distance → mild.
  let targetsScore = 0;
  let targetsReason = "";
  try {
    // In-process /api/models (internalApi.ts), bounded; skipped once the hard
    // stop has fired (it overrides every other category).
    const data: any = hardStop >= 100 ? null : (await callInternal("/api/models?symbol=^GSPC&experimental=1", { timeoutMs: MODELS_CALL_TIMEOUT_MS })).body;
    const daily = data?.horizons?.daily;
    if (daily) {
      const rt = await computeRealtimeTargets({
        spot: daily.spot,
        scenarioTargets: daily.audit?.scenarioTargets ?? {
          bull: daily.spot,
          base: daily.spot,
          bear: daily.spot,
          oneDayEM: 0,
        },
        audit: daily.audit ?? {},
        symbol: "^GSPC",
      });
      const spot = daily.spot as number;
      const target = underlyingSide === "long" ? rt.compressed.bull : rt.compressed.bear;
      const base = rt.compressed.base;
      const distFromBase = Math.abs(target - base) || 1;
      const traveled = underlyingSide === "long" ? spot - base : base - spot;
      const frac = Math.max(0, traveled / distFromBase);
      if (frac >= 1.0) {
        targetsScore = 100;
        targetsReason = `at compressed ${underlyingSide === "long" ? "bull" : "bear"} target ~${target.toFixed(0)}`;
      } else if (frac >= 0.7) {
        targetsScore = 55;
        targetsReason = `near compressed target (${Math.round(frac * 100)}%)`;
      } else if (frac >= 0.5) {
        targetsScore = 30;
      } else {
        targetsScore = 0;
      }
    }
  } catch {
    // skip silently
  }

  // ─── Category 5a: VIX MOVE AGAINST SIDE ────────────────────────────
  // CRITICAL: VIX up is BAD for calls (longs), GOOD for puts (shorts).
  // We score EXIT PRESSURE, so only penalize the ADVERSE direction:
  //   - calls/longs:  adverse = +dv  (VIX rising hurts)
  //   - puts/shorts:  adverse = -dv  (VIX falling hurts — VIX rising HELPS, no exit pressure)
  // adverse is clamped at 0 so favorable VIX moves never add exit pressure.
  let vixScore = 0;
  let vixReason = "";
  try {
    const v = await getVix();
    if (v != null && mem.vixAtEntry != null && mem.vixAtEntry > 0) {
      const dv = (v - mem.vixAtEntry) / mem.vixAtEntry;
      const adverse = underlyingSide === "long" ? dv : -dv;
      // Honest VIX direction text (regardless of side) for the reason
      const vixDirText = `VIX ${dv >= 0 ? "+" : ""}${(dv * 100).toFixed(0)}% since entry`;
      if (adverse >= 0.10) {
        vixScore = 100;
        vixReason = `${vixDirText} (adverse for ${underlyingSide === "long" ? "calls" : "puts"})`;
      } else if (adverse >= 0.05) {
        vixScore = 60;
        vixReason = `${vixDirText} (adverse for ${underlyingSide === "long" ? "calls" : "puts"})`;
      } else if (adverse >= 0.03) {
        vixScore = 30;
      }
      // Favorable VIX (adverse < 0) → vixScore stays 0 (puts benefit from VIX up)
    }
  } catch {
    // skip silently
  }

  // ─── Category 5b: GAMMA FLIP / WALL BREAK ──────────────────────────
  let gammaScore = 0;
  let gammaReason = "";
  try {
    // In-process /api/models (internalApi.ts), bounded; skipped once the hard
    // stop has fired (it overrides every other category).
    const data: any = hardStop >= 100 ? null : (await callInternal("/api/models?symbol=^GSPC&experimental=1", { timeoutMs: MODELS_CALL_TIMEOUT_MS })).body;
    const daily = data?.horizons?.daily;
    if (daily) {
      const spot = daily.spot as number;
      const rb = daily.rangeBox;
      if (rb) {
        if (underlyingSide === "long" && rb.status === "breakdown") {
          gammaScore = 100;
          gammaReason = `range breakdown below ${rb.low.toFixed(0)}`;
        } else if (underlyingSide === "short" && rb.status === "breakout") {
          gammaScore = 100;
          gammaReason = `range breakout above ${rb.high.toFixed(0)}`;
        }
      }
      // Gamma zone flip: y/y+ (positive gamma pin) flipping to y- against you
      const zone = String(daily.audit?.gammaZone ?? "").toLowerCase();
      if (underlyingSide === "long" && zone === "y-") gammaScore = Math.max(gammaScore, 60);
      if (underlyingSide === "short" && zone === "y+") gammaScore = Math.max(gammaScore, 60);
    }
  } catch {
    // skip silently
  }

  // ─── Composite score ──────────────────────────────────────────────
  // ── Category 6: HAZARD ENGINE (survival curve) ──
  // Conditional p(target before stop | still alive N minutes in) vs the
  // breakeven probability for a +50%/-20% option-space bracket. When the
  // tape says remaining win probability has decayed below breakeven,
  // holding is -EV regardless of how it feels.
  let hazardScore = 0;
  let hazardReason = "";
  try {
    const hz = await import("./hazardEngine");
    const snap = getOdteSnapshot();
    const spot = snap?.spot;
    if (spot && spot > 0 && entry > 0) {
      const nowET = new Date(asOf).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
      const [hh, mm] = nowET.split(":").map(Number);
      const nowMod = (hh - 9) * 60 + mm - 30;
      const heldMin = Math.max(0, Math.round((asOf - pos.buyTimestamp) / 60_000));
      const entryMod = Math.max(0, Math.min(389, nowMod - heldMin));
      const minutesRemaining = Math.max(1, 390 - nowMod);
      const dayUnit = hz.currentDayUnit();
      const optSide = pos.side === "call" ? "C" as const : "P" as const;
      const absDelta = hz.estimateOdteDelta({ spot, strike: pos.strike, side: optSide, minutesRemaining, dayUnitPts: dayUnit });
      const TGT_PCT = 50, STP_PCT = 20; // matches sizer + hard stop convention
      const targetPts = hz.optionPctToPoints(TGT_PCT, entry, absDelta);
      const stopPts = hz.optionPctToPoints(STP_PCT, entry, absDelta);
      const res = hz.computeHazard({
        entryMod,
        targetPts,
        stopPts,
        direction: underlyingSide === "long" ? "up" : "down",
      });
      if (!("error" in res)) {
        const breakeven = STP_PCT / (TGT_PCT + STP_PCT); // ~0.286, then friction pad
        const pad = 0.04; // spread/slippage friction
        const pStar = breakeven + pad;
        const step = res.curve.reduce((best, p) =>
          Math.abs(p.minute - heldMin) < Math.abs(best.minute - heldMin) ? p : best, res.curve[0]);
        const entryPWin = res.curve[0]?.condPWin;
        if (step?.condPWin != null && entryPWin != null) {
          const pWin = step.condPWin;
          // Fire ONLY on decay: survival curves here typically RISE with time
          // (early minutes are stop-dominated), so absolute base-rate pressure
          // at entry would be backwards. Pressure = below breakeven AND below
          // what the entry minute implied — i.e. surviving has made it WORSE.
          if (pWin < pStar && pWin < entryPWin) {
            const decay = (entryPWin - pWin) / Math.max(0.05, entryPWin);
            hazardScore = Math.round(Math.min(100, decay * 200 + ((pStar - pWin) / pStar) * 60));
            hazardReason = `hazard: cond win ${(pWin * 100).toFixed(0)}% — decayed from ${(entryPWin * 100).toFixed(0)}% at entry, breakeven ${(pStar * 100).toFixed(0)}% (${heldMin}min, n=${step.alive})`;
          }
        }
      }
    }
  } catch {
    // skip silently — hazard is additive, never blocking
  }

  // Hard stop SHORT-CIRCUITS — if hit, score = 100 regardless.
  let exitScore = 0;
  if (hardStop >= 100) {
    exitScore = 100;
  } else {
    const num =
      stackCollapseScore * W.stackCollapse +
      reversionScore * W.reversion +
      targetsScore * W.targetsHit +
      vixScore * W.vixSpike +
      gammaScore * W.gammaFlip +
      hazardScore * W.hazard;
    const den =
      W.stackCollapse + W.reversion + W.targetsHit + W.vixSpike + W.gammaFlip + W.hazard;
    exitScore = Math.round(num / den);
  }

  // ─── Trail-stop takeover ──────────────────────────────────────────
  // If we've banked a fat unrealized (≥40% gain) and we've given back ≥15% from
  // peak, treat it like a confluence-driven exit.
  const trailTriggered =
    ret != null && mem.peakReturnPct >= 0.40 && ret <= mem.peakReturnPct - 0.15;

  // ─── Action verdict ────────────────────────────────────────────────
  let action: ExitAction = "HOLD";
  if (ret == null) {
    action = "NO_QUOTE";
  } else if (hardStop >= 100) {
    action = "EXIT";
  } else if (trailTriggered) {
    action = "TRAIL";
  } else if (exitScore >= EXIT_SCORE) {
    action = "EXIT";
  } else if (exitScore >= TRIM_SCORE) {
    action = "TRIM";
  } else {
    action = "HOLD";
  }

  // ─── Reasons (top contributors) ───────────────────────────────────
  const reasons: string[] = [];
  if (ret == null) {
    reasons.push(live.noQuoteReason && live.noQuoteReason !== "no bid"
      ? `NO USABLE BID: ${live.noQuoteReason}; hard stop and P&L are not evaluated on an old price`
      : "NO BID: hard stop and P&L cannot be evaluated until the contract has a bid");
  }
  if (hardStop >= 100 && ret != null) {
    reasons.push(`HARD STOP: bid ${mark?.toFixed(2)} <= $${(entry * (1 + HARD_STOP_PCT)).toFixed(2)} (0.80 x the $${entry.toFixed(2)} fill)`);
  }
  if (trailTriggered && ret != null) {
    reasons.push(
      `TRAIL: peak +${(mem.peakReturnPct * 100).toFixed(0)}% at the bid, gave back ${((mem.peakReturnPct - ret) * 100).toFixed(0)}%`,
    );
  }
  if (stackReason) reasons.push(stackReason);
  if (reversionReason) reasons.push(reversionReason);
  if (targetsReason) reasons.push(targetsReason);
  if (vixReason) reasons.push(vixReason);
  if (gammaReason) reasons.push(gammaReason);
  if (hazardReason) reasons.push(hazardReason);

  mem.lastEvalScore = exitScore;

  return {
    positionId: pos.id,
    contractKey: pos.contractKey,
    side: pos.side,
    mark,
    markSource: live.source,
    markQuoteTimeMs: live.quoteTimeMs,
    markAgeMs: live.ageMs,
    noQuoteReason: live.noQuoteReason,
    entry,
    entryBasis,
    drawdownPct: liq ? liq.netReturn : null,
    bidReturnPct: ret,
    feeBasis: feeRes.basis,
    bid: quote.bid,
    ask: quote.ask,
    valuation: "bid_net_of_exit_fee",
    feePerContract: feeRes.fee ?? undefined,
    peakReturnPct: mem.peakReturnPct,
    action,
    exitScore,
    categories: {
      hardStop,
      stackCollapse: Math.round(stackCollapseScore),
      reversion: Math.round(reversionScore),
      targetsHit: targetsScore,
      vixSpike: vixScore,
      gammaFlip: gammaScore,
      hazard: hazardScore,
    },
    reasons: reasons.slice(0, 3),
    asOf,
  };
}

// ─── Eval loop ────────────────────────────────────────────────────────

/** Hard stop from live marks only: never waits on /api/models or quotes. */
function hardStopSweep(): void {
  // Same single rule as evaluatePosition: live bid <= 0.80 x the entry ask
  // fill, before fees (stream quote, else REST chain). No bid: not a hit and
  // not a pass; the full pass reports NO_QUOTE.
  const now = Date.now();
  const hits: typeof hardStopHits = [];
  for (const p of getTracked().filter((x) => x.status === "active")) {
    const { bid } = getLiveQuote(p.contractKey);
    const { fill } = entryFillOf(p);
    if (bid == null || !(fill > 0)) continue;
    if (optionStopHit(bid, fill) === true) hits.push({ positionId: p.id, contractKey: p.contractKey, mark: bid, returnPct: (bid - fill) / fill, asOf: now });
  }
  hardStopHits = hits;
}

async function evalAll(): Promise<void> {
  try { hardStopSweep(); } catch (e: any) { errors++; lastError = `hard-stop sweep: ${e?.message ?? String(e)}`; }
  if (evalInFlight) {
    skippedTicks++;
    return;
  }
  evalInFlight = true;
  try {
    const positions = getTracked().filter((p) => p.status === "active");
    if (!positions.length) {
      evals = [];
      return;
    }
    const out: ExitBrainEval[] = [];
    for (const p of positions) {
      try {
        out.push(await evaluatePosition(p));
      } catch (e: any) {
        errors++;
        lastError = `pos ${p.id}: ${e?.message ?? String(e)}`;
      }
    }
    evals = out;
    // GC memory for closed positions
    const liveIds = new Set(positions.map((p) => p.id));
    for (const id of memory.keys()) {
      if (!liveIds.has(id)) memory.delete(id);
    }
  } catch (e: any) {
    errors++;
    lastError = e?.message ?? String(e);
  } finally {
    evalInFlight = false;
    ticks++;
    lastTickMs = Date.now();
  }
}

// ─── Public API ───────────────────────────────────────────────────────

export function startExitBrain(intervalMs = EVAL_INTERVAL_MS): void {
  if (timer) return;
  // Fire once immediately, then on interval
  void evalAll();
  timer = setInterval(() => {
    void evalAll();
  }, intervalMs);
  console.log(`[exitBrain] started — 30s eval cadence, hard stop bid <= 0.80 x entry ask, exit≥${EXIT_SCORE} trim≥${TRIM_SCORE}`);
}

export function stopExitBrain(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getExitBrainSnapshot(): ExitBrainSnapshot {
  return {
    asOf: Date.now(),
    running: timer != null,
    intervalMs: EVAL_INTERVAL_MS,
    evals: evals.map((e) => ({ ...e })),
    config: {
      hardStopPct: HARD_STOP_PCT,
      trimScore: TRIM_SCORE,
      exitScore: EXIT_SCORE,
      trailScore: TRAIL_SCORE,
    },
    diagnostics: {
      lastTickMs,
      ticks,
      errors,
      lastError: lastError || undefined,
      skippedTicks,
    },
    hardStopHits: hardStopHits.map((h) => ({ ...h })),
  };
}

/** Single-shot evaluation for testing — not from the loop. */
export async function evaluateOnce(positionId: string): Promise<ExitBrainEval | null> {
  const pos = getTracked().find((p) => p.id === positionId && p.status === "active");
  if (!pos) return null;
  return await evaluatePosition(pos);
}
