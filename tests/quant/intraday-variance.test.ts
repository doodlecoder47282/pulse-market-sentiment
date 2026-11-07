// Time-of-day variance profile for the 0DTE Wiener map: estimated from the
// desk's own 1-minute bars, flat below the session floor, and a time change
// that moves band shape only (touch odds, close distribution and expected
// range are invariant).
import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateVarianceProfile, flatProfile, cumulativeShare, remainingVarianceTimeChange,
  FULL_SESSION_SLOTS, MIN_SESSIONS, SLOT_MIN,
} from "../../shared/intradayVariance";
import { wienerMap } from "../../shared/odteWiener";

// Synthetic sessions: 390 one-minute closes with a U-shaped per-minute sd
// (3x at the open and close, 1x at lunch). dayOf maps t -> (date, mod).
function session(dayIndex: number, seed: number) {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2 ** 31; return x / 2 ** 31 - 0.5; };
  const bars: Array<{ t: number; close: number }> = [];
  let px = 6000;
  for (let m = 0; m < 390; m++) {
    const u = m / 389;
    const sd = 1 + 2 * (4 * (u - 0.5) ** 2); // 3 at the ends, 1 in the middle
    px *= Math.exp(sd * 0.0004 * rnd() * Math.sqrt(12));
    bars.push({ t: dayIndex * 86_400_000 + m * 60_000, close: px });
  }
  return bars;
}
const dayOf = (ms: number) => ({ date: `D${String(Math.floor(ms / 86_400_000)).padStart(3, "0")}`, mod: Math.floor((ms % 86_400_000) / 60_000) });

test("profile: flat below the session floor, U-shaped and normalised with enough sessions", () => {
  const few = estimateVarianceProfile([...session(0, 1), ...session(1, 2)], dayOf);
  assert.equal(few.source, "flat");
  assert.equal(few.sessions, 2, "the payload carries how many are stored even when flat");
  assert.match(few.note, new RegExp(`2 complete sessions stored, ${MIN_SESSIONS} needed`));
  assert.equal(few.slotShare.length, FULL_SESSION_SLOTS);
  const bars = Array.from({ length: 25 }, (_, d) => session(d, d + 7)).flat();
  const p = estimateVarianceProfile(bars, dayOf);
  assert.equal(p.source, "empirical");
  assert.equal(p.sessions, 20, "uses the most recent 20");
  // The first bar's own move counts in slot 0 when the open is known.
  const withOpen = bars.map((b, i, a) => ({ ...b, open: i > 0 && dayOf(a[i - 1].t).date === dayOf(b.t).date ? a[i - 1].close : b.close * 0.999 }));
  const p2 = estimateVarianceProfile(withOpen, dayOf);
  assert.ok(p2.slotShare[0] > p.slotShare[0], "slot 0 gains the opening bar's return");
  assert.ok(Math.abs(p.slotShare.reduce((s, v) => s + v, 0) - 1) < 1e-9);
  const open = p.slotShare[0], lunch = p.slotShare[39], close = p.slotShare[77];
  assert.ok(open > 3 * lunch && close > 3 * lunch, `U-shape: open ${open}, lunch ${lunch}, close ${close}`);
  assert.ok(p.peakRatio > 2);
  assert.match(p.note, /last 20 full sessions/);
  // A partial session (half day) is excluded from the estimate.
  const half = session(30, 3).filter((b) => dayOf(b.t).mod < 210);
  assert.equal(estimateVarianceProfile([...bars, ...half], dayOf).sessions, 20);
});

test("time change: cumulative share is monotone, 0 to 1 over the window, flat profile is t/T", () => {
  const f = flatProfile("test");
  assert.ok(Math.abs(cumulativeShare(f, 0, 390) - 1) < 1e-9);
  assert.ok(Math.abs(cumulativeShare(f, 0, 195) - 0.5) < 1e-9);
  const uFlat = remainingVarianceTimeChange(f, 120, 390);
  assert.ok(Math.abs(uFlat(135) - 135 / 270) < 1e-9);
  const bars = Array.from({ length: 25 }, (_, d) => session(d, d + 7)).flat();
  const p = estimateVarianceProfile(bars, dayOf);
  const u = remainingVarianceTimeChange(p, 0, 390);
  assert.equal(u(0), 0); assert.ok(Math.abs(u(390) - 1) < 1e-9);
  let prev = 0;
  for (let t = 0; t <= 390; t += SLOT_MIN) { const v = u(t); assert.ok(v >= prev - 1e-12); prev = v; }
  // The open carries more than its flat share: by 10:00 (30 min, 7.7% of the clock) well over 7.7% of variance is spent.
  assert.ok(u(30) > 0.12, `u(30)=${u(30)}`);
  // Half day: the window ends at 13:00; u still reaches 1 at its own close.
  const uHalf = remainingVarianceTimeChange(p, 0, 210);
  assert.ok(Math.abs(uHalf(210) - 1) < 1e-9);
});

test("wiener map under a time change: bands reshape; touch, close distribution and expected range are unchanged", () => {
  const bars = Array.from({ length: 25 }, (_, d) => session(d, d + 7)).flat();
  const p = estimateVarianceProfile(bars, dayOf);
  const base = { spot: 6000, sigmaFromIv: 40, straddle: null, minutesLeft: 390, startAbsMin: 570, horizon: "rest_of_today" as const,
    levels: [{ price: 6030, kind: "wall", label: "call wall" }, { price: 5950, kind: "wall", label: "put wall" }] };
  const flat = wienerMap(base);
  const shaped = wienerMap({ ...base, timeChange: remainingVarianceTimeChange(p, 0, 390), varianceProfile: p });
  assert.deepEqual(shaped.levels, flat.levels);
  assert.deepEqual(shaped.closeDist, flat.closeDist);
  assert.deepEqual(shaped.expected, flat.expected);
  assert.equal(shaped.sigmaToClose, flat.sigmaToClose);
  // Same end width, wider early.
  const last = (m: typeof flat) => m.bands[m.bands.length - 1].q.p975;
  assert.equal(last(shaped), last(flat));
  const at = (m: typeof flat, minute: number) => m.bands.find((b) => b.minute === minute)!.q.p975 - 6000;
  assert.ok(at(shaped, 30) > at(flat, 30) * 1.15, `shaped ${at(shaped, 30)} vs flat ${at(flat, 30)}`);
  assert.equal(shaped.varianceProfile.source, "empirical");
  assert.equal(flat.varianceProfile.source, "flat");
  assert.match(shaped.caveats.join(" "), /same under any profile/);
  // Bands never narrow even under a broken time change.
  const broken = wienerMap({ ...base, timeChange: (t) => (t > 100 && t < 200 ? 0.01 : t / 390) });
  let prevW = 0;
  for (const b of broken.bands) { const w = b.q.p975 - b.q.p025; assert.ok(w >= prevW - 1e-9); prevW = w; }
});
