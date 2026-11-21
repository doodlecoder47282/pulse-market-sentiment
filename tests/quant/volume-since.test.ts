import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextVolumeState, type VolumeState } from "../../shared/volumeSince";

const run = (start: VolumeState, reads: Array<[number, string]>) => reads.reduce((s, [v, d]) => nextVolumeState(s, v, d), start);
// Flagged on the 17th with 5,000 contracts already traded that session.
const FLAG: VolumeState = { volume: 5000, since: 0, day: "2026-11-17" };

test("on the flag day it is the increase since the flag", () => {
  assert.deepEqual(run(FLAG, [[5200, "2026-11-17"], [6100, "2026-11-17"]]), { volume: 6100, since: 1100, day: "2026-11-17" });
});

test("the next session starts from zero and all of it counts: the old subtraction read zero here", () => {
  const s = run(FLAG, [[6100, "2026-11-17"], [300, "2026-11-18"], [2400, "2026-11-18"]]);
  assert.deepEqual(s, { volume: 2400, since: 1100 + 2400, day: "2026-11-18" });
  assert.equal(Math.max(0, 2400 - 5000), 0, "volume now minus volume at the flag");
  // A third session.
  assert.equal(run(s, [[50, "2026-11-19"], [900, "2026-11-19"]]).since, 1100 + 2400 + 900);
});

test("yesterday's total still being served before the open is not counted again", () => {
  const s = run(FLAG, [[6100, "2026-11-17"], [6100, "2026-11-18"], [6100, "2026-11-18"]]);
  assert.deepEqual(s, { volume: 6100, since: 1100, day: "2026-11-17" });
  // Then the new session's own count arrives.
  assert.deepEqual(run(s, [[40, "2026-11-18"], [700, "2026-11-18"]]), { volume: 700, since: 1800, day: "2026-11-18" });
});

test("a lower reading in the same session is a correction or an old snapshot: nothing is added, and nothing is counted twice when the feed catches up", () => {
  const s = run(FLAG, [[6100, "2026-11-17"], [5900, "2026-11-17"]]);
  assert.deepEqual(s, { volume: 6100, since: 1100, day: "2026-11-17" });
  assert.equal(run(s, [[6100, "2026-11-17"], [6150, "2026-11-17"]]).since, 1150);
  // The same on the new session once it has begun.
  const d2 = run(FLAG, [[300, "2026-11-18"], [900, "2026-11-18"], [850, "2026-11-18"], [1000, "2026-11-18"]]);
  assert.equal(d2.since, 1000);
});

test("bad readings change nothing; the count never goes down", () => {
  assert.deepEqual(nextVolumeState(FLAG, NaN, "2026-11-17"), FLAG);
  assert.deepEqual(nextVolumeState(FLAG, -5, "2026-11-18"), FLAG);
  let s = FLAG;
  let last = 0;
  for (const [v, d] of [[5100, "2026-11-17"], [4000, "2026-11-17"], [10, "2026-11-18"], [5, "2026-11-18"], [800, "2026-11-18"], [0, "2026-11-19"], [0, "2026-11-19"], [60, "2026-11-19"]] as Array<[number, string]>) {
    s = nextVolumeState(s, v, d);
    assert.ok(s.since >= last);
    last = s.since;
  }
  assert.equal(last, 100 + 800 + 60);
});

test("wiring: the follow-through carries the count and its session day, and old rows take the day from their last update", () => {
  const f = readFileSync("server/whaleFollowThrough.ts", "utf8");
  assert.match(f, /day: p\.live\.volumeDay \?\? etDate\(p\.live\.lastUpdateAt\)/);
  assert.match(f, /volumeSinceEntry: vol\.since,\s+volumeDay: vol\.day,/);
  assert.doesNotMatch(f, /newVolume - p\.entry\.volume/);
});
