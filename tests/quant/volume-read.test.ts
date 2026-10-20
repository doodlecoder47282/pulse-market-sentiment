// tests/quant/volume-read.test.ts
//
// Relative volume, quiet volume and block prints from what Schwab serves:
// states for missing inputs, paced ratios, and a block read that is a lower
// bound and never a venue claim.

import { test } from "node:test";
import assert from "node:assert/strict";
import { relativeVolume, quietVolume, blockPrints } from "../../shared/volumeRead";

const hist = Array.from({ length: 25 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, close: 100, volume: 1_000_000 + (i % 2) * 200_000 }));

test("relativeVolume: 20-session average excluding today, raw and paced", () => {
  const rv = relativeVolume(1_650_000, hist, "2026-09-25", 0.5);
  assert.equal(rv.sessions, 20);
  assert.equal(rv.dataState, "ok");
  assert.equal(rv.avg20, 1_100_000);
  assert.equal(rv.rel, 1.5);
  assert.equal(rv.relPaced, 3);
  const early = relativeVolume(50_000, hist, null, 0.02);
  assert.equal(early.relPaced, null, "under 5% of the session the pace is not read");
  const short = relativeVolume(1_000_000, hist.slice(0, 7), null, null);
  assert.equal(short.dataState, "partial");
  assert.match(short.reason!, /7 sessions/);
  const none = relativeVolume(null, hist, null, 0.5);
  assert.equal(none.dataState, "no_data");
  assert.equal(none.rel, null);
});

test("quietVolume: heavy paced volume with a small move flags; a missing input is null, not false", () => {
  const rv = relativeVolume(2_000_000, hist, null, 0.5); // paced 3.6x
  assert.equal(quietVolume(rv, 0.001).flag, true);
  assert.equal(quietVolume(rv, 0.02).flag, false);
  assert.equal(quietVolume(rv, null).flag, null);
  assert.match(quietVolume(rv, 0.001).note, /cannot say where it printed/);
});

test("blockPrints: threshold from the median print, share of volume, and the no-venue note", () => {
  const ticks = Array.from({ length: 200 }, (_, i) => ({ t: i, last: 100 + i * 0.01, lastSize: 100 + (i % 5) * 20, trade: true }));
  ticks.push({ t: 300, last: 101, lastSize: 25_000, trade: true }, { t: 301, last: 101.1, lastSize: 3_000, trade: true }, { t: 302, last: null, lastSize: null, trade: false });
  const b = blockPrints(ticks);
  assert.equal(b.available, true);
  assert.equal(b.threshold, 2_000, "8x a median near 140 is under the 2,000-share floor, so the floor applies");
  assert.equal(b.prints, 2);
  assert.equal(b.largest?.size, 25_000);
  assert.ok(b.shareOfVolume! > 0.4);
  assert.match(b.note, /not a dark-pool count/);
  const few = blockPrints(ticks.slice(0, 10));
  assert.equal(few.available, false);
  assert.match(few.note, /too few/);
});
