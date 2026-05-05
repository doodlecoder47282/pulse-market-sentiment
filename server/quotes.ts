// server/quotes.ts
// Yahoo Finance chart API adapters for SPX (^GSPC), SPY, VIX intraday + daily OHLC.
// Yahoo returns delayed quotes but updates every ~30-60s for major indices.

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

const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0)";

async function yFetch(url: string, timeoutMs = 10_000): Promise<any> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Yahoo ${r.status} for ${url}`);
    return await r.json();
  } finally {
    clearTimeout(to);
  }
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

/** Fetch an intraday chart. Default: 1d range, 1m interval. */
export async function fetchIntraday(
  symbol: string,
  range: "1d" | "5d" = "1d",
  interval: "1m" | "5m" | "15m" = "1m",
): Promise<QuoteSeries> {
  // For 5d we need 5m bars (Yahoo rejects 1m + 5d).
  const eff = range === "5d" && interval === "1m" ? "5m" : interval;
  const enc = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=${eff}&range=${range}&includePrePost=false`;
  let result: any = null;
  try {
    const d = await yFetch(url);
    result = d?.chart?.result?.[0];
  } catch (e) {
    // fall through to empty
  }
  if (!result) {
    return {
      symbol,
      displayName: symbol,
      currency: "USD",
      price: null, prevClose: null, change: null, changePct: null,
      sessionOpen: null, sessionHigh: null, sessionLow: null,
      bars: [], interval: eff, range,
      asOf: Math.floor(Date.now() / 1000),
    };
  }
  const bars = normalizeBars(result);
  const meta = result.meta || {};
  const price: number | null = meta.regularMarketPrice ?? bars[bars.length - 1]?.c ?? null;
  const prevClose: number | null = meta.chartPreviousClose ?? meta.previousClose ?? null;

  // Quote-shield observer (flag-only — never alters returned data).
  // Source: MASTER_SYNTHESIS Tier 2 #6 (statisticsbyjim outliers reference).
  try {
    if (price != null && isFinite(price)) observeQuote(symbol, price);
  } catch { /* shield must never break ingest */ }
  const change = price != null && prevClose != null ? price - prevClose : null;
  const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;
  return {
    symbol,
    displayName: meta.shortName || meta.longName || symbol,
    currency: meta.currency || "USD",
    price,
    prevClose,
    change,
    changePct,
    sessionOpen: meta.regularMarketDayRange ? null : bars[0]?.o ?? null,
    sessionHigh: meta.regularMarketDayHigh ?? null,
    sessionLow: meta.regularMarketDayLow ?? null,
    bars,
    interval: eff,
    range,
    asOf: Math.floor(Date.now() / 1000),
  };
}

/**
 * Fetch prior trading day's OHLC. Pulls 10-day daily bars and returns the most
 * recent COMPLETED session (excludes today if market hasn't closed). This is
 * what feeds the pivot math.
 */
export async function fetchPrevDayOHLC(symbol: string): Promise<DailyOHLC | null> {
  const enc = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=10d`;
  try {
    const d = await yFetch(url);
    const r = d?.chart?.result?.[0];
    if (!r) return null;
    const ts: number[] = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const rows: DailyOHLC[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (o != null && h != null && l != null && c != null) {
        rows.push({ t: ts[i], o, h, l, c });
      }
    }
    if (!rows.length) return null;
    // Pick the most recent completed session. Yahoo marks today even mid-session
    // with partial data; we use the session BEFORE the latest available (yesterday)
    // once the market is open. Heuristic: if most recent bar's date == today in
    // America/New_York, use rows[len-2]; otherwise use rows[len-1].
    const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const todayEt = `${nowEt.getFullYear()}-${nowEt.getMonth() + 1}-${nowEt.getDate()}`;
    const last = rows[rows.length - 1];
    const lastEt = new Date(new Date(last.t * 1000).toLocaleString("en-US", { timeZone: "America/New_York" }));
    const lastDate = `${lastEt.getFullYear()}-${lastEt.getMonth() + 1}-${lastEt.getDate()}`;
    // If the most recent bar is "today" and it's during US market hours, use prior.
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
 * Fetch N days of daily closes. Used for realized-vol computation (need ~60 days
 * for a stable 20D HV + 60D HV blend).
 */
export async function fetchDailyCloses(symbol: string, days = 120): Promise<DailyOHLC[]> {
  const enc = encodeURIComponent(symbol);
  // Yahoo range syntax: 3mo/6mo/1y. Pick the smallest that covers `days`.
  const range = days <= 30 ? "1mo" : days <= 90 ? "3mo" : days <= 180 ? "6mo" : "1y";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=${range}`;
  try {
    const d = await yFetch(url);
    const r = d?.chart?.result?.[0];
    if (!r) return [];
    const ts: number[] = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const rows: DailyOHLC[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (o != null && h != null && l != null && c != null) {
        rows.push({ t: ts[i], o, h, l, c });
      }
    }
    return rows;
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
