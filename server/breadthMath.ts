// server/breadthMath.ts
//
// Pure breadth computation (no DB), so the labels and data states are
// testable. server/breadth.ts loads the bars and calls computeBreadth().
//
// What the sample is (review finding 5.7). The single-stock sample is the
// 36 names the app already caches from Schwab: the mega caps and high-flow
// names on the watchlist (TSLA, NVDA, COIN, MSTR, PLTR ...) plus 20 large
// caps added across sectors. It is hand-picked, not a random or constituent
// sample, so it measures LARGE-CAP participation, not the median stock.
// Schwab's Trader API has no index-constituent or advance/decline endpoint
// we could verify, so two broader reads sit beside it, both from Schwab
// daily bars already cached for the Regime tab:
//   - sector participation: how many of the 11 SPDR sector ETFs are above
//     their 20/50-day averages (each sector counts once, whatever its cap);
//   - RSP/SPY: equal-weight S&P 500 vs cap-weight, the standard read on
//     whether the average constituent keeps up with the index.

import { etClock, etDate, isTradingDay, prevTradingDay, sessionCloseMinutes } from "./exchangeCalendar";

export interface BarRow { symbol: string; date: string; close: number }

export const SECTOR_ETFS = ["XLK", "XLF", "XLE", "XLY", "XLP", "XLI", "XLU", "XLV", "XLB", "XLRE", "XLC"];

export interface BreadthSnapshot {
  asOf: number;
  sampleSize: number;         // symbols with enough history today
  pctAbove20dma: number | null;
  pctAbove50dma: number | null;
  advancersPct: number | null; // % of sample up on the last cached session
  rspSpyZ: number | null;      // 20d RSP/SPY ratio z-score (60d baseline)
  spyNear20dHigh: boolean | null;
  divergence: boolean;         // SPY near highs while <55% above 20dma
  read: string;                // plain-english verdict
  history: Array<{ date: string; pctAbove20: number }>;  // ~60 sessions
  note: string;
  /** what the single-stock sample is, so nobody reads it as the median stock */
  sample: { kind: "hand-picked large caps"; random: false; measures: string; symbols: number };
  /** 11 SPDR sector ETFs: equal count per sector */
  sectorBreadth: { pctAbove20dma: number | null; pctAbove50dma: number | null; sectors: number };
  /** last daily bar in the cache (SPY calendar) and the session it should be */
  lastBarDate: string | null;
  expectedBarDate: string | null;
  dataState: "ok" | "stale" | "insufficient" | "unavailable";
}

export function sma(values: number[], n: number, endIdx: number): number | null {
  if (endIdx + 1 < n) return null;
  let s = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) s += values[i];
  return s / n;
}

/** Last completed regular session at `nowMs` (ET): today after the close, else the prior trading day. */
export function lastCompletedSession(nowMs: number): string {
  const today = etDate(nowMs);
  const close = sessionCloseMinutes(today);
  if (isTradingDay(today) && close != null && etClock(nowMs).minutes >= close) return today;
  return prevTradingDay(today);
}

const SAMPLE_MEASURES = "large-cap participation (hand-picked watchlist names, not a random or constituent sample; not the median stock)";

function emptySnapshot(nowMs: number, symbols: number, state: BreadthSnapshot["dataState"], lastBarDate: string | null, expected: string | null): BreadthSnapshot {
  return {
    asOf: nowMs, sampleSize: 0, pctAbove20dma: null, pctAbove50dma: null,
    advancersPct: null, rspSpyZ: null, spyNear20dHigh: null, divergence: false,
    read: "insufficient data", history: [],
    note: `sampled breadth (${symbols} hand-picked large caps), not full NYSE breadth`,
    sample: { kind: "hand-picked large caps", random: false, measures: SAMPLE_MEASURES, symbols },
    sectorBreadth: { pctAbove20dma: null, pctAbove50dma: null, sectors: 0 },
    lastBarDate, expectedBarDate: expected, dataState: state,
  };
}

/** % of symbols above their N-day SMA on the last date; null if fewer than minCount qualify. */
function participation(
  closeMatrix: Map<string, Map<string, number>>,
  symbols: string[],
  dates: string[],
  n: number,
  minCount: number,
): number | null {
  let above = 0, total = 0;
  for (const sym of symbols) {
    const cm = closeMatrix.get(sym);
    if (!cm) continue;
    const series: number[] = [];
    for (const d of dates) { const c = cm.get(d); if (c != null) series.push(c); }
    if (series.length < n + 1) continue;
    const i = series.length - 1;
    const m = sma(series, n, i);
    if (m == null) continue;
    total++;
    if (series[i] > m) above++;
  }
  return total >= minCount ? (above / total) * 100 : null;
}

export function computeBreadth(input: {
  rows: BarRow[];          // single-stock sample bars
  etfRows: BarRow[];       // SPY, RSP and sector ETF bars
  stockSymbols: string[];
  nowMs: number;
}): BreadthSnapshot {
  const { rows, etfRows, stockSymbols, nowMs } = input;
  const expected = lastCompletedSession(nowMs);
  const bySym = new Map<string, BarRow[]>();
  for (const r of rows.concat(etfRows)) {
    const a = bySym.get(r.symbol) ?? [];
    a.push(r); bySym.set(r.symbol, a);
  }
  for (const a of Array.from(bySym.values())) a.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  const spy = bySym.get("SPY") ?? [];
  const rsp = bySym.get("RSP") ?? [];
  const lastBarDate = spy.length ? spy[spy.length - 1].date : null;
  if (spy.length < 70) return emptySnapshot(nowMs, stockSymbols.length, "insufficient", lastBarDate, expected);

  const dates = spy.map((r) => r.date);
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const closeMatrix = new Map<string, Map<string, number>>();
  for (const [sym, list] of Array.from(bySym.entries())) closeMatrix.set(sym, new Map(list.map((r) => [r.date, r.close])));

  // 60-session participation history (single-stock sample).
  const history: Array<{ date: string; pctAbove20: number }> = [];
  const start = Math.max(50, dates.length - 60);
  for (let di = start; di < dates.length; di++) {
    const v = participation(closeMatrix, stockSymbols, dates.slice(0, di + 1), 20, 20);
    if (v != null) history.push({ date: dates[di], pctAbove20: Number(v.toFixed(1)) });
  }

  // Last-session stats.
  let above20 = 0, above50 = 0, adv = 0, total = 0;
  for (const sym of stockSymbols) {
    const cm = closeMatrix.get(sym);
    if (!cm) continue;
    const series: number[] = [];
    for (const d of dates) { const c = cm.get(d); if (c != null) series.push(c); }
    if (series.length < 51) continue;
    const i = series.length - 1;
    const m20 = sma(series, 20, i), m50 = sma(series, 50, i);
    if (m20 == null || m50 == null) continue;
    total++;
    if (series[i] > m20) above20++;
    if (series[i] > m50) above50++;
    if (series[i] > series[i - 1]) adv++;
  }
  if (total < 20) return emptySnapshot(nowMs, stockSymbols.length, "insufficient", lastBarDate, expected);

  const pct20 = (above20 / total) * 100;
  const pct50 = (above50 / total) * 100;
  const advPct = (adv / total) * 100;

  // Sector participation: each of the 11 sectors counts once.
  const sec20 = participation(closeMatrix, SECTOR_ETFS, dates, 20, 8);
  const sec50 = participation(closeMatrix, SECTOR_ETFS, dates, 50, 8);
  const sectorsWithData = SECTOR_ETFS.filter((s) => (closeMatrix.get(s)?.size ?? 0) >= 51).length;

  // RSP/SPY ratio z (20d mean of ratio vs 60d baseline)
  let rspSpyZ: number | null = null;
  if (rsp.length >= 70) {
    const rspMap = new Map(rsp.map((r) => [r.date, r.close]));
    const ratios: number[] = [];
    for (const d of dates) {
      const rc = rspMap.get(d);
      const sc = spy[dateIdx.get(d)!].close;
      if (rc != null && sc > 0) ratios.push(rc / sc);
    }
    if (ratios.length >= 60) {
      const last20 = ratios.slice(-20).reduce((s, x) => s + x, 0) / 20;
      const base = ratios.slice(-60);
      const mean = base.reduce((s, x) => s + x, 0) / base.length;
      const sd = Math.sqrt(base.reduce((s, x) => s + (x - mean) ** 2, 0) / base.length);
      if (sd > 0) rspSpyZ = Number((((last20 - mean) / sd)).toFixed(2));
    }
  }

  const spyCloses = spy.map((r) => r.close);
  const last20High = Math.max(...spyCloses.slice(-20));
  const spyLast = spyCloses[spyCloses.length - 1];
  const nearHigh = spyLast >= last20High * 0.99;
  const divergence = nearHigh && pct20 < 55;

  const read = divergence
    ? `thin tape among the large caps: index near highs but under 55% of the ${total}-name sample above its 20dma.`
    : pct20 >= 70
      ? "broad large-cap participation — the index move has the big names behind it."
      : pct20 >= 50
        ? "mixed large-cap participation — no breadth edge either way."
        : nearHigh
          ? "index holding up but large-cap participation weak — watch for catch-down."
          : "weak large-cap participation confirming index softness.";

  const stale = lastBarDate != null && lastBarDate < expected;
  const dataState: BreadthSnapshot["dataState"] = stale ? "stale" : "ok";
  return {
    asOf: nowMs,
    sampleSize: total,
    pctAbove20dma: Number(pct20.toFixed(1)),
    pctAbove50dma: Number(pct50.toFixed(1)),
    advancersPct: Number(advPct.toFixed(1)),
    rspSpyZ,
    spyNear20dHigh: nearHigh,
    divergence,
    read: stale ? `${read} (bars stale: last ${lastBarDate}, expected ${expected})` : read,
    history,
    note: `sampled breadth — ${total} hand-picked large caps from the Schwab daily cache (watchlist names, not a random or constituent sample: it reads large-cap participation, not the median stock). Sector participation counts each of the 11 SPDR sectors once. RSP/SPY z ${rspSpyZ == null ? "unavailable until RSP history caches" : "from 20d equal-weight/cap-weight ratio vs 60d baseline"}.`,
    sample: { kind: "hand-picked large caps", random: false, measures: SAMPLE_MEASURES, symbols: stockSymbols.length },
    sectorBreadth: {
      pctAbove20dma: sec20 == null ? null : Number(sec20.toFixed(1)),
      pctAbove50dma: sec50 == null ? null : Number(sec50.toFixed(1)),
      sectors: sectorsWithData,
    },
    lastBarDate,
    expectedBarDate: expected,
    dataState,
  };
}
