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
