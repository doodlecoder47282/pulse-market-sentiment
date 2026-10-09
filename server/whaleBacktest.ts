// server/whaleBacktest.ts
//
// Whale alert backtester. Replays past whale_alerts as long-option trades
// (review item 4.4: theta and spread are now in the P&L):
//   - entry: BUY AT THE ASK logged at detection (whale_alert_quotes). Alerts
//     with no logged quote (older than this build) are skipped as
//     "no_entry_quote"; there is no leverage proxy any more.
//   - exit, held to expiry:
//       1. the bid the follow-through tracker logged at or shortly before the
//          16:00 ET expiry close, when one exists ("ok_logged_mark");
//       2. else the expiry value from the underlying's daily close on the
//          expiry date: intrinsic for PM cash-settled index options (SPXW,
//          XSP), intrinsic minus half the entry spread for physically settled
//          options (sold at the bid in the last minutes), 0 if out of the money
//          ("ok_modeled_expiry"). All time value decays by expiry, so this is
//          the exact theta over the hold (Hull ch. 10 terminal payoff).
//       AM-settled index roots (SPX monthlies, settled on the opening print)
//       are skipped: the daily close is not their settlement value.
//   - dollars: whole contracts that fit the per-trade notional
//     (floor(notional / (ask x 100 + fee))), fees per contract per side
//     (default $0.65); pnlPerContract and dollarPnl are after fees.
//   - pctReturn = (exit - ask) / ask, before fees (kept per trade for reference).
//   - netPctReturn = pnlPerContract / (ask x 100 + fee): every total (winners,
//     win rate, mean/median return, by-symbol/type/exit-source) is NET of fees,
//     the same basis as the $ P&L (whaleScoreboard.netGroupStats).
//   - A DB failure returns dataState "error" with its note, never a summary
//     that looks like "no trades".
// 0DTE alerts use the same hold-to-close rule (the detection day is the expiry).

import { db } from "./storage";
import { whaleAlerts } from "@shared/schema";
import { and, gte, lte, eq } from "drizzle-orm";
import { getPriceHistory } from "./schwab";
import { loadWhaleEntryQuote, loadWhaleExitQuote } from "./whalePersistence";
import { acceptExitQuote, etCloseMs, evaluateWhaleTrade } from "./validationMath";
import { netGroupStats, netReturnOnCost } from "./whaleScoreboard";
import { feeForProduct } from "./feeConfig";

const EXIT_QUOTE_MAX_AGE_MS = 20 * 60_000;

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
  /** Commission + exchange fees, $ per contract per side (default 0.65) */
  feePerContract?: number;
}

export interface BacktestTrade {
  occ: string;
  symbol: string;
  type: "CALL" | "PUT";
  strike: number;
  dte: number;
  premium: number;
  detectedAt: number;
  entryPrice: number; // underlying close on the detection day
  exitPrice: number | null; // underlying close on the expiry day
  exitAt: number | null;
  underlyingMovePct: number | null;
  delta: number;
  pctReturn: number | null;  // option return, ask in / exit out, BEFORE fees (reference only)
  netPctReturn?: number | null; // pnlPerContract / (ask x 100 + fee): the basis of every total
  dollarPnl: number | null;  // $ for `contracts` whole contracts, after fees
  reason: "ok" | "no_history" | "no_exit_bar" | "no_delta" | "filtered" | "no_entry_quote" | "am_settled" | "below_one_contract" | "no_fee_configured";
  // Added: option prices are $ per share; one contract = 100x
  optionEntryAsk?: number | null;
  optionExitPrice?: number | null;
  exitSource?: "logged_bid" | "expiry_intrinsic_cash" | "expiry_intrinsic_less_half_spread" | null;
  contracts?: number;
  pnlPerContract?: number | null;   // $ per contract after round-trip fees
  feesDollars?: number;
}

export interface BacktestSummary {
  /** "error" when the alert history could not be read: totals are then not a result. */
  dataState: "ok" | "error";
  note?: string;
  /** All totals are net of fees. */
  returnBasis?: "net_of_fees";
  asOf: number;
  windowFrom: number;
  windowTo: number;
  filters: { symbol?: string; type?: string; maxDte: number; notional: number; feePerContract?: number | "per_root" };
  /**
   * The same totals split by how the exit was priced. Only "logged_bid" uses
   * the definition the outcome grader uses (logged ask in, logged bid out);
   * "modeled_expiry" prices the exit from the expiry-day close.
   */
  byExitSource?: Array<{ exitSource: "logged_bid" | "modeled_expiry"; n: number; winRate: number | null; avgPctReturn: number | null; totalDollarPnl: number }>;
  /** Plain-language cost model, shown with the numbers. */
  costModel?: string;
  totals: {
    alertsConsidered: number;
    tradesExecuted: number;
    skipped: number;
    winners: number;
    losers: number;
    winRate: number | null; // 0..1, win = P&L after fees > 0; null with no trades
    avgPctReturn: number | null; // mean NET return across executed trades
    medianPctReturn: number | null; // median NET return
    totalDollarPnl: number;
    bestTrade: BacktestTrade | null;
    worstTrade: BacktestTrade | null;
  };
  bySymbol: Array<{
    symbol: string;
    n: number;
    winRate: number | null;
    avgPctReturn: number | null;
    totalDollarPnl: number;
  }>;
  byType: Array<{
    type: "CALL" | "PUT";
    n: number;
    winRate: number | null;
    avgPctReturn: number | null;
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

interface Candle {
  datetime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// Cache with a TTL. It used to never expire, so after the first call the process served
// the same candles forever and every alert after the fill reported "no_exit_bar".
const _historyCache = new Map<string, { candles: Candle[]; at: number }>();
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000; // 6 h

async function fetchDailyHistory(symbol: string): Promise<Candle[]> {
  const cached = _historyCache.get(symbol);
  if (cached && Date.now() - cached.at < HISTORY_TTL_MS) return cached.candles;
  try {
    const r = await getPriceHistory(symbol, "year", 1, "daily", 1);
    const candles = ((r as any)?.candles ?? []) as Candle[];
    if (candles.length > 0) _historyCache.set(symbol, { candles, at: Date.now() });
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
  // expiration like "2026-05-04" or ISO: 16:00 ET that day (DST-correct).
  return etCloseMs(String(expiration).slice(0, 10));
}

// ─── Core ──────────────────────────────────────────────────────────────

export async function runBacktest(params: BacktestParams): Promise<BacktestSummary> {
  const now = Date.now();
  const windowFrom = toEpochMs(params.from, now - 14 * 24 * 60 * 60 * 1000);
  const windowTo = toEpochMs(params.to, now);
  const notional = params.notional ?? 1000;
  const maxDte = params.maxDte ?? 7;
  // SF-2: an explicit fee applies to every trade; otherwise the fee rule per
  // root (feeConfig): $0.65 equity/ETF, the configured all-in fee for index
  // roots, and index roots without one are skipped (no_fee_configured).
  const explicitFee = params.feePerContract != null && Number.isFinite(params.feePerContract) ? Math.max(0, params.feePerContract) : null;

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
    // Daily history only feeds the modeled expiry exit; a logged exit bid works without it.
    const candles = await fetchDailyHistory(symbol);
    for (const r of alerts) {
      const dte = Number(r.dte);
      if (dte > maxDte) {
        trades.push(makeTradeStub(r, "filtered"));
        skipped++;
        continue;
      }
      const delta = Number(r.delta ?? 0);
      const detectedAt = Number(r.detectedAt);
      // Entry = the detection day's daily bar (last bar whose start is <= detectedAt);
      // Schwab daily candle `datetime` is the start of the day.
      let { bar: entryBar } = closeOnOrBefore(candles, detectedAt);
      if (!entryBar) entryBar = closeOnOrAfter(candles, detectedAt).bar;
      const expMs = expirationToMs(r.expiration);
      const { bar: expBar } = closeOnOrBefore(candles, expMs);
      const tNorm = String(r.type).toUpperCase();
      const isCall = tNorm === "CALL" || tNorm === "C";
      const feePerContract = explicitFee ?? feeForProduct(String(r.occ || r.symbol)).fee;
      if (feePerContract == null) {
        trades.push(makeTradeStub(r, "no_fee_configured"));
        skipped++;
        continue;
      }
      const quote = loadWhaleEntryQuote(String(r.occ), detectedAt);
      const exitQ = Date.now() >= expMs ? loadWhaleExitQuote(String(r.occ)) : null;
      const acc = exitQ ? acceptExitQuote(exitQ, expMs, EXIT_QUOTE_MAX_AGE_MS) : null;
      // The expiry-day bar must be a different (later or same-day-for-0DTE) bar that has closed.
      const expiryBarUsable = expBar != null && Date.now() >= expMs && etDateOfBar(expBar) === String(r.expiration).slice(0, 10);
      const ev = evaluateWhaleTrade({
        isCall,
        strike: Number(r.strike),
        occ: String(r.occ),
        entryBid: quote?.bid ?? null,
        entryAsk: quote?.ask ?? null,
        loggedExitBid: acc && acc.ok ? acc.bid : null,
        underlyingCloseAtExpiry: expiryBarUsable ? expBar!.close : null,
        notional,
        feePerContract,
      });
      const common = {
        ...stubFields(r),
        entryPrice: entryBar?.close ?? 0,
        exitPrice: expiryBarUsable ? expBar!.close : null,
        exitAt: expiryBarUsable ? expBar!.datetime : null,
        underlyingMovePct: entryBar && expiryBarUsable ? (expBar!.close - entryBar.close) / entryBar.close : null,
        delta,
        optionEntryAsk: ev.entryAsk,
        optionExitPrice: ev.exitPrice,
        exitSource: ev.exitSource,
        contracts: ev.contracts,
        pnlPerContract: ev.pnlPerContract,
        feesDollars: ev.feesDollars,
      };
      const netPctReturn = netReturnOnCost(ev.pnlPerContract, ev.entryAsk, feePerContract);
      if ((ev.reason === "ok_logged_mark" || ev.reason === "ok_modeled_expiry") && ev.contracts === 0) {
        // One contract costs more than the per-trade notional: not a trade at
        // this notional. The per-contract result is kept for reference only.
        trades.push({ ...common, pctReturn: ev.pctReturn, netPctReturn, dollarPnl: null, reason: "below_one_contract" });
        skipped++;
        continue;
      }
      if (ev.reason === "ok_logged_mark" || ev.reason === "ok_modeled_expiry") {
        trades.push({ ...common, pctReturn: ev.pctReturn, netPctReturn, dollarPnl: ev.dollarPnl, reason: "ok" });
        continue;
      }
      const reason: BacktestTrade["reason"] =
        ev.reason === "no_entry_quote" ? "no_entry_quote"
        : ev.reason === "am_settled_no_settlement_value" ? "am_settled"
        : !entryBar ? "no_history"
        : "no_exit_bar"; // expiry not reached yet, or no expiry-day bar
      trades.push({ ...common, pctReturn: null, dollarPnl: null, reason });
      skipped++;
    }
  }

  // ─── Aggregate (all net of fees) ───
  const executed = trades.filter((t) => t.reason === "ok");
  const all = netGroupStats(executed.map((t) => ({ netPctReturn: t.netPctReturn ?? null, pnlPerContract: t.pnlPerContract ?? null, dollarPnl: t.dollarPnl })));
  const netOf = (t: BacktestTrade) => t.netPctReturn ?? -Infinity;
  const best = executed.reduce<BacktestTrade | null>((b, t) => (b == null || netOf(t) > netOf(b) ? t : b), null);
  const worst = executed.reduce<BacktestTrade | null>((b, t) => (b == null || netOf(t) < netOf(b) ? t : b), null);
  const groupStats = (ts: BacktestTrade[]) => {
    const g = netGroupStats(ts.map((t) => ({ netPctReturn: t.netPctReturn ?? null, pnlPerContract: t.pnlPerContract ?? null, dollarPnl: t.dollarPnl })));
    return { n: g.n, winRate: g.winRate, avgPctReturn: g.avgPctReturn, totalDollarPnl: g.totalDollarPnl };
  };

  // bySymbol breakdown
  const symGroups = new Map<string, BacktestTrade[]>();
  for (const t of executed) {
    if (!symGroups.has(t.symbol)) symGroups.set(t.symbol, []);
    symGroups.get(t.symbol)!.push(t);
  }
  const bySymbolStats = Array.from(symGroups.entries())
    .map(([symbol, ts]) => ({ symbol, ...groupStats(ts) }))
    .sort((a, b) => b.totalDollarPnl - a.totalDollarPnl);

  // byType
  const byType: BacktestSummary["byType"] = [];
  for (const k of ["CALL", "PUT"] as const) {
    const ts = executed.filter((t) => t.type === k);
    if (ts.length) byType.push({ type: k, ...groupStats(ts) });
  }

  return {
    dataState: "ok",
    returnBasis: "net_of_fees",
    asOf: now,
    windowFrom,
    windowTo,
    filters: { symbol: params.symbol, type: params.type, maxDte, notional, feePerContract: explicitFee ?? "per_root" },
    costModel: COST_MODEL,
    byExitSource: (["logged_bid", "modeled_expiry"] as const).map((src) => ({
      exitSource: src,
      ...groupStats(executed.filter((t) => (src === "logged_bid" ? t.exitSource === "logged_bid" : t.exitSource !== "logged_bid"))),
    })),
    totals: {
      alertsConsidered: rows.length,
      tradesExecuted: executed.length,
      skipped,
      winners: all.winners,
      losers: all.losers,
      winRate: all.winRate,
      avgPctReturn: all.avgPctReturn,
      medianPctReturn: all.medianPctReturn,
      totalDollarPnl: all.totalDollarPnl,
      bestTrade: best,
      worstTrade: worst,
    },
    bySymbol: bySymbolStats,
    byType,
    trades,
  };
}

const COST_MODEL =
  "long option held to expiry: bought at the ask logged at detection; sold at the logged bid at the expiry close when available, " +
  "else intrinsic on the expiry-day close (cash-settled index) or intrinsic minus half the entry spread (physical); full time decay; " +
  "fees per contract per side; whole contracts within the per-trade notional. Alerts without a logged entry quote are not traded. " +
  "Win rate and returns are NET of fees (win = P&L after fees > 0; return = net P&L / (ask x 100 + fee)), the same basis as the dollar P&L. " +
  "Alerts where one contract costs more than the notional are reason below_one_contract and are excluded from every total. " +
  "Totals mix logged-bid exits (the outcome grader's definition) with modeled expiry exits; byExitSource reports them separately. " +
  "Fees: feePerContract when given; else $0.65 per contract per side (Schwab equity/ETF commission) and, for index roots " +
  "(SPX, SPXW, XSP, NDX, RUT, VIX), the configured all-in INDEX_OPTION_FEE_PER_CONTRACT; index alerts without one are skipped as no_fee_configured.";

/** ET calendar date of a daily candle (its start time). */
function etDateOfBar(c: Candle): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(c.datetime + 12 * 3600_000)); // midday of the bar's session: robust to the 00:00/05:00 UTC start convention
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
  // A failed read is an error state with its reason, not an empty result.
  return {
    dataState: "error",
    note,
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
