// Labels on charts do not print over each other, and a seasonality day reads as a date.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { labelLanes, levelLabelVertical, tradingDayToDateLabel } from "../../shared/chartLabels";
import { isTradingDay } from "../../shared/exchangeCalendar";

test("labels closer than a label's width go into different lanes", () => {
  // The Heatseeker screenshot: DOWNSIDE and DN VOMMA a few strikes apart, then a clear gap.
  assert.deepEqual(labelLanes([6950, 6960, 7020], 60), [0, 1, 0]);
  assert.deepEqual(labelLanes([7100, 7095, 7090, 7300], 60), [2, 1, 0, 0], "three in a cluster take three lanes");
  assert.deepEqual(labelLanes([], 60), []);
  assert.deepEqual(labelLanes([7000, Number.NaN, 7200], 60), [0, 0, 0]);
});

test("a level at the bottom edge is labelled above its line", () => {
  assert.equal(levelLabelVertical(7057, 7057, 7366), "above", "DN VOMMA on the time axis in the Models screenshot");
  assert.equal(levelLabelVertical(7187, 7057, 7366), "below");
  assert.equal(levelLabelVertical(7100, 7100, 7100), "below");
});

test("a trading-day count becomes this year's date", () => {
  assert.equal(tradingDayToDateLabel(1, 2026, isTradingDay), "Fri, Jan 2");
  assert.equal(tradingDayToDateLabel(2, 2026, isTradingDay), "Mon, Jan 5");
  assert.match(String(tradingDayToDateLabel(200, 2026, isTradingDay)), /^(Mon|Tue|Wed|Thu|Fri), Oct \d+$/);
  assert.equal(tradingDayToDateLabel(400, 2026, isTradingDay), null);
  assert.equal(tradingDayToDateLabel(0, 2026, isTradingDay), null);
});

test("the four charts use them", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  assert.match(read("client/src/components/Heatseeker.tsx"), /offset: 4 \+ \(topLanes\.levels\[li\] \?\? 0\) \* 13/);
  assert.match(read("client/src/components/TradeDesk.tsx"), /position: prevNearLabel \? "insideTopRight" : "insideTopLeft"/);
  assert.match(read("client/src/components/ModelsPanel.tsx"), /levelLabelVertical\(lv\.price, yMin, yMax\) === "above"/);
  for (const f of ["client/src/components/SeasonalityPanel.tsx", "client/src/components/SeasonalityResearch.tsx"]) {
    assert.doesNotMatch(read(f), />Day \{label\}</, f);
    assert.match(read(f), /\{seasonDayLabel\(label\)\}/, f);
  }
});
