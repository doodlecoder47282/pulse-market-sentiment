// server/leeReadyOfi.ts
//
// Wire 13 — 1-min SIGNED TICK VOLUME, session-cumulative trend (SPY volume proxy).
//
// Naming: this file keeps its historical name, but the method is a tick rule
// on 1-minute bars, NOT Lee-Ready (Lee & Ready 1991 classify each trade
// against the prevailing midquote) and NOT order-flow imbalance (Cont,
// Kukanov & Stoikov 2014 measure changes in best bid/ask depth). Each bar's
// whole volume is signed by its close-to-close change, which is close to
// on-balance volume. The UI calls it "signed tick volume".
//
// Deterministic bar-level tick rule (server/signedVolume.ts):
//   close > prev.close  → +1, signed volume = +volume
//   close < prev.close  → -1, signed volume = -volume
//   close == prev.close → zero-tick rule: persist last non-zero direction
//
// slope15m = sum of signed volumes over last 15 bars (proxy for trend strength)
// slope5m  = sum of signed volumes over last  5 bars (proxy for acceleration)
//
// Trend classification uses median bar volume * 5 as significance threshold so
// low-volume sessions (pre-open / after-hours noise) don't trigger spurious
// BULLISH/BEARISH reads.
//
// Acceleration: slope5m vs expected (slope15m / 3). If slope5m is > 1.3x the
// proportional expectation the trend is accelerating; < 0.7x it is decelerating.
//
// Bulk volume classification (Easley, Lopez de Prado & O'Hara 2012) is
// computed alongside as bvcCumulativeNow, a diagnostic only (past-only sigma,
// missing volume left unclassified). The trend keeps the bar-level tick rule
// for continuity; see signedVolume.ts for what the evidence does and does not
// say about that choice.
//
// Cache: 30 seconds (Schwab free tier ~ 1 req/s; no need to hammer it).
// Graceful degradation: returns NEUTRAL_TREND with dataState "unavailable"
// when bars cannot be fetched, so callers can tell "no data" from "flat".

import { getPriceHistory } from "./schwab.js";
import { signedTickVolumeBars, bulkVolumeClassify } from "./signedVolume";

export type OfiBar = {
  ts: number;
  close: number;
  volume: number;
  direction: 1 | -1 | 0;  // tick rule sign for this bar
  signedVolume: number;    // volume * direction
  cumulative: number;      // session-cumulative running sum
};

export type OfiTrend = {
  bars: OfiBar[];
  cumulativeNow: number;
  slope15m: number;        // signed volume sum over last 15 bars
  slope5m: number;         // signed volume sum over last 5 bars
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";  // from slope15m
  acceleration: "ACCELERATING" | "DECELERATING" | "FLAT";  // slope5m vs slope15m/3
  /** Honest method label for UI/API: tick rule on 1-min bars. */
  method: "tick-rule-1m";
  label: "signed tick volume";
  /** "unavailable" = bars could not be fetched; trend fields are placeholders, not a flat read. */
  dataState: "ok" | "unavailable";
  /** Diagnostic: session buy-minus-sell volume by bulk volume classification
   *  (past-only sigma); null when no bar could be classified. */
  bvcCumulativeNow: number | null;
};

const CACHE_MS = 30_000;
let cache: { ts: number; trend: OfiTrend } | null = null;

const NEUTRAL_TREND: OfiTrend = {
  bars: [],
  cumulativeNow: 0,
  slope15m: 0,
  slope5m: 0,
  trend: "NEUTRAL",
  acceleration: "FLAT",
  method: "tick-rule-1m",
  label: "signed tick volume",
  dataState: "unavailable",
  bvcCumulativeNow: null,
};

export async function computeOfiTrend(): Promise<OfiTrend> {
  if (cache && Date.now() - cache.ts < CACHE_MS) return cache.trend;

  // SPY, not $SPX.X — Schwab reports zero volume on index candles, which made
  // every signed-volume bar 0 and the panel permanently NEUTRAL/FLAT. SPY is
  // the liquid tradable proxy so the tick rule actually has volume.
  const history = await getPriceHistory("SPY", "day", 1, "minute", 1);
  if (!history.candles || history.candles.length < 2) {
    cache = { ts: Date.now(), trend: NEUTRAL_TREND };
    return NEUTRAL_TREND;
  }

  const candles = history.candles;
  const bars: OfiBar[] = signedTickVolumeBars(candles);
  const cumulative = bars.length > 0 ? bars[bars.length - 1].cumulative : 0;

  // Slopes: sum of signed volumes over last N bars
  const last15 = bars.slice(-15);
  const last5 = bars.slice(-5);
  const slope15m = last15.reduce((s, b) => s + b.signedVolume, 0);
  const slope5m = last5.reduce((s, b) => s + b.signedVolume, 0);

  // Trend classification
  // Threshold: |slope15m| must exceed median bar volume * 5 to be meaningful
  const medianVol = bars.length > 0
    ? bars.map(b => b.volume).sort((a, b) => a - b)[Math.floor(bars.length / 2)]
    : 0;
  const threshold = medianVol * 5;

  let trend: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  if (slope15m > threshold) trend = "BULLISH";
  else if (slope15m < -threshold) trend = "BEARISH";

  // Acceleration: compare slope5m to expected (slope15m / 3)
  const expected5 = slope15m / 3;
  let acceleration: "ACCELERATING" | "DECELERATING" | "FLAT" = "FLAT";
  if (Math.abs(slope5m) > Math.abs(expected5) * 1.3) acceleration = "ACCELERATING";
  else if (Math.abs(slope5m) < Math.abs(expected5) * 0.7) acceleration = "DECELERATING";

  const result: OfiTrend = {
    bars,
    cumulativeNow: cumulative,
    slope15m,
    slope5m,
    trend,
    acceleration,
    method: "tick-rule-1m",
    label: "signed tick volume",
    dataState: "ok",
    bvcCumulativeNow: (() => {
      const b = bulkVolumeClassify(candles).cumulativeSigned;
      return b == null ? null : Math.round(b);
    })(),
  };
  cache = { ts: Date.now(), trend: result };
  console.log(
    `[signedTickVolume] computeOfiTrend: bars=${bars.length} cum=${cumulative.toFixed(0)} ` +
    `slope15m=${slope15m.toFixed(0)} slope5m=${slope5m.toFixed(0)} ` +
    `trend=${trend} accel=${acceleration}`,
  );
  return result;
}
