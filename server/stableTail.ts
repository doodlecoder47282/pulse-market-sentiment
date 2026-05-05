// server/stableTail.ts
//
// Tier 3 experiment #3 — Stable-distribution tail z-score for "today is a
// black-swan day" alerts only. We don't fully fit a stable distribution
// (that's a research project on its own); instead, we use Mandelbrot's
// observation that fat-tailed return distributions vastly underestimate
// extreme moves under Gaussian assumptions. A modified-z based on rolling
// MAD (which is far more robust to fat tails than σ) gives a calibrated
// "this move is in the X-sigma fat tail" flag.
//
// Pure observer. Returns {tailZ, isExtreme, percentile} from a return series.
// Caller decides whether to alert.

export type TailFlag = {
  tailZ: number;        // MAD-based modified z-score
  isExtreme: boolean;   // true when |tailZ| > 5.0 (Mandelbrot fat-tail threshold)
  isWarning: boolean;   // 3.5 < |tailZ| ≤ 5.0 — early warning
  percentile: number;   // empirical |return| percentile in the recent window
  median: number;
  mad: number;
  reason: string;
};

const EXTREME_Z = 5.0;
const WARNING_Z = 3.5;

/**
 * Flag whether `todayReturn` (decimal, e.g. -0.04 for -4%) is a fat-tail event
 * relative to a recent window of daily returns.
 *
 * @param recentReturns  trailing N daily returns (decimal), oldest → newest
 *                       Recommended N ≥ 60.
 */
export function flagTailEvent(
  todayReturn: number,
  recentReturns: number[],
): TailFlag {
  if (!isFinite(todayReturn)) {
    return {
      tailZ: NaN, isExtreme: false, isWarning: false,
      percentile: NaN, median: NaN, mad: NaN,
      reason: "non-finite today return",
    };
  }
  const r = recentReturns.filter(Number.isFinite);
  if (r.length < 30) {
    return {
      tailZ: 0, isExtreme: false, isWarning: false,
      percentile: 0, median: 0, mad: 0,
      reason: `need ≥30 recent returns, have ${r.length}`,
    };
  }

  // Median + MAD (median absolute deviation) — robust to fat tails
  const sorted = [...r].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const absDevs = r.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  const mad = absDevs[Math.floor(absDevs.length / 2)] || 0;

  // Modified z-score: 0.6745 = E[|Z|] for standard normal — same calibration
  // factor used in industrial outlier detection.
  const tailZ = mad > 0 ? (0.6745 * (todayReturn - median)) / mad : 0;

  // Empirical percentile of |today|
  const absToday = Math.abs(todayReturn);
  const allAbs = [...absDevs];
  allAbs.push(absToday);
  allAbs.sort((a, b) => a - b);
  const idx = allAbs.indexOf(absToday);
  const percentile = idx / Math.max(1, allAbs.length - 1);

  const absZ = Math.abs(tailZ);
  return {
    tailZ,
    isExtreme: absZ > EXTREME_Z,
    isWarning: absZ > WARNING_Z && absZ <= EXTREME_Z,
    percentile,
    median,
    mad,
    reason:
      absZ > EXTREME_Z ? "fat-tail extreme event"
      : absZ > WARNING_Z ? "fat-tail warning zone"
      : "within normal regime",
  };
}
