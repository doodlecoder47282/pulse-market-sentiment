// Round-3 quant tests, workstream R3-3: statistics, 0DTE grading,
// validation, crypto (Sectors 5, 7, 8, 10).
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/r3-3.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32 } from "../../server/macroStats";

const near = (a: number, b: number, tol: number, msg = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} +/- ${tol}, got ${a}`);

function gauss(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─── 1. Sentiment weights: near-constant gauge cannot take the composite ───

test("gauge weights: grader's pinned dealer-gamma case is excluded, not 98% of the composite", async () => {
  const { estimateGaugeWeights, computeComposite } = await import("../../server/composite");
  // Verbatim generator from regrade2/g2/hrp_check.ts (Lehmer LCG, seed 3).
  let seed = 3;
  const u = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const g = () => Math.sqrt(-2 * Math.log(u() || 1e-9)) * Math.cos(2 * Math.PI * u());
  const hist: Record<string, number>[] = [];
  let vix = 50, pcr = 50, gam = 50, fg = 50, soc = 50;
  for (let t = 0; t < 120; t++) {
    const f = g();
    vix = Math.max(0, Math.min(100, vix + 6 * f));
    pcr = Math.max(0, Math.min(100, pcr + 4 * g()));
    gam = 98 + 0.3 * g();
    fg = Math.max(0, Math.min(100, fg + 5 * (0.6 * f + 0.8 * g())));
    soc = Math.max(0, Math.min(100, soc + 15 * g()));
    hist.push({ "VIX Level": vix, "Put/Call OI (0-45 DTE)": pcr, "Dealer Gamma Regime": gam, "CNN Fear & Greed": fg, "Social Sentiment (StockTwits + Reddit)": soc });
  }
  const r = estimateGaugeWeights(hist);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.est.weights["Dealer Gamma Regime"], undefined);
  assert.match(r.est.excluded["Dealer Gamma Regime"], /near-constant/);
  // Four single-gauge blocks of unit z-variance: 1/4 each (correlation does
  // not enter a single-gauge block's variance). No gauge dominates.
  for (const n of ["VIX Level", "Put/Call OI (0-45 DTE)", "CNN Fear & Greed", "Social Sentiment (StockTwits + Reddit)"]) near(r.est.weights[n], 0.25, 1e-9, n);
  // VIX and F&G share a factor (corr ~0.6 by construction): fewer than 4 independent gauges.
  assert.ok(r.est.effectiveN < 4 && r.est.effectiveN > 2.5, `effN ${r.est.effectiveN}`);

  // computeComposite: an excluded gauge that is present gets weight 0 and is named; estimates still used.
  const base: any = {
    vol: { vix: { value: 20 }, vvix: { value: null }, vix9d: { value: null }, vix3m: { value: null }, skew: { value: null } },
    term: { ratio9dOver30d: null, ratio30dOver3m: null },
    gamma: { totalGex: 1e9, regime: "positive", callWall: 0, putWall: 0, maxPain: 0, zeroGamma: null, pcrOi: 1, pcrVol: 1 },
    social: { score: null, bullish: 0, bearish: 0, neutral: 0, posts: [], status: "unavailable" },
    fearGreed: null, aaii: null, spy: { price: 1, prevClose: 1, changePct: 0 },
  };
  const c = computeComposite(base, null, r);
  assert.equal(c.weightSource, "estimated");
  const gw = c.gauges.find((x: any) => x.name === "Dealer Gamma Regime");
  assert.ok(gw);
  assert.equal(gw!.weight, 0);
  assert.match(c.method ?? "", /weight 0 \(near-constant.*Dealer Gamma Regime/);
  const tot = c.gauges.reduce((a: number, x: any) => a + x.weight, 0);
  near(tot, 1, 1e-12, "weights renormalized");
});

test("gauge weights: block of near-duplicates counts about once (correlation HRP known answer)", async () => {
  const { estimateGaugeWeights } = await import("../../server/composite");
  // VIX and VVIX are the same factor (rho = 1), SKEW independent in the vol
  // block; PCR independent in its own block. Within vol: 1/3 each, block
  // z-variance (1/9)(3 + 2) = 5/9; PCR 1. Between: 9/5 : 1 -> 9/14, 5/14.
  const rand = mulberry32(7);
  const hist: Array<Record<string, number>> = [];
  let a = 50, b = 50, c = 50;
  for (let t = 0; t < 4001; t++) {
    hist.push({ "VIX Level": a, "VVIX (Vol-of-Vol)": 2 * a, "SKEW Index": b, "Put/Call OI (0-45 DTE)": c });
    a += gauss(rand); b += 3 * gauss(rand); c += 0.5 * gauss(rand);
  }
  const r = estimateGaugeWeights(hist);
  assert.ok(r.ok);
  if (!r.ok) return;
  near(r.est.weights["VIX Level"], 9 / 14 / 3, 0.02, "VIX");
  near(r.est.weights["SKEW Index"], 9 / 14 / 3, 0.02, "SKEW");
  near(r.est.weights["Put/Call OI (0-45 DTE)"], 5 / 14, 0.02, "PCR");
  // Scale does not matter: PCR's change sd is 1/6 of SKEW's yet it is not up-weighted.
  assert.deepEqual(r.est.excluded, {});
});
