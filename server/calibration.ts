// server/calibration.ts
//
// Pulse calibration tracker. Records every scenarioProb / scenarioTargets
// triple we publish and scores them against the actual SPX close at 4pm ET.
//
// CRITICAL DESIGN PRINCIPLE: this module is READ-ONLY against existing calcs.
// It does not touch models.ts, discordBatcaveCard.ts, or any pricing logic.
// It only observes outputs and computes calibration metrics.
//
// Scoring methodology:
//   For each daily prediction we record three probabilities + three targets:
//     bull (Pb_up,  T_up)   — close ≥ T_up
//     base (Pb_mid, T_mid)  — close within ±0.5*EM of T_mid
//     bear (Pb_dn,  T_dn)   — close ≤ T_dn
//
//   At market close we determine which scenario actually realized:
//     o_bull = 1 if close ≥ T_up else 0
//     o_bear = 1 if close ≤ T_dn else 0
//     o_base = 1 if neither bull nor bear else 0
//   (Mutually exclusive, sum to 1 — multinomial outcome.)
//
//   Brier score for the day:
//     BS = (P_bull − o_bull)² + (P_base − o_base)² + (P_bear − o_bear)²
//   Per-scenario Brier is just the squared error on that scenario.
//
//   Rolling Brier over N days = mean of daily per-scenario Brier scores.
//   Reference: <0.20 good, <0.10 excellent, 0.06–0.12 = top forecaster.

import { mainDbPath } from "./dbPath";
import Database from "better-sqlite3";
import { climatologyBaseline } from "./stats";

const sqlite = new Database(mainDbPath());

// One-time schema bootstrap. Idempotent — safe to call on every server start.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS pulse_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                   -- YYYY-MM-DD ET trade date
    captured_at INTEGER NOT NULL,         -- epoch seconds
    spot REAL NOT NULL,                   -- spot at prediction time
    target_bull REAL NOT NULL,
    target_base REAL NOT NULL,
    target_bear REAL NOT NULL,
    prob_bull REAL NOT NULL,              -- 0-1
    prob_base REAL NOT NULL,
    prob_bear REAL NOT NULL,
    one_day_em REAL NOT NULL,             -- EM at prediction time (for base-bucket width)
    source TEXT NOT NULL                  -- "daily" | "halfhour"
  );
  CREATE INDEX IF NOT EXISTS idx_pulse_pred_date ON pulse_predictions(date);

  CREATE TABLE IF NOT EXISTS pulse_outcomes (
    date TEXT PRIMARY KEY,                -- YYYY-MM-DD ET trade date
    close REAL NOT NULL,                  -- 4pm SPX close
    outcome_bull INTEGER NOT NULL,        -- 0 or 1
    outcome_base INTEGER NOT NULL,
    outcome_bear INTEGER NOT NULL,
    -- daily Brier (using each day's FIRST prediction = morning daily card)
    brier_bull REAL NOT NULL,
    brier_base REAL NOT NULL,
    brier_bear REAL NOT NULL,
    brier_total REAL NOT NULL,            -- sum of three (multinomial Brier)
    settled_at INTEGER NOT NULL           -- epoch seconds
  );
`);
// Which odds were recorded: "risk-neutral-implied" | "hand-set-heuristic" | null
// (rows from before this column). The card reports the mix instead of pooling
// two forecasters into one Brier without saying so.
try { sqlite.exec(`ALTER TABLE pulse_predictions ADD COLUMN prob_source TEXT`); } catch { /* exists */ }

/** Settled days before the card states a Brier, a skill score or a hit rate as a reading. */
export const CALIBRATION_MIN_DAYS = 20;
/** Window the posted card scores over (the gate applies to the days found inside it). A 7-day Brier is a 7-sample estimate whatever the table holds. */
export const CALIBRATION_CARD_DAYS = 30;

export type PredictionRow = {
  date: string;
  capturedAt: number;
  spot: number;
  targetBull: number;
  targetBase: number;
  targetBear: number;
  probBull: number;
  probBase: number;
  probBear: number;
  oneDayEm: number;
  source: "daily" | "halfhour";
  probSource?: string | null;
};

// Record a prediction. Called from postBatcaveDailyCard right before it sends.
export function recordPrediction(p: PredictionRow): void {
  try {
    sqlite
      .prepare(
        `INSERT INTO pulse_predictions
         (date, captured_at, spot, target_bull, target_base, target_bear,
          prob_bull, prob_base, prob_bear, one_day_em, source, prob_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.date,
        p.capturedAt,
        p.spot,
        p.targetBull,
        p.targetBase,
        p.targetBear,
        p.probBull,
        p.probBase,
        p.probBear,
        p.oneDayEm,
        p.source,
        p.probSource ?? null,
      );
  } catch (e) {
    console.error(`[calibration] recordPrediction failed: ${e}`);
  }
}

// Settle one trading day: pull the FIRST prediction of that date (morning
// daily card) and score it against the close. Idempotent — uses INSERT OR
// REPLACE on (date) so re-running after a late close-fix is safe.
export function settleDay(date: string, close: number): {
  date: string;
  close: number;
  outcome: { bull: 0 | 1; base: 0 | 1; bear: 0 | 1 };
  brier: { bull: number; base: number; bear: number; total: number };
} | null {
  const pred = sqlite
    .prepare(
      `SELECT * FROM pulse_predictions
       WHERE date = ?
       ORDER BY captured_at ASC
       LIMIT 1`,
    )
    .get(date) as
    | {
        target_bull: number;
        target_base: number;
        target_bear: number;
        prob_bull: number;
        prob_base: number;
        prob_bear: number;
      }
    | undefined;
  if (!pred) {
    console.warn(`[calibration] settleDay: no prediction for ${date}`);
    return null;
  }

  // Outcome buckets: bull if close >= target_bull, bear if close <= target_bear,
  // base otherwise. Mutually exclusive, exhaustive.
  const isBull = close >= pred.target_bull ? 1 : 0;
  const isBear = close <= pred.target_bear ? 1 : 0;
  const isBase = isBull === 0 && isBear === 0 ? 1 : 0;

  const brierBull = Math.pow(pred.prob_bull - isBull, 2);
  const brierBase = Math.pow(pred.prob_base - isBase, 2);
  const brierBear = Math.pow(pred.prob_bear - isBear, 2);
  const brierTotal = brierBull + brierBase + brierBear;

  sqlite
    .prepare(
      `INSERT OR REPLACE INTO pulse_outcomes
       (date, close, outcome_bull, outcome_base, outcome_bear,
        brier_bull, brier_base, brier_bear, brier_total, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      date,
      close,
      isBull,
      isBase,
      isBear,
      brierBull,
      brierBase,
      brierBear,
      brierTotal,
      Math.floor(Date.now() / 1000),
    );

  return {
    date,
    close,
    outcome: { bull: isBull as 0 | 1, base: isBase as 0 | 1, bear: isBear as 0 | 1 },
    brier: { bull: brierBull, base: brierBase, bear: brierBear, total: brierTotal },
  };
}

// Compute rolling Brier over the last N settled days.
export function rollingBrier(days: number = 30): {
  n: number;
  bull: number;
  base: number;
  bear: number;
  total: number;
  // Reference baseline: the climatology (base-rate) forecaster from
  // stats.climatologyBaseline, computed from the same outcome stream so the
  // comparator is fair. Field names kept as trivial* for API compatibility.
  trivialBull: number;
  trivialBase: number;
  trivialBear: number;
  trivialTotal: number;
  // Hit rate = fraction of days where the highest-prob scenario realized.
  topPickHitRate: number;
  // Raw counts for Beta-Binomial credible interval on the hit rate.
  topPickHits: number;
  topPickN: number;
  // Outcome distribution actually realized (helps spot whether base is
  // structurally over/under-weighted).
  realized: { bull: number; base: number; bear: number };
  /** Mean forecast probability per class over the graded morning rows: the number the realized mix is compared with. */
  meanForecast: { bull: number; base: number; bear: number };
  /** Which odds the graded rows carried (prob_source), "unrecorded" for rows before the column. */
  probSourceMix: Record<string, number>;
  /** Which slot the graded row came from ("daily" 09:30 or "halfhour"). */
  slotMix: Record<string, number>;
  /** Brier skill vs climatology, 1 - BS/BS_clim (0 = no better than the base rate; null when the baseline is 0).
   *  The base rate is fitted on the same settled days (the best constant forecast in hindsight), so the
   *  skill is understated for the model: a conservative comparison, stated on the card. */
  skill: { bull: number | null; base: number | null; bear: number | null; total: number | null };
  /** Below CALIBRATION_MIN_DAYS the readings are shown as counts only. */
  gated: boolean;
  minDays: number;
} | null {
  const rows = sqlite
    .prepare(
      `SELECT * FROM pulse_outcomes
       ORDER BY date DESC
       LIMIT ?`,
    )
    .all(days) as Array<{
    date: string;
    outcome_bull: number;
    outcome_base: number;
    outcome_bear: number;
    brier_bull: number;
    brier_base: number;
    brier_bear: number;
    brier_total: number;
  }>;
  if (rows.length === 0) return null;

  // Mean per-scenario Brier
  const n = rows.length;
  const meanBull = rows.reduce((s, r) => s + r.brier_bull, 0) / n;
  const meanBase = rows.reduce((s, r) => s + r.brier_base, 0) / n;
  const meanBear = rows.reduce((s, r) => s + r.brier_bear, 0) / n;
  const meanTotal = rows.reduce((s, r) => s + r.brier_total, 0) / n;

  // Baseline forecaster = CLIMATOLOGY (always predicts the realized frequency),
  // not uniform 1/3. Base is structurally the most likely bucket (±0.5 EM
  // middle), so uniform was a straw man any constant forecast could beat.
  // Shared helper: the CUSUM watchdog uses the same definition.
  const clim = climatologyBaseline(
    rows.map((r) => [r.outcome_bull, r.outcome_base, r.outcome_bear]),
  );
  const [realizedBull, realizedBase, realizedBear] = clim.freqs;
  const [trivialBull, trivialBase, trivialBear] = clim.perClass;
  const trivialTotal = clim.total;

  // Top-pick hit rate. We need the original prediction to know which scenario
  // was the top pick that day. JOIN to pulse_predictions for the morning row.
  const hitRows = sqlite
    .prepare(
      `SELECT
         o.outcome_bull, o.outcome_base, o.outcome_bear,
         p.prob_bull, p.prob_base, p.prob_bear, p.prob_source, p.source
       FROM pulse_outcomes o
       JOIN pulse_predictions p
         ON p.date = o.date
         AND p.id = (
           SELECT id FROM pulse_predictions
           WHERE date = o.date
           ORDER BY captured_at ASC
           LIMIT 1
         )
       WHERE o.date >= ?
       ORDER BY o.date DESC
       LIMIT ?`,
    )
    // Same date set as `rows` (the oldest settled date in the window), so the
    // hit rate and the mean forecast are over exactly the days the Brier is.
    .all(rows[rows.length - 1].date, days) as Array<{
    outcome_bull: number;
    outcome_base: number;
    outcome_bear: number;
    prob_bull: number;
    prob_base: number;
    prob_bear: number;
    prob_source: string | null;
    source: string | null;
  }>;
  let hits = 0;
  const probSourceMix: Record<string, number> = {};
  const slotMix: Record<string, number> = {};
  let fB = 0, fM = 0, fR = 0;
  for (const r of hitRows) {
    const ps = r.prob_source ?? "unrecorded";
    probSourceMix[ps] = (probSourceMix[ps] ?? 0) + 1;
    const sl = r.source ?? "unrecorded";
    slotMix[sl] = (slotMix[sl] ?? 0) + 1;
    fB += r.prob_bull; fM += r.prob_base; fR += r.prob_bear;
    const probs = [r.prob_bull, r.prob_base, r.prob_bear];
    const outs = [r.outcome_bull, r.outcome_base, r.outcome_bear];
    let topIdx = 0;
    for (let i = 1; i < 3; i++) if (probs[i] > probs[topIdx]) topIdx = i;
    if (outs[topIdx] === 1) hits++;
  }
  const topPickHitRate = hitRows.length > 0 ? hits / hitRows.length : 0;
  const m = hitRows.length || 1;
  const skillOf = (bs: number, clim: number) => (Number.isFinite(clim) && clim > 0 ? 1 - bs / clim : null);

  return {
    meanForecast: { bull: fB / m, base: fM / m, bear: fR / m },
    probSourceMix,
    slotMix,
    skill: { bull: skillOf(meanBull, trivialBull), base: skillOf(meanBase, trivialBase), bear: skillOf(meanBear, trivialBear), total: skillOf(meanTotal, trivialTotal) },
    gated: n < CALIBRATION_MIN_DAYS,
    minDays: CALIBRATION_MIN_DAYS,
    n,
    bull: meanBull,
    base: meanBase,
    bear: meanBear,
    total: meanTotal,
    trivialBull,
    trivialBase,
    trivialBear,
    trivialTotal,
    topPickHitRate,
    topPickHits: hits,
    topPickN: hitRows.length,
    realized: { bull: realizedBull, base: realizedBase, bear: realizedBear },
  };
}

// Pull the morning-card forecast probabilities for the last N settled days.
// Used to compute the resolution score (Mauboussin footnote 45) — we need
// the variance of forecast probs ACROSS days, not within a single day.
export function recentForecastProbs(days: number = 30): {
  bull: number[];
  base: number[];
  bear: number[];
} {
  const rows = sqlite
    .prepare(
      `SELECT p.prob_bull, p.prob_base, p.prob_bear
       FROM pulse_outcomes o
       JOIN pulse_predictions p
         ON p.date = o.date
         AND p.id = (
           SELECT id FROM pulse_predictions
           WHERE date = o.date
           ORDER BY captured_at ASC
           LIMIT 1
         )
       ORDER BY o.date DESC
       LIMIT ?`,
    )
    .all(days) as Array<{
    prob_bull: number;
    prob_base: number;
    prob_bear: number;
  }>;
  return {
    bull: rows.map((r) => r.prob_bull),
    base: rows.map((r) => r.prob_base),
    bear: rows.map((r) => r.prob_bear),
  };
}

// Letter grade from an ABSOLUTE Brier. Not used by the card any more: an
// absolute Brier threshold says nothing in a three-class problem whose base
// bucket realises most days (a constant base-rate forecast scores "good"
// here), so the card reports skill against climatology instead. Kept for
// the /api/calibration consumers that still read it.
export function gradeBrier(b: number): { letter: string; label: string } {
  if (b < 0.06) return { letter: "A+", label: "elite" };
  if (b < 0.10) return { letter: "A", label: "excellent" };
  if (b < 0.15) return { letter: "B", label: "good" };
  if (b < 0.20) return { letter: "C", label: "fair" };
  if (b < 0.25) return { letter: "D", label: "weak" };
  return { letter: "F", label: "poor" };
}

// True if Pulse beats the trivial forecaster on a metric. Unused by the card
// (the skill score carries the comparison); kept for API consumers.
export function beatsTrivial(pulse: number, trivial: number): boolean {
  return pulse < trivial;
}
