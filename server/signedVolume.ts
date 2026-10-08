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
//    price changes; dP = 0 splits the bar 50/50. Computed alongside as a
//    diagnostic only. The panel keeps the tick rule because Chakrabarty,
//    Pascual & Shkilko (2015, J. Financial Markets, "Evaluating trade
//    classification algorithms: BVC versus the tick rule and the Lee-Ready
//    algorithm") find the tick rule and Lee-Ready classify equity volume
//    more accurately than BVC.

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
    const volume = c.volume || 0;
    const signedVolume = volume * direction;
    cumulative += signedVolume;
    bars.push({ ts: c.datetime, close: c.close, volume, direction, signedVolume, cumulative });
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

export interface BvcResult {
  /** Per bar (from the second candle): buy fraction Z(dP/sigma). */
  buyFraction: number[];
  /** Sum over bars of V * (2 * buyFraction - 1) = buy volume - sell volume. */
  cumulativeSigned: number;
  sigma: number;
}

/** Bulk volume classification over a session of bars (EL-O 2012, eq. 7). */
export function bulkVolumeClassify(candles: MinuteCandleLike[]): BvcResult {
  const dP: number[] = [];
  for (let i = 1; i < candles.length; i++) dP.push(candles[i].close - candles[i - 1].close);
  let sigma = 0;
  if (dP.length >= 2) {
    const mean = dP.reduce((s, x) => s + x, 0) / dP.length;
    const v = dP.reduce((s, x) => s + (x - mean) ** 2, 0) / (dP.length - 1);
    sigma = Math.sqrt(v);
  }
  const buyFraction: number[] = [];
  let cumulativeSigned = 0;
  for (let i = 0; i < dP.length; i++) {
    const f = sigma > 0 ? normalCdf(dP[i] / sigma) : 0.5;
    buyFraction.push(f);
    cumulativeSigned += (candles[i + 1].volume || 0) * (2 * f - 1);
  }
  return { buyFraction, cumulativeSigned, sigma };
}
