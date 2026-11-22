import { test } from "node:test";
import assert from "node:assert/strict";
import { wallReach, outOfReachLine, ONE_DAY_REACH_SIGMAS } from "../../shared/playbookReach";
import { readFileSync } from "node:fs";
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
  assert.equal(bull.trigger.condition, "out of one day's range");
  assert.match(bull.oneLiner, /^The call wall 775\.00 is 77\.5 points above the price/);
  assert.deepEqual(bull.drivers, []);
  assert.equal(bear.reach!.withinDay, true);
  assert.match(bear.trigger.condition, /15m close below put wall 675\.00/);
  // The rule weights are left as set: nothing is added to the middle path to make it look surer.
  assert.ok(Math.abs(bull.probability + base.probability + bear.probability - 1) < 1e-9);
  assert.ok(bull.probability > 0.1 && base.probability < 0.4);
  // The middle path no longer speaks of a break of the far wall, and the headline names a drawn path.
  assert.equal(base.trigger.condition, "No 15m close below the put wall 675.00. The call wall 775.00 is out of one day's range.");
  assert.match(pb.headline, /lean down \(\d+% wt, heuristic\)/);
  // The chart draws no band, line or trigger for it, and the verdict takes no vote from it.
  const chart = readFileSync("client/src/components/DailyPlaybookChart.tsx", "utf8");
  assert.match(chart, /if \(notDrawn\(pb\.paths\[k\]\)\) continue;/);
  assert.equal((chart.match(/ordered\.filter\(k => !notDrawn\(paths\[k\]\)\)/g) ?? []).length, 2);
  assert.match(chart, /\|\| notDrawn\(paths\[k\]\)\) return null;/);
  assert.match(readFileSync("server/edgeBriefing.ts", "utf8"), /if \(b\.playbook && pbUsable && !pbWingOut\)/);
});

test("the daily target is a session: Monday when asked on a weekend, Friday when asked on Thanksgiving", () => {
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-22", 15 * 60)).targetDateLong, "MON NOV 23, 2026");
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-22", 15 * 60)).targetDate, "MON 11/23 CLOSE");
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-21", 10 * 60)).targetDateLong, "MON NOV 23, 2026");
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-26", 10 * 60)).targetDateLong, "FRI NOV 27, 2026");
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-23", 10 * 60)).targetDateLong, "MON NOV 23, 2026");
  assert.equal(buildHorizonDates("daily", etWallToEpochMs("2026-11-22", 15 * 60)).spotAnchorDate, "SUN 11/22", "the price anchor is still now");
});

test("when the up wing would have been the heaviest it still is not the headline", async () => {
  setSnapshotProvider(async () => ({
    capturedAt: 1_795_000_000, gammaAsOf: 1_795_000_000, spy: { price: 697.48 },
    gamma: { spot: 697.48, callWall: 775, putWall: 690, zeroGamma: 690, maxPain: 700, totalGex: -1e9 },
    term: { ratio30dOver3m: 0.9, ratio9dOver30d: 0.9, vix9d: 30, vix3m: 40 }, vol: { vix: { value: 35.89 } }, composite: { marketScore: 80 },
  }) as any);
  const pb = await buildDailyPlaybook("SPY");
  assert.ok(pb.paths.bull.probability > pb.paths.base.probability, "the rules put most weight on the up wing");
  assert.doesNotMatch(pb.headline, /lean up/);
});
