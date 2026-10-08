// WS2 options math: gamma flip, dollar gamma, implied distribution,
// straddle expected move, implied scenario odds.
//
// Every expected value below is either hand-computed (shown in the comment)
// or a closed form derived from Black-Scholes; the reference is named next to
// each assertion.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGammaProfile,
  cumulativeStrikeFlip,
  repricedFlipFromChain,
  repricedFlipFromRows,
  rowsFromChain,
  type OptionRow,
} from "../../server/gammaProfile";

// ─── helpers ─────────────────────────────────────────────────────────────────

const normPdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Black-Scholes gamma, r = q = 0 (Hull, OFOD, gamma = phi(d1) / (S sigma sqrt T)). */
function bsGamma0(S: number, K: number, sigma: number, T: number): number {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * v * v) / v;
  return normPdf(d1) / (S * v);
}

/**
 * Closed-form flip for one call (K1, weight w1) and one put (K2, weight w2)
 * with the same sigma and T, r = q = 0. Net dealer gamma is
 * w1*Gamma(K1) - w2*Gamma(K2); both gammas share the factor 1/(S v), so the
 * root solves w1*phi(d_a) = w2*phi(d_b), i.e. d_b^2 - d_a^2 = 2 ln(w2/w1),
 * which is linear in x = ln S:
 *   S* = sqrt(K1 K2) * exp(-v^2/2 + v^2 ln(w2/w1) / ln(K1/K2)).
 */
function closedFormFlip(K1: number, w1: number, K2: number, w2: number, sigma: number, T: number): number {
  const v2 = sigma * sigma * T;
  return Math.sqrt(K1 * K2) * Math.exp(-v2 / 2 + (v2 * Math.log(w2 / w1)) / Math.log(K1 / K2));
}

// ─── F2.1 gamma flip ────────────────────────────────────────────────────────

test("dollar gamma: $ per 1% move per contract, multiplier 100 (hand-computed)", () => {
  // S = K = 100, sigma = 20%, T = 1y, r = q = 0:
  //   d1 = 0.5 * 0.2 = 0.1, phi(0.1) = 0.3969525
  //   gamma = 0.3969525 / (100 * 0.2) = 0.019847627 per share per $1 of spot
  //   $ GEX per 1% move per contract = gamma * 100 * S^2 * 0.01
  //                                  = 0.019847627 * 100 * 10000 * 0.01 = 198.476
  //   10 contracts -> $1,984.76 per 1% move.
  const rows: OptionRow[] = [{ type: "C", strike: 100, iv: 0.2, oi: 10, dte: 365, T: 1 }];
  const p = buildGammaProfile(rows, 100, { r: 0, q: 0 });
  assert.ok(Math.abs(p.currentGex - 1984.76) < 0.01, `got ${p.currentGex}`);
  // A put of the same strike contributes the same magnitude with dealer sign -1
  // (naive model: dealers short put gamma).
  const pp = buildGammaProfile([{ ...rows[0], type: "P" }], 100, { r: 0, q: 0 });
  assert.ok(Math.abs(pp.currentGex + 1984.76) < 0.01, `got ${pp.currentGex}`);
});

test("put gamma form equals call gamma form for any r, q (Hull: identical gamma)", () => {
  const S = 6600, K = 6550, sigma = 0.18, T = 10 / 262;
  const call = buildGammaProfile([{ type: "C", strike: K, iv: sigma, oi: 1, dte: 14, T }], S, { r: 0.05, q: 0.013 });
  const put = buildGammaProfile([{ type: "P", strike: K, iv: sigma, oi: 1, dte: 14, T }], S, { r: 0.05, q: 0.013 });
  assert.ok(Math.abs(call.currentGex + put.currentGex) < 1e-9 * Math.abs(call.currentGex));
});

test("re-priced flip matches the closed-form root (equal weights)", () => {
  // Reference: closedFormFlip above; with w1 = w2 it is sqrt(K1 K2) e^{-v^2/2}.
  const sigma = 0.15, T = 1 / 252;
  const rows: OptionRow[] = [
    { type: "C", strike: 6650, iv: sigma, oi: 5000, dte: 0, T },
    { type: "P", strike: 6550, iv: sigma, oi: 5000, dte: 0, T },
  ];
  const want = closedFormFlip(6650, 5000, 6550, 5000, sigma, T); // 6599.81
  const p = buildGammaProfile(rows, 6600, { r: 0, q: 0 });
  assert.equal(p.zeroCrossings.length, 1);
  assert.ok(Math.abs((p.zeroGammaSpot as number) - want) < 1e-3, `${p.zeroGammaSpot} vs ${want}`);
});

test("put-heavy 0DTE chain: re-priced flip exists, cumulative-by-strike finds none", () => {
  // Review finding 2.1: the cumulative method can report "no flip" where the
  // re-priced profile has one. Spot 6600; 20k puts at 6580, 10k calls at 6640.
  // Closed form: S* = 6654.86.
  const sigma = 0.15, T = 1 / 252, S = 6600;
  const rows: OptionRow[] = [
    { type: "C", strike: 6640, iv: sigma, oi: 10_000, dte: 0, T },
    { type: "P", strike: 6580, iv: sigma, oi: 20_000, dte: 0, T },
  ];
  // Per-strike GEX at today's spot ($ per 1%): calls +, puts -.
  const dollar = (K: number, oi: number) => bsGamma0(S, K, sigma, T) * oi * 100 * S * S * 0.01;
  const perStrike = [
    { strike: 6580, netGex: -dollar(6580, 20_000) },
    { strike: 6640, netGex: +dollar(6640, 10_000) },
  ];
  assert.ok(perStrike[0].netGex + perStrike[1].netGex < 0, "net GEX at spot is negative");
  assert.equal(cumulativeStrikeFlip(perStrike), null, "cumulative never changes sign");

  const want = closedFormFlip(6640, 10_000, 6580, 20_000, sigma, T);
  const flip = repricedFlipFromRows(rows, S, { r: 0, q: 0 });
  assert.ok(want > 6600, `closed form ${want}: flip above spot, regime turns long gamma there`);
  assert.ok(Math.abs((flip.zeroGamma as number) - want) < 1e-3, `${flip.zeroGamma} vs ${want}`);
  assert.ok((flip.gexAtSpot as number) < 0, "short gamma at spot");
  assert.equal(flip.method, "repriced-profile");
});

test("15 minutes to expiry: underflowed zeros are not reported as crossings", () => {
  // Far from every strike 0DTE gamma underflows to exactly 0; the old scan
  // pushed each exact zero as a crossing. Reference: closed-form root.
  const sigma = 0.15, T = 15 / (365 * 24 * 60);
  const rows: OptionRow[] = [
    { type: "C", strike: 6610, iv: sigma, oi: 1000, dte: 0, T },
    { type: "P", strike: 6590, iv: sigma, oi: 1000, dte: 0, T },
  ];
  const p = buildGammaProfile(rows, 6600, { r: 0, q: 0, nLevels: 121 });
  assert.ok(p.curve.some((c) => c.gex === 0), "grid has underflowed points");
  assert.equal(p.zeroCrossings.length, 1);
  const want = closedFormFlip(6610, 1000, 6590, 1000, sigma, T);
  assert.ok(Math.abs((p.zeroGammaSpot as number) - want) < 1e-3, `${p.zeroGammaSpot} vs ${want}`);
});

test("no usable contracts -> flip and GEX are missing (null), not zero", () => {
  const f = repricedFlipFromRows([], 6600);
  assert.equal(f.zeroGamma, null);
  assert.equal(f.gexAtSpot, null);
  assert.equal(f.rowsUsed, 0);
});

test("rowsFromChain: Schwab shape, percent IV, -999 sentinel dropped, T override", () => {
  const chain = {
    callExpDateMap: {
      "2026-10-08:0": {
        "6650.0": [{ volatility: 15, openInterest: 5000 }],
        "6700.0": [{ volatility: -999, openInterest: 100 }],
      },
      "2026-10-30:22": { "6800.0": [{ volatility: 14, openInterest: 50 }] },
    },
    putExpDateMap: { "2026-10-08:0": { "6550.0": [{ volatility: 15, openInterest: 5000 }] } },
  };
  const rows = rowsFromChain(chain, { expiryKeys: ["2026-10-08:0"], tYears: () => 1 / 252 });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.iv === 0.15 && r.T === 1 / 252));
  const flip = repricedFlipFromChain(chain, 6600, { expiryKeys: ["2026-10-08:0"], tYears: () => 1 / 252, r: 0, q: 0 });
  const want = closedFormFlip(6650, 5000, 6550, 5000, 0.15, 1 / 252);
  assert.ok(Math.abs((flip.zeroGamma as number) - want) < 1e-3);
});

// ─── F2.3 implied distribution (SVI-smoothed Breeden-Litzenberger) ──────────

import {
  black76,
  computeRND,
  computeRNDRaw,
  fitImpliedDistribution,
  probAbove,
  sviProbAbove,
  sviW,
  type SviParams,
} from "../../server/breedenLitzenberger";

/** Deterministic PRNG (mulberry32) for seeded quote noise. */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** High-accuracy standard normal CDF (erfc, W. J. Cody rational approximations via series). */
function Phi(x: number): number {
  // Use the complementary error function by continued fraction for |x| large,
  // series otherwise; accurate to ~1e-12, independent of the module under test.
  const z = Math.abs(x) / Math.SQRT2;
  let erfc: number;
  if (z < 3) {
    let sum = z, term = z;
    for (let n = 1; n < 200; n++) { term *= -z * z / n; sum += term / (2 * n + 1); }
    erfc = 1 - (2 / Math.sqrt(Math.PI)) * sum;
  } else {
    let f = 0;
    for (let n = 60; n >= 1; n--) f = (n / 2) / (z + f);
    erfc = Math.exp(-z * z) / Math.sqrt(Math.PI) / (z + f);
  }
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

const SPX_GRID: number[] = [];
for (let K = 6300; K <= 6900; K += 5) SPX_GRID.push(K);

test("BL on noisy flat-vol 0DTE calls: smoothed P(up>1%) ~ true, raw is far off", () => {
  // Review 2.4 setup: SPX 6600, 5-pt strikes, call mids with +/-$0.25 uniform
  // noise. True (lognormal, sigma 15%, T = 1/252, r = q = 0):
  //   P(S_T > 1.01 S) = N(d2), d2 = (ln(1/1.01) - v^2/2)/v, v = 0.15/sqrt(252)
  //   = N(-1.0577) = 0.14508.
  const S = 6600, v = 0.15 / Math.sqrt(252), w = v * v;
  const truth = Phi((Math.log(1 / 1.01) - w / 2) / v);
  assert.ok(Math.abs(truth - 0.14508) < 1e-4);
  let worst = 0, rawWorst = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const rnd = mulberry32(seed);
    const chain = SPX_GRID.map((K) => ({ strike: K, callMid: Math.max(0, black76(S, K, w, "C") + (rnd() - 0.5) * 0.5) }));
    const out = computeRND(chain, S, 0, 1 / 252, 50);
    assert.equal(out.method, "svi-smoothed");
    worst = Math.max(worst, Math.abs((out.probs as any).pUpOnePct - truth));
    const raw = computeRNDRaw(chain, S, 0, 1 / 252, 50);
    rawWorst = Math.max(rawWorst, Math.abs((raw.probs as any).pUpOnePct - truth));
  }
  assert.ok(worst < 0.01, `smoothed worst error ${worst}`);
  assert.ok(rawWorst > 0.05, `raw estimator should be noise-dominated, worst ${rawWorst}`);
});

test("BL density is non-negative, integrates to 1, and recovers a clean skewed smile exactly", () => {
  // Truth: SVI slice with equity-style skew (rho = -0.7); its exact digital is
  // P(S_T > K) = N(d_-) - phi(d_-) w'(k) / (2 sqrt w)  (Gatheral & Jacquier 2014).
  const S = 6600;
  const truth: SviParams = { a: 4e-5, b: 0.0043, rho: -0.7, m: 0.002, sigma: 0.01 };
  const quotes = SPX_GRID.map((K) => {
    const w = sviW(truth, Math.log(K / S));
    return { strike: K, callMid: black76(S, K, w, "C"), putMid: black76(S, K, w, "P") };
  });
  const d = fitImpliedDistribution(quotes, { spot: S, T: 1 / 252 });
  assert.ok(d);
  assert.equal(d.forwardSource, "put-call-parity");
  assert.ok(Math.abs(d.forward - S) < 1e-6);
  assert.ok(d.grid.density.every((x) => x >= 0));
  // Integral of f(K) dK over the grid (trapezoid in K) ~ 1.
  let mass = 0;
  for (let i = 1; i < d.grid.strike.length; i++) {
    mass += 0.5 * (d.grid.density[i] + d.grid.density[i - 1]) * (d.grid.strike[i] - d.grid.strike[i - 1]);
  }
  assert.ok(Math.abs(mass - 1) < 1e-3, `mass ${mass}`);
  for (const K of [6400, 6534, 6600, 6666, 6750]) {
    assert.ok(Math.abs(probAbove(d, K) - sviProbAbove(truth, S, K)) < 5e-4, `K=${K}`);
  }
});

test("BL on noisy skewed puts+calls: probabilities within 0.01 of truth", () => {
  const S = 6600;
  const truth: SviParams = { a: 4e-5, b: 0.0043, rho: -0.7, m: 0.002, sigma: 0.01 };
  let worst = 0;
  for (let seed = 11; seed <= 16; seed++) {
    const rnd = mulberry32(seed);
    const quotes = SPX_GRID.map((K) => {
      const w = sviW(truth, Math.log(K / S));
      return {
        strike: K,
        callMid: Math.max(0, black76(S, K, w, "C") + (rnd() - 0.5) * 0.5),
        putMid: Math.max(0, black76(S, K, w, "P") + (rnd() - 0.5) * 0.5),
      };
    });
    const d = fitImpliedDistribution(quotes, { spot: S, T: 1 / 252 });
    assert.ok(d);
    for (const K of [6400, 6534, 6600, 6666, 6750]) {
      worst = Math.max(worst, Math.abs(probAbove(d, K) - sviProbAbove(truth, S, K)));
    }
  }
  assert.ok(worst < 0.01, `worst ${worst}`);
});

// ─── F3.3 straddle expected move ────────────────────────────────────────────

import {
  quotesFromSchwabExpiry,
  scenarioOddsFromCdf,
  straddleExpectedMove,
  toPercentTriple,
  pickExpiryKey,
} from "../../server/impliedScenario";

test("straddle EM: hand-computed ATM case and Brenner-Subrahmanyam 0.8 rule", () => {
  // F = K = 6600, v = sigma sqrt(T) = 0.01:
  //   straddle = 2 F (2 N(v/2) - 1) = 2*6600*(2*N(0.005) - 1) = 52.6600 points
  //   Brenner-Subrahmanyam: ~ 0.7979 * F * v = 52.660 (agrees to 1e-4 here)
  //   1-sigma move = F * v = 66.00 points.
  const F = 6600, v = 0.01;
  const c = black76(F, 6600, v * v, "C"), p = black76(F, 6600, v * v, "P");
  assert.ok(Math.abs(c + p - 52.66) < 0.005, `straddle ${c + p}`);
  const em = straddleExpectedMove([{ strike: 6600, callMid: c, putMid: p }], 6600);
  assert.ok(em);
  assert.ok(Math.abs(em.oneSigmaMove - 66.0) < 1e-6, `${em.oneSigmaMove}`);
  assert.ok(Math.abs(em.approxOneSigma - 66.0) < 0.01, `${em.approxOneSigma}`);
});

test("straddle EM off-ATM: parity forward and bracketing interpolation recover F and v", () => {
  // Forward 6602.5 between the 6600 and 6605 strikes, v = 0.0095 at both.
  const F = 6602.5, v = 0.0095;
  const quotes = [6590, 6595, 6600, 6605, 6610].map((K) => ({
    strike: K, callMid: black76(F, K, v * v, "C"), putMid: black76(F, K, v * v, "P"),
  }));
  const em = straddleExpectedMove(quotes, 6601);
  assert.ok(em);
  assert.ok(Math.abs(em.forward - F) < 1e-9);
  assert.ok(Math.abs(em.totalVol - v) < 1e-9);
  assert.ok(Math.abs(em.oneSigmaMove - F * v) < 1e-6); // 62.72 points
});

test("straddle EM: no two-sided ATM quotes -> null (caller falls back, labeled)", () => {
  assert.equal(straddleExpectedMove([{ strike: 6600, callMid: 10, putMid: null }], 6600), null);
});

// ─── F3.2 scenario odds from the implied distribution ───────────────────────

test("scenario odds: lognormal known answer, sums to 1, falls with distance", () => {
  // Lognormal Q-distribution, F = 6600, v = 0.01:
  //   P(S_T <= K) = N((ln(K/F) + v^2/2)/v).
  // Targets bull 6680 / base 6600 / bear 6520 -> boundaries U = 6640, L = 6560.
  //   bull = 1 - N((ln(6640/6600) + 5e-5)/0.01) = 1 - N(0.6092) = 0.2712
  //   bear = N((ln(6560/6600) + 5e-5)/0.01) = N(-0.6029) = 0.2733
  //   base = 0.4555
  const F = 6600, v = 0.01;
  const cdf = (K: number) => Phi((Math.log(K / F) + (v * v) / 2) / v);
  const o = scenarioOddsFromCdf(cdf, 6600, { bull: 6680, base: 6600, bear: 6520 });
  assert.ok(o);
  assert.equal(o.upper, 6640);
  assert.equal(o.lower, 6560);
  assert.ok(Math.abs(o.bull - 0.2712) < 5e-4, `bull ${o.bull}`);
  assert.ok(Math.abs(o.bear - 0.2733) < 5e-4, `bear ${o.bear}`);
  assert.ok(Math.abs(o.bull + o.base + o.bear - 1) < 1e-12);
  // Reflection principle: touch ~ 2 x close-beyond.
  assert.ok(Math.abs(o.pTouchBull - 2 * o.pCloseBeyondBull) < 1e-12);
  // A target twice as far away gets lower odds (hand-set splits did not).
  const far = scenarioOddsFromCdf(cdf, 6600, { bull: 6800, base: 6600, bear: 6520 });
  assert.ok(far && far.bull < o.bull);
  assert.deepEqual(toPercentTriple(o), { bull: 27, base: 46, bear: 27 });
});

test("toPercentTriple always sums to 100", () => {
  for (const t of [{ bull: 1 / 3, base: 1 / 3, bear: 1 / 3 }, { bull: 0.005, base: 0.99, bear: 0.005 }, { bull: 0.2712, base: 0.4555, bear: 0.2733 }]) {
    const p = toPercentTriple(t);
    assert.equal(p.bull + p.base + p.bear, 100);
  }
});

test("Schwab expiry adapter: mids, PM-settled preference, expiry pick", () => {
  const calls = { "2026-10-16:8": { "6600.0": [
    { settlementType: "A", bid: 50, ask: 52 },
    { settlementType: "P", bid: 40, ask: 41 },
  ] } };
  const puts = { "2026-10-16:8": { "6600.0": [{ settlementType: "P", bid: 39, ask: 40 }], "6550.0": [{ bid: 0, ask: 0 }] } };
  const q = quotesFromSchwabExpiry(calls, puts, "2026-10-16:8");
  assert.deepEqual(q, [{ strike: 6600, callMid: 40.5, putMid: 39.5 }]);
  assert.equal(pickExpiryKey(["2026-10-09:1", "2026-10-16:8", "2026-10-15:7"], "2026-10-16"), "2026-10-16:8");
  assert.equal(pickExpiryKey(["2026-10-15:7", "2026-10-17:9"], "2026-10-16"), "2026-10-17:9");
});

test("horizon target expiries (ET calendar)", async () => {
  const { horizonTargetIso, etNowParts } = await import("../../server/impliedScenario");
  // 2026-10-08 18:00Z = Thu 14:00 EDT. Oct 2026 starts on a Thursday, so the
  // third Friday is Oct 16; Jan 2027 starts on a Friday -> third Friday Jan 15.
  const now = new Date("2026-10-08T18:00:00Z");
  assert.deepEqual(etNowParts(now), { iso: "2026-10-08", dow: 4, minutes: 840 });
  assert.equal(horizonTargetIso("daily", now), "2026-10-08");
  assert.equal(horizonTargetIso("weekly", now), "2026-10-09");
  assert.equal(horizonTargetIso("monthly", now), "2026-10-16");
  assert.equal(horizonTargetIso("quarterly", now), "2027-01-15");
  // Saturday -> next week's Friday; OPEX day rolls monthly to next month (Nov 20).
  assert.equal(horizonTargetIso("weekly", new Date("2026-10-10T16:00:00Z")), "2026-10-16");
  assert.equal(horizonTargetIso("monthly", new Date("2026-10-16T16:00:00Z")), "2026-11-20");
});

test("25-delta IV interpolated in delta space; no bracket -> null", async () => {
  const { ivAtAbsDelta } = await import("@shared/vol");
  // Puts at |delta| 0.18 (iv 0.24) and 0.31 (iv 0.20): 25D lies 7/13 of the way
  //   iv = 0.24 + (0.25 - 0.18)/(0.31 - 0.18) * (0.20 - 0.24) = 0.218462
  const rows = [
    { delta: -0.10, iv: 0.27 }, { delta: -0.18, iv: 0.24 },
    { delta: -0.31, iv: 0.20 }, { delta: -0.45, iv: 0.17 }, { delta: -999, iv: 0.5 },
  ];
  const iv = ivAtAbsDelta(rows, 0.25) as number;
  assert.ok(Math.abs(iv - 0.2184615) < 1e-6, `${iv}`);
  // The old nearest-contract pick returned 0.20 (the 31D put) here.
  assert.equal(ivAtAbsDelta([{ delta: 0.4, iv: 0.2 }, { delta: 0.45, iv: 0.19 }], 0.25), null);
});

// ─── review fixes (WS1 review of qf-ws2) ────────────────────────────────────

test("dollarGexPerPct: $ per 1% move, x100 contract multiplier (hand-computed)", async () => {
  const { dollarGexPerPct } = await import("../../server/gammaProfile");
  // gamma 0.002 per share, 1,000 contracts, SPX 6,600:
  //   0.002 x 1,000 x 100 x 6,600^2 x 0.01 = 0.002 x 1,000 x 100 x 43,560,000 x 0.01
  //   = $87,120,000 per 1% move. The pre-fix routes formula (no x100) gave $871,200.
  assert.equal(dollarGexPerPct(0.002, 1000, 6600), 87_120_000);
  assert.equal(dollarGexPerPct(0.002, 1000, 6600) / 100, 871_200);
});

test("rows with a supplied T <= 0 are settled and dropped; tYears sees the contract", async () => {
  const { buildGammaProfile, rowsFromChain } = await import("../../server/gammaProfile");
  const live: OptionRow = { type: "C", strike: 100, iv: 0.2, oi: 10, dte: 365, T: 1 };
  const settled: OptionRow = { type: "P", strike: 100, iv: 0.2, oi: 10, dte: 0, T: 0 };
  const p = buildGammaProfile([live, settled], 100, { r: 0, q: 0 });
  assert.equal(p.rowsUsed, 1);
  assert.ok(Math.abs(p.currentGex - 1984.76) < 0.01); // only the live call (see dollar-gamma test)
  // AM-settled SPX (settlementType "A") vs PM-settled SPXW in one expiry key:
  const chain = {
    callExpDateMap: { "2026-10-16:0": { "6600.0": [
      { volatility: 15, openInterest: 100, settlementType: "A" },
      { volatility: 15, openInterest: 200, settlementType: "P" },
    ] } },
    putExpDateMap: {},
  };
  const seen: string[] = [];
  const rows = rowsFromChain(chain, {
    tYears: (_k, _d, c) => { seen.push(c.settlementType); return c.settlementType === "A" ? 0 : 1 / 252; },
  });
  assert.deepEqual(seen, ["A", "P"]);
  const prof = buildGammaProfile(rows, 6600, { r: 0, q: 0 });
  assert.equal(prof.rowsUsed, 1); // the AM contract (T = 0 after the open) carries no gamma
});

test("audit scenarioProb = Q-probability of exactly the graded events (calibration.ts)", async () => {
  const { gradedScenarioOdds } = await import("../../server/impliedScenario");
  // Lognormal, F = 6600, v = 0.01; calibration grades bull = close >= T_up,
  // bear = close <= T_dn, base = neither. T_up 6650, T_dn 6540:
  //   bull = 1 - N((ln(6650/6600) + 5e-5)/0.01) = 1 - N(0.75972) = 0.22371
  //   bear = N((ln(6540/6600) + 5e-5)/0.01)     = N(-0.90825)   = 0.18188
  const cdf = (K: number) => Phi((Math.log(K / 6600) + 0.00005) / 0.01);
  const g = gradedScenarioOdds(cdf, { bull: 6650, bear: 6540 });
  assert.ok(g);
  assert.ok(Math.abs(g.bull - 0.22371) < 5e-5, `${g.bull}`);
  assert.ok(Math.abs(g.bear - 0.18188) < 5e-5, `${g.bear}`);
  assert.ok(Math.abs(g.bull + g.base + g.bear - 1) < 1e-12);
  assert.equal(gradedScenarioOdds(cdf, { bull: 6500, bear: 6540 }), null); // inverted targets
});
