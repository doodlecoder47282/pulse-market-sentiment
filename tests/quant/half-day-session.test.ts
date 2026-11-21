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

test("the opening band's remaining sigma: unchanged on a full day, minutes to the real close on a half day", () => {
  // The engine's arithmetic, as written in server/odteAlertEngine.ts.
  const left = (len: number, elapsed: number) => Math.sqrt(Math.max(0.01 * FULL_SESSION_MIN, len - elapsed) / FULL_SESSION_MIN);
  const old = (elapsed: number) => Math.sqrt(1 - Math.min(0.99, elapsed / 390));
  for (const e of [1, 30, 150, 300, 389, 400]) assert.ok(Math.abs(left(390, e) - old(e)) < 1e-12, `full day, ${e} minutes in`);
  assert.equal(left(210, 150).toFixed(3), "0.392", "noon on a half day: 60 of 390 trading minutes of a day's sigma are left");
  assert.equal(old(150).toFixed(3), "0.784", "the fixed length counted 240");
});

test("volume pace stays on a full session's clock, also on a half day", () => {
  // Today's volume is compared with the 20-day average of FULL sessions: by noon, 150 / 390 of a normal day is due.
  const ts = src("server/tickerScan.ts");
  assert.match(ts, /mins \/ FULL_SESSION_MIN/);
  assert.doesNotMatch(ts, /sessionLengthAt/);
});

test("the hazard walk stops at today's close on a half day and is untouched on a full day", () => {
  const hz = src("server/hazardEngine.ts");
  assert.match(hz, /opts\.minutesLeft < 390 - entryMod \? Math\.max\(1, Math\.floor\(opts\.minutesLeft\)\) : null/, "a full day leaves the cap off, so its cache key and paths are as before");
  assert.match(hz, /if \(cap != null && b\.mod - m > cap\) \{ minutes = cap; break; \}/);
  assert.match(hz, /Math\.min\(cap \?\? 390 - entryMod, 240\)/);
  assert.match(src("server/exitBrain.ts"), /minutesLeft: sessionLengthAt\(asOf\) - entryMod/);
});

test("wiring: the session length comes from the calendar where today's clock is meant", () => {
  const rt = src("server/realtimeTargets.ts");
  assert.doesNotMatch(rt, /RTH_FULL_MINUTES/);
  assert.match(rt, /const len = sessionLengthAt\(nowMs\);/);
  assert.match(rt, /Math\.round\(fracRemaining \* sessionLengthAt\(now\)\)/);
  assert.match(src("server/exitBrain.ts"), /const minutesRemaining = Math\.max\(1, sessionLengthAt\(asOf\) - nowMod\);/);
  const eng = src("server/odteAlertEngine.ts");
  assert.match(eng, /sessionLengthAt\(Date\.now\(\)\) - minutesElapsed/);
  assert.match(eng, /const eodWindow = todMin >= closeMin - 30 && todMin <= closeMin - 5;/);
  const rp = src("server/regimePredictor.ts");
  assert.match(rp, /const len = sessionLengthAt\(nowMs\);/);
  assert.doesNotMatch(rp, /minutes to 16:00 ET/);
  assert.match(src("server/signalTracker.ts"), /Date\.now\(\) > etCloseMs\(it\.expiration\)/);
  const routes = src("server/routes.ts");
  assert.match(routes, /sessionLengthAt\(Date\.now\(\)\) - entryMod - minutesHeld/);
  assert.match(routes, /const r = FLIP_RATE; \/\/ the one rate every panel uses/);
});
