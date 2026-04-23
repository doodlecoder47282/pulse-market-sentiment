import { snapshots, xUsers, xTweets, schwabTokens } from "@shared/schema";
import type { Snapshot, InsertSnapshot, XUser, XTweet, SchwabToken } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

// Create tables if they don't exist
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS x_users (
    handle TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    resolved_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS x_tweets (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    text TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_xtweets_handle_created ON x_tweets(handle, created_at DESC);
  CREATE TABLE IF NOT EXISTS snapshot_history (
    date TEXT PRIMARY KEY,              -- YYYY-MM-DD America/New_York trade date
    captured_at INTEGER NOT NULL,
    spy_close REAL NOT NULL,
    composite INTEGER NOT NULL,
    vix REAL NOT NULL,
    gamma_regime TEXT NOT NULL,
    net_gex REAL NOT NULL,
    pcr_oi REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS daily_bars (
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,   -- YYYY-MM-DD (America/New_York trade date)
    close REAL NOT NULL,
    t INTEGER NOT NULL,   -- epoch seconds
    PRIMARY KEY (symbol, date)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_bars_symbol_date ON daily_bars(symbol, date DESC);
  CREATE TABLE IF NOT EXISTS schwab_tokens (
    id INTEGER PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    refresh_expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export { schwabTokens };

export const db = drizzle(sqlite);

type XTweetInsert = {
  id: string;
  handle: string;
  createdAt: number;
  text: string;
  payload: string;
};

export interface IStorage {
  getLatestSnapshot(): Promise<Snapshot | undefined>;
  saveSnapshot(s: InsertSnapshot): Promise<Snapshot>;
  // X cache
  getXUser(handle: string): Promise<XUser | undefined>;
  saveXUser(handle: string, userId: string): Promise<void>;
  getRecentXTweets(handle: string, limit: number): Promise<XTweet[]>;
  getNewestXTweetId(handle: string): Promise<string | null>;
  saveXTweets(rows: XTweetInsert[]): Promise<void>;
  getAllRecentXTweets(handles: string[], limitPerHandle: number): Promise<XTweet[]>;
}

export type SnapshotHistoryRow = {
  date: string;
  capturedAt: number;
  spyClose: number;
  composite: number;
  vix: number;
  gammaRegime: "positive" | "negative" | "neutral";
  netGex: number;
  pcrOi: number;
};

export class DatabaseStorage implements IStorage {
  async getLatestSnapshot(): Promise<Snapshot | undefined> {
    return db.select().from(snapshots).orderBy(desc(snapshots.capturedAt)).limit(1).get();
  }
  async saveSnapshot(s: InsertSnapshot): Promise<Snapshot> {
    return db.insert(snapshots).values(s).returning().get();
  }

  async getXUser(handle: string): Promise<XUser | undefined> {
    return db.select().from(xUsers).where(eq(xUsers.handle, handle.toLowerCase())).get();
  }

  async saveXUser(handle: string, userId: string): Promise<void> {
    const h = handle.toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    // Upsert
    const existing = db.select().from(xUsers).where(eq(xUsers.handle, h)).get();
    if (existing) {
      db.update(xUsers).set({ userId, resolvedAt: now }).where(eq(xUsers.handle, h)).run();
    } else {
      db.insert(xUsers).values({ handle: h, userId, resolvedAt: now }).run();
    }
  }

  async getRecentXTweets(handle: string, limit: number): Promise<XTweet[]> {
    return db.select().from(xTweets)
      .where(eq(xTweets.handle, handle.toLowerCase()))
      .orderBy(desc(xTweets.createdAt))
      .limit(limit)
      .all();
  }

  async getNewestXTweetId(handle: string): Promise<string | null> {
    const row = db.select().from(xTweets)
      .where(eq(xTweets.handle, handle.toLowerCase()))
      .orderBy(desc(xTweets.createdAt))
      .limit(1)
      .get();
    return row?.id ?? null;
  }

  async saveXTweets(rows: XTweetInsert[]): Promise<void> {
    if (!rows.length) return;
    const stmt = sqlite.prepare(
      `INSERT INTO x_tweets (id, handle, created_at, text, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         handle = excluded.handle,
         created_at = excluded.created_at,
         text = excluded.text,
         payload = excluded.payload`,
    );
    const tx = sqlite.transaction((batch: XTweetInsert[]) => {
      for (const r of batch) stmt.run(r.id, r.handle.toLowerCase(), r.createdAt, r.text, r.payload);
    });
    tx(rows);
  }

  async getAllRecentXTweets(handles: string[], limitPerHandle: number): Promise<XTweet[]> {
    const out: XTweet[] = [];
    for (const h of handles) {
      const rows = await this.getRecentXTweets(h, limitPerHandle);
      out.push(...rows);
    }
    return out;
  }

  // Snapshot history — daily trade-date upsert (idempotent per day).
  upsertSnapshotHistory(row: SnapshotHistoryRow): void {
    const stmt = sqlite.prepare(
      `INSERT INTO snapshot_history (date, captured_at, spy_close, composite, vix, gamma_regime, net_gex, pcr_oi)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         captured_at = excluded.captured_at,
         spy_close = excluded.spy_close,
         composite = excluded.composite,
         vix = excluded.vix,
         gamma_regime = excluded.gamma_regime,
         net_gex = excluded.net_gex,
         pcr_oi = excluded.pcr_oi`,
    );
    stmt.run(
      row.date, row.capturedAt, row.spyClose, row.composite, row.vix,
      row.gammaRegime, row.netGex, row.pcrOi,
    );
  }

  // ---- Daily bars cache (for regime rotation tracker) ----
  upsertDailyBars(symbol: string, rows: { date: string; close: number; t: number }[]): void {
    if (!rows.length) return;
    const stmt = sqlite.prepare(
      `INSERT INTO daily_bars (symbol, date, close, t)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(symbol, date) DO UPDATE SET
         close = excluded.close,
         t = excluded.t`,
    );
    const tx = sqlite.transaction((batch: typeof rows) => {
      for (const r of batch) stmt.run(symbol, r.date, r.close, r.t);
    });
    tx(rows);
  }

  getDailyBars(symbol: string, limit = 520): { date: string; close: number; t: number }[] {
    return sqlite.prepare(
      `SELECT date, close, t FROM daily_bars
       WHERE symbol = ?
       ORDER BY date ASC
       LIMIT ?`,
    ).all(symbol, limit) as { date: string; close: number; t: number }[];
  }

  getLatestBarDate(symbol: string): string | null {
    const row = sqlite.prepare(
      `SELECT date FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT 1`,
    ).get(symbol) as { date: string } | undefined;
    return row?.date ?? null;
  }

  getSnapshotHistory(limit = 400): SnapshotHistoryRow[] {
    const rows = sqlite.prepare(
      `SELECT date, captured_at as capturedAt, spy_close as spyClose, composite,
              vix, gamma_regime as gammaRegime, net_gex as netGex, pcr_oi as pcrOi
       FROM snapshot_history
       ORDER BY date DESC
       LIMIT ?`,
    ).all(limit) as SnapshotHistoryRow[];
    return rows;
  }
}

export const storage = new DatabaseStorage();
