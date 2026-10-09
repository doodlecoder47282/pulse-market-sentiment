// tests/quant/options-r2.test.ts
//
// Round-2 options math and volatility (workstream R2-B). Each test names its
// reference next to the expected value. Deterministic: seeded RNG only.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGammaProfile, dealerConventionSensitivity, flipInputs, GEX_NOISE_REL, type OptionRow,
} from "../../server/gammaProfile";
import { buildHeatseeker } from "../../server/heatseeker";

const near = (got: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);

/** Mulberry32: small seeded PRNG (deterministic tests). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Standard normal by Box-Muller from a seeded uniform source. */
function gauss(u: () => number): () => number {
  return () => {
    const a = Math.max(1e-300, u());
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u());
  };
}

// ─── Item 1: Heatseeker Net GEX and per-strike GEX on the re-priced basis ──

function chainFor0dte(expDate: string, rows: Array<{ K: number; side: "C" | "P"; oi: number; iv: number; vendorGamma: number }>) {
  const callExpDateMap: any = { [`${expDate}:0`]: {} };
  const putExpDateMap: any = { [`${expDate}:0`]: {} };
  for (const r of rows) {
    const map = r.side === "C" ? callExpDateMap : putExpDateMap;
    const sym = `SPXW  ${expDate.slice(2).replace(/-/g, "")}${r.side}0${r.K}000`;
    // no bid/ask: sigma = vendor IV (re-solve needs a two-sided quote)
    map[`${expDate}:0`][`${r.K.toFixed(1)}`] = [{ symbol: sym, gamma: r.vendorGamma, delta: r.side === "C" ? 0.5 : -0.5, volatility: r.iv * 100, openInterest: r.oi, totalVolume: 0 }];
  }
  return { underlying: { last: 6700 }, callExpDateMap, putExpDateMap };
}

test("heatseeker: Net GEX is the full-expiry re-priced sum, so its sign matches gexAtSpotRepriced even when vendor gamma disagrees", () => {
  // 2026-10-08 11:00 ET, PM-settled 0DTE: 5 h to the close.
  const nowMs = Date.UTC(2026, 9, 8, 15, 0);
  // Vendor gamma deliberately inflated on the puts (as an undocumented clock
  // would): the old vendor-gamma Net GEX read negative while the re-priced
  // regime sign was positive.
  const chain: any = chainFor0dte("2026-10-08", [
    { K: 6700, side: "C", oi: 30000, iv: 0.12, vendorGamma: 0.001 },
    { K: 6690, side: "P", oi: 20000, iv: 0.13, vendorGamma: 0.05 },
    { K: 6400, side: "P", oi: 50000, iv: 0.25, vendorGamma: 0.0001 }, // outside the +-5% window? no: 4.5% away, inside
    { K: 7100, side: "C", oi: 40000, iv: 0.10, vendorGamma: 0.0001 }, // 6.0% away: outside the 0DTE +-5% display window
  ]);
  const h = buildHeatseeker(chain, "$SPX", 6700, null, nowMs);
  assert.equal(h.totals.netGexScope, "full-expiry-repriced");
  // Same per-contract term as the flip, so equal up to summation order.
  near(h.totals.netGex, h.totals.gexAtSpotRepriced!, 1e-6 * Math.abs(h.totals.netGex), "Net GEX vs re-priced GEX at spot");
  assert.equal(Math.sign(h.totals.netGex), Math.sign(h.totals.gexAtSpotRepriced!));
  // The 7,100 strike is outside the display window: the window sum excludes it.
  assert.ok(!h.strikes.some((s) => s.strike === 7100));
  const windowSum = h.strikes.reduce((a, s) => a + s.netGex, 0);
  near(h.totals.netGexWindow!, windowSum, 1e-6, "window sum");
  // Old vendor-gamma reading would have been put-dominated (negative).
  const vendorNet = (0.001 * 30000 - 0.05 * 20000 - 0.0001 * 50000) * 100 * 6700 * 6700 * 0.01;
  assert.ok(vendorNet < 0 && h.totals.netGex > 0, "re-priced basis changes the sign the vendor basis gave");
  // Labels for the flip inputs and the dealer assumption are present.
  assert.equal(h.flipInputs?.weight, "open_interest");
  assert.equal(h.flipInputs?.universe, "single-expiry");
  assert.deepEqual(h.flipInputs?.expiries, ["2026-10-08"]);
  assert.ok(h.dealerSensitivity && h.dealerSensitivity.conventions.length === 3);
});

// ─── Item 3: far-wing zero crossings below numeric materiality are dropped ──

test("gammaProfile: two-lobe flip matches the closed form S* = sqrt(K1 K2) exp(-sigma^2 T / 2)", () => {
  // One call at K1 and one put at K2 with equal OI, sigma and T, r = q = 0:
  // net gamma is zero where phi(d1(K1)) = phi(d1(K2)), i.e. d1(K1) = -d1(K2)
  // => 2 ln S = ln K1 + ln K2 - sigma^2 T (Black-Scholes gamma, Hull OFOD ch. 19).
  const T = 20 / 365, sigma = 0.15;
  const rows: OptionRow[] = [
    { type: "C", strike: 6750, iv: sigma, oi: 1000, dte: 20, T },
    { type: "P", strike: 6650, iv: sigma, oi: 1000, dte: 20, T },
  ];
  const p = buildGammaProfile(rows, 6700, { r: 0, q: 0, nLevels: 121, lowPct: 0.9, highPct: 1.1 });
  const want = Math.sqrt(6750 * 6650) * Math.exp(-0.5 * sigma * sigma * T);
  near(p.zeroGammaSpot!, want, 1e-4, "two-lobe flip (bisection stops at 1e-9 relative)");
  assert.deepEqual(p.discardedCrossings, []);
});

test("gammaProfile: a 0DTE far-wing sign change below 1e-6 of peak |GEX| is discarded, real flips kept", () => {
  const T = 2 / (24 * 365); // 2 h to settlement
  const rows: OptionRow[] = [
    { type: "P", strike: 6600, iv: 0.16, oi: 20000, dte: 0, T },
    { type: "C", strike: 6750, iv: 0.12, oi: 15000, dte: 0, T },
    { type: "P", strike: 7000, iv: 0.12, oi: 300, dte: 0, T },
    { type: "C", strike: 7300, iv: 0.14, oi: 5000, dte: 0, T },
  ];
  const p = buildGammaProfile(rows, 6700, { lowPct: 0.93, highPct: 1.07, nLevels: 121, r: 0.05, q: 0.013 });
  const peak = Math.max(Math.abs(p.maxGex), Math.abs(p.minGex));
  near(p.noiseFloor, GEX_NOISE_REL * peak, 1e-9 * peak, "floor = 1e-6 x peak");
  // Above ~7,100 only the 7,300 call's tail is left: every grid point there
  // is below a millionth of the peak, so its sign change near 7,135 is
  // floating-point territory, not hedging. Without the floor it was reported.
  assert.equal(p.discardedCrossings.length, 1);
  assert.ok(p.discardedCrossings[0] > 7100 && p.discardedCrossings[0] < 7170, `discarded ${p.discardedCrossings[0]}`);
  assert.ok(p.zeroCrossings.every((z) => z < 7000), `kept ${p.zeroCrossings}`);
  // The flip nearest spot (between the 6,600 put and 6,750 call lobes) is kept.
  assert.ok(p.zeroGammaSpot! > 6600 && p.zeroGammaSpot! < 6750);
});

// ─── Item 6: dealer-convention sensitivity ──────────────────────────────────

test("dealer sensitivity: all-short GEX = -(call GEX + put GEX); calls-flat = -put GEX; robustness flag", () => {
  const T = 10 / 365;
  const rows: OptionRow[] = [
    { type: "C", strike: 6700, iv: 0.14, oi: 3000, dte: 10, T },
    { type: "P", strike: 6500, iv: 0.18, oi: 1000, dte: 10, T },
  ];
  const s = dealerConventionSensitivity(rows, 6700, { r: 0, q: 0 });
  const byId = Object.fromEntries(s.conventions.map((c) => [c.id, c]));
  const callOnly = buildGammaProfile([rows[0]], 6700, { r: 0, q: 0 }).currentGex;          // +call GEX
  const putOnly = -buildGammaProfile([rows[1]], 6700, { r: 0, q: 0 }).currentGex;          // put GEX magnitude
  near(byId["naive"].gexAtSpot!, callOnly - putOnly, 1e-6 * callOnly, "naive");
  near(byId["dealer-short-all"].gexAtSpot!, -(callOnly + putOnly), 1e-6 * callOnly, "all short");
  near(byId["calls-flat"].gexAtSpot!, -putOnly, 1e-6 * callOnly, "calls flat");
  // Call-heavy at spot: naive says long gamma, the others say short gamma.
  assert.ok(byId["naive"].gexAtSpot! > 0);
  assert.equal(s.regimeSignRobust, false);
  assert.match(s.note, /DEPENDS/);
  // Under all-short every term is negative: no flip can exist.
  assert.equal(byId["dealer-short-all"].zeroGamma, null);
});

test("flipInputs: weight, universe and DTE range label", () => {
  const f = flipInputs({ weight: "oi_plus_quarter_volume", universe: "all-expiries-in-request", expiryKeys: ["2026-10-09:1", "2026-10-08:0", "2026-11-20:43"] });
  assert.deepEqual(f.expiries, ["2026-10-08", "2026-10-09", "2026-11-20"]);
  assert.deepEqual(f.dteRange, [0, 43]);
  assert.match(f.label, /OI \+ 0\.25 x volume, 3 expiries, 0-43 DTE/);
});

// ─── Items 7 and 8: Chain Audit conventions and settlement probability ─────

import { buildChainAudit } from "../../server/chainAudit";
import { black76 } from "../../server/breedenLitzenberger";
import { normCdf } from "../../server/greeks";
import { yearsToExpiry } from "../../server/timeToExpiry";

/** Schwab-shaped chain priced exactly by Black-76 (flat vol, r = 0), tight two-sided quotes. */
function flatVolChain(expDate: string, dteTag: number, F: number, sigma: number, T: number, strikes: number[], oi = 1000) {
  const key = `${expDate}:${dteTag}`;
  const callExpDateMap: any = { [key]: {} }, putExpDateMap: any = { [key]: {} };
  const ymd = expDate.slice(2).replace(/-/g, "");
  for (const K of strikes) {
    const w = sigma * sigma * T;
    const c = black76(F, K, w, "C"), p = black76(F, K, w, "P");
    const ks = String(K * 1000).padStart(8, "0"); // OCC strike field
    callExpDateMap[key][K.toFixed(1)] = [{ symbol: `SPXW  ${ymd}C${ks}`, bid: Math.max(0, c - 0.05), ask: c + 0.05, volatility: sigma * 100, openInterest: oi, totalVolume: 0, delta: 0.5, gamma: 0.001 }];
    putExpDateMap[key][K.toFixed(1)] = [{ symbol: `SPXW  ${ymd}P${ks}`, bid: Math.max(0, p - 0.05), ask: p + 0.05, volatility: sigma * 100, openInterest: oi, totalVolume: 0, delta: -0.5, gamma: 0.001 }];
  }
  return { underlying: { last: F }, callExpDateMap, putExpDateMap };
}

test("chain audit: settlement probability per strike = lognormal N(d2(K-w/2)) - N(d2(K+w/2)) on a flat-vol chain", () => {
  // Black-76 with flat sigma: P(S_T > K) = N(d2), d2 = [ln(F/K) - w/2]/sqrt(w) (Hull, OFOD ch. 18).
  // Nearest expiry 9 calendar days out (vendor IV path; no 3-day re-solve); r enters
  // only the discount factor, so price with r = 0 and compare against D-adjusted F.
  const nowMs = Date.UTC(2026, 9, 7, 15, 0); // 2026-10-07 11:00 ET
  const T = yearsToExpiry("2026-10-16", nowMs, "PM");
  const sigma = 0.16, F = 6700;
  const strikes: number[] = [];
  for (let K = 6300; K <= 7100; K += 5) strikes.push(K);
  const chain: any = flatVolChain("2026-10-16", 9, F, sigma, T, strikes);
  const a = buildChainAudit(chain, F, nowMs);
  assert.equal(a.pinningMeta?.state, "ok", a.pinningMeta?.reason ?? "");
  assert.equal(a.pinning.length, 5);
  // The quotes are undiscounted Black-76 prices; the fit treats them as
  // discounted at r = FLIP_RATE and divides by D = e^(-rT), so its parity
  // forward is F/D and the implied lognormal is centred there.
  const D = Math.exp(-0.05 * T);
  const Ffit = F / D;
  const w = sigma * sigma * T;
  const P = (K: number) => normCdf((Math.log(Ffit / K) - w / 2) / Math.sqrt(w)); // P(S_T > K)
  for (const pin of a.pinning) {
    const want = (P(pin.strike - 2.5) - P(pin.strike + 2.5)) * 100;
    near(pin.prob, want, 0.02, `P(settle near ${pin.strike}) %`);
    assert.equal(pin.upper! - pin.lower!, 5);
  }
  // Most likely bin is at the mode of the lognormal: F exp(-1.5 w) ~ F (w tiny).
  assert.ok(Math.abs(a.pinning[0].strike - F) <= 5);
  // Probabilities, not shares: the top 5 bins of 5 points hold far less than 100%.
  const top5 = a.pinning.reduce((s, p) => s + p.prob, 0);
  assert.ok(top5 > 5 && top5 < 30, `top-5 mass ${top5}%`);
});

test("chain audit: settlement probability is 'unavailable' on a thin chain, never a made-up share", () => {
  const nowMs = Date.UTC(2026, 9, 7, 15, 0);
  const T = yearsToExpiry("2026-10-16", nowMs, "PM");
  const chain: any = flatVolChain("2026-10-16", 9, 6700, 0.16, T, [6650, 6700, 6750]);
  const a = buildChainAudit(chain, 6700, nowMs);
  assert.deepEqual(a.pinning, []);
  assert.equal(a.pinningMeta?.state, "unavailable");
  assert.ok(a.pinningMeta?.reason);
});

test("chain audit: charm reported separately for 0DTE (to settlement) and other expiries (one day); vanna conventions labeled", () => {
  // 2026-10-08 11:00 ET: the 10-08 SPXW expiry settles at 16:00 today (T < 1 day),
  // the 10-16 expiry is 8 days out.
  const nowMs = Date.UTC(2026, 9, 8, 15, 0);
  const mk = (exp: string, tag: number) => flatVolChain(exp, tag, 6700, 0.15, yearsToExpiry(exp, nowMs, "PM"), [6650, 6700, 6750], 1000);
  const c0 = mk("2026-10-08", 0), c8 = mk("2026-10-16", 8);
  const chain: any = {
    underlying: { last: 6700 },
    callExpDateMap: { ...c0.callExpDateMap, ...c8.callExpDateMap },
    putExpDateMap: { ...c0.putExpDateMap, ...c8.putExpDateMap },
  };
  const a = buildChainAudit(chain, 6700, nowMs);
  const only0 = buildChainAudit(c0 as any, 6700, nowMs);
  const only8 = buildChainAudit(c8 as any, 6700, nowMs);
  near(a.charm.totalCharmToSettlement!, only0.charm.totalCharmPerDay, 1e-6, "0DTE bucket = 0DTE-only total");
  near(a.charm.totalCharmOneDay!, only8.charm.totalCharmPerDay, 1e-6, "1-day bucket = 8DTE-only total");
  near(a.charm.totalCharmToSettlement! + a.charm.totalCharmOneDay!, a.charm.totalCharmPerDay, 1e-3, "buckets add up");
  assert.equal(only0.charm.totalCharmOneDay, 0);
  // Vanna: long-holder profile vs naive-dealer total. Equal call and put OI
  // at every strike: dealer (calls - puts) vanna is ~0 while the long-holder
  // sum is twice the call side.
  assert.equal(a.vanna.convention, "long-holder-aggregate");
  assert.ok(Math.abs(a.vanna.totalVannaDealerNaive!) < 0.05 * Math.abs(a.vanna.totalVannaDollarPerVolPct) + 1);
});

// ─── Items 9 and 12: cone drift and tails; robust tail z-score ──────────────

import { coneBandPrices, studentTSumQuantile } from "../../server/multiDayProjection";
import { flagTailEvent, MAD_NORMAL } from "../../server/stableTail";

test("cone tails: 1-day Student-t(4) quantile matches the closed form; n-day sums match seeded Monte Carlo", () => {
  // t_4 quantiles have a closed form (Hill 1970; e.g. Shaw 2006, "Sampling
  // Student's T distribution"): t = sign(p - 1/2) 2 sqrt(cos(acos(sqrt(a))/3)/sqrt(a) - 1), a = 4p(1-p).
  const t4 = (p: number) => {
    const a = 4 * p * (1 - p);
    const q = Math.cos(Math.acos(Math.sqrt(a)) / 3) / Math.sqrt(a);
    return Math.sign(p - 0.5) * 2 * Math.sqrt(q - 1);
  };
  near(t4(0.95), 2.131847, 1e-5, "t4(0.95) table value");
  const unit = Math.SQRT1_2; // unit-variance scaling sqrt((nu-2)/nu)
  for (const p of [0.01, 0.05, 0.10, 0.25, 0.75, 0.95, 0.99]) {
    near(studentTSumQuantile(p, 1), t4(p) * unit, 2e-3, `1-day q${p}`);
  }
  // 10-day sum: seeded Monte Carlo of sum of 10 unit-variance t4 / sqrt(10).
  const u = rng(20261008), z = gauss(u);
  const draw = () => {
    // T_4 = Z / sqrt(chi2_4 / 4), chi2_4 = sum of 4 squared normals
    const c = z() ** 2 + z() ** 2 + z() ** 2 + z() ** 2;
    return (z() / Math.sqrt(c / 4)) * unit;
  };
  const N = 200_000, xs = new Float64Array(N);
  for (let i = 0; i < N; i++) { let s = 0; for (let k = 0; k < 10; k++) s += draw(); xs[i] = s / Math.sqrt(10); }
  xs.sort();
  for (const p of [0.01, 0.05, 0.25]) {
    const mc = xs[Math.floor(p * N)];
    near(studentTSumQuantile(p, 10), mc, 0.03, `10-day q${p} vs MC`);
  }
  // Fat-tail content: wider than normal at 1% (2.326), narrower at 10% (1.2816) for 1 day.
  assert.ok(-studentTSumQuantile(0.01, 1) > 2.326 && -studentTSumQuantile(0.10, 1) < 1.2816);
});

test("cone: zero drift (q50 = spot) and symmetric log bands", () => {
  const b = coneBandPrices(6700, 0.01, 5);
  assert.equal(b.q50, 6700);
  near(Math.log(b.q99 / 6700), -Math.log(b.q01 / 6700), 1e-3, "symmetric 1/99 in log");
  assert.ok(b.q01 < b.q05 && b.q05 < b.q10 && b.q10 < b.q25 && b.q75 < b.q90 && b.q90 < b.q95 && b.q95 < b.q99);
});

test("stableTail: modified z-score uses Phi^-1(0.75) = 0.6745; percentile compares like with like; missing is NaN, not 0", () => {
  // Phi^-1(0.75) = 0.674490 (normal tables); E|Z| = sqrt(2/pi) = 0.797885 is a different constant.
  near(MAD_NORMAL, 0.67449, 1e-4, "MAD of N(0,1)");
  // Window -0.020, -0.019, ..., +0.020 (41 values): median 0; the |deviations|
  // are 0, 0.001 (x2), ..., 0.020 (x2), whose median (21st of 41) is 0.010.
  const w: number[] = [];
  for (let i = -20; i <= 20; i++) w.push(i / 1000);
  const f = flagTailEvent(0.06, w);
  assert.equal(f.dataState, "ok");
  near(f.median, 0, 1e-12, "median");
  near(f.mad, 0.01, 1e-12, "MAD");
  near(f.tailZ, 0.6745 * 0.06 / 0.01, 1e-9, "M = 0.6745 x / MAD = 4.047");
  assert.equal(f.isWarning, true); // 3.5 < 4.047 <= 5
  near(f.percentile, 1, 1e-12, "larger than every window deviation");
  const g = flagTailEvent(0.0, w);
  near(g.percentile, 0, 1e-12, "a zero deviation is the smallest");
  near(g.empiricalExceedance, 1, 1e-12, "every |dev| >= 0");
  const thin = flagTailEvent(0.01, w.slice(0, 10));
  assert.ok(Number.isNaN(thin.tailZ));
  assert.equal(thin.dataState, "insufficient");
  const flat = flagTailEvent(0.01, new Array(40).fill(0.001));
  assert.equal(flat.dataState, "degenerate");
  assert.ok(Number.isNaN(flat.tailZ));
});

// ─── Item 10: reflection-principle touch probability ───────────────────────

import { rateAdjustedTouchProb, reflectionTouchProb, scenarioOddsFromCdf, touchSigmaFromRate } from "../../server/impliedScenario";

test("touch probability: reflection formula vs seeded Brownian Monte Carlo (Broadie-Glasserman-Kou continuity correction)", () => {
  // P(max_{t<=1} W_t >= d) = 2(1 - N(d)) (Shreve II, 3.7.3). A path monitored
  // at m steps touches less often; Broadie, Glasserman & Kou (1997), "A
  // continuity correction for discrete barrier options", Math. Finance 7(4):
  // discrete ~ continuous with the barrier shifted out by 0.5826 sigma sqrt(dt).
  const u = rng(424242), z = gauss(u);
  const m = 500, paths = 40_000, dt = 1 / m, sq = Math.sqrt(dt);
  const ds = [0.5, 1.0, 2.0];
  const hits = ds.map(() => 0);
  for (let p = 0; p < paths; p++) {
    let w = 0, mx = 0;
    for (let i = 0; i < m; i++) { w += z() * sq; if (w > mx) mx = w; }
    ds.forEach((d, k) => { if (mx >= d) hits[k]++; });
  }
  ds.forEach((d, k) => {
    const mc = hits[k] / paths;
    const se = Math.sqrt(mc * (1 - mc) / paths);
    const corrected = reflectionTouchProb(d + 0.5826 * sq, 1);
    assert.ok(Math.abs(mc - corrected) < 4 * se + 1e-3, `d=${d}: MC ${mc} vs ${corrected} (se ${se})`);
    // and the continuous formula is the upper limit
    assert.ok(reflectionTouchProb(d, 1) >= mc - 4 * se);
  });
  near(reflectionTouchProb(1, 1), 2 * (1 - 0.841345), 1e-6, "2(1 - N(1)) = 0.31731");
});

test("target derivation touch odds: equal the walk-forward rate at the median distance, normal-tail fall-off beyond", () => {
  // 50% base rate at a 40 bps median distance: s = 40 / N^-1(0.75) = 40 / 0.67449 = 59.30 bps.
  near(touchSigmaFromRate(0.5, 40)!, 40 / 0.6744898, 1e-3, "fitted s");
  near(rateAdjustedTouchProb(0.5, 40, 40), 0.5, 1e-6, "rate reproduced at the median");
  // Three times further: 2(1 - N(3 x 0.67449)) = 0.04302 (the old 1/distance rule gave 0.1667).
  near(rateAdjustedTouchProb(0.5, 40, 120), 0.04302, 1e-4, "3x median distance");
  assert.ok(rateAdjustedTouchProb(0.5, 40, 20) > 0.5 && rateAdjustedTouchProb(0.5, 40, 20) < 1);
  assert.equal(rateAdjustedTouchProb(0, 40, 10), 0);
});

// ─── Item 13: touch odds of a target already crossed ───────────────────────

test("scenario odds: a bull target at or below spot has touch probability 1, not 2 x P(close above)", () => {
  // Normal CDF around 100 with sd 2 as the implied distribution.
  const cdf = (K: number) => 0.5 * (1 + erf((K - 100) / (2 * Math.SQRT2)));
  const o = scenarioOddsFromCdf(cdf, 100, { bull: 99.5, base: 98, bear: 95 })!;
  assert.equal(o.pTouchBull, 1);
  const o2 = scenarioOddsFromCdf(cdf, 100, { bull: 104, base: 100, bear: 96 })!;
  near(o2.pCloseBeyondBull, 1 - cdf(104), 1e-12, "P(close beyond)");
  near(o2.pTouchBull, 2 * (1 - cdf(104)), 1e-12, "reflection");
});

/** erf via A&S 7.1.26 (|error| < 1.5e-7). */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1; const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}

// ─── Item 11: HAR-RV forecast and spread z-score ───────────────────────────

import { fitHar, harForecastVariance, harVolForecast, spreadVerdict, spreadZScore, squaredLogReturns } from "../../server/harRv";

test("HAR-RV: OLS recovers known coefficients from a simulated HAR process (Corsi 2009 eq. 8)", () => {
  // RV_{t+1} = 0.1 + 0.4 RV_t + 0.3 RV^(w)_t + 0.2 RV^(m)_t + e, e ~ N(0, 0.05^2):
  // stationary mean 0.1 / (1 - 0.9) = 1.
  const u = rng(7), z = gauss(u);
  const rv: number[] = new Array(22).fill(1);
  for (let t = 21; t < 8000; t++) {
    const d = rv[t], w = rv.slice(t - 4, t + 1).reduce((a, b) => a + b, 0) / 5, m = rv.slice(t - 21, t + 1).reduce((a, b) => a + b, 0) / 22;
    rv.push(Math.max(1e-3, 0.1 + 0.4 * d + 0.3 * w + 0.2 * m + 0.05 * z()));
  }
  const fit = fitHar(rv.slice(500), 1)!;
  near(fit.coef[0], 0.1, 0.03, "c");
  near(fit.coef[1], 0.4, 0.03, "b_d");
  near(fit.coef[2], 0.3, 0.05, "b_w");
  near(fit.coef[3], 0.2, 0.05, "b_m");
  // Forecast = c + b . regressors at the last date (hand computation).
  const r = rv.slice(500); const t = r.length - 1;
  const w = r.slice(t - 4).reduce((a, b) => a + b, 0) / 5, m = r.slice(t - 21).reduce((a, b) => a + b, 0) / 22;
  near(harForecastVariance(r, fit)!, fit.coef[0] + fit.coef[1] * r[t] + fit.coef[2] * w + fit.coef[3] * m, 1e-12, "forecast");
});

test("HAR-RV vol forecast: constant-vol random walk forecasts its own vol; spread z-score and verdict", () => {
  // Daily log returns N(0, 0.01^2): annualized vol 0.01 x sqrt(252) = 15.87%.
  const u = rng(99), z = gauss(u);
  const closes = [100];
  for (let i = 0; i < 1500; i++) closes.push(closes[closes.length - 1] * Math.exp(0.01 * z()));
  assert.equal(squaredLogReturns(closes).length, 1500);
  const f = harVolForecast(closes, 21)!;
  near(f.annualVol, 0.01 * Math.sqrt(252), 0.015, "forecast ~ true vol");
  assert.equal(harVolForecast(closes.slice(0, 100), 21), null, "too few returns: no forecast");
  // z-score: past spreads 0.02 +- 0.01 (alternating), today 0.04 -> z = (0.04 - 0.02)/sd.
  const past = Array.from({ length: 80 }, (_, i) => (i % 2 ? 0.03 : 0.01));
  const sd = Math.sqrt(80 * 0.0001 / 79);
  const s = spreadZScore(0.04, past);
  near(s.z!, 0.02 / sd, 1e-9, "z");
  assert.equal(s.percentile, 1);
  assert.equal(spreadVerdict(s.z), "rich");
  assert.equal(spreadVerdict(spreadZScore(0.02, past).z), "fair");
  assert.equal(spreadVerdict(spreadZScore(0.0, past).z), "cheap");
  // Too little history: no verdict, never a default "fair".
  assert.equal(spreadZScore(0.04, past.slice(0, 30)).z, null);
  assert.equal(spreadVerdict(null), "insufficient");
});
