// server/edgeStatsMath.ts
//
// Pure helpers for edgeStats (no DB): whale grading coverage and the
// walk-forward hold-out test that threshold suggestions must pass.
//
// References:
//   Lopez de Prado (2018), "Advances in Financial Machine Learning", Wiley,
//     ch. 7 (purging: a training observation whose outcome is not known
//     before the test period starts leaks the test period) and ch. 11-12
//     (backtests mined and tested on the same data overfit),
//     https://www.wiley.com/en-us/Advances+in+Financial+Machine+Learning-p-9781119482086
//   Bailey, Borwein, Lopez de Prado & Zhu, "The Probability of Backtest
//     Overfitting", J. Computational Finance (2017), https://papers.ssrn.com/abstract=2326253
//     (a single hold-out is a minimum, not a guarantee; we report the
//     out-of-sample evidence instead of claiming an edge).
//   NIST/SEMATECH e-Handbook of Statistical Methods, sec. 7.3.3, two-proportion
//     z = (p1 - p2) / sqrt(p(1-p)(1/n1 + 1/n2)), p pooled,
//     https://www.itl.nist.gov/div898/handbook/prc/section3/prc33.htm
//   Wilson (1927) score interval: validationMath.wilsonInterval.
//   Power of the one-sided two-proportion z test (pooled SE under H0,
//   unpooled under H1), OriginLab "Algorithm (PSS: Two-Proportion Test)",
//   https://docs.originlab.com/origin-help/pss-two-prop-algorithm/ (equal n;
//   the same expression with 1/n1 + 1/n2 for unequal groups).

import { wilsonInterval } from "./validationMath";

// ─── Whale grading coverage (round-2 item 8) ────────────────────────────────

export interface WhaleCoverage {
  /** Rows in the window (pending + graded + ungraded_no_mark; legacy proxy rows excluded). */
  total: number;
  graded: number;
  pending: number;
  /** Resolved but not gradable from real marks (no entry ask or no usable exit bid). */
  ungradedNoMark: number;
  /** ungradedNoMark / (graded + ungradedNoMark): the share of resolved alerts the hit rates cannot see. Null with none resolved. */
  ungradedShare: number | null;
  ungradedReasons: Record<string, number>;
  /** Old rows graded by the leverage proxy: stored, excluded from every rate. */
  legacyProxyExcluded: number;
}

function outcomeOf(r: { outcomeJson?: string | null; outcome_json?: string | null }): any {
  try { return JSON.parse((r.outcomeJson ?? r.outcome_json ?? "") || "{}"); } catch { return {}; }
}

/**
 * Split whale rows into graded / pending / ungraded_no_mark / legacy proxy.
 * `isOnMarks` is validationMath.isOutcomeOnOptionMarks (true for rows graded
 * by the option-marks method). A pending row has no outcome yet and is kept.
 */
export function whaleGradingCoverage(
  rows: Array<{ graded: number | null; pctReturn: number | null; outcomeJson?: string | null }>,
  isOnMarks: (r: any) => boolean,
): WhaleCoverage {
  let graded = 0, pending = 0, ungraded = 0, legacy = 0;
  const reasons: Record<string, number> = {};
  for (const r of rows) {
    if (r.graded !== 1) { pending++; continue; }
    if (!isOnMarks(r)) { legacy++; continue; }
    const o = outcomeOf(r);
    if (o.result === "ungraded_no_mark" || r.pctReturn == null) {
      ungraded++;
      const k = String(o.reason ?? "unknown");
      reasons[k] = (reasons[k] ?? 0) + 1;
    } else graded++;
  }
  const resolved = graded + ungraded;
  return {
    total: graded + pending + ungraded,
    graded, pending,
    ungradedNoMark: ungraded,
    ungradedShare: resolved > 0 ? ungraded / resolved : null,
    ungradedReasons: reasons,
    legacyProxyExcluded: legacy,
  };
}

// ─── Walk-forward hold-out for threshold suggestions (round-2 item 7) ───────

/** In-sample bar (unchanged rule): lift >= max(5 pts, 2 SE of the difference). */
export function liftBar(hit: number, n: number, baseHit: number, baseN: number): number {
  const se = Math.sqrt((hit * (1 - hit)) / Math.max(1, n) + (baseHit * (1 - baseHit)) / Math.max(1, baseN));
  return Math.max(0.05, 2 * se);
}

/**
 * Pooled two-proportion z statistic (NIST 7.3.3). Null when undefined. With
 * `continuity`, the Yates correction shrinks |p1 - p2| by c = (1/n1 + 1/n2)/2
 * ("Z-Test Pooled with Continuity Correction",
 * https://pystatpower.readthedocs.io/zh-cn/latest/algorithms/proportion/independent/inequality/).
 * Without it the walk-forward test ran at ~2.0% per field against a 1.67%
 * target in seeded simulation; with it, 0.2-1.1% (validation-r2 tests).
 */
export function twoProportionZ(h1: number, n1: number, h2: number, n2: number, continuity = false): number | null {
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const p1 = h1 / n1, p2 = h2 / n2, p = (h1 + h2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return null;
  const diff = p1 - p2;
  if (!continuity) return diff / se;
  const adj = Math.max(0, Math.abs(diff) - 0.5 * (1 / n1 + 1 / n2));
  return (diff >= 0 ? adj : -adj) / se;
}

export interface WfRow {
  /** When the alert fired (time order). */
  t: number;
  /** When its outcome became known (expiry close / grading due time). */
  knownAt: number;
  hit: 0 | 1;
  value: number;
}

export const WF_MIN_ROWS = 40;          // fewer graded rows: no walk-forward, no suggestion
export const WF_TEST_FOLDS = 3;         // the later half of the window, three contiguous folds
export const WF_MIN_FILTERED = 10;      // rows a threshold must keep (same as the in-sample rule)
/**
 * One-sided z for the out-of-sample test, Bonferroni over the three swept
 * fields (premium, vol/OI, delta): alpha = 0.05 / 3 = 0.01667 -> z = 2.128.
 */
export const WF_Z_CRIT = 2.128;

/** Standard normal CDF, Abramowitz & Stegun 26.2.17 polynomial (absolute error < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Power of the one-sided pooled two-proportion z test to detect kept rate
 * p2 + delta against dropped rate p2 with n1 kept and n2 dropped rows:
 *   Phi((delta - z_a sqrt(pbar(1-pbar)(1/n1 + 1/n2))) / sqrt(p1(1-p1)/n1 + p2(1-p2)/n2)).
 */
export function twoProportionPower(n1: number, n2: number, p2: number, delta: number, zAlpha: number = WF_Z_CRIT): number | null {
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const p1 = Math.min(1, Math.max(0, p2 + delta));
  const pbar = (n1 * p1 + n2 * p2) / (n1 + n2);
  const se0 = Math.sqrt(pbar * (1 - pbar) * (1 / n1 + 1 / n2));
  const se1 = Math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2);
  if (!(se1 > 0)) return null;
  return normCdf((delta - zAlpha * se0) / se1);
}

/** Smallest lift (fraction) the test detects with the given power, by bisection; null if not reachable below 100%. */
export function minimumDetectableLift(n1: number, n2: number, p2: number, power = 0.8, zAlpha: number = WF_Z_CRIT): number | null {
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const hiMax = 1 - p2 - 1e-9;
  const pw = (d: number) => twoProportionPower(n1, n2, p2, d, zAlpha) ?? 0;
  if (!(hiMax > 0) || pw(hiMax) < power) return null;
  let lo = 0, hi = hiMax;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (pw(m) >= power) hi = m; else lo = m; }
  return hi;
}

/** Candidate cut-offs strictly tighter than the live gate (never re-suggest the gate or a looser one). */
export function sweepAboveGate(live: number, grid: number[]): number[] {
  return grid.filter((v) => Number.isFinite(v) && v > live + 1e-12).sort((a, b) => a - b);
}

/**
 * In-fold screen. "strict" = the in-sample bar (first value in sweep order
 * with lift >= max(5 pts, 2 SE)). "loose" = the value whose kept rows beat
 * its dropped rows by the largest in-fold two-proportion z (positive lift,
 * at least WF_MIN_FILTERED rows each side), with no significance bar: the
 * out-of-sample test, not the screen, controls false positives. Maximizing
 * z rather than raw lift avoids picking extreme cut-offs that keep a handful
 * of rows (seeded simulation in tests/quant/validation-r2.test.ts).
 */
export function selectThresholdInFold(rows: WfRow[], sweep: number[], screen: "strict" | "loose"): number | null {
  if (screen === "strict") return selectThresholdInSample(rows, sweep);
  if (rows.length === 0) return null;
  let best: number | null = null, bestZ = 0;
  for (const v of sweep) {
    let kN = 0, kH = 0, dN = 0, dH = 0;
    for (const r of rows) { if (r.value >= v) { kN++; kH += r.hit; } else { dN++; dH += r.hit; } }
    if (kN < WF_MIN_FILTERED || dN < WF_MIN_FILTERED) continue;
    const z = twoProportionZ(kH, kN, dH, dN);
    if (z != null && z > bestZ + 1e-12) { bestZ = z; best = v; }
  }
  return best;
}

/** First threshold in sweep order whose kept rows beat the whole set by liftBar (the existing in-sample rule). */
export function selectThresholdInSample(rows: WfRow[], sweep: number[]): number | null {
  if (rows.length === 0) return null;
  const base = rows.reduce((s, r) => s + r.hit, 0) / rows.length;
  for (const v of sweep) {
    const kept = rows.filter((r) => r.value >= v);
    if (kept.length < WF_MIN_FILTERED) continue;
    const hit = kept.reduce((s, r) => s + r.hit, 0) / kept.length;
    if (hit - base >= liftBar(hit, kept.length, base, rows.length)) return v;
  }
  return null;
}

export interface WalkForwardResult {
  status: "ok" | "insufficient_rows" | "no_selection";
  /** Threshold selected on the whole window (what would be suggested). */
  fullSampleValue: number | null;
  folds: Array<{ testFrom: number; testTo: number; trainN: number; purged: number; selected: number | null; keptN: number; keptHits: number; droppedN: number; droppedHits: number }>;
  oos: {
    keptN: number; keptHits: number; keptRate: number | null; keptWilsonLo: number | null; keptWilsonHi: number | null;
    droppedN: number; droppedHits: number; droppedRate: number | null;
    allRate: number | null;
    lift: number | null;          // keptRate - allRate on the test folds
    z: number | null;             // kept vs dropped, pooled two-proportion
  };
  /** True only when the out-of-sample kept rows beat the dropped rows at WF_Z_CRIT with enough rows on both sides. */
  supported: boolean;
  reason: string;
  screen: "strict" | "loose";
  /** What the out-of-sample test could detect at this sample size (80% power, one-sided, z >= WF_Z_CRIT). */
  power: {
    oosRows: number;
    keptN: number;
    droppedN: number;
    baseRate: number | null;
    /** minimum detectable lift of the kept hit rate over the dropped one, fraction; null = not detectable */
    mde80: number | null;
    /** power to detect a 10-point lift */
    powerAt10pts: number | null;
    basis: "observed out-of-sample split" | "expected split (half the window out of sample, half kept)";
  };
}

/**
 * Anchored walk-forward with purging. Rows sorted by fire time; the later
 * half is split into WF_TEST_FOLDS contiguous test folds. For each fold the
 * threshold is selected (selectThresholdInSample) on rows that fired before
 * the fold AND whose outcome was known before it started (purged otherwise),
 * then applied to the fold. Out-of-sample kept vs dropped rows are pooled
 * over folds and compared with a one-sided pooled two-proportion z test.
 */
export function walkForwardThreshold(rowsIn: WfRow[], sweep: number[], opts: { screen?: "strict" | "loose" } = {}): WalkForwardResult {
  const screen = opts.screen ?? "loose";
  const rows = rowsIn.filter((r) => Number.isFinite(r.t) && Number.isFinite(r.value)).sort((a, b) => a.t - b.t);
  const emptyOos = { keptN: 0, keptHits: 0, keptRate: null, keptWilsonLo: null, keptWilsonHi: null, droppedN: 0, droppedHits: 0, droppedRate: null, allRate: null, lift: null, z: null };
  const fullSampleValue = selectThresholdInFold(rows, sweep, screen);
  const allRate = rows.length ? rows.reduce((s, r) => s + r.hit, 0) / rows.length : null;
  const expectedPower = (): WalkForwardResult["power"] => {
    const oosRows = rows.length - Math.floor(rows.length / 2);
    const k = Math.floor(oosRows / 2), d = oosRows - k;
    return {
      oosRows, keptN: k, droppedN: d, baseRate: allRate,
      mde80: allRate != null ? minimumDetectableLift(k, d, allRate) : null,
      powerAt10pts: allRate != null ? twoProportionPower(k, d, allRate, 0.10) : null,
      basis: "expected split (half the window out of sample, half kept)",
    };
  };
  if (rows.length < WF_MIN_ROWS) {
    return { status: "insufficient_rows", fullSampleValue, folds: [], oos: emptyOos, supported: false, screen, power: expectedPower(), reason: `${rows.length} graded rows (< ${WF_MIN_ROWS}): no out-of-sample test` };
  }
  const firstTest = Math.floor(rows.length / 2);
  const foldSize = Math.ceil((rows.length - firstTest) / WF_TEST_FOLDS);
  const folds: WalkForwardResult["folds"] = [];
  let kN = 0, kH = 0, dN = 0, dH = 0;
  for (let f = 0; f < WF_TEST_FOLDS; f++) {
    const a = firstTest + f * foldSize;
    const b = Math.min(rows.length, a + foldSize);
    if (a >= b) break;
    const test = rows.slice(a, b);
    const testFrom = test[0].t;
    const before = rows.slice(0, a);
    const train = before.filter((r) => Number.isFinite(r.knownAt) && r.knownAt < testFrom);
    const selected = selectThresholdInFold(train, sweep, screen);
    let keptN = 0, keptHits = 0, droppedN = 0, droppedHits = 0;
    if (selected != null) {
      for (const r of test) {
        if (r.value >= selected) { keptN++; keptHits += r.hit; } else { droppedN++; droppedHits += r.hit; }
      }
    }
    kN += keptN; kH += keptHits; dN += droppedN; dH += droppedHits;
    folds.push({ testFrom, testTo: test[test.length - 1].t, trainN: train.length, purged: before.length - train.length, selected, keptN, keptHits, droppedN, droppedHits });
  }
  const allN = kN + dN;
  const w = wilsonInterval(kH, kN);
  const oos = {
    keptN: kN, keptHits: kH, keptRate: kN > 0 ? kH / kN : null,
    keptWilsonLo: kN > 0 ? w.lo : null, keptWilsonHi: kN > 0 ? w.hi : null,
    droppedN: dN, droppedHits: dH, droppedRate: dN > 0 ? dH / dN : null,
    allRate: allN > 0 ? (kH + dH) / allN : null,
    lift: kN > 0 && allN > 0 ? kH / kN - (kH + dH) / allN : null,
    z: twoProportionZ(kH, kN, dH, dN, true),
  };
  const power: WalkForwardResult["power"] = kN > 0 && dN > 0
    ? {
      oosRows: allN, keptN: kN, droppedN: dN, baseRate: oos.droppedRate,
      mde80: oos.droppedRate != null ? minimumDetectableLift(kN, dN, oos.droppedRate) : null,
      powerAt10pts: oos.droppedRate != null ? twoProportionPower(kN, dN, oos.droppedRate, 0.10) : null,
      basis: "observed out-of-sample split",
    }
    : expectedPower();
  if (folds.every((f) => f.selected == null)) {
    return { status: "no_selection", fullSampleValue, folds, oos, supported: false, screen, power, reason: "no threshold passed the in-fold screen in any training window" };
  }
  const enough = kN >= WF_MIN_FILTERED && dN >= WF_MIN_FILTERED;
  const supported = enough && oos.z != null && oos.z >= WF_Z_CRIT && fullSampleValue != null;
  const reason = !enough
    ? `out-of-sample kept ${kN} / dropped ${dN} rows (need ${WF_MIN_FILTERED} each)`
    : oos.z == null || oos.z < WF_Z_CRIT
      ? `out-of-sample z ${oos.z == null ? "n/a" : oos.z.toFixed(2)} < ${WF_Z_CRIT} (one-sided, Bonferroni over 3 fields)`
      : fullSampleValue == null
        ? "no threshold passes on the whole window"
        : `out-of-sample z ${oos.z.toFixed(2)} >= ${WF_Z_CRIT}`;
  return { status: "ok", fullSampleValue, folds, oos, supported, reason, screen, power };
}
