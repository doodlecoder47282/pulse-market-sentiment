// CLV (Closing-Line Value) Tracker
// Logs every entry, grades against EOD mid (or expiry intrinsic for options).
// CLV is the only honest metric for whether your entries have edge.

import { sqlite } from "./storage";
import { randomUUID } from "node:crypto";
import { getQuotes, getOptionChain } from "./schwab";

export type Side = "BUY" | "SELL";
export type Instrument = "EQUITY" | "OPTION";

export interface TradeLogInput {
  symbol: string;
  side: Side;
  instrument: Instrument;
  qty: number;
  entryPrice: number;
  occ?: string;
  strike?: number;
  optType?: "C" | "P";
  expiry?: string;          // ISO yyyy-mm-dd
  midAtEntry?: number;
  signalSource?: string;
  notes?: string;
}

export interface TradeRow {
  id: string;
  capturedAt: number;
  symbol: string;
  side: Side;
  instrument: Instrument;
  occ: string | null;
  strike: number | null;
  optType: string | null;
  expiry: string | null;
  qty: number;
  entryPrice: number;
  midAtEntry: number | null;
  signalSource: string | null;
  notes: string | null;
  graded: number;
  closingMid: number | null;
  closeTime: number | null;
  clvBps: number | null;
  clvDollars: number | null;
  exitPrice: number | null;
  exitTime: number | null;
  pnlDollars: number | null;
}

export function logTrade(input: TradeLogInput): TradeRow {
  const id = randomUUID();
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO trade_log (
      id, captured_at, symbol, side, instrument, occ, strike, opt_type, expiry,
      qty, entry_price, mid_at_entry, signal_source, notes, graded
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 0)
  `).run(
    id, now, input.symbol.toUpperCase(), input.side, input.instrument,
    input.occ ?? null, input.strike ?? null, input.optType ?? null, input.expiry ?? null,
    input.qty, input.entryPrice, input.midAtEntry ?? null,
    input.signalSource ?? null, input.notes ?? null
  );
  return getTrade(id)!;
}

export function getTrade(id: string): TradeRow | undefined {
  const row = sqlite.prepare(`SELECT * FROM trade_log WHERE id = ?`).get(id) as any;
  return row ? rowToTrade(row) : undefined;
}

export function listTrades(opts?: { limit?: number; symbol?: string; gradedOnly?: boolean }): TradeRow[] {
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 1000);
  let sql = `SELECT * FROM trade_log WHERE 1=1`;
  const args: any[] = [];
  if (opts?.symbol) { sql += ` AND symbol = ?`; args.push(opts.symbol.toUpperCase()); }
  if (opts?.gradedOnly) { sql += ` AND graded = 1`; }
  sql += ` ORDER BY captured_at DESC LIMIT ?`;
  args.push(limit);
  const rows = sqlite.prepare(sql).all(...args) as any[];
  return rows.map(rowToTrade);
}

export function deleteTrade(id: string): boolean {
  const r = sqlite.prepare(`DELETE FROM trade_log WHERE id = ?`).run(id);
  return r.changes > 0;
}

export function logExit(id: string, exitPrice: number): TradeRow | undefined {
  const t = getTrade(id);
  if (!t) return undefined;
  const mult = t.instrument === "OPTION" ? 100 : 1;
  const dir = t.side === "BUY" ? 1 : -1;
  const pnl = (exitPrice - t.entryPrice) * t.qty * mult * dir;
  sqlite.prepare(`UPDATE trade_log SET exit_price = ?, exit_time = ?, pnl_dollars = ? WHERE id = ?`)
    .run(exitPrice, Date.now(), pnl, id);
  return getTrade(id);
}

function rowToTrade(r: any): TradeRow {
  return {
    id: r.id,
    capturedAt: r.captured_at,
    symbol: r.symbol,
    side: r.side,
    instrument: r.instrument,
    occ: r.occ,
    strike: r.strike,
    optType: r.opt_type,
    expiry: r.expiry,
    qty: r.qty,
    entryPrice: r.entry_price,
    midAtEntry: r.mid_at_entry,
    signalSource: r.signal_source,
    notes: r.notes,
    graded: r.graded,
    closingMid: r.closing_mid,
    closeTime: r.close_time,
    clvBps: r.clv_bps,
    clvDollars: r.clv_dollars,
    exitPrice: r.exit_price,
    exitTime: r.exit_time,
    pnlDollars: r.pnl_dollars,
  };
}

// ---------- CLV math ----------
// CLV is sign-adjusted by trade direction:
//   BUY:  closingMid - entryPrice  (if you bought below close → positive CLV)
//   SELL: entryPrice - closingMid  (if you sold above close → positive CLV)
// Reported in basis points (× 10000 / entry) and absolute dollars.

function clvBps(side: Side, entry: number, closingMid: number): number {
  if (entry <= 0) return 0;
  const dir = side === "BUY" ? 1 : -1;
  return ((closingMid - entry) / entry) * 10000 * dir;
}

function clvDollars(side: Side, entry: number, closingMid: number, qty: number, instrument: Instrument): number {
  const mult = instrument === "OPTION" ? 100 : 1;
  const dir = side === "BUY" ? 1 : -1;
  return (closingMid - entry) * qty * mult * dir;
}

// ---------- Grading ----------
// EOD grading: pull current quote / option mid, compute CLV.
// If option is past expiry, grade against intrinsic value vs underlying close.

export async function gradeTrade(id: string): Promise<TradeRow | undefined> {
  const t = getTrade(id);
  if (!t || t.graded) return t;

  let closingMid: number | null = null;

  if (t.instrument === "EQUITY") {
    try {
      const quotes = await getQuotes([t.symbol]);
      const q = quotes.find(x => x.symbol === t.symbol.toUpperCase());
      if (q && Number.isFinite(q.last)) closingMid = q.last;
    } catch {}
  } else if (t.instrument === "OPTION" && t.expiry && t.strike != null && t.optType) {
    // Past expiry → grade as intrinsic at underlying close.
    const today = new Date().toISOString().slice(0, 10);
    if (t.expiry < today) {
      try {
        const quotes = await getQuotes([t.symbol]);
        const q = quotes.find(x => x.symbol === t.symbol.toUpperCase());
        const px = q?.last;
        if (Number.isFinite(px)) {
          const intrinsic = t.optType === "C"
            ? Math.max(0, (px as number) - t.strike)
            : Math.max(0, t.strike - (px as number));
          closingMid = intrinsic;
        }
      } catch {}
    } else {
      // Live option — pull chain, find ATM mid for that strike/expiry.
      try {
        const dte = Math.max(1, Math.ceil((new Date(t.expiry).getTime() - Date.now()) / 86_400_000));
        const chain = await getOptionChain(t.symbol, dte + 2);
        if (chain && !("error" in chain)) {
          const map = t.optType === "C" ? chain.callExpDateMap : chain.putExpDateMap;
          // Schwab key shape "yyyy-mm-dd:dte" — find loose match.
          const key = Object.keys(map).find(k => k.startsWith(t.expiry!));
          if (key) {
            const strikeMap = map[key];
            const strikeKey = Object.keys(strikeMap).find(s => Math.abs(parseFloat(s) - (t.strike as number)) < 0.01);
            if (strikeKey) {
              const opt = strikeMap[strikeKey][0];
              if (opt && Number.isFinite(opt.bid) && Number.isFinite(opt.ask)) {
                closingMid = (opt.bid + opt.ask) / 2;
              } else if (opt && Number.isFinite(opt.last)) {
                closingMid = opt.last;
              }
            }
          }
        }
      } catch {}
    }
  }

  if (closingMid == null || !Number.isFinite(closingMid)) return t;

  const bps = clvBps(t.side, t.entryPrice, closingMid);
  const dollars = clvDollars(t.side, t.entryPrice, closingMid, t.qty, t.instrument);
  sqlite.prepare(`
    UPDATE trade_log SET graded = 1, closing_mid = ?, close_time = ?, clv_bps = ?, clv_dollars = ?
    WHERE id = ?
  `).run(closingMid, Date.now(), bps, dollars, id);
  return getTrade(id);
}

// ---------- Aggregations ----------
export interface ClvSummary {
  count: number;
  gradedCount: number;
  meanBps: number;
  medianBps: number;
  positivePct: number;          // % of trades with CLV > 0 (this is your edge proxy)
  totalDollars: number;
  rolling20Bps: number;
  rolling50Bps: number;
  bySignal: { signal: string; count: number; meanBps: number; positivePct: number }[];
  bySymbol: { symbol: string; count: number; meanBps: number }[];
  recent: TradeRow[];
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function getClvSummary(): ClvSummary {
  const trades = listTrades({ limit: 1000 });
  const graded = trades.filter(t => t.graded && t.clvBps != null);
  const bps = graded.map(t => t.clvBps!).filter(Number.isFinite);
  const dollars = graded.map(t => t.clvDollars ?? 0).reduce((a, b) => a + b, 0);
  const positive = bps.filter(b => b > 0).length;

  const sortedDesc = [...graded].sort((a, b) => b.capturedAt - a.capturedAt);
  const last20 = sortedDesc.slice(0, 20).map(t => t.clvBps!);
  const last50 = sortedDesc.slice(0, 50).map(t => t.clvBps!);

  const sigMap = new Map<string, number[]>();
  for (const t of graded) {
    const key = t.signalSource || "unsourced";
    if (!sigMap.has(key)) sigMap.set(key, []);
    sigMap.get(key)!.push(t.clvBps!);
  }
  const bySignal = Array.from(sigMap.entries()).map(([signal, arr]) => ({
    signal,
    count: arr.length,
    meanBps: arr.reduce((a, b) => a + b, 0) / arr.length,
    positivePct: 100 * arr.filter(b => b > 0).length / arr.length,
  })).sort((a, b) => b.count - a.count);

  const symMap = new Map<string, number[]>();
  for (const t of graded) {
    if (!symMap.has(t.symbol)) symMap.set(t.symbol, []);
    symMap.get(t.symbol)!.push(t.clvBps!);
  }
  const bySymbol = Array.from(symMap.entries()).map(([symbol, arr]) => ({
    symbol,
    count: arr.length,
    meanBps: arr.reduce((a, b) => a + b, 0) / arr.length,
  })).sort((a, b) => b.count - a.count).slice(0, 12);

  return {
    count: trades.length,
    gradedCount: graded.length,
    meanBps: bps.length ? bps.reduce((a, b) => a + b, 0) / bps.length : 0,
    medianBps: median(bps),
    positivePct: bps.length ? 100 * positive / bps.length : 0,
    totalDollars: dollars,
    rolling20Bps: last20.length ? last20.reduce((a, b) => a + b, 0) / last20.length : 0,
    rolling50Bps: last50.length ? last50.reduce((a, b) => a + b, 0) / last50.length : 0,
    bySignal,
    bySymbol,
    recent: sortedDesc.slice(0, 25),
  };
}

// Cron-callable: grade every ungraded trade that has a closing reference available.
export async function gradePending(): Promise<{ graded: number; skipped: number }> {
  const rows = sqlite.prepare(`SELECT id FROM trade_log WHERE graded = 0`).all() as { id: string }[];
  let graded = 0, skipped = 0;
  for (const { id } of rows) {
    const out = await gradeTrade(id);
    if (out?.graded) graded++; else skipped++;
  }
  return { graded, skipped };
}
