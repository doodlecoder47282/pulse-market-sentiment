// Money-math pass: every dollar figure fixed in this pass gets a hand-computed
// test. The arithmetic is written next to each expected value. Greeks are the
// Black-Scholes closed forms (Hull, "Options, Futures, and Other Derivatives",
// ch. 19; Haug, "The Complete Guide to Option Pricing Formulas", sec. 2.3),
// re-derived from d1 = [ln(S/K) + sigma^2 T/2] / (sigma sqrt T), r = q = 0:
//   dDelta/dT(to expiry) = -phi(d1) d2 / (2T)  =>  charm dDelta/dt = +phi(d1) d2 / (2T)
//   vanna = -phi(d1) d2 / sigma, vomma = vega d1 d2 / sigma, zomma = gamma (d1 d2 - 1) / sigma.
// Contract multiplier 100 (Cboe SPX/SPXW/XSP specs, OCC standard equity option).
import { test } from "node:test";
import assert from "node:assert/strict";

import { contractExposure, charmTiltNorm, callDelta0 } from "../../server/greekExposure";
import { modelThetaToClose, projectedThetaCost } from "../../server/chainClock";
import { bsPrice, delta as bsDelta } from "../../server/greeks";
import { etWallToEpochMs } from "../../server/exchangeCalendar";
import { buildChainAudit } from "../../server/chainAudit";
import { buildHeatseeker } from "../../server/heatseeker";
import { buildExposureProfile, rowYears, type ExposureRow } from "../../server/exposureProfile";
import { pickEarningsExpiry } from "../../server/impliedScenario";
import { toCents } from "../../server/validationMath";

const near = (got: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);

// ─── 1. Per-contract dollar exposures (Killbox, thermal, 0DTE forward, Heatseeker) ──

test("contractExposure: $ GEX, vanna, charm, vomma, zomma for 10 contracts (hand-computed)", () => {
  // S = K = 100, sigma = 0.20, T = 1 y, n = 10, m = 100.
  //   v = 0.2, d1 = 0.1, d2 = -0.1, phi(0.1) = 0.39695255
  //   gamma = 0.39695255 / (100 x 0.2) = 0.0198476
  //   GEX $/1%   = 0.0198476 x 10 x 100 x 100^2 x 0.01              = 1,984.76
  //   vanna      = -0.39695255 x (-0.1) / 0.2 = 0.1984763 per 1.00 vol
  //   vanna $    = 0.1984763 x 0.01 x 10 x 100 x 100                 = 198.476 per +1 vol pt
  //   vega       = 100 x 0.39695255 x 1 = 39.695255; d1 d2 = -0.01
  //   vomma      = 39.695255 x (-0.01) / 0.2 = -1.9847628
  //   vomma $    = -1.9847628 x 1e-4 x 10 x 100                     = -0.198476 $ vega per vol pt per vol pt
  //   zomma      = 0.0198476 x (-1.01) / 0.2 = -0.1002305
  //   zomma $    = -0.1002305 x 0.01 x 10 x 100 x 100^2 x 0.01      = -100.23 ($/1% GEX per +1 vol pt)
  //   charm      = phi(d1) d2 / (2T) = 0.39695255 x (-0.1) / 2 = -0.0198476 per year
  //   charm $/day ~ -0.0198476 / 365 x 10 x 100 x 100                = -5.4377 (first order)
  const x = contractExposure({ spot: 100, strike: 100, sigma: 0.2, T: 1, contracts: 10 });
  near(x.gexPerPct, 1984.76, 0.01, "GEX $/1%");
  near(x.vannaPerVolPt, 198.476, 0.001, "vanna $/vol pt");
  near(x.vommaPerVolPt, -0.198476, 1e-5, "vomma $");
  near(x.zommaPerVolPt, -100.23, 0.01, "zomma $");
  near(x.charmPerDay, -5.4377, 0.01, "charm $/day");
});

test("contractExposure: each $ figure equals a finite difference of Black-Scholes", () => {
  // Independent check: bump the inputs of greeks.ts (bsPrice / delta) and
  // convert with the stated units.
  const S = 6700, K = 6750, sig = 0.16, T = 20 / 365, n = 250, m = 100;
  const x = contractExposure({ spot: S, strike: K, sigma: sig, T, contracts: n });
  const d = (s: number, v: number, t: number) => bsDelta(s, K, v, t, 0, 0, "C");
  const vega = (s: number, v: number) => (bsPrice(s, K, v + 1e-5, T, 0, 0, "C") - bsPrice(s, K, v - 1e-5, T, 0, 0, "C")) / 2e-5;
  const gamma = (v: number) => (d(S + 0.01, v, T) - d(S - 0.01, v, T)) / 0.02;
  // vanna: $ delta notional change for +1 vol pt
  near(x.vannaPerVolPt, (d(S, sig + 0.005, T) - d(S, sig - 0.005, T)) * n * m * S, Math.abs(x.vannaPerVolPt) * 1e-3, "vanna FD");
  // charm: delta one calendar day later
  near(x.charmPerDay, (d(S, sig, T - 1 / 365) - d(S, sig, T)) * n * m * S, 1, "charm FD");
  // vomma: change in $ vega (per vol pt) per +1 vol pt
  near(x.vommaPerVolPt, (vega(S, sig + 0.001) - vega(S, sig - 0.001)) / 0.002 * 1e-4 * n * m, Math.abs(x.vommaPerVolPt) * 1e-3 + 0.01, "vomma FD");
  // zomma: change in GEX $/1% per +1 vol pt
  near(x.zommaPerVolPt, (gamma(sig + 0.005) - gamma(sig - 0.005)) * n * m * S * S * 0.01, Math.abs(x.zommaPerVolPt) * 2e-3 + 1, "zomma FD");
});

test("0DTE charm: $ delta left to lose to settlement, not an extrapolated rate (before/after)", () => {
  // K = 6610, S = 6600, sigma 15%, 2 h to the PM settlement, OI 1,000:
  //   T = 120 / 525,600 = 2.2831e-4, v = 0.15 sqrt(T) = 0.0022665
  //   d1 = (ln(6600/6610) + v^2/2) / v = (-0.0015140 + 0.0000026) / 0.0022665 = -0.66686
  //   N(d1) = 0.25240; at settlement (spot held) the call delta is 0.
  //   after:  (0 - 0.25240) x 1,000 x 100 x 6,600 = -$166.58M "per day (to settlement)"
  //   before (Killbox inline): -phi(d1) d2 / (2 T sigma sqrt T) / 365 x 1,000 x 100
  //          = +5.66e7 printed as "$56.6M/day": wrong sign, share units, and 1/(sigma sqrt T) = 441x too big a rate.
  const T = 120 / 525_600;
  const x = contractExposure({ spot: 6600, strike: 6610, sigma: 0.15, T, contracts: 1000 });
  const want = -callDelta0(6600, 6610, 0.15, T) * 1000 * 100 * 6600;
  near(x.charmPerDay, want, 1, "charm to settlement");
  near(x.charmPerDay / 1e6, -166.58, 0.05, "charm $M");
  const v = 0.15 * Math.sqrt(T);
  const d1 = (Math.log(6600 / 6610) + 0.5 * v * v) / v, d2 = d1 - v;
  const phi = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const old = -phi * d2 / (2 * T * 0.15 * Math.sqrt(T)) / 365 * 1000 * 100;
  near(old / 1e6, 56.6, 0.2, "old inline value");
  assert.ok(Math.sign(old) !== Math.sign(x.charmPerDay), "old formula had the opposite sign");
});

test("contractExposure: unusable inputs give zeros, never NaN", () => {
  for (const bad of [
    { spot: 0, strike: 100, sigma: 0.2, T: 1, contracts: 1 },
    { spot: 100, strike: 100, sigma: 0, T: 1, contracts: 1 },
    { spot: 100, strike: 100, sigma: 0.2, T: 0, contracts: 1 },
    { spot: 100, strike: 100, sigma: 0.2, T: 1, contracts: 0 },
  ]) {
    const x = contractExposure(bad);
    for (const v of Object.values(x)) assert.equal(v, 0);
  }
});

test("charmTiltNorm: -netCharm / gross $GEX, clamped at +-0.15", () => {
  // Dealers' hedged delta decays by $120M to the close (netCharm = -1.2e8):
  // they buy $120M. Gross |GEX| = $2B per 1% -> 1.2e8 / 2e9 = +0.06 (up tilt).
  assert.equal(charmTiltNorm(-1.2e8, 2e9), 0.06);
  assert.equal(charmTiltNorm(1.2e8, 2e9), -0.06);
  assert.equal(charmTiltNorm(-1e9, 2e9), 0.15);   // 0.5 clamped
  assert.equal(charmTiltNorm(5e8, 0), 0);          // no gamma surface: no tilt
});

// ─── 2. Theta to the close (contractPicker / odteAlertEngine projThetaCost) ────

test("modelThetaToClose: PM 0DTE loses its whole extrinsic by the close (vs theta x minutes)", () => {
  // Wed 2026-10-07 12:00 ET, SPXW 0DTE ATM call, S = K = 6,700, sigma 15%,
  // 240 minutes to the 16:00 PM settlement:
  //   T = 240 / 525,600; ATM value = S [N(v/2) - N(-v/2)] = 8.5675 per share
  //   at the close (spot held) it is worth intrinsic 0 -> cost = -8.5675 = -$856.75 per contract.
  // Old method: instantaneous theta per day -S sigma phi(d1) / (2 sqrt T) / 365 = -25.70,
  //   x 240 / 390 = -15.82 per share = -$1,581.69 per contract (1.85x too much).
  const nowMs = etWallToEpochMs("2026-10-07", 12 * 60);
  const T = 240 / 525_600;
  const mid = bsPrice(6700, 6700, 0.15, T, 0, 0, "C");
  near(mid, 8.5675, 1e-4, "ATM mid");
  const cost = modelThetaToClose({
    spot: 6700, strike: 6700, type: "C", expiry: "2026-10-07", symbol: "SPXW  261007C06700000",
    bid: mid - 0.05, ask: mid + 0.05, vendorIv: 0.15, minutesToClose: 240, nowMs,
  });
  assert.ok(cost != null);
  near(cost!, -8.5675, 1e-3, "theta to close per share");
  near(cost! * 100, -856.75, 0.1, "theta to close $ per contract");
  const old = projectedThetaCost(-25.70, 240, nowMs);
  near(old, -15.815, 1e-3, "old theta x minutes");
});

test("modelThetaToClose: half day, ITM put keeps intrinsic; a 1DTE keeps value past the close", () => {
  // Fri 2026-11-27 (13:00 ET close) at 12:00: 60 minutes left.
  //   ITM put K = 6,710, S = 6,700, sigma 15%: intrinsic 10; cost = 10 - P(now).
  const nowMs = etWallToEpochMs("2026-11-27", 12 * 60);
  const T = 60 / 525_600;
  const p = bsPrice(6700, 6710, 0.15, T, 0, 0, "P");
  const cost = modelThetaToClose({
    spot: 6700, strike: 6710, type: "P", expiry: "2026-11-27", symbol: "SPXW  261127P06710000",
    bid: p - 0.05, ask: p + 0.05, vendorIv: 0.15, minutesToClose: 60, nowMs,
  });
  near(cost!, 10 - p, 1e-3, "half-day put");
  assert.ok(cost! < 0 && cost! > -p, "cost is the extrinsic only");
  // 1DTE (expires Thu 2026-10-08 16:00) priced Wed 12:00, 240 min to today's close:
  //   T_now = 28 h = 1,680 min; T_close = 1,440 min; cost = P(1,440) - P(1,680).
  const now2 = etWallToEpochMs("2026-10-07", 12 * 60);
  const T1 = 1680 / 525_600, T2 = 1440 / 525_600;
  const m1 = bsPrice(6700, 6700, 0.15, T1, 0, 0, "C");
  const c2 = modelThetaToClose({
    spot: 6700, strike: 6700, type: "C", expiry: "2026-10-08", symbol: "SPXW  261008C06700000",
    bid: m1 - 0.05, ask: m1 + 0.05, vendorIv: 0.15, minutesToClose: 240, nowMs: now2,
  });
  near(c2!, bsPrice(6700, 6700, 0.15, T2, 0, 0, "C") - m1, 1e-3, "1DTE to close");
});

test("modelThetaToClose: settled contract or no sigma -> null (caller falls back)", () => {
  const after = etWallToEpochMs("2026-10-07", 16 * 60 + 5);
  assert.equal(modelThetaToClose({ spot: 6700, strike: 6700, type: "C", expiry: "2026-10-07", symbol: "SPXW  261007C06700000", bid: 1, ask: 1.1, vendorIv: 0.15, minutesToClose: 1, nowMs: after }), null);
  const noon = etWallToEpochMs("2026-10-07", 12 * 60);
  assert.equal(modelThetaToClose({ spot: 6700, strike: 6700, type: "C", expiry: "2026-10-07", symbol: "SPXW  261007C06700000", bid: null, ask: null, vendorIv: -9.99, minutesToClose: 240, nowMs: noon }), null);
});

// ─── 3. Chain audit DEX is dollars, sentinels skipped ─────────────────────────

test("chainAudit DEX: delta x OI x 100 x S dollars; Schwab -999 sentinel skipped", () => {
  // One SPXW call, delta 0.50, OI 1,000, spot 6,700:
  //   0.50 x 1,000 x 100 x 6,700 = $335,000,000 (old value: 50,000 printed as "$50K").
  // One put, delta -0.25, OI 2,000: -0.25 x 2,000 x 100 x 6,700 = -$335,000,000.
  // A call row with delta -999 (closed-market sentinel) must not add -$66.9B.
  const nowMs = etWallToEpochMs("2026-10-07", 12 * 60);
  const row = (o: any) => ({ bid: 10, ask: 10.5, volatility: 15, gamma: 0.001, theta: -1, vega: 1, totalVolume: 0, ...o });
  const chain: any = {
    underlying: { last: 6700, bid: 6700, ask: 6700 },
    callExpDateMap: { "2026-10-16:9": {
      "6700.0": [row({ symbol: "SPXW  261016C06700000", delta: 0.5, openInterest: 1000 })],
      "6800.0": [row({ symbol: "SPXW  261016C06800000", delta: -999, openInterest: 1000 })],
    } },
    putExpDateMap: { "2026-10-16:9": {
      "6600.0": [row({ symbol: "SPXW  261016P06600000", delta: -0.25, openInterest: 2000 })],
    } },
  };
  const a = buildChainAudit(chain, 6700, nowMs);
  assert.equal(a.dex.totalCallDex, 335_000_000);
  assert.equal(a.dex.totalPutDex, -335_000_000);
  assert.equal(a.dex.totalNetDex, 0);
});

// ─── 4. Heatseeker: sentinel gamma is not a wall ──────────────────────────────

test("heatseeker: a -999 vendor gamma contributes $0 GEX, a valid one gamma x OI x 100 x S^2 x 0.01", () => {
  // Valid call K = 6,750, gamma 0.002, OI 500, S = 6,700:
  //   0.002 x 500 x 100 = 100; 6,700^2 = 44,890,000; 100 x 44,890,000 x 0.01 = $44,890,000 per 1% move.
  // The sentinel row (gamma -999, OI 900) would have read -999 x 900 x 100 x 44,890,000 x 0.01 = -$40.4T.
  const chain: any = {
    underlying: { last: 6700 },
    callExpDateMap: { "2027-12-17:435": {
      "6750.0": [{ symbol: "SPXW  271217C06750000", gamma: 0.002, delta: 0.5, volatility: 15, openInterest: 500, totalVolume: 0, bid: 300, ask: 301 }],
      "6800.0": [{ symbol: "SPXW  271217C06800000", gamma: -999, delta: -999, volatility: -999, openInterest: 900, totalVolume: 0, bid: 0, ask: 0 }],
    } },
    putExpDateMap: {},
  };
  const h = buildHeatseeker(chain, "$SPX", 6700, "2027-12-17");
  const s6750 = h.strikes.find((s) => s.strike === 6750)!;
  const s6800 = h.strikes.find((s) => s.strike === 6800)!;
  near(s6750.netGex, 44_890_000, 1, "valid GEX $/1%");
  assert.equal(s6800.netGex, 0);
  assert.equal(s6800.netDex, 0);
  assert.equal(h.totals.callWall, 6750);
});

// ─── 5. /api/exposures charm: $ delta change over min(1 day, T) ───────────────

test("exposureProfile charm: finite delta change over one day x OI x 100 x S (r, q as given)", () => {
  // One call far from expiry: charm $/day = [Delta(T - 1/365) - Delta(T)] x 300 x 100 x S,
  // Delta from greeks.ts with r = 5%, q = 1.3% (the profile's defaults).
  const row: ExposureRow = { type: "C", strike: 700, iv: 0.18, oi: 300, dte: 400, expiry: "2027-12-17", style: "PM" };
  const S = 680;
  const p = buildExposureProfile("SPY", [row], S, { r: 0.05, q: 0.013 });
  const T = rowYears(row);
  const want = (bsDelta(S, 700, 0.18, T - 1 / 365, 0.05, 0.013, "C") - bsDelta(S, 700, 0.18, T, 0.05, 0.013, "C")) * 300 * 100 * S;
  near(p.current.charm, want, Math.abs(want) * 1e-3 + 0.5, "charm $/day");
});

// ─── 6. Earnings implied move: the straddle must span the reaction ───────────

test("pickEarningsExpiry: AMC needs an expiry after the report day, BMO may use it", () => {
  // Listed: Fri 10-23, Fri 10-30, Fri 11-06. AAPL reports Thu 10-29 after the close:
  // the 10-23 straddle settles before the report (no event in its price);
  // 10-30 settles the day of the reaction. A $2.10 pre-earnings straddle on
  // a $250 stock read "+-$2.10 (0.8%)" for an event the 10-30 straddle prices at, say, $9.40.
  const ex = ["2026-10-23:15", "2026-10-30:22", "2026-11-06:29"];
  assert.equal(pickEarningsExpiry(ex, "2026-10-29", "AMC"), "2026-10-30");
  assert.equal(pickEarningsExpiry(ex, "2026-10-30", "BMO"), "2026-10-30"); // report-day expiry reacts
  assert.equal(pickEarningsExpiry(ex, "2026-10-30", "AMC"), "2026-11-06");
  assert.equal(pickEarningsExpiry(ex, "2026-10-30", "UNK"), "2026-11-06"); // unknown timing: be safe
  assert.equal(pickEarningsExpiry(ex, "2026-11-06", "AMC"), null);         // not listed yet: missing, not a number
});

test("CLV/trade-log dollars: toCents rounds halves away from zero for losses", () => {
  // Equity, qty 1, price diff -12.345: Math.round(-1234.4999999999998) / 100 = -12.34,
  // toCents(-12.345) / 100 = -12.35 (the loss is never shaved by float error).
  assert.equal(Math.round(-12.345 * 100) / 100, -12.34);
  assert.equal(toCents(-12.345) / 100, -12.35);
  // Option, 3 contracts, (1.20 - 1.50) $/share x 3 x 100 = -$90.00 exactly.
  assert.equal(toCents((1.2 - 1.5) * 3 * 100) / 100, -90);
});
