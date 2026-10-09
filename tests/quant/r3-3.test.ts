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

// ─── 2. Seasonality: "validated" belongs to the window the hold-out tested ──

test("seasonality: hold-out verdict attaches to the training-picked window, not the full-sample best", async () => {
  const { findOptimalWindow, generateAnalysisText } = await import("../../server/seasonality");
  // 15 years, +0.3%/day on trading days 100-159, 1%/day noise.
  const market = (seed: number) => {
    const r = mulberry32(seed);
    const m = new Map<number, number[]>();
    for (let y = 0; y < 15; y++) {
      let L = 0;
      const p = [0];
      for (let d = 1; d < 252; d++) { L += (d >= 100 && d < 160 ? 0.003 : 0) + 0.01 * gauss(r); p.push((Math.exp(L) - 1) * 100); }
      m.set(2000 + y, p);
    }
    return m;
  };
  const yearly = { fullYearAvg: 1, fullYearWinRate: 0.5, presidentialCycleYear: 2, presidentialCycleAvg: null };
  // Seed 6: the hold-out validates the window picked on the first 10 years
  // (days 98-182) but the full-sample best is days 40-236: not validated.
  const d = findOptimalWindow(market(6), { permutations: 49 })!;
  assert.equal(d.verdict, "validated_window_differs");
  assert.equal(d.testedWindow!.sameAsHeadline, false);
  assert.deepEqual([d.testedWindow!.buyDayOfYear, d.testedWindow!.sellDayOfYear], [98, 182]);
  assert.notDeepEqual([d.buyDayOfYear, d.sellDayOfYear], [98, 182]);
  assert.ok(d.confidenceLabel !== "Good" && d.confidenceLabel !== "Excellent", d.confidenceLabel);
  const t = generateAnalysisText("TEST", d, yearly, 15);
  assert.match(t, /^In-sample analysis/);
  assert.match(t, /NOT itself validated/);
  // Seed 12: the training pick IS the full-sample best (days 100-156): validated.
  const s = findOptimalWindow(market(12), { permutations: 49 })!;
  assert.equal(s.verdict, "validated");
  assert.equal(s.testedWindow!.sameAsHeadline, true);
  assert.deepEqual([s.buyDayOfYear, s.sellDayOfYear], [s.testedWindow!.buyDayOfYear, s.testedWindow!.sellDayOfYear]);
  assert.match(generateAnalysisText("TEST", s, yearly, 15), /^Analysis/);
});

// ─── 3. Regime null: size under GARCH within Monte Carlo error ────────────

test("regime z test: wild-bootstrap null is sized under GARCH(1,1) (grader's model, w = 65)", async () => {
  const { regimeZTest } = await import("../../server/macroStats");
  // The grader's null (regrade2/g2/regime_null.ts): zero-drift GARCH(1,1),
  // omega 2e-6, alpha 0.08, beta 0.90, 504 days. Round-2 stationary bootstrap
  // read ~10% at 5% on 150 trials. Full study (1000 nulls per cell, 199 reps;
  // iid, two GARCH, AR(0.2); w = 20/65/252) put every z-test size in
  // [0.039, 0.063], inside 0.05 +/- 2 MC s.e. (0.014). Here a 300-trial check:
  // 0.05 +/- 3 s.e. (s.e. 0.0126).
  const rand = mulberry32(7);
  const N = 300;
  let rejZ = 0, rejP = 0;
  for (let k = 0; k < N; k++) {
    let h = 1e-4, e = 0;
    const r: number[] = [];
    for (let t = 0; t < 504; t++) { h = 2e-6 + 0.08 * e * e + 0.9 * h; e = Math.sqrt(h) * gauss(rand); r.push(e); }
    const t = regimeZTest(r, 65, { seed: k + 1, reps: 99 })!;
    if (t.pZ <= 0.05) rejZ++;
    if (t.pPersist <= 0.05) rejP++;
  }
  const se = Math.sqrt(0.05 * 0.95 / N);
  assert.ok(Math.abs(rejZ / N - 0.05) <= 3 * se, `z-test size ${rejZ}/${N}`);
  assert.ok(rejP / N <= 0.05 + 3 * se, `persistence-test size ${rejP}/${N}`);
});

// ─── 4. Canary: thresholds from the same canary set as the live z ─────────

test("canary thresholds: history built on the live subset (weights, R block, transform by original index)", async () => {
  const { compositeHistory, compositeHistorySubset, standardizedComposite } = await import("../../server/macroStats");
  const rand = mulberry32(99);
  // 4 columns; columns 0 and 1 identical (rho 1), 2 and 3 independent.
  const X: number[][] = [];
  for (let t = 0; t < 400; t++) { const a = gauss(rand); X.push([a, a, gauss(rand), gauss(rand)]); }
  const R = [[1, 1, 0, 0], [1, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const w = [0.4, 0.3, 0.2, 0.1];
  const cols = [0, 2, 3];
  const sub = compositeHistorySubset(X, w, R, cols, 20, (j, z) => (j === 3 ? 2 * z : z));
  const manual = compositeHistory(X.map((r) => [r[0], r[2], r[3]]), [0.4, 0.2, 0.1], [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 20, (k, z) => (k === 2 ? 2 * z : z));
  assert.equal(sub.length, manual.length);
  for (let i = 0; i < sub.length; i++) near(sub[i], manual[i], 1e-12);
  // Closed form for one day: the subset composite uses only the subset's w and R.
  const z = [1, -0.5, 2];
  const c = standardizedComposite([0.4, 0.2, 0.1], z, [[1, 0, 0], [0, 1, 0], [0, 0, 1]])!;
  near(c.z, (0.4 - 0.1 + 0.2) / Math.sqrt(0.16 + 0.04 + 0.01), 1e-12);
  // The full-set history is a different distribution (0 and 1 duplicate):
  const full = compositeHistory(X, w, R, 20);
  assert.notEqual(full.length ? full[0] : NaN, sub[0]);
});

// ─── 5. 0DTE plan replay: same-bar order ───────────────────────────────────

test("0DTE replay: a T1 touch in the bar that closes a 5-minute candle below the stop happened first", async () => {
  const { replayOdtePlan } = await import("../../server/validationMath");
  const M = 60_000;
  const T0 = Date.UTC(2026, 9, 9, 14, 0);   // 10:00 ET, a 5-minute boundary
  const CLOSE = Date.UTC(2026, 9, 9, 20, 0);
  const flat = (px: number) => { const o: any[] = []; for (let t = T0; t < CLOSE; t += M) o.push({ datetime: t, open: px, high: px, low: px, close: px }); return o; };
  const plan = { isCall: true, entryTs: T0, closeMs: CLOSE, t1: 6010, stopLevel: 5990, t2: 6025, contracts: 2 };
  // 10:04 bar (ends the 10:00-10:05 candle): high 6011 touches T1, close 5989 < stop.
  const bars = flat(6000);
  bars[4] = { ...bars[4], high: 6011, low: 5988, close: 5989 };
  const r = replayOdtePlan(plan, bars);
  // 2 contracts: 1 at T1 (6010), the runner (1) still under the ORIGINAL
  // stop is stopped at the same close 5989; both known at 10:05.
  assert.deepEqual(r.legs.map((l) => [l.kind, l.fraction, l.underlyingPx, l.time]),
    [["t1_touch", 0.5, 6010, T0 + 5 * M], ["underlying_stop", 0.5, 5989, T0 + 5 * M]]);
  assert.equal(r.hitT1, true);
  assert.equal(r.stoppedBeforeT1, false);
  // Same bar, close NOT beyond the stop: only T1; runner continues.
  const b2 = flat(6000);
  b2[4] = { ...b2[4], high: 6011, close: 6005 };
  assert.deepEqual(replayOdtePlan(plan, b2).legs.map((l) => l.kind), ["t1_touch"]);
  // A bar reaching T2 from below T1 passed T1 first: both legs in that bar.
  const b3 = flat(6000);
  b3[7] = { ...b3[7], high: 6026, close: 6020 };
  const r3 = replayOdtePlan(plan, b3);
  assert.deepEqual(r3.legs.map((l) => [l.kind, l.fraction, l.underlyingPx]), [["t1_touch", 0.5, 6010], ["t2_touch", 0.5, 6025]]);
  assert.equal(r3.remaining, 0);
  // Put side mirror: low 5989 touches T1 5990, 5-minute close 6011 above stop 6010.
  const pp = { isCall: false, entryTs: T0, closeMs: CLOSE, t1: 5990, stopLevel: 6010, contracts: 1 };
  const b4 = flat(6000);
  b4[9] = { ...b4[9], low: 5989, high: 6012, close: 6011 };
  assert.deepEqual(replayOdtePlan(pp, b4).legs.map((l) => [l.kind, l.fraction]), [["t1_touch", 1]]);
});
