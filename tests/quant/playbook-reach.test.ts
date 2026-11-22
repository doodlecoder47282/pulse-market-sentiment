import { test } from "node:test";
import assert from "node:assert/strict";
import { wallReach, weightsForReach, outOfReachLine, ONE_DAY_REACH_SIGMAS } from "../../shared/playbookReach";
import { buildHorizonDates } from "../../server/horizonDates";
import { etWallToEpochMs } from "../../shared/exchangeCalendar";
import { setSnapshotProvider, buildDailyPlaybook } from "../../server/dailyPlaybook";

test("a wall is a one-day path only within two one-day moves of the price", () => {
  // The case seen live: SPY 697.48, one-day move 13.76, call wall 775, put wall 675.
  const up = wallReach(697.48, 775, 13.76)!, dn = wallReach(697.48, 675, 13.76)!;
  assert.equal(up.points.toFixed(2), "77.52");      // 775 - 697.48
  assert.equal(up.sigmas.toFixed(1), "5.6");        // 77.52 / 13.76
  assert.equal(up.withinDay, false);
  assert.equal(dn.points.toFixed(2), "-22.48");
  assert.equal(dn.sigmas.toFixed(1), "1.6");        // 22.48 / 13.76
  assert.equal(dn.withinDay, true);
  assert.equal(wallReach(100, 100 + 2 * 1.5, 1.5)!.withinDay, true, "exactly two moves is within");
  assert.equal(ONE_DAY_REACH_SIGMAS, 2);
  assert.equal(wallReach(100, 110, 0), null);
  assert.equal(wallReach(100, NaN, 1), null);
});

test("an out-of-range wing carries no weight; the weights still sum to one", () => {
  const w = weightsForReach({ bull: 0.19, base: 0.30, bear: 0.51 }, false, true);
  assert.deepEqual([w.bull, Number(w.base.toFixed(2)), w.bear], [0, 0.49, 0.51]);
  assert.deepEqual(weightsForReach({ bull: 0.2, base: 0.5, bear: 0.3 }, true, true), { bull: 0.2, base: 0.5, bear: 0.3 });
  const both = weightsForReach({ bull: 0.2, base: 0.5, bear: 0.3 }, false, false);
  assert.equal(both.base, 1);
});

test("the line states the distance and names no target", () => {
  const line = outOfReachLine("call", 775, wallReach(697.48, 775, 13.76)!, 13.76);
  assert.match(line, /^The call wall 775\.00 is 77\.5 points above the price: 5\.6 one-day moves \(one day is about ±13\.76\)\./);
  assert.match(line, /no up path is drawn from it/);
  assert.doesNotMatch(line, /target|trigger|squeeze|momentum|will|expect/i);
});

test("the playbook: a far call wall is not a path, a near put wall is", async () => {
  setSnapshotProvider(async () => ({
    capturedAt: 1_795_000_000, gammaAsOf: 1_795_000_000,
    spy: { price: 697.48 },
    gamma: { spot: 697.48, callWall: 775, putWall: 675, zeroGamma: 752.04, maxPain: 728, totalGex: -1e9 },
    term: { ratio30dOver3m: 1.03, ratio9dOver30d: 1.1, vix9d: 40, vix3m: 35 },
    vol: { vix: { value: 35.89 } },
    composite: { marketScore: 18 },
  }) as any);
  const pb = await buildDailyPlaybook("SPY");
  const { bull, base, bear } = pb.paths;
  assert.equal(bull.reach!.withinDay, false);
  assert.equal(bull.probability, 0);
  assert.equal(bull.trigger.condition, "out of one day's range");
  assert.match(bull.oneLiner, /^The call wall 775\.00 is 77\.5 points above the price/);
  assert.deepEqual(bull.drivers, []);
  assert.equal(bear.reach!.withinDay, true);
  assert.match(bear.trigger.condition, /15m close below put wall 675\.00/);
  assert.ok(Math.abs(bull.probability + base.probability + bear.probability - 1) < 1e-9);
  assert.ok(base.probability > 0.3, "the bull wing's weight went to the middle path");
});

test("the daily target is a session: Monday when asked on a weekend, Friday when asked on Thanksgiving", () => {
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-22", 15 * 60)).targetDateLong, "MON NOV 23, 2026");
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-22", 15 * 60)).targetDate, "MON 11/23 CLOSE");
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-21", 10 * 60)).targetDateLong, "MON NOV 23, 2026");
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-26", 10 * 60)).targetDateLong, "FRI NOV 27, 2026");
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-23", 10 * 60)).targetDateLong, "MON NOV 23, 2026");
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-22", 15 * 60)).spotAnchorDate, "SUN 11/22", "the price anchor is still now");
});
