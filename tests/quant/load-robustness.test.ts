// Review item 6 (load): the Schwab cache never evicted, the killbox seeder
// fetched its own 0-60 DTE chain every 5 min, weekday evenings kept the
// session TTLs, the 0DTE tracker fetched a dead chain all night, and the
// client's 4-15 s pollers ran all weekend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cacheEntryUnservable, freshTtlMs, lastSettledCloseMs, FRESH_TTL_MS, SETTLED_EVENING_TTL_MS, NON_TRADING_DAY_TTL_MS, MAX_SERVE_AGE_MS } from "../../server/schwabDataPolicy";
import { pacedInterval, OFF_SESSION_MS, inExtendedHours } from "../../client/src/lib/pollInterval";

const T = (iso: string) => Date.parse(iso);

test("cache eviction rule: an entry is unservable once past the longest serve age AND older than the last settled close", () => {
  const sat = T("2026-11-07T20:00:00Z"); // Saturday 15:00 ET; Friday settled 16:15 ET = 21:15Z Nov 6
  const settled = lastSettledCloseMs(sat)!;
  assert.equal(settled, T("2026-11-06T21:15:00Z"));
  // Friday's chain read after the settle: the last-session copy, kept at any age.
  assert.equal(cacheEntryUnservable("chains", T("2026-11-06T21:20:00Z"), sat), false);
  // Thursday's chain: past 30 min and before the settle, gone.
  assert.equal(cacheEntryUnservable("chains", T("2026-11-05T18:00:00Z"), sat), true);
  // A quote 10 min old is inside its closed-market cap: kept.
  assert.equal(cacheEntryUnservable("quotes", sat - 10 * 60_000, sat), false);
  // A quote read Friday afternoon (before the settle) and now 20 h old: gone.
  assert.equal(cacheEntryUnservable("quotes", T("2026-11-06T19:00:00Z"), sat), true);
  // In the session: a chain 2 min old is inside its serve age: kept; one from yesterday: gone.
  const wed = T("2026-11-04T16:00:00Z");
  assert.equal(cacheEntryUnservable("chains", wed - 120_000, wed), false);
  assert.equal(cacheEntryUnservable("chains", T("2026-11-03T15:00:00Z"), wed), true);
  // The longest cap of the kind is the one used (closed > rth here).
  assert.ok(MAX_SERVE_AGE_MS.closed.chains > MAX_SERVE_AGE_MS.rth.chains);
});

test("fresh TTL: session values in RTH; settled-evening values after 16:15 ET on a trading day; non-trading-day values on weekends", () => {
  const rth = T("2026-11-05T16:00:00Z"); // Thu 11:00 ET
  assert.equal(freshTtlMs("chains", rth), FRESH_TTL_MS.chains);
  const settling = T("2026-11-05T21:10:00Z"); // 16:10 ET: not settled yet
  assert.equal(freshTtlMs("chains", settling), FRESH_TTL_MS.chains);
  const evening = T("2026-11-06T01:00:00Z"); // Thu 20:00 ET
  assert.equal(freshTtlMs("chains", evening), SETTLED_EVENING_TTL_MS.chains);
  assert.equal(freshTtlMs("daily_bars", evening), SETTLED_EVENING_TTL_MS.daily_bars);
  assert.equal(freshTtlMs("quotes", evening), FRESH_TTL_MS.quotes, "quotes keep their TTL: extended-hours prints move");
  assert.equal(freshTtlMs("minute_bars", evening), FRESH_TTL_MS.minute_bars);
  const sat = T("2026-11-07T20:00:00Z");
  assert.equal(freshTtlMs("chains", sat), NON_TRADING_DAY_TTL_MS.chains);
  // Half day: settled from 13:15 ET.
  const bf = T("2026-11-27T18:30:00Z"); // Black Friday 13:30 ET
  assert.equal(freshTtlMs("chains", bf), SETTLED_EVENING_TTL_MS.chains);
});

test("client poll pacing: live in the session, slower in extended hours, five minutes when the market is closed", () => {
  const rth = T("2026-11-05T16:00:00Z");
  assert.equal(pacedInterval(5_000, rth), 5_000);
  const pre = T("2026-11-05T12:00:00Z"); // 07:00 ET
  assert.ok(inExtendedHours(pre));
  assert.equal(pacedInterval(5_000, pre), 30_000);
  assert.equal(pacedInterval(60_000, pre), OFF_SESSION_MS, "capped at the off-session cadence");
  const night = T("2026-11-06T03:00:00Z"); // 22:00 ET Thu
  assert.ok(!inExtendedHours(night));
  assert.equal(pacedInterval(5_000, night), OFF_SESSION_MS);
  const sat = T("2026-11-07T20:00:00Z");
  assert.equal(pacedInterval(4_000, sat), OFF_SESSION_MS);
  const holiday = T("2026-11-26T16:00:00Z"); // Thanksgiving 11:00 ET
  assert.equal(pacedInterval(5_000, holiday), OFF_SESSION_MS);
});

test("wiring: cache sweep on write, killbox seeder through the shared ladder, 0DTE tracker makes no off-hours request, panels paced", () => {
  const sw = readFileSync(new URL("../../server/schwab.ts", import.meta.url), "utf8");
  assert.match(sw, /if \(ttl > 0\) _cache\.set\(cacheKey, \{ data, fetchedAt, expiresAt: fetchedAt \+ ttl, fingerprint, kind \}\);\s*if \(fetchedAt - _lastCacheSweep > CACHE_SWEEP_MS\) sweepSchwabCache\(fetchedAt\);/);
  assert.match(sw, /if \(cacheEntryUnservable\(e\.kind, e\.fetchedAt, nowMs, settled\)\) \{ _cache\.delete\(k\); n\+\+; \}/);
  assert.match(sw, /cacheEvictedTotal: _cacheEvicted,/);
  const r = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  assert.match(r, /const \{ getOptionChainLadder \} = await import\("\.\/schwab"\);\s*const chain = await getOptionChainLadder\(symbol, dte\);/);
  const ot = readFileSync(new URL("../../server/odteTracker.ts", import.meta.url), "utf8");
  // Off-hours: no request, but tracked positions and events still carry their current state (a disarm after the close shows at once).
  assert.match(ot, /if \(!inSession\) \{[^}]*lastSnapshot = \{ \.\.\.lastSnapshot, asOf: Date\.now\(\), connected: false, note: "0DTE tracker idle \(outside session\)", tracked: \[\.\.\.tracked\], events: events\.slice\(-200\) \};\s*return;\s*\}\s*const chain: OptionChainResponse = await getOptionChain\("\$SPX", 0\);/);
  assert.doesNotMatch(ot, /if \(!inSession \|\| authFailure\)/, "the dead off-hours branch inside the error path is gone");
  // The sweep computes the settle once, not per entry.
  assert.match(sw, /const settled = lastSettledCloseMs\(nowMs\);[^\n]*\n\s*for \(const \[k, e\] of _cache\) \{\s*if \(cacheEntryUnservable\(e\.kind, e\.fetchedAt, nowMs, settled\)\)/);
  assert.equal(cacheEntryUnservable("chains", T("2026-11-05T18:00:00Z"), T("2026-11-07T20:00:00Z"), T("2026-11-06T21:15:00Z")), true, "settle passed in gives the same answer");
  assert.match(readFileSync(new URL("../../client/src/components/DepthSkewFlow.tsx", import.meta.url), "utf8"), /`\$\{Math\.round\(pacedInterval\(4_000\) \/ 1000\)\}s`/);
  for (const f of ["Heatseeker", "OdteContractChart", "DepthSkewFlow", "LiveQuoteStrip", "MacroCarousel", "FlowPanel", "ModelsPanel", "TradeDesk", "Mag7Panel", "ChartPanel"]) {
    const c = readFileSync(new URL(`../../client/src/components/${f}.tsx`, import.meta.url), "utf8");
    assert.match(c, /import \{ livePoll(, pacedInterval)? \} from "@\/lib\/pollInterval";/, f);
    assert.doesNotMatch(c, /refetchInterval: (4_000|5_000|10_000|15_000),/, `${f}: raw sub-minute interval left`);
  }
  // The server calendar is the shared one (one session clock for both sides).
  assert.match(readFileSync(new URL("../../server/exchangeCalendar.ts", import.meta.url), "utf8"), /export \* from "\.\.\/shared\/exchangeCalendar";/);
});
