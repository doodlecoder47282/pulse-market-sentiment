import { etTime } from "./etTime";

// The top of the Signals tab for someone who can buy a call or a put and does not know the Greeks:
// what is happening, the levels that matter, and the path between them as if-then steps (A to B, because C).
//
// Every line is a rule applied to the option map for the nearest expiry (shared/odteMap.ts). The rules:
//   - TURNING POINT = the map's gamma flip. Under the model, on the side of it where dealers are "short
//     gamma" their hedging trades with the move (bigger swings); on the other side it trades against the
//     move (smaller swings). The model assumes who holds what; it is not a count of real positions.
//   - CEILING / FLOOR = the largest strike within 2% above / below the price where the model has hedging
//     leaning against the move. Largest on the model's map, not the largest open interest.
//   - Which side the price is on is the map's read AT the price. The far side of the turning point is the
//     other one; the turning point being above or below the price does not decide it.
//   - No line says what price will do. "Tends to" and "in this model" are the limits of the claim, and no
//     record for these option levels exists yet to put beside them.
//   - EXPECTED MOVE = the at-the-money straddle price: what option buyers are paying for movement by the
//     close. About two days in three end inside one such move if options are priced right.
// These are conditions and levels, not a promise about price. The record of how such levels have done is
// shown beside them where one exists.

type Side = "bigger" | "calmer" | null;
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
  /** When the option data behind the map was read (epoch ms). */
  readAtMs?: number | null;
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
  const here: Side = m.atSpot === "short" ? "bigger" : m.atSpot === "long" ? "calmer" : null;
  const mood = here === "bigger" ? `Bigger swings are the setup ${when}: at this price, the option map has the hedging of big option dealers leaning with moves, which tends to push ${sym} further in whichever direction it is already going.`
    : here === "calmer" ? `Smaller swings are the setup ${when}: at this price, the option map has the hedging of big option dealers leaning against moves, which tends to pull ${sym} back toward the middle.`
    : `The option map does not say ${when} whether dealer hedging leans with moves or against them.`;
  // After the close the map is for the next expiry, read after the close: say when it was read.
  const readAt = closed ? ` Market closed: these are levels for the next session${fin(m.readAtMs) ? `, read at ${etTime(m.readAtMs)} ET` : ""}.` : "";
  const headline = `${mood}${move}${readAt}`;

  const path: string[] = [];
  const flip = fin(m.flip) ? m.flip : null, above = fin(m.above) ? m.above : null, below = fin(m.below) ? m.below : null;
  const hi = fin(m.high) ? m.high : null, lo = fin(m.low) ? m.low : null;
  // The side price is on comes from the map's read at the price (atSpot); the far side of the turning point
  // is the other one. Which side of the price the turning point sits on does not decide it.
  const sideWords = (s: Exclude<Side, null>) => (s === "calmer"
    ? "the calmer side: there the model has dealer hedging leaning against moves (smaller swings in this model)"
    : "the bigger-swing side: there the model has dealer hedging leaning with moves (bigger swings in this model)");
  if (flip != null) {
    const up = flip > spot;
    if (here) {
      const far: Exclude<Side, null> = here === "calmer" ? "bigger" : "calmer";
      path.push(`If ${sym} ${up ? "gets above" : "falls below"} ${n0(flip)}, the option map switches to ${sideWords(far)}.`);
      path.push(`While it stays ${up ? "below" : "above"} ${n0(flip)}, it is on ${here === "calmer" ? "the calmer side" : "the bigger-swing side"}.`);
    } else {
      path.push(`${n0(flip)} is where the model's hedging read changes sides; which side the price is on now could not be read.`);
    }
  }
  path.push(above != null
    ? `The largest level overhead on the option map is ${n0(above)}, where the model has hedging leaning against rallies.`
    : `No level stands out overhead within 2%${hi != null ? `; the high end of the priced move is ${n0(hi)}` : ""}.`);
  path.push(below != null
    ? `The largest level underneath on the option map is ${n0(below)}, where the model has hedging leaning against drops.`
    : `No level stands out underneath within 2%${lo != null ? `; the low end of the priced move is ${n0(lo)}` : ""}.`);

  const away = (x: number) => `${Math.abs(((x - spot) / spot) * 100).toFixed(2)}% ${x >= spot ? "above" : "below"} the price`;
  const notes = {
    above: above != null ? away(above) : "none within 2%",
    flip: flip != null ? `${away(flip)}${here ? `: price is on the ${here === "bigger" ? "bigger-swing" : "calmer"} side` : ""}` : "none found in the range read",
    below: below != null ? away(below) : "none within 2%",
  };
  return { headline, path, labels, notes };
}
