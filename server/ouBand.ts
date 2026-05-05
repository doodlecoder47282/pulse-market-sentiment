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

export type OUFit = {
  ok: boolean;
  mu: number;       // long-run mean (in price units, exp() of mean log price)
  theta: number;    // mean-reversion speed (per dt-unit)
  sigma: number;    // diffusion (per sqrt-dt-unit)
  halfLife: number; // in dt units
  bandLower: number;
  bandUpper: number;
  reason: string;
};

const ENABLE_FLOOR_THETA = 1e-6;

/**
 * Fit OU on the most recent N daily closes.
 * @param closes  array of daily closes, oldest → newest
 * @param k  band width multiplier (default 1.96 for ~95% band)
 */
export function fitOUBand(closes: number[], k: number = 1.96): OUFit {
  const n = closes?.length ?? 0;
  if (n < 30) {
    return {
      ok: false,
      mu: 0, theta: 0, sigma: 0, halfLife: 0,
      bandLower: 0, bandUpper: 0,
      reason: `need ≥30 closes, have ${n}`,
    };
  }
  const x = closes.filter((c) => isFinite(c) && c > 0).map(Math.log);
  if (x.length < 30) {
    return {
      ok: false, mu: 0, theta: 0, sigma: 0, halfLife: 0,
      bandLower: 0, bandUpper: 0,
      reason: "non-positive or non-finite closes",
    };
  }

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
    return {
      ok: false, mu: 0, theta: 0, sigma: 0, halfLife: 0,
      bandLower: 0, bandUpper: 0,
      reason: "degenerate variance",
    };
  }
  const b = (Sxy / N - meanX * meanY) / varX;
  const a = meanY - b * meanX;

  // Residual variance
  let SSR = 0;
  for (let i = 0; i < N; i++) {
    const pred = a + b * x[i];
    const r = x[i + 1] - pred;
    SSR += r * r;
  }
  const sigmaEps2 = SSR / Math.max(1, N - 2);

  // Convert AR(1) → OU (dt = 1 day)
  if (b <= 0 || b >= 1) {
    return {
      ok: false, mu: 0, theta: 0, sigma: 0, halfLife: 0,
      bandLower: 0, bandUpper: 0,
      reason: `non-stationary AR(1) (b=${b.toFixed(4)})`,
    };
  }
  const theta = -Math.log(b);
  if (theta < ENABLE_FLOOR_THETA) {
    return {
      ok: false, mu: 0, theta: 0, sigma: 0, halfLife: 0,
      bandLower: 0, bandUpper: 0,
      reason: "near-zero mean reversion (random walk)",
    };
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
    reason: `OU fit OK · halfLife=${halfLife.toFixed(1)}d`,
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
