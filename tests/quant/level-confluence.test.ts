// tests/quant/level-confluence.test.ts
//
// A reader's chart levels against the 0DTE map: landmark / chain / weak /
// chart_only / unavailable, with the tolerance and share rules stated in
// shared/levelConfluence.ts. Fixture is Sunday 18 Oct 2026's SPX read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLevel, checkLevels, parseLevels, defaultTolerancePts } from "../../shared/levelConfluence";

const map = {
  spot: 7659.44,
  strikes: [
    { strike: 7700, share: 0.22, gexPct: 6.7e9, label: "wall above" },
    { strike: 7690, share: 0.02, gexPct: 0.8e9, label: null },
    { strike: 7675, share: 0.035, gexPct: 1.1e9, label: null },
    { strike: 7655, share: 0.08, gexPct: -2.6e9, label: null },
    { strike: 7630, share: 0.13, gexPct: -3.9e9, label: "magnet below" },
    { strike: 7600, share: 0.06, gexPct: -2.0e9, label: null },
    { strike: 7575, share: 0.045, gexPct: -1.5e9, label: null },
  ],
  landmarks: { pin: 7700, wallAbove: 7700, magnetBelow: 7630, pocketAbove: null, pocketBelow: null, flip: 7655 },
  range: { low: 7569.5, high: 7749.4 },
};

test("tolerance defaults to 0.1% of spot with a 2-point floor", () => {
  assert.equal(defaultTolerancePts(7659.44), 7.7);
  assert.equal(defaultTolerancePts(500), 2);
});

test("landmark beats chain beats weak beats chart only; distances and sides are reported", () => {
  const wall = checkLevel(map, 7698);
  assert.equal(wall.tag, "landmark");
  assert.deepEqual(wall.landmarks, ["pin", "wall above"]);
  assert.equal(wall.strike, 7700);
  assert.equal(wall.distancePts, 2);
  assert.equal(wall.side, "above");

  const shelf = checkLevel(map, 7629);
  assert.equal(shelf.tag, "landmark");
  assert.deepEqual(shelf.landmarks, ["magnet below"]);
  assert.equal(shelf.side, "below");

  const six = checkLevel(map, 7600);
  assert.equal(six.tag, "chain", "6% of exposure clears the 3% floor");
  assert.equal(six.distancePts, 0);
  assert.match(six.note, /on the 7,600 strike/);

  const weak = checkLevel(map, 7688);
  assert.equal(weak.tag, "weak", "7,690 carries 2%: under the floor");
  assert.equal(weak.strike, 7690);

  const chart = checkLevel(map, 7643);
  assert.equal(chart.tag, "chart_only");
  assert.equal(chart.strike, null);
  assert.equal(chart.insideStraddle, true);

  const far = checkLevel(map, 7500);
  assert.equal(far.tag, "chart_only");
  assert.equal(far.insideStraddle, false, "outside the straddle range");
});

test("at-the-money and the flip: spot itself reads 'at', the flip is a landmark", () => {
  const atm = checkLevel(map, 7660);
  assert.equal(atm.side, "at");
  assert.equal(atm.tag, "landmark");
  assert.deepEqual(atm.landmarks, ["gamma flip"]);
});

test("no map, no spot or no strikes is unavailable, never chart only", () => {
  assert.equal(checkLevel({ spot: null, strikes: map.strikes }, 7600).tag, "unavailable");
  assert.equal(checkLevel({ spot: 7659, strikes: [] }, 7600).tag, "unavailable");
  assert.equal(checkLevel(map, NaN).tag, "unavailable");
});

test("checkLevels dedupes, drops junk and sorts high to low; parseLevels accepts commas, spaces and thousands separators", () => {
  assert.deepEqual(parseLevels("7686, 7,643 7600;7600 abc 0"), [7686, 7643, 7600, 7600]);
  const out = checkLevels(map, [7600, 7686, 7600, NaN, 7629]);
  assert.deepEqual(out.map((o) => o.level), [7686, 7629, 7600]);
});
