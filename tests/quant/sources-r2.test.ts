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
