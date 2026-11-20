import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { daySpread, daySpreadAnswer, DAY_WINS_FLOOR } from "../../shared/whaleDays";

const r = (day: string, wins: number, losses: number) => [...Array(wins).fill({ day, win: true }), ...Array(losses).fill({ day, win: false })];

test("counts per flag day, newest first, and names the one day that holds most positions and most wins", () => {
  const s = daySpread([...r("2026-11-17", 1, 2), ...r("2026-11-18", 6, 3), ...r("2026-11-19", 0, 2)]);
  assert.deepEqual(s.byDay, [{ day: "2026-11-19", n: 2, wins: 0 }, { day: "2026-11-18", n: 9, wins: 6 }, { day: "2026-11-17", n: 3, wins: 1 }]);
  assert.deepEqual([s.total, s.wins, s.busiest?.day, s.mostWins?.day, s.dayHoldsMostPositions, s.dayHoldsMostWins], [14, 7, "2026-11-18", "2026-11-18", true, true]);
  assert.equal(daySpreadAnswer(s), "The 14 scored positions were flagged on 3 days. 2026-11-18 holds 9 of the 14. 2026-11-18 holds 6 of the 7 that made money, so the win count moves with that day's alerts.");
});

test("an even split names no day: exactly half is not most", () => {
  const two = daySpread([...r("2026-11-18", 5, 5), ...r("2026-11-19", 5, 5)]);
  assert.deepEqual([two.busiest, two.mostWins, two.dayHoldsMostPositions, two.dayHoldsMostWins], [null, null, false, false]);
  assert.equal(daySpreadAnswer(two), "The 20 scored positions were flagged on 2 days.");
  // 20 positions over 4 days, wins 1/0/1/0: two wins on two days carry nothing.
  const split = daySpread([...r("2026-11-16", 1, 4), ...r("2026-11-17", 0, 5), ...r("2026-11-18", 1, 4), ...r("2026-11-19", 0, 5)]);
  assert.equal(split.dayHoldsMostWins, false);
  assert.equal(daySpreadAnswer(split), "The 20 scored positions were flagged on 4 days.");
  // Two positions on two days.
  assert.equal(daySpreadAnswer(daySpread([...r("2026-11-18", 1, 0), ...r("2026-11-19", 0, 1)])), "The 2 scored positions were flagged on 2 days.");
});

test("wins and positions can point at different days, and each sentence names its own day and measure", () => {
  const s = daySpread([...r("2026-11-17", 0, 8), ...r("2026-11-18", 3, 0), ...r("2026-11-19", 1, 2)]);
  assert.deepEqual([s.busiest?.day, s.mostWins?.day, s.dayHoldsMostPositions, s.dayHoldsMostWins], ["2026-11-17", "2026-11-18", true, true]);
  assert.equal(daySpreadAnswer(s), "The 14 scored positions were flagged on 3 days. 2026-11-17 holds 8 of the 14. 2026-11-18 holds 3 of the 4 that made money, so the win count moves with that day's alerts.");
});

test("fewer wins than the floor says nothing about where the wins came from", () => {
  assert.equal(DAY_WINS_FLOOR, 3);
  const s = daySpread([...r("2026-11-17", 0, 3), ...r("2026-11-18", 2, 1), ...r("2026-11-19", 0, 3)]);
  assert.equal(s.dayHoldsMostWins, false);
  assert.doesNotMatch(daySpreadAnswer(s)!, /made money/);
});

test("one day, one position, none, and a result without a day each read as what they are", () => {
  assert.match(daySpreadAnswer(daySpread(r("2026-11-18", 3, 2)))!, /^All 5 scored positions were flagged on one day \(2026-11-18\)/);
  assert.match(daySpreadAnswer(daySpread(r("2026-11-18", 1, 1)))!, /^Both scored positions were flagged on one day/);
  assert.match(daySpreadAnswer(daySpread(r("2026-11-18", 1, 0)))!, /^One scored position, flagged on 2026-11-18: a single result/);
  assert.equal(daySpreadAnswer(daySpread([])), null);
  assert.equal(daySpreadAnswer(null), null);
  assert.equal(daySpread([{ day: "bad", win: true }]).total, 0, "not counted on a made-up day");
});

test("wiring: keyed on the day flagged, over the scored set; the route passes it on; a failed read is not an empty record; the record sits above the new alerts", () => {
  const srv = readFileSync("server/whaleFollowThrough.ts", "utf8");
  assert.match(srv, /if \(s\) \{ scored\.push\(s\); days\.push\(\{ day: flagDay\(p\), win: s\.trade\.win \}\); \}/);
  assert.match(srv, /Number\.isFinite\(t\) && t > 0 \? etDate\(t\) : ""/);
  assert.match(srv, /daySpread: daySpread\(days\)/);
  assert.match(readFileSync("server/routes.ts", "utf8"), /daySpread: whaleSnap\.daySpread/);
  const ui = readFileSync("client/src/components/WhaleFlowPanel.tsx", "utf8");
  assert.match(ui, /performance-day-spread/);
  assert.match(ui, /performance-failed/);
  assert.ok(ui.indexOf("perfQuery.isError ? (") < ui.indexOf("showRows.length === 0 ? ("), "the failed state is checked before the empty one");
  assert.ok(ui.indexOf("<PerformanceCard />") > 0 && ui.indexOf("<PerformanceCard />") < ui.indexOf('data-testid="section-fresh-whales"'));
});
