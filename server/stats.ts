// server/stats.ts
//
// Pulse statistics toolkit. Pure-function utilities used by decision-support,
// calibration-card, and quote-shield modules. Zero dependencies on existing
// signal/regime/DFI math — these are READ-ONLY helpers that observe outputs.
//
// Sources weighed in /home/user/workspace/pulse-research/MASTER_SYNTHESIS.md:
//   - Mauboussin 2025 "Probabilities & Payoffs" (Kelly, vol drag, base rates)
//   - Statistics-by-Jim outliers (Tukey IQR, MAD)
//   - SPC / Cambridge SPC (CUSUM)
//   - 3Blue1Brown CLT, 3-Min Data Science PDF/CDF/PPF
//   - Very Normal Bayesian Beta-Binomial
//
// Every function here is side-effect free, pure, and safe to call from any
// path. If inputs are bad, functions return null/safe defaults — they never
// throw.

// ─── Kelly criterion ──────────────────────────────────────────────────────
//
// For an even-money binary bet with probability p of winning, the Kelly
// fraction is f = 2p - 1 (Mauboussin footnote 73). For asymmetric payoffs
// with edge E and odds b: f = E / b. We use the simple even-money form for
// the daily-card sizing tile because Pulse scenarios are framed as 0-1
// outcomes against close targets.
//
// Returns the FRACTIONAL Kelly we recommend showing the user (half-Kelly by
// default — practitioners commonly damp Kelly volatility, see Mauboussin
// p. 19).
export function kellyFraction(probWin: number, fraction: number = 0.5): number {
  if (probWin == null || !isFinite(probWin)) return 0;
  if (probWin <= 0.5) return 0; // no edge, no bet
  if (probWin >= 1.0) return fraction * 1.0; // capped at the fractional limit
  const fullKelly = 2 * probWin - 1;
  return Math.max(0, Math.min(1, fraction * fullKelly));
}

// ─── Volatility drag ──────────────────────────────────────────────────────
//
// Mauboussin p. 20: arithmetic - variance/2 ≈ geometric. Returns the drag
// in DECIMAL form (e.g. 0.015 = 1.5pp). Caller decides how to display.
export function volDrag(annualSigma: number): number {
  if (!isFinite(annualSigma) || annualSigma <= 0) return 0;
  return (annualSigma * annualSigma) / 2;
}

// ─── Standard normal pdf / cdf / ppf ──────────────────────────────────────
//
// Pure-JS implementations — no external dependency. Acklam's algorithm for
// the inverse-cdf has < 1e-9 error in the [0.02, 0.98] range we care about.
//
// pdf(z) = (1/√2π) e^(−z²/2)
export function pdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

// cdf(z) = Φ(z), implemented via Abramowitz & Stegun 26.2.17 (error < 7.5e-8)
export function cdf(z: number): number {
  if (!isFinite(z)) return z < 0 ? 0 : 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d =
    0.3989422804014337 * Math.exp(-0.5 * z * z); // φ(|z|)
  const p =
    d *
    t *
    (0.319381530 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// ppf(q) = Φ⁻¹(q) — Acklam's algorithm
export function ppf(q: number): number {
  if (q <= 0 || q >= 1 || !isFinite(q)) return NaN;
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let r;
  if (q < pLow) {
    const u = Math.sqrt(-2 * Math.log(q));
    return (
      (((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
      ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1)
    );
  }
  if (q <= pHigh) {
    const u = q - 0.5;
    r = u * u;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        u) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  {
    const u = Math.sqrt(-2 * Math.log(1 - q));
    return -(
      (((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
      ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1)
    );
  }
}

// Convenience: percentile of a Normal(μ, σ) distribution
export function normPpf(q: number, mu: number, sigma: number): number {
  return mu + sigma * ppf(q);
}

// ─── Beta-Binomial credible interval ──────────────────────────────────────
//
// Conjugate-prior posterior for a binomial hit rate after k wins in n trials,
// with prior Beta(α₀, β₀). Default prior is Beta(1, 1) = uniform.
// Returns {mean, lower95, upper95} where the bounds are the 2.5/97.5 quantiles
// of Beta(α₀+k, β₀+n−k).
//
// We approximate Beta quantiles via the Wilson score interval for n ≥ 30 and
// a Beta-CDF Newton iteration for smaller n. Wilson is the same form Pfizer
// used to report vaccine-trial confidence (see Very Normal video).
export function betaBinomialCI(
  k: number,
  n: number,
  alpha0: number = 1,
  beta0: number = 1,
): { mean: number; lower95: number; upper95: number; n: number } {
  if (n <= 0) {
    return { mean: 0, lower95: 0, upper95: 1, n };
  }
  const a = alpha0 + k;
  const b = beta0 + (n - k);
  const mean = a / (a + b);
  // Wilson interval — robust for moderate n, no Beta function needed.
  // For prior + data this is a good enough approximation; the prior already
  // smooths small-n cases.
  const z = 1.96;
  const total = a + b;
  const p = mean;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const half =
    (z / denom) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    mean,
    lower95: Math.max(0, center - half),
    upper95: Math.min(1, center + half),
    n,
  };
}

// ─── Outlier detection (Statistics-by-Jim) ────────────────────────────────
//
// Tukey IQR fence. Returns true if `x` is OUTSIDE [Q1 - k·IQR, Q3 + k·IQR].
// k=1.5 is the standard Tukey choice. This is the FENCE — milder values use
// k=3.0 for "extreme" outliers only.
export function iqrFence(
  x: number,
  sample: number[],
  k: number = 1.5,
): { suspect: boolean; q1: number; q3: number; iqr: number } {
  if (sample.length < 4 || !isFinite(x)) {
    return { suspect: false, q1: NaN, q3: NaN, iqr: NaN };
  }
  const sorted = [...sample].filter(Number.isFinite).sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - k * iqr;
  const hi = q3 + k * iqr;
  return { suspect: x < lo || x > hi, q1, q3, iqr };
}

// MAD (Median Absolute Deviation) fence — more robust than IQR to heavy tails.
// Flags as suspect when |x − median| / (1.4826 · MAD) exceeds threshold (≈z-score).
export function madFlag(
  x: number,
  sample: number[],
  zThreshold: number = 3.0,
): { suspect: boolean; median: number; mad: number; modZ: number } {
  if (sample.length < 4 || !isFinite(x)) {
    return { suspect: false, median: NaN, mad: NaN, modZ: NaN };
  }
  const finite = sample.filter(Number.isFinite);
  const sorted = [...finite].sort((a, b) => a - b);
  const med = quantile(sorted, 0.5);
  const absDev = finite.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = quantile(absDev, 0.5);
  if (mad === 0) return { suspect: false, median: med, mad: 0, modZ: 0 };
  const modZ = Math.abs(x - med) / (1.4826 * mad);
  return { suspect: modZ > zThreshold, median: med, mad, modZ };
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (pos - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

// ─── CUSUM (cumulative sum) ───────────────────────────────────────────────
//
// One-sided upper-CUSUM for detecting persistent positive drift in a series of
// errors. C_t = max(0, C_{t-1} + (x_t − μ₀ − k)).
// Health badge:
//   HEALTHY   — C_t ≤ h_warn
//   DRIFTING  — h_warn < C_t ≤ h_alarm
//   BROKEN    — C_t > h_alarm
// Defaults: μ₀ = mean of `series`, k = 0.5σ, h_warn = 4σ, h_alarm = 5σ.
// k = 0.5σ, h = 5σ is the textbook tabular CUSUM (Montgomery, Introduction to
// Statistical Quality Control, 7th ed.): in-control ARL ≈ 465, ARL ≈ 10 for a
// 1σ shift. Pass `opts.target` to anchor μ₀ to a fixed reference instead of the
// series' own mean: a series' own mean can never drift from itself, so a
// model-skill watchdog must anchor to the no-skill level (target 0).
// The series must be ordered OLDEST → NEWEST.
export function cusum(series: number[], opts: { target?: number } = {}): {
  c: number;
  status: "HEALTHY" | "DRIFTING" | "BROKEN";
  baseline: number;
  k: number;
  h_warn: number;
  h_alarm: number;
} {
  const finite = series.filter(Number.isFinite);
  if (finite.length < 5) {
    return {
      c: 0,
      status: "HEALTHY",
      baseline: 0,
      k: 0,
      h_warn: 0,
      h_alarm: 0,
    };
  }
  const mean = finite.reduce((s, x) => s + x, 0) / finite.length;
  const mu0 = opts.target != null && Number.isFinite(opts.target) ? opts.target : mean;
  // σ is the series' dispersion around its own mean (not around the target),
  // so a large persistent offset from the target does not inflate σ and mask itself.
  const variance =
    finite.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (finite.length - 1);
  const sigma = Math.sqrt(Math.max(variance, 1e-12));
  const k = 0.5 * sigma;
  const h_warn = 4 * sigma;
  const h_alarm = 5 * sigma;
  let c = 0;
  for (const x of finite) {
    c = Math.max(0, c + (x - mu0 - k));
  }
  const status: "HEALTHY" | "DRIFTING" | "BROKEN" =
    c > h_alarm ? "BROKEN" : c > h_warn ? "DRIFTING" : "HEALTHY";
  return { c, status, baseline: mu0, k, h_warn, h_alarm };
}

// ─── Resolution score (Mauboussin footnote 45) ────────────────────────────
//
// Resolution = variance of forecast probabilities across days. A model that
// always says "55% bull" has resolution ≈ 0 (perfect calibration possible,
// zero discriminative value). High variance + good calibration = real edge.
//
// Returns the variance of `forecasts`. Caller should compare against
// resolution baselines: <0.01 → flat, 0.01–0.04 → mild discrim, ≥0.04 → real.
export function resolutionScore(forecasts: number[]): number {
  const finite = forecasts.filter(Number.isFinite);
  if (finite.length < 2) return 0;
  const mean = finite.reduce((s, x) => s + x, 0) / finite.length;
  return finite.reduce((s, x) => s + (x - mean) * (x - mean), 0) / finite.length;
}

// Resolution grade — qualitative label for the calibration card
export function gradeResolution(r: number): { letter: string; label: string } {
  if (r < 0.005) return { letter: "F", label: "flat" };
  if (r < 0.015) return { letter: "D", label: "weak discrim" };
  if (r < 0.04) return { letter: "C", label: "fair discrim" };
  if (r < 0.08) return { letter: "B", label: "good discrim" };
  return { letter: "A", label: "strong discrim" };
}

// ─── Base rates (Mauboussin p. 24) ────────────────────────────────────────
//
// Hardcoded historical SPX base rates for "any positive return" by horizon.
// These are anchor numbers for the decision-support strip — they fight
// recency bias by reminding the user what's normal.
export const SPX_BASE_RATES_UP = {
  daily: 0.55,
  weekly: 0.59,
  monthly: 0.63,
  yearly: 0.73,
};

// ─── Ordinary least squares ───────────────────────────────────────────────
//
// y = X·β + ε. `X` rows are observations; include a column of 1s for an
// intercept. Solved via the normal equations with partial-pivot Gauss-Jordan
// inversion of X'X (k is small everywhere this is used: ≤ ~15 regressors).
// Standard errors are classical: se(β_j) = sqrt(s² · [(X'X)^{-1}]_jj) with
// s² = SSR / (n − k). Returns ok=false when X'X is singular or n ≤ k.
export function olsFit(X: number[][], y: number[]): {
  ok: boolean;
  coef: number[];
  se: number[];
  t: number[];
  n: number;
  k: number;
  ssr: number;
  sigma2: number;
  r2: number;
} {
  const n = Math.min(X.length, y.length);
  const k = n > 0 ? X[0].length : 0;
  const fail = { ok: false, coef: [], se: [], t: [], n, k, ssr: NaN, sigma2: NaN, r2: NaN };
  if (n === 0 || k === 0 || n <= k) return fail;
  // X'X and X'y
  const xtx: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty: number[] = new Array(k).fill(0);
  for (let r = 0; r < n; r++) {
    const row = X[r];
    const yr = y[r];
    if (!Number.isFinite(yr) || row.length !== k || row.some((v) => !Number.isFinite(v))) return fail;
    for (let i = 0; i < k; i++) {
      xty[i] += row[i] * yr;
      for (let j = i; j < k; j++) xtx[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) xtx[i][j] = xtx[j][i];
  // Invert X'X (Gauss-Jordan, partial pivoting)
  const a = xtx.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  let scale = 0;
  for (let i = 0; i < k; i++) scale = Math.max(scale, Math.abs(xtx[i][i]));
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) <= 1e-12 * Math.max(1, scale)) return fail;
    if (piv !== col) { const tmp = a[piv]; a[piv] = a[col]; a[col] = tmp; }
    const d = a[col][col];
    for (let j = 0; j < 2 * k; j++) a[col][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * k; j++) a[r][j] -= f * a[col][j];
    }
  }
  const inv = a.map((row) => row.slice(k));
  const coef = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  let ssr = 0;
  let ySum = 0;
  for (let r = 0; r < n; r++) ySum += y[r];
  const yMean = ySum / n;
  let sst = 0;
  for (let r = 0; r < n; r++) {
    let fit = 0;
    for (let j = 0; j < k; j++) fit += X[r][j] * coef[j];
    ssr += (y[r] - fit) ** 2;
    sst += (y[r] - yMean) ** 2;
  }
  const sigma2 = ssr / (n - k);
  const se = inv.map((row, j) => Math.sqrt(Math.max(0, sigma2 * row[j])));
  const t = coef.map((b, j) => (se[j] > 0 ? b / se[j] : NaN));
  const r2 = sst > 0 ? 1 - ssr / sst : NaN;
  return { ok: true, coef, se, t, n, k, ssr, sigma2, r2 };
}

// ─── Climatology baseline (the ONE trivial forecaster) ────────────────────
//
// Every place Batcave compares a probability model with a "trivial
// forecaster" uses this helper: the climatological (base-rate) forecaster
// that always predicts the realized class frequencies of the logged outcomes.
// It is the standard reference forecast for the Brier skill score
// (BSS = 1 − BS / BS_climatology; Wilks, Statistical Methods in the
// Atmospheric Sciences, ch. "Forecast verification"). Uniform 1/K is a
// straw man that any forecaster leaning on the most common class beats.
//
// `outcomes` rows are one-hot vectors over K mutually exclusive classes
// (multinomial), or a single 0/1 column for a binary event. Frequencies are
// the in-window sample frequencies; that is the hardest constant forecast to
// beat (it is the Brier-optimal constant in-sample), so it errs toward
// flagging a model, which is the safe direction for a watchdog.
export function climatologyBaseline(outcomes: number[][]): {
  n: number;
  freqs: number[];       // base rate per class
  perClass: number[];    // mean squared error per class of the climatology forecast
  total: number;         // multinomial Brier of the climatology forecast (sum over classes)
  perRow: number[];      // per-observation climatology Brier (sum over classes)
} {
  const rows = outcomes.filter((r) => Array.isArray(r) && r.length > 0 && r.every(Number.isFinite));
  const n = rows.length;
  if (n === 0) return { n: 0, freqs: [], perClass: [], total: NaN, perRow: [] };
  const K = rows[0].length;
  const freqs = new Array(K).fill(0);
  for (const r of rows) for (let j = 0; j < K; j++) freqs[j] += r[j] ?? 0;
  for (let j = 0; j < K; j++) freqs[j] /= n;
  const perClass = new Array(K).fill(0);
  const perRow: number[] = [];
  for (const r of rows) {
    let s = 0;
    for (let j = 0; j < K; j++) {
      const e = (freqs[j] - (r[j] ?? 0)) ** 2;
      perClass[j] += e;
      s += e;
    }
    perRow.push(s);
  }
  for (let j = 0; j < K; j++) perClass[j] /= n;
  const total = perClass.reduce((s, v) => s + v, 0);
  return { n, freqs, perClass, total, perRow };
}

// Brier skill score vs climatology: 1 − BS_model / BS_clim. > 0 = skill,
// 0 = no better than the base rate, < 0 = worse than the base rate.
export function brierSkillScore(modelBrier: number, climatologyBrier: number): number | null {
  if (!Number.isFinite(modelBrier) || !Number.isFinite(climatologyBrier) || climatologyBrier <= 0) return null;
  return 1 - modelBrier / climatologyBrier;
}

// ─── Skill watchdog (CUSUM anchored to zero skill) ────────────────────────
//
// d_t = BS_model,t − BS_clim,t, ordered oldest → newest. Mean d > 0 means the
// model is worse than the base-rate forecaster. The CUSUM target is 0 (no
// skill), so a model that is consistently worse than climatology accumulates
// and trips, instead of reading HEALTHY against its own mean. A model whose
// window mean is ≥ 0 is never HEALTHY: it has shown no skill.
export type SkillWatchdogStatus = "HEALTHY" | "DRIFTING" | "BROKEN";
export function skillWatchdog(
  rowsOldestFirst: Array<{ modelBrier: number; outcome: number[] }>,
): {
  status: SkillWatchdogStatus;
  n: number;
  meanDiff: number;           // mean(BS_model − BS_clim); < 0 = skill
  tStat: number | null;       // meanDiff / (sd / √n)
  bss: number | null;         // window Brier skill score vs climatology
  modelBrier: number;
  climatologyBrier: number;
  climatologyFreqs: number[];
  cusum: ReturnType<typeof cusum>;
  reason: string;
} {
  const rows = rowsOldestFirst.filter((r) => Number.isFinite(r.modelBrier) && Array.isArray(r.outcome));
  const clim = climatologyBaseline(rows.map((r) => r.outcome));
  const d = rows.map((r, i) => r.modelBrier - clim.perRow[i]);
  const n = d.length;
  const modelBrier = n ? rows.reduce((s, r) => s + r.modelBrier, 0) / n : NaN;
  const meanDiff = n ? d.reduce((s, v) => s + v, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(d.reduce((s, v) => s + (v - meanDiff) ** 2, 0) / (n - 1)) : NaN;
  const tStat = n > 1 && sd > 1e-12 ? meanDiff / (sd / Math.sqrt(n)) : null;
  const cs = cusum(d, { target: 0 });
  const bss = brierSkillScore(modelBrier, clim.total);
  let status: SkillWatchdogStatus;
  let reason: string;
  if (cs.status === "BROKEN") {
    status = "BROKEN";
    reason = "CUSUM vs zero skill crossed 5σ: model is persistently worse than the base-rate forecaster";
  } else if (meanDiff > 0 && tStat != null && tStat >= 2) {
    status = "BROKEN";
    reason = `model Brier is worse than climatology over the window (t=${tStat.toFixed(1)})`;
  } else if (cs.status === "DRIFTING") {
    status = "DRIFTING";
    reason = "CUSUM vs zero skill crossed 4σ: losing to the base-rate forecaster, watch closely";
  } else if (!(meanDiff < 0)) {
    status = "DRIFTING";
    reason = "no skill: model is not beating the base-rate (climatology) forecaster";
  } else {
    status = "HEALTHY";
    reason = "model beats the base-rate forecaster over the window and the CUSUM is quiet";
  }
  return {
    status, n, meanDiff, tStat, bss, modelBrier,
    climatologyBrier: clim.total, climatologyFreqs: clim.freqs, cusum: cs, reason,
  };
}

// ─── Wilson score interval ────────────────────────────────────────────────
//
// Wilson (1927) score interval for a binomial proportion k/n; recommended
// over the Wald interval by Brown, Cai & DasGupta (2001, Statistical Science).
export function wilsonInterval(k: number, n: number, z: number = 1.96): { lo: number; hi: number; p: number } {
  if (!(n > 0)) return { lo: 0, hi: 1, p: NaN };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), p };
}

// ─── Reliability curve + calibration test ────────────────────────────────
//
// Bins forecasts into equal-width probability bins and reports, per bin, the
// mean forecast, the observed frequency, the count and the Wilson 95% interval
// (Murphy & Winkler 1977 reliability diagram). "calibrated" is returned ONLY
// when the stated test passes:
//   1. n ≥ minTotal graded forecasts (default 100), and
//   2. Spiegelhalter (1986, Stat Med 5:421) Z test does not reject
//      calibration at alpha (two-sided). Z = Σ(o−p)(1−2p) / √Σ(1−2p)²p(1−p)
//      is the Brier score standardised by its mean and variance under
//      perfect calibration, and
//   3. every bin with ≥ minBinN forecasts has its mean forecast inside its
//      Wilson interval at the Bonferroni level alpha/m (m = bins tested).
// Brier mixes calibration with sharpness, so a low Brier alone is never
// called "calibrated".
export type ReliabilityBin = {
  lo: number;
  hi: number;
  n: number;
  meanPred: number | null;
  observed: number | null;
  wilsonLo: number | null;
  wilsonHi: number | null;
  tested: boolean;
  inInterval: boolean | null;
};
export type ReliabilityReport = {
  n: number;
  bins: ReliabilityBin[];
  brier: number | null;
  climatologyBrier: number | null;
  bss: number | null;
  spiegelhalterZ: number | null;
  spiegelhalterP: number | null;
  verdict: "calibrated" | "not calibrated" | "insufficient data";
  test: {
    name: string;
    alpha: number;
    minTotal: number;
    minBinN: number;
    passed: boolean;
    reasons: string[];
  };
};
export function reliabilityCurve(
  preds: number[],
  outcomes: number[],
  opts: { bins?: number; minTotal?: number; minBinN?: number; alpha?: number } = {},
): ReliabilityReport {
  const nb = Math.max(2, Math.floor(opts.bins ?? 10));
  const minTotal = opts.minTotal ?? 100;
  const minBinN = opts.minBinN ?? 10;
  const alpha = opts.alpha ?? 0.05;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(preds.length, outcomes.length); i++) {
    const p = preds[i];
    const o = outcomes[i];
    if (!Number.isFinite(p) || !(o === 0 || o === 1)) continue;
    pairs.push([Math.max(0, Math.min(1, p)), o]);
  }
  const n = pairs.length;
  const acc = Array.from({ length: nb }, () => ({ n: 0, sp: 0, so: 0 }));
  let brierSum = 0, zNum = 0, zVar = 0;
  for (const [p, o] of pairs) {
    const b = Math.min(nb - 1, Math.floor(p * nb));
    acc[b].n++; acc[b].sp += p; acc[b].so += o;
    brierSum += (p - o) ** 2;
    zNum += (o - p) * (1 - 2 * p);
    zVar += (1 - 2 * p) ** 2 * p * (1 - p);
  }
  const tested = acc.filter((a) => a.n >= minBinN).length;
  const zBin = ppf(1 - alpha / (2 * Math.max(1, tested)));
  const bins: ReliabilityBin[] = acc.map((a, i) => {
    if (a.n === 0) {
      return { lo: i / nb, hi: (i + 1) / nb, n: 0, meanPred: null, observed: null, wilsonLo: null, wilsonHi: null, tested: false, inInterval: null };
    }
    const meanPred = a.sp / a.n;
    const w95 = wilsonInterval(a.so, a.n, 1.96);
    const isTested = a.n >= minBinN;
    const wT = wilsonInterval(a.so, a.n, zBin);
    return {
      lo: i / nb, hi: (i + 1) / nb, n: a.n, meanPred, observed: a.so / a.n,
      wilsonLo: w95.lo, wilsonHi: w95.hi, tested: isTested,
      inInterval: isTested ? meanPred >= wT.lo && meanPred <= wT.hi : null,
    };
  });
  const brier = n ? brierSum / n : null;
  const clim = climatologyBaseline(pairs.map(([, o]) => [o]));
  const climatologyBrier = n ? clim.total : null;
  const bss = brier != null && climatologyBrier != null ? brierSkillScore(brier, climatologyBrier) : null;
  const spiegelhalterZ = zVar > 0 ? zNum / Math.sqrt(zVar) : null;
  const spiegelhalterP = spiegelhalterZ != null ? 2 * (1 - cdf(Math.abs(spiegelhalterZ))) : null;
  const reasons: string[] = [];
  if (n < minTotal) reasons.push(`need ≥${minTotal} graded forecasts, have ${n}`);
  if (spiegelhalterP == null) reasons.push("Spiegelhalter Z undefined (all forecasts at 0, 0.5 or 1)");
  else if (spiegelhalterP < alpha) reasons.push(`Spiegelhalter Z=${spiegelhalterZ!.toFixed(2)} rejects calibration (p=${spiegelhalterP.toFixed(3)})`);
  const missed = bins.filter((b) => b.inInterval === false);
  if (missed.length) reasons.push(`${missed.length} bin(s) outside Bonferroni Wilson interval`);
  if (tested === 0) reasons.push(`no bin has ≥${minBinN} forecasts`);
  const passed = reasons.length === 0;
  const verdict: ReliabilityReport["verdict"] =
    n < minTotal ? "insufficient data" : passed ? "calibrated" : "not calibrated";
  return {
    n, bins, brier, climatologyBrier, bss, spiegelhalterZ, spiegelhalterP, verdict,
    test: {
      name: `n≥${minTotal}, Spiegelhalter Z (two-sided alpha ${alpha}), every bin with n≥${minBinN} inside its Bonferroni Wilson interval`,
      alpha, minTotal, minBinN, passed, reasons,
    },
  };
}
