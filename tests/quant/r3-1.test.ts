// Round 3, workstream R3-1: volatility, data plumbing, greeks, ML presentation.
// Known-answer tests for every math change (closed forms or hand computation).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chainLadderSegments, tenorWindow, tenorWindowWide, chainStrikePlan, chainPayloadBoundBytes,
  mergeChainSegments, chainAsOf, Z_25_DELTA, MAX_CARRY_PER_YEAR, QUOTE_CLOCK_SKEW_MS, CHAIN_LADDER_DTE,
} from "../../server/schwabDataPolicy";
import {
  buildGammaProfile, dealerConventionSensitivity, breakevenMisattribution, gexRegime, gexByStrikeFromChain,
  bsGamma, dollarGexPerPct, FLIP_RATE, FLIP_DIV_YIELD, ROBUST_MISATTRIBUTION, type OptionRow,
} from "../../server/gammaProfile";
import { buildHeatseeker } from "../../server/heatseeker";
import { deltaRQ } from "../../server/greekExposure";
import { yearsToExpiry } from "../../server/timeToExpiry";
import { etWallToEpochMs } from "../../server/exchangeCalendar";
import {
  studentTSumQuantileFft, studentT4Quantile, atmIvTermFromChain, totalVarianceAt, coneBandsFromVariance,
} from "../../server/tickerConeMath";
import { studentTSumQuantile } from "../../server/multiDayProjection";
import { buildQuarterlyTrajectory } from "../../server/quarterlyTrajectory";
import { sqrtTimeExtension } from "../../shared/coneExtension";
import { baselineSigmaPerBar, VIX_INTRADAY_VARIANCE_RATIO, TRADING_DAYS, BARS_PER_DAY_5M } from "../../server/mlServedBand";

const near = (got: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} (tol ${tol})`);

// ─── N1-1: chain request windows ─────────────────────────────────────────────

test("N1-1 ladder: disjoint segments that compose every Models horizon and the 30-DTE headline", () => {
  assert.deepEqual(CHAIN_LADDER_DTE, [2, 7, 30, 45, 100]);
  assert.deepEqual(chainLadderSegments(2), [{ fromDte: 0, toDte: 2 }]);
  assert.deepEqual(chainLadderSegments(7), [{ fromDte: 0, toDte: 2 }, { fromDte: 3, toDte: 7 }]);
  assert.deepEqual(chainLadderSegments(30).map((s) => s.toDte), [2, 7, 30]);
  const q = chainLadderSegments(100);
  assert.deepEqual(q, [
    { fromDte: 0, toDte: 2 }, { fromDte: 3, toDte: 7 }, { fromDte: 8, toDte: 30 },
    { fromDte: 31, toDte: 45 }, { fromDte: 46, toDte: 100 },
  ]);
  // Disjoint and gap-free.
  for (let i = 1; i < q.length; i++) assert.equal(q[i].fromDte, q[i - 1].toDte + 1);
  // The weekly ladder is a prefix of the quarterly one: the same cached requests.
  assert.deepEqual(chainLadderSegments(45).slice(0, 2), chainLadderSegments(7));
  // Off-ladder: ends at the next bound; beyond the last bound, at dteMax.
  assert.equal(chainLadderSegments(20).at(-1)!.toDte, 30);
  assert.deepEqual(chainLadderSegments(120).at(-1), { fromDte: 101, toDte: 120 });
});

test("N1-1 single-tenor windows: +-max(2, ceil(5% t)) days, wide fallback 0.4t-1.6t", () => {
  assert.deepEqual(tenorWindow(7), { fromDte: 5, toDte: 9 });
  assert.deepEqual(tenorWindow(30), { fromDte: 28, toDte: 32 });
  assert.deepEqual(tenorWindow(60), { fromDte: 57, toDte: 63 });
  assert.deepEqual(tenorWindow(90), { fromDte: 85, toDte: 95 });
  assert.deepEqual(tenorWindowWide(90), { fromDte: 36, toDte: 144 });
});

test("N1-1 strike plans: 25-delta wing for skew, ATM-only for ATM IV", () => {
  // wing25 at 30 DTE, SPX 6,700, ATM 18%:
  //   z25 x 1.5 x 0.18 x sqrt(30/365) + 0.05 x 30/365 = 0.6744898 x 0.27 x 0.2866910 + 0.0041096 = 0.0563195
  const T = 30 / 365;
  const want = Z_25_DELTA * 1.5 * 0.18 * Math.sqrt(T) + MAX_CARRY_PER_YEAR * T;
  near(want, 0.0563195, 1e-6, "wing half-width");
  const p = chainStrikePlan({ symbol: "$SPX", spot: 6700, dteMax: 32, atmIv: 0.18, coverage: "wing25" });
  near(p.halfWidthPct, Z_25_DELTA * 1.5 * 0.18 * Math.sqrt(32 / 365) + MAX_CARRY_PER_YEAR * 32 / 365, 1e-12, "plan wing");
  // 32 DTE: 0.6744898 x 0.27 x sqrt(32/365) + 0.05 x 32/365 = 0.0583056 -> ceil(0.0583056 x 6700 / 5) = ceil(78.13)
  assert.equal(p.perSide, Math.ceil(p.halfWidthPct * 6700 / 5));
  assert.equal(p.perSide, 79);
  assert.equal(p.strikeCount, 160);                                       // 2 x 79 = 158 -> step 20
  // The 25-delta put at a 22% wing vol, 32 DTE: ln(K/F) = -0.6745 x 0.22 x sqrt(T) + 0.22^2 T / 2 = -0.04180
  const k25 = -Z_25_DELTA * 0.22 * Math.sqrt(32 / 365) + 0.5 * 0.22 * 0.22 * 32 / 365;
  assert.ok(p.halfWidthPct > Math.abs(Math.expm1(k25)), "window reaches the 25-delta put");
  // ATM-only request: 4 strikes per side -> the minimum step of 20.
  const a = chainStrikePlan({ symbol: "AAPL", spot: 250, dteMax: 120, atmIv: 0.3, coverage: "atm" });
  assert.equal(a.perSide, 4);
  assert.equal(a.strikeCount, 20);
  // Payload bound: expiries x strikeCount x 2 x 1.3 KB.
  assert.equal(chainPayloadBoundBytes(70, 300), 70 * 300 * 2 * 1300); // 54.6 MB (old skew / quarterly upper bound)
  assert.equal(chainPayloadBoundBytes(5, 160), 2_080_000);             // one skew tenor window
});

test("N1-1 / N1-2 merge: union of disjoint segments, oldest asOf, worst coverage, newest underlying", () => {
  const seg = (asOfMs: number, key: string, last: number, stale: boolean, below: number) => ({
    underlying: { last, quoteTimeMs: asOfMs },
    callExpDateMap: { [key]: { "100.0": [{ x: 1 }] } },
    putExpDateMap: { [key]: { "100.0": [{ x: 2 }] } },
    asOfMs, ageMs: 1000, servedFromCache: false, stale, maxAgeMs: 180_000, staleReason: stale ? "403" : null,
    strikeCount: 280, strikePlan: key,
    strikeCoverage: { targetHalfWidthPct: 0.1, belowPct: below, abovePct: 0.12, complete: below >= 0.1, expiries: 1, nearestBelow: 10, nearestAbove: 10 },
  });
  const m = mergeChainSegments([seg(2_000, "2026-10-09:0", 6701, false, 0.11), seg(1_000, "2026-10-14:5", 6700, true, 0.08)])!;
  assert.deepEqual(Object.keys(m.callExpDateMap).sort(), ["2026-10-09:0", "2026-10-14:5"]);
  assert.equal(m.asOfMs, 1_000);
  assert.equal(m.underlying.last, 6701); // newest segment's spot
  assert.equal(m.stale, true);
  assert.equal(m.staleReason, "403");
  assert.equal(m.strikeCoverage!.belowPct, 0.08);
  assert.equal(m.strikeCoverage!.complete, false);
  assert.equal(m.strikeCoverage!.expiries, 2);
  assert.equal(mergeChainSegments([]), null);
});

test("N1-2 chain asOf: Schwab underlying quoteTime, receive time only as fallback", () => {
  const rx = 1_760_000_000_000;
  // Quote 40 s before receipt (e.g. index between ticks): age counts from the quote.
  assert.deepEqual(chainAsOf(rx - 40_000, rx), { asOfMs: rx - 40_000, basis: "underlying_quote_time", reason: null });
  // After the close the quote is hours old and the chain says so.
  assert.equal(chainAsOf(rx - 3 * 3600_000, rx).asOfMs, rx - 3 * 3600_000);
  // Missing / non-positive quote time: receive time, labelled.
  assert.equal(chainAsOf(null, rx).basis, "receive_time");
  assert.equal(chainAsOf(0, rx).asOfMs, rx);
  // A quote time slightly ahead (clock skew within 5 s) is clamped to the receive time.
  assert.deepEqual(chainAsOf(rx + 2_000, rx), { asOfMs: rx, basis: "underlying_quote_time", reason: null });
  // Far ahead: not trusted.
  const f = chainAsOf(rx + QUOTE_CLOCK_SKEW_MS + 1, rx);
  assert.equal(f.basis, "receive_time");
  assert.equal(f.asOfMs, rx);
});

// ─── N2-1: two-sided dealer-convention sensitivity ───────────────────────────

test("N2-1 sensitivity is two-sided: f* = |C - P| / (2 max(C, P)) decides long AND short readings", () => {
  near(breakevenMisattribution(3, 1)!, 1 / 3, 1e-15, "f* long");
  near(breakevenMisattribution(1, 3)!, 1 / 3, 1e-15, "f* short (symmetric)");
  assert.equal(breakevenMisattribution(0, 0), null);
  assert.equal(breakevenMisattribution(2, 0), 0.5);
  const T = 10 / 365;
  // Near-balanced PUT-heavy book: naive says short gamma. Round 2 called every
  // short reading robust (all its alternatives pushed gamma down); now it needs
  // f* >= 25%.
  const shortRows: OptionRow[] = [
    { type: "C", strike: 6700, iv: 0.15, oi: 1000, dte: 10, T },
    { type: "P", strike: 6700, iv: 0.15, oi: 1150, dte: 10, T },
  ];
  const s = dealerConventionSensitivity(shortRows, 6700, { r: 0, q: 0 });
  const C = buildGammaProfile([shortRows[0]], 6700, { r: 0, q: 0 }).currentGex;
  const P = -buildGammaProfile([shortRows[1]], 6700, { r: 0, q: 0 }).currentGex;
  // Same strike, vol and T with r = q = 0: call and put gamma are equal, so P / C = 1150 / 1000.
  near(P / C, 1.15, 1e-9, "P/C");
  near(s.callGexAtSpot!, C, 1e-6 * C, "C");
  near(s.putGexAtSpot!, P, 1e-6 * C, "P");
  near(s.breakevenMisattribution!, (1.15 - 1) / (2 * 1.15), 1e-9, "f* = 0.0652");
  assert.equal(s.conventions.find((c) => c.id === "naive")!.gexSign, -1);
  assert.equal(s.regimeSignRobust, false);
  assert.match(s.note, /short-gamma reading flips if 7%/);
  // Long-gamma book with C = 3P at spot: f* = 1/3 >= 25%, robust (round 2: never robust).
  const longRows: OptionRow[] = [
    { type: "C", strike: 6700, iv: 0.15, oi: 3000, dte: 10, T },
    { type: "P", strike: 6700, iv: 0.15, oi: 1000, dte: 10, T },
  ];
  const l = dealerConventionSensitivity(longRows, 6700, { r: 0, q: 0 });
  near(l.breakevenMisattribution!, 1 / 3, 1e-9, "f* long");
  assert.equal(l.regimeSignRobust, true);
  assert.equal(l.robustAt, ROBUST_MISATTRIBUTION);
  // Both directions are present among the stress cases.
  const dirs = new Set(l.conventions.map((c) => c.direction));
  assert.ok(dirs.has("toward-short") && dirs.has("toward-long"));
  const byId = Object.fromEntries(l.conventions.map((c) => [c.id, c.gexAtSpot!]));
  near(byId["dealer-long-all"], -byId["dealer-short-all"], 1e-6 * Math.abs(byId["dealer-long-all"]), "long-all = -short-all");
});

test("N3-3 regime: missing, exact 0 and sub-floor GEX are unknown, never negative", () => {
  assert.equal(gexRegime(null, 1e9, 10), "unknown");
  assert.equal(gexRegime(0, 1e9, 10), "unknown");
  assert.equal(gexRegime(5e9, 5e9, 0), "unknown");          // no contracts
  assert.equal(gexRegime(-1e2, 1e9, 10), "unknown");        // 1e-7 of the peak < 1e-6 floor
  assert.equal(gexRegime(-2e3, 1e9, 10), "negative");       // 2e-6 of the peak
  assert.equal(gexRegime(3e8, 1e9, 10), "positive");
  assert.equal(gexRegime(NaN, 1e9, 10), "unknown");
});

// ─── N2-2: Signals walls on re-priced gamma ──────────────────────────────────

test("N2-2 walls use the flip's re-priced gamma: a vendor-gamma outlier no longer sets the call wall", () => {
  const nowMs = etWallToEpochMs("2026-10-07", 12 * 60);
  const exp = "2026-10-16:9";
  const chain = {
    underlying: { last: 6700 },
    callExpDateMap: {
      [exp]: {
        // Vendor gamma 0.0001 (stale/odd) but ATM-ish: BS gamma is large.
        "6750.0": [{ symbol: "SPXW  261016C06750000", gamma: 0.0001, openInterest: 1000, volatility: 15, bid: 40, ask: 41 }],
        // Far OTM: vendor gamma 0.01 (outlier), BS gamma tiny.
        "7300.0": [{ symbol: "SPXW  261016C07300000", gamma: 0.01, openInterest: 1000, volatility: 15, bid: 0.05, ask: 0.1 }],
        // No usable sigma (sentinel IV, no quote): dropped and counted, not zero gamma.
        "6800.0": [{ symbol: "SPXW  261016C06800000", gamma: -999, openInterest: 500, volatility: -999, bid: 0, ask: 0 }],
      },
      // 60 DTE: outside the 0-45 DTE Signals universe.
      "2026-12-06:60": { "6705.0": [{ symbol: "SPXW  261206C06705000", gamma: 0.001, openInterest: 90000, volatility: 15, bid: 200, ask: 201 }] },
    },
    putExpDateMap: {},
  };
  const g = gexByStrikeFromChain(chain as any, nowMs);
  // Old vendor basis: 7300 call GEX 0.01 x 1000 x 100 x S^2 x 0.01 vs 0.0001 x ... -> wall 7300.
  assert.equal(g.callWall, 6750);
  assert.equal(g.gammaBasis, "repriced-bs");
  assert.equal(g.contractsNoSigma, 1);
  assert.ok(!g.profile.some((p) => p.strike === 6705), "60 DTE excluded");
  assert.ok(!g.profile.some((p) => p.strike === 6800), "no-sigma contract is not a zero-gamma strike");
  const T = yearsToExpiry("2026-10-16", nowMs, "PM");
  near(g.profile.find((p) => p.strike === 6750)!.callGex,
    dollarGexPerPct(bsGamma(6700, 6750, 0.15, T, FLIP_RATE, FLIP_DIV_YIELD, "C"), 1000, 6700), 1e-3, "BS GEX");
});

// ─── N2-2: Heatseeker DEX missing is missing ─────────────────────────────────

test("N2-2 Heatseeker DEX: BS delta on our clock; vendor delta only without sigma; neither -> null, counted", () => {
  const nowMs = Date.UTC(2026, 9, 8, 15, 0); // 2026-10-08 11:00 ET
  const exp = "2026-10-16:8";
  const chain: any = {
    underlying: { last: 6700 },
    callExpDateMap: { [exp]: {
      "6700.0": [{ symbol: "SPXW  261016C06700000", delta: 0.9, volatility: 15, openInterest: 100, bid: 60, ask: 61 }],
      "6710.0": [{ symbol: "SPXW  261016C06710000", delta: 0.3, volatility: -999, openInterest: 50, bid: 0, ask: 0 }],
      "6720.0": [{ symbol: "SPXW  261016C06720000", volatility: -999, openInterest: 70, bid: 0, ask: 0 }],
      "6730.0": [{ symbol: "SPXW  261016C06730000", delta: -999, volatility: -999, openInterest: 70, bid: 0, ask: 0 }],
      "6740.0": [{ symbol: "SPXW  261016C06740000", delta: 0.4, volatility: 15, openInterest: 0, bid: 40, ask: 41 }],
    } },
    putExpDateMap: {},
  };
  const h = buildHeatseeker(chain, "$SPX", 6700, null, nowMs);
  const at = (k: number) => h.strikes.find((s) => s.strike === k)!;
  const T = yearsToExpiry("2026-10-16", nowMs, "PM");
  // Sigma present: BS delta (vendor 0.9 ignored), $ delta = delta x OI x 100 x S.
  const d = deltaRQ(6700, 6700, 0.15, T, FLIP_RATE, FLIP_DIV_YIELD, "C");
  near(at(6700).netDex!, d * 100 * 100 * 6700, 1e-6, "BS DEX");
  // No sigma, valid vendor delta: 0.3 x 50 x 100 x 6,700 = $10,050,000.
  near(at(6710).netDex!, 10_050_000, 1e-6, "vendor DEX");
  // No sigma and no delta / sentinel delta: missing.
  assert.equal(at(6720).netDex, null);
  assert.equal(at(6730).netDex, null);
  assert.equal(at(6730).dexMissingContracts, 1);
  // OI 0 with a delta: an OBSERVED zero, not missing.
  assert.equal(at(6740).netDex, 0);
  assert.equal(h.totals.dexState, "partial");
  assert.equal(h.totals.dexCoverage!.contractsMissingDelta, 2);
  assert.equal(h.totals.dexCoverage!.contractsWithDelta, 2);
  near(h.totals.dexCoverage!.oiMissingShare!, 140 / 290, 1e-12, "OI share missing");
  near(h.totals.netDex!, d * 100 * 100 * 6700 + 10_050_000, 1e-6, "total = known sum");
  // Every delta missing -> total null, "unavailable".
  const none: any = { underlying: { last: 6700 }, putExpDateMap: {}, callExpDateMap: { [exp]: {
    "6720.0": [{ symbol: "SPXW  261016C06720000", volatility: -999, openInterest: 70, bid: 0, ask: 0 }],
  } } };
  const hn = buildHeatseeker(none, "$SPX", 6700, null, nowMs);
  assert.equal(hn.totals.netDex, null);
  assert.equal(hn.totals.dexState, "unavailable");
});

// ─── N3-1: ticker cone math ──────────────────────────────────────────────────

test("N3-1 Student-t sum quantiles by FFT: closed-form t(4) at n = 1, direct convolution at n = 5, 10", () => {
  // Closed-form t(4) quantile (Shaw 2006): t_0.90 = 1.533206, t_0.975 = 2.776445 (standard tables).
  near(studentT4Quantile(0.90), 1.533206, 1e-6, "t4 0.90");
  near(studentT4Quantile(0.975), 2.776445, 1e-6, "t4 0.975");
  // Unit variance: divide by sqrt(nu / (nu - 2)) = sqrt(2).
  for (const p of [0.01, 0.1, 0.25, 0.75, 0.9, 0.99]) {
    near(studentTSumQuantileFft(p, 1, 4, 10), studentT4Quantile(p) / Math.SQRT2, 5e-4, `n=1 p=${p}`);
  }
  for (const n of [5, 10]) for (const p of [0.1, 0.25, 0.9]) {
    near(studentTSumQuantileFft(p, n, 4, 10), studentTSumQuantile(p, n), 2e-4, `n=${n} p=${p}`);
  }
  // Long horizon converges towards the normal (CLT): 1.2734 at n = 120 vs 1.2816.
  const z120 = studentTSumQuantileFft(0.9, 120, 4, 120);
  assert.ok(z120 < 1.2816 && z120 > 1.27, String(z120));
  near(studentTSumQuantileFft(0.5, 30, 4, 120), 0, 1e-3, "median 0");
});

test("N3-1 ATM IV term structure: strike interpolation to spot, total-variance interpolation in T, monotone", () => {
  const chain = {
    callExpDateMap: {
      "2026-11-20:42": { "95.0": [{ volatility: 32 }], "105.0": [{ volatility: 28 }] },
      "2027-01-15:98": { "100.0": [{ volatility: 25 }] },
    },
    putExpDateMap: {
      "2026-11-20:42": { "95.0": [{ volatility: 34 }], "105.0": [{ volatility: -999 }] },
      "2027-01-15:98": { "100.0": [{ volatility: 27 }] },
    },
  };
  const tYears = (k: string) => Number(k.split(":")[1]) / 365;
  const term = atmIvTermFromChain(chain, 98, tYears);
  // 95: mean(0.32, 0.34) = 0.33; 105: 0.28 (put -999 dropped); at 98: 0.33 + (0.28 - 0.33) x 3/10 = 0.315.
  near(term[0].atmIv, 0.315, 1e-12, "ATM IV Nov");
  near(term[1].atmIv, 0.26, 1e-12, "ATM IV Jan");
  const T1 = 42 / 365, T2 = 98 / 365;
  const w1 = 0.315 ** 2 * T1, w2 = 0.26 ** 2 * T2;
  // Between expiries: linear in total variance.
  const Tm = 70 / 365;
  near(totalVarianceAt(term, Tm)!, w1 + (w2 - w1) * (Tm - T1) / (T2 - T1), 1e-15, "interp");
  // Before the first expiry: flat vol; after the last: flat vol.
  near(totalVarianceAt(term, 10 / 365)!, 0.315 ** 2 * 10 / 365, 1e-15, "front flat");
  near(totalVarianceAt(term, 200 / 365)!, 0.26 ** 2 * 200 / 365, 1e-15, "back flat");
  // Calendar arbitrage (w falling with T) is removed by the running maximum.
  const inverted = [{ expiry: "a", T: 0.1, atmIv: 0.6, w: 0.036 }, { expiry: "b", T: 0.2, atmIv: 0.3, w: 0.018 }];
  near(totalVarianceAt(inverted, 0.15)!, 0.036, 1e-15, "monotone");
  assert.equal(totalVarianceAt([], 0.1), null);
});

test("N3-1 cone bands: zero drift (median = spot), qP = spot x exp(z_P(n) sqrt(w))", () => {
  const w = 0.3 ** 2 * (60 / 365);
  const b = coneBandsFromVariance(100, w, 41, 60);
  assert.equal(b.q50, 100);
  near(b.q90, 100 * Math.exp(studentTSumQuantileFft(0.9, 41, 4, 60) * Math.sqrt(w)), 1e-12, "q90");
  near(Math.log(b.q90 / 100), -Math.log(b.q10 / 100), 1e-9, "symmetric in log price");
  assert.ok(b.q75 < b.q90 && b.q25 > b.q10);
});

// ─── N3-2: quarterly trajectory median has zero drift ────────────────────────

test("N3-2 quarterly trajectory: BASE = spot every week, tilts only in the labelled scenario line", () => {
  const t = buildQuarterlyTrajectory({
    spot: 6700, vix: 18, vix9d: 15, vix3m: 20, callWall: 6900, putWall: 6500, gammaFlip: 6600,
    maxPain: 6650, totalGex: 2e9, composite: 80, skew: 150, realizedVol20d: 0.12,
  });
  assert.ok(t.drivers.totalDriftPerWeek !== 0, "tilts exist");
  assert.equal(t.drivers.medianDriftPerWeek, 0);
  assert.equal(t.drivers.tiltsInMedian, false);
  for (const w of t.weeks) {
    assert.equal(w.base, 6700);
    assert.equal(w.cumDriftPct, 0);
    // Round 4: bands are t(4)-sum quantiles in log price (no IV term here ->
    // labelled 20d realized fallback); r4.test.ts has the known answers.
    assert.ok(w.bull > w.base && w.bear < w.base);
    near(Math.log(w.bull / w.base), -Math.log(w.bear / w.base), 2e-5, "symmetric in log price");
  }
  assert.ok(t.weeks.some((w) => w.scenarioBase !== 6700), "scenario line carries the tilt");
  assert.equal(t.endpoint.base, 6700);
});

// ─── Sector 9: ML band extension and VIX fallback ────────────────────────────

test("S9 band extension: sqrt-time from the 60-min band, median held, stops at the (half-day) close", () => {
  // Anchor at minute 100, last horizon 60 min later: base 500, bull +2, bear -1.5.
  const rows = sqrtTimeExtension({ anchorMinute: 100, lastMinute: 160, base: 500, bull: 502, bear: 498.5, closeMinute: 390 });
  assert.deepEqual(rows[0], { minute: 160, bullExt: 502, baseExt: 500, bearExt: 498.5 });
  const at = (m: number) => rows.find((r) => r.minute === m)!;
  // t = 240 min -> sqrt(240 / 60) = 2: bull 504, bear 497.
  near(at(340).bullExt, 504, 1e-12, "bull x2");
  near(at(340).bearExt, 497, 1e-12, "bear x2");
  assert.ok(rows.every((r) => r.baseExt === 500), "median not extrapolated");
  assert.equal(rows.at(-1)!.minute, 390);
  // 13:00 ET half day: close = minute 210.
  const half = sqrtTimeExtension({ anchorMinute: 100, lastMinute: 160, base: 500, bull: 502, bear: 498.5, closeMinute: 210 });
  assert.equal(half.at(-1)!.minute, 210);
  near(half.at(-1)!.bullExt, 500 + 2 * Math.sqrt(110 / 60), 1e-12, "half-day end");
  // No session / past the close / no horizon: nothing drawn.
  assert.deepEqual(sqrtTimeExtension({ anchorMinute: 100, lastMinute: 160, base: 500, bull: 502, bear: 498, closeMinute: null }), []);
  assert.deepEqual(sqrtTimeExtension({ anchorMinute: 300, lastMinute: 390, base: 500, bull: 502, bear: 498, closeMinute: 390 }), []);
  // The old linear rule at t = 240 would have drawn 502 + (2/60) x 180 = 508 (capped +-1.5%).
});

test("S9 VIX fallback: per-bar sigma = sqrt(14.90 / 36.30) x VIX / 100 / sqrt(252 x 78)", () => {
  near(VIX_INTRADAY_VARIANCE_RATIO, 0.4104683195592287, 1e-15, "kappa (BTZ 2009 Table 1)");
  const s = baselineSigmaPerBar({ vix_level: 20 })!;
  assert.equal(s.source, "vix_implied");
  near(s.sigma, Math.sqrt(14.90 / 36.30) * 0.20 / Math.sqrt(TRADING_DAYS * BARS_PER_DAY_5M), 1e-18, "sigma");
  near(s.sigma, 0.0009139495968634681, 1e-15, "sigma value");
  // Session RV, when present, is untouched.
  assert.equal(baselineSigmaPerBar({ rv_session_5m: 0.001, vix_level: 20 })!.sigma, 0.001);
});
