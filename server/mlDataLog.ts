// server/mlDataLog.ts
//
// Real-data pipeline for the ML quantile forecaster (review items 9.1, 9.4/F9.3).
//
// 1. spx_minute_bars: Schwab $SPX 1-minute candles, persisted after each
//    session. Schwab serves only ~10 days of minute history, so these are
//    stored before they age out; they are the real price path the trainer and
//    the coverage scorer use.
// 2. ml_feature_log: the exact feature dict the live forecaster is fed
//    (mlGreekFeatures, dealer levels from the Schwab $SPX chain), logged every
//    LOG_EVERY_MS during RTH, with schema_version, the features that were
//    missing (stored as JSON null) and why. The trainer uses only rows of the
//    current schema (v1 rows measured CBOE SPY-point levels against SPX spot).
// 3. ml_forecast_log: the band the panel actually draws (mlServing: promoted
//    model, else the baseline cone, plus any gated morning blend) per horizon
//    at the same moments, under model/version keys naming every component,
//    scored once the horizon has passed against the real SPX return over
//    [t, t + h] from spx_minute_bars.
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
import { isTradingDay as calIsTradingDay, sessionCloseMinutes as calCloseMin } from "./exchangeCalendar";
import { getPriceHistory } from "./schwab";
import { buildMlFeatures, getLastMlFeatureProvenance, ML_FEATURE_SCHEMA_VERSION, type MlFeatureInputs } from "./mlGreekFeatures";
import { buildServedProjection } from "./mlServing";
import { liveCoverageDemotion, promotedComponentsOf } from "./mlServedBand";
import { mlDemote } from "./mlBridge";
import {
  etDate, etWallToUtcMs, forwardReturnFromBars, nonOverlappingForecasts, scoreIntervalCoverage,
  type CoverageScore, type MinuteBar,
} from "./validationMath";

const LOG_EVERY_MS = 5 * 60_000;
const SCORE_EVERY_MS = 15 * 60_000;
const HORIZONS = [5, 15, 30, 60];
const MAX_HORIZON_MIN = 240; // morning-model horizons, when one is ever promoted
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
    version TEXT NOT NULL,          -- served model version: coverage is never pooled across versions
    training_data TEXT,             -- 'real' | 'synthetic_gbm' | null
    n INTEGER NOT NULL,
    covered INTEGER NOT NULL,
    rate REAL, wilson_lo REAL, wilson_hi REAL, kupiec_p REAL, independence_p REAL, mean_interval_score REAL,
    below_lo INTEGER, above_hi INTEGER,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (day, horizon_min, model, version)
  );
`);

// Feature schema versioning (R2-F 1): rows logged before this column existed
// are schema 1 (CBOE SPY-point dealer levels against SPX spot) and are never
// trained on. reasons_json records why each missing feature is missing.
for (const ddl of [
  "ALTER TABLE ml_feature_log ADD COLUMN schema_version INTEGER",
  "ALTER TABLE ml_feature_log ADD COLUMN reasons_json TEXT",
  "ALTER TABLE ml_forecast_log ADD COLUMN label TEXT",
]) {
  try { sqlite.exec(ddl); } catch { /* column exists */ }
}

function etMinuteOfDay(ms: number): { day: string; mod: number; weekday: boolean } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  const wd = g("weekday");
  void wd;
  const day = etDate(ms);
  // "weekday" = an exchange trading day (holidays excluded)
  return { day, mod: Number(g("hour")) * 60 + Number(g("minute")), weekday: calIsTradingDay(day) };
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
  // An empty answer (token missing, rate-limit throttle) is not a successful
  // persist: leave the marker so the next tick retries.
  if (candles.length > 0) _lastBarsPersist = Date.now();
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
  // JSON.stringify writes NaN (missing) as null; the trainer reads null as NaN.
  sqlite.prepare(`INSERT OR IGNORE INTO ml_feature_log (ts, spot, features_json, missing_json, live_chain, schema_version, reasons_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(now, features.spx_spot > 0 ? features.spx_spot : null, JSON.stringify(features), JSON.stringify(prov?.missing ?? []),
      prov?.liveChainAudit ? 1 : 0, prov?.schemaVersion ?? ML_FEATURE_SCHEMA_VERSION, JSON.stringify(prov?.reasons ?? {}));
  // The band the panel draws (same function as /api/ml/projection-spy).
  const { served } = await buildServedProjection(features);
  if (!served.bands) return { features: true, forecasts: 0 };
  const ins = sqlite.prepare(`INSERT INTO ml_forecast_log (ts, model, version, status, training_data, horizon_min, q10, q25, q50, q75, q90, label)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const [hk, b] of Object.entries(served.bands)) {
    const h = Number(hk);
    if (!Number.isFinite(h) || h > MAX_HORIZON_MIN || ![b.q10, b.q90].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    ins.run(now, served.coverageModel, served.coverageVersion, served.learned ? "PROMOTED" : "BASELINE", served.trainingData, h,
      b.q10, b.q25, b.q50, b.q75, b.q90, served.label);
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
  const to = pending[pending.length - 1].ts + (MAX_HORIZON_MIN + 10) * 60_000;
  const bars = loadBars(from, to);
  const upd = sqlite.prepare(`UPDATE ml_forecast_log SET realized_ret = ?, scored_at = ?, outcome = ? WHERE id = ?`);
  let scored = 0, noPrice = 0;
  for (const p of pending) {
    const r = forwardReturnFromBars(bars, p.ts, p.horizon_min);
    if (r != null) { upd.run(r, now, "scored", p.id); scored++; continue; }
    // Bars for this window may still arrive on a later persist (Schwab keeps ~10
    // days of minute history); give up only after that window has passed.
    if (now - p.ts > 9 * 24 * 3600_000) { upd.run(null, now, "no_price", p.id); noPrice++; }
  }
  return { scored, noPrice };
}

function scoreRows(rows: Array<{ ts: number; horizon_min: number; q10: number; q90: number; realized_ret: number }>): CoverageScore {
  const kept = nonOverlappingForecasts(rows.map((r) => ({ ...r, horizonMin: r.horizon_min })));
  return scoreIntervalCoverage(kept.map((r) => ({ lo: r.q10, hi: r.q90, realized: r.realized_ret })), NOMINAL);
}

/** Recompute and store coverage for every ET day, horizon and served band (model + version) with scored forecasts. */
export function computeDailyCoverage(now = Date.now()): number {
  const rows = sqlite.prepare(`SELECT ts, horizon_min, q10, q90, realized_ret, model, version, training_data FROM ml_forecast_log
                               WHERE outcome = 'scored' ORDER BY ts ASC`)
    .all() as Array<{ ts: number; horizon_min: number; q10: number; q90: number; realized_ret: number; model: string; version: string | null; training_data: string | null }>;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${etDate(r.ts)}\u0000${r.horizon_min}\u0000${r.model}\u0000${r.version ?? ""}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const up = sqlite.prepare(`INSERT OR REPLACE INTO ml_coverage_daily
    (day, horizon_min, model, version, training_data, n, covered, rate, wilson_lo, wilson_hi, kupiec_p, independence_p, mean_interval_score, below_lo, above_hi, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [k, list] of Array.from(groups)) {
    const [day, h, model, version] = k.split("\u0000");
    const s = scoreRows(list);
    up.run(day, Number(h), model, version, list[list.length - 1].training_data ?? null, s.n, s.covered, s.rate, s.wilsonLo, s.wilsonHi,
      s.kupiecP, s.independenceP, s.meanIntervalScore, s.belowLo, s.aboveHi, now);
  }
  return groups.size;
}

/**
 * Live demotion (R2-F fix round item 1). For every served band that contains
 * a promoted sidecar model, pool its scored non-overlapping outcomes per
 * horizon; when Kupiec rejects 80% coverage at p < 0.01 with >= 20 scored ET
 * days at any horizon (mlServedBand.liveCoverageDemotion), ask the sidecar to
 * demote every promoted model in that band. The next forecast is then the
 * baseline cone (a new coverage record). Sidecar down: retried next pass.
 */
const _demoted = new Set<string>();
export async function checkLiveDemotion(): Promise<Array<{ model: string; version: number; reason: string; ok: boolean }>> {
  const out: Array<{ model: string; version: number; reason: string; ok: boolean }> = [];
  const bands = sqlite.prepare(`SELECT DISTINCT model, version FROM ml_forecast_log WHERE outcome = 'scored' AND status = 'PROMOTED'`).all() as Array<{ model: string; version: string | null }>;
  for (const b of bands) {
    const comps = promotedComponentsOf(b.version).filter((c) => !_demoted.has(`${c.model}:${c.version}`));
    if (comps.length === 0) continue;
    const rows = sqlite.prepare(`SELECT ts, horizon_min, q10, q90, realized_ret FROM ml_forecast_log
                                 WHERE outcome = 'scored' AND model = ? AND COALESCE(version, '') = ? ORDER BY ts ASC`)
      .all(b.model, b.version ?? "") as Array<{ ts: number; horizon_min: number; q10: number; q90: number; realized_ret: number }>;
    const hs = Array.from(new Set(rows.map((r) => r.horizon_min)));
    const per = hs.map((h) => {
      const list = rows.filter((r) => r.horizon_min === h);
      const kept = nonOverlappingForecasts(list.map((r) => ({ ...r, horizonMin: r.horizon_min })));
      return { horizonMin: h, kupiecP: scoreRows(list).kupiecP, nDays: new Set(kept.map((r) => etDate(r.ts))).size };
    });
    const v = liveCoverageDemotion(per);
    if (!v.demote) continue;
    for (const c of comps) {
      const r = await mlDemote(c.model, c.version, `${v.reason} (served band ${b.model} ${b.version ?? ""})`);
      const ok = !!r?.demoted;
      if (ok) _demoted.add(`${c.model}:${c.version}`);
      console.warn(`[ml:datalog] live demotion ${c.model} v${c.version}: ${ok ? "demoted" : "sidecar did not confirm, retry next pass"}; ${v.reason}`);
      out.push({ model: c.model, version: c.version, reason: v.reason!, ok });
    }
  }
  return out;
}

export interface CoverageReport {
  asOf: number;
  nominal: number;
  band: "q10-q90";
  note: string;
  /** Served band this report covers: component names and versions (never pooled across them). */
  model: string | null;
  version: string | null;
  trainingData: string | null;
  label: string | null;
  versionsSeen: Array<{ model: string; version: string; trainingData: string | null; scored: number }>;
  pooled: Array<{ horizonMin: number; windowDays: number } & CoverageScore>;
  daily: Array<{ day: string; horizonMin: number; n: number; covered: number; rate: number | null; wilsonLo: number | null; wilsonHi: number | null; kupiecP: number | null; independenceP: number | null; meanIntervalScore: number | null }>;
  pending: number;
  noPrice: number;
}

/**
 * Live coverage of ONE served band (model + version; default: the most
 * recently scored one), pooled over windowDays and per ET day, per horizon.
 * Different bands (baseline cone vs a promoted model, model versions, a
 * morning blend) are never mixed: each starts a fresh record.
 */
export function getCoverageReport(windowDays = 30, now = Date.now(), version?: string, model?: string): CoverageReport {
  const since = now - windowDays * 24 * 3600_000;
  let rows: Array<{ ts: number; horizon_min: number; q10: number; q90: number; realized_ret: number; training_data: string | null; label: string | null }> = [];
  let pending = 0, noPrice = 0;
  let daily: CoverageReport["daily"] = [];
  let versionsSeen: CoverageReport["versionsSeen"] = [];
  let ver: string | null = version ?? null;
  let mdl: string | null = model ?? null;
  try {
    versionsSeen = (sqlite.prepare(`SELECT model, version, training_data, COUNT(*) n, MAX(ts) last FROM ml_forecast_log
                                    WHERE outcome = 'scored' AND ts >= ?
                                    GROUP BY model, version, training_data ORDER BY last DESC`).all(since) as any[])
      .map((r) => ({ model: String(r.model), version: String(r.version ?? ""), trainingData: r.training_data ?? null, scored: Number(r.n) }));
    const pick = versionsSeen.find((v) => (mdl == null || v.model === mdl) && (ver == null || v.version === ver));
    if (mdl == null) mdl = pick?.model ?? null;
    if (ver == null) ver = pick?.version ?? null;
    rows = sqlite.prepare(`SELECT ts, horizon_min, q10, q90, realized_ret, training_data, label FROM ml_forecast_log
                           WHERE outcome = 'scored' AND ts >= ? AND model = ? AND COALESCE(version, '') = ?
                           ORDER BY ts ASC`).all(since, mdl ?? "", ver ?? "") as typeof rows;
    pending = Number((sqlite.prepare(`SELECT COUNT(*) n FROM ml_forecast_log WHERE outcome = 'pending'`).get() as any)?.n ?? 0);
    noPrice = Number((sqlite.prepare(`SELECT COUNT(*) n FROM ml_forecast_log WHERE outcome = 'no_price' AND ts >= ?`).get(since) as any)?.n ?? 0);
    daily = (sqlite.prepare(`SELECT day, horizon_min, n, covered, rate, wilson_lo, wilson_hi, kupiec_p, independence_p, mean_interval_score FROM ml_coverage_daily
                             WHERE model = ? AND version = ? ORDER BY day DESC, horizon_min ASC LIMIT 400`).all(mdl ?? "", ver ?? "") as any[])
      .map((r) => ({ day: r.day, horizonMin: r.horizon_min, n: r.n, covered: r.covered, rate: r.rate, wilsonLo: r.wilson_lo, wilsonHi: r.wilson_hi, kupiecP: r.kupiec_p, independenceP: r.independence_p, meanIntervalScore: r.mean_interval_score }));
  } catch { /* tables not created yet */ }
  const hs = Array.from(new Set([...HORIZONS, ...rows.map((r) => r.horizon_min)])).sort((a, b) => a - b);
  const pooled = hs.map((h) => ({ horizonMin: h, windowDays, ...scoreRows(rows.filter((r) => r.horizon_min === h)) }));
  return {
    asOf: now,
    nominal: NOMINAL,
    band: "q10-q90",
    note: "Fraction of realized SPX forward returns inside the drawn 10-90% band; nominal 80%, for one served band (model + version). " +
      "Only non-overlapping outcome windows per horizon are counted. Wilson 95% interval on the rate; Kupiec p < 0.05 rejects correct coverage; " +
      "Christoffersen independence p < 0.05 means misses cluster. n = 0 means no scored forecasts yet (not 0% coverage). " +
      "Scored on SPX returns; the panel draws the same return band on SPY.",
    model: mdl,
    version: ver,
    trainingData: rows.length ? rows[rows.length - 1].training_data : (versionsSeen.find((v) => v.model === mdl && v.version === ver)?.trainingData ?? null),
    label: rows.length ? rows[rows.length - 1].label : null,
    versionsSeen,
    pooled,
    daily,
    pending,
    noPrice,
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
      const closeMin = calCloseMin(day) ?? 16 * 60; // 13:00 on half days
      if (weekday && mod >= 9 * 60 + 35 && mod <= closeMin - 5 && now - _lastLog >= LOG_EVERY_MS - 5_000) {
        _lastLog = now;
        await logMlSnapshot(resolveInputs, now);
      }
      const closeMs = etWallToUtcMs(day, Math.floor((closeMin + 5) / 60), (closeMin + 5) % 60);
      const barsDue = weekday && now >= closeMs && _lastBarsPersist < closeMs;
      if (now - _lastScore >= SCORE_EVERY_MS) { // at most one Schwab history call per 15 min
        _lastScore = now;
        if (barsDue || now - _lastBarsPersist > 6 * 3600_000) await persistSpxMinuteBars();
        scorePendingForecasts(now);
        computeDailyCoverage(now);
        await checkLiveDemotion();
      }
    } catch (e: any) {
      console.warn(`[ml:datalog] tick failed: ${e?.message ?? e}`);
    }
  };
  setTimeout(tick, 90_000);
  setInterval(tick, 60_000);
  console.log("[ml:datalog] started: features + forecasts every 5 min in RTH; minute bars, scoring and daily coverage after the close");
}
