// ─────────────────────────────────────────────────────────────────────────────
// whalePersistence.ts — durable storage for whale alerts + follow-through.
//
// User spec (verbatim):
//   "I like the flow bot but make it able to track the flow and come back to it
//    see closing position etc"
//
// Design:
//   - whale_alerts:  append-only audit log of every detection (one row per fire)
//   - whale_follows: state-of-the-world for tracker (one row per OCC, upserted)
//
// Engineering contract (preserved):
//   - read-only DB observer pattern; every wire-in fail-soft (try/catch)
//   - synchronous better-sqlite3 driver (.run / .get / .all — no destructure)
//   - never throws to callers — errors logged, swallowed
// ─────────────────────────────────────────────────────────────────────────────

import { db, sqlite } from "./storage";
import { whaleAlerts, whaleFollows } from "@shared/schema";
import type { WhaleAlert, WhaleFollow } from "@shared/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { WhaleHit } from "./flowAlertEngine";
import type { FollowPosition } from "./whaleFollowThrough";

// ─── Entry-quote ledger (review items 4.4 / 8.2) ─────────────────────────────
// whale_alerts has no bid/ask, so the option P&L of an alert could only be
// proxied. Every detection now also logs the contract's quote at detection
// ($ per share, as quoted; one contract = 100x). Keyed by (occ, detected_at),
// the same values outcomeLogger stores as the prediction's occ / captured_at.
try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS whale_alert_quotes (
      occ TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      bid REAL,
      ask REAL,
      mid REAL,
      spot REAL,
      iv REAL,
      PRIMARY KEY (occ, detected_at)
    );
  `);
} catch (e) {
  console.warn("[whalePersistence] whale_alert_quotes init failed:", (e as Error).message);
}

function finiteOrNull(v: unknown): number | null {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : null;
}

/** Record the quote at detection. Fail-soft. */
export function persistWhaleEntryQuote(hit: WhaleHit): void {
  try {
    const bid = finiteOrNull(hit.bid);
    const ask = finiteOrNull(hit.ask);
    if (bid == null && ask == null) return;
    sqlite.prepare(`INSERT OR IGNORE INTO whale_alert_quotes (occ, detected_at, bid, ask, mid, spot, iv)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(hit.occ, hit.detectedAt, bid, ask, finiteOrNull(hit.mid), finiteOrNull(hit.spot), finiteOrNull(hit.iv));
  } catch (e) {
    console.warn("[whalePersistence] entry quote insert failed:", (e as Error).message);
  }
}

/** Entry quote for an alert: exact (occ, detected_at) match, else the nearest within 5 minutes. */
export function loadWhaleEntryQuote(occ: string, detectedAt: number): { bid: number | null; ask: number | null; at: number } | null {
  try {
    const row = sqlite.prepare(`SELECT bid, ask, detected_at FROM whale_alert_quotes
                                WHERE occ = ? AND detected_at BETWEEN ? AND ?
                                ORDER BY ABS(detected_at - ?) ASC LIMIT 1`)
      .get(occ, detectedAt - 300_000, detectedAt + 300_000, detectedAt) as { bid: number | null; ask: number | null; detected_at: number } | undefined;
    return row ? { bid: row.bid, ask: row.ask, at: row.detected_at } : null;
  } catch { return null; }
}

/**
 * Last quote the follow-through tracker logged at or before the expiry close
 * (stored in whale_follows.current_live_json.preExpiryQuote). Null if none.
 */
export function loadWhaleExitQuote(occ: string): { bid: number | null; ask: number | null; mark: number | null; at: number } | null {
  try {
    const row = sqlite.prepare(`SELECT current_live_json FROM whale_follows WHERE occ = ?`).get(occ) as { current_live_json: string } | undefined;
    if (!row) return null;
    const live = JSON.parse(row.current_live_json || "{}");
    const q = live?.preExpiryQuote;
    if (!q || !Number.isFinite(Number(q.at))) return null;
    return { bid: finiteOrNull(q.bid), ask: finiteOrNull(q.ask), mark: finiteOrNull(q.mark), at: Number(q.at) };
  } catch { return null; }
}

// ─── Insert path ─────────────────────────────────────────────────────────────

/** Record one whale detection. Fail-soft: never throws. */
export function persistWhaleAlert(hit: WhaleHit): void {
  try {
    db.insert(whaleAlerts)
      .values({
        occ: hit.occ,
        symbol: hit.symbol,
        type: hit.type,
        strike: hit.strike,
        expiration: hit.expiration,
        dte: hit.dte,
        premium: hit.premium,
        volOiRatio: hit.volOiRatio,
        isNewStrike: hit.isNewStrike ? 1 : 0,
        tag: hit.tag,
        sentiment: hit.sentiment,
        delta: hit.delta,
        detectedAt: hit.detectedAt,
        reason: hit.reason,
        openingProb: hit.openingProb ?? null,
        spreadLegLikely: hit.spreadLegLikely == null ? null : (hit.spreadLegLikely ? 1 : 0),
        directionalConfidence: hit.directionalConfidence ?? null,
      })
      .run();
  } catch (e) {
    console.warn("[whalePersistence] alert insert failed:", (e as Error).message);
  }
  persistWhaleEntryQuote(hit);
}

/** Upsert follow-through state for a position. Fail-soft. */
export function persistFollowState(p: FollowPosition): void {
  try {
    const entryJson = JSON.stringify(p.entry);
    const liveJson = JSON.stringify(p.live);
    const closingJson = p.closingPrint ? JSON.stringify(p.closingPrint) : null;
    // INSERT OR REPLACE pattern (occ is PK)
    db.insert(whaleFollows)
      .values({
        occ: p.occ,
        symbol: p.symbol,
        type: p.type,
        strike: p.strike,
        expiration: p.expiration,
        side: p.side,
        entryJson,
        currentLiveJson: liveJson,
        status: p.status,
        statusAt: p.statusAt,
        closingPrintJson: closingJson,
      })
      .onConflictDoUpdate({
        target: whaleFollows.occ,
        set: {
          currentLiveJson: liveJson,
          status: p.status,
          statusAt: p.statusAt,
          closingPrintJson: closingJson,
        },
      })
      .run();
  } catch (e) {
    console.warn("[whalePersistence] follow upsert failed:", (e as Error).message);
  }
}

// ─── Read path ───────────────────────────────────────────────────────────────

/** /api/flow/history payload row */
export interface WhaleAlertHistoryRow {
  id: number;
  occ: string;
  symbol: string;
  type: "C" | "P";
  strike: number;
  expiration: string;
  dte: number;
  premium: number;
  volOiRatio: number;
  isNewStrike: boolean;
  tag: string;
  sentiment: string;
  delta: number;
  detectedAt: number;
  reason: string;
  openingProb: number | null;
  spreadLegLikely: boolean | null;
  directionalConfidence: number | null;
}

/** Pull recent whale alerts. days=1 → last 24h. limit caps result size. */
export function getWhaleAlertHistory(opts: {
  days?: number;
  symbol?: string;
  limit?: number;
} = {}): WhaleAlertHistoryRow[] {
  const days = Math.max(1, Math.min(opts.days ?? 7, 90));
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    const where = opts.symbol
      ? and(gte(whaleAlerts.detectedAt, cutoff), eq(whaleAlerts.symbol, opts.symbol))
      : gte(whaleAlerts.detectedAt, cutoff);
    const rows = db
      .select()
      .from(whaleAlerts)
      .where(where)
      .orderBy(desc(whaleAlerts.detectedAt))
      .limit(limit)
      .all() as WhaleAlert[];
    return rows.map((r) => ({
      id: r.id,
      occ: r.occ,
      symbol: r.symbol,
      type: r.type as "C" | "P",
      strike: r.strike,
      expiration: r.expiration,
      dte: r.dte,
      premium: r.premium,
      volOiRatio: r.volOiRatio,
      isNewStrike: r.isNewStrike === 1,
      tag: r.tag,
      sentiment: r.sentiment,
      delta: r.delta,
      detectedAt: r.detectedAt,
      reason: r.reason,
      openingProb: r.openingProb ?? null,
      spreadLegLikely: r.spreadLegLikely == null ? null : r.spreadLegLikely === 1,
      directionalConfidence: r.directionalConfidence ?? null,
    }));
  } catch (e) {
    console.warn("[whalePersistence] history read failed:", (e as Error).message);
    return [];
  }
}

/** Daily counts/total premium for sparkline summary. */
export function getWhaleAlertDailyStats(days = 14): Array<{
  date: string;
  count: number;
  totalPremium: number;
}> {
  const safeDays = Math.max(1, Math.min(days, 90));
  const cutoff = Date.now() - safeDays * 24 * 60 * 60 * 1000;
  try {
    // SQLite: group by date(epoch_ms / 1000, 'unixepoch')
    const rows = db.all(sql`
      SELECT
        date(detected_at / 1000, 'unixepoch') AS d,
        COUNT(*) AS c,
        COALESCE(SUM(premium), 0) AS p
      FROM whale_alerts
      WHERE detected_at >= ${cutoff}
      GROUP BY d
      ORDER BY d DESC
    `) as Array<{ d: string; c: number; p: number }>;
    return rows.map((r) => ({
      date: r.d,
      count: Number(r.c),
      totalPremium: Number(r.p),
    }));
  } catch (e) {
    console.warn("[whalePersistence] daily stats failed:", (e as Error).message);
    return [];
  }
}

/** Hydrate the in-memory follow-through tracker from DB on server boot. */
export function loadAllFollows(): WhaleFollow[] {
  try {
    return db.select().from(whaleFollows).all() as WhaleFollow[];
  } catch (e) {
    console.warn("[whalePersistence] follows hydration failed:", (e as Error).message);
    return [];
  }
}

/**
 * Persistent dedup hydration. Returns the most recent fire timestamp per
 * (occ, premiumTierMillions) within the lookback window so the in-memory
 * dedup map can be seeded after a process restart — prevents the same
 * whale flow from being re-alerted just because the runtime cache was
 * wiped on redeploy.
 *
 * Window default 24h covers overnight redeploys + after-hours rebroadcasts.
 */
export function loadRecentDedupKeys(windowMs = 24 * 60 * 60 * 1000): Array<{
  dedupKey: string;
  detectedAt: number;
}> {
  try {
    const cutoff = Date.now() - windowMs;
    const rows = db
      .select()
      .from(whaleAlerts)
      .where(gte(whaleAlerts.detectedAt, cutoff))
      .orderBy(desc(whaleAlerts.detectedAt))
      .all() as WhaleAlert[];
    // Collapse to most-recent-detection per dedup key.
    const seen = new Map<string, number>();
    for (const r of rows) {
      const tier = Math.ceil(r.premium / 1_000_000);
      const key = `${r.occ}|t${tier}`;
      if (!seen.has(key)) seen.set(key, r.detectedAt);
      const coarse = `coarse|${r.symbol}|${r.type}|${r.strike}|${r.expiration}|t${tier}`;
      if (!seen.has(coarse)) seen.set(coarse, r.detectedAt);
    }
    return Array.from(seen.entries()).map(([dedupKey, detectedAt]) => ({
      dedupKey,
      detectedAt,
    }));
  } catch (e) {
    console.warn("[whalePersistence] dedup hydration failed:", (e as Error).message);
    return [];
  }
}
