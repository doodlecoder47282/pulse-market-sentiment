// Edge stats engine. Reads graded prediction_outcomes and produces
// rolling aggregates by symbol, regime, type, premium tier, calibration
// buckets, and threshold suggestions.

import { db } from "./storage";
import { predictionOutcomes } from "@shared/schema";
import { and, eq, gte, lte, sql } from "drizzle-orm";

export interface EdgeStats {
  asOf: number;
  windowDays: number;
  windowFrom: number;
  whaleAlerts: WhaleAlertEdge;
  regimeCalls: RegimeCallEdge;
  suggestions: ThresholdSuggestion[];
}

interface WhaleAlertEdge {
  total: number;
  graded: number;
  pending: number;
  hit30Rate: number;
  hit50Rate: number;
  hit100Rate: number;
  avgPctReturn: number;
  bySymbol: { symbol: string; n: number; hit30Rate: number; avgPctReturn: number }[];
  byType: { type: "CALL" | "PUT"; n: number; hit30Rate: number; avgPctReturn: number }[];
  byPremiumTier: { tier: string; n: number; hit30Rate: number; avgPctReturn: number }[];
  byVolOiTier: { tier: string; n: number; hit30Rate: number; avgPctReturn: number }[];
  byDeltaTier: { tier: string; n: number; hit30Rate: number; avgPctReturn: number }[];
}

interface RegimeCallEdge {
  total: number;
  graded: number;
  pending: number;
  overallHitRate: number;
  byConfidenceBucket: { bucket: string; n: number; hitRate: number }[];
  byRegime: { regime: string; n: number; hitRate: number }[];
  calibration: { predictedProb: number; actualHitRate: number; n: number }[];
}

export interface ThresholdSuggestion {
  field: "premiumFloor" | "volOiRatio" | "deltaMin" | "deltaMax" | "minDte";
  currentNote: string;
  suggested: number;
  rationale: string;
  liftHit30: number; // how much hit-30 would have improved
  alertReductionPct: number; // how many fewer alerts (0..1)
}

export function computeEdgeStats(windowDays: number = 30): EdgeStats {
  const now = Date.now();
  const windowFrom = now - windowDays * 24 * 60 * 60 * 1000;

  const allRows = db
    .select()
    .from(predictionOutcomes)
    .where(gte(predictionOutcomes.capturedAt, windowFrom))
    .all();

  const whaleRows = allRows.filter((r) => r.kind === "whale_alert");
  const regimeRows = allRows.filter((r) => r.kind === "regime_call");

  return {
    asOf: now,
    windowDays,
    windowFrom,
    whaleAlerts: aggregateWhaleAlerts(whaleRows),
    regimeCalls: aggregateRegimeCalls(regimeRows),
    suggestions: deriveSuggestions(whaleRows),
  };
}

// ─── Whale alerts aggregation ────────────────────────────────────────────────

function aggregateWhaleAlerts(rows: any[]): WhaleAlertEdge {
  const total = rows.length;
  const graded = rows.filter((r) => r.graded === 1 && r.pctReturn != null);
  const pending = rows.filter((r) => r.graded === 0).length;
  const hit30 = graded.filter((r) => r.hit30 === 1).length;
  const hit50 = graded.filter((r) => r.hit50 === 1).length;
  const hit100 = graded.filter((r) => r.hit100 === 1).length;
  const avgPctReturn = graded.length
    ? graded.reduce((s, r) => s + (r.pctReturn ?? 0), 0) / graded.length
    : 0;

  const bySymbol = groupAndScore(graded, (r) => r.symbol);
  const byType = groupAndScore(graded, (r) => normType(JSON.parse(r.predictionJson || "{}").type));
  const byPremiumTier = groupAndScore(graded, (r) => premiumTier(JSON.parse(r.predictionJson || "{}").premium));
  const byVolOiTier = groupAndScore(graded, (r) => volOiTier(JSON.parse(r.predictionJson || "{}").volOiRatio));
  const byDeltaTier = groupAndScore(graded, (r) => deltaTier(JSON.parse(r.predictionJson || "{}").delta));

  return {
    total,
    graded: graded.length,
    pending,
    hit30Rate: graded.length ? hit30 / graded.length : 0,
    hit50Rate: graded.length ? hit50 / graded.length : 0,
    hit100Rate: graded.length ? hit100 / graded.length : 0,
    avgPctReturn,
    bySymbol: bySymbol.map(({ key, ...rest }) => ({ symbol: key, ...rest })) as any,
    byType: byType.map(({ key, ...rest }) => ({ type: key as any, ...rest })) as any,
    byPremiumTier: byPremiumTier.map(({ key, ...rest }) => ({ tier: key, ...rest })) as any,
    byVolOiTier: byVolOiTier.map(({ key, ...rest }) => ({ tier: key, ...rest })) as any,
    byDeltaTier: byDeltaTier.map(({ key, ...rest }) => ({ tier: key, ...rest })) as any,
  };
}

function groupAndScore(
  graded: any[],
  keyFn: (r: any) => string,
): { key: string; n: number; hit30Rate: number; avgPctReturn: number }[] {
  const map = new Map<string, any[]>();
  for (const r of graded) {
    const k = keyFn(r);
    if (!k) continue;
    const arr = map.get(k) ?? [];
    arr.push(r);
    map.set(k, arr);
  }
  return Array.from(map.entries())
    .map(([key, arr]) => ({
      key,
      n: arr.length,
      hit30Rate: arr.filter((r) => r.hit30 === 1).length / arr.length,
      avgPctReturn: arr.reduce((s, r) => s + (r.pctReturn ?? 0), 0) / arr.length,
    }))
    .sort((a, b) => b.n - a.n);
}

function normType(t: any): "CALL" | "PUT" {
  const s = String(t || "").toUpperCase();
  return s === "C" || s === "CALL" ? "CALL" : "PUT";
}
function premiumTier(p: number): string {
  if (p >= 5_000_000) return "$5M+";
  if (p >= 2_500_000) return "$2.5-5M";
  if (p >= 1_500_000) return "$1.5-2.5M";
  return "$1-1.5M";
}
function volOiTier(r: number): string {
  if (r >= 50) return "50x+";
  if (r >= 25) return "25-50x";
  if (r >= 15) return "15-25x";
  return "10-15x";
}
function deltaTier(d: number): string {
  const a = Math.abs(d);
  if (a >= 0.6) return "0.6+";
  if (a >= 0.4) return "0.4-0.6";
  if (a >= 0.25) return "0.25-0.4";
  return "0.2-0.25";
}

// ─── Regime calls aggregation ────────────────────────────────────────────────

function aggregateRegimeCalls(rows: any[]): RegimeCallEdge {
  const total = rows.length;
  const graded = rows.filter((r) => r.graded === 1 && r.hit30 != null);
  const pending = rows.filter((r) => r.graded === 0).length;
  const overallHitRate = graded.length
    ? graded.filter((r) => r.hit30 === 1).length / graded.length
    : 0;

  // Confidence buckets
  const buckets: Record<string, any[]> = {
    "low (30-50%)": [],
    "med (50-70%)": [],
    "high (70-90%)": [],
    "very-high (90%+)": [],
  };
  for (const r of graded) {
    const conf = JSON.parse(r.predictionJson || "{}").confidence ?? 0;
    if (conf < 0.5) buckets["low (30-50%)"].push(r);
    else if (conf < 0.7) buckets["med (50-70%)"].push(r);
    else if (conf < 0.9) buckets["high (70-90%)"].push(r);
    else buckets["very-high (90%+)"].push(r);
  }
  const byConfidenceBucket = Object.entries(buckets).map(([bucket, arr]) => ({
    bucket,
    n: arr.length,
    hitRate: arr.length ? arr.filter((r) => r.hit30 === 1).length / arr.length : 0,
  }));

  // Per regime category
  const regMap = new Map<string, any[]>();
  for (const r of graded) {
    const reg = JSON.parse(r.predictionJson || "{}").topCandidate ?? "?";
    const arr = regMap.get(reg) ?? [];
    arr.push(r);
    regMap.set(reg, arr);
  }
  const byRegime = Array.from(regMap.entries()).map(([regime, arr]) => ({
    regime,
    n: arr.length,
    hitRate: arr.length ? arr.filter((r) => r.hit30 === 1).length / arr.length : 0,
  }));

  // Calibration: bin predicted probabilities, see if actual hit rate matches
  const probBuckets = [
    { lo: 0.3, hi: 0.5 },
    { lo: 0.5, hi: 0.7 },
    { lo: 0.7, hi: 0.85 },
    { lo: 0.85, hi: 1.01 },
  ];
  const calibration = probBuckets.map((b) => {
    const items = graded.filter((r) => {
      const p = JSON.parse(r.predictionJson || "{}").topProbability ?? 0;
      return p >= b.lo && p < b.hi;
    });
    return {
      predictedProb: (b.lo + b.hi) / 2,
      actualHitRate: items.length ? items.filter((r) => r.hit30 === 1).length / items.length : 0,
      n: items.length,
    };
  });

  return {
    total,
    graded: graded.length,
    pending,
    overallHitRate,
    byConfidenceBucket,
    byRegime,
    calibration,
  };
}

// ─── Threshold suggestion engine ─────────────────────────────────────────────

function deriveSuggestions(whaleRows: any[]): ThresholdSuggestion[] {
  const suggestions: ThresholdSuggestion[] = [];
  const graded = whaleRows.filter((r) => r.graded === 1 && r.pctReturn != null);
  if (graded.length < 20) return suggestions;

  const overallHit30 = graded.filter((r) => r.hit30 === 1).length / graded.length;

  // Premium floor sweep — what if we'd been stricter?
  for (const floor of [1_500_000, 2_000_000, 2_500_000, 5_000_000]) {
    const filtered = graded.filter((r) => {
      const prem = JSON.parse(r.predictionJson || "{}").premium ?? 0;
      return prem >= floor;
    });
    if (filtered.length < 10) continue;
    const hit = filtered.filter((r) => r.hit30 === 1).length / filtered.length;
    const lift = hit - overallHit30;
    const reduction = 1 - filtered.length / graded.length;
    if (lift >= 0.05) {
      suggestions.push({
        field: "premiumFloor",
        currentNote: "$1M",
        suggested: floor,
        rationale: `Last ${graded.length} graded alerts: tightening to $${(floor / 1e6).toFixed(1)}M would lift hit-30 from ${(overallHit30 * 100).toFixed(0)}% to ${(hit * 100).toFixed(0)}%.`,
        liftHit30: lift,
        alertReductionPct: reduction,
      });
      break; // one premium suggestion is enough
    }
  }

  // Vol/OI ratio sweep
  for (const minRatio of [15, 20, 30]) {
    const filtered = graded.filter((r) => {
      const v = JSON.parse(r.predictionJson || "{}").volOiRatio ?? 0;
      return v >= minRatio;
    });
    if (filtered.length < 10) continue;
    const hit = filtered.filter((r) => r.hit30 === 1).length / filtered.length;
    const lift = hit - overallHit30;
    const reduction = 1 - filtered.length / graded.length;
    if (lift >= 0.05) {
      suggestions.push({
        field: "volOiRatio",
        currentNote: "10x",
        suggested: minRatio,
        rationale: `Tightening vol/OI to ${minRatio}x would lift hit-30 from ${(overallHit30 * 100).toFixed(0)}% to ${(hit * 100).toFixed(0)}%.`,
        liftHit30: lift,
        alertReductionPct: reduction,
      });
      break;
    }
  }

  // Delta floor
  for (const dMin of [0.25, 0.3, 0.35]) {
    const filtered = graded.filter((r) => {
      const d = Math.abs(JSON.parse(r.predictionJson || "{}").delta ?? 0);
      return d >= dMin;
    });
    if (filtered.length < 10) continue;
    const hit = filtered.filter((r) => r.hit30 === 1).length / filtered.length;
    const lift = hit - overallHit30;
    const reduction = 1 - filtered.length / graded.length;
    if (lift >= 0.05) {
      suggestions.push({
        field: "deltaMin",
        currentNote: "0.20",
        suggested: dMin,
        rationale: `Tightening delta floor to ${dMin.toFixed(2)} would lift hit-30 from ${(overallHit30 * 100).toFixed(0)}% to ${(hit * 100).toFixed(0)}%.`,
        liftHit30: lift,
        alertReductionPct: reduction,
      });
      break;
    }
  }

  return suggestions;
}

// ─── Regime-conditioned conviction multiplier ─────────────────────────────────
// Read-only utility: given current regime + symbol, returns a multiplier
// (0.5..1.5) based on rolling 30d hit-rate of whale alerts in that regime.
export function regimeConvictionMultiplier(
  symbol: string,
  currentRegime: string,
  windowDays: number = 30,
): { multiplier: number; n: number; baseHitRate: number; regimeHitRate: number } {
  try {
    const now = Date.now();
    const from = now - windowDays * 24 * 60 * 60 * 1000;
    const rows = db
      .select()
      .from(predictionOutcomes)
      .where(
        and(
          eq(predictionOutcomes.kind, "whale_alert"),
          eq(predictionOutcomes.symbol, symbol),
          eq(predictionOutcomes.graded, 1),
          gte(predictionOutcomes.capturedAt, from),
        ),
      )
      .all();
    if (rows.length < 5) return { multiplier: 1.0, n: rows.length, baseHitRate: 0, regimeHitRate: 0 };
    const baseHit = rows.filter((r) => r.hit30 === 1).length / rows.length;
    const inRegime = rows.filter((r) => {
      const inputs = JSON.parse(r.inputsJson || "{}");
      return inputs.regimeAtFire === currentRegime;
    });
    if (inRegime.length < 3) return { multiplier: 1.0, n: rows.length, baseHitRate: baseHit, regimeHitRate: 0 };
    const regHit = inRegime.filter((r) => r.hit30 === 1).length / inRegime.length;
    // Multiplier in [0.5, 1.5]; 1.0 = neutral
    const ratio = baseHit > 0 ? regHit / baseHit : 1.0;
    const multiplier = Math.max(0.5, Math.min(1.5, ratio));
    return { multiplier, n: rows.length, baseHitRate: baseHit, regimeHitRate: regHit };
  } catch {
    return { multiplier: 1.0, n: 0, baseHitRate: 0, regimeHitRate: 0 };
  }
}
