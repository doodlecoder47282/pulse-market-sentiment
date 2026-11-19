// shared/chartLabels.ts
//
// Where a level's label sits on the Models path chart. Every path starts at the current price on the left
// edge, so a label drawn at the left for a level close to the price is painted over by the start dot and
// the three path lines and cannot be read. Such a label moves to the right edge. Pure.

export const NEAR_PRICE_FRACTION = 0.06;

/** "right" when the level is within 6% of the chart's price range of the current price, else "left". */
export function levelLabelSide(price: number, spot: number | null | undefined, yMin: number, yMax: number): "left" | "right" {
  const range = yMax - yMin;
  if (typeof spot !== "number" || !Number.isFinite(spot) || !Number.isFinite(price) || !(range > 0)) return "left";
  return Math.abs(price - spot) < range * NEAR_PRICE_FRACTION ? "right" : "left";
}
