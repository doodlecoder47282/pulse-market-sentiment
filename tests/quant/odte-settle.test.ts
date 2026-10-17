// tests/quant/odte-settle.test.ts
//
// Settle evaluation of a 0DTE map (shared/odteSettle.ts): range and band
// tests, pin distance, zone outcomes, the lesson line, the running tally with
// its sample-size note, and the candle-to-settle inputs on the demo tape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { composeOdteMap, type ForwardLike } from "../../shared/odteMap";
import { evaluateSettle, tallySettles } from "../../shared/odteSettle";
import { settleFromCandles } from "../../server/odteSettleInputs";
import { demoPriceHistory } from "../../server/demoMarket";
import { etWallToEpochMs } from "../../server/exchangeCalendar";

function fwd(): ForwardLike {
  const mk = (strike: number, gex: number) => ({ strike, gex, callOI: 1, putOI: 1 });
  return {
    symbol: "$SPX", asOf: "2026-10-12T14:00:00.000Z", spot: 7000, expiry: "2026-10-12", dte: 0, gexValid: true, regime: "long_gamma", netGex: 5e9,
    levels: { callWall: 7050, putWall: 6950, gammaFlip: 6962, pin: 7050 }, expectedMove: { sigma: 38, straddle: 30 },
    session: { state: "intraday", minutesToClose: 300, projMinutes: 300 },
    bars: { priorClose: 6990, sessionHigh: 7005, sessionLow: 6992, orbHigh: null, orbLow: null, vwap: null },
    strikes: [mk(6950, -1.5e9), mk(6960, 0.3e9), mk(6975, 2.0e9), mk(6995, 1.6e9), mk(7010, -1.3e9), mk(7050, 4.0e9), mk(7060, -2.2e9)],
    gammaCrossings: [6962, 7071], sessionOpen: 6998, priorClose: 6990,
  };
}

test("evaluate: inside/outside the ranges, pin distance, nearest landmark, band, zone outcomes and the lesson line", () => {
  const m = composeOdteMap(fwd(), { edition: "personal" });
  // Range 6970-7030; sigma 6962-7038; band 6962-7071; pin 7050; zones: dip 6975-6979 (inv 6959), fade 7030-7060, no-trade 7005-7015.
  const e = evaluateSettle(m, { settle: 7042, sessionHigh: 7055, sessionLow: 6973 });
  assert.equal(e.settleInStraddle, false);
  assert.equal(e.sessionInStraddle, false);
  assert.equal(e.settleInSigma, false);
  assert.equal(e.pinDistance, -8);
  assert.deepEqual(e.nearestLandmark, { name: "pin", level: 7050, distance: 8 });
  assert.equal(e.bandHeld, true);
  const z = Object.fromEntries(e.zones.map((x) => [x.kind, x]));
  assert.equal(z.dip.touched, true);            // low 6973 <= 6979
  assert.equal(z.dip.heldOrCrossed, true);      // low above the 6959 invalidation
  assert.equal(z.dip.settleRelation, true);     // settle above 6975
  assert.equal(z.fade.touched, true);           // high 7055 >= 7030
  assert.equal(z.fade.heldOrCrossed, true);     // high <= 7060
  assert.equal(z.fade.settleRelation, false);   // settle 7042 not below 7030
  assert.equal(z["no-trade"].heldOrCrossed, true); // 7005-7015 crossed (low below, high above)
  assert.match(e.lesson, /outside the straddle range 6970-7030/);
  assert.match(e.lesson, /8 pts below the pin 7050/);
  assert.match(e.lesson, /long-gamma band held/);
  assert.match(e.lesson, /no-trade pocket crossed/);
  // A quiet day inside everything.
  const q = evaluateSettle(m, { settle: 7001, sessionHigh: 7004, sessionLow: 6993 });
  assert.equal(q.settleInStraddle, true);
  assert.equal(q.sessionInStraddle, true);
  assert.equal(q.zones.find((x) => x.kind === "dip")!.touched, false);
  assert.equal(q.zones.find((x) => x.kind === "no-trade")!.touched, false);
  // Investor map: no zones to evaluate, ranges still graded.
  const inv = evaluateSettle(composeOdteMap(fwd(), { edition: "investor" }), { settle: 7001, sessionHigh: 7004, sessionLow: 6993 });
  assert.equal(inv.zones.length, 0);
  assert.equal(inv.settleInStraddle, true);
  // No straddle: range tests are null, never false.
  const noRange = evaluateSettle(composeOdteMap({ ...fwd(), expectedMove: { sigma: null, straddle: null } }, { edition: "investor" }), { settle: 7001, sessionHigh: 7004, sessionLow: 6993 });
  assert.equal(noRange.settleInStraddle, null);
  assert.equal(noRange.settleInSigma, null);
});

test("tally: counts with their denominators, median |pin distance|, zone hit rates, and a sample-size note under 50 days", () => {
  const m = composeOdteMap(fwd(), { edition: "personal" });
  const evals = [
    evaluateSettle(m, { settle: 7001, sessionHigh: 7004, sessionLow: 6993 }),   // inside; dip not touched
    evaluateSettle(m, { settle: 7042, sessionHigh: 7055, sessionLow: 6973 }),   // outside; dip touched and held, settle above
    evaluateSettle(m, { settle: 6940, sessionHigh: 7002, sessionLow: 6935 }),   // outside; dip touched, premise failed
  ];
  const t = tallySettles(evals);
  assert.equal(t.days, 3);
  assert.deepEqual(t.settleInStraddle, { yes: 1, of: 3 });
  assert.deepEqual(t.bandHeld, { yes: 2, of: 3 });
  assert.equal(t.medianAbsPinDistance, 49);     // |7001-7050| 49, 8, 110 -> median 49
  assert.deepEqual(t.dipTouchedAndHeld, { yes: 1, of: 2 });
  assert.match(t.note, /3 settled days: counts only, no claim of edge/);
  assert.equal(tallySettles([]).days, 0);
  assert.equal(tallySettles([]).medianAbsPinDistance, null);
});

test("settle inputs from candles: today's regular-session bars only, last close is the settle, high and low over the session", () => {
  const t = etWallToEpochMs("2026-10-12", 16 * 60 + 10);
  const h = demoPriceHistory({ symbol: "$SPX", periodType: "day", period: 1, frequencyType: "minute", frequency: 1, endDate: t }, t);
  const s = settleFromCandles(h.candles, t);
  assert.ok(s && s.settle > 0 && s.sessionHigh >= s.settle && s.sessionLow <= s.settle, JSON.stringify(s));
  // Nothing from today -> null, not zeros.
  const yesterday = etWallToEpochMs("2026-10-13", 16 * 60 + 10);
  assert.equal(settleFromCandles(h.candles.filter((c: any) => c.datetime < etWallToEpochMs("2026-10-13", 0)), yesterday), null);
  assert.equal(settleFromCandles([], t), null);
});
