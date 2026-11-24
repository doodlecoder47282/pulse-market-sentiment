// shared/bounceList.ts
//
// Words for the Regime tab's pullback list. Pure.

export interface BounceCounts {
  /** Names with enough daily bars to judge (50). 0: nothing was read. */
  scanned: number;
  downToday: number;
  /** Down today but below both the 20- and the 50-day average. */
  fallingKnives: number;
  /** Down today, but by less than 1.5 standard deviations of its own 60-day daily returns. */
  notStretched: number;
  thin: number;
  noVolume: number;
}

/** Why the list is empty. Each case says what happened; none says "nothing is down" unless nothing is. */
export function emptyListLine(c: BounceCounts, mode: "bounce" | "all"): string {
  if (c.scanned === 0) return "No daily bars were read from Schwab, so there is nothing to list. This is not a statement that no stock is down.";
  if (c.downToday === 0) return `None of the ${c.scanned} names read is down today.`;
  if (mode === "all") return `${c.downToday} of the ${c.scanned} names read are down today.`;
  const parts: string[] = [];
  if (c.fallingKnives) parts.push(`${c.fallingKnives} below both their 20- and 50-day averages`);
  if (c.notStretched) parts.push(`${c.notStretched} down by less than 1.5 standard deviations of their own daily moves`);
  if (c.thin) parts.push(`${c.thin} trading under the dollar-volume cut`);
  if (c.noVolume) parts.push(`${c.noVolume} with no volume read`);
  return `${c.downToday} of the ${c.scanned} names read ${c.downToday === 1 ? "is" : "are"} down today, and none is on this list: ${parts.join(", ")}. "All dumps" shows them.`;
}

/** Average dollars traded a day, for a table cell. */
export function dollarsPerDay(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "not read";
  if (v < 1e6) return "<$1M";
  const m = Math.round(v / 1e6);
  return m >= 1000 ? `$${(v / 1e9).toFixed(1)}B` : `$${m}M`;
}
