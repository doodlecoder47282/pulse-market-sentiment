// server/masterAlphaFit.ts
//
// Re-estimates masterAlpha's component weights on the app's OWN logged
// history instead of borrowing β = −0.18 and the $80M net-charm σ from the
// Baltussen-Terstegge-Whelan sample (different OI coverage, sign conventions
// and time units than this app's net-charm).
//
// Model (OLS, one row per independent session):
//   realized_bps = c + Σ_j m_j · componentBps_j + ε
// m_j is the realized bps per bps the component predicted. Under the
// hand-set formula the implied m_j is the component weight w_j (× regime and
// triple-witching multipliers), so m_j ≈ w_j means the weights are right and
// m_j ≈ 0 means the component carries no information.
//
// Sample-size gate. For one predictor with true R² = 3.2% (the paper's
// value), the slope t-statistic has noncentrality ≈ √(n·R²/(1 − R²)).
// Requiring 80% power for a two-sided 5% test gives
//   n ≈ (z_{0.975} + z_{0.80})² (1 − R²)/R² = (1.960 + 0.842)² × 0.968 / 0.032 ≈ 237
// independent sessions (only 50% power at n ≈ 116), plus one per
// regressor: MIN_SESSIONS = 250, about one trading year of daily sessions.
// Below that the fit is reported as "insufficient-data" and the live formula
// keeps its hand-set weights, labeled as such. Even at "fit-ready" the
// weights are NOT swapped in automatically: a fitted model replaces a
// hand-set one only after a human reviews the out-of-sample R² below
// (Campbell & Thompson 2008, RFS 21:1509 — OOS R² vs the training mean).

import { olsFit } from "./stats";

export const MASTER_ALPHA_MIN_SESSIONS = 250;
const OOS_FRACTION = 0.3;

export interface MasterAlphaFitSample {
  ts: number;                    // epoch seconds of the snapshot
  sessionDate: string;           // YYYY-MM-DD
  horizon: string;
  components: Array<{ name: string; directionBps: number; weight?: number }>;
  realizedBps: number;           // snapshot spot → session close, bps
}

export interface MasterAlphaFit {
  status: "insufficient-data" | "fit-ready" | "fit-failed";
  horizon: string;
  sessions: number;              // independent sessions used (one per date)
  minSessions: number;
  intercept: number | null;
  coefficients: Array<{ component: string; multiplier: number; se: number; t: number; handSetWeight: number | null }>;
  droppedComponents: string[];   // constant (e.g. always 0) in the sample
  sessionsDroppedMissing: number; // sessions dropped because a used component was not logged (never filled with 0)
  r2: number | null;
  oosR2: number | null;          // last 30% of sessions, model fit on the first 70%
  note: string;
}

/** Stable component key: "Charm — daily window" → "charm". */
export function componentKey(name: string): string {
  return (name.split(/[\s—-]+/)[0] ?? name).toLowerCase();
}

export function fitMasterAlphaWeights(
  samples: MasterAlphaFitSample[],
  opts: { horizon?: string; minSessions?: number } = {},
): MasterAlphaFit {
  const horizon = opts.horizon ?? "daily";
  const minSessions = opts.minSessions ?? MASTER_ALPHA_MIN_SESSIONS;
  // One observation per session: the first snapshot of the day for this
  // horizon. Several snapshots on one date share one realized close, so
  // counting them separately would overstate the evidence.
  const firstBySession = new Map<string, MasterAlphaFitSample>();
  for (const s of samples) {
    if (s.horizon !== horizon || !Number.isFinite(s.realizedBps) || !Array.isArray(s.components)) continue;
    const prev = firstBySession.get(s.sessionDate);
    if (!prev || s.ts < prev.ts) firstBySession.set(s.sessionDate, s);
  }
  const rows = [...firstBySession.values()].sort((a, b) => a.ts - b.ts);
  const base: MasterAlphaFit = {
    status: "insufficient-data", horizon, sessions: rows.length, minSessions,
    intercept: null, coefficients: [], droppedComponents: [], sessionsDroppedMissing: 0, r2: null, oosR2: null,
    note: `hand-set weights: need ≥${minSessions} independent ${horizon} sessions with logged components, have ${rows.length}`,
  };
  if (rows.length < minSessions) return base;

  const keys = [...new Set(rows.flatMap((r) => r.components.map((c) => componentKey(c.name))))].sort();
  const handSet = new Map<string, number>();
  for (const r of rows) for (const c of r.components) {
    if (typeof c.weight === "number" && !handSet.has(componentKey(c.name))) handSet.set(componentKey(c.name), c.weight);
  }
  // A component that was not logged (or not finite) is MISSING, not 0 bps:
  // filling it with 0 would bias its multiplier toward 0 and the others with it.
  const value = (r: MasterAlphaFitSample, k: string): number => {
    const c = r.components.find((x) => componentKey(x.name) === k);
    return c && Number.isFinite(c.directionBps) ? c.directionBps : NaN;
  };
  const used = keys.filter((k) => {
    const v = rows.map((r) => value(r, k)).filter(Number.isFinite);
    return v.length > 0 && Math.max(...v) - Math.min(...v) > 1e-9;
  });
  const dropped = keys.filter((k) => !used.includes(k));
  // Complete-case fit: drop sessions missing any used component, and say how many.
  const complete = rows.filter((r) => used.every((k) => Number.isFinite(value(r, k))));
  const sessionsDroppedMissing = rows.length - complete.length;
  if (complete.length < minSessions) {
    return {
      ...base, sessions: complete.length, droppedComponents: dropped, sessionsDroppedMissing,
      note: `hand-set weights: need ≥${minSessions} independent ${horizon} sessions with every component logged, have ${complete.length} (${sessionsDroppedMissing} dropped for a missing component)`,
    };
  }
  const X = complete.map((r) => [1, ...used.map((k) => value(r, k))]);
  const y = complete.map((r) => r.realizedBps);
  const f = olsFit(X, y);
  if (!f.ok) {
    return { ...base, status: "fit-failed", sessions: complete.length, droppedComponents: dropped, sessionsDroppedMissing, note: "hand-set weights: OLS failed (collinear components)" };
  }

  // Out-of-sample check: fit on the first 70%, score the last 30% against
  // the training-mean forecast.
  let oosR2: number | null = null;
  const nTrain = Math.floor(complete.length * (1 - OOS_FRACTION));
  const tr = olsFit(X.slice(0, nTrain), y.slice(0, nTrain));
  if (tr.ok && nTrain < complete.length) {
    const yBar = y.slice(0, nTrain).reduce((s, v) => s + v, 0) / nTrain;
    let sse = 0, sseBench = 0;
    for (let i = nTrain; i < complete.length; i++) {
      const yh = X[i].reduce((s, v, j) => s + v * tr.coef[j], 0);
      sse += (y[i] - yh) ** 2;
      sseBench += (y[i] - yBar) ** 2;
    }
    oosR2 = sseBench > 0 ? 1 - sse / sseBench : null;
  }

  return {
    status: "fit-ready",
    horizon,
    sessions: complete.length,
    minSessions,
    intercept: f.coef[0],
    coefficients: used.map((k, j) => ({
      component: k,
      multiplier: f.coef[j + 1],
      se: f.se[j + 1],
      t: f.t[j + 1],
      handSetWeight: handSet.get(k) ?? null,
    })),
    droppedComponents: dropped,
    sessionsDroppedMissing,
    r2: f.r2,
    oosR2,
    note: "fit available for review; live formula still uses hand-set weights until a reviewed fit is promoted",
  };
}
