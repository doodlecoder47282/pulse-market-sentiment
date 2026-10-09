// server/stableTail.ts
//
// Tier 3 experiment #3 — robust tail z-score for "today is an unusually large
// move" alerts. No stable (or any other) distribution is fitted. The score is
// the MODIFIED z-score of Iglewicz & Hoaglin (1993), "How to Detect and Handle
// Outliers", ASQC Basic References in Quality Control vol. 16:
//
//   M = 0.6745 (x - median) / MAD,   MAD = median |x_i - median|.
//
// 0.6745 = Phi^-1(0.75) is the MAD of a standard normal (the median of |Z|),
// so MAD / 0.6745 estimates sigma for normal data and M is on a sigma scale.
// (It is NOT E|Z|: that is sqrt(2/pi) = 0.798.) Median and MAD are robust to
// the very fat tails being flagged, which is why they are used instead of
// mean and standard deviation. Iglewicz & Hoaglin suggest |M| > 3.5 as a
// potential outlier; the 5.0 "extreme" cut is a house heuristic.
//
// Nothing here is calibrated: the thresholds are conventions, and neither the
// alert rate nor its forward usefulness has been tested. For a model-free tail
// read, `empiricalExceedance` gives the share of the trailing window whose
// absolute deviation from the median was at least today's.
//
// Pure observer. Caller decides whether to alert. Missing or degenerate input
// returns NaN scores with dataState set, never a "calm" 0.

export type TailFlag = {
  tailZ: number;        // modified z-score (NaN when not computable)
  isExtreme: boolean;   // |tailZ| > 5.0 (house heuristic)
  isWarning: boolean;   // 3.5 < |tailZ| <= 5.0 (Iglewicz-Hoaglin outlier cut)
  /** Empirical percentile of |today - median| among the window's |x_i - median| (0-1). */
  percentile: number;
  /** Share of the window with |x_i - median| >= |today - median| (0-1). */
  empiricalExceedance: number;
  median: number;
  mad: number;
  dataState: "ok" | "insufficient" | "degenerate" | "invalid";
  reason: string;
};

const EXTREME_Z = 5.0;
const WARNING_Z = 3.5;
/** Phi^-1(0.75): MAD of N(0,1). */
export const MAD_NORMAL = 0.6745;

/**
 * Flag whether `todayReturn` (decimal, e.g. -0.04 for -4%) is a tail event
 * relative to a recent window of daily returns.
 *
 * @param recentReturns  trailing N daily returns (decimal), oldest → newest
 *                       Recommended N ≥ 60; N < 30 is "insufficient".
 */
export function flagTailEvent(
  todayReturn: number,
  recentReturns: number[],
): TailFlag {
  const none = (dataState: TailFlag["dataState"], reason: string, median = NaN, mad = NaN): TailFlag => ({
    tailZ: NaN, isExtreme: false, isWarning: false,
    percentile: NaN, empiricalExceedance: NaN, median, mad, dataState, reason,
  });
  if (!isFinite(todayReturn)) return none("invalid", "non-finite today return");
  const r = recentReturns.filter(Number.isFinite);
  if (r.length < 30) return none("insufficient", `need ≥30 recent returns, have ${r.length}`);

  const sorted = [...r].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? 0.5 * (sorted[mid - 1] + sorted[mid]) : sorted[mid];
  const absDevs = r.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  const md = Math.floor(absDevs.length / 2);
  const mad = absDevs.length % 2 === 0 ? 0.5 * (absDevs[md - 1] + absDevs[md]) : absDevs[md];
  if (!(mad > 0)) return none("degenerate", "MAD is zero (constant returns): z-score undefined", median, mad);

  const tailZ = (MAD_NORMAL * (todayReturn - median)) / mad;

  // Today's absolute deviation against the window's absolute deviations
  // (same quantity on both sides; the old code mixed |today| with deviations).
  const dToday = Math.abs(todayReturn - median);
  let below = 0, atOrAbove = 0;
  for (const d of absDevs) { if (d < dToday) below++; else atOrAbove++; }
  const percentile = below / absDevs.length;
  const empiricalExceedance = atOrAbove / absDevs.length;

  const absZ = Math.abs(tailZ);
  return {
    tailZ,
    isExtreme: absZ > EXTREME_Z,
    isWarning: absZ > WARNING_Z && absZ <= EXTREME_Z,
    percentile,
    empiricalExceedance,
    median,
    mad,
    dataState: "ok",
    reason:
      absZ > EXTREME_Z ? "beyond 5 robust sigmas (house heuristic)"
      : absZ > WARNING_Z ? "beyond 3.5 robust sigmas (Iglewicz-Hoaglin outlier cut)"
      : "within 3.5 robust sigmas",
  };
}
