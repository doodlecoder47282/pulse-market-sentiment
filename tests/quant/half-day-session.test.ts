import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sessionLengthAt, FULL_SESSION_MIN, etWallToEpochMs } from "../../shared/exchangeCalendar";

const src = (p: string) => readFileSync(p, "utf8");

test("the session length comes from the calendar: 390 on a full day, 210 on a half day", () => {
  assert.equal(FULL_SESSION_MIN, 390);
  assert.equal(sessionLengthAt(etWallToEpochMs("2026-11-20", 12 * 60)), 390, "an ordinary Friday");
  assert.equal(sessionLengthAt(etWallToEpochMs("2026-11-27", 12 * 60)), 210, "the day after Thanksgiving closes at 13:00");
  assert.equal(sessionLengthAt(etWallToEpochMs("2026-12-24", 10 * 60)), 210, "Christmas Eve");
  // No session: the full length, so nothing divides by zero.
  assert.equal(sessionLengthAt(etWallToEpochMs("2026-11-26", 12 * 60)), 390, "Thanksgiving");
  assert.equal(sessionLengthAt(etWallToEpochMs("2026-11-21", 12 * 60)), 390, "a Saturday");
});

test("what the fixed 390 got wrong at noon on a half day", () => {
  const noon = etWallToEpochMs("2026-11-27", 12 * 60);
  const elapsed = 150;
  assert.equal(Math.round((1 - elapsed / sessionLengthAt(noon)) * 100), 29, "29% of the session is left");
  assert.equal(Math.round((1 - elapsed / 390) * 100), 62, "the fixed length said 62%");
});

test("wiring: no live calculation divides the session by a fixed 390", () => {
  const rt = src("server/realtimeTargets.ts");
  assert.doesNotMatch(rt, /RTH_FULL_MINUTES/);
  assert.match(rt, /const len = sessionLengthAt\(nowMs\);/);
  assert.match(rt, /Math\.round\(fracRemaining \* sessionLengthAt\(now\)\)/);
  assert.match(src("server/tickerScan.ts"), /mins \/ sessionLengthAt\(nowMs\)/);
  assert.match(src("server/exitBrain.ts"), /const minutesRemaining = minutesToSessionClose\(asOf\);/);
  assert.match(src("server/odteAlertEngine.ts"), /minutesElapsed \/ sessionLengthAt\(Date\.now\(\)\)/);
  const routes = src("server/routes.ts");
  assert.match(routes, /sessionLengthAt\(Date\.now\(\)\) - entryMod - minutesHeld/);
  assert.match(routes, /const r = FLIP_RATE; \/\/ the one rate every panel uses/);
  for (const f of ["server/realtimeTargets.ts", "server/tickerScan.ts", "server/exitBrain.ts"]) {
    assert.doesNotMatch(src(f).replace(/\/\/.*$/gm, ""), /[\/-] ?390\b|\b390 ?-/, `${f} still does arithmetic on a fixed 390`);
  }
});
