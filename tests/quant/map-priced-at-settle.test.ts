// Outside the session the option map is priced at the last settle, not the wall clock. Seen live 2026-11-25:
// the Signals card said "option data read 4:32 PM ET" all evening while its ceiling went 7,200 -> 7,300 and
// its turning point 7,208 -> 7,242. Same data, later clock, different levels; a restart dropped the hold.
import test from "node:test";
import assert from "node:assert/strict";
import { buildOdteForward, pricingClockMs, PREOPEN_LIVE_FROM_MIN } from "../../server/odteForward";
import { demoChain, demoPriceHistory } from "../../server/demoMarket";
import { etDate, addDays, etWallToEpochMs, sessionCloseMs } from "../../server/exchangeCalendar";

const DAY = "2026-10-12"; // a Monday, full session
const settle = sessionCloseMs(DAY)! + 15 * 60_000;

test("the pricing clock: now in the session, the last settle outside it, now again from 8:00 AM before the open", () => {
  const noon = etWallToEpochMs(DAY, 12 * 60);
  assert.equal(pricingClockMs("intraday", 12 * 60, noon), noon);
  const evening = etWallToEpochMs(DAY, 20 * 60);
  assert.equal(pricingClockMs("closed", 20 * 60, evening), settle);
  const late = etWallToEpochMs(DAY, 23 * 60 + 30);
  assert.equal(pricingClockMs("closed", 23 * 60 + 30, late), settle);
  // The small hours of the next trading day: still the last session's data.
  const three = etWallToEpochMs("2026-10-13", 3 * 60);
  assert.equal(pricingClockMs("preopen", 3 * 60, three), settle);
  const pre = etWallToEpochMs("2026-10-13", PREOPEN_LIVE_FROM_MIN + 30);
  assert.equal(pricingClockMs("preopen", PREOPEN_LIVE_FROM_MIN + 30, pre), pre);
  // 4:05 PM: the session has closed but not settled, so index options are still live.
  const settling = etWallToEpochMs(DAY, 16 * 60 + 5);
  assert.equal(pricingClockMs("closed", 16 * 60 + 5, settling), settling);
});

/** The same stored chain (read at the settle) served at any later clock time. */
const depsAt = () => ({
  getOptionChain: async (symbol: string, dte: number) => {
    const from = etDate(settle);
    return { ...(demoChain({ symbol, contractType: "ALL", strikeCount: 120, includeUnderlyingQuote: "true", fromDate: from, toDate: addDays(from, Math.max(dte, 3)) }, settle) as any), source: "demo", asOfMs: settle };
  },
  getPriceHistory: async (symbol: string, periodType: string, period: number, frequencyType: string, frequency: number) =>
    demoPriceHistory({ symbol, periodType, period, frequencyType, frequency, endDate: settle }, settle),
});

test("the same option data gives the same levels at 6 PM, at 11 PM and at 3 AM", async () => {
  const at = async (ms: number) => { const f = await buildOdteForward("$SPX", ms, depsAt() as any); assert.equal(f.status, 200); return f.body as any; };
  const six = await at(etWallToEpochMs(DAY, 18 * 60));
  const eleven = await at(etWallToEpochMs(DAY, 23 * 60));
  const three = await at(etWallToEpochMs("2026-10-13", 3 * 60));
  for (const later of [eleven, three]) {
    assert.equal(later.expiry, six.expiry);
    assert.deepEqual(later.levels, six.levels, "walls, turning point and pin");
    assert.equal(later.netGex, six.netGex);
    assert.deepEqual(later.strikes.map((s: any) => [s.strike, s.gex]), six.strikes.map((s: any) => [s.strike, s.gex]));
    assert.equal(later.pricedAsOfMs, settle);
  }
  assert.equal(six.pricedAsOfMs, settle);
});
