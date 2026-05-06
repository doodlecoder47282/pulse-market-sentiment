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
import { getPriceHistory } from "./schwab";

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

// Map Yahoo-style symbols to Schwab equivalents
function toSchwabSymbol(symbol: string): string {
  const map: Record<string, string> = {
    "^VIX": "$VIX.X", "^VIX9D": "$VIX9D.X", "^VIX3M": "$VIX3M.X",
    "^VVIX": "$VVIX.X", "^SKEW": "$SKEW.X",
    "^GSPC": "$SPX.X", "^SPX": "$SPX.X",
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
  let prevClose: number | null = null;

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
      prevClose = bars.length >= 2 ? bars[0]?.c ?? null : null;
    }
  } catch { /* fall through to empty */ }

  // Quote-shield observer (flag-only — never alters returned data).
  try {
    if (price != null && isFinite(price)) observeQuote(symbol, price);
  } catch { /* shield must never break ingest */ }

  const change = price != null && prevClose != null ? price - prevClose : null;
  const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;
  const sessionHighs = bars.map((b) => b.h).filter((v): v is number => v != null);
  const sessionLows = bars.map((b) => b.l).filter((v): v is number => v != null);

  return {
    symbol,
    displayName: symbol,
    currency: "USD",
    price,
    prevClose,
    change,
    changePct,
    sessionOpen: bars[0]?.o ?? null,
    sessionHigh: sessionHighs.length > 0 ? Math.max(...sessionHighs) : null,
    sessionLow: sessionLows.length > 0 ? Math.min(...sessionLows) : null,
    bars,
    interval,
    range,
    asOf: Math.floor(Date.now() / 1000),
  };
}

/**
 * Fetch prior trading day's OHLC via Schwab. Pulls 10 daily bars and returns the most
 * recent COMPLETED session (excludes today if market hasn't closed).
 */
export async function fetchPrevDayOHLC(symbol: string): Promise<DailyOHLC | null> {
  const schwabSym = toSchwabSymbol(symbol);
  try {
    const resp = await getPriceHistory(schwabSym, "day", 10, "daily", 1);
    if (!resp.candles.length) return null;
    const rows: DailyOHLC[] = resp.candles
      .map((c) => ({ t: Math.floor(c.datetime / 1000), o: c.open, h: c.high, l: c.low, c: c.close }))
      .filter((r) => r.o > 0 && r.c > 0);
    if (!rows.length) return null;
    // Pick the most recent completed session.
    const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const todayEt = `${nowEt.getFullYear()}-${nowEt.getMonth() + 1}-${nowEt.getDate()}`;
    const last = rows[rows.length - 1];
    const lastEt = new Date(new Date(last.t * 1000).toLocaleString("en-US", { timeZone: "America/New_York" }));
    const lastDate = `${lastEt.getFullYear()}-${lastEt.getMonth() + 1}-${lastEt.getDate()}`;
    const hourEt = nowEt.getHours();
    const marketOpen = hourEt >= 9 && hourEt < 16;
    if (lastDate === todayEt && marketOpen && rows.length >= 2) {
      return rows[rows.length - 2];
    }
    return last;
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
