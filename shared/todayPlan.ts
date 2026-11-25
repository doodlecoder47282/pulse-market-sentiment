// The top of the Signals tab for someone who can buy a call or a put and does not know the Greeks:
// what is happening, the levels that matter, and the path between them as if-then steps (A to B, because C).
//
// Every line is a rule applied to the option map for the nearest expiry (shared/odteMap.ts). The rules:
//   - TURNING POINT = the map's gamma flip. Under the model, on the side of it where dealers are "short
//     gamma" their hedging trades with the move (bigger swings); on the other side it trades against the
//     move (smaller swings). The model assumes who holds what; it is not a count of real positions.
//   - CEILING / FLOOR = the largest strike within 2% above / below the price where the model has hedging
//     leaning against the move.
//   - EXPECTED MOVE = the at-the-money straddle price: what option buyers are paying for movement by the
//     close. About two days in three end inside one such move if options are priced right.
// These are conditions and levels, not a promise about price. The record of how such levels have done is
// shown beside them where one exists.

const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export interface TodayPlanInput {
  symbol: string;
  spot: number | null | undefined;
  sessionState?: string | null;
  dataState?: string | null;
  atSpot: "long" | "short" | "indeterminate" | string | null | undefined;
  straddle: number | null | undefined;
  low: number | null | undefined;
  high: number | null | undefined;
  above: number | null | undefined;
  below: number | null | undefined;
  flip: number | null | undefined;
}

export interface TodayPlan {
  /** One or two sentences: what is happening. */
  headline: string;
  /** If-then steps, most relevant first. Empty when there is nothing to build them from. */
  path: string[];
  /** Short labels for the three tiles. */
  labels: { above: string; flip: string; below: string };
  /** One line under each tile. */
  notes: { above: string; flip: string; below: string };
}

export const TODAY_LABELS = { above: "ceiling above", flip: "turning point", below: "floor below" } as const;

export function todayPlan(m: TodayPlanInput): TodayPlan {
  const labels = { ...TODAY_LABELS };
  const sym = m.symbol.replace(/^\$/, "");
  if (m.dataState === "no_gex" || !fin(m.spot)) {
    return {
      headline: "No option levels to read yet: the option data has not come in with what the map needs.",
      path: [], labels, notes: { above: "not read", flip: "not read", below: "not read" },
    };
  }
  const spot = m.spot;
  const closed = m.sessionState === "closed";
  const when = closed ? "for the next session" : "today";
  const byWhen = closed ? "by the next close" : "by today's close";
  const move = fin(m.straddle) && fin(m.low) && fin(m.high)
    ? ` Options are priced for a move of about ${n0(m.straddle)} points either way ${byWhen}: roughly ${n0(m.low)} to ${n0(m.high)}.`
    : "";
  const mood = m.atSpot === "short" ? `Bigger swings are the setup ${when}: at this price, the hedging of big option dealers tends to push ${sym} further in whichever direction it is already going.`
    : m.atSpot === "long" ? `Smaller swings are the setup ${when}: at this price, the hedging of big option dealers tends to pull ${sym} back toward the middle.`
    : `The option map does not say ${when} whether dealer hedging will add to moves or calm them.`;
  const headline = `${mood}${move}${closed ? " This is from the last read before the close, not a live one." : ""}`;

  const path: string[] = [];
  const flip = fin(m.flip) ? m.flip : null, above = fin(m.above) ? m.above : null, below = fin(m.below) ? m.below : null;
  const hi = fin(m.high) ? m.high : null, lo = fin(m.low) ? m.low : null;
  if (flip != null && flip > spot) {
    path.push(`If ${sym} gets back above ${n0(flip)}, swings should calm down, because above that level dealer hedging works against the move instead of with it.`);
    if (above != null && above > flip) path.push(`Above ${n0(flip)}, the next level is ${n0(above)}: the heaviest option positions overhead, where rallies tend to slow.`);
    path.push(below != null
      ? `While it stays below ${n0(flip)}, expect larger moves both ways; the next level down is ${n0(below)}.`
      : `While it stays below ${n0(flip)}, expect larger moves both ways. No option level stands out underneath within 2%${lo != null ? `; the low end of the priced move is ${n0(lo)}` : ""}.`);
  } else if (flip != null && flip <= spot) {
    path.push(`If ${sym} falls below ${n0(flip)}, swings should get bigger, because below that level dealer hedging works with the move instead of against it.`);
    if (above != null) path.push(`While it holds above ${n0(flip)}, the next level up is ${n0(above)}: the heaviest option positions overhead, where rallies tend to slow.`);
    else path.push(`While it holds above ${n0(flip)}, no option level stands out overhead within 2%${hi != null ? `; the high end of the priced move is ${n0(hi)}` : ""}.`);
    if (below != null && below < flip) path.push(`Below ${n0(flip)}, the next level down is ${n0(below)}.`);
  } else {
    if (above != null) path.push(`The nearest level overhead is ${n0(above)}: the heaviest option positions above the price, where rallies tend to slow.`);
    if (below != null) path.push(`The nearest level underneath is ${n0(below)}: the heaviest option positions below the price, where drops tend to slow.`);
    if (!path.length) path.push("No option level stands out within 2% of the price on either side.");
  }

  const away = (x: number) => `${Math.abs(((x - spot) / spot) * 100).toFixed(2)}% ${x >= spot ? "above" : "below"} the price`;
  const notes = {
    above: above != null ? away(above) : "none within 2%",
    flip: flip != null ? `${away(flip)}: price is on the ${m.atSpot === "short" ? "bigger-swing" : m.atSpot === "long" ? "calmer" : "undetermined"} side` : "none found in the range read",
    below: below != null ? away(below) : "none within 2%",
  };
  return { headline, path, labels, notes };
}
