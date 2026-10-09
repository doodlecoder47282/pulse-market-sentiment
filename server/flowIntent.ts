// server/flowIntent.ts
//
// Opening-vs-closing read for heavy contracts (review item 4.6). Pure.
//
// The old engine printed hand-set "opening probabilities" (0.92 / 0.85 /
// 0.75 ...) and a "directional confidence" as percentages, which read like
// estimates. Neither was estimated from data. This module replaces the
// opening number with a quantity that follows from the definitions:
//
//   volumeOverOiShare = max(0, 1 - OI_prev / V)        (1 when OI_prev = 0)
//
// Open interest is the number of contracts still open after yesterday's
// clearing (OCC). Today's volume V is opening trades plus closing trades;
// closing trades can retire at most OI_prev contracts plus any contracts
// opened earlier TODAY. So, if nothing was opened and closed again within
// the day, at least V - OI_prev of today's contracts are opening trades:
// volumeOverOiShare is that lower bound as a share of V. Same-day round
// trips break the bound, which is why it is a proxy and the next morning's
// OI change is the confirmation ("heavy volume can evaporate overnight
// after day trading": Schaeffer's Investment Research, "Open Interest and
// Volume", https://www.schaeffersresearch.com/education/options-basics/key-option-concepts/open-interest-and-volume).
// Data that does separate opening from closing volume (Cboe open/close
// data, as used by Pan & Poteshman, RFS 2006, https://www.nber.org/papers/w10925)
// is a paid product and is not connected.
//
// The direction score stays a HEURISTIC 0..1 score (never shown as a %):
//   score = volumeOverOiShare x sideClarity x spreadDiscount
// sideClarity (0.9 for a last print at/through the bid or ask, 0.55 inside)
// and spreadDiscount (0.5 when a same-expiry sibling fired in the same scan)
// are hand-set, not fitted.

export const DIRECTION_SCORE_NOTE =
  "direction score is a hand-set heuristic (vol-over-OI share x last-print clarity x spread-leg discount), not a probability";

/** Lower bound on the opening share of today's volume (no same-day round trips assumed); null without volume. */
export function volumeOverOiShare(volume: number, priorOi: number): number | null {
  if (!Number.isFinite(volume) || volume <= 0) return null;
  if (!Number.isFinite(priorOi) || priorOi < 0) return null; // OI unknown: no bound
  return Math.max(0, 1 - priorOi / volume);                 // OI 0 (new strike) -> 1
}

/** Hand-set clarity of the last-print side tag. */
export function sideClarity(tag: string): number {
  if (tag === "ABOVE_ASK" || tag === "AT_ASK" || tag === "BELOW_BID" || tag === "AT_BID") return 0.9;
  return 0.55;
}

/** Heuristic direction score in [0, 1], 2 decimals; null when the opening share is unknown. */
export function directionScore(share: number | null, tag: string, spreadLegLikely: boolean): number | null {
  if (share == null) return null;
  return Number((share * sideClarity(tag) * (spreadLegLikely ? 0.5 : 1)).toFixed(2));
}

/** Plain text for alerts, e.g. "opening >= 93% of vol (vs prior-day OI; next-day OI confirms)". */
export function openingText(share: number | null): string | null {
  if (share == null) return null;
  if (share <= 0) return "volume within prior-day OI: may be closing";
  return `opening >= ${(share * 100).toFixed(0)}% of vol (vs prior-day OI, no same-day round trips; next-day OI confirms)`;
}
