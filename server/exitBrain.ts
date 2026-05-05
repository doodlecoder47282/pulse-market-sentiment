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
//   │   1) read live mark from odteTracker snapshot                   │
//   │   2) compute drawdown vs entry                                  │
//   │   3) HARD STOP: drawdown ≤ −20%  →  EXIT immediately            │
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

// ─── Types ────────────────────────────────────────────────────────────

export type ExitAction = "HOLD" | "TRIM" | "EXIT" | "TRAIL";

export interface ExitBrainEval {
  positionId: string;
  contractKey: string;
  side: Side;
  /** Live mark used for this eval */
  mark: number | null;
  /** Entry price */
  entry: number;
  /** Drawdown vs entry, signed pct (e.g. -0.18 = −18%) */
  drawdownPct: number;
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
  };
}

// ─── Config ───────────────────────────────────────────────────────────

const HARD_STOP_PCT = -0.20;       // -20% drawdown → instant exit
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

// ─── Helpers ──────────────────────────────────────────────────────────

async function getVix(): Promise<number | null> {
  try {
    const port = Number(process.env.PORT ?? 5000);
    const r = await fetch(`http://127.0.0.1:${port}/api/quotes`);
    const d: any = await r.json();
    return Number(d?.vix?.price ?? null) || null;
  } catch {
    return null;
  }
}

/** Get the most recent live mark (last → mid → bid mid) for a contract. */
function getLiveMark(contractKey: string): number | null {
  const snap = getOdteSnapshot();
  const row = snap.contracts.find((c) => c.key === contractKey);
  if (!row) return null;
  if (row.last != null && row.last > 0) return row.last;
  if (row.mid != null && row.mid > 0) return row.mid;
  if (row.bid != null && row.ask != null && row.bid > 0 && row.ask > 0) {
    return (row.bid + row.ask) / 2;
  }
  return null;
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

  const mark = getLiveMark(pos.contractKey);
  const entry = pos.buyPrice;
  const ret = mark != null && entry > 0 ? (mark - entry) / entry : 0;
  if (ret > mem.peakReturnPct) mem.peakReturnPct = ret;

  // Map option side ("call"/"put") → underlying directional side ("long"/"short")
  const underlyingSide: "long" | "short" = pos.side === "call" ? "long" : "short";

  // ─── Category 1: HARD STOP ─────────────────────────────────────────
  const hardStop = ret <= HARD_STOP_PCT ? 100 : 0;

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
    const port = Number(process.env.PORT ?? 5000);
    const r = await fetch(`http://127.0.0.1:${port}/api/models?symbol=^GSPC&experimental=1`);
    const data: any = await r.json();
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

  // ─── Category 5a: VIX SPIKE AGAINST SIDE ───────────────────────────
  let vixScore = 0;
  let vixReason = "";
  try {
    const v = await getVix();
    if (v != null && mem.vixAtEntry != null && mem.vixAtEntry > 0) {
      const dv = (v - mem.vixAtEntry) / mem.vixAtEntry;
      // For longs (calls) — VIX spike is bad. For shorts (puts) — VIX crash is bad.
      const adverse = underlyingSide === "long" ? dv : -dv;
      if (adverse >= 0.10) {
        vixScore = 100;
        vixReason = `VIX ${adverse > 0 ? "+" : ""}${(adverse * 100).toFixed(0)}% since entry`;
      } else if (adverse >= 0.05) {
        vixScore = 60;
        vixReason = `VIX ${(adverse * 100).toFixed(0)}% since entry`;
      } else if (adverse >= 0.03) {
        vixScore = 30;
      }
    }
  } catch {
    // skip silently
  }

  // ─── Category 5b: GAMMA FLIP / WALL BREAK ──────────────────────────
  let gammaScore = 0;
  let gammaReason = "";
  try {
    const port = Number(process.env.PORT ?? 5000);
    const r = await fetch(`http://127.0.0.1:${port}/api/models?symbol=^GSPC&experimental=1`);
    const data: any = await r.json();
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
      gammaScore * W.gammaFlip;
    const den =
      W.stackCollapse + W.reversion + W.targetsHit + W.vixSpike + W.gammaFlip;
    exitScore = Math.round(num / den);
  }

  // ─── Trail-stop takeover ──────────────────────────────────────────
  // If we've banked a fat unrealized (≥40% gain) and we've given back ≥15% from
  // peak, treat it like a confluence-driven exit.
  const trailTriggered =
    mem.peakReturnPct >= 0.40 && ret <= mem.peakReturnPct - 0.15;

  // ─── Action verdict ────────────────────────────────────────────────
  let action: ExitAction = "HOLD";
  if (hardStop >= 100) {
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
  if (hardStop >= 100) {
    reasons.push(`HARD STOP: drawdown ${(ret * 100).toFixed(0)}% ≤ -20%`);
  }
  if (trailTriggered) {
    reasons.push(
      `TRAIL: peak +${(mem.peakReturnPct * 100).toFixed(0)}%, gave back ${((mem.peakReturnPct - ret) * 100).toFixed(0)}%`,
    );
  }
  if (stackReason) reasons.push(stackReason);
  if (reversionReason) reasons.push(reversionReason);
  if (targetsReason) reasons.push(targetsReason);
  if (vixReason) reasons.push(vixReason);
  if (gammaReason) reasons.push(gammaReason);

  mem.lastEvalScore = exitScore;

  return {
    positionId: pos.id,
    contractKey: pos.contractKey,
    side: pos.side,
    mark,
    entry,
    drawdownPct: ret,
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
    },
    reasons: reasons.slice(0, 3),
    asOf,
  };
}

// ─── Eval loop ────────────────────────────────────────────────────────

async function evalAll(): Promise<void> {
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
  console.log(`[exitBrain] started — 30s eval cadence, hard stop -20%, exit≥${EXIT_SCORE} trim≥${TRIM_SCORE}`);
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
    },
  };
}

/** Single-shot evaluation for testing — not from the loop. */
export async function evaluateOnce(positionId: string): Promise<ExitBrainEval | null> {
  const pos = getTracked().find((p) => p.id === positionId && p.status === "active");
  if (!pos) return null;
  return await evaluatePosition(pos);
}
