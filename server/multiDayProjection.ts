import { vixToAtmPct } from "@shared/vol";
// server/multiDayProjection.ts
//
// Multi-day forward vol cone for SPX / SPY.
//
// This is NOT a trained ML model. It's a realized-vol cone with regime
// adjustment — labeled honestly. Bands (log price, n sessions ahead):
//   qP = ln(spot) + z_P(n) * sigma * sqrt(n),  P in {1,5,10,25,75,90,95,99}%
// where z_P(n) is the P-quantile of the standardised sum of n iid
// unit-variance Student-t(nu = 4) daily shocks (studentTSumQuantile below).
// Why Student-t: daily index returns have power-law tails with tail index
// "higher than two and less than five for most data sets" (R. Cont, 2001,
// "Empirical properties of asset returns: stylized facts and statistical
// issues", Quantitative Finance 1(2), 223-236,
// https://ideas.repec.org/a/taf/quantf/v1y2001i2p223-236.html; quoted in
// arXiv:2311.07738). A t with nu degrees of freedom has tail index nu.
// Scaled to unit variance, its two-sided tail probability crosses the
// normal's at about 1.95 sigma (P(|X| > 1.955) = 5.06% for both; numerical
// root of the two survival functions): inside that the t is NARROWER (its
// 10/90% quantiles are +-1.085 vs +-1.282), beyond it wider (1/99%: +-2.65 vs
// +-2.33). The n-day sum converges to normal (central limit), so the honest
// fat-tail content is in q01/q99 (and q05/q95) at short horizons. Not modelled: volatility clustering (GARCH-type), which is
// what fattens multi-day tails in stressed regimes. Coverage of these bands
// has NOT been tested on held-out data: they are not "calibrated".
//
// sigma is the realized daily log-return stdev from the last 30 sessions,
// scaled by the VIX/realized ratio when available (vol-of-vol overlay).
//
// Drift: zero (the q50 line is spot). Earlier code carried 0.5 x the median
// of the last 10 daily log returns forward; there is no evidence that
// one-to-two-week index momentum is strong enough for that (at 1-4 week
// horizons the documented effect is, if anything, short-term reversal:
// Lehmann 1990, "Fads, Martingales, and Market Efficiency", QJE 105(1);
// Jegadeesh 1990, "Evidence of Predictable Behavior of Security Returns",
// J. Finance 45(3)). The risk-neutral alternative, r - q, is ~3%/yr, i.e.
// ~0.1% over 10 sessions, an order of magnitude inside the q25-q75 band, so
// the martingale (zero) drift is used and stated.
//
// Output: bands for N=1..10 trading days forward.

export type ConeBand = {
  day: number;          // 1..10 forward sessions
  date: string;         // approximate ISO date (calendar — not skipping weekends)
  q01?: number;         // Student-t tail bands (see header)
  q05?: number;
  q10: number;
  q25: number;
  q50: number;          // median: spot (zero drift)
  q75: number;
  q90: number;
  q95?: number;
  q99?: number;
};

export type MultiDayConeResp = {
  symbol: string;
  spot: number;
  asOfTs: number;
  sigmaDaily: number;     // realized daily stdev (log returns)
  sigmaAnnualizedPct: number;
  driftDaily: number;     // log return per day: 0 (martingale; see header)
  driftBasis?: string;
  tailModel?: string;
  volBlowupFactor: number; // VIX/realized ratio applied to σ (1.0 if no VIX)
  bands: ConeBand[];
  source: "realized_vol_cone";
  honestyNote: string;
  computedAt: string;
};

// ─── Pure helpers (no I/O; tested in tests/quant/options-r2.test.ts) ───────

/** Degrees of freedom of the Student-t daily shock (tail index 4; Cont 2001: 2-5). */
export const CONE_T_DOF = 4;

/** Student-t(nu) density. */
function tPdf(x: number, nu: number): number {
  // Gamma((nu+1)/2) / (sqrt(nu pi) Gamma(nu/2)) via log-gamma (Lanczos).
  const lg = logGamma((nu + 1) / 2) - logGamma(nu / 2) - 0.5 * Math.log(nu * Math.PI);
  return Math.exp(lg - ((nu + 1) / 2) * Math.log(1 + (x * x) / nu));
}

/** log Gamma(x), Lanczos g = 7, n = 9 (Numerical Recipes 3rd ed., sec. 6.1). */
function logGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const _tSumCache = new Map<string, { x: number[]; cdf: number[] }>();

/**
 * CDF of S_n / sqrt(n), S_n the sum of n iid Student-t(nu) shocks scaled to
 * unit variance (nu > 2): numerical n-fold convolution of the density on a
 * uniform grid (step 0.05; one-day support +-25 sd, mass beyond ~1e-5 for
 * nu = 4), trapezoid CDF renormalised to 1. Cached per (nu, n).
 */
function tSumCdf(nu: number, n: number): { x: number[]; cdf: number[] } {
  const key = `${nu}:${n}`;
  const hit = _tSumCache.get(key);
  if (hit) return hit;
  const scale = Math.sqrt((nu - 2) / nu); // unit-variance t: X = scale * T_nu
  const h = 0.05;
  const half1 = Math.round(25 / h);
  const f1 = new Float64Array(2 * half1 + 1);
  for (let i = 0; i < f1.length; i++) f1[i] = tPdf(((i - half1) * h) / scale, nu) / scale;
  let half = half1;
  let f = Float64Array.from(f1);
  // Build every k = 1..n in one pass and cache each (the cone asks for 1..10).
  for (let k = 1; k <= n; k++) {
    if (k > 1) {
      const newHalf = half + half1;
      const g = new Float64Array(2 * newHalf + 1);
      // g(x) = sum_j f(x_j) f1(x - x_j) h
      for (let j = 0; j < f.length; j++) {
        const fj = f[j] * h;
        if (fj === 0) continue;
        const base = j - half + newHalf - half1; // index in g of x_j - L1
        for (let i = 0; i < f1.length; i++) g[base + i] += fj * f1[i];
      }
      f = g;
      half = newHalf;
    }
    const kKey = `${nu}:${k}`;
    if (_tSumCache.has(kKey)) continue;
    const x: number[] = [], cdf: number[] = [];
    let c = 0;
    const sq = Math.sqrt(k);
    for (let i = 0; i < f.length; i++) {
      if (i > 0) c += 0.5 * (f[i] + f[i - 1]) * h;
      x.push(((i - half) * h) / sq);
      cdf.push(c);
    }
    for (let i = 0; i < cdf.length; i++) cdf[i] /= c;
    _tSumCache.set(kKey, { x, cdf });
  }
  return _tSumCache.get(key)!;
}

/** P-quantile of the standardised n-day sum of unit-variance Student-t(nu) shocks. */
export function studentTSumQuantile(p: number, n: number, nu: number = CONE_T_DOF): number {
  if (!(p > 0 && p < 1) || !(n >= 1) || !(nu > 2)) return NaN;
  const { x, cdf } = tSumCdf(nu, Math.round(n));
  let lo = 0, hi = cdf.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < p) lo = mid; else hi = mid;
  }
  const t = (p - cdf[lo]) / Math.max(1e-300, cdf[hi] - cdf[lo]);
  return x[lo] + t * (x[hi] - x[lo]);
}

export const CONE_PROBS = [0.01, 0.05, 0.10, 0.25, 0.75, 0.90, 0.95, 0.99] as const;

/** Cone band prices n sessions ahead: spot x exp(z_P(n) sigma sqrt(n)), zero drift. */
export function coneBandPrices(spot: number, sigmaDaily: number, n: number, nu: number = CONE_T_DOF) {
  const z = (p: number) => studentTSumQuantile(p, n, nu) * sigmaDaily * Math.sqrt(n);
  return {
    q01: spot * Math.exp(z(0.01)),
    q05: spot * Math.exp(z(0.05)),
    q10: spot * Math.exp(z(0.10)),
    q25: spot * Math.exp(z(0.25)),
    q50: spot,
    q75: spot * Math.exp(z(0.75)),
    q90: spot * Math.exp(z(0.90)),
    q95: spot * Math.exp(z(0.95)),
    q99: spot * Math.exp(z(0.99)),
  };
}

function nextWeekdayDate(start: Date, sessions: number): Date {
  const d = new Date(start);
  let added = 0;
  while (added < sessions) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sq = arr.reduce((s, x) => s + (x - mean) ** 2, 0);
  return Math.sqrt(sq / (arr.length - 1));
}

// 5min in-memory bars cache — keeps Models tab from racing pivot, ML accuracy,
// and multi-day cone for the same /pricehistory call when Schwab is saturated.
const _coneBarsCache = new Map<string, { ts: number; bars: { t: number; c: number }[] }>();
const CONE_BARS_TTL_MS = 5 * 60 * 1000;

export async function buildMultiDayCone(symbol: string): Promise<MultiDayConeResp> {
  const { getPriceHistory, getQuotes } = await import("./schwab");
  // Schwab uses $SPX for SPX
  const wireSym = symbol === "^GSPC" ? "$SPX" : symbol;

  // Pull 2 months of daily bars for σ estimation — cached with stale fallback
  // so a transient Schwab throttle doesn't blank the cone panel.
  let bars: { t: number; c: number }[] = [];
  const cached = _coneBarsCache.get(wireSym);
  if (cached && Date.now() - cached.ts < CONE_BARS_TTL_MS) {
    bars = cached.bars;
  } else {
    try {
      const resp = await getPriceHistory(wireSym, "month", 2, "daily", 1);
      bars = (resp?.candles || [])
        .filter((c: any) => c.close != null && isFinite(c.close))
        .map((c: any) => ({ t: c.datetime, c: c.close }));
      if (bars.length >= 15) {
        _coneBarsCache.set(wireSym, { ts: Date.now(), bars });
      }
    } catch (fetchErr: any) {
      if (cached) {
        console.log(`[multiDayCone] Schwab fetch failed for ${wireSym}, using stale cache (${cached.bars.length} bars)`);
        bars = cached.bars;
      } else {
        throw new Error(`Schwab fetch failed for ${symbol}: ${fetchErr?.message ?? fetchErr}`);
      }
    }
  }

  if (bars.length < 15) {
    // Last-resort fallback to any stale cache before throwing
    if (cached && cached.bars.length >= 15) {
      bars = cached.bars;
    } else {
      throw new Error(`insufficient bars for ${symbol} (${bars.length})`);
    }
  }

  // Log returns
  const logRets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    logRets.push(Math.log(bars[i].c / bars[i - 1].c));
  }
  // Use the last 30 returns for σ
  const recentRets = logRets.slice(-30);
  const sigmaDaily = std(recentRets);
  const sigmaAnnualizedPct = sigmaDaily * Math.sqrt(252) * 100;

  // Drift: zero (martingale); see the header for why the old 0.5 x 10-day
  // median momentum drift was removed.
  const driftDaily = 0;

  // Vol blowup = VIX / realized annualized (clamped 0.7..2.0)
  let volBlowupFactor = 1.0;
  try {
    const quotes = await getQuotes(["$VIX"]);
    const vix = quotes.find((q) => q.symbol === "$VIX")?.last;
    if (vix && sigmaAnnualizedPct > 0) {
      // true ATM vol vs realized — raw VIX overstates the blowup ratio ~1.15x
      const ratio = vixToAtmPct(vix) / sigmaAnnualizedPct;
      volBlowupFactor = Math.max(0.7, Math.min(2.0, ratio));
    }
  } catch {
    // VIX optional
  }
  const sigmaAdj = sigmaDaily * volBlowupFactor;

  const spot = bars[bars.length - 1].c;
  const asOfTs = bars[bars.length - 1].t;
  const now = new Date();

  const bands: ConeBand[] = [];
  for (let n = 1; n <= 10; n++) {
    bands.push({
      day: n,
      date: nextWeekdayDate(now, n).toISOString().slice(0, 10),
      ...coneBandPrices(spot, sigmaAdj, n),
    });
  }

  return {
    symbol,
    spot,
    asOfTs,
    sigmaDaily,
    sigmaAnnualizedPct,
    driftDaily,
    driftBasis: "zero drift (martingale): no evidence for 1-2 week index momentum; r - q over 10 sessions is ~0.1%, inside the noise",
    tailModel: `iid Student-t(${CONE_T_DOF}) daily shocks, unit variance (tail index ${CONE_T_DOF}; Cont 2001: 2-5); volatility clustering not modelled; band coverage not tested`,
    volBlowupFactor,
    bands,
    source: "realized_vol_cone",
    honestyNote:
      "Vol cone (not a trained ML model, coverage not tested). σ from 30d realized daily stdev; zero drift; Student-t(4) daily shocks for the tails (q01/q99), no volatility clustering. VIX/realized used as vol-blowup factor (clamped 0.7-2.0).",
    computedAt: new Date().toISOString(),
  };
}
