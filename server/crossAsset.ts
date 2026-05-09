// Cross-asset confirmation matrix.
// Pull recent daily bars for SPY + macro proxies (already cached via stockBarsCache),
// compute % changes 1d/1w/1m + rolling 20d correlations vs SPY, classify regime.

import { sqlite } from "./storage";

type Sym = "SPY" | "TLT" | "HYG" | "LQD" | "UUP" | "GLD" | "TIP" | "VIX";

const TICKERS: Sym[] = ["SPY", "TLT", "HYG", "LQD", "UUP", "GLD", "TIP"];

interface DailyBar { date: string; close: number; }

function loadBars(symbol: string, n: number): DailyBar[] {
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

function logReturns(bars: DailyBar[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].close, b = bars[i].close;
    if (a > 0 && b > 0) r.push(Math.log(b / a));
  }
  return r;
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

export function buildCrossAssetMatrix(): CrossAssetMatrix {
  const spyBars = loadBars("SPY", 90);
  const spyRets = logReturns(spyBars);
  const rows: CrossAssetTickerRow[] = [];

  for (const sym of TICKERS) {
    const bars = loadBars(sym, 90);
    const last = bars[bars.length - 1]?.close ?? null;
    const d1 = pctChange(bars, 1);
    const w1 = pctChange(bars, 5);
    const m1 = pctChange(bars, 21);
    let corr20: number | null = null;
    let corr60: number | null = null;
    let regime: CrossAssetTickerRow["corrRegime"] = "n/a";
    if (sym !== "SPY") {
      const rets = logReturns(bars);
      corr20 = pearson(rets.slice(-20), spyRets.slice(-20));
      corr60 = pearson(rets.slice(-60), spyRets.slice(-60));
      if (corr20 != null && corr60 != null) {
        const drift = Math.abs(corr20 - corr60);
        if (drift > 0.4) regime = "broken";
        else if (Math.abs(corr20) >= CORR_TIGHT) regime = "tight";
        else if (Math.abs(corr20) >= CORR_LOOSE) regime = "loose";
        else regime = "broken";
      }
    }
    rows.push({
      symbol: sym, last,
      d1Pct: d1, w1Pct: w1, m1Pct: m1,
      corr20d: corr20, corr60dRolling: corr60,
      corrRegime: regime,
    });
  }

  // ----- Regime verdict from cross-asset state -----
  const map = Object.fromEntries(rows.map(r => [r.symbol, r]));
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

  if (gldD > 0.5 && tipD > 0.2) notes.push("gold + TIPS bid → inflation re-pricing input");
  if (Math.abs(dxyD) > 0.5) notes.push(`dollar moved ${dxyD > 0 ? "+" : ""}${dxyD.toFixed(2)}% — global liquidity input`);

  return {
    asOf: Date.now(),
    rows,
    regimeVerdict: { label, confidence, notes, risk },
  };
}
