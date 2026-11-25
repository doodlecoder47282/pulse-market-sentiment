// shared/chartLabels.ts
//
// Where a level's label sits on the Models path chart. Every path starts at the current price on the left
// edge, so a label drawn at the left for a level close to the price is painted over by the start dot and
// the three path lines and cannot be read. Such a label moves to the right edge, unless a path ends beside it there too. Pure.

export const NEAR_PRICE_FRACTION = 0.06;

/**
 * "right" when the level is within 6% of the chart's price range of the current price and no path ends
 * that close to it on the right edge (the end dots would cover the label there instead); else "left".
 */
export function levelLabelSide(price: number, spot: number | null | undefined, yMin: number, yMax: number, pathEnds: Array<number | null | undefined> = []): "left" | "right" {
  const range = yMax - yMin;
  if (typeof spot !== "number" || !Number.isFinite(spot) || !Number.isFinite(price) || !(range > 0)) return "left";
  const near = range * NEAR_PRICE_FRACTION;
  if (Math.abs(price - spot) >= near) return "left";
  const endNear = pathEnds.some((e) => typeof e === "number" && Number.isFinite(e) && Math.abs(price - e) < near);
  return endNear ? "left" : "right";
}

/** A label sits above its line near the bottom edge of a chart, so it is not drawn over the axis; below it otherwise. */
export const EDGE_FRACTION = 0.08;
export function levelLabelVertical(price: number, yMin: number, yMax: number): "above" | "below" {
  const range = yMax - yMin;
  if (!(range > 0) || !Number.isFinite(price)) return "below";
  return price - yMin < range * EDGE_FRACTION ? "above" : "below";
}

/**
 * Lanes for labels that sit along one axis (for example level names along the top of a chart). Labels closer
 * together than `minGap` (in the axis's own units) go into different lanes so their text does not print over
 * each other. Returns the lane (0 = first) for each input, in input order.
 */
export function labelLanes(positions: readonly number[], minGap: number): number[] {
  const order = positions.map((p, i) => ({ p, i })).filter((x) => Number.isFinite(x.p)).sort((a, b) => a.p - b.p);
  const lastInLane: number[] = [];
  const lanes = positions.map(() => 0);
  for (const { p, i } of order) {
    let lane = lastInLane.findIndex((last) => p - last >= minGap);
    if (lane < 0) { lane = lastInLane.length; lastInLane.push(p); } else lastInLane[lane] = p;
    lanes[i] = lane;
  }
  return lanes;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The seasonality charts count trading days of the year (1 to about 252). This gives that day's date in a
 * given year as "Fri, Jul 17", using `isTradingDay` for the year's holidays. Null when the year has fewer
 * trading days than `n`.
 */
export function tradingDayToDateLabel(n: number, year: number, isTradingDay: (iso: string) => boolean): string | null {
  if (!Number.isFinite(n) || n < 1) return null;
  let count = 0;
  const d = new Date(Date.UTC(year, 0, 1, 12));
  while (d.getUTCFullYear() === year) {
    const iso = d.toISOString().slice(0, 10);
    if (isTradingDay(iso) && ++count === Math.round(n)) return `${WEEKDAY[d.getUTCDay()]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return null;
}

/**
 * Vertical nudges, in rows, for labels that sit at the same edge beside horizontal lines (for example
 * "PREV 7,237" and "CW 7,238" at the right edge). Values closer together than `minGap` form a cluster; the
 * cluster's labels are fanned out around its middle, highest value on top. Returns one number per input, in
 * input order: 0 for a label on its own, otherwise a row offset (negative = up) to multiply by the row height.
 */
export function labelNudges(values: ReadonlyArray<number | null | undefined>, minGap: number): number[] {
  const out = values.map(() => 0);
  const items = values.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => typeof x.v === "number" && Number.isFinite(x.v)).sort((a, b) => b.v - a.v);
  let cluster: typeof items = [];
  const flush = () => {
    const n = cluster.length;
    if (n > 1) cluster.forEach((c, k) => { out[c.i] = k - (n - 1) / 2; });
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && cluster[cluster.length - 1].v - it.v >= minGap) flush();
    cluster.push(it);
  }
  flush();
  return out;
}
