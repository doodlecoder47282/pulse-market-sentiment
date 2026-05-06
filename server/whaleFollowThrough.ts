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
    premium: number;       // notional at detection
    delta: number;
    volume: number;        // running session volume at detection
    openInterest: number;
    detectedAt: number;
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
  };
}

// ─── State ────────────────────────────────────────────────────────────────────
const positions = new Map<string, FollowPosition>();
const MAX_POSITIONS = 500;
const STALE_AFTER_MS = 90 * 24 * 60 * 60_000;   // GC after 90 days

// ─── Public API ───────────────────────────────────────────────────────────────

/** Called by flowAlertEngine when a new whale fires. */
export function registerWhale(hit: WhaleHit): void {
  if (positions.has(hit.occ)) {
    // Already tracking — flowAlertEngine premium-tier dedup handles re-fires;
    // we just bump the entry premium on the existing record.
    const p = positions.get(hit.occ)!;
    if (hit.premium > p.entry.premium) {
      p.entry.premium = hit.premium;       // tier increased = more conviction
    }
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
}

/** Re-price every open position from a fresh chain pull. Called by flowAlertEngine after each eval. */
export async function updateAll(): Promise<{
  updated: number;
  closed: number;
  errors: number;
}> {
  const open = Array.from(positions.values()).filter(
    (p) => p.status !== "CLOSED" && p.status !== "EXPIRED",
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
            closed++;
          }
          continue;
        }
        applyTick(p, live, now);
        updated++;
        if (p.status === "CLOSED" || p.status === "EXPIRED") closed++;
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
  // Past 4:30 PM ET on the expiry date is expired
  return Date.now() > d + 16.5 * 60 * 60_000;
}

function applyTick(p: FollowPosition, live: SchwabFlowContract, now: number): void {
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
  };

  // ─── Status transitions ──────────────────────────────────────────────────
  // CLOSED: mark went to ~0 (essentially worthless / closed out)
  if (newMark <= 0.05 || (p.entry.mark > 0 && newMark / p.entry.mark <= 0.05)) {
    transitionToTerminal(p, "CLOSED", `mark ${newMark.toFixed(2)} → ~0`, now);
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
  };
}

// ─── Read-only API for routes ────────────────────────────────────────────────

export interface FollowSnapshot {
  asOf: number;
  total: number;
  byStatus: Record<FollowStatus, number>;
  positions: FollowPosition[];
}

export function getFollowSnapshot(filter?: {
  status?: FollowStatus | "ACTIVE" | "TERMINAL";
  symbol?: string;
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
    positions: filtered,
  };
}

/** For tests / debug: clear all tracking. */
export function _clearFollows(): void {
  positions.clear();
}
