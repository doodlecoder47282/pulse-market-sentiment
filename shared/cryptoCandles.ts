// shared/cryptoCandles.ts
//
// The 1-minute tape of a tracked pair, read as measurements. Pure.
//
// The desk's own refresh is ~4 minutes, so it never saw what happens inside a
// sample interval: the first dip after the launch high, whether it was bought
// back and how fast, wicks against bodies, volume into the signal. These are
// the things a trader reads top-down from the lower timeframe. Here each one
// is a number with its method stated, recorded on the signal row (features
// .candles) for the grader to correlate with outcomes. NOTHING here moves a
// verdict, a score or an exit level; a feature earns that only when the graded
// record shows it separates winners from losers (docs/CRYPTO_DESK.md).
//
// Source: GeckoTerminal /networks/solana/pools/{pool}/ohlcv/minute (keyless),
// newest first; normalised to oldest first here.

export interface Candle {
  /** Candle open, epoch ms. */
  t: number;
  o: number; h: number; l: number; c: number;
  /** Quote volume, USD. */
  v: number;
}

export const CANDLE_METHOD = "1-minute OHLCV (GeckoTerminal; intervals with no swaps are skipped, so a candle is a traded minute, not a clock minute); window high = highest high in the candles read; first dip = the first local low after the high before any 90% reclaim; deepest low = lowest low after the high; reclaim = share of the window high regained by the latest close; wicks over the last 10 candles; volume = last 5 candles vs the 5 before; measurements only, no gate";

/** Candles needed before any feature is read (fewer is "insufficient", never a number). */
export const CANDLES_MIN = 10;
/** Reclaim threshold the `reclaimed` flag uses: latest close at or above this share of the window high. */
export const RECLAIM_SHARE = 0.9;
/** A tape whose last candle is older than this is stale: the read failed or the pair stopped trading; either way not "now". */
export const TAPE_STALE_MINUTES = 15;
const WICK_WINDOW = 10;
const VOL_WINDOW = 5;

export interface CandleFeatures {
  /** "stale": the last candle is older than TAPE_STALE_MINUTES or the latest read failed; the numbers are from the last good read and say so. */
  state: "ok" | "stale" | "insufficient" | "unavailable";
  candles: number;
  spanMinutes: number | null;
  /** When the candles were read from the source (epoch ms) and the open of the last candle; age of the tape in minutes at `nowMs`. */
  readAt: number | null;
  lastCandleAt: number | null;
  tapeAgeMinutes: number | null;
  /** Highest high in the candles read (the launch high only when the window reaches back to the launch) and minutes since it printed. */
  windowHigh: number | null;
  minutesSinceHigh: number | null;
  /** The FIRST local low after the high before any 90% reclaim: depth from the high, percent, and minutes after the high. Null when the high is the latest candle. */
  firstDipPct: number | null;
  minutesHighToFirstDip: number | null;
  /** The DEEPEST low after the high (max drawdown from the high): percent and minutes after the high. */
  maxDrawdownPct: number | null;
  minutesHighToDeepestLow: number | null;
  /** Latest close as a share of the window high (1 = back at the high). */
  reclaimShare: number | null;
  /** Latest close at or above RECLAIM_SHARE of the window high. */
  reclaimed: boolean | null;
  /** Minutes from the FIRST dip's low to the first close at or above RECLAIM_SHARE x high; null if never. */
  minutesToReclaim: number | null;
  /** Over the last WICK_WINDOW candles: upper and lower wick length as a share of total range (0..1 each). */
  upperWickShare: number | null;
  lowerWickShare: number | null;
  /** Share of the last WICK_WINDOW candles that closed above their open. */
  upCloseShare: number | null;
  /** Volume of the last VOL_WINDOW candles divided by the VOL_WINDOW before (1 = flat); null if the prior window had none. */
  volumeTrend: number | null;
  method: string;
  text: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Parse GeckoTerminal's ohlcv_list ([[ts_sec, o, h, l, c, v], ...], newest first) into oldest-first candles; bad rows dropped. */
export function parseGtOhlcv(list: unknown): Candle[] {
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [ts, o, h, l, c, v] = row.map(Number);
    if (![ts, o, h, l, c, v].every(Number.isFinite) || ts <= 0 || h < l || o <= 0 || c <= 0) continue;
    out.push({ t: ts * 1000, o, h, l, c, v: Math.max(0, v) });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function unavailableCandles(reason: string): CandleFeatures {
  return { state: "unavailable", candles: 0, spanMinutes: null, readAt: null, lastCandleAt: null, tapeAgeMinutes: null, windowHigh: null, minutesSinceHigh: null,
    firstDipPct: null, minutesHighToFirstDip: null, maxDrawdownPct: null, minutesHighToDeepestLow: null,
    reclaimShare: null, reclaimed: null, minutesToReclaim: null, upperWickShare: null, lowerWickShare: null, upCloseShare: null, volumeTrend: null,
    method: CANDLE_METHOD, text: `1m tape: ${reason}` };
}

export interface CandleRead {
  /** When the candles were read from the source (epoch ms). */
  readAt: number | null;
  /** The latest read attempt's error, if the last attempt after a good read failed. */
  error?: string | null;
}

export function candleFeatures(candles: Candle[], nowMs: number, read: CandleRead = { readAt: null }): CandleFeatures {
  const cs = [...candles].filter((c) => Number.isFinite(c.t) && c.t <= nowMs).sort((a, b) => a.t - b.t);
  if (!cs.length) return unavailableCandles("no candles read");
  const last = cs[cs.length - 1];
  const tapeAgeMinutes = Math.round((nowMs - last.t) / 60_000);
  const base = { readAt: read.readAt, lastCandleAt: last.t, tapeAgeMinutes };
  if (cs.length < CANDLES_MIN) {
    return { ...unavailableCandles(""), ...base, state: "insufficient", candles: cs.length, spanMinutes: Math.round((last.t - cs[0].t) / 60_000) + 1,
      text: `1m tape: ${cs.length} candle${cs.length === 1 ? "" : "s"}, ${CANDLES_MIN} needed` };
  }
  let hi = 0;
  for (let i = 1; i < cs.length; i++) if (cs[i].h > cs[hi].h) hi = i;
  const windowHigh = cs[hi].h;
  const minutesSinceHigh = Math.round((nowMs - cs[hi].t) / 60_000);
  // Deepest low after the high (max drawdown) and the FIRST local low after
  // the high: the first candle after the high whose low is below the next
  // candle's low, or the last candle before a 90% reclaim. A later, lower low
  // (a second leg down) is the drawdown, not the first dip.
  let deep: number | null = null;
  for (let i = hi + 1; i < cs.length; i++) if (deep == null || cs[i].l < cs[deep].l) deep = i;
  let first: number | null = null;
  if (deep != null) {
    first = hi + 1;
    for (let i = hi + 1; i < cs.length; i++) {
      if (cs[i].l <= cs[first].l) first = i;
      const next = cs[i + 1];
      if (next == null) break;
      if (next.c >= RECLAIM_SHARE * windowHigh || next.l > cs[first].l) break;
    }
  }
  const pctFrom = (i: number) => r1(((cs[i].l - windowHigh) / windowHigh) * 100);
  const minsFromHigh = (i: number) => Math.round((cs[i].t - cs[hi].t) / 60_000);
  const firstDipPct = first == null ? null : pctFrom(first);
  const minutesHighToFirstDip = first == null ? null : minsFromHigh(first);
  const maxDrawdownPct = deep == null ? null : pctFrom(deep);
  const minutesHighToDeepestLow = deep == null ? null : minsFromHigh(deep);
  const reclaimShare = r2(last.c / windowHigh);
  const reclaimed = reclaimShare >= RECLAIM_SHARE;
  let minutesToReclaim: number | null = null;
  if (first != null) {
    for (let i = first + 1; i < cs.length; i++) {
      if (cs[i].c >= RECLAIM_SHARE * windowHigh) { minutesToReclaim = Math.round((cs[i].t - cs[first].t) / 60_000); break; }
    }
  }
  // Wicks and closes over the last window.
  const w = cs.slice(-WICK_WINDOW);
  let range = 0, upper = 0, lower = 0, ups = 0;
  for (const c of w) {
    const rg = c.h - c.l;
    range += rg;
    upper += c.h - Math.max(c.o, c.c);
    lower += Math.min(c.o, c.c) - c.l;
    if (c.c > c.o) ups++;
  }
  const upperWickShare = range > 0 ? r2(upper / range) : null;
  const lowerWickShare = range > 0 ? r2(lower / range) : null;
  const upCloseShare = r2(ups / w.length);
  // Volume trend.
  const recent = cs.slice(-VOL_WINDOW).reduce((s, c) => s + c.v, 0);
  const prior = cs.slice(-2 * VOL_WINDOW, -VOL_WINDOW).reduce((s, c) => s + c.v, 0);
  const volumeTrend = prior > 0 ? r2(recent / prior) : null;
  const spanMinutes = Math.round((last.t - cs[0].t) / 60_000) + 1;
  const stale = tapeAgeMinutes > TAPE_STALE_MINUTES || !!read.error;
  const dipText = first == null ? "no dip since the high (the high is the latest candle)"
    : `first dip ${firstDipPct}% at ${minutesHighToFirstDip} min after the high${deep !== first ? `, deepest ${maxDrawdownPct}% at ${minutesHighToDeepestLow} min` : ""}`;
  const recText = first == null ? "" : minutesToReclaim != null ? `, ${Math.round(RECLAIM_SHARE * 100)}% of the high reclaimed ${minutesToReclaim} min after the first dip` : `, not reclaimed (${Math.round(reclaimShare * 100)}% of the high at the last close)`;
  const wickText = upperWickShare == null ? "" : `; wicks ${Math.round(upperWickShare * 100)}% upper / ${Math.round(lowerWickShare! * 100)}% lower of range over the last ${w.length} candles`;
  const volText = volumeTrend == null ? "" : `; volume ${volumeTrend}x the prior ${VOL_WINDOW} candles`;
  const ageText = stale ? ` STALE: last candle ${tapeAgeMinutes} min old${read.error ? `, latest read failed (${read.error})` : ""}; numbers are from the last good read;` : "";
  return {
    ...base, state: stale ? "stale" : "ok", candles: cs.length, spanMinutes, windowHigh, minutesSinceHigh, firstDipPct, minutesHighToFirstDip, maxDrawdownPct, minutesHighToDeepestLow,
    reclaimShare, reclaimed, minutesToReclaim, upperWickShare, lowerWickShare, upCloseShare, volumeTrend, method: CANDLE_METHOD,
    text: `1m tape (${cs.length} traded minutes over ${spanMinutes} min):${ageText} high ${minutesSinceHigh} min ago, ${dipText}${recText}${wickText}; ${Math.round(upCloseShare * 100)}% up closes${volText}`,
  };
}
