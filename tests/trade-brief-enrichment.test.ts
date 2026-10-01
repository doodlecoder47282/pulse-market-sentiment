import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStockTradeBrief, createTradeBriefService } from "../server/tradeBrief";
import { TRADE_BRIEF_INSTRUMENTS, TradeBriefSchema } from "../shared/tradeBrief";
import { etEpochMs } from "../server/etTime";

const now = Date.parse("2026-09-30T15:00:30Z");
const stock = TRADE_BRIEF_INSTRUMENTS.find(i => i.symbol === "AAPL")!;
const ok = (value: unknown) => ({ state: "ok" as const, value });
function quote(patch: Record<string, unknown> = {}) {
  return { AAPL: { symbol: "AAPL", assetMainType: "EQUITY", realtime: true,
    quote: { lastPrice: 105, tradeTime: now - 10_000, quoteTime: now - 5_000, totalVolume: 1000, ...patch } } };
}
function history() {
  const candles: { datetime: number; open: number; high: number; low: number; close: number; volume?: number }[] = [];
  for (let t = Date.parse("2026-08-20T12:00:00Z"); t < Date.parse("2026-09-30T12:00:00Z"); t += 86400_000) {
    const date = new Date(t);
    if ([0, 6].includes(date.getUTCDay())) continue;
    candles.push({ datetime: etEpochMs(date.toISOString().slice(0, 10), 0, 0), open: 100, high: 110, low: 90,
      close: 100, volume: 2000 });
  }
  return { symbol: "AAPL", candles };
}
const macro = [
  { seriesId: "DGS2", latest: 3.5, latestDate: "2026-09-29" },
  { seriesId: "DGS10", latest: 4, latestDate: "2026-09-29" },
];
type Extras = { news?: unknown; earnings?: unknown; options?: ReturnType<typeof ok> };
function make(extras: Extras = {}, q: unknown = quote(), h: unknown = history(), m: unknown = macro) {
  return buildStockTradeBrief(stock, "swing", { quote: ok(q), history: ok(h), macro: ok(m), ...extras }, now);
}
const value = (b: ReturnType<typeof make>, id: string) => b.evidence.find(e => e.id === id)?.value;
const status = (b: ReturnType<typeof make>, category: string) => b.source_statuses.find(s => s.category === category)!;
function news(title = "Apple Inc reports results", source = "Fixture RSS") {
  return { asOf: now / 1000, feeds: [{ source, status: "ok", checked_at: new Date(now - 5000).toISOString(), item_count: 1 }],
    headlines: [{ title, source, url: "https://example.com/article", published: now / 1000 - 120,
      publication_verified: true, tickers: ["AAPL"] }] };
}
function earnings() {
  return { weeks: [{ days: [{ rows: [{ ticker: "AAPL", date: "2026-10-05", timing: "AMC",
    provenance: { source: "Nasdaq", url: "https://api.nasdaq.com/api/calendar/earnings?date=2026-10-05",
      checked_at: new Date(now - 5000).toISOString(), synthetic: false } }] }] }] };
}
function chain() {
  return { symbol: "AAPL", status: "SUCCESS", isDelayed: false,
    underlying: { symbol: "AAPL", quoteTime: now - 20_000 },
    callExpDateMap: { "2026-10-02:2": { "105": [{ symbol: "AAPL  261002C00105000", putCall: "CALL",
      strikePrice: 105, quoteTimeInLong: now - 15_000, bid: 2, ask: 2.1, multiplier: 100, totalVolume: 25 }] } },
    putExpDateMap: { "2026-10-02:2": { "100": [{ symbol: "AAPL  261002P00100000", putCall: "PUT",
      strikePrice: 100, quoteTimeInLong: now - 25_000, bid: 1, ask: 1.1, multiplier: 100, totalVolume: 0 }] } } };
}

test("ATR14 SMA, signed reference distances, full-day volume ratio and matched macro have reproducible evidence", () => {
  const b = make();
  assert.equal(value(b, "atr14"), 20);
  assert.equal(value(b, "distance-pivot"), 5);
  assert.equal(value(b, "distance-atr-pivot"), 0.25);
  assert.equal(value(b, "volume-prior20-mean"), 2000);
  assert.equal(value(b, "volume-session-vs-prior20"), 0.5);
  assert.equal(value(b, "macro-10y-2y"), 0.5);
  assert.equal(b.evidence.find(e => e.id === "atr14")?.evidence_ids?.length, 14);
  assert.ok(b.thesis.includes("NOT time-of-day RVOL"));
  assert.ok(b.claims.some(c => c.evidence_ids.includes("factor-atr")));
  assert.equal(b.risk.basis, "withheld");
  assert.ok(TradeBriefSchema.safeParse(b).success);
});

test("today's incomplete candle never enters daily ATR or prior20 baseline; observed zero remains zero", () => {
  const h = history();
  h.candles.push({ datetime: etEpochMs("2026-09-30", 0, 0), open: 100, high: 1000, low: 1, close: 200, volume: 999999 });
  const b = make({}, quote({ totalVolume: 0 }), h);
  assert.equal(value(b, "atr14"), 20);
  assert.equal(value(b, "volume-prior20-mean"), 2000);
  assert.equal(value(b, "volume-session-vs-prior20"), 0);
  delete h.candles.at(-2)!.volume;
  assert.equal(value(make({}, quote(), h), "volume-session-vs-prior20"), undefined);
});

test("history gaps, insufficient samples, delayed quotes and split-like jumps suppress dependent enrichments", () => {
  const gap = history(); gap.candles.splice(-5, 1);
  assert.equal(value(make({}, quote(), gap), "atr14"), undefined);
  assert.equal(value(make({}, quote(), gap), "volume-prior20-mean"), undefined);
  const short = history(); short.candles = short.candles.slice(-10);
  assert.equal(value(make({}, quote(), short), "atr14"), undefined);
  const delayed = quote(); delayed.AAPL.realtime = false;
  assert.equal(value(make({}, delayed), "atr14"), undefined);
  const split = history(); split.candles.at(-1)!.close = 180; split.candles.at(-1)!.high = 200;
  assert.equal(value(make({}, quote(), split), "atr14"), undefined);
});

test("macro spread requires two eligible dates to match; negative values have honest units", () => {
  assert.equal(value(make({}, quote(), history(), [macro[0], { ...macro[1], latestDate: "2026-09-28" }]), "macro-10y-2y"), undefined);
  assert.equal(value(make({}, quote(), history(), [macro[0], { ...macro[1], latest: 3 }]), "macro-10y-2y"), -0.5);
});

test("cached news requires explicit title attribution, healthy fresh feed and actual publication date; tags are ignored", () => {
  assert.equal(status(make({ news: news("General market story") }), "news").contributed, false);
  assert.equal(status(make({ news: news("Apple grows in popularity") }), "news").contributed, false);
  assert.equal(status(make({ news: news("Results from $AAPL") }), "news").status, "partial");
  assert.equal(status(make({ news: news("Results from $AAPLX") }), "news").contributed, false);
  const b = make({ news: news() });
  assert.ok(b.context_items?.some(c => c.category === "news" && c.url === "https://example.com/article"));
  const unhealthy = news(); unhealthy.feeds[0].status = "unavailable";
  assert.equal(status(make({ news: unhealthy }), "news").contributed, false);
  const old = news(); old.headlines[0].published -= 86400;
  assert.equal(status(make({ news: old }), "news").contributed, false);
  const future = news(); future.headlines[0].published += 1000;
  assert.equal(status(make({ news: future }), "news").contributed, false);
  const noFeed = news(); noFeed.feeds = [];
  assert.equal(status(make({ news: noFeed }), "news").contributed, false);
  const fallbackTime = news(); fallbackTime.headlines[0].publication_verified = false;
  assert.equal(status(make({ news: fallbackTime }), "news").contributed, false);
});

test("cached earnings requires exact real-row provenance and calendar URL; unknown timing stays unknown", () => {
  const real = earnings();
  const b = make({ earnings: real });
  assert.equal(status(b, "earnings").status, "partial");
  assert.ok(b.events[0].evidence_ids.includes("earnings-next-collected"));
  assert.equal(status(b, "earnings").observed_at, real.weeks[0].days[0].rows[0].provenance.checked_at);
  const bad = earnings() as any;
  bad.weeks[0].days[0].rows[0].provenance.synthetic = true;
  assert.equal(status(make({ earnings: bad }), "earnings").contributed, false);
  delete bad.weeks[0].days[0].rows[0].provenance;
  assert.equal(status(make({ earnings: bad }), "earnings").contributed, false);
  const unknown = earnings(); unknown.weeks[0].days[0].rows[0].timing = "UNK";
  assert.ok(make({ earnings: unknown }).context_items?.some(c => c.id === "earnings-next-collected" && c.text.includes("timing unknown")));
  const wrong = earnings(); wrong.weeks[0].days[0].rows[0].provenance.url = "https://example.com";
  assert.equal(status(make({ earnings: wrong }), "earnings").contributed, false);
});

test("raw options is bounded descriptive actual sample only; no invented OI, GEX or probabilities", () => {
  const b = make({ options: ok(chain()) });
  assert.equal(status(b, "options").status, "partial");
  assert.equal(status(b, "options").max_age_seconds, 60);
  assert.equal(value(b, "options-sampled-count"), 2);
  assert.equal(value(b, "options-sampled-volume"), 25);
  assert.equal(value(b, "options-atm-call-bid"), 2);
  assert.equal(value(b, "options-atm-put-ask"), 1.1);
  assert.ok(!b.evidence.some(e => /open interest|gamma|wall/i.test(e.label)));
  const missingVolume = chain() as any;
  delete missingVolume.callExpDateMap["2026-10-02:2"]["105"][0].totalVolume;
  delete missingVolume.putExpDateMap["2026-10-02:2"]["100"][0].totalVolume;
  assert.equal(value(make({ options: ok(missingVolume) }), "options-sampled-volume"), undefined);
});

test("options wrong identity, delayed flag, future/stale time, crossed quote and missing standard multiplier fail closed", () => {
  for (const modify of [
    (c: any) => { c.symbol = "MSFT"; },
    (c: any) => { c.underlying.symbol = "MSFT"; },
    (c: any) => { c.isDelayed = true; },
    (c: any) => { delete c.isDelayed; },
    (c: any) => { c.underlying.quoteTime = now + 1; },
    (c: any) => { c.underlying.quoteTime = now - 300_000; },
    (c: any) => { c.underlying.quoteTime = now - 60_000; },
    (c: any) => { for (const map of [c.callExpDateMap, c.putExpDateMap]) for (const e of Object.values(map) as any[]) for (const a of Object.values(e) as any[]) a[0].ask = 0.5; },
    (c: any) => { for (const map of [c.callExpDateMap, c.putExpDateMap]) for (const e of Object.values(map) as any[]) for (const a of Object.values(e) as any[]) delete a[0].multiplier; },
  ]) {
    const c = chain(); modify(c);
    assert.equal(status(make({ options: ok(c) }), "options").contributed, false);
  }
});

test("options never restamps old consumed contract time and options/news/earnings shorten snapshot expiry", () => {
  const c = chain();
  c.callExpDateMap["2026-10-02:2"]["105"][0].quoteTimeInLong = now - 59_999;
  const b = make({ options: ok(c) });
  assert.equal(Date.parse(b.expires_at), now + 1);
  assert.equal(b.evidence.find(e => e.id === "options-sampled-count")?.observed_at, new Date(now - 59_999).toISOString());
  const n = news(); n.feeds[0].checked_at = new Date(now - 899_999).toISOString();
  assert.equal(Date.parse(make({ news: n }).expires_at), now + 1);
  const e = earnings(); e.weeks[0].days[0].rows[0].provenance.checked_at = new Date(now - 1799_999).toISOString();
  assert.equal(Date.parse(make({ earnings: e }).expires_at), now + 1);
});

test("options malformed identity and excess scan budgets cannot create descriptive evidence", () => {
  const mismatch = chain();
  mismatch.callExpDateMap["2026-10-02:2"]["105"][0].symbol = "AAPL  261002C00110000";
  delete (mismatch as any).putExpDateMap;
  assert.equal(status(make({ options: ok(mismatch) }), "options").contributed, false);
  const excess = chain() as any;
  const item = excess.callExpDateMap["2026-10-02:2"]["105"][0];
  excess.callExpDateMap["2026-10-02:2"]["105"] = Array.from({ length: 1001 }, () => ({ ...item }));
  assert.equal(status(make({ options: ok(excess) }), "options").contributed, false);
});

test("semantic validation rejects duplicate IDs/categories, dangling references and identity mismatch", () => {
  const b = make();
  assert.equal(TradeBriefSchema.safeParse({ ...b, evidence: [...b.evidence, b.evidence[0]] }).success, false);
  assert.equal(TradeBriefSchema.safeParse({ ...b, claims: [{ text: "bad", evidence_ids: ["invented"] }] }).success, false);
  assert.equal(TradeBriefSchema.safeParse({ ...b, source_statuses: b.source_statuses.map(s => ({ ...s, category: "quote" })) }).success, false);
  assert.equal(TradeBriefSchema.safeParse({ ...b, instrument_id: "US:STOCK:MSFT" }).success, false);
});

test("null upstream is unavailable; cache-only getSnapshot never fetches and rejects expiry/unknown/replaced IDs", async () => {
  assert.equal(status(make({}, null), "quote").status, "unavailable");
  let time = now, calls = 0;
  const service = createTradeBriefService({
    now: () => time,
    quote: async () => { calls++; return quote(); },
    history: async () => history(), macro: async () => macro,
  });
  assert.equal(service.getSnapshot("unknown"), null);
  assert.equal(calls, 0);
  const b = await service.analyze(stock.id, "swing");
  assert.equal(service.getSnapshot(b.snapshot_id), b);
  assert.ok(Object.isFrozen(service.getSnapshot(b.snapshot_id)));
  assert.equal(calls, 1);
  time = Date.parse(b.expires_at);
  assert.equal(service.getSnapshot(b.snapshot_id), null);
  assert.equal(calls, 1);
  const replacement = await service.analyze(stock.id, "swing");
  assert.equal(service.getSnapshot(b.snapshot_id), null);
  assert.equal(service.getSnapshot(replacement.snapshot_id), replacement);
});

test("cache-only readers are deadline bounded and optional chain reads stay deduplicated", async () => {
  let optionReads = 0;
  const service = createTradeBriefService({
    now: () => now, timeoutMs: 5,
    quote: async () => quote(), history: async () => history(), macro: async () => [],
    options: async () => { optionReads++; return chain(); },
    news: () => new Promise(() => {}), earnings: () => new Promise(() => {}),
  });
  const [a, b] = await Promise.all([service.analyze(stock.id, "swing"), service.analyze(stock.id, "intraday")]);
  assert.equal(optionReads, 1);
  assert.equal(status(a, "news").status, "unavailable");
  assert.equal(status(b, "earnings").status, "unavailable");
});
