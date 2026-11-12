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

export const CANDLE_METHOD = "1-minute OHLCV (GeckoTerminal); launch high = highest high in the window; first dip = lowest low after it; reclaim = share of launch high regained by the latest close; wicks over the last 10 candles; volume trend = last 5 candles vs the 5 before; measurements only, no gate";

/** Candles needed before any feature is read (fewer is "insufficient", never a number). */
export const CANDLES_MIN = 10;
/** Reclaim threshold the `reclaimed` flag uses: latest close at or above this share of the launch high. */
export const RECLAIM_SHARE = 0.9;
const WICK_WINDOW = 10;
const VOL_WINDOW = 5;

export interface CandleFeatures {
  state: "ok" | "insufficient" | "unavailable";
  candles: number;
  spanMinutes: number | null;
  /** Highest high in the window and when it printed (minutes before `nowMs`). */
  launchHigh: number | null;
  minutesSinceHigh: number | null;
  /** Lowest low after the launch high: depth from the high, percent, and minutes after the high. Null when the high is the latest candle. */
  firstDipPct: number | null;
  minutesHighToLow: number | null;
  /** Latest close as a share of the launch high (1 = back at the high). */
  reclaimShare: number | null;
  /** Latest close at or above RECLAIM_SHARE of the launch high. */
  reclaimed: boolean | null;
  /** Minutes from the dip low to the first close at or above RECLAIM_SHARE x high; null if never. */
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
  return { state: "unavailable", candles: 0, spanMinutes: null, launchHigh: null, minutesSinceHigh: null, firstDipPct: null, minutesHighToLow: null,
    reclaimShare: null, reclaimed: null, minutesToReclaim: null, upperWickShare: null, lowerWickShare: null, upCloseShare: null, volumeTrend: null,
    method: CANDLE_METHOD, text: `1m tape: ${reason}` };
}

export function candleFeatures(candles: Candle[], nowMs: number): CandleFeatures {
  const cs = [...candles].filter((c) => Number.isFinite(c.t) && c.t <= nowMs).sort((a, b) => a.t - b.t);
  if (!cs.length) return unavailableCandles("no candles read");
  if (cs.length < CANDLES_MIN) {
    return { ...unavailableCandles(""), state: "insufficient", candles: cs.length, spanMinutes: Math.round((cs[cs.length - 1].t - cs[0].t) / 60_000) + 1,
      text: `1m tape: ${cs.length} candle${cs.length === 1 ? "" : "s"}, ${CANDLES_MIN} needed` };
  }
  const last = cs[cs.length - 1];
  let hi = 0;
  for (let i = 1; i < cs.length; i++) if (cs[i].h > cs[hi].h) hi = i;
  const launchHigh = cs[hi].h;
  const minutesSinceHigh = Math.round((nowMs - cs[hi].t) / 60_000);
  // First dip: lowest low after the high.
  let lo: number | null = null;
  for (let i = hi + 1; i < cs.length; i++) if (lo == null || cs[i].l < cs[lo].l) lo = i;
  const firstDipPct = lo == null ? null : r1(((cs[lo].l - launchHigh) / launchHigh) * 100);
  const minutesHighToLow = lo == null ? null : Math.round((cs[lo].t - cs[hi].t) / 60_000);
  const reclaimShare = r2(last.c / launchHigh);
  const reclaimed = reclaimShare >= RECLAIM_SHARE;
  let minutesToReclaim: number | null = null;
  if (lo != null) {
    for (let i = lo + 1; i < cs.length; i++) {
      if (cs[i].c >= RECLAIM_SHARE * launchHigh) { minutesToReclaim = Math.round((cs[i].t - cs[lo].t) / 60_000); break; }
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
  const dipText = lo == null ? "no dip since the high (the high is the latest candle)" : `first dip ${firstDipPct}% in ${minutesHighToLow} min`;
  const recText = lo == null ? "" : minutesToReclaim != null ? `, ${Math.round(RECLAIM_SHARE * 100)}% of the high reclaimed in ${minutesToReclaim} min` : `, not reclaimed (${Math.round(reclaimShare * 100)}% of the high now)`;
  const wickText = upperWickShare == null ? "" : `; wicks ${Math.round(upperWickShare * 100)}% upper / ${Math.round(lowerWickShare! * 100)}% lower of range`;
  const volText = volumeTrend == null ? "" : `; volume ${volumeTrend}x the prior ${VOL_WINDOW} min`;
  return {
    state: "ok", candles: cs.length, spanMinutes, launchHigh, minutesSinceHigh, firstDipPct, minutesHighToLow, reclaimShare, reclaimed, minutesToReclaim,
    upperWickShare, lowerWickShare, upCloseShare, volumeTrend, method: CANDLE_METHOD,
    text: `1m tape (${cs.length} candles): high ${minutesSinceHigh} min ago, ${dipText}${recText}${wickText}; ${Math.round(upCloseShare * 100)}% up closes${volText}`,
  };
}
