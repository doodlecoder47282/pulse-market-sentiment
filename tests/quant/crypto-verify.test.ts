// Crypto desk live verification (shared/cryptoVerify.ts): consistent payloads
// pass, a planted gate breach, sizing error, desk-risk disagreement or
// expectancy label fails, and absent inputs report unavailable/skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateChecks, deskRiskCheck, expectancyChecks } from "../../shared/cryptoVerify";
import { CRYPTO_RULES } from "../../shared/cryptoRules";
import { tradeCost } from "../../shared/memeStructure";

const byId = (cs: { id: string; state: string }[]) => Object.fromEntries(cs.map((c) => [c.id, c.state]));

const enter = (over: Record<string, unknown> = {}) => {
  const liq = 40_000;
  const size = Math.floor(Math.min(liq * CRYPTO_RULES.sizing.poolShare, CRYPTO_RULES.sizing.maxPositionUsd));
  return {
    symbol: "TEST", verdict: "ENTER", liquidityUsd: liq, marketCap: 400_000, mintAuthorityActive: false, freezeAuthorityActive: false,
    top10Pct: 22, jupState: "agree", score: 80, volAccel: 2.1, netBuyRatio5m: 0.66,
    risk: { maxPositionUsd: size, estSlippagePct: tradeCost({ liquidityUsd: liq, sizeUsd: size }).roundTripPct },
    ...over,
  };
};

test("ENTER gates: a clean ENTER row passes; any breached gate fails and names it", () => {
  assert.deepEqual(byId(candidateChecks([enter()], { state: "on" })), { "crypto.gates": "pass", "crypto.sizing": "pass", "crypto.cost": "pass" });
  for (const bad of [
    { mintAuthorityActive: true }, { top10Pct: null }, { jupState: "failed" }, { liquidityUsd: 5_000 }, { score: 60 }, { marketCap: 2_000_000 },
  ]) {
    const r = candidateChecks([enter(bad)], { state: "on" });
    assert.equal(r[0].state, "fail", JSON.stringify(bad));
  }
  assert.equal(candidateChecks([enter()], { state: "off" })[0].state, "fail", "desk off cannot carry an ENTER");
  assert.equal(candidateChecks([enter({ verdict: "WATCH" })], { state: "off" })[0].state, "skipped");
  assert.equal(candidateChecks(null, null)[0].state, "unavailable");
});

test("sizing and cost: a wrong size or a wrong round-trip on the card fails", () => {
  const r1 = byId(candidateChecks([enter({ risk: { maxPositionUsd: 999, estSlippagePct: 5 } })], { state: "on" }));
  assert.equal(r1["crypto.sizing"], "fail");
  assert.equal(r1["crypto.cost"], "fail");
});

test("desk risk: the signals state must equal the arithmetic on the majors payload; stale is unknown", () => {
  const now = 1_700_000_000_000;
  const majors = (mid: number, vwap: number, state = "ok") => ({ state: "ok", rows: [{ asset: "BTC", kraken: { state, mid, vwap24h: vwap }, coinbase: { state: "ok", mid: null } }] });
  assert.equal(deskRiskCheck({ state: "on", btcVsVwap24hPct: -1, asOf: now - 60_000 }, majors(99_000, 100_000), now).state, "pass");
  assert.equal(deskRiskCheck({ state: "on", btcVsVwap24hPct: -1, asOf: now - 60_000 }, majors(90_000, 100_000), now).state, "fail");
  assert.equal(deskRiskCheck({ state: "off", btcVsVwap24hPct: -10, asOf: now - 60_000 }, majors(90_000, 100_000), now).state, "pass");
  assert.equal(deskRiskCheck({ state: "unknown", btcVsVwap24hPct: null, asOf: now - 60_000 }, majors(90_000, 100_000, "stale"), now).state, "pass");
  assert.equal(deskRiskCheck({ state: "on", btcVsVwap24hPct: -1, asOf: now - 20 * 60_000 }, majors(99_000, 100_000), now).state, "fail", "a 20-minute-old read must be unknown");
  assert.equal(deskRiskCheck(null, null, now).state, "unavailable");
});

test("expectancy bookkeeping: shares, gate and label agree with the rule book", () => {
  const s = (n: number, noData: number, validation: string, over: Record<string, unknown> = {}) => ({
    n, noData, noDataShare: n + noData ? Math.round((noData / (n + noData)) * 1000) / 1000 : null, maxNoDataShare: CRYPTO_RULES.grading.maxNoDataShare,
    minSample: CRYPTO_RULES.grading.minSample, sampleReady: n >= CRYPTO_RULES.grading.minSample, validation, ...over,
  });
  const ok = expectancyChecks({ graded: s(60, 5, "MIXED RESULTS"), hold: s(10, 0, "INSUFFICIENT DATA"), peak: s(60, 5, "PASSES PREDEFINED TESTS") });
  assert.ok(ok.every((c) => c.state === "pass"), JSON.stringify(ok));
  const bad = expectancyChecks({ graded: s(60, 40, "PASSES PREDEFINED TESTS"), hold: s(10, 0, "MIXED RESULTS"), peak: s(60, 5, "MIXED RESULTS", { noDataShare: 0.5 }) });
  assert.deepEqual(byId(bad), { "crypto.expectancy.graded": "fail", "crypto.expectancy.hold": "fail", "crypto.expectancy.peak": "fail" });
  assert.equal(expectancyChecks(null)[0].state, "unavailable");
});
