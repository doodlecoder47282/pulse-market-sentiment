// server/greeks.ts
//
// Black-Scholes with continuous dividend yield — full Greek suite + Newton-Raphson
// IV solver. Ported from EzOptions (https://github.com/EazyDuz1t/EzOptions) with
// TypeScript types and minor numerical-stability tweaks.
//
// Convention:
//   S = spot price
//   K = strike
//   σ = implied vol (decimal, 0.15 = 15%)
//   T = time to expiry in YEARS (trading years — use 262/yr for 0DTE consistency)
//   r = risk-free rate (decimal, 0.05 = 5%)
//   q = dividend yield (decimal, 0.013 = 1.3%)
//   type = "C" | "P"
//
// All Greeks returned in "per 1 contract, per 1 unit of the underlying driver"
// form. Exposure scaling (×100 contract multiplier, × OI, × S, × S² ×0.01, ÷365, etc.)
// happens in exposureProfile.ts — this file only does the math.

// ---------------------------------------------------------------------------
// Normal distribution helpers
// ---------------------------------------------------------------------------

/** Standard-normal PDF: φ(x) = (2π)^-½ · e^(-x²/2). */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard-normal CDF via Abramowitz & Stegun 7.1.26 approximation.
 * Max absolute error ~7.5e-8 — plenty good for option Greeks.
 */
export function normCdf(x: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

// ---------------------------------------------------------------------------
// d1 / d2 with numerical guards
// ---------------------------------------------------------------------------

export function d1(S: number, K: number, sigma: number, T: number, r: number, q: number): number {
  const sqrtT = Math.sqrt(T);
  return (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
}

export function d2(S: number, K: number, sigma: number, T: number, r: number, q: number): number {
  return d1(S, K, sigma, T, r, q) - sigma * Math.sqrt(T);
}

// ---------------------------------------------------------------------------
// Primary Greeks
// ---------------------------------------------------------------------------

export type OptionType = "C" | "P";

/** Δ = ∂V/∂S. Range [-1, +1]. */
export function delta(S: number, K: number, sigma: number, T: number, r: number, q: number, type: OptionType): number {
  if (!isValid(S, K, sigma, T)) return 0;
  const _d1 = d1(S, K, sigma, T, r, q);
  const e_qT = Math.exp(-q * T);
  return type === "C" ? e_qT * normCdf(_d1) : e_qT * (normCdf(_d1) - 1);
}

/** Γ = ∂²V/∂S² = ∂Δ/∂S. Same for calls and puts. */
export function gamma(S: number, K: number, sigma: number, T: number, r: number, q: number): number {
  if (!isValid(S, K, sigma, T)) return 0;
  const _d1 = d1(S, K, sigma, T, r, q);
  return Math.exp(-q * T) * normPdf(_d1) / (S * sigma * Math.sqrt(T));
}

/** Vega = ∂V/∂σ. Per 1.0 vol unit (multiply by 0.01 for "per 1% vol"). */
export function vega(S: number, K: number, sigma: number, T: number, r: number, q: number): number {
  if (!isValid(S, K, sigma, T)) return 0;
  const _d1 = d1(S, K, sigma, T, r, q);
  return S * Math.exp(-q * T) * normPdf(_d1) * Math.sqrt(T);
}

/** Θ = ∂V/∂t. Per-year; divide by 365 for per-calendar-day. */
export function theta(S: number, K: number, sigma: number, T: number, r: number, q: number, type: OptionType): number {
  if (!isValid(S, K, sigma, T)) return 0;
  const _d1 = d1(S, K, sigma, T, r, q);
  const _d2 = _d1 - sigma * Math.sqrt(T);
  const term1 = -(S * Math.exp(-q * T) * normPdf(_d1) * sigma) / (2 * Math.sqrt(T));
  if (type === "C") {
    return term1 - r * K * Math.exp(-r * T) * normCdf(_d2) + q * S * Math.exp(-q * T) * normCdf(_d1);
  }
  return term1 + r * K * Math.exp(-r * T) * normCdf(-_d2) - q * S * Math.exp(-q * T) * normCdf(-_d1);
}

// ---------------------------------------------------------------------------
// Second-order Greeks (for DEX/VEX/Charm/Speed/Vomma exposures)
// ---------------------------------------------------------------------------

/** Vanna = ∂Δ/∂σ = ∂Vega/∂S. Same for calls/puts. */
export function vanna(S: number, K: number, sigma: number, T: number, r: number, q: number): number {
  if (!isValid(S, K, sigma, T)) return 0;
  const _d1 = d1(S, K, sigma, T, r, q);
  const _d2 = _d1 - sigma * Math.sqrt(T);
  return -Math.exp(-q * T) * normPdf(_d1) * _d2 / sigma;
}

/** Charm = ∂Δ/∂t. Per-year; divide by 365 for per-calendar-day. */
export function charm(S: number, K: number, sigma: number, T: number, r: number, q: number, type: OptionType): number {
  if (!isValid(S, K, sigma, T)) return 0;
  const _d1 = d1(S, K, sigma, T, r, q);
  const _d2 = _d1 - sigma * Math.sqrt(T);
  const sqrtT = Math.sqrt(T);
  const e_qT = Math.exp(-q * T);
  const term = e_qT * normPdf(_d1) * (2 * (r - q) * T - _d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT);
  if (type === "C") return -term - q * e_qT * normCdf(_d1);
  return -term + q * e_qT * normCdf(-_d1);
}

/** Speed = ∂Γ/∂S. Third derivative. */
export function speed(S: number, K: number, sigma: number, T: number, r: number, q: number): number {
  if (!isValid(S, K, sigma, T)) return 0;
  const g = gamma(S, K, sigma, T, r, q);
  const _d1 = d1(S, K, sigma, T, r, q);
  return -(g / S) * (_d1 / (sigma * Math.sqrt(T)) + 1);
}

/** Vomma = ∂Vega/∂σ. */
export function vomma(S: number, K: number, sigma: number, T: number, r: number, q: number): number {
  if (!isValid(S, K, sigma, T)) return 0;
  const _d1 = d1(S, K, sigma, T, r, q);
  const _d2 = _d1 - sigma * Math.sqrt(T);
  const v = vega(S, K, sigma, T, r, q);
  return v * _d1 * _d2 / sigma;
}

// ---------------------------------------------------------------------------
// Bulk Greek computation (one row → all Greeks)
// ---------------------------------------------------------------------------

export interface GreekSet {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  vanna: number;
  charm: number;
  speed: number;
  vomma: number;
}

export function computeGreeks(
  S: number, K: number, sigma: number, T: number, r: number, q: number, type: OptionType,
): GreekSet {
  return {
    delta: delta(S, K, sigma, T, r, q, type),
    gamma: gamma(S, K, sigma, T, r, q),
    vega:  vega(S, K, sigma, T, r, q),
    theta: theta(S, K, sigma, T, r, q, type),
    vanna: vanna(S, K, sigma, T, r, q),
    charm: charm(S, K, sigma, T, r, q, type),
    speed: speed(S, K, sigma, T, r, q),
    vomma: vomma(S, K, sigma, T, r, q),
  };
}

// ---------------------------------------------------------------------------
// Black-Scholes price (for IV solver)
// ---------------------------------------------------------------------------

export function bsPrice(S: number, K: number, sigma: number, T: number, r: number, q: number, type: OptionType): number {
  if (!isValid(S, K, sigma, T)) return 0;
  const _d1 = d1(S, K, sigma, T, r, q);
  const _d2 = _d1 - sigma * Math.sqrt(T);
  const e_qT = Math.exp(-q * T);
  const e_rT = Math.exp(-r * T);
  if (type === "C") return S * e_qT * normCdf(_d1) - K * e_rT * normCdf(_d2);
  return K * e_rT * normCdf(-_d2) - S * e_qT * normCdf(-_d1);
}

// ---------------------------------------------------------------------------
// Implied vol — Newton-Raphson with bisection fallback
// ---------------------------------------------------------------------------

/**
 * Solve IV from an observed option price.
 *
 * Returns null if:
 *   - price is below intrinsic value (arbitrage-free bound violated)
 *   - Newton fails to converge AND bisection can't bracket
 *
 * @param price  Observed option mid (or last, or mark)
 * @param initialGuess  Starting σ (default 0.3 = 30%)
 * @param maxIter  Newton iterations (default 50)
 * @param tol  Price-space tolerance (default 1e-5)
 */
export function impliedVol(
  price: number, S: number, K: number, T: number, r: number, q: number, type: OptionType,
  initialGuess = 0.3, maxIter = 50, tol = 1e-5,
): number | null {
  if (price <= 0 || S <= 0 || K <= 0 || T <= 0) return null;

  // Intrinsic bound — a call must be ≥ max(0, S·e^-qT - K·e^-rT).
  const intrinsic = type === "C"
    ? Math.max(0, S * Math.exp(-q * T) - K * Math.exp(-r * T))
    : Math.max(0, K * Math.exp(-r * T) - S * Math.exp(-q * T));
  if (price < intrinsic - 1e-6) return null;

  // Newton-Raphson.
  let sigma = initialGuess;
  for (let i = 0; i < maxIter; i++) {
    const p = bsPrice(S, K, sigma, T, r, q, type);
    const diff = p - price;
    if (Math.abs(diff) < tol) return sigma;
    const v = vega(S, K, sigma, T, r, q);
    if (v < 1e-10) break; // vega too small → Newton blows up, fall back
    sigma = sigma - diff / v;
    if (sigma <= 0) sigma = 0.0001;
    if (sigma > 5) sigma = 5;
  }

  // Bisection fallback — slower but always converges.
  let lo = 0.001, hi = 5.0;
  let pLo = bsPrice(S, K, lo, T, r, q, type) - price;
  let pHi = bsPrice(S, K, hi, T, r, q, type) - price;
  if (pLo * pHi > 0) return null; // can't bracket
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const pMid = bsPrice(S, K, mid, T, r, q, type) - price;
    if (Math.abs(pMid) < tol) return mid;
    if (pLo * pMid < 0) { hi = mid; pHi = pMid; }
    else { lo = mid; pLo = pMid; }
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function isValid(S: number, K: number, sigma: number, T: number): boolean {
  return S > 0 && K > 0 && sigma > 0 && T > 0 && isFinite(S) && isFinite(K) && isFinite(sigma) && isFinite(T);
}
