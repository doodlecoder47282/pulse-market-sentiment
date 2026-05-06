import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Minimal cache table — we store the last snapshot so the UI has something
// even if live fetches transiently fail.
export const snapshots = sqliteTable("snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  capturedAt: integer("captured_at").notNull(), // epoch seconds
  payload: text("payload").notNull(), // JSON string of the full snapshot
});

export const insertSnapshotSchema = createInsertSchema(snapshots).omit({ id: true });
export type InsertSnapshot = z.infer<typeof insertSnapshotSchema>;
export type Snapshot = typeof snapshots.$inferSelect;

// Cache table for X user-id lookups so we never waste reads re-resolving handles.
export const xUsers = sqliteTable("x_users", {
  handle: text("handle").primaryKey(),
  userId: text("user_id").notNull(),
  resolvedAt: integer("resolved_at").notNull(),
});
export type XUser = typeof xUsers.$inferSelect;

// Cache table for tweets. Persisted so a refresh that failed still has data.
export const xTweets = sqliteTable("x_tweets", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull(),
  createdAt: integer("created_at").notNull(), // epoch seconds
  text: text("text").notNull(),
  payload: text("payload").notNull(), // full JSON of tweet object
});
export type XTweet = typeof xTweets.$inferSelect;

// Daily snapshot history for historical-analog matching. One row per (symbol, tradeDate).
// Stores the key fields we match on (composite, VIX, gamma regime) + close price for
// forward-return computation.
export const snapshotHistory = sqliteTable("snapshot_history", {
  date: text("date").primaryKey(),       // YYYY-MM-DD (America/New_York trade date)
  capturedAt: integer("captured_at").notNull(),
  spyClose: integer("spy_close").notNull(),         // close * 100 (to keep as int) — actually store as float via text to preserve precision
  composite: integer("composite").notNull(),        // 0-100 integer
  vix: integer("vix").notNull(),                    // VIX * 100
  gammaRegime: text("gamma_regime").notNull(),      // "positive" | "negative" | "neutral"
  netGex: integer("net_gex").notNull(),             // in $M (GEX / 1e6, rounded) — int is fine
  pcrOi: integer("pcr_oi").notNull(),               // PCR * 100
});
export type SnapshotHistory = typeof snapshotHistory.$inferSelect;

// ---- Backtest cache: one row per (horizon, level_kind) summarizing hit-rates across all dates ----
export const backtestLevels = sqliteTable("backtest_levels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  horizon: text("horizon").notNull(),              // "daily" | "weekly" | "monthly" | "quarterly"
  levelKind: text("level_kind").notNull(),         // callWall | putWall | zeroGamma | dominantMag | upsidePivot | downsidePivot | mopexMaxPain | extremeVac | vommaPocket
  sampleSize: integer("sample_size").notNull(),    // number of historical observations
  touchRate: real("touch_rate").notNull(),         // fraction (0..1): price touched within tolerance before horizon end
  holdRate: real("hold_rate").notNull(),           // fraction (0..1): price touched AND reversed at least 50% back within horizon
  avgAbsDistBps: real("avg_abs_dist_bps").notNull(),  // avg |realized - predicted| at horizon end, basis points
  medianAbsDistBps: real("median_abs_dist_bps").notNull(),
  breachBeyondPct: real("breach_beyond_pct").notNull(), // fraction where realized went >1% past the level
  computedAt: integer("computed_at").notNull(),    // unix sec
  methodology: text("methodology").notNull(),      // "proxy-vol-regime-v1" etc
});
export type BacktestLevel = typeof backtestLevels.$inferSelect;

// ---- Backtest observations: one row per (date, horizon, level_kind) - raw data for the aggregates above ----
export const backtestObservations = sqliteTable("backtest_observations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),                    // YYYY-MM-DD trade date
  horizon: text("horizon").notNull(),
  levelKind: text("level_kind").notNull(),
  predictedPrice: real("predicted_price").notNull(),
  realizedClose: real("realized_close").notNull(),
  realizedHigh: real("realized_high").notNull(),   // max close over horizon
  realizedLow: real("realized_low").notNull(),     // min close over horizon
  touched: integer("touched").notNull(),           // 0/1
  held: integer("held").notNull(),                 // 0/1
  absDistBps: real("abs_dist_bps").notNull(),
  breachBeyondPct: integer("breach_beyond_pct").notNull(), // 0/1
});
export type BacktestObservation = typeof backtestObservations.$inferSelect;

// ---- Schwab OAuth token storage (single row, id=1) ----
export const schwabTokens = sqliteTable("schwab_tokens", {
  id: integer("id").primaryKey(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: integer("expires_at").notNull(),       // unix ms
  refreshExpiresAt: integer("refresh_expires_at").notNull(), // unix ms (7 days)
  updatedAt: integer("updated_at").notNull(),
});
export type SchwabToken = typeof schwabTokens.$inferSelect;

// ---- Client-facing types (the shape /api/snapshot returns) ----

export interface VolMetric {
  symbol: string;
  name: string;
  value: number | null;
  prev: number | null;
  changePct: number | null;
}

export interface TermStructure {
  vix9d: number | null;
  vix: number | null;
  vix3m: number | null;
  ratio9dOver30d: number | null; // <1 = contango (calm), >1 = backwardation (stress)
  ratio30dOver3m: number | null;
}

export interface GexStrikePoint {
  strike: number;
  gex: number;        // dollars per 1% move
  callOi: number;
  putOi: number;
}

export interface GammaStructure {
  spot: number;
  totalGex: number;             // net dealer gamma ($ per 1% move), calls +, puts -
  regime: "positive" | "negative" | "neutral";
  callWall: number;             // strike with largest positive GEX contribution
  callWallGex: number;
  putWall: number;              // strike with largest negative GEX contribution
  putWallGex: number;
  zeroGamma: number | null;     // canonical zero-gamma spot level (Perfiliev-style) — where total γ flips as spot moves
  maxPain: number;              // nearest expiry max-pain strike
  nearestDte: number;
  pcrOi: number;                // put/call open-interest ratio, 0-45 DTE
  pcrVol: number;               // put/call volume ratio, 0-45 DTE
  profile: GexStrikePoint[];    // strike-level GEX within ±$60 of spot
  topCallOi: { strike: number; oi: number; expiry: string; dte: number }[];
  topPutOi:  { strike: number; oi: number; expiry: string; dte: number }[];
  pcrByBucket: { label: string; dteMax: number; pcrOi: number; pcrVol: number; callOi: number; putOi: number }[];  // rolling DTE buckets for PCR selector
  gexCrossoverStrike: number | null;       // legacy metric — strike where cumulative per-strike GEX flips sign
  gammaProfile: { spot: number; gex: number }[];  // 60-pt Perfiliev curve, 0.9 · S → 1.1 · S
}

// ---- Whale alert history: every detection logged for auditability + /api/flow/history ----
export const whaleAlerts = sqliteTable("whale_alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  occ: text("occ").notNull(),
  symbol: text("symbol").notNull(),
  type: text("type").notNull(),                       // "C" | "P"
  strike: real("strike").notNull(),
  expiration: text("expiration").notNull(),
  dte: integer("dte").notNull(),
  premium: real("premium").notNull(),                  // notional dollars
  volOiRatio: real("vol_oi_ratio").notNull(),
  isNewStrike: integer("is_new_strike").notNull(),     // 0/1
  tag: text("tag").notNull(),                          // "ABOVE_ASK" etc
  sentiment: text("sentiment").notNull(),              // BULLISH | BEARISH | NEUTRAL
  delta: real("delta").notNull(),
  detectedAt: integer("detected_at").notNull(),        // epoch ms
  reason: text("reason").notNull(),                    // why it qualified (e.g. "premium=$1.2M, vol/oi=12x, new-strike")
});
export type WhaleAlert = typeof whaleAlerts.$inferSelect;

// ---- Whale follow-through state (one row per OCC, upserted on every tick) ----
export const whaleFollows = sqliteTable("whale_follows", {
  occ: text("occ").primaryKey(),
  symbol: text("symbol").notNull(),
  type: text("type").notNull(),                        // "C" | "P"
  strike: real("strike").notNull(),
  expiration: text("expiration").notNull(),
  side: text("side").notNull(),                        // BULLISH | BEARISH | NEUTRAL
  entryJson: text("entry_json").notNull(),             // FollowPosition.entry serialized
  currentLiveJson: text("current_live_json").notNull(),// FollowPosition.live serialized
  status: text("status").notNull(),                    // OPEN | TRIMMING | CLOSING | CLOSED | EXPIRED
  statusAt: integer("status_at").notNull(),            // epoch ms
  closingPrintJson: text("closing_print_json"),        // nullable
});
export type WhaleFollow = typeof whaleFollows.$inferSelect;

// ----- Sector Web (reactive force-graph + deep heatmap grid) -----

export interface SectorNode {
  id: string;
  kind: "sector" | "market";
  symbol: string;
  name: string;
  hue: number;
  r1d: number; r1w: number; r1m: number;      // raw returns (%)
  rs1d: number; rs1w: number; rs1m: number;    // relative strength vs SPY (%)
  heat: number;                                 // weighted RS blend (color driver)
  last: number;                                 // last close
}

export interface LeaderNode {
  id: string;
  kind: "leader";
  symbol: string;
  sectorId: string;
  name: string;
  hue: number;
  r1d: number; r1w: number; r1m: number;
  rs1d: number; rs1w: number; rs1m: number;
  last: number;
}

export interface SectorEdge {
  source: string;                               // node id
  target: string;
  corr: number;                                 // 60-day daily-return Pearson
}

export interface SectorGridRow {
  sectorId: string;
  sectorName: string;
  etf: string;
  hue: number;
  r1d: number; r1w: number; r1m: number;
  rs1d: number; rs1w: number; rs1m: number;
  heat: number;
  leaders: LeaderNode[];                        // pre-sorted by rs1w desc
}

export interface SectorWebResponse {
  asOf: string;
  spy: SectorNode;
  sectors: SectorNode[];
  leaders: LeaderNode[];
  edges: SectorEdge[];
  grid: SectorGridRow[];
  breadth: { w1: number; m1: number; total: number };
}

// ----- WEF Theme Mapper -----

export interface WefTheme {
  /** Stable slug, e.g. "ai-governance" */
  id: string;
  /** Display label, e.g. "AI Governance" */
  label: string;
  /** Short paragraph describing the theme */
  blurb: string;
  /** How many WEF sources mentioned this theme (rough heat) */
  mentions: number;
  /** Representative source URLs */
  sources: { title: string; url: string }[];
  /** All tickers in the theme basket */
  basket: string[];
  /** RS-filtered leaders (tickers outperforming SPY over 1M) */
  leaders: { symbol: string; r1m: number; rs1m: number }[];
  /** Basket-average RS over 1M (in %) — drives the heat color */
  basketRs1m: number;
}

export interface WefThemeResponse {
  asOf: string;
  themes: WefTheme[];
  sourcesScanned: number;
  /** Tag surfacing on the page — e.g. "Based on 14 WEF agenda sessions + 3 flagship reports" */
  summary: string;
}

export interface SocialPost {
  source: "X" | "Reddit" | "News";
  author?: string;
  text: string;
  url: string;
  timestamp?: string;
  tone: "bullish" | "bearish" | "neutral";
}

export interface SocialSentiment {
  score: number;                   // -100 (extreme fear) ... +100 (extreme greed)
  bullish: number;                 // raw counts
  bearish: number;
  neutral: number;
  posts: SocialPost[];
}

export interface Gauge {
  name: string;
  value: number;          // 0..100 where 50 = neutral
  weight: number;         // contribution weight to composite
  interpretation: string;
}

export interface Composite {
  score: number;                // 0..100 (0 fear, 50 neutral, 100 greed)
  label: string;                // "Extreme Fear"..."Extreme Greed"
  gauges: Gauge[];
  takeaway: string;             // short human summary
  tradingRegime: string;        // "positive gamma / mean reversion", etc.
}

export interface Snapshot_Public {
  capturedAt: number;
  spy: { price: number; prevClose: number; changePct: number };
  vol: { vix: VolMetric; vvix: VolMetric; vix9d: VolMetric; vix3m: VolMetric; skew: VolMetric };
  term: TermStructure;
  gamma: GammaStructure;
  social: SocialSentiment;
  fearGreed: { value: number; label: string; source: string } | null;
  aaii: { bullish: number; bearish: number; neutral: number; asOf: string } | null;
  composite: Composite;
  headlines: { title: string; url: string; source: string; publishedAt?: string }[];
  warnings: string[];
}
