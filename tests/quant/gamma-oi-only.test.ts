// Master list X15, step 1: the option map can be built on open interest alone, and the route serves that
// beside the levels it serves today, so the change can be measured on live data before it is made.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("one function decides the contract count for both the strike exposures and the turning point", () => {
  const f = read("server/odteForward.ts");
  assert.match(f, /const contractWeight = \(oi: number, vol: number\) => \(weightMode === "oi" \? oi : oi \+ vol \* HYBRID_VOLUME_WEIGHT\);/);
  assert.match(f, /const weight = contractWeight\(oi, vol\);/);
  assert.match(f, /weight: \(c: any\) => contractWeight\(Number\(c\?\.openInterest\) \|\| 0, Number\(c\?\.totalVolume\) \|\| 0\),/);
  assert.equal((f.match(/vol \* HYBRID_VOLUME_WEIGHT|totalVolume\) \|\| 0\) \* HYBRID_VOLUME_WEIGHT/g) ?? []).length, 1, "no second place blends volume in");
  // The served default is unchanged in this step.
  assert.match(f, /weightMode: GammaWeightMode = "hybrid"\)/);
  assert.match(f, /weightMode === "oi" \? "open_interest" : "oi_plus_quarter_volume"/);
});

test("both views of the map carry the open-interest-only levels, and both cards show them", () => {
  const r = read("server/routes.ts");
  assert.match(r, /oiOnly: await oiOnlyLevels\("week", b\)/);
  assert.match(r, /oiOnly: await oiOnlyLevels\("nearest", fwd\.body\)/);
  // Once per read of the option data: no second re-pricing on every poll, no drift while levels are held.
  assert.match(r, /if \(hit && hit\.fp === fp\) return hit\.levels;/);
  assert.match(read("client/src/components/TodayCard.tsx"), /<OiOnlyCompare oiOnly=\{\(m as any\)\.oiOnly\} testId="today-oi-only"/);
  assert.match(read("client/src/components/TodayWeek.tsx"), /testId="today-week-oi-only"/);
});
