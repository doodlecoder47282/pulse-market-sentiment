// Round-2 quant tests: Regime, macro, sentiment and crypto (Sectors 5 and 10).
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/regime-crypto-r2.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mulberry32, neweyWestLRV, neweyWestLag, politisWhiteBlockLength, stationaryBootstrapIndices,
  horizonZSeries, terminalRun, regimeZTest, ledoitWolf, ledoitWolfConstantCorrelation, standardizedComposite, toCorrelation,
} from "../../server/macroStats";

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
