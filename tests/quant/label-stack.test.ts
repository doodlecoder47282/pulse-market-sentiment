// Label spreading for level labels on a price chart (shared/labelStack.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spreadLabels } from "../../shared/labelStack";

const gaps = (ys: number[]) => { const s = [...ys].sort((a, b) => a - b); return s.slice(1).map((y, i) => y - s[i]); };

test("spreadLabels: separated labels are untouched; close ones are pushed apart in order, inside the bounds", () => {
  assert.deepEqual(spreadLabels([10, 50, 90], 12, 0, 100), [10, 50, 90]);
  const out = spreadLabels([40, 41, 42, 80], 12, 0, 100);
  assert.ok(gaps(out).every((g) => g >= 12 - 1e-9), `gaps ${gaps(out)}`);
  // order preserved and the group stays centred near its levels (moved as little as possible)
  assert.ok(out[0] < out[1] && out[1] < out[2] && out[2] < out[3]);
  assert.ok(out[0] >= 28 && out[2] <= 54, `group ${out}`);
  assert.equal(out[3], 80);
});

test("spreadLabels: a cluster at the bottom is pulled back up; the top bound holds; unsorted input keeps its indexes", () => {
  const out = spreadLabels([98, 99, 100], 12, 0, 100);
  assert.deepEqual(out, [76, 88, 100]);
  const top = spreadLabels([0, 1, 2], 12, 0, 100);
  assert.deepEqual(top, [0, 12, 24]);
  const mixed = spreadLabels([50, 10, 11], 12, 0, 100);
  assert.equal(mixed[0], 50);
  assert.ok(mixed[2] - mixed[1] >= 12 && mixed[1] <= 10);
});

test("spreadLabels: more labels than room spreads them evenly; empty input is empty", () => {
  const out = spreadLabels([5, 5, 5, 5, 5, 5], 20, 0, 50);
  assert.deepEqual(out.map((y) => Math.round(y)), [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(spreadLabels([], 12, 0, 100), []);
});
