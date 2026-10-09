// ─────────────────────────────────────────────────────────────────────────────
// whaleFollowThrough.ts — track detected whale positions tick-by-tick.
//
// User spec (verbatim):
//   "I like the flow bot but make it able to track the flow and come back to it
//    see closing position etc"
//
// What this does:
//   1) When flowAlertEngine detects a whale, register() seeds a Position record
//      with the entry mark, premium, delta, OCC, etc.
//   2) On every flow eval cycle, updateAll() re-prices each open position from
//      the latest Schwab chain. Computes:
//        - currentMark, peakMark, realized %change
//        - volume runoff (today's vol vs first-seen vol)
//        - status: OPEN | TRIMMING | CLOSING | CLOSED | EXPIRED
//   3) Heuristic close detection (since we can't see actual fills):
//        - mark drops to ≤ 50% of entry mark for 3+ consecutive observations
//          AND volume has stopped accumulating ≥ 5min  →  CLOSING
//        - mark hits 0 OR DTE expires  →  CLOSED
//   4) Exposes /api/flow/followups for the UI panel.
//
// In-memory only by default; alert history persistence (next ticket) will
// flush this to SQLite.
// ─────────────────────────────────────────────────────────────────────────────

import type { WhaleHit } from "./flowAlertEngine";
import { buildSchwabFlow, type SchwabFlowContract } from "./schwabFlow";
// Static import instead of bare require(): the package is ESM and under `tsx` dev every
// require() threw inside its try/catch, so nothing persisted and hydrateFromDb loaded 0
// rows, silently. whalePersistence only imports a *type* from this file, so no cycle.
import { persistFollowState, persistWhaleAlert, loadAllFollows, loadWhaleEntryQuote } from "./whalePersistence";
import { acceptExitQuote, etCloseMs, whaleFireSnapshot } from "./validationMath";
import { buildScoreboardRow, scoreAskToBid, SCOREBOARD_BASIS_NOTE, type ScoreboardRow, type ScoredTrade } from "./whaleScoreboard";
import { feeForProduct } from "./feeConfig";

// Persistence wrappers — fail-soft, never let DB hiccups break tracking.
function safePersistFollow(p: FollowPosition): void {
  try {
    persistFollowState(p);
  } catch (e: any) {
    console.warn(`[whaleFollow] persistFollowState failed: ${e?.message ?? e}`);
  }
}
function safePersistAlert(hit: WhaleHit): void {
  try {
    persistWhaleAlert(hit);
  } catch (e: any) {
    console.warn(`[whaleFollow] persistWhaleAlert failed: ${e?.message ?? e}`);
  }
}

export type FollowStatus = "OPEN" | "TRIMMING" | "CLOSING" | "CLOSED" | "EXPIRED";

export interface FollowPosition {
  /** Unique key — same as WhaleHit.occ */
  occ: string;
  symbol: string;
  type: "C" | "P";
  strike: number;
  expiration: string;
  side: "BULLISH" | "BEARISH" | "NEUTRAL";
  /** Entry observation snapshot */
  entry: {
    mark: number;
    premium: number;       // $ day premium at the FIRST fire (= volume x mark x 100); never rewritten
    delta: number;
    volume: number;        // running session volume at detection
    openInterest: number;
    detectedAt: number;
    /** Quote at detection, $ per share (additive; older rows fall back to whale_alert_quotes). */
    bid?: number | null;
    ask?: number | null;
  };
  /** Live-updated position state */
  live: {
    mark: number | null;
    pctChange: number;     // (mark - entry.mark) / entry.mark
    peakMark: number;
    peakPctChange: number;
    troughMark: number;
    volume: number;        // latest session volume
    volumeSinceEntry: number;
    lastUpdateAt: number;
    /** Consecutive ticks where mark has been falling */
    fadeStreak: number;
    /** Consecutive ticks where mark has been below 0.50 of entry */
    drawdownStreak: number;
    /** Last time volume increased */
    lastVolumeBumpAt: number;
    /** Latest Schwab quote, $ per share (additive; absent on rows from older builds) */
    bid?: number | null;
    ask?: number | null;
    quoteAt?: number | null;
    /**
     * Last quote observed at or before the 16:00 ET close of the expiry date:
     * the exit mark the outcome grader uses (review item 8.2). Never written
     * after the close, so a later stale quote cannot overwrite it.
     */
    preExpiryQuote?: { bid: number | null; ask: number | null; mark: number | null; at: number } | null;
    /** Latest re-fire of this contract (additive): premium $ = volume x mark x 100, same moment. */
    lastFire?: { premium: number; volume: number; mark: number | null; at: number } | null;
    refireCount?: number;
    /** Highest bid seen while the position was live (scoreboard "burn" test on sellable prices). */
    peakBid?: number | null;
  };
  status: FollowStatus;
  /** When status transitioned to its current value */
  statusAt: number;
  /** Final closing snapshot (only set once status terminal) */
  closingPrint?: {
    mark: number;
    pctChange: number;
    peakPctChange: number;
    closedAt: number;
    reason: string;
    /** Bid at the terminal moment, $ per share (additive): the scoreboard exit price. */
    bid?: number | null;
  };
}

// ─── State ────────────────────────────────────────────────────────────────────
const positions = new Map<string, FollowPosition>();
const MAX_POSITIONS = 500;
const STALE_AFTER_MS = 90 * 24 * 60 * 60_000;   // GC after 90 days

// ─── Public API ───────────────────────────────────────────────────────────────

/** Called by flowAlertEngine when a new whale fires. */
export function registerWhale(hit: WhaleHit): void {
  // Always log to alert history (audit trail) — even on re-fires of the same OCC.
  safePersistAlert(hit);
  if (positions.has(hit.occ)) {
    // Already tracking (flowAlertEngine premium-tier dedup handles re-fires).
    // The entry is the FIRST fire and is never rewritten: the old code raised
    // entry.premium alone, so premium no longer equalled entry.volume x
    // entry.mark x 100, and the DB upsert never stored it (entryJson is
    // insert-only), so memory and disk disagreed after a restart. The latest
    // fire is kept instead as one consistent premium/volume/mark snapshot.
    const p = positions.get(hit.occ)!;
    p.live.lastFire = whaleFireSnapshot(hit);
    p.live.refireCount = (p.live.refireCount ?? 0) + 1;
    safePersistFollow(p);
    return;
  }
  // GC oldest if at capacity
  if (positions.size >= MAX_POSITIONS) {
    let oldest: { key: string; ts: number } | null = null;
    for (const [k, v] of positions) {
      if (v.status === "CLOSED" || v.status === "EXPIRED") {
        if (!oldest || v.statusAt < oldest.ts) oldest = { key: k, ts: v.statusAt };
      }
    }
    if (oldest) positions.delete(oldest.key);
  }
  const sentiment = (hit.sentiment as FollowPosition["side"]) ?? "NEUTRAL";
  const entryMark = hit.volume > 0 ? hit.premium / (hit.volume * 100) : 0;
  positions.set(hit.occ, {
    occ: hit.occ,
    symbol: hit.symbol,
    type: hit.type,
    strike: hit.strike,
    expiration: hit.expiration,
    side: sentiment,
    entry: {
      mark: entryMark,
      premium: hit.premium,
      delta: hit.delta,
      volume: hit.volume,
      openInterest: hit.openInterest,
      detectedAt: hit.detectedAt,
      bid: Number.isFinite(hit.bid as number) ? (hit.bid as number) : null,
      ask: Number.isFinite(hit.ask as number) ? (hit.ask as number) : null,
    },
    live: {
      mark: entryMark,
      pctChange: 0,
      peakMark: entryMark,
      peakPctChange: 0,
      troughMark: entryMark,
      volume: hit.volume,
      volumeSinceEntry: 0,
      lastUpdateAt: hit.detectedAt,
      fadeStreak: 0,
      drawdownStreak: 0,
      lastVolumeBumpAt: hit.detectedAt,
    },
    status: "OPEN",
    statusAt: hit.detectedAt,
  });
  safePersistFollow(positions.get(hit.occ)!);
}

/** Re-price every open position from a fresh chain pull. Called by flowAlertEngine after each eval. */
export async function updateAll(): Promise<{
  updated: number;
  closed: number;
  errors: number;
}> {
  const nowMs = Date.now();
  // CLOSED (premium ~0) positions keep logging quotes until the expiry close so
  // the grader has a real exit mark for them too; otherwise the worst trades
  // would drop out of the ledger as "no mark" and bias it upward.
  const open = Array.from(positions.values()).filter(
    (p) => p.status !== "EXPIRED" && (p.status !== "CLOSED" || nowMs <= expiryCloseMs(p.expiration)),
  );
  if (open.length === 0) return { updated: 0, closed: 0, errors: 0 };

  // Group by symbol so we make ≤1 chain call per ticker
  const bySymbol = new Map<string, FollowPosition[]>();
  for (const p of open) {
    if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, []);
    bySymbol.get(p.symbol)!.push(p);
  }

  let updated = 0;
  let closed = 0;
  let errors = 0;
  const now = Date.now();

  for (const [symbol, group] of bySymbol) {
    try {
      // Pull a wider net — we don't want to filter by volume here
      const flow = await buildSchwabFlow(symbol, {
        minVolume: 0,
        minVolOi: 0,
        maxDte: 365,
        limit: 5000,
      });
      if ("error" in flow) {
        errors++;
        // Don't mark positions as errored — just skip this cycle
        continue;
      }
      const byOcc = new Map<string, SchwabFlowContract>();
      for (const c of flow.contracts) byOcc.set(c.occ, c);
      for (const p of group) {
        const live = byOcc.get(p.occ);
        if (!live) {
          // Contract dropped from chain — likely expired
          if (isExpired(p.expiration)) {
            transitionToTerminal(p, "EXPIRED", "expiration date passed", now);
            safePersistFollow(p);
            closed++;
          }
          continue;
        }
        if (p.status === "CLOSED") {
          recordQuote(p, live, flow.asOf ?? now);
          safePersistFollow(p);
          continue;
        }
        applyTick(p, live, now, flow.asOf ?? now);
        safePersistFollow(p);
        updated++;
        const after = p.status as FollowStatus; // applyTick may have moved it to a terminal state
        if (after === "CLOSED" || after === "EXPIRED") closed++;
      }
    } catch {
      errors++;
    }
  }
  return { updated, closed, errors };
}

function isExpired(expiration: string): boolean {
  // expiration shape varies; treat anything parseable
  const d = Date.parse(expiration);
  if (!isFinite(d)) return false;
  // Date.parse("YYYY-MM-DD") is UTC midnight, so "+16.5h" was 16:30 UTC = 12:30 ET and
  // positions were stamped EXPIRED (P&L frozen) 3.5 h early. 21.5 h = 16:30 ET (17:30 EDT).
  return Date.now() > d + 21.5 * 60 * 60_000;
}

function expiryCloseMs(expiration: string): number {
  const ms = etCloseMs(String(expiration).slice(0, 10));
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** Store the latest quote; keep the last one at or before the expiry close as the exit mark. */
function recordQuote(p: FollowPosition, live: SchwabFlowContract, quoteAt: number): void {
  const bid = Number.isFinite(live.bid) && live.bid >= 0 ? live.bid : null;
  const ask = Number.isFinite(live.ask) && live.ask > 0 ? live.ask : null;
  const mark = Number.isFinite(live.mark) && live.mark > 0 ? live.mark : null;
  p.live.bid = bid;
  p.live.ask = ask;
  p.live.quoteAt = quoteAt;
  if ((bid != null || ask != null) && quoteAt <= expiryCloseMs(p.expiration)) {
    p.live.preExpiryQuote = { bid, ask, mark, at: quoteAt };
  }
}

function applyTick(p: FollowPosition, live: SchwabFlowContract, now: number, quoteAt: number = now): void {
  const newMark = live.mark > 0 ? live.mark : p.live.mark ?? p.entry.mark;
  const prevMark = p.live.mark ?? p.entry.mark;
  const pctChange = p.entry.mark > 0 ? (newMark - p.entry.mark) / p.entry.mark : 0;

  // Volume tracking (Schwab volume is session cumulative — bump if it grew)
  const prevVolume = p.live.volume;
  const newVolume = live.volume;
  const volBumped = newVolume > prevVolume;

  // Streaks
  const fadeStreak = newMark < prevMark ? p.live.fadeStreak + 1 : 0;
  const drawdownStreak =
    p.entry.mark > 0 && newMark <= 0.50 * p.entry.mark
      ? p.live.drawdownStreak + 1
      : 0;

  p.live = {
    mark: newMark,
    pctChange,
    peakMark: Math.max(p.live.peakMark, newMark),
    peakPctChange: Math.max(p.live.peakPctChange, pctChange),
    troughMark: Math.min(p.live.troughMark, newMark),
    volume: newVolume,
    volumeSinceEntry: Math.max(0, newVolume - p.entry.volume),
    lastUpdateAt: now,
    fadeStreak,
    drawdownStreak,
    lastVolumeBumpAt: volBumped ? now : p.live.lastVolumeBumpAt,
    bid: p.live.bid,
    ask: p.live.ask,
    quoteAt: p.live.quoteAt,
    preExpiryQuote: p.live.preExpiryQuote,
    lastFire: p.live.lastFire,
    refireCount: p.live.refireCount,
    peakBid: p.live.peakBid ?? null,
  };
  recordQuote(p, live, quoteAt);
  if (p.live.bid != null && (p.live.peakBid == null || p.live.bid > p.live.peakBid)) p.live.peakBid = p.live.bid;

  // ─── Status transitions ──────────────────────────────────────────────────
  // CLOSED: mark went to ~0. Note this is "premium blew up / worthless", not evidence of
  // a voluntary exit; the reason string says so (status enum kept for UI/schema compat).
  if (newMark <= 0.05 || (p.entry.mark > 0 && newMark / p.entry.mark <= 0.05)) {
    transitionToTerminal(p, "CLOSED", `mark ${newMark.toFixed(2)} → ~0 (premium blown, not a voluntary exit)`, now);
    return;
  }
  // EXPIRED: contract expired today
  if (isExpired(p.expiration)) {
    transitionToTerminal(p, "EXPIRED", "expiration date passed", now);
    return;
  }
  // CLOSING: drawdown ≥3 ticks AND no volume bump in 5+ min (whale isn't adding)
  const noFreshVolume = now - p.live.lastVolumeBumpAt > 5 * 60_000;
  if (drawdownStreak >= 3 && noFreshVolume) {
    if (p.status !== "CLOSING") {
      p.status = "CLOSING";
      p.statusAt = now;
    }
    return;
  }
  // TRIMMING: peak ≥ +50% AND faded ≥30% from peak (took some off)
  if (p.live.peakPctChange >= 0.50) {
    const giveback = (p.live.peakMark - newMark) / p.live.peakMark;
    if (giveback >= 0.30) {
      if (p.status !== "TRIMMING") {
        p.status = "TRIMMING";
        p.statusAt = now;
      }
      return;
    }
  }
  // Otherwise OPEN
  if (p.status !== "OPEN") {
    p.status = "OPEN";
    p.statusAt = now;
  }
}

function transitionToTerminal(
  p: FollowPosition,
  status: "CLOSED" | "EXPIRED",
  reason: string,
  now: number,
): void {
  p.status = status;
  p.statusAt = now;
  p.closingPrint = {
    mark: p.live.mark ?? 0,
    pctChange: p.live.pctChange,
    peakPctChange: p.live.peakPctChange,
    closedAt: now,
    reason,
    bid: p.live.bid ?? null,
  };
}

// ─── Read-only API for routes ────────────────────────────────────────────────

/** Tradable-price read attached to each position in the snapshot (additive). */
export interface FollowScore {
  basis: "ask_in_bid_out_net_fees";
  /** Terminal: final result. Active: what selling at the current bid would net. Null when a quote is missing. */
  netReturn: number | null;
  pnlPerContract: number | null;
  win: boolean | null;
  final: boolean;
  reason: string | null;
}

export interface FollowSnapshot {
  asOf: number;
  total: number;
  byStatus: Record<FollowStatus, number>;
  positions: Array<FollowPosition & { score?: FollowScore }>;
  priceBasisNote?: string;
}

export function getFollowSnapshot(filter?: {
  status?: FollowStatus | "ACTIVE" | "TERMINAL";
  symbol?: string;
  /** If true, include EXPIRED positions that are genuinely past expiry. Default false (auto-purge from view). */
  includeExpired?: boolean;
}): FollowSnapshot {
  const all = Array.from(positions.values());
  // GC very old terminal records
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const p of all) {
    if ((p.status === "CLOSED" || p.status === "EXPIRED") && p.statusAt < cutoff) {
      positions.delete(p.occ);
    }
  }
  const byStatus: Record<FollowStatus, number> = {
    OPEN: 0,
    TRIMMING: 0,
    CLOSING: 0,
    CLOSED: 0,
    EXPIRED: 0,
  };
  for (const p of all) byStatus[p.status]++;

  let filtered = all;
  // Auto-purge expired contracts from view unless explicitly requested.
  // Keep in DB for 90d (rollup endpoint uses includeExpired=true).
  if (!filter?.includeExpired) {
    filtered = filtered.filter(
      (p) => !(p.status === "EXPIRED" && isExpired(p.expiration)),
    );
  }
  if (filter?.status) {
    if (filter.status === "ACTIVE") {
      filtered = filtered.filter(
        (p) => p.status === "OPEN" || p.status === "TRIMMING" || p.status === "CLOSING",
      );
    } else if (filter.status === "TERMINAL") {
      filtered = filtered.filter((p) => p.status === "CLOSED" || p.status === "EXPIRED");
    } else {
      filtered = filtered.filter((p) => p.status === filter.status);
    }
  }
  if (filter?.symbol) {
    filtered = filtered.filter((p) => p.symbol === filter.symbol);
  }
  // Most recently updated first, with active before terminal
  filtered.sort((a, b) => {
    const order = (s: FollowStatus): number =>
      s === "OPEN" ? 0
      : s === "TRIMMING" ? 1
      : s === "CLOSING" ? 2
      : s === "CLOSED" ? 3
      : 4;
    if (order(a.status) !== order(b.status)) return order(a.status) - order(b.status);
    return b.live.lastUpdateAt - a.live.lastUpdateAt;
  });
  return {
    asOf: Date.now(),
    total: all.length,
    byStatus,
    positions: filtered.map((p) => ({ ...p, score: followScore(p) })),
    priceBasisNote: SCOREBOARD_BASIS_NOTE,
  };
}

function followScore(p: FollowPosition): FollowScore {
  const terminal = p.status === "CLOSED" || p.status === "EXPIRED";
  const base: FollowScore = { basis: "ask_in_bid_out_net_fees", netReturn: null, pnlPerContract: null, win: null, final: terminal, reason: null };
  try {
    if (terminal) {
      const fr = feeForProduct(p.occ);
      if (fr.fee == null) return { ...base, reason: fr.basis };
      const s = scoreFollowPosition(p, fr.fee);
      return s ? { ...base, netReturn: s.trade.netReturn, pnlPerContract: s.trade.pnlPerContract, win: s.trade.win }
        : { ...base, reason: "no logged entry ask or exit bid: not scored" };
    }
    const fr = feeForProduct(p.occ);
    if (fr.fee == null) return { ...base, reason: fr.basis };
    const e = entryQuote(p);
    const t = scoreAskToBid({ entryBid: e.bid, entryAsk: e.ask, exitBid: p.live.bid ?? null, feePerContract: fr.fee });
    return t ? { ...base, netReturn: t.netReturn, pnlPerContract: t.pnlPerContract, win: t.win }
      : { ...base, reason: e.ask == null ? "no logged entry ask" : "no current bid" };
  } catch {
    return { ...base, reason: "score unavailable" };
  }
}

/** For tests / debug: clear all tracking. */
export function _clearFollows(): void {
  positions.clear();
}

// ─── Performance rollup ──────────────────────────────────────────────────────
// Scored on tradable prices (whaleScoreboard.ts): logged ask at detection in,
// logged bid at the terminal moment out, fees per contract per side, win =
// positive net P&L. It used to be mid-to-mid (closingPrint.pctChange), which
// overstated every result by the round-trip spread.

/** Kept for API compatibility: the row now carries the scoreboard fields too. */
export type PerformanceRow = ScoreboardRow;

export interface PerformanceSnapshot {
  asOf: number;
  windowDays: number;
  totalTerminal: number;
  bySource: PerformanceRow[];
  /** Aggregate across all sources */
  overall: PerformanceRow;
  priceBasisNote?: string;
}

const EXIT_QUOTE_MAX_AGE_MS = 20 * 60_000;

/** Exit bid for a terminal position, or null when none was logged in time. */
function terminalExitBid(p: FollowPosition): number | null {
  if (p.status === "EXPIRED") {
    const acc = acceptExitQuote(p.live.preExpiryQuote ?? null, expiryCloseMs(p.expiration), EXIT_QUOTE_MAX_AGE_MS);
    return acc.ok ? acc.bid : null;
  }
  const b = p.closingPrint?.bid;
  return b != null && Number.isFinite(b) && b >= 0 ? b : null;
}

function entryQuote(p: FollowPosition): { bid: number | null; ask: number | null } {
  if (p.entry.ask != null) return { bid: p.entry.bid ?? null, ask: p.entry.ask };
  try {
    const q = loadWhaleEntryQuote(p.occ, p.entry.detectedAt);
    return { bid: q?.bid ?? null, ask: q?.ask ?? null };
  } catch { return { bid: null, ask: null }; }
}

/** Score one terminal position at ask in / bid out, net of fees; null when a quote or the fee (index root) is missing. */
export function scoreFollowPosition(p: FollowPosition, feePerContract: number | null = feeForProduct(p.occ).fee): { trade: ScoredTrade; peakNetReturn: number | null } | null {
  const e = entryQuote(p);
  const trade = scoreAskToBid({ entryBid: e.bid, entryAsk: e.ask, exitBid: terminalExitBid(p), feePerContract });
  if (!trade) return null;
  const peak = p.live.peakBid != null ? scoreAskToBid({ entryBid: e.bid, entryAsk: e.ask, exitBid: p.live.peakBid, feePerContract }) : null;
  return { trade, peakNetReturn: peak ? peak.netReturn : null };
}

/**
 * Aggregate terminal positions (CLOSED + EXPIRED) by source.
 * Whale follow positions always have source = "whale".
 * windowDays filters by statusAt within the last N days. Default 7.
 */
export function getPerformanceSnapshot(opts?: { windowDays?: number }): PerformanceSnapshot {
  const windowDays = opts?.windowDays ?? 7;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60_000;
  const all = Array.from(positions.values());
  const terminal = all.filter(
    (p) =>
      (p.status === "CLOSED" || p.status === "EXPIRED") &&
      p.statusAt >= cutoff &&
      p.closingPrint != null,
  );

  const scored: Array<{ trade: ScoredTrade; peakNetReturn: number | null }> = [];
  let excluded = 0, excludedNoFee = 0;
  for (const p of terminal) {
    const fee = feeForProduct(p.occ).fee;
    if (fee == null) { excludedNoFee++; continue; }
    const s = scoreFollowPosition(p, fee);
    if (s) scored.push(s); else excluded++;
  }
  // whaleFollowThrough only tracks whale-source positions
  const row = buildScoreboardRow("whale", scored, excluded, undefined, excludedNoFee);
  return {
    asOf: Date.now(),
    windowDays,
    totalTerminal: terminal.length,
    bySource: terminal.length > 0 ? [row] : [],
    overall: { ...row, source: "overall" },
    priceBasisNote: SCOREBOARD_BASIS_NOTE,
  };
}

/** Hydrate in-memory positions from SQLite on boot. Fail-soft. */
export function hydrateFromDb(): { loaded: number } {
  try {
    const rows = loadAllFollows() as unknown as Array<{
      occ: string;
      symbol: string;
      type: string;
      strike: number;
      expiration: string;
      side: string;
      entryJson: string;
      currentLiveJson: string;
      status: string;
      statusAt: number;
      closingPrintJson: string | null;
    }>;
    let loaded = 0;
    for (const r of rows) {
      try {
        const entry = JSON.parse(r.entryJson);
        const live = JSON.parse(r.currentLiveJson);
        const closing = r.closingPrintJson ? JSON.parse(r.closingPrintJson) : undefined;
        const status = r.status as FollowStatus;
        positions.set(r.occ, {
          occ: r.occ,
          symbol: r.symbol,
          type: r.type as "C" | "P",
          strike: r.strike,
          expiration: r.expiration,
          side: r.side as FollowPosition["side"],
          entry,
          live,
          status,
          statusAt: r.statusAt,
          closingPrint: closing,
        });
        loaded++;
      } catch {
        /* corrupt row — skip */
      }
    }
    return { loaded };
  } catch {
    return { loaded: 0 };
  }
}
