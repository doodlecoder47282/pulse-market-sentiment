import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildVolCalendar, daysAway } from "../../server/volCalendar";
import { etDate, etWallToEpochMs, isTradingDay, nextTradingDay } from "../../shared/exchangeCalendar";

const src = (p: string) => readFileSync(p, "utf8");

test("the class of fault: from 7 PM New York time the UTC date is already tomorrow", () => {
  const evening = etWallToEpochMs("2026-11-23", 20 * 60 + 30); // Monday 8:30 PM ET
  assert.equal(etDate(evening), "2026-11-23");
  assert.equal(new Date(evening).toISOString().slice(0, 10), "2026-11-24");
});

test("days away is a count of calendar days: an event today is 0 away, whatever the server's clock zone", () => {
  const at = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return new Date(y, m - 1, dd, 12); };
  assert.equal(daysAway("2026-11-23", at("2026-11-23")), 0);
  assert.equal(daysAway("2026-11-24", at("2026-11-23")), 1);
  assert.equal(daysAway("2026-12-18", at("2026-11-23")), 25);
  assert.equal(daysAway("2027-03-15", at("2027-03-13")), 2, "across the spring clock change");
  assert.equal(daysAway("2026-11-02", at("2026-10-31")), 2, "across the autumn clock change");
});

test("the event calendar is built from New York's date, in the evening too", () => {
  const evening = etWallToEpochMs("2026-11-23", 21 * 60);
  const cal = buildVolCalendar(evening);
  assert.ok(cal.events.length > 0);
  assert.ok(cal.events.every((e) => e.date >= "2026-11-23"), "nothing before today");
  assert.ok(cal.events.every((e) => e.daysAway >= 0));
  // Each count is the calendar distance from New York's date, not from the UTC one.
  for (const e of cal.events) assert.equal(e.daysAway, Math.round((Date.parse(`${e.date}T12:00:00Z`) - Date.parse("2026-11-23T12:00:00Z")) / 86400000), e.label);
  // The same instant read on the UTC date would have been a day short on every count.
  const morning = buildVolCalendar(etWallToEpochMs("2026-11-23", 9 * 60));
  assert.deepEqual(cal.events.map((e) => [e.date, e.daysAway]), morning.events.map((e) => [e.date, e.daysAway]), "one New York day, one answer");
});

test("ten sessions ahead skip holidays as well as weekends", () => {
  // From Monday Nov 23, 2026: Thanksgiving (Thu Nov 26) is not a session.
  const dates: string[] = [];
  for (let d = nextTradingDay("2026-11-23"); dates.length < 10; d = nextTradingDay(d)) dates.push(d);
  assert.deepEqual(dates.slice(0, 5), ["2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30", "2026-12-01"]);
  assert.ok(dates.every(isTradingDay));
  const m = src("server/multiDayProjection.ts");
  assert.match(m, /for \(let d = nextTradingDay\(etDate\(Date\.now\(\)\)\); sessionDates\.length < 10; d = nextTradingDay\(d\)\) sessionDates\.push\(d\);/);
  assert.doesNotMatch(m, /nextWeekdayDate\(now, n\)/);
});

test("wiring: today is New York's date wherever a calendar day is compared", () => {
  assert.match(src("server/routes.ts"), /const todayIso = etDate\(Date\.now\(\)\); \/\/ New York's date/);
  assert.match(src("server/earnings.ts"), /const todayIso = etDate\(Date\.now\(\)\);/);
  assert.match(src("server/tickerCalendar.ts"), /function todayIsoUtc\(\): string \{\s+return etDate\(Date\.now\(\)\);/);
  assert.match(src("server/masterAlpha.ts"), /date: etDate\(Date\.now\(\)\),/);
  assert.match(src("server/volCalendar.ts"), /const \[ty, tm, td\] = etDate\(nowMs\)\.split\("-"\)\.map\(Number\);/);
  for (const f of ["server/earnings.ts", "server/tickerCalendar.ts", "server/masterAlpha.ts"]) {
    assert.doesNotMatch(src(f), /new Date\(\)\.toISOString\(\)\.(slice\(0, ?10\)|split\("T"\)\[0\])/, f);
  }
});
