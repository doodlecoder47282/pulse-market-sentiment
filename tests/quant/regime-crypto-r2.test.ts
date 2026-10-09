// Round-2 quant tests: Regime, macro, sentiment and crypto (Sectors 5 and 10).
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/regime-crypto-r2.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mulberry32, neweyWestLRV, neweyWestLag, politisWhiteBlockLength, stationaryBootstrapIndices,
  horizonZSeries, terminalRun, regimeZTest, ledoitWolf, ledoitWolfConstantCorrelation, standardizedComposite, toCorrelation,
} from "../../server/macroStats";

const near = (a: number, b: number, tol: number, msg = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} +/- ${tol}, got ${a}`);

function gauss(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─── 5.4 regime z on overlapping windows ───────────────────────────────────

test("Newey-West: lag rule and long-run variance of an MA(1) (seeded MC)", () => {
  // Newey & West (1994): floor(4 (T/100)^(2/9)); T = 100 -> 4, T = 500 -> 5.
  assert.equal(neweyWestLag(100), 4);
  assert.equal(neweyWestLag(500), 5);
  // L = 0 is the divisor-T sample variance: {1,2,3,4} -> 1.25.
  assert.equal(neweyWestLRV([1, 2, 3, 4], 0), 1.25);
  // MA(1) x_t = e_t + theta e_{t-1}: long-run variance = sigma^2 (1 + theta)^2
  // (Hamilton 1994, Time Series Analysis, eq. 10.5.18 / 7.2). theta = 0.5 -> 2.25.
  const r = mulberry32(11);
  const e = Array.from({ length: 40_001 }, () => gauss(r));
  const x = e.slice(1).map((v, i) => v + 0.5 * e[i]);
  const lrv = neweyWestLRV(x, 30);
  assert.ok(Math.abs(lrv - 2.25) < 0.12, `lrv ${lrv}`);
  // the naive variance (1 + theta^2 = 1.25) would understate it
  assert.ok(Math.abs(neweyWestLRV(x, 0) - 1.25) < 0.05);
});

test("horizon z: exact finite-sample scaling sigma^2 w (1 - w/T) for a demeaned sum", () => {
  // Var(S_w - w * mean) = sigma^2 w (1 - w/T) for i.i.d. returns. Check the
  // closed form on a hand case: r = [1, -1, 1, -1, 2, 0], w = 2, lrv = 1.
  const r = [1, -1, 1, -1, 2, 0];
  const z = horizonZSeries(r, 2, 1);
  const mu = 2 / 6;
  const sd = Math.sqrt(1 * 2 * (1 - 2 / 6));
  assert.equal(z.length, 5);
  assert.ok(Math.abs(z[4] - (2 - 2 * mu) / sd) < 1e-12);
  assert.ok(Math.abs(z[0] - (0 - 2 * mu) / sd) < 1e-12);
  // Monte Carlo: the terminal z has unit variance for i.i.d. normal returns.
  const rand = mulberry32(3);
  const zs: number[] = [];
  for (let k = 0; k < 4000; k++) {
    const x = Array.from({ length: 120 }, () => gauss(rand));
    zs.push(horizonZSeries(x, 60, 1).at(-1)!);
  }
  const v = zs.reduce((a, b) => a + b * b, 0) / zs.length;
  assert.ok(Math.abs(v - 1) < 0.06, `var ${v}`);
  assert.equal(terminalRun([0.2, 1.6, 1.7, 2.0], 1.5), 3);
  assert.equal(terminalRun([-1.6, -1.7, 0.4], 1.5), 0);
});

test("Politis-White block length: ~1-2 for i.i.d., larger for AR(1) 0.5; bootstrap mean block = 1/p", () => {
  const r = mulberry32(7);
  const iid = Array.from({ length: 2000 }, () => gauss(r));
  const bi = politisWhiteBlockLength(iid);
  assert.ok(bi.b <= 3, `iid b ${bi.b}`);
  let x = 0;
  const ar = Array.from({ length: 2000 }, () => (x = 0.5 * x + gauss(r)));
  const ba = politisWhiteBlockLength(ar);
  assert.ok(ba.b >= 6 && ba.b <= 40, `ar b ${ba.b}`);
  assert.ok(ba.b <= ba.bMax);
  // Stationary bootstrap: a new block starts with probability 1/L, so the
  // mean run of consecutive indices is L (Politis & Romano 1994).
  const idx = stationaryBootstrapIndices(200_000, 8, mulberry32(1));
  let starts = 1;
  for (let t = 1; t < idx.length; t++) if (idx[t] !== (idx[t - 1] + 1) % idx.length) starts++;
  const meanBlock = idx.length / starts;
  assert.ok(Math.abs(meanBlock - 8) < 0.3, `mean block ${meanBlock}`);
});

test("regime null test is correctly sized on random walks and detects an injected regime", () => {
  // Size: zero-drift random walks, 519 daily returns (the 520-bar cache).
  // Under the null the 5% tests should fire about 5% of the time.
  let sig = 0, durable = 0;
  const N = 120;
  for (let trial = 0; trial < N; trial++) {
    const rnd = mulberry32(9000 + trial);
    const r = Array.from({ length: 519 }, () => 0.01 * gauss(rnd));
    const t = regimeZTest(r, 65, { seed: trial, reps: 99 })!;
    if (t.pZ <= 0.05) sig++;
    if (t.persistence >= 30 && t.pPersist <= 0.05) durable++;
    assert.equal(t.independentWindows, Math.floor(519 / 65));
  }
  assert.ok(sig / N <= 0.10, `size of the z test ${sig}/${N}`);
  assert.ok(durable / N <= 0.08, `size of the persistence test ${durable}/${N}`);
  // Power: the same 1%/day noise plus a 0.4%/day drift over the last 90
  // sessions. Expected z of the 65-day return ~ (65*0.004 - 65*90*0.004/519)
  // / (0.01 sqrt(65 (1 - 65/519))) ~ 2.9, held for the 25+ sessions the
  // window has been inside the drift: a significant, durable regime.
  const rnd = mulberry32(42);
  const r = Array.from({ length: 519 }, (_, i) => 0.01 * gauss(rnd) + (i >= 429 ? 0.004 : 0));
  const t = regimeZTest(r, 65, { seed: 1, reps: 199 })!;
  assert.ok(t.z > 2, `z ${t.z}`);
  assert.ok(t.pZ <= 0.05, `pZ ${t.pZ}`);
  assert.ok(t.persistence >= 30 && t.pPersist <= 0.05, `run ${t.persistence} p ${t.pPersist}`);
  // deterministic for a fixed seed
  assert.equal(regimeZTest(r, 65, { seed: 1, reps: 199 })!.pZ, t.pZ);
  // not enough history -> null, never a fabricated z
  assert.equal(regimeZTest(r.slice(0, 80), 65), null);
});

// ─── 5.6 canary composite as a z-score ─────────────────────────────────────

test("Ledoit-Wolf shrinkage: hand-computed case and Frobenius-loss improvement (seeded MC)", () => {
  // Hand case (Ledoit & Wolf 2004, Sec. 3 estimators, divisor n, ||A||^2 = tr(AA')/p):
  // X = {(2,0),(0,1),(-2,0),(0,-1)}: S = diag(2, 0.5), m = 1.25,
  // d2 = (0.75^2 + 0.75^2)/2 = 0.5625, bbar2 = 4 * 2.125 / 16 = 0.53125,
  // shrinkage = 0.53125 / 0.5625 = 0.94444..., S*11 = 1.291666..., S*22 = 1.208333...
  const lw = ledoitWolf([[2, 0], [0, 1], [-2, 0], [0, -1]])!;
  assert.ok(Math.abs(lw.shrinkage - 0.53125 / 0.5625) < 1e-12);
  assert.ok(Math.abs(lw.cov[0][0] - 1.2916666666666667) < 1e-12);
  assert.ok(Math.abs(lw.cov[1][1] - 1.2083333333333333) < 1e-12);
  assert.equal(lw.cov[0][1], 0);
  // MC: p = 6, n = 30, equicorrelation 0.3. LW must beat the sample
  // covariance in average Frobenius loss (the paper's main result), and the
  // intensity must fall toward 0 as n grows.
  const p = 6, rho = 0.3;
  const draw = (rand: () => number) => {
    const f = gauss(rand);
    return Array.from({ length: p }, () => Math.sqrt(rho) * f + Math.sqrt(1 - rho) * gauss(rand));
  };
  const truth = (i: number, j: number) => (i === j ? 1 : rho);
  const rand = mulberry32(5);
  const sampleCov = (X: number[][]) => {
    const m = Array.from({ length: p }, (_, j) => X.reduce((a, r) => a + r[j], 0) / X.length);
    return Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) =>
      X.reduce((a, r) => a + (r[i] - m[i]) * (r[j] - m[j]), 0) / X.length));
  };
  let lossLW = 0, lossCC = 0, lossS = 0;
  for (let rep = 0; rep < 300; rep++) {
    const X = Array.from({ length: 30 }, () => draw(rand));
    const S = sampleCov(X);
    const est = ledoitWolf(X)!;
    const cc = ledoitWolfConstantCorrelation(X)!;
    assert.ok(cc.shrinkage >= 0 && cc.shrinkage <= 1);
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) {
      lossLW += (est.cov[i][j] - truth(i, j)) ** 2;
      lossCC += (cc.cov[i][j] - truth(i, j)) ** 2;
      lossS += (S[i][j] - truth(i, j)) ** 2;
    }
  }
  assert.ok(lossLW < lossS, `LW ${lossLW} vs sample ${lossS}`);
  assert.ok(lossCC < lossS, `LW-CC ${lossCC} vs sample ${lossS}`);
  // Constant-correlation target, hand case: with every pairwise correlation
  // equal, F = S, gamma = 0 -> intensity 1 and S* = S.
  const eq = ledoitWolfConstantCorrelation([[1, 1], [-1, -1], [1, 1], [-1, -1], [2, 2], [-2, -2]])!;
  assert.ok(Math.abs(eq.mu - 1) < 1e-12);
  const big = ledoitWolf(Array.from({ length: 5000 }, () => draw(rand)))!;
  assert.ok(big.shrinkage < 0.05, `n=5000 shrinkage ${big.shrinkage}`);
});

test("canary composite: sum(w z)/sqrt(w'Rw) is N(0,1) under the null; closed-form limits", () => {
  // Identity R, equal weights, all z = 1, k = 4: 4 / sqrt(4) = 2, effective N = 4.
  const I4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const a = standardizedComposite([1, 1, 1, 1], [1, 1, 1, 1], I4)!;
  assert.equal(a.z, 2);
  assert.equal(a.effectiveN, 4);
  // Perfect correlation: the z equals the weighted mean, effective N = 1.
  const ones = [[1, 1, 1], [1, 1, 1], [1, 1, 1]];
  const b = standardizedComposite([1, 0.8, 1.1], [2, -1, 0.5], ones)!;
  assert.ok(Math.abs(b.z - b.weightedMean) < 1e-12);
  assert.ok(Math.abs(b.effectiveN - 1) < 1e-12);
  // Seeded MC with the canary weights and equicorrelation 0.3: with R
  // estimated by Ledoit-Wolf (constant-correlation target) from 126 days the
  // composite has variance ~1,
  // while the old weighted mean has variance w'Rw/(sum w)^2 (~0.42 here).
  const w = [1.0, 1.0, 0.8, 0.9, 1.1, 0.5];
  const p = w.length, rho = 0.3;
  const rand = mulberry32(17);
  const draw = () => {
    const f = gauss(rand);
    return Array.from({ length: p }, () => Math.sqrt(rho) * f + Math.sqrt(1 - rho) * gauss(rand));
  };
  const hist = Array.from({ length: 126 }, draw);
  const R = toCorrelation(ledoitWolfConstantCorrelation(hist)!.cov);
  let v = 0, vMean = 0;
  const N = 6000;
  for (let k = 0; k < N; k++) {
    const r = standardizedComposite(w, draw(), R)!;
    v += r.z * r.z;
    vMean += r.weightedMean * r.weightedMean;
  }
  v /= N; vMean /= N;
  assert.ok(Math.abs(v - 1) < 0.12, `composite variance ${v}`);
  assert.ok(vMean < 0.55, `weighted-mean variance ${vMean}`);
  // a 1.25 weighted-mean alarm was really about z = 1.25 / sqrt(vMean)
  assert.ok(1.25 / Math.sqrt(vMean) > 1.7);
});

// ─── 5.5 composite: one vol factor, not four ──────────────────────────────

test("composite: correlated vol gauges share one block weight; F&G cut for its VIX/put-call overlap", async () => {
  const { computeComposite, blockWeights, BLOCK_WEIGHTS } = await import("../../server/composite");
  const base: any = {
    vol: { vix: { value: 40 }, vvix: { value: 150 }, vix9d: { value: null }, vix3m: { value: null }, skew: { value: 160 } },
    term: { ratio9dOver30d: 1.3, ratio30dOver3m: null },
    gamma: { totalGex: 3e9, regime: "positive", callWall: 0, putWall: 0, maxPain: 0, zeroGamma: null, pcrOi: 0.5, pcrVol: 1 },
    social: { score: null, bullish: 0, bearish: 0, neutral: 0, posts: [], status: "unavailable" },
    fearGreed: null, aaii: null, spy: { price: 1, prevClose: 1, changePct: 0 },
  };
  const c = computeComposite(base);
  const share = (blk: string) => c.gauges.filter((g: any) => g.block === blk).reduce((a: number, g: any) => a + g.weight, 0);
  // Two blocks present (vol, positioning), each 0.30 -> 0.5 / 0.5 after renormalization.
  assert.ok(Math.abs(share("implied-vol") - 0.5) < 1e-12);
  assert.ok(Math.abs(c.gauges.reduce((a: number, g: any) => a + g.weight, 0) - 1) < 1e-12);
  // Hand-computed score: vol sub-scores VIX 40->5, VVIX 150->10, term 1.3->10, SKEW 160->25
  // with intra weights .45/.15/.25/.15 -> 2.25 + 1.5 + 2.5 + 3.75 = 10; positioning
  // PCR 0.5->85 (.45), gamma 3B->75 (.55) -> 79.5. Score = 0.5 * 10 + 0.5 * 79.5 = 44.75 -> 45.
  assert.equal(c.score, 45);
  // The old independent average would have let the vol factor carry 0.50/0.77 of it.
  // Dropping three of four vol gauges does not change the vol block's share.
  const onlyVix = computeComposite({ ...base, vol: { ...base.vol, vvix: { value: null }, skew: { value: null } }, term: { ratio9dOver30d: null, ratio30dOver3m: null } });
  assert.ok(Math.abs(onlyVix.gauges.filter((g: any) => g.block === "implied-vol").reduce((a: number, g: any) => a + g.weight, 0) - 0.5) < 1e-12);
  // F&G block weight carries the 5/7 haircut
  assert.ok(Math.abs(BLOCK_WEIGHTS["fear-greed"] - 0.15 * 5 / 7) < 1e-15);
  const w = blockWeights([{ block: "fear-greed", intra: 1 }, { block: "crowd", intra: 0.4 }]);
  const tot = BLOCK_WEIGHTS["fear-greed"] + BLOCK_WEIGHTS.crowd;
  assert.ok(Math.abs(w[0] - BLOCK_WEIGHTS["fear-greed"] / tot) < 1e-12);
  assert.ok(Math.abs(w[1] - BLOCK_WEIGHTS.crowd / tot) < 1e-12);
  assert.match(c.method ?? "", /heuristic/);
});

// ─── 5.7 breadth sample labelled; sector participation; stale bars ────────

test("breadth: sample labelled as hand-picked large caps; sector participation counts each sector once; stale bars flagged", async () => {
  const { computeBreadth, SECTOR_ETFS, lastCompletedSession } = await import("../../server/breadthMath");
  const { nextTradingDay } = await import("../../server/exchangeCalendar");
  const dates: string[] = [];
  let d = "2026-05-01";
  while (dates.length < 110) { dates.push(d); d = nextTradingDay(d); }
  const last = dates[dates.length - 1];
  const up = (sym: string) => dates.map((date, i) => ({ symbol: sym, date, close: 100 + i }));
  const down = (sym: string) => dates.map((date, i) => ({ symbol: sym, date, close: 300 - i }));
  const stocks = Array.from({ length: 36 }, (_, i) => `S${i}`);
  // 27 of 36 rising -> 75% above 20dma; 8 of 11 sectors rising -> 72.7%
  const rows = stocks.flatMap((s, i) => (i < 27 ? up(s) : down(s)));
  const etfRows = [...up("SPY"), ...up("RSP"), ...SECTOR_ETFS.flatMap((s, i) => (i < 8 ? up(s) : down(s)))];
  // "now" = 17:00 ET on the last date: that session is complete and present.
  const nowOk = Date.parse(`${last}T21:00:00Z`);
  assert.equal(lastCompletedSession(nowOk), last);
  const b = computeBreadth({ rows, etfRows, stockSymbols: stocks, nowMs: nowOk });
  assert.equal(b.pctAbove20dma, 75);
  assert.equal(b.sectorBreadth.pctAbove20dma, Number(((8 / 11) * 100).toFixed(1)));
  assert.equal(b.sectorBreadth.sectors, 11);
  assert.equal(b.sample.random, false);
  assert.match(b.note, /not the median stock/);
  assert.equal(b.dataState, "ok");
  // Two sessions later with no new bars: stale, and the read says so.
  const later = nextTradingDay(nextTradingDay(last));
  const b2 = computeBreadth({ rows, etfRows, stockSymbols: stocks, nowMs: Date.parse(`${later}T21:00:00Z`) });
  assert.equal(b2.dataState, "stale");
  assert.equal(b2.lastBarDate, last);
  assert.match(b2.read, /stale/);
  // No SPY history: insufficient, never a 0% reading.
  const b3 = computeBreadth({ rows, etfRows: [], stockSymbols: stocks, nowMs: nowOk });
  assert.equal(b3.dataState, "insufficient");
  assert.equal(b3.pctAbove20dma, null);
});

// ─── 5.8 Signals headline feed: real labeled source, or "unavailable" ─────

test("headline feed: labeled RSS items with age; all-failed is unavailable, not an empty quiet list", async () => {
  const { summarizeHeadlineFeed } = await import("../../server/news");
  const now = Date.parse("2026-10-08T15:00:00Z");
  const h = (title: string, source: string, hoursAgo: number | null) => ({
    id: title, title, source, url: `https://x/${encodeURIComponent(title)}`,
    published: hoursAgo == null ? 0 : now / 1000 - hoursAgo * 3600, summary: "", topics: [], tickers: [],
  });
  const down = summarizeHeadlineFeed([{ name: "A", items: null }, { name: "B", items: null }], now);
  assert.equal(down.status, "unavailable");
  assert.equal(down.items.length, 0);
  assert.match(down.note, /no headline source/);
  const mixed = summarizeHeadlineFeed([
    { name: "A", items: [h("Fed holds rates", "A", 1), h("Old story", "A", 30), h("No date", "A", null)] },
    { name: "B", items: null },
    { name: "C", items: [h("Fed holds rates", "C", 2), h("CPI hot", "C", 0.5)] },
  ], now);
  assert.equal(mixed.status, "partial");
  assert.deepEqual(mixed.items.map((i: any) => i.title), ["CPI hot", "Fed holds rates"]); // newest first, deduped, >24h dropped
  assert.equal(mixed.items[0].source, "C");
  assert.equal(mixed.items[0].publishedAt, new Date(now - 0.5 * 3600_000).toISOString());
  assert.equal(mixed.undatedDropped, 1);
  const stale = summarizeHeadlineFeed([{ name: "A", items: [h("Old", "A", 48)] }], now);
  assert.equal(stale.status, "empty");
});

// ─── Seasonality: a window that fails the hold-out is never "Optimal" ─────

test("seasonality verdict: significant but bottom-half out of sample is failed_out_of_sample, not validated", async () => {
  const { seasonalVerdict, findOptimalWindow, generateAnalysisText } = await import("../../server/seasonality");
  assert.equal(seasonalVerdict(false, { percentile: 0.99, pValue: 0.01 }), "not_significant");
  assert.equal(seasonalVerdict(true, null), "in_sample_only");
  assert.equal(seasonalVerdict(true, { percentile: 0.3, pValue: 0.7 }), "failed_out_of_sample");
  // top half is not enough: "validated" needs the held-out calendar-shift p-value <= 0.10
  assert.equal(seasonalVerdict(true, { percentile: 0.6, pValue: 0.4 }), "held_up_not_significant");
  assert.equal(seasonalVerdict(true, { percentile: 0.95, pValue: 0.05 }), "validated");
  // A calendar effect present only in the early (training) years: the
  // in-sample search finds it, the held-out recent years do not have it.
  // Seeded fixture, 20 years: +0.5%/day on days 100-159 in the first 14
  // years; in the 6 held-out years (floor(20/3)) that window loses 0.4%/day
  // and days 1-59 gain 0.15%/day. The full-sample search still passes the
  // snooping test (p 0.04 with this seed), but the window picked on the
  // first 14 years ranks in the bottom third of same-length windows on the
  // held-out years: the case that used to read "Optimal" in green.
  const r = mulberry32(31);
  const m = new Map<number, number[]>();
  for (let y = 0; y < 20; y++) {
    let L = 0;
    const p = [0];
    for (let d = 1; d < 252; d++) {
      const inWin = d >= 100 && d < 160;
      L += (y < 14 ? (inWin ? 0.005 : 0) : (inWin ? -0.004 : d < 60 ? 0.0015 : 0)) + 0.01 * gauss(r);
      p.push((Math.exp(L) - 1) * 100);
    }
    m.set(2000 + y, p);
  }
  const w = findOptimalWindow(m, { permutations: 49 })!;
  assert.ok(w.significance!.significant, `p ${w.significance!.pFamilywise}`);
  assert.ok(w.significance!.outOfSample!.randomWindowPercentile < 0.5);
  assert.equal(w.verdict, "failed_out_of_sample");
  // held-out p-value: share of same-length windows at least as good (here most of them)
  assert.ok(w.significance!.outOfSample!.pValue > 0.5);
  assert.equal(w.confidenceLabel, "Weak");
  const text = generateAnalysisText("TEST", w, { fullYearAvg: 1, fullYearWinRate: 0.5, presidentialCycleYear: 2, presidentialCycleAvg: null }, 20);
  assert.match(text, /NOT validated/);
  assert.match(text, /^In-sample analysis/);
});

// ─── Cosmos: deterministic trade-instruction filter on the LLM narrative ──

test("cosmos filter is an allow-list of sky talk: market sentences dropped (adversarial set), sky facts kept, disclaimer forced", async () => {
  const { filterTradeInstructions, isTradeInstruction, COSMOS_LLM_DISCLAIMER } = await import("../../server/cosmos");
  // Eight paraphrased market sentences with no order verb (the review's
  // adversarial set: 7 of 8 slipped past the old deny-list).
  const adversarial = [
    "Equities have historically drifted lower in the week after a full moon.",
    "Tech names tend to wobble around Mercury stations.",
    "SPX 5,800 is a level to watch into the new moon.",
    "Traders may want to keep powder dry until Mercury goes direct.",
    "The S&P has had a soft patch around the equinox.",
    "Capital preservation matters most while the Moon is void of course.",
    "Defensive sectors held up better during past geomagnetic storms.",
    "Risk appetite often fades into an eclipse.",
  ];
  // Benign sky sentences that must survive.
  const benign = [
    "Mercury stations direct on Tue Oct 13.",
    "The full Moon falls on Thu Oct 15 at 14:20 ET.",
    "Venus enters Libra on Oct 17.",
    "The Moon is void of course from 09:12 to 15:40 ET.",
    "Saturn is retrograde in Pisces.",
    "Kp reached 5 (a G1 storm) on Oct 10.",
    "Jupiter trines Saturn (120 degrees) on Oct 20.",
    "The Moon exits Virgo late on Oct 21.",
    "Krivelyova and Robotti (2003) is a single working paper.",
    "Bradley turns on Oct 20; it has no peer-reviewed support.",
  ];
  for (const s of adversarial) assert.ok(isTradeInstruction(s), `should drop: ${s}`);
  for (const s of benign) assert.ok(!isTradeInstruction(s), `should keep: ${s}`);
  // order and direction forms are dropped too
  for (const s of ["Buy the dip on Monday.", "Go long into the new moon.", "Hedge with puts.", "A bullish week.", "Take profits before Friday.", "Consider lightening up before the eclipse.", "Stay defensive into Friday."]) {
    assert.ok(isTradeInstruction(s), s);
  }
  const llm = ["## Week ahead", benign[0] + " " + adversarial[1], "- " + adversarial[2], "- " + benign[2], ...adversarial.slice(3), benign[9]].join("\n");
  const f = filterTradeInstructions(llm);
  assert.ok(f.text.startsWith(COSMOS_LLM_DISCLAIMER));
  for (const s of adversarial.slice(1)) assert.ok(!f.text.includes(s), s);
  for (const s of [benign[0], benign[2], benign[9], "## Week ahead"]) assert.ok(f.text.includes(s), s);
  assert.equal(f.dropped, 7);
  // the disclaimer appears exactly once even if the model already wrote it
  const twice = filterTradeInstructions(`${COSMOS_LLM_DISCLAIMER}\n\nThe Moon is waxing.`);
  assert.equal(twice.text.split(COSMOS_LLM_DISCLAIMER).length - 1, 1);
});

// ─── Sector 10: crypto data states, coin-level stats, holders, social ────

test("crypto: observed $0 liquidity is a pull (RUGGED), absent liquidity is missing", async () => {
  const { observedNumber, gradeSignal } = await import("../../server/cryptoStats");
  // DexScreener Pair: liquidity / liquidity.usd / marketCap / fdv / priceUsd are nullable.
  assert.equal(observedNumber(0), 0);
  assert.equal(observedNumber("0"), 0);
  assert.equal(observedNumber("0.00012"), 0.00012);
  assert.equal(observedNumber(undefined), null);
  assert.equal(observedNumber(null), null);
  assert.equal(observedNumber(""), null);
  assert.equal(observedNumber("n/a"), null);
  const base = { entryMcap: 400_000, entryLiq: 40_000, prevPeak: 420_000, targetMcap: 5_000_000, horizonMs: 72 * 3600_000 };
  // full pull: liquidity 0 observed, market cap missing -> RUGGED (used to be "missing" -> NO_DATA)
  assert.equal(gradeSignal({ ...base, mcap: null, liq: 0, ageMs: 3600_000 }).outcome, "RUGGED");
  // liquidity field absent, mcap absent, inside horizon -> still OPEN; past horizon -> NO_DATA, never DEAD
  assert.equal(gradeSignal({ ...base, mcap: null, liq: null, ageMs: 3600_000 }).outcome, "OPEN");
  assert.equal(gradeSignal({ ...base, mcap: null, liq: null, ageMs: 80 * 3600_000 }).outcome, "NO_DATA");
  // observed mcap 0 -> RUGGED (below 10% of entry), not missing
  assert.equal(gradeSignal({ ...base, mcap: 0, liq: 30_000, ageMs: 3600_000 }).outcome, "RUGGED");
  // ordinary paths unchanged
  assert.equal(gradeSignal({ ...base, mcap: 5_100_000, liq: 300_000, ageMs: 3600_000 }).outcome, "HIT_5M");
  assert.equal(gradeSignal({ ...base, mcap: 300_000, liq: 30_000, ageMs: 80 * 3600_000 }).outcome, "DEAD");
  const d = gradeSignal({ ...base, mcap: 300_000, liq: 30_000, ageMs: 80 * 3600_000, prevPeak: 900_000 });
  assert.equal(d.outcome, "DOUBLED");
  assert.equal(d.peak, 900_000);
});

test("crypto stats: gate and counts on distinct coins (first signal per coin), NO_DATA share (node:sqlite)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { CRYPTO_SIGNAL_COUNTS_SQL, cryptoCoinCountsSql, summarizeDeskStats } = await import("../../server/cryptoStats");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE crypto_signals (id TEXT PRIMARY KEY, detected_at INTEGER, chain TEXT, pair_address TEXT, token_address TEXT, verdict TEXT, outcome TEXT)`);
  const ins = db.prepare(`INSERT INTO crypto_signals VALUES (?, ?, 'solana', ?, ?, ?, ?)`);
  // coin A: WATCH day 1 (DEAD), ENTER day 1 (DEAD), WATCH day 2 (DEAD) -> 3 rows, 1 coin
  ins.run("a1", 1000, "pA", "mintA", "WATCH", "DEAD");
  ins.run("a2", 2000, "pA", "mintA", "ENTER", "DEAD");
  ins.run("a3", 90_000_000, "pA", "mintA", "WATCH", "DEAD");
  // coin B: two pairs of the same mint, first signal HIT_5M
  ins.run("b1", 1500, "pB1", "mintB", "ENTER", "HIT_5M");
  ins.run("b2", 1600, "pB2", "mintB", "WATCH", "RUGGED");
  // coin C: unknown mint -> identity falls back to the pair
  ins.run("c1", 1700, "pC", "", "WATCH", "NO_DATA");
  // coin D: still open
  ins.run("d1", 1800, "pD", "mintD", "WATCH", "OPEN");
  const st = summarizeDeskStats(
    db.prepare(CRYPTO_SIGNAL_COUNTS_SQL).get() as any,
    db.prepare(cryptoCoinCountsSql()).get() as any,
    db.prepare(cryptoCoinCountsSql("ENTER")).get() as any,
  );
  assert.equal(st.rows.total, 7);
  assert.equal(st.rows.graded, 5);
  assert.equal(st.total, 4);      // A, B, C, D
  assert.equal(st.graded, 2);     // A DEAD, B HIT_5M (first signals)
  assert.equal(st.dead, 1);
  assert.equal(st.hit5m, 1);
  assert.equal(st.rugged, 0);     // B's later RUGGED row is not its first signal
  assert.equal(st.noData, 1);
  assert.equal(st.open, 1);
  assert.ok(Math.abs((st.noDataShare ?? 0) - 1 / 3) < 1e-12);
  assert.equal(st.enterCoins.total, 2); // A and B have an ENTER row
  assert.equal(st.sampleReady, false);
  // the gate uses graded COINS: 60 graded rows from 10 coins is not ready
  const many = summarizeDeskStats({ total: 60, open: 0, hit5m: 0, doubled: 0, rugged: 0, dead: 60 }, { total: 10, open: 0, hit5m: 0, doubled: 0, rugged: 0, dead: 10 }, null);
  assert.equal(many.rows.sampleReady, true);
  assert.equal(many.sampleReady, false);
});

test("crypto holders: only identified pool vaults and burn are excluded; a whale at #1 counts", async () => {
  const { holderConcentration, SOLANA_INCINERATOR } = await import("../../server/cryptoStats");
  const supply = 1_000_000_000;
  // #1 is a whale (25%), #2 the Raydium-style vault matching the pool's base reserve (20%),
  // #3 burned (10%), #4 a pool-owned vault of a second pool (5%), then 10 holders of 2% each.
  const accounts = [
    { address: "whale", uiAmount: 250_000_000, owner: "WhaleWallet" },
    { address: "vaultR", uiAmount: 200_000_000, owner: "RaydiumAuthority" },
    { address: "burnAcct", uiAmount: 100_000_000, owner: SOLANA_INCINERATOR },
    { address: "vaultO", uiAmount: 50_000_000, owner: "pool2" },
    ...Array.from({ length: 10 }, (_, i) => ({ address: `h${i}`, uiAmount: 20_000_000, owner: `w${i}` })),
  ];
  const pools = [{ pairAddress: "pool1", baseAmount: 201_000_000 }, { pairAddress: "pool2", baseAmount: 49_000_000 }];
  const r = holderConcentration(accounts, pools, supply);
  // top-10 non-pool non-burn: whale 25% + nine 2% holders = 43%
  assert.equal(r.top10Pct, 43);
  assert.deepEqual(r.excluded.map((e) => [e.address, e.reason]).sort(), [["burnAcct", "burn"], ["vaultO", "pool-owned"], ["vaultR", "pool-reserve-match"]]);
  assert.equal(r.poolsMatched, 2);
  // the old rule (drop the largest, sum the next ten) would have hidden the whale:
  const old = accounts.slice(1, 11).reduce((s, a) => s + a.uiAmount, 0) / supply * 100;
  assert.equal(old, 49); // 20 vault + 10 burn + 5 pool2 + 7 x 2: counts pool and burn, drops the whale
  // no pool identifiable (no owners, no reserves): nothing excluded, labelled as overstated
  const blind = holderConcentration(accounts.map((a) => ({ ...a, owner: null })), [{ pairAddress: "pool1", baseAmount: null }], supply);
  assert.equal(blind.top10Pct, 25 + 20 + 10 + 5 + 6 * 2);
  assert.match(blind.method, /INCLUDING/);
  assert.equal(holderConcentration([], pools, supply).top10Pct, null);
});

test("crypto social: cashtag + contract-address union, capped search is a lower bound, score normalized over applicable sources", async () => {
  const { countMentions, computeSocialScore, socialCoverage, resolveSocialCollection } = await import("../../server/cryptoStats");
  const now = Date.parse("2026-10-08T15:00:00Z");
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const mint = "So1anaMint1111111111111111111111111111111pump";
  const mc = countMentions([
    { kind: "cashtag", capped: false, posts: [
      { uri: "at://1", createdAt: iso(5), text: "$CAT to the moon" },
      { uri: "at://2", createdAt: iso(30), text: `$CAT ${mint}` },
      { uri: "at://3", createdAt: iso(90), text: "$CAT old" },
    ] },
    { kind: "address", capped: true, posts: [
      { uri: "at://2", createdAt: iso(30), text: `$CAT ${mint}` }, // duplicate of the cashtag hit
      { uri: "at://4", createdAt: iso(8), text: `ca: ${mint}` },
    ] },
  ], mint, now);
  assert.deepEqual(mc, { m10: 2, byAddress10m: 1, m1h: 3, capped: true, byAddress1h: 2 });
  // Address matches count fully, cashtag-only at 0.5: 1h = 2 + 0.5 x 1 = 2.5 -> 2.5 x 2.5 = 6.25 pts;
  // 10m = 1 + 0.5 x 1 = 1.5 -> 18 pts; Bluesky-only normalization 24.25 / 55 -> 44.
  const { weightedMentions } = await import("../../server/cryptoStats");
  assert.equal(weightedMentions(3, 2), 2.5);
  assert.equal(weightedMentions(3, null), 3); // legacy rows (no split) count all
  assert.equal(computeSocialScore({ bskyMentions10m: 2, bskyMentions1h: 3, bskyMentionsByAddress10m: 1, bskyMentionsByAddress1h: 2, pumpReplyPerHr: null, pumpLive: false, hasSocialLinks: null }, { bsky: true, pump: false }), 44);
  // normalization: Bluesky-only token with saturated Bluesky points scores 100, not 55
  const sat = { bskyMentions10m: 3, bskyMentions1h: 8, pumpReplyPerHr: null, pumpLive: false, hasSocialLinks: null };
  assert.equal(computeSocialScore(sat, { bsky: true, pump: false }), 100);
  assert.equal(computeSocialScore(sat), 55); // both sources applicable: unchanged scale
  // pump-only: 40 replies/hr (30) + live (10) + links (5) = 45/45 -> 100
  assert.equal(computeSocialScore({ bskyMentions10m: null, bskyMentions1h: null, pumpReplyPerHr: 40, pumpLive: true, hasSocialLinks: true }, { bsky: false, pump: true }), 100);
  assert.equal(computeSocialScore(sat, { bsky: false, pump: false }), null);
  assert.match(socialCoverage({ bsky: true, pump: false }), /pump.fun n\/a/);
  // a complete collection with no applicable source is unavailable, not a 0 score
  const u = resolveSocialCollection({ socialScore: null, socialCheckedAt: null, socialStatus: null }, { bsky: "ok", pump: "skipped" }, null, now);
  assert.equal(u.socialScore, null);
  assert.equal(u.socialStatus, "unavailable");
});

// ─── Non-price context sources: labelled with source and age, never a price input ─

test("non-price sources: F&G carries source/asOf, stale is left out; marketScore excludes social/survey/F&G", async () => {
  const { parseFearGreed, FEAR_GREED_MAX_AGE_MS } = await import("../../server/sources");
  const { computeComposite } = await import("../../server/composite");
  const now = Date.parse("2026-10-08T15:00:00Z");
  const fresh = parseFearGreed({ fear_and_greed: { score: 72.4, rating: "greed", timestamp: "2026-10-08T14:00:00Z" } }, now)!;
  assert.equal(fresh.value, 72);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.asOf, "2026-10-08T14:00:00.000Z");
  assert.match(fresh.source, /CNN/);
  const old = parseFearGreed({ fear_and_greed: { score: 20, rating: "fear", timestamp: now - FEAR_GREED_MAX_AGE_MS - 1 } }, now)!;
  assert.equal(old.stale, true);
  assert.equal(parseFearGreed({ fear_and_greed: { score: 50, rating: "neutral" } }, now)!.stale, true); // undated
  assert.equal(parseFearGreed({}, now), null);
  const base: any = {
    vol: { vix: { value: 12 }, vvix: { value: null }, vix9d: { value: null }, vix3m: { value: null }, skew: { value: null } },
    term: { ratio9dOver30d: null, ratio30dOver3m: null },
    gamma: { totalGex: 3e9, regime: "positive", callWall: 0, putWall: 0, maxPain: 0, zeroGamma: null, pcrOi: 0.5, pcrVol: 1 },
    social: { score: -100, bullish: 0, bearish: 10, neutral: 0, posts: [], status: "ok" },
    aaii: null, spy: { price: 1, prevClose: 1, changePct: 0 },
  };
  const withOld = computeComposite({ ...base, fearGreed: old });
  assert.equal(withOld.gauges.some((g: any) => /Fear & Greed/.test(g.name)), false);
  const withFresh = computeComposite({ ...base, fearGreed: fresh }, { score: -100, sampleSize: 20 });
  assert.equal(withFresh.gauges.some((g: any) => /Fear & Greed/.test(g.name)), true);
  // marketScore: VIX 12 -> 90 (vol block), PCR 0.5 -> 85 (.45) + gamma 3B -> 75 (.55) = 79.5;
  // equal block weights -> (90 + 79.5) / 2 = 84.75 -> 85, unaffected by the -100 social and voices reads.
  assert.equal(withFresh.marketScore, 85);
  assert.ok(withFresh.score < withFresh.marketScore!);
});

test("regime FDR: Benjamini-Hochberg q-values (hand-computed) gate fresh and durable across the 21 readings", async () => {
  const { benjaminiHochberg, regimeFdrFlags } = await import("../../server/macroStats");
  // Benjamini & Hochberg (1995) step-up. p = [0.01, 0.04, 0.03, 0.20], m = 4:
  // sorted 0.01, 0.03, 0.04, 0.20 -> p m / k = 0.04, 0.06, 0.0533, 0.20;
  // monotone from the top: 0.04, 0.0533, 0.0533, 0.20.
  const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.2]);
  assert.ok(Math.abs(q[0] - 0.04) < 1e-12);
  assert.ok(Math.abs(q[1] - 0.04 * 4 / 3) < 1e-12);
  assert.ok(Math.abs(q[2] - 0.04 * 4 / 3) < 1e-12);
  assert.ok(Math.abs(q[3] - 0.2) < 1e-12);
  assert.ok(Number.isNaN(benjaminiHochberg([NaN, 0.01])[0]));
  // 21 readings: one at p = 0.03 alone is NOT fresh after BH (q = 0.63); one at p = 0.001 is.
  const items = Array.from({ length: 21 }, (_, i) => ({ pZ: i === 0 ? 0.03 : i === 1 ? 0.001 : 0.5, pPersist: i === 2 ? 0.002 : 1, freshCandidate: i < 2, persistence: i === 2 ? 40 : 0 }));
  const f = regimeFdrFlags(items);
  assert.equal(f[0].fresh, false);
  assert.ok(Math.abs(f[0].qZ - 0.03 * 21 / 2) < 1e-12);
  assert.equal(f[1].fresh, true);
  assert.equal(f[2].durable, true); // q = 0.002 * 21 / 1 = 0.042
  assert.ok(Math.abs(f[2].qPersist - 0.042) < 1e-12);
});

test("regime block length accounts for volatility clustering (GARCH): max of r and |r| lengths", async () => {
  const { politisWhiteBlockLength, regimeZTest } = await import("../../server/macroStats");
  // GARCH(1,1) a = 0.10, b = 0.88, 1000 days after burn-in: returns ~uncorrelated,
  // |returns| persistent (seeded; across 20 seeds |r| always gave the longer block).
  const rand = mulberry32(1);
  const r: number[] = [];
  let h = 1e-4, e = 0;
  for (let t = 0; t < 1500; t++) { h = 2e-6 + 0.1 * e * e + 0.88 * h; e = Math.sqrt(h) * gauss(rand); if (t >= 500) r.push(e); }
  const bR = politisWhiteBlockLength(r).b;
  const bA = politisWhiteBlockLength(r.map(Math.abs)).b;
  assert.ok(bA > bR, `|r| block ${bA} vs r block ${bR}`);
  assert.equal(regimeZTest(r, 20, { reps: 99, seed: 1 })!.blockLength, Math.max(bR, bA));
});

test("Ledoit-Wolf constant-correlation: reference value on the review's 80x6 fixture (paper divisor T and covCor's N-1)", async () => {
  const { readFileSync } = await import("node:fs");
  const X = JSON.parse(readFileSync(new URL("./fixtures/lw_constant_correlation_X.json", import.meta.url), "utf8")) as number[][];
  assert.equal(X.length, 80);
  // Divisor T (Ledoit & Wolf 2004 formulas; covCor with k = 0 after demeaning): 0.16363055 (review reference).
  assert.ok(Math.abs(ledoitWolfConstantCorrelation(X)!.shrinkage - 0.16363055267710927) < 1e-10);
  // The authors' covCor.py default (demean, n = N - 1): 0.16347232 (numpy port of
  // https://github.com/pald22/covShrinkage/blob/main/covCor.py on the same fixture).
  assert.ok(Math.abs(ledoitWolfConstantCorrelation(X, { k: 1 })!.shrinkage - 0.163472318283661) < 1e-10);
});

test("canary thresholds: composite close-to-close history and empirical percentiles (known answers)", async () => {
  const { compositeHistory, empiricalQuantile } = await import("../../server/macroStats");
  // type-7 quantile: [1..5], q = 0.95 -> 1 + 0.95 * 4 = 4.8
  assert.equal(empiricalQuantile([5, 1, 3, 2, 4], 0.95), 4.8);
  assert.equal(empiricalQuantile([1, 2, 3, 4], 0.5), 2.5);
  // One column, window 2: day 2 return 3 over sd of [1, -1] (= sqrt(2)) -> z = 3 / sqrt(2);
  // with R = [[1]] and w = [1] the composite equals z.
  const h = compositeHistory([[1], [-1], [3]], [1], [[1]], 2);
  assert.equal(h.length, 1);
  assert.ok(Math.abs(h[0] - 3 / Math.SQRT2) < 1e-12);
  // transform hook (crude spike rule) is applied per column before combining
  const t = compositeHistory([[1], [-1], [-3]], [1], [[1]], 2, (_j, z) => (-z >= 2 ? Math.abs(z) : z));
  assert.ok(Math.abs(t[0] - 3 / Math.SQRT2) < 1e-12);
  // Fat tails: Student-t(3) canaries have empirical 97.5% lines different from 1.96,
  // which is why the alarm uses the composite's own history.
  const rand = mulberry32(8);
  const tdraw = () => { const z = gauss(rand); let c = 0; for (let k = 0; k < 3; k++) c += gauss(rand) ** 2; return z / Math.sqrt(c / 3); };
  const X = Array.from({ length: 600 }, () => [tdraw(), tdraw(), tdraw()]);
  const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const hist = compositeHistory(X, [1, 1, 1], I3, 20);
  const m = hist.reduce((a, b) => a + b, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((a, b) => a + (b - m) ** 2, 0) / (hist.length - 1));
  assert.ok(sd > 1.05, `realized sd ${sd}`); // rolling-vol z of t(3) returns is wider than N(0,1)
});

test("sentiment weights: HRP on gauge history (known answer), sample gate, heuristic fallback labelled", async () => {
  const { estimateGaugeWeights, computeComposite, WEIGHT_MIN_DAYS } = await import("../../server/composite");
  // Independent daily changes, variances VIX 1, SKEW 4 (implied-vol block), PCR 2 (positioning).
  // Round 3: HRP on the CORRELATION of changes (sub-scores share one 0..100
  // scale, so change variance is not a precision measure). Within vol: equal
  // 1/2, 1/2, block z-variance 1/4 + 1/4 = 1/2; PCR block 1; between blocks
  // 2 : 1 -> 2/3, 1/3. Effective weights 1/3 each; effective N = 3.
  const rand = mulberry32(12);
  const hist: Array<Record<string, number>> = [];
  let a = 50, b = 50, c = 50;
  for (let t = 0; t < 3001; t++) {
    hist.push({ "VIX Level": a, "SKEW Index": b, "Put/Call OI (0-45 DTE)": c });
    a += gauss(rand); b += 2 * gauss(rand); c += Math.SQRT2 * gauss(rand);
  }
  const r = estimateGaugeWeights(hist);
  assert.ok(r.ok);
  if (!r.ok) return;
  near(r.est.weights["VIX Level"], 1 / 3, 0.03, "VIX");
  near(r.est.weights["SKEW Index"], 1 / 3, 0.03, "SKEW");
  near(r.est.weights["Put/Call OI (0-45 DTE)"], 1 / 3, 0.03, "PCR");
  near(r.est.effectiveN, 3, 0.15, "effective N");
  // Two copies of one factor count about once: effective N falls toward 1 + PCR.
  const dup = hist.map((h) => ({ ...h, "VVIX (Vol-of-Vol)": h["VIX Level"] * 1.0 }));
  const r2 = estimateGaugeWeights(dup);
  assert.ok(r2.ok && r2.est.effectiveN < r.est.effectiveN + 0.05, "a duplicated gauge adds ~no independent information");
  // Sample gate: fewer than 60 daily changes -> not estimated, with the reason.
  const short = estimateGaugeWeights(hist.slice(0, WEIGHT_MIN_DAYS - 10));
  assert.equal(short.ok, false);
  const base: any = {
    vol: { vix: { value: 20 }, vvix: { value: null }, vix9d: { value: null }, vix3m: { value: null }, skew: { value: 140 } },
    term: { ratio9dOver30d: null, ratio30dOver3m: null },
    gamma: { totalGex: 1e9, regime: "positive", callWall: 0, putWall: 0, maxPain: 0, zeroGamma: null, pcrOi: 1, pcrVol: 1 },
    social: { score: null, bullish: 0, bearish: 0, neutral: 0, posts: [], status: "unavailable" },
    fearGreed: null, aaii: null, spy: { price: 1, prevClose: 1, changePct: 0 },
  };
  // Gate failed: hand-set weights, labelled heuristic, no method citation, no effective N.
  const h = computeComposite(base, null, short);
  assert.equal(h.weightSource, "heuristic");
  assert.match(h.method ?? "", /heuristic hand-set/);
  assert.doesNotMatch(h.method ?? "", /Lopez|Prado|risk parity/);
  assert.equal(h.effectiveGauges, null);
  // Gate passed but Dealer Gamma has no estimated weight -> heuristic (every gauge must be covered).
  assert.equal(computeComposite(base, null, r).weightSource, "heuristic");
  // Covered: estimated weights used, renormalized over the gauges present.
  const est = { ok: true as const, est: { ...r.est, weights: { ...r.est.weights, "Dealer Gamma Regime": 0.2 } } };
  const e = computeComposite(base, null, est);
  assert.equal(e.weightSource, "estimated");
  const tot = r.est.weights["VIX Level"] + r.est.weights["SKEW Index"] + r.est.weights["Put/Call OI (0-45 DTE)"] + 0.2;
  near(e.gauges.find((g: any) => g.name === "VIX Level")!.weight, r.est.weights["VIX Level"] / tot, 1e-12);
  assert.ok(e.effectiveGauges != null);
});

test("breadth internals: Schwab $ADVN/$DECN/$UVOL/$DVOL validated; a tradeable look-alike or failure is unavailable", async () => {
  const { breadthInternalsFromQuotes } = await import("../../server/breadthMath");
  const q = (symbol: string, last: number | null, extra: Record<string, unknown> = {}) => ({ symbol, last, bid: null, ask: null, stale: false, quoteTimeMs: 1000, ...extra });
  const ok = breadthInternalsFromQuotes([q("$ADVN", 1800), q("$DECN", 1200), q("$UVOL", 6e8), q("$DVOL", 2e8)]);
  assert.equal(ok.state, "ok");
  assert.equal(ok.advanceShare, 0.6);    // 1800 / 3000
  assert.equal(ok.upVolumeShare, 0.75);  // 6e8 / 8e8
  // $DVOL resolving to a tradeable instrument (bid/ask) is refused; counts still used -> partial
  const p = breadthInternalsFromQuotes([q("$ADVN", 1800), q("$DECN", 1200), q("$UVOL", 6e8), q("$DVOL", 30, { bid: 17.75, ask: 53.23 })]);
  assert.equal(p.state, "partial");
  assert.equal(p.upVolumeShare, null);
  assert.match(p.reason ?? "", /tradeable instrument/);
  // implausible counts (not the NYSE index), no response, failure -> unavailable, never 0%
  assert.equal(breadthInternalsFromQuotes([q("$ADVN", 12), q("$DECN", 30)]).state, "unavailable");
  const none = breadthInternalsFromQuotes(null, "401");
  assert.equal(none.state, "unavailable");
  assert.equal(none.advanceShare, null);
  assert.match(none.reason ?? "", /401/);
  // an observed 0 decliners on a valid count is kept (0 is data, not missing)
  assert.equal(breadthInternalsFromQuotes([q("$ADVN", 2900), q("$DECN", 0)]).advanceShare, 1);
  // stale quotes are labelled stale
  assert.equal(breadthInternalsFromQuotes([q("$ADVN", 1500, { stale: true }), q("$DECN", 1500)]).state, "stale");
});
