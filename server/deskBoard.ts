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

import type { NormalizedQuote, PriceHistoryResponse } from "./schwab";
import { etDate, prevTradingDay, sessionCloseMs } from "./exchangeCalendar";
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
  /** "ok" live or last-session quote; "stale" old in session or re-served; "age_unknown" no timestamp in session; "unavailable" none. */
  quoteState: "ok" | "stale" | "age_unknown" | "unavailable";
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
  cases: { symbol: string; price: number | null; bull: DeskCase; bear: DeskCase; optionsState: "ok" | "stale" | "unavailable"; optionsReason: string | null; optionsAsOfMs: number | null };
  note: string;
}

const DAILY_TTL_MS = 30 * 60_000;
const INTRA_TTL_MS = 60_000;
const BOARD_TTL_MS = 20_000;
/** A refused read (HTTP 4xx) is not asked for again for five minutes: a refused endpoint cools down app-wide. Anything else empty, one minute. */
const REFUSED_TTL_MS = 5 * 60_000;
const EMPTY_TTL_MS = 60_000;
const negTtl = (reason: string) => (/\bHTTP 4\d\d\b|\b40[13]\b/.test(reason) ? REFUSED_TTL_MS : EMPTY_TTL_MS);

/** What the board reads from; replaced in tests. */
export interface DeskBoardDeps {
  getQuotes(symbols: string[]): Promise<NormalizedQuote[]>;
  getPriceHistory(symbol: string, periodType: "day" | "month", period: number, frequencyType: "minute" | "daily", frequency: number, ext?: boolean): Promise<PriceHistoryResponse>;
  optionLevels(nowMs: number): Promise<OptionLevels>;
  edition(): string;
}
export interface OptionLevels { levels: BoardLevel[]; state: "ok" | "stale" | "unavailable"; reason: string | null; asOfMs: number | null }

interface DailyRead { bars: DayBar[]; reason: string | null; asOfMs: number | null }
const dailyCache = new Map<string, { at: number; forSession: string; read: DailyRead }>();
const intraCache = new Map<string, { at: number; bars: IntraBar[]; reason: string | null }>();
const negative = new Map<string, { at: number; reason: string }>();
let boardCache: { at: number; board: DeskBoard } | null = null;
let inFlight: Promise<DeskBoard> | null = null;

const src = (deps: DeskBoardDeps) => (deps.edition() === "demo" ? "the sample feed" : "Schwab");

async function dailyBars(deps: DeskBoardDeps, symbol: string, forSession: string, nowMs: number): Promise<DailyRead> {
  const hit = dailyCache.get(symbol);
  // A cache entry built for another session is a miss: at the close today's bar turns from "in progress" into the prior day.
  if (hit && hit.forSession === forSession && nowMs - hit.at < DAILY_TTL_MS) return hit.read;
  const neg = negative.get(`d:${symbol}`);
  if (neg && nowMs - neg.at < negTtl(neg.reason)) return { bars: [], reason: neg.reason, asOfMs: null };
  let read: DailyRead;
  try {
    const ph = await deps.getPriceHistory(symbol, "month", 3, "daily", 1);
    const bars = (ph.candles ?? []).map((c) => ({ date: dailyBarEtDate(c.datetime, etDate), open: c.open, high: c.high, low: c.low, close: c.close }));
    read = { bars, asOfMs: ph.asOfMs ?? null, reason: bars.length ? null : `no daily bars from ${src(deps)} for ${symbol}${ph.reason ? `: ${ph.reason}` : ""}` };
  } catch (e: any) {
    read = { bars: [], asOfMs: null, reason: `daily bars request failed for ${symbol}: ${String(e?.message ?? e).slice(0, 100)}` };
  }
  if (!read.bars.length) { negative.set(`d:${symbol}`, { at: nowMs, reason: read.reason ?? "no daily bars" }); return read; }
  // A payload read before the prior session closed holds that session's bar half-formed: use it, flag it, do not keep it.
  if (!readBeforeClose(read, forSession)) dailyCache.set(symbol, { at: nowMs, forSession, read });
  return read;
}

/** True when the newest completed bar's session had not closed when the payload was produced. */
function readBeforeClose(read: DailyRead, forSession: string): boolean {
  const done = read.bars.map((b) => b.date).filter((d) => d < forSession).sort();
  const prior = done[done.length - 1];
  if (!prior || read.asOfMs == null) return false;
  const closeMs = sessionCloseMs(prior);
  return closeMs != null && read.asOfMs < closeMs;
}

export async function intraBars(symbol: string, nowMs: number, deps: DeskBoardDeps = liveDeps()): Promise<{ bars: IntraBar[]; reason: string | null }> {
  const hit = intraCache.get(symbol);
  if (hit && nowMs - hit.at < INTRA_TTL_MS) return hit;
  const neg = negative.get(`i:${symbol}`);
  if (neg && nowMs - neg.at < negTtl(neg.reason)) return { bars: [], reason: neg.reason };
  let out: { bars: IntraBar[]; reason: string | null };
  try {
    const ph = await deps.getPriceHistory(symbol, "day", 1, "minute", 5, false);
    const bars = (ph.candles ?? []).map((c) => ({ t: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close }));
    out = { bars, reason: bars.length ? null : (ph.reason ?? "no intraday bars") };
  } catch (e: any) {
    out = { bars: [], reason: String(e?.message ?? e).slice(0, 100) };
  }
  if (out.bars.length) intraCache.set(symbol, { at: nowMs, ...out });
  else negative.set(`i:${symbol}`, { at: nowMs, reason: out.reason ?? "no intraday bars" });
  return out;
}

/** Option landmarks of the index from the nearest-expiry map, as board levels. */
async function liveOptionLevels(nowMs: number): Promise<OptionLevels> {
  try {
    const { buildOdteForward } = await import("./odteForward");
    const { composeOdteMap } = await import("../shared/odteMap");
    const fwd = await buildOdteForward("$SPX", nowMs);
    if (fwd.status !== 200) return { levels: [], state: "unavailable", reason: String((fwd.body as any)?.reason ?? "the nearest-expiry map is unavailable"), asOfMs: null };
    const map = composeOdteMap(fwd.body as any, { edition: editionFromEnv() as any });
    if (map.dataState === "no_gex") return { levels: [], state: "unavailable", reason: map.reason ?? "the chain carries no priced gamma", asOfMs: map.chainAsOfMs ?? null };
    const lm = map.landmarks;
    const levels: BoardLevel[] = [];
    const add = (key: string, label: string, price: number | null) => { if (price != null && Number.isFinite(price) && price > 0) levels.push({ key, label, price, group: "options" }); };
    add("pin", "pin", lm.pin); add("wallAbove", "wall above", lm.wallAbove); add("magnetBelow", "magnet below", lm.magnetBelow); add("flip", "gamma flip", lm.flip);
    add("straddleHigh", "straddle high", map.range.high); add("straddleLow", "straddle low", map.range.low);
    const okMap = map.dataState === "ok";
    return { levels, state: okMap ? "ok" : "stale", reason: okMap ? null : (map.reason ?? "from the last chain read"), asOfMs: map.chainAsOfMs ?? null };
  } catch (e: any) {
    return { levels: [], state: "unavailable", reason: String(e?.message ?? e).slice(0, 120), asOfMs: null };
  }
}

let _live: DeskBoardDeps | null = null;
function liveDeps(): DeskBoardDeps {
  if (_live) return _live;
  _live = {
    getQuotes: async (symbols) => (await import("./schwab")).getQuotes(symbols),
    getPriceHistory: async (symbol, periodType, period, frequencyType, frequency, ext) => (await import("./schwab")).getPriceHistory(symbol, periodType, period, frequencyType, frequency, ext ?? false),
    optionLevels: liveOptionLevels,
    edition: () => editionFromEnv(),
  };
  return _live;
}

export async function buildDeskBoard(nowMs: number = Date.now(), deps: DeskBoardDeps = liveDeps()): Promise<DeskBoard> {
  if (boardCache && nowMs - boardCache.at < BOARD_TTL_MS) return boardCache.board;
  // One build at a time: concurrent readers of an expired cache share it.
  if (inFlight) return inFlight;
  inFlight = compose(nowMs, deps).then((board) => { boardCache = { at: nowMs, board }; return board; }).finally(() => { inFlight = null; });
  return inFlight;
}

async function compose(nowMs: number, deps: DeskBoardDeps): Promise<DeskBoard> {
  const { forSession, sessionOpen, today } = boardSession(nowMs);
  const expectedPrior = prevTradingDay(forSession);

  const quotes = new Map<string, NormalizedQuote>();
  let quoteError: string | null = null;
  try {
    for (const q of await deps.getQuotes(BOARD_TICKERS.map((t) => t.symbol))) if (q?.symbol) quotes.set(q.symbol, q);
  } catch (e: any) { quoteError = String(e?.message ?? e).slice(0, 100); }

  const priced = (sym: string) => { const q = quotes.get(sym); return q?.last != null && Number.isFinite(q.last) && q.last > 0; };
  // A future with no quote is not asked for bars either: an endpoint that refuses futures would cool down for every caller.
  const wantsBars = (t: (typeof BOARD_TICKERS)[number]) => t.kind !== "future" || priced(t.symbol);
  const [opt, dailies, intras] = await Promise.all([
    deps.optionLevels(nowMs),
    Promise.all(BOARD_TICKERS.map((t) => wantsBars(t) ? dailyBars(deps, t.symbol, forSession, nowMs) : Promise.resolve<DailyRead>({ bars: [], asOfMs: null, reason: `no bars asked for: no ${t.symbol} quote` }))),
    Promise.all(BOARD_TICKERS.map((t) => sessionOpen && t.kind !== "future" ? intraBars(t.symbol, nowMs, deps) : Promise.resolve(null))),
  ]);

  let spxRaw: BoardLevel[] = [];
  const tickers: BoardTicker[] = BOARD_TICKERS.map((t, idx) => {
    const q = quotes.get(t.symbol) ?? null;
    const price = priced(t.symbol) ? (q!.last as number) : null;
    const changePct = q?.changePercent != null && Number.isFinite(q.changePercent) ? q.changePercent
      : price != null && q?.prevClose != null && q.prevClose > 0 ? ((price - q.prevClose) / q.prevClose) * 100 : null;
    // In session an unknown age is not live; closed, the last price is the last price.
    const quoteState: BoardTicker["quoteState"] = price == null ? "unavailable" : q?.stale === true ? "stale" : sessionOpen && q?.stale == null ? "age_unknown" : "ok";
    const quoteReason = price == null ? (quoteError ?? `${src(deps)} returned no quote for ${t.symbol}`)
      : quoteState === "stale" ? "the quote is older than two minutes in session, or was re-served after a failed refresh"
      : quoteState === "age_unknown" ? "the quote carries no timestamp, so its age is unknown" : null;

    const d = dailies[idx];
    let levels: BoardLevel[] = calendarLevels(d.bars, forSession, { pivots: t.kind !== "vol" });
    const done = d.bars.filter((b) => b.date < forSession).map((b) => b.date).sort();
    const priorSession = done[done.length - 1] ?? null;
    let levelsState: BoardTicker["levelsState"] = levels.length ? "ok" : "unavailable";
    const reasons: string[] = [];
    if (!levels.length) reasons.push(d.reason ?? `no completed daily bars for ${t.symbol}`);
    else if (priorSession !== expectedPrior) reasons.push(`the newest completed daily bar is ${priorSession}, not ${expectedPrior}: "prior-day" levels are from ${priorSession}`);
    else if (readBeforeClose(d, forSession)) reasons.push(`the daily bar for ${priorSession} was read before that session closed`);
    const i = intras[idx];
    if (i) {
      const sl = sessionLevels(i.bars, today, nowMs);
      levels = levels.concat(sl);
      if (!sl.length) reasons.push(`today's open and opening range not read: ${i.reason ?? "no bar starting at 09:30 in the feed"}`);
    }
    if (levels.length && reasons.length) levelsState = "partial";
    if (t.symbol === "$SPX") { levels = levels.concat(opt.levels); spxRaw = levels; }
    const merged = mergeLevels(levels, price);
    const n = nearestLevels(levels, price);
    return {
      symbol: t.symbol, label: t.label, kind: t.kind, price, changePct, quoteState, quoteReason,
      levels: merged, levelsState, levelsReason: reasons.length ? reasons.join("; ") : null, priorSession,
      at: n.at, above: n.above[0] ?? null, below: n.below[0] ?? null,
    };
  });

  const by = (s: string) => tickers.find((t) => t.symbol === s)!;
  const spx = by("$SPX");
  return {
    asOf: nowMs,
    edition: deps.edition(),
    forSession, sessionOpen,
    tickers,
    tech: techRead(by("QQQ").changePct, by("SPY").changePct),
    vix: vixRead(by("$VIX").changePct),
    cases: {
      symbol: "$SPX", price: spx.price,
      bull: deskCase(spxRaw, spx.price, "bull"),
      bear: deskCase(spxRaw, spx.price, "bear"),
      optionsState: opt.state, optionsReason: opt.reason, optionsAsOfMs: opt.asOfMs,
    },
    note: "Prior-day, prior-week and prior-month levels and the pivots come from completed daily bars; the week, month and today's open and the opening range come from the session in progress; the option landmarks come from the nearest-expiry map and move with it. A case lists the levels on one side of the price in order; it is not a forecast and carries no odds.",
  };
}

/** Test hook. */
export function _resetDeskBoardCache(): void { boardCache = null; inFlight = null; dailyCache.clear(); intraCache.clear(); negative.clear(); }
