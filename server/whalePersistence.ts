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

import { db } from "./storage";
import { whaleAlerts, whaleFollows } from "@shared/schema";
import type { WhaleAlert, WhaleFollow } from "@shared/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { WhaleHit } from "./flowAlertEngine";
import type { FollowPosition } from "./whaleFollowThrough";

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
      })
      .run();
  } catch (e) {
    console.warn("[whalePersistence] alert insert failed:", (e as Error).message);
  }
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
