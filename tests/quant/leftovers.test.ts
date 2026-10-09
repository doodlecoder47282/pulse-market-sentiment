// Final-verification leftovers: no Kelly size from scenario odds, and missing
// minute-bar volume is flagged instead of read as a zero-volume print.
import { test } from "node:test";
import assert from "node:assert/strict";

test("decision block shows no size from scenario odds (finding 6.1)", async () => {
  const { formatDecisionBlock } = await import("../../server/decisionSupport.ts");
  // Strong bull odds used to produce a half-Kelly size: kellyFraction(0.6, 0.5) * 100.
  const out = formatDecisionBlock({ spot: 6600, probBull: 0.6, probBase: 0.25, probBear: 0.15, oneDayEM: 60 });
  assert.match(out, /long-leaning/);
  assert.match(out, /size: none/);
  assert.match(out, /Suggested size\s+none/);
  assert.doesNotMatch(out, /size \d/);
});

test("tick rule flags bars with missing volume and adds nothing for them", async () => {
  const { signedTickVolumeBars } = await import("../../server/signedVolume.ts");
  const bars = signedTickVolumeBars([
    { datetime: 0, close: 100, volume: 10 },
    { datetime: 1, close: 101, volume: 20 },   // up tick: +20
    { datetime: 2, close: 102, volume: null }, // up tick, volume missing: +0, flagged
    { datetime: 3, close: 101, volume: 5 },    // down tick: -5
  ]);
  assert.deepEqual(bars.map((b) => b.signedVolume), [20, 0, -5]);
  assert.equal(bars[2].cumulative, 15); // 20 + 0 - 5
  assert.equal(bars[1].volumeMissing, true);
  assert.equal(bars[0].volumeMissing, undefined);
});
