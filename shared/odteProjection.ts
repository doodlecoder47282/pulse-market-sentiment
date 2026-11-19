// shared/odteProjection.ts
//
// The three "centre of the close" reads drawn on the 0DTE Wiener map. Pure.
//
// Each is the middle of a distribution of the close from a different source. None is a forecast:
//   walk    the random walk's median. Zero drift, so it is the current price by construction.
//   implied the median of the chain's own settle distribution (shared/impliedClose.ts).
//   dealer  the end of the dealer-rule path (pin pull, charm tilt): a heuristic, not graded.
// A read that the source itself does not stand behind is not drawn, and the reason is carried:
// the same rule compareCloseDistributions uses for the median (any strike clipped to zero), a
// distribution with half its mass in an open tail, and a dealer path built without priced gamma.

export interface ProjectionInputs {
  spot: number | null;
  walkMedian: number | null;
  sessionState: "preopen" | "intraday" | "closed";
  implied?: {
    state: "ok" | "unavailable"; reason: string | null; median?: number | null; bucket?: number | null;
    diagnostics: { clipped: number; lowTail?: number; highTail?: number };
  } | null;
  /** Chain parity forward minus the last index print, points (closeComparison.forwardMinusSpot). */
  forwardMinusSpot?: number | null;
  /** Last point of the dealer-rule path, points. */
  dealerEnd?: number | null;
  gexValid?: boolean;
}

export interface Projection {
  spot: number;
  walk: number;
  implied: {
    end: number;
    /** end minus the last price, points. */
    gap: number;
    /** Part of the gap that is the chain's forward sitting away from the last index print (null: not reported or under 0.25 pts). */
    forwardGap: number | null;
    /** The gap is under half a strike: the grid cannot place the median better than that, so no lean is readable. */
    withinGrid: boolean;
    /** Drawn as a line only in the live session: outside it the index print is not live and the gap is mostly the forward against an old print. */
    draw: boolean;
  } | null;
  impliedWhy: string | null;
  dealer: { end: number; gap: number } | null;
  dealerWhy: string | null;
}

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const r1 = (n: number) => Math.round(n * 10) / 10;
/** The threshold shared/impliedClose.ts uses before it mentions the forward-versus-print gap. */
export const FORWARD_GAP_MIN = 0.25;

export function projectedClose(i: ProjectionInputs): Projection | null {
  if (!fin(i.spot) || !fin(i.walkMedian)) return null;
  const ic = i.implied;
  let implied: Projection["implied"] = null;
  let impliedWhy: string | null = null;
  if (!ic || ic.state !== "ok") impliedWhy = `not readable: ${ic?.reason ?? "no chain mids"}`;
  else if (ic.diagnostics.clipped > 0) impliedWhy = `median not read: ${ic.diagnostics.clipped} strike${ic.diagnostics.clipped === 1 ? "" : "s"} priced out of line (clipped to zero)`;
  else if ((ic.diagnostics.lowTail ?? 0) >= 0.5 || (ic.diagnostics.highTail ?? 0) >= 0.5) impliedWhy = "median not read: half the distribution lies beyond the readable strikes";
  else if (!fin(ic.median)) impliedWhy = "median not reported";
  else {
    const gap = r1(ic.median - i.spot);
    const fg = fin(i.forwardMinusSpot) && Math.abs(i.forwardMinusSpot) >= FORWARD_GAP_MIN ? r1(i.forwardMinusSpot) : null;
    implied = {
      end: r1(ic.median), gap, forwardGap: fg,
      withinGrid: fin(ic.bucket) && ic.bucket > 0 ? Math.abs(ic.median - i.spot) < ic.bucket / 2 : false,
      draw: i.sessionState === "intraday",
    };
  }
  let dealer: Projection["dealer"] = null;
  let dealerWhy: string | null = null;
  if (i.gexValid === false) dealerWhy = "not available: gamma not priced on this read";
  else if (!fin(i.dealerEnd)) dealerWhy = "not available on this read";
  else dealer = { end: r1(i.dealerEnd), gap: r1(i.dealerEnd - i.spot) };
  return { spot: i.spot, walk: i.walkMedian, implied, impliedWhy, dealer, dealerWhy };
}

// ─── Small path chart (Today card) ───────────────────────────────────────────────────────────────

export interface PathBand { minute: number; q: { p10: number; p25: number; p50: number; p75: number; p90: number } }
export interface PathView {
  /** Polygon / polyline point strings in a 300 x 100 box (x: start to close, y: price, high at the top). */
  outer: string; inner: string; walk: string;
  implied: { x1: number; y1: number; x2: number; y2: number } | null;
  dealer: string | null;
  lo: number; hi: number;
}

/**
 * Geometry for the small projected-path chart. Bands and the dealer path share one time frame (minutes from
 * the projection start). Returns null when there is nothing honest to draw: fewer than two bands, a band
 * that is not a finite number, or no spot.
 */
export function pathView(bands: PathBand[], spot: number | null, impliedEnd: number | null, dealerPath: Array<{ minute: number; median: number }> | null): PathView | null {
  if (!fin(spot) || bands.length < 2) return null;
  const nums = bands.flatMap((b) => [b.minute, b.q.p10, b.q.p25, b.q.p50, b.q.p75, b.q.p90]);
  if (!nums.every(fin)) return null;
  const dealer = dealerPath && dealerPath.length > 1 && dealerPath.every((p) => fin(p.minute) && fin(p.median)) ? dealerPath : null;
  const last = bands[bands.length - 1];
  const ys = [...bands.flatMap((b) => [b.q.p10, b.q.p90]), spot, ...(fin(impliedEnd) ? [impliedEnd] : []), ...(dealer ? dealer.map((p) => p.median) : [])];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const t0 = bands[0].minute, span = last.minute - t0;
  if (!(span > 0)) return null;
  const X = (minute: number) => Math.max(0, Math.min(300, ((minute - t0) / span) * 300));
  const Y = (px: number) => 100 - ((px - lo) / (hi - lo)) * 100;
  const pt = (minute: number, px: number) => `${X(minute).toFixed(1)},${Y(px).toFixed(1)}`;
  const poly = (up: keyof PathBand["q"], dn: keyof PathBand["q"]) => [...bands.map((b) => pt(b.minute, b.q[up])), ...[...bands].reverse().map((b) => pt(b.minute, b.q[dn]))].join(" ");
  return {
    outer: poly("p90", "p10"), inner: poly("p75", "p25"), walk: bands.map((b) => pt(b.minute, b.q.p50)).join(" "),
    implied: fin(impliedEnd) ? { x1: 0, y1: Number(Y(spot).toFixed(1)), x2: 300, y2: Number(Y(impliedEnd).toFixed(1)) } : null,
    dealer: dealer ? dealer.map((p) => pt(p.minute, p.median)).join(" ") : null,
    lo, hi,
  };
}
