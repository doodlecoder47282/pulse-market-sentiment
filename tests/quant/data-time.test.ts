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
import { resolvePrevClose, prevCloseFromDailyBars, dailyBarSessionDate, dayChange } from "../../server/dayChange";
import { aggregateCandles } from "../../server/candleAggregate";

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
  // AM-settled June 2026 monthly dated Fri 19 Jun (Juneteenth): SOQ at Thu 18 Jun 09:30 ET.
  assert.equal(settlementInstantMs("2026-06-19", "AM"), ms("2026-06-18T09:30:00-04:00"));
});

// ---------------------------------------------------------------------------
// chainAudit: 0DTE contracts are included until settlement (finding 7.1).
// Known answers from Black-Scholes with r = q = 0 (Hull), S = 6600, sigma = 15%,
// T = 120 / 525,600 (14:00 ET on expiry day), OI = 1,000, multiplier 100:
//   K = 6600: vanna $ per vol pt = -phi(d1) d2 / sigma x 0.01 x 1000 x 100 x 6600 = 19,892.38
//   K = 6610: vanna $ per vol pt = 9,403,848.92
//   K = 6610 charm (delta change to settlement, 2 h < 1 day): call delta N(d1) = 0.252430
//     decays to 0 (OTM) -> -0.252430 x 1000 x 100 x 6600 = -$166,603,996.21
//     (the old charm/365 extrapolation read -$846,346,403.10)
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
  assert.ok(Math.abs((ch.get(6610) ?? 0) - -166_603_996.21) / 166_603_996.21 < 1e-3, `charm 6610 ${ch.get(6610)}`);
  assert.equal(audit.charm.horizon, "1d-or-to-settlement");
  assert.ok(audit.vomma.profile.length === 2 && audit.zomma.profile.length === 2);
});

test("chainAudit: charm over a 30-day tenor is the 1-day delta change (~ charm/365)", () => {
  // 2026-10-07 16:00 EDT -> 2026-11-06 16:00 EST: 30 days + 60 min (DST ends 1 Nov).
  // K = 6500 call, S = 6600, sigma 15%, OI 1000. scipy: Delta(T - 1d) - Delta(T) gives
  // +$1,395,579.71 per day; the instantaneous charm/365 is +$1,360,631.74 (first-order agreement).
  const S = 6600;
  const T = (43_200 + 60) / 525_600;
  const chain: any = {
    underlying: { last: S, bid: S, ask: S }, source: "schwab",
    callExpDateMap: { "2026-11-06:30": { "6500.0": [contract("SPXW  261106C06500000", 6500, "C", S, 0.15, T, 15)] } },
    putExpDateMap: {},
  };
  const audit = buildChainAudit(chain, S, ms("2026-10-07T16:00:00-04:00"));
  const v = audit.charm.profile[0]?.charmExposure ?? NaN;
  assert.ok(Math.abs(v - 1_395_579.71) / 1_395_579.71 < 1e-3, `charm 30d ${v}`);
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

// ---------------------------------------------------------------------------
// Day change from the prior session close (finding 1.2).
// Hand example: SPY prior close 650.00, last 656.50 -> change +6.50 $/share, +1.00%.
// ---------------------------------------------------------------------------


// Daily bars stamped at midnight Central (Schwab), epoch seconds.
const dailyBar = (date: string, c: number) => ({ t: Date.parse(`${date}T00:00:00-05:00`) / 1000, c });
const DAILY = [dailyBar("2026-10-05", 640), dailyBar("2026-10-06", 645), dailyBar("2026-10-07", 650), dailyBar("2026-10-08", 656.5)];

test("dayChange: quote closePrice for a price from today's session", () => {
  const r = resolvePrevClose({
    priceSessionDate: "2026-10-08", todayEt: "2026-10-08", prevTradingDate: "2026-10-07",
    quote: { closePrice: 650, lastPrice: 656.5, netChange: 6.5 }, dailyBars: DAILY,
  });
  assert.equal(r.prevClose, 650);
  assert.equal(r.source, "schwab_quote_close");
  const d = dayChange(656.5, r.prevClose);
  assert.equal(d.change, 6.5);
  assert.ok(Math.abs((d.changePct ?? 0) - 1.0) < 1e-12);
  // closePrice missing: last - netChange (Schwab's own definition).
  const r2 = resolvePrevClose({ priceSessionDate: "2026-10-08", todayEt: "2026-10-08", quote: { lastPrice: 656.5, netChange: 6.5 } });
  assert.equal(r2.prevClose, 650);
  assert.equal(r2.source, "schwab_quote_net_change");
});

test("dayChange: price from an earlier session uses the daily bar before that session", () => {
  // Saturday: last price is Thursday's (10-08) close; prior close is 10-07, not the quote.
  const r = resolvePrevClose({
    priceSessionDate: "2026-10-08", todayEt: "2026-10-10",
    quote: { closePrice: 656.5, lastPrice: 656.5, netChange: 0 }, dailyBars: DAILY,
  });
  assert.equal(r.prevClose, 650);
  assert.equal(r.source, "daily_bar");
  assert.equal(r.prevCloseDate, "2026-10-07");
});

test("dayChange: nothing honest available -> null, never a first-bar or previous-candle close", () => {
  const r = resolvePrevClose({ priceSessionDate: "2026-10-08", todayEt: "2026-10-08", quote: null, dailyBars: [] });
  assert.equal(r.prevClose, null);
  assert.equal(r.source, "unavailable");
  assert.deepEqual(dayChange(656.5, null), { change: null, changePct: null });
});

test("dayChange: daily-bar dating is robust to midnight CT, ET or UTC stamps", () => {
  for (const off of ["-05:00", "-04:00", "Z"]) {
    assert.equal(dailyBarSessionDate(Date.parse(`2026-10-08T00:00:00${off}`) / 1000), "2026-10-08", off);
  }
  assert.equal(prevCloseFromDailyBars(DAILY, "2026-10-08")?.close, 650);
});

test("candles: 2m from 1m and 60m from 30m, anchored at 09:30 ET", () => {
  const t0 = Date.parse("2026-10-08T09:30:00-04:00") / 1000;
  const ones = [0, 1, 2, 3, 4].map((i) => ({ t: t0 + i * 60, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 10 }));
  const twos = aggregateCandles(ones, 2);
  assert.equal(twos.length, 3);
  assert.deepEqual(twos[0], { t: t0, o: 100, h: 102, l: 99, c: 101.5, v: 20 });
  assert.deepEqual(twos[2], { t: t0 + 240, o: 104, h: 105, l: 103, c: 104.5, v: 10 });
  const thirties = [0, 1, 2, 3].map((i) => ({ t: t0 + i * 1800, o: 1, h: 2 + i, l: 0.5, c: 1 + i, v: null }));
  const hours = aggregateCandles(thirties, 60);
  assert.deepEqual(hours.map((h) => h.t), [t0, t0 + 3600]); // 09:30, 10:30
  assert.equal(hours[1].h, 5);
  assert.equal(hours[1].v, null);
  // One missing sub-bar volume makes the bucket volume missing, not a partial sum.
  const mixed = aggregateCandles([{ ...ones[0] }, { ...ones[1], v: null }, { ...ones[2], v: null }, { ...ones[3] }], 2);
  assert.equal(mixed[0].v, null); // 10 + null
  assert.equal(mixed[1].v, null); // null + 10
});

// ---------------------------------------------------------------------------
// Social gauge (finding 5.4/5.5): failed, stale or tiny samples are
// "unavailable"/"insufficient" with score null, never a neutral 0 -> 50.
// ---------------------------------------------------------------------------

test("social: failed collection is unavailable, not neutral", async () => {
  const { summarizeSocial } = await import("../../server/sources");
  const now = ms("2026-10-08T15:00:00Z");
  const post = (tone: "bullish" | "bearish" | "neutral", iso = "2026-10-08T14:00:00Z") =>
    ({ source: "StockTwits" as const, text: "", url: "", timestamp: iso, tone });
  const failed = summarizeSocial([{ name: "a", posts: null }, { name: "b", posts: null }], now);
  assert.equal(failed.score, null);
  assert.equal(failed.status, "unavailable");
  // Stale: newest post 4 days old -> excluded -> unavailable.
  const stale = summarizeSocial([{ name: "a", posts: [post("bullish", "2026-10-04T14:00:00Z")] }], now);
  assert.equal(stale.status, "unavailable");
  assert.equal(stale.sources?.[0].state, "stale");
  // Too few tagged posts: 2 tagged < 5.
  const tiny = summarizeSocial([{ name: "a", posts: [post("bullish"), post("bearish"), post("neutral")] }], now);
  assert.equal(tiny.score, null);
  assert.equal(tiny.status, "insufficient");
  // 6 bullish, 2 bearish, one source failed: (6 - 2) / 8 = +50, partial.
  const ok = summarizeSocial([
    { name: "a", posts: [...Array(6)].map(() => post("bullish")).concat([post("bearish"), post("bearish")]) },
    { name: "b", posts: null },
  ], now);
  assert.equal(ok.score, 50);
  assert.equal(ok.status, "partial");
});

test("social: VIX tone inverted, unknown-age posts dropped, 24 h window", async () => {
  const { summarizeSocial } = await import("../../server/sources");
  const now = ms("2026-10-08T15:00:00Z");
  const post = (tone: "bullish" | "bearish" | "neutral", iso = "2026-10-08T14:00:00Z") =>
    ({ source: "StockTwits" as const, text: "", url: "", timestamp: iso, tone });
  // 6 "bullish VIX" posts = 6 bearish equity reads -> -100.
  const vix = summarizeSocial([{ name: "vix", posts: [...Array(6)].map(() => post("bullish")), invertTone: true }], now);
  assert.equal(vix.score, -100);
  assert.equal(vix.bearish, 6);
  // Undated posts never count as fresh.
  const undated = summarizeSocial([{ name: "a", posts: [...Array(6)].map(() => post("bullish", "")) }], now);
  assert.equal(undated.status, "unavailable");
  assert.equal(undated.sources?.[0].state, "undated");
  // 5 dated bullish + 3 undated: scored on the 5, flagged partial.
  const mix = summarizeSocial([{ name: "a", posts: [...Array(5)].map(() => post("bullish")).concat([...Array(3)].map(() => post("bearish", ""))) }], now);
  assert.equal(mix.score, 100);
  assert.equal(mix.status, "partial");
  // 30 h old: outside the 24 h window.
  const old = summarizeSocial([{ name: "a", posts: [...Array(6)].map(() => post("bullish", "2026-10-07T09:00:00Z")) }], now);
  assert.equal(old.status, "unavailable");
  assert.equal(old.sources?.[0].state, "stale");
});

test("social: composite leaves out an unavailable social gauge instead of scoring it 50", async () => {
  const { computeComposite } = await import("../../server/composite");
  const base: any = {
    vol: { vix: { value: null }, vvix: { value: null }, vix9d: { value: null }, vix3m: { value: null }, skew: { value: null } },
    term: { ratio9dOver30d: null, ratio30dOver3m: null },
    gamma: { totalGex: 1e9, regime: "positive", callWall: 0, putWall: 0, maxPain: 0, zeroGamma: null, pcrOi: 1, pcrVol: 1 },
    fearGreed: null, aaii: null, spy: { price: 1, prevClose: 1, changePct: 0 },
  };
  const without = computeComposite({ ...base, social: { score: null, bullish: 0, bearish: 0, neutral: 0, posts: [], status: "unavailable" } });
  assert.equal(without.gauges.some((g: any) => /Social/.test(g.name)), false);
  const withSocial = computeComposite({ ...base, social: { score: 40, bullish: 7, bearish: 3, neutral: 0, posts: [], status: "ok" } });
  const g = withSocial.gauges.find((x: any) => /Social/.test(x.name));
  assert.equal(g?.value, 70); // 50 + 40 / 2
});
