// server/calibration.ts
//
// Pulse calibration tracker. Records every scenarioProb / scenarioTargets
// triple we publish and scores them against the actual SPX close at 4pm ET.
//
// CRITICAL DESIGN PRINCIPLE: this module is READ-ONLY against existing calcs.
// It does not touch models.ts, discordSelzCard.ts, or any pricing logic.
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

import Database from "better-sqlite3";

const sqlite = new Database("data.db");

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
};

// Record a prediction. Called from postSelzDailyCard right before it sends.
export function recordPrediction(p: PredictionRow): void {
  try {
    sqlite
      .prepare(
        `INSERT INTO pulse_predictions
         (date, captured_at, spot, target_bull, target_base, target_bear,
          prob_bull, prob_base, prob_bear, one_day_em, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  // Reference baseline: the "always 1/3" trivial forecaster.
  // BS for that = 3 * (1/3)² when wrong scenario = 0.222, etc.
  // We compute it dynamically from the same outcome stream so we have a
  // fair comparator for the user.
  trivialBull: number;
  trivialBase: number;
  trivialBear: number;
  trivialTotal: number;
  // Hit rate = fraction of days where the highest-prob scenario realized.
  topPickHitRate: number;
  // Outcome distribution actually realized (helps spot whether base is
  // structurally over/under-weighted).
  realized: { bull: number; base: number; bear: number };
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

  // Trivial forecaster (1/3, 1/3, 1/3) Brier on the same outcomes
  const trivialBull =
    rows.reduce((s, r) => s + Math.pow(1 / 3 - r.outcome_bull, 2), 0) / n;
  const trivialBase =
    rows.reduce((s, r) => s + Math.pow(1 / 3 - r.outcome_base, 2), 0) / n;
  const trivialBear =
    rows.reduce((s, r) => s + Math.pow(1 / 3 - r.outcome_bear, 2), 0) / n;
  const trivialTotal = trivialBull + trivialBase + trivialBear;

  // Realized outcome distribution
  const realizedBull = rows.reduce((s, r) => s + r.outcome_bull, 0) / n;
  const realizedBase = rows.reduce((s, r) => s + r.outcome_base, 0) / n;
  const realizedBear = rows.reduce((s, r) => s + r.outcome_bear, 0) / n;

  // Top-pick hit rate. We need the original prediction to know which scenario
  // was the top pick that day. JOIN to pulse_predictions for the morning row.
  const hitRows = sqlite
    .prepare(
      `SELECT
         o.outcome_bull, o.outcome_base, o.outcome_bear,
         p.prob_bull, p.prob_base, p.prob_bear
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
    outcome_bull: number;
    outcome_base: number;
    outcome_bear: number;
    prob_bull: number;
    prob_base: number;
    prob_bear: number;
  }>;
  let hits = 0;
  for (const r of hitRows) {
    const probs = [r.prob_bull, r.prob_base, r.prob_bear];
    const outs = [r.outcome_bull, r.outcome_base, r.outcome_bear];
    let topIdx = 0;
    for (let i = 1; i < 3; i++) if (probs[i] > probs[topIdx]) topIdx = i;
    if (outs[topIdx] === 1) hits++;
  }
  const topPickHitRate = hitRows.length > 0 ? hits / hitRows.length : 0;

  return {
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
    realized: { bull: realizedBull, base: realizedBase, bear: realizedBear },
  };
}

// Lightweight grade letter from a Brier — for the user-facing card.
// Reference: 0.06–0.12 = top forecaster, <0.20 good, <0.25 ok, >0.25 weak.
export function gradeBrier(b: number): { letter: string; label: string } {
  if (b < 0.06) return { letter: "A+", label: "elite" };
  if (b < 0.10) return { letter: "A", label: "excellent" };
  if (b < 0.15) return { letter: "B", label: "good" };
  if (b < 0.20) return { letter: "C", label: "fair" };
  if (b < 0.25) return { letter: "D", label: "weak" };
  return { letter: "F", label: "poor" };
}

// True if Pulse beats the trivial forecaster on a metric.
export function beatsTrivial(pulse: number, trivial: number): boolean {
  return pulse < trivial;
}
