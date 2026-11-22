import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildVolCalendar, daysAway } from "../../server/volCalendar";
import { etDate, etWallToEpochMs, isTradingDay, nextTradingDay } from "../../shared/exchangeCalendar";
import { eventsOnEtDate, PLAYBOOK_EVENTS_MAX, releaseCalendarNote, releaseGroup } from "../../shared/playbookEvents";
import { buildHorizonDates } from "../../server/horizonDates";
import { horizonTargetIso } from "../../server/impliedScenario";

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
});

test("wiring: today is New York's date wherever a calendar day is compared", () => {
  assert.match(src("server/earnings.ts"), /const todayIso = etDate\(Date\.now\(\)\);/);
  assert.match(src("server/tickerCalendar.ts"), /function todayIsoUtc\(\): string \{\s+return etDate\(Date\.now\(\)\);/);
  assert.match(src("server/masterAlpha.ts"), /date: etDate\(Date\.now\(\)\),/);
  assert.match(src("server/volCalendar.ts"), /const \[ty, tm, td\] = etDate\(nowMs\)\.split\("-"\)\.map\(Number\);/);
  for (const f of ["server/earnings.ts", "server/tickerCalendar.ts", "server/masterAlpha.ts"]) {
    assert.doesNotMatch(src(f), /new Date\(\)\.toISOString\(\)\.(slice\(0, ?10\)|split\("T"\)\[0\])/, f);
  }
});

test("the playbook's releases are the HIGH ones on New York's date, read from the event's own time, one line per release", () => {
  const at = (d: string, min: number) => Math.floor(etWallToEpochMs(d, min) / 1000);
  const cal = [
    { kind: "ECON", title: "MBA Mortgage Applications", when: at("2026-11-23", 7 * 60), whenLabel: "7:00 AM ET", importance: "LOW" },
    // One CPI release as the calendar can carry it when the official read fails: three vendor rows and a computed one.
    { kind: "ECON", title: "CPI MoM", family: "CPI", when: at("2026-11-23", 8 * 60 + 30), whenLabel: "Mon 11/23 · 8:30 AM ET", importance: "HIGH" },
    { kind: "ECON", title: "Core CPI MoM", family: "CPI", when: at("2026-11-23", 8 * 60 + 30), whenLabel: "Mon 11/23 · 8:30 AM ET", importance: "HIGH" },
    { kind: "ECON", title: "CPI YoY", family: "CPI", when: at("2026-11-23", 8 * 60 + 30), whenLabel: "Mon 11/23 · 8:30 AM ET", importance: "HIGH" },
    { kind: "ECON", title: "CPI Release (CPI)", family: "CPI", when: at("2026-11-23", 8 * 60 + 30), whenLabel: "Mon 11/23 · 8:30 AM ET", importance: "HIGH" },
    { kind: "FED", title: "FOMC Rate Decision", when: at("2026-11-23", 14 * 60), whenLabel: "Mon 11/23 · 2:00 PM ET", importance: "HIGH" },
    // 7:30 PM New York time: already the 24th in UTC, still today's event.
    { kind: "ECON", title: "Some evening release", when: at("2026-11-23", 19 * 60 + 30), whenLabel: "Mon 11/23 · 7:30 PM ET", importance: "HIGH" },
    { kind: "FED", title: "Fed speaker", when: at("2026-11-23", 12 * 60), whenLabel: "", importance: "MED" },
    { kind: "ECON", title: "GDP", when: at("2026-11-24", 8 * 60 + 30), whenLabel: "Tue", importance: "HIGH" },
    { kind: "OPEX", title: "Weekly expiry", when: at("2026-11-23", 16 * 60), whenLabel: "", importance: "HIGH" },
    { kind: "EARNINGS", title: "NVDA", when: at("2026-11-23", 16 * 60 + 5), whenLabel: "", importance: "HIGH" },
    { kind: "ECON", title: "no time", importance: "HIGH" },
  ];
  const got = eventsOnEtDate(cal, "2026-11-23");
  assert.deepEqual(got.map((e) => e.label), ["CPI", "FOMC decision", "Some evening release"]);
  assert.equal(got[0].timeLabel, "Mon 11/23 · 8:30 AM ET");
  assert.doesNotMatch(JSON.stringify(got), /recession|Risk-on|Mortgage/);
  assert.deepEqual(eventsOnEtDate(cal, "2026-11-24").map((e) => e.label), ["GDP"]);
  assert.deepEqual(eventsOnEtDate(null, "2026-11-23"), []);
  const many = Array.from({ length: 9 }, (_, i) => ({ kind: "ECON", title: `e${i}`, when: at("2026-11-23", 480 + i), whenLabel: "", importance: "HIGH" }));
  assert.deepEqual(eventsOnEtDate(many, "2026-11-23").map((e) => e.label), ["e0", "e1", "e2", "e3"]);
  assert.equal(PLAYBOOK_EVENTS_MAX, 4);
  // Grouping: the calendar's own family key first; one rate decision is one line; everything else is itself.
  assert.deepEqual(releaseGroup("Unemployment Rate", "NFP"), { key: "family:NFP", label: "Jobs report (NFP)" });
  assert.equal(releaseGroup("Fed Interest Rate Decision", null).label, "FOMC decision");
  assert.equal(releaseGroup("FOMC Press Conference", undefined).key, releaseGroup("FOMC Decision", null).key);
  assert.equal(releaseGroup("FOMC Meeting Minutes", null).label, "FOMC Meeting Minutes", "minutes are not a decision");
  assert.equal(releaseGroup("FOMC Member Waller Speaks", null).label, "FOMC Member Waller Speaks");
  assert.equal(releaseGroup("ADP Nonfarm Employment Change", null).label, "ADP Nonfarm Employment Change", "not the jobs report");
  assert.equal(releaseGroup("Nonfarm Productivity (QoQ)", "PRODUCTIVITY").label, "Productivity and costs");
  const jobsDay = ["Nonfarm Payrolls", "Unemployment Rate", "Average Hourly Earnings (MoM)"].map((title) => ({ kind: "ECON", title, family: "NFP", when: at("2026-12-04", 510), whenLabel: "8:30", importance: "HIGH" }));
  assert.deepEqual(eventsOnEtDate(jobsDay, "2026-12-04").map((e) => e.label), ["Jobs report (NFP)"]);
  // An empty list from a calendar that was not read is said to be unknown.
  const st = (bls: string, bea: string, tsy: string, nq: string) => [{ id: "bls_calendar", state: bls }, { id: "bea_calendar", state: bea }, { id: "treasury_auctions", state: tsy }, { id: "nasdaq_econ", state: nq }];
  assert.equal(releaseCalendarNote(st("ok", "ok", "ok", "ok")), null);
  assert.equal(releaseCalendarNote(st("ok", "empty", "failed", "ok")), null, "auctions are not releases");
  assert.equal(releaseCalendarNote(st("ok", "ok", "ok", "partial")), null, "one failed Nasdaq day of fourteen");
  assert.equal(releaseCalendarNote(st("ok", "ok", "ok", "not_configured")), null);
  assert.equal(releaseCalendarNote(st("failed", "ok", "ok", "ok")), "Scheduled releases today: not known (the BLS release calendar was not read). This is not a statement that nothing is scheduled.");
  assert.match(String(releaseCalendarNote(st("stale", "failed", "ok", "failed"))), /the BLS, BEA and Nasdaq release calendars were not read/);
  assert.match(String(releaseCalendarNote(null)), /could not be read\). This is not a statement that nothing is scheduled/);
  // The route reads the event's time, not a date field the events do not carry.
  const routes = src("server/routes.ts");
  assert.ok(routes.includes("eventsOnEtDate(news.calendar, etDate(Date.now()))"));
  assert.ok(routes.includes("releaseCalendarNote: todaysEvents.length === 0 ? releaseCalendarNote(releaseSources) : null"));
  assert.ok(!routes.includes("e.date === todayIso"));
});

test("horizon labels are on New York's date and agree with the chain pricing, in the evening too", () => {
  const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
  const cases: Array<[string, number]> = [
    ["2026-11-23", 20 * 60 + 30], // Monday evening: UTC is Tuesday
    ["2026-11-20", 20 * 60],      // monthly OPEX evening: UTC is Saturday
    ["2026-11-20", 10 * 60],      // monthly OPEX morning
    ["2026-11-19", 21 * 60],      // the evening before OPEX
    ["2026-11-21", 12 * 60],      // Saturday
    ["2026-12-31", 22 * 60],      // New Year's Eve: UTC is next year
    ["2026-11-25", 9 * 60],
  ];
  for (const [d, min] of cases) {
    const ms = etWallToEpochMs(d, min);
    const daily = buildHorizonDates("daily", ms);
    assert.ok(daily.spotAnchorDate.endsWith(` ${md(d)}`), `${d} ${min}: anchor ${daily.spotAnchorDate}`);
    for (const h of ["weekly", "monthly", "quarterly"] as const) {
      const iso = horizonTargetIso(h, new Date(ms));
      const lab = buildHorizonDates(h, ms).targetDate;
      assert.ok(lab.endsWith(` ${md(iso)}`), `${h} at ${d} ${min}: label ${lab}, priced ${iso}`);
    }
  }
});

test("cone bands are dated from the bar they start from", () => {
  const m = src("server/multiDayProjection.ts");
  assert.ok(m.includes("nextTradingDay(etDate(asOfTs + 12 * 3600_000))"));
  // A bar stamped midnight UTC, midnight Central or midnight Eastern of Tuesday Nov 24 is Tuesday's bar: band 1 is Wednesday.
  for (const stamp of [Date.UTC(2026, 10, 24, 0), Date.UTC(2026, 10, 24, 5), Date.UTC(2026, 10, 24, 6)]) {
    assert.equal(nextTradingDay(etDate(stamp + 12 * 3600_000)), "2026-11-25");
  }
  assert.ok(!m.includes("nextWeekdayDate"));
  // Before Monday's open the last bar is Friday's: band 1 is Monday, not Tuesday.
  assert.equal(nextTradingDay(etDate(etWallToEpochMs("2026-11-20", 60) + 12 * 3600_000)), "2026-11-23");
  // Wednesday's bar before Thanksgiving: band 1 is Friday.
  assert.equal(nextTradingDay("2026-11-25"), "2026-11-27");
});
