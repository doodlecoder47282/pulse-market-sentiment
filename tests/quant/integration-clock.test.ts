// Integration pass: every greeks / gamma / theta caller on ONE clock
// (server/timeToExpiry.ts via server/chainClock.ts). Known answers:
// T = calendar minutes to the settlement instant / 525,600 (Cboe VIX
// methodology), AM-settled SPX at the 09:30 open, PM SPXW at the close,
// 13:00 ET close on half days (exchangeCalendar).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contractYears, dteYears, ivForClock, minutesToSessionClose, projectedThetaCost,
} from "../../server/chainClock";
import { rowsFromChain, buildGammaProfile } from "../../server/gammaProfile";
import { black76 } from "../../server/breedenLitzenberger";

// Fri 16 Oct 2026 (third Friday, EDT = UTC-4): 10:00 ET = 14:00Z.
const OPEX_10ET = Date.parse("2026-10-16T14:00:00Z");
// Fri 27 Nov 2026 (half day, close 13:00 ET; EST = UTC-5): 12:00 ET = 17:00Z.
const HALFDAY_12ET = Date.parse("2026-11-27T17:00:00Z");

test("AM-settled SPX monthly has settled by 10:00 ET; SPXW has 360 minutes left", () => {
  const am = { symbol: "SPX   261016C06600000", settlementType: "A" };
  const pm = { symbol: "SPXW  261016C06600000", settlementType: "P" };
  assert.equal(contractYears("2026-10-16:0", am, OPEX_10ET), 0);
  // 10:00 -> 16:00 ET = 360 minutes; 360 / 525,600 = 6.849e-4 years
  assert.ok(Math.abs(contractYears("2026-10-16:0", pm, OPEX_10ET) - 360 / 525_600) < 1e-12);
  // Root alone decides when settlementType is absent (SPX = AM, SPXW = PM)
  assert.equal(contractYears("2026-10-16:0", { symbol: "SPX   261016P06500000" }, OPEX_10ET), 0);
});

test("gamma rows: the settled AM contract drops out at 10:00 ET on expiry day", () => {
  const chain = {
    callExpDateMap: { "2026-10-16:0": { "6600.0": [
      { symbol: "SPX   261016C06600000", volatility: 15, openInterest: 5000 },
      { symbol: "SPXW  261016C06600000", volatility: 15, openInterest: 2000 },
    ] } },
    putExpDateMap: {},
  };
  const rows = rowsFromChain(chain, { nowMs: OPEX_10ET });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].oi, 2000);
  assert.ok(Math.abs((rows[0].T as number) - 360 / 525_600) < 1e-12);
  const p = buildGammaProfile(rows, 6600, { r: 0, q: 0, nowMs: OPEX_10ET });
  assert.equal(p.rowsUsed, 1);
});

test("half day: SPXW settles at 13:00 ET, so 12:00 ET leaves 60 minutes", () => {
  assert.ok(Math.abs(contractYears("2026-11-27:0", { symbol: "SPXW  261127C06600000" }, HALFDAY_12ET) - 60 / 525_600) < 1e-12);
  assert.ok(Math.abs(dteYears(0, { nowMs: HALFDAY_12ET }) - 60 / 525_600) < 1e-12);
  assert.equal(minutesToSessionClose(HALFDAY_12ET), 60);
  // Regular day 12:00 ET (Thu 8 Oct 2026, EDT): 240 minutes
  assert.equal(minutesToSessionClose(Date.parse("2026-10-08T16:00:00Z")), 240);
});

test("half-day theta cost at 12:00 ET (hand-computed $)", () => {
  // theta -2.50 per share per day; session 09:30-13:00 = 210 minutes; 60 left:
  //   -2.50 / 210 x 60 = -0.714286 per share = -$71.43 per contract (x100)
  // Old code: 16:00 close and 390-minute day -> -2.50 / 390 x 240 = -1.538462
  // per share (-$153.85 per contract), 2.15x too much.
  const perShare = projectedThetaCost(-2.5, minutesToSessionClose(HALFDAY_12ET), HALFDAY_12ET);
  assert.ok(Math.abs(perShare - -0.7142857) < 1e-6, `${perShare}`);
  assert.ok(Math.abs(perShare * 100 - -71.43) < 0.005);
  // Regular day at 12:00 ET: -2.50 / 390 x 240 = -1.538462 (unchanged)
  const reg = Date.parse("2026-10-08T16:00:00Z");
  assert.ok(Math.abs(projectedThetaCost(-2.5, minutesToSessionClose(reg), reg) - -1.5384615) < 1e-6);
});

test("ivForClock re-solves 0DTE sigma from the mid with our T; longer tenors keep vendor IV", () => {
  // ATM call, S = K = 6600, T = 60 / 525,600, true sigma 20%: price by Black
  // (r = q = 0), quote +/- 0.10 around it, vendor says 35% on its own clock.
  const T = 60 / 525_600;
  const px = black76(6600, 6600, 0.2 * 0.2 * T, "C");
  const s = ivForClock({ vendorIv: 0.35, bid: px - 0.1, ask: px + 0.1, spot: 6600, strike: 6600, T, type: "C" });
  assert.ok(Math.abs(s - 0.2) < 1e-4, `${s}`);
  assert.equal(ivForClock({ vendorIv: 0.18, bid: 10, ask: 11, spot: 6600, strike: 6600, T: 30 / 365, type: "C" }), 0.18);
});

test("implied-scenario adapter prefers the PM-settled SPXW contract by root, not only settlementType", async () => {
  const { quotesFromSchwabExpiry } = await import("../../server/impliedScenario");
  // No settlementType field: the SPX root (AM, SOQ) must lose to SPXW (PM).
  const calls = { "2026-10-16:8": { "6600.0": [
    { symbol: "SPX   261016C06600000", bid: 50, ask: 52 },
    { symbol: "SPXW  261016C06600000", bid: 40, ask: 41 },
  ] } };
  const q = quotesFromSchwabExpiry(calls, {}, "2026-10-16:8");
  assert.deepEqual(q, [{ strike: 6600, callMid: 40.5, putMid: null }]);
});

test("market-hours checks follow the exchange calendar (holiday, 13:00 half day)", async () => {
  const { isRthOpen, rthSessionKey } = await import("../../server/sessionCache");
  // Thu 26 Nov 2026 (Thanksgiving) 11:00 ET = 16:00Z: closed all day
  assert.equal(isRthOpen(new Date("2026-11-26T16:00:00Z")), false);
  // Fri 27 Nov 2026 half day: 12:30 ET open, 13:30 ET closed
  assert.equal(isRthOpen(new Date("2026-11-27T17:30:00Z")), true);
  assert.equal(isRthOpen(new Date("2026-11-27T18:30:00Z")), false);
  // A regular Friday at 13:30 ET (Fri 9 Oct 2026, EDT) is open
  assert.equal(isRthOpen(new Date("2026-10-09T17:30:00Z")), true);
  // Session key on the holiday rolls back to Wed 25 Nov, not "Thursday"
  assert.equal(rthSessionKey(new Date("2026-11-26T16:00:00Z")), "2026-11-25");
});
