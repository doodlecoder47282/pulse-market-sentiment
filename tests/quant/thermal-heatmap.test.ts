// Independent verification of server/thermalHeatmap.ts (buildThermalHeatmap).
//
// Every expected number here is derived in this file from first principles:
// Black-Scholes-Merton with a continuous dividend yield (Hull, "Options,
// Futures, and Other Derivatives", ch. 19; Haug, "The Complete Guide to
// Option Pricing Formulas", 2nd ed., sec. 2.3), the dollar units documented in
// the header of server/greekExposure.ts, the SqueezeMetrics GEX convention
// (gamma x OI x 100 per contract, dealers long calls / short puts) and the
// Cboe calendar-minute clock (minutes to the settlement instant / 525,600).
// The module's own helpers (contractExposure, repricedFlipFromChain,
// gexByStrikeFromChain) are called only where the task is to confirm that the
// heatmap agrees with them; they never supply an expectation on their own.
//
// Fixtures are Schwab-shaped (callExpDateMap / putExpDateMap keyed
// "YYYY-MM-DD:DTE" -> "strike.0" -> [contract]). bid = ask = 0 on hand-built
// rows so chainClock.ivForClock never re-solves sigma from a mid and the
// vendor `volatility` is the sigma in play.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThermalHeatmap, THERMAL_GREEKS, type ThermalGreek, type ThermalHeatmap } from "../../server/thermalHeatmap";
import { etWallToEpochMs } from "../../server/exchangeCalendar";
import { demoChain } from "../../server/demoMarket";
import { contractExposure } from "../../server/greekExposure";
import { FLIP_RATE, gexByStrikeFromChain, repricedFlipFromChain } from "../../server/gammaProfile";

// ─── Fixed instant and basis ────────────────────────────────────────────────
// Monday 2026-10-12 11:00 ET (EDT, UTC-4; DST ends 2026-11-01 so every instant
// in these fixtures shares the same offset). Not an exchange holiday.
const TODAY = "2026-10-12";
const NOW = etWallToEpochMs(TODAY, 11 * 60);
const SPOT = 6700;
const R = 0.05;      // FLIP_RATE: the module's rate
const Q = 0.013;     // dividendYieldFor("$SPX")
const MULT = 100;    // Cboe SPX contract multiplier ($100 x the index)
const MINUTES_PER_YEAR = 525_600; // Cboe VIX methodology
const TOL = 1e-6;

// ─── First-principles math (no imports) ─────────────────────────────────────
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const phi = (x: number) => Math.exp(-0.5 * x * x) / SQRT_2PI;

/** Standard normal CDF, Abramowitz & Stegun 7.1.26 (|error| < 7.5e-8). */
function N(x: number): number {
  const p = 0.3275911, a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  return 0.5 * (1 + s * (1 - poly * Math.exp(-z * z)));
}

/** d1 = [ln(S/K) + (r - q + sigma^2/2) T] / (sigma sqrt T), d2 = d1 - sigma sqrt T. */
function d12(S: number, K: number, sigma: number, T: number, r: number, q: number): [number, number] {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / v;
  return [d1, d1 - v];
}

/** BSM delta: call e^{-qT} N(d1), put e^{-qT} (N(d1) - 1); terminal payoff slope at T <= 0. */
function bsDelta(S: number, K: number, sigma: number, T: number, r: number, q: number, type: "C" | "P"): number {
  if (!(T > 1e-12)) {
    const c = S > K ? 1 : S < K ? 0 : 0.5;
    return type === "C" ? c : c - 1;
  }
  const [d1] = d12(S, K, sigma, T, r, q);
  const eq = Math.exp(-q * T);
  return type === "C" ? eq * N(d1) : eq * (N(d1) - 1);
}

/** BSM gamma = e^{-qT} phi(d1) / (S sigma sqrt T), identical for calls and puts. */
function bsGammaFP(S: number, K: number, sigma: number, T: number, r: number, q: number): number {
  const [d1] = d12(S, K, sigma, T, r, q);
  return Math.exp(-q * T) * phi(d1) / (S * sigma * Math.sqrt(T));
}

/** BSM vega = S e^{-qT} phi(d1) sqrt T (per 1.00 vol). */
function bsVegaFP(S: number, K: number, sigma: number, T: number, r: number, q: number): number {
  const [d1] = d12(S, K, sigma, T, r, q);
  return S * Math.exp(-q * T) * phi(d1) * Math.sqrt(T);
}

interface Exposure { gex: number; vanna: number; charm: number; vomma: number; zomma: number }

/**
 * Dollar exposures of n LONG contracts, from the units in greekExposure.ts:
 *   gex   = gamma n m S^2 0.01            ($ delta notional per 1% spot move)
 *   vanna = (dDelta/dsigma) 0.01 n m S    ($ delta notional per +1 vol point)
 *   charm = [Delta(T-h) - Delta(T)] n m S, h = min(1 day, T)
 *   vomma = (dVega/dsigma) 1e-4 n m       ($ vega per vol point, per +1 vol point)
 *   zomma = (dGamma/dsigma) 0.01 n m S^2 0.01
 * with, for Delta = e^{-qT} N(d1) and d(d1)/dsigma = -d2/sigma:
 *   dDelta/dsigma = -e^{-qT} phi(d1) d2 / sigma
 *   dVega/dsigma  = vega d1 d2 / sigma
 *   dGamma/dsigma = gamma (d1 d2 - 1) / sigma
 * (Hull ch. 19, Haug sec. 2.3; the e^{-qT} factor is what q != 0 adds to the
 * r = q = 0 forms quoted in the greekExposure.ts header.)
 */
function longExposure(S: number, K: number, sigma: number, T: number, r: number, q: number, type: "C" | "P", n: number): Exposure {
  const [d1, d2] = d12(S, K, sigma, T, r, q);
  const eq = Math.exp(-q * T);
  const gamma = eq * phi(d1) / (S * sigma * Math.sqrt(T));
  const vanna = -eq * phi(d1) * d2 / sigma;
  const vomma = bsVegaFP(S, K, sigma, T, r, q) * d1 * d2 / sigma;
  const zomma = gamma * (d1 * d2 - 1) / sigma;
  const h = Math.min(1 / 365, T);
  const dDelta = bsDelta(S, K, sigma, T - h, r, q, type) - bsDelta(S, K, sigma, T, r, q, type);
  return {
    gex: gamma * n * MULT * S * S * 0.01,
    vanna: vanna * 0.01 * n * MULT * S,
    charm: dDelta * n * MULT * S,
    vomma: vomma * 1e-4 * n * MULT,
    zomma: zomma * 0.01 * n * MULT * S * S * 0.01,
  };
}

const dealerSign = (side: "C" | "P") => (side === "C" ? 1 : -1);

// ─── Clock ──────────────────────────────────────────────────────────────────
/** Calendar years from NOW to the PM settlement (16:00 ET) of an expiry date. */
function pmT(expiry: string): number {
  return (etWallToEpochMs(expiry, 16 * 60) - NOW) / 60_000 / MINUTES_PER_YEAR;
}
function dteOf(expiry: string): number {
  return Math.round((Date.parse(`${expiry}T12:00:00Z`) - Date.parse(`${TODAY}T12:00:00Z`)) / 86_400_000);
}
const keyOf = (expiry: string) => `${expiry}:${dteOf(expiry)}`;

// ─── Schwab-shaped fixture ──────────────────────────────────────────────────
interface Row {
  side: "C" | "P";
  expiry: string;
  strike: number;
  oi: number;
  vol?: number;
  ivPct?: number;
  bid?: number;
  ask?: number;
  root?: string;            // "SPXW" (PM) or "SPX" (AM-settled)
  settlementType?: string;  // "P" | "A"
  gamma?: number;           // vendor gamma field
}

function occSymbol(root: string, expiry: string, side: "C" | "P", strike: number): string {
  return `${root.padEnd(6, " ")}${expiry.slice(2).replace(/-/g, "")}${side}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

function contractOf(row: Row): any {
  const root = row.root ?? "SPXW";
  const expMs = etWallToEpochMs(row.expiry, (row.settlementType ?? "P") === "A" ? 9 * 60 + 30 : 16 * 60);
  const bid = row.bid ?? 0, ask = row.ask ?? 0;
  return {
    putCall: row.side === "C" ? "CALL" : "PUT",
    symbol: occSymbol(root, row.expiry, row.side, row.strike),
    description: `${root} ${row.expiry} ${row.strike} ${row.side === "C" ? "Call" : "Put"} (fixture)`,
    bid, ask, mark: (bid + ask) / 2, last: 0,
    totalVolume: row.vol ?? 0,
    volatility: row.ivPct ?? 18,
    delta: row.side === "C" ? 0.5 : -0.5,
    gamma: row.gamma ?? 0.0012,
    openInterest: row.oi,
    strikePrice: row.strike,
    expirationDate: new Date(expMs).toISOString(),
    daysToExpiration: dteOf(row.expiry),
    multiplier: 100,
    settlementType: row.settlementType ?? "P",
    optionRoot: root,
  };
}

function chainOf(rows: Row[], spot = SPOT) {
  const callExpDateMap: Record<string, Record<string, any[]>> = {};
  const putExpDateMap: Record<string, Record<string, any[]>> = {};
  for (const row of rows) {
    const map = row.side === "C" ? callExpDateMap : putExpDateMap;
    const ek = keyOf(row.expiry), sk = row.strike.toFixed(1);
    (map[ek] ??= {});
    (map[ek][sk] ??= []).push(contractOf(row));
  }
  return { callExpDateMap, putExpDateMap, underlying: { last: spot }, source: "fixture" };
}

// ─── Assertion helpers ──────────────────────────────────────────────────────
function assertRel(actual: number, expected: number, msg: string, tol = TOL): void {
  const scale = Math.max(Math.abs(expected), Math.abs(actual));
  const diff = Math.abs(actual - expected);
  assert.ok(
    Number.isFinite(actual) && (scale === 0 ? diff === 0 : diff <= tol * scale),
    `${msg}: expected ${expected}, actual ${actual}, relative difference ${scale === 0 ? diff : diff / scale} (tolerance ${tol})`,
  );
}

const build = (chain: any, greek: ThermalGreek = "gex", opts: Record<string, unknown> = {}) =>
  buildThermalHeatmap(chain, "$SPX", SPOT, greek, { nowMs: NOW, ...opts });

function cellAt(h: ThermalHeatmap, expiry: string, strike: number) {
  const c = h.cells.find((x) => x.expiry === expiry && x.strike === strike);
  assert.ok(c, `cell for ${expiry} @ ${strike} present`);
  return c!;
}
function totalAt(h: ThermalHeatmap, strike: number) {
  const t = h.strikeTotals.find((x) => x.strike === strike);
  assert.ok(t, `strikeTotal for ${strike} present`);
  return t!;
}

function findNonFinite(x: unknown, path = "heatmap"): string | null {
  if (typeof x === "number") return Number.isFinite(x) ? null : `${path} = ${x}`;
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) { const r = findNonFinite(x[i], `${path}[${i}]`); if (r) return r; }
    return null;
  }
  if (x && typeof x === "object") {
    for (const k of Object.keys(x)) { const r = findNonFinite((x as any)[k], `${path}.${k}`); if (r) return r; }
  }
  return null;
}

// Far expiry for exact-value tests: Friday 2026-10-30, PM-settled, 18 days out
// (> 3 days, so the vendor IV is used as is).
const FAR = "2026-10-30";
const T_FAR = pmT(FAR);

// ─── 1. GEX cell: units and formula ─────────────────────────────────────────
test("1. GEX cell = +/- e^(-qT) phi(d1)/(S sigma sqrtT) x OI x 100 x S^2 x 0.01 at r = 0.05, q = 0.013", () => {
  // Clock check by hand: 18 days x 1440 + 5 h x 60 = 26,220 minutes, both instants EDT.
  assertRel(T_FAR, 26_220 / MINUTES_PER_YEAR, "T to 2026-10-30 16:00 ET from 2026-10-12 11:00 ET (Cboe minutes / 525,600)", 1e-12);
  assert.equal(FLIP_RATE, 0.05, "module rate FLIP_RATE");

  const nCall = 1234, nPut = 987, sigma = 0.18;
  const h = build(chainOf([
    { side: "C", expiry: FAR, strike: 6700, oi: nCall, ivPct: 18 },
    { side: "P", expiry: FAR, strike: 6600, oi: nPut, ivPct: 18 },
  ]));
  assert.equal(h.method.r, R, "method.r is FLIP_RATE 0.05");
  assert.equal(h.method.q, Q, "method.q is the S&P 500 yield 0.013 for $SPX");

  const gammaCall = bsGammaFP(SPOT, 6700, sigma, T_FAR, R, Q);
  const expCall = +gammaCall * nCall * MULT * SPOT * SPOT * 0.01;
  const call = cellAt(h, FAR, 6700);
  assertRel(call.gex, expCall, "call GEX = +gamma x OI x 100 x S^2 x 0.01");
  assert.ok(call.gex > 0, "call GEX positive (dealers long calls)");
  assert.equal(call.callOI, nCall);

  const gammaPut = bsGammaFP(SPOT, 6600, sigma, T_FAR, R, Q);
  const expPut = -gammaPut * nPut * MULT * SPOT * SPOT * 0.01;
  const put = cellAt(h, FAR, 6600);
  assertRel(put.gex, expPut, "put GEX = -gamma x OI x 100 x S^2 x 0.01");
  assert.ok(put.gex < 0, "put GEX negative (dealers short puts)");
  assert.equal(put.putOI, nPut);

  // Sensitivity to the basis: the same cell at q = 0 or r = 0 must differ (so the check above is not vacuous).
  const atQ0 = bsGammaFP(SPOT, 6700, sigma, T_FAR, R, 0) * nCall * MULT * SPOT * SPOT * 0.01;
  assert.ok(Math.abs(atQ0 - call.gex) > TOL * Math.abs(call.gex), "q = 0.013 vs q = 0 is resolvable at the test tolerance");
});

// ─── 2. Open interest only ──────────────────────────────────────────────────
test("2. open interest only: volume-only rows carry no exposure; volume never enters an OI row", () => {
  const n = 800;
  const h = build(chainOf([
    { side: "C", expiry: FAR, strike: 6700, oi: 0, vol: 5000 },
    { side: "P", expiry: FAR, strike: 6700, oi: 0, vol: 3000 },
    { side: "C", expiry: FAR, strike: 6800, oi: n, vol: 777 },
  ]));
  const volOnly = cellAt(h, FAR, 6700);
  for (const g of THERMAL_GREEKS) assert.equal(volOnly[g], 0, `OI = 0, volume 5000: ${g} contributes nothing`);
  assert.equal(volOnly.callVolume, 5000, "call volume reported for context");
  assert.equal(volOnly.putVolume, 3000, "put volume reported for context");
  assert.equal(volOnly.callOI, 0);
  assert.equal(volOnly.putOI, 0);
  assert.equal(h.method.contractsWithoutOI, 2, "both zero-OI rows counted as contractsWithoutOI");
  assert.equal(h.method.contractsUsed, 1, "only the OI row is used");

  const exp = longExposure(SPOT, 6800, 0.18, T_FAR, R, Q, "C", n);
  const withOI = cellAt(h, FAR, 6800);
  assertRel(withOI.gex, exp.gex, "OI row GEX = gamma x OI x 100 x S^2 x 0.01 with OI = 800 (volume 777 ignored)");
  assert.equal(withOI.callVolume, 777);
  // Same OI, different volume -> identical exposures (volume is context only).
  const h2 = build(chainOf([{ side: "C", expiry: FAR, strike: 6800, oi: n, vol: 0 }]));
  const noVol = cellAt(h2, FAR, 6800);
  for (const g of THERMAL_GREEKS) assert.equal(withOI[g], noVol[g], `${g} unchanged when volume changes 777 -> 0`);
  assert.equal(totalAt(h, 6700).total, 0, "strike total of a volume-only strike is 0");
});

// ─── 3. Dealer sign ─────────────────────────────────────────────────────────
test("3. dealer sign: calls +, puts -, cell = call part + put part, method.dealerSign {call: 1, put: -1}", () => {
  const nC = 1500, nP = 2200, K = 6700;
  const callOnly = cellAt(build(chainOf([{ side: "C", expiry: FAR, strike: K, oi: nC, ivPct: 17 }])), FAR, K);
  const putOnly = cellAt(build(chainOf([{ side: "P", expiry: FAR, strike: K, oi: nP, ivPct: 19 }])), FAR, K);
  const both = cellAt(build(chainOf([
    { side: "C", expiry: FAR, strike: K, oi: nC, ivPct: 17 },
    { side: "P", expiry: FAR, strike: K, oi: nP, ivPct: 19 },
  ])), FAR, K);
  assert.ok(callOnly.gex > 0, "call cell positive");
  assert.ok(putOnly.gex < 0, "put cell negative");
  assertRel(callOnly.gex, +bsGammaFP(SPOT, K, 0.17, T_FAR, R, Q) * nC * MULT * SPOT * SPOT * 0.01, "call part");
  assertRel(putOnly.gex, -bsGammaFP(SPOT, K, 0.19, T_FAR, R, Q) * nP * MULT * SPOT * SPOT * 0.01, "put part");
  for (const g of THERMAL_GREEKS) assertRel(both[g], callOnly[g] + putOnly[g], `cell.${g} = call part + put part`, 1e-9);
  assert.equal(both.callOI, nC);
  assert.equal(both.putOI, nP);
  const h = build(chainOf([{ side: "C", expiry: FAR, strike: K, oi: 1 }]));
  assert.deepEqual(h.method.dealerSign, { call: 1, put: -1 });
  assert.equal(h.flipInputs.dealerConvention, "naive-dealer-long-calls-short-puts");
});

// ─── 4. One basis for every greek ───────────────────────────────────────────
test("4. vanna/charm/vomma/zomma per contract: BSM with r = 0.05, q = 0.013 and the greekExposure.ts dollar units", () => {
  // Guard on this file's own closed forms: central differences of delta, vega and gamma in sigma.
  {
    const S = SPOT, K = 6650, sigma = 0.2, T = T_FAR, hs = 1e-5;
    const [d1, d2] = d12(S, K, sigma, T, R, Q);
    const vannaFD = (bsDelta(S, K, sigma + hs, T, R, Q, "C") - bsDelta(S, K, sigma - hs, T, R, Q, "C")) / (2 * hs);
    assertRel(vannaFD, -Math.exp(-Q * T) * phi(d1) * d2 / sigma, "self-check: vanna closed form vs dDelta/dsigma by finite difference", 1e-5);
    const vommaFD = (bsVegaFP(S, K, sigma + hs, T, R, Q) - bsVegaFP(S, K, sigma - hs, T, R, Q)) / (2 * hs);
    assertRel(vommaFD, bsVegaFP(S, K, sigma, T, R, Q) * d1 * d2 / sigma, "self-check: vomma closed form vs dVega/dsigma", 1e-5);
    const zommaFD = (bsGammaFP(S, K, sigma + hs, T, R, Q) - bsGammaFP(S, K, sigma - hs, T, R, Q)) / (2 * hs);
    assertRel(zommaFD, bsGammaFP(S, K, sigma, T, R, Q) * (d1 * d2 - 1) / sigma, "self-check: zomma closed form vs dGamma/dsigma", 1e-5);
  }

  const rows: Row[] = [
    { side: "C", expiry: FAR, strike: 6700, oi: 1300, ivPct: 16 },
    { side: "P", expiry: FAR, strike: 6600, oi: 2100, ivPct: 20 },
  ];
  const h = build(chainOf(rows));
  for (const row of rows) {
    const sigma = row.ivPct! / 100;
    const cell = cellAt(h, FAR, row.strike);
    const sign = dealerSign(row.side);
    const exp = longExposure(SPOT, row.strike, sigma, T_FAR, R, Q, row.side, row.oi);
    assertRel(cell.gex, sign * exp.gex, `${row.side} ${row.strike} gex`);
    assertRel(cell.vanna, sign * exp.vanna, `${row.side} ${row.strike} vanna = sign x (-e^(-qT) phi(d1) d2/sigma) x 0.01 x OI x 100 x S`);
    assertRel(cell.charm, sign * exp.charm, `${row.side} ${row.strike} charm = sign x [Delta(T-1d) - Delta(T)] x OI x 100 x S (BSM delta of the option's own type)`);
    assertRel(cell.vomma, sign * exp.vomma, `${row.side} ${row.strike} vomma = sign x (vega d1 d2/sigma) x 1e-4 x OI x 100`);
    assertRel(cell.zomma, sign * exp.zomma, `${row.side} ${row.strike} zomma = sign x gamma (d1 d2 - 1)/sigma x 0.01 x OI x 100 x S^2 x 0.01`);
    for (const g of ["vanna", "charm", "vomma", "zomma"] as const) assert.notEqual(cell[g], 0, `${g} non-zero in the fixture`);

    // Agreement with the shared helper on the SAME basis (r = 0.05, q = 0.013, type = side) ...
    const same = contractExposure({ spot: SPOT, strike: row.strike, sigma, T: T_FAR, contracts: row.oi, r: R, q: Q, type: row.side });
    assertRel(cell.vanna, sign * same.vannaPerVolPt, `${row.side} ${row.strike} vanna = contractExposure(r=0.05,q=0.013,type)`, 1e-12);
    assertRel(cell.charm, sign * same.charmPerDay, `${row.side} ${row.strike} charm = contractExposure(r=0.05,q=0.013,type)`, 1e-12);
    assertRel(cell.vomma, sign * same.vommaPerVolPt, `${row.side} ${row.strike} vomma = contractExposure(r=0.05,q=0.013,type)`, 1e-12);
    assertRel(cell.zomma, sign * same.zommaPerVolPt, `${row.side} ${row.strike} zomma = contractExposure(r=0.05,q=0.013,type)`, 1e-12);
    // ... and NOT on the helper's default r = q = 0 basis (the check above must be able to tell them apart).
    const zero = contractExposure({ spot: SPOT, strike: row.strike, sigma, T: T_FAR, contracts: row.oi });
    assert.ok(Math.abs(cell.vanna - sign * zero.vannaPerVolPt) > TOL * Math.abs(cell.vanna), `${row.side} ${row.strike} vanna differs from the r = q = 0 basis`);
  }
});

// ─── 5. Strike band ─────────────────────────────────────────────────────────
test("5. strike band: only strikes within +-15% of spot, ascending", () => {
  // 6700 x 0.85 = 5695, 6700 x 1.15 = 7705.
  const h = build(chainOf([
    { side: "C", expiry: FAR, strike: 7800, oi: 100 },
    { side: "P", expiry: FAR, strike: 5600, oi: 100 },
    { side: "C", expiry: FAR, strike: 7600, oi: 100 },
    { side: "C", expiry: FAR, strike: 6700, oi: 100 },
    { side: "P", expiry: FAR, strike: 5800, oi: 100 },
  ]));
  assert.equal(h.method.strikeBandPct, 0.15);
  assert.deepEqual(h.strikes, [5800, 6700, 7600], "strikes inside +-15% kept and sorted ascending");
  assert.deepEqual(h.strikeTotals.map((s) => s.strike), [5800, 6700, 7600], "strikeTotals follow the band");
  assert.deepEqual(h.cells.map((c) => c.strike).sort((a, b) => a - b), [5800, 6700, 7600], "no cell outside the band");
  h.cells.forEach((c) => assert.equal(c.strikeIdx, h.strikes.indexOf(c.strike), "strikeIdx indexes the sorted strike list"));
});

// ─── 6 / 7. Expiry cap, column maxima, strike totals ────────────────────────
// 14 PM-settled expiries (trading days 2026-10-13 .. 2026-10-30), inserted in a
// scrambled order. The two farthest carry enormous OI so a leak past the cap
// would dominate every maximum and total.
const DATES14 = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21",
  "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"];
const SHOWN = DATES14.slice(0, 12);
const HIDDEN = DATES14.slice(12);
const SCRAMBLE = [7, 13, 2, 11, 0, 9, 4, 12, 6, 1, 10, 3, 8, 5];
function fixture14(): Row[] {
  const rows: Row[] = [];
  for (const i of SCRAMBLE) {
    const expiry = DATES14[i];
    const hidden = i >= 12;
    rows.push({ side: i % 3 === 1 ? "P" : "C", expiry, strike: 6700, oi: hidden ? 1_000_000 : 100 * (i + 1), ivPct: 18 });
    if ([0, 5, 11, 13].includes(i)) rows.push({ side: "C", expiry, strike: 6800, oi: hidden ? 1_000_000 : 250, ivPct: 17 });
    if (i === 12) rows.push({ side: "P", expiry, strike: 7000, oi: 1_000_000, ivPct: 15 }); // strike that exists only beyond the cap
  }
  return rows;
}
/** Dealer-signed exposure of a fixture row from first principles. */
function rowExposure(row: Row): Exposure {
  const e = longExposure(SPOT, row.strike, (row.ivPct ?? 18) / 100, pmT(row.expiry), R, Q, row.side, row.oi);
  const s = dealerSign(row.side);
  return { gex: s * e.gex, vanna: s * e.vanna, charm: s * e.charm, vomma: s * e.vomma, zomma: s * e.zomma };
}

test("6. expiry cap: the 12 nearest expiries by DTE, ascending; expiries[i].maxAbs and maxAbs are column / grid maxima of |exposure|", () => {
  const rows = fixture14();
  const h = build(chainOf(rows));
  assert.equal(h.method.maxExpiries, 12);
  assert.deepEqual(h.expiries.map((e) => e.label), SHOWN, "12 nearest expiries, ascending by DTE");
  assert.deepEqual(h.expiries.map((e) => e.dte), SHOWN.map(dteOf), "dte parsed from the key");
  for (const d of HIDDEN) assert.ok(!h.cells.some((c) => c.expiry === d), `no cell for ${d} (beyond the cap)`);

  let grid = 0;
  h.expiries.forEach((e, i) => {
    const expected = Math.max(...rows.filter((r) => r.expiry === e.label).map((r) => Math.abs(rowExposure(r).gex)));
    assertRel(e.maxAbs, expected, `expiries[${i}] (${e.label}) maxAbs = max |gex| over its rows (first principles)`);
    const fromCells = Math.max(...h.cells.filter((c) => c.expIdx === i).map((c) => Math.abs(c.exposure)));
    assertRel(e.maxAbs, fromCells, `expiries[${i}] maxAbs = max |cell.exposure| in that column`, 1e-12);
    grid = Math.max(grid, expected);
  });
  assertRel(h.maxAbs, grid, "maxAbs = max over all shown columns");
  const smallestHidden = Math.min(...rows.filter((r) => HIDDEN.includes(r.expiry)).map((r) => Math.abs(rowExposure(r).gex)));
  assert.ok(h.maxAbs < smallestHidden, `no hidden-expiry OI leaked into the maxima (${h.maxAbs} < ${smallestHidden})`);
});

test("7. strikeTotals: total = sum of the greek over the SHOWN expiries only, totalAbs = sum of |values|", () => {
  const rows = fixture14();
  for (const greek of THERMAL_GREEKS) {
    const h = build(chainOf(rows), greek);
    for (const strike of [6700, 6800]) {
      const shownRows = rows.filter((r) => r.strike === strike && SHOWN.includes(r.expiry));
      const vals = shownRows.map((r) => rowExposure(r)[greek]);
      const total = vals.reduce((a, b) => a + b, 0);
      const totalAbs = vals.reduce((a, b) => a + Math.abs(b), 0);
      const st = totalAt(h, strike);
      assertRel(st.total, total, `${greek} total @ ${strike} over ${shownRows.length} shown expiries`);
      assertRel(st.totalAbs, totalAbs, `${greek} totalAbs @ ${strike}`);
      assert.ok(totalAbs > Math.abs(total) || vals.every((v) => Math.sign(v) === Math.sign(vals[0])), "fixture mixes signs where intended");
      const fromCells = h.cells.filter((c) => c.strike === strike).reduce((a, c) => a + c.exposure, 0);
      assertRel(st.total, fromCells, `${greek} total @ ${strike} = sum of the column's cells`, 1e-9);
    }
  }
});

test("7b. strikeTotals/strikes carry no row for a strike that exists only beyond the expiry cap", () => {
  const h = build(chainOf(fixture14()));
  assert.ok(!h.strikes.includes(7000), "7000 has no shown cell: a zero-total row would read as observed-zero exposure, not as hidden data");
  assert.ok(!h.strikeTotals.some((s) => s.strike === 7000));
});

// ─── 8. Levels ──────────────────────────────────────────────────────────────
const LEVEL_ROWS: Row[] = [
  { side: "P", expiry: FAR, strike: 6500, oi: 1500, ivPct: 21 },
  { side: "P", expiry: FAR, strike: 6600, oi: 4000, ivPct: 20 },
  { side: "P", expiry: FAR, strike: 6650, oi: 600, ivPct: 19 },
  { side: "P", expiry: FAR, strike: 6700, oi: 900, ivPct: 18 },
  { side: "C", expiry: FAR, strike: 6700, oi: 700, ivPct: 18 },
  { side: "C", expiry: FAR, strike: 6750, oi: 500, ivPct: 17 },
  { side: "C", expiry: FAR, strike: 6800, oi: 3000, ivPct: 16 },
  { side: "C", expiry: FAR, strike: 6900, oi: 1200, ivPct: 15 },
];
/** Net dealer GEX at a hypothetical spot S, every contract re-priced (Perfiliev / SpotGamma zero-gamma method). */
function netGexAt(rows: Row[], S: number): number {
  let total = 0;
  for (const r of rows) {
    total += dealerSign(r.side) * bsGammaFP(S, r.strike, (r.ivPct ?? 18) / 100, pmT(r.expiry), R, Q) * r.oi * MULT * S * S * 0.01;
  }
  return total;
}

test("8. levels: call wall = max positive total at/above spot, put wall = min total at/below spot, flip = re-priced zero crossing", () => {
  const chain = chainOf(LEVEL_ROWS);
  const h = build(chain);
  // Expected totals per strike from first principles (single expiry: everything is shown).
  const totals = new Map<number, number>();
  for (const r of LEVEL_ROWS) totals.set(r.strike, (totals.get(r.strike) ?? 0) + rowExposure(r).gex);
  let callWall: number | null = null, callV = 0, putWall: number | null = null, putV = 0;
  for (const [k, v] of totals) {
    if (k >= SPOT && v > callV) { callV = v; callWall = k; }
    if (k <= SPOT && v < putV) { putV = v; putWall = k; }
  }
  assert.equal(h.levels.callWall, callWall, "call wall strike");
  assertRel(h.levels.callWallValue, callV, "call wall value = that strike's net total");
  assert.equal(h.levels.putWall, putWall, "put wall strike");
  assertRel(h.levels.putWallValue, putV, "put wall value = that strike's net total");
  assert.ok(h.levels.putWall! < SPOT && h.levels.callWall! > SPOT, "walls bracket spot in this fixture");

  // Flip: bracketed from first principles (net gamma negative at the put cluster, positive at the call cluster) ...
  const flip = h.levels.gammaFlip;
  assert.ok(flip != null, "flip found");
  assert.ok(netGexAt(LEVEL_ROWS, 6600) < 0 && netGexAt(LEVEL_ROWS, 6800) > 0, "fixture: net gamma changes sign between 6600 and 6800");
  assert.ok(flip! > 6600 && flip! < 6800, `flip ${flip} between the put and call clusters`);
  assert.ok(flip! >= h.strikes[0] && flip! <= h.strikes[h.strikes.length - 1], "flip inside the shown strike range");
  // ... is a root of the re-priced sum ...
  let peak = 0;
  for (let S = 0.9 * SPOT; S <= 1.1 * SPOT; S += SPOT / 1000) peak = Math.max(peak, Math.abs(netGexAt(LEVEL_ROWS, S)));
  assert.ok(Math.abs(netGexAt(LEVEL_ROWS, flip!)) < 1e-6 * peak, `net re-priced GEX at the flip is ~0 (|${netGexAt(LEVEL_ROWS, flip!)}| vs peak ${peak})`);
  // ... and equals the shared helper on the same basis and universe.
  const ref = repricedFlipFromChain(chain, SPOT, {
    r: R, q: Q, nowMs: NOW, expiryKeys: [keyOf(FAR)],
    weight: (c: any) => Math.max(0, Math.round(Number(c?.openInterest) || 0)),
  }).zeroGamma;
  assert.equal(flip, ref, "gammaFlip = repricedFlipFromChain(... r, q, nowMs, shown keys, OI weight).zeroGamma");

  // Per-strike net GEX agrees in sign and value with gexByStrikeFromChain (FLIP_RATE / FLIP_DIV_YIELD basis, same as $SPX here).
  const g = gexByStrikeFromChain(chain, NOW);
  assert.equal(g.dataState, "ok");
  assert.equal(g.profile.length, h.strikeTotals.length, "same strike universe (single expiry, all inside the band)");
  for (const p of g.profile) {
    const st = totalAt(h, p.strike);
    assert.equal(Math.sign(st.total), Math.sign(p.netGex), `sign of net GEX @ ${p.strike}`);
    assertRel(st.total, p.netGex, `net GEX @ ${p.strike} vs gexByStrikeFromChain.profile`);
  }
  // Other greeks: no levels.
  const hv = build(chain, "vanna");
  assert.deepEqual(hv.levels, { callWall: null, callWallValue: 0, putWall: null, putWallValue: 0, gammaFlip: null }, "levels only for gex");
});

// ─── 9. Settled contracts ───────────────────────────────────────────────────
// AM-settled SPX series settle at the 09:30 ET SOQ; at 11:00 ET on expiry day
// they are gone (T = 0) and carry no gamma.
const SETTLED: Row = { side: "C", expiry: TODAY, strike: 6700, oi: 5000, vol: 0, root: "SPX", settlementType: "A" };
const SETTLED_VOL: Row = { side: "P", expiry: TODAY, strike: 6800, oi: 5000, vol: 40, root: "SPX", settlementType: "A" };
const LIVE: Row = { side: "C", expiry: FAR, strike: 6700, oi: 100 };

test("9. settled contracts: an expiry whose settlement instant is before nowMs contributes nothing", () => {
  const h = build(chainOf([SETTLED, LIVE]));
  const live = longExposure(SPOT, 6700, 0.18, T_FAR, R, Q, "C", 100);
  assertRel(totalAt(h, 6700).total, live.gex, "strike total holds only the live contract");
  assert.ok(!h.cells.some((c) => c.expiry === TODAY && (c.gex !== 0 || c.callOI !== 0)), "no exposure or OI from the settled contract");
  assertRel(h.maxAbs, live.gex, "maxAbs from the live contract only");
  // A still-live PM-settled contract on the same date (16:00 ET) does count: same date, different settlement instant.
  const pm: Row = { side: "C", expiry: TODAY, strike: 6700, oi: 300, ivPct: 18 };
  const h2 = build(chainOf([SETTLED, pm]));
  const T0 = pmT(TODAY); // 5 h = 300 minutes
  assertRel(T0, 300 / MINUTES_PER_YEAR, "T for the PM contract: 300 minutes", 1e-12);
  assertRel(cellAt(h2, TODAY, 6700).gex, longExposure(SPOT, 6700, 0.18, T0, R, Q, "C", 300).gex, "PM-settled same-day contract priced with 300 minutes left");
  assert.equal(cellAt(h2, TODAY, 6700).callOI, 300, "callOI counts only the live PM contract");
});

test("9b. settled contracts leave no phantom column or strike", () => {
  const h = build(chainOf([SETTLED, SETTLED_VOL, LIVE]));
  assert.deepEqual(h.expiries.map((e) => e.label), [FAR], "an expiry with nothing live is not a column (it would also consume one of the 12 slots)");
  assert.ok(!h.strikes.includes(6800), "a strike seen only on settled contracts is not a row");
});

test("9c. method counts account for every contract with OI or volume (settled rows are not silently dropped)", () => {
  const h = build(chainOf([SETTLED, SETTLED_VOL, LIVE]));
  // 3 contracts have OI or volume; 'used' + 'withoutOI' must explain them all, or the panel reports a count that hides missing data.
  const m = h.method;
  assert.equal(m.contractsUsed + m.contractsWithoutOI + m.contractsSettled + m.contractsNoSigma, 3,
    `used ${m.contractsUsed} + withoutOI ${m.contractsWithoutOI} + settled ${m.contractsSettled} + noSigma ${m.contractsNoSigma} should account for 3 contracts (2 settled with OI, 1 live)`);
  assert.equal(m.contractsSettled, 2, "the two settled contracts are reported as settled, not silently dropped");
  assert.equal(h.dataState, "ok");
});

// ─── 10. Determinism and shape ──────────────────────────────────────────────
test("10. determinism and shape: deep-equal rebuild, exposure = cell[greek], weightMode oi, units for all five greeks", () => {
  const chain = chainOf(LEVEL_ROWS);
  for (const greek of THERMAL_GREEKS) {
    const a = build(chain, greek), b = build(chain, greek);
    assert.deepEqual(a, b, `${greek}: same inputs, same output`);
    assert.equal(a.greek, greek);
    assert.ok(a.cells.length > 0);
    for (const c of a.cells) assert.equal(c.exposure, c[greek], `${greek}: cell.exposure = cell.${greek}`);
    assert.equal(a.weightMode, "oi");
    assert.deepEqual(Object.keys(a.method.units).sort(), [...THERMAL_GREEKS].sort(), "method.units names all five greeks");
    for (const g of THERMAL_GREEKS) assert.ok(a.method.units[g].includes("$"), `units[${g}] states a dollar unit`);
    assert.equal(a.method.position, "open_interest");
    assert.equal(a.asOf, NOW);
    assert.equal(a.spot, SPOT);
    assert.equal(a.symbol, "$SPX");
    for (const c of a.cells) {
      assert.equal(a.expiries[c.expIdx].label, c.expiry, "expIdx indexes expiries");
      assert.equal(a.strikes[c.strikeIdx], c.strike, "strikeIdx indexes strikes");
    }
  }
});

// ─── 11. Demo chain sanity ──────────────────────────────────────────────────
test("11. demo $SPX chain: put wall < spot < call wall, flip inside the strikes, finite everywhere, cells sum to strike totals", () => {
  const ch = demoChain({ symbol: "$SPX", contractType: "ALL", strikeCount: 120, fromDate: "2026-10-12", toDate: "2026-10-23" }, NOW);
  assert.equal(ch.status, "SUCCESS");
  const S = ch.underlying.last;
  const h = buildThermalHeatmap(ch, "$SPX", S, "gex", { nowMs: NOW });
  assert.ok(h.cells.length > 0, "cells present");
  assert.equal(findNonFinite(h), null, "no NaN / Infinity anywhere in the payload");
  assert.ok(h.levels.putWall != null && h.levels.putWall < S, `put wall ${h.levels.putWall} below spot ${S}`);
  assert.ok(h.levels.callWall != null && h.levels.callWall > S, `call wall ${h.levels.callWall} above spot ${S}`);
  assert.ok(h.levels.putWallValue < 0 && h.levels.callWallValue > 0, "wall values carry the dealer sign");
  assert.ok(h.levels.gammaFlip != null && h.levels.gammaFlip >= h.strikes[0] && h.levels.gammaFlip <= h.strikes[h.strikes.length - 1],
    `flip ${h.levels.gammaFlip} inside [${h.strikes[0]}, ${h.strikes[h.strikes.length - 1]}]`);
  const cellSum = h.cells.reduce((a, c) => a + c.gex, 0);
  const totalSum = h.strikeTotals.reduce((a, s) => a + s.total, 0);
  assertRel(cellSum, totalSum, "sum of gex over cells = sum of strikeTotals.total", 1e-9);
  assert.equal(h.method.contractsUsed + h.method.contractsWithoutOI, ch.numberOfContracts, "every demo contract is accounted for");
  assert.equal(h.expiries.length, Object.keys(ch.callExpDateMap).length, "10 demo expiries (<= 12) all shown");
  assert.ok(h.expiries.every((e, i) => i === 0 || e.dte > h.expiries[i - 1].dte), "ascending DTE");
  // Per-cell cross-check on a far (> 3 day) expiry where sigma is the vendor IV: first-principles GEX from the chain row.
  const ek = Object.keys(ch.callExpDateMap).find((k) => k.startsWith("2026-10-23"))!;
  const c = ch.callExpDateMap[ek][h.strikes[Math.floor(h.strikes.length / 2)].toFixed(1)][0];
  const p = ch.putExpDateMap[ek][c.strikePrice.toFixed(1)][0];
  const T = (etWallToEpochMs("2026-10-23", 16 * 60) - NOW) / 60_000 / MINUTES_PER_YEAR;
  const expected = bsGammaFP(S, c.strikePrice, c.volatility / 100, T, R, Q) * c.openInterest * MULT * S * S * 0.01
    - bsGammaFP(S, p.strikePrice, p.volatility / 100, T, R, Q) * p.openInterest * MULT * S * S * 0.01;
  assertRel(cellAt(h, "2026-10-23", c.strikePrice).gex, expected, `demo cell 2026-10-23 @ ${c.strikePrice} from the row's vendor IV and OI`);
});

// ─── 12. Vendor sentinels ───────────────────────────────────────────────────
test("12. Schwab -999 sentinels (closed market: volatility -999, gamma -999) are missing data, not exposure", () => {
  const h = build(chainOf([{ side: "C", expiry: FAR, strike: 6700, oi: 100, ivPct: -999, gamma: -999 }]));
  const cell = h.cells.find((c) => c.strike === 6700);
  const gex = cell?.gex ?? 0;
  assert.equal(gex, 0, `no usable sigma and a sentinel gamma must not price: got gex ${gex} (= -999 x 100 x 100 x S^2 x 0.01 would be ${-999 * 100 * MULT * SPOT * SPOT * 0.01})`);
  assert.equal(h.method.contractsUsed, 0, "a contract with no usable greeks is not 'used'");
});
