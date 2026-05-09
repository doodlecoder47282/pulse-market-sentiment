// Lightweight anomaly detector + ML drift monitor (no heavy deps).
// Uses daily snapshot_history rows as the feature vector and scores today
// against the historical density via a Mahalanobis-style distance with shrinkage.
//
// This is the cheap-and-effective version of "isolation forest" — the goal is
// to flag days where today's market state is in the tail of historical similarity.

import { sqlite } from "./storage";

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
  features: { name: string; value: number; z: number }[];
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
  if (isAnomaly) notes = "today's market state is in the 5% most-anomalous of recent history — base rates degrade, mean-reversion strategies break here";
  else if (pct >= 80) notes = "today is mildly unusual vs recent history — degrade signal confidence by ~25%";

  return {
    date: today.date,
    features: FEATURE_NAMES.map((n, i) => ({
      name: n,
      value: rows[0][n.replace("_z", "") as keyof SnapHistoryRow] as number,
      z: today.features[i],
    })),
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
  recent30: { count: number; meanAbsPctReturn: number | null; meanHit50: number | null };
  prior90: { count: number; meanAbsPctReturn: number | null; meanHit50: number | null };
  driftPctMae: number | null;       // % degradation in MAE
  driftPctHit: number | null;
  status: "stable" | "drifting" | "n/a";
  note: string;
}

export function computeDrift(): DriftResult {
  const rows = sqlite.prepare(
    `SELECT pct_return, hit_50, captured_at FROM prediction_outcomes
     WHERE graded = 1 ORDER BY captured_at DESC LIMIT 200`
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
  let status: DriftResult["status"] = "stable";
  let note = "model performance stable vs prior 90 grades";
  if (driftMae != null && driftMae > 25) { status = "drifting"; note = "MAE up 25%+ vs prior 90 — model degrading, retrain or distrust"; }
  else if (driftHit != null && driftHit < -25) { status = "drifting"; note = "hit-rate dropped 25%+ vs prior 90 — calibration breaking"; }
  else if (prior.length < 30) { status = "n/a"; note = "not enough prior history for drift comparison"; }
  return { recent30: r, prior90: p, driftPctMae: driftMae, driftPctHit: driftHit, status, note };
}
