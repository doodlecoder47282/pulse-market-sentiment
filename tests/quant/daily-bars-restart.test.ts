// Daily price history survives a restart, and a settled daily copy is not re-requested while the request
// budget is under pressure, within bounds.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  serveSettledDailyUnderPressure, SETTLED_DAILY_PRESSURE, SETTLED_DAILY_BOOT_WINDOW_MS, SETTLED_DAILY_MAX_AGE_MS,
  planDailyRestore, RESTORE_MAX_ROWS, cacheEntryUnservable, isLastSessionCopy,
} from "../../server/schwabDataPolicy";

const EVE = Date.parse("2026-11-05T23:00:00Z");          // Thursday 18:00 ET, settled
const AFTER_SETTLE = Date.parse("2026-11-05T21:20:00Z"); // 16:20 ET
const BEFORE_CLOSE = Date.parse("2026-11-05T20:50:00Z"); // 15:50 ET
const RTH = Date.parse("2026-11-05T16:00:00Z");          // 11:00 ET
const LONG_UP = 5 * 3600_000;                            // the process has been up for hours

test("a settled daily copy is served without a request once half the budget is in use", () => {
  assert.equal(SETTLED_DAILY_PRESSURE, 0.5);
  assert.equal(serveSettledDailyUnderPressure("daily_bars", AFTER_SETTLE, 50, 100, LONG_UP, EVE), true);
  assert.equal(serveSettledDailyUnderPressure("daily_bars", AFTER_SETTLE, 49, 100, LONG_UP, EVE), false, "below the pressure line the usual refresh runs");
  assert.equal(serveSettledDailyUnderPressure("daily_bars", AFTER_SETTLE, 30, 60, LONG_UP, EVE), true, "the line follows the caller's own limit");
});

test("the rule is bounded: an old copy under sustained load is refreshed, except just after a restart", () => {
  const late = AFTER_SETTLE + SETTLED_DAILY_MAX_AGE_MS + 60_000; // 18:21 ET, the copy is over two hours old
  assert.equal(serveSettledDailyUnderPressure("daily_bars", AFTER_SETTLE, 100, 100, LONG_UP, late), false, "sustained load cannot hold one copy all night");
  assert.equal(serveSettledDailyUnderPressure("daily_bars", AFTER_SETTLE, 100, 100, 60_000, late), true, "the cold-cache page load after a restart");
  assert.equal(serveSettledDailyUnderPressure("daily_bars", AFTER_SETTLE, 100, 100, SETTLED_DAILY_BOOT_WINDOW_MS, late), false, "the restart window ends");
});

test("it never applies to bars that could still change, or to other kinds", () => {
  assert.equal(serveSettledDailyUnderPressure("daily_bars", BEFORE_CLOSE, 100, 100, 0, EVE), false, "read before the close: the last bar was still forming");
  assert.equal(serveSettledDailyUnderPressure("daily_bars", RTH - 60_000, 100, 100, 0, RTH), false, "in the session today's bar moves");
  for (const k of ["quotes", "chains", "minute_bars", "markets", "other"] as const) assert.equal(serveSettledDailyUnderPressure(k, AFTER_SETTLE, 100, 100, 0, EVE), false, k);
  assert.equal(serveSettledDailyUnderPressure("daily_bars", null, 100, 100, 0, EVE), false);
  assert.equal(serveSettledDailyUnderPressure("daily_bars", AFTER_SETTLE, 100, 0, 0, EVE), false);
});

test("restore plan: only rows the cache could still serve, expiry capped, newest first up to the cap", () => {
  assert.equal(cacheEntryUnservable("daily_bars", AFTER_SETTLE, EVE), false);
  const rows = [
    { cache_key: "ok", fetched_at: AFTER_SETTLE, expires_at: AFTER_SETTLE + 3_600_000 },
    { cache_key: "far-future-expiry", fetched_at: AFTER_SETTLE + 1, expires_at: AFTER_SETTLE + 400 * 86_400_000 },
    { cache_key: "nan-expiry", fetched_at: AFTER_SETTLE + 2, expires_at: NaN },
    { cache_key: "weeks-old", fetched_at: Date.parse("2026-10-20T21:20:00Z"), expires_at: 0 },
    { cache_key: "from-the-future", fetched_at: EVE + 60_000, expires_at: EVE + 120_000 },
  ];
  const plan = planDailyRestore(rows, EVE);
  assert.deepEqual(plan.keep.map((r) => r.cache_key), ["nan-expiry", "far-future-expiry", "ok"]);
  assert.deepEqual(plan.drop.sort(), ["from-the-future", "weeks-old"]);
  const by = (k: string) => plan.keep.find((r) => r.cache_key === k)!;
  assert.equal(by("ok").expires_at, AFTER_SETTLE + 3_600_000);
  assert.equal(by("far-future-expiry").expires_at, AFTER_SETTLE + 1 + 3_600_000, "a damaged expiry cannot read as fresh for more than the longest daily TTL");
  assert.equal(by("nan-expiry").expires_at, AFTER_SETTLE + 2, "no usable expiry: already expired, so it is refreshed or served by the stale rules");
  const many = Array.from({ length: RESTORE_MAX_ROWS + 5 }, (_, i) => ({ cache_key: `k${i}`, fetched_at: AFTER_SETTLE + i, expires_at: AFTER_SETTLE + i }));
  const p2 = planDailyRestore(many, EVE);
  assert.equal(p2.keep.length, RESTORE_MAX_ROWS);
  assert.deepEqual(p2.drop.sort(), ["k0", "k1", "k2", "k3", "k4"], "the oldest fetches go first");
});

test("only a copy that is a last-session copy at its own fetch time is written", () => {
  assert.equal(isLastSessionCopy("daily_bars", AFTER_SETTLE, AFTER_SETTLE), true);
  assert.equal(isLastSessionCopy("daily_bars", RTH, RTH), false);
  assert.equal(isLastSessionCopy("daily_bars", BEFORE_CLOSE, BEFORE_CLOSE), false);
  const store = readFileSync(new URL("../../server/schwabCacheStore.ts", import.meta.url), "utf8");
  assert.match(store, /if \(!isLastSessionCopy\("daily_bars", fetchedAt, fetchedAt\)\) return;/);
  assert.match(store, /planDailyRestore\(meta, nowMs\)/);
});

test("the wiring: saved on fetch, restored once, served as a cache hit and never recorded as degraded", () => {
  const src = readFileSync(new URL("../../server/schwab.ts", import.meta.url), "utf8");
  assert.match(src, /if \(ttl > 0 && kind === "daily_bars"\) saveDailyPayload\(cacheKey, data, fetchedAt, fetchedAt \+ ttl\)/);
  assert.match(src, /restoreDailyCacheOnce\(\);/);
  assert.match(src, /if \(_cache\.has\(e\.cacheKey\)\) continue;/, "a payload already fetched since the restart is not replaced by the kept one");
  const i = src.indexOf("serveSettledDailyUnderPressure(kind, settled.fetchedAt");
  assert.ok(i > 0);
  const branch = src.slice(src.lastIndexOf("if (!opts?.skipCache && ttl > 0) {", i), src.indexOf("}\n  }", i));
  assert.match(branch, /deliver\(\{ data: settled\.data, freshness: freshFreshness\(settled\.fetchedAt, kind, true\), reason: null \}, "cache_hit"/);
  assert.doesNotMatch(branch, /serveStale|_recordDegraded/, "a deliberate last-session serve is not a failed refresh");
});
