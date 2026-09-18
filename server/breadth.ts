/**
 * MISSION FIX #6 — sampled breadth engine.
 *
 * The composite reads VIX, gamma, put/call, sentiment surveys — all price-of-
 * insurance or positioning measures. None of them answer "how many soldiers
 * are marching with the generals?" A cap-weighted index can grind higher on
 * 5 megacaps while the median stock rolls over; that divergence historically
 * precedes air pockets.
 *
 * This is SAMPLED breadth: 36 large caps across sectors from the daily-bars
 * cache (Schwab-only), not full NYSE breadth. Disclosed as such. Signals:
 *   - % of sample above 20dma / 50dma (participation)
 *   - advancers % today (daily pulse)
 *   - RSP/SPY 20d ratio z-score (equal-weight vs cap-weight divergence)
 *   - divergence flag: SPY near 20d high while participation is thin
 *
 * All computed from cached daily closes — zero extra API calls at read time.
 */

import { sqlite } from "./storage";
import { BREADTH_STOCKS } from "./stockBarsCache";

interface BarRow { symbol: string; date: string; close: number }

export interface BreadthSnapshot {
  asOf: number;
  sampleSize: number;         // symbols with enough history today
  pctAbove20dma: number | null;
  pctAbove50dma: number | null;
  advancersPct: number | null; // % of sample up on the day
  rspSpyZ: number | null;      // 20d RSP/SPY ratio z-score (60d baseline)
  spyNear20dHigh: boolean | null;
  divergence: boolean;         // SPY near highs while <55% above 20dma
  read: string;                // plain-english verdict
  history: Array<{ date: string; pctAbove20: number }>;  // ~60 sessions
  note: string;
}

function sma(values: number[], n: number, endIdx: number): number | null {
  if (endIdx + 1 < n) return null;
  let s = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) s += values[i];
  return s / n;
}

let _cache: { at: number; snap: BreadthSnapshot } | null = null;

export function getBreadthSnapshot(force = false): BreadthSnapshot {
  const now = Date.now();
  if (!force && _cache && now - _cache.at < 10 * 60_000) return _cache.snap;

  const empty: BreadthSnapshot = {
    asOf: now, sampleSize: 0, pctAbove20dma: null, pctAbove50dma: null,
    advancersPct: null, rspSpyZ: null, spyNear20dHigh: null, divergence: false,
    read: "insufficient data", history: [],
    note: "sampled breadth (36 large caps) — not full NYSE breadth",
  };

  try {
    const placeholders = BREADTH_STOCKS.map(() => "?").join(",");
    const rows = sqlite
      .prepare(`SELECT symbol, date, close FROM daily_bars
                WHERE symbol IN (${placeholders}) ORDER BY symbol, date ASC`)
      .all(...BREADTH_STOCKS) as BarRow[];
    const spyRows = sqlite
      .prepare(`SELECT symbol, date, close FROM daily_bars WHERE symbol IN ('SPY','RSP') ORDER BY symbol, date ASC`)
      .all() as BarRow[];

    const bySym = new Map<string, BarRow[]>();
    for (const r of rows) {
      const a = bySym.get(r.symbol) ?? [];
      a.push(r); bySym.set(r.symbol, a);
    }
    const spy = spyRows.filter((r) => r.symbol === "SPY");
    const rsp = spyRows.filter((r) => r.symbol === "RSP");
    if (spy.length < 70) { _cache = { at: now, snap: empty }; return empty; }

    // Align on SPY's trading dates (canonical calendar).
    const dates = spy.map((r) => r.date);
    const dateIdx = new Map(dates.map((d, i) => [d, i]));

    // Per-symbol close series aligned to SPY dates (forward-fill not needed —
    // missing dates just drop that symbol from that day's sample).
    const closeMatrix = new Map<string, Map<string, number>>();
    for (const [sym, list] of bySym) {
      closeMatrix.set(sym, new Map(list.map((r) => [r.date, r.close])));
    }

    // Build 60-session participation history.
    const history: Array<{ date: string; pctAbove20: number }> = [];
    const start = Math.max(50, dates.length - 60);
    for (let di = start; di < dates.length; di++) {
      let above = 0, total = 0;
      for (const sym of BREADTH_STOCKS) {
        const cm = closeMatrix.get(sym);
        if (!cm) continue;
        // collect series up to this date
        const series: number[] = [];
        for (let k = 0; k <= di; k++) {
          const c = cm.get(dates[k]);
          if (c != null) series.push(c);
        }
        if (series.length < 21) continue;
        const last = series[series.length - 1];
        const m20 = sma(series, 20, series.length - 1);
        if (m20 == null) continue;
        total++;
        if (last > m20) above++;
      }
      if (total >= 20) history.push({ date: dates[di], pctAbove20: Number(((above / total) * 100).toFixed(1)) });
    }

    // Today's stats (last aligned date).
    let above20 = 0, above50 = 0, adv = 0, total = 0;
    for (const sym of BREADTH_STOCKS) {
      const cm = closeMatrix.get(sym);
      if (!cm) continue;
      const series: number[] = [];
      for (const d of dates) { const c = cm.get(d); if (c != null) series.push(c); }
      if (series.length < 51) continue;
      const i = series.length - 1;
      const last = series[i], prev = series[i - 1];
      const m20 = sma(series, 20, i), m50 = sma(series, 50, i);
      if (m20 == null || m50 == null) continue;
      total++;
      if (last > m20) above20++;
      if (last > m50) above50++;
      if (last > prev) adv++;
    }
    if (total < 20) { _cache = { at: now, snap: empty }; return empty; }

    const pct20 = (above20 / total) * 100;
    const pct50 = (above50 / total) * 100;
    const advPct = (adv / total) * 100;

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

    // SPY near 20d high?
    const spyCloses = spy.map((r) => r.close);
    const last20High = Math.max(...spyCloses.slice(-20));
    const spyLast = spyCloses[spyCloses.length - 1];
    const nearHigh = spyLast >= last20High * 0.99;

    const divergence = nearHigh && pct20 < 55;

    const read = divergence
      ? "thin tape: index near highs but under 55% of the sample above its 20dma — generals without soldiers. rallies on thin participation are fade candidates."
      : pct20 >= 70
        ? "broad participation — moves have soldiers behind them."
        : pct20 >= 50
          ? "mixed participation — no breadth edge either way."
          : nearHigh
            ? "index holding up but participation weak — watch for catch-down."
            : "weak participation confirming index softness.";

    const snap: BreadthSnapshot = {
      asOf: now,
      sampleSize: total,
      pctAbove20dma: Number(pct20.toFixed(1)),
      pctAbove50dma: Number(pct50.toFixed(1)),
      advancersPct: Number(advPct.toFixed(1)),
      rspSpyZ,
      spyNear20dHigh: nearHigh,
      divergence,
      read,
      history,
      note: `sampled breadth — ${total} large caps from the Schwab daily cache, not full NYSE breadth. RSP/SPY z ${rspSpyZ == null ? "unavailable until RSP history caches" : "from 20d ratio vs 60d baseline"}.`,
    };
    _cache = { at: now, snap };
    return snap;
  } catch (e: any) {
    console.warn("[breadth] snapshot failed:", e?.message ?? e);
    return empty;
  }
}
