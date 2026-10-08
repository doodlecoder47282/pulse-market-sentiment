// server/breedenLitzenberger.ts
//
// Risk-neutral (implied) distribution of S_T from one expiry of an option
// chain. Pure math, no I/O.
//
// Breeden & Litzenberger (1978), "Prices of State-Contingent Claims Implicit
// in Option Prices", J. Business 51(4): for European calls C(K),
//     d^2C/dK^2 = e^(-rT) f(K),
// where f is the risk-neutral density of S_T.
//
// Differentiating raw quote mids twice amplifies quote noise: with +/-$0.25
// noise on a 5-point SPX grid the review measured P(S_T > S*1.01) = 0.199
// against a true 0.149. Desks therefore smooth implied volatility across
// strikes first and differentiate the smooth curve. This module:
//
//   1. builds the forward F from put-call parity (C - P = D (F - K)) when puts
//      are supplied, else F = S e^((r-q)T);
//   2. uses out-of-the-money quotes (puts below F, calls above), the liquid
//      side and the one desks build each wing from;
//   3. fits Gatheral's raw SVI total-variance smile
//        w(k) = a + b ( rho (k - m) + sqrt((k - m)^2 + sigma^2) ),  k = ln(K/F)
//      (Gatheral & Jacquier 2014, "Arbitrage-free SVI volatility surfaces",
//      Quantitative Finance 14(1), arXiv:1204.0646), initialised with the
//      quasi-explicit (a, d, c) least squares of Zeliade (2009) and polished
//      by least squares in PRICE space (quote noise is in dollars, not vol);
//   4. evaluates the density in closed form,
//        p(k) = g(k) / sqrt(2 pi w(k)) * exp(-d_-(k)^2 / 2),
//        g(k) = (1 - k w'/(2w))^2 - (w'^2/4)(1/w + 1/4) + w''/2,
//        d_-(k) = -k/sqrt(w) - sqrt(w)/2,
//      which is exactly d^2C/dK^2 of the SVI-priced calls (BL) expressed in
//      log-strike; f(K) = p(k)/K. Any negative density (butterfly arbitrage
//      in the fit, g < 0) is clipped and reported, and the density is
//      normalised to integrate to 1.
//
// Probabilities from this module are RISK-NEUTRAL (Q), not real-world
// forecasts: they embed the variance and skew risk premia. Label them so.

import { normCdf, normPdf } from "./greeks";

export type CallStrike = {
  strike: number;
  callMid: number;          // (bid + ask) / 2 OR last, per share
  putMid?: number | null;   // optional: same-strike put mid, per share
};

export type BLDensityPoint = {
  strike: number;
  density: number; // risk-neutral density of S_T per $1 of strike (non-negative)
};

export type BLProbabilities = {
  pUpOnePct: number;   // P(S_T > spot * 1.01)
  pUp: number;         // P(S_T > spot)
  pDownOnePct: number; // P(S_T < spot * 0.99)
  pInOneEM: number;    // P(spot - EM <= S_T <= spot + EM)
};

export interface SviParams { a: number; b: number; rho: number; m: number; sigma: number }

/** One option quote at a single expiry (per-share prices, discounted as quoted). */
export interface OptionQuote {
  strike: number;
  callMid?: number | null;
  putMid?: number | null;
}

export interface ImpliedDistribution {
  method: "svi-smoothed";
  measure: "risk-neutral";
  forward: number;
  forwardSource: "put-call-parity" | "spot-carry";
  discount: number;              // e^(-rT)
  svi: SviParams;
  atmTotalVol: number;           // sqrt(w(0)) = sigma_ATM * sqrt(T)
  fitRmse: number;               // $ per share, OTM price residual RMSE
  quotesUsed: number;
  quotedRange: [number, number]; // lowest / highest strike used in the fit
  coverage: number;              // probability mass inside quotedRange
  negativeMassClipped: number;   // |negative density| removed before normalising
  rawMass: number;               // integral of the clipped density before normalising
  // Fine log-strike grid: strikes, density per $1, CDF P(S_T <= K).
  grid: { strike: number[]; density: number[]; cdf: number[] };
}

// ─── SVI ────────────────────────────────────────────────────────────────────

export function sviW(p: SviParams, k: number): number {
  const x = k - p.m;
  return p.a + p.b * (p.rho * x + Math.sqrt(x * x + p.sigma * p.sigma));
}
function sviW1(p: SviParams, k: number): number {
  const x = k - p.m;
  return p.b * (p.rho + x / Math.sqrt(x * x + p.sigma * p.sigma));
}
function sviW2(p: SviParams, k: number): number {
  const x = k - p.m;
  const s2 = p.sigma * p.sigma;
  return p.b * s2 / Math.pow(x * x + s2, 1.5);
}

/** Gatheral-Jacquier density of k = ln(S_T/F) for an SVI slice (may be < 0 if g < 0). */
export function sviLogDensity(p: SviParams, k: number): number {
  const w = sviW(p, k);
  if (!(w > 0)) return 0;
  const w1 = sviW1(p, k);
  const w2 = sviW2(p, k);
  const g = (1 - (k * w1) / (2 * w)) ** 2 - (w1 * w1 / 4) * (1 / w + 0.25) + w2 / 2;
  const sw = Math.sqrt(w);
  const dm = -k / sw - sw / 2;
  return (g / Math.sqrt(2 * Math.PI * w)) * Math.exp(-0.5 * dm * dm);
}

/**
 * Closed-form digital: P(S_T > K) = N(d_-) - phi(d_-) w'(k) / (2 sqrt(w)),
 * i.e. -dC/dK / D with the smile's own slope (exact for the fitted slice).
 */
export function sviProbAbove(p: SviParams, F: number, K: number): number {
  const k = Math.log(K / F);
  const w = sviW(p, k);
  if (!(w > 0)) return K < F ? 1 : 0;
  const sw = Math.sqrt(w);
  const dm = -k / sw - sw / 2;
  return normCdf(dm) - (normPdf(dm) * sviW1(p, k)) / (2 * sw);
}

// ─── Black-76 on undiscounted prices ────────────────────────────────────────

/** Undiscounted Black-76 price per share; w = total implied variance sigma^2 T. */
export function black76(F: number, K: number, w: number, type: "C" | "P"): number {
  if (!(w > 0)) return Math.max(0, type === "C" ? F - K : K - F);
  const sw = Math.sqrt(w);
  const d1 = (Math.log(F / K) + w / 2) / sw;
  const d2 = d1 - sw;
  const call = F * normCdf(d1) - K * normCdf(d2);
  return type === "C" ? call : call - (F - K);
}

/** Total implied variance from an undiscounted price by bisection on sqrt(w). */
function impliedTotalVar(F: number, K: number, price: number, type: "C" | "P"): number | null {
  const intrinsic = Math.max(0, type === "C" ? F - K : K - F);
  const upper = type === "C" ? F : K;
  if (!(price > intrinsic + 1e-9) || !(price < upper)) return null;
  let lo = 1e-6, hi = 3;
  if (black76(F, K, hi * hi, type) < price) return null;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (black76(F, K, mid * mid, type) < price) lo = mid; else hi = mid;
  }
  const s = 0.5 * (lo + hi);
  return s * s;
}

// ─── Nelder-Mead (deterministic) ────────────────────────────────────────────

function nelderMead(f: (x: number[]) => number, x0: number[], scale: number[], maxIter = 3000, tol = 1e-12): { x: number[]; fx: number } {
  const n = x0.length;
  let simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const v = x0.slice();
    v[i] += scale[i];
    simplex.push(v);
  }
  let values = simplex.map(f);
  for (let iter = 0; iter < maxIter; iter++) {
    const order = values.map((v, i) => i).sort((i, j) => values[i] - values[j]);
    simplex = order.map((i) => simplex[i]);
    values = order.map((i) => values[i]);
    if (Math.abs(values[n] - values[0]) <= tol * (Math.abs(values[0]) + 1e-30)) break;
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const at = (t: number) => centroid.map((c, j) => c + t * (simplex[n][j] - c));
    const xr = at(-1); const fr = f(xr);
    if (fr < values[0]) {
      const xe = at(-2); const fe = f(xe);
      if (fe < fr) { simplex[n] = xe; values[n] = fe; } else { simplex[n] = xr; values[n] = fr; }
    } else if (fr < values[n - 1]) {
      simplex[n] = xr; values[n] = fr;
    } else {
      const outside = fr < values[n];
      const xc = at(outside ? -0.5 : 0.5); const fc = f(xc);
      if (fc < (outside ? fr : values[n])) { simplex[n] = xc; values[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i <= n; i++) if (values[i] < values[best]) best = i;
  return { x: simplex[best], fx: values[best] };
}

// ─── Quasi-explicit inner fit (Zeliade 2009) ────────────────────────────────
// For fixed (m, sigma), with y = (k - m)/sigma, w = a + d*y + c*sqrt(y^2 + 1)
// is linear in (a, d, c) (d = rho*b*sigma, c = b*sigma).

function solve3(A: number[][], r: number[]): number[] | null {
  const M = A.map((row, i) => [...row, r[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let i = col + 1; i < 3; i++) if (Math.abs(M[i][col]) > Math.abs(M[piv][col])) piv = i;
    if (Math.abs(M[piv][col]) < 1e-300) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let i = 0; i < 3; i++) {
      if (i === col) continue;
      const fct = M[i][col] / M[col][col];
      for (let j = col; j < 4; j++) M[i][j] -= fct * M[col][j];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

function innerFit(ks: number[], ws: number[], wt: number[], m: number, sigma: number): { p: SviParams; err: number } {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhs = [0, 0, 0];
  for (let i = 0; i < ks.length; i++) {
    const y = (ks[i] - m) / sigma;
    const z = Math.sqrt(y * y + 1);
    const basis = [1, y, z];
    for (let r = 0; r < 3; r++) {
      rhs[r] += wt[i] * basis[r] * ws[i];
      for (let c = 0; c < 3; c++) A[r][c] += wt[i] * basis[r] * basis[c];
    }
  }
  let sol = solve3(A, rhs) ?? [ws.reduce((s, x) => s + x, 0) / ws.length, 0, 0];
  let [a, d, c] = sol;
  // Feasibility: c >= 0, |d| <= c (|rho| < 1), min w = a + sqrt(c^2 - d^2) >= 0.
  c = Math.max(c, 1e-12);
  d = Math.max(-0.999 * c, Math.min(0.999 * c, d));
  let num = 0, den = 0;
  for (let i = 0; i < ks.length; i++) {
    const y = (ks[i] - m) / sigma;
    num += wt[i] * (ws[i] - d * y - c * Math.sqrt(y * y + 1));
    den += wt[i];
  }
  a = den > 0 ? num / den : a;
  const minW = a + Math.sqrt(Math.max(0, c * c - d * d));
  if (minW < 0) a -= minW;
  const p: SviParams = { a, b: c / sigma, rho: d / c, m, sigma };
  let err = 0;
  for (let i = 0; i < ks.length; i++) err += wt[i] * (sviW(p, ks[i]) - ws[i]) ** 2;
  return { p, err };
}

// ─── Main fit ───────────────────────────────────────────────────────────────

export interface ImpliedDistributionOptions {
  spot: number;
  r?: number;       // risk-free rate (decimal); default 0
  q?: number;       // dividend yield, only used without puts; default 0
  T: number;        // years to expiry; enters ONLY the discount factor e^(-rT)
                    // and the spot-carry forward (the SVI density needs no clock)
  gridPoints?: number;
}

export function fitImpliedDistribution(quotes: OptionQuote[], opts: ImpliedDistributionOptions): ImpliedDistribution | null {
  const S = opts.spot;
  const r = opts.r ?? 0;
  const q = opts.q ?? 0;
  const T = Math.max(0, opts.T);
  if (!(S > 0)) return null;
  const D = Math.exp(-r * T);

  const qs = quotes
    .filter((x) => Number.isFinite(x.strike) && x.strike > 0)
    .map((x) => ({
      K: x.strike,
      c: x.callMid != null && Number.isFinite(x.callMid) && x.callMid >= 0 ? x.callMid / D : null,
      p: x.putMid != null && Number.isFinite(x.putMid) && x.putMid >= 0 ? x.putMid / D : null,
    }))
    .sort((a, b) => a.K - b.K);
  if (qs.length < 5) return null;

  // 1. Forward: put-call parity on the strikes nearest spot, else spot carry.
  let F = S * Math.exp((r - q) * T);
  let forwardSource: ImpliedDistribution["forwardSource"] = "spot-carry";
  const pairs = qs.filter((x) => x.c != null && x.p != null)
    .sort((a, b) => Math.abs(a.K - S) - Math.abs(b.K - S))
    .slice(0, 5)
    .map((x) => x.K + (x.c as number) - (x.p as number))
    .sort((a, b) => a - b);
  if (pairs.length >= 1) {
    F = pairs[Math.floor(pairs.length / 2)];
    forwardSource = "put-call-parity";
  }

  // 2. Fit set: OTM side where available (puts below F, calls above).
  type Pt = { K: number; k: number; u: number; type: "C" | "P" };
  const pts: Pt[] = [];
  for (const x of qs) {
    const wantPut = x.K < F;
    if (wantPut && x.p != null) pts.push({ K: x.K, k: Math.log(x.K / F), u: x.p, type: "P" });
    else if (!wantPut && x.c != null) pts.push({ K: x.K, k: Math.log(x.K / F), u: x.c, type: "C" });
    else if (x.c != null) pts.push({ K: x.K, k: Math.log(x.K / F), u: x.c, type: "C" });
    else if (x.p != null) pts.push({ K: x.K, k: Math.log(x.K / F), u: x.p, type: "P" });
  }
  if (pts.length < 5) return null;

  // 3a. Initial smile from invertible quotes (vega-weighted, Zeliade inner LS).
  const ks: number[] = [], ws: number[] = [], wt: number[] = [];
  for (const pt of pts) {
    const w = impliedTotalVar(F, pt.K, pt.u, pt.type);
    if (w == null) continue;
    const sw = Math.sqrt(w);
    const d2 = (Math.log(F / pt.K) - w / 2) / sw;
    const dPdW = (pt.K * normPdf(d2)) / (2 * sw); // d(price)/d(total variance)
    ks.push(pt.k); ws.push(w); wt.push(dPdW * dPdW);
  }
  if (ks.length < 4) return null;
  const sortedW = ws.slice().sort((a, b) => a - b);
  const wAtm = Math.max(1e-10, sortedW[Math.floor(sortedW.length / 2)]);
  const vAtm = Math.sqrt(wAtm);
  const kLo = Math.min(...ks), kHi = Math.max(...ks);
  // Curvature floor: SVI's sigma is the width of the smile's rounded vertex.
  // Unbounded, the fit chases quote noise with a kink (sigma -> 0), which puts
  // a spike in the density. A floor of a quarter of the ATM total vol keeps the
  // smile smooth on the scale of the distribution itself.
  const sigMin = 0.25 * vAtm;
  let best: { p: SviParams; err: number } | null = null;
  for (let i = 0; i <= 8; i++) {
    const m = kLo + ((kHi - kLo) * i) / 8;
    for (const sMul of [0.1, 0.3, 1, 3]) {
      const fit = innerFit(ks, ws, wt, m, Math.max(sigMin, sMul * vAtm));
      if (!best || fit.err < best.err) best = fit;
    }
  }
  if (!best) return null;
  const outer = nelderMead(
    (x) => innerFit(ks, ws, wt, x[0], sigMin + Math.exp(x[1])).err,
    [best.p.m, Math.log(Math.max(best.p.sigma - sigMin, 1e-3 * sigMin))],
    [0.25 * vAtm, 0.5],
    600,
  );
  const init = innerFit(ks, ws, wt, outer.x[0], sigMin + Math.exp(outer.x[1])).p;

  // 3b. Polish in price space on every OTM quote (uniform $ noise).
  const toParams = (x: number[]): SviParams => ({
    a: x[0], b: Math.exp(x[1]), rho: Math.tanh(x[2]), m: x[3], sigma: sigMin + Math.exp(x[4]),
  });
  const priceSSE = (p: SviParams) => {
    let s = 0;
    for (const pt of pts) {
      const w = sviW(p, pt.k);
      s += (black76(F, pt.K, Math.max(w, 0), pt.type) - pt.u) ** 2;
    }
    return s;
  };
  const objective = (x: number[]) => {
    const p = toParams(x);
    let pen = 0;
    const minW = p.a + p.b * p.sigma * Math.sqrt(1 - p.rho * p.rho);
    if (minW < 0) pen += 1e6 * (minW / wAtm) ** 2;
    const lee = p.b * (1 + Math.abs(p.rho)); // Lee (2004) moment bound: <= 2
    if (lee > 2) pen += 1e6 * (lee - 2) ** 2;
    return priceSSE(p) * (1 + pen);
  };
  const x0 = [init.a, Math.log(Math.max(init.b, 1e-8)), Math.atanh(Math.max(-0.999, Math.min(0.999, init.rho))), init.m, Math.log(Math.max(init.sigma - sigMin, 1e-3 * sigMin))];
  let polish = nelderMead(objective, x0, [0.1 * wAtm, 0.3, 0.2, 0.2 * vAtm, 0.3], 4000);
  polish = nelderMead(objective, polish.x, [0.05 * wAtm, 0.1, 0.1, 0.05 * vAtm, 0.1], 4000);
  const svi = objective(polish.x) <= objective(x0) ? toParams(polish.x) : toParams(x0);
  const fitRmse = Math.sqrt(priceSSE(svi) / pts.length);

  // 4. Density on a fine log-strike grid wide enough for the tails.
  const v0 = Math.sqrt(Math.max(sviW(svi, 0), 1e-12));
  const gLo = Math.min(pts[0].k, -12 * v0);
  const gHi = Math.max(pts[pts.length - 1].k, 12 * v0);
  const n = Math.max(401, Math.floor(opts.gridPoints ?? 4001));
  const dk = (gHi - gLo) / (n - 1);
  const strike: number[] = [], density: number[] = [], cdf: number[] = [];
  const pk: number[] = [];
  let negMass = 0;
  for (let i = 0; i < n; i++) {
    const k = gLo + i * dk;
    let d = sviLogDensity(svi, k);
    if (!Number.isFinite(d)) d = 0;
    if (d < 0) { negMass += -d * dk; d = 0; }
    pk.push(d);
    strike.push(F * Math.exp(k));
  }
  let mass = 0;
  cdf.push(0);
  for (let i = 1; i < n; i++) {
    mass += 0.5 * (pk[i] + pk[i - 1]) * dk;
    cdf.push(mass);
  }
  if (!(mass > 0)) return null;
  for (let i = 0; i < n; i++) {
    cdf[i] /= mass;
    density.push(pk[i] / mass / strike[i]); // per $1 of strike: f(K) = p(k)/K
  }

  const quotedRange: [number, number] = [pts[0].K, pts[pts.length - 1].K];
  const dist: ImpliedDistribution = {
    method: "svi-smoothed",
    measure: "risk-neutral",
    forward: F,
    forwardSource,
    discount: D,
    svi,
    atmTotalVol: v0,
    fitRmse,
    quotesUsed: pts.length,
    quotedRange,
    coverage: 0,
    negativeMassClipped: negMass,
    rawMass: mass,
    grid: { strike, density, cdf },
  };
  dist.coverage = cdfAt(dist, quotedRange[1]) - cdfAt(dist, quotedRange[0]);
  return dist;
}

/** P(S_T <= K) under the fitted risk-neutral distribution (linear in the grid). */
export function cdfAt(dist: ImpliedDistribution, K: number): number {
  const xs = dist.grid.strike, ys = dist.grid.cdf;
  if (K <= xs[0]) return 0;
  if (K >= xs[xs.length - 1]) return 1;
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= K) lo = mid; else hi = mid;
  }
  const t = (K - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** P(S_T > K), risk-neutral. */
export function probAbove(dist: ImpliedDistribution, K: number): number {
  return 1 - cdfAt(dist, K);
}

// ─── Legacy raw estimator (kept for comparison and as a labeled fallback) ───

/** Raw central second differences of call mids (no smoothing). Noise-sensitive. */
export function computeRNDRaw(
  chain: CallStrike[],
  spot: number,
  r: number,
  T: number,
  oneDayEM: number,
): { curve: BLDensityPoint[]; probs: BLProbabilities | null; coverage?: number } {
  if (!chain || chain.length < 5) return { curve: [], probs: null };
  const c = chain
    .filter((p) => isFinite(p.strike) && isFinite(p.callMid) && p.callMid >= 0)
    .sort((a, b) => a.strike - b.strike);
  if (c.length < 5) return { curve: [], probs: null };

  const erT = Math.exp(r * T);
  const curve: BLDensityPoint[] = [];
  for (let i = 1; i < c.length - 1; i++) {
    const km = c[i].strike - c[i - 1].strike;
    const kp = c[i + 1].strike - c[i].strike;
    const denom = km * kp * (km + kp);
    if (denom === 0) continue;
    const num = 2 * (c[i - 1].callMid * kp - c[i].callMid * (km + kp) + c[i + 1].callMid * km);
    let density = erT * (num / denom);
    if (!isFinite(density)) continue;
    if (density < 0) density = 0;
    curve.push({ strike: c[i].strike, density });
  }
  if (curve.length === 0) return { curve, probs: null };

  let area = 0;
  for (let i = 1; i < curve.length; i++) {
    area += 0.5 * (curve[i].density + curve[i - 1].density) * (curve[i].strike - curve[i - 1].strike);
  }
  const coverage = area;
  if (area >= 0.9) for (const p of curve) p.density = p.density / area;

  const integrate = (lo: number, hi: number): number => {
    let s = 0;
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1].strike, b = curve[i].strike;
      if (b < lo || a > hi) continue;
      const x0 = Math.max(a, lo), x1 = Math.min(b, hi);
      const t0 = (x0 - a) / (b - a || 1), t1 = (x1 - a) / (b - a || 1);
      const f0 = curve[i - 1].density + t0 * (curve[i].density - curve[i - 1].density);
      const f1 = curve[i - 1].density + t1 * (curve[i].density - curve[i - 1].density);
      s += 0.5 * (f0 + f1) * (x1 - x0);
    }
    return Math.max(0, Math.min(1, s));
  };
  const lastK = curve[curve.length - 1].strike;
  const firstK = curve[0].strike;
  return {
    curve,
    probs: {
      pUpOnePct: integrate(spot * 1.01, lastK),
      pUp: integrate(spot, lastK),
      pDownOnePct: integrate(firstK, spot * 0.99),
      pInOneEM: integrate(spot - oneDayEM, spot + oneDayEM),
    },
    coverage,
  };
}

// ─── Public entry used by /api/experimental/bl-pdf ──────────────────────────

/**
 * Implied (risk-neutral) density and probabilities for one expiry.
 * Smooths IV across strikes with SVI before differentiating (see header).
 * Falls back to the raw estimator only when the smile cannot be fitted, and
 * says so in `method`.
 *
 * @param chain  One expiry: strikes with call mids (and optional put mids)
 * @param spot   Current underlying price
 * @param r      Risk-free rate (decimal)
 * @param T      Years to expiry (discounting only)
 * @param oneDayEM  Expected move in price units for the band probability
 */
export function computeRND(
  chain: CallStrike[],
  spot: number,
  r: number,
  T: number,
  oneDayEM: number,
): {
  curve: BLDensityPoint[];
  probs: BLProbabilities | null;
  coverage?: number;
  method: "svi-smoothed" | "raw-finite-difference";
  measure: "risk-neutral";
  diagnostics?: {
    forward: number;
    forwardSource: ImpliedDistribution["forwardSource"];
    fitRmse: number;
    quotesUsed: number;
    negativeMassClipped: number;
    svi: SviParams;
  };
} {
  const dist = chain && chain.length >= 5
    ? fitImpliedDistribution(chain.map((c) => ({ strike: c.strike, callMid: c.callMid, putMid: c.putMid ?? null })), { spot, r, T })
    : null;
  if (!dist) {
    return { ...computeRNDRaw(chain, spot, r, T, oneDayEM), method: "raw-finite-difference", measure: "risk-neutral" };
  }
  // Display curve: the smooth density resampled across the quoted strike range.
  const [k0, k1] = dist.quotedRange;
  const curve: BLDensityPoint[] = [];
  const N = 201;
  for (let i = 0; i < N; i++) {
    const K = k0 + ((k1 - k0) * i) / (N - 1);
    const kk = Math.log(K / dist.forward);
    const d = Math.max(0, sviLogDensity(dist.svi, kk)) / dist.rawMass / K;
    curve.push({ strike: K, density: d });
  }
  const between = (lo: number, hi: number) => Math.max(0, cdfAt(dist, hi) - cdfAt(dist, lo));
  return {
    curve,
    probs: {
      pUpOnePct: probAbove(dist, spot * 1.01),
      pUp: probAbove(dist, spot),
      pDownOnePct: cdfAt(dist, spot * 0.99),
      pInOneEM: between(spot - oneDayEM, spot + oneDayEM),
    },
    coverage: dist.coverage,
    method: "svi-smoothed",
    measure: "risk-neutral",
    diagnostics: {
      forward: dist.forward,
      forwardSource: dist.forwardSource,
      fitRmse: dist.fitRmse,
      quotesUsed: dist.quotesUsed,
      negativeMassClipped: dist.negativeMassClipped,
      svi: dist.svi,
    },
  };
}
