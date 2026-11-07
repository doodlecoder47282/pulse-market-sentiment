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
// above the FORWARD and puts below (the out-of-the-money side, where mids are
// tighter), converting puts with C = P + F - K, where F is solved from the
// chain itself at the two-sided strike nearest the spot (F = K + C - P).
// Converting with the spot instead would pin the mean to the spot by
// construction and put a kink at the spot whenever the underlying's last
// print differs from the chain's own forward (always, after the close).
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
  /** Implied 1-sigma of the settle in points, from the interquartile range (IQR / 1.349): robust to mid-tick noise
   *  in the wings, which inflates a variance-based sigma. The variance-based figure is in diagnostics. */
  sigma: number | null;
  /** Mean of the distribution, points (close to the parity forward when the mids are consistent). */
  mean: number | null;
  /** Median of the distribution, points. */
  median: number | null;
  /** Forward solved from parity at the two-sided strike nearest the spot (F = K + C - P), points. */
  forward: number | null;
  /** Mass resolution: the smallest bucket mass a one-tick mid change can produce (tick / bucket). Noise below this is not a reading. */
  resolution: number | null;
  /** Strikes used, butterflies clipped at zero (mids out of line), tail masses; clippedInBody = clipped strikes inside the interquartile range (a hole there moves the median a whole bucket). */
  diagnostics: { strikes: number; clipped: number; clippedInBody?: number; lowTail: number; highTail: number; renormalised: number; sigmaFromVariance?: number | null };
}

export const IMPLIED_CLOSE_METHOD = "Breeden-Litzenberger butterflies on 0DTE option mids (calls above the parity forward, puts below via parity), zero rate, no smoothing";

/** Fewer usable strikes than this: unavailable. */
export const MIN_STRIKES = 7;
/** More than this share of inner buckets clipped: unavailable (mids too ragged to read a density). */
export const MAX_CLIPPED_SHARE = 0.34;
/** Mass that had to be added or removed to make the buckets sum to one. More than this: the mids do not describe one distribution. */
export const MAX_RENORMALISED = 0.05;
/** SPX option mids move in this many points (quotes in 0.05, mids in 0.025). */
export const MID_TICK = 0.025;
/** Strikes within this share of the spot vote on the parity forward (about one 0DTE sigma). */
export const FORWARD_WINDOW_PCT = 0.0075;

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function impliedClose(spot: number, quotes: StrikeQuote[], bucket: number): ImpliedClose {
  const base = { method: IMPLIED_CLOSE_METHOD, bucket: bucket > 0 ? bucket : null, buckets: [] as ImpliedCloseBucket[], sigma: null, mean: null, median: null, forward: null, resolution: bucket > 0 ? r4(MID_TICK / bucket) : null, diagnostics: { strikes: 0, clipped: 0, lowTail: 0, highTail: 0, renormalised: 0 } };
  if (!(spot > 0)) return { ...base, state: "unavailable", reason: "no spot" };
  if (!(bucket > 0)) return { ...base, state: "unavailable", reason: "no strike spacing" };
  const onGrid = quotes.filter((q) => Number.isFinite(q.strike) && q.strike > 0 && Math.abs(q.strike / bucket - Math.round(q.strike / bucket)) <= 1e-6);
  // The chain's own forward: the MEDIAN of parity (K + C - P) over the two-sided
  // strikes near the spot. Parity holds at every strike, so one stale leg at the
  // money cannot move F (a single-strike F absorbed that leg's error as a
  // constant offset on every converted put, which read as skew).
  const both = onGrid.filter((q) => q.callMid != null && q.callMid > 0 && q.putMid != null && q.putMid > 0);
  if (!both.length) return { ...base, state: "unavailable", reason: "no strike with both a call and a put mid: the forward cannot be read from the chain" };
  const near = both.filter((q) => Math.abs(q.strike - spot) <= Math.max(FORWARD_WINDOW_PCT * spot, 2 * bucket));
  const pool = (near.length >= 3 ? near : both).map((q) => q.strike + (q.callMid as number) - (q.putMid as number)).sort((a, b) => a - b);
  const forward = pool.length % 2 ? pool[(pool.length - 1) / 2] : (pool[pool.length / 2 - 1] + pool[pool.length / 2]) / 2;
  if (!(forward > 0) || Math.abs(forward - spot) > 0.05 * spot) return { ...base, state: "unavailable", reason: `parity forward ${forward.toFixed(2)} is not near the spot ${spot.toFixed(2)}: the chain's mids and the underlying print disagree`, forward: r2(forward) };
  // One call price per grid strike: the OTM side's mid, puts converted by parity with the forward.
  const byStrike = new Map<number, number>();
  for (const q of onGrid) {
    const useCall = q.strike >= forward;
    const c = useCall
      ? (q.callMid != null && q.callMid > 0 ? q.callMid : null)
      : (q.putMid != null && q.putMid > 0 ? q.putMid + forward - q.strike : null);
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
  const clippedAt: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const k = best[i];
    const fly = (C(best[i - 1]) - 2 * C(k) + C(best[i + 1])) / bucket;
    if (fly < 0) { clipped++; clippedAt.push(k); }
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
  if (!(raw > 0)) return { ...base, state: "unavailable", reason: "zero total mass from the mids", diagnostics: { ...base.diagnostics, strikes: n, clipped }, forward: r2(forward) };
  if (Math.abs(1 - raw) > MAX_RENORMALISED) {
    return { ...base, state: "unavailable", reason: `the mids' masses sum to ${raw.toFixed(3)}, not 1: ${Math.round(Math.abs(1 - raw) * 100)}% had to be renormalised (limit ${Math.round(MAX_RENORMALISED * 100)}%); not one consistent distribution`, diagnostics: { ...base.diagnostics, strikes: n, clipped, renormalised: r4(Math.abs(1 - raw)) }, forward: r2(forward) };
  }
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
  // Quantiles: linear inside the bucket that crosses the level; a tail bucket answers with its finite edge.
  const quantile = (q: number): number | null => {
    let acc = 0;
    for (const b of exact) {
      if (acc + b.p >= q) {
        if (b.lo == null || b.hi == null) return b.lo ?? b.hi;
        return b.lo + (b.hi - b.lo) * ((q - acc) / b.p);
      }
      acc += b.p;
    }
    return null;
  };
  const median = quantile(0.5), q25 = quantile(0.25), q75 = quantile(0.75);
  const sigmaIqr = q25 != null && q75 != null ? (q75 - q25) / 1.349 : null;
  const clippedInBody = q25 != null && q75 != null ? clippedAt.filter((k) => k >= q25 && k <= q75).length : clippedAt.length;
  return {
    ...base, state: "ok", reason: null, buckets, forward: r2(forward),
    sigma: sigmaIqr == null ? null : r2(sigmaIqr), mean: r2(mean), median: median == null ? null : r2(median),
    diagnostics: { strikes: n, clipped, clippedInBody, lowTail: r4(lowTail * scale), highTail: r4(highTail * scale), renormalised: r4(Math.abs(1 - raw)), sigmaFromVariance: r2(Math.sqrt(v)) },
  };
}

/**
 * Side-by-side reading of the two close distributions, as labelled
 * differences: where each puts its mass, and how far apart they are. No
 * verdict on which is right; the scorecard (50 days) is the only judge.
 */
export interface CloseComparison {
  /** Total variation distance between the two distributions on coarse bins (one Wiener sigma wide), 0 (same) to 1 (disjoint).
   *  Coarse so that mid-tick noise (about tick/bucket of mass per strike bucket) does not read as disagreement. */
  tvDistance: number;
  /** Bin width used for the distance, points. */
  binWidth: number;
  /** Implied sigma minus Wiener sigma, points; positive = the chain prices a wider settle than the random walk. */
  sigmaDiff: number;
  /** Implied median minus the parity forward, points: the skew of the chain's settle (its mean sits at the forward by parity). */
  medianShift: number;
  /** Parity forward minus spot, points: carry and any gap between the chain and the underlying print. */
  forwardMinusSpot: number;
  /** Share of implied mass above the spot vs the Wiener's (0.5 by construction). */
  pAboveSpotImplied: number;
  text: string;
}

export function compareCloseDistributions(
  wiener: { spot: number; sigma: number },
  implied: ImpliedClose,
  normCdf: (x: number) => number,
): CloseComparison | null {
  if (implied.state !== "ok" || implied.sigma == null || implied.mean == null || implied.median == null || implied.forward == null || !(wiener.sigma > 0)) return null;
  // Distance on coarse bins one Wiener sigma wide, centred on the spot: the
  // implied mass is summed into them (a strike bucket straddling a bin edge is
  // split pro rata), the random walk's comes exactly from its normal CDF.
  const binWidth = r2(wiener.sigma);
  const edges: number[] = [];
  for (let k = -4; k <= 4; k++) edges.push(wiener.spot + k * binWidth);
  // A tail's mass is placed in the strike bucket just beyond the readable run
  // (the same placement the moments use), so every implied bucket has a width.
  const w = implied.bucket ?? binWidth;
  const placed = implied.buckets.map((b) => ({ lo: b.lo ?? (b.hi as number) - w, hi: b.hi ?? (b.lo as number) + w, p: b.p }));
  const impliedIn = (lo: number | null, hi: number | null) => placed.reduce((s, b) => {
    const l = Math.max(b.lo, lo ?? -Infinity), h = Math.min(b.hi, hi ?? Infinity);
    return h <= l ? s : s + b.p * ((h - l) / (b.hi - b.lo));
  }, 0);
  const cdf = (x: number | null, tail: 0 | 1) => x == null ? tail : normCdf((x - wiener.spot) / wiener.sigma);
  let tv = 0;
  const bins: Array<[number | null, number | null]> = [[null, edges[0]], ...edges.slice(0, -1).map((e, i) => [e, edges[i + 1]] as [number, number]), [edges[edges.length - 1], null]];
  for (const [lo, hi] of bins) tv += Math.abs((cdf(hi, 1) - cdf(lo, 0)) - impliedIn(lo, hi));
  const tvDistance = r4(tv / 2);
  const above = implied.buckets.reduce((s, b) => {
    if (b.lo != null && b.lo >= wiener.spot) return s + b.p;
    if (b.lo != null && b.hi != null && b.lo < wiener.spot && b.hi > wiener.spot) return s + b.p * ((b.hi - wiener.spot) / (b.hi - b.lo));
    if (b.lo == null) return s;
    return s;
  }, 0);
  const sigmaDiff = r2(implied.sigma - wiener.sigma);
  const medianShift = r2(implied.median - implied.forward);
  const forwardMinusSpot = r2(implied.forward - wiener.spot);
  const widthWord = Math.abs(sigmaDiff) < 0.1 * wiener.sigma ? "about the same width as" : sigmaDiff > 0 ? "wider than" : "narrower than";
  // IQR/1.349 equals sigma only for a normal; when the implied's tails carry more, say both.
  const sv = implied.diagnostics.sigmaFromVariance;
  const tailNote = sv != null && Math.abs(sv - implied.sigma) > 0.1 * implied.sigma ? `; its body is ±${implied.sigma} but its tails push the variance sigma to ±${sv}` : "";
  // Below half a strike bucket the median cannot be placed better than the grid: no skew is claimed.
  const skewFloor = (implied.bucket ?? binWidth) / 2;
  // A clipped (zero-mass) strike inside the interquartile body moves the median a whole bucket: no skew is claimed then either.
  const holeInBody = (implied.diagnostics.clippedInBody ?? 0) > 0;
  const skewWord = holeInBody ? `median not read: ${implied.diagnostics.clippedInBody} strike${implied.diagnostics.clippedInBody === 1 ? "" : "s"} inside its body priced out of line (clipped to zero)`
    : Math.abs(medianShift) < skewFloor ? `median within half a strike of its forward (no skew readable at ${implied.bucket ?? binWidth}-pt strikes)` : medianShift > 0 ? `median ${medianShift > 0 ? "+" : ""}${medianShift} pts above its forward (longer lower tail)` : `median ${medianShift} pts below its forward (longer upper tail)`;
  const fwdNote = Math.abs(forwardMinusSpot) >= 0.25 ? `; its parity forward sits ${forwardMinusSpot > 0 ? "+" : ""}${forwardMinusSpot} pts from the underlying print` : "";
  const renormNote = implied.diagnostics.renormalised >= 0.005 ? `; ${Math.round(implied.diagnostics.renormalised * 1000) / 10}% of mass renormalised` : "";
  const text = `the chain's own settle distribution is ${widthWord} the random walk's (implied 1σ ±${implied.sigma} from its interquartile range vs ±${wiener.sigma}${tailNote}); ${skewWord}, ${Math.round(above * 100)}% of its mass above spot (the random walk has 50%)${fwdNote}${renormNote}; on 1σ-wide bins the two differ by ${Math.round(tvDistance * 100)}% of their mass (strike-bucket detail below about ${Math.round((implied.resolution ?? 0) * 100)}% per bucket is mid-tick noise, not a reading; bins this wide do not show a two-humped shape, the histogram does). A description of two models, not a signal.`;
  return { tvDistance, binWidth, sigmaDiff, medianShift, forwardMinusSpot, pAboveSpotImplied: r4(above), text };
}
