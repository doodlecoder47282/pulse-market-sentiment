// shared/impliedClose.ts
//
// The 0DTE chain's own close distribution, read from option mids. Pure.
//
// Breeden & Litzenberger (1978): for European calls, the risk-neutral density
// of the settlement price is the second derivative of the call price in the
// strike,  f(K) = d2C/dK2  (zero rate over the few hours left, so no
// discounting). On a strike grid of spacing w the density of the bucket
// (K_i - w/2, K_i + w/2) is the butterfly:
//
//     p_i ~= (C(K_{i-1}) - 2 C(K_i) + C(K_{i+1})) / w
//
// and the tail masses are the digital reads at the grid ends:
//     P(S_T < K_lo) = 1 + (C(K_lo) - C(K_lo - w)) / w   (= 1 - |slope| at the low end)
//     P(S_T > K_hi) = -(C(K_hi) - C(K_hi - w)) / w       (= |slope| at the high end)
// Put mids give the same density via put-call parity; the module uses calls
// above the spot and puts below (the out-of-the-money side, where mids are
// tighter), converting puts with C = P + S - K.
//
// What this is: the market's price-implied distribution of the settle, in
// the Wiener map's own strike buckets, so the two can be laid side by side.
// What it is not: a forecast, a direction, or a verdict on either model. A
// negative butterfly (a mid out of line) is clipped to zero and COUNTED; a
// chain with too many of them, or too few strikes, is unavailable with the
// reason, never a smoothed-over curve.

export interface StrikeQuote {
  strike: number;
  /** Call mid in points (bid/ask mid; 0 or null when no two-sided quote). */
  callMid: number | null;
  putMid: number | null;
}

export interface ImpliedCloseBucket {
  /** null = open-ended tail. */
  lo: number | null;
  hi: number | null;
  p: number;
}

export interface ImpliedClose {
  state: "ok" | "unavailable";
  reason: string | null;
  method: string;
  /** Strike spacing used (points). */
  bucket: number | null;
  /** Buckets in the SAME layout as the Wiener closeDist: low tail, inner buckets, high tail. */
  buckets: ImpliedCloseBucket[];
  /** Implied 1-sigma of the settle in points (sqrt of the distribution's variance), for the side-by-side. */
  sigma: number | null;
  /** Mean of the distribution (the market's forward for the settle), points. */
  mean: number | null;
  /** Strikes used, butterflies clipped at zero (mids out of line), tail masses. */
  diagnostics: { strikes: number; clipped: number; lowTail: number; highTail: number; renormalised: number };
}

export const IMPLIED_CLOSE_METHOD = "Breeden-Litzenberger butterflies on 0DTE option mids (calls above spot, puts below via parity), zero rate, no smoothing";

/** Fewer usable strikes than this: unavailable. */
export const MIN_STRIKES = 7;
/** More than this share of inner buckets clipped: unavailable (mids too ragged to read a density). */
export const MAX_CLIPPED_SHARE = 0.34;

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function impliedClose(spot: number, quotes: StrikeQuote[], bucket: number): ImpliedClose {
  const base = { method: IMPLIED_CLOSE_METHOD, bucket: bucket > 0 ? bucket : null, buckets: [] as ImpliedCloseBucket[], sigma: null, mean: null, diagnostics: { strikes: 0, clipped: 0, lowTail: 0, highTail: 0, renormalised: 0 } };
  if (!(spot > 0)) return { ...base, state: "unavailable", reason: "no spot" };
  if (!(bucket > 0)) return { ...base, state: "unavailable", reason: "no strike spacing" };
  // One call price per grid strike: the OTM side's mid, puts converted by parity.
  const byStrike = new Map<number, number>();
  for (const q of quotes) {
    if (!Number.isFinite(q.strike) || q.strike <= 0) continue;
    // Snap to the grid: strikes off the spacing are not comparable neighbours.
    if (Math.abs(q.strike / bucket - Math.round(q.strike / bucket)) > 1e-6) continue;
    const useCall = q.strike >= spot;
    const c = useCall
      ? (q.callMid != null && q.callMid > 0 ? q.callMid : null)
      : (q.putMid != null && q.putMid > 0 ? q.putMid + spot - q.strike : null);
    if (c == null || !Number.isFinite(c) || c < 0) continue;
    byStrike.set(q.strike, c);
  }
  const ks = [...byStrike.keys()].sort((a, b) => a - b);
  // Longest run of consecutive grid strikes around the spot: a gap breaks the
  // butterflies, so only a contiguous run is read.
  let best: number[] = [], run: number[] = [];
  for (let i = 0; i < ks.length; i++) {
    if (run.length && Math.abs(ks[i] - ks[i - 1] - bucket) > 1e-6) { if (run.length > best.length) best = run; run = []; }
    run.push(ks[i]);
  }
  if (run.length > best.length) best = run;
  if (best.length < MIN_STRIKES) return { ...base, state: "unavailable", reason: `${best.length} consecutive strikes with two-sided mids; ${MIN_STRIKES} needed`, diagnostics: { ...base.diagnostics, strikes: best.length } };
  const C = (k: number) => byStrike.get(k) as number;
  const n = best.length;
  // Inner buckets centred on each interior strike: (K - w/2, K + w/2).
  const inner: ImpliedCloseBucket[] = [];
  let clipped = 0;
  for (let i = 1; i < n - 1; i++) {
    const k = best[i];
    const fly = (C(best[i - 1]) - 2 * C(k) + C(best[i + 1])) / bucket;
    if (fly < 0) clipped++;
    inner.push({ lo: k - bucket / 2, hi: k + bucket / 2, p: Math.max(0, fly) });
  }
  if (clipped / inner.length > MAX_CLIPPED_SHARE) {
    return { ...base, state: "unavailable", reason: `${clipped} of ${inner.length} butterflies negative: mids too ragged to read a density`, diagnostics: { ...base.diagnostics, strikes: n, clipped } };
  }
  // Tails from the end slopes (digital reads), clipped to [0, 1].
  const lowSlope = (C(best[1]) - C(best[0])) / bucket;   // in (-1, 0)
  const highSlope = (C(best[n - 1]) - C(best[n - 2])) / bucket;
  const lowTail = Math.min(1, Math.max(0, 1 + lowSlope));
  const highTail = Math.min(1, Math.max(0, -highSlope));
  const lowEdge = best[0] + bucket / 2, highEdge = best[n - 1] - bucket / 2;
  // Masses: tails + inner should sum to ~1; the clip and mid noise leave a
  // residual, which is spread proportionally and REPORTED (renormalised).
  const raw = lowTail + highTail + inner.reduce((s, b) => s + b.p, 0);
  if (!(raw > 0)) return { ...base, state: "unavailable", reason: "zero total mass from the mids", diagnostics: { ...base.diagnostics, strikes: n, clipped } };
  const scale = 1 / raw;
  // Exact (unrounded) masses for the moments; the published buckets are rounded.
  const exact: ImpliedCloseBucket[] = [
    { lo: null, hi: lowEdge, p: lowTail * scale },
    ...inner.map((b) => ({ ...b, p: b.p * scale })),
    { lo: highEdge, hi: null, p: highTail * scale },
  ];
  const buckets: ImpliedCloseBucket[] = exact.map((b) => ({ ...b, p: r4(b.p) }));
  // Mean and sigma over the inner buckets plus tails placed one half-bucket
  // beyond the edges (a stated approximation; the tails are small when the
  // grid covers the move). Rounding each bucket first would bias the mean by
  // about a point over 80 buckets, so the moments use the exact masses.
  let mean = 0;
  const mids: Array<[number, number]> = exact.map((b) => [b.lo == null ? (b.hi as number) - bucket / 2 : b.hi == null ? (b.lo as number) + bucket / 2 : ((b.lo as number) + (b.hi as number)) / 2, b.p]);
  for (const [m, p] of mids) mean += m * p;
  let v = 0;
  for (const [m, p] of mids) v += p * (m - mean) ** 2;
  return {
    ...base, state: "ok", reason: null, buckets,
    sigma: Math.round(Math.sqrt(v) * 100) / 100, mean: Math.round(mean * 100) / 100,
    diagnostics: { strikes: n, clipped, lowTail: r4(lowTail * scale), highTail: r4(highTail * scale), renormalised: r4(Math.abs(1 - raw)) },
  };
}

/**
 * Side-by-side reading of the two close distributions, as labelled
 * differences: where each puts its mass, and how far apart they are. No
 * verdict on which is right; the scorecard (50 days) is the only judge.
 */
export interface CloseComparison {
  /** Total variation distance between the two bucket distributions, 0 (same) to 1 (disjoint). */
  tvDistance: number;
  /** Implied sigma minus Wiener sigma, points; positive = the chain prices a wider settle than the random walk. */
  sigmaDiff: number;
  /** Implied mean minus spot, points (the market's forward tilt in the settle). */
  meanShift: number;
  /** Share of implied mass above the spot vs the Wiener's (0.5 by construction). */
  pAboveSpotImplied: number;
  text: string;
}

export function compareCloseDistributions(
  wiener: { spot: number; sigma: number },
  implied: ImpliedClose,
  normCdf: (x: number) => number,
): CloseComparison | null {
  if (implied.state !== "ok" || implied.sigma == null || implied.mean == null || !(wiener.sigma > 0)) return null;
  // The random walk's mass in each IMPLIED bucket, exactly from its normal CDF
  // (no bucket-edge alignment to get wrong), then the total variation distance.
  const cdf = (x: number | null, tail: 0 | 1) => x == null ? tail : normCdf((x - wiener.spot) / wiener.sigma);
  let tv = 0;
  for (const b of implied.buckets) {
    const pw = cdf(b.hi, 1) - cdf(b.lo, 0);
    tv += Math.abs(pw - b.p);
  }
  const tvDistance = r4(tv / 2);
  const above = implied.buckets.reduce((s, b) => {
    if (b.lo != null && b.lo >= wiener.spot) return s + b.p;
    if (b.lo != null && b.hi != null && b.lo < wiener.spot && b.hi > wiener.spot) return s + b.p * ((b.hi - wiener.spot) / (b.hi - b.lo));
    if (b.lo == null) return s;
    return s;
  }, 0);
  const sigmaDiff = Math.round((implied.sigma - wiener.sigma) * 100) / 100;
  const meanShift = Math.round((implied.mean - wiener.spot) * 100) / 100;
  const widthWord = Math.abs(sigmaDiff) < 0.1 * wiener.sigma ? "about the same width as" : sigmaDiff > 0 ? "wider than" : "narrower than";
  const text = `the chain's own settle distribution is ${widthWord} the random walk's (implied 1σ ±${implied.sigma} vs ±${wiener.sigma}); its mean sits ${meanShift >= 0 ? "+" : ""}${meanShift} pts from spot with ${Math.round(above * 100)}% of its mass above (the random walk has 50%); the two distributions differ by ${Math.round(tvDistance * 100)}% of their mass. A description of two models, not a signal.`;
  return { tvDistance, sigmaDiff, meanShift, pAboveSpotImplied: r4(above), text };
}
