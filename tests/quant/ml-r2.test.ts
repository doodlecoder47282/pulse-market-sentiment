// R2-F: ML forecaster (Sector 9) known-answer tests.
// Feature schema v2 (same-index dealer levels, unit guard, NaN for missing),
// the baseline volatility cone (TS/Python parity on hand-computed values), the
// served-band decision (promotion gate, morning-model gate, labels), the fix
// round (session-filtered bars, cached/stale chains, periodicity cone, live
// demotion, ML Lab chain levels), and the Python sidecar checks in
// tests/quant/ml_r2_checks.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  guardedDistanceAtr, dealerLevelsFromChain, computeMlFeatures, featuresForJson, sessionRealizedVolPerBar,
  todaysSessionBars, mlLabLevels, spyPerSpxRatio,
  ML_FEATURE_SCHEMA_VERSION, type DealerLevels, type Bar5m,
} from "../../server/mlFeatureMath";
import {
  baselineCone, baselineScale, baselineSigmaPerBar, composeServedBand, liveCoverageDemotion, overlapWeight, promotedComponentsOf,
  GAUSS_Z, type ModelBandsIn,
} from "../../server/mlServedBand";
import { scoreIntervalCoverage } from "../../server/validationMath";

const near = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} +/- ${tol}, got ${a}`);

// 2026-07-15 14:00 EDT (a Wednesday, regular session) = 18:00 UTC.
const NOW = Date.UTC(2026, 6, 15, 18, 0, 0);

// ─── Unit guard (item 1) ─────────────────────────────────────────────────────

test("unit guard: a SPY-scale level is never measured against SPX spot", () => {
  // The v1 bug: CBOE SPY call wall 670 vs SPX spot 6700 with ATR 5 -> (670 - 6700) / 5 = -1206 ATR.
  const spyLevelSpxLabel = guardedDistanceAtr(670, "$SPX", 6700, "$SPX", 5);
  assert.ok(Number.isNaN(spyLevelSpxLabel.value));
  assert.equal(spyLevelSpxLabel.reason, "scale_mismatch");
  const spyUnderlying = guardedDistanceAtr(672, "SPY", 6700, "$SPX", 5);
  assert.ok(Number.isNaN(spyUnderlying.value));
  assert.equal(spyUnderlying.reason, "underlying_mismatch");
  // Same index: (6750 - 6700) / 5 = 10 ATR exactly.
  assert.deepEqual(guardedDistanceAtr(6750, "$SPX", 6700, "$SPX", 5), { value: 10, reason: null });
  // Missing inputs are NaN with a reason, never 0.
  assert.equal(guardedDistanceAtr(null, "$SPX", 6700, "$SPX", 5).reason, "level_missing");
  assert.equal(guardedDistanceAtr(6750, "$SPX", 6700, "$SPX", NaN).reason, "atr_missing");
  // A far strike on the right index is out of range (not a unit error): 4000 / 6700 = 0.60 < 0.7.
  assert.equal(guardedDistanceAtr(4000, "$SPX", 6700, "$SPX", 5).reason, "out_of_range");
  assert.equal(guardedDistanceAtr(67000, "$SPX", 6700, "$SPX", 5).reason, "scale_mismatch");
  // Symbols are compared normalized ("$SPX.X" is "$SPX").
  assert.deepEqual(guardedDistanceAtr(6750, "$SPX.X", 6700, "$SPX", 5), { value: 10, reason: null });
});

// ─── Dealer levels from a Schwab $SPX chain (item 1) ─────────────────────────

function contract(strike: number, side: "C" | "P", oi: number) {
  return {
    symbol: `SPXW  260724${side}0${strike}000`, optionRoot: "SPXW", settlementType: "P",
    strikePrice: strike, openInterest: oi, volatility: 15, gamma: 0.002, delta: side === "C" ? 0.5 : -0.5,
    bid: 10, ask: 10.5, mark: 10.25, totalVolume: 10, daysToExpiration: 9,
  };
}
function spxChain(extra: Record<string, unknown> = {}) {
  const k = "2026-07-24:9";
  return {
    underlying: { last: 6700, bid: 6699.5, ask: 6700.5 },
    callExpDateMap: { [k]: { "6700.0": [contract(6700, "C", 100)], "6800.0": [contract(6800, "C", 3000)] } },
    putExpDateMap: { [k]: { "6600.0": [contract(6600, "P", 300)], "6700.0": [contract(6700, "P", 100)] } },
    source: "schwab",
    ...extra,
  };
}

test("dealer levels from the Schwab $SPX chain: walls, max pain, gamma sign (hand-checked)", () => {
  const { levels, reason } = dealerLevelsFromChain(spxChain(), "$SPX", { nowMs: NOW, fetchedAtMs: NOW });
  assert.equal(reason, null);
  assert.ok(levels);
  assert.equal(levels!.underlying, "$SPX");
  // Equal vendor gamma per contract: call wall = largest call OI at/above spot (6800: 3000),
  // put wall = largest put OI below spot (6600: 300).
  assert.equal(levels!.callWall, 6800);
  assert.equal(levels!.putWall, 6600);
  // Max pain: payout to holders at K* = 6600: puts 6700 x100 x $100 = 10,000; K* = 6700: 0;
  // K* = 6800: calls 6700 x100 x $100 = 10,000 -> 6700.
  assert.equal(levels!.maxPain, 6700);
  // 3,100 call OI vs 400 put OI near spot: re-priced net dealer gamma at spot is positive.
  assert.ok(levels!.gexAtSpot != null && levels!.gexAtSpot > 0);
  assert.ok(levels!.upVomma == null || levels!.upVomma > 6700);
  assert.ok(levels!.dnVomma == null || levels!.dnVomma < 6700);
});

test("dealer levels refuse a non-Schwab, stale or spot-less chain (unavailable, never a substitute)", () => {
  assert.equal(dealerLevelsFromChain(spxChain({ source: "cboe" }), "$SPX", { nowMs: NOW }).reason, "chain_source_cboe_refused");
  assert.equal(dealerLevelsFromChain(spxChain({ asOfMs: NOW - 6 * 60_000 }), "$SPX", { nowMs: NOW }).reason, "chain_stale");
  assert.equal(dealerLevelsFromChain(spxChain({ underlying: { last: null } }), "$SPX", { nowMs: NOW, fetchedAtMs: NOW }).reason, "chain_no_underlying_last");
  assert.equal(dealerLevelsFromChain(null, "$SPX", { nowMs: NOW }).reason, "chain_unavailable");
});

test("dealer levels: cached, flagged-stale, unknown-age or other-symbol chains are missing (fix round items 2, 7)", () => {
  const fresh = { nowMs: NOW, fetchedAtMs: NOW };
  // R2-A fields: a response served from the fetch layer's cache is not live, whatever its asOf.
  assert.equal(dealerLevelsFromChain(spxChain({ servedFromCache: true, asOfMs: NOW }), "$SPX", fresh).reason, "chain_served_from_cache");
  assert.equal(dealerLevelsFromChain(spxChain({ stale: true, asOfMs: NOW }), "$SPX", fresh).reason, "chain_stale");
  // 4 min 59 s old: fresh; 5 min 1 s: stale (DEALER_LEVEL_MAX_AGE_MS = 5 min, chain asOf wins over fetch time).
  assert.equal(dealerLevelsFromChain(spxChain({ asOfMs: NOW - 299_000 }), "$SPX", fresh).reason, null);
  assert.equal(dealerLevelsFromChain(spxChain({ asOfMs: NOW - 301_000 }), "$SPX", fresh).reason, "chain_stale");
  // No asOf and no fetch time: age unknown -> missing, never assumed fresh.
  assert.equal(dealerLevelsFromChain(spxChain(), "$SPX", { nowMs: NOW }).reason, "chain_age_unknown");
  // The chain's own symbol decides the underlying: a SPY chain asked for as $SPX is refused.
  assert.equal(dealerLevelsFromChain(spxChain({ symbol: "SPY" }), "$SPX", fresh).reason, "chain_symbol_mismatch");
  const ok = dealerLevelsFromChain(spxChain({ symbol: "$SPX.X" }), "$SPX", fresh);
  assert.equal(ok.reason, null);
  assert.equal(ok.levels!.underlying, "$SPX");
  // Top |net GEX| strikes kept for the chart: 6800 call OI 3000 dominates.
  assert.equal(ok.levels!.topGex![0].strike, 6800);
});

// ─── Feature dict v2 (items 1, 2) ────────────────────────────────────────────

// 2026-07-15 09:30 EDT = 13:30 UTC, in epoch seconds (fetchOHLC candles carry seconds).
const OPEN_S = Date.UTC(2026, 6, 15, 13, 30, 0) / 1000;
function bars(n: number, start = 6700, step = 1, openS = OPEN_S): Bar5m[] {
  // 5-minute bars from 09:30 ET. Closes 6700, 6701, ... ; high = close + 1, low = close - 1.
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * step;
    return { t: openS + i * 300, o: c - step, h: c + 1, l: c - 1, c };
  });
}

const dealerSpx: DealerLevels = {
  underlying: "$SPX", source: "schwab", asOfMs: NOW, chainSpot: 6712,
  callWall: 6750, putWall: 6650, flip: 6690, maxPain: 6700, zomma: 6720, upVomma: 6800, dnVomma: 6600,
  vanna: 6730, charm: 6680, gexAtSpot: -2.5e9, rowsUsed: 40,
};

test("feature dict v2: same-index distances, gamma sign at spot, NaN for missing (never 0)", () => {
  const r = computeMlFeatures({ nowMs: NOW, bars: bars(13), spot: 6712, spotUnderlying: "$SPX", vix: 18, vixPrev: 20, dealer: dealerSpx });
  assert.equal(r.schemaVersion, ML_FEATURE_SCHEMA_VERSION);
  assert.equal(ML_FEATURE_SCHEMA_VERSION, 2);
  // ATR over the last 7 bars: every true range = max(h - l = 2, |h - prev c| = 2, |l - prev c| = 0) = 2.
  assert.equal(r.features.atr_5m, 2);
  // (6750 - 6712) / 2 = 19 ATR; (6650 - 6712) / 2 = -31 ATR.
  assert.equal(r.features.dist_to_callwall_atr, 19);
  assert.equal(r.features.dist_to_putwall_atr, -31);
  // Net GEX at spot -2.5 $bn per 1%: sign -1 (v1 compared spot with a SPY-scale flip: always +1).
  assert.equal(r.features.net_gex_sign, -1);
  assert.equal(r.features.net_gex_magnitude, 2.5);
  near(r.features.vix_change_pct, -0.1, 1e-12, "(18 - 20) / 20");
  // realized_vol_5m = |last log return| x sqrt(78 x 252) (v1: stdev of ONE return = always 0).
  near(r.features.realized_vol_5m, Math.log(6712 / 6711) * Math.sqrt(78 * 252), 1e-12);
  assert.ok(r.features.realized_vol_5m > 0);
  // 12 returns = the minimum for the session RV (one hour).
  assert.ok(Number.isFinite(r.features.rv_session_5m));
  assert.ok(Number.isNaN(r.features.vix_pct_of_5d_avg));
  assert.ok(r.missing.includes("vix_pct_of_5d_avg"));
  assert.ok(!r.missing.includes("dist_to_callwall_atr"));
});

test("feature dict v2: SPY-scale dealer levels against SPX spot are all missing, with a reason", () => {
  const spy: DealerLevels = { ...dealerSpx, underlying: "SPY", callWall: 675, putWall: 665, flip: 669, maxPain: 670 };
  const r = computeMlFeatures({ nowMs: NOW, bars: bars(13), spot: 6712, spotUnderlying: "$SPX", vix: 18, vixPrev: 20, dealer: spy });
  for (const k of ["dist_to_callwall_atr", "dist_to_putwall_atr", "dist_to_flip_atr", "dist_to_maxpain_atr", "net_gex_sign"]) {
    assert.ok(Number.isNaN(r.features[k]), `${k} must be NaN`);
    assert.ok(r.missing.includes(k));
  }
  assert.equal(r.reasons.dist_to_callwall_atr, "underlying_mismatch");
  // Mislabeled SPY numbers on a "$SPX" record: caught by the scale guard.
  const mislabeled = computeMlFeatures({ nowMs: NOW, bars: bars(13), spot: 6712, spotUnderlying: "$SPX", vix: 18, vixPrev: 20,
    dealer: { ...dealerSpx, callWall: 675 } });
  assert.ok(Number.isNaN(mislabeled.features.dist_to_callwall_atr));
  assert.equal(mislabeled.reasons.dist_to_callwall_atr, "scale_mismatch");
});

test("feature dict v2: no chain, no bars, no VIX -> NaN + reasons, serialized as JSON null", () => {
  const r = computeMlFeatures({ nowMs: NOW, bars: bars(3), spot: 6712, spotUnderlying: "$SPX", vix: null, vixPrev: null, dealer: null, dealerReason: "chain_stale" });
  for (const k of ["dist_to_callwall_atr", "net_gex_sign", "net_gex_magnitude", "realized_vol_30m", "atr_5m", "rv_session_5m", "vix_level", "vix_change_pct"]) {
    assert.ok(Number.isNaN(r.features[k]), `${k} must be NaN, got ${r.features[k]}`);
    assert.ok(r.missing.includes(k), `${k} listed missing`);
  }
  assert.equal(r.reasons.dist_to_callwall_atr, "chain_stale");
  assert.equal(r.features.hour_of_day, 14);
  // Transport: JSON has no NaN; both helpers give null (the sidecar reads null as NaN).
  assert.equal(JSON.parse(JSON.stringify(r.features)).net_gex_sign, null);
  assert.equal(featuresForJson(r.features).net_gex_sign, null);
  assert.equal(r.liveChain, false);
});

test("features use only today's ET session bars: yesterday's bars never leak in (fix round item 3)", () => {
  // Yesterday (2026-07-14): 30 bars with a 100-point step; today: 13 bars with a 1-point step,
  // plus a pre-market bar at 09:00 today and a bar that opens after NOW (14:00).
  const yesterday = bars(30, 6000, 100, OPEN_S - 86_400);
  const preMarket = { t: OPEN_S - 1800, o: 6600, h: 6601, l: 6599, c: 6600 };
  const future = { t: Date.UTC(2026, 6, 15, 18, 5, 0) / 1000, o: 9000, h: 9001, l: 8999, c: 9000 };
  const today = bars(13);
  const kept = todaysSessionBars([...yesterday, preMarket, ...today, future], NOW);
  assert.equal(kept.length, 13);
  assert.equal(kept[0].c, 6700);
  const mixed = computeMlFeatures({ nowMs: NOW, bars: [...yesterday, preMarket, ...today, future], spot: 6712, spotUnderlying: "$SPX", vix: 18, vixPrev: 20, dealer: dealerSpx });
  const clean = computeMlFeatures({ nowMs: NOW, bars: today, spot: 6712, spotUnderlying: "$SPX", vix: 18, vixPrev: 20, dealer: dealerSpx });
  for (const k of ["atr_5m", "rv_session_5m", "realized_vol_30m", "trend_30m", "distance_from_open_pct", "dist_to_callwall_atr"]) {
    assert.equal(mixed.features[k], clean.features[k], k);
  }
  // distance from TODAY's open: (6712 - 6699) / 6699.
  near(clean.features.distance_from_open_pct, 13 / 6699, 1e-15);
  // Only yesterday's bars: nothing from today -> bar features missing, not yesterday's values.
  const onlyYesterday = computeMlFeatures({ nowMs: NOW, bars: yesterday, spot: 6712, spotUnderlying: "$SPX", vix: 18, vixPrev: 20, dealer: null });
  assert.ok(Number.isNaN(onlyYesterday.features.atr_5m));
  assert.ok(Number.isNaN(onlyYesterday.features.rv_session_5m));
  // Millisecond timestamps are handled the same way.
  assert.equal(todaysSessionBars(today.map((b) => ({ ...b, t: b.t * 1000 })), NOW).length, 13);
  // A holiday has no session: 2026-07-03 (Independence Day observed).
  assert.equal(todaysSessionBars(today, Date.UTC(2026, 6, 3, 18, 0, 0)).length, 0);
});

test("session realized vol per bar: RMS of 5-minute log returns, NaN below 12 returns", () => {
  assert.ok(Number.isNaN(sessionRealizedVolPerBar(Array(11).fill(0.001))));
  // Returns +-0.001 alternating: RMS = 0.001 exactly.
  near(sessionRealizedVolPerBar(Array.from({ length: 12 }, (_, i) => (i % 2 ? 0.001 : -0.001))), 0.001, 1e-15);
});

// ─── Baseline cone (item 3), parity with ml_service/forecast_eval.py ─────────

test("baseline cone: hand-computed quantiles (same numbers as the Python checks)", () => {
  // sigma 0.001 per 5-min bar, h = 20: s = 0.001 x sqrt(4) = 0.002;
  // q90 = expm1(1.2815516 x 0.002) = x + x^2/2 + x^3/6 with x = 0.0025631031 -> 0.0025663907.
  // 10:30 ET, flat profile (no fitted periodicity): E = 1, W = h / 5.
  const c = baselineCone({ rv_session_5m: 0.001, hour_of_day: 10.5 }, [20])!;
  near(c.bands["20"].q90, 0.0025663906881020224, 1e-15, "q90");
  near(c.bands["20"].q10, -0.0025598211868448975, 1e-15, "q10");
  near(c.bands["20"].q75, 0.0013498897825096905, 1e-15, "q75");
  assert.equal(c.bands["20"].q50, 0);
  assert.equal(c.zMethod, "gaussian");
  assert.equal(c.sigmaSource, "rv_session");
  // VIX 20 and no session RV (round 3: scaled to intraday by KAPPA = 14.90 / 36.30, BTZ 2009):
  // sigma = sqrt(0.41046832) x 0.20 / sqrt(252 x 78) = 0.6406780 x 0.0014265350 = 0.0009139496; h = 30 -> q90 = expm1(1.2815516 x 0.0009139496 x sqrt(6)) = 0.0028731421.
  const v = baselineCone({ rv_session_5m: null, vix_level: 20, hour_of_day: 10.5 }, [30])!;
  near(v.sigmaPerBar, 0.0009139495968634681, 1e-15);
  near(v.bands["30"].q90, 0.0028731420979910874, 1e-15);
  assert.equal(v.sigmaSource, "vix_implied");
  // Neither input -> unavailable, never a default width.
  assert.equal(baselineCone({ rv_session_5m: null, vix_level: null, hour_of_day: 10.5 }, [30]), null);
  assert.equal(baselineCone({ rv_session_5m: 0.001 }, [30]), null); // no time of day -> no cone
  assert.equal(baselineSigmaPerBar({}), null);
  // Fitted standardized quantiles replace the normal ones when present.
  const f = baselineCone({ rv_session_5m: 0.001, hour_of_day: 10.5 }, [20], { method: "fhs", nDays: 61, fittedAt: 1, byHorizon: { "20": { ...GAUSS_Z, q90: 2 } } })!;
  near(f.bands["20"].q90, Math.expm1(2 * 0.002), 1e-15);
  assert.equal(f.zMethod, "fhs");
});

test("baseline cone with intraday periodicity (Andersen-Bollerslev): hand-computed, parity with forecast_eval.py", () => {
  // Profile: first 6 buckets (09:30-10:00) at 2, the other 72 at 11/12 (mean exactly 1).
  const prof = { f: [...Array(6).fill(2), ...Array(72).fill(11 / 12)], nDays: 40 };
  near(overlapWeight(0, 60, prof.f), 6 * 2 + 6 * 11 / 12, 1e-12);
  // 10:30 ET, rv 0.001: E = 17.5 / 12; sigma^2 = 1e-6 / E = 6.857142857e-7;
  // h = 30 -> W = 6 x 11/12 = 5.5; s_h = sqrt(3.7714285714e-6) = 0.0019420166.
  const a = baselineScale({ rv_session_5m: 0.001, hour_of_day: 10.5 }, 30, prof)!;
  near(a.sH, 0.001942016624910449, 1e-15);
  near(baselineCone({ rv_session_5m: 0.001, hour_of_day: 10.5 }, [30], null, prof)!.bands["30"].q90, 0.0024918940657702128, 1e-15);
  // 15:45 ET, h = 30: only 15 minutes are left in the session (W = 3 x 11/12 = 2.75);
  // E = (12 + 69 x 11/12) / 75 -> s_h = 0.0016555554.
  near(baselineScale({ rv_session_5m: 0.001, hour_of_day: 15.75 }, 30, prof)!.sH, 0.0016555554316830998, 1e-15);
  // VIX-implied sigma, flat, 15:45, h = 30: W = 3 -> 0.0009139496 x sqrt(3) (intraday-scaled VIX sigma).
  near(baselineScale({ vix_level: 20, hour_of_day: 15.75 }, 30, null)!.sH, 0.0015830071373246198, 1e-15);
  // A horizon wholly after the close has no cone (never a zero-width band).
  assert.equal(baselineScale({ rv_session_5m: 0.001, hour_of_day: 16 }, 5, prof), null);
  const c = baselineCone({ rv_session_5m: 0.001, hour_of_day: 16 }, [5], null, prof);
  assert.equal(c, null);
  // The coverage key names every input that changes the band.
  const k = baselineCone({ rv_session_5m: 0.001, hour_of_day: 10.5 }, [30], null, prof)!;
  assert.equal(k.periodicity, "andersen_bollerslev");
  assert.equal(k.versionKey, "baseline_cone:gaussian:rv_session:ab40");
  assert.equal(baselineCone({ vix_level: 20, hour_of_day: 10.5 }, [30])!.versionKey, "baseline_cone:gaussian:vix_implied:flat");
  // A malformed profile (wrong length) is ignored: flat.
  assert.equal(baselineCone({ rv_session_5m: 0.001, hour_of_day: 10.5 }, [30], null, { f: [1, 2], nDays: 3 })!.periodicity, "flat");
});

// ─── Served band (items 3, 5, 8) ─────────────────────────────────────────────

const H = [5, 15, 30, 60];
const flat = (x: number) => ({ q10: -2 * x, q25: -x, q50: 0, q75: x, q90: 2 * x });
const bandsFor = (hs: number[], x: number) => Object.fromEntries(hs.map((h) => [String(h), flat(x)]));
const baseline = baselineCone({ rv_session_5m: 0.001, hour_of_day: 10.5 }, H);

test("served band: an unpromoted or synthetic model is never drawn; the baseline cone is, labeled", () => {
  const synth: ModelBandsIn = { bands: bandsFor(H, 0.003), status: "TRAINED", version: "4", trainingData: "synthetic_gbm", promoted: true };
  const s1 = composeServedBand({ overlay: synth, morning: null, morningWeight: 0, baseline, overlayHorizons: H });
  assert.equal(s1.source, "baseline_cone");
  assert.equal(s1.learned, false);
  assert.match(s1.label, /baseline volatility cone \(not a learned model\)/);
  assert.match(s1.reason ?? "", /not trained on real data/);
  assert.equal(s1.bands!["60"].q90, baseline!.bands["60"].q90);
  const notPromoted: ModelBandsIn = { ...synth, trainingData: "real", promoted: false };
  assert.match(composeServedBand({ overlay: notPromoted, morning: null, morningWeight: 0, baseline, overlayHorizons: H }).reason ?? "", /did not pass the promotion gate/);
  const none = composeServedBand({ overlay: null, morning: null, morningWeight: 0, baseline, overlayHorizons: H, reasonIfNoModel: "ML sidecar not installed (x)" });
  assert.equal(none.reason, "ML sidecar not installed (x)");
  assert.equal(none.coverageModel, "baseline_cone");
  assert.equal(none.coverageVersion, "baseline_cone:gaussian:rv_session:flat");
  const nothing = composeServedBand({ overlay: null, morning: null, morningWeight: 0, baseline: null, overlayHorizons: H });
  assert.equal(nothing.source, "unavailable");
  assert.equal(nothing.bands, null);
});

test("served band: the synthetic morning model is never blended; a promoted one is, and the label says so", () => {
  const overlay: ModelBandsIn = { bands: bandsFor(H, 0.002), status: "TRAINED", version: "7", trainingData: "real", promoted: true };
  const morningSynth: ModelBandsIn = { bands: bandsFor([30, 60, 120], 0.004), status: "TRAINED", version: "1", trainingData: "synthetic_gbm" };
  const a = composeServedBand({ overlay, morning: morningSynth, morningWeight: 0.7, baseline, overlayHorizons: H, morningHorizons: [30, 60, 120] });
  assert.equal(a.components.length, 1);
  assert.equal(a.bands!["60"].q90, 0.004);
  assert.equal(a.bands!["120"], undefined);
  assert.equal(a.learned, true);
  assert.equal(a.coverageVersion, "quantile_overlay:v7");

  const morningReal: ModelBandsIn = { ...morningSynth, trainingData: "real", promoted: true };
  const b = composeServedBand({ overlay, morning: morningReal, morningWeight: 0.25, baseline, overlayHorizons: H, morningHorizons: [30, 60, 120] });
  // 60 min q90: 0.25 x 0.008 + 0.75 x 0.004 = 0.005; 120 min: morning only (0.008); 5 min: overlay only.
  near(b.bands!["60"].q90, 0.005, 1e-15);
  assert.equal(b.bands!["120"].q90, 0.008);
  assert.equal(b.bands!["5"].q90, 0.004);
  assert.equal(b.components.map((c) => `${c.name}:${c.weight}`).join(","), "quantile_overlay:0.75,morning_anchor:0.25");
  assert.match(b.label, /quantile model v7 .* x 75% \+ morning-anchor v1 x 25%/);
  assert.equal(b.coverageModel, "quantile_overlay+morning_anchor");
  // Partial model bands (a missing horizon) are not served.
  const partial: ModelBandsIn = { ...overlay, bands: bandsFor([5, 15], 0.002) };
  assert.equal(composeServedBand({ overlay: partial, morning: null, morningWeight: 0, baseline, overlayHorizons: H }).source, "baseline_cone");
});

// ─── Live-coverage demotion (fix round item 1) ───────────────────────────────

test("live demotion: Kupiec p < 0.01 on >= 20 scored days at any horizon demotes every promoted model in the band", () => {
  // 100 non-overlapping outcomes, 60 inside the 80% band: LR = 2[60 ln(.6/.8) + 40 ln(.4/.2)] = 20.92, p = 4.8e-6.
  const s = scoreIntervalCoverage(Array.from({ length: 100 }, (_, i) => ({ lo: -1, hi: 1, realized: i < 60 ? 0 : 2 })), 0.8);
  assert.ok(s.kupiecP! < 0.01);
  near(s.kupiecLR!, 2 * (60 * Math.log(0.6 / 0.8) + 40 * Math.log(0.4 / 0.2)), 1e-9);
  const d = liveCoverageDemotion([{ horizonMin: 5, kupiecP: 0.4, nDays: 25 }, { horizonMin: 60, kupiecP: s.kupiecP, nDays: 20 }]);
  assert.equal(d.demote, true);
  assert.deepEqual(d.horizons, [60]);
  // 19 days is not enough evidence; p = 0.02 is not a rejection at 1%.
  assert.equal(liveCoverageDemotion([{ horizonMin: 60, kupiecP: s.kupiecP, nDays: 19 }]).demote, false);
  assert.equal(liveCoverageDemotion([{ horizonMin: 60, kupiecP: 0.02, nDays: 40 }]).demote, false);
  // Missing p (no outcomes) never demotes and never counts as a pass either: it is just no evidence.
  assert.equal(liveCoverageDemotion([{ horizonMin: 60, kupiecP: null, nDays: 40 }]).demote, false);
  assert.deepEqual(promotedComponentsOf("quantile_overlay:v7+morning_anchor:v2"),
    [{ model: "quantile_overlay", version: 7 }, { model: "quantile_overlay_morning", version: 2 }]);
  assert.deepEqual(promotedComponentsOf("baseline_cone:gaussian:rv_session:flat"), []);
});

// ─── ML Lab levels (fix round item 6) ────────────────────────────────────────

test("ML Lab levels: $SPX chain levels, SPY through the live quote ratio, unavailable without one", () => {
  const r = spyPerSpxRatio({ last: 6700, stale: false, quoteTimeMs: NOW }, { last: 668.66, stale: false, quoteTimeMs: NOW - 1000 });
  near(r.ratio!, 668.66 / 6700, 1e-15);
  assert.equal(spyPerSpxRatio({ last: 6700, stale: null }, { last: 668.66, stale: false }).reason, "quote_stale_or_unknown_age");
  assert.equal(spyPerSpxRatio({ last: 6700, stale: false, quoteTimeMs: NOW }, { last: 668.66, stale: false, quoteTimeMs: NOW - 180_000 }).reason, "quotes_not_simultaneous");
  assert.equal(spyPerSpxRatio({ last: 6700, stale: false }, { last: 6700, stale: false }).reason, "ratio_out_of_range");
  const dealer = { ...dealerSpx, topGex: [{ strike: 6800, gex: 3e9 }] };
  const spy = mlLabLevels(dealer, null, { scale: r.ratio, display: "SPY", targets: { upside: 6800, downside: null } });
  // Call wall 6750 SPX x (668.66 / 6700) = 673.6491 SPY (a fixed /10 would say 675.00).
  near(spy.callWall.value, 6750 * 668.66 / 6700, 1e-9);
  assert.equal(spy.callWall.source, "schwab_spx_chain");
  assert.equal(spy.callWall.spxValue, 6750);
  near(spy.mopex.value, 6700 * 668.66 / 6700, 1e-9); // max pain from the chain
  near(spy.topGexStrikes[0].strike, 6800 * 668.66 / 6700, 1e-9);
  assert.equal(spy.weeklyTargets.upside.source, "user_targets");
  assert.equal(spy.weeklyTargets.downside, null); // missing target is null, never 0
  assert.equal(spy.dataState, "ok");
  const spx = mlLabLevels(dealer, null, { scale: 1, display: "$SPX" });
  assert.equal(spx.putWall.value, 6650);
  const noRatio = mlLabLevels(dealer, null, { scale: null, scaleReason: "quote_stale_or_unknown_age", display: "SPY" });
  assert.equal(noRatio.callWall, null);
  assert.equal(noRatio.dataState, "unavailable");
  assert.equal(noRatio.reason, "quote_stale_or_unknown_age");
  const noChain = mlLabLevels(null, "chain_served_from_cache", { scale: 1, display: "$SPX" });
  assert.equal(noChain.gammaFlip, null);
  assert.equal(noChain.reason, "chain_served_from_cache");
});

// ─── Python sidecar checks ───────────────────────────────────────────────────

test("ML sidecar (python): DM size (fixed-smoothing), periodicity, promotion gate, incumbent demotion, false promotions, schema-checked serving", async (t) => {
  const probe = spawnSync("python3", ["-I", "-c", "import numpy, pandas, scipy, sklearn, joblib"], { encoding: "utf8", timeout: 20_000 });
  if (probe.error || probe.status !== 0) { t.skip("python3 with numpy, pandas, scipy, scikit-learn and joblib not available"); return; }
  const script = fileURLToPath(new URL("./ml_r2_checks.py", import.meta.url));
  // ~4 min: the 20-seed false-promotion check trains 20 models (set ML_R2_SKIP_SLOW=1 to skip it).
  const r = spawnSync("python3", ["-I", script], { encoding: "utf8", timeout: 900_000 });
  assert.equal(r.status, 0, `python checks failed:\n${r.stdout}\n${r.stderr}`);
});
