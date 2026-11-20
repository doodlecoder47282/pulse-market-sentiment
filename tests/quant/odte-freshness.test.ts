import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { forwardFreshness, FORWARD_MAX_AGE_MS, ageText } from "../../shared/odteFreshness";

const at = (iso: string) => Date.parse(iso);
// 2026-11-20 is a Friday; 15:00Z = 10:00 ET.
const NOW = at("2026-11-20T15:00:00Z");

test("a read from a minute ago with today's expiry is current", () => {
  const f = forwardFreshness({ asOf: "2026-11-20T14:59:00Z", expiry: "2026-11-20", horizon: "rest_of_today" }, NOW);
  assert.equal(f.state, "current");
});

test("yesterday's read is out of date and says when it was read", () => {
  const f = forwardFreshness({ asOf: "2026-11-19T15:00:00Z", expiry: "2026-11-19", horizon: "rest_of_today" }, NOW);
  assert.equal(f.state, "out_of_date");
  assert.match((f as any).reason, /10:00 ET on 2026-11-19/);
  assert.match((f as any).reason, /24 h 0 min ago/);
});

test("a read older than five missed polls on the same day is out of date; one at the limit is not", () => {
  const old = forwardFreshness({ asOf: new Date(NOW - FORWARD_MAX_AGE_MS - 1000).toISOString(), expiry: "2026-11-20", horizon: "rest_of_today" }, NOW);
  assert.equal(old.state, "out_of_date");
  assert.match((old as any).reason, /09:54 ET, 5 min ago/);
  const edge = forwardFreshness({ asOf: new Date(NOW - FORWARD_MAX_AGE_MS).toISOString(), expiry: "2026-11-20", horizon: "rest_of_today" }, NOW);
  assert.equal(edge.state, "current");
});

test("a recent read built on an expired chain is its own state, not 'out of date'", () => {
  const f = forwardFreshness({ asOf: "2026-11-20T14:59:30Z", expiry: "2026-11-19", horizon: "rest_of_today" }, NOW);
  assert.equal(f.state, "wrong_expiry");
  assert.match((f as any).reason, /expired 2026-11-19/);
});

test("a rest-of-today read on a later expiry is the wrong expiry; a next-session read on it is current", () => {
  const a = forwardFreshness({ asOf: "2026-11-20T14:59:30Z", expiry: "2026-11-23", horizon: "rest_of_today" }, NOW);
  assert.equal(a.state, "wrong_expiry");
  // An old read on the wrong expiry is first of all old.
  assert.equal(forwardFreshness({ asOf: "2026-11-19T15:00:00Z", expiry: "2026-11-19", horizon: "rest_of_today" }, NOW).state, "out_of_date");
  const evening = at("2026-11-20T23:00:00Z");
  const b = forwardFreshness({ asOf: "2026-11-20T22:59:30Z", expiry: "2026-11-23", horizon: "next_session" }, evening);
  assert.equal(b.state, "current");
});

test("a read without a time is never shown as current", () => {
  assert.equal(forwardFreshness({ expiry: "2026-11-20" }, NOW).state, "out_of_date");
  assert.equal(forwardFreshness(null, NOW).state, "out_of_date");
  assert.equal(forwardFreshness({ asOf: "not a time" }, NOW).state, "out_of_date");
});

test("a clock behind the server does not make a read out of date", () => {
  const f = forwardFreshness({ asOf: "2026-11-20T15:00:20Z", expiry: "2026-11-20", horizon: "rest_of_today" }, NOW);
  assert.equal(f.state, "current");
});

test("the age is measured on the device's own clock when the receipt time is known", () => {
  // Device clock six minutes ahead of the server: the read's server time looks six minutes old, but it arrived just now.
  const ahead = forwardFreshness({ asOf: new Date(NOW - 6 * 60_000).toISOString(), receivedAtMs: NOW - 2000, expiry: "2026-11-20", horizon: "rest_of_today" }, NOW);
  assert.equal(ahead.state, "current");
  // A read that arrived long ago is old whatever its server time says.
  const old = forwardFreshness({ asOf: new Date(NOW).toISOString(), receivedAtMs: NOW - 20 * 60_000, expiry: "2026-11-20", horizon: "rest_of_today" }, NOW);
  assert.equal(old.state, "out_of_date");
  assert.match((old as any).reason, /09:40 ET, 20 min ago/);
  // No receipt time (0 before the first read): the server time is used.
  assert.equal(forwardFreshness({ asOf: new Date(NOW - 1000).toISOString(), receivedAtMs: 0, expiry: "2026-11-20", horizon: "rest_of_today" }, NOW).state, "current");
});

test("server: a chain that still carries yesterday's days-to-expiry number for today's expiry is today's chain", async () => {
  const { buildOdteForward } = await import("../../server/odteForward.ts");
  const { demoChain, demoPriceHistory } = await import("../../server/demoMarket.ts");
  const { etDate, addDays, etWallToEpochMs } = await import("../../server/exchangeCalendar.ts");
  const T = etWallToEpochMs("2026-10-12", 11 * 60);
  const bump = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => { const [d, n] = k.split(":"); return [`${d}:${Number(n) + 1}`, v]; }));
  const deps = {
    getOptionChain: async (symbol: string, dte: number) => {
      const from = etDate(T);
      const ch: any = demoChain({ symbol, contractType: "ALL", strikeCount: 120, includeUnderlyingQuote: "true", fromDate: from, toDate: addDays(from, Math.max(dte, 1)) }, T);
      // As re-served from last night's cache: every key's number is one more than it would be today.
      return { ...ch, callExpDateMap: bump(ch.callExpDateMap), putExpDateMap: bump(ch.putExpDateMap), source: "demo", asOfMs: T - 16 * 3_600_000, servedFromCache: true, stale: true };
    },
    getPriceHistory: async (symbol: string, periodType: string, period: number, frequencyType: string, frequency: number) =>
      demoPriceHistory({ symbol, periodType, period, frequencyType, frequency, endDate: T }, T),
  };
  const fwd = await buildOdteForward("$SPX", T, deps as any);
  assert.equal(fwd.status, 200);
  const b: any = fwd.body;
  assert.equal(b.expiry, "2026-10-12");
  assert.equal(b.wiener.state, "ok", b.wiener.reason ?? "");
  assert.equal(b.chainStale, true, "and it is still marked as an old chain");
});

test("age text", () => {
  assert.equal(ageText(7 * 60_000), "7 min");
  assert.equal(ageText(125 * 60_000), "2 h 5 min");
  assert.equal(ageText(72 * 3_600_000), "3 days");
});

test("wiring: both panels gate on freshness, and the server takes today's expiry from the date", () => {
  const map = readFileSync("client/src/components/OdteForward.tsx", "utf8");
  const path = readFileSync("client/src/components/TodayPath.tsx", "utf8");
  const srv = readFileSync("server/odteForward.ts", "utf8");
  assert.match(map, /forwardFreshness\(/);
  assert.match(map, /odte-forward-out-of-date/);
  assert.match(map, /odte-forward-wrong-expiry/);
  assert.match(map, /receivedAtMs: dataUpdatedAt/);
  assert.match(path, /receivedAtMs: q\.dataUpdatedAt/);
  assert.match(path, /visibilitychange/);
  assert.match(path, /forwardFreshness\(/);
  assert.match(srv, /horizon === "rest_of_today" \? expiryDate !== todayEt/);
});
