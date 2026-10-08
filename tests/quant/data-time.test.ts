// WS1 data and time: exchange calendar, time to expiry, chainAudit 0DTE,
// day change from the prior close, social gauge availability.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isTradingDay, isHoliday, isEarlyClose, isCovered, sessionClose, sessionCloseMs,
  sessionOpenMs, nextTradingDay, prevTradingDay, isRegularSessionOpen, etClock,
  sessionMinutes,
} from "../../server/exchangeCalendar";
import {
  timeToExpiry, settlementStyleOf, settlementInstantMs, optionRootOf,
  MINUTES_PER_CALENDAR_YEAR, TRADING_MINUTES_PER_YEAR,
} from "../../server/timeToExpiry";
import { bsPrice } from "../../server/greeks";
import { buildChainAudit } from "../../server/chainAudit";

const ms = (iso: string) => Date.parse(iso);

// ---------------------------------------------------------------------------
// Exchange calendar. Reference: NYSE Group 2026-2028 holiday and early-close
// calendar (ir.theice.com press release, 23 Dec 2025) and nyse.com/markets/hours-calendars.
// ---------------------------------------------------------------------------

test("calendar: NYSE full holidays 2026-2028", () => {
  const holidays = [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
    "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
    "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
    "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04",
    "2028-09-04", "2028-11-23", "2028-12-25",
  ];
  for (const d of holidays) {
    assert.equal(isHoliday(d), true, d);
    assert.equal(isTradingDay(d), false, d);
  }
  // NYSE: 1 Jan 2028 is a Saturday, "no New Year's Day holiday is observed".
  assert.equal(isTradingDay("2027-12-31"), true);
  assert.equal(nextTradingDay("2027-12-31"), "2028-01-03");
  // Columbus Day is not an NYSE holiday.
  assert.equal(isTradingDay("2026-10-12"), true);
});

test("calendar: early closes at 1:00 p.m. ET", () => {
  for (const d of ["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"]) {
    assert.equal(isTradingDay(d), true, d);
    assert.equal(isEarlyClose(d), true, d);
    assert.deepEqual(sessionClose(d), { hh: 13, mm: 0 }, d);
    assert.equal(sessionMinutes(d), 210, d);
  }
  assert.deepEqual(sessionClose("2026-10-08"), { hh: 16, mm: 0 });
  assert.equal(sessionClose("2026-11-26"), null);
  // 27 Nov 2026 is EST (UTC-5): 13:00 ET = 18:00Z.
  assert.equal(sessionCloseMs("2026-11-27"), ms("2026-11-27T18:00:00Z"));
  assert.equal(isRegularSessionOpen(ms("2026-11-27T17:59:00Z")), true);  // 12:59 ET
  assert.equal(isRegularSessionOpen(ms("2026-11-27T18:00:00Z")), false); // 13:00 ET
});

test("calendar: next/prev trading day and DST-aware session times", () => {
  assert.equal(nextTradingDay("2026-07-02"), "2026-07-06"); // Fri 3 Jul holiday, weekend
  assert.equal(prevTradingDay("2026-04-06"), "2026-04-02"); // Good Friday 3 Apr
  assert.equal(nextTradingDay("2026-11-25"), "2026-11-27"); // Thanksgiving
  // DST starts 8 Mar 2026 and ends 1 Nov 2026 (US rule: 2nd Sun Mar, 1st Sun Nov).
  assert.equal(sessionOpenMs("2026-03-06"), ms("2026-03-06T14:30:00Z")); // EST
  assert.equal(sessionOpenMs("2026-03-09"), ms("2026-03-09T13:30:00Z")); // EDT
  assert.equal(sessionOpenMs("2026-11-02"), ms("2026-11-02T14:30:00Z")); // EST
  assert.equal(sessionOpenMs("2026-11-26"), null);
  // 2026-10-08 is EDT: 15:59 ET open, 16:00 ET closed.
  assert.equal(isRegularSessionOpen(ms("2026-10-08T19:59:00Z")), true);
  assert.equal(isRegularSessionOpen(ms("2026-10-08T20:00:00Z")), false);
  assert.equal(isRegularSessionOpen(ms("2026-10-08T13:29:00Z")), false);
  const c = etClock(ms("2026-10-09T03:30:00Z")); // 23:30 ET on the 8th, already the 9th in UTC
  assert.equal(c.date, "2026-10-08");
  assert.equal(c.minutes, 23 * 60 + 30);
});

test("calendar: outside the verified table falls back to weekdays and says so", () => {
  assert.equal(isCovered("2029-01-01"), false);
  assert.equal(isCovered("2027-06-01"), true);
  assert.equal(isTradingDay("2029-06-06"), true); // a Wednesday
  assert.equal(isTradingDay("2029-06-09"), false); // a Saturday
});

// ---------------------------------------------------------------------------
// Time to expiry. Reference: Cboe VIX methodology (T = minutes to settlement /
// 525,600; standard SPX deemed to expire at the 9:30 ET open, SPXW at the
// 4:00 ET close) and Cboe SPX spec (expiring SPXW stop at 1:00 ET on half days).
// ---------------------------------------------------------------------------

test("tte: PM-settled 0DTE uses true minutes to 16:00 ET", () => {
  const t = timeToExpiry("2026-10-09", { nowMs: ms("2026-10-09T14:00:00-04:00") });
  assert.equal(t.expired, false);
  assert.equal(t.minutes, 120);
  assert.equal(t.years, 120 / 525_600);
  assert.equal(MINUTES_PER_CALENDAR_YEAR, 525_600);
  assert.equal(t.settlementMs, ms("2026-10-09T16:00:00-04:00"));
});

test("tte: half day settles at 13:00 ET", () => {
  const t = timeToExpiry("2026-11-27", { nowMs: ms("2026-11-27T12:00:00-05:00") });
  assert.equal(t.minutes, 60);
  const after = timeToExpiry("2026-11-27", { nowMs: ms("2026-11-27T13:00:00-05:00") });
  assert.equal(after.expired, true);
  assert.equal(after.years, 0);
});

test("tte: AM-settled SPX monthly settles at the 09:30 ET open", () => {
  // Third Friday of October 2026 is the 16th.
  const style = settlementStyleOf("SPX   261016C06600000");
  assert.equal(style, "AM");
  const eve = timeToExpiry("2026-10-16", { nowMs: ms("2026-10-15T16:00:00-04:00"), style });
  assert.equal(eve.minutes, 17.5 * 60); // 16:00 -> 09:30 next day
  const open = timeToExpiry("2026-10-16", { nowMs: ms("2026-10-16T10:00:00-04:00"), style });
  assert.equal(open.expired, true);
  // The SPXW on the same date is still live until 16:00.
  const w = timeToExpiry("2026-10-16", { nowMs: ms("2026-10-16T10:00:00-04:00"), style: settlementStyleOf("SPXW  261016C06600000") });
  assert.equal(w.expired, false);
  assert.equal(w.minutes, 360);
});

test("tte: 15-minute floor until settlement, then expired", () => {
  const t = timeToExpiry("2026-10-09", { nowMs: ms("2026-10-09T15:50:00-04:00") });
  assert.equal(t.minutes, 10);
  assert.equal(t.floored, true);
  assert.equal(t.years, 15 / 525_600);
  assert.equal(timeToExpiry("2026-10-09", { nowMs: ms("2026-10-09T16:00:00-04:00") }).expired, true);
});

test("tte: trading basis counts only regular-session minutes", () => {
  // Thu 15:00 -> Fri 16:00: 60 + 390 minutes.
  const a = timeToExpiry("2026-10-09", { nowMs: ms("2026-10-08T15:00:00-04:00"), basis: "trading" });
  assert.equal(a.minutes, 450);
  assert.equal(a.years, 450 / TRADING_MINUTES_PER_YEAR);
  // Wed 25 Nov 15:00 -> Fri 27 Nov half day: 60 + 0 (Thanksgiving) + 210.
  const b = timeToExpiry("2026-11-27", { nowMs: ms("2026-11-25T15:00:00-05:00"), basis: "trading" });
  assert.equal(b.minutes, 270);
});

test("tte: settlement style resolution", () => {
  assert.equal(optionRootOf("SPXW  261009C06600000"), "SPXW");
  assert.equal(optionRootOf("SPX_101626C6600"), "SPX");
  assert.equal(settlementStyleOf("SPXW  261009C06600000"), "PM");
  assert.equal(settlementStyleOf("SPY   261009C00660000"), "PM");
  assert.equal(settlementStyleOf({ symbol: "SPX   261016C06600000", settlementType: "P" }), "PM");
  assert.equal(settlementStyleOf({ optionRoot: "SPX" }), "AM");
  assert.equal(settlementStyleOf(null), "PM");
  // An expiry dated on a holiday falls back to the prior trading day's close.
  assert.equal(settlementInstantMs("2026-04-03", "PM"), ms("2026-04-02T16:00:00-04:00"));
});

// ---------------------------------------------------------------------------
// chainAudit: 0DTE contracts are included until settlement (finding 7.1).
// Known answers from Black-Scholes with r = q = 0 (Hull), S = 6600, sigma = 15%,
// T = 120 / 525,600 (14:00 ET on expiry day), OI = 1,000, multiplier 100:
//   K = 6600: vanna $ per vol pt = -phi(d1) d2 / sigma x 0.01 x 1000 x 100 x 6600 = 19,892.38
//   K = 6610: vanna $ per vol pt = 9,403,848.92 ; charm $ per day = -846,346,403.10
// (computed independently with scipy.stats.norm).
// ---------------------------------------------------------------------------

function contract(sym: string, K: number, type: "C" | "P", S: number, sigma: number, T: number, vendorVolPct: number) {
  const p = bsPrice(S, K, sigma, T, 0, 0, type);
  return {
    symbol: sym, putCall: type === "C" ? "CALL" : "PUT",
    bid: p - 0.05, ask: p + 0.05, mark: p, last: p,
    delta: 0.5, gamma: 0.01, theta: -1, vega: 0.1, rho: 0,
    volatility: vendorVolPct, theoreticalVolatility: vendorVolPct,
    openInterest: 1000, totalVolume: 10, inTheMoney: false,
  };
}

test("chainAudit: 0DTE vanna/charm included with intraday T and IV re-solved from mid", () => {
  const S = 6600, sigma = 0.15;
  const now = ms("2026-10-09T14:00:00-04:00");
  const T = 120 / 525_600;
  // Vendor IV deliberately inconsistent (40%) to show the mid re-solve is used.
  const chain: any = {
    underlying: { last: S, bid: S, ask: S },
    source: "schwab",
    callExpDateMap: {
      "2026-10-09:0": {
        "6600.0": [contract("SPXW  261009C06600000", 6600, "C", S, sigma, T, 40)],
        "6610.0": [contract("SPXW  261009C06610000", 6610, "C", S, sigma, T, 40)],
      },
    },
    putExpDateMap: {},
  };
  const audit = buildChainAudit(chain, S, now);
  assert.equal(audit.contractsProcessed, 2);
  const v = new Map(audit.vanna.profile.map((p) => [p.strike, p.vannaExposure]));
  const ch = new Map(audit.charm.profile.map((p) => [p.strike, p.charmExposure]));
  assert.ok(Math.abs((v.get(6600) ?? 0) - 19_892.38) / 19_892.38 < 1e-3, `vanna 6600 ${v.get(6600)}`);
  assert.ok(Math.abs((v.get(6610) ?? 0) - 9_403_848.92) / 9_403_848.92 < 1e-3, `vanna 6610 ${v.get(6610)}`);
  assert.ok(Math.abs((ch.get(6610) ?? 0) - -846_346_403.10) / 846_346_403.10 < 1e-3, `charm 6610 ${ch.get(6610)}`);
  assert.ok(audit.vomma.profile.length === 2 && audit.zomma.profile.length === 2);
});

test("chainAudit: settled contracts are dropped (AM SPX after the open, 0DTE after the close)", () => {
  const S = 6600;
  const mk = (sym: string) => contract(sym, 6600, "C", S, 0.15, 6 / 24 / 365, 15);
  const chain: any = {
    underlying: { last: S, bid: S, ask: S },
    source: "schwab",
    callExpDateMap: {
      "2026-10-16:0": {
        "6600.0": [mk("SPX   261016C06600000"), mk("SPXW  261016C06600000")],
      },
    },
    putExpDateMap: {},
  };
  // 10:00 ET on the third Friday: the AM-settled SPX monthly has settled, SPXW has not.
  const mid = buildChainAudit(chain, S, ms("2026-10-16T10:00:00-04:00"));
  assert.equal(mid.contractsProcessed, 1);
  // 09:00 ET: both still live.
  assert.equal(buildChainAudit(chain, S, ms("2026-10-16T09:00:00-04:00")).contractsProcessed, 2);
  // 16:05 ET: everything on that expiry has settled.
  const after = buildChainAudit(chain, S, ms("2026-10-16T16:05:00-04:00"));
  assert.equal(after.contractsProcessed, 0);
  assert.equal(after.vanna.profile.length, 0);
});
