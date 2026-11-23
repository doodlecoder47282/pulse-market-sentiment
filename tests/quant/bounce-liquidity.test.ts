import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUnderperformers, avgDollarVolume, MIN_ADV_USD } from "../../server/underperformers";
import { SECTORS } from "../../server/sector-web";

// 60 sessions rising from 80 to about 110 with a little noise, then one sharp down day to 106: still above
// the 50-day average, below the 5-day.
const bars = (volume: number | undefined) => Array.from({ length: 61 }, (_, i) => ({ t: i, close: i === 60 ? 106 : 80 + i * 0.5 + (i % 2 ? 0.15 : -0.15), volume }));

test("average dollar volume is the bars' own volume, and unknown when there is none", () => {
  assert.equal(avgDollarVolume(bars(undefined)), null);
  const adv = avgDollarVolume(bars(3_000_000))!;
  assert.ok(adv > 300_000_000 && adv < 330_000_000, String(adv)); // closes of about 95 to 110 x 3,000,000 shares
  assert.equal(avgDollarVolume(bars(3_000_000).slice(-10)), null, "fewer than 20 sessions with volume");
});

test("the bounce list keeps a name only when it really trades over $200M a day", () => {
  const [liquid, thin, blank] = SECTORS[0].leaders;
  const daily = new Map<string, any>([[liquid, bars(3_000_000)], [thin, bars(200_000)], [blank, bars(undefined)]]);
  const r = buildUnderperformers(daily, { mode: "bounce" });
  assert.deepEqual(r.rows.map((x) => x.symbol), [liquid]);
  assert.ok(r.rows[0].advUsd! > MIN_ADV_USD);
  assert.deepEqual(r.leftOut, { thin: 1, noVolume: 1 });
  assert.match(r.notes, /over \$200M traded a day \(1 thinner name and 1 with no volume read left out\)/);
  // "All dumps" shows every one of them, with the true figure or null.
  const all = buildUnderperformers(daily, { mode: "all" });
  assert.equal(all.rows.length, 3);
  assert.equal(all.rows.find((x) => x.symbol === blank)!.advUsd, null);
});

test("a hard down day: the empty list says the names are below their averages, not that leaders are holding up", () => {
  const [a] = SECTORS[0].leaders;
  // A month-long slide: below both the 20- and the 50-day average.
  const slide = Array.from({ length: 61 }, (_, i) => ({ t: i, close: 120 - i * 0.5, volume: 5_000_000 }));
  const r = buildUnderperformers(new Map<string, any>([[a, slide]]), { mode: "bounce" });
  assert.equal(r.rows.length, 0);
  assert.equal(r.fallingKnives, 1);
});
