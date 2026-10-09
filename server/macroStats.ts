// server/macroStats.ts
//
// Pure statistics for the Regime and Canary engines (no DB, no network), so
// every threshold can be tested against a known answer.
//
// 1. Regime z-scores on overlapping windows (review finding 5.4).
//    A w-day rate of change sampled every day over a ~2-year history holds
//    only about T/w independent observations (2 for a 52-week window), so the
//    sample standard deviation of overlapping rolling returns is noisy and
//    biased low, and a normal table overstates how rare |z| >= 2 is
//    (Hansen & Hodrick 1980; Valkanov 2003). Here:
//      - the horizon-w return is z-scored with the Newey-West long-run
//        variance of DAILY returns, scaled to w days, with the exact finite-
//        sample factor (1 - w/T) for a demeaned sum
//        (Newey & West 1987, Econometrica 55(3):703-708,
//         https://www.nber.org/papers/t0055; lag rule floor(4 (T/100)^(2/9))
//         from Newey & West 1994, Review of Economic Studies 61(4):631-653,
//         https://ideas.repec.org/a/oup/restud/v61y1994i4p631-653..html);
//      - "fresh" and "durable" are tested against a no-regime null built
//        with a Rademacher wild bootstrap of the demeaned daily returns
//        (round 3; Liu 1988, Annals of Statistics 16(4):1696-1708;
//        Goncalves & Kilian 2004, J. Econometrics 123(1):89-120,
//        https://users.ssc.wisc.edu/~bhansen/718/GoncalvesKilian2004.pdf):
//        random signs at fixed dates keep the realized volatility path
//        (volatility clustering) and destroy any drift run. Round 2 used the
//        Politis-Romano stationary bootstrap with a Politis-White block
//        length (Politis & White 2004, Econometric Reviews 23(1):53-70;
//        Patton, Politis & White 2009, Econometric Reviews 28(4):372-375,
//        https://public.econ.duke.edu/~ap172/Patton_Politis_White_2009.pdf);
//        the Politis-White length of r is still reported as a diagnostic.
//      The
//      persistence test asks how often a run of |z| >= band as long as the
//      observed one ends on the last day under that null.
//
// 2. Canary composite as a true z-score (finding 5.6).
//    A weighted sum of correlated unit-variance z-scores has standard
//    deviation sqrt(w' R w), not sum(w). Dividing by it gives a statistic
//    that is N(0,1) under the null. R is estimated from daily history with
//    Ledoit-Wolf shrinkage toward the identity (Ledoit & Wolf 2004, "A
//    well-conditioned estimator for large-dimensional covariance matrices",
//    J. Multivariate Analysis 88(2):365-411,
//    https://econpapers.repec.org/RePEc:eee:jmvana:v:88:y:2004:i:2:p:365-411),
//    because 6 series over ~120 days is a small sample. The canary uses the
//    constant-correlation target (Ledoit & Wolf 2004, "Honey, I Shrunk the
//    Sample Covariance Matrix", https://econ-papers.upf.edu/papers/691.pdf):
//    shrinking positively correlated canaries toward independence would
//    understate sqrt(w' R w) and inflate the composite.

// ─── PRNG ──────────────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) so the same history gives the same p-value. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit seed from a string (FNV-1a), so each axis/window has its own fixed seed. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ─── Moments ───────────────────────────────────────────────────────────────

export function mean(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += xs[i];
  return s / n;
}

/** Sample autocovariance at lag k, divisor T (the positive-semidefinite form). */
export function autocov(xs: ArrayLike<number>, k: number, mu = mean(xs)): number {
  const n = xs.length;
  if (k >= n) return 0;
  let s = 0;
  for (let i = k; i < n; i++) s += (xs[i] - mu) * (xs[i - k] - mu);
  return s / n;
}

/** Newey-West (1994) rule-of-thumb lag for the Bartlett kernel: floor(4 (T/100)^(2/9)). */
export function neweyWestLag(T: number): number {
  if (T < 2) return 0;
  return Math.max(0, Math.floor(4 * Math.pow(T / 100, 2 / 9)));
}

/**
 * Newey-West long-run variance of a series (variance of sqrt(T) * mean):
 * gamma0 + 2 * sum_{k=1..L} (1 - k/(L+1)) gamma_k. Bartlett weights keep it
 * non-negative. With L = 0 it is the (divisor-T) sample variance.
 */
export function neweyWestLRV(xs: ArrayLike<number>, lag = neweyWestLag(xs.length)): number {
  const mu = mean(xs);
  let v = autocov(xs, 0, mu);
  for (let k = 1; k <= lag; k++) v += 2 * (1 - k / (lag + 1)) * autocov(xs, k, mu);
  return Math.max(0, v);
}

// ─── Politis-White automatic block length (stationary bootstrap) ──────────

function flatTop(t: number): number {
  const a = Math.abs(t);
  if (a <= 0.5) return 1;
  if (a <= 1) return 2 * (1 - a);
  return 0;
}

export interface BlockLengthResult {
  /** optimal mean block length for the stationary bootstrap, rounded, in [1, bMax] */
  b: number;
  /** unrounded estimate before the cap */
  bRaw: number;
  mHat: number;
  M: number;
  bMax: number;
}

/**
 * Politis & White (2004) with the Patton-Politis-White (2009) correction,
 * stationary-bootstrap branch, following the authors' reference code:
 *   K_N = max(5, ceil(log10 n)), m_max = ceil(sqrt n) + K_N,
 *   b_max = ceil(min(3 sqrt n, n / 3)), c = 1.96 (qnorm 0.975),
 *   m_hat = first lag that starts a run of K_N insignificant autocorrelations
 *           (|rho| < c sqrt(log10 n / n)); else the largest significant lag; else 1,
 *   M = min(2 m_hat, m_max),
 *   G = sum_{|k|<=M} lambda(k/M) |k| R(k),  D_SB = 2 (sum_{|k|<=M} lambda(k/M) R(k))^2,
 *   b = (2 G^2 / D_SB)^(1/3) n^(1/3).
 */
export function politisWhiteBlockLength(xs: ArrayLike<number>): BlockLengthResult {
  const n = xs.length;
  const bMax = Math.max(1, Math.ceil(Math.min(3 * Math.sqrt(n), n / 3)));
  if (n < 10) return { b: 1, bRaw: 1, mHat: 1, M: 1, bMax };
  const KN = Math.max(5, Math.ceil(Math.log10(n)));
  const mMax = Math.ceil(Math.sqrt(n)) + KN;
  const c = 1.959963984540054;
  const mu = mean(xs);
  const g0 = autocov(xs, 0, mu);
  if (!(g0 > 0)) return { b: 1, bRaw: 1, mHat: 1, M: 1, bMax };
  const rho: number[] = [0];
  for (let k = 1; k <= mMax; k++) rho.push(autocov(xs, k, mu) / g0);
  const thresh = c * Math.sqrt(Math.log10(n) / n);
  const insig = rho.map((r) => Math.abs(r) < thresh);
  let mHat = -1;
  for (let j = 1; j + KN - 1 <= mMax; j++) {
    let all = true;
    for (let k = j; k < j + KN; k++) if (!insig[k]) { all = false; break; }
    if (all) { mHat = j; break; }
  }
  if (mHat < 0) {
    let lastSig = -1;
    for (let k = 1; k <= mMax; k++) if (!insig[k]) lastSig = k;
    mHat = lastSig > 0 ? lastSig : 1;
  }
  const M = Math.min(2 * mHat, mMax);
  let G = 0;
  let g = 0;
  for (let k = -M; k <= M; k++) {
    const R = autocov(xs, Math.abs(k), mu);
    const lam = flatTop(k / M);
    G += lam * Math.abs(k) * R;
    g += lam * R;
  }
  const D = 2 * g * g;
  const bRaw = D > 0 ? Math.pow((2 * G * G) / D, 1 / 3) * Math.pow(n, 1 / 3) : 1;
  const b = Math.min(bMax, Math.max(1, Math.round(bRaw)));
  return { b, bRaw, mHat, M, bMax };
}

// ─── Stationary bootstrap ─────────────────────────────────────────────────

/**
 * Politis-Romano stationary bootstrap indices: blocks start at a uniform
 * random index, have geometric length with mean `meanBlock`, and wrap around
 * the end of the sample (circular), so the resampled series is stationary.
 */
export function stationaryBootstrapIndices(T: number, meanBlock: number, rand: () => number): Int32Array {
  const idx = new Int32Array(T);
  const p = 1 / Math.max(1, meanBlock);
  let cur = Math.floor(rand() * T);
  for (let t = 0; t < T; t++) {
    if (t > 0) {
      if (rand() < p) cur = Math.floor(rand() * T);
      else cur = (cur + 1) % T;
    }
    idx[t] = cur;
  }
  return idx;
}

// ─── Horizon z-scores and persistence ─────────────────────────────────────

/**
 * z_t of the w-day demeaned sum ending at each t (t = w-1 .. T-1):
 *   z_t = (S_t - w * mean) / sqrt(LRV * w * (1 - w/T)).
 * For i.i.d. returns Var(S - w * mean) = sigma^2 * w * (1 - w/T) exactly,
 * because the sample mean contains the window's own returns.
 */
export function horizonZSeries(r: ArrayLike<number>, w: number, lrv: number): number[] {
  const T = r.length;
  if (w < 1 || w >= T || !(lrv > 0)) return [];
  const mu = mean(r);
  const sd = Math.sqrt(lrv * w * (1 - w / T));
  const out: number[] = [];
  let s = 0;
  for (let i = 0; i < T; i++) {
    s += r[i];
    if (i >= w) s -= r[i - w];
    if (i >= w - 1) out.push((s - w * mu) / sd);
  }
  return out;
}

/** Length of the run ending at the last point with z on the same side of +/-band as the last z. */
export function terminalRun(z: ArrayLike<number>, band: number): number {
  const n = z.length;
  if (!n) return 0;
  const last = z[n - 1];
  const sign = last >= 0 ? 1 : -1;
  let run = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (sign > 0 ? z[i] >= band : z[i] <= -band) run++;
    else break;
  }
  return run;
}

export interface RegimeZTest {
  /** z of the latest w-day return (HAC, finite-sample scaled) */
  z: number;
  /** full z series, oldest first (one point per day from day w) */
  zSeries: number[];
  /** days the |z| >= band run (same sign as today) has lasted, ending today */
  persistence: number;
  /** wild-bootstrap two-sided p-value of |z| under the no-regime null */
  pZ: number;
  /** wild-bootstrap p-value of a terminal run at least this long (1 when run = 0) */
  pPersist: number;
  /** bootstrap 95th percentile of |z| (the two-sided 5% critical value) */
  zCrit95: number;
  /** bootstrap 95th percentile of the terminal run length */
  runCrit95: number;
  band: number;
  /** Politis-White block length of r, days (diagnostic: the serial-dependence scale; the null is a wild bootstrap) */
  blockLength: number;
  nwLag: number;
  /** floor(T / w): how many non-overlapping windows the history holds */
  independentWindows: number;
  bootstrapReps: number;
  sampleDays: number;
  method: string;
}

export const REGIME_BOOTSTRAP_REPS = 299;

/**
 * Regime z-score with a bootstrap null. `r` = daily log returns (oldest first).
 * Returns null when there is not enough history for the window.
 */
export function regimeZTest(
  r: ArrayLike<number>,
  w: number,
  opts: { reps?: number; seed?: number; band?: number } = {},
): RegimeZTest | null {
  const T = r.length;
  if (w < 1 || T < w + 30) return null;
  const band = opts.band ?? 1.5;
  const reps = Math.max(99, Math.floor(opts.reps ?? REGIME_BOOTSTRAP_REPS));
  const lag = neweyWestLag(T);
  const lrv = neweyWestLRV(r, lag);
  const zSeries = horizonZSeries(r, w, lrv);
  if (!zSeries.length) return null;
  const z = zSeries[zSeries.length - 1];
  const persistence = terminalRun(zSeries, band);
  // Null resampling (round 3): wild bootstrap of the demeaned daily returns
  // with Rademacher signs, r*_t = (r_t - mean) * s_t, s_t = +/-1 i.i.d.
  // (Liu 1988; for heteroskedasticity of unknown form in time series,
  // Goncalves & Kilian 2004, "Bootstrapping autoregressions with conditional
  // heteroskedasticity of unknown form", J. Econometrics 123(1):89-120,
  // https://users.ssc.wisc.edu/~bhansen/718/GoncalvesKilian2004.pdf).
  // Every |residual| stays at its own date, so the realized volatility path,
  // including the last window's, is kept exactly; under GARCH with symmetric
  // shocks the signs are independent of the magnitudes, so given |r| the
  // last-window sum is a Rademacher sum in both the data and the bootstrap.
  // A drift regime is a run of same-signed residuals; random signs destroy
  // it: the "no regime" null. Linear serial dependence is not resampled; the
  // statistic is HAC-studentized in the data and in each replicate.
  // Alternatives measured (seeded Monte Carlo, 1000 nulls x w = 20/65/252,
  // tests/quant/r3-3.test.ts and the report): the round-2 stationary
  // bootstrap and a Bartlett dependent wild bootstrap (Shao 2010, JASA
  // 105(489):218-235) with the Politis-White bandwidth; the latter was
  // undersized (1-3% at w = 20) because NW in the replicate misses the
  // multiplier-induced autocorrelation.
  const bR = politisWhiteBlockLength(r);
  const mu = mean(r);
  const rand = mulberry32(opts.seed ?? 0x5e9e);
  const buf = new Float64Array(T);
  const absZ: number[] = [];
  const runs: number[] = [];
  let zAtLeast = 0;
  let runAtLeast = 0;
  for (let rep = 0; rep < reps; rep++) {
    for (let t = 0; t < T; t++) buf[t] = (rand() < 0.5 ? -1 : 1) * (r[t] - mu);
    const zs = horizonZSeries(buf, w, neweyWestLRV(buf, lag));
    if (!zs.length) continue;
    const zb = Math.abs(zs[zs.length - 1]);
    const rb = terminalRun(zs, band);
    absZ.push(zb);
    runs.push(rb);
    if (zb >= Math.abs(z)) zAtLeast++;
    if (rb >= persistence) runAtLeast++;
  }
  const B = absZ.length;
  const q95 = (xs: number[]) => {
    if (!xs.length) return NaN;
    const s = xs.slice().sort((a, c) => a - c);
    return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
  };
  return {
    z,
    zSeries,
    persistence,
    pZ: (1 + zAtLeast) / (B + 1),
    pPersist: persistence > 0 ? (1 + runAtLeast) / (B + 1) : 1,
    zCrit95: q95(absZ),
    runCrit95: q95(runs),
    band,
    blockLength: bR.b,
    nwLag: lag,
    independentWindows: Math.floor(T / w),
    bootstrapReps: B,
    sampleDays: T,
    method: "HAC z (Newey-West) of the w-day return; p-values from a Rademacher wild bootstrap of demeaned daily returns (Liu 1988; Goncalves-Kilian 2004), which keeps the realized volatility path",
  };
}

// ─── Multiple testing ─────────────────────────────────────────────────────

/**
 * Benjamini-Hochberg q-values (step-up, monotone): q_(i) = min_{j>=i} p_(j) m / j,
 * capped at 1. Rejecting q <= alpha controls the false discovery rate at alpha
 * for independent or positively dependent tests (Benjamini & Hochberg 1995,
 * https://doi.org/10.1111/j.2517-6161.1995.tb02031.x;
 * JRSS B 57(1):289-300; Benjamini & Yekutieli 2001, Ann. Statist. 29(4)).
 * Non-finite p-values get q = NaN and do not count toward m.
 */
export function benjaminiHochberg(p: number[]): number[] {
  const idx = p.map((v, i) => ({ v, i })).filter((x) => Number.isFinite(x.v));
  const m = idx.length;
  const q = p.map(() => NaN);
  if (!m) return q;
  idx.sort((a, b) => a.v - b.v);
  let run = 1;
  for (let k = m - 1; k >= 0; k--) {
    run = Math.min(run, (idx[k].v * m) / (k + 1));
    q[idx[k].i] = Math.min(1, run);
  }
  return q;
}

/**
 * Regime flags after FDR control (pure, used by regime.ts applyRegimeFdr):
 * one BH family for the z p-values, one for the persistence p-values.
 */
export function regimeFdrFlags(
  items: Array<{ pZ: number; pPersist: number; freshCandidate: boolean; persistence: number }>,
  alpha = 0.05,
  durableMinDays = 30,
): Array<{ qZ: number; qPersist: number; fresh: boolean; durable: boolean }> {
  const qz = benjaminiHochberg(items.map((r) => r.pZ));
  const qp = benjaminiHochberg(items.map((r) => r.pPersist));
  return items.map((r, i) => ({
    qZ: qz[i],
    qPersist: qp[i],
    fresh: r.freshCandidate && qz[i] <= alpha,
    durable: r.persistence >= durableMinDays && qp[i] <= alpha,
  }));
}

// ─── Ledoit-Wolf shrinkage and the canary composite z ────────────────────

export interface ShrunkCovariance {
  cov: number[][];
  /** shrinkage intensity toward mu * I, in [0, 1] */
  shrinkage: number;
  /** identity target: its scale trace(S) / p; constant-correlation target: the average correlation */
  mu: number;
  n: number;
  p: number;
}

/**
 * Ledoit-Wolf (2004) shrinkage of the sample covariance toward mu * I.
 * X has one row per observation (n x p). Uses the paper's estimators with
 * divisor n and the normalized Frobenius norm ||A||^2 = tr(A A') / p:
 *   m = tr(S)/p, d2 = ||S - m I||^2, bbar2 = (1/n^2) sum_k ||x_k x_k' - S||^2,
 *   b2 = min(bbar2, d2), shrinkage = b2 / d2, S* = shrinkage m I + (1 - shrinkage) S.
 */
export function ledoitWolf(X: number[][]): ShrunkCovariance | null {
  const n = X.length;
  if (n < 2) return null;
  const p = X[0].length;
  if (!p || X.some((row) => row.length !== p || row.some((v) => !Number.isFinite(v)))) return null;
  const means = new Array(p).fill(0);
  for (const row of X) for (let j = 0; j < p; j++) means[j] += row[j] / n;
  const Xc = X.map((row) => row.map((v, j) => v - means[j]));
  const S: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const x of Xc) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) S[i][j] += (x[i] * x[j]) / n;
  let m = 0;
  for (let i = 0; i < p; i++) m += S[i][i] / p;
  let d2 = 0;
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) d2 += (S[i][j] - (i === j ? m : 0)) ** 2 / p;
  let bbar2 = 0;
  for (const x of Xc) {
    let f = 0;
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) f += (x[i] * x[j] - S[i][j]) ** 2 / p;
    bbar2 += f;
  }
  bbar2 /= n * n;
  const b2 = Math.min(bbar2, d2);
  const shrinkage = d2 > 0 ? b2 / d2 : 1;
  const cov = S.map((row, i) => row.map((v, j) => shrinkage * (i === j ? m : 0) + (1 - shrinkage) * v));
  return { cov, shrinkage, mu: m, n, p };
}

/**
 * Ledoit-Wolf shrinkage toward the CONSTANT-CORRELATION target ("Honey, I
 * Shrunk the Sample Covariance Matrix", J. Portfolio Management 30(4) 2004,
 * https://econ-papers.upf.edu/papers/691.pdf): F keeps each variance and sets
 * every correlation to the average sample correlation rbar;
 *   delta = max(0, min(1, (pi - rho) / gamma / n)),  S* = delta F + (1 - delta) S,
 * with pi, rho (theta terms) and gamma as in the paper (divisor n). Unlike the
 * identity target it does not pull a set of positively correlated signals
 * toward independence, which would understate sqrt(w' R w) and inflate a
 * composite z.
 */
export function ledoitWolfConstantCorrelation(X: number[][], opts: { k?: 0 | 1 } = {}): ShrunkCovariance | null {
  const N = X.length;
  if (N < 2) return null;
  // Divisor: the paper's estimators use T (k = 0, the default here). The
  // authors' covCor code demeans and then divides by N - 1 (k = 1);
  // https://github.com/pald22/covShrinkage/blob/main/covCor.py
  const n = N - (opts.k ?? 0);
  const p = X[0].length;
  if (p < 2 || X.some((row) => row.length !== p || row.some((v) => !Number.isFinite(v)))) return null;
  const means = new Array(p).fill(0);
  for (const row of X) for (let j = 0; j < p; j++) means[j] += row[j] / N;
  const Y = X.map((row) => row.map((v, j) => v - means[j]));
  const S: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const y of Y) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) S[i][j] += (y[i] * y[j]) / n;
  const sd = S.map((row, i) => Math.sqrt(row[i]));
  if (sd.some((v) => !(v > 0))) return null;
  let rbar = 0;
  for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) rbar += S[i][j] / (sd[i] * sd[j]);
  rbar *= 2 / (p * (p - 1));
  const F = S.map((row, i) => row.map((v, j) => (i === j ? v : rbar * sd[i] * sd[j])));
  let pi = 0;
  const piDiag = new Array(p).fill(0);
  // pi_ij = (1/n) sum y_i^2 y_j^2 - s_ij^2 and theta_ii,ij = (1/n) sum y_i^3 y_j
  // - s_ii s_ij: the covCor form (identical to the paper's centred form when n = N).
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) {
    let a = 0;
    for (const y of Y) a += y[i] * y[i] * y[j] * y[j];
    a = a / n - S[i][j] * S[i][j];
    pi += a;
    if (i === j) piDiag[i] = a;
  }
  let rho = piDiag.reduce((a, b) => a + b, 0);
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) {
    if (i === j) continue;
    let tii = 0, tjj = 0;
    for (const y of Y) {
      tii += y[i] * y[i] * y[i] * y[j];
      tjj += y[j] * y[j] * y[j] * y[i];
    }
    tii = tii / n - S[i][i] * S[i][j];
    tjj = tjj / n - S[j][j] * S[i][j];
    rho += (rbar / 2) * ((sd[j] / sd[i]) * tii + (sd[i] / sd[j]) * tjj);
  }
  let gamma = 0;
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) gamma += (F[i][j] - S[i][j]) ** 2;
  const shrinkage = gamma > 0 ? Math.max(0, Math.min(1, (pi - rho) / gamma / n)) : 1;
  const cov = S.map((row, i) => row.map((v, j) => shrinkage * F[i][j] + (1 - shrinkage) * v));
  return { cov, shrinkage, mu: rbar, n, p };
}

/** Empirical quantile (type 7, linear interpolation, as numpy's default). NaN for an empty sample. */
export function empiricalQuantile(xs: number[], q: number): number {
  const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const h = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  return s[lo] + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)]) - s[lo]);
}

/**
 * Close-to-close history of a standardized composite: for each day t after
 * `volWindow` days, each column's return is z-scored by the sample sd of its
 * previous `volWindow` returns (the live canary's 20-day vol), passed through
 * `transform` (e.g. the crude spike rule), and combined as
 * sum(w z) / sqrt(w' R w). `X` rows are days (oldest first), columns are the
 * risk-off-signed daily log returns.
 */
export function compositeHistory(
  X: number[][],
  w: number[],
  R: number[][],
  volWindow = 20,
  transform?: (j: number, z: number) => number,
): number[] {
  const out: number[] = [];
  const p = w.length;
  for (let t = volWindow; t < X.length; t++) {
    const z: number[] = [];
    let ok = true;
    for (let j = 0; j < p; j++) {
      const col: number[] = [];
      for (let k = t - volWindow; k < t; k++) col.push(X[k][j]);
      const m = col.reduce((a, b) => a + b, 0) / col.length;
      const sd = Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / (col.length - 1));
      if (!(sd > 0)) { ok = false; break; }
      const zj = X[t][j] / sd;
      z.push(transform ? transform(j, zj) : zj);
    }
    if (!ok) continue;
    const c = standardizedComposite(w, z, R);
    if (c) out.push(c.z);
  }
  return out;
}

/** Covariance to correlation. */
export function toCorrelation(cov: number[][]): number[][] {
  const sd = cov.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  return cov.map((row, i) => row.map((v, j) => (sd[i] > 0 && sd[j] > 0 ? v / (sd[i] * sd[j]) : i === j ? 1 : 0)));
}

/**
 * Standardized weighted composite: sum(w_i z_i) / sqrt(w' R w). With R the
 * correlation of unit-variance inputs this is N(0,1) under the null. Also
 * returns the plain weighted mean for reference and the effective number of
 * independent inputs, (sum w)^2 / (w' R w) (equals the count for equal
 * weights and R = I, and 1 for perfectly correlated inputs).
 */
export function standardizedComposite(
  w: number[],
  z: number[],
  R: number[][],
): { z: number; sd: number; weightedMean: number; effectiveN: number } | null {
  const k = w.length;
  if (!k || z.length !== k || R.length !== k) return null;
  let num = 0;
  let wsum = 0;
  for (let i = 0; i < k; i++) { num += w[i] * z[i]; wsum += w[i]; }
  let q = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) q += w[i] * w[j] * R[i][j];
  if (!(q > 0) || !(wsum > 0)) return null;
  const sd = Math.sqrt(q);
  return { z: num / sd, sd, weightedMean: num / wsum, effectiveN: (wsum * wsum) / q };
}
