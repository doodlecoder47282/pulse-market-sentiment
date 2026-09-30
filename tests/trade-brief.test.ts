import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStockTradeBrief, createTradeBriefService, registerTradeBriefRoutes } from "../server/tradeBrief";
import {
  BriefRequestSchema, SearchRequestSchema, TRADE_BRIEF_CATEGORIES, TRADE_BRIEF_INSTRUMENTS,
  TradeBriefSchema, searchTradeBriefInstruments, tradeBriefExpired,
} from "../shared/tradeBrief";
import { etEpochMs } from "../server/etTime";
import type { Express } from "express";

const now = Date.parse("2026-09-30T15:00:30Z");
const stock = TRADE_BRIEF_INSTRUMENTS.find(i => i.symbol === "AAPL")!;
const etf = TRADE_BRIEF_INSTRUMENTS.find(i => i.symbol === "SPY")!;
function quote(symbol = "AAPL", patch: Record<string, unknown> = {}) {
  return { [symbol]: { symbol, assetMainType: "EQUITY", realtime: true,
    quote: { lastPrice: 105, tradeTime: now - 10_000, quoteTime: now - 5_000, totalVolume: 0, ...patch } } };
}
function history(symbol = "AAPL") {
  return { symbol, candles: ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29"]
    .map(date => ({ datetime: etEpochMs(date, 0, 0), open: 100, high: 110, low: 90, close: 100, volume: 100 })) };
}
const ok = (value: unknown) => ({ state: "ok" as const, value });
function make(q: unknown = quote(), h: unknown = history(), instrument = stock, horizon: "swing" | "intraday" = "swing", macro: unknown = []) {
  return buildStockTradeBrief(instrument, horizon, { quote: ok(q), history: ok(h), macro: ok(macro) }, now);
}
function category(brief: ReturnType<typeof make>, c: string) { return brief.source_statuses.find(s => s.category === c)!; }

test("lookup requires exact explicit selection; Alphabet classes remain separate; no ticker fallback", () => {
  const alphabet = searchTradeBriefInstruments("Alphabet");
  assert.equal(alphabet.requires_selection, true);
  assert.deepEqual(alphabet.instruments.map(i => i.symbol).sort(), ["GOOG", "GOOGL"]);
  assert.equal(searchTradeBriefInstruments("aapl").instruments[0].id, stock.id);
  assert.equal(searchTradeBriefInstruments("Apple").instruments[0].symbol, "AAPL");
  assert.equal(searchTradeBriefInstruments("not-a-security").total, 0);
  assert.equal(searchTradeBriefInstruments("bitcoin").total, 0);
  assert.equal(searchTradeBriefInstruments("").total, 0);
  assert.ok(searchTradeBriefInstruments("a").instruments.length <= 8);
  assert.equal(SearchRequestSchema.safeParse({ q: "x".repeat(65) }).success, false);
  assert.equal(SearchRequestSchema.safeParse({ q: ["SPY", "AAPL"] }).success, false);
  assert.equal(BriefRequestSchema.safeParse({ instrument_id: stock.id, horizon: "weekly" }).success, false);
  assert.equal(BriefRequestSchema.safeParse({ instrument_id: stock.id, url: "http://example.com" }).success, false);
});

test("all eight coverage modules, deterministic version, reviewed pivot math and evidence IDs", () => {
  const brief = make();
  assert.equal(TradeBriefSchema.safeParse(brief).success, true);
  assert.deepEqual(brief.source_statuses.map(s => s.category), [...TRADE_BRIEF_CATEGORIES]);
  assert.equal(brief.verdict, "WATCH");
  assert.equal(brief.quote?.value, 105);
  assert.deepEqual(brief.levels.map(l => l.value), [90, 100, 110]);
  assert.ok(brief.thesis.includes("above"));
  const ids = new Set(brief.evidence.map(e => e.id));
  for (const l of brief.levels) {
    assert.equal(l.purpose, "structure_reference_only");
    assert.ok(l.evidence_ids.every(id => ids.has(id)));
    assert.ok(l.period.includes("2026-09-21"));
    assert.ok(l.formula_id.includes("classic:"));
  }
  for (const s of brief.source_statuses) assert.ok(s.evidence_ids.every(id => ids.has(id)));
  for (const claim of brief.claims) assert.ok(claim.evidence_ids.every(id => ids.has(id)));
  assert.equal(brief.risk.planned_loss, null);
  assert.equal(brief.risk.scenario_reward_risk, null);
  assert.equal(brief.model_version, "none");
  assert.equal(brief.explanation.status, "deterministic");
});

test("observed volume zero differs from missing; earnings dates are never synthesized", () => {
  const brief = make();
  assert.equal(brief.evidence.find(e => e.id === "quote-volume")?.value, 0);
  assert.equal(category(brief, "volume").status, "partial");
  const missing = make(quote("AAPL", { totalVolume: undefined }));
  assert.equal(category(missing, "volume").status, "missing");
  assert.equal(missing.evidence.some(e => e.id === "quote-volume"), false);
  assert.equal(category(brief, "earnings").status, "unavailable");
  assert.ok(brief.counterevidence[0].includes("unknown"));
  const fund = make(quote("SPY"), history("SPY"), etf);
  assert.equal(category(fund, "earnings").status, "not_applicable");
  assert.ok(category(fund, "earnings").reason.includes("Holdings"));
  assert.ok(fund.events.every(e => !/\d{4}-\d{2}-\d{2}/.test(e.text)));
});

test("missing, stale, delayed, future, wrong symbol/currency and non-finite quotes fail closed", () => {
  const fixtures = [
    null, quote("AAPL", { lastPrice: 0 }), quote("AAPL", { lastPrice: NaN }), quote("AAPL", { lastPrice: Infinity }),
    quote("AAPL", { tradeTime: undefined }), quote("AAPL", { tradeTime: now + 1 }),
    quote("AAPL", { tradeTime: now - 301_000, quoteTime: now }), quote("SPY"),
    { AAPL: { ...quote().AAPL, symbol: "MSFT" } },
    { AAPL: { ...quote().AAPL, realtime: false } },
    { AAPL: { ...quote().AAPL, realtime: undefined } },
    { AAPL: { ...quote().AAPL, synthetic: true } },
    { AAPL: { ...quote().AAPL, reference: { currency: "EUR" } } },
  ];
  for (const q of fixtures) {
    const b = make(q);
    assert.equal(b.verdict, "INSUFFICIENT DATA");
    assert.equal(b.quote, null);
    assert.equal(b.levels.length, 0);
    assert.equal(b.risk.planned_loss, null);
  }
  const old = make(quote("AAPL", { tradeTime: now - 301_000, quoteTime: now }));
  assert.equal(category(old, "quote").status, "stale"); // fresh bid timestamp cannot refresh old last trade
  assert.equal(old.evidence.find(e => e.id === "quote-last")?.observed_at, new Date(now - 301_000).toISOString());
  const delayed = make({ AAPL: { ...quote().AAPL, realtime: false } });
  assert.equal(category(delayed, "quote").status, "delayed");
});

test("horizons have distinct source periods/freshness and snapshot IDs", () => {
  const swing = make(), day = make(quote(), history(), stock, "intraday");
  assert.notEqual(swing.snapshot_id, day.snapshot_id);
  assert.ok(day.levels[0].period.includes("2026-09-29"));
  const old = quote("AAPL", { tradeTime: now - 61_000 });
  assert.equal(make(old).verdict, "WATCH");
  assert.equal(make(old, history(), stock, "intraday").verdict, "INSUFFICIENT DATA");
});

test("invalid or incomplete history never falls back to arbitrary older periods", () => {
  const missingFriday = history();
  missingFriday.candles = missingFriday.candles.filter(c => c.datetime !== etEpochMs("2026-09-25", 0, 0));
  assert.equal(make(quote(), missingFriday).levels.length, 0);
  assert.equal(category(make(quote(), missingFriday), "levels").status, "stale");
  for (const h of [
    { ...history(), symbol: "SPY" },
    { ...history(), synthetic: true },
    { ...history(), candles: [...history().candles, history().candles[0]] },
    { ...history(), candles: history().candles.map(c => ({ ...c, high: 0 })) },
    { ...history(), candles: history().candles.map(c => ({ ...c, close: 200 })) },
    { ...history(), candles: history().candles.map(c => ({ ...c, high: 100, low: 100 })) },
  ]) assert.equal(make(quote(), h).levels.length, 0);
});

test("macro carries dated evidence and stale values cannot contribute; missing isn't zero", () => {
  const b = make(quote(), history(), stock, "swing", [
    { seriesId: "DGS2", latest: 0, latestDate: "2026-09-29" },
    { seriesId: "DGS10", latest: 4, latestDate: "2026-08-01" },
    { seriesId: "DTWEXBGS", latest: null, latestDate: "2026-09-29" },
    { seriesId: "BAMLH0A0HYM2", latest: 3, latestDate: "2027-01-01" },
  ]);
  assert.equal(category(b, "macro").status, "partial");
  assert.equal(b.evidence.find(e => e.id === "macro-DGS2")?.value, 0);
  assert.equal(b.evidence.find(e => e.id === "macro-DGS10")?.status, "stale");
  assert.equal(b.evidence.filter(e => e.category === "macro").length, 2);
  assert.equal(category(make(), "macro").status, "missing");
});

test("expiry uses consumed source deadlines, not fetch time", () => {
  const b = make(quote("AAPL", { tradeTime: now - 299_000 }));
  assert.equal(Date.parse(b.expires_at), now + 1_000);
  assert.equal(tradeBriefExpired(b, now), false);
  assert.equal(tradeBriefExpired(b, now + 1_000), true);
  assert.equal(tradeBriefExpired({ expires_at: "not a time" }), true);
});

test("immutable cache, deduplication and no automatic model call or retries", async () => {
  let time = now, quotes = 0, histories = 0, macros = 0;
  const service = createTradeBriefService({
    now: () => time,
    quote: async () => { quotes++; return quote(); },
    history: async () => { histories++; return history(); },
    macro: async () => { macros++; return []; },
  });
  const [a, b] = await Promise.all([service.analyze(stock.id, "swing"), service.analyze(stock.id, "swing")]);
  assert.equal(a, b);
  assert.deepEqual([quotes, histories, macros], [1, 1, 1]);
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.source_statuses));
  assert.equal(await service.analyze(stock.id, "swing"), a);
  time += 46_000;
  const c = await service.analyze(stock.id, "swing");
  assert.notEqual(c.snapshot_id, a.snapshot_id);
  assert.deepEqual([quotes, histories, macros], [2, 2, 2]);
  await assert.rejects(service.analyze("http://arbitrary.example", "swing"));
});

test("timeouts retain underlying slots and source failures are sanitized", async () => {
  let time = now, calls = 0;
  const stuck = new Promise<unknown>(() => {});
  const service = createTradeBriefService({
    now: () => time, timeoutMs: 5,
    quote: () => { calls++; return stuck; },
    history: () => { calls++; return stuck; },
    macro: async () => { throw new Error("secret=DO_NOT_RETURN"); },
  });
  const a = await service.analyze(stock.id, "swing");
  assert.equal(a.verdict, "INSUFFICIENT DATA");
  assert.equal(category(a, "quote").status, "unavailable");
  assert.equal(JSON.stringify(a).includes("DO_NOT_RETURN"), false);
  time += 50_000;
  await service.analyze(stock.id, "intraday");
  assert.equal(calls, 2); // no replacing unfinished provider reads after deadline
});

test("read-only registrar validates query shape/identity and redacts failures", async () => {
  const routes = new Map<string, Function>();
  const app = { get(path: string, fn: Function) { routes.set(path, fn); } } as unknown as Express;
  let calls = 0;
  registerTradeBriefRoutes(app, { analyze: async () => { calls++; throw new Error("PRIVATE_TOKEN"); } });
  function response() {
    return { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string>,
      setHeader(k: string, v: string) { this.headers[k] = v; return this; },
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) { this.body = value; return this; } };
  }
  assert.deepEqual([...routes.keys()], ["/api/trade-brief/search", "/api/trade-brief"]);
  const bad = response();
  await routes.get("/api/trade-brief")!({ query: { instrument_id: "AAPL" } }, bad);
  assert.equal(bad.statusCode, 404);
  assert.equal(calls, 0);
  const array = response();
  await routes.get("/api/trade-brief/search")!({ query: { q: ["SPY", "AAPL"] } }, array);
  assert.equal(array.statusCode, 400);
  const good = response();
  await routes.get("/api/trade-brief")!({ query: { instrument_id: stock.id, horizon: "swing" } }, good);
  assert.equal(good.statusCode, 503);
  assert.equal(good.headers["Cache-Control"], "no-store");
  assert.equal(JSON.stringify(good.body).includes("PRIVATE_TOKEN"), false);
  for (let i = 0; i < 30; i++) await routes.get("/api/trade-brief")!({ query: { instrument_id: stock.id } }, response());
  const limited = response();
  await routes.get("/api/trade-brief")!({ query: { instrument_id: stock.id } }, limited);
  assert.equal(limited.statusCode, 429);
});
