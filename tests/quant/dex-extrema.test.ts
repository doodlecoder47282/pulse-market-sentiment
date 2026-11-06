// Chain audit DEX extremes: only a strike that IS positive (negative) is reported.
import test from "node:test";
import assert from "node:assert/strict";
import { computeDEX } from "../../server/chainAudit.ts";

const c = (strike: number, side: "call" | "put", delta: number | null, oi: number): any =>
  ({ strike, side, expiry: "2026-11-06", dte: 0, style: "PM", tYears: 0.001, delta, gamma: 0, theta: 0, vega: 0, rho: 0, iv: 0.2, theoreticalIV: null, oi });

test("DEX extremes: every strike netting to zero reports no extreme (was 'strike 2,000, $0')", () => {
  const zeroOi = computeDEX([c(2000, "call", 0.5, 0), c(2000, "put", -0.5, 0), c(2005, "call", 0.4, 0)], 2002);
  assert.equal(zeroOi.maxPositive, null);
  assert.equal(zeroOi.maxNegative, null);
  const noDelta = computeDEX([c(2000, "call", null, 10)], 2002);
  assert.equal(noDelta.maxPositive, null);
  assert.equal(noDelta.maxNegative, null);
});

test("DEX extremes: only one sign present reports only that side", () => {
  const callsOnly = computeDEX([c(100, "call", 0.6, 10), c(105, "call", 0.4, 30)], 102);
  assert.equal(callsOnly.maxPositive!.strike, 105);
  assert.equal(callsOnly.maxNegative, null, "no negative strike exists");
  const mixed = computeDEX([c(100, "put", -0.4, 50), c(105, "call", 0.5, 10), c(110, "put", -0.1, 5)], 104);
  assert.equal(mixed.maxNegative!.strike, 100);
  assert.ok(mixed.maxNegative!.value < 0);
  assert.equal(mixed.maxPositive!.strike, 105);
  assert.ok(mixed.maxPositive!.value > 0);
});
