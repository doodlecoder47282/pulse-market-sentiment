import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUnderperformers, avgDollarVolume, MIN_ADV_USD } from "../../server/underperformers";
import { SECTORS } from "../../server/sector-web";
import { emptyListLine, dollarsPerDay } from "../../shared/bounceList";
import { etWallToEpochMs } from "../../shared/exchangeCalendar";

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

test("an empty list says what happened: nothing read, nothing down, or why the down names are not on it", () => {
  const [a] = SECTORS[0].leaders;
  // A mild down day in an uptrend: down, but not unusually.
  const mild = Array.from({ length: 61 }, (_, i) => ({ t: i, close: i === 60 ? 109.6 : 80 + i * 0.5 + (i % 2 ? 1.5 : -1.5), volume: 5_000_000 }));
  const r = buildUnderperformers(new Map<string, any>([[a, mild]]), { mode: "bounce" });
  assert.equal(r.rows.length, 0);
  assert.deepEqual(r.counts, { scanned: 1, downToday: 1, fallingKnives: 0, notStretched: 1, thin: 0, noVolume: 0 });
  assert.equal(emptyListLine(r.counts, "bounce"), '1 of the 1 names read is down today, and none is on this list: 1 down by less than 1.5 standard deviations of their own daily moves. "All dumps" shows them.');
  const none = buildUnderperformers(new Map(), { mode: "bounce" });
  assert.equal(none.counts.scanned, 0);
  assert.match(emptyListLine(none.counts, "bounce"), /^No daily bars were read from Schwab.*not a statement that no stock is down/);
  assert.equal(emptyListLine({ scanned: 40, downToday: 0, fallingKnives: 0, notStretched: 0, thin: 0, noVolume: 0 }, "bounce"), "None of the 40 names read is down today.");
  assert.match(emptyListLine({ scanned: 40, downToday: 30, fallingKnives: 22, notStretched: 5, thin: 2, noVolume: 1 }, "bounce"), /^30 of the 40 names read are down today, and none is on this list: 22 below both their 20- and 50-day averages, 5 down by less than 1\.5 standard deviations of their own daily moves, 2 trading under the dollar-volume cut, 1 with no volume read\./);
});

test("today's partial bar is not part of the average while the session is open", () => {
  const day = (iso: string) => Date.parse(`${iso}T05:00:00Z`) / 1000; // midnight Eastern stamp
  const dates = ["2026-11-02","2026-11-03","2026-11-04","2026-11-05","2026-11-06","2026-11-09","2026-11-10","2026-11-11","2026-11-12","2026-11-13","2026-11-16","2026-11-17","2026-11-18","2026-11-19","2026-11-20","2026-10-05","2026-10-06","2026-10-07","2026-10-08","2026-10-09","2026-10-12","2026-10-13","2026-10-14","2026-10-15","2026-10-16","2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23"].sort();
  const full = dates.map((d) => ({ t: day(d), close: 100, volume: 2_050_000 })); // $205M a day
  const withToday = [...full, { t: day("2026-11-23"), close: 100, volume: 400_000 }]; // 20% of a day by mid-morning
  const tenAm = etWallToEpochMs("2026-11-23", 10 * 60), sixPm = etWallToEpochMs("2026-11-23", 18 * 60);
  assert.equal(avgDollarVolume(withToday, tenAm), 205_000_000, "the open session's bar is left out");
  assert.ok(avgDollarVolume(withToday, sixPm)! < 205_000_000, "after the close the bar is complete and counts");
  assert.ok(avgDollarVolume(withToday)! < 205_000_000);
});

test("dollars per day in a cell", () => {
  assert.deepEqual([null, 400_000, 340_400_000, 999_700_000, 1_240_000_000].map((v) => dollarsPerDay(v)), ["not read", "<$1M", "$340M", "$1.0B", "$1.2B"]);
});
