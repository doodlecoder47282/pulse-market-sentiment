// The daily playbook builds its scenarios on levels inside the day's reach, not on all-expiry walls many
// percent away (seen live: put wall 700 and call wall 775 with SPY at 709).
import test from "node:test";
import assert from "node:assert/strict";
import { playbookDayBounds, buildDailyPlaybook, DAY_REACH_SIGMAS } from "../../server/playbook";

const piv = { h4: 729.2, l4: 702.5, r1: 721, s1: 704 };

test("a wall inside the day's reach is used; one outside gives way to the nearest pivot inside it", () => {
  // VIX 28 at 709: one day range is about 12.5 points, the reach about 18.8.
  const b = playbookDayBounds(709.22, 775, 700, 28, piv);
  assert.ok(b.sigma! > 12 && b.sigma! < 13);
  assert.deepEqual([b.lower.price, b.lower.label], [700, "put wall"], "9 points away: inside the reach");
  assert.deepEqual([b.upper.price, b.upper.label], [721, "classic R1"], "the call wall is 66 points away; R1 is the nearest level above inside the reach");
  const calm = playbookDayBounds(709.22, 775, 700, 12, piv); // reach about 8 points
  assert.deepEqual([calm.lower.price, calm.lower.label], [704, "classic S1"]);
  assert.match(calm.upper.label, /upper edge of one day range from VIX/);
  assert.ok(Math.abs(calm.upper.price - (709.22 + calm.sigma!)) < 1e-9);
  assert.equal(DAY_REACH_SIGMAS, 1.5);
});

test("with no VIX the walls are kept and marked far; with no pivots the day range stands in", () => {
  const none = playbookDayBounds(709, 775, 700, null, piv);
  assert.deepEqual([none.upper.price, none.upper.far, none.lower.price, none.lower.far, none.sigma], [775, true, 700, true, null]);
  const noPiv = playbookDayBounds(709, 775, 650, 28, null);
  assert.match(noPiv.upper.label, /upper edge/);
  assert.match(noPiv.lower.label, /lower edge/);
});

test("the scenarios of a short-gamma day name near levels, describe instead of instruct, and say where the far walls are", () => {
  const pivots: any = {
    classic: { pp: 715, r1: 721, r2: 730, r3: 740, s1: 704, s2: 699.6, s3: 690 },
    camarilla: { h3: 722.5, h4: 729.2, h5: 736, l3: 709.2, l4: 702.5, l5: 689.2 },
    fibonacci: {}, priorOhlc: { open: 0, high: 0, low: 0, close: 0 },
  };
  const pb = buildDailyPlaybook({
    symbol: "SPY", spot: 709.22, pivots,
    gamma: { callWall: 775, putWall: 700, callWallGex: 1e9, putWallGex: -1e9, zeroGamma: 737.7, regime: "negative", totalGex: -1e10, maxPain: 720, pcrOi: 2, profile: [], gammaProfile: [], gexCrossoverStrike: null } as any,
    squeeze: { score: -60, probability: 60, direction: "down", label: "", triggers: [], riskFactors: [], timeHorizon: "" } as any,
    vix: { value: 28, changePct: 0 } as any, term: { ratio9dOver30d: 1.03 } as any, marketScore: 31,
  } as any);
  const all = JSON.stringify(pb.scenarios);
  assert.doesNotMatch(all, /775/, "the 66-point-away call wall is not a scenario level");
  assert.doesNotMatch(all, /737/, "nor the gamma flip 4% away");
  assert.doesNotMatch(all, /chase|Take direction|Fast trip/i, "no instruction wording");
  const base = pb.scenarios[0];
  assert.match(base.trigger, /After the first 30 minutes, a 15-min close above .*721.* \(classic R1\) or below .*700.* \(put wall\)/);
  assert.match(base.target, /Continuation on the side that breaks; one day range from VIX is about/);
  const far = pb.gameplan.find((g) => /Largest positions across all expiries/.test(g))!;
  assert.match(far, /call wall .*775.* \(9\.3% above\)\. It is more than 1\.5 day ranges from the price, so the scenarios above use nearer levels instead\./);
});
