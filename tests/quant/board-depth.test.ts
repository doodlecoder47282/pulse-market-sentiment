// Range levels give the board a far side on a day that runs through the prior day, week and month; repeat
// crossings of one level are shown as one line.
import test from "node:test";
import assert from "node:assert/strict";
import { rangeLevels, nearestLevels, calendarLevels, RANGE_SHORT, RANGE_LONG_MIN, type DayBar } from "../../shared/levelBoard";
import { joinHits, HIT_JOIN_MIN, type HitRow } from "../../shared/protocols";

/** n completed weekdays ending 2026-11-18, low falling toward the oldest bar. */
function bars(n: number): DayBar[] {
  const out: DayBar[] = [];
  let ms = Date.UTC(2026, 10, 18);
  while (out.length < n) {
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) { const i = out.length; out.unshift({ date: new Date(ms).toISOString().slice(0, 10), open: 100, high: 110 + (i % 3), low: 95 - i * 0.5, close: 100 }); }
    ms -= 86_400_000;
  }
  return out;
}

test("range levels: 20 sessions, and every bar read once there are enough, labelled with the real count", () => {
  const d = bars(63);
  const ls = rangeLevels(d, "2026-11-19");
  const get = (k: string) => ls.find((l) => l.key === k)!;
  assert.equal(get("l20").price, 95 - 19 * 0.5);
  assert.equal(get("lAll").price, 95 - 62 * 0.5);
  assert.equal(get("lAll").label, "63-session low");
  assert.equal(get("h20").label, `${RANGE_SHORT}-session high`);
  assert.ok(ls.every((l) => l.group === "range"));
});

test("range levels: too few bars form no level, and a bar dated today never counts", () => {
  assert.deepEqual(rangeLevels(bars(RANGE_SHORT - 1), "2026-11-19"), []);
  assert.deepEqual(rangeLevels(bars(RANGE_LONG_MIN - 1), "2026-11-19").map((l) => l.key), ["h20", "l20"]);
  const d = bars(25);
  const withToday = [...d, { date: "2026-11-19", open: 100, high: 500, low: 1, close: 100 }];
  assert.deepEqual(rangeLevels(withToday, "2026-11-19"), rangeLevels(d, "2026-11-19"));
});

test("a price under every calendar level still has a level below once range levels are added", () => {
  const d = bars(63);
  const price = 70; // under the prior day, week and month lows of the recent bars
  const cal = calendarLevels(d, "2026-11-19");
  assert.equal(nearestLevels(cal, price).below.length, 0);
  assert.ok(nearestLevels([...cal, ...rangeLevels(d, "2026-11-19")], price).below.length > 0);
});

const row = (min: number, o: Partial<HitRow> = {}): HitRow => ({ at: min * 60_000, symbol: "$VIX", levelKey: "pdh", label: "prior-day high", levelPrice: 26.26, direction: "up", price: 26.3, ...o });

test("joinHits: crossings of one level close together become one line that keeps the count", () => {
  const lines = joinHits([row(0), row(1, { direction: "down", price: 26.2 }), row(4), row(30, { direction: "down" })]);
  assert.equal(lines.length, 2);
  const [newest, joined] = lines;
  assert.deepEqual([newest.count, newest.at], [1, 30 * 60_000]);
  assert.deepEqual([joined.count, joined.firstAt, joined.at, joined.direction, joined.price], [3, 0, 4 * 60_000, "up", 26.3]);
  assert.equal(lines.reduce((s, l) => s + l.count, 0), 4, "no crossing is dropped from the count");
});

test("joinHits: the window is measured from the previous crossing; other levels and tickers stay apart", () => {
  const chain = joinHits([row(0), row(HIT_JOIN_MIN), row(2 * HIT_JOIN_MIN), row(3 * HIT_JOIN_MIN + 1)]);
  assert.deepEqual(chain.map((l) => l.count), [1, 3]);
  const apart = joinHits([row(0), row(1, { symbol: "QQQ" }), row(2, { levelKey: "pwh", levelPrice: 25.08 })]);
  assert.equal(apart.length, 3);
  assert.deepEqual(joinHits([]), []);
});
