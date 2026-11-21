import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextVolumeState, type VolumeState } from "../../shared/volumeSince";
import { etWallToEpochMs } from "../../shared/exchangeCalendar";

// A read at HH:MM ET on a date. 2026-11-17 is a Tuesday; 11-21/22 a weekend; 11-26 Thanksgiving; 11-27 a 13:00 half day.
const at = (d: string, hm: string) => { const [h, m] = hm.split(":").map(Number); return etWallToEpochMs(`2026-11-${d}`, h * 60 + m); };
const run = (start: VolumeState, reads: Array<[number, string, string]>) => reads.reduce((s, [v, d, t]) => nextVolumeState(s, v, at(d, t)), start);
// Flagged on the 17th with 5,000 contracts already traded that session.
const FLAG: VolumeState = { volume: 5000, since: 0, day: "2026-11-17" };

test("on the flag day it is the increase since the flag", () => {
  assert.deepEqual(run(FLAG, [[5200, "17", "11:00"], [6100, "17", "15:59"]]), { volume: 6100, since: 1100, day: "2026-11-17" });
});

test("the next session starts from zero and all of it counts: the old subtraction read zero here", () => {
  const s = run(FLAG, [[6100, "17", "15:59"], [300, "18", "09:31"], [2400, "18", "14:00"]]);
  assert.deepEqual(s, { volume: 2400, since: 1100 + 2400, day: "2026-11-18" });
  assert.equal(Math.max(0, 2400 - 5000), 0, "volume now minus volume at the flag");
  assert.equal(run(s, [[50, "19", "09:35"], [900, "19", "12:00"]]).since, 1100 + 2400 + 900, "a third session");
});

test("a first read of the day that is already above yesterday's total is still a whole new session", () => {
  // The server was down across the open, or the contract opened busier than it closed.
  const s = run(FLAG, [[6100, "17", "15:59"], [8000, "18", "10:40"], [9000, "18", "11:00"]]);
  assert.deepEqual(s, { volume: 9000, since: 1100 + 9000, day: "2026-11-18" });
});

test("a read before the open, on a weekend or on a holiday is ignored: the feed can still show the last session's total", () => {
  const closed = run(FLAG, [[6100, "17", "15:59"]]);
  assert.deepEqual(run(closed, [[6100, "18", "09:10"], [6100, "18", "09:29"]]), closed, "before the open");
  assert.deepEqual(run(closed, [[6100, "21", "12:00"], [6100, "22", "12:00"]]), closed, "a weekend");
  assert.deepEqual(run(closed, [[6100, "26", "12:00"]]), closed, "Thanksgiving");
  assert.deepEqual(run(closed, [[700, "27", "13:30"]]), closed, "after the 13:00 close on a half day");
  assert.equal(run(closed, [[6100, "18", "09:10"], [40, "18", "09:31"], [700, "18", "10:00"]]).since, 1100 + 700);
});

test("a lower reading in the same session adds nothing, and nothing is counted twice when the feed catches up", () => {
  const s = run(FLAG, [[6100, "17", "12:00"], [5900, "17", "12:01"]]);
  assert.deepEqual(s, { volume: 6100, since: 1100, day: "2026-11-17" });
  assert.equal(run(s, [[6100, "17", "12:02"], [6150, "17", "12:03"]]).since, 1150);
  assert.equal(run(FLAG, [[300, "18", "09:40"], [900, "18", "10:00"], [850, "18", "10:01"], [1000, "18", "10:02"]]).since, 1000);
});

test("a read stamped on an earlier day, or a bad reading, changes nothing; the count never goes down", () => {
  const d2 = run(FLAG, [[15, "18", "09:31"]]);
  assert.deepEqual(run(d2, [[6100, "17", "15:59"]]), d2, "an old chain re-served");
  assert.deepEqual(nextVolumeState(FLAG, NaN, at("17", "12:00")), FLAG);
  assert.deepEqual(nextVolumeState(FLAG, -5, at("18", "12:00")), FLAG);
  assert.deepEqual(nextVolumeState(FLAG, 9000, NaN), FLAG);
  let s = FLAG, last = 0;
  for (const r of [[5100, "17", "10:00"], [4000, "17", "10:01"], [10, "18", "09:31"], [5, "18", "09:32"], [800, "18", "15:00"], [0, "19", "09:31"], [60, "19", "11:00"]] as Array<[number, string, string]>) {
    s = nextVolumeState(s, r[0], at(r[1], r[2]));
    assert.ok(s.since >= last);
    last = s.since;
  }
  assert.equal(last, 100 + 800 + 60);
});

test("the one case that is not a floor is written down, not hidden", () => {
  // The previous session's total served again, stamped in today's session, after today's count was read.
  const s = run(FLAG, [[6100, "17", "15:59"], [15, "18", "09:31"], [6100, "18", "09:33"], [3000, "18", "11:00"]]);
  assert.equal(s.since, 1100 + 6100, "counted again: an overcount of the truth (1100 + 3000)");
  assert.match(readFileSync("shared/volumeSince.ts", "utf8"), /One case is NOT a floor and is not verified against the live feed/);
  assert.match(readFileSync("shared/whaleWords.ts", "utf8"), /Usually a floor/);
});

test("wiring: the follow-through passes the read's own time and carries the session day", () => {
  const f = readFileSync("server/whaleFollowThrough.ts", "utf8");
  assert.match(f, /day: p\.live\.volumeDay \?\? etDate\(p\.live\.lastUpdateAt\) \},\s+live\.volume, quoteAt,/);
  assert.match(f, /volumeSinceEntry: vol\.since,\s+volumeDay: vol\.day,/);
  assert.doesNotMatch(f, /newVolume - p\.entry\.volume/);
});
