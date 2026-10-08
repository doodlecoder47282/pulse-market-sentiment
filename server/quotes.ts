// server/quotes.ts
// SPX/SPY/VIX intraday + daily OHLC adapters.
// Schwab-only mode: all data via Schwab getPriceHistory. No Yahoo.

import { observeQuote } from "./quoteShield";

export type Bar = {
  t: number;     // epoch seconds
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
  v: number | null;
};

export type QuoteSeries = {
  symbol: string;
  displayName: string;
  currency: string;
  price: number | null;        // latest
  prevClose: number | null;    // prior session close
  change: number | null;
  changePct: number | null;
  sessionOpen: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  bars: Bar[];                 // intraday bars (1m or 5m)
  interval: string;
  range: string;
  asOf: number;                // epoch seconds
  /** Where prevClose came from (see server/dayChange.ts); "unavailable" = no honest prior close. */
  prevCloseSource?: PrevCloseSource;
  /** ET date of the session whose close is prevClose, when known. */
  prevCloseDate?: string | null;
  /** ET date of the session the latest price belongs to. */
  priceSessionDate?: string | null;
};

export type DailyOHLC = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

/** Period OHLC for weekly/monthly pivots. */
export type PeriodOHLC = {
  start: number;     // epoch seconds (period start)
  end: number;       // epoch seconds (period end)
  label: string;     // e.g. "2026-W16" or "2026-03"
  o: number;
  h: number;
  l: number;
  c: number;
};

// TODO: Schwab-only mode — Yahoo source removed, awaiting Schwab equivalent.
// yFetch helper removed. Using Schwab getPriceHistory for all data.
import { getPriceHistory, getQuotes } from "./schwab";
import {
  type PrevCloseSource, type PrevCloseResult, type QuoteCloseLike,
  resolvePrevClose, dayChange, dailyBarSessionDate, intradayBarSessionDate,
} from "./dayChange";
import { etClock, etDate, prevTradingDay, sessionCloseMs } from "./exchangeCalendar";

// ─── Prior close (shared by quotes.ts, ohlc.ts, mag7.ts, macro.ts) ───────────
//
// Schwab quote requests from callers that run in parallel (MAG 7, macro
// carousel, Trade Desk) are coalesced into one /quotes call per 15 ms window
// so the day-change fix does not multiply request count.
const QUOTE_BATCH_MS = 15;
const _pendingQuotes = new Map<string, Array<(q: QuoteCloseLike | null) => void>>();
let _quoteTimer: ReturnType<typeof setTimeout> | null = null;

async function _flushQuoteBatch(): Promise<void> {
  _quoteTimer = null;
  const batch = new Map(_pendingQuotes);
  _pendingQuotes.clear();
  let quotes: Awaited<ReturnType<typeof getQuotes>> = [];
  try {
    quotes = await getQuotes(Array.from(batch.keys()));
  } catch { /* resolve every waiter with null below */ }
  const bySym = new Map(quotes.map((q) => [q.symbol, q]));
  for (const [sym, waiters] of batch) {
    const q = bySym.get(sym);
    const info: QuoteCloseLike | null = q
      ? { closePrice: q.prevClose ?? null, lastPrice: q.last, netChange: q.change }
      : null;
    for (const w of waiters) w(info);
  }
}

/** Schwab quote close fields for one Schwab symbol (batched). Null when unavailable. */
export function fetchQuoteClose(schwabSymbol: string): Promise<QuoteCloseLike | null> {
  return new Promise((resolve) => {
    const arr = _pendingQuotes.get(schwabSymbol) ?? [];
    arr.push(resolve);
    _pendingQuotes.set(schwabSymbol, arr);
    if (!_quoteTimer) _quoteTimer = setTimeout(() => { void _flushQuoteBatch(); }, QUOTE_BATCH_MS);
  });
}

/**
 * Most recent regular session that has started by `nowMs` (today once 09:30 ET
 * has passed on a trading day, otherwise the previous trading day). Used to
 * date a price whose bar timestamps are not intraday (weekly/monthly candles).
 */
export function latestStartedSessionDate(nowMs: number = Date.now()): string {
  const c = etClock(nowMs);
  const close = sessionCloseMs(c.date);
  if (close != null && c.minutes >= 9 * 60 + 30) return c.date;
  return prevTradingDay(c.date);
}

/**
 * Prior close for a price from session `priceSessionDate` (YYYY-MM-DD ET).
 * Quote close first (today's prices), then Schwab daily bars; never an
 * intraday bar. `dailyBars` may be passed when the caller already has them.
 */
export async function resolveSessionPrevClose(
  symbol: string,
  priceSessionDate: string | null,
  dailyBars?: { t: number; c: number }[] | null,
): Promise<PrevCloseResult> {
  const schwabSym = toSchwabSymbol(symbol);
  const todayEt = etDate();
  const sessionDate = priceSessionDate ?? todayEt;
  const quote = sessionDate === todayEt ? await fetchQuoteClose(schwabSym).catch(() => null) : null;
  let bars = dailyBars ?? null;
  const quoteUsable = quote != null && ((quote.closePrice ?? 0) > 0 || (quote.lastPrice != null && quote.netChange != null));
  if (!quoteUsable && !bars) {
    try {
      const resp = await getPriceHistory(schwabSym, "month", 1, "daily", 1);
      bars = resp.candles.map((c) => ({ t: Math.floor(c.datetime / 1000), c: c.close }));
    } catch { bars = null; }
  }
  return resolvePrevClose({
    priceSessionDate: sessionDate,
    todayEt,
    prevTradingDate: prevTradingDay(todayEt),
    quote,
    dailyBars: bars,
  });
}

/** Normalize Yahoo chart -> Bar[] */
function normalizeBars(result: any): Bar[] {
  const ts: number[] = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i] ?? null;
    const h = q.high?.[i] ?? null;
    const l = q.low?.[i] ?? null;
    const c = q.close?.[i] ?? null;
    const v = q.volume?.[i] ?? null;
    // Skip rows where all are null (Yahoo sometimes pads)
    if (o == null && h == null && l == null && c == null) continue;
    bars.push({ t: ts[i], o, h, l, c, v });
  }
  return bars;
}

// Map Yahoo-style symbols to Schwab equivalents.
// Schwab cash indexes use "$" prefix WITHOUT ".X" suffix.
function toSchwabSymbol(symbol: string): string {
  const map: Record<string, string> = {
    "^VIX": "$VIX", "^VIX9D": "$VIX9D", "^VIX3M": "$VIX3M",
    "^VVIX": "$VVIX", "^SKEW": "$SKEW",
    "^GSPC": "$SPX", "^SPX": "$SPX",
    "^VXN": "$VXN", "^RVX": "$RVX",
  };
  return map[symbol] ?? symbol;
}

/** Fetch an intraday chart via Schwab. Default: 1d range, 1m interval. */
export async function fetchIntraday(
  symbol: string,
  range: "1d" | "5d" = "1d",
  interval: "1m" | "5m" | "15m" = "1m",
): Promise<QuoteSeries> {
  const schwabSym = toSchwabSymbol(symbol);
  // Map to Schwab params
  const period = range === "5d" ? 5 : 1;
  const frequencyMap: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15 };
  const frequency = frequencyMap[interval] ?? 1;

  let bars: Bar[] = [];
  let price: number | null = null;

  try {
    const resp = await getPriceHistory(schwabSym, "day", period, "minute", frequency);
    if (resp.candles.length > 0) {
      bars = resp.candles
        .map((c) => ({
          t: Math.floor(c.datetime / 1000),
          o: c.open ?? null,
          h: c.high ?? null,
          l: c.low ?? null,
          c: c.close ?? null,
          v: c.volume ?? null,
        }))
        .filter((b) => b.c != null && (b.c as number) > 0);
      price = bars[bars.length - 1]?.c ?? null;
    }
  } catch { /* fall through to empty */ }

  // Day change is measured from the prior session's close (server/dayChange.ts).
  // It was bars[0].c -- the first bar of the window -- which made "day change"
  // a change since the open (or since 5 days ago for range=5d).
  const lastBar = bars[bars.length - 1];
  const priceSessionDate = lastBar ? intradayBarSessionDate(lastBar.t) : null;
  let pc: PrevCloseResult = { prevClose: null, source: "unavailable", prevCloseDate: null };
  if (price != null) {
    try { pc = await resolveSessionPrevClose(symbol, priceSessionDate); } catch { /* stays unavailable */ }
  }
  const prevClose = pc.prevClose;
  // Session stats from the latest session's bars only (range=5d holds 5 sessions).
  const sessionBars = priceSessionDate ? bars.filter((b) => intradayBarSessionDate(b.t) === priceSessionDate) : bars;

  // Quote-shield observer (flag-only — never alters returned data).
  try {
    if (price != null && isFinite(price)) observeQuote(symbol, price);
  } catch { /* shield must never break ingest */ }

  const { change, changePct } = dayChange(price, prevClose);
  const sessionHighs = sessionBars.map((b) => b.h).filter((v): v is number => v != null);
  const sessionLows = sessionBars.map((b) => b.l).filter((v): v is number => v != null);

  return {
    symbol,
    displayName: symbol,
    currency: "USD",
    price,
    prevClose,
    change,
    changePct,
    sessionOpen: sessionBars[0]?.o ?? null,
    sessionHigh: sessionHighs.length > 0 ? Math.max(...sessionHighs) : null,
    sessionLow: sessionLows.length > 0 ? Math.min(...sessionLows) : null,
    bars,
    interval,
    range,
    asOf: Math.floor(Date.now() / 1000),
    prevCloseSource: pc.source,
    prevCloseDate: pc.prevCloseDate,
    priceSessionDate,
  };
}

/**
 * Fetch prior trading day's OHLC via Schwab. Pulls 10 daily bars and returns the most
 * recent COMPLETED session (excludes today if market hasn't closed).
 */
export async function fetchPrevDayOHLC(symbol: string): Promise<DailyOHLC | null> {
  const schwabSym = toSchwabSymbol(symbol);
  try {
    // Schwab API: periodType=day only supports frequencyType=minute. For DAILY bars
    // we must use periodType=month + frequencyType=daily. 1 month gives ~22 sessions,
    // plenty to pick the most recent completed one.
    const resp = await getPriceHistory(schwabSym, "month", 1, "daily", 1);
    if (!resp.candles.length) return null;
    const rows: DailyOHLC[] = resp.candles
      .map((c) => ({ t: Math.floor(c.datetime / 1000), o: c.open, h: c.high, l: c.low, c: c.close }))
      .filter((r) => r.o > 0 && r.c > 0);
    if (!rows.length) return null;
    // Most recent COMPLETED regular session: today once its close (16:00 ET,
    // 13:00 ET on half days) has passed, otherwise the previous trading day.
    // (Was "9 <= hour < 16", which mis-dated 09:00-09:30, half-day afternoons
    // and holidays.)
    const nowMs = Date.now();
    const today = etDate(nowMs);
    const todayClose = sessionCloseMs(today);
    const lastCompleted = todayClose != null && nowMs >= todayClose ? today : prevTradingDay(today);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (dailyBarSessionDate(rows[i].t) <= lastCompleted) return rows[i];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch N days of daily closes via Schwab. Used for realized-vol computation.
 */
export async function fetchDailyCloses(symbol: string, days = 120): Promise<DailyOHLC[]> {
  const schwabSym = toSchwabSymbol(symbol);
  // Map days to Schwab period: use month periods for up to 6mo, year for longer
  const period = days <= 30 ? 1 : days <= 90 ? 3 : days <= 180 ? 6 : 12;
  const periodType = days <= 180 ? "month" as const : "year" as const;
  const actualPeriod = days <= 180 ? period : 1;
  try {
    const resp = await getPriceHistory(schwabSym, periodType, actualPeriod, "daily", 1);
    return resp.candles
      .map((c) => ({ t: Math.floor(c.datetime / 1000), o: c.open, h: c.high, l: c.low, c: c.close }))
      .filter((r) => r.o > 0 && r.c > 0);
  } catch {
    return [];
  }
}

/**
 * Compute prior week's OHLC (Mon open → Fri close) from daily bars.
 * We use the most recent COMPLETED week. If we're mid-week now, the "prior week"
 * is last Mon–Fri. If it's Sunday/Saturday, still last Mon–Fri.
 */
export function priorWeekOHLC(dailyBars: DailyOHLC[]): PeriodOHLC | null {
  if (!dailyBars.length) return null;
  // Group bars by ISO week (Mon = 1).
  const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  // Find the Monday of the CURRENT week (today if Mon, otherwise most recent Mon).
  const currentMonday = new Date(nowEt);
  const dayOfWeek = currentMonday.getDay(); // 0=Sun..6=Sat
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  currentMonday.setDate(currentMonday.getDate() - daysToMonday);
  currentMonday.setHours(0, 0, 0, 0);
  // Prior week: Mon-Fri BEFORE currentMonday.
  const priorMon = new Date(currentMonday);
  priorMon.setDate(priorMon.getDate() - 7);
  const priorFri = new Date(priorMon);
  priorFri.setDate(priorFri.getDate() + 4);
  priorFri.setHours(23, 59, 59, 999);
  const startT = Math.floor(priorMon.getTime() / 1000);
  const endT = Math.floor(priorFri.getTime() / 1000);
  const barsInWeek = dailyBars.filter((b) => b.t >= startT && b.t <= endT);
  if (!barsInWeek.length) return null;
  const o = barsInWeek[0].o;
  const c = barsInWeek[barsInWeek.length - 1].c;
  const h = Math.max(...barsInWeek.map((b) => b.h));
  const l = Math.min(...barsInWeek.map((b) => b.l));
  const yr = priorMon.getFullYear();
  // ISO week number (approx).
  const jan1 = new Date(yr, 0, 1);
  const wk = Math.ceil(((priorMon.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
  return { start: startT, end: endT, label: `${yr}-W${String(wk).padStart(2, "0")}`, o, h, l, c };
}

/**
 * Compute prior CALENDAR month's OHLC (1st trading day → last trading day).
 * If we're mid-month now, "prior month" is the previous calendar month.
 */
export function priorMonthOHLC(dailyBars: DailyOHLC[]): PeriodOHLC | null {
  if (!dailyBars.length) return null;
  const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  // First day of current month:
  const currentMonthStart = new Date(nowEt.getFullYear(), nowEt.getMonth(), 1);
  // Prior month = one month before.
  const priorMonthStart = new Date(currentMonthStart);
  priorMonthStart.setMonth(priorMonthStart.getMonth() - 1);
  const priorMonthEnd = new Date(currentMonthStart);
  priorMonthEnd.setDate(priorMonthEnd.getDate() - 1);
  priorMonthEnd.setHours(23, 59, 59, 999);
  const startT = Math.floor(priorMonthStart.getTime() / 1000);
  const endT = Math.floor(priorMonthEnd.getTime() / 1000);
  const barsInMonth = dailyBars.filter((b) => b.t >= startT && b.t <= endT);
  if (!barsInMonth.length) return null;
  const o = barsInMonth[0].o;
  const c = barsInMonth[barsInMonth.length - 1].c;
  const h = Math.max(...barsInMonth.map((b) => b.h));
  const l = Math.min(...barsInMonth.map((b) => b.l));
  const mm = String(priorMonthStart.getMonth() + 1).padStart(2, "0");
  return {
    start: startT, end: endT,
    label: `${priorMonthStart.getFullYear()}-${mm}`,
    o, h, l, c,
  };
}
