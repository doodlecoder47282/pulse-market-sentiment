// Per-candidate observation history: liquidity velocity is measured over the
// readings it has (never extrapolated, never a number from too few), and the
// exit-cost stress is constant-product arithmetic at stated depths.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendObservation, exitCostStress, liquidityVelocity, HISTORY_CAP, VELOCITY_MIN_READINGS, STRESS_RUIN_PCT } from "../../shared/cryptoHistory";
import { tradeCost } from "../../shared/memeStructure";

const obs = (at: number, liq: number | null) => ({ at, liquidityUsd: liq, marketCap: 100_000, top10Pct: null });

test("history: one row per refresh, same instant not repeated, ring of 60", () => {
  let h = appendObservation(null, obs(1000, 20_000));
  h = appendObservation(h, obs(1000, 20_000));
  assert.equal(h.length, 1, "a re-score without a new read is not a new observation");
  for (let i = 1; i <= 80; i++) h = appendObservation(h, obs(1000 + i * 60_000, 20_000));
  assert.equal(h.length, HISTORY_CAP);
  assert.equal(h[0].at, 1000 + 21 * 60_000);
});

test("velocity: unavailable / insufficient / measured, with the span and worst step", () => {
  const now = 10 * 3600_000;
  assert.equal(liquidityVelocity([], 3600_000, now).state, "unavailable");
  const two = [obs(now - 20 * 60_000, 40_000), obs(now - 10 * 60_000, 30_000)];
  const v2 = liquidityVelocity(two, 3600_000, now);
  assert.equal(v2.state, "insufficient");
  assert.equal(v2.changePct, null, "no number from fewer than the minimum readings");
  assert.match(v2.text, new RegExp(`2 readings, ${VELOCITY_MIN_READINGS} needed`));
  const pulled = [obs(now - 50 * 60_000, 40_000), obs(now - 30 * 60_000, 38_000), obs(now - 10 * 60_000, 20_000)];
  const v = liquidityVelocity(pulled, 3600_000, now);
  assert.equal(v.state, "ok");
  assert.equal(v.changePct, -50);
  assert.equal(v.spanMinutes, 40, "the span is first-to-last reading, not the window");
  assert.ok(v.worstStepPct != null && v.worstStepPct < -47 && v.worstStepPct > -48);
  assert.match(v.text, /liquidity pulled -50% over 40 min \(3 readings, worst single step -47\.4%\)/);
  // Readings outside the window are not used; a null liquidity reading is skipped, not read as zero.
  const old = [obs(now - 5 * 3600_000, 1), ...pulled, obs(now - 5 * 60_000, null)];
  assert.equal(liquidityVelocity(old, 3600_000, now).changePct, -50);
  const flat = liquidityVelocity([obs(now - 30 * 60_000, 40_000), obs(now - 20 * 60_000, 40_100), obs(now - 10 * 60_000, 40_200)], 3600_000, now);
  assert.match(flat.text, /liquidity flat \+0\.5%/);
  // From $0: a percent is undefined, and that is said, not "unreadable".
  const fromZero = liquidityVelocity([obs(now - 30 * 60_000, 0), obs(now - 20 * 60_000, 5_000), obs(now - 10 * 60_000, 8_000)], 3600_000, now);
  assert.equal(fromZero.state, "ok");
  assert.match(fromZero.text, /from \$0 \(percent undefined\) to \$8,000/);
});

test("exit stress: the same arithmetic as the card's round trip, at each pulled depth; 100% pull is no exit", () => {
  const s = exitCostStress(40_000, 200);
  assert.equal(s.state, "ok");
  assert.deepEqual(s.rows.map((r) => r.pullPct), [0, 25, 50, 75, 100]);
  assert.equal(s.rows[0].cost.roundTripPct, tradeCost({ liquidityUsd: 40_000, sizeUsd: 200 }).roundTripPct);
  assert.equal(s.rows[2].cost.roundTripPct, tradeCost({ liquidityUsd: 20_000, sizeUsd: 200 }).roundTripPct);
  // Cost rises monotonically as depth is pulled.
  const costs = s.rows.slice(0, 4).map((r) => r.cost.roundTripPct as number);
  for (let i = 1; i < costs.length; i++) assert.ok(costs[i] > costs[i - 1]);
  assert.equal(s.rows[4].cost.dataState, "observed_zero");
  assert.equal(s.firstRuinousPullPct, 100, `$200 in a $40k pool is not ruinous until the pool is gone (ruin = ${STRESS_RUIN_PCT}% of size)`);
  assert.match(s.text, /not a forecast that liquidity will move/);
  // A big position in a thin pool: ruin arrives at a partial pull.
  const thin = exitCostStress(4_000, 1_000);
  assert.equal(thin.firstRuinousPullPct, 0, "already ruinous with no pull: says 0, not 25");
  const mid = exitCostStress(6_000, 1_000);
  assert.equal(mid.firstRuinousPullPct, 50, "41% unpulled, 48% at 25%, 58% at 50%: ruin is reached at the 50% pull");
  // One rounding on both lines: the card's round trip is tradeCost's two decimals.
  assert.match(s.text, /0% → \d+\.\d\d%/);
  assert.equal(exitCostStress(null, 200).state, "unavailable");
  assert.equal(exitCostStress(0, 200).state, "unavailable");
});

test("wiring: an observation per refresh, derived readouts on structure, raw ring not served", () => {
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.match(e, /c\.lastRefreshAt = Date\.now\(\);\s*c\.observations = appendObservation\(c\.observations, \{ at: c\.lastRefreshAt, liquidityUsd: c\.liquidityUsd, marketCap: capOf\(c\)\.cap, top10Pct: c\.top10Pct \}\);/);
  assert.match(e, /liquidityVelocity: liquidityVelocity\(c\.observations, 60 \* 60_000, Date\.now\(\)\),/);
  assert.match(e, /exitStress: exitCostStress\(c\.liquidityUsd, c\.risk \? Math\.max\(1, c\.risk\.maxPositionUsd\) : 100\),/);
  assert.match(e, /\.map\(\(\{ observations: _obs, \.\.\.rest \}\) => \(\{ \.\.\.rest, observationCount: _obs\.length \}\)\)/);
  const p = readFileSync(new URL("../../client/src/components/CryptoPanel.tsx", import.meta.url), "utf8");
  assert.match(p, /data-testid=\{`crypto-liq-history-/);
  assert.match(p, /\(arithmetic at each depth, not a forecast\)/);
  assert.match(p, /<= CRYPTO_RULES\.sizing\.liquidityExitStopPct \? "text-amber-300\/90"/, "the colour follows the book's liquidity stop");
});
