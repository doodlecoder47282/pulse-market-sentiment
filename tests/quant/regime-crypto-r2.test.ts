// Round-2 quant tests: Regime, macro, sentiment and crypto (Sectors 5 and 10).
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/regime-crypto-r2.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mulberry32, neweyWestLRV, neweyWestLag, politisWhiteBlockLength, stationaryBootstrapIndices,
  horizonZSeries, terminalRun, regimeZTest, ledoitWolf, standardizedComposite, toCorrelation,
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
