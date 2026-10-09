// Round-2 tests: professional-grade news and crypto sources (workstream R2-I).
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/sources-r2.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCES, sourceTable, TIER_RANK } from "../../server/sources/registry";
import { SourceCache, sourceStatus, aggregateState } from "../../server/sources/state";
import {
  parseFeed, parseIcs, parseEdgarAtom, parseEdgarSubmissions, parseUpcomingAuctions,
  auctionPlacementEt, auctionImportance, classifyRelease, familyOfEventName,
} from "../../server/sources/parse";
import { tierItems, mergeTiered, mergeEconEvents, FUTURE_SKEW_MS } from "../../server/sources/merge";
import { secUserAgent } from "../../server/sources/official";

// ─── Registry ──────────────────────────────────────────────────────────────

test("registry: every source has a tier, terms and what it feeds; weak sources say why", () => {
  for (const s of Object.values(SOURCES)) {
    assert.ok(s.name && s.publisher && s.access && s.terms && s.feeds, `${s.id} incomplete`);
    assert.equal(s.cost, "free", `${s.id} must be free (no new paid service)`);
    assert.ok(s.tier in TIER_RANK, s.id);
    if (s.tier === "weak") assert.ok(s.weakReason, `${s.id} weak without a reason`);
  }
  // Official issuers are primary; pump.fun and social are weak; Reddit is dropped.
  for (const id of ["fed_press", "sec_edgar_current", "sec_edgar_submissions", "bls_calendar", "bea_calendar", "treasury_auctions", "cftc_press", "coinbase", "kraken"]) {
    assert.equal(SOURCES[id].tier, "primary", id);
  }
  assert.equal(SOURCES.pumpfun.tier, "weak");
  assert.equal(SOURCES.pumpfun.weakReason, "undocumented frontend API");
  assert.equal(SOURCES.bluesky.weakReason, "social media");
  assert.match(SOURCES.reddit.feeds, /dropped/);
  assert.equal(SOURCES.google_news_reuters.tier, "aggregator");
  // Table sorts most authoritative first.
  const t = sourceTable();
  for (let i = 1; i < t.length; i++) assert.ok(TIER_RANK[t[i - 1].tier] <= TIER_RANK[t[i].tier]);
});

test("SEC User-Agent comes only from the env, needs a contact, is never defaulted", () => {
  assert.equal(secUserAgent({}), null);
  assert.equal(secUserAgent({ BATCAVE_SEC_USER_AGENT: "  " }), null);
  assert.equal(secUserAgent({ BATCAVE_SEC_USER_AGENT: "Batcave" }), null); // no contact email
  assert.equal(secUserAgent({ BATCAVE_SEC_USER_AGENT: "Batcave ops@example.com" }), "Batcave ops@example.com");
});

// ─── RSS / Atom ────────────────────────────────────────────────────────────

const RSS = `<?xml version="1.0"?><rss><channel><title>Federal Reserve</title>
<item><title><![CDATA[Federal Reserve issues FOMC statement]]></title>
<link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm</link>
<guid>monetary20260916a</guid><pubDate>Wed, 16 Sep 2026 18:00:00 GMT</pubDate>
<description>&lt;p&gt;Statement &amp;amp; implementation note&lt;/p&gt;</description><category>Monetary Policy</category></item>
<item><title>Undated notice</title><link>https://example.gov/x</link></item>
<item><title></title><link>https://example.gov/empty</link><pubDate>Wed, 16 Sep 2026 18:00:00 GMT</pubDate></item>
</channel></rss>`;

test("parseFeed: RSS dates read as UTC instants, entities decoded, undated kept as null", () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 2); // the empty-title item is skipped
  assert.equal(items[0].title, "Federal Reserve issues FOMC statement");
  // 18:00 GMT = 2:00 PM EDT, the FOMC statement time.
  assert.equal(items[0].publishedMs, Date.UTC(2026, 8, 16, 18, 0, 0));
  assert.equal(items[0].summary, "Statement & implementation note");
  assert.equal(items[0].category, "Monetary Policy");
  assert.equal(items[1].publishedMs, null); // never stamped with fetch time
});

test("parseFeed: Atom entries with link href and an explicit offset", () => {
  const atom = `<feed><entry><title>X</title><link rel="alternate" href="https://a.example/1"/>
    <id>urn:1</id><updated>2026-10-08T22:30:32-04:00</updated></entry></feed>`;
  const [e] = parseFeed(atom);
  assert.equal(e.link, "https://a.example/1");
  assert.equal(e.publishedMs, Date.UTC(2026, 9, 9, 2, 30, 32));
});

// ─── iCalendar ─────────────────────────────────────────────────────────────

test("parseIcs: TZID Eastern is DST-aware, UTC Z kept, all-day not timed, unknown zone skipped", () => {
  const ics = [
    "BEGIN:VCALENDAR", "X-WR-TIMEZONE:US-Eastern",
    "BEGIN:VEVENT", "UID:cpi-oct", "DTSTART;TZID=US-Eastern:20261014T083000", "SUMMARY:Consumer Price Index for Sept", " ember 2026", "END:VEVENT",
    "BEGIN:VEVENT", "UID:cpi-jan", "DTSTART;TZID=US-Eastern:20260113T083000", "SUMMARY:Consumer Price Index", "END:VEVENT",
    "BEGIN:VEVENT", "UID:gdp", "DTSTART:20261029T123000Z", "SUMMARY:Gross Domestic Product\\, 3rd Quarter 2026 (Advance Estimate)", "END:VEVENT",
    "BEGIN:VEVENT", "UID:allday", "DTSTART;VALUE=DATE:20261102", "SUMMARY:Employment Situation", "END:VEVENT",
    "BEGIN:VEVENT", "UID:float", "DTSTART:20261104T100000", "SUMMARY:Job Openings and Labor Turnover Survey", "END:VEVENT",
    "BEGIN:VEVENT", "UID:paris", "DTSTART;TZID=Europe/Paris:20261104T100000", "SUMMARY:Foreign", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const ev = parseIcs(ics);
  const by = Object.fromEntries(ev.map((e) => [e.uid, e]));
  // 8:30 EDT (UTC-4) on 2026-10-14 = 12:30 UTC; 8:30 EST (UTC-5) on 2026-01-13 = 13:30 UTC.
  assert.equal(by["cpi-oct"].startMs, Date.UTC(2026, 9, 14, 12, 30));
  assert.equal(by["cpi-oct"].summary, "Consumer Price Index for September 2026"); // folded line
  assert.equal(by["cpi-jan"].startMs, Date.UTC(2026, 0, 13, 13, 30));
  assert.equal(by.gdp.startMs, Date.UTC(2026, 9, 29, 12, 30));
  assert.equal(by.gdp.summary, "Gross Domestic Product, 3rd Quarter 2026 (Advance Estimate)");
  assert.equal(by.allday.timed, false);
  // Floating time inherits the Eastern calendar zone: 10:00 EST on 2026-11-04 = 15:00 UTC.
  assert.equal(by.float.startMs, Date.UTC(2026, 10, 4, 15, 0));
  assert.equal(by.paris, undefined); // never guessed
});

test("classifyRelease and familyOfEventName join BLS/BEA titles with Nasdaq names", () => {
  assert.deepEqual(classifyRelease("Consumer Price Index for September 2026").family, "CPI");
  assert.equal(classifyRelease("Employment Situation for September").importance, "HIGH");
  assert.equal(classifyRelease("Gross Domestic Product by State").family, null);
  assert.equal(classifyRelease("Personal Income and Outlays, August 2026").family, "PCE");
  assert.equal(familyOfEventName("Nonfarm Payrolls"), "NFP");
  assert.equal(familyOfEventName("Core CPI m/m"), "CPI");
  assert.equal(familyOfEventName("Initial Jobless Claims"), null);
});

// ─── SEC EDGAR ─────────────────────────────────────────────────────────────

test("parseEdgarAtom: one row per accession, CIK padded, items and acceptance time", () => {
  const xml = `<feed>
  <entry><title>8-K - Apple Inc. (0000320193) (Filer)</title>
   <link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000101/0000320193-26-000101-index.htm"/>
   <summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-10-08 &lt;b&gt;AccNo:&lt;/b&gt; 0000320193-26-000101 &lt;b&gt;Size:&lt;/b&gt; 300 KB&lt;br&gt;Item 2.02: Results of Operations and Financial Condition&lt;br&gt;Item 9.01: Financial Statements and Exhibits</summary>
   <updated>2026-10-08T16:31:05-04:00</updated><category scheme="https://www.sec.gov/" label="form type" term="8-K"/>
   <id>urn:tag:sec.gov,2008:accession-number=0000320193-26-000101</id></entry>
  <entry><title>8-K - Apple Inc. (0000320193) (Subject)</title>
   <link rel="alternate" href="https://www.sec.gov/x"/><summary>AccNo: 0000320193-26-000101</summary>
   <updated>2026-10-08T16:31:05-04:00</updated><id>urn:tag:sec.gov,2008:accession-number=0000320193-26-000101</id></entry>
  </feed>`;
  const f = parseEdgarAtom(xml);
  assert.equal(f.length, 1);
  assert.equal(f[0].form, "8-K");
  assert.equal(f[0].cik, "0000320193");
  assert.equal(f[0].filingDate, "2026-10-08");
  assert.equal(f[0].acceptedMs, Date.UTC(2026, 9, 8, 20, 31, 5));
  assert.deepEqual(f[0].items.map((x) => x.slice(0, 4)), ["2.02", "9.01"]);
});

test("parseEdgarSubmissions: forms filter, since window, acceptance read as UTC, archive link", () => {
  const j = {
    cik: "320193", name: "Apple Inc.",
    filings: { recent: {
      accessionNumber: ["0000320193-26-000101", "0000320193-26-000090", "0000320193-26-000050"],
      form: ["8-K", "4", "10-Q"],
      filingDate: ["2026-10-08", "2026-10-07", "2026-08-01"],
      acceptanceDateTime: ["2026-10-09T02:30:32.000Z", "2026-10-07T21:00:00.000Z", "2026-08-01T20:05:00.000Z"],
      primaryDocument: ["aapl-8k.htm", "x.xml", "aapl-10q.htm"],
      items: ["2.02,9.01", "", ""],
    } },
  };
  const out = parseEdgarSubmissions(j, new Set(["8-K", "10-Q"]), Date.UTC(2026, 9, 1));
  assert.equal(out.length, 1); // the Form 4 is filtered, the 10-Q is older than the window
  assert.equal(out[0].acceptedMs, Date.UTC(2026, 9, 9, 2, 30, 32));
  assert.deepEqual(out[0].items, ["2.02", "9.01"]);
  assert.equal(out[0].link, "https://www.sec.gov/Archives/edgar/data/320193/000032019326000101/aapl-8k.htm");
});

// ─── Treasury auctions ─────────────────────────────────────────────────────

test("parseUpcomingAuctions: newest record wins per CUSIP+date, 'null' stays null, sorted", () => {
  const j = { data: [
    { record_date: "2026-10-06", security_type: "Note", security_term: "10-Year", reopening: "Yes", cusip: "91282CNA5", offering_amt: "39000000000", announcemt_date: "2026-10-01", auction_date: "2026-10-14", issue_date: "2026-10-15" },
    { record_date: "2026-10-07", security_type: "Note", security_term: "10-Year", reopening: "Yes", cusip: "91282CNA5", offering_amt: "42000000000", announcemt_date: "2026-10-01", auction_date: "2026-10-14", issue_date: "2026-10-15" },
    { record_date: "2026-10-07", security_type: "Bill", security_term: "8-Week", reopening: "No", cusip: "912797XX1", offering_amt: "null", announcemt_date: "2026-10-08", auction_date: "2026-10-09", issue_date: "2026-10-13" },
    { record_date: "2026-10-07", security_type: "Bill", security_term: "4-Week", reopening: "No", cusip: "912797OLD", offering_amt: "1", announcemt_date: "2026-10-01", auction_date: "2026-10-02", issue_date: "2026-10-06" },
  ] };
  const a = parseUpcomingAuctions(j, "2026-10-08");
  assert.deepEqual(a.map((x) => x.auctionDate), ["2026-10-09", "2026-10-14"]);
  assert.equal(a[0].offeringUsd, null);
  assert.equal(a[1].offeringUsd, 42e9);
  assert.equal(a[1].reopening, true);
  assert.deepEqual(auctionPlacementEt("Bill"), { hh: 11, mm: 30 });
  assert.deepEqual(auctionPlacementEt("Note"), { hh: 13, mm: 0 });
  assert.equal(auctionImportance(a[1]), "HIGH");
  assert.equal(auctionImportance(a[0]), "LOW");
});

// ─── Headline tiering and merge ────────────────────────────────────────────

test("tierItems drops undated and future-stamped items and counts them", () => {
  const now = Date.UTC(2026, 9, 9, 15);
  const r = tierItems("cnbc", [
    { title: "A", link: "u1", summary: "", guid: "1", category: null, publishedMs: now - 60_000 },
    { title: "B", link: "u2", summary: "", guid: "2", category: null, publishedMs: null },
    { title: "C", link: "u3", summary: "", guid: "3", category: null, publishedMs: now + FUTURE_SKEW_MS + 1 },
  ], now - 30_000, now);
  assert.equal(r.items.length, 1);
  assert.equal(r.undatedDropped, 2);
  assert.equal(r.items[0].tier, "publisher");
  assert.equal(r.items[0].fetchedAtMs, now - 30_000);
});

test("mergeTiered: the official release beats a publisher write-up with the same title", () => {
  const now = Date.UTC(2026, 9, 9, 15);
  const pub = tierItems("cnbc", [{ title: "Federal Reserve issues FOMC statement", link: "c", summary: "", guid: "c", category: null, publishedMs: now - 1000 }], now, now).items;
  const off = tierItems("fed_press", [{ title: "Federal Reserve issues FOMC statement", link: "f", summary: "", guid: "f", category: null, publishedMs: now - 5000 }], now, now).items;
  const other = tierItems("ft", [{ title: "Stocks rise", link: "s", summary: "", guid: "s", category: null, publishedMs: now - 100 }], now, now).items;
  const m = mergeTiered([pub, off, other]);
  assert.equal(m.length, 2);
  assert.equal(m[0].title, "Stocks rise"); // newest first
  assert.equal(m[1].sourceId, "fed_press");
  assert.equal(m[1].kind, "official");
});

test("mergeEconEvents: official time wins, Nasdaq consensus folds in, estimates near an official row drop", () => {
  const off = [{ id: "bls:cpi", kind: "ECON", title: "Consumer Price Index", when: Date.UTC(2026, 9, 14, 12, 30) / 1000, family: "CPI", tier: "primary" as const, source: "BLS" }];
  const others = [
    { id: "nq:cpi", kind: "ECON", title: "CPI m/m", when: Date.UTC(2026, 9, 14, 12, 30) / 1000, family: "CPI", tier: "weak" as const, source: "Nasdaq (unofficial API)", previous: "0.4%", forecast: "0.3%" },
    { id: "vol:cpi", kind: "ECON", title: "CPI (hardcoded)", when: Date.UTC(2026, 9, 13, 12, 30) / 1000, family: "CPI", tier: "computed" as const, source: "BLS schedule (hardcoded copy)" },
    { id: "nq:claims", kind: "ECON", title: "Initial Jobless Claims", when: Date.UTC(2026, 9, 15, 12, 30) / 1000, family: null, tier: "weak" as const, source: "Nasdaq (unofficial API)" },
  ];
  const m = mergeEconEvents<any>(off, others);
  assert.deepEqual(m.map((e) => e.id), ["bls:cpi", "nq:claims"]);
  assert.equal(m[0].forecast, "0.3%");
  assert.equal(m[0].previous, "0.4%");
  assert.match(m[0].notes, /Nasdaq, unofficial/);
});

// ─── Cache and states ──────────────────────────────────────────────────────

test("SourceCache: fresh within TTL, stale-if-error inside max age, then failed; one in-flight call", async () => {
  let now = 0;
  const c = new SourceCache(() => now);
  let calls = 0;
  let fail = false;
  const f = async () => { calls++; if (fail) throw new Error("HTTP 503"); return calls; };
  const a = await c.get("k", 60_000, 300_000, f);
  assert.deepEqual([a.state, a.value, a.fetchedAtMs], ["fresh", 1, 0]);
  now = 30_000;
  assert.equal((await c.get("k", 60_000, 300_000, f)).value, 1); // cached, no upstream call
  assert.equal(calls, 1);
  now = 120_000; fail = true;
  const s = await c.get("k", 60_000, 300_000, f);
  assert.deepEqual([s.state, s.value, s.fetchedAtMs, s.error], ["stale", 1, 0, "HTTP 503"]);
  now = 400_000;
  const g = await c.get("k", 60_000, 300_000, f);
  assert.deepEqual([g.state, g.value], ["failed", null]);
  // concurrent callers share one request
  const c2 = new SourceCache(() => 0);
  let n = 0;
  const slow = () => new Promise<number>((r) => { n++; setTimeout(() => r(7), 5); });
  const [x, y] = await Promise.all([c2.get("z", 1000, 1000, slow), c2.get("z", 1000, 1000, slow)]);
  assert.equal(n, 1);
  assert.equal(x.value, 7);
  assert.equal(y.value, 7);
});

test("sourceStatus and aggregateState keep failed, stale, empty, not_configured distinct", () => {
  const now = 1_000_000;
  const ok = sourceStatus("cnbc", { state: "fresh", fetchedAtMs: now - 5000, error: null }, [{ publishedMs: now - 9000 }], now);
  assert.equal(ok.state, "ok");
  assert.equal(ok.ageSec, 5);
  const empty = sourceStatus("cnbc", { state: "fresh", fetchedAtMs: now, error: null }, [], now);
  assert.equal(empty.state, "empty"); // observed zero, not failure
  assert.equal(empty.items, 0);
  const failed = sourceStatus("cnbc", { state: "failed", fetchedAtMs: null, error: "HTTP 500" }, [], now);
  assert.equal(failed.state, "failed");
  const nc = sourceStatus("sec_press", { state: "not_configured", fetchedAtMs: null, error: "set it" }, [], now);
  assert.equal(nc.state, "not_configured");
  assert.equal(sourceStatus("pumpfun", { state: "fresh", fetchedAtMs: now, error: null }, [], now).unofficial, true);
  assert.equal(aggregateState(["failed", "failed"]), "unavailable");
  assert.equal(aggregateState(["not_configured"]), "unavailable");
  assert.equal(aggregateState(["ok", "failed"]), "partial");
  assert.equal(aggregateState(["ok", "empty", "not_configured"]), "ok");
  assert.equal(aggregateState(["empty", "empty"]), "empty");
  assert.equal(aggregateState(["stale", "empty"]), "stale");
});

// ─── News calendar adapters ────────────────────────────────────────────────

test("news calendar rows: official time exact, Nasdaq date-only time not guessed, auction close placed", async () => {
  const { officialReleaseEvents, nasdaqEconEvents, treasuryAuctionEvents } = await import("../../server/news");
  const t0 = Date.UTC(2026, 9, 1), t1 = Date.UTC(2026, 11, 31);
  const [cpi] = officialReleaseEvents("bls_calendar", [{ uid: "1", summary: "Consumer Price Index for September 2026", startMs: Date.UTC(2026, 9, 14, 12, 30), timed: true }], t0, t1);
  assert.equal(cpi.when, Date.UTC(2026, 9, 14, 12, 30) / 1000);
  assert.equal(cpi.tier, "primary");
  assert.equal(cpi.timeExact, true);
  assert.equal(cpi.family, "CPI");
  assert.match(cpi.whenLabel, /8:30/);
  const nq = nasdaqEconEvents([
    { date: "2026-10-15", time: "08:30", eventName: "Initial Jobless Claims", country: "United States", impact: 2 },
    { date: "2026-10-15", time: "All Day", eventName: "Holiday", country: "US", impact: 1 },
    { date: "2026-10-15", time: "04:00", eventName: "Euro CPI", country: "Euro Zone", impact: 3 },
  ]);
  assert.equal(nq.length, 2);
  assert.equal(nq[0].when, Date.UTC(2026, 9, 15, 12, 30) / 1000);
  assert.equal(nq[0].tierLabel, "unofficial");
  assert.equal(nq[1].timeExact, false);
  assert.match(nq[1].whenLabel, /time TBA/);
  const [au] = treasuryAuctionEvents([{ cusip: "91282CNA5", securityType: "Note", securityTerm: "10-Year", auctionDate: "2026-10-14", offeringUsd: 42e9, reopening: true, issueDate: "2026-10-15" }]);
  assert.equal(au.when, Date.UTC(2026, 9, 14, 17, 0) / 1000); // 1:00 PM EDT
  assert.equal(au.timeExact, false);
  assert.match(au.title, /\$42B/);
});

// ─── Crypto majors: exchange-direct, cross-checked ─────────────────────────

import {
  parseCoinbaseTicker, parseCoinbaseTrades, parseKrakenTicker, parseKrakenTrades,
  tradeFlow, crossCheck, venueState, buildMajorRow, mid, spreadBps, TRADE_STALE_MS,
} from "../../server/sources/cryptoMajors";
import { parseJupiterPrices, jupiterCheck, narrativeCounts } from "../../server/sources/dexCross";

test("Coinbase trades: `side` is the maker side, so the taker (aggressor) is the opposite", () => {
  // Coinbase docs: a "sell" side trade is an up-tick (a taker bought from a resting sell).
  const t = parseCoinbaseTrades([
    { trade_id: 2, side: "sell", size: "1", price: "100", time: "2026-10-09T15:00:00Z" },
    { trade_id: 1, side: "buy", size: "3", price: "102", time: "2026-10-09T14:59:00Z" },
    { trade_id: 0, side: "?", size: "1", price: "1", time: "2026-10-09T14:59:00Z" },
  ]);
  assert.deepEqual(t.map((x) => x.takerSide), ["buy", "sell"]);
  const q = parseCoinbaseTicker({ trade_id: 2, price: "100", size: "1", time: "2026-10-09T15:00:00Z", bid: "99.5", ask: "100.5", volume: "1234.5" });
  assert.equal(mid(q), 100);
  assert.equal(spreadBps(q), 100); // (100.5 - 99.5) / 100 = 100 bps
  assert.equal(q.lastTradeMs, Date.UTC(2026, 9, 9, 15));
});

test("Kraken: pair keys resolved (XXBTZUSD), b/s is the taker side, 24h volume and VWAP", () => {
  const tick = { error: [], result: { XXBTZUSD: { a: ["62010.0", "1", "1.0"], b: ["62000.0", "2", "2.0"], c: ["62005.0", "0.01"], v: ["100", "2500"], p: ["61900", "61800"] } } };
  const q = parseKrakenTicker(tick, "BTC")!;
  assert.equal(mid(q), 62005);
  assert.equal(q.volume24h, 2500);
  assert.equal(q.vwap24h, 61800);
  assert.equal(parseKrakenTicker(tick, "ETH"), null);
  const tr = parseKrakenTrades({ error: [], result: { XXBTZUSD: [["62000.0", "0.5", 1791558000.25, "b", "m", "", 1], ["62001.0", "0.5", 1791558001, "s", "l", "", 2]], last: "x" } }, "BTC");
  assert.deepEqual(tr.map((x) => [x.takerSide, x.timeMs]), [["buy", 1791558000250], ["sell", 1791558001000]]);
  assert.throws(() => parseKrakenTicker({ error: ["EQuery:Unknown asset pair"] }, "BTC"));
});

test("tradeFlow: taker-buy share and VWAP by hand; coverage reported when the batch is short", () => {
  const now = Date.UTC(2026, 9, 9, 15, 0, 0);
  const trades = [
    { price: 100, size: 1, timeMs: now - 60_000, takerSide: "buy" as const },
    { price: 102, size: 3, timeMs: now - 30_000, takerSide: "sell" as const },
    { price: 90, size: 9, timeMs: now - 10 * 60_000, takerSide: "buy" as const }, // outside 5 min
  ];
  const f = tradeFlow(trades, now);
  assert.equal(f.count, 2);
  assert.equal(f.takerBuyShare, 0.25); // 1 / (1 + 3)
  assert.equal(f.vwap, 101.5);         // (100 + 306) / 4
  assert.equal(f.notionalUsd, 406);
  assert.equal(f.largestUsd, 306);
  assert.equal(f.coveredSec, 300);
  const short = tradeFlow(trades.slice(0, 2), now);
  assert.equal(short.coveredSec, 60); // batch only reaches back one minute
  assert.equal(tradeFlow([], now).takerBuyShare, null); // no trades is not 50/50
});

test("crossCheck: bps divergence by hand; diverged venues give no reference price", () => {
  const a = crossCheck(100_000, 100_100); // 100 / 100050 = 9.995 bps
  assert.equal(a.state, "agree");
  assert.ok(Math.abs(a.divergenceBps! - 9.995) < 0.001);
  assert.equal(a.reference, 100_050);
  assert.equal(crossCheck(100_000, 100_500).state, "watch");   // 49.9 bps
  const d = crossCheck(100_000, 102_000);                       // 198 bps
  assert.equal(d.state, "diverge");
  assert.equal(d.reference, null);
  assert.deepEqual(crossCheck(null, 5), { state: "single-source", divergenceBps: null, reference: 5 });
  assert.equal(crossCheck(null, null).state, "unavailable");
});

test("majors row: a venue with no recent trade is stale and leaves the cross-check", () => {
  const now = Date.UTC(2026, 9, 9, 15);
  const live = { quote: { bid: 99.9, ask: 100.1, last: 100, lastTradeMs: now - 1000, volume24h: 1, vwap24h: null }, trades: [], fetchedAtMs: now, error: null };
  const old = { quote: { bid: 120, ask: 120.2, last: 120, lastTradeMs: null, volume24h: 1, vwap24h: null }, trades: [{ price: 120, size: 1, timeMs: now - TRADE_STALE_MS - 1, takerSide: "buy" as const }], fetchedAtMs: now, error: null };
  assert.equal(venueState(live, now), "ok");
  assert.equal(venueState(old, now), "stale");
  assert.equal(venueState({ quote: null, trades: null, fetchedAtMs: null, error: "x" }, now), "failed");
  const row = buildMajorRow("BTC", live, old, { price: 100.2, asOfMs: now }, now);
  assert.equal(row.cross.state, "single-source"); // the stale Kraken book is not compared
  assert.equal(row.cross.reference, 100);
  assert.ok(Math.abs(row.coingecko.deviationBps! - 20) < 1e-9); // reference only
  assert.match(row.coingecko.label, /reference/);
});

test("Jupiter cross-check: omitted mint is no-reliable-price, gap thresholds by hand", () => {
  const r = parseJupiterPrices({ MintA: { usdPrice: 1.1, blockId: 1 }, MintB: { usdPrice: 0 } }, ["MintA", "MintB", "MintC"]);
  assert.equal(r.prices.get("MintA"), 1.1);
  assert.deepEqual(r.omitted, ["MintB", "MintC"]);
  const w = jupiterCheck(1.0, { price: 1.1, omitted: false, failed: false });
  assert.equal(w.state, "watch"); // |1.0 - 1.1| / 1.1 = 9.09%
  assert.ok(Math.abs(w.gapPct! - 9.0909) < 1e-3);
  assert.equal(jupiterCheck(1.0, { price: 1.03, omitted: false, failed: false }).state, "agree");
  assert.equal(jupiterCheck(1.0, { price: 2, omitted: false, failed: false }).state, "diverge");
  assert.equal(jupiterCheck(1.0, { price: null, omitted: true, failed: false }).state, "no-reliable-price");
  assert.equal(jupiterCheck(1.0, { price: null, omitted: false, failed: true }).state, "failed");
  assert.equal(jupiterCheck(1.0, null).state, "unchecked");
});

test("narrative heat counts only dated titles from the last 24 h; failed and empty feeds differ", () => {
  const now = Date.UTC(2026, 9, 9, 15);
  const r = narrativeCounts([
    { name: "CoinDesk", items: [{ title: "Solana ETF filing", publishedMs: now - 3600_000 }, { title: "Solana rally", publishedMs: now - 3 * 86400_000 }, { title: "Solana undated", publishedMs: null }] },
    { name: "Decrypt", items: [{ title: "Old solana story", publishedMs: now - 2 * 86400_000 }] },
    { name: "TheBlock", items: null },
  ], ["solana", "etf"], now);
  assert.deepEqual(r.heat.find((h) => h.term === "solana"), { term: "solana", hits: 1, sources: ["CoinDesk"] });
  assert.deepEqual(r.sources.map((x) => x.state), ["ok", "empty", "failed"]);
  assert.equal(r.sources[0].undated, 1);
});

test("CoinGecko reference needs the optional Demo key; no key means not called", async () => {
  const { coingeckoDemoKey } = await import("../../server/sources/cryptoMajors");
  assert.equal(coingeckoDemoKey({}), null);
  assert.equal(coingeckoDemoKey({ BATCAVE_COINGECKO_DEMO_KEY: "bad key!" }), null);
  assert.equal(coingeckoDemoKey({ BATCAVE_COINGECKO_DEMO_KEY: "CG-abcdefgh1234" }), "CG-abcdefgh1234");
});

// ─── Models event band (econWeek) ──────────────────────────────────────────

test("econ week: official BLS chip at the exact time; estimates of covered families drop", async () => {
  const { officialChips, nasdaqChips, mergeOfficialWeek } = await import("../../server/econWeek");
  const from = Date.UTC(2026, 9, 12), to = Date.UTC(2026, 9, 18);
  const off = officialChips("BLS", [
    { uid: "cpi", summary: "Consumer Price Index for September 2026", startMs: Date.UTC(2026, 9, 14, 12, 30), timed: true },
    { uid: "minor", summary: "County Employment and Wages", startMs: Date.UTC(2026, 9, 14, 14, 0), timed: true },
  ], from, to);
  assert.equal(off.length, 1); // minor releases stay off the band
  assert.equal(off[0].title, "CPI 8:30am");
  assert.equal(off[0].when, Date.UTC(2026, 9, 14, 12, 30) / 1000);
  assert.equal(off[0].tier, "primary");
  const nq = nasdaqChips([
    { date: "2026-10-14", time: "08:30", eventName: "CPI m/m", country: "US", impact: 3 },
    { date: "2026-10-15", time: "08:30", eventName: "Initial Jobless Claims", country: "US", impact: 2 },
    { date: "2026-10-16", time: "Tentative", eventName: "Business Inventories", country: "US", impact: 1 },
  ]);
  assert.equal(nq[2].timeLabel, "time TBA");
  const syn = [
    { id: "syn:cpi:2026-10-13", kind: "ECON", title: "CPI 8:30am", longTitle: "x", importance: "HIGH" as const, when: Date.UTC(2026, 9, 13, 12, 30) / 1000, timeLabel: "", estimated: true, family: "CPI" },
    { id: "syn:retail:2026-10-15", kind: "ECON", title: "Retail", longTitle: "x", importance: "MED" as const, when: Date.UTC(2026, 9, 15, 12, 30) / 1000, timeLabel: "", estimated: true, family: null },
  ];
  const m = mergeOfficialWeek(off, nq, syn as any, new Set(["CPI", "NFP"]));
  const ids = m.map((c) => c.id);
  assert.ok(ids.includes("bls:cpi"));
  assert.ok(!ids.includes("nasdaq:2026-10-14:CPI m/m")); // official wins the same day
  assert.ok(ids.includes("nasdaq:2026-10-15:Initial Jobless Claims"));
  assert.ok(!ids.includes("syn:cpi:2026-10-13")); // BLS read: its schedule decides
  assert.ok(ids.includes("syn:retail:2026-10-15")); // not covered: estimate stays, labeled
  // With BLS unreachable the CPI estimate stays (labeled estimate).
  assert.ok(mergeOfficialWeek([], [], syn as any, new Set()).some((c) => c.id === "syn:cpi:2026-10-13"));
});

// ─── Alpha news: corroboration and SEC filings ─────────────────────────────

test("alpha news: one outlet repeating a story is one source; 8-K is an official tier-1 event", async () => {
  const { distinctSourceCount, filingEvents } = await import("../../server/sources/alphaSources");
  const byId = new Map([
    ["a", { sourceId: "cnbc", source: "CNBC" }], ["b", { sourceId: "cnbc", source: "CNBC" }], ["c", { sourceId: "ft", source: "FT" }],
  ]);
  assert.equal(distinctSourceCount(["a", "b"], byId), 1);
  assert.equal(distinctSourceCount(["a", "b", "c"], byId), 2);
  const ev = filingEvents("aapl", [
    { form: "8-K", company: "Apple Inc. (AAPL)", accession: "0000320193-26-000101", acceptedUtc: "2026-10-09T02:30:32.000Z", filingDate: "2026-10-08", items: ["2.02", "9.01"], url: "https://www.sec.gov/x" },
    { form: "10-Q", company: "Apple Inc. (AAPL)", accession: "0000320193-26-000050", acceptedUtc: null, filingDate: "2026-08-01", items: [], url: "u" },
    { form: "8-K", company: "Microsoft Corp (MSFT)", accession: "1", acceptedUtc: "2026-10-09T02:30:32.000Z", filingDate: null, items: [], url: "u" },
  ]);
  assert.equal(ev.length, 1); // undated filing and other tickers excluded
  assert.equal(ev[0].tier, "TIER_1");
  assert.equal(ev[0].category, "MATERIAL_8K");
  assert.equal(ev[0].sourceTierLabel, "official");
  assert.equal(ev[0].published, Date.UTC(2026, 9, 9, 2, 30, 32) / 1000);
});
