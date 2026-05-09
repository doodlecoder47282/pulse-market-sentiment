// Vectorized signal backtest harness.
// Runs declarative signals against daily_bars with realistic slippage.
// Edge metrics: Sharpe, Sortino, max drawdown, win-rate, mean-bps-per-trade, CLV-style.

import { sqlite } from "./storage";

interface DailyBar { symbol: string; date: string; close: number; }

export type SignalKind =
  | "price_above_sma"
  | "price_below_sma"
  | "rsi_below"
  | "rsi_above"
  | "bbands_breakout_up"
  | "bbands_breakout_down"
  | "ret_zscore_below"
  | "ret_zscore_above";

export interface BacktestSignalSpec {
  kind: SignalKind;
  symbol: string;
  param1?: number;        // SMA window / RSI window / lookback
  param2?: number;        // RSI threshold / z-score threshold / band stdev
  holdDays?: number;      // default 1
  side?: "long" | "short" | "both";  // default long
}

export interface BacktestTrade {
  entryDate: string;
  exitDate: string;
  side: "long" | "short";
  entry: number;
  exit: number;
  retPct: number;
  retBpsAfterCosts: number;
}

export interface BacktestResult {
  spec: BacktestSignalSpec;
  trades: BacktestTrade[];
  trades_count: number;
  win_rate: number;
  mean_ret_bps: number;
  median_ret_bps: number;
  total_ret_pct: number;
  max_dd_pct: number;
  sharpe: number;
  sortino: number;
  best_trade_bps: number;
  worst_trade_bps: number;
  notes: string;
  // realistic-frictions assumed:
  costsBps: number;
}

function loadBars(symbol: string, n = 1500): DailyBar[] {
  const rows = sqlite.prepare(
    `SELECT date, close FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT ?`
  ).all(symbol.toUpperCase(), n) as { date: string; close: number }[];
  return rows.reverse().map(r => ({ symbol: symbol.toUpperCase(), date: r.date, close: r.close }));
}

function sma(closes: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let acc = 0;
  for (let i = 0; i < closes.length; i++) {
    acc += closes[i];
    if (i >= window) acc -= closes[i - window];
    if (i >= window - 1) out[i] = acc / window;
  }
  return out;
}

function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    avgG += Math.max(0, ch); avgL += Math.max(0, -ch);
  }
  avgG /= period; avgL /= period;
  out[period] = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(0, ch), l = Math.max(0, -ch);
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
  }
  return out;
}

function rollingStats(xs: number[], window: number): { mean: (number | null)[]; std: (number | null)[] } {
  const mean: (number | null)[] = new Array(xs.length).fill(null);
  const std: (number | null)[] = new Array(xs.length).fill(null);
  for (let i = 0; i < xs.length; i++) {
    if (i < window - 1) continue;
    let m = 0;
    for (let j = i - window + 1; j <= i; j++) m += xs[j];
    m /= window;
    let v = 0;
    for (let j = i - window + 1; j <= i; j++) v += (xs[j] - m) * (xs[j] - m);
    v /= (window - 1);
    mean[i] = m;
    std[i] = Math.sqrt(v);
  }
  return { mean, std };
}

function maxDrawdown(equity: number[]): number {
  let peak = equity[0] ?? 1, mdd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd * 100;
}

function sharpe(retsPct: number[]): number {
  if (retsPct.length < 5) return 0;
  const m = retsPct.reduce((a, b) => a + b, 0) / retsPct.length;
  const v = retsPct.reduce((a, b) => a + (b - m) * (b - m), 0) / (retsPct.length - 1);
  const sd = Math.sqrt(v);
  return sd > 0 ? (m / sd) * Math.sqrt(252) : 0;
}

function sortino(retsPct: number[]): number {
  if (retsPct.length < 5) return 0;
  const m = retsPct.reduce((a, b) => a + b, 0) / retsPct.length;
  const downs = retsPct.filter(r => r < 0);
  if (!downs.length) return Infinity;
  const dv = downs.reduce((a, b) => a + b * b, 0) / downs.length;
  const dsd = Math.sqrt(dv);
  return dsd > 0 ? (m / dsd) * Math.sqrt(252) : 0;
}

const DEFAULT_COST_BPS = 3; // ~1-2 ticks one-way + commission

export function runSignal(spec: BacktestSignalSpec, costBps = DEFAULT_COST_BPS): BacktestResult {
  const bars = loadBars(spec.symbol, 1500);
  if (bars.length < 60) {
    return {
      spec, trades: [], trades_count: 0, win_rate: 0, mean_ret_bps: 0, median_ret_bps: 0,
      total_ret_pct: 0, max_dd_pct: 0, sharpe: 0, sortino: 0, best_trade_bps: 0, worst_trade_bps: 0,
      notes: "insufficient daily bars (need 60+)", costsBps: costBps,
    };
  }
  const closes = bars.map(b => b.close);
  const dates = bars.map(b => b.date);
  const hold = Math.max(1, spec.holdDays ?? 1);
  const sideDirective = spec.side ?? "long";
  const trades: BacktestTrade[] = [];

  // Build entry signal mask
  const entry: boolean[] = new Array(closes.length).fill(false);
  const sideArr: ("long" | "short")[] = new Array(closes.length).fill("long");

  if (spec.kind === "price_above_sma" || spec.kind === "price_below_sma") {
    const w = spec.param1 ?? 50;
    const m = sma(closes, w);
    for (let i = 1; i < closes.length; i++) {
      if (m[i] == null || m[i - 1] == null) continue;
      if (spec.kind === "price_above_sma") {
        if (closes[i] > (m[i] as number) && closes[i - 1] <= (m[i - 1] as number)) {
          entry[i] = true; sideArr[i] = "long";
        }
      } else {
        if (closes[i] < (m[i] as number) && closes[i - 1] >= (m[i - 1] as number)) {
          entry[i] = true; sideArr[i] = sideDirective === "short" ? "short" : "long";
        }
      }
    }
  } else if (spec.kind === "rsi_below" || spec.kind === "rsi_above") {
    const w = spec.param1 ?? 14;
    const t = spec.param2 ?? (spec.kind === "rsi_below" ? 30 : 70);
    const r = rsi(closes, w);
    for (let i = 1; i < closes.length; i++) {
      if (r[i] == null) continue;
      const rv = r[i] as number;
      if (spec.kind === "rsi_below") {
        if (rv < t && (r[i - 1] ?? t) >= t) { entry[i] = true; sideArr[i] = "long"; }
      } else {
        if (rv > t && (r[i - 1] ?? t) <= t) {
          entry[i] = true; sideArr[i] = sideDirective === "short" ? "short" : "long";
        }
      }
    }
  } else if (spec.kind === "bbands_breakout_up" || spec.kind === "bbands_breakout_down") {
    const w = spec.param1 ?? 20;
    const k = spec.param2 ?? 2;
    const { mean, std } = rollingStats(closes, w);
    for (let i = 1; i < closes.length; i++) {
      if (mean[i] == null || std[i] == null) continue;
      const upper = (mean[i] as number) + k * (std[i] as number);
      const lower = (mean[i] as number) - k * (std[i] as number);
      const upperPrev = (mean[i - 1] as number) + k * (std[i - 1] as number);
      const lowerPrev = (mean[i - 1] as number) - k * (std[i - 1] as number);
      if (spec.kind === "bbands_breakout_up") {
        if (closes[i] > upper && closes[i - 1] <= upperPrev) { entry[i] = true; sideArr[i] = "long"; }
      } else {
        if (closes[i] < lower && closes[i - 1] >= lowerPrev) {
          entry[i] = true; sideArr[i] = sideDirective === "short" ? "short" : "long";
        }
      }
    }
  } else if (spec.kind === "ret_zscore_below" || spec.kind === "ret_zscore_above") {
    const w = spec.param1 ?? 20;
    const z = spec.param2 ?? 2;
    const rets: number[] = [0];
    for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    const { mean, std } = rollingStats(rets, w);
    for (let i = 1; i < closes.length; i++) {
      if (mean[i] == null || std[i] == null) continue;
      const zs = ((rets[i] - (mean[i] as number)) / (std[i] as number));
      if (spec.kind === "ret_zscore_below") {
        if (zs < -z) { entry[i] = true; sideArr[i] = "long"; }
      } else {
        if (zs > z) { entry[i] = true; sideArr[i] = sideDirective === "short" ? "short" : "long"; }
      }
    }
  }

  // Walk-forward exits — held for `hold` days, no overlapping trades
  let nextEligible = 0;
  for (let i = 0; i < closes.length; i++) {
    if (!entry[i]) continue;
    if (i < nextEligible) continue;
    const exitIdx = Math.min(closes.length - 1, i + hold);
    const e0 = closes[i], e1 = closes[exitIdx];
    if (!Number.isFinite(e0) || !Number.isFinite(e1)) continue;
    const dir = sideArr[i] === "short" ? -1 : 1;
    const grossBps = ((e1 - e0) / e0) * 10000 * dir;
    const netBps = grossBps - costBps * 2; // round-trip costs
    trades.push({
      entryDate: dates[i], exitDate: dates[exitIdx], side: sideArr[i],
      entry: e0, exit: e1, retPct: grossBps / 100, retBpsAfterCosts: netBps,
    });
    nextEligible = exitIdx + 1;
  }

  // Aggregate
  const rets = trades.map(t => t.retBpsAfterCosts);
  const wins = rets.filter(r => r > 0).length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sortedRets = [...rets].sort((a, b) => a - b);
  const median = sortedRets.length ? sortedRets[Math.floor(sortedRets.length / 2)] : 0;

  // Equity curve
  let eq = 1;
  const equity: number[] = [eq];
  for (const r of rets) {
    eq = eq * (1 + r / 10000);
    equity.push(eq);
  }
  const totalRetPct = (eq - 1) * 100;
  const mdd = maxDrawdown(equity);

  // Convert per-trade bps to pct for ratio annualization
  const retsPct = rets.map(b => b / 100);
  const sh = sharpe(retsPct);
  const so = sortino(retsPct);

  let notes = "";
  if (trades.length < 20) notes = "thin sample (<20 trades) — wide error bars, do not size off this alone";
  else if (mean > 5 && winRate > 55) notes = "promising — replicate on out-of-sample window before sizing";
  else if (mean < 0) notes = "negative-edge after costs — not tradeable as-is";
  else notes = "marginal — needs filter or regime-conditioner to be size-able";

  return {
    spec, trades, trades_count: trades.length, win_rate: winRate,
    mean_ret_bps: mean, median_ret_bps: median, total_ret_pct: totalRetPct,
    max_dd_pct: mdd, sharpe: sh, sortino: so,
    best_trade_bps: rets.length ? Math.max(...rets) : 0,
    worst_trade_bps: rets.length ? Math.min(...rets) : 0,
    notes, costsBps: costBps,
  };
}

export function listAvailableSymbols(): string[] {
  const rows = sqlite.prepare(
    `SELECT DISTINCT symbol FROM daily_bars ORDER BY symbol`
  ).all() as { symbol: string }[];
  return rows.map(r => r.symbol);
}
