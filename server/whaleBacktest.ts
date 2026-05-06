// server/backtest.ts
//
// Whale alert backtester. Replays past whale_alerts from SQLite against
// underlying price history to estimate hypothetical P&L assuming you'd
// entered each alert at the close of its detection bar and exited at:
//   - end of expiration day for non-0DTE
//   - 15:55 ET for 0DTE
//
// Approximation model (read-only, simple, transparent):
//   - Use the alert's recorded delta as the option's price sensitivity.
//   - Underlying move from detection-bar close to exit-bar close drives PnL.
//   - PnL multiplier: delta * underlyingMove. Calls are positive on upmove,
//     puts on downmove. Cap at -100% (premium loss).
//   - Result per alert: pctReturn, dollarPnl (vs $1k notional), regime tags.
//
// This is a sizing heuristic, not a market-making sim — no greeks decay,
// no IV shifts, no spread costs. Treat output as relative ranking signal.

import { db } from "./storage";
import { whaleAlerts } from "@shared/schema";
import { sql, and, gte, lte, eq } from "drizzle-orm";
import { getPriceHistory } from "./schwab";

// ─── Types ─────────────────────────────────────────────────────────────

export interface BacktestParams {
  /** ISO date or epoch ms — start of window (inclusive) */
  from?: string | number;
  /** ISO date or epoch ms — end of window (inclusive) */
  to?: string | number;
  /** Filter by symbol (e.g. "TSLA"). Omit for all. */
  symbol?: string;
  /** Filter by type ("CALL" | "PUT"). Omit for both. */
  type?: "CALL" | "PUT";
  /** Per-trade notional in dollars (defaults to 1000) */
  notional?: number;
  /** Skip alerts whose dte > maxDte (default 7) */
  maxDte?: number;
}

export interface BacktestTrade {
  occ: string;
  symbol: string;
  type: "CALL" | "PUT";
  strike: number;
  dte: number;
  premium: number;
  detectedAt: number;
  entryPrice: number; // underlying close at detection
  exitPrice: number | null;
  exitAt: number | null;
  underlyingMovePct: number | null;
  delta: number;
  pctReturn: number | null;
  dollarPnl: number | null;
  reason: "ok" | "no_history" | "no_exit_bar" | "no_delta" | "filtered";
}

export interface BacktestSummary {
  asOf: number;
  windowFrom: number;
  windowTo: number;
  filters: { symbol?: string; type?: string; maxDte: number; notional: number };
  totals: {
    alertsConsidered: number;
    tradesExecuted: number;
    skipped: number;
    winners: number;
    losers: number;
    winRate: number; // 0..1
    avgPctReturn: number; // mean across executed trades
    medianPctReturn: number;
    totalDollarPnl: number;
    bestTrade: BacktestTrade | null;
    worstTrade: BacktestTrade | null;
  };
  bySymbol: Array<{
    symbol: string;
    n: number;
    winRate: number;
    avgPctReturn: number;
    totalDollarPnl: number;
  }>;
  byType: Array<{
    type: "CALL" | "PUT";
    n: number;
    winRate: number;
    avgPctReturn: number;
    totalDollarPnl: number;
  }>;
  trades: BacktestTrade[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function toEpochMs(v: string | number | undefined, fallback: number): number {
  if (v == null) return fallback;
  if (typeof v === "number") return v;
  const n = Date.parse(v);
  return isFinite(n) ? n : fallback;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface Candle {
  datetime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const _historyCache = new Map<string, Candle[]>();

async function fetchDailyHistory(symbol: string): Promise<Candle[]> {
  if (_historyCache.has(symbol)) return _historyCache.get(symbol)!;
  try {
    const r = await getPriceHistory(symbol, "year", 1, "daily", 1);
    const candles = ((r as any)?.candles ?? []) as Candle[];
    _historyCache.set(symbol, candles);
    return candles;
  } catch {
    return [];
  }
}

/**
 * Find the close on the given detection day (the bar whose calendar date in
 * UTC matches the detection epoch ms within ±24h). Uses simple nearest-day match.
 */
function closeOnOrAfter(
  candles: Candle[],
  ms: number,
): { bar: Candle | null; idx: number } {
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].datetime >= ms) return { bar: candles[i], idx: i };
  }
  return { bar: null, idx: -1 };
}

function closeOnOrBefore(
  candles: Candle[],
  ms: number,
): { bar: Candle | null; idx: number } {
  let best: Candle | null = null;
  let bestIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].datetime <= ms) {
      best = candles[i];
      bestIdx = i;
    } else break;
  }
  return { bar: best, idx: bestIdx };
}

function expirationToMs(expiration: string): number {
  // expiration like "2026-05-04" or ISO. Treat as 16:00 ET that day.
  const d = new Date(`${expiration}T20:00:00Z`); // 16:00 ET ≈ 20:00 UTC (DST-naive)
  return d.getTime();
}

// ─── Core ──────────────────────────────────────────────────────────────

export async function runBacktest(params: BacktestParams): Promise<BacktestSummary> {
  const now = Date.now();
  const windowFrom = toEpochMs(params.from, now - 14 * 24 * 60 * 60 * 1000);
  const windowTo = toEpochMs(params.to, now);
  const notional = params.notional ?? 1000;
  const maxDte = params.maxDte ?? 7;

  // Pull alerts from db
  let rows: any[] = [];
  try {
    const conds = [
      gte(whaleAlerts.detectedAt, windowFrom),
      lte(whaleAlerts.detectedAt, windowTo),
    ];
    if (params.symbol) conds.push(eq(whaleAlerts.symbol, params.symbol.toUpperCase()));
    rows = db
      .select()
      .from(whaleAlerts)
      .where(and(...conds))
      .orderBy(whaleAlerts.detectedAt)
      .all();
    if (params.type) {
      const t = params.type.toUpperCase();
      const stored = t === "CALL" ? ["CALL", "C"] : t === "PUT" ? ["PUT", "P"] : [t];
      rows = rows.filter((r: any) => stored.includes(String(r.type).toUpperCase()));
    }
  } catch (e: any) {
    return emptySummary(windowFrom, windowTo, params, notional, maxDte, "db_error: " + (e?.message ?? String(e)));
  }

  const trades: BacktestTrade[] = [];
  let skipped = 0;

  // Group by symbol so we only fetch each underlying once per run
  const bySymbol = new Map<string, any[]>();
  for (const r of rows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol)!.push(r);
  }

  for (const [symbol, alerts] of bySymbol.entries()) {
    const candles = await fetchDailyHistory(symbol);
    if (!candles.length) {
      for (const r of alerts) {
        trades.push(makeTradeStub(r, "no_history"));
        skipped++;
      }
      continue;
    }
    for (const r of alerts) {
      const dte = Number(r.dte);
      if (dte > maxDte) {
        trades.push(makeTradeStub(r, "filtered"));
        skipped++;
        continue;
      }
      const delta = Number(r.delta ?? 0);
      if (!isFinite(delta) || delta === 0) {
        trades.push(makeTradeStub(r, "no_delta"));
        skipped++;
        continue;
      }
      const detectedAt = Number(r.detectedAt);
      // Try at-or-after first; if none, fall back to most recent prior bar (alert detected after market close)
      let { bar: entryBar, idx: entryIdx } = closeOnOrAfter(candles, detectedAt);
      if (!entryBar) {
        const prior = closeOnOrBefore(candles, detectedAt);
        entryBar = prior.bar;
        entryIdx = prior.idx;
      }
      if (!entryBar) {
        trades.push(makeTradeStub(r, "no_history"));
        skipped++;
        continue;
      }
      // Exit bar: bar at expiration (inclusive). For 0DTE same day → use same bar's close as best available proxy.
      const expMs = expirationToMs(r.expiration);
      let exitBar: Candle | null = null;
      if (dte === 0) {
        // 0DTE: use entry bar's close as exit — daily granularity prevents intraday sim.
        // Mark as no_exit_bar to be transparent.
        trades.push({
          ...stubFields(r),
          entryPrice: entryBar.close,
          exitPrice: entryBar.close,
          exitAt: entryBar.datetime,
          underlyingMovePct: 0,
          delta,
          pctReturn: 0,
          dollarPnl: 0,
          reason: "no_exit_bar",
        });
        skipped++;
        continue;
      }
      const { bar: expBar, idx: expIdx } = closeOnOrBefore(candles, expMs);
      if (!expBar || expIdx <= entryIdx) {
        // Expiration not yet reached (still alive) — mark as open and skip P&L calc
        trades.push(makeTradeStub(r, "no_exit_bar"));
        skipped++;
        continue;
      }
      exitBar = expBar;
      const movePct = (exitBar.close - entryBar.close) / entryBar.close;
      // Schema stores raw type which is sometimes 'C'/'P' or 'CALL'/'PUT'. Normalize.
      const tNorm = String(r.type).toUpperCase();
      const isCall = tNorm === "CALL" || tNorm === "C";
      const directionalMove = isCall ? movePct : -movePct;
      // pctReturn = leverage * directionalMove. Leverage = |delta| * spot / premiumPerContract
      // Premium per contract is unknown here; we assume average ATM 1-week call costs roughly
      // 1.5% of underlying for tech names. As a generic proxy, use leverage = |delta| / 0.05
      // bounded [4x, 25x]. Floors at -100% (max loss = premium).
      const leverage = Math.max(4, Math.min(25, Math.abs(delta) / 0.05));
      const pctReturn = Math.max(-1, leverage * directionalMove);
      const dollarPnl = pctReturn * notional;
      trades.push({
        ...stubFields(r),
        entryPrice: entryBar.close,
        exitPrice: exitBar.close,
        exitAt: exitBar.datetime,
        underlyingMovePct: movePct,
        delta,
        pctReturn,
        dollarPnl,
        reason: "ok",
      });
    }
  }

  // ─── Aggregate ───
  const executed = trades.filter((t) => t.reason === "ok");
  const winners = executed.filter((t) => (t.pctReturn ?? 0) > 0);
  const losers = executed.filter((t) => (t.pctReturn ?? 0) < 0);
  const returns = executed.map((t) => t.pctReturn ?? 0);
  const totalDollarPnl = executed.reduce((a, t) => a + (t.dollarPnl ?? 0), 0);
  const avgPct = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const medPct = median(returns);
  const best = executed.reduce<BacktestTrade | null>(
    (b, t) => (b == null || (t.pctReturn ?? 0) > (b.pctReturn ?? 0) ? t : b),
    null,
  );
  const worst = executed.reduce<BacktestTrade | null>(
    (b, t) => (b == null || (t.pctReturn ?? 0) < (b.pctReturn ?? 0) ? t : b),
    null,
  );

  // bySymbol breakdown
  const symGroups = new Map<string, BacktestTrade[]>();
  for (const t of executed) {
    if (!symGroups.has(t.symbol)) symGroups.set(t.symbol, []);
    symGroups.get(t.symbol)!.push(t);
  }
  const bySymbolStats = Array.from(symGroups.entries()).map(([symbol, ts]) => {
    const w = ts.filter((t) => (t.pctReturn ?? 0) > 0).length;
    const avg = ts.reduce((a, t) => a + (t.pctReturn ?? 0), 0) / ts.length;
    const pnl = ts.reduce((a, t) => a + (t.dollarPnl ?? 0), 0);
    return { symbol, n: ts.length, winRate: w / ts.length, avgPctReturn: avg, totalDollarPnl: pnl };
  }).sort((a, b) => b.totalDollarPnl - a.totalDollarPnl);

  // byType
  const callTs = executed.filter((t) => t.type === "CALL");
  const putTs = executed.filter((t) => t.type === "PUT");
  const byType: BacktestSummary["byType"] = [];
  for (const [k, ts] of [["CALL", callTs], ["PUT", putTs]] as const) {
    if (!ts.length) continue;
    const w = ts.filter((t) => (t.pctReturn ?? 0) > 0).length;
    const avg = ts.reduce((a, t) => a + (t.pctReturn ?? 0), 0) / ts.length;
    const pnl = ts.reduce((a, t) => a + (t.dollarPnl ?? 0), 0);
    byType.push({ type: k as "CALL" | "PUT", n: ts.length, winRate: w / ts.length, avgPctReturn: avg, totalDollarPnl: pnl });
  }

  return {
    asOf: now,
    windowFrom,
    windowTo,
    filters: { symbol: params.symbol, type: params.type, maxDte, notional },
    totals: {
      alertsConsidered: rows.length,
      tradesExecuted: executed.length,
      skipped,
      winners: winners.length,
      losers: losers.length,
      winRate: executed.length ? winners.length / executed.length : 0,
      avgPctReturn: avgPct,
      medianPctReturn: medPct,
      totalDollarPnl,
      bestTrade: best,
      worstTrade: worst,
    },
    bySymbol: bySymbolStats,
    byType,
    trades,
  };
}

// ─── Stub helpers ──────────────────────────────────────────────────────

function stubFields(r: any) {
  return {
    occ: String(r.occ ?? ""),
    symbol: String(r.symbol),
    type: (String(r.type).toUpperCase() === "P" ? "PUT" : String(r.type).toUpperCase() === "C" ? "CALL" : (r.type as any)) as "CALL" | "PUT",
    strike: Number(r.strike),
    dte: Number(r.dte),
    premium: Number(r.premium),
    detectedAt: Number(r.detectedAt),
  };
}

function makeTradeStub(r: any, reason: BacktestTrade["reason"]): BacktestTrade {
  return {
    ...stubFields(r),
    entryPrice: 0,
    exitPrice: null,
    exitAt: null,
    underlyingMovePct: null,
    delta: Number(r.delta ?? 0),
    pctReturn: null,
    dollarPnl: null,
    reason,
  };
}

function emptySummary(
  from: number,
  to: number,
  params: BacktestParams,
  notional: number,
  maxDte: number,
  note: string,
): BacktestSummary {
  return {
    asOf: Date.now(),
    windowFrom: from,
    windowTo: to,
    filters: { symbol: params.symbol, type: params.type, maxDte, notional },
    totals: {
      alertsConsidered: 0,
      tradesExecuted: 0,
      skipped: 0,
      winners: 0,
      losers: 0,
      winRate: 0,
      avgPctReturn: 0,
      medianPctReturn: 0,
      totalDollarPnl: 0,
      bestTrade: null,
      worstTrade: null,
    },
    bySymbol: [],
    byType: [],
    trades: [],
  };
}
