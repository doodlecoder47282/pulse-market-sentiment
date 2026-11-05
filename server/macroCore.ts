// server/macroCore.ts
//
// The macro strip's data collection, kept pure so tests can count every
// upstream request. server/macro.ts wires it to Schwab and the public
// crypto/FX fallbacks; nothing here imports the network.
//
// Request plan per build (Schwab-covered symbols are derived from UNIVERSE):
//   - ONE batched quote request for every Schwab-covered symbol (price and
//     the quote's prior-close fields);
//   - daily history only when a symbol's cached COMPLETED sessions are out of
//     date: a new session completed, the latest completed bar was missing at
//     the last read (retried at most every INCOMPLETE_RETRY_MS), the copy is
//     older than HISTORY_MAX_AGE_MS (picks up vendor corrections), or the
//     owner invalidated it. A failed read is not retried before
//     FAIL_BACKOFF_MS, so UI polling cannot turn one failure into a storm.
// The old plan read 5-minute intraday bars AND daily bars for every symbol
// on every build (2 requests x 17 symbols).
//
// Price meaning is unchanged: the price is the last REGULAR-session trade
// (Schwab regularMarketLastPrice; the old intraday bars were regular-hours
// only), and the prior close goes through dayChange.resolvePrevClose with
// the same quote fields as before plus the completed daily bars. Today's
// still-forming daily bar is never stored. A symbol whose quote is missing
// shows the last completed session's close, labelled as such with its own
// date, never as a current price; with no close either it stays listed as
// unavailable.

import { resolvePrevClose, dayChange, dailyBarSessionDate, type PrevCloseSource } from "./dayChange";
import { etClock, etDate, prevTradingDay, sessionCloseMs, isTradingDay, isRegularSessionOpen, type IsoDate } from "./exchangeCalendar";
import { lastCompletedSession } from "./breadthMath";

export type MacroCategory = "equities" | "bonds" | "credit" | "commods" | "fx" | "crypto";

export type TickerDef = { symbol: string; label: string; category: MacroCategory };

/**
 * Commodity rows are ETF proxies: the price is the fund's share price, not a
 * barrel, ounce or bushel. The label says which fund.
 */
export const UNIVERSE: TickerDef[] = [
  // Equities — index ETFs
  { symbol: "SPY", label: "SPY", category: "equities" },
  { symbol: "QQQ", label: "QQQ", category: "equities" },
  { symbol: "IWM", label: "IWM", category: "equities" },
  { symbol: "DIA", label: "DIA", category: "equities" },

  // Bonds — duration ladder
  { symbol: "SHY", label: "SHY 1-3Y", category: "bonds" },
  { symbol: "IEF", label: "IEF 7-10Y", category: "bonds" },
  { symbol: "TLT", label: "TLT 20+Y", category: "bonds" },

  // Credit
  { symbol: "HYG", label: "HYG HY", category: "credit" },
  { symbol: "LQD", label: "LQD IG", category: "credit" },
  { symbol: "JNK", label: "JNK HY", category: "credit" },

  // Commodities — ETF proxies (fund share prices)
  { symbol: "USO", label: "Oil (USO)", category: "commods" },
  { symbol: "UNG", label: "NatGas (UNG)", category: "commods" },
  { symbol: "GLD", label: "Gold (GLD)", category: "commods" },
  { symbol: "SLV", label: "Silver (SLV)", category: "commods" },
  { symbol: "CPER", label: "Copper (CPER)", category: "commods" },
  { symbol: "CORN", label: "Corn (CORN)", category: "commods" },
  { symbol: "WEAT", label: "Wheat (WEAT)", category: "commods" },

  // FX
  { symbol: "DX-Y.NYB", label: "DXY", category: "fx" },
  { symbol: "EURUSD=X", label: "EUR/USD", category: "fx" },
  { symbol: "USDJPY=X", label: "USD/JPY", category: "fx" },
  { symbol: "GBPUSD=X", label: "GBP/USD", category: "fx" },

  // Crypto
  { symbol: "BTC-USD", label: "BTC", category: "crypto" },
  { symbol: "ETH-USD", label: "ETH", category: "crypto" },
];

/** Schwab cannot quote crypto or Yahoo-style FX symbols; those use public fallbacks. */
export const schwabCovers = (d: TickerDef): boolean => d.category !== "crypto" && d.category !== "fx";
export const SCHWAB_SYMBOLS: string[] = UNIVERSE.filter(schwabCovers).map((d) => d.symbol);

/** Where a row's price comes from. */
export type PriceBasis =
  | "regular_session_last"   // Schwab quote, last regular-session trade
  | "last_daily_close"       // quote missing: last COMPLETED session's close (Schwab daily bar)
  | "public_fallback"        // crypto / FX public source
  | "unavailable";

export type MacroQuote = {
  category: MacroCategory;
  symbol: string;
  display: string;
  label: string;
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  /** Last ~22 daily closes for the sparkline (completed sessions, plus the current price when it belongs to a later session). */
  spark: number[];
  basis: PriceBasis;
  /** "ok" = current price and prior close; "partial" = something missing or substituted (see reason); "unavailable" = no price. */
  dataState: "ok" | "partial" | "unavailable";
  reason: string | null;
  /** When the price was observed (quote time, or the close of the bar's session), epoch ms. Not the build time. */
  priceAsOfMs: number | null;
  /** ET session the price belongs to. */
  priceSessionDate: IsoDate | null;
  /** true when the quote was re-served after a failed refresh or is older than its window. */
  stale: boolean;
  prevCloseSource: PrevCloseSource | null;
  prevCloseDate: IsoDate | null;
};

export type MacroResponse = {
  /** Build time, epoch seconds. Each row's own observation time is priceAsOfMs. */
  asOf: number;
  sessionOpen: boolean;
  coverage: { total: number; ok: number; partial: number; unavailable: number };
  groups: { category: MacroCategory; label: string; quotes: MacroQuote[] }[];
  /** Flat list for ticker tape (in display order). */
  tape: MacroQuote[];
};

// ─── Injected inputs ─────────────────────────────────────────────────────────

/** The fields of a Schwab quote this module reads (subset of schwab.NormalizedQuote). */
export interface QuoteIn {
  symbol: string;
  last: number | null;
  change: number | null;
  /** Schwab quote closePrice (documented as the previous session close; may roll after 16:00 ET). */
  prevClose?: number | null;
  regularMarketLast?: number | null;
  quoteTimeMs?: number | null;
  fetchedAtMs?: number | null;
  stale?: boolean;
}

export interface DailyBarsIn {
  /** Daily candles: t = epoch SECONDS, c = close. */
  bars: { t: number; c: number }[];
  dataState: "ok" | "empty" | "unavailable";
  reason?: string | null;
}

export interface FallbackIn { price: number | null; prevClose: number | null; spark: number[] }

export interface MacroDeps {
  now(): number;
  /** One batched quote request for all symbols. Must not throw for a missing symbol; omit it. */
  getQuotes(symbols: string[]): Promise<QuoteIn[]>;
  /** About one month of daily bars for one symbol. */
  getDailyBars(symbol: string): Promise<DailyBarsIn>;
  /** Crypto / FX public fallback. */
  getFallback(def: TickerDef): Promise<FallbackIn | null>;
}

// ─── History cache (completed sessions only) ─────────────────────────────────

/** Retry a symbol whose latest completed session bar was missing (vendor posts late). */
export const INCOMPLETE_RETRY_MS = 10 * 60_000;
/** Re-read a complete copy after this long anyway, to pick up vendor corrections. */
export const HISTORY_MAX_AGE_MS = 6 * 3600_000;
/** After a failed read, wait this long before asking again. */
export const FAIL_BACKOFF_MS = 2 * 60_000;
/** Concurrent history reads per build (one-time work at a session change or cold start). */
export const HISTORY_CONCURRENCY = 6;

interface HistoryEntry {
  /** Last completed session when read. */
  key: IsoDate;
  /** Completed-session bars, oldest first. */
  bars: { t: number; c: number; date: IsoDate }[];
  fetchedAt: number;
  /** true when the bars include the key session. */
  complete: boolean;
}

interface HistoryFailure { at: number; reason: string }

export interface HistoryRead {
  bars: { t: number; c: number; date: IsoDate }[];
  /** "fresh" = read for the current completed session; "kept" = an older or incomplete copy reused; "none" = nothing. */
  state: "fresh" | "kept" | "none";
  reason: string | null;
}

/** ET session date of a price observed at `nowMs` from the quote's regular-session last trade. */
export function latestStartedSession(nowMs: number): IsoDate {
  const c = etClock(nowMs);
  const close = sessionCloseMs(c.date);
  if (close != null && isTradingDay(c.date) && c.minutes >= 9 * 60 + 30) return c.date;
  return prevTradingDay(c.date);
}

const CATEGORY_LABELS: Record<MacroCategory, string> = {
  equities: "Equities",
  bonds: "Bonds",
  credit: "Credit",
  commods: "Commodities",
  fx: "FX",
  crypto: "Crypto",
};

const CATEGORY_ORDER: MacroCategory[] = ["equities", "bonds", "credit", "commods", "fx", "crypto"];
const TAPE_ORDER: MacroCategory[] = ["equities", "crypto", "fx", "commods", "bonds", "credit"];

export interface MacroBuilder {
  /** Build a snapshot; concurrent calls share one build. */
  build(): Promise<MacroResponse>;
  /** Drop cached history (all symbols, or one) so the next build re-reads it. */
  invalidateHistory(symbol?: string): void;
}

export function createMacroBuilder(deps: MacroDeps, universe: TickerDef[] = UNIVERSE): MacroBuilder {
  const history = new Map<string, HistoryEntry>();
  const failures = new Map<string, HistoryFailure>();
  const historyInFlight = new Map<string, Promise<void>>();
  let buildInFlight: Promise<MacroResponse> | null = null;

  const needsRead = (sym: string, key: IsoDate, now: number): boolean => {
    const f = failures.get(sym);
    if (f && now - f.at < FAIL_BACKOFF_MS) return false;
    const e = history.get(sym);
    if (!e) return true;
    if (e.key !== key) return true;
    if (!e.complete) return now - e.fetchedAt >= INCOMPLETE_RETRY_MS;
    return now - e.fetchedAt >= HISTORY_MAX_AGE_MS;
  };

  const readHistory = (sym: string, key: IsoDate): Promise<void> => {
    const running = historyInFlight.get(sym);
    if (running) return running;
    const p = (async () => {
      try {
        const r = await deps.getDailyBars(sym);
        const now = deps.now();
        // Completed sessions only: today's forming bar is never kept.
        const bars = (r?.bars ?? [])
          .filter((b) => b && Number.isFinite(b.t) && Number.isFinite(b.c) && b.c > 0)
          .map((b) => ({ t: b.t, c: b.c, date: dailyBarSessionDate(b.t) }))
          .filter((b) => b.date <= key)
          .sort((a, b) => a.t - b.t);
        if (bars.length === 0) {
          failures.set(sym, { at: now, reason: r?.reason || (r?.dataState === "empty" ? "Schwab returned no daily bars" : "daily history unavailable") });
          return;
        }
        failures.delete(sym);
        history.set(sym, { key, bars, fetchedAt: now, complete: bars[bars.length - 1].date === key });
      } catch (e: any) {
        failures.set(sym, { at: deps.now(), reason: `daily history read failed: ${e?.message ?? e}` });
      }
    })().finally(() => { historyInFlight.delete(sym); });
    historyInFlight.set(sym, p);
    return p;
  };

  const historyFor = (sym: string, key: IsoDate): HistoryRead => {
    const e = history.get(sym);
    const f = failures.get(sym);
    if (!e) return { bars: [], state: "none", reason: f?.reason ?? "daily history not read yet" };
    if (e.key === key && e.complete) return { bars: e.bars, state: "fresh", reason: null };
    const why = e.key !== key
      ? `daily history from before ${key}${f ? ` (${f.reason})` : ""}`
      : `the ${key} daily bar was not posted yet`;
    return { bars: e.bars, state: "kept", reason: why };
  };

  async function refreshHistories(symbols: string[], key: IsoDate, now: number): Promise<void> {
    const due = symbols.filter((s) => needsRead(s, key, now));
    for (let i = 0; i < due.length; i += HISTORY_CONCURRENCY) {
      await Promise.all(due.slice(i, i + HISTORY_CONCURRENCY).map((s) => readHistory(s, key)));
    }
  }

  function schwabRow(def: TickerDef, q: QuoteIn | undefined, h: HistoryRead, now: number): MacroQuote {
    const todayEt = etDate(now);
    const open = isRegularSessionOpen(now);
    const closeToday = sessionCloseMs(todayEt);
    const afterSessionClose = closeToday != null && now >= closeToday;
    const notes: string[] = [];
    const base = { category: def.category, symbol: def.symbol, display: def.label, label: def.label };

    // Price: the last regular-session trade. Outside the session the quote's
    // lastPrice can be an extended-hours print, which the old regular-hours
    // bars never showed, so it is used only while the session is open.
    const reg = q?.regularMarketLast != null && Number.isFinite(q.regularMarketLast) && q.regularMarketLast > 0 ? q.regularMarketLast : null;
    const lastOpen = open && q?.last != null && Number.isFinite(q.last) && q.last > 0 ? q.last : null;
    let price: number | null = reg ?? lastOpen;
    let basis: PriceBasis = price != null ? "regular_session_last" : "unavailable";
    let priceSessionDate: IsoDate | null = price != null ? latestStartedSession(now) : null;
    let priceAsOfMs: number | null = price != null ? (q?.quoteTimeMs ?? q?.fetchedAtMs ?? null) : null;
    const stale = price != null && q?.stale === true;
    if (stale) notes.push("quote is stale (older than its window or re-served after a failed refresh)");

    if (price == null && h.bars.length) {
      const last = h.bars[h.bars.length - 1];
      price = last.c;
      basis = "last_daily_close";
      priceSessionDate = last.date;
      priceAsOfMs = sessionCloseMs(last.date);
      notes.push(q ? "quote carried no regular-session price: showing the last completed session's close" : "quote unavailable: showing the last completed session's close");
    }
    if (price == null) {
      return {
        ...base, price: null, prevClose: null, change: null, changePct: null, spark: h.bars.slice(-22).map((b) => b.c),
        basis: "unavailable", dataState: "unavailable",
        reason: [q ? "quote carried no regular-session price" : "quote unavailable", h.reason].filter(Boolean).join("; "),
        priceAsOfMs: null, priceSessionDate: null, stale: false, prevCloseSource: null, prevCloseDate: null,
      };
    }

    const pc = resolvePrevClose({
      priceSessionDate,
      todayEt,
      prevTradingDate: prevTradingDay(todayEt),
      // The quote's close fields only describe the session before today; the
      // resolver uses them only for a price from today's session.
      quote: basis === "regular_session_last" && q
        ? { closePrice: q.prevClose ?? null, lastPrice: q.last, netChange: q.change, regularMarketLast: q.regularMarketLast ?? null }
        : null,
      dailyBars: h.bars.length ? h.bars : null,
      afterSessionClose,
    });
    if (pc.prevClose == null) notes.push(pc.reason ?? "prior close unavailable");
    if (h.state !== "fresh" && h.reason) notes.push(h.reason);
    const { change, changePct } = dayChange(price, pc.prevClose);

    const closes = h.bars.map((b) => b.c);
    const lastBarDate = h.bars.length ? h.bars[h.bars.length - 1].date : null;
    const spark = (priceSessionDate && (!lastBarDate || priceSessionDate > lastBarDate)) ? [...closes, price] : closes;

    const partial = basis !== "regular_session_last" || stale || pc.prevClose == null;
    return {
      ...base, price, prevClose: pc.prevClose, change, changePct, spark: spark.slice(-22),
      basis, dataState: partial ? "partial" : "ok", reason: notes.length ? notes.join("; ") : null,
      priceAsOfMs, priceSessionDate, stale,
      prevCloseSource: pc.source, prevCloseDate: pc.prevCloseDate,
    };
  }

  async function fallbackRow(def: TickerDef): Promise<MacroQuote> {
    const base = { category: def.category, symbol: def.symbol, display: def.label, label: def.label };
    let fb: FallbackIn | null = null;
    try { fb = await deps.getFallback(def); } catch { fb = null; }
    if (!fb || fb.price == null || !Number.isFinite(fb.price)) {
      return {
        ...base, price: null, prevClose: null, change: null, changePct: null, spark: [],
        basis: "unavailable", dataState: "unavailable", reason: "public source unavailable",
        priceAsOfMs: null, priceSessionDate: null, stale: false, prevCloseSource: null, prevCloseDate: null,
      };
    }
    const { change, changePct } = dayChange(fb.price, fb.prevClose);
    return {
      ...base, price: fb.price, prevClose: fb.prevClose, change, changePct, spark: (fb.spark ?? []).slice(-22),
      basis: "public_fallback", dataState: fb.prevClose == null ? "partial" : "ok",
      reason: fb.prevClose == null ? "prior close unavailable" : null,
      priceAsOfMs: null, priceSessionDate: null, stale: false, prevCloseSource: null, prevCloseDate: null,
    };
  }

  async function buildOnce(): Promise<MacroResponse> {
    const now = deps.now();
    const key = lastCompletedSession(now);
    const schwabDefs = universe.filter(schwabCovers);
    const syms = schwabDefs.map((d) => d.symbol);

    const [quotes] = await Promise.all([
      deps.getQuotes(syms).catch(() => [] as QuoteIn[]),
      refreshHistories(syms, key, now),
    ]);
    const bySym = new Map((quotes ?? []).map((q) => [String(q.symbol).toUpperCase(), q]));
    const rowNow = deps.now();

    const rows = await Promise.all(universe.map((def) =>
      schwabCovers(def)
        ? Promise.resolve(schwabRow(def, bySym.get(def.symbol.toUpperCase()), historyFor(def.symbol, key), rowNow))
        : fallbackRow(def)));

    const groups = CATEGORY_ORDER.map((cat) => ({
      category: cat, label: CATEGORY_LABELS[cat], quotes: rows.filter((q) => q.category === cat),
    })).filter((g) => g.quotes.length > 0);
    const tape = TAPE_ORDER.flatMap((cat) => rows.filter((q) => q.category === cat));
    return {
      asOf: Math.floor(rowNow / 1000),
      sessionOpen: isRegularSessionOpen(rowNow),
      coverage: {
        total: rows.length,
        ok: rows.filter((r) => r.dataState === "ok").length,
        partial: rows.filter((r) => r.dataState === "partial").length,
        unavailable: rows.filter((r) => r.dataState === "unavailable").length,
      },
      groups,
      tape,
    };
  }

  return {
    build(): Promise<MacroResponse> {
      if (buildInFlight) return buildInFlight;
      // Cleared on success AND failure, so one rejected build cannot poison later ones.
      const p = buildOnce().finally(() => { if (buildInFlight === p) buildInFlight = null; });
      buildInFlight = p;
      return p;
    },
    invalidateHistory(symbol?: string): void {
      if (symbol) { history.delete(symbol); failures.delete(symbol); }
      else { history.clear(); failures.clear(); }
    },
  };
}
