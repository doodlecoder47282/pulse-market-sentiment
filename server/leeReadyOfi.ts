// server/leeReadyOfi.ts
//
// Wire 13 — 1-min Lee-Ready OFI session-cumulative trend.
//
// Deterministic bar-level tick-rule approximation:
//   close > prev.close  → buy  (direction = +1), signed volume = +volume
//   close < prev.close  → sell (direction = -1), signed volume = -volume
//   close == prev.close → zero-tick rule: persist last non-zero direction
//
// Session-cumulative signed volume tracks net order-flow imbalance (OFI).
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
// Cache: 30 seconds (Schwab free tier ~ 1 req/s; no need to hammer it).
// Graceful degradation: returns NEUTRAL_TREND on any error.

import { getPriceHistory } from "./schwab.js";

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
};

export async function computeOfiTrend(): Promise<OfiTrend> {
  if (cache && Date.now() - cache.ts < CACHE_MS) return cache.trend;

  const history = await getPriceHistory("$SPX.X", "day", 1, "minute", 1);
  if (!history.candles || history.candles.length < 2) {
    cache = { ts: Date.now(), trend: NEUTRAL_TREND };
    return NEUTRAL_TREND;
  }

  const candles = history.candles;
  const bars: OfiBar[] = [];
  let lastDirection: 1 | -1 | 0 = 0;
  let cumulative = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    let direction: 1 | -1 | 0;
    if (c.close > prev.close) direction = 1;
    else if (c.close < prev.close) direction = -1;
    else direction = lastDirection; // zero-tick rule: persist last sign

    const signedVolume = (c.volume || 0) * direction;
    cumulative += signedVolume;
    bars.push({
      ts: c.datetime,
      close: c.close,
      volume: c.volume || 0,
      direction,
      signedVolume,
      cumulative,
    });
    if (direction !== 0) lastDirection = direction;
  }

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
  };
  cache = { ts: Date.now(), trend: result };
  console.log(
    `[leeReadyOfi] computeOfiTrend: bars=${bars.length} cum=${cumulative.toFixed(0)} ` +
    `slope15m=${slope15m.toFixed(0)} slope5m=${slope5m.toFixed(0)} ` +
    `trend=${trend} accel=${acceleration}`,
  );
  return result;
}
