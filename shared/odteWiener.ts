// shared/odteWiener.ts
//
// The 0DTE Wiener baseline for the rest of TODAY's session. Pure.
//
// Model: arithmetic Brownian motion (a Wiener process in price points) with
// ZERO drift, from the current price to today's close:
//     X(t) = S + sigma * W(t),   Var X(T) = sigmaToClose^2
// sigmaToClose is the market's own 1-sigma move to the close, taken from the
// 0DTE chain's at-the-money implied volatility (server/odteForward.ts), with
// the at-the-money straddle as a cross-check. Variance is spread evenly over
// the remaining trading minutes (no time-of-day weighting in this version).
//
// Every output is a property of that stated model, not a forecast:
//   bands       percentiles of the price at each time (not paths);
//   levels      for each map level, the chance it is touched before the close
//               (exact first-passage probability for this model) and the
//               chance the close ends above or below it;
//   expected    expected remaining high, low and range;
//   closeDist   the model's close distribution in strike-width buckets.
// Nothing here uses dealer positioning; that overlay is drawn separately and
// labelled as a heuristic.

export const WIENER_MODEL = "arithmetic Brownian motion (Wiener), zero drift, sigma from the 0DTE chain's implied volatility";

/** Standard normal CDF via the Numerical Recipes erfcc approximation (fractional error < 1.2e-7). */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  // erfc via Numerical Recipes erfcc (fractional error < 1.2e-7).
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r / 2 : r / 2;
}

/**
 * Probability that X(t) = mu*t + sigma*W(t), started at 0, reaches level a > 0
 * by time T (first passage, drift mu, per-unit-time sigma):
 *   P = Phi((mu*T - a)/(sigma*sqrt T)) + exp(2*mu*a/sigma^2) * Phi((-mu*T - a)/(sigma*sqrt T))
 * With mu = 0 this is 2*(1 - Phi(a/(sigma*sqrt T))) (the reflection principle).
 * Only valid for this model; it is not a conversion of arbitrary scenario weights.
 */
export function hitProbability(a: number, mu: number, sigma: number, T: number): number {
  if (a <= 0) return 1;
  if (!(T > 0)) return 0;
  // No noise: the path is the straight line mu*t.
  if (!(sigma > 0)) return mu * T >= a ? 1 : 0;
  const sT = sigma * Math.sqrt(T);
  if (mu === 0) return Math.min(1, Math.max(0, 2 * (1 - normCdf(a / sT))));
  // Second term in log space: exp(2 mu a / sigma^2) overflows long before the product does.
  const logE = (2 * mu * a) / (sigma * sigma);
  const second = Math.exp(logE + logNormCdf((-mu * T - a) / sT));
  const p = normCdf((mu * T - a) / sT) + (Number.isFinite(second) ? second : 0);
  return Math.min(1, Math.max(0, p));
}

/** log Phi(x), accurate in the far left tail (asymptotic series below -8). */
export function logNormCdf(x: number): number {
  if (x > -8) return Math.log(normCdf(x));
  const x2 = x * x;
  return -x2 / 2 - Math.log(-x) - 0.5 * Math.log(2 * Math.PI) + Math.log(1 - 1 / x2 + 3 / (x2 * x2));
}

/** z-scores of the band percentiles. */
export const BAND_Z = { p025: -1.959964, p10: -1.281552, p25: -0.67449, p50: 0, p75: 0.67449, p90: 1.281552, p975: 1.959964 } as const;
export type BandKey = keyof typeof BAND_Z;

export interface WienerBandPoint {
  /** Minutes from the start of the projection. */
  minute: number;
  /** ET clock "HH:MM". */
  et: string;
  q: Record<BandKey, number>;
}

export interface WienerLevelIn {
  price: number;
  kind: string;
  label: string;
  /** Already traded through earlier today (from the session's own bars). */
  touchedToday?: boolean;
}

export interface WienerLevel {
  price: number;
  kind: string;
  label: string;
  side: "above" | "below" | "at";
  /** Signed points from the current price. */
  distance: number;
  /** |distance| in units of sigmaToClose. */
  distanceSigma: number;
  /** Chance of trading at the level before the close under the model (1 when at the price). */
  pTouch: number;
  /** Chance the close ends above / below the level under the model. */
  pCloseAbove: number;
  pCloseBelow: number;
  touchedToday: boolean;
}

export interface WienerCloseBucket {
  /** null = open-ended tail. */
  lo: number | null;
  hi: number | null;
  p: number;
}

export interface WienerMap {
  state: "ok" | "unavailable";
  reason: string | null;
  model: string;
  /** Session the projection covers: today's remaining session, or the next full session when the market is closed. */
  horizon: "rest_of_today" | "next_session";
  spot: number | null;
  /** 1-sigma move to the close in points under the model. */
  sigmaToClose: number | null;
  /** Where sigma came from. */
  sigmaSource: "atm_iv" | "atm_straddle" | null;
  /** sigma implied by the ATM straddle (straddle / sqrt(2/pi)), for comparison; null when no straddle. */
  sigmaFromStraddle: number | null;
  minutesLeft: number;
  bands: WienerBandPoint[];
  levels: WienerLevel[];
  expected: { high: number; low: number; range: number } | null;
  closeDist: WienerCloseBucket[];
  /** Plain-words limits the card shows. */
  caveats: string[];
}

export interface WienerInputs {
  spot: number | null;
  /** Market 1-sigma move to the close in points (from ATM IV), or null. */
  sigmaFromIv: number | null;
  /** ATM straddle mid in points, or null. */
  straddle: number | null;
  minutesLeft: number;
  /** ET minute-of-day where the projection starts (now intraday; 09:30 otherwise). */
  startAbsMin: number;
  horizon: "rest_of_today" | "next_session";
  /** true when the projection starts from the last price before the open (pre-open or next session). */
  fromPreviousClose?: boolean;
  /** Set by the caller when an input makes the model inapplicable (e.g. no expiry for today). */
  unavailableReason?: string | null;
  levels: WienerLevelIn[];
  /** Bucket width for the close distribution (strike spacing); default 5. */
  bucket?: number;
  /** Band spacing in minutes; default 5. */
  stepMin?: number;
}

const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI);
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const hhmm = (abs: number) => {
  const m = Math.round(abs);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export const WIENER_CAVEATS = [
  "a model of the remaining range under a random walk with the market's own implied volatility, not a forecast and not a direction",
  "real intraday moves have fatter tails and uneven time-of-day volatility than this model assumes",
  "touch odds are for trading at the level at least once before the close; they say nothing about holding it",
];

export function wienerMap(i: WienerInputs): WienerMap {
  const base = {
    model: WIENER_MODEL, horizon: i.horizon, minutesLeft: Math.max(0, Math.round(i.minutesLeft)),
    bands: [] as WienerBandPoint[], levels: [] as WienerLevel[], expected: null, closeDist: [] as WienerCloseBucket[], caveats: WIENER_CAVEATS,
  };
  const spot = typeof i.spot === "number" && Number.isFinite(i.spot) && i.spot > 0 ? i.spot : null;
  const sIv = typeof i.sigmaFromIv === "number" && Number.isFinite(i.sigmaFromIv) && i.sigmaFromIv > 0 ? i.sigmaFromIv : null;
  const strad = typeof i.straddle === "number" && Number.isFinite(i.straddle) && i.straddle > 0 ? i.straddle : null;
  // ATM straddle under this model: E|X(T) - S| = sigma * sqrt(2/pi).
  const sStrad = strad != null ? strad / SQRT_2_OVER_PI : null;
  const sigma = sIv ?? sStrad;
  const sigmaSource = sIv != null ? "atm_iv" as const : sStrad != null ? "atm_straddle" as const : null;
  if (i.unavailableReason) return { ...base, state: "unavailable", reason: i.unavailableReason, spot, sigmaToClose: null, sigmaSource: null, sigmaFromStraddle: null };
  if (spot == null) return { ...base, state: "unavailable", reason: "no current price from the chain", spot: null, sigmaToClose: null, sigmaSource: null, sigmaFromStraddle: sStrad != null ? r2(sStrad) : null };
  if (sigma == null) return { ...base, state: "unavailable", reason: "no implied volatility or straddle from the 0DTE chain", spot, sigmaToClose: null, sigmaSource: null, sigmaFromStraddle: null };
  if (!(i.minutesLeft > 0)) return { ...base, state: "unavailable", reason: "no session time left to project", spot, sigmaToClose: r2(sigma), sigmaSource, sigmaFromStraddle: sStrad != null ? r2(sStrad) : null };

  const T = i.minutesLeft;
  const step = Math.max(1, Math.round(i.stepMin ?? 5));

  // Bands: percentile k at elapsed t is S + z_k * sigma * sqrt(t/T).
  const bands: WienerBandPoint[] = [];
  const times: number[] = [];
  for (let t = 0; t < T; t += step) times.push(t);
  times.push(T);
  for (const t of times) {
    const sd = sigma * Math.sqrt(t / T);
    const q = {} as Record<BandKey, number>;
    for (const k of Object.keys(BAND_Z) as BandKey[]) q[k] = r2(spot + BAND_Z[k] * sd);
    bands.push({ minute: t, et: hhmm(i.startAbsMin + t), q });
  }

  // Levels: exact first passage (driftless) and close odds, per level.
  const seen = new Set<string>();
  const levels: WienerLevel[] = [];
  for (const L of i.levels ?? []) {
    if (!L || !Number.isFinite(L.price) || L.price <= 0) continue;
    const key = `${L.kind}:${L.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = L.price - spot;
    const at = Math.abs(d) < 1e-9;
    const pAbove = 1 - normCdf((L.price - spot) / sigma);
    levels.push({
      price: L.price, kind: L.kind, label: L.label,
      side: at ? "at" : d > 0 ? "above" : "below",
      distance: r2(d),
      distanceSigma: r2(Math.abs(d) / sigma),
      // Per-unit-time sigma is sigma/sqrt(T); hitProbability(a, 0, sigma/sqrt T, T) = 2(1 - Phi(a/sigma)).
      pTouch: at ? 1 : r4(hitProbability(Math.abs(d), 0, sigma / Math.sqrt(T), T)),
      pCloseAbove: r4(pAbove),
      pCloseBelow: r4(1 - pAbove),
      touchedToday: L.touchedToday === true,
    });
  }
  levels.sort((a, b) => b.price - a.price);

  // Expected remaining high / low / range of a driftless Brownian motion:
  // E[max] - S = sigma * sqrt(2/pi), E[min] symmetric, E[range] = 2 * sigma * sqrt(2/pi).
  const ext = sigma * SQRT_2_OVER_PI;
  const expected = { high: r2(spot + ext), low: r2(spot - ext), range: r2(2 * ext) };

  // Close distribution in strike-width buckets across +-3 sigma, plus both tails.
  const w = i.bucket && i.bucket > 0 ? i.bucket : 5;
  const lo = Math.floor((spot - 3 * sigma) / w) * w;
  const hi = Math.ceil((spot + 3 * sigma) / w) * w;
  const cdf = (x: number) => normCdf((x - spot) / sigma);
  const closeDist: WienerCloseBucket[] = [{ lo: null, hi: lo, p: r4(cdf(lo)) }];
  for (let a = lo; a < hi; a += w) closeDist.push({ lo: a, hi: a + w, p: r4(cdf(a + w) - cdf(a)) });
  closeDist.push({ lo: hi, hi: null, p: r4(1 - cdf(hi)) });

  const caveats = i.fromPreviousClose
    ? [...WIENER_CAVEATS, "projected from the last price before the open: the overnight part of the implied move is spread across the session as if it traded continuously, so an opening gap is not modelled and a level a gap jumps over counts as touched"]
    : WIENER_CAVEATS;
  return {
    ...base, caveats, state: "ok", reason: null, spot, sigmaToClose: r2(sigma), sigmaSource,
    sigmaFromStraddle: sStrad != null ? r2(sStrad) : null,
    bands, levels, expected, closeDist,
  };
}

// ─── Scorecard: did the morning odds match what happened? ──────────────────

export interface WienerLevelOutcome {
  price: number;
  kind: string;
  pTouch: number;
  touched: boolean;
  pCloseAbove: number;
  closedAbove: boolean;
}

/**
 * Score a morning snapshot against the day: a level counts as touched when
 * the session's high (for levels above) or low (for levels below) reached it
 * AFTER the snapshot. Levels already touched before the snapshot, or at the
 * price, are left out (their odds were not a forward statement).
 * `highAfter`/`lowAfter` must be the extremes from the snapshot time to the close.
 */
export function scoreWienerDay(snapshot: Pick<WienerMap, "state" | "spot" | "levels">, day: { settle: number; highAfter: number; lowAfter: number }): WienerLevelOutcome[] {
  if (snapshot.state !== "ok" || snapshot.spot == null) return [];
  if (!(day.settle > 0) || !(day.highAfter >= day.lowAfter)) return [];
  const out: WienerLevelOutcome[] = [];
  for (const L of snapshot.levels) {
    if (L.touchedToday || L.side === "at") continue;
    const touched = L.side === "above" ? day.highAfter >= L.price : day.lowAfter <= L.price;
    out.push({ price: L.price, kind: L.kind, pTouch: L.pTouch, touched, pCloseAbove: L.pCloseAbove, closedAbove: day.settle > L.price });
  }
  return out;
}

export interface CalibrationBucket {
  /** Stated odds range, inclusive low, exclusive high (the last bucket includes 1). */
  lo: number;
  hi: number;
  n: number;
  /** Mean stated odds in the bucket. */
  stated: number | null;
  /** Share that happened. */
  observed: number | null;
}

export interface WienerScorecard {
  days: number;
  touch: { n: number; buckets: CalibrationBucket[]; brier: number | null; brierBaseRate: number | null };
  close: { n: number; buckets: CalibrationBucket[]; brier: number | null; brierBaseRate: number | null };
  /** Below this many days the card says the odds are untested. */
  minDays: number;
  tested: boolean;
}

export const SCORECARD_MIN_DAYS = 50;
const EDGES = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1];

function calibrate(pairs: Array<{ p: number; hit: boolean }>): { n: number; buckets: CalibrationBucket[]; brier: number | null; brierBaseRate: number | null } {
  const buckets: CalibrationBucket[] = [];
  for (let k = 0; k < EDGES.length - 1; k++) {
    const lo = EDGES[k], hi = EDGES[k + 1];
    const inB = pairs.filter((x) => x.p >= lo && (k === EDGES.length - 2 ? x.p <= hi : x.p < hi));
    buckets.push({
      lo, hi, n: inB.length,
      stated: inB.length ? r4(inB.reduce((s, x) => s + x.p, 0) / inB.length) : null,
      observed: inB.length ? r4(inB.filter((x) => x.hit).length / inB.length) : null,
    });
  }
  const brier = pairs.length ? r4(pairs.reduce((s, x) => s + (x.p - (x.hit ? 1 : 0)) ** 2, 0) / pairs.length) : null;
  // Reference: the Brier score of always stating the observed base rate (a skill-free forecast).
  const base = pairs.length ? pairs.filter((x) => x.hit).length / pairs.length : null;
  return { n: pairs.length, buckets, brier, brierBaseRate: base == null ? null : r4(base * (1 - base)) };
}

/** Running scorecard over scored days. Counts, not a claim of edge. */
export function wienerScorecard(days: WienerLevelOutcome[][]): WienerScorecard {
  const scored = days.filter((d) => d.length > 0);
  const flat = scored.flat();
  return {
    days: scored.length,
    touch: calibrate(flat.map((x) => ({ p: x.pTouch, hit: x.touched }))),
    close: calibrate(flat.map((x) => ({ p: x.pCloseAbove, hit: x.closedAbove }))),
    minDays: SCORECARD_MIN_DAYS,
    tested: scored.length >= SCORECARD_MIN_DAYS,
  };
}
