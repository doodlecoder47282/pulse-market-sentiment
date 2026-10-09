// server/tickerConeMath.ts
//
// Pure math for the single-name forward cone (server/tickerProjection.ts),
// round 3 item N3-1. No DB, network or package imports (unit tested in
// tests/quant/r3-1.test.ts).
//
// The cone is the index cone's model (server/multiDayProjection.ts) with the
// stock's OWN implied volatility instead of VIX-scaled realized volatility:
//
//   log(S_n / S_0) = sd_n x Z_n,   Z_n = (sum of n iid unit-variance
//   Student-t(nu = 4) daily shocks) / sqrt(n),   zero drift (median = spot),
//
// where sd_n^2 = w(T_n) is the ATM total implied variance to the close of
// session n, T_n in calendar years (the convention the option IVs are quoted
// in), interpolated linearly in total variance between listed expiries:
//   w(T) = sigma_ATM(T)^2 x T.
// Linear interpolation in total variance, and a total variance that does not
// decrease with T (no calendar-spread arbitrage at the money), is the standard
// treatment: J. Gatheral, "The Volatility Surface: A Practitioner's Guide",
// Wiley 2006, ch. 3; Gatheral & Jacquier, "Arbitrage-free SVI volatility
// surfaces", Quantitative Finance 14(1), 2014, Lemma 2.1 / Def. 2.1
// (calendar-spread arbitrage free iff total variance is non-decreasing in T),
// https://arxiv.org/abs/1204.0646. Before the first and after the last listed
// expiry the ATM vol is held flat (w = sigma^2 T).
//
// The t(4) daily shock follows the index cone (tail index 2-5 for daily
// returns: R. Cont, "Empirical properties of asset returns: stylized facts
// and statistical issues", Quantitative Finance 1(2), 2001). The n-fold
// convolution for long horizons (the ticker cone goes to 120 sessions) is
// done with an FFT on a fixed grid (the index cone's direct convolution is
// O(n^2) and takes ~17 s at n = 60). Agreement with the direct convolution
// (multiDayProjection.studentTSumQuantile) and with the closed-form t(4)
// quantile at n = 1 is tested.
//
// Coverage of these bands has NOT been tested on held-out data: they are
// heuristic bands, not calibrated probabilities. The implied vol carries the
// variance risk premium and any scheduled event (earnings) inside the
// horizon; both are the market's price, not a realized-vol forecast.

// ─── Student-t(nu) sum quantiles via FFT ─────────────────────────────────────

function logGamma(x: number): number {
  // Lanczos g = 7, n = 9 (Numerical Recipes 3rd ed., sec. 6.1); same as the index cone.
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function tPdf(x: number, nu: number): number {
  const lg = logGamma((nu + 1) / 2) - logGamma(nu / 2) - 0.5 * Math.log(nu * Math.PI);
  return Math.exp(lg - ((nu + 1) / 2) * Math.log(1 + (x * x) / nu));
}

/** In-place iterative radix-2 complex FFT (sign -1 forward, +1 inverse, unnormalised). */
function fft(re: Float64Array, im: Float64Array, sign: 1 | -1): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export const TSUM_GRID_STEP = 0.05;
export const TSUM_GRID_SIZE = 16384; // +-409.6 sd: wrap-around mass < 1e-9 up to n = 120

const _tSumFftCache = new Map<string, Float64Array[]>();

/**
 * CDFs of S_n / sqrt(n) for n = 1..nMax, S_n the sum of n iid unit-variance
 * Student-t(nu) shocks (nu > 2), on the grid x_i = i h (i centred at 0,
 * h = TSUM_GRID_STEP), as cumulative pmf at the cell upper edges. The one-day
 * pmf is the density at the grid points x h, renormalised; the n-day pmf is
 * IFFT(FFT(pmf)^n) (circular convolution, the grid is wide enough that the
 * wrap-around mass is negligible). Cached per (nu, nMax).
 */
function tSumCdfsFft(nu: number, nMax: number): Float64Array[] {
  const key = `${nu}:${nMax}`;
  const hit = _tSumFftCache.get(key);
  if (hit) return hit;
  const N = TSUM_GRID_SIZE, h = TSUM_GRID_STEP;
  const scale = Math.sqrt((nu - 2) / nu); // X = scale x T_nu has unit variance
  const re = new Float64Array(N), im = new Float64Array(N);
  let tot = 0;
  for (let i = 0; i < N; i++) {
    const k = i < N / 2 ? i : i - N; // wrap-around index: x = k h
    const v = (tPdf((k * h) / scale, nu) / scale) * h;
    re[i] = v; tot += v;
  }
  for (let i = 0; i < N; i++) re[i] /= tot;
  fft(re, im, -1);
  const out: Float64Array[] = [];
  for (let n = 1; n <= nMax; n++) {
    // F^n via polar form
    const pr = new Float64Array(N), pi = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const mod = Math.hypot(re[i], im[i]);
      const arg = Math.atan2(im[i], re[i]);
      const m = Math.pow(mod, n);
      pr[i] = m * Math.cos(n * arg);
      pi[i] = m * Math.sin(n * arg);
    }
    fft(pr, pi, 1);
    // unwrap to ascending x: k = -N/2 .. N/2 - 1; pmf = pr / N, clipped at 0
    const cdf = new Float64Array(N);
    let c = 0;
    for (let j = 0; j < N; j++) {
      const k = j - N / 2;
      const idx = k < 0 ? k + N : k;
      c += Math.max(0, pr[idx] / N);
      cdf[j] = c;
    }
    for (let j = 0; j < N; j++) cdf[j] /= c;
    out.push(cdf);
  }
  _tSumFftCache.set(key, out);
  return out;
}

/**
 * P-quantile of the standardised n-day sum (S_n / sqrt(n)) of unit-variance
 * Student-t(nu) shocks, for n up to nMax (FFT; see tSumCdfsFft). Same
 * quantity as multiDayProjection.studentTSumQuantile, usable at n = 120.
 */
export function studentTSumQuantileFft(p: number, n: number, nu = 4, nMax = Math.max(1, Math.round(n))): number {
  const nn = Math.round(n);
  if (!(p > 0 && p < 1) || !(nn >= 1) || !(nu > 2) || nn > nMax) return NaN;
  const cdf = tSumCdfsFft(nu, nMax)[nn - 1];
  const N = TSUM_GRID_SIZE, h = TSUM_GRID_STEP;
  // cdf[j] = P(S_n <= x_j + h/2), x_j = (j - N/2) h
  let lo = 0, hi = N - 1;
  if (p <= cdf[0]) return ((-N / 2 + 0.5) * h) / Math.sqrt(nn);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < p) lo = mid; else hi = mid;
  }
  const t = (p - cdf[lo]) / Math.max(1e-300, cdf[hi] - cdf[lo]);
  const xLo = (lo - N / 2 + 0.5) * h;
  return (xLo + t * h) / Math.sqrt(nn);
}

/** Closed-form Student-t(4) quantile (standard, not unit variance): Shaw (2006), nu = 4. */
export function studentT4Quantile(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  const a = 4 * p * (1 - p);
  const q = Math.cos(Math.acos(Math.sqrt(a)) / 3) / Math.sqrt(a);
  return Math.sign(p - 0.5) * 2 * Math.sqrt(Math.max(0, q - 1));
}

// ─── ATM implied-vol term structure ──────────────────────────────────────────

export interface AtmIvPoint {
  expiry: string;      // YYYY-MM-DD
  T: number;           // years to settlement (calendar clock)
  atmIv: number;       // decimal
  /** Total variance sigma^2 T as quoted, before the monotone fix. */
  w: number;
}

type ExpMap = Record<string, Record<string, any[]>> | null | undefined;

/**
 * ATM implied vol per expiry from a Schwab chain: at the two listed strikes
 * bracketing spot, the mean of the call and put `volatility` (percent, the
 * -999 sentinel and absurd values dropped), linearly interpolated in strike
 * to spot (nearest strike when spot is outside the listed strikes).
 * @param tYears  years to settlement for an expiry key and one of its contracts
 */
export function atmIvTermFromChain(
  chain: { callExpDateMap?: ExpMap; putExpDateMap?: ExpMap },
  spot: number,
  tYears: (expKey: string, contract: any) => number,
): AtmIvPoint[] {
  if (!(spot > 0)) return [];
  const keys = Array.from(new Set([
    ...Object.keys(chain.callExpDateMap ?? {}),
    ...Object.keys(chain.putExpDateMap ?? {}),
  ])).sort();
  const out: AtmIvPoint[] = [];
  for (const key of keys) {
    const byStrike = new Map<number, number[]>();
    let anyContract: any = null;
    for (const map of [chain.callExpDateMap, chain.putExpDateMap]) {
      const strikes = map?.[key] ?? {};
      for (const sk of Object.keys(strikes)) {
        const k = parseFloat(sk);
        if (!Number.isFinite(k) || k <= 0) continue;
        for (const c of strikes[sk] ?? []) {
          anyContract = anyContract ?? c;
          const v = Number(c?.volatility);
          if (Number.isFinite(v) && v > 0 && v < 500) {
            const arr = byStrike.get(k) ?? [];
            arr.push(v / 100);
            byStrike.set(k, arr);
          }
        }
      }
    }
    if (!byStrike.size || !anyContract) continue;
    const ks = Array.from(byStrike.keys()).sort((a, b) => a - b);
    const ivAt = (k: number) => { const a = byStrike.get(k)!; return a.reduce((s, x) => s + x, 0) / a.length; };
    let iv: number;
    const below = ks.filter((k) => k <= spot), above = ks.filter((k) => k >= spot);
    if (below.length && above.length) {
      const k0 = below[below.length - 1], k1 = above[0];
      iv = k1 === k0 ? ivAt(k0) : ivAt(k0) + (ivAt(k1) - ivAt(k0)) * (spot - k0) / (k1 - k0);
    } else {
      iv = ivAt(below.length ? below[below.length - 1] : above[0]);
    }
    const T = tYears(key, anyContract);
    if (!(T > 0) || !(iv > 0)) continue;
    out.push({ expiry: key.split(":")[0], T, atmIv: iv, w: iv * iv * T });
  }
  return out.sort((a, b) => a.T - b.T);
}

/**
 * ATM total implied variance w(T): linear in T between listed expiries, on
 * the running maximum of the listed w (a decrease would be a calendar-spread
 * arbitrage; Gatheral & Jacquier 2014), flat vol before the first and after
 * the last expiry. null without any expiry.
 */
export function totalVarianceAt(term: AtmIvPoint[], T: number): number | null {
  if (!term.length || !(T > 0)) return term.length ? 0 : null;
  const pts: Array<{ T: number; w: number }> = [];
  let wMax = 0;
  for (const p of term) { wMax = Math.max(wMax, p.w); pts.push({ T: p.T, w: wMax }); }
  if (T <= pts[0].T) return (pts[0].w / pts[0].T) * T;
  const last = pts[pts.length - 1];
  if (T >= last.T) return (last.w / last.T) * T;
  for (let i = 1; i < pts.length; i++) {
    if (T <= pts[i].T) {
      const a = pts[i - 1], b = pts[i];
      return a.w + (b.w - a.w) * (T - a.T) / (b.T - a.T);
    }
  }
  return (last.w / last.T) * T;
}

// ─── Cone bands ──────────────────────────────────────────────────────────────

export const CONE_PROBS_TICKER = { q10: 0.10, q25: 0.25, q75: 0.75, q90: 0.90 } as const;

/**
 * Cone band prices for session n with total log variance w: median = spot
 * (zero drift), qP = spot x exp(z_P(n) sqrt(w)), z_P(n) the standardised
 * t(nu)-sum quantile.
 */
export function coneBandsFromVariance(spot: number, w: number, n: number, nMax: number, nu = 4) {
  const sd = Math.sqrt(Math.max(0, w));
  const z = (p: number) => studentTSumQuantileFft(p, n, nu, nMax) * sd;
  return {
    q10: spot * Math.exp(z(0.10)),
    q25: spot * Math.exp(z(0.25)),
    q50: spot,
    q75: spot * Math.exp(z(0.75)),
    q90: spot * Math.exp(z(0.90)),
  };
}
