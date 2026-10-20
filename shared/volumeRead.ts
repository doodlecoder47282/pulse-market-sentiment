// shared/volumeRead.ts
//
// What the volume says, from what Schwab serves. Schwab's quote and streamer
// carry no venue code and no time-and-sales, so this module never claims to
// see a dark pool. It measures three things a reader can check:
//   relative volume   today's volume against the 20-session average, raw
//                     and paced to how much of the session has elapsed;
//   quiet volume      relative volume high while the price moved little,
//                     the pattern that off-exchange accumulation leaves in
//                     consolidated tape (a sign, not proof);
//   block prints      for the streamed symbols only, Level-1 updates whose
//                     last size is far above the session's typical print.
// Every number says which inputs it used; a missing input is a state.

export interface DailyVolumeBar { date?: string; t?: number; close: number; volume: number }

export interface RelativeVolume {
  todayVolume: number | null;
  avg20: number | null;
  /** today / avg20, raw. */
  rel: number | null;
  /** today / (avg20 x share of the session elapsed); null before the open or when the session fraction is unknown. */
  relPaced: number | null;
  sessionFraction: number | null;
  sessions: number;
  dataState: "ok" | "partial" | "no_data";
  reason: string | null;
}

/**
 * `history` is ascending daily bars; the bar for `todayDate` (if present) is
 * excluded from the average. `sessionFraction` is minutes elapsed / 390,
 * clamped to [0, 1], or null outside the session.
 */
export function relativeVolume(todayVolume: number | null, history: DailyVolumeBar[], todayDate: string | null, sessionFraction: number | null): RelativeVolume {
  const past = history.filter((b) => Number.isFinite(b.volume) && b.volume > 0 && (todayDate == null || b.date !== todayDate)).slice(-20);
  const n = past.length;
  const avg20 = n ? past.reduce((a, b) => a + b.volume, 0) / n : null;
  const tv = typeof todayVolume === "number" && Number.isFinite(todayVolume) && todayVolume >= 0 ? todayVolume : null;
  const frac = sessionFraction == null ? null : Math.max(0, Math.min(1, sessionFraction));
  const rel = tv != null && avg20 ? tv / avg20 : null;
  const relPaced = rel != null && frac != null && frac > 0.05 ? tv! / (avg20! * frac) : null;
  const dataState: RelativeVolume["dataState"] = tv == null || avg20 == null ? "no_data" : n < 20 ? "partial" : "ok";
  const reason = tv == null ? "no volume in the quote" : avg20 == null ? "no daily history" : n < 20 ? `${n} sessions of history, 20 wanted` : null;
  return { todayVolume: tv, avg20: avg20 == null ? null : Math.round(avg20), rel: rel == null ? null : Math.round(rel * 100) / 100, relPaced: relPaced == null ? null : Math.round(relPaced * 100) / 100, sessionFraction: frac, sessions: n, dataState, reason };
}

export interface QuietVolume {
  flag: boolean | null;
  relPaced: number | null;
  changePct: number | null;
  note: string;
}

/** Relative volume at or above `minRel` with the day's move inside `maxMovePct` (both fractions): volume without a price move. */
export function quietVolume(rv: RelativeVolume, changePct: number | null, minRel = 1.8, maxMovePct = 0.004): QuietVolume {
  const r = rv.relPaced ?? rv.rel;
  if (r == null || changePct == null || !Number.isFinite(changePct)) return { flag: null, relPaced: r, changePct, note: "needs relative volume and the day's change" };
  const flag = r >= minRel && Math.abs(changePct) <= maxMovePct;
  return {
    flag, relPaced: r, changePct,
    note: flag
      ? `volume ${r.toFixed(1)}x its pace with the price ${(changePct * 100).toFixed(2)}% on the day: heavy trading that did not move price. Consolidated tape cannot say where it printed.`
      : `volume ${r.toFixed(1)}x its pace, price ${(changePct * 100).toFixed(2)}% on the day`,
  };
}

export interface BlockPrintRead {
  available: boolean;
  prints: number;
  /** Share of the session's traded size that came in block-sized updates. */
  shareOfVolume: number | null;
  threshold: number | null;
  medianSize: number | null;
  largest: { size: number; price: number | null; t: number } | null;
  note: string;
}

/**
 * From Level-1 updates that carried a trade (`lastSize` present). A block is
 * an update whose size is at least `multiple` x the session's median print
 * and at least `floor` shares. Level-1 can coalesce prints, so a "block" is
 * a lower bound on what printed in that instant, never a venue.
 */
export function blockPrints(ticks: Array<{ t: number; last: number | null; lastSize: number | null; trade: boolean }>, multiple = 8, floor = 2_000): BlockPrintRead {
  const sizes = ticks.filter((k) => k.trade && k.lastSize != null && k.lastSize > 0);
  if (sizes.length < 50) return { available: false, prints: 0, shareOfVolume: null, threshold: null, medianSize: null, largest: null, note: sizes.length ? `${sizes.length} streamed prints: too few to size a block` : "no streamed prints for this symbol (block reads cover the streamed symbols only)" };
  const sorted = sizes.map((k) => k.lastSize!).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const threshold = Math.max(floor, median * multiple);
  const blocks = sizes.filter((k) => k.lastSize! >= threshold);
  const total = sizes.reduce((a, k) => a + k.lastSize!, 0);
  const blockVol = blocks.reduce((a, k) => a + k.lastSize!, 0);
  const largest = blocks.reduce<BlockPrintRead["largest"]>((best, k) => (!best || k.lastSize! > best.size ? { size: k.lastSize!, price: k.last, t: k.t } : best), null);
  return {
    available: true, prints: blocks.length, shareOfVolume: total > 0 ? Math.round((blockVol / total) * 1000) / 1000 : null, threshold, medianSize: median, largest,
    note: `${blocks.length} Level-1 updates at or above ${threshold.toLocaleString("en-US")} shares (${multiple}x the median print of ${median}); ${total > 0 ? `${((blockVol / total) * 100).toFixed(1)}% of streamed size` : "no size"}. Level-1 coalesces prints and carries no venue: a lower bound, not a dark-pool count.`,
  };
}
