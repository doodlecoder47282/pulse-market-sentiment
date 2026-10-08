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
