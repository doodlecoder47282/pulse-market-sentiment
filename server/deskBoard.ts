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
  boardSession, quoteChangeBasis, type ChangeBasis, calendarLevels, rangeLevels, sessionLevels, dayBarFromIntraday, mergeLevels, nearestLevels, deskCase, techRead, vixRead,
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
  /** What changePct is a change of, read from the quote's own previous close (shared/levelBoard.ts quoteChangeBasis). */
  changeBasis: ChangeBasis;
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
  /** Why this read's quotes call produced no price for a future, as a code (server/schwab.ts QuoteRefusalCode). */
  quoteRefusal?(symbol: string): Promise<string | null>;
  getPriceHistory(symbol: string, periodType: "day" | "month", period: number, frequencyType: "minute" | "daily", frequency: number, ext?: boolean): Promise<PriceHistoryResponse>;
  optionLevels(nowMs: number): Promise<OptionLevels>;
  edition(): string;
  /** Daily bars kept from the last good read of a symbol, for a read the source refuses (a restart loses the in-memory cache). */
  loadDaily?(symbol: string): Promise<{ bars: DayBar[]; asOfMs: number | null } | null>;
  saveDaily?(symbol: string, bars: DayBar[], asOfMs: number | null): Promise<void>;
}
export interface OptionLevels { levels: BoardLevel[]; state: "ok" | "stale" | "unavailable"; reason: string | null; asOfMs: number | null }

interface DailyRead { bars: DayBar[]; reason: string | null; asOfMs: number | null; /** Set when the bars are the kept copy: why the fresh read failed. */ storedBecause?: string | null }
const dailyCache = new Map<string, { at: number; forSession: string; read: DailyRead }>();
const intraCache = new Map<string, { at: number; bars: IntraBar[]; reason: string | null }>();
const negative = new Map<string, { at: number; reason: string }>();
/** A finished session's bar built from its intraday bars (shared/levelBoard.ts dayBarFromIntraday): it does not change, so it is built once. */
const builtDay = new Map<string, DayBar>();
/** When a build was last tried and gave no whole session, per ticker and session: not tried again for this long. */
const builtMiss = new Map<string, number>();
const BUILT_RETRY_MS = 15 * 60_000;
let boardCache: { at: number; board: DeskBoard } | null = null;
let inFlight: Promise<DeskBoard> | null = null;

const hhmmEt = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const src = (deps: DeskBoardDeps) => (deps.edition() === "demo" ? "the sample feed" : "Schwab");

async function dailyBars(deps: DeskBoardDeps, symbol: string, forSession: string, nowMs: number): Promise<DailyRead> {
  const hit = dailyCache.get(symbol);
  // A cache entry built for another session is a miss: at the close today's bar turns from "in progress" into the prior day.
  if (hit && hit.forSession === forSession && nowMs - hit.at < DAILY_TTL_MS) return hit.read;
  const neg = negative.get(`d:${symbol}`);
  if (neg && nowMs - neg.at < negTtl(neg.reason)) {
    try {
      const kept = await deps.loadDaily?.(symbol);
      if (kept && kept.bars.length) return { bars: kept.bars, asOfMs: kept.asOfMs, reason: null, storedBecause: neg.reason };
    } catch { /* no kept copy */ }
    return { bars: [], reason: neg.reason, asOfMs: null };
  }
  let read: DailyRead;
  try {
    const ph = await deps.getPriceHistory(symbol, "month", 3, "daily", 1);
    const bars = (ph.candles ?? []).map((c) => ({ date: dailyBarEtDate(c.datetime, etDate), open: c.open, high: c.high, low: c.low, close: c.close }));
    read = { bars, asOfMs: ph.asOfMs ?? null, reason: bars.length ? null : `no daily bars from ${src(deps)} for ${symbol}${ph.reason ? `: ${ph.reason}` : ""}` };
  } catch (e: any) {
    read = { bars: [], asOfMs: null, reason: `daily bars request failed for ${symbol}: ${String(e?.message ?? e).slice(0, 100)}` };
  }
  if (!read.bars.length) {
    negative.set(`d:${symbol}`, { at: nowMs, reason: read.reason ?? "no daily bars" });
    // The source gave nothing: completed daily bars do not change, so the copy kept from the last good read is used and
    // named as a copy. Whether it still holds the right prior session is checked by the caller, as for any read.
    try {
      const kept = await deps.loadDaily?.(symbol);
      if (kept && kept.bars.length) return { bars: kept.bars, asOfMs: kept.asOfMs, reason: null, storedBecause: read.reason ?? "no daily bars" };
    } catch { /* no kept copy: the refusal stands */ }
    return read;
  }
  try { await deps.saveDaily?.(symbol, read.bars, read.asOfMs); } catch { /* keeping a copy is best effort */ }
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
let _dailyTable = false;
function ensureDailyTable(sqlite: { exec(sql: string): unknown }): void {
  if (_dailyTable) return;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS desk_daily_bars (symbol TEXT PRIMARY KEY, bars_json TEXT NOT NULL, as_of_ms INTEGER, saved_at INTEGER NOT NULL)`);
  _dailyTable = true;
}

function liveDeps(): DeskBoardDeps {
  if (_live) return _live;
  _live = {
    getQuotes: async (symbols) => (await import("./schwab")).getQuotes(symbols),
    quoteRefusal: async (symbol) => (await import("./schwab")).quoteRefusalReason(symbol),
    getPriceHistory: async (symbol, periodType, period, frequencyType, frequency, ext) => (await import("./schwab")).getPriceHistory(symbol, periodType, period, frequencyType, frequency, ext ?? false),
    optionLevels: liveOptionLevels,
    edition: () => editionFromEnv(),
    loadDaily: async (symbol) => {
      if (editionFromEnv() === "demo") return null;
      const { sqlite } = await import("./storage");
      ensureDailyTable(sqlite);
      const r = sqlite.prepare(`SELECT bars_json, as_of_ms FROM desk_daily_bars WHERE symbol = ?`).get(symbol) as { bars_json: string; as_of_ms: number | null } | undefined;
      if (!r) return null;
      const bars = JSON.parse(r.bars_json);
      return Array.isArray(bars) ? { bars, asOfMs: r.as_of_ms ?? null } : null;
    },
    saveDaily: async (symbol, bars, asOfMs) => {
      if (editionFromEnv() === "demo") return;
      const { sqlite } = await import("./storage");
      ensureDailyTable(sqlite);
      sqlite.prepare(`INSERT OR REPLACE INTO desk_daily_bars (symbol, bars_json, as_of_ms, saved_at) VALUES (?, ?, ?, ?)`).run(symbol, JSON.stringify(bars), asOfMs, Date.now());
    },
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
  // The source's own account of a future it gave no price for, worded with the source's name.
  const refusals = new Map<string, string>();
  if (deps.quoteRefusal && quoteError == null) {
    await Promise.all(BOARD_TICKERS.filter((t) => t.kind === "future" && !priced(t.symbol)).map(async (t) => {
      try {
        const code = await deps.quoteRefusal!(t.symbol);
        const who = src(deps);
        const text = code === "invalid_symbol" ? `${who} answered that ${t.symbol} is not a symbol it recognises`
          : code === "no_entry" ? `${who} answered, with no entry for ${t.symbol}`
          : code === "no_price" ? `${who} sent an entry for ${t.symbol} with no price in it`
          : code === "not_connected" ? `${who} is not connected, so no quote was asked for`
          : code === "no_answer" ? `${who} did not answer the quotes request` : null;
        if (text) refusals.set(t.symbol, text);
      } catch { /* the plain wording below stands */ }
    }));
  }
  // Futures are price-only for now: the price-history endpoint is not known to serve a root future, and a
  // refusal there cools the endpoint down for every caller (SPX charts included). No futures bars are asked for.
  const wantsBars = (t: (typeof BOARD_TICKERS)[number]) => t.kind !== "future";
  const [opt, dailies, intras] = await Promise.all([
    deps.optionLevels(nowMs),
    Promise.all(BOARD_TICKERS.map((t) => wantsBars(t) ? dailyBars(deps, t.symbol, forSession, nowMs) : Promise.resolve<DailyRead>({ bars: [], asOfMs: null, reason: "price only: no futures bars are asked for, so no levels are computed" }))),
    Promise.all(BOARD_TICKERS.map((t) => sessionOpen && t.kind !== "future" ? intraBars(t.symbol, nowMs, deps) : Promise.resolve(null))),
  ]);

  let spxRaw: BoardLevel[] = [];
  // The daily feed can lag the close by hours. When the session before the board's has finished and its daily bar is
  // missing, that bar is built from the session's own intraday bars, once, and named as such.
  const priorClosed = (() => { const c = expectedPrior ? sessionCloseMs(expectedPrior) : null; return c != null && nowMs >= c; })();
  const builtBars: Array<DayBar | null> = await Promise.all(BOARD_TICKERS.map(async (t, idx) => {
    const d = dailies[idx];
    if (!expectedPrior || !priorClosed || !d.bars.length) return null;
    const newest = d.bars.map((b) => b.date).filter((x) => x < forSession).sort().pop();
    if (!newest || newest >= expectedPrior) return null;
    const key = `${t.symbol}|${expectedPrior}`;
    const hit = builtDay.get(key);
    if (hit) return hit;
    // No whole session came back last time: asking again every board build would spend a request a minute per ticker all evening.
    const missed = builtMiss.get(key);
    if (missed != null && nowMs - missed < BUILT_RETRY_MS) return null;
    const bar = dayBarFromIntraday((await intraBars(t.symbol, nowMs, deps)).bars, expectedPrior);
    if (bar) { builtDay.set(key, bar); builtMiss.delete(key); } else builtMiss.set(key, nowMs);
    return bar;
  }));

  const tickers: BoardTicker[] = BOARD_TICKERS.map((t, idx) => {
    const q = quotes.get(t.symbol) ?? null;
    const price = priced(t.symbol) ? (q!.last as number) : null;
    const changePct = q?.changePercent != null && Number.isFinite(q.changePercent) ? q.changePercent
      : price != null && q?.prevClose != null && q.prevClose > 0 ? ((price - q.prevClose) / q.prevClose) * 100 : null;
    // In session an unknown age is not live; closed, the last price is the last price.
    const quoteState: BoardTicker["quoteState"] = price == null ? "unavailable" : q?.stale === true ? "stale" : sessionOpen && q?.stale == null ? "age_unknown" : "ok";
    const quoteReason = price == null ? (quoteError ?? refusals.get(t.symbol) ?? `${src(deps)} returned no quote for ${t.symbol}`)
      : quoteState === "stale" ? "the quote is older than two minutes in session, or was re-served after a failed refresh"
      : quoteState === "age_unknown" ? "the quote carries no timestamp, so its age is unknown" : null;

    let d = dailies[idx];
    const built = builtBars[idx];
    if (built) d = { ...d, bars: [...d.bars.filter((b) => b.date !== built.date), built] };
    let levels: BoardLevel[] = calendarLevels(d.bars, forSession, { pivots: t.kind !== "vol" });
    // Only alongside the calendar levels: a board with no prior day stays "unavailable" rather than showing ranges alone.
    if (levels.length) levels = [...levels, ...rangeLevels(d.bars, forSession)];
    const done = d.bars.filter((b) => b.date < forSession).map((b) => b.date).sort();
    const priorSession = done[done.length - 1] ?? null;
    // The close the quote's change is measured from tells what the change is a change of.
    const closeOf = (date: string | undefined) => (date ? d.bars.find((b) => b.date === date)?.close ?? null : null);
    const hasPrior = priorSession != null && priorSession === expectedPrior;
    const changeBasis = quoteChangeBasis(sessionOpen, q?.prevClose ?? null, hasPrior ? closeOf(priorSession!) : null, closeOf(hasPrior ? done[done.length - 2] : done[done.length - 1]));
    let levelsState: BoardTicker["levelsState"] = levels.length ? "ok" : "unavailable";
    const reasons: string[] = [];
    if (!levels.length) reasons.push(d.reason ?? `no completed daily bars for ${t.symbol}`);
    else if (priorSession !== expectedPrior) reasons.push(`the newest completed daily bar is ${priorSession}, not ${expectedPrior}: "prior-day" levels are from ${priorSession}, and the range levels end there`);
    else if (built) reasons.push(`${src(deps)}'s daily bar for ${built.date} is not posted yet: prior-day levels and pivots use that session's intraday bars (every 5-minute bar from 09:30 to the regular close: its high and low, and the last intraday close, which can differ from the official close${t.kind === "vol" ? "; VIX is calculated until 16:15 ET and those last minutes are not in this bar" : ""})`);
    else if (readBeforeClose(d, forSession)) reasons.push(`the daily bar for ${priorSession} was read before that session closed, so levels that use it (prior day, pivots, ranges) may be short of its final high or low`);
    // Kept copy in use: say so and why, whatever else is true of it. The prior-session checks above already ran on it.
    if (levels.length && d.storedBecause) reasons.push(`daily bars are the copy kept from ${d.asOfMs != null ? `${etDate(d.asOfMs)} ${hhmmEt(d.asOfMs)} ET` : "an earlier read"}; the fresh read failed (${d.storedBecause})`);
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
      symbol: t.symbol, label: t.label, kind: t.kind, price, changePct, changeBasis, quoteState, quoteReason,
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
    // Two changes are only compared when they are changes of the same thing.
    tech: techRead(by("QQQ").changePct, by("SPY").changePct, by("QQQ").changeBasis === by("SPY").changeBasis ? by("QQQ").changeBasis : "unknown"),
    vix: vixRead(by("$VIX").changePct, by("$VIX").changeBasis),
    cases: {
      symbol: "$SPX", price: spx.price,
      bull: deskCase(spxRaw, spx.price, "bull"),
      bear: deskCase(spxRaw, spx.price, "bear"),
      optionsState: opt.state, optionsReason: opt.reason, optionsAsOfMs: opt.asOfMs,
    },
    note: "Prior-day, prior-week and prior-month levels and the pivots come from completed daily bars, as do the 20-session high and low and the high and low of every daily bar read (about three months; the label carries the count); the week, month and today's open and the opening range come from the session in progress; the option landmarks come from the nearest-expiry map and move with it. A case lists the levels on one side of the price in order; it is not a forecast and carries no odds.",
  };
}

/** Test hook. */
export function _resetDeskBoardCache(): void { boardCache = null; inFlight = null; dailyCache.clear(); intraCache.clear(); negative.clear(); builtDay.clear(); builtMiss.clear(); }
