import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composeCalibrationCard, type RollingBrierLike } from "../../server/calibrationCardText";

const base: RollingBrierLike = {
  n: 30, bull: 0.15, base: 0.22, bear: 0.12, total: 0.49,
  trivialBull: 0.16, trivialBase: 0.24, trivialBear: 0.14, trivialTotal: 0.54,
  topPickHitRate: 0.6, topPickHits: 18, topPickN: 30,
  realized: { bull: 0.2, base: 0.6, bear: 0.2 },
  meanForecast: { bull: 0.25, base: 0.45, bear: 0.30 },
  probSourceMix: { "risk-neutral-implied": 22, "hand-set-heuristic": 8 },
  slotMix: { daily: 28, halfhour: 2 },
  skill: { bull: 1 - 0.15 / 0.16, base: 1 - 0.22 / 0.24, bear: 1 - 0.12 / 0.14, total: 1 - 0.49 / 0.54 },
  gated: false, minDays: 20,
};

test("calibration card: under the sample gate it shows counts and the realized-vs-forecast mix only; no score, grade, hit rate or diagnosis", () => {
  const t = composeCalibrationCard({ r: { ...base, n: 5, gated: true, topPickN: 5, topPickHits: 4, topPickHitRate: 0.8 }, forecastProbs: null, watchdog: null, today: "2026-11-08" });
  assert.match(t, /5 SETTLED DAYS/);
  assert.match(t, /withheld: 5 of the 20 settled days needed/);
  assert.match(t, /BASE  60% realized vs 45% forecast \(\+15 pts\)/);
  assert.doesNotMatch(t, /skill \+|skill -|Top-pick realized|95% CI|always-/);
  assert.doesNotMatch(t, /\((A\+?|B|C|D|F),/, "no letter grades");
  assert.doesNotMatch(t, /sharper|worse|elite|excellent|over-modeled|under-priced|regime\)/);
  assert.match(t, /noise either way/);
});

test("calibration card: past the gate, Brier is read against climatology with a skill score, the hit rate against always-picking the most frequent bucket, and the odds mix is named", () => {
  const t = composeCalibrationCard({ r: base, forecastProbs: { bull: [0.2, 0.3, 0.25], base: [0.5, 0.4, 0.45], bear: [0.3, 0.3, 0.3] }, watchdog: { status: "NO_SKILL", n: 30, cValue: 0.1, baseline: 0.54, reason: "cusum within thresholds" }, today: "2026-11-08" });
  assert.match(t, /odds recorded as: risk-neutral-implied 22, hand-set-heuristic 8 \(two forecasters pooled in one score\)/);
  assert.match(t, /graded row from the daily 28, halfhour 2 slot/);
  assert.match(t, /BULL\s+0\.150\s+base-rate 0\.160\s+skill \+6%/);
  assert.match(t, /TOTAL\s+0\.490\s+base-rate 0\.540\s+skill \+9%/);
  assert.match(t, /Top-pick realized  18\/30 = 60%\s+95% CI \[\d+%, \d+%\]/);
  assert.match(t, /always-base would have scored 60% on the same days; read the CI against that, not against 33%/);
  assert.match(t, /RESOLUTION/); assert.match(t, /NO DEMONSTRATED SKILL/);
  assert.doesNotMatch(t, /\((A\+?|B|C|D|F),/, "no absolute Brier letter grades");
  assert.doesNotMatch(t, /sharper|elite|excellent|poor\)|vol may be|skew under-priced/);
  assert.match(t, /a measurement, not a verdict/);
  // Skill undefined when the climatology Brier is 0 (every day the same bucket): stated, not divided.
  const z = composeCalibrationCard({ r: { ...base, skill: { ...base.skill, bull: null } }, forecastProbs: null, watchdog: null, today: "x" });
  assert.match(z, /BULL\s+0\.150\s+base-rate 0\.160\s+skill n\/a/);
});

test("wiring: predictions record which odds they carried; rollingBrier reports the mix, mean forecast, skill and the gate", () => {
  const c = readFileSync(new URL("../../server/calibration.ts", import.meta.url), "utf8");
  assert.match(c, /ALTER TABLE pulse_predictions ADD COLUMN prob_source TEXT/);
  assert.match(c, /export const CALIBRATION_MIN_DAYS = 20;/);
  assert.match(c, /p\.probSource \?\? null,/);
  assert.match(c, /p\.prob_bull, p\.prob_base, p\.prob_bear, p\.prob_source, p\.source/);
  assert.match(c, /gated: n < CALIBRATION_MIN_DAYS,/);
  assert.match(c, /const skillOf = \(bs: number, clim: number\) => \(Number\.isFinite\(clim\) && clim > 0 \? 1 - bs \/ clim : null\);/);
  const d = readFileSync(new URL("../../server/discordBatcaveCard.ts", import.meta.url), "utf8");
  assert.match(d, /probSource: typeof audit\.scenarioProbSource === "string" \? audit\.scenarioProbSource : null,/);
  const card = readFileSync(new URL("../../server/calibrationCard.ts", import.meta.url), "utf8");
  assert.doesNotMatch(card, /gradeBrier|beatsTrivial/);
  assert.match(card, /composeCalibrationCard\(\{ r, forecastProbs, watchdog, today: etDate\(\) \}\)/);
});
