// Cross-asset confirmation matrix.
// Pull recent daily bars for SPY + macro proxies (already cached via stockBarsCache),
// compute % changes 1d/1w/1m + rolling 20d correlations vs SPY, classify regime.

import { sqlite } from "./storage";
import { settledThrough } from "./dailyBarsSettled";

type Sym = "SPY" | "TLT" | "HYG" | "LQD" | "UUP" | "GLD" | "TIP";

const TICKERS: Sym[] = ["SPY", "TLT", "HYG", "LQD", "UUP", "GLD", "TIP"];

interface DailyBar { date: string; close: number; }

function loadStoredBars(symbol: string, n: number): DailyBar[] {
  const rows = sqlite.prepare(
    `SELECT date, close FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT ?`
  ).all(symbol, n) as DailyBar[];
  return rows.reverse();
}

function pctChange(bars: DailyBar[], offset: number): number | null {
  if (bars.length <= offset) return null;
  const a = bars[bars.length - 1 - offset]?.close;
  const b = bars[bars.length - 1]?.close;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return ((b - a) / a) * 100;
}

// Returns keyed by bar date so correlations compare the SAME days.
// (Unkeyed arrays silently misalign when one symbol is missing a session,
// which biases the correlation toward zero.)
function logReturnsByDate(bars: DailyBar[]): Map<string, number> {
  const r = new Map<string, number>();
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].close, b = bars[i].close;
    if (a > 0 && b > 0) r.set(bars[i].date, Math.log(b / a));
  }
  return r;
}

// Date-aligned Pearson over the last `window` shared dates.
function alignedPearson(
  a: Map<string, number>,
  b: Map<string, number>,
  window: number,
): number | null {
  const shared = [...a.keys()].filter((d) => b.has(d)).sort().slice(-window);
  if (shared.length < 5) return null;
  return pearson(shared.map((d) => a.get(d)!), shared.map((d) => b.get(d)!));
}

function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const ax = a.slice(-n), bx = b.slice(-n);
  const ma = ax.reduce((x, y) => x + y, 0) / n;
  const mb = bx.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const da_i = ax[i] - ma, db_i = bx[i] - mb;
    num += da_i * db_i;
    da += da_i * da_i;
    db += db_i * db_i;
  }
  const denom = Math.sqrt(da * db);
  return denom > 0 ? num / denom : null;
}

export interface CrossAssetTickerRow {
  symbol: string;
  /** New York date of the newest stored bar: every figure in the row is as of that close. */
  barDate: string | null;
  /** The newest bar is older than the last completed session. */
  stale: boolean;
  last: number | null;
  d1Pct: number | null;
  w1Pct: number | null;
  m1Pct: number | null;
  corr20d: number | null;
  corr60dRolling: number | null;
  corrRegime: "tight" | "loose" | "broken" | "n/a";
}

export interface CrossAssetMatrix {
  asOf: number;
  /** The last completed session: the date every row's bars should reach. */
  expectedBarDate: string;
  /** Symbols whose bars stop before it. */
  staleSymbols: string[];
  rows: CrossAssetTickerRow[];
  regimeVerdict: {
    label: string;
    confidence: "high" | "medium" | "low";
    notes: string[];
    risk: "on" | "off" | "mixed";
  };
}

const CORR_TIGHT = 0.5;
const CORR_LOOSE = 0.2;

export function buildCrossAssetMatrix(nowMs: number = Date.now()): CrossAssetMatrix {
  const expectedBarDate = settledThrough(nowMs);
  // Completed sessions only: a bar for the session still open is a mid-session price, not a close.
  const loadBars = (symbol: string, n: number) => loadStoredBars(symbol, n + 1).filter((b) => b.date <= expectedBarDate).slice(-n);
  const spyBars = loadBars("SPY", 90);
  const spyRets = logReturnsByDate(spyBars);
  const rows: CrossAssetTickerRow[] = [];

  for (const sym of TICKERS) {
    const bars = loadBars(sym, 90);
    const last = bars[bars.length - 1]?.close ?? null;
    const barDate = bars[bars.length - 1]?.date ?? null;
    const d1 = pctChange(bars, 1);
    const w1 = pctChange(bars, 5);
    const m1 = pctChange(bars, 21);
    let corr20: number | null = null;
    let corr60: number | null = null;
    let regime: CrossAssetTickerRow["corrRegime"] = "n/a";
    if (sym !== "SPY") {
      const rets = logReturnsByDate(bars);
      corr20 = alignedPearson(rets, spyRets, 20);
      corr60 = alignedPearson(rets, spyRets, 60);
      if (corr20 != null && corr60 != null) {
        const drift = Math.abs(corr20 - corr60);
        if (drift > 0.4) regime = "broken";
        else if (Math.abs(corr20) >= CORR_TIGHT) regime = "tight";
        else if (Math.abs(corr20) >= CORR_LOOSE) regime = "loose";
        else regime = "broken";
      }
    }
    rows.push({
      symbol: sym, barDate, stale: barDate != null && barDate < expectedBarDate, last,
      d1Pct: d1, w1Pct: w1, m1Pct: m1,
      corr20d: corr20, corr60dRolling: corr60,
      corrRegime: regime,
    });
  }

  // ----- Regime verdict from cross-asset state -----
  const map = Object.fromEntries(rows.map(r => [r.symbol, r]));
  const missingLegs = ["SPY", "TLT", "HYG", "UUP"].filter(
    (s) => map[s]?.d1Pct == null,
  );
  const spyD = map.SPY?.d1Pct ?? 0;
  const tltD = map.TLT?.d1Pct ?? 0;
  const hygD = map.HYG?.d1Pct ?? 0;
  const dxyD = map.UUP?.d1Pct ?? 0;
  const gldD = map.GLD?.d1Pct ?? 0;
  const tipD = map.TIP?.d1Pct ?? 0;

  const notes: string[] = [];
  let risk: "on" | "off" | "mixed" = "mixed";
  let label = "mixed regime";
  let confidence: "high" | "medium" | "low" = "low";

  // Clean risk-on: SPY+, HYG+, TLT-, DXY flat/-
  if (spyD > 0.1 && hygD > 0.0 && tltD < 0.05 && dxyD < 0.2) {
    risk = "on";
    label = "clean risk-on";
    confidence = "high";
    notes.push("SPY + HYG up, TLT down, DXY soft — classic risk-on confluence");
  } else if (spyD > 0 && hygD <= 0 && tltD > 0) {
    risk = "mixed";
    label = "suspicious rally";
    confidence = "medium";
    notes.push("SPY up but credit (HYG) flat/down and rates bid (TLT up) — equity divergence flag");
  } else if (spyD < -0.2 && hygD < 0 && tltD > 0) {
    risk = "off";
    label = "risk-off";
    confidence = "high";
    notes.push("equities + credit down, rates bid — full risk-off rotation");
  } else if (spyD < 0 && tltD < 0 && dxyD > 0) {
    risk = "off";
    label = "stagflation-flavor";
    confidence = "medium";
    notes.push("stocks and bonds both selling, dollar bid — duration + risk de-grossing");
  } else {
    notes.push("no clean cross-asset confluence — defer to fundamentals/regime tab");
  }

  // A missing leg means "no data", not "0.0% move". The rules above read it as 0, which can satisfy a
  // condition ("HYG flat/down") on its own, so with any of the four legs missing no pattern is named.
  if (missingLegs.length > 0) {
    risk = "mixed";
    label = "not read: missing data";
    confidence = "low";
    notes.length = 0;
    notes.push(`no day change for ${missingLegs.join(", ")}: the cross-asset pattern needs SPY, TLT, HYG and UUP, so none is named`);
  }

  // Bars that stop before the last completed session describe an older day. A pattern named from them
  // would be read as today's, and legs on different dates are not one day's pattern at all.
  const staleSymbols = rows.filter((r) => r.stale).map((r) => r.symbol);
  const staleLegs = ["SPY", "TLT", "HYG", "UUP"].filter((s) => map[s]?.stale);
  if (missingLegs.length === 0 && staleLegs.length > 0) {
    risk = "mixed";
    label = "not read: bars not current";
    confidence = "low";
    notes.length = 0;
    notes.push(`bars for ${staleLegs.map((s) => `${s} stop at ${map[s].barDate}`).join(", ")}; the last completed session is ${expectedBarDate}, so no pattern is named`);
  }
  const patternRead = missingLegs.length === 0 && staleLegs.length === 0;

  if (patternRead && !map.GLD?.stale && !map.TIP?.stale && gldD > 0.5 && tipD > 0.2) notes.push("gold + TIPS bid → inflation re-pricing input");
  if (patternRead && Math.abs(dxyD) > 0.5) notes.push(`dollar moved ${dxyD > 0 ? "+" : ""}${dxyD.toFixed(2)}% — global liquidity input`);

  return {
    asOf: nowMs,
    expectedBarDate,
    staleSymbols,
    rows,
    regimeVerdict: { label, confidence, notes, risk },
  };
}
