// server/signedVolume.ts
//
// Pure bar-level volume signing used by the Wire 13 "signed tick volume"
// read (server/leeReadyOfi.ts). No network, no DB.
//
// 1) Tick rule on bars (what the panel uses): each bar's whole volume takes
//    the sign of close[i] - close[i-1]; a zero change keeps the last non-zero
//    sign (zero-tick rule). Behavior is unchanged from the original inline
//    code in leeReadyOfi.ts; it was only moved here so it can be tested.
//
// 2) Bulk volume classification (BVC), Easley, Lopez de Prado & O'Hara
//    (2012), "Flow Toxicity and Liquidity in a High-frequency World", RFS
//    25(5), eq. (7): buy volume of bar i = V_i * Z(dP_i / sigma_dP), with Z
//    the standard normal CDF and sigma_dP the standard deviation of bar-to-bar
//    price changes. Computed alongside as a diagnostic only.
//    No look-ahead: sigma for bar i uses only the price changes BEFORE bar i
//    (expanding window over the bars passed in, at least BVC_MIN_PAST_CHANGES
//    of them); earlier bars are left unclassified. A bar with missing volume
//    is unclassified (its price change still feeds later sigmas); it is never
//    counted as zero volume.
//
// Why the panel uses the bar-level tick rule: continuity with the original
// Wire 13 read, not evidence. Published comparisons (e.g. Chakrabarty,
// Pascual & Shkilko 2015, J. Financial Markets) rank BVC against the
// TRADE-level tick rule and Lee-Ready, which need individual trade prints this
// app does not have; they do not show that a tick rule on 1-minute bars beats
// BVC. Neither read here is trade-level aggressor data.

export interface MinuteCandleLike {
  datetime: number;
  close: number;
  volume?: number | null;
}

export interface SignedTickBar {
  ts: number;
  close: number;
  volume: number;
  direction: 1 | -1 | 0;
  signedVolume: number;
  cumulative: number;
  /** True when the candle had no volume: the bar adds nothing and is not a 0-volume print. */
  volumeMissing?: boolean;
}

/** Tick rule on bars. Returns one bar per candle after the first. */
export function signedTickVolumeBars(candles: MinuteCandleLike[]): SignedTickBar[] {
  const bars: SignedTickBar[] = [];
  let lastDirection: 1 | -1 | 0 = 0;
  let cumulative = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    let direction: 1 | -1 | 0;
    if (c.close > prev.close) direction = 1;
    else if (c.close < prev.close) direction = -1;
    else direction = lastDirection; // zero-tick rule: persist last sign
    const volumeMissing = c.volume == null || !Number.isFinite(c.volume);
    const volume = volumeMissing ? 0 : (c.volume as number);
    const signedVolume = volume * direction;
    cumulative += signedVolume;
    bars.push({ ts: c.datetime, close: c.close, volume, direction, signedVolume, cumulative, ...(volumeMissing ? { volumeMissing: true } : {}) });
    if (direction !== 0) lastDirection = direction;
  }
  return bars;
}

/**
 * Standard normal CDF via erf, Abramowitz & Stegun 7.1.26
 * (|error| < 1.5e-7, ample for volume splitting).
 */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Minimum number of past price changes before a bar can be classified. */
export const BVC_MIN_PAST_CHANGES = 10;

export interface BvcResult {
  /**
   * Per bar from the second candle: buy fraction Z(dP / sigma_past), or null
   * when the bar is unclassified (too few past changes, sigma 0, or missing
   * volume).
   */
  buyFraction: (number | null)[];
  /** Sum over classified bars of V * (2 * buyFraction - 1); null when no bar was classified. */
  cumulativeSigned: number | null;
  /** sigma used for the LAST bar (past changes only); 0 when not yet estimable. */
  sigma: number;
  barsClassified: number;
  barsMissingVolume: number;
}

function finiteVolume(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Bulk volume classification over a session of bars (ELO 2012, eq. 7), no look-ahead. */
export function bulkVolumeClassify(candles: MinuteCandleLike[]): BvcResult {
  const buyFraction: (number | null)[] = [];
  let cumulativeSigned = 0;
  let barsClassified = 0;
  let barsMissingVolume = 0;
  // Running sums of past price changes (Welford's method for the variance).
  let n = 0;
  let mean = 0;
  let m2 = 0;
  let sigma = 0;
  for (let i = 1; i < candles.length; i++) {
    const dP = candles[i].close - candles[i - 1].close;
    sigma = n >= 2 ? Math.sqrt(m2 / (n - 1)) : 0;
    const vol = finiteVolume(candles[i].volume);
    if (vol == null) barsMissingVolume++;
    if (n >= BVC_MIN_PAST_CHANGES && sigma > 0 && vol != null && Number.isFinite(dP)) {
      const f = normalCdf(dP / sigma);
      buyFraction.push(f);
      cumulativeSigned += vol * (2 * f - 1);
      barsClassified++;
    } else {
      buyFraction.push(null);
    }
    // Only now add this bar's change, so it informs later bars only.
    if (Number.isFinite(dP)) {
      n++;
      const d = dP - mean;
      mean += d / n;
      m2 += d * (dP - mean);
    }
  }
  return {
    buyFraction,
    cumulativeSigned: barsClassified > 0 ? cumulativeSigned : null,
    sigma,
    barsClassified,
    barsMissingVolume,
  };
}
