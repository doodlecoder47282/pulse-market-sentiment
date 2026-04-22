// server/seasonality.ts
//
// Historical seasonality engine — fetches 20 years of daily closes from Yahoo
// and computes:
//   - Monthly avg/median/winrate/stddev/best/worst
//   - Weekly avg/median/winrate/stddev/best/worst
//   - Yearly cumulative day-by-day path (equityclock-style)
//   - Optimal buy/sell seasonal window via geometric return maximization
//   - Presidential cycle analysis
//   - Lookback selector support (?lookback=5|10|20)
//
// Cache: 24hr TTL (disk-backed via sessionCache). Cache key: seasonality-v2.

import { readCache, writeCache } from "./sessionCache";

const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0)";

async function yFetch(url: string, timeoutMs = 25_000): Promise<any> {
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

// ─── Enriched per-month/week stat ─────────────────────────────────────────
export interface SeasonalityBar {
  month?: number;
  week?: number;
  avgReturn: number;
  medianReturn: number;
  winRate: number;         // 0–1
  sampleSize: number;
  best: number;
  worst: number;
  stdDev: number;
  currentYearReturn: number | null;
}

export interface OptimalWindow {
  buyDayOfYear: number;
  buyDate: string;         // "Oct 28"
  sellDayOfYear: number;
  sellDate: string;        // "May 5"
  geometricAvgReturn: number;
  winRate: number;
  yearsTested: number;
  confidenceLabel: "Excellent" | "Good" | "Fair" | "Weak" | "Insufficient";
}

export interface YearlySeasonality {
  /** 252-entry array: avgCumulativeReturn = avg across all historical years */
  dailyCumulativePath: Array<{
    dayOfYear: number;
    avgCumulativeReturn: number;
    stdDev: number;
    frequencyPositive: number;   // 0–1: % of years that were positive by this day
    currentYearCumulativeReturn: number | null;
  }>;
  fullYearAvg: number;
  fullYearMedian: number;
  fullYearWinRate: number;
  bestYear: { year: number; return: number };
  worstYear: { year: number; return: number };
  presidentialCycleYear: 1 | 2 | 3 | 4;
  presidentialCycleAvg: number | null;
  currentDecadeAvg: number | null;
  optimalWindow: OptimalWindow | null;
  yearsCovered: string[];
  analysisText: string;
}

export interface SeasonalityTicker {
  symbol: string;
  displayName: string;
  monthly: SeasonalityBar[];
  weekly: SeasonalityBar[];
  yearly: YearlySeasonality;
  lookbackYears: number;
  strongestMonth: { month: number; avgReturn: number; winRate: number };
  weakestMonth: { month: number; avgReturn: number; winRate: number };
  yearsCovered: string[];
}

export interface SeasonalityResponse {
  tickers: SeasonalityTicker[];
  asOf: string;
}

// ─── Ticker list ──────────────────────────────────────────────────────────
const TICKER_MAP: Array<{ symbol: string; displayName: string; yahooSymbol: string }> = [
  { symbol: "SPY",  displayName: "SPY / SPX",   yahooSymbol: "SPY"     },
  { symbol: "IWM",  displayName: "IWM",          yahooSymbol: "IWM"     },
  { symbol: "QQQ",  displayName: "QQQ",          yahooSymbol: "QQQ"     },
  { symbol: "VIX",  displayName: "VIX",          yahooSymbol: "^VIX"    },
  { symbol: "HYG",  displayName: "HYG",          yahooSymbol: "HYG"     },
  { symbol: "USO",  displayName: "USO (Oil)",    yahooSymbol: "USO"     },
  { symbol: "GLD",  displayName: "GLD (Gold)",   yahooSymbol: "GLD"     },
  { symbol: "SLV",  displayName: "SLV (Silver)", yahooSymbol: "SLV"     },
  { symbol: "BTC",  displayName: "BTC-USD",      yahooSymbol: "BTC-USD" },
];

// ─── ISO week ─────────────────────────────────────────────────────────────
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
    const d = await yFetch(url);
    const r = d?.chart?.result?.[0];
    if (!r) return [];
    const ts: number[] = r.timestamp || [];
    const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
    const bars: DailyBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c != null && isFinite(c) && c > 0) bars.push({ t: ts[i], c });
    }
    return bars;
  } catch (e: any) {
    console.warn(`[seasonality] fetch failed for ${yahooSymbol}: ${e?.message}`);
    return [];
  }
}

// ─── Stats helpers ────────────────────────────────────────────────────────
function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

function enrichBars(hist: Map<number, number[]>, currentYear: Map<number, number | null>, keys: number[]): SeasonalityBar[] {
  return keys.map((k) => {
    const arr = hist.get(k) ?? [];
    const avg = arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const med = median(arr);
    const winRate = arr.length > 0 ? arr.filter((v) => v > 0).length / arr.length : 0;
    const best = arr.length > 0 ? Math.max(...arr) : 0;
    const worst = arr.length > 0 ? Math.min(...arr) : 0;
    const sd = stdDev(arr);
    const currentYearReturn = currentYear.get(k) ?? null;
    const bar: SeasonalityBar = {
      avgReturn: avg,
      medianReturn: med,
      winRate,
      sampleSize: arr.length,
      best,
      worst,
      stdDev: sd,
      currentYearReturn,
    };
    if (k <= 12) bar.month = k; else bar.week = k;
    return bar;
  });
}

// ─── Presidential cycle ───────────────────────────────────────────────────
// Anchor: 2024 = Year 4 (election year)
function presidentialCycleYear(year: number): 1 | 2 | 3 | 4 {
  const cycle = ((year - 2024) % 4 + 4) % 4; // 0=Y4, 1=Y1, 2=Y2, 3=Y3
  if (cycle === 0) return 4;
  if (cycle === 1) return 1;
  if (cycle === 2) return 2;
  return 3;
}

// ─── Day-of-year (trading day index within year) ──────────────────────────
// Build a map: year → { date → trading day index (0-based) }
function buildTradingDayIndexes(bars: DailyBar[]): Map<number, Map<string, number>> {
  // Group bars by year, sort, then assign sequential index
  const byYear = new Map<number, DailyBar[]>();
  for (const bar of bars) {
    const d = new Date(bar.t * 1000);
    const yr = d.getUTCFullYear();
    const arr = byYear.get(yr) ?? [];
    arr.push(bar);
    byYear.set(yr, arr);
  }
  const result = new Map<number, Map<string, number>>();
  for (const [yr, yearBars] of byYear) {
    const sorted = [...yearBars].sort((a, b) => a.t - b.t);
    const map = new Map<string, number>();
    sorted.forEach((b, idx) => {
      const d = new Date(b.t * 1000);
      const key = `${d.getUTCMonth()}-${d.getUTCDate()}`;
      map.set(String(idx), b.t as any); // idx → timestamp
      map.set(`t${b.t}`, idx);          // timestamp → idx
    });
    result.set(yr, map);
  }
  return result;
}

// ─── Optimal window finder ────────────────────────────────────────────────
function dayOfYearToDate(doy: number, referenceYear = 2025): string {
  // doy is 0-based trading day index in a typical year
  // Map to approximate calendar date using a reference non-leap year
  // We'll use SPY's actual calendar structure: approximate by spreading 252 trading days
  // evenly across 365 calendar days (ratio ~0.69)
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  // Use a reference date: Jan 2 = trading day 0
  const approxCalendarDay = Math.round((doy / 252) * 365);
  const d = new Date(Date.UTC(referenceYear, 0, 2 + approxCalendarDay));
  const mon = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  return `${mon} ${day}`;
}

function confidenceLabel(winRate: number): OptimalWindow["confidenceLabel"] {
  if (winRate >= 0.80) return "Excellent";
  if (winRate >= 0.70) return "Good";
  if (winRate >= 0.60) return "Fair";
  if (winRate >= 0.50) return "Weak";
  return "Insufficient";
}

function findOptimalWindow(
  cumulativePaths: Map<number, number[]>, // year → cumulative return array (252 entries, 0-based)
): OptimalWindow | null {
  const years = [...cumulativePaths.keys()];
  if (years.length < 5) return null;
  const daysPerYear = 252;

  let bestScore = -Infinity;
  let best: { buyDay: number; sellDay: number; geometric: number; winRate: number; yearsTested: number } | null = null;

  // Step 5 to reduce computation while keeping granularity useful
  for (let buyDay = 0; buyDay < daysPerYear - 20; buyDay += 2) {
    for (let sellDay = buyDay + 20; sellDay < daysPerYear; sellDay += 2) {
      const windowReturns: number[] = [];
      for (const yr of years) {
        const path = cumulativePaths.get(yr);
        if (!path || path.length <= sellDay || path.length <= buyDay) continue;
        const buyRet = path[buyDay] / 100; // path is in % already
        const sellRet = path[sellDay] / 100;
        // window return = (1 + sell) / (1 + buy) - 1
        const wr = (1 + sellRet) / (1 + buyRet) - 1;
        windowReturns.push(wr);
      }
      if (windowReturns.length < Math.min(8, years.length * 0.5)) continue;
      const geometric = (Math.pow(
        windowReturns.reduce((acc, r) => acc * (1 + r), 1),
        1 / windowReturns.length,
      ) - 1) * 100;
      const winRate = windowReturns.filter((r) => r > 0).length / windowReturns.length;
      if (winRate < 0.50) continue;
      const score = geometric * winRate * Math.sqrt(windowReturns.length);
      if (score > bestScore) {
        bestScore = score;
        best = { buyDay, sellDay, geometric, winRate, yearsTested: windowReturns.length };
      }
    }
  }

  if (!best) return null;
  const label = confidenceLabel(best.winRate);
  if (label === "Insufficient") return null;

  return {
    buyDayOfYear: best.buyDay,
    buyDate: dayOfYearToDate(best.buyDay),
    sellDayOfYear: best.sellDay,
    sellDate: dayOfYearToDate(best.sellDay),
    geometricAvgReturn: best.geometric,
    winRate: best.winRate,
    yearsTested: best.yearsTested,
    confidenceLabel: label,
  };
}

function generateAnalysisText(
  symbol: string,
  opt: OptimalWindow | null,
  yearly: Pick<YearlySeasonality, "fullYearAvg" | "fullYearWinRate" | "presidentialCycleYear" | "presidentialCycleAvg" | "lookbackYears">,
  lookback: number,
): string {
  if (!opt || opt.confidenceLabel === "Insufficient") {
    return `Seasonal analysis for ${symbol} over the past ${lookback} years does not show a statistically reliable buy/sell window (confidence below 50%). Full-year average return: ${yearly.fullYearAvg >= 0 ? "+" : ""}${yearly.fullYearAvg.toFixed(1)}%, win rate ${Math.round(yearly.fullYearWinRate * 100)}%.`;
  }
  const winPct = Math.round(opt.winRate * 100);
  const positiveYears = Math.round(opt.winRate * opt.yearsTested);
  const cycleNote = yearly.presidentialCycleAvg != null
    ? ` The current presidential cycle is Year ${yearly.presidentialCycleYear} (${["","post-election","midterm","pre-election","election"][yearly.presidentialCycleYear]} year), which historically averages ${yearly.presidentialCycleAvg >= 0 ? "+" : ""}${yearly.presidentialCycleAvg.toFixed(1)}%.`
    : "";
  return `Analysis of the ${symbol} seasonal pattern above shows that a Buy Date of ${opt.buyDate} and a Sell Date of ${opt.sellDate} has resulted in a geometric average return of ${opt.geometricAvgReturn >= 0 ? "+" : ""}${opt.geometricAvgReturn.toFixed(1)}% over the past ${lookback} years. This seasonal timeframe has shown positive results in ${positiveYears} of those ${opt.yearsTested} periods (${winPct}%), rated ${opt.confidenceLabel}.${cycleNote}`;
}

// ─── Main compute ─────────────────────────────────────────────────────────
function computeSeasonality(
  bars: DailyBar[],
  lookbackYearsOverride?: number,
): Omit<SeasonalityTicker, "symbol" | "displayName"> {
  if (bars.length < 2) {
    const monthly: SeasonalityBar[] = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1, avgReturn: 0, medianReturn: 0, winRate: 0, sampleSize: 0, best: 0, worst: 0, stdDev: 0, currentYearReturn: null,
    }));
    const weekly: SeasonalityBar[] = Array.from({ length: 52 }, (_, i) => ({
      week: i + 1, avgReturn: 0, medianReturn: 0, winRate: 0, sampleSize: 0, best: 0, worst: 0, stdDev: 0, currentYearReturn: null,
    }));
    const emptyYearly: YearlySeasonality = {
      dailyCumulativePath: [],
      fullYearAvg: 0,
      fullYearMedian: 0,
      fullYearWinRate: 0,
      bestYear: { year: 0, return: 0 },
      worstYear: { year: 0, return: 0 },
      presidentialCycleYear: 2,
      presidentialCycleAvg: null,
      currentDecadeAvg: null,
      optimalWindow: null,
      yearsCovered: [],
      analysisText: "Insufficient data.",
    };
    return { monthly, weekly, yearly: emptyYearly, lookbackYears: 0, strongestMonth: { month: 1, avgReturn: 0, winRate: 0 }, weakestMonth: { month: 1, avgReturn: 0, winRate: 0 }, yearsCovered: [] };
  }

  const nowDate = new Date();
  const currentYear = nowDate.getFullYear();
  const currentMonth = nowDate.getMonth() + 1;
  const currentWeek = isoWeek(nowDate);

  // Filter bars by lookback
  let filteredBars = bars;
  if (lookbackYearsOverride && lookbackYearsOverride > 0) {
    const cutoffYear = currentYear - lookbackYearsOverride;
    filteredBars = bars.filter((b) => new Date(b.t * 1000).getUTCFullYear() > cutoffYear);
  }
  const firstBar = filteredBars[0] ?? bars[0];
  const firstYear = new Date(firstBar.t * 1000).getUTCFullYear();
  const lookbackYears = currentYear - firstYear;

  // ─── Monthly seasonality ───────────────────────────────────────────────
  type MonthKey = string;
  const monthGroups = new Map<MonthKey, DailyBar[]>();
  for (const bar of filteredBars) {
    const d = new Date(bar.t * 1000);
    const key: MonthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const arr = monthGroups.get(key) ?? [];
    arr.push(bar);
    monthGroups.set(key, arr);
  }

  const monthlyHistorical: Map<number, number[]> = new Map(Array.from({ length: 12 }, (_, i) => [i + 1, []]));
  const monthlyCurrentYear: Map<number, number | null> = new Map();

  for (const [key, barArr] of monthGroups) {
    const [yrStr, moStr] = key.split("-");
    const yr = Number(yrStr);
    const mo = Number(moStr);
    if (!barArr.length) continue;
    const sorted = [...barArr].sort((a, b) => a.t - b.t);
    const first = sorted[0].c;
    const last = sorted[sorted.length - 1].c;
    if (first <= 0) continue;
    const ret = ((last - first) / first) * 100;
    if (yr === currentYear) {
      if (mo <= currentMonth) monthlyCurrentYear.set(mo, ret);
    } else {
      (monthlyHistorical.get(mo) ?? []).push(ret);
    }
  }

  const monthly = enrichBars(monthlyHistorical, monthlyCurrentYear, Array.from({ length: 12 }, (_, i) => i + 1));

  // ─── Weekly seasonality ───────────────────────────────────────────────
  const weekGroups = new Map<string, DailyBar[]>();
  for (const bar of filteredBars) {
    const d = new Date(bar.t * 1000);
    const wk = isoWeek(d);
    const key = `${d.getUTCFullYear()}-${String(wk).padStart(2, "0")}`;
    const arr = weekGroups.get(key) ?? [];
    arr.push(bar);
    weekGroups.set(key, arr);
  }

  const weeklyHistorical: Map<number, number[]> = new Map(Array.from({ length: 53 }, (_, i) => [i + 1, []]));
  const weeklyCurrentYear: Map<number, number | null> = new Map();

  for (const [key, barArr] of weekGroups) {
    const [yrStr, wkStr] = key.split("-");
    const yr = Number(yrStr);
    const wk = Number(wkStr);
    if (!barArr.length) continue;
    const sorted = [...barArr].sort((a, b) => a.t - b.t);
    const first = sorted[0].c;
    const last = sorted[sorted.length - 1].c;
    if (first <= 0) continue;
    const ret = ((last - first) / first) * 100;
    if (yr === currentYear) {
      if (wk <= currentWeek) weeklyCurrentYear.set(wk, ret);
    } else {
      (weeklyHistorical.get(wk) ?? []).push(ret);
    }
  }

  const weekly = enrichBars(weeklyHistorical, weeklyCurrentYear, Array.from({ length: 52 }, (_, i) => i + 1));

  // ─── Yearly cumulative path ────────────────────────────────────────────
  // Group bars by year
  const barsByYear = new Map<number, DailyBar[]>();
  for (const bar of filteredBars) {
    const yr = new Date(bar.t * 1000).getUTCFullYear();
    const arr = barsByYear.get(yr) ?? [];
    arr.push(bar);
    barsByYear.set(yr, arr);
  }

  const TARGET_DAYS = 252; // canonical trading year

  // Per-year cumulative return arrays (TARGET_DAYS entries)
  const yearCumPaths = new Map<number, number[]>(); // year → array of % from yr-start
  const yearFullReturn = new Map<number, number>();  // year → full year % return
  const historicalYears: number[] = [];

  for (const [yr, yearBars] of barsByYear) {
    if (yr === currentYear) continue; // handle current year separately
    const sorted = [...yearBars].sort((a, b) => a.t - b.t);
    if (sorted.length < 20) continue; // too few bars
    const startClose = sorted[0].c;
    if (startClose <= 0) continue;

    // Build cumulative path — resample to TARGET_DAYS using linear interp
    const rawPath = sorted.map((b) => ((b.c - startClose) / startClose) * 100);
    const resampled: number[] = [];
    for (let d = 0; d < TARGET_DAYS; d++) {
      const rawIdx = (d / (TARGET_DAYS - 1)) * (rawPath.length - 1);
      const lo = Math.floor(rawIdx);
      const hi = Math.ceil(rawIdx);
      const frac = rawIdx - lo;
      resampled.push(rawPath[lo] * (1 - frac) + rawPath[Math.min(hi, rawPath.length - 1)] * frac);
    }
    yearCumPaths.set(yr, resampled);
    yearFullReturn.set(yr, resampled[TARGET_DAYS - 1]);
    historicalYears.push(yr);
  }

  // Current year YTD cumulative path
  const currentYearBars = barsByYear.get(currentYear) ?? [];
  const currentYearSorted = [...currentYearBars].sort((a, b) => a.t - b.t);
  const currentYearCumPath: (number | null)[] = new Array(TARGET_DAYS).fill(null);
  if (currentYearSorted.length >= 2) {
    const startClose = currentYearSorted[0].c;
    const rawPath = currentYearSorted.map((b) => ((b.c - startClose) / startClose) * 100);
    const todayDayCount = currentYearSorted.length;
    // Map to target days
    for (let d = 0; d <= Math.min(todayDayCount - 1, TARGET_DAYS - 1); d++) {
      const rawIdx = (d / (TARGET_DAYS - 1)) * (rawPath.length - 1);
      const lo = Math.floor(rawIdx);
      const hi = Math.ceil(rawIdx);
      const frac = rawIdx - lo;
      const val = rawPath[lo] * (1 - frac) + rawPath[Math.min(hi, rawPath.length - 1)] * frac;
      currentYearCumPath[d] = val;
    }
    // Only fill up to current trading day equivalent
    const currentDayFraction = todayDayCount / TARGET_DAYS;
    const currentDayIdx = Math.floor(currentDayFraction * TARGET_DAYS);
    for (let d = currentDayIdx; d < TARGET_DAYS; d++) {
      currentYearCumPath[d] = null;
    }
  }

  // Build daily cumulative path: average across historical years at each day
  const dailyCumulativePath: YearlySeasonality["dailyCumulativePath"] = [];
  const years = historicalYears;

  for (let d = 0; d < TARGET_DAYS; d++) {
    const vals: number[] = [];
    for (const yr of years) {
      const path = yearCumPaths.get(yr);
      if (path && d < path.length) vals.push(path[d]);
    }
    const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const sd = stdDev(vals);
    const freqPos = vals.length > 0 ? vals.filter((v) => v > 0).length / vals.length : 0;
    dailyCumulativePath.push({
      dayOfYear: d + 1,
      avgCumulativeReturn: avg,
      stdDev: sd,
      frequencyPositive: freqPos,
      currentYearCumulativeReturn: currentYearCumPath[d],
    });
  }

  // Full-year stats
  const fullYearReturns = [...yearFullReturn.entries()].filter(([yr]) => yr !== currentYear);
  const fullYearVals = fullYearReturns.map(([, v]) => v);
  const fullYearAvg = fullYearVals.length > 0 ? fullYearVals.reduce((a, b) => a + b, 0) / fullYearVals.length : 0;
  const fullYearMedian = median(fullYearVals);
  const fullYearWinRate = fullYearVals.length > 0 ? fullYearVals.filter((v) => v > 0).length / fullYearVals.length : 0;
  const bestYearEntry = fullYearReturns.reduce((best, cur) => cur[1] > best[1] ? cur : best, fullYearReturns[0] ?? [0, 0]);
  const worstYearEntry = fullYearReturns.reduce((worst, cur) => cur[1] < worst[1] ? cur : worst, fullYearReturns[0] ?? [0, 0]);

  // Presidential cycle
  const cycYear = presidentialCycleYear(currentYear);
  const cycleYears = historicalYears.filter((yr) => presidentialCycleYear(yr) === cycYear);
  const cycleReturns = cycleYears.map((yr) => yearFullReturn.get(yr)).filter((v): v is number => v != null);
  const presidentialCycleAvg = cycleReturns.length > 0
    ? cycleReturns.reduce((a, b) => a + b, 0) / cycleReturns.length
    : null;

  // Decade avg
  const currentDecade = Math.floor(currentYear / 10) * 10;
  const decadeYears = historicalYears.filter((yr) => yr >= currentDecade && yr < currentDecade + 10);
  const decadeReturns = decadeYears.map((yr) => yearFullReturn.get(yr)).filter((v): v is number => v != null);
  const currentDecadeAvg = decadeReturns.length > 0
    ? decadeReturns.reduce((a, b) => a + b, 0) / decadeReturns.length
    : null;

  // Optimal window
  const optimalWindow = findOptimalWindow(yearCumPaths);

  const yearsCovered = historicalYears.sort((a, b) => a - b).map(String);

  const yearlyResult: YearlySeasonality = {
    dailyCumulativePath,
    fullYearAvg,
    fullYearMedian,
    fullYearWinRate,
    bestYear: { year: bestYearEntry?.[0] ?? 0, return: bestYearEntry?.[1] ?? 0 },
    worstYear: { year: worstYearEntry?.[0] ?? 0, return: worstYearEntry?.[1] ?? 0 },
    presidentialCycleYear: cycYear,
    presidentialCycleAvg,
    currentDecadeAvg,
    optimalWindow,
    yearsCovered,
    analysisText: generateAnalysisText(
      "this ticker",
      optimalWindow,
      { fullYearAvg, fullYearWinRate, presidentialCycleYear: cycYear, presidentialCycleAvg, lookbackYears },
      lookbackYears,
    ),
  };

  // Strongest / weakest month
  const sortedMonthly = [...monthly].sort((a, b) => b.avgReturn - a.avgReturn);
  const strongestMonth = { month: sortedMonthly[0].month!, avgReturn: sortedMonthly[0].avgReturn, winRate: sortedMonthly[0].winRate };
  const weakestMonth = { month: sortedMonthly[sortedMonthly.length - 1].month!, avgReturn: sortedMonthly[sortedMonthly.length - 1].avgReturn, winRate: sortedMonthly[sortedMonthly.length - 1].winRate };

  return { monthly, weekly, yearly: yearlyResult, lookbackYears, strongestMonth, weakestMonth, yearsCovered };
}

// ─── Cache ────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = "seasonality-v2";

interface CachedSeasonality { at: number; data: SeasonalityResponse }
let memCache: CachedSeasonality | null = null;

export async function buildSeasonalitySnapshot(lookback?: number): Promise<SeasonalityResponse> {
  // If specific lookback requested, compute on the fly from base cache
  const baseCacheKey = CACHE_KEY;

  // Check memory cache first (only for default 20yr)
  if (!lookback || lookback === 20) {
    if (memCache && Date.now() - memCache.at < CACHE_TTL_MS) return memCache.data;
    const diskCached = await readCache<CachedSeasonality>(baseCacheKey);
    if (diskCached && Date.now() - diskCached.at < CACHE_TTL_MS) {
      memCache = diskCached;
      return diskCached.data;
    }
  }

  console.log(`[seasonality] Building fresh seasonality snapshot (lookback=${lookback ?? 20})…`);

  const results: SeasonalityTicker[] = [];
  const BATCH = 3;

  for (let i = 0; i < TICKER_MAP.length; i += BATCH) {
    const batch = TICKER_MAP.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (tk) => {
        const bars = await fetchBars(tk.yahooSymbol);
        const computed = computeSeasonality(bars, lookback);
        console.log(`[seasonality] ${tk.yahooSymbol}: ${bars.length} bars, ${computed.lookbackYears} yrs`);
        // Fix analysis text symbol reference
        const yearly = { ...computed.yearly };
        yearly.analysisText = generateAnalysisText(
          tk.symbol,
          yearly.optimalWindow,
          { fullYearAvg: yearly.fullYearAvg, fullYearWinRate: yearly.fullYearWinRate, presidentialCycleYear: yearly.presidentialCycleYear, presidentialCycleAvg: yearly.presidentialCycleAvg, lookbackYears: computed.lookbackYears },
          computed.lookbackYears,
        );
        return { symbol: tk.symbol, displayName: tk.displayName, ...computed, yearly };
      }),
    );
    results.push(...batchResults);
    if (i + BATCH < TICKER_MAP.length) await new Promise((r) => setTimeout(r, 300));
  }

  const response: SeasonalityResponse = { tickers: results, asOf: new Date().toISOString() };

  // Only cache the default 20yr build
  if (!lookback || lookback === 20) {
    const cached: CachedSeasonality = { at: Date.now(), data: response };
    memCache = cached;
    await writeCache(baseCacheKey, cached);
  }

  return response;
}
