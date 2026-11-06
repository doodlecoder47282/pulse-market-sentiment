// Heatseeker scenarios: the region each probability refers to, a magnet outside the
// bull/bear range, and touch odds only where the reflection rule applies.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scenarioOddsFromCdf } from "../../server/impliedScenario.ts";

const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const normal = (mu: number, sd: number) => (K: number) => 0.5 * (1 + erf((K - mu) / (sd * Math.SQRT2)));

test("touch odds: stated only when the target is beyond the distribution's median (never capped at 100%)", () => {
  // Recording (frame 37): bull target 7,782 with the implied close-beyond at 56%: the old code showed touch 100%.
  const drifted = normal(7790, 60); // median above the bull target
  const o = scenarioOddsFromCdf(drifted, 7689, { bull: 7782, base: 7700, bear: 7600 })!;
  assert.ok(o.pCloseBeyondBull >= 0.5);
  assert.equal(o.pTouchBull, null, "not 100%");
  // A target beyond the median keeps the reflection value.
  const centred = normal(7689, 60);
  const o2 = scenarioOddsFromCdf(centred, 7689, { bull: 7782, base: 7700, bear: 7600 })!;
  assert.ok(o2.pCloseBeyondBull < 0.5);
  assert.ok(Math.abs((o2.pTouchBull as number) - 2 * o2.pCloseBeyondBull) < 1e-12);
  // Already reached: touched.
  assert.equal(scenarioOddsFromCdf(centred, 7689, { bull: 7680, base: 7650, bear: 7600 })!.pTouchBull, 1);
  assert.equal(o2.touchWithheld, null);
});

test("touch odds: withheld when the implied distribution is not centred on spot, even with close-beyond under 1/2", () => {
  // Review case: drift 0.75 sd toward a +1 sd target. Close-beyond 0.40, the 2x rule says 80%, the true
  // touch odds are about 58%: the rule must not be used.
  const spot = 7700, sd = 60;
  const drift = scenarioOddsFromCdf(normal(spot + 0.75 * sd, sd), spot, { bull: spot + sd, base: spot + 10, bear: spot - sd })!;
  assert.ok(drift.pCloseBeyondBull > 0.39 && drift.pCloseBeyondBull < 0.41);
  assert.ok(drift.spotQuantile < 0.25);
  assert.equal(drift.pTouchBull, null, "no 80% touch on a drifted distribution");
  assert.equal(drift.pTouchBear, null);
  assert.match(String(drift.touchWithheld), /not centred on spot \(spot sits at its 23% quantile/);
  // A small offset (spot near the 42nd percentile) keeps the rule.
  const mild = scenarioOddsFromCdf(normal(spot + 0.2 * sd, sd), spot, { bull: spot + sd, base: spot + 10, bear: spot - sd })!;
  assert.ok(Math.abs(mild.spotQuantile - 0.5) <= 0.1);
  assert.ok(mild.pTouchBull != null && Math.abs(mild.pTouchBull - 2 * mild.pCloseBeyondBull) < 1e-12);
  // The card shows the reason, not a guessed number.
  const card = readFileSync(new URL("../../client/src/components/ModelsPanel.tsx", import.meta.url), "utf8");
  assert.match(card, /touch not stated: \$\{p\.touchWithheld\}/);
});

test("magnet outside the bull/bear range: flagged, middle region centred on spot", () => {
  // Recording: base path to the dominant magnet 8,021, above the bull target 7,782.
  const o = scenarioOddsFromCdf(normal(7689, 80), 7689, { bull: 7782, base: 8021, bear: 7600 })!;
  assert.equal(o.baseOutsideRange, true);
  assert.equal(o.upper, (7689 + 7782) / 2, "split halfway between spot and the bull target");
  assert.equal(o.lower, (7689 + 7600) / 2);
  assert.ok(Math.abs(o.bull + o.base + o.bear - 1) < 1e-12);
  const inside = scenarioOddsFromCdf(normal(7689, 80), 7689, { bull: 7782, base: 7700, bear: 7600 })!;
  assert.equal(inside.baseOutsideRange, false);
});

test("models and card: regions sent and shown; the magnet path is named, not called BASE", () => {
  const m = readFileSync(new URL("../../server/models.ts", import.meta.url), "utf8");
  assert.match(m, /bullP\.region = \{ lo: odds\.upper, hi: null \};/);
  assert.match(m, /baseP\.region = \{ lo: odds\.lower, hi: odds\.upper \};/);
  assert.match(m, /bearP\.region = \{ lo: null, hi: odds\.lower \};/);
  assert.match(m, /if \(odds\.baseOutsideRange\) \{[\s\S]{0,300}baseP\.name = "MAGNET";/);
  const c = readFileSync(new URL("../../client/src/components/ModelsPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(c, /const bullRange = `\$\{fmtK\(bullTgt \* 0\.998\)\}/, "no +-0.2% band presented as the region");
  assert.match(c, /touch not stated: \$\{p\.touchWithheld\}/);
  assert.match(c, /MIDDLE" : "BASE"\} region/);
});
