// server/volumeProfile.ts
//
// Deterministic VWAP + Volume Profile computation from intraday OHLCV bars.
// No external APIs at score time — all inputs from cached ohlc data.
//
// Sources:
//   Paper O: arxiv 2406.17198 (SPY volume VWAP formula + session seasonality)
//   Paper F: SSRN 5095349 (Maróy — VWAP as asymmetric trailing-stop discipline)
//   Standard market microstructure: POC/VAH/VAL per 70% value-area convention
//
// Bar resolution: degrades gracefully.
//   - 1-min bars → accurate tick-level histogram
//   - 5-min bars → coarser POC/VAH/VAL, VWAP still precise (cumulative PV/V)
//   - 15-min bars → usable for VWAP; VAH/VAL ±2-3 ticks wide
//   If NO intraday bars are available → returns null (Wire 7 skips gracefully)

import type { Candle } from "./ohlc";

export interface VolumeProfileResult {
  vwap: number;
  poc: number;
  vah: number;
  val: number;
  spotVsVwap: number;        // (spot - vwap) / vwap
  inValueArea: boolean;
  aboveVwap: boolean;
  pocDist: number;
  vwapStretchZ: number | null; // Wire 8 — Paper E re-engineered: z-score of (spot-vwap)/vwap vs today's bar stdev. null when <10 bars.
}

/**
 * Compute session VWAP and volume profile from intraday OHLCV bars.
 *
 * @param bars     - Intraday OHLCV bars for the current RTH session (9:30–now).
 *                   Any resolution (1-min, 5-min, 15-min) — VWAP degrades gracefully.
 * @param spot     - Current spot price (used for spotVsVwap, inValueArea, aboveVwap, pocDist).
 * @param tickSize - Price bucket width for volume histogram.
 *                   Default 0.25 for SPX (index-point space, ~5500–7500).
 *                   Use 0.01 for SPY (ETF, ~550–750).
 *
 * @returns VolumeProfileResult or null if bars is empty or total volume is zero.
 */
export function computeVolumeProfile(
  bars: Candle[],
  spot: number,
  tickSize = 0.25,
): VolumeProfileResult | null {
  if (!bars.length) return null;

  // ── 1. VWAP: Σ(typicalPrice_i × volume_i) / Σ(volume_i) ──────────────────
  // typicalPrice = (high + low + close) / 3  — standard HLC/3 per Paper O Rule 2
  let cumPV = 0;
  let cumV = 0;
  const histogram: Map<number, number> = new Map();

  for (const b of bars) {
    const v = b.v ?? 0;
    if (v <= 0) continue;
    const typical = (b.h + b.l + b.c) / 3;
    cumPV += typical * v;
    cumV += v;

    // Volume profile histogram: bucket by tick size
    // Round typical to nearest tickSize bucket center
    const bucket = Math.round(typical / tickSize) * tickSize;
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + v);
  }

  if (cumV === 0) return null;
  const vwap = cumPV / cumV;

  // ── 1b. VWAP stretch z-score (Wire 8 — Paper E re-engineered) ────────────
  // For each bar, compute relative deviation = (close - vwap) / vwap.
  // stdev of all bar deviations → current stretch z = (spot - vwap)/vwap / stdev.
  // null when <10 bars (insufficient sample for reliable stdev).
  let vwapStretchZ: number | null = null;
  {
    const deviations: number[] = [];
    for (const b of bars) {
      if ((b.v ?? 0) <= 0) continue;
      const dev = (b.c - vwap) / vwap;
      deviations.push(dev);
    }
    if (deviations.length >= 10) {
      const mean = deviations.reduce((s, d) => s + d, 0) / deviations.length;
      const variance = deviations.reduce((s, d) => s + (d - mean) ** 2, 0) / deviations.length;
      const stdev = Math.sqrt(variance);
      if (stdev > 0) {
        const currentDev = (spot - vwap) / vwap;
        vwapStretchZ = currentDev / stdev;
      }
    }
  }

  // ── 2. POC = price bucket with maximum volume ─────────────────────────────
  let poc = 0;
  let maxVol = 0;
  for (const [price, vol] of histogram) {
    if (vol > maxVol) {
      maxVol = vol;
      poc = price;
    }
  }

  // ── 3. Value Area (70% of total volume, expanding outward from POC) ───────
  // Standard convention: start at POC, expand to the adjacent bucket with
  // more volume (up or down), repeat until ≥ 70% of total volume is enclosed.
  const targetVol = cumV * 0.70;

  // Sort histogram by price ascending for index arithmetic
  const sortedBuckets = [...histogram.entries()].sort((a, b) => a[0] - b[0]);
  const pocIdx = sortedBuckets.findIndex(([p]) => p === poc);

  let lo = pocIdx;
  let hi = pocIdx;
  let accumulated = maxVol;

  while (accumulated < targetVol && (lo > 0 || hi < sortedBuckets.length - 1)) {
    const downVol = lo > 0 ? sortedBuckets[lo - 1][1] : 0;
    const upVol   = hi < sortedBuckets.length - 1 ? sortedBuckets[hi + 1][1] : 0;

    if (upVol >= downVol && hi < sortedBuckets.length - 1) {
      hi++;
      accumulated += sortedBuckets[hi][1];
    } else if (lo > 0) {
      lo--;
      accumulated += sortedBuckets[lo][1];
    } else {
      // Only upside expansion remains
      hi++;
      accumulated += sortedBuckets[hi][1];
    }
  }

  const val = sortedBuckets[lo][0];   // Value Area Low
  const vah = sortedBuckets[hi][0];   // Value Area High

  return {
    vwap,
    poc,
    vah,
    val,
    spotVsVwap: (spot - vwap) / vwap,
    inValueArea: spot >= val && spot <= vah,
    aboveVwap: spot > vwap,
    pocDist: Math.abs(spot - poc),
    vwapStretchZ,
  };
}
