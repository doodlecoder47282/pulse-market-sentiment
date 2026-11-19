// shared/scenarioRegions.ts
//
// Two sets of odds sit on the Models tab and they answer different questions. Pure helpers to name each one
// for what it is, so the same three words never carry two different numbers.
//
//   headline odds  (audit.scenarioProb)   P(close at least one expected move above the current price) /
//                                         P(in between) / P(at least one below). Symmetric about the price.
//                                         These are the events the calibration grades.
//   range odds     (paths[].probability)  P(close inside each of three price ranges). The splits sit halfway
//                                         between the base path target and the bull and bear targets; when
//                                         the base target is outside those two, the current price is used. The ranges are wherever the path targets put
//                                         them: when the base path's target is far from the price, the
//                                         lowest (or highest) range CONTAINS the current price, and calling
//                                         it "bear" (or "bull") would describe an unchanged close as a move.
//
// So a range is named by where it is (upper / middle / lower) and flagged when the price is inside it. The
// path keeps its own name (BULL / BASE / BEAR): that is a drawn trajectory, not a probability.

export type PathKind = "bull" | "base" | "bear";
export interface RegionLike { lo: number | null; hi: number | null }
export interface PathLike { kind: PathKind; probability: number; probabilitySource?: string; region?: RegionLike | null; target: number }

export interface RangeOdds {
  kind: PathKind;
  /** "upper" | "middle" | "lower" when the odds are for a price range; null when they are the heuristic split. */
  position: "upper" | "middle" | "lower" | null;
  pct: number;
  lo: number | null; hi: number | null;
  /** The current price is inside this range. */
  holdsPrice: boolean;
  /** "UPPER range 0%" / "LOWER range 73%", or the path name with the heuristic split when no range exists. */
  label: string;
  /** "above 7,577" / "7,384-7,577" / "below 7,384", or "near 7,582" for a heuristic split. */
  rangeText: string;
}

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const k = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * The range a price falls in, on the server's convention (server/impliedScenario.ts): upper is strictly
 * above its split, lower strictly below, and the middle range is closed at both ends.
 */
function holds(r: RegionLike, spot: number): boolean {
  if (r.hi == null) return r.lo == null || spot > r.lo;
  if (r.lo == null) return spot < r.hi;
  return spot >= r.lo && spot <= r.hi;
}

/**
 * Odds beside one path. With options-implied odds and a region, they are range odds and are named by
 * position. Otherwise they are the hand-set split (the same numbers as the headline) and keep the path name.
 */
export function rangeOdds(paths: PathLike[], kind: PathKind, spot: number | null | undefined, fallbackPct: number): RangeOdds {
  const p = paths.find((x) => x.kind === kind);
  const implied = !!p && p.probabilitySource === "risk-neutral-implied";
  const r = implied ? p!.region ?? null : null;
  const pct = implied ? Math.round(p!.probability * 100) : fallbackPct;
  if (!r) {
    const name = kind === "bull" ? "BULL" : kind === "base" ? "BASE" : "BEAR";
    return { kind, position: null, pct, lo: null, hi: null, holdsPrice: false, label: `${name} ${pct}%`, rangeText: p ? `near ${k(p.target)}` : "" };
  }
  const position = r.hi == null ? "upper" : r.lo == null ? "lower" : "middle";
  const holdsPrice = fin(spot) ? holds(r, spot) : false;
  return {
    kind, position, pct, lo: r.lo, hi: r.hi, holdsPrice,
    label: `${position.toUpperCase()} range ${pct}%`,
    rangeText: r.lo == null ? `below ${k(r.hi!)}` : r.hi == null ? `above ${k(r.lo)}` : `${k(r.lo)}-${k(r.hi)}`,
  };
}

/** One line that tells the two sets apart; shown wherever both appear. */
export const TWO_ODDS_NOTE =
  "Two different questions. BULL / BASE / BEAR odds: a close at least one expected move above the current price, in between, or at least one below. Range odds: where the close lands among three price ranges. The splits sit halfway between the base path target and the bull and bear path targets; when the base target is outside those two, the current price is used in its place. The range that holds the current price is marked. An unchanged close counts toward whichever range holds the price.";

/** Short tag for the range that holds the price. */
export const HOLDS_PRICE_TAG = "price is in this range";
