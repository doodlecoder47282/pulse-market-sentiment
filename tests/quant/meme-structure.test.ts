// tests/quant/meme-structure.test.ts
//
// First-principles checks of shared/memeStructure.ts: constant-product impact
// derived independently from reserves, the published compounding table, the
// range / survival counter on synthetic series, the three-category rules with
// missing inputs reported as missing, and the hold-vs-rotate arithmetic
// reproducing the published example only under perfect timing and zero cost.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tradeCost, zeroEdgeBalance, maxSizeAtImpact, linePosition, classifyMeme, rangeStats, rotationIllustration,
  ROTATION_EXAMPLE, COMMUNITY_MIN_AGE_DAYS, COMMUNITY_MIN_LIQUIDITY_USD, DEEP_DIP_PCT, type DailyBar,
} from "../../shared/memeStructure";

const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

// ── Execution cost ────────────────────────────────────────────────────────────
test("constant product, no fees: impact derived from reserves matches the module", () => {
  // Pool: Q = $50,000 quote, B = 1,000,000 tokens, p0 = 0.05. Buy with x = $1,000.
  const Q = 50_000, B = 1_000_000, x = 1_000;
  const tokens = (B * x) / (Q + x);                  // 19,607.84
  const p0 = Q / B;
  // Price impact as Uniswap / Jupiter define it: value shortfall against the quote.
  const impactBuy = 1 - (tokens * p0) / x;           // x/(Q+x) = 0.019608
  const p1 = (Q + x) / (B - tokens);                 // pool price after the buy
  const priceMove = p1 / p0 - 1;                     // (1+x/Q)^2 - 1 = 0.0404
  // Zero-edge sell: the quote is back at p0 with the same depth; sell `tokens` into Q, B.
  const sellGross = (Q * tokens) / (B + tokens);
  const impactSell = 1 - sellGross / (tokens * p0);  // v0/(Q+v0) = 0.019231
  const r = tradeCost({ liquidityUsd: 2 * Q, sizeUsd: x, dexFeePct: 0, platformFeePct: 0, priorityFeeUsd: 0 });
  assert.equal(r.dataState, "ok");
  close(r.impactBuyPct!, 100 * impactBuy, 0.01);
  close(r.priceMoveAfterBuyPct!, 100 * priceMove, 0.01);
  close(r.impactSellPct!, 100 * impactSell, 0.01);
  // All-in loss: x - sellGross, which is 2x/(Q+2x) of x.
  close(r.roundTripPct!, 100 * (1 - sellGross / x), 0.01);
  close(r.roundTripPct!, (100 * 2 * x) / (Q + 2 * x), 0.01);
  // Break-even: selling the tokens at quote p0·(1+m) into a pool of the same depth returns x.
  const m = r.breakEvenMovePct! / 100;
  const v = tokens * p0 * (1 + m);
  const net = (Q * v) / (Q + v);
  close(net, x, x * 2e-4);
});

test("fees and priority: both swaps pay, break-even solves against net proceeds", () => {
  const r = tradeCost({ liquidityUsd: 100_000, sizeUsd: 1_000, dexFeePct: 0.25, platformFeePct: 1, priorityFeeUsd: 0.25 });
  assert.equal(r.feesRoundTripPct, 2.5);
  assert.equal(r.priorityRoundTripUsd, 0.5);
  // Reproduce the break-even from the model's own definitions.
  const feeFrac = 0.0125, Q = 50_000;
  const x = 1_000 * (1 - feeFrac) - 0.25;
  const v0 = (Q * x) / (Q + x);
  const m = r.breakEvenMovePct! / 100;
  const v = v0 * (1 + m);
  const net = ((Q * v) / (Q + v)) * (1 - feeFrac) - 0.25;
  close(net, 1_000, 0.2);
  assert.ok(r.breakEvenMovePct! > r.roundTripPct!, "break-even move exceeds the round-trip cost because the sell pays on the larger amount");
  assert.ok(r.roundTripPct! > 6 && r.roundTripPct! < 7, `${r.roundTripPct}`);
  // No break-even when the pool's depth caps the proceeds under the size.
  assert.equal(tradeCost({ liquidityUsd: 2_000, sizeUsd: 1_000, dexFeePct: 0, platformFeePct: 0, priorityFeeUsd: 0 }).breakEvenMovePct, null);
  assert.equal(tradeCost({ liquidityUsd: 100, sizeUsd: 1, dexFeePct: 1, platformFeePct: 1, priorityFeeUsd: 1 }).dataState, "below_fees");
});

test("impact scales with size over depth: a tenth of the size has a tenth of the impact; deeper pools cost less", () => {
  const a = tradeCost({ liquidityUsd: 100_000, sizeUsd: 1_000, dexFeePct: 0, platformFeePct: 0, priorityFeeUsd: 0 });
  const b = tradeCost({ liquidityUsd: 100_000, sizeUsd: 100, dexFeePct: 0, platformFeePct: 0, priorityFeeUsd: 0 });
  const c = tradeCost({ liquidityUsd: 1_000_000, sizeUsd: 1_000, dexFeePct: 0, platformFeePct: 0, priorityFeeUsd: 0 });
  // x/(Q+x): 1000/51000 = 1.961%, 100/50100 = 0.1996%, 1000/501000 = 0.1996%
  close(a.impactBuyPct!, 1.96, 0.01);
  close(b.impactBuyPct!, 0.2, 0.01);
  close(c.impactBuyPct!, 0.2, 0.01);
  assert.ok(a.roundTripPct! > b.roundTripPct! && a.roundTripPct! > c.roundTripPct!);
});

test("data states: liquidity missing is unavailable, zero is observed zero, no size is invalid; none of them is a cost of 0", () => {
  assert.equal(tradeCost({ liquidityUsd: null, sizeUsd: 100 }).dataState, "unavailable");
  assert.equal(tradeCost({ liquidityUsd: null, sizeUsd: 100 }).roundTripPct, null);
  assert.equal(tradeCost({ liquidityUsd: 0, sizeUsd: 100 }).dataState, "observed_zero");
  assert.equal(tradeCost({ liquidityUsd: 50_000, sizeUsd: 0 }).dataState, "invalid");
  assert.equal(tradeCost({ liquidityUsd: 50_000, sizeUsd: Number.NaN }).dataState, "invalid");
});

test("published compounding table: $1,000, 100 zero-edge trades at 2 / 4 / 6 / 10% per round trip", () => {
  assert.equal(Math.round(zeroEdgeBalance(1_000, 2, 100)), 133);
  assert.equal(Math.round(zeroEdgeBalance(1_000, 4, 100)), 17);
  assert.equal(Math.round(zeroEdgeBalance(1_000, 6, 100)), 2);
  close(zeroEdgeBalance(1_000, 10, 100), 0.03, 0.005);
  assert.equal(zeroEdgeBalance(1_000, 6, 0), 1_000);
  close(zeroEdgeBalance(1_000, 6, 1), 940, 1e-9);
});

test("largest size at a given impact: x/(Q+x) = f gives x = Q f/(1-f)", () => {
  assert.equal(maxSizeAtImpact(100_000, 1), Math.floor(50_000 * (0.01 / 0.99)));   // 505
  assert.equal(maxSizeAtImpact(100_000, 2), Math.floor(50_000 * (0.02 / 0.98)));   // 1020
  assert.equal(maxSizeAtImpact(8_000, 5), Math.floor(4_000 * (0.05 / 0.95)));      // 210
  assert.equal(maxSizeAtImpact(100_000, 100), null);
  assert.equal(maxSizeAtImpact(null, 1), null);
  assert.equal(maxSizeAtImpact(0, 1), null);
  assert.equal(maxSizeAtImpact(100_000, 0), null);
  // Consistency with tradeCost: that size produces that impact (no fees).
  const r = tradeCost({ liquidityUsd: 100_000, sizeUsd: 505, dexFeePct: 0, platformFeePct: 0, priorityFeeUsd: 0 });
  close(r.impactBuyPct!, 1, 0.01);
});

// ── Food chain ────────────────────────────────────────────────────────────────
test("line position: four groups ahead in the first day, three in the first week, none named after; age missing is unknown", () => {
  assert.equal(linePosition(10, true).phase, "first-hour");
  assert.equal(linePosition(10, true).ahead.length, 4);
  assert.match(linePosition(10, true).note, /fifth in line/);
  assert.equal(linePosition(600, false).phase, "first-day");
  assert.equal(linePosition(3 * 1440, false).phase, "first-week");
  assert.equal(linePosition(3 * 1440, false).ahead.length, 3);
  assert.equal(linePosition(40 * 1440, false).phase, "settled");
  assert.equal(linePosition(40 * 1440, false).ahead.length, 0);
  assert.equal(linePosition(null, false).phase, "unknown");
});

// ── Categories ────────────────────────────────────────────────────────────────
const base = { name: "Plain Coin", symbol: "PLAIN", ageDays: 0.3, liquidityUsd: 50_000, top10Pct: 20, mintAuthorityActive: false, narrativeHits: [] as string[], history: null };

test("categories: news trigger on a young pool is speculative; a template name is meta; otherwise new-launch then maturing", () => {
  assert.equal(classifyMeme({ ...base, narrativeHits: ["elon"] }).category, "speculative");
  assert.equal(classifyMeme({ ...base, name: "Pepe 2.0" }).category, "meta");
  assert.equal(classifyMeme({ ...base, name: "Baby Doge" }).category, "meta");
  assert.equal(classifyMeme({ ...base, symbol: "FEESHARE", name: "Fee Share Coin" }).category, "meta");
  assert.equal(classifyMeme({ ...base }).category, "new-launch");
  assert.equal(classifyMeme({ ...base, ageDays: 12 }).category, "maturing");
  // News beats the name pattern (a trigger is the stronger structural fact).
  assert.equal(classifyMeme({ ...base, name: "Elon 2.0", narrativeHits: ["elon"] }).category, "speculative");
});

test("categories: community needs 30+ days, $100k+ liquidity, top-10 at or under 30%, no active mint; history makes it firm", () => {
  const aged = { ...base, ageDays: COMMUNITY_MIN_AGE_DAYS + 5, liquidityUsd: COMMUNITY_MIN_LIQUIDITY_USD + 1, top10Pct: 18, mintAuthorityActive: false };
  const t = classifyMeme(aged);
  assert.equal(t.category, "community");
  assert.equal(t.confidence, "tentative");
  assert.ok(t.missing.includes("history"));
  const hist = rangeStats(series([100, 300, 90, 310, 200, 250].concat(new Array(40).fill(250))));
  const f = classifyMeme({ ...aged, history: hist });
  assert.equal(f.category, "community");
  assert.equal(f.confidence, "firm");
  assert.match(f.reasons.join(" | "), /1 dip of 70%\+ reclaimed/);
  // Fails the depth / supply test: aged but not community.
  assert.equal(classifyMeme({ ...aged, liquidityUsd: 20_000 }).category, "unclassified");
  assert.equal(classifyMeme({ ...aged, top10Pct: 55 }).category, "unclassified");
  assert.equal(classifyMeme({ ...aged, mintAuthorityActive: true }).category, "unclassified");
  // Missing inputs are reported, not assumed.
  const m = classifyMeme({ ...aged, top10Pct: null, mintAuthorityActive: null });
  assert.equal(m.category, "community");
  assert.deepEqual(m.missing.sort(), ["history", "mintAuthority", "top10Pct"]);
  const noLiq = classifyMeme({ ...aged, liquidityUsd: null });
  assert.equal(noLiq.category, "unclassified");
  assert.equal(noLiq.confidence, "tentative");
  assert.equal(classifyMeme({ ...base, ageDays: null }).category, "unclassified");
});

// ── Range statistics ──────────────────────────────────────────────────────────
function series(closes: number[], t0 = Date.UTC(2026, 0, 1)): DailyBar[] {
  return closes.map((c, i) => ({ t: t0 + i * 86_400_000, o: c, h: c, l: c, c, v: 1000 + i }));
}
function flat(c: number, n: number, t0 = Date.UTC(2026, 6, 1)): DailyBar[] {
  return series(new Array(n).fill(c), t0);
}

test("range stats: position, drawdown, deep dips reclaimed and open, on a hand-built series", () => {
  // 100 -> 300 (high) -> 90 (-70%: deep) -> 310 (reclaim, new high) -> 200 -> 93 (-70% from 310: deep, open)
  const bars = series([100, 150, 300, 200, 90, 310, 200, 93]);
  const s = rangeStats(bars, 90);
  assert.equal(s.dataState, "partial");
  assert.equal(s.bars, 8);
  assert.equal(s.windowHigh, 310);
  assert.equal(s.windowLow, 90);
  assert.equal(s.last, 93);
  close(s.rangePosition!, (93 - 90) / (310 - 90), 1e-3);
  close(s.drawdownFromHighPct!, 100 * (1 - 93 / 310), 0.01);
  assert.equal(s.daysSinceHigh, 2);
  // The latest bar at the high counts: [..., 310, 200, 310, 250, 260, 270] -> 3 days since the second 310.
  assert.equal(rangeStats(series([100, 310, 200, 310, 250, 260, 270]), 90).daysSinceHigh, 3);
  assert.equal(s.deepDipsReclaimed, 1);
  assert.equal(s.deepDipOpen, true);
  close(s.maxDrawdownPct!, 70, 0.01);   // 300 -> 90 and 310 -> 93 are both 70%
  assert.equal(s.deepDipPct, DEEP_DIP_PCT);
});

test("range stats: a dip that is partly recovered is not a reclaim; two full reclaims count two", () => {
  const twice = series([100, 300, 80, 320, 90, 330, 300]);
  const s = rangeStats(twice, 90);
  assert.equal(s.deepDipsReclaimed, 2);
  assert.equal(s.deepDipOpen, false);
  const partial = series([100, 300, 80, 250, 260, 270, 280]);
  const p = rangeStats(partial, 90);
  assert.equal(p.deepDipsReclaimed, 0);
  assert.equal(p.deepDipOpen, true);
});

test("range stats: thresholds and window; unordered input is sorted; non-positive closes are dropped", () => {
  assert.equal(rangeStats(series([1, 2, 3]), 90).dataState, "no_data");
  assert.equal(rangeStats(series([1, 2, 3]), 90).rangePosition, null);
  assert.equal(rangeStats(flat(5, 30), 90).dataState, "ok");
  assert.equal(rangeStats(flat(5, 30), 90).realizedVol30Pct, 0);
  // Window: only the last `windowDays` bars count, so an old high is outside the window.
  const w = rangeStats(series([1000].concat(new Array(20).fill(10))), 10);
  assert.equal(w.windowHigh, 10);
  assert.equal(w.bars, 10);
  const shuffled = series([100, 200, 50, 210, 210, 210, 210, 210, 210]).reverse();
  assert.equal(rangeStats(shuffled, 90).windowLow, 50);
  // Calendar window: bars older than `windowDays` before the last bar are outside it even when few bars exist.
  const gap = series([5, 6, 7, 8, 9, 10, 11]).concat(series([20, 21, 22, 23, 24, 25, 26, 27], Date.UTC(2026, 5, 1)));
  const g = rangeStats(gap, 90);
  assert.equal(g.bars, 8);
  assert.equal(g.windowLow, 20);
  // Duplicate timestamps collapse to one bar (the last one wins).
  const dup = series([1, 2, 3, 4, 5, 6, 7, 8]).concat(series([9, 9, 9, 9, 9, 9, 9, 9]));
  assert.equal(rangeStats(dup, 90).bars, 8);
  assert.equal(rangeStats(dup, 90).last, 9);
  // Even count: the median averages the two middle values.
  const ev = series([1, 1, 1, 1, 1, 1, 1, 1]).map((b, i) => ({ ...b, v: [10, 20, 30, 40, 50, 60, 70, 80][i] }));
  assert.equal(rangeStats(ev, 90).medianDailyVolumeUsd, 45);
  const bad = series([100, 0, -5, 200, 150, 160, 170, 180]);
  assert.equal(rangeStats(bad, 90).bars, 6);
});

test("range stats: realized vol on an alternating series matches the hand computation", () => {
  const closes: number[] = [];
  for (let i = 0; i < 31; i++) closes.push(i % 2 === 0 ? 100 : 110);
  const s = rangeStats(series(closes), 90);
  // log returns alternate +ln(1.1), -ln(1.1): mean 0, sample variance = ln(1.1)^2 * 30/29
  const r = Math.log(1.1);
  const expected = 100 * Math.sqrt((r * r * 30) / 29) * Math.sqrt(365);
  close(s.realizedVol30Pct!, expected, 0.02);
});

// ── Hold vs rotate ────────────────────────────────────────────────────────────
test("rotation: the published example (10k: holder 27k, rotator 270k) needs perfect timing and zero cost", () => {
  const perfect = rotationIllustration(10_000, ROTATION_EXAMPLE, 0, 1);
  assert.equal(perfect.holderUsd, 27_000);
  assert.equal(perfect.rotatorUsd, 270_000);
  assert.equal(perfect.ratio, 10);
  assert.equal(perfect.rotations, 2);
  // Costs: two round trips at 2% bring it under the published figure.
  const costed = rotationIllustration(10_000, ROTATION_EXAMPLE, 2, 1);
  close(costed.rotatorUsd, 270_000 * 0.98 * 0.98, 1);
  assert.equal(costed.costsPaidUsd, Math.round(30_000 * 0.02 + 30_000 * 0.98 * 3 * 0.02));
  // Half the timing: the gap shrinks to a few x, not ten.
  const half = rotationIllustration(10_000, ROTATION_EXAMPLE, 2, 0.5);
  assert.ok(half.ratio > 3 && half.ratio < 5, `${half.ratio}`);
  // No timing: the rotator is a holder paying fees.
  const none = rotationIllustration(10_000, ROTATION_EXAMPLE, 2, 0);
  assert.ok(none.rotatorUsd < none.holderUsd);
  close(none.rotatorUsd, 27_000 * 0.98 * 0.98, 1);
  // Monotone in timing capture.
  let prev = -1;
  for (const cap of [0, 0.25, 0.5, 0.75, 1]) {
    const r = rotationIllustration(10_000, ROTATION_EXAMPLE, 2, cap).rotatorUsd;
    assert.ok(r > prev); prev = r;
  }
  assert.ok(perfect.assumptions.some((a) => /not a forecast/.test(a)));
});

test("classifyMeme names an active mint authority at any age, not only in the community test", () => {
  const young = classifyMeme({ name: "Grit 2.0", symbol: "GRIT", ageDays: 21, liquidityUsd: 140_000, top10Pct: null, mintAuthorityActive: true, narrativeHits: [], history: null });
  assert.equal(young.category, "meta");
  assert.ok(young.reasons.includes("mint authority active"));
  const unread = classifyMeme({ name: "Grit 2.0", symbol: "GRIT", ageDays: 21, liquidityUsd: 140_000, top10Pct: null, mintAuthorityActive: null, narrativeHits: [], history: null });
  assert.ok(!unread.reasons.includes("mint authority active"), "unread is not active");
});
