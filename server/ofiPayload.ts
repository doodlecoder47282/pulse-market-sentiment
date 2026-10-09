// server/ofiPayload.ts
//
// Shapes the /api/ofi response from computeOfiTrend() (leeReadyOfi.ts). Pure,
// so the data-state rules are unit-tested (tests/quant/infra-ui-r2.test.ts).
//
// The route used to drop dataState and the per-bar volumeMissing flag, so the
// client could not tell "feed failed" from "flat tape": an all-missing tape
// rendered as "no prints / feed idle" and a partial tape drew missing bars as
// zero-height bars under a BULLISH/BEARISH badge.
//
// Rules carried here:
//   - dataState and a plain-language reason travel with the payload.
//   - A bar whose candle had no volume is sent with volumeMissing: true and
//     signedVolume: null (a gap, not a zero).
//   - The 15m slope is a sum over the last 15 bars and the 5m acceleration is
//     judged against it. If any bar in that window has no volume the sum is
//     incomplete, so trendComplete is false and the client withholds the trend
//     and acceleration badges instead of showing a biased read.
//   - asOfMs is the last bar's timestamp (data time), not the request time.

export type OfiDataState = "ok" | "partial" | "unavailable";

export interface OfiTrendLike {
  bars: Array<{ ts: number; signedVolume: number; cumulative: number; volumeMissing?: boolean }>;
  cumulativeNow: number;
  slope15m: number;
  slope5m: number;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  acceleration: "ACCELERATING" | "DECELERATING" | "FLAT";
  dataState: OfiDataState;
  volumeMissingBars?: number;
}

export interface OfiApiBar {
  ts: number;
  /** null when the minute candle carried no volume (gap, not zero). */
  signedVolume: number | null;
  cumulative: number;
  volumeMissing: boolean;
}

export const OFI_TREND_WINDOW = 15;
export const OFI_TAIL_BARS = 60;

export function ofiApiPayload(trend: OfiTrendLike, nowMs: number) {
  const all = trend.bars;
  const tail: OfiApiBar[] = all.slice(-OFI_TAIL_BARS).map((b) => {
    const missing = b.volumeMissing === true;
    return { ts: b.ts, signedVolume: missing ? null : b.signedVolume, cumulative: b.cumulative, volumeMissing: missing };
  });
  const window = all.slice(-OFI_TREND_WINDOW);
  const trendWindowMissingBars = window.filter((b) => b.volumeMissing === true).length;
  const volumeMissingBars = trend.volumeMissingBars ?? all.filter((b) => b.volumeMissing === true).length;
  const trendComplete =
    trend.dataState !== "unavailable" && window.length >= OFI_TREND_WINDOW && trendWindowMissingBars === 0;

  let dataStateReason: string | null = null;
  if (trend.dataState === "unavailable") {
    dataStateReason = all.length === 0
      ? "SPY minute bars could not be fetched from Schwab"
      : "every SPY minute bar arrived without volume";
  } else if (trend.dataState === "partial") {
    dataStateReason = `${volumeMissingBars} of ${all.length} minute bars arrived without volume (shown as gaps)`;
  }

  return {
    bars: tail,
    cumulativeNow: trend.cumulativeNow,
    slope15m: trend.slope15m,
    slope5m: trend.slope5m,
    trend: trend.trend,
    acceleration: trend.acceleration,
    dataState: trend.dataState,
    dataStateReason,
    volumeMissingBars,
    totalBars: all.length,
    trendWindowMissingBars,
    trendComplete,
    asOfMs: all.length > 0 ? all[all.length - 1].ts : null,
    capturedAt: Math.floor(nowMs / 1000),
  };
}

export type OfiApiPayload = ReturnType<typeof ofiApiPayload>;
