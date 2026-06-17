/**
 * GREEK GRADIENT SNAPSHOTS — for VS3D-style time-series heatmap
 *
 * Stores per-strike greek exposure values at periodic snapshots so the
 * heatmap can render a 2D grid: time (x-axis) × strike (y-axis), color = greek value.
 *
 * Storage strategy:
 * - Snapshot every chain audit run (currently ~every 30s during market hours)
 * - Keep 6 hours rolling window (enough for an intraday gradient view)
 * - Auto-prune older than 6h to keep table small
 *
 * Schema:
 *   id          INTEGER PRIMARY KEY
 *   ts          INTEGER NOT NULL  — unix ms
 *   symbol      TEXT NOT NULL     — 'SPY', 'QQQ', etc.
 *   spot        REAL NOT NULL     — underlying price at snapshot
 *   strike      REAL NOT NULL     — option strike
 *   greek_type  TEXT NOT NULL     — 'vanna' | 'charm' | 'vomma' | 'zomma' | 'gex'
 *   exposure    REAL NOT NULL     — $ exposure per 1% vol move (vanna/vomma) etc.
 *
 * Index on (symbol, greek_type, ts DESC) for fast slicing.
 */

import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "data", "greek_gradient.db");
let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS greek_gradient (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      symbol      TEXT NOT NULL,
      spot        REAL NOT NULL,
      strike      REAL NOT NULL,
      greek_type  TEXT NOT NULL,
      exposure    REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gg_lookup ON greek_gradient(symbol, greek_type, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_gg_prune ON greek_gradient(ts);
  `);

  return db;
}

export interface GreekSnapshotRow {
  symbol: string;
  spot: number;
  strike: number;
  greekType: "vanna" | "charm" | "vomma" | "zomma" | "gex";
  exposure: number;
}

/** Bulk insert one snapshot worth of greek values (one ts, many strikes × greeks). */
export function insertGreekSnapshot(ts: number, rows: GreekSnapshotRow[]): void {
  if (rows.length === 0) return;
  const stmt = getDb().prepare(`
    INSERT INTO greek_gradient (ts, symbol, spot, strike, greek_type, exposure)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = getDb().transaction((batch: GreekSnapshotRow[]) => {
    for (const r of batch) {
      stmt.run(ts, r.symbol, r.spot, r.strike, r.greekType, r.exposure);
    }
  });
  tx(rows);
}

export interface GradientPoint {
  ts: number;
  spot: number;
  strike: number;
  exposure: number;
}

/**
 * Fetch gradient data for a symbol + greek over a time window.
 * Returns rows sorted by ts ASC, strike ASC — ready for grid render.
 */
export function fetchGradient(
  symbol: string,
  greekType: "vanna" | "charm" | "vomma" | "zomma" | "gex",
  sinceMs: number,
): GradientPoint[] {
  const rows = getDb()
    .prepare(
      `SELECT ts, spot, strike, exposure
       FROM greek_gradient
       WHERE symbol = ? AND greek_type = ? AND ts >= ?
       ORDER BY ts ASC, strike ASC`,
    )
    .all(symbol, greekType, sinceMs) as GradientPoint[];
  return rows;
}

/** Prune rows older than `keepMs` (default 6h). Call periodically. */
export function pruneOldSnapshots(keepMs: number = 6 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - keepMs;
  const result = getDb().prepare(`DELETE FROM greek_gradient WHERE ts < ?`).run(cutoff);
  return Number(result.changes);
}

/** Snapshot count + oldest/newest ts (for diagnostics). */
export function getGradientStats(symbol?: string): {
  count: number;
  oldestTs: number | null;
  newestTs: number | null;
} {
  const where = symbol ? `WHERE symbol = ?` : "";
  const params = symbol ? [symbol] : [];
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) as count, MIN(ts) as oldestTs, MAX(ts) as newestTs
       FROM greek_gradient ${where}`,
    )
    .get(...params) as { count: number; oldestTs: number | null; newestTs: number | null };
  return row;
}
