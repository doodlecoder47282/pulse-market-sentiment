// shared/playbookReach.ts
//
// Is a wall within one day's range? Pure.
//
// The daily playbook sizes everything for ONE session: its sigma is a one-day move from VIX. Its up path and
// down path are tied to the call wall and the put wall, which come from open interest across every expiry
// read and can sit anywhere. After a fast fall the heaviest calls are still at the old strikes: seen live, a
// call wall 77.5 points above the price (5.6 one-day moves) was shown as the day's "bull" path with a target
// and a 19% weight. A wall further than ONE_DAY_REACH_SIGMAS one-day moves away is not a one-day path.

export const ONE_DAY_REACH_SIGMAS = 2;

export interface WallReach {
  /** Wall minus price, points (signed). */
  points: number;
  /** Distance in one-day moves (always positive). */
  sigmas: number;
  withinDay: boolean;
}

export function wallReach(spot: number, wall: number, sigma: number): WallReach | null {
  if (![spot, wall, sigma].every((n) => Number.isFinite(n)) || !(sigma > 0)) return null;
  const points = wall - spot;
  const sigmas = Math.abs(points) / sigma;
  return { points, sigmas, withinDay: sigmas <= ONE_DAY_REACH_SIGMAS };
}

/** A wing whose wall is out of the day's range carries no weight: it goes to the middle path. */
export function weightsForReach(w: { bull: number; base: number; bear: number }, bullWithin: boolean, bearWithin: boolean): { bull: number; base: number; bear: number } {
  const bull = bullWithin ? w.bull : 0, bear = bearWithin ? w.bear : 0;
  return { bull, bear, base: w.base + (w.bull - bull) + (w.bear - bear) };
}

/** What the card says in place of a path. States the distance; names no target. */
export function outOfReachLine(side: "call" | "put", wall: number, r: WallReach, sigma: number): string {
  const pts = Math.abs(r.points).toFixed(1);
  return `The ${side} wall ${wall.toFixed(2)} is ${pts} points ${r.points >= 0 ? "above" : "below"} the price: ${r.sigmas.toFixed(1)} one-day moves (one day is about ±${sigma.toFixed(2)}). `
    + `That is outside one day's range, so no ${side === "call" ? "up" : "down"} path is drawn from it. The wall is where the most ${side} gamma sits across all expiries read, not a one-day level.`;
}
