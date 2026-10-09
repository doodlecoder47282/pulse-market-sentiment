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
//   - The signing method travels with the payload (R3-2 item 3): "tick-rule-1m"
//     (bar-level tick rule on Schwab REST minute bars), "lee-ready-l1" (every
//     minute from Schwab LEVELONE trade blocks signed by Lee-Ready against the
//     prior quote) or "hybrid-l1" (bar rule, then trade blocks from
//     tradeLevelFromMs). methodLabel / methodNote are what the UI shows, so
//     the panel never calls a Lee-Ready read "tick rule" or the reverse.
//     Lee & Ready (1991), "Inferring Trade Direction from Intraday Data",
//     J. Finance 46(2), https://doi.org/10.1111/j.1540-6261.1991.tb02683.x

export type OfiDataState = "ok" | "partial" | "unavailable";
export type OfiMethod = "tick-rule-1m" | "lee-ready-l1" | "hybrid-l1";
export type OfiTradeLevelCounts = { quoteRule: number; tickRule: number; unsigned: number };

/** UI label and note for the signing method; counts give the Lee-Ready coverage of trade blocks. */
export function ofiMethodLabel(
  method: OfiMethod | undefined,
  tradeLevelFromMs: number | null | undefined,
  counts: OfiTradeLevelCounts | null | undefined,
): { methodLabel: string; methodNote: string; tradeLevelCoveragePct: number | null } {
  const total = counts ? counts.quoteRule + counts.tickRule + counts.unsigned : 0;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
  const coverage = counts && total > 0
    ? `${total} trade blocks this stream session: ${pct(counts.quoteRule)}% quote rule, ${pct(counts.tickRule)}% tick rule (at the mid), ${pct(counts.unsigned)}% unsigned.`
    : "";
  const blockNote = "A LEVELONE trade block is the volume between two streamed updates (one or more prints at the update's last price); Schwab provides no time-and-sales tape.";
  const from = tradeLevelFromMs != null
    ? new Date(tradeLevelFromMs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET"
    : null;
  if (method === "lee-ready-l1") {
    return {
      methodLabel: "Signed volume · Lee-Ready on streamed trades (SPY)",
      methodNote: `Every minute shown is the sum of Schwab LEVELONE trade blocks signed by Lee-Ready against the prior quote (quote rule; tick rule at the mid). ${blockNote} ${coverage}`.trim(),
      tradeLevelCoveragePct: total > 0 ? pct(counts!.quoteRule + counts!.tickRule) : null,
    };
  }
  if (method === "hybrid-l1") {
    return {
      methodLabel: `Signed volume · tick rule, Lee-Ready from ${from ?? "stream start"} (SPY)`,
      methodNote: `Minutes before ${from ?? "the stream start"}: tick rule on 1-minute Schwab bars (whole bar volume signed by close-to-close change). From then: Schwab LEVELONE trade blocks signed by Lee-Ready against the prior quote. ${blockNote} ${coverage}`.trim(),
      tradeLevelCoveragePct: total > 0 ? pct(counts!.quoteRule + counts!.tickRule) : null,
    };
  }
  return {
    methodLabel: "Signed tick volume · 1m (SPY proxy)",
    methodNote: "Signed tick volume: tick rule on 1-minute SPY closes; each bar's whole volume takes the sign of its close-to-close change (zero change keeps the last sign). Not Lee-Ready trade classification and not order-book OFI. The Schwab stream is not live, so no trade-level read.",
    tradeLevelCoveragePct: null,
  };
}

export interface OfiTrendLike {
  bars: Array<{ ts: number; signedVolume: number; cumulative: number; volumeMissing?: boolean }>;
  cumulativeNow: number;
  slope15m: number;
  slope5m: number;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  acceleration: "ACCELERATING" | "DECELERATING" | "FLAT";
  dataState: OfiDataState;
  volumeMissingBars?: number;
  method?: OfiMethod;
  tradeLevelFromMs?: number | null;
  tradeLevelCounts?: OfiTradeLevelCounts | null;
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

  const m = ofiMethodLabel(trend.method, trend.tradeLevelFromMs, trend.tradeLevelCounts);
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
    method: trend.method ?? "tick-rule-1m",
    methodLabel: m.methodLabel,
    methodNote: m.methodNote,
    tradeLevelFromMs: trend.tradeLevelFromMs ?? null,
    tradeLevelCounts: trend.tradeLevelCounts ?? null,
    tradeLevelCoveragePct: m.tradeLevelCoveragePct,
  };
}

export type OfiApiPayload = ReturnType<typeof ofiApiPayload>;
