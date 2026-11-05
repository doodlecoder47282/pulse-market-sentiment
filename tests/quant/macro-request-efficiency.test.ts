// Macro strip request efficiency and price meaning (server/macroCore.ts).
// Every upstream call goes through injected doubles, so the counts below are
// the requests the strip would send: one batched quote per build, daily
// history only when a completed session is missing.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createMacroBuilder, SCHWAB_SYMBOLS, UNIVERSE, INCOMPLETE_RETRY_MS, FAIL_BACKOFF_MS, HISTORY_MAX_AGE_MS,
  type MacroDeps, type QuoteIn, type DailyBarsIn, type MacroQuote,
} from "../../server/macroCore.ts";

// November 2026 is EST (UTC-5). Wed 2026-11-04 is a regular session;
// Thu 11-26 Thanksgiving (closed); Fri 11-27 closes at 13:00 ET.
const et = (date: string, hh: number, mm = 0) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hh + 5, mm);
};
/** Schwab stamps daily candles at midnight Central (06:00 UTC in EST). */
const bar = (date: string, c: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return { t: Date.UTC(y, m - 1, d, 6) / 1000, c };
};
const SESSIONS = ["2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
/** Close for a symbol on a session: distinct per day so a wrong session shows. */
const closeOf = (sym: string, date: string) => 100 + SESSIONS.indexOf(date) + (sym.charCodeAt(0) % 7) / 10;

interface Harness {
  deps: MacroDeps;
  clock: { t: number };
  quoteCalls: string[][];
  dailyCalls: Map<string, number>;
  /** Sessions whose daily bar the double returns (includes a forming bar if listed). */
  barsUpTo: { date: string };
  quotes: (syms: string[]) => QuoteIn[];
  dailyFail: Set<string>;
}

function harness(start: number, quoteFn?: (syms: string[], now: number) => QuoteIn[]): Harness {
  const clock = { t: start };
  const quoteCalls: string[][] = [];
  const dailyCalls = new Map<string, number>();
  const barsUpTo = { date: "2026-11-04" };
  const dailyFail = new Set<string>();
  const h: Harness = {
    clock, quoteCalls, dailyCalls, barsUpTo, dailyFail,
    quotes: (syms) => (quoteFn ?? defaultQuotes)(syms, clock.t),
    deps: {
      now: () => clock.t,
      getQuotes: async (syms) => { quoteCalls.push(syms); return h.quotes(syms); },
      getDailyBars: async (sym): Promise<DailyBarsIn> => {
        dailyCalls.set(sym, (dailyCalls.get(sym) ?? 0) + 1);
        if (dailyFail.has(sym)) throw new Error("Schwab 500");
        return { bars: SESSIONS.filter((d) => d <= barsUpTo.date).map((d) => bar(d, closeOf(sym, d))), dataState: "ok" };
      },
      getFallback: async () => ({ price: 1, prevClose: 1, spark: [1, 1] }),
    },
  };
  return h;
}

/** Quote during or after Wed 11-04: closePrice = Tue's close (not rolled), regular last = 200. */
function defaultQuotes(syms: string[]): QuoteIn[] {
  return syms.map((s) => ({
    symbol: s, last: 200, change: 200 - closeOf(s, "2026-11-03"), prevClose: closeOf(s, "2026-11-03"),
    regularMarketLast: 200, quoteTimeMs: et("2026-11-04", 15, 59), fetchedAtMs: null, stale: false,
  }));
}
const totalDaily = (h: Harness) => Array.from(h.dailyCalls.values()).reduce((a, b) => a + b, 0);
const row = (r: { tape: MacroQuote[] }, sym: string) => {
  const q = r.tape.find((x) => x.symbol === sym);
  assert.ok(q, `${sym} listed`);
  return q!;
};

test("macro: the Schwab symbol list is derived from the universe (17), commodities name their ETF", () => {
  assert.equal(SCHWAB_SYMBOLS.length, 17);
  assert.equal(SCHWAB_SYMBOLS.length, UNIVERSE.filter((d) => d.category !== "fx" && d.category !== "crypto").length);
  for (const d of UNIVERSE.filter((x) => x.category === "commods")) {
    assert.match(d.label, new RegExp(`\\(${d.symbol}\\)$`), `${d.label} names its fund`);
  }
});

test("macro: cold start = 1 batched quote + 1 history read per symbol; warm rebuild = 1 quote, 0 history", async () => {
  const h = harness(et("2026-11-04", 23, 30));
  const b = createMacroBuilder(h.deps);
  await b.build();
  assert.equal(h.quoteCalls.length, 1, "one quote request");
  assert.deepEqual([...h.quoteCalls[0]].sort(), [...SCHWAB_SYMBOLS].sort(), "the quote request carries every Schwab symbol");
  assert.equal(totalDaily(h), 17, "cold start: one history read per symbol");
  h.clock.t += 5 * 60_000;
  await b.build();
  assert.equal(h.quoteCalls.length, 2);
  assert.equal(totalDaily(h), 17, "warm: no history re-read");
  // The old plan: 2 history requests per symbol on every build = 34 per build.
});

test("macro: concurrent builds share one build; a failed build does not poison the next", async () => {
  const h = harness(et("2026-11-04", 23, 30));
  const b = createMacroBuilder(h.deps);
  const [a, c] = await Promise.all([b.build(), b.build()]);
  assert.equal(a, c, "same snapshot object");
  assert.equal(h.quoteCalls.length, 1);
  assert.equal(totalDaily(h), 17);

  let fail = true;
  const h2 = harness(et("2026-11-04", 23, 30));
  const inner = h2.deps.getQuotes;
  h2.deps.getQuotes = (syms) => { if (fail) throw new Error("boom"); return inner(syms); };
  const b2 = createMacroBuilder(h2.deps);
  const results = await Promise.allSettled([b2.build(), b2.build()]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"], "both callers see the one failure");
  fail = false;
  const ok = await b2.build();
  assert.equal(ok.coverage.total, UNIVERSE.length, "the next build runs");
});

test("macro: a symbol missing from the batch shows its last close, labelled; with no history it stays listed as unavailable", async () => {
  const h = harness(et("2026-11-04", 23, 30), (syms) => defaultQuotes(syms).filter((q) => q.symbol !== "GLD" && q.symbol !== "WEAT"));
  h.dailyFail.add("WEAT");
  const r = await createMacroBuilder(h.deps).build();
  const gld = row(r, "GLD");
  assert.equal(gld.basis, "last_daily_close");
  assert.equal(gld.dataState, "partial");
  assert.equal(gld.price, closeOf("GLD", "2026-11-04"));
  assert.equal(gld.priceSessionDate, "2026-11-04");
  assert.match(gld.reason ?? "", /quote unavailable/);
  const weat = row(r, "WEAT");
  assert.equal(weat.dataState, "unavailable");
  assert.equal(weat.price, null);
  assert.match(weat.reason ?? "", /Schwab 500/);
  assert.equal(row(r, "SPY").dataState, "ok", "the other rows stay usable");
  assert.equal(r.coverage.unavailable, 1);
  assert.equal(r.coverage.partial, 1);
  assert.equal(r.coverage.ok, UNIVERSE.length - 2);
});

test("macro: quote failure with cached history keeps the close's own age, never the build time", async () => {
  const h = harness(et("2026-11-04", 23, 30));
  const b = createMacroBuilder(h.deps);
  await b.build();
  h.quotes = () => [];
  h.clock.t += 60_000;
  const r = await b.build();
  for (const q of r.tape.filter((x) => SCHWAB_SYMBOLS.includes(x.symbol))) {
    assert.equal(q.basis, "last_daily_close", q.symbol);
    assert.equal(q.priceAsOfMs, et("2026-11-04", 16), `${q.symbol}: dated at that session's close`);
    assert.notEqual(q.priceAsOfMs, h.clock.t);
    // Prior close for a 11-04 price is the 11-03 bar.
    assert.equal(q.prevClose, closeOf(q.symbol, "2026-11-03"));
    assert.equal(q.prevCloseSource, "daily_bar");
  }
  assert.equal(totalDaily(h), 17, "no history re-read on a quote failure");
});

test("macro: during the session the forming daily bar is never stored; prior close and change are the quote's", async () => {
  const h = harness(et("2026-11-04", 11, 0));
  h.barsUpTo.date = "2026-11-04"; // the vendor returns today's partial bar too
  const b = createMacroBuilder(h.deps);
  const r = await b.build();
  const spy = row(r, "SPY");
  assert.equal(r.sessionOpen, true);
  assert.equal(spy.basis, "regular_session_last");
  assert.equal(spy.price, 200);
  assert.equal(spy.prevClose, closeOf("SPY", "2026-11-03"));
  assert.equal(spy.prevCloseSource, "schwab_quote_close");
  assert.equal(spy.change, 200 - closeOf("SPY", "2026-11-03"), "change = price - prior close");
  assert.ok(Math.abs((spy.changePct ?? 0) - ((200 / closeOf("SPY", "2026-11-03")) - 1) * 100) < 1e-9);
  assert.equal(spy.spark[spy.spark.length - 1], 200, "sparkline ends at the current price");
  assert.equal(spy.spark[spy.spark.length - 2], closeOf("SPY", "2026-11-03"), "the forming 11-04 bar is not in the history");
  assert.ok(!spy.spark.includes(closeOf("SPY", "2026-11-04")));
  assert.equal(spy.dataState, "ok");
});

test("macro: session close re-reads history once; a late vendor bar is retried every 10 min, not every poll", async () => {
  const h = harness(et("2026-11-04", 15, 50));
  const b = createMacroBuilder(h.deps);
  await b.build();
  assert.equal(totalDaily(h), 17);
  h.barsUpTo.date = "2026-11-03"; // Schwab has not posted 11-04 yet
  h.clock.t = et("2026-11-04", 16, 1);
  await b.build();
  assert.equal(totalDaily(h), 34, "session completed: one re-read per symbol");
  h.clock.t = et("2026-11-04", 16, 5);
  await b.build();
  assert.equal(totalDaily(h), 34, "incomplete copy is not re-read on every poll");
  const kept = row(await b.build(), "SPY");
  assert.match(kept.reason ?? "", /11-04 daily bar was not posted yet/);
  h.barsUpTo.date = "2026-11-04";
  h.clock.t = et("2026-11-04", 16, 1) + INCOMPLETE_RETRY_MS;
  await b.build();
  assert.equal(totalDaily(h), 51, "retried after the interval");
  h.clock.t += 60_000;
  await b.build();
  assert.equal(totalDaily(h), 51, "complete now: no further reads");
  h.clock.t = et("2026-11-04", 16, 11) + HISTORY_MAX_AGE_MS;
  await b.build();
  assert.equal(totalDaily(h), 68, "a complete copy is still refreshed after the maximum age (vendor corrections)");
});

test("macro: a failed history read backs off instead of retrying on each poll", async () => {
  const h = harness(et("2026-11-04", 23, 30));
  h.dailyFail.add("SPY");
  const b = createMacroBuilder(h.deps);
  await b.build();
  assert.equal(h.dailyCalls.get("SPY"), 1);
  h.clock.t += 30_000;
  await b.build();
  h.clock.t += 30_000;
  await b.build();
  assert.equal(h.dailyCalls.get("SPY"), 1, "no retry inside the backoff");
  h.clock.t = et("2026-11-04", 23, 30) + FAIL_BACKOFF_MS;
  h.dailyFail.delete("SPY");
  await b.build();
  assert.equal(h.dailyCalls.get("SPY"), 2, "retried after the backoff");
});

test("macro: invalidateHistory forces one re-read", async () => {
  const h = harness(et("2026-11-04", 23, 30));
  const b = createMacroBuilder(h.deps);
  await b.build();
  b.invalidateHistory("TLT");
  await b.build();
  assert.equal(h.dailyCalls.get("TLT"), 2);
  assert.equal(totalDaily(h), 18);
  b.invalidateHistory();
  await b.build();
  assert.equal(totalDaily(h), 35);
});

test("macro: after the close a rolled quote close is caught by the daily bars (no false flat day)", async () => {
  // Schwab rolled closePrice to TODAY's close: last - closePrice would read ~0.
  const h = harness(et("2026-11-04", 23, 30), (syms) => syms.map((s) => ({
    symbol: s, last: closeOf(s, "2026-11-04"), change: 0, prevClose: closeOf(s, "2026-11-04"),
    regularMarketLast: closeOf(s, "2026-11-04"), quoteTimeMs: et("2026-11-04", 16), fetchedAtMs: null, stale: false,
  })));
  const spy = row(await createMacroBuilder(h.deps).build(), "SPY");
  assert.equal(spy.prevClose, closeOf("SPY", "2026-11-03"));
  assert.equal(spy.prevCloseSource, "daily_bar");
  assert.ok((spy.change ?? 0) > 0.9, "the real day change, not zero");
});

test("macro: after the close an extended-hours print is not shown as the regular-session price", async () => {
  const h = harness(et("2026-11-04", 19, 0), (syms) => syms.map((s) => ({
    symbol: s, last: 205, change: 5, prevClose: closeOf(s, "2026-11-03"),
    regularMarketLast: 200, quoteTimeMs: et("2026-11-04", 18, 59), fetchedAtMs: null, stale: false,
  })));
  const r = await createMacroBuilder(h.deps).build();
  assert.equal(r.sessionOpen, false);
  assert.equal(row(r, "SPY").price, 200);

  const h2 = harness(et("2026-11-04", 19, 0), (syms) => syms.map((s) => ({
    symbol: s, last: 205, change: 5, prevClose: closeOf(s, "2026-11-03"),
    regularMarketLast: null, quoteTimeMs: et("2026-11-04", 18, 59), fetchedAtMs: null, stale: false,
  })));
  const spy = row(await createMacroBuilder(h2.deps).build(), "SPY");
  assert.equal(spy.basis, "last_daily_close", "no regular-session price after hours: the close, labelled");
  assert.equal(spy.price, closeOf("SPY", "2026-11-04"));
});

test("macro: weekend, pre-market, holiday and early close date the price and prior close correctly", async () => {
  // Saturday: Friday's session vs Thursday's close; the quote close is not used.
  const sat = harness(et("2026-11-07", 12, 0), (syms) => syms.map((s) => ({
    symbol: s, last: closeOf(s, "2026-11-06"), change: 0, prevClose: closeOf(s, "2026-11-06"),
    regularMarketLast: closeOf(s, "2026-11-06"), quoteTimeMs: et("2026-11-06", 16), fetchedAtMs: null, stale: false,
  })));
  sat.barsUpTo.date = "2026-11-06";
  const s = row(await createMacroBuilder(sat.deps).build(), "SPY");
  assert.equal(s.priceSessionDate, "2026-11-06");
  assert.equal(s.prevClose, closeOf("SPY", "2026-11-05"));
  assert.equal(s.prevCloseSource, "daily_bar");

  // Thursday 08:00 ET (pre-market): the price is Wednesday's regular close, compared with Tuesday.
  const pre = harness(et("2026-11-05", 8, 0), (syms) => syms.map((x) => ({
    symbol: x, last: 210, change: 0, prevClose: closeOf(x, "2026-11-04"),
    regularMarketLast: closeOf(x, "2026-11-04"), quoteTimeMs: et("2026-11-05", 7, 59), fetchedAtMs: null, stale: false,
  })));
  const p = row(await createMacroBuilder(pre.deps).build(), "SPY");
  assert.equal(p.priceSessionDate, "2026-11-04");
  assert.equal(p.price, closeOf("SPY", "2026-11-04"), "not the 210 pre-market print");
  assert.equal(p.prevClose, closeOf("SPY", "2026-11-03"));

  // Thanksgiving noon: no session today; Wednesday 11-25 is the last started session.
  const hol = harness(et("2026-11-26", 12, 0));
  const r = await createMacroBuilder(hol.deps).build();
  assert.equal(r.sessionOpen, false);
  assert.equal(row(r, "SPY").priceSessionDate, "2026-11-25");

  // Friday 11-27 at 14:00 ET: the 13:00 early close has passed.
  const early = harness(et("2026-11-27", 14, 0));
  const e = await createMacroBuilder(early.deps).build();
  assert.equal(e.sessionOpen, false);
});

test("macro: a stale quote keeps its own time and is marked partial", async () => {
  const h = harness(et("2026-11-04", 11, 0), (syms) => defaultQuotes(syms).map((q) => ({ ...q, stale: true, quoteTimeMs: et("2026-11-04", 10, 40) })));
  const spy = row(await createMacroBuilder(h.deps).build(), "SPY");
  assert.equal(spy.stale, true);
  assert.equal(spy.dataState, "partial");
  assert.equal(spy.priceAsOfMs, et("2026-11-04", 10, 40));
  assert.match(spy.reason ?? "", /stale/);
});

test("macro: crypto and FX rows keep their public fallbacks and never reach Schwab", async () => {
  const h = harness(et("2026-11-04", 11, 0));
  const r = await createMacroBuilder(h.deps).build();
  for (const sym of ["BTC-USD", "ETH-USD", "EURUSD=X", "DX-Y.NYB"]) {
    assert.equal(row(r, sym).basis, "public_fallback");
    assert.ok(!h.quoteCalls[0].includes(sym));
    assert.equal(h.dailyCalls.get(sym), undefined);
  }
});
