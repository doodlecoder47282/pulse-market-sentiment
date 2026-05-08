// ─────────────────────────────────────────────────────────────────────────────
// flowAlertEngine.ts — WHALE-ONLY flow detection + per-ticker coalesce + Discord
//
// User spec (locked):
//   - Source: Schwab option chains (real-time, authenticated, no rate-limit)
//   - WHALE gate (ALL must pass):
//       • notional (premium) ≥ $1M
//       • (volOiRatio ≥ 10x)  OR  (isNewStrike && openInterest = 0)
//       • tag = "ABOVE_ASK"  (aggressive buyer urgency)
//       • dte ≥ 1  (0DTE excluded — handled by BANGERS engine)
//   - Cadence: real-time per hit, coalesced per-ticker on a 60s window
//   - Order: SPX, QQQ, SPY first; then alpha-sorted; whale prints ranked by
//            premium desc within each ticker msg
//
// Engineering contract (preserved from prior segments):
//   - try/catch wrapped, fail silently
//   - never modifies existing calcs (signals/regime/dfi/models/composite)
//   - read-only observer over buildUnusualFlow output
// ─────────────────────────────────────────────────────────────────────────────

import { buildSchwabFlow, type SchwabFlowContract } from "./schwabFlow";
import { getFlowConfig } from "./flowConfig";
import { loadRecentDedupKeys } from "./whalePersistence";
import { ingestContract as ingestUoaContract, getUoaSnapshot } from "./uoaScanner";

// Fire-once Discord poster for UOA. Imported lazily to avoid a hard
// dependency when running without webhook env (e.g. tests).
async function fireUoaDiscord(symbol: string, occ: string): Promise<void> {
  try {
    const snap = getUoaSnapshot();
    const list = snap.byTicker[symbol] ?? [];
    // Find the cluster that just fired by matching the most recent OCC into hits
    // (cluster is keyed by surface, so any cluster that includes this occ)
    const target = list.find(cl => cl.fired && cl.firedAt && Date.now() - cl.firedAt < 10_000);
    if (!target || !target.tier?.discordEnabled) return;
    const { postUoaClusterAlert } = await import("./discordUoaCard");
    await postUoaClusterAlert(target);
  } catch (e: any) {
    console.warn(`[uoa] discord post failed: ${e?.message ?? e}`);
  }
}

// ─── Config — WHALE bar (live values come from flowConfig at runtime) ──────────────────────────────────────────────────────
// SURGICAL TIER (locked 2026-05-08): only the cleanest aggressor prints with
// 1-3 DTE urgency. Discord + UI use the SAME gate. UOA scanner runs separately
// for any-ticker any-DTE clustering.
export const WHALE_PREMIUM_FLOOR = 2_500_000;   // $2.5M notional minimum
export const WHALE_VOL_OI_RATIO  = 15;          // 15x or higher
export const WHALE_MIN_DTE       = 1;           // no 0DTE
export const WHALE_MAX_DTE       = 3;           // 1–3DTE only — urgency money
export const WHALE_REQUIRED_TAG  = "ABOVE_ASK"; // aggressive buyer only

// Delta floor — kill lottery tickets (deep OTM gamma plays) and deep ITM hedges
export const WHALE_DELTA_MIN = 0.20;
export const WHALE_DELTA_MAX = 0.80;

// Universe — SPX/QQQ/SPY first (priority), then watchlist
export const FLOW_PRIORITY = ["SPX", "QQQ", "SPY"];
export const FLOW_WATCHLIST = [
  "NVDA", "TSLA", "AAPL", "MSFT", "META", "GOOGL", "AMZN",
  "AMD", "AVGO", "PLTR", "COIN", "MSTR",
];

// 60s coalesce window per ticker
const COALESCE_WINDOW_MS = 60_000;

// Eval cadence — pull fresh chain & detect every 30s
const EVAL_INTERVAL_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface WhaleHit {
  symbol: string;
  occ: string;
  type: "C" | "P";
  strike: number;
  expiration: string;
  dte: number;
  volume: number;
  openInterest: number;
  volOiRatio: number;
  isNewStrike: boolean;
  premium: number;       // notional in $
  tag: string;
  sentiment: string;
  delta: number;
  detectedAt: number;    // ms epoch
  reason: string;        // human-readable why-this-fired
  // Extended contract context — surfaces in expanded UI row, never gates
  bid?: number;
  ask?: number;
  mid?: number;
  spreadPct?: number;     // (ask-bid)/mid — tighter = more liquid
  iv?: number;            // 0..1
  gamma?: number;
  theta?: number;
  vega?: number;
  spot?: number | null;
  distFromSpotPct?: number;  // (strike - spot) / spot * 100
  breakeven?: number;        // C: strike + mid ; P: strike - mid
  breakevenPct?: number;     // (breakeven - spot) / spot * 100
  // Closed-loop edge-conditioned conviction (read-only metadata, additive).
  // Computed at queueHit time from rolling 45d edge stats. Never alters
  // gating, sizing, or any decision — surfaces in alert metadata only.
  convictionMultiplier?: number;   // e.g. 0.5 … 1.5 (1.0 = neutral)
  convictionRationale?: string;
  regimeAtFire?: string | null;
}

export interface FlowSnapshot {
  running: boolean;
  source: "schwab";
  lastEvalAt: number;
  lastEvalDurationMs: number;
  evalCount: number;
  errorCount: number;
  lastCycleErrors: number;
  pendingByTicker: Record<string, WhaleHit[]>;
  recentFired: Array<{ ticker: string; hits: number; firedAt: number }>;
  config: {
    premiumFloor: number;
    volOiRatio: number;
    minDte: number;
    maxDte: number;
    deltaMin: number;
    deltaMax: number;
    requiredTag: string;
    universe: string[];
  };
}

// ─── State (in-memory only — no localStorage per project rules) ─────────────
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lastEvalAt = 0;
let lastEvalDurationMs = 0;
let evalCount = 0;
let errorCount = 0;
let lastCycleErrors = 0;

// pending hits per ticker, awaiting coalesce flush
const pendingByTicker = new Map<string, WhaleHit[]>();

// dedup cache — same OCC + same premium tier won't refire within window.
// Hydrated from whale_alerts SQLite table on boot so process restarts and
// redeploys do NOT cause the same flow to re-alert. Window is per-day so
// the same contract+tier never alerts more than once on the same trading day.
const recentlySeen = new Map<string, number>();  // dedupKey -> ms epoch
const DEDUP_WINDOW_MS = 18 * 60 * 60 * 1000;  // 18h — covers full RTH + AH + overnight
const DEDUP_MAX_ENTRIES = 20_000;             // wider cap with longer window
// Coarser fallback dedup: same contract surface (sym|type|strike|exp), same window.
// Catches OCC format variations or feed mid-stream symbol changes.
const DEDUP_COARSE_WINDOW_MS = 18 * 60 * 60 * 1000;

// ET market hours guard — flow scanner runs ONLY during RTH on trading days.
// Without this, Schwab can return stale snapshots / late prints / rebroadcast
// the same day's flow after 16:00 ET, causing apparent re-alerts.
const HOLIDAYS_2026 = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);
function isRthNow(): boolean {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const dateStr = et.toISOString().slice(0, 10);
  if (HOLIDAYS_2026.has(dateStr)) return false;
  const totalMins = et.getHours() * 60 + et.getMinutes();
  return totalMins >= 9 * 60 + 30 && totalMins < 16 * 60;
}

// Hydration flag — ensures the dedup map is populated from SQLite exactly
// once on first eval cycle after process boot.
let dedupHydrated = false;
function hydrateDedupOnce(): void {
  if (dedupHydrated) return;
  dedupHydrated = true;
  try {
    const keys = loadRecentDedupKeys(DEDUP_WINDOW_MS);
    for (const k of keys) recentlySeen.set(k.dedupKey, k.detectedAt);
    console.log(`[flowAlerts] dedup hydrated — ${keys.length} keys from whale_alerts (last 18h)`);
  } catch (e: any) {
    console.warn(`[flowAlerts] dedup hydrate failed: ${e?.message ?? e}`);
  }
}

// fired log — last 20 ticker flushes
const recentFired: Array<{ ticker: string; hits: number; firedAt: number }> = [];

// flush timers per ticker
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Contract enrichment — attach extended fields for UI/Discord context ──────────────────
export function enrichHit(hit: WhaleHit, c: SchwabFlowContract, spot: number | null): WhaleHit {
  const mid = (c as any).mid > 0 ? (c as any).mid : ((c.bid + c.ask) / 2);
  const spreadPct = mid > 0 && c.ask > 0 && c.bid > 0 ? ((c.ask - c.bid) / mid) * 100 : 0;
  const breakeven = c.type === "C" ? c.strike + mid : c.strike - mid;
  const distFromSpotPct = spot && spot > 0 ? ((c.strike - spot) / spot) * 100 : undefined;
  const breakevenPct = spot && spot > 0 ? ((breakeven - spot) / spot) * 100 : undefined;
  return {
    ...hit,
    bid: c.bid,
    ask: c.ask,
    mid,
    spreadPct,
    iv: c.iv,
    gamma: (c as any).gamma,
    theta: (c as any).theta,
    vega: (c as any).vega,
    spot: spot ?? null,
    distFromSpotPct,
    breakeven,
    breakevenPct,
  };
}

// ─── Whale gate — single contract test ────────────────────────────────────────
export function isWhale(c: SchwabFlowContract): { whale: boolean; reason: string } {
  const cfg = getFlowConfig();
  // Premium floor
  if (c.notional < cfg.premiumFloor) {
    return { whale: false, reason: `premium $${(c.notional / 1000).toFixed(0)}K < $${(cfg.premiumFloor / 1_000_000).toFixed(2)}M` };
  }
  // Aggressor side
  if (cfg.requiredTag !== "ANY" && c.tag !== cfg.requiredTag) {
    return { whale: false, reason: `tag=${c.tag} (need ${cfg.requiredTag})` };
  }
  // DTE band — surgical 1–3DTE window kills hedges/LEAPS, keeps urgency money
  if (c.dte < cfg.minDte) {
    return { whale: false, reason: `dte=${c.dte} < min ${cfg.minDte}` };
  }
  if (c.dte > cfg.maxDte) {
    return { whale: false, reason: `dte=${c.dte} > max ${cfg.maxDte}` };
  }
  // Delta sanity — kill lotto tickets and deep ITM hedges (only when delta is real)
  const absDelta = Math.abs(c.delta ?? 0);
  if (absDelta > 0 && (absDelta < cfg.deltaMin || absDelta > cfg.deltaMax)) {
    return { whale: false, reason: `|delta|=${absDelta.toFixed(2)} outside [${cfg.deltaMin}, ${cfg.deltaMax}]` };
  }
  // OI ratio OR brand-new strike
  const ratioOk = c.volOiRatio >= cfg.volOiRatio;
  const newStrikeOk = c.isNewStrike && c.openInterest === 0;
  if (!ratioOk && !newStrikeOk) {
    return { whale: false, reason: `vol/OI=${c.volOiRatio.toFixed(1)}x < ${cfg.volOiRatio}x and not new strike` };
  }
  // Build why-fired reason
  const reasonParts: string[] = [];
  reasonParts.push(`$${(c.notional / 1_000_000).toFixed(2)}M premium`);
  if (newStrikeOk) reasonParts.push(`NEW STRIKE (OI=0)`);
  else reasonParts.push(`vol/OI ${c.volOiRatio.toFixed(1)}x`);
  reasonParts.push(`${c.tag} aggressor`);
  reasonParts.push(`${c.dte}DTE`);
  if ((c.delta ?? 0) !== 0) reasonParts.push(`Δ ${c.delta.toFixed(2)}`);
  return { whale: true, reason: reasonParts.join(" • ") };
}

// ─── Per-ticker scan ──────────────────────────────────────────────────────────
async function scanTicker(symbol: string): Promise<{ hits: WhaleHit[]; error: string | null }> {
  try {
    const flow = await buildSchwabFlow(symbol, {
      minVolOi: 2.0,
      minVolume: 100,
      maxDte: 90,
      limit: 200,
    });
    if ("error" in flow) {
      return { hits: [], error: flow.error };
    }
    const hits: WhaleHit[] = [];
    const now = Date.now();
    for (const c of flow.contracts) {
      // UOA observer — piggybacks on this Schwab pull. Independent of whale gate.
      try {
        const out = ingestUoaContract(c, symbol, flow.spot ?? null);
        if (out.fired) { void fireUoaDiscord(symbol, c.occ); }
      } catch { /* never blocks whale path */ }

      const { whale, reason } = isWhale(c);
      if (!whale) continue;

      // Primary dedup keyed on (occ, premium-tier in $M) — whale doublings re-fire
      const tier = Math.ceil(c.notional / 1_000_000);
      const dedupKey = `${c.occ}|t${tier}`;
      const lastSeen = recentlySeen.get(dedupKey);
      if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) continue;

      // Fallback dedup catches OCC format drift (same contract surface, different occ string).
      const coarseKey = `coarse|${symbol}|${c.type}|${c.strike}|${c.expiration}|t${tier}`;
      const coarseLast = recentlySeen.get(coarseKey);
      if (coarseLast && now - coarseLast < DEDUP_COARSE_WINDOW_MS) continue;

      recentlySeen.set(dedupKey, now);
      recentlySeen.set(coarseKey, now);

      const baseHit: WhaleHit = {
        symbol,
        occ: c.occ,
        type: c.type,
        strike: c.strike,
        expiration: c.expiration,
        dte: c.dte,
        volume: c.volume,
        openInterest: c.openInterest,
        volOiRatio: c.volOiRatio,
        isNewStrike: c.isNewStrike,
        premium: c.notional,
        tag: c.tag,
        sentiment: c.sentiment,
        delta: c.delta,
        detectedAt: now,
        reason,
      };
      hits.push(enrichHit(baseHit, c, flow.spot ?? null));
    }
    return { hits, error: null };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.warn(`[flowAlerts] scan ${symbol} failed: ${msg}`);
    return { hits: [], error: msg };
  }
}

// ─── Coalesce + flush ─────────────────────────────────────────────────────────
function queueHit(hit: WhaleHit): void {
  try {
    const ticker = hit.symbol;
    const buf = pendingByTicker.get(ticker) ?? [];
    buf.push(hit);
    pendingByTicker.set(ticker, buf);

    // Register with follow-through tracker so we can re-price tick-by-tick
    // and detect closing positions. Failure here must NEVER block alert flow.
    try {
      // Lazy import — keeps a clean dep boundary
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { registerWhale } = require("./whaleFollowThrough");
      registerWhale(hit);
    } catch (e: any) {
      console.warn(`[flowAlerts] follow-through register failed: ${e?.message ?? e}`);
    }

    // Read current regime (if available) and decorate the hit with edge-conditioned
    // conviction. Pure read-only — NEVER throws to alert flow, NEVER changes gating.
    let regimeAtFire: string | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getRegimeSnapshot } = require("./regimeStateCache");
      const snap = getRegimeSnapshot();
      regimeAtFire = snap?.topCandidate ? String(snap.topCandidate) : null;
    } catch {
      // best-effort only
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { regimeConvictionMultiplier } = require("./edgeStats");
      if (regimeAtFire && typeof regimeConvictionMultiplier === "function") {
        const result = regimeConvictionMultiplier(hit.symbol, regimeAtFire, 45);
        const mult = result?.multiplier;
        if (typeof mult === "number" && isFinite(mult)) {
          hit.convictionMultiplier = mult;
          hit.regimeAtFire = regimeAtFire;
          if (mult >= 1.2) {
            hit.convictionRationale = `${regimeAtFire} historically lifts ${hit.symbol} hit-rate by ${((mult - 1) * 100).toFixed(0)}% (n=${result.n})`;
          } else if (mult <= 0.8) {
            hit.convictionRationale = `${regimeAtFire} historically reduces ${hit.symbol} hit-rate by ${((1 - mult) * 100).toFixed(0)}% (n=${result.n})`;
          } else {
            hit.convictionRationale = `${regimeAtFire} hit-rate near baseline for ${hit.symbol} (n=${result.n})`;
          }
        }
      }
    } catch {
      // Never block alert flow on edge-stats failures
    }

    // Closed-loop edge tracking: log this prediction for grading later.
    // Pure read-only writer — never throws to alert flow.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { logWhaleAlertPrediction } = require("./outcomeLogger");
      const cfg = getFlowConfig();
      logWhaleAlertPrediction({
        occ: hit.occ,
        symbol: hit.symbol,
        type: hit.type as any,
        strike: hit.strike,
        expiration: hit.expiration,
        dte: hit.dte,
        premium: hit.premium,
        volOiRatio: hit.volOiRatio,
        isNewStrike: !!hit.isNewStrike,
        tag: hit.tag,
        delta: hit.delta,
        sentiment: hit.sentiment as any,
        gates: {
          premiumFloor: cfg.premiumFloor,
          volOiRatio: cfg.volOiRatio,
          minDte: cfg.minDte,
          requiredTag: cfg.requiredTag,
          deltaMin: cfg.deltaMin,
          deltaMax: cfg.deltaMax,
        },
        regimeAtFire,
        detectedAt: hit.detectedAt,
      });
    } catch (e: any) {
      // Never block alert flow on logging failures
    }

    // Schedule a flush if not already scheduled
    if (!flushTimers.has(ticker)) {
      const t = setTimeout(() => {
        void flushTicker(ticker);
      }, COALESCE_WINDOW_MS);
      flushTimers.set(ticker, t);
    }
  } catch (e: any) {
    console.warn(`[flowAlerts] queueHit failed: ${e?.message ?? e}`);
  }
}

async function flushTicker(ticker: string): Promise<void> {
  try {
    const hits = pendingByTicker.get(ticker) ?? [];
    pendingByTicker.delete(ticker);
    flushTimers.delete(ticker);
    if (hits.length === 0) return;

    // Rank by premium desc within the ticker
    hits.sort((a, b) => b.premium - a.premium);

    // Post to Discord
    const { postWhaleFlowAlert } = await import("./discordFlowCard");
    const ok = await postWhaleFlowAlert(ticker, hits);
    if (ok) {
      recentFired.unshift({ ticker, hits: hits.length, firedAt: Date.now() });
      if (recentFired.length > 20) recentFired.pop();
      console.log(`[flowAlerts] FIRED ${ticker} — ${hits.length} whale hit(s)`);
    }
  } catch (e: any) {
    console.warn(`[flowAlerts] flush ${ticker} failed: ${e?.message ?? e}`);
    errorCount++;
  }
}

// ─── Eval loop ────────────────────────────────────────────────────────────────
async function evalCycle(): Promise<void> {
  const t0 = Date.now();
  // Hydrate dedup from SQLite on first cycle so a process restart cannot
  // cause the same whale flow to re-alert just because the in-memory map
  // was wiped by the redeploy.
  hydrateDedupOnce();

  // RTH guard — do not scan or fire outside regular trading hours. Schwab
  // post-close behavior includes stale snapshots and late prints that
  // appear novel to a fresh dedup window. Skip eval entirely when closed.
  if (!isRthNow()) {
    lastEvalAt = Date.now();
    lastEvalDurationMs = Date.now() - t0;
    return;
  }

  try {
    // Priority first, then watchlist — sequential is fine on Schwab (no 429 risk)
    const cfg = getFlowConfig();
    const universe = [...cfg.priority, ...cfg.watchlist];
    let cycleErrors = 0;
    for (const sym of universe) {
      const { hits, error } = await scanTicker(sym);
      if (error) cycleErrors++;
      for (const h of hits) queueHit(h);
    }
    lastCycleErrors = cycleErrors;

    // Sweep dedup cache (use longest window so coarse entries don't survive past primary)
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [key, ts] of recentlySeen.entries()) {
      if (ts < cutoff) recentlySeen.delete(key);
    }
    // Hard cap: if the map ever exceeds the limit, drop oldest half.
    if (recentlySeen.size > DEDUP_MAX_ENTRIES) {
      const sorted = Array.from(recentlySeen.entries()).sort((a, b) => a[1] - b[1]);
      const drop = Math.floor(sorted.length / 2);
      for (let i = 0; i < drop; i++) recentlySeen.delete(sorted[i][0]);
      console.warn(`[flowAlerts] dedup cache hit cap ${DEDUP_MAX_ENTRIES} — evicted ${drop} oldest`);
    }
    // Re-price every tracked whale from fresh chains — captures closing prints,
    // peak P&L, drawdowns. Read-only; never throws to outer cycle.
    try {
      const { updateAll } = await import("./whaleFollowThrough");
      await updateAll();
    } catch (e: any) {
      console.warn(`[flowAlerts] follow-through update failed: ${e?.message ?? e}`);
    }
  } catch (e: any) {
    console.warn(`[flowAlerts] evalCycle failed: ${e?.message ?? e}`);
    errorCount++;
  } finally {
    lastEvalAt = Date.now();
    lastEvalDurationMs = lastEvalAt - t0;
    evalCount++;
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
export function startFlowAlerts(): void {
  if (intervalHandle) return;
  console.log(
    `[flowAlerts] started — ${EVAL_INTERVAL_MS / 1000}s eval, WHALE-ONLY ` +
    `(prem≥$${WHALE_PREMIUM_FLOOR / 1_000_000}M, vol/OI≥${WHALE_VOL_OI_RATIO}x OR new-strike, ` +
    `${WHALE_REQUIRED_TAG}, dte≥${WHALE_MIN_DTE}), ${COALESCE_WINDOW_MS / 1000}s coalesce`
  );
  // Kick first eval immediately so snapshot is meaningful right away
  void evalCycle();
  intervalHandle = setInterval(() => {
    void evalCycle();
  }, EVAL_INTERVAL_MS);
}

export function stopFlowAlerts(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  for (const t of flushTimers.values()) clearTimeout(t);
  flushTimers.clear();
}

// ─── Snapshot for /api/flow/snapshot ──────────────────────────────────────────
export function getFlowSnapshot(): FlowSnapshot {
  const pending: Record<string, WhaleHit[]> = {};
  for (const [k, v] of pendingByTicker.entries()) pending[k] = v;
  return {
    running: intervalHandle != null,
    source: "schwab",
    lastEvalAt,
    lastEvalDurationMs,
    evalCount,
    errorCount,
    lastCycleErrors,
    pendingByTicker: pending,
    recentFired: [...recentFired],
    config: ((): FlowSnapshot["config"] => {
      const cfg = getFlowConfig();
      return {
        premiumFloor: cfg.premiumFloor,
        volOiRatio: cfg.volOiRatio,
        minDte: cfg.minDte,
        maxDte: cfg.maxDte,
        deltaMin: cfg.deltaMin,
        deltaMax: cfg.deltaMax,
        requiredTag: cfg.requiredTag,
        universe: [...cfg.priority, ...cfg.watchlist],
      };
    })(),
  };
}

// ─── Single-shot preview for /api/flow/preview ───────────────────────────────
export async function previewFlow(): Promise<{
  config: FlowSnapshot["config"];
  byTicker: Record<string, { whales: WhaleHit[]; rejected: Array<{ occ: string; reason: string }> }>;
  totalScanned: number;
  totalWhales: number;
}> {
  const cfg = getFlowConfig();
  const universe = [...cfg.priority, ...cfg.watchlist];
  const byTicker: Record<string, { whales: WhaleHit[]; rejected: Array<{ occ: string; reason: string }> }> = {};
  let totalScanned = 0;
  let totalWhales = 0;
  for (const sym of universe) {
    try {
      const flow = await buildSchwabFlow(sym, {
        minVolOi: 2.0, minVolume: 100, maxDte: 90, limit: 200,
      });
      if ("error" in flow) {
        byTicker[sym] = { whales: [], rejected: [{ occ: "ERROR", reason: flow.error }] };
        continue;
      }
      const whales: WhaleHit[] = [];
      const rejected: Array<{ occ: string; reason: string }> = [];
      const now = Date.now();
      for (const c of flow.contracts) {
        totalScanned++;
        // UOA piggyback in preview path too — keeps cluster state warm
        try {
          const out = ingestUoaContract(c, sym, flow.spot ?? null);
          if (out.fired) { void fireUoaDiscord(sym, c.occ); }
        } catch { /* */ }
        const { whale, reason } = isWhale(c);
        if (whale) {
          const base: WhaleHit = {
            symbol: sym, occ: c.occ, type: c.type, strike: c.strike,
            expiration: c.expiration, dte: c.dte, volume: c.volume,
            openInterest: c.openInterest, volOiRatio: c.volOiRatio,
            isNewStrike: c.isNewStrike, premium: c.notional, tag: c.tag,
            sentiment: c.sentiment, delta: c.delta, detectedAt: now, reason,
          };
          whales.push(enrichHit(base, c, flow.spot ?? null));
        } else {
          // Only show top rejects to keep response readable
          if (rejected.length < 5) rejected.push({ occ: c.occ, reason });
        }
      }
      // Sort: premium DESC, then volume DESC (tiebreaker)
      whales.sort((a, b) => (b.premium - a.premium) || (b.volume - a.volume));
      byTicker[sym] = { whales, rejected };
      totalWhales += whales.length;
    } catch (e: any) {
      byTicker[sym] = { whales: [], rejected: [{ occ: "ERROR", reason: e?.message ?? String(e) }] };
    }
  }
  return {
    source: "schwab" as const,
    config: {
      premiumFloor: cfg.premiumFloor,
      volOiRatio: cfg.volOiRatio,
      minDte: cfg.minDte,
      maxDte: cfg.maxDte,
      deltaMin: cfg.deltaMin,
      deltaMax: cfg.deltaMax,
      requiredTag: cfg.requiredTag,
      universe,
    },
    byTicker,
    totalScanned,
    totalWhales,
  };
}
