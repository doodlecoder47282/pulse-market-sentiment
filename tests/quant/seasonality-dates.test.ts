// The seasonality window dates and the chart hover come from one calculation (master list X13).
import test from "node:test";
import assert from "node:assert/strict";
import { dayOfYearToDate } from "../../server/seasonality";
import { tradingDayToDateLabel } from "../../shared/chartLabels";
import { isTradingDay } from "../../shared/exchangeCalendar";

test("a window day reads as the same date the hover shows for that step", () => {
  for (const doy of [0, 20, 136, 199, 251]) {
    const hover = tradingDayToDateLabel(doy + 1, 2026, isTradingDay);
    if (hover) assert.equal(dayOfYearToDate(doy, 2026), hover.replace(/^[A-Za-z]{3}, /, ""));
  }
  assert.equal(dayOfYearToDate(0, 2026), "Jan 2");
});
