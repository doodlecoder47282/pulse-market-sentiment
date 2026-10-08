// server/mlDataLog.ts
//
// Real-data pipeline for the ML quantile forecaster (review items 9.1, 9.4/F9.3).
//
// 1. spx_minute_bars: Schwab $SPX 1-minute candles, persisted after each
//    session. Schwab serves only ~10 days of minute history, so these are
//    stored before they age out; they are the real price path the trainer and
//    the coverage scorer use.
// 2. ml_feature_log: the exact feature dict the live forecaster is fed
//    (mlGreekFeatures, real dealer levels from the live chain), logged every
//    LOG_EVERY_MS during RTH, with the list of features that were placeholders
//    for missing inputs. Training on these removes the train/serve skew of the
//    synthetic models.
// 3. ml_forecast_log: the served q10..q90 forward-return forecast per horizon
//    at the same moments, scored once the horizon has passed against the real
//    SPX return over [t, t + h] from spx_minute_bars.
// 4. ml_coverage_daily: per ET day and horizon, the fraction of realized
//    returns inside the 10-90% band, with a Wilson 95% interval, the Kupiec
//    test and the Gneiting-Raftery interval score. Only forecasts with
//    non-overlapping outcome windows are counted (overlapping windows share
//    one realized path and are not independent trials).
//
// Deterministic polling, no LLM. Costs one feature build and one ML-sidecar
// call per LOG_EVERY_MS during RTH, and one Schwab minute-history call per
// scoring pass (at most every 15 minutes).

import { sqlite } from "./storage";
import { getPriceHistory } from "./schwab";
import { buildMlFeatures, getLastMlFeatureProvenance, type MlFeatureInputs } from "./mlGreekFeatures";
import { mlQuantileOverlay } from "./mlBridge";
import {
  etDate, etWallToUtcMs, forwardReturnFromBars, nonOverlappingForecasts, scoreIntervalCoverage,
  type CoverageScore, type MinuteBar,
} from "./validationMath";

const LOG_EVERY_MS = 5 * 60_000;
const SCORE_EVERY_MS = 15 * 60_000;
const HORIZONS = [5, 15, 30, 60];
const NOMINAL = 0.8; // q10..q90

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS spx_minute_bars (
    t INTEGER PRIMARY KEY,          -- bar open, epoch ms
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
    volume REAL,
    source TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ml_feature_log (
    ts INTEGER PRIMARY KEY,
    spot REAL,
    features_json TEXT NOT NULL,
    missing_json TEXT NOT NULL,     -- features that were placeholders for missing inputs
    live_chain INTEGER NOT NULL     -- 1 when dealer levels came from a live chain audit
  );
  CREATE TABLE IF NOT EXISTS ml_forecast_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    model TEXT NOT NULL,
    version TEXT,
    status TEXT,                    -- model status from the sidecar (e.g. TRAINED)
    training_data TEXT,             -- 'real' | 'synthetic_gbm' | null (unknown)
    horizon_min INTEGER NOT NULL,
    q10 REAL, q25 REAL, q50 REAL, q75 REAL, q90 REAL,   -- forward simple returns (fractions)
    realized_ret REAL,
    scored_at INTEGER,
    outcome TEXT NOT NULL DEFAULT 'pending'            -- pending | scored | no_price
  );
  CREATE INDEX IF NOT EXISTS idx_ml_forecast_pending ON ml_forecast_log(outcome, ts);
  CREATE TABLE IF NOT EXISTS ml_coverage_daily (
    day TEXT NOT NULL,
    horizon_min INTEGER NOT NULL,
    model TEXT NOT NULL,
    n INTEGER NOT NULL,
    covered INTEGER NOT NULL,
    rate REAL, wilson_lo REAL, wilson_hi REAL, kupiec_p REAL, mean_interval_score REAL,
    below_lo INTEGER, above_hi INTEGER,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (day, horizon_min, model)
  );
`);

function etMinuteOfDay(ms: number): { day: string; mod: number; weekday: boolean } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  const wd = g("weekday");
  return { day: etDate(ms), mod: Number(g("hour")) * 60 + Number(g("minute")), weekday: wd !== "Sat" && wd !== "Sun" };
}

// ─── 1. Minute bars ──────────────────────────────────────────────────────────

let _lastBarsPersist = 0;

/** Persist Schwab $SPX minute candles (INSERT OR IGNORE). Returns rows written. */
export async function persistSpxMinuteBars(): Promise<number> {
  const resp = await getPriceHistory("$SPX", "day", 10, "minute", 1);
  const candles = (resp?.candles ?? []) as any[];
  const stmt = sqlite.prepare(`INSERT OR IGNORE INTO spx_minute_bars (t, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, 'schwab')`);
  let n = 0;
  const tx = sqlite.transaction((rows: any[]) => {
    for (const c of rows) {
      if (![c.datetime, c.open, c.high, c.low, c.close].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
      const r = stmt.run(c.datetime, c.open, c.high, c.low, c.close, typeof c.volume === "number" ? c.volume : null);
      n += Number(r.changes ?? 0);
    }
  });
  tx(candles);
  _lastBarsPersist = Date.now();
  return n;
}

function loadBars(from: number, to: number): MinuteBar[] {
  return sqlite.prepare(`SELECT t AS datetime, open, high, low, close FROM spx_minute_bars WHERE t >= ? AND t <= ? ORDER BY t ASC`)
    .all(from, to) as MinuteBar[];
}

// ─── 2/3. Feature + forecast logging ─────────────────────────────────────────

export async function logMlSnapshot(resolveInputs: () => Promise<MlFeatureInputs>, now = Date.now()): Promise<{ features: boolean; forecasts: number }> {
  const features = await buildMlFeatures(resolveInputs);
  const prov = getLastMlFeatureProvenance();
  sqlite.prepare(`INSERT OR IGNORE INTO ml_feature_log (ts, spot, features_json, missing_json, live_chain) VALUES (?, ?, ?, ?, ?)`)
    .run(now, features.spx_spot > 0 ? features.spx_spot : null, JSON.stringify(features), JSON.stringify(prov?.missing ?? []), prov?.liveChainAudit ? 1 : 0);
  const proj = await mlQuantileOverlay(features, HORIZONS, { timeoutMs: 2500 });
  if (!proj) return { features: true, forecasts: 0 };
  const ins = sqlite.prepare(`INSERT INTO ml_forecast_log (ts, model, version, status, training_data, horizon_min, q10, q25, q50, q75, q90)
                              VALUES (?, 'quantile_overlay', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const h of HORIZONS) {
    const b = proj.bands[String(h)];
    if (!b || ![b.q10, b.q90].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    ins.run(now, proj.version, proj.status, proj.trainingData ?? null, h, b.q10, b.q25, b.q50, b.q75, b.q90);
    n++;
  }
  return { features: true, forecasts: n };
}

// ─── 3/4. Scoring and daily coverage ─────────────────────────────────────────

/** Score pending forecasts whose horizon has passed, using persisted minute bars. */
export function scorePendingForecasts(now = Date.now()): { scored: number; noPrice: number } {
  const pending = sqlite.prepare(`SELECT id, ts, horizon_min FROM ml_forecast_log WHERE outcome = 'pending' AND ts + horizon_min * 60000 <= ? ORDER BY ts ASC LIMIT 5000`)
    .all(now - 5 * 60_000) as Array<{ id: number; ts: number; horizon_min: number }>;
  if (pending.length === 0) return { scored: 0, noPrice: 0 };
  const from = pending[0].ts - 10 * 60_000;
  const to = pending[pending.length - 1].ts + 70 * 60_000;
  const bars = loadBars(from, to);
  const upd = sqlite.prepare(`UPDATE ml_forecast_log SET realized_ret = ?, scored_at = ?, outcome = ? WHERE id = ?`);
  let scored = 0, noPrice = 0;
  for (const p of pending) {
    const r = forwardReturnFromBars(bars, p.ts, p.horizon_min);
    if (r != null) { upd.run(r, now, "scored", p.id); scored++; continue; }
    // Bars for this window may still arrive on the next persist; give up after a day.
    if (now - p.ts > 24 * 3600_000) { upd.run(null, now, "no_price", p.id); noPrice++; }
  }
  return { scored, noPrice };
}

function scoreRows(rows: Array<{ ts: number; horizon_min: number; q10: number; q90: number; realized_ret: number }>): CoverageScore {
  const kept = nonOverlappingForecasts(rows.map((r) => ({ ...r, horizonMin: r.horizon_min })));
  return scoreIntervalCoverage(kept.map((r) => ({ lo: r.q10, hi: r.q90, realized: r.realized_ret })), NOMINAL);
}

/** Recompute and store coverage for every ET day that has scored forecasts. */
export function computeDailyCoverage(now = Date.now()): number {
  const rows = sqlite.prepare(`SELECT ts, horizon_min, q10, q90, realized_ret FROM ml_forecast_log WHERE outcome = 'scored' AND model = 'quantile_overlay' ORDER BY ts ASC`)
    .all() as Array<{ ts: number; horizon_min: number; q10: number; q90: number; realized_ret: number }>;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${etDate(r.ts)}|${r.horizon_min}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const up = sqlite.prepare(`INSERT OR REPLACE INTO ml_coverage_daily
    (day, horizon_min, model, n, covered, rate, wilson_lo, wilson_hi, kupiec_p, mean_interval_score, below_lo, above_hi, computed_at)
    VALUES (?, ?, 'quantile_overlay', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [k, list] of groups) {
    const [day, h] = k.split("|");
    const s = scoreRows(list);
    up.run(day, Number(h), s.n, s.covered, s.rate, s.wilsonLo, s.wilsonHi, s.kupiecP, s.meanIntervalScore, s.belowLo, s.aboveHi, now);
  }
  return groups.size;
}

export interface CoverageReport {
  asOf: number;
  nominal: number;
  band: "q10-q90";
  note: string;
  pooled: Array<{ horizonMin: number; windowDays: number } & CoverageScore>;
  daily: Array<{ day: string; horizonMin: number; n: number; covered: number; rate: number | null; wilsonLo: number | null; wilsonHi: number | null; kupiecP: number | null; meanIntervalScore: number | null }>;
  pending: number;
  noPrice: number;
  trainingData: string | null;
}

/** Live coverage of the served 10-90% band: pooled over the last windowDays and per day. */
export function getCoverageReport(windowDays = 30, now = Date.now()): CoverageReport {
  const since = now - windowDays * 24 * 3600_000;
  let rows: Array<{ ts: number; horizon_min: number; q10: number; q90: number; realized_ret: number; training_data: string | null }> = [];
  let pending = 0, noPrice = 0;
  let daily: CoverageReport["daily"] = [];
  try {
    rows = sqlite.prepare(`SELECT ts, horizon_min, q10, q90, realized_ret, training_data FROM ml_forecast_log
                           WHERE outcome = 'scored' AND model = 'quantile_overlay' AND ts >= ? ORDER BY ts ASC`).all(since) as typeof rows;
    pending = Number((sqlite.prepare(`SELECT COUNT(*) n FROM ml_forecast_log WHERE outcome = 'pending'`).get() as any)?.n ?? 0);
    noPrice = Number((sqlite.prepare(`SELECT COUNT(*) n FROM ml_forecast_log WHERE outcome = 'no_price' AND ts >= ?`).get(since) as any)?.n ?? 0);
    daily = (sqlite.prepare(`SELECT day, horizon_min, n, covered, rate, wilson_lo, wilson_hi, kupiec_p, mean_interval_score FROM ml_coverage_daily
                             WHERE model = 'quantile_overlay' ORDER BY day DESC, horizon_min ASC LIMIT 400`).all() as any[])
      .map((r) => ({ day: r.day, horizonMin: r.horizon_min, n: r.n, covered: r.covered, rate: r.rate, wilsonLo: r.wilson_lo, wilsonHi: r.wilson_hi, kupiecP: r.kupiec_p, meanIntervalScore: r.mean_interval_score }));
  } catch { /* tables not created yet */ }
  const pooled = HORIZONS.map((h) => ({ horizonMin: h, windowDays, ...scoreRows(rows.filter((r) => r.horizon_min === h)) }));
  const td = rows.length ? rows[rows.length - 1].training_data : null;
  return {
    asOf: now,
    nominal: NOMINAL,
    band: "q10-q90",
    note: "Fraction of realized SPX forward returns inside the served 10-90% band; nominal 80%. Only non-overlapping outcome windows per horizon are counted. " +
      "Wilson 95% interval on the rate; Kupiec p < 0.05 rejects correct coverage. n = 0 means no scored forecasts yet (not 0% coverage).",
    pooled,
    daily,
    pending,
    noPrice,
    trainingData: td,
  };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let _started = false;
let _lastLog = 0;
let _lastScore = 0;

/**
 * Start the deterministic logger. Logs features + forecasts every 5 minutes
 * from 09:35 to 15:55 ET on weekdays; after 16:05 ET persists the day's minute
 * bars, scores due forecasts and recomputes daily coverage. Fail-soft.
 * Set PULSE_ML_DATALOG=0 to disable.
 */
export function startMlDataLogger(resolveInputs: () => Promise<MlFeatureInputs>): void {
  if (_started || process.env.PULSE_ML_DATALOG === "0") return;
  _started = true;
  const tick = async () => {
    const now = Date.now();
    const { mod, weekday, day } = etMinuteOfDay(now);
    try {
      if (weekday && mod >= 9 * 60 + 35 && mod <= 15 * 60 + 55 && now - _lastLog >= LOG_EVERY_MS - 5_000) {
        _lastLog = now;
        await logMlSnapshot(resolveInputs, now);
      }
      const closeMs = etWallToUtcMs(day, 16, 5);
      const barsDue = weekday && now >= closeMs && _lastBarsPersist < closeMs;
      if (barsDue || now - _lastScore >= SCORE_EVERY_MS) {
        _lastScore = now;
        if (barsDue || now - _lastBarsPersist > 6 * 3600_000) await persistSpxMinuteBars();
        scorePendingForecasts(now);
        computeDailyCoverage(now);
      }
    } catch (e: any) {
      console.warn(`[ml:datalog] tick failed: ${e?.message ?? e}`);
    }
  };
  setTimeout(tick, 90_000);
  setInterval(tick, 60_000);
  console.log("[ml:datalog] started: features + forecasts every 5 min in RTH; minute bars, scoring and daily coverage after the close");
}
