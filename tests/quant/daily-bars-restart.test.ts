// Daily price history survives a restart, and settled daily bars are not re-requested while the request
// budget is under pressure.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serveSettledDailyUnderPressure, SETTLED_DAILY_PRESSURE, cacheEntryUnservable } from "../../server/schwabDataPolicy";

const EVE = Date.parse("2026-11-05T23:00:00Z");      // Thursday 18:00 ET, settled
const AFTER_SETTLE = Date.parse("2026-11-05T21:20:00Z"); // 16:20 ET
const BEFORE_CLOSE = Date.parse("2026-11-05T20:50:00Z"); // 15:50 ET
const RTH = Date.parse("2026-11-05T16:00:00Z");      // 11:00 ET

test("settled daily bars are served without a request once half the budget is in use", () => {
  assert.equal(SETTLED_DAILY_PRESSURE, 0.5);
  assert.equal(serveSettledDailyUnderPressure("daily_bars", AFTER_SETTLE, 50, 100, EVE), true);
  assert.equal(serveSettledDailyUnderPressure("daily_bars", AFTER_SETTLE, 49, 100, EVE), false, "below the pressure line the usual refresh runs");
  assert.equal(serveSettledDailyUnderPressure("daily_bars", AFTER_SETTLE, 30, 60, EVE), true, "the line follows the caller's own limit");
});

test("it never applies to bars that could still change, or to other kinds", () => {
  assert.equal(serveSettledDailyUnderPressure("daily_bars", BEFORE_CLOSE, 100, 100, EVE), false, "read before the close: the last bar was still forming");
  assert.equal(serveSettledDailyUnderPressure("daily_bars", RTH - 60_000, 100, 100, RTH), false, "in the session today's bar moves");
  for (const k of ["quotes", "chains", "minute_bars", "markets", "other"] as const) assert.equal(serveSettledDailyUnderPressure(k, AFTER_SETTLE, 100, 100, EVE), false, k);
  assert.equal(serveSettledDailyUnderPressure("daily_bars", null, 100, 100, EVE), false);
  assert.equal(serveSettledDailyUnderPressure("daily_bars", AFTER_SETTLE, 100, 0, EVE), false);
});

test("a kept payload is restored only while the cache rules could still serve it", () => {
  assert.equal(cacheEntryUnservable("daily_bars", AFTER_SETTLE, EVE), false, "the last-session copy is servable");
  assert.equal(cacheEntryUnservable("daily_bars", Date.parse("2026-10-20T21:20:00Z"), EVE), true, "weeks old and before the last settle: gone");
});

test("the wiring: daily payloads are saved on fetch, restored once, and a forced refresh is never short-circuited", () => {
  const src = readFileSync(new URL("../../server/schwab.ts", import.meta.url), "utf8");
  assert.match(src, /if \(ttl > 0 && kind === "daily_bars"\) saveDailyPayload\(cacheKey, data, fetchedAt, fetchedAt \+ ttl\)/);
  assert.match(src, /restoreDailyCacheOnce\(\);/);
  assert.match(src, /if \(_cache\.has\(e\.cacheKey\)\) continue;/, "a payload already fetched since the restart is not replaced by the kept one");
  assert.match(src, /!opts\?\.skipCache && serveSettledDailyUnderPressure\(/);
  const store = readFileSync(new URL("../../server/schwabCacheStore.ts", import.meta.url), "utf8");
  assert.match(store, /fetchedAt <= nowMs && !cacheEntryUnservable\("daily_bars", fetchedAt, nowMs\)/);
});
