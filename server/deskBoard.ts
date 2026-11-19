// server/deskBoard.ts
//
// THE LEVEL BOARD on the Trade Desk: one read of SPX, SPY, QQQ, VIX and the index futures, each with the
// levels a chart reader marks by hand, plus the index's option landmarks, and two descriptive cases for the
// index. Composition is pure (shared/levelBoard.ts); this file fetches quotes and bars from Schwab, caches
// them, and states for every ticker what was read and what was not.
//
// Nothing is filled in: a ticker Schwab does not quote, or a ticker with no daily bars, says so with the
// reason it gave. Futures symbols are asked for as Schwab names them (/ES, /NQ); whether an account's
// market-data entitlement serves them is only known from the answer.

import { getQuotes, getPriceHistory, type NormalizedQuote } from "./schwab";
import { etDate, prevTradingDay } from "./exchangeCalendar";
import { dailyBarEtDate } from "../shared/macroCalendar";
import { editionFromEnv } from "../shared/edition";
import {
  boardSession, calendarLevels, sessionLevels, mergeLevels, nearestLevels, deskCase, techRead, vixRead,
  type BoardLevel, type DayBar, type IntraBar, type DeskCase, type RelRead, type VixRead,
} from "../shared/levelBoard";

export const BOARD_TICKERS: ReadonlyArray<{ symbol: string; label: string; kind: "index" | "etf" | "vol" | "future" }> = [
  { symbol: "$SPX", label: "SPX", kind: "index" },
  { symbol: "SPY", label: "SPY", kind: "etf" },
  { symbol: "QQQ", label: "QQQ", kind: "etf" },
  { symbol: "$VIX", label: "VIX", kind: "vol" },
  { symbol: "/ES", label: "ES", kind: "future" },
  { symbol: "/NQ", label: "NQ", kind: "future" },
];

export interface BoardTicker {
  symbol: string;
  label: string;
  kind: "index" | "etf" | "vol" | "future";
  price: number | null;
  changePct: number | null;
  /** "ok" live or last-session quote; "stale" an old quote in session; "unavailable" none. */
  quoteState: "ok" | "stale" | "unavailable";
  quoteReason: string | null;
  levels: BoardLevel[];
  levelsState: "ok" | "partial" | "unavailable";
  levelsReason: string | null;
  /** The session the "prior-day" levels come from. */
  priorSession: string | null;
  at: BoardLevel[];
  above: BoardLevel | null;
  below: BoardLevel | null;
}

export interface DeskBoard {
  asOf: number;
  edition: string;
  /** The session these levels are for: today while it is open or still to come, else the next one. */
  forSession: string;
  sessionOpen: boolean;
  tickers: BoardTicker[];
  tech: RelRead;
  vix: VixRead;
  cases: { symbol: string; price: number | null; bull: DeskCase; bear: DeskCase; optionsState: string; optionsReason: string | null };
  note: string;
}

const DAILY_TTL_MS = 30 * 60_000;
const INTRA_TTL_MS = 60_000;
const BOARD_TTL_MS = 20_000;
const dailyCache = new Map<string, { at: number; bars: DayBar[]; reason: string | null }>();
const intraCache = new Map<string, { at: number; bars: IntraBar[]; reason: string | null }>();
let boardCache: { at: number; board: DeskBoard } | null = null;

async function dailyBars(symbol: string, nowMs: number): Promise<{ bars: DayBar[]; reason: string | null }> {
  const hit = dailyCache.get(symbol);
  if (hit && nowMs - hit.at < DAILY_TTL_MS) return hit;
  let out: { bars: DayBar[]; reason: string | null };
  try {
    const ph = await getPriceHistory(symbol, "month", 3, "daily", 1);
    const bars = (ph.candles ?? []).map((c) => ({ date: dailyBarEtDate(c.datetime, etDate), open: c.open, high: c.high, low: c.low, close: c.close }));
    out = { bars, reason: bars.length ? null : `no daily bars from Schwab for ${symbol}${ph.reason ? `: ${ph.reason}` : ""}` };
  } catch (e: any) {
    out = { bars: [], reason: `daily bars request failed for ${symbol}: ${String(e?.message ?? e).slice(0, 100)}` };
  }
  // A failed read is retried on the next build, not held for half an hour.
  if (out.bars.length) dailyCache.set(symbol, { at: nowMs, ...out });
  return out;
}

export async function intraBars(symbol: string, nowMs: number): Promise<{ bars: IntraBar[]; reason: string | null }> {
  const hit = intraCache.get(symbol);
  if (hit && nowMs - hit.at < INTRA_TTL_MS) return hit;
  let out: { bars: IntraBar[]; reason: string | null };
  try {
    const ph = await getPriceHistory(symbol, "day", 1, "minute", 5, false);
    const bars = (ph.candles ?? []).map((c) => ({ t: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close }));
    out = { bars, reason: bars.length ? null : (ph.reason ?? "no intraday bars") };
  } catch (e: any) {
    out = { bars: [], reason: String(e?.message ?? e).slice(0, 100) };
  }
  if (out.bars.length) intraCache.set(symbol, { at: nowMs, ...out });
  return out;
}

/** Option landmarks of the index from the nearest-expiry map, as board levels. */
async function optionLevels(nowMs: number): Promise<{ levels: BoardLevel[]; state: string; reason: string | null }> {
  try {
    const { buildOdteForward } = await import("./odteForward");
    const { composeOdteMap } = await import("../shared/odteMap");
    const fwd = await buildOdteForward("$SPX", nowMs);
    if (fwd.status !== 200) return { levels: [], state: "unavailable", reason: String((fwd.body as any)?.reason ?? "the nearest-expiry map is unavailable") };
    const map = composeOdteMap(fwd.body as any, { edition: editionFromEnv() as any });
    if (map.dataState === "no_gex") return { levels: [], state: "unavailable", reason: map.reason ?? "the chain carries no priced gamma" };
    const lm = map.landmarks;
    const levels: BoardLevel[] = [];
    const add = (key: string, label: string, price: number | null) => { if (price != null && Number.isFinite(price) && price > 0) levels.push({ key, label, price, group: "options" }); };
    add("pin", "pin", lm.pin); add("wallAbove", "wall above", lm.wallAbove); add("magnetBelow", "magnet below", lm.magnetBelow); add("flip", "gamma flip", lm.flip);
    add("straddleHigh", "straddle high", map.range.high); add("straddleLow", "straddle low", map.range.low);
    const state = map.dataState === "ok" ? "ok" : map.dataState;
    return { levels, state, reason: map.dataState === "ok" ? null : (map.reason ?? "from the last chain read") };
  } catch (e: any) {
    return { levels: [], state: "unavailable", reason: String(e?.message ?? e).slice(0, 120) };
  }
}

export async function buildDeskBoard(nowMs: number = Date.now()): Promise<DeskBoard> {
  if (boardCache && nowMs - boardCache.at < BOARD_TTL_MS) return boardCache.board;
  const { forSession, sessionOpen, today } = boardSession(nowMs);
  const expectedPrior = prevTradingDay(forSession);

  const quotes = new Map<string, NormalizedQuote>();
  let quoteError: string | null = null;
  try {
    for (const q of await getQuotes(BOARD_TICKERS.map((t) => t.symbol))) if (q?.symbol) quotes.set(q.symbol, q);
  } catch (e: any) { quoteError = String(e?.message ?? e).slice(0, 100); }

  const opt = await optionLevels(nowMs);

  const tickers: BoardTicker[] = [];
  for (const t of BOARD_TICKERS) {
    const q = quotes.get(t.symbol) ?? null;
    const price = q?.last != null && Number.isFinite(q.last) && q.last > 0 ? q.last : null;
    const changePct = q?.changePercent != null && Number.isFinite(q.changePercent) ? q.changePercent
      : price != null && q?.prevClose != null && q.prevClose > 0 ? ((price - q.prevClose) / q.prevClose) * 100 : null;
    const quoteState: BoardTicker["quoteState"] = price == null ? "unavailable" : q?.stale === true ? "stale" : "ok";
    const quoteReason = price == null ? (quoteError ?? `Schwab returned no quote for ${t.symbol}`) : q?.stale === true ? "the quote is older than two minutes" : null;

    const d = await dailyBars(t.symbol, nowMs);
    let levels: BoardLevel[] = calendarLevels(d.bars, forSession, { pivots: t.kind !== "vol" });
    const done = d.bars.filter((b) => b.date < forSession).map((b) => b.date).sort();
    const priorSession = done[done.length - 1] ?? null;
    let levelsState: BoardTicker["levelsState"] = levels.length ? "ok" : "unavailable";
    let levelsReason: string | null = levels.length ? null : d.reason ?? `no completed daily bars for ${t.symbol}`;
    if (levels.length && priorSession !== expectedPrior) {
      levelsState = "partial";
      levelsReason = `the newest completed daily bar is ${priorSession}, not ${expectedPrior}: "prior-day" levels are from ${priorSession}`;
    }
    if (forSession === today && t.kind !== "future") {
      const i = await intraBars(t.symbol, nowMs);
      levels = levels.concat(sessionLevels(i.bars, today, nowMs));
    }
    if (t.symbol === "$SPX") levels = levels.concat(opt.levels);
    const merged = mergeLevels(levels, price);
    const n = nearestLevels(levels, price);
    tickers.push({
      symbol: t.symbol, label: t.label, kind: t.kind, price, changePct, quoteState, quoteReason,
      levels: merged, levelsState, levelsReason, priorSession,
      at: n.at, above: n.above[0] ?? null, below: n.below[0] ?? null,
    });
  }

  const by = (s: string) => tickers.find((t) => t.symbol === s)!;
  const spx = by("$SPX");
  const board: DeskBoard = {
    asOf: nowMs,
    edition: editionFromEnv(),
    forSession, sessionOpen,
    tickers,
    tech: techRead(by("QQQ").changePct, by("SPY").changePct),
    vix: vixRead(by("$VIX").changePct),
    cases: {
      symbol: "$SPX", price: spx.price,
      bull: deskCase(spx.levels, spx.price, "bull"),
      bear: deskCase(spx.levels, spx.price, "bear"),
      optionsState: opt.state, optionsReason: opt.reason,
    },
    note: "Levels are prices from completed bars and the nearest-expiry option map. A case lists the levels on one side of the price in order; it is not a forecast and carries no odds.",
  };
  boardCache = { at: nowMs, board };
  return board;
}

/** Test hook. */
export function _resetDeskBoardCache(): void { boardCache = null; dailyCache.clear(); intraCache.clear(); }
