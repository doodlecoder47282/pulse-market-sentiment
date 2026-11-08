import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { horizonExpectedMove, HORIZON_TRADING_DAYS, RESIDUAL_SESSION_FACTOR, QUARTERLY_MEAN_REVERSION_DAMP } from "../../shared/horizonExpectedMove";
import { vixToAtmPct } from "../../shared/vol";
import { gradedScenarioOdds } from "../../server/impliedScenario";

const spot = 6000;

test("daily EM: straddle first, VIX x sqrt(1/252) x 0.55 second, fixed last; sources named", () => {
  const s = horizonExpectedMove({ spot, horizon: "daily", vix: 20, straddle: { oneSigmaMove: 31.4, straddleMid: 25, strike: 6000 } });
  assert.equal(s.source, "0dte-straddle"); assert.equal(s.oneSigma, 31.4); assert.equal(s.days, 1);
  const v = horizonExpectedMove({ spot, horizon: "daily", vix: 20, straddle: null });
  assert.equal(v.source, "vix-scaled");
  assert.ok(Math.abs(v.oneSigma - spot * (vixToAtmPct(20) / 100) * Math.sqrt(1 / 252) * RESIDUAL_SESSION_FACTOR) < 0.01);
  const f = horizonExpectedMove({ spot, horizon: "daily", vix: null });
  assert.equal(f.source, "fixed-fallback"); assert.equal(f.oneSigma, parseFloat((spot * 0.01 * RESIDUAL_SESSION_FACTOR).toFixed(2)));
  // The straddle is a daily read only: a weekly card never uses it.
  const w = horizonExpectedMove({ spot, horizon: "weekly", vix: 20, straddle: { oneSigmaMove: 31.4, straddleMid: 25, strike: 6000 } });
  assert.notEqual(w.source, "0dte-straddle");
});

test("non-daily EM: the horizon expiry's implied ATM total vol first (same distribution as the odds), then a VIX cone", () => {
  const imp = horizonExpectedMove({ spot, horizon: "weekly", vix: 20, implied: { atmTotalVol: 0.02, expiry: "2026-11-13" } });
  assert.equal(imp.source, "implied-atm"); assert.equal(imp.oneSigma, 120); assert.equal(imp.expiry, "2026-11-13"); assert.equal(imp.days, 5);
  assert.match(imp.note, /same distribution the odds are read from/);
  const w9 = horizonExpectedMove({ spot, horizon: "weekly", vix: 20, vix9d: 18 });
  assert.equal(w9.source, "vix-scaled");
  assert.ok(Math.abs(w9.oneSigma - spot * (vixToAtmPct(18) / 100) * Math.sqrt(7 / 365)) < 0.01, "weekly fallback uses VIX9D when present");
  const w = horizonExpectedMove({ spot, horizon: "weekly", vix: 20 });
  assert.ok(Math.abs(w.oneSigma - spot * (vixToAtmPct(20) / 100) * Math.sqrt(5 / 252)) < 0.01);
  const m = horizonExpectedMove({ spot, horizon: "monthly", vix: 20 });
  assert.ok(Math.abs(m.oneSigma - spot * (vixToAtmPct(20) / 100) * Math.sqrt(21 / 252)) < 0.01);
  const q = horizonExpectedMove({ spot, horizon: "quarterly", vix: 20 });
  assert.ok(Math.abs(q.oneSigma - spot * (vixToAtmPct(20) / 100) * Math.sqrt(63 / 252) * QUARTERLY_MEAN_REVERSION_DAMP) < 0.01);
  assert.match(q.note, /hand-set mean-reversion damp/);
  // A monthly EM is wider than a daily one from the same VIX: the old 1-day targets on a monthly card were far too tight.
  const d = horizonExpectedMove({ spot, horizon: "daily", vix: 20 });
  assert.ok(m.oneSigma > 5 * d.oneSigma);
  for (const h of ["daily", "weekly", "monthly", "quarterly"] as const) assert.equal(horizonExpectedMove({ spot, horizon: h, vix: 20 }).days, HORIZON_TRADING_DAYS[h]);
  // An unusable implied figure falls through, never a NaN or 0 EM.
  const bad = horizonExpectedMove({ spot, horizon: "monthly", vix: 20, implied: { atmTotalVol: NaN, expiry: "x" } });
  assert.equal(bad.source, "vix-scaled"); assert.ok(bad.oneSigma > 0);
});

test("odds and targets are about the same event: a weekly lognormal CDF read at +-1 weekly sigma gives ~16/68/16, not the ~45/10/45 a one-day band gave", () => {
  const sigmaT = 0.02; // weekly ATM total vol
  const F = spot;
  const Phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
  const cdf = (K: number) => Phi((Math.log(K / F) + 0.5 * sigmaT * sigmaT) / sigmaT);
  const em = horizonExpectedMove({ spot, horizon: "weekly", vix: 20, implied: { atmTotalVol: sigmaT, expiry: "2026-11-13" } });
  const onHorizon = gradedScenarioOdds(cdf, { bull: spot + em.oneSigma, bear: spot - em.oneSigma })!;
  assert.ok(Math.abs(onHorizon.bull - 0.16) < 0.02 && Math.abs(onHorizon.bear - 0.16) < 0.02 && onHorizon.base > 0.64, JSON.stringify(onHorizon));
  const oneDay = horizonExpectedMove({ spot, horizon: "daily", vix: 20 }).oneSigma;
  const offHorizon = gradedScenarioOdds(cdf, { bull: spot + oneDay, bear: spot - oneDay })!;
  assert.ok(offHorizon.base < 0.3, `the old mixed read: ${JSON.stringify(offHorizon)}`);
});

function erf(x: number): number {
  // Abramowitz-Stegun 7.1.26, |error| < 1.5e-7
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

test("wiring: buildAudit caps the targets to the horizon EM and reads the odds there; the route post-processor that re-cut targets after the odds is gone", () => {
  const m = readFileSync(new URL("../../server/models.ts", import.meta.url), "utf8");
  assert.match(m, /const expectedMove: HorizonExpectedMove = horizonExpectedMove\(\{\s*spot, horizon: extras\.horizon, vix: vixForEM, vix9d: extras\.vix9d \?\? null,/);
  assert.match(m, /const bullCap = spot \+ horizonEM;/);
  assert.match(m, /const bearCap = spot - horizonEM;/);
  assert.match(m, /gradedScenarioOdds\(extras\.impliedCdf, \{ bull: scenarioTargets\.bull, bear: scenarioTargets\.bear \}\)/);
  assert.match(m, /horizonEM: parseFloat\(horizonEM\.toFixed\(2\)\),\s*horizonDays: expectedMove\.days,/);
  assert.match(m, /impliedAtmTotalVol: dist && scenarioProbSource === "risk-neutral-implied" \? dist\.atmTotalVol : null,/);
  assert.match(m, /scenarioProbEvent: `bull: close >= \$\{scenarioTargets\.bull\}; bear: close <= \$\{scenarioTargets\.bear\}; base: neither \(\$\{extras\.horizon\} horizon/);
  const r = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(r, /applyTermStructureRescale/);
  assert.match(r, /vix9d: snap\?\.vol\.vix9d\?\.value \?\? null,/);
});
