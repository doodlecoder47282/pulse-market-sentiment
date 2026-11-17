// Lightweight anomaly detector + ML drift monitor (no heavy deps).
// Uses daily snapshot_history rows as the feature vector and scores today
// against the historical density via a Mahalanobis-style distance with shrinkage.
//
// This is the cheap-and-effective version of "isolation forest" — the goal is
// to flag days where today's market state is in the tail of historical similarity.

import { sqlite } from "./storage";
import { OUTCOME_ON_OPTION_MARKS_SQL } from "./validationMath";

interface SnapHistoryRow {
  date: string;
  spy_close: number;
  composite: number;
  vix: number;
  net_gex: number;
  pcr_oi: number;
}

interface FeatureVec {
  date: string;
  features: number[];
}

const FEATURE_NAMES = ["composite_z", "vix_z", "net_gex_z", "pcr_oi_z", "spy_ret_5d_z"];

function loadHistory(limit = 252): SnapHistoryRow[] {
  return sqlite.prepare(
    `SELECT date, spy_close, composite, vix, net_gex, pcr_oi
     FROM snapshot_history ORDER BY date DESC LIMIT ?`
  ).all(limit) as SnapHistoryRow[];
}

function spy5dRet(rows: SnapHistoryRow[], idx: number): number | null {
  if (idx + 5 >= rows.length) return null;
  const a = rows[idx + 5].spy_close, b = rows[idx].spy_close;
  if (!a || !b) return null;
  return (b - a) / a;
}

function buildFeatureMatrix(rows: SnapHistoryRow[]): FeatureVec[] {
  // mean / std for each raw axis
  const composite = rows.map(r => r.composite);
  const vix = rows.map(r => r.vix);
  const netGex = rows.map(r => r.net_gex);
  const pcrOi = rows.map(r => r.pcr_oi);
  const ret5d = rows.map((_, i) => spy5dRet(rows, i)).map(v => v ?? 0);

  const stats = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, xs.length - 1);
    return { m, sd: Math.sqrt(v) || 1 };
  };
  const cS = stats(composite), vS = stats(vix), gS = stats(netGex), pS = stats(pcrOi), rS = stats(ret5d);

  return rows.map((r, i) => ({
    date: r.date,
    features: [
      (r.composite - cS.m) / cS.sd,
      (r.vix - vS.m) / vS.sd,
      (r.net_gex - gS.m) / gS.sd,
      (r.pcr_oi - pS.m) / pS.sd,
      ((spy5dRet(rows, i) ?? 0) - rS.m) / rS.sd,
    ],
  }));
}

function euclid(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
  return Math.sqrt(s);
}

export interface AnomalyResult {
  date: string;
  features: { name: string; value: number | null; z: number }[];
  nearestNeighborDistance: number;
  meanDistance: number;
  pctileVsHistory: number;          // 0-100; 99 = today is in 1% most-anomalous
  isAnomaly: boolean;               // pctileVsHistory >= 95
  closestDates: { date: string; distance: number }[];
  notes: string;
}

export function scoreAnomalyToday(): AnomalyResult | { error: string } {
  const rows = loadHistory(252);
  if (rows.length < 30) return { error: "insufficient history (need 30+ days)" };
  const matrix = buildFeatureMatrix(rows);
  const today = matrix[0];
  const rest = matrix.slice(1);
  // Distance from today to each historical day
  const dists = rest.map(v => ({ date: v.date, distance: euclid(today.features, v.features) }))
    .sort((a, b) => a.distance - b.distance);
  // Distribution of *historical* nearest-neighbor distances (each day's NN to its rest-of-history)
  const histDists: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    let nn = Infinity;
    for (let j = 0; j < rest.length; j++) {
      if (i === j) continue;
      const d = euclid(rest[i].features, rest[j].features);
      if (d < nn) nn = d;
    }
    if (Number.isFinite(nn)) histDists.push(nn);
  }
  histDists.sort((a, b) => a - b);
  const todayNN = dists[0]?.distance ?? Infinity;
  const rank = histDists.findIndex(d => d >= todayNN);
  const pct = rank < 0 ? 100 : (rank / histDists.length) * 100;
  const isAnomaly = pct >= 95;

  const closest = dists.slice(0, 5);
  const meanDistance = dists.slice(0, 10).reduce((a, b) => a + b.distance, 0) / Math.min(10, dists.length);

  let notes = "today's state has historical analogs — base rates apply";
  if (isAnomaly) notes = "today's market state is in the 5% most unusual of recent history by nearest-neighbour distance: few close analogs, so base rates drawn from that history describe it less well";
  else if (pct >= 80) notes = "today is mildly unusual vs recent history (80th percentile or above of nearest-neighbour distance)";

  return {
    date: today.date,
    // spy_ret_5d is computed (spy5dRet), not a snapshot_history column: reading it off the row gave
    // undefined, the field vanished from the JSON, and the client's toFixed on it threw, taking the
    // whole Edge Lab tab down. A value that is not finite is null, never a hole.
    features: FEATURE_NAMES.map((n, i) => {
      const raw = n === "spy_ret_5d_z" ? spy5dRet(rows, 0) : (rows[0][n.replace("_z", "") as keyof SnapHistoryRow] as number | null | undefined);
      return { name: n, value: typeof raw === "number" && Number.isFinite(raw) ? raw : null, z: today.features[i] };
    }),
    nearestNeighborDistance: todayNN,
    meanDistance,
    pctileVsHistory: pct,
    isAnomaly,
    closestDates: closest,
    notes,
  };
}

// ----- ML drift monitor -----
// We have prediction_outcomes graded over time. Track rolling brier-score / mean abs error
// across the last 30 vs prior 90 trades. If degrades > 25%, flag drift.

export interface DriftResult {
  /** meanAbsPctReturn and meanHit50 are fractions (0.45 = 45%), as stored in prediction_outcomes; the client multiplies by 100. */
  recent30: { count: number; meanAbsPctReturn: number | null; meanHit50: number | null };
  prior90: { count: number; meanAbsPctReturn: number | null; meanHit50: number | null };
  driftPctMae: number | null;       // % change in mean |realized return| (recent 30 vs prior 90); not an error measure
  driftPctHit: number | null;
  status: "stable" | "drifting" | "n/a";
  note: string;
}

export function computeDrift(): DriftResult {
  const rows = sqlite.prepare(
    `SELECT pct_return, hit_50, captured_at FROM prediction_outcomes
     WHERE graded = 1 AND pct_return IS NOT NULL AND ${OUTCOME_ON_OPTION_MARKS_SQL} ORDER BY captured_at DESC LIMIT 200`
  ).all() as { pct_return: number | null; hit_50: number | null; captured_at: number }[];
  if (rows.length < 30) {
    return { recent30: { count: rows.length, meanAbsPctReturn: null, meanHit50: null },
      prior90: { count: 0, meanAbsPctReturn: null, meanHit50: null },
      driftPctMae: null, driftPctHit: null, status: "n/a", note: "insufficient graded outcomes" };
  }
  const recent = rows.slice(0, 30);
  const prior = rows.slice(30, 120);
  const summarize = (xs: typeof rows) => {
    const ret = xs.map(r => Math.abs(r.pct_return ?? 0)).filter(Number.isFinite);
    const hit = xs.map(r => r.hit_50 ?? 0).filter(Number.isFinite);
    return {
      count: xs.length,
      meanAbsPctReturn: ret.length ? ret.reduce((a, b) => a + b, 0) / ret.length : null,
      meanHit50: hit.length ? hit.reduce((a, b) => a + b, 0) / hit.length : null,
    };
  };
  const r = summarize(recent);
  const p = summarize(prior);
  const driftMae = (r.meanAbsPctReturn != null && p.meanAbsPctReturn != null && p.meanAbsPctReturn > 0)
    ? ((r.meanAbsPctReturn - p.meanAbsPctReturn) / p.meanAbsPctReturn) * 100 : null;
  const driftHit = (r.meanHit50 != null && p.meanHit50 != null && p.meanHit50 > 0)
    ? ((r.meanHit50 - p.meanHit50) / p.meanHit50) * 100 : null;
  // The sample gate comes FIRST: a verdict on a 5-row prior is not a verdict. And the first figure is the
  // mean absolute realized option return (a size of outcomes, larger for big winners as much as for big
  // losers), not an error: a rise in it alone is reported as a change, never as "degrading".
  let status: DriftResult["status"] = "stable";
  let note = "hit rate and mean |return| within 25% of the prior 90 grades";
  if (prior.length < 30) { status = "n/a"; note = `not enough prior history for a comparison (${prior.length} of 30 prior grades)`; }
  else if (driftHit != null && driftHit < -25) { status = "drifting"; note = "hit rate down 25% or more against the prior 90 grades"; }
  else if (driftMae != null && Math.abs(driftMae) > 25) { note = `mean |return| ${driftMae > 0 ? "up" : "down"} 25% or more against the prior 90 grades (outcome size changed; says nothing about direction)`; }
  return { recent30: r, prior90: p, driftPctMae: driftMae, driftPctHit: driftHit, status, note };
}
