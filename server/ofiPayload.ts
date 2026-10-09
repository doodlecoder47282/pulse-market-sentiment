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
  /** Session-cumulative signed volume; null from the first bar without volume onward (an unknown term makes every later sum unknown). */
  cumulative: number | null;
  volumeMissing: boolean;
}

export const OFI_TREND_WINDOW = 15;
export const OFI_TAIL_BARS = 60;
/**
 * Max age of the last minute bar (bar start time) before the tape counts as
 * stale during the regular session: a completed bar is ~1-2 min old when
 * Schwab publishes it, so 5 min means at least two bars are missing.
 * Operating limit (heuristic), shared by the panel and the trade environment.
 */
export const OFI_MAX_AGE_MS = 5 * 60_000;

/** During the session, the tape is stale when its last bar is older than OFI_MAX_AGE_MS (or there is none). Outside the session: not judged (false). */
export function ofiTapeStale(bars: Array<{ ts: number }>, nowMs: number, sessionOpen: boolean): boolean {
  if (!sessionOpen) return false;
  if (!bars.length) return true;
  return nowMs - bars[bars.length - 1].ts > OFI_MAX_AGE_MS;
}

/** True when the last 15 bars all carry volume (the 15m slope is a complete sum). */
export function ofiTrendWindowComplete(bars: Array<{ volumeMissing?: boolean }>): boolean {
  const w = bars.slice(-OFI_TREND_WINDOW);
  return w.length >= OFI_TREND_WINDOW && w.every((b) => b.volumeMissing !== true);
}

export function ofiApiPayload(trend: OfiTrendLike, nowMs: number) {
  const all = trend.bars;
  const firstGap = all.findIndex((b) => b.volumeMissing === true);
  const tailStart = Math.max(0, all.length - OFI_TAIL_BARS);
  const tail: OfiApiBar[] = all.slice(tailStart).map((b, i) => {
    const missing = b.volumeMissing === true;
    const afterGap = firstGap >= 0 && tailStart + i >= firstGap;
    return { ts: b.ts, signedVolume: missing ? null : b.signedVolume, cumulative: afterGap ? null : b.cumulative, volumeMissing: missing };
  });
  const window = all.slice(-OFI_TREND_WINDOW);
  const trendWindowMissingBars = window.filter((b) => b.volumeMissing === true).length;
  const volumeMissingBars = trend.volumeMissingBars ?? all.filter((b) => b.volumeMissing === true).length;
  const trendComplete = trend.dataState !== "unavailable" && ofiTrendWindowComplete(all);

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
    // Unknown once any bar lacked volume (not "the sum of the known bars").
    cumulativeNow: firstGap >= 0 ? null : trend.cumulativeNow,
    cumulativeNote: firstGap >= 0 ? `cumulative unknown from ${volumeMissingBars} bar(s) without volume onward` : null,
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
