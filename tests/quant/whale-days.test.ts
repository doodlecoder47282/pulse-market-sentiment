import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { daySpread, daySpreadAnswer } from "../../shared/whaleDays";

const r = (day: string, wins: number, losses: number) => [...Array(wins).fill({ day, win: true }), ...Array(losses).fill({ day, win: false })];

test("counts per day, newest first, and names the day that holds the most", () => {
  const s = daySpread([...r("2026-11-17", 1, 2), ...r("2026-11-18", 6, 3), ...r("2026-11-19", 0, 2)]);
  assert.deepEqual(s.byDay, [{ day: "2026-11-19", n: 2, wins: 0 }, { day: "2026-11-18", n: 9, wins: 6 }, { day: "2026-11-17", n: 3, wins: 1 }]);
  assert.deepEqual([s.total, s.wins, s.busiest?.day, s.mostWins?.day, s.oneDayCarries], [14, 7, "2026-11-18", "2026-11-18", true]);
  assert.equal(daySpreadAnswer(s), "The 14 scored closes fell on 3 days; 9 of them on 2026-11-18. 6 of the 7 that made money closed on 2026-11-18. One day holds half or more of this figure, so it moves with that day.");
});

test("an even spread is not flagged; ties go to the newest day", () => {
  const s = daySpread([...r("2026-11-16", 1, 1), ...r("2026-11-17", 1, 1), ...r("2026-11-18", 1, 1), ...r("2026-11-19", 1, 1), ...r("2026-11-20", 1, 1)]);
  assert.equal(s.oneDayCarries, false);
  assert.equal(s.busiest?.day, "2026-11-20");
  assert.equal(s.mostWins?.day, "2026-11-20");
  assert.doesNotMatch(daySpreadAnswer(s)!, /One day holds/);
});

test("wins on one day flag the figure even when closes are spread", () => {
  const s = daySpread([...r("2026-11-16", 0, 3), ...r("2026-11-17", 0, 3), ...r("2026-11-18", 4, 0), ...r("2026-11-19", 1, 3)]);
  assert.equal(s.busiest!.n * 2 >= s.total, false);
  assert.equal(s.oneDayCarries, true);
});

test("one day, one close, none, and no wins each read as what they are", () => {
  assert.match(daySpreadAnswer(daySpread(r("2026-11-18", 3, 2)))!, /^All 5 scored closes fell on one day \(2026-11-18\)/);
  assert.match(daySpreadAnswer(daySpread(r("2026-11-18", 1, 0)))!, /^One scored close, on 2026-11-18: a single result/);
  assert.equal(daySpreadAnswer(daySpread([])), null);
  assert.equal(daySpreadAnswer(null), null);
  const none = daySpread([...r("2026-11-17", 0, 1), ...r("2026-11-18", 0, 1), ...r("2026-11-19", 0, 1)]);
  assert.equal(none.mostWins, null);
  assert.equal(daySpreadAnswer(none), "The 3 scored closes fell on 3 days; 1 of them on 2026-11-19.");
  assert.equal(daySpread([{ day: "bad", win: true }]).total, 0, "a result without a day is not counted on a made-up one");
});

test("wiring: the snapshot carries the spread, the route passes it on, and the record sits above the new alerts", () => {
  const srv = readFileSync("server/whaleFollowThrough.ts", "utf8");
  assert.match(srv, /days\.push\(\{ day: etDate\(p\.statusAt\), win: s\.trade\.win \}\)/);
  assert.match(srv, /daySpread: daySpread\(days\)/);
  assert.match(readFileSync("server/routes.ts", "utf8"), /daySpread: whaleSnap\.daySpread/);
  const ui = readFileSync("client/src/components/WhaleFlowPanel.tsx", "utf8");
  assert.match(ui, /performance-day-spread/);
  assert.ok(ui.indexOf("<PerformanceCard />") > 0 && ui.indexOf("<PerformanceCard />") < ui.indexOf('data-testid="section-fresh-whales"'));
});
