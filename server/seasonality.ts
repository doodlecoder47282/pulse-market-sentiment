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
// Cache: 24hr TTL (disk-backed via sessionCache). Cache key: seasonality-v3.

import { readCache, writeCache } from "./sessionCache";

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
  /** Data-snooping test of the window search (added). The label above is
   *  "Insufficient" unless the family-wise p-value is ≤ 0.05. */
  significance?: SeasonalSignificance;
}

export interface SeasonalSignificance {
  method: string;
  /** Pairs searched per run (the multiple-testing family). */
  windowsSearched: number;
  permutations: number;
  /** P(best score on calendar-scrambled data ≥ observed best score). */
  pFamilywise: number;
  significant: boolean;
  alpha: number;
  /** Walk-forward hold-out: window chosen on the earlier years only,
   *  evaluated on the most recent years it never saw. null if < 8 years. */
  outOfSample: {
    inSampleYears: number;
    heldOutYears: number;
    buyDayOfYear: number;
    sellDayOfYear: number;
    geometricAvgReturn: number;
    winRate: number;
    /** Share of same-length windows (all start days) on the held-out years
     *  whose mean log return is below the chosen window's. 0.5 = random. */
    randomWindowPercentile: number;
  } | null;
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

// TODO: Schwab-only mode — Yahoo source removed, using Schwab getPriceHistory.
// Note: Schwab max history is ~10 years for daily; 20y range truncated to available history.
export async function fetchBars(yahooSymbol: string): Promise<DailyBar[]> {
  // Map legacy Yahoo symbols to Schwab equivalents
  // Schwab cash indexes use "$" prefix WITHOUT ".X" suffix.
  const schwabSymMap: Record<string, string> = {
    "^VIX": "$VIX", "^GSPC": "$SPX", "^SPX": "$SPX",
    "BTC-USD": "BTC/USD",
  };
  const schwabSym = schwabSymMap[yahooSymbol] ?? yahooSymbol;
  try {
    const { getPriceHistory } = await import("./schwab");
    // Use max supported period (10 years daily)
    const resp = await getPriceHistory(schwabSym, "year", 10, "daily", 1);
    return resp.candles
      .filter((c) => c.close != null && isFinite(c.close) && c.close > 0)
      .map((c) => ({ t: Math.floor(c.datetime / 1000), c: c.close }));
  } catch (e: any) {
    console.warn(`[seasonality] Schwab fetch failed for ${yahooSymbol}: ${e?.message}`);
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

// ─── Window search + data-snooping test ──────────────────────────────────
//
// The search below scans ~7,000 buy/sell pairs and keeps the best one. The
// best of thousands of windows looks good even on pure noise (review: noise
// was rated Good/Excellent in 32 of 40 zero-drift trials). The label is now
// earned only through a test that accounts for the whole search:
//
//   1. Family-wise permutation test (max-statistic, White 2000 "A Reality
//      Check for Data Snooping", Econometrica 68:1097; applied to calendar
//      effects by Sullivan, Timmermann & White 2001, J. Econometrics
//      105:249). Each null replicate circularly shifts every year's daily
//      log returns by an independent random offset, which keeps each year's
//      return, volatility and serial dependence but destroys calendar
//      alignment. The full search is re-run on each replicate; the p-value
//      is the share of replicates whose BEST score beats the observed best.
//      Positive drift is kept in the null, so a window must beat holding a
//      random window of the market, not beat cash.
//   2. Walk-forward hold-out: choose the window on the earlier years only
//      and report how it did on the most recent years, ranked against every
//      same-length window on those years.
// Labels "Fair" and above require p ≤ 0.05; otherwise "Insufficient".

const SEASONAL_DAYS = 252;
const SEASONAL_STEP = 2;
const SEASONAL_MIN_LEN = 20;
const SEASONAL_PERMUTATIONS = 199;
const SEASONAL_ALPHA = 0.05;

type WindowPick = { buyDay: number; sellDay: number; geometric: number; winRate: number; yearsTested: number; score: number };

/** Paths are % cumulative-from-year-start (TARGET_DAYS entries) → log(1+r). */
function toLogPaths(paths: number[][]): Float64Array[] {
  return paths.map((p) => {
    const out = new Float64Array(SEASONAL_DAYS);
    for (let d = 0; d < SEASONAL_DAYS; d++) out[d] = Math.log(1 + (p[d] ?? p[p.length - 1]) / 100);
    return out;
  });
}

/** Same selection rule as before: max geometric% × winRate × √years, winRate ≥ 0.5. */
function searchBestWindow(logPaths: Float64Array[]): { best: WindowPick | null; searched: number } {
  const Y = logPaths.length;
  if (Y === 0) return { best: null, searched: 0 };
  const minYears = Math.min(8, Y * 0.5);
  if (Y < minYears) return { best: null, searched: 0 };
  // Mean log path: mean over years of (L[sell] − L[buy]) = M[sell] − M[buy].
  const M = new Float64Array(SEASONAL_DAYS);
  for (const L of logPaths) for (let d = 0; d < SEASONAL_DAYS; d++) M[d] += L[d] / Y;
  const sqrtY = Math.sqrt(Y);
  let best: WindowPick | null = null;
  let searched = 0;
  for (let buyDay = 0; buyDay < SEASONAL_DAYS - SEASONAL_MIN_LEN; buyDay += SEASONAL_STEP) {
    for (let sellDay = buyDay + SEASONAL_MIN_LEN; sellDay < SEASONAL_DAYS; sellDay += SEASONAL_STEP) {
      searched++;
      let wins = 0;
      for (let y = 0; y < Y; y++) if (logPaths[y][sellDay] > logPaths[y][buyDay]) wins++;
      const winRate = wins / Y;
      if (winRate < 0.5) continue;
      const geometric = (Math.exp(M[sellDay] - M[buyDay]) - 1) * 100;
      const score = geometric * winRate * sqrtY;
      if (best == null || score > best.score) {
        best = { buyDay, sellDay, geometric, winRate, yearsTested: Y, score };
      }
    }
  }
  return { best, searched };
}

/**
 * True when daily bars (sorted by t, epoch seconds) cover a whole calendar
 * year: first session by Jan 10, last session on/after Dec 20, and at least
 * 200 sessions (NYSE years have 250-253; 2001 had 248).
 */
export function isFullCalendarYear(sortedBars: Array<{ t: number }>): boolean {
  if (sortedBars.length < 200) return false;
  const first = new Date(sortedBars[0].t * 1000);
  const last = new Date(sortedBars[sortedBars.length - 1].t * 1000);
  return (
    first.getUTCMonth() === 0 && first.getUTCDate() <= 10 &&
    last.getUTCMonth() === 11 && last.getUTCDate() >= 20
  );
}

/** Deterministic PRNG (mulberry32) so the same history gives the same p-value. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Null replicate: circularly shift each year's daily log returns. */
function calendarScramble(logPaths: Float64Array[], rand: () => number): Float64Array[] {
  const nInc = SEASONAL_DAYS - 1;
  return logPaths.map((L) => {
    const shift = Math.floor(rand() * nInc);
    const out = new Float64Array(SEASONAL_DAYS);
    let acc = 0;
    for (let d = 1; d < SEASONAL_DAYS; d++) {
      const src = ((d - 1 + shift) % nInc) + 1;
      acc += L[src] - L[src - 1];
      out[d] = acc;
    }
    return out;
  });
}

function outOfSampleCheck(logPaths: Float64Array[]): SeasonalSignificance["outOfSample"] {
  const Y = logPaths.length;
  if (Y < 8) return null;
  const hold = Math.max(2, Math.floor(Y / 3));
  const train = logPaths.slice(0, Y - hold);
  const test = logPaths.slice(Y - hold);
  const pick = searchBestWindow(train).best;
  if (!pick) return null;
  const meanLog = (buy: number, sell: number) =>
    test.reduce((s, L) => s + (L[sell] - L[buy]), 0) / test.length;
  const chosen = meanLog(pick.buyDay, pick.sellDay);
  const len = pick.sellDay - pick.buyDay;
  let below = 0, total = 0;
  for (let b = 0; b + len < SEASONAL_DAYS; b++) {
    const m = meanLog(b, b + len);
    total++;
    if (m < chosen) below++;
    else if (m === chosen) below += 0.5;
  }
  const wins = test.filter((L) => L[pick.sellDay] > L[pick.buyDay]).length;
  return {
    inSampleYears: train.length,
    heldOutYears: test.length,
    buyDayOfYear: pick.buyDay,
    sellDayOfYear: pick.sellDay,
    geometricAvgReturn: (Math.exp(chosen) - 1) * 100,
    winRate: wins / test.length,
    randomWindowPercentile: total > 0 ? below / total : 0.5,
  };
}

/**
 * Find the best seasonal buy/sell window and test it for data snooping.
 * `cumulativePaths` is year → % cumulative return from the year's first close
 * (TARGET_DAYS entries). Years are used in ascending order for the hold-out.
 */
export function findOptimalWindow(
  cumulativePaths: Map<number, number[]>,
  opts: { permutations?: number; seed?: number } = {},
): OptimalWindow | null {
  const years = [...cumulativePaths.keys()].sort((a, b) => a - b);
  if (years.length < 5) return null;
  const logPaths = toLogPaths(years.map((y) => cumulativePaths.get(y) ?? []).filter((p) => p.length > 0));
  if (logPaths.length < 5) return null;

  const { best, searched } = searchBestWindow(logPaths);
  if (!best) return null;

  const B = Math.max(19, Math.floor(opts.permutations ?? SEASONAL_PERMUTATIONS));
  const rand = mulberry32(opts.seed ?? 0x5ea5);
  let atLeast = 0;
  for (let i = 0; i < B; i++) {
    const nullBest = searchBestWindow(calendarScramble(logPaths, rand)).best;
    if (nullBest && nullBest.score >= best.score) atLeast++;
  }
  const pFamilywise = (1 + atLeast) / (B + 1);
  const significant = pFamilywise <= SEASONAL_ALPHA;
  const outOfSample = outOfSampleCheck(logPaths);

  let label: OptimalWindow["confidenceLabel"] = significant ? confidenceLabel(best.winRate) : "Insufficient";
  // A window that held up in-sample but lands in the bottom half of random
  // same-length windows on unseen years is not a "Good" window.
  if (significant && outOfSample && outOfSample.randomWindowPercentile < 0.5 && (label === "Excellent" || label === "Good" || label === "Fair")) {
    label = "Weak";
  }

  return {
    buyDayOfYear: best.buyDay,
    buyDate: dayOfYearToDate(best.buyDay),
    sellDayOfYear: best.sellDay,
    sellDate: dayOfYearToDate(best.sellDay),
    geometricAvgReturn: best.geometric,
    winRate: best.winRate,
    yearsTested: best.yearsTested,
    confidenceLabel: label,
    significance: {
      method: "max-statistic permutation test over the full window search (calendar-scrambled years, White 2000 / Sullivan-Timmermann-White 2001) + walk-forward hold-out",
      windowsSearched: searched,
      permutations: B,
      pFamilywise,
      significant,
      alpha: SEASONAL_ALPHA,
      outOfSample,
    },
  };
}

export function generateAnalysisText(
  symbol: string,
  opt: OptimalWindow | null,
  yearly: Pick<YearlySeasonality, "fullYearAvg" | "fullYearWinRate" | "presidentialCycleYear" | "presidentialCycleAvg" | "lookbackYears">,
  lookback: number,
): string {
  if (!opt || opt.confidenceLabel === "Insufficient") {
    const sig = opt?.significance;
    const snoop = opt && sig
      ? ` The best in-sample window (${opt.buyDate} to ${opt.sellDate}, ${Math.round(opt.winRate * 100)}% of ${opt.yearsTested} years positive) does not beat calendar-scrambled history after accounting for the ${sig.windowsSearched.toLocaleString("en-US")} windows searched (data-snooping p=${sig.pFamilywise.toFixed(2)}), so it is not a reliable pattern.`
      : "";
    return `Seasonal analysis for ${symbol} over the past ${lookback} years does not show a statistically reliable buy/sell window.${snoop} Full-year average return: ${yearly.fullYearAvg >= 0 ? "+" : ""}${yearly.fullYearAvg.toFixed(1)}%, win rate ${Math.round(yearly.fullYearWinRate * 100)}%.`;
  }
  const winPct = Math.round(opt.winRate * 100);
  const positiveYears = Math.round(opt.winRate * opt.yearsTested);
  const cycleNote = yearly.presidentialCycleAvg != null
    ? ` The current presidential cycle is Year ${yearly.presidentialCycleYear} (${["","post-election","midterm","pre-election","election"][yearly.presidentialCycleYear]} year), which historically averages ${yearly.presidentialCycleAvg >= 0 ? "+" : ""}${yearly.presidentialCycleAvg.toFixed(1)}%.`
    : "";
  const sig = opt.significance;
  const sigNote = sig
    ? ` Data-snooping p=${sig.pFamilywise.toFixed(2)} across ${sig.windowsSearched.toLocaleString("en-US")} windows searched${sig.outOfSample ? `; on the ${sig.outOfSample.heldOutYears} most recent held-out years the window chosen without them ranked at the ${Math.round(sig.outOfSample.randomWindowPercentile * 100)}th percentile of same-length windows` : ""}.`
    : "";
  return `Analysis of the ${symbol} seasonal pattern above shows that a Buy Date of ${opt.buyDate} and a Sell Date of ${opt.sellDate} has resulted in a geometric average return of ${opt.geometricAvgReturn >= 0 ? "+" : ""}${opt.geometricAvgReturn.toFixed(1)}% over the past ${lookback} years. This seasonal timeframe has shown positive results in ${positiveYears} of those ${opt.yearsTested} periods (${winPct}%), rated ${opt.confidenceLabel}.${sigNote}${cycleNote}`;
}

// ─── Main compute ─────────────────────────────────────────────────────────
export function computeSeasonality(
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
    // Key by ISO week-YEAR (year of that week's Thursday), not calendar year —
    // otherwise Dec 29-31 land in "week 1" of the wrong year and pollute the
    // first-week stats with a whole year's return.
    const thu = new Date(Date.UTC(
      d.getUTCFullYear(), d.getUTCMonth(),
      d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7),
    ));
    const key = `${thu.getUTCFullYear()}-${String(wk).padStart(2, "0")}`;
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
    // Only full calendar years enter the day-of-year paths. A partial year
    // (history starting mid-year, or a gap) would be stretched over 252 slots
    // by the resample below, so its July would plot as January and its
    // "full-year" return would be a partial-year return.
    if (!isFullCalendarYear(sorted)) continue;
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
    // Trading day d of THIS year plots at slot d — no stretching a partial YTD
    // across all 252 slots (that made the line lag the calendar).
    for (let d = 0; d < Math.min(rawPath.length, TARGET_DAYS); d++) {
      currentYearCumPath[d] = rawPath[d];
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
const CACHE_KEY = "seasonality-v3"; // v3: optimal window carries the data-snooping test

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
