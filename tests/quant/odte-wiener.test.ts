// shared/odteWiener.ts: the 0DTE Wiener baseline and its scorecard.
import test from "node:test";
import assert from "node:assert/strict";
import { normCdf, hitProbability, wienerMap, scoreWienerDay, wienerScorecard, BAND_Z, SCORECARD_MIN_DAYS, type WienerInputs } from "../../shared/odteWiener.ts";

const close = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);

const base = (over: Partial<WienerInputs> = {}): WienerInputs => ({
  spot: 6800, sigmaFromIv: 30, straddle: 24, minutesLeft: 240, startAbsMin: 12 * 60, horizon: "rest_of_today",
  levels: [
    { price: 6850, kind: "call_wall", label: "call wall" },
    { price: 6780, kind: "gamma_flip", label: "flip" },
    { price: 6750, kind: "put_wall", label: "put wall" },
    { price: 6800, kind: "pin", label: "pin" },
  ],
  ...over,
});

test("wiener: normal CDF matches reference values", () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1), 0.8413447461, 2e-7);
  close(normCdf(-1.959964), 0.025, 2e-7);
  close(normCdf(2.5758293), 0.995, 2e-7);
  close(normCdf(-3), 0.0013498980, 2e-7);
  assert.equal(normCdf(Infinity), 1);
  assert.equal(normCdf(-Infinity), 0);
});

test("wiener: driftless first passage is the reflection principle; the drift formula agrees with a seeded simulation", () => {
  // Driftless: P(hit a by T) = 2 (1 - Phi(a / (sigma sqrt T))).
  close(hitProbability(1, 0, 1, 1), 2 * (1 - normCdf(1)), 1e-12);
  assert.equal(hitProbability(0, 0, 1, 1), 1);
  assert.equal(hitProbability(-1, 0, 1, 1), 1);
  // Continuity at mu -> 0.
  close(hitProbability(1, 1e-9, 1, 1), hitProbability(1, 0, 1, 1), 1e-6);
  // Positive drift toward the barrier raises the odds, negative lowers them.
  assert.ok(hitProbability(1, 0.5, 1, 1) > hitProbability(1, 0, 1, 1));
  assert.ok(hitProbability(1, -0.5, 1, 1) < hitProbability(1, 0, 1, 1));
  // Seeded Euler simulation with a fine grid (discrete monitoring undercounts slightly).
  let s = 12345;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const mu = 0.4, sig = 1, T = 1, a = 0.8, steps = 2000, paths = 6000;
  const dt = T / steps;
  let hits = 0;
  for (let p = 0; p < paths; p++) {
    let x = 0;
    for (let k = 0; k < steps; k++) { x += mu * dt + sig * Math.sqrt(dt) * gauss(); if (x >= a) { hits++; break; } }
  }
  close(hits / paths, hitProbability(a, mu, sig, T), 0.03, "drifted first passage vs simulation");
});

test("wiener: bands start at the price, widen with sqrt(time), and end at the market's 1-sigma", () => {
  const m = wienerMap(base());
  assert.equal(m.state, "ok");
  assert.equal(m.sigmaSource, "atm_iv");
  const first = m.bands[0], last = m.bands[m.bands.length - 1];
  assert.equal(first.minute, 0);
  assert.equal(first.et, "12:00");
  for (const k of Object.keys(BAND_Z)) assert.equal((first.q as any)[k], 6800, `t=0 ${k}`);
  assert.equal(last.minute, 240);
  assert.equal(last.et, "16:00");
  close(last.q.p975, 6800 + 1.959964 * 30, 0.01);
  close(last.q.p10, 6800 - 1.281552 * 30, 0.01);
  assert.equal(last.q.p50, 6800, "zero drift: the median stays at the price");
  // sqrt(time): at t = T/4 the band is half as wide as at T.
  const quarter = m.bands.find((b) => b.minute === 60)!;
  close(quarter.q.p975 - 6800, (last.q.p975 - 6800) / 2, 0.02);
  for (let i = 1; i < m.bands.length; i++) assert.ok(m.bands[i].q.p90 >= m.bands[i - 1].q.p90, "widening");
});

test("wiener: level odds: touch = 2 x close-beyond (reflection), close odds sum to 1, at-the-price = 1", () => {
  const m = wienerMap(base());
  const wall = m.levels.find((l) => l.kind === "call_wall")!;
  assert.equal(wall.side, "above");
  close(wall.distanceSigma, 50 / 30, 0.01);
  close(wall.pCloseAbove, 1 - normCdf(50 / 30), 1e-4);
  close(wall.pTouch, 2 * wall.pCloseAbove, 2e-4, "driftless: P(touch above) = 2 P(close above)");
  close(wall.pCloseAbove + wall.pCloseBelow, 1, 1e-4);
  const put = m.levels.find((l) => l.kind === "put_wall")!;
  close(put.pTouch, 2 * put.pCloseBelow, 2e-4);
  const pin = m.levels.find((l) => l.kind === "pin")!;
  assert.equal(pin.side, "at");
  assert.equal(pin.pTouch, 1);
  for (const l of m.levels) assert.ok(l.pTouch >= 0 && l.pTouch <= 1);
  assert.deepEqual(m.levels.map((l) => l.price), [6850, 6800, 6780, 6750], "sorted high to low");
});

test("wiener: expected remaining high, low and range of a driftless walk", () => {
  const m = wienerMap(base());
  const ext = 30 * Math.sqrt(2 / Math.PI);
  close(m.expected!.high, 6800 + ext, 0.01);
  close(m.expected!.low, 6800 - ext, 0.01);
  close(m.expected!.range, 2 * ext, 0.01);
});

test("wiener: the close distribution covers everything and is contiguous", () => {
  const m = wienerMap(base({ bucket: 5 }));
  const sum = m.closeDist.reduce((s, b) => s + b.p, 0);
  close(sum, 1, 2e-3);
  assert.equal(m.closeDist[0].lo, null);
  assert.equal(m.closeDist[m.closeDist.length - 1].hi, null);
  for (let i = 1; i < m.closeDist.length; i++) assert.equal(m.closeDist[i].lo, m.closeDist[i - 1].hi);
  const inner = m.closeDist.slice(1, -1);
  assert.ok(inner.every((b) => (b.hi! - b.lo!) === 5));
  // The bucket holding the price is the most likely.
  const at = inner.find((b) => b.lo! <= 6800 && 6800 < b.hi!)!;
  assert.equal(Math.max(...inner.map((b) => b.p)), at.p);
});

test("wiener: sigma falls back to the ATM straddle, labelled; the straddle cross-check is reported", () => {
  const m = wienerMap(base({ sigmaFromIv: null, straddle: 24 }));
  assert.equal(m.sigmaSource, "atm_straddle");
  close(m.sigmaToClose!, 24 / Math.sqrt(2 / Math.PI), 0.01);
  const both = wienerMap(base());
  close(both.sigmaFromStraddle!, 24 / Math.sqrt(2 / Math.PI), 0.01);
  assert.equal(both.sigmaToClose, 30, "IV first when present");
});

test("wiener: missing inputs give an unavailable state with the reason, never a made-up cone", () => {
  const noSigma = wienerMap(base({ sigmaFromIv: null, straddle: null }));
  assert.equal(noSigma.state, "unavailable");
  assert.match(noSigma.reason!, /no implied volatility or straddle/);
  assert.equal(noSigma.bands.length, 0);
  assert.equal(noSigma.expected, null);
  const noSpot = wienerMap(base({ spot: null }));
  assert.equal(noSpot.state, "unavailable");
  assert.match(noSpot.reason!, /no current price/);
  const noTime = wienerMap(base({ minutesLeft: 0 }));
  assert.equal(noTime.state, "unavailable");
  assert.match(noTime.reason!, /no session time left/);
  assert.equal(wienerMap(base({ sigmaFromIv: NaN, straddle: -1 })).state, "unavailable");
});

test("wiener: a half-day session ends at its own close", () => {
  const m = wienerMap(base({ minutesLeft: 210, startAbsMin: 9 * 60 + 30 }));
  assert.equal(m.bands[m.bands.length - 1].et, "13:00");
});

test("wiener scorecard: levels touched before the snapshot are left out; touches count only after it", () => {
  const m = wienerMap(base({ levels: [
    { price: 6850, kind: "call_wall", label: "w" },
    { price: 6750, kind: "put_wall", label: "p" },
    { price: 6790, kind: "orb_low", label: "orb low", touchedToday: true },
    { price: 6800, kind: "pin", label: "pin" },
  ] }));
  const s = scoreWienerDay(m, { settle: 6830, highAfter: 6852, lowAfter: 6790 });
  assert.deepEqual(s.map((x) => x.price).sort(), [6750, 6850]);
  const wall = s.find((x) => x.price === 6850)!;
  assert.equal(wall.touched, true);
  assert.equal(wall.closedAbove, false);
  const put = s.find((x) => x.price === 6750)!;
  assert.equal(put.touched, false);
  assert.equal(put.closedAbove, true);
  assert.deepEqual(scoreWienerDay({ state: "unavailable", spot: null, levels: [] }, { settle: 1, highAfter: 1, lowAfter: 1 }), []);
  assert.deepEqual(scoreWienerDay(m, { settle: 0, highAfter: 1, lowAfter: 1 }), [], "incomplete day inputs score nothing");
});

test("wiener scorecard: calibration buckets, Brier score and the untested flag", () => {
  const day = [
    { price: 1, kind: "k", pTouch: 0.05, touched: false, pCloseAbove: 0.95, closedAbove: true },
    { price: 2, kind: "k", pTouch: 0.4, touched: true, pCloseAbove: 0.2, closedAbove: false },
    { price: 3, kind: "k", pTouch: 0.4, touched: false, pCloseAbove: 1, closedAbove: true },
  ];
  const sc = wienerScorecard([day, [], day]);
  assert.equal(sc.days, 2, "empty days are not counted");
  assert.equal(sc.touch.n, 6);
  const b = sc.touch.buckets.find((x) => x.lo === 0.3)!;
  assert.equal(b.n, 4);
  assert.equal(b.stated, 0.4);
  assert.equal(b.observed, 0.5);
  const top = sc.close.buckets.find((x) => x.lo === 0.9)!;
  assert.equal(top.n, 4, "1.0 lands in the last bucket");
  const brier = ((0.05 ** 2) + (0.6 ** 2) + (0.4 ** 2)) / 3;
  close(sc.touch.brier!, brier, 1e-4);
  assert.equal(sc.tested, false);
  assert.equal(sc.minDays, SCORECARD_MIN_DAYS);
  assert.equal(wienerScorecard(Array.from({ length: SCORECARD_MIN_DAYS }, () => day)).tested, true);
  assert.equal(wienerScorecard([]).touch.brier, null);
});

test("wiener scorecard: the settle uses extremes from the morning map's minute onward", async () => {
  const { settleFromCandles } = await import("../../server/odteSettleInputs.ts");
  const { etWallToEpochMs } = await import("../../server/exchangeCalendar.ts");
  const d = "2026-11-04";
  const bar = (m: number, h: number, l: number, c: number) => ({ datetime: etWallToEpochMs(d, m), open: c, high: h, low: l, close: c });
  const candles = [bar(9 * 60 + 30, 6900, 6700, 6800), bar(9 * 60 + 35, 6820, 6790, 6810), bar(15 * 60 + 59, 6830, 6805, 6825)];
  const s = settleFromCandles(candles, etWallToEpochMs(d, 16 * 60 + 10), etWallToEpochMs(d, 9 * 60 + 35) + 20_000)!;
  assert.equal(s.sessionHigh, 6900);
  assert.equal(s.highAfter, 6830, "the 09:30 spike before the map is not counted");
  assert.equal(s.lowAfter, 6790);
  assert.deepEqual(Object.keys(settleFromCandles(candles, etWallToEpochMs(d, 16 * 60 + 10))!).sort(), ["sessionHigh", "sessionLow", "settle"]);
});

test("wiener scorecard: a composed morning map carries the Wiener odds and the settle scores them", async () => {
  const { composeOdteMap } = await import("../../shared/odteMap.ts");
  const { evaluateSettle } = await import("../../shared/odteSettle.ts");
  const w = wienerMap(base());
  const fwd: any = {
    symbol: "$SPX", asOf: "2026-11-04T15:00:00.000Z", spot: 6800, expiry: "2026-11-04", dte: 0, gexValid: true, regime: "long_gamma", netGex: 1,
    levels: { callWall: 6850, putWall: 6750, gammaFlip: 6780, pin: 6800 }, expectedMove: { sigma: 30, straddle: 24 },
    session: { state: "intraday", minutesToClose: 240, projMinutes: 240 },
    bars: { priorClose: 6790, sessionHigh: null, sessionLow: null, orbHigh: null, orbLow: null, vwap: null },
    strikes: [6750, 6775, 6800, 6825, 6850].map((k, i) => ({ strike: k, gex: (i - 2) * 1e8 + 5e7, callOI: 100, putOI: 100 })),
    wiener: w,
  };
  const m = composeOdteMap(fwd, { edition: "personal" });
  assert.ok(m.wiener);
  assert.equal(m.wiener!.levels.length, w.levels.length);
  const ev = evaluateSettle(m, { settle: 6830, sessionHigh: 6860, sessionLow: 6760, highAfter: 6860, lowAfter: 6760 });
  assert.ok(ev.wiener && ev.wiener.length === 3, "pin at the price is left out");
  assert.equal(ev.wiener!.find((x) => x.price === 6850)!.touched, true);
  assert.equal(evaluateSettle(m, { settle: 6830, sessionHigh: 6860, sessionLow: 6760 }).wiener, null, "no after-extremes: not scored");
  const noW = composeOdteMap({ ...fwd, wiener: { ...w, state: "unavailable" } }, { edition: "personal" });
  assert.equal(noW.wiener, null);
});

test("wiener: the real forward computation on the demo chain carries a consistent Wiener map and today's path", async () => {
  const { buildOdteForward } = await import("../../server/odteForward.ts");
  const { demoChain, demoPriceHistory } = await import("../../server/demoMarket.ts");
  const { etWallToEpochMs, etDate, addDays } = await import("../../server/exchangeCalendar.ts");
  const T = etWallToEpochMs("2026-10-12", 11 * 60);
  const deps = {
    getOptionChain: async (symbol: string, dte: number) => {
      const from = etDate(T);
      const ch = demoChain({ symbol, contractType: "ALL", strikeCount: 120, includeUnderlyingQuote: "true", fromDate: from, toDate: addDays(from, Math.max(dte, 1)) }, T);
      return { ...ch, source: "demo", asOfMs: T, ageMs: 0, servedFromCache: false, stale: false };
    },
    getPriceHistory: async (symbol: string, periodType: string, period: number, frequencyType: string, frequency: number) =>
      demoPriceHistory({ symbol, periodType, period, frequencyType, frequency, endDate: T }, T),
  };
  let calls = 0;
  const counted = { getOptionChain: async (s: string, d: number) => { calls++; return deps.getOptionChain(s, d); }, getPriceHistory: async (...a: [string, string, number, string, number]) => { calls++; return deps.getPriceHistory(...a); } };
  const fwd = await buildOdteForward("$SPX", T, counted as any);
  assert.equal(fwd.status, 200);
  assert.equal(calls, 2, "the Wiener map adds no upstream request (one chain, one history read, as before)");
  const b: any = fwd.body;
  const w = b.wiener;
  assert.equal(w.state, "ok");
  assert.equal(w.horizon, "rest_of_today");
  assert.equal(w.minutesLeft, 300, "11:00 to 16:00");
  assert.equal(w.sigmaToClose, b.expectedMove.sigma, "the market's own sigma to the close");
  assert.equal(w.bands[0].et, "11:00");
  assert.equal(w.bands[w.bands.length - 1].et, "16:00");
  assert.ok(w.levels.length > 0);
  assert.ok(w.levels.every((l: any) => l.kind !== "sigma"), "the model's own sigma rails are not scored as levels");
  // The level map's driftless touch odds and the Wiener ones agree (same sigma, same model).
  for (const l of w.levels) {
    const lm = b.levelMap.find((x: any) => x.kind === l.kind && x.price === l.price);
    if (lm && !lm.touched && l.side !== "at") assert.ok(Math.abs(lm.pTouch - l.pTouch) < 0.01, `${l.kind} ${l.price}: ${lm.pTouch} vs ${l.pTouch}`);
  }
  assert.ok(Array.isArray(b.todayPath) && b.todayPath.length > 0);
  assert.ok(b.todayPath.every((p: any) => p.min >= 9 * 60 + 30 && p.min <= 11 * 60));
  assert.match(b.pathBasis, /heuristic/);
});
