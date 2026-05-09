import { snapshots, xUsers, xTweets, schwabTokens } from "@shared/schema";
import type { Snapshot, InsertSnapshot, XUser, XTweet, SchwabToken } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";

const sqlite = new Database("data.db");
export { sqlite };
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
  CREATE TABLE IF NOT EXISTS backtest_levels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    horizon TEXT NOT NULL,
    level_kind TEXT NOT NULL,
    sample_size INTEGER NOT NULL,
    touch_rate REAL NOT NULL,
    hold_rate REAL NOT NULL,
    avg_abs_dist_bps REAL NOT NULL,
    median_abs_dist_bps REAL NOT NULL,
    breach_beyond_pct REAL NOT NULL,
    computed_at INTEGER NOT NULL,
    methodology TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_backtest_levels_h_k ON backtest_levels(horizon, level_kind);
  CREATE TABLE IF NOT EXISTS backtest_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    horizon TEXT NOT NULL,
    level_kind TEXT NOT NULL,
    predicted_price REAL NOT NULL,
    realized_close REAL NOT NULL,
    realized_high REAL NOT NULL,
    realized_low REAL NOT NULL,
    touched INTEGER NOT NULL,
    held INTEGER NOT NULL,
    abs_dist_bps REAL NOT NULL,
    breach_beyond_pct INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_backtest_obs_h_k_date ON backtest_observations(horizon, level_kind, date);
  CREATE TABLE IF NOT EXISTS model_recals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,          -- ^GSPC / SPY
    horizon TEXT NOT NULL,         -- daily / weekly / monthly / quarterly
    captured_at INTEGER NOT NULL,  -- epoch seconds
    trade_date TEXT NOT NULL,      -- YYYY-MM-DD America/New_York
    spot REAL NOT NULL,
    dfi REAL NOT NULL,
    charm_per_day REAL NOT NULL,   -- $B/day signed
    iv_1d REAL,                    -- today's 1D IV %
    charm_zero REAL,
    zero_gamma REAL
  );
  CREATE INDEX IF NOT EXISTS idx_model_recals_sym_h_date ON model_recals(symbol, horizon, trade_date, captured_at DESC);
  CREATE TABLE IF NOT EXISTS whale_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occ TEXT NOT NULL,
    symbol TEXT NOT NULL,
    type TEXT NOT NULL,
    strike REAL NOT NULL,
    expiration TEXT NOT NULL,
    dte INTEGER NOT NULL,
    premium REAL NOT NULL,
    vol_oi_ratio REAL NOT NULL,
    is_new_strike INTEGER NOT NULL,
    tag TEXT NOT NULL,
    sentiment TEXT NOT NULL,
    delta REAL NOT NULL,
    detected_at INTEGER NOT NULL,
    reason TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_whale_alerts_symbol_detected ON whale_alerts(symbol, detected_at DESC);
  CREATE INDEX IF NOT EXISTS idx_whale_alerts_detected ON whale_alerts(detected_at DESC);
  CREATE TABLE IF NOT EXISTS whale_follows (
    occ TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    type TEXT NOT NULL,
    strike REAL NOT NULL,
    expiration TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_json TEXT NOT NULL,
    current_live_json TEXT NOT NULL,
    status TEXT NOT NULL,
    status_at INTEGER NOT NULL,
    closing_print_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_whale_follows_status_at ON whale_follows(status, status_at DESC);
  CREATE TABLE IF NOT EXISTS prediction_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prediction_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    symbol TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    grading_due_at INTEGER NOT NULL,
    inputs_json TEXT NOT NULL,
    prediction_json TEXT NOT NULL,
    outcome_json TEXT,
    pct_return REAL,
    hit_30 INTEGER,
    hit_50 INTEGER,
    hit_100 INTEGER,
    graded INTEGER NOT NULL DEFAULT 0,
    graded_at INTEGER,
    grade_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_pred_outcomes_kind_captured ON prediction_outcomes(kind, captured_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pred_outcomes_due ON prediction_outcomes(graded, grading_due_at);
  CREATE INDEX IF NOT EXISTS idx_pred_outcomes_symbol ON prediction_outcomes(symbol, captured_at DESC);
  CREATE TABLE IF NOT EXISTS trade_log (
    id TEXT PRIMARY KEY,
    captured_at INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    instrument TEXT NOT NULL,
    occ TEXT,
    strike REAL,
    opt_type TEXT,
    expiry TEXT,
    qty REAL NOT NULL,
    entry_price REAL NOT NULL,
    mid_at_entry REAL,
    signal_source TEXT,
    notes TEXT,
    graded INTEGER NOT NULL DEFAULT 0,
    closing_mid REAL,
    close_time INTEGER,
    clv_bps REAL,
    clv_dollars REAL,
    exit_price REAL,
    exit_time INTEGER,
    pnl_dollars REAL
  );
  CREATE INDEX IF NOT EXISTS idx_trade_log_captured ON trade_log(captured_at DESC);
  CREATE INDEX IF NOT EXISTS idx_trade_log_symbol ON trade_log(symbol, captured_at DESC);
  CREATE INDEX IF NOT EXISTS idx_trade_log_graded ON trade_log(graded, captured_at);
  CREATE TABLE IF NOT EXISTS fred_series (
    series_id TEXT NOT NULL,
    date TEXT NOT NULL,
    value REAL,
    refreshed_at INTEGER NOT NULL,
    PRIMARY KEY (series_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_fred_series_date ON fred_series(series_id, date DESC);
  CREATE TABLE IF NOT EXISTS cot_reports (
    market TEXT NOT NULL,
    report_date TEXT NOT NULL,
    commercial_net REAL,
    non_commercial_net REAL,
    small_specs_net REAL,
    oi REAL,
    payload TEXT,
    PRIMARY KEY (market, report_date)
  );
  CREATE INDEX IF NOT EXISTS idx_cot_reports_date ON cot_reports(market, report_date DESC);
  CREATE TABLE IF NOT EXISTS iv_rv_daily (
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    rv_5 REAL,
    rv_10 REAL,
    rv_20 REAL,
    rv_30 REAL,
    rv_60 REAL,
    iv_30 REAL,
    iv_60 REAL,
    iv_90 REAL,
    captured_at INTEGER NOT NULL,
    PRIMARY KEY (symbol, date)
  );
  CREATE INDEX IF NOT EXISTS idx_iv_rv_daily_date ON iv_rv_daily(symbol, date DESC);
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

export type ModelRecalRow = {
  id: number;
  symbol: string;
  horizon: string;
  capturedAt: number;
  tradeDate: string;
  spot: number;
  dfi: number;
  charmPerDay: number;
  iv1d: number | null;
  charmZero: number | null;
  zeroGamma: number | null;
};

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

  // ---- Model recal snapshots (Batcave #3 — intraday recal tracking) ----
  insertModelRecal(r: {
    symbol: string; horizon: string; capturedAt: number; tradeDate: string;
    spot: number; dfi: number; charmPerDay: number; iv1d: number | null;
    charmZero: number | null; zeroGamma: number | null;
  }): void {
    sqlite.prepare(
      `INSERT INTO model_recals
         (symbol, horizon, captured_at, trade_date, spot, dfi, charm_per_day, iv_1d, charm_zero, zero_gamma)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.symbol, r.horizon, r.capturedAt, r.tradeDate, r.spot, r.dfi, r.charmPerDay, r.iv1d, r.charmZero, r.zeroGamma);
  }

  getLatestRecal(symbol: string, horizon: string): ModelRecalRow | undefined {
    return sqlite.prepare(
      `SELECT id, symbol, horizon, captured_at as capturedAt, trade_date as tradeDate,
              spot, dfi, charm_per_day as charmPerDay, iv_1d as iv1d,
              charm_zero as charmZero, zero_gamma as zeroGamma
       FROM model_recals
       WHERE symbol = ? AND horizon = ?
       ORDER BY captured_at DESC
       LIMIT 1`,
    ).get(symbol, horizon) as ModelRecalRow | undefined;
  }

  getTodayOpenRecal(symbol: string, horizon: string, tradeDate: string): ModelRecalRow | undefined {
    return sqlite.prepare(
      `SELECT id, symbol, horizon, captured_at as capturedAt, trade_date as tradeDate,
              spot, dfi, charm_per_day as charmPerDay, iv_1d as iv1d,
              charm_zero as charmZero, zero_gamma as zeroGamma
       FROM model_recals
       WHERE symbol = ? AND horizon = ? AND trade_date = ?
       ORDER BY captured_at ASC
       LIMIT 1`,
    ).get(symbol, horizon, tradeDate) as ModelRecalRow | undefined;
  }

  getPrevTradeDayRecal(symbol: string, horizon: string, todayTradeDate: string): ModelRecalRow | undefined {
    return sqlite.prepare(
      `SELECT id, symbol, horizon, captured_at as capturedAt, trade_date as tradeDate,
              spot, dfi, charm_per_day as charmPerDay, iv_1d as iv1d,
              charm_zero as charmZero, zero_gamma as zeroGamma
       FROM model_recals
       WHERE symbol = ? AND horizon = ? AND trade_date < ?
       ORDER BY trade_date DESC, captured_at DESC
       LIMIT 1`,
    ).get(symbol, horizon, todayTradeDate) as ModelRecalRow | undefined;
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
