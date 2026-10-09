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
// clearing (OCC); each open contract has one long and one short holder.
// Every trade has two sides, and each side is opening or closing (CME Group,
// "Open Interest", https://www.cmegroup.com/education/courses/introduction-to-futures/open-interest.html:
// open interest adds the contracts of opened trades and subtracts those of
// closed ones). So a trade is open/open (OI +1), open/close (OI 0) or
// close/close (OI -1). If nothing opened today is also closed today (no
// same-day round trips):
//   - close/close trades retire one long and one short of yesterday's OI,
//     so there are at most OI_prev of them, and at least V - OI_prev trades
//     have AT LEAST ONE opening side.          volumeOverOiShare = 1 - OI_prev / V
//   - closing sides number at most 2 x OI_prev (OI_prev longs + OI_prev
//     shorts), so at least V - 2 x OI_prev trades are FULLY opening
//     (both sides new).                         fullyOpeningShare = 1 - 2 OI_prev / V
// Both are clamped at 0 and stated together (R3-2 item 5): the first bound
// says nothing about WHICH side opened, so it does not say the aggressor
// opened. Same-day round trips break both bounds, which is why they are
// proxies and the next morning's OI change is the confirmation ("heavy
// volume can evaporate overnight after day trading": Schaeffer's Investment
// Research, "Open Interest and Volume", https://www.schaeffersresearch.com/education/options-basics/key-option-concepts/open-interest-and-volume).
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

/** Lower bound on the share of today's volume with at least one opening side (no same-day round trips assumed); null without volume. */
export function volumeOverOiShare(volume: number, priorOi: number): number | null {
  if (!Number.isFinite(volume) || volume <= 0) return null;
  if (!Number.isFinite(priorOi) || priorOi < 0) return null; // OI unknown: no bound
  return Math.max(0, 1 - priorOi / volume);                 // OI 0 (new strike) -> 1
}

/** Lower bound on the share of today's volume that is fully opening (both sides new): max(0, 1 - 2 OI_prev / V). */
export function fullyOpeningShare(volume: number, priorOi: number): number | null {
  if (!Number.isFinite(volume) || volume <= 0) return null;
  if (!Number.isFinite(priorOi) || priorOi < 0) return null;
  return Math.max(0, 1 - (2 * priorOi) / volume);
}

/** Fully-opening bound from the opening-side bound s = 1 - OI/V: 1 - 2 OI/V = 2 s - 1 (clamped at 0). */
export function fullyOpeningFromShare(share: number | null): number | null {
  if (share == null || !Number.isFinite(share)) return null;
  return Math.max(0, 2 * share - 1);
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

/**
 * Plain text for alerts stating both bounds, e.g. for V = 1,500, OI_prev = 100:
 * "with an opening side >= 93% of vol; fully opening >= 87% (vs prior-day OI, ...)".
 */
export function openingText(share: number | null): string | null {
  if (share == null) return null;
  if (share <= 0) return "volume within prior-day OI: may be closing";
  const full = fullyOpeningFromShare(share) ?? 0;
  return `with an opening side >= ${(share * 100).toFixed(0)}% of vol; fully opening >= ${(full * 100).toFixed(0)}% (vs prior-day OI, no same-day round trips; which side opened is unknown; next-day OI confirms)`;
}
