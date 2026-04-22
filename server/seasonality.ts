// server/seasonality.ts
//
// Historical seasonality engine — fetches 20 years of daily closes from Yahoo
// and computes average monthly and weekly returns across all years, plus
// current-year cumulative returns for comparison.
//
// Cache: 24hr TTL (disk-backed via sessionCache). Historical seasonality
// data doesn't change intraday — heavy fetch, cache aggressively.

import { readCache, writeCache } from "./sessionCache";

const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0)";

async function yFetch(url: string, timeoutMs = 20_000): Promise<any> {
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

export interface SeasonalityTicker {
  symbol: string;
  displayName: string;
  monthly: Array<{ month: number; avgReturn: number; currentYearReturn: number | null }>;
  weekly: Array<{ week: number; avgReturn: number; currentYearReturn: number | null }>;
  lookbackYears: number;
}

export interface SeasonalityResponse {
  tickers: SeasonalityTicker[];
  asOf: string;
}

const TICKER_MAP: Array<{ symbol: string; displayName: string; yahooSymbol: string }> = [
  { symbol: "SPY",  displayName: "SPY / SPX",  yahooSymbol: "SPY"  },
  { symbol: "IWM",  displayName: "IWM",         yahooSymbol: "IWM"  },
  { symbol: "VIX",  displayName: "VIX",         yahooSymbol: "^VIX" },
  { symbol: "HYG",  displayName: "HYG",         yahooSymbol: "HYG"  },
  { symbol: "USO",  displayName: "USO (Oil)",   yahooSymbol: "USO"  },
  { symbol: "GLD",  displayName: "GLD (Gold)",  yahooSymbol: "GLD"  },
  { symbol: "SLV",  displayName: "SLV (Silver)",yahooSymbol: "SLV"  },
  { symbol: "QQQ",  displayName: "QQQ (Tech)",  yahooSymbol: "QQQ"  },
];

/** ISO week number (1–53). Uses a robust algorithm compatible with ISO 8601. */
function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

interface DailyBar { t: number; c: number }

async function fetchBars(yahooSymbol: string): Promise<DailyBar[]> {
  const enc = encodeURIComponent(yahooSymbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=20y`;
  try {
    const d = await yFetch(url, 25_000);
    const r = d?.chart?.result?.[0];
    if (!r) return [];
    const ts: number[] = r.timestamp || [];
    const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
    const bars: DailyBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c != null && isFinite(c) && c > 0) {
        bars.push({ t: ts[i], c });
      }
    }
    return bars;
  } catch (e: any) {
    console.warn(`[seasonality] fetch failed for ${yahooSymbol}: ${e?.message}`);
    return [];
  }
}

function computeSeasonality(bars: DailyBar[]): Pick<SeasonalityTicker, "monthly" | "weekly" | "lookbackYears"> {
  if (bars.length < 2) {
    const monthly = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, avgReturn: 0, currentYearReturn: null }));
    const weekly = Array.from({ length: 52 }, (_, i) => ({ week: i + 1, avgReturn: 0, currentYearReturn: null }));
    return { monthly, weekly, lookbackYears: 0 };
  }

  const nowDate = new Date();
  const currentYear = nowDate.getFullYear();
  const currentMonth = nowDate.getMonth() + 1; // 1-based
  const currentWeek = isoWeek(nowDate);

  // ---- Monthly seasonality ----
  // Group bars by year-month, take first and last close per month-year.
  // Monthly return = (last_close - first_close) / first_close * 100

  // Build month-year groups
  type MonthKey = string; // "YYYY-MM"
  const monthGroups = new Map<MonthKey, DailyBar[]>();
  for (const bar of bars) {
    const d = new Date(bar.t * 1000);
    const key: MonthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const arr = monthGroups.get(key) ?? [];
    arr.push(bar);
    monthGroups.set(key, arr);
  }

  // For each month number (1-12): accumulate returns across all historical years
  const monthlyHistorical: Map<number, number[]> = new Map(
    Array.from({ length: 12 }, (_, i) => [i + 1, []]),
  );
  // Current-year cumulative returns per month
  const monthlyCurrentYear: Map<number, number | null> = new Map();

  for (const [key, barArr] of monthGroups.entries()) {
    const [yrStr, moStr] = key.split("-");
    const yr = Number(yrStr);
    const mo = Number(moStr);
    if (!barArr.length) continue;
    const sorted = barArr.slice().sort((a, b) => a.t - b.t);
    const first = sorted[0].c;
    const last = sorted[sorted.length - 1].c;
    if (first <= 0) continue;
    const ret = ((last - first) / first) * 100;

    if (yr === currentYear) {
      // Only include months that have completed (past months) or the current month if mid-month
      if (mo <= currentMonth) {
        monthlyCurrentYear.set(mo, ret);
      }
    } else {
      const arr = monthlyHistorical.get(mo) ?? [];
      arr.push(ret);
      monthlyHistorical.set(mo, arr);
    }
  }

  const monthly = Array.from({ length: 12 }, (_, i) => {
    const mo = i + 1;
    const hist = monthlyHistorical.get(mo) ?? [];
    const avgReturn = hist.length > 0 ? hist.reduce((a, b) => a + b, 0) / hist.length : 0;
    const currentYearReturn = monthlyCurrentYear.get(mo) ?? null;
    return { month: mo, avgReturn, currentYearReturn };
  });

  // ---- Weekly seasonality ----
  // Group bars by year-week, take first and last close per week-year.
  type WeekKey = string; // "YYYY-WW"
  const weekGroups = new Map<WeekKey, DailyBar[]>();
  for (const bar of bars) {
    const d = new Date(bar.t * 1000);
    const wk = isoWeek(d);
    const key: WeekKey = `${d.getUTCFullYear()}-${String(wk).padStart(2, "0")}`;
    const arr = weekGroups.get(key) ?? [];
    arr.push(bar);
    weekGroups.set(key, arr);
  }

  const weeklyHistorical: Map<number, number[]> = new Map(
    Array.from({ length: 53 }, (_, i) => [i + 1, []]),
  );
  const weeklyCurrentYear: Map<number, number | null> = new Map();

  for (const [key, barArr] of weekGroups.entries()) {
    const [yrStr, wkStr] = key.split("-");
    const yr = Number(yrStr);
    const wk = Number(wkStr);
    if (!barArr.length) continue;
    const sorted = barArr.slice().sort((a, b) => a.t - b.t);
    const first = sorted[0].c;
    const last = sorted[sorted.length - 1].c;
    if (first <= 0) continue;
    const ret = ((last - first) / first) * 100;

    if (yr === currentYear) {
      if (wk <= currentWeek) {
        weeklyCurrentYear.set(wk, ret);
      }
    } else {
      const arr = weeklyHistorical.get(wk) ?? [];
      arr.push(ret);
      weeklyHistorical.set(wk, arr);
    }
  }

  const weekly = Array.from({ length: 52 }, (_, i) => {
    const wk = i + 1;
    const hist = weeklyHistorical.get(wk) ?? [];
    const avgReturn = hist.length > 0 ? hist.reduce((a, b) => a + b, 0) / hist.length : 0;
    const currentYearReturn = weeklyCurrentYear.get(wk) ?? null;
    return { week: wk, avgReturn, currentYearReturn };
  });

  // Estimate lookback years from first bar
  const firstBar = bars[0];
  const firstYear = new Date(firstBar.t * 1000).getUTCFullYear();
  const lookbackYears = currentYear - firstYear;

  return { monthly, weekly, lookbackYears };
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_KEY = "seasonality-v1";

interface CachedSeasonality {
  at: number;
  data: SeasonalityResponse;
}

let memCache: CachedSeasonality | null = null;

export async function buildSeasonalitySnapshot(): Promise<SeasonalityResponse> {
  // Check memory cache first
  if (memCache && Date.now() - memCache.at < CACHE_TTL_MS) {
    return memCache.data;
  }

  // Check disk cache
  const diskCached = await readCache<CachedSeasonality>(CACHE_KEY);
  if (diskCached && Date.now() - diskCached.at < CACHE_TTL_MS) {
    memCache = diskCached;
    return diskCached.data;
  }

  console.log("[seasonality] Building fresh seasonality snapshot…");

  // Fetch all tickers in parallel (with concurrency to avoid rate limiting)
  const results: SeasonalityTicker[] = [];
  const BATCH = 3; // 3 at a time to avoid Yahoo rate limiting

  for (let i = 0; i < TICKER_MAP.length; i += BATCH) {
    const batch = TICKER_MAP.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (tk) => {
        const bars = await fetchBars(tk.yahooSymbol);
        const { monthly, weekly, lookbackYears } = computeSeasonality(bars);
        console.log(`[seasonality] ${tk.yahooSymbol}: ${bars.length} bars, ${lookbackYears} yrs`);
        return {
          symbol: tk.symbol,
          displayName: tk.displayName,
          monthly,
          weekly,
          lookbackYears,
        };
      }),
    );
    results.push(...batchResults);
    // Small delay between batches to be polite to Yahoo
    if (i + BATCH < TICKER_MAP.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const response: SeasonalityResponse = {
    tickers: results,
    asOf: new Date().toISOString(),
  };

  const cached: CachedSeasonality = { at: Date.now(), data: response };
  memCache = cached;
  await writeCache(CACHE_KEY, cached);

  return response;
}
