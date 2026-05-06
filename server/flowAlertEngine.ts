// ─────────────────────────────────────────────────────────────────────────────
// flowAlertEngine.ts — WHALE-ONLY flow detection + per-ticker coalesce + Discord
//
// User spec (locked):
//   - Source: CBOE/Schwab options chain (existing buildUnusualFlow pipeline)
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

import { buildUnusualFlow, type UnusualFlowContract } from "./unusualFlow";

// ─── Config — WHALE bar ──────────────────────────────────────────────────────
export const WHALE_PREMIUM_FLOOR = 1_000_000;   // $1M notional minimum
export const WHALE_VOL_OI_RATIO  = 10;          // 10x or higher
export const WHALE_MIN_DTE       = 1;           // no 0DTE
export const WHALE_REQUIRED_TAG  = "ABOVE_ASK"; // aggressive buyer only

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
  detectedAt: number;    // ms epoch
  reason: string;        // human-readable why-this-fired
}

export interface FlowSnapshot {
  running: boolean;
  lastEvalAt: number;
  lastEvalDurationMs: number;
  evalCount: number;
  errorCount: number;
  pendingByTicker: Record<string, WhaleHit[]>;   // hits waiting in coalesce window
  recentFired: Array<{ ticker: string; hits: number; firedAt: number }>;
  config: {
    premiumFloor: number;
    volOiRatio: number;
    minDte: number;
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

// pending hits per ticker, awaiting coalesce flush
const pendingByTicker = new Map<string, WhaleHit[]>();

// dedup cache — same OCC + same minute won't refire
const recentlySeen = new Map<string, number>();  // occ -> ms epoch
const DEDUP_WINDOW_MS = 5 * 60 * 1000;  // 5min

// fired log — last 20 ticker flushes
const recentFired: Array<{ ticker: string; hits: number; firedAt: number }> = [];

// flush timers per ticker
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Whale gate — single contract test ────────────────────────────────────────
export function isWhale(c: UnusualFlowContract): { whale: boolean; reason: string } {
  // Premium floor
  if (c.notional < WHALE_PREMIUM_FLOOR) {
    return { whale: false, reason: `premium $${(c.notional / 1000).toFixed(0)}K < $${WHALE_PREMIUM_FLOOR / 1_000_000}M` };
  }
  // Aggressor side
  if (c.tag !== WHALE_REQUIRED_TAG) {
    return { whale: false, reason: `tag=${c.tag} (need ABOVE_ASK)` };
  }
  // DTE — exclude 0DTE
  if (c.dte < WHALE_MIN_DTE) {
    return { whale: false, reason: `dte=${c.dte} (0DTE excluded)` };
  }
  // OI ratio OR brand-new strike
  const ratioOk = c.volOiRatio >= WHALE_VOL_OI_RATIO;
  const newStrikeOk = c.isNewStrike && c.openInterest === 0;
  if (!ratioOk && !newStrikeOk) {
    return { whale: false, reason: `vol/OI=${c.volOiRatio.toFixed(1)}x < ${WHALE_VOL_OI_RATIO}x and not new strike` };
  }
  // Build why-fired reason
  const reasonParts: string[] = [];
  reasonParts.push(`$${(c.notional / 1_000_000).toFixed(2)}M premium`);
  if (newStrikeOk) reasonParts.push(`NEW STRIKE (OI=0)`);
  else reasonParts.push(`vol/OI ${c.volOiRatio.toFixed(1)}x`);
  reasonParts.push(`${c.tag} aggressor`);
  reasonParts.push(`${c.dte}DTE`);
  return { whale: true, reason: reasonParts.join(" • ") };
}

// ─── Per-ticker scan ──────────────────────────────────────────────────────────
async function scanTicker(symbol: string): Promise<WhaleHit[]> {
  try {
    // Pull with relaxed pre-filter — let our whale gate do the real filtering
    const flow = await buildUnusualFlow(symbol, {
      minVolOi: 2.0,        // pre-filter — we tighten to 10x in isWhale()
      minVolume: 100,
      maxDte: 90,
      limit: 200,           // higher limit so we don't miss whales
    });
    const hits: WhaleHit[] = [];
    const now = Date.now();
    for (const c of flow.contracts) {
      const { whale, reason } = isWhale(c);
      if (!whale) continue;

      // Dedup — same OCC seen within window? skip
      const lastSeen = recentlySeen.get(c.occ);
      if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) continue;
      recentlySeen.set(c.occ, now);

      hits.push({
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
        detectedAt: now,
        reason,
      });
    }
    return hits;
  } catch (e: any) {
    console.warn(`[flowAlerts] scan ${symbol} failed: ${e?.message ?? e}`);
    return [];
  }
}

// ─── Coalesce + flush ─────────────────────────────────────────────────────────
function queueHit(hit: WhaleHit): void {
  try {
    const ticker = hit.symbol;
    const buf = pendingByTicker.get(ticker) ?? [];
    buf.push(hit);
    pendingByTicker.set(ticker, buf);

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
  try {
    // Priority first, then watchlist — sequential to avoid hammering CBOE
    const universe = [...FLOW_PRIORITY, ...FLOW_WATCHLIST];
    for (const sym of universe) {
      const hits = await scanTicker(sym);
      for (const h of hits) queueHit(h);
    }

    // Sweep dedup cache
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [occ, ts] of recentlySeen.entries()) {
      if (ts < cutoff) recentlySeen.delete(occ);
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
    lastEvalAt,
    lastEvalDurationMs,
    evalCount,
    errorCount,
    pendingByTicker: pending,
    recentFired: [...recentFired],
    config: {
      premiumFloor: WHALE_PREMIUM_FLOOR,
      volOiRatio: WHALE_VOL_OI_RATIO,
      minDte: WHALE_MIN_DTE,
      requiredTag: WHALE_REQUIRED_TAG,
      universe: [...FLOW_PRIORITY, ...FLOW_WATCHLIST],
    },
  };
}

// ─── Single-shot preview for /api/flow/preview ───────────────────────────────
export async function previewFlow(): Promise<{
  config: FlowSnapshot["config"];
  byTicker: Record<string, { whales: WhaleHit[]; rejected: Array<{ occ: string; reason: string }> }>;
  totalScanned: number;
  totalWhales: number;
}> {
  const universe = [...FLOW_PRIORITY, ...FLOW_WATCHLIST];
  const byTicker: Record<string, { whales: WhaleHit[]; rejected: Array<{ occ: string; reason: string }> }> = {};
  let totalScanned = 0;
  let totalWhales = 0;
  for (const sym of universe) {
    try {
      const flow = await buildUnusualFlow(sym, {
        minVolOi: 2.0, minVolume: 100, maxDte: 90, limit: 200,
      });
      const whales: WhaleHit[] = [];
      const rejected: Array<{ occ: string; reason: string }> = [];
      const now = Date.now();
      for (const c of flow.contracts) {
        totalScanned++;
        const { whale, reason } = isWhale(c);
        if (whale) {
          whales.push({
            symbol: sym, occ: c.occ, type: c.type, strike: c.strike,
            expiration: c.expiration, dte: c.dte, volume: c.volume,
            openInterest: c.openInterest, volOiRatio: c.volOiRatio,
            isNewStrike: c.isNewStrike, premium: c.notional, tag: c.tag,
            sentiment: c.sentiment, detectedAt: now, reason,
          });
        } else {
          // Only show top rejects to keep response readable
          if (rejected.length < 5) rejected.push({ occ: c.occ, reason });
        }
      }
      whales.sort((a, b) => b.premium - a.premium);
      byTicker[sym] = { whales, rejected };
      totalWhales += whales.length;
    } catch (e: any) {
      byTicker[sym] = { whales: [], rejected: [{ occ: "ERROR", reason: e?.message ?? String(e) }] };
    }
  }
  return {
    config: {
      premiumFloor: WHALE_PREMIUM_FLOOR,
      volOiRatio: WHALE_VOL_OI_RATIO,
      minDte: WHALE_MIN_DTE,
      requiredTag: WHALE_REQUIRED_TAG,
      universe,
    },
    byTicker,
    totalScanned,
    totalWhales,
  };
}
