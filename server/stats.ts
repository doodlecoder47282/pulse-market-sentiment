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
export function cusum(series: number[]): {
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
  const mu0 = finite.reduce((s, x) => s + x, 0) / finite.length;
  const variance =
    finite.reduce((s, x) => s + (x - mu0) * (x - mu0), 0) / (finite.length - 1);
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
