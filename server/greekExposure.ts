// server/greekExposure.ts
//
// Per-contract dealer exposures in DOLLARS, one definition for every chain
// heatmap (Killbox, thermal heatmap, 0DTE forward, Heatseeker). Pure: no
// imports, so the tests load it on plain Node.
//
// Black-Scholes with r = q = 0 (carry is negligible for the short tenors these
// maps weight most; the same choice chainAudit.ts makes). T is calendar years
// on the one clock (timeToExpiry via chainClock), sigma must be valid for that
// T (chainClock.ivForClock). Per-share Greeks (Hull, "Options, Futures, and
// Other Derivatives", ch. 19; Haug, "The Complete Guide to Option Pricing
// Formulas", 2nd ed., sec. 2.3), derived from d1 = [ln(S/K) + sigma^2 T/2]/(sigma sqrt T):
//   delta (call)    N(d1)                (put: N(d1) - 1; same time/vol change)
//   gamma           phi(d1) / (S sigma sqrt T)
//   vanna           dDelta/dsigma = -phi(d1) d2 / sigma          (per 1.00 vol)
//   charm           dDelta/dt     = +phi(d1) d2 / (2 T)          (per year, t = calendar time)
//   vomma           dVega/dsigma  = vega d1 d2 / sigma, vega = S phi(d1) sqrt T
//   zomma           dGamma/dsigma = gamma (d1 d2 - 1) / sigma
//
// Dollar units (n = contracts, m = contract multiplier, 100 for SPX, SPXW,
// XSP, SPY, QQQ and single-name equity options; Cboe SPX contract specs:
// "$100 x the index"):
//   gexPerPct      $ change in delta notional per 1% spot move  = gamma n m S^2 0.01
//   vannaPerVolPt  $ change in delta notional per +1 vol point  = vanna 0.01 n m S
//   charmPerDay    $ change in delta notional over h = min(1 calendar day, T),
//                  spot and vol held: [Delta(T-h) - Delta(T)] n m S. For tenors
//                  well over a day this equals charm/365 x n m S to first order;
//                  inside a day it is the delta still left to lose before
//                  settlement (the instantaneous rate x 1 day would extrapolate
//                  past expiry; chainAudit.ts made the same change).
//   vommaPerVolPt  change in $ vega (per vol point) per +1 vol point = vomma 1e-4 n m
//   zommaPerVolPt  change in GEX ($ per 1% move) per +1 vol point  = zomma 0.01 n m S^2 0.01
// Signs are per LONG contract; the caller applies the dealer sign.

export const CONTRACT_MULTIPLIER = 100;
const ONE_DAY_YEARS = 1 / 365;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

const phi = (x: number) => Math.exp(-0.5 * x * x) / SQRT_2PI;

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 7.5e-8). */
function normCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/** Call delta N(d1) at r = q = 0; terminal value (1 / 0 / 0.5 at the strike) when T <= 0. */
export function callDelta0(S: number, K: number, sigma: number, T: number): number {
  if (!(T > 1e-12)) return S > K ? 1 : S < K ? 0 : 0.5;
  const v = sigma * Math.sqrt(T);
  return normCdf((Math.log(S / K) + 0.5 * v * v) / v);
}

export interface ContractExposureInput {
  spot: number;
  strike: number;
  sigma: number;          // decimal, valid for T
  T: number;              // calendar years to settlement (> 0)
  contracts: number;      // OI, volume, or a blend: the caller's weight
  /** Gamma per share to use for GEX (the caller's basis); default Black-Scholes r = q = 0. */
  gamma?: number;
  multiplier?: number;
}

export interface ContractExposure {
  gexPerPct: number;
  vannaPerVolPt: number;
  charmPerDay: number;
  vommaPerVolPt: number;
  zommaPerVolPt: number;
}

const ZERO: ContractExposure = { gexPerPct: 0, vannaPerVolPt: 0, charmPerDay: 0, vommaPerVolPt: 0, zommaPerVolPt: 0 };

/** Dollar exposures of `contracts` long options (see header for units). Zero when inputs are unusable. */
export function contractExposure(inp: ContractExposureInput): ContractExposure {
  const { spot: S, strike: K, sigma, T, contracts: n } = inp;
  const m = inp.multiplier != null && inp.multiplier > 0 ? inp.multiplier : CONTRACT_MULTIPLIER;
  if (!(S > 0) || !(K > 0) || !(sigma > 0) || !(T > 0) || !(n > 0)) return { ...ZERO };
  const sqrtT = Math.sqrt(T);
  const v = sigma * sqrtT;
  const d1 = (Math.log(S / K) + 0.5 * v * v) / v;
  const d2 = d1 - v;
  if (!Number.isFinite(d1) || !Number.isFinite(d2)) return { ...ZERO };
  const pd1 = phi(d1);
  const bsGamma = pd1 / (S * v);
  const gamma = inp.gamma != null && Number.isFinite(inp.gamma) ? inp.gamma : bsGamma;
  const vanna = -pd1 * d2 / sigma;
  const vega = S * pd1 * sqrtT;
  const vomma = vega * d1 * d2 / sigma;
  const zomma = bsGamma * (d1 * d2 - 1) / sigma;
  const h = Math.min(ONE_DAY_YEARS, T);
  const deltaChange = callDelta0(S, K, sigma, T - h) - callDelta0(S, K, sigma, T);
  return {
    gexPerPct: gamma * n * m * S * S * 0.01,
    vannaPerVolPt: vanna * 0.01 * n * m * S,
    charmPerDay: deltaChange * n * m * S,
    vommaPerVolPt: vomma * 1e-4 * n * m,
    zommaPerVolPt: zomma * 0.01 * n * m * S * S * 0.01,
  };
}

/**
 * 0DTE forward path tilt from charm (heuristic, dimensionless, clamped).
 *   netCharm    dealer-signed $ delta-notional change to settlement (sum of
 *               sign x charmPerDay; for a same-day expiry h = T).
 *   totalAbsGex sum of |dealer-signed GEX|, $ per 1% move.
 * A dealer whose hedged delta decays by X $ must BUY X $ of the underlying to
 * stay flat (so the flow is -netCharm). Dividing by $ GEX per 1% gives the
 * spot move, in %, whose gamma rebalancing would absorb that flow. The path
 * uses it, clamped to +-0.15, as a fraction of the 1-sigma cone. It is a
 * heuristic tilt, not a forecast.
 */
export function charmTiltNorm(netCharm: number, totalAbsGex: number, clamp = 0.15): number {
  if (!(totalAbsGex > 0) || !Number.isFinite(netCharm)) return 0;
  return Math.max(-clamp, Math.min(clamp, -netCharm / totalAbsGex));
}
