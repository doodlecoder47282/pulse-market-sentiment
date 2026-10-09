// Edge stats engine. Reads graded prediction_outcomes and produces
// rolling aggregates by symbol, regime, type, premium tier, calibration
// buckets, and threshold suggestions.

import { db } from "./storage";
import { predictionOutcomes } from "@shared/schema";
import { isOutcomeOnOptionMarks } from "./validationMath";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { reliabilityCurve, wilsonInterval, firstPerSession, type ReliabilityReport } from "./stats";
import {
  whaleGradingCoverage, walkForwardThreshold, sweepAboveGate, WF_Z_CRIT,
  type WalkForwardResult, type WfRow,
} from "./edgeStatsMath";
import { getFlowConfig } from "./flowConfig";

/** Threshold suggestions are tested on at least this much history (walk-forward needs rows). */
export const SUGGESTION_WINDOW_DAYS = 180;

// The event a regime call's hit_30 records (outcomeLogger.gradeRegimeCall):
// a proxy, not the regime itself.
const REGIME_HIT_EVENT =
  "regime-match proxy: SPY close-to-close |move| >= 0.5% to the grading date for TREND calls, < 0.5% for CHOP/neutral; one call per ET session";

export interface EdgeStats {
  asOf: number;
  windowDays: number;
  windowFrom: number;
  whaleAlerts: WhaleAlertEdge;
  regimeCalls: RegimeCallEdge;
  suggestions: ThresholdSuggestion[];
  /** Every swept field with its walk-forward result, suggested or not (round-2 item 7). */
  suggestionTests: SuggestionTest[];
  /** History the suggestion tests used (max(windowDays, SUGGESTION_WINDOW_DAYS)). */
  suggestionWindowDays: number;
}

export interface SuggestionTest {
  field: ThresholdSuggestion["field"];
  /** live gate from getFlowConfig() */
  current: number;
  /** candidate cut-offs, all strictly tighter than the live gate */
  candidates: number[];
  inSampleValue: number | null;
  walkForward: WalkForwardResult;
}

interface WhaleAlertEdge {
  total: number;
  graded: number;
  pending: number;
  /** Resolved alerts with no usable logged mark: never graded, never counted as misses (round-2 item 8). */
  ungradedNoMark: number;
  /** ungradedNoMark / (graded + ungradedNoMark); null when nothing resolved. */
  ungradedShare: number | null;
  ungradedReasons: Record<string, number>;
  /** Old leverage-proxy rows in the window, excluded from every rate. */
  legacyProxyExcluded: number;
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
  // ONE call per ET session (the first): calls logged every few minutes in
  // a session share one graded outcome. predictedProb = mean predicted
  // probability in the bucket (bucket midpoint when empty); actualHitRate is
  // null for an empty bucket (no data, not 0%). wilsonLo/Hi = Wilson 95%
  // interval of the hit rate; tested = n ≥ 10; inInterval = predicted inside
  // that interval (null if untested).
  calibration: {
    predictedProb: number; actualHitRate: number | null; n: number;
    hits?: number; wilsonLo?: number; wilsonHi?: number; tested?: boolean; inInterval?: boolean | null;
  }[];
  // Stated calibration test on the same one-per-session (topProbability, hit30) pairs.
  reliability?: ReliabilityReport;
  calibrationSessions?: number;   // independent sessions behind calibration + reliability
  calibrationEvent?: string;      // what hit30 measures for regime calls
}

export interface ThresholdSuggestion {
  field: "premiumFloor" | "volOiRatio" | "deltaMin" | "deltaMax" | "minDte";
  currentNote: string;
  suggested: number;
  rationale: string;
  liftHit30: number; // in-sample lift of hit-30 on the whole window
  alertReductionPct: number; // how many fewer alerts (0..1)
  /** Out-of-sample evidence the suggestion passed (walk-forward). */
  oos: {
    n: number; hits: number; hitRate: number | null; wilsonLo: number | null; wilsonHi: number | null;
    droppedN: number; droppedHitRate: number | null; lift: number | null; z: number | null; zCrit: number;
    method: string;
  };
}

export function computeEdgeStats(windowDays: number = 30): EdgeStats {
  const now = Date.now();
  const windowFrom = now - windowDays * 24 * 60 * 60 * 1000;

  const allRows = db
    .select()
    .from(predictionOutcomes)
    .where(gte(predictionOutcomes.capturedAt, windowFrom))
    .all();

  // Rates use only whale outcomes graded on real option marks; proxy-graded
  // rows stay stored but are excluded (and counted). Pending rows (no outcome
  // yet) and ungraded_no_mark rows are counted, never treated as misses.
  const whaleAll = allRows.filter((r) => r.kind === "whale_alert");
  const whaleRows = whaleAll.filter((r: (typeof allRows)[number]) => r.graded === 1 && isOutcomeOnOptionMarks(r));
  const regimeRows = allRows.filter((r) => r.kind === "regime_call");
  // Suggestions use a longer history than the display window: the
  // walk-forward needs rows to have any power (round-2 fix item 4).
  const suggestionWindowDays = Math.max(windowDays, SUGGESTION_WINDOW_DAYS);
  const sugFrom = now - suggestionWindowDays * 24 * 60 * 60 * 1000;
  const sugRows = suggestionWindowDays === windowDays ? whaleRows : db
    .select()
    .from(predictionOutcomes)
    .where(gte(predictionOutcomes.capturedAt, sugFrom))
    .all()
    .filter((r: (typeof allRows)[number]) => r.kind === "whale_alert" && r.graded === 1 && isOutcomeOnOptionMarks(r));
  const { suggestions, tests } = deriveSuggestions(sugRows);

  return {
    asOf: now,
    windowDays,
    windowFrom,
    whaleAlerts: aggregateWhaleAlerts(whaleRows, whaleAll),
    regimeCalls: aggregateRegimeCalls(regimeRows),
    suggestions,
    suggestionTests: tests,
    suggestionWindowDays,
  };
}

// ─── Whale alerts aggregation ────────────────────────────────────────────────

function aggregateWhaleAlerts(rows: any[], allWhaleRows: any[]): WhaleAlertEdge {
  const cov = whaleGradingCoverage(allWhaleRows, isOutcomeOnOptionMarks);
  const total = cov.total;
  const graded = rows.filter((r) => r.graded === 1 && r.pctReturn != null);
  const pending = cov.pending;
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
    ungradedNoMark: cov.ungradedNoMark,
    ungradedShare: cov.ungradedShare,
    ungradedReasons: cov.ungradedReasons,
    legacyProxyExcluded: cov.legacyProxyExcluded,
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
  // Missing / unparseable topProbability is NaN (excluded), never a 0% forecast.
  const topProb = (r: (typeof graded)[number]): number => {
    try {
      const raw = JSON.parse(r.predictionJson || "{}").topProbability;
      const p = raw == null ? NaN : Number(raw);
      return Number.isFinite(p) ? p : NaN;
    } catch {
      return NaN;
    }
  };
  const sessionRows = firstPerSession(
    graded.filter((r) => Number.isFinite(topProb(r))),
    (r) => Number(r.capturedAt),
  );
  const calibration = probBuckets.map((b) => {
    const items = sessionRows.filter((r) => {
      const p = topProb(r);
      return p >= b.lo && p < b.hi;
    });
    const hits = items.filter((r) => r.hit30 === 1).length;
    const n = items.length;
    const meanPred = n ? items.reduce((s, r) => s + topProb(r), 0) / n : (b.lo + b.hi) / 2;
    const w = wilsonInterval(hits, n);
    const tested = n >= 10;
    return {
      predictedProb: meanPred,
      actualHitRate: n ? hits / n : null,
      n,
      hits,
      wilsonLo: w.lo,
      wilsonHi: w.hi,
      tested,
      inInterval: tested ? meanPred >= w.lo && meanPred <= w.hi : null,
    };
  });
  const reliability = reliabilityCurve(
    sessionRows.map(topProb),
    sessionRows.map((r) => (r.hit30 === 1 ? 1 : 0)),
    { event: REGIME_HIT_EVENT },
  );

  return {
    total,
    graded: graded.length,
    pending,
    overallHitRate,
    byConfidenceBucket,
    byRegime,
    calibration,
    reliability,
    calibrationSessions: sessionRows.length,
    calibrationEvent: REGIME_HIT_EVENT,
  };
}

// ─── Threshold suggestion engine ─────────────────────────────────────────────
//
// Round-2 item 7 (review 8.5): thresholds used to be mined and tested on the
// same 30-day window. Now every candidate field is run through an anchored
// walk-forward with purging (edgeStatsMath.walkForwardThreshold): the
// threshold is chosen on earlier rows whose outcome was already known, then
// scored on later rows it never saw. A suggestion appears only when the
// out-of-sample rows it keeps beat the rows it drops (one-sided pooled
// two-proportion z >= WF_Z_CRIT, Bonferroni over the three fields) with at
// least 10 rows on each side; its out-of-sample hit rate is reported with a
// Wilson 95% interval. The in-sample bar (5 points and 2 SE) still applies
// to pick the candidate.

// Candidate grids; only values strictly tighter than the LIVE gate
// (getFlowConfig(): defaults $2.5M premium, 15x vol/OI, 0.20 delta) are swept,
// and the "current" label is the live value, not a hard-coded one.
const PREMIUM_GRID = [1_500_000, 2_000_000, 2_500_000, 3_000_000, 4_000_000, 5_000_000, 7_500_000, 10_000_000];
const VOLOI_GRID = [10, 12, 15, 20, 25, 30, 40, 50];
const DELTA_GRID = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];

function sweeps(): Array<{ field: ThresholdSuggestion["field"]; current: number; currentNote: string; values: number[]; get: (p: any) => number; label: (v: number) => string }> {
  const cfg = getFlowConfig();
  return [
    { field: "premiumFloor", current: cfg.premiumFloor, currentNote: `$${(cfg.premiumFloor / 1e6).toFixed(1)}M`, values: sweepAboveGate(cfg.premiumFloor, PREMIUM_GRID), get: (p) => Number(p.premium ?? 0), label: (v) => `$${(v / 1e6).toFixed(1)}M premium floor` },
    { field: "volOiRatio", current: cfg.volOiRatio, currentNote: `${cfg.volOiRatio}x`, values: sweepAboveGate(cfg.volOiRatio, VOLOI_GRID), get: (p) => Number(p.volOiRatio ?? 0), label: (v) => `vol/OI ${v}x` },
    { field: "deltaMin", current: cfg.deltaMin, currentNote: cfg.deltaMin.toFixed(2), values: sweepAboveGate(cfg.deltaMin, DELTA_GRID), get: (p) => Math.abs(Number(p.delta ?? 0)), label: (v) => `delta floor ${v.toFixed(2)}` },
  ];
}

function deriveSuggestions(whaleRows: any[]): { suggestions: ThresholdSuggestion[]; tests: SuggestionTest[] } {
  const suggestions: ThresholdSuggestion[] = [];
  const tests: SuggestionTest[] = [];
  const graded = whaleRows.filter((r) => r.graded === 1 && r.pctReturn != null && r.hit30 != null);
  const parsed = graded.map((r) => {
    let p: any = {};
    try { p = JSON.parse(r.predictionJson || "{}"); } catch { /* noop */ }
    return { r, p };
  });
  const overallHit30 = graded.length ? graded.filter((r) => r.hit30 === 1).length / graded.length : 0;

  for (const sw of sweeps()) {
    const rows: WfRow[] = parsed.map(({ r, p }) => ({
      t: Number(r.capturedAt),
      knownAt: Number(r.gradingDueAt ?? r.gradedAt),
      hit: r.hit30 === 1 ? 1 : 0,
      value: sw.get(p),
    }));
    const wf = walkForwardThreshold(rows, sw.values);
    tests.push({ field: sw.field, current: sw.current, candidates: sw.values, inSampleValue: wf.fullSampleValue, walkForward: wf });
    if (!wf.supported || wf.fullSampleValue == null) continue;
    const v = wf.fullSampleValue;
    const kept = rows.filter((x) => x.value >= v);
    const hit = kept.reduce((s, x) => s + x.hit, 0) / kept.length;
    const o = wf.oos;
    const pc = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(0)}%`);
    suggestions.push({
      field: sw.field,
      currentNote: sw.currentNote,
      suggested: v,
      rationale: `${sw.label(v)}: in-sample (${graded.length} graded) hit-30 ${pc(overallHit30)} -> ${pc(hit)}; ` +
        `out-of-sample (walk-forward, ${o.keptN + o.droppedN} later alerts) kept ${pc(o.keptRate)} ` +
        `(95% CI ${pc(o.keptWilsonLo)}-${pc(o.keptWilsonHi)}, n=${o.keptN}) vs dropped ${pc(o.droppedRate)} (n=${o.droppedN}), z ${o.z?.toFixed(2)}.`,
      liftHit30: hit - overallHit30,
      alertReductionPct: rows.length ? 1 - kept.length / rows.length : 0,
      oos: {
        n: o.keptN, hits: o.keptHits, hitRate: o.keptRate, wilsonLo: o.keptWilsonLo, wilsonHi: o.keptWilsonHi,
        droppedN: o.droppedN, droppedHitRate: o.droppedRate, lift: o.lift, z: o.z, zCrit: WF_Z_CRIT,
        method: `anchored walk-forward, ${wf.folds.length} test folds over the later half, purged training (outcome known before each fold), in-fold screen = largest kept-vs-dropped z, out-of-sample z with continuity correction`,
      },
    });
  }
  return { suggestions, tests };
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
      .all()
      .filter((r) => r.hit30 != null && isOutcomeOnOptionMarks(r)); // ungraded or proxy-graded rows are not misses
    if (rows.length < 5) return { multiplier: 1.0, n: rows.length, baseHitRate: 0, regimeHitRate: 0 };
    const baseHit = rows.filter((r) => r.hit30 === 1).length / rows.length;
    const inRegime = rows.filter((r) => {
      const inputs = JSON.parse(r.inputsJson || "{}");
      return inputs.regimeAtFire === currentRegime;
    });
    if (inRegime.length < 3) return { multiplier: 1.0, n: rows.length, baseHitRate: baseHit, regimeHitRate: 0 };
    // Shrink toward the base rate (pseudo-count of 10) so a 3-for-3 streak
    // can't swing live conviction 1.5x on noise.
    const regHit =
      (inRegime.filter((r) => r.hit30 === 1).length + 10 * baseHit) / (inRegime.length + 10);
    // Multiplier in [0.5, 1.5]; 1.0 = neutral
    const ratio = baseHit > 0 ? regHit / baseHit : 1.0;
    const multiplier = Math.max(0.5, Math.min(1.5, ratio));
    return { multiplier, n: rows.length, baseHitRate: baseHit, regimeHitRate: regHit };
  } catch {
    return { multiplier: 1.0, n: 0, baseHitRate: 0, regimeHitRate: 0 };
  }
}
