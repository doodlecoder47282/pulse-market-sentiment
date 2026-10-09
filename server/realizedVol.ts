// server/realizedVol.ts
//
// Noise-robust realized variance from the closest-to-tick series Batcave has
// (Schwab LEVELONE updates, server/streamStore.ts). Pure module: no DB, no
// network, so every number here is testable.
//
// Why not plain realized variance: at tick frequency the observed log price is
// Y = X + e, with e market-microstructure noise (bid-ask bounce, discreteness).
// Sum of squared tick returns then estimates IV + 2 n E[e^2], which grows with
// the number of ticks n instead of converging to integrated variance (IV).
// Two published fixes are implemented and reported side by side:
//
// 1. Two-scales realized variance (TSRV):
//    Zhang, Mykland & Ait-Sahalia (2005), "A Tale of Two Time Scales:
//    Determining Integrated Volatility With Noisy High-Frequency Data",
//    JASA 100(472), 1394-1411.
//    https://ideas.repec.org/a/bes/jnlasa/v100y2005p1394-1411.html
//    (working paper: https://www.stat.cmu.edu/tr/tr821/tr821.pdf, eq. 7)
//      [Y,Y]^all = sum over all n returns of r_i^2
//      [Y,Y]^avg = (1/K) * sum_{i=K..n} (Y_i - Y_{i-K})^2   (average of K subgrids)
//      nbar      = (n - K + 1) / K                          (avg subgrid size)
//      TSRV      = (1 - nbar/n)^-1 * ([Y,Y]^avg - (nbar/n) [Y,Y]^all)
//    (the (1 - nbar/n)^-1 factor is the paper's small-sample adjustment).
//    Noise variance E[e^2] = [Y,Y]^all / (2n). Scale K = c * n^(2/3), the
//    paper's rate; c minimises the asymptotic variance 8 E[e^2]^2 / c^2 +
//    (4/3) c T int sigma^4, i.e. c = (12 E[e^2]^2 / (T int sigma^4))^(1/3),
//    with T int sigma^4 approximated by IV_sparse^2 (constant-vol plug-in).
//
// 2. Realized kernel (Parzen, non-negative form):
//    Barndorff-Nielsen, Hansen, Lunde & Shephard (2008), "Designing Realized
//    Kernels to Measure the ex post Variation of Equity Prices in the Presence
//    of Noise", Econometrica 76(6), 1481-1536; implementation choices from
//    their "Realised Kernels in Practice: Trades and Quotes", Econometrics
//    Journal (2009) 12, C1-C32.
//    https://scholar.harvard.edu/sites/scholar.harvard.edu/files/RKpractice-ECTJ.pdf
//      K(X)   = sum_{h=-H..H} k(h/(H+1)) gamma_h,  gamma_h = sum_j x_j x_{j-|h|}
//      Parzen k(x) = 1 - 6x^2 + 6x^3 (0 <= x <= 1/2); 2(1-x)^3 (1/2 <= x <= 1)
//      H* = c* xi^(4/5) n^(3/5), c* = 3.5134, xi^2 = omega^2 / IV
//      omega^2 = mean over q offsets of RV_dense^(i) / (2 n^(i)), q chosen so
//        every q-th observation is about 2 minutes apart
//      IV for xi = RV_sparse: 20-minute returns averaged over 1-second shifts
//      Jittering m = 2: first and last prices replaced by 2-point averages.
//
// Both estimators assume the noise is i.i.d. and independent of the price.
// Schwab LEVELONE updates are conflated (several trades can arrive as one
// update), so the series is "closest to tick", not a trade tape: the
// estimators remain consistent under that sampling but n is the number of
// updates, not the number of trades.

/** One observation: Schwab time (epoch ms) and price (> 0). */
export interface PricePoint {
  t: number;
  p: number;
}

/** Regular-session seconds per year used to annualise (252 x 6.5 h). */
export const RTH_SECONDS_PER_YEAR = 252 * 23_400;
/** Parzen-kernel bandwidth constant c* = ((12)^2 / 0.269)^(1/5). */
export const PARZEN_C_STAR = Math.pow(144 / 0.269, 0.2);
/** Fewest observations for which an estimate is reported. */
export const MIN_RV_OBS = 50;

/** Successive differences of a series. */
export function diffs(x: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < x.length; i++) out.push(x[i] - x[i - 1]);
  return out;
}

/** Plain realized variance: sum of squared returns of the log-price series. */
export function realizedVariance(logPrices: number[]): number {
  let s = 0;
  for (let i = 1; i < logPrices.length; i++) {
    const r = logPrices[i] - logPrices[i - 1];
    s += r * r;
  }
  return s;
}

/** Parzen kernel weight. */
export function parzen(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.5) return 1 - 6 * a * a + 6 * a * a * a;
  if (a <= 1) return 2 * Math.pow(1 - a, 3);
  return 0;
}

/** Previous-tick sample of points at grid times (ascending); null before the first point. Binary search per grid time. */
export function previousTick(points: PricePoint[], grid: number[]): (number | null)[] {
  const out: (number | null)[] = [];
  let lo0 = 0;
  for (const g of grid) {
    // last index with t <= g, searching from the previous answer (grid ascending)
    let lo = lo0;
    let hi = points.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= g) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans >= 0) lo0 = ans;
    out.push(ans >= 0 ? points[ans].p : null);
  }
  return out;
}

/**
 * Subsampled sparse RV (BNHLS 2009 sec. on bandwidth): RV of log returns
 * over `stepMs`, averaged over shifts of the start by `shiftMs`.
 * Returns null when no shift yields at least one return.
 */
export function sparseRealizedVariance(points: PricePoint[], stepMs = 20 * 60_000, shiftMs = 1_000): number | null {
  if (points.length < 2) return null;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = t1 - t0;
  if (span <= 0) return null;
  // Short window: shrink the step so at least 3 sparse returns fit (labelled
  // in the result as rvSparse20m all the same: it is only a bandwidth input).
  const step = Math.min(stepMs, span / 3);
  const shifts = Math.max(1, Math.min(Math.floor(step / shiftMs), 1200));
  let sum = 0;
  let used = 0;
  for (let s = 0; s < shifts; s++) {
    const grid: number[] = [];
    for (let g = t0 + s * shiftMs; g <= t1; g += step) grid.push(g);
    if (grid.length < 2) continue;
    const px = previousTick(points, grid);
    let rv = 0;
    let k = 0;
    for (let i = 1; i < px.length; i++) {
      const a = px[i - 1];
      const b = px[i];
      if (a == null || b == null) continue;
      const r = Math.log(b / a);
      rv += r * r;
      k++;
    }
    if (k === 0) continue;
    // Each shift covers (grid.length - 1) * step of the window; scale to the full span.
    rv *= span / ((grid.length - 1) * step);
    sum += rv;
    used++;
  }
  return used > 0 ? sum / used : null;
}

export interface TsrvResult {
  iv: number;
  K: number;
  nbar: number;
  rvAll: number;
  rvAvg: number;
  /** E[e^2] = [Y,Y]^all / (2n). */
  noiseVar: number;
}

/** TSRV with scale K (ZMA 2005), small-sample adjusted. logPrices has n+1 points. */
export function tsrv(logPrices: number[], K: number): TsrvResult | null {
  const n = logPrices.length - 1;
  if (n < 4) return null;
  const k = Math.max(2, Math.min(Math.floor(K), Math.floor(n / 2)));
  const rvAll = realizedVariance(logPrices);
  let s = 0;
  for (let i = k; i <= n; i++) {
    const r = logPrices[i] - logPrices[i - k];
    s += r * r;
  }
  const rvAvg = s / k;
  const nbar = (n - k + 1) / k;
  const adj = 1 - nbar / n;
  if (adj <= 0) return null;
  const iv = (rvAvg - (nbar / n) * rvAll) / adj;
  return { iv, K: k, nbar, rvAll, rvAvg, noiseVar: rvAll / (2 * n) };
}

/** ZMA scale K = c n^(2/3), c = (12 noiseVar^2 / quarticity)^(1/3), clamped to [2, n/2]. */
export function tsrvScale(n: number, noiseVar: number, quarticity: number): number {
  if (!(quarticity > 0) || !(noiseVar > 0)) return Math.max(2, Math.round(Math.pow(n, 2 / 3) / 10));
  const c = Math.cbrt((12 * noiseVar * noiseVar) / quarticity);
  return Math.max(2, Math.min(Math.floor(n / 2), Math.round(c * Math.pow(n, 2 / 3))));
}

/** Realized kernel with Parzen weights and bandwidth H on the returns x. */
export function realizedKernelFromReturns(x: number[], H: number): number {
  const n = x.length;
  const h = Math.max(0, Math.min(Math.floor(H), n - 1));
  let k = 0;
  for (let j = 0; j < n; j++) k += x[j] * x[j];
  for (let lag = 1; lag <= h; lag++) {
    let g = 0;
    for (let j = lag; j < n; j++) g += x[j] * x[j - lag];
    k += 2 * parzen(lag / (h + 1)) * g;
  }
  return k;
}

/** Jittered (m = 2) log-price series: first and last prices replaced by 2-point averages. */
export function jitterEnds(logPrices: number[]): number[] {
  const n = logPrices.length;
  if (n < 4) return logPrices.slice();
  const out = logPrices.slice(1, n - 1);
  out[0] = (logPrices[0] + logPrices[1]) / 2;
  out[out.length - 1] = (logPrices[n - 2] + logPrices[n - 1]) / 2;
  return out;
}

/** omega^2 = mean over q offsets of RV_dense^(i) / (2 n^(i)), n^(i) = non-zero returns. */
export function noiseVarianceBnhls(logPrices: number[], q: number): number | null {
  const qq = Math.max(1, Math.floor(q));
  let sum = 0;
  let used = 0;
  for (let i = 0; i < qq; i++) {
    let rv = 0;
    let nz = 0;
    for (let j = i + qq; j < logPrices.length; j += qq) {
      const r = logPrices[j] - logPrices[j - qq];
      if (r !== 0) {
        rv += r * r;
        nz++;
      }
    }
    if (nz === 0) continue;
    sum += rv / (2 * nz);
    used++;
  }
  return used > 0 ? sum / used : null;
}

export interface RealizedVolEstimate {
  dataState: "ok" | "insufficient";
  reason: string | null;
  /** Observations used (price updates), and the window they span. */
  n: number;
  fromMs: number | null;
  toMs: number | null;
  windowSec: number;
  /** Plain sum of squared tick returns: biased up by 2 n E[e^2]; shown for contrast only. */
  rvNaive: number | null;
  rvSparse20m: number | null;
  tsrv: number | null;
  tsrvK: number | null;
  realizedKernel: number | null;
  rkBandwidth: number | null;
  /** ZMA noise variance E[e^2] = RV_all / (2n). */
  noiseVar: number | null;
  /** BNHLS omega^2 used for the kernel bandwidth (conservative: biased up by IV / (2 n_q)). */
  rkOmega2: number | null;
  /** Preferred estimate: TSRV when positive, else the realized kernel (non-negative by construction). */
  iv: number | null;
  method: "tsrv" | "realized_kernel_parzen" | null;
  /** sqrt(iv * RTH_SECONDS_PER_YEAR / windowSec): annualised over regular-session seconds. */
  annualizedVol: number | null;
}

/**
 * Integrated variance over the window spanned by `points` (Schwab time,
 * ascending, prices > 0). Points with non-finite or non-positive prices are
 * dropped. Returns dataState "insufficient" (never 0) below MIN_RV_OBS.
 */
export function estimateRealizedVol(pointsIn: PricePoint[], opts: { minObs?: number } = {}): RealizedVolEstimate {
  const minObs = opts.minObs ?? MIN_RV_OBS;
  const points = pointsIn.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.p) && p.p > 0);
  const empty: RealizedVolEstimate = {
    dataState: "insufficient", reason: null, n: points.length,
    fromMs: points.length ? points[0].t : null, toMs: points.length ? points[points.length - 1].t : null,
    windowSec: points.length >= 2 ? (points[points.length - 1].t - points[0].t) / 1000 : 0,
    rvNaive: null, rvSparse20m: null, tsrv: null, tsrvK: null, realizedKernel: null, rkBandwidth: null,
    noiseVar: null, rkOmega2: null, iv: null, method: null, annualizedVol: null,
  };
  if (points.length < minObs) return { ...empty, reason: `only ${points.length} observations (need ${minObs})` };
  if (empty.windowSec <= 0) return { ...empty, reason: "observations span no time" };

  const y = points.map((p) => Math.log(p.p));
  const n = y.length - 1;
  const rvNaive = realizedVariance(y);
  const rvSparse = sparseRealizedVariance(points);

  // TSRV
  const noiseAll = rvNaive / (2 * n);
  const quart = rvSparse != null && rvSparse > 0 ? rvSparse * rvSparse : 0;
  const ts = tsrv(y, tsrvScale(n, noiseAll, quart));

  // Realized kernel (jittered ends, BNHLS bandwidth)
  const yj = jitterEnds(y);
  const xj = diffs(yj);
  const avgSpacingSec = empty.windowSec / n;
  const q = Math.max(1, Math.round(120 / Math.max(avgSpacingSec, 1e-9)));
  const omega2 = noiseVarianceBnhls(y, Math.min(q, Math.floor(n / 2)));
  let H: number | null = null;
  let rk: number | null = null;
  if (omega2 != null && rvSparse != null && rvSparse > 0) {
    const xi2 = omega2 / rvSparse;
    H = Math.max(1, Math.ceil(PARZEN_C_STAR * Math.pow(xi2, 0.4) * Math.pow(n, 0.6)));
    rk = realizedKernelFromReturns(xj, H);
  } else if (omega2 === null) {
    // No non-zero returns at all: a flat series. The kernel is 0 by construction.
    H = 1;
    rk = realizedKernelFromReturns(xj, 1);
  }

  // Headline: TSRV when positive (lower dispersion than the kernel with the
  // BNHLS bandwidth in the seeded known-answer tests, tests/quant/stream-r2),
  // else the kernel, which cannot be negative. Both are always reported.
  const iv = ts != null && ts.iv > 0 ? ts.iv : rk != null && rk >= 0 ? rk : null;
  const method = ts != null && ts.iv > 0 ? "tsrv" : rk != null && rk >= 0 ? "realized_kernel_parzen" : null;
  return {
    ...empty,
    dataState: iv != null ? "ok" : "insufficient",
    reason: iv != null ? null : "estimators undefined for this window",
    rvNaive,
    rvSparse20m: rvSparse,
    tsrv: ts?.iv ?? null,
    tsrvK: ts?.K ?? null,
    realizedKernel: rk,
    rkBandwidth: H,
    noiseVar: noiseAll,
    rkOmega2: omega2,
    iv,
    method,
    annualizedVol: iv != null ? Math.sqrt((iv * RTH_SECONDS_PER_YEAR) / empty.windowSec) : null,
  };
}
