// server/ouBand.ts
//
// Tier 3 experiment #2 — Ornstein-Uhlenbeck mean-reversion band, gated to
// low-vol regimes only. Pure observer. Emits {lower, upper, mu, halfLife}
// for the dashboard. The dashboard shows it as a soft band; any trade is
// the user's call.
//
// Model: dx_t = θ(μ - x_t) dt + σ dW_t
//
// We fit θ, μ, σ from a recent log-price series via OLS regression of the
// AR(1) form:
//     x_{t+1} = a + b·x_t + ε
// where:
//     b = exp(-θ·dt),  a = μ·(1 - b),  σ² = Var(ε)·(2θ)/(1 - exp(-2θ·dt))
//
// Half-life = ln(2) / θ (in dt units, so days for daily data).
//
// Confidence band: ±k·σ_eq where σ_eq = σ / sqrt(2θ) is the long-run sigma.
//
// The fit is reported only after a unit-root test rejects a random walk
// (see adfTest below), and b is bias-corrected before θ and the half-life.

import { olsFit } from "./stats";

// ─── Unit-root gate ──────────────────────────────────────────────────────
//
// An AR(1) fitted by OLS to log index prices almost always returns b < 1, so
// "b in (0,1)" says nothing: on pure random walks the old fit reported mean
// reversion ~95% of the time. The band is now shown only when an Augmented
// Dickey-Fuller test (Dickey & Fuller 1979; Said & Dickey 1984) rejects a
// unit root at 5%:
//
//   Δx_t = α + γ·x_{t-1} + Σ_{i=1..p} φ_i·Δx_{t-i} + ε_t,   τ = γ̂ / se(γ̂)
//
// Critical values: MacKinnon (2010) "Critical Values for Cointegration
// Tests", Queen's Economics Dept WP 1227, Table 2, N=1, constant/no trend:
//   cv(T) = β∞ + β1/T + β2/T² + β3/T³
// Lag order p: Schwarz/BIC over 0..pmax on a common sample,
// pmax = floor(12·(T/100)^{1/4}) (Schwert 1989).

export type AdfResult = {
  stat: number;            // τ statistic
  lags: number;            // chosen p
  nobs: number;            // observations in the final regression (T)
  crit: { "1%": number; "5%": number; "10%": number };
  rejectUnitRoot5: boolean;
};

// MacKinnon (2010) Table 2, τ_c, N=1: [β∞, β1, β2, β3]
const MACKINNON_TAU_C: Record<"1%" | "5%" | "10%", [number, number, number, number]> = {
  "1%": [-3.43035, -6.5393, -16.786, -79.433],
  "5%": [-2.86154, -2.8903, -4.234, -40.040],
  "10%": [-2.56677, -1.5384, -2.809, 0],
};

export function adfCriticalValue(level: "1%" | "5%" | "10%", T: number): number {
  const [b0, b1, b2, b3] = MACKINNON_TAU_C[level];
  return b0 + b1 / T + b2 / (T * T) + b3 / (T * T * T);
}

function adfRegression(x: number[], p: number, start: number): { stat: number; ssr: number; nobs: number; k: number } | null {
  // Rows t = start..n-1 (index into x), each using x[t-1] and Δx lags.
  const X: number[][] = [];
  const y: number[] = [];
  for (let t = start; t < x.length; t++) {
    const row = [1, x[t - 1]];
    for (let i = 1; i <= p; i++) row.push(x[t - i] - x[t - i - 1]);
    X.push(row);
    y.push(x[t] - x[t - 1]);
  }
  const f = olsFit(X, y);
  if (!f.ok || !(f.se[1] > 0)) return null;
  return { stat: f.coef[1] / f.se[1], ssr: f.ssr, nobs: f.n, k: f.k };
}

/** Augmented Dickey-Fuller test with a constant (no trend). `x` oldest → newest. */
export function adfTest(x: number[], maxLags?: number): AdfResult | null {
  const n = x.length;
  if (n < 20) return null;
  const Tn = n - 1;
  const pmax = Math.max(0, Math.min(
    maxLags ?? Math.floor(12 * Math.pow(Tn / 100, 0.25)),
    Math.floor((n - 10) / 3),
  ));
  // Common sample for lag selection: t starts at pmax + 1.
  let bestP = 0;
  let bestBic = Infinity;
  for (let p = 0; p <= pmax; p++) {
    const r = adfRegression(x, p, pmax + 1);
    if (!r) continue;
    const bic = r.nobs * Math.log(r.ssr / r.nobs) + r.k * Math.log(r.nobs);
    if (bic < bestBic) { bestBic = bic; bestP = p; }
  }
  // Re-estimate the chosen lag on the full available sample.
  const fin = adfRegression(x, bestP, bestP + 1);
  if (!fin) return null;
  const T = fin.nobs;
  const crit = {
    "1%": adfCriticalValue("1%", T),
    "5%": adfCriticalValue("5%", T),
    "10%": adfCriticalValue("10%", T),
  };
  return { stat: fin.stat, lags: bestP, nobs: T, crit, rejectUnitRoot5: fin.stat < crit["5%"] };
}

// Kendall (1954) / Marriott & Pope (1954): with an intercept, the OLS AR(1)
// coefficient is biased downward, E[b̂] ≈ b − (1 + 3b)/T. Inverting gives the
// first-order bias-corrected estimate b_c = (T·b̂ + 1)/(T − 3). Uncorrected,
// b̂ is too small, θ = −ln b too large and the half-life too short.
// (See also Yu 2012, J. Econometrics 169:114, which builds on this formula.)
export function ar1BiasCorrected(bHat: number, T: number): number {
  if (!(T > 3)) return bHat;
  return (T * bHat + 1) / (T - 3);
}

export type OUFit = {
  ok: boolean;
  mu: number;       // long-run mean (in price units, exp() of mean log price)
  theta: number;    // mean-reversion speed (per dt-unit)
  sigma: number;    // diffusion (per sqrt-dt-unit)
  halfLife: number; // in dt units
  bandLower: number;
  bandUpper: number;
  reason: string;
  // Added: unit-root gate. meanReverting=false means "not mean-reverting":
  // no half-life, no reversion target, no band.
  meanReverting: boolean;
  adf: AdfResult | null;
  bRaw: number | null;        // OLS AR(1) coefficient
  bCorrected: number | null;  // Kendall/Marriott-Pope corrected
};

const ENABLE_FLOOR_THETA = 1e-6;

function notFit(reason: string, extra: Partial<OUFit> = {}): OUFit {
  return {
    ok: false, mu: 0, theta: 0, sigma: 0, halfLife: 0,
    bandLower: 0, bandUpper: 0, reason,
    meanReverting: false, adf: null, bRaw: null, bCorrected: null,
    ...extra,
  };
}

/**
 * Fit OU on the most recent N daily closes.
 * @param closes  array of daily closes, oldest → newest
 * @param k  band width multiplier (default 1.96 for ~95% band)
 */
export function fitOUBand(closes: number[], k: number = 1.96): OUFit {
  const n = closes?.length ?? 0;
  if (n < 30) {
    return notFit(`need ≥30 closes, have ${n}`);
  }
  const x = closes.filter((c) => isFinite(c) && c > 0).map(Math.log);
  if (x.length < 30) {
    return notFit("non-positive or non-finite closes");
  }

  // Gate 1: unit-root test. Without a rejection the series is treated as a
  // random walk: no half-life, no reversion target.
  const adf = adfTest(x);
  if (!adf) return notFit("ADF test could not be computed");

  // OLS: x_{t+1} = a + b·x_t + ε
  const N = x.length - 1;
  let Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
  for (let i = 0; i < N; i++) {
    const xi = x[i];
    const yi = x[i + 1];
    Sx += xi; Sy += yi; Sxx += xi * xi; Sxy += xi * yi;
  }
  const meanX = Sx / N;
  const meanY = Sy / N;
  const varX = Sxx / N - meanX * meanX;
  if (varX <= 0) {
    return notFit("degenerate variance", { adf });
  }
  const bRaw = (Sxy / N - meanX * meanY) / varX;
  const bCorrected = ar1BiasCorrected(bRaw, N);

  if (!adf.rejectUnitRoot5) {
    return notFit(
      `not mean-reverting: ADF τ=${adf.stat.toFixed(2)} does not reject a unit root (5% cv ${adf.crit["5%"].toFixed(2)}, T=${adf.nobs}, lags=${adf.lags})`,
      { adf, bRaw, bCorrected },
    );
  }

  // Convert AR(1) → OU (dt = 1 day) using the bias-corrected coefficient.
  const b = bCorrected;
  if (b <= 0 || b >= 1) {
    return notFit(
      `not mean-reverting after bias correction (b̂=${bRaw.toFixed(4)}, b_c=${b.toFixed(4)})`,
      { adf, bRaw, bCorrected },
    );
  }
  const a = meanY - b * meanX;

  // Residual variance at the corrected coefficient
  let SSR = 0;
  for (let i = 0; i < N; i++) {
    const r = x[i + 1] - (a + b * x[i]);
    SSR += r * r;
  }
  const sigmaEps2 = SSR / Math.max(1, N - 2);

  const theta = -Math.log(b);
  if (theta < ENABLE_FLOOR_THETA) {
    return notFit("near-zero mean reversion (random walk)", { adf, bRaw, bCorrected });
  }
  const muLog = a / (1 - b);
  const sigma = Math.sqrt(sigmaEps2 * (2 * theta) / (1 - Math.exp(-2 * theta)));
  const sigmaEq = sigma / Math.sqrt(2 * theta);
  const halfLife = Math.log(2) / theta;

  // Band in price space
  const lowerLog = muLog - k * sigmaEq;
  const upperLog = muLog + k * sigmaEq;

  return {
    ok: true,
    mu: Math.exp(muLog),
    theta,
    sigma,
    halfLife,
    bandLower: Math.exp(lowerLog),
    bandUpper: Math.exp(upperLog),
    reason: `OU fit OK · ADF τ=${adf.stat.toFixed(2)} < ${adf.crit["5%"].toFixed(2)} (5%) · halfLife=${halfLife.toFixed(1)}d (bias-corrected)`,
    meanReverting: true,
    adf,
    bRaw,
    bCorrected,
  };
}

/**
 * Helper: should the OU band actually be displayed? Only in low-vol regimes
 * where mean reversion dominates. Caller passes realized 20d σ; we gate at
 * σ_20d ≤ 18% annualized (Tier 3 spec).
 */
export function shouldShowOUBand(realizedSigma20d: number): boolean {
  if (!isFinite(realizedSigma20d)) return false;
  return realizedSigma20d > 0 && realizedSigma20d <= 0.18;
}
