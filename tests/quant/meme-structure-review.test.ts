// tests/quant/meme-structure-review.test.ts
//
// Independent review of shared/memeStructure.ts. Every expected value below is
// derived in the test body from the constant-product pool itself (reserves,
// not the module's formulas), from the module's documented contracts, or from
// the product rules in AGENTS.md (missing / partial / observed-zero are
// different states; descriptive language only). Tests named "REVIEW FINDING"
// fail on the current code and state what must hold instead. The other tests
// record properties verified as correct.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  tradeCost, zeroEdgeBalance, maxSizeAtImpact, linePosition, classifyMeme, rangeStats, rotationIllustration,
  ROTATION_EXAMPLE, META_PATTERNS, type DailyBar, type RotationEvent,
} from "../../shared/memeStructure";

const close = (a: number, b: number, tol: number, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} (tol ${tol})`);

/** Simulate the pool directly: reserves Q (quote) and B (base), fees off the input, priority in USD. Returns the net quote after a zero-edge round trip. */
function simulateRoundTrip(Q: number, size: number, feeFrac: number, prio: number): number {
  const B = 1_000_000;
  const x = Math.max(0, size * (1 - feeFrac) - prio);
  const tokens = (B * x) / (Q + x);                 // buy against Q, B
  const gross = (Q * tokens) / (B + tokens);         // sell the same tokens into the same untouched pool at the entry quote
  return gross * (1 - feeFrac) - prio;
}

/** Net quote from selling tokens worth v0 at the entry quote, after the quote has moved by m, into a pool of the same depth (the module's break-even definition). */
function netAtMove(Q: number, v0: number, m: number, feeFrac: number, prio: number): number {
  const v = v0 * (1 + m);
  return ((Q * v) / (Q + v)) * (1 - feeFrac) - prio;
}

function series(closes: number[], t0 = Date.UTC(2026, 0, 1)): DailyBar[] {
  return closes.map((c, i) => ({ t: t0 + i * 86_400_000, o: c, h: c, l: c, c, v: 1000 + i }));
}
const flat = (c: number, n: number, t0 = Date.UTC(2026, 6, 1)) => series(new Array(n).fill(c), t0);
const noFees = { dexFeePct: 0, platformFeePct: 0, priorityFeeUsd: 0 };

// ── 1. tradeCost ──────────────────────────────────────────────────────────────

test("verified: buy impact x/(Q+x) (Uniswap/Jupiter price impact), post-buy price (1+x/Q)^2 and zero-edge sell discount v0/(Q+v0) are exact at every size, including size = Q", () => {
  const Q = 50_000, B = 1_000_000, p0 = Q / B;
  for (const x of [100, 1_000, 10_000, 50_000, 250_000]) {
    const tokens = (B * x) / (Q + x);
    const premium = 1 - (tokens * p0) / x; // value shortfall against the quote = x/(Q+x)
    const p1 = (Q + x) / (B - tokens);
    const sellGross = (Q * tokens) / (B + tokens);
    const discount = 1 - sellGross / (tokens * p0);
    const r = tradeCost({ liquidityUsd: 2 * Q, sizeUsd: x, ...noFees });
    assert.equal(r.dataState, "ok");
    close(r.impactBuyPct!, 100 * premium, 0.01, `x=${x} premium`);
    close(r.priceMoveAfterBuyPct!, 100 * (p1 / p0 - 1), 0.01, `x=${x} price`);
    close(r.impactSellPct!, 100 * discount, 0.01, `x=${x} sell`);
    for (const k of ["impactBuyPct", "priceMoveAfterBuyPct", "impactSellPct", "roundTripPct", "quoteReserveUsd"] as const) {
      assert.ok(Number.isFinite(r[k]), `${k} finite at x=${x}`);
    }
  }
  assert.ok(tradeCost({ liquidityUsd: 100_000, sizeUsd: 1_000 }).assumptions.some((a) => /quote reserve = liquidity \/ 2/.test(a)), "Q = liquidity / 2 is stated");
});

test("REVIEW FINDING A. roundTripPct must equal the loss the pool actually inflicts (x/(Q+x) on the buy leg), not the fill premium x/Q", () => {
  // The buy premium x/Q is the right number for "average fill premium", but as a
  // cost in percent of size the buy leg loses x/(Q+x) of its value, so the exact
  // zero-edge loss with no fees is 2x/(Q+2x). The module adds the premium to the
  // sell discount, which overstates the loss and exceeds 100% at size = Q, a round
  // trip that in fact returns a third of the size. zeroEdgeBalance consumes this
  // number as the fraction of the balance lost per trip, so the error compounds.
  const Q = 50_000;
  for (const [size, exact] of [[5_000, 100 * (2 * 5_000) / (Q + 2 * 5_000)], [50_000, 100 * (2 * 50_000) / (Q + 2 * 50_000)]]) {
    const r = tradeCost({ liquidityUsd: 2 * Q, sizeUsd: size, ...noFees });
    const simulated = 100 * (1 - simulateRoundTrip(Q, size, 0, 0) / size);
    close(simulated, exact, 1e-9, "simulation agrees with the closed form");
    close(r.roundTripPct!, exact, 0.05, `size=${size} roundTripPct`);
  }
  // With no priority fee a round trip cannot lose more than the size.
  assert.ok(tradeCost({ liquidityUsd: 2 * Q, sizeUsd: 5 * Q, ...noFees }).roundTripPct! < 100, "loss under 100% of size");
});

test("verified: break-even converges and satisfies the module's own equation for sizes well inside the depth, with and without fees", () => {
  const Q = 50_000;
  for (const size of [100, 1_000, 10_000, 25_000]) {
    for (const fees of [noFees, { dexFeePct: 0.25, platformFeePct: 1, priorityFeeUsd: 0.25 }]) {
      const r = tradeCost({ liquidityUsd: 2 * Q, sizeUsd: size, ...fees });
      const feeFrac = (fees.dexFeePct + fees.platformFeePct) / 100;
      const x = size * (1 - feeFrac) - fees.priorityFeeUsd;
      const v0 = (Q * x) / (Q + x);
      assert.ok(r.breakEvenMovePct != null, `size=${size}`);
      close(netAtMove(Q, v0, r.breakEvenMovePct! / 100, feeFrac, fees.priorityFeeUsd), size, size * 2e-4, `size=${size}`);
      assert.ok(r.breakEvenMovePct! >= r.roundTripPct!, "break-even is not below the round-trip cost (equal only after 2-dp rounding at tiny sizes)");
    }
  }
});

test("REVIEW FINDING B. break-even must be null when no move at the same depth can return the size (size >= Q·(1-fee) - priority); it must not report an unconverged iterate", () => {
  // Selling into a pool whose quote reserve is Q can never return more than Q, so
  // net(m) -> Q·(1-fee) - priority as m -> infinity. For size at or above that
  // ceiling there is no fixed point. The iteration m <- (1+m)·size/net(m) - 1 then
  // grows without bound and after 60 steps the module reports whatever it reached
  // (about 12,100% at size = Q, about 7e44 % at size = 5Q), a number that does not
  // satisfy net(m) = size. Just under the ceiling the iteration is far from converged.
  const Q = 50_000;
  for (const size of [Q, 5 * Q]) {
    const r = tradeCost({ liquidityUsd: 2 * Q, sizeUsd: size, ...noFees });
    assert.equal(r.breakEvenMovePct, null, `size=${size}: no break-even exists at this depth, got ${r.breakEvenMovePct}`);
  }
  const near = tradeCost({ liquidityUsd: 2 * Q, sizeUsd: 0.99 * Q, ...noFees });
  if (near.breakEvenMovePct != null) {
    const v0 = (Q * 0.99 * Q) / (Q + 0.99 * Q);
    close(netAtMove(Q, v0, near.breakEvenMovePct / 100, 0, 0), 0.99 * Q, 0.99 * Q * 1e-3, "size=0.99Q: a reported break-even must satisfy net(m) = size");
  }
});

test("REVIEW FINDING C. a size that does not cover fees plus priority never reaches the pool; it must not be reported as an ok fill with zero impact", () => {
  // size $0.20, fee 1.25%, priority $0.25: x = max(0, 0.1975 - 0.25) = 0. The
  // module returns dataState ok, impactBuyPct 0, priceMoveAfterBuyPct 0 and a
  // round trip of 252.5% of size. A zero impact here is a failed order, not an
  // observed zero (AGENTS.md: never label failed collection as zero activity).
  const r = tradeCost({ liquidityUsd: 100_000, sizeUsd: 0.2, dexFeePct: 0.25, platformFeePct: 1, priorityFeeUsd: 0.25 });
  assert.notEqual(r.dataState, "ok", `got ${r.dataState} with impactBuyPct ${r.impactBuyPct} and roundTripPct ${r.roundTripPct}`);
  assert.equal(r.impactBuyPct, null, "no fill, no impact figure");
});

test("REVIEW FINDING D. input states: negative liquidity is invalid, not observed_zero; a negative zero-edge cost cannot grow the balance", () => {
  // observed_zero means the pool was read and had no liquidity. -5 is not a
  // reading of zero. And a round trip cannot pay the trader: cost below 0 must
  // clamp to 0, leaving the start balance, not compound it upward.
  assert.equal(tradeCost({ liquidityUsd: -5, sizeUsd: 100 }).dataState, "invalid");
  assert.equal(zeroEdgeBalance(1_000, -2, 100), 1_000);
});

test("verified: zeroEdgeBalance and maxSizeAtImpact on the remaining edges", () => {
  assert.equal(zeroEdgeBalance(1_000, 150, 3), 0);                       // cost over 100%: nothing left
  assert.ok(Number.isNaN(zeroEdgeBalance(1_000, Number.NaN, 100)));      // NaN cost propagates, is not silently a balance
  assert.equal(zeroEdgeBalance(1_000, 2, -3), 1_000);                    // negative trade count: none taken
  assert.equal(maxSizeAtImpact(100_000, Number.NaN), null);
  assert.equal(maxSizeAtImpact(100_000, -1), null);
  assert.equal(maxSizeAtImpact(Number.NaN, 1), null);
  assert.equal(tradeCost({ liquidityUsd: 100_000, sizeUsd: -5 }).dataState, "invalid");
  // Fee inputs: negatives clamp to 0, NaN falls back to the defaults.
  assert.equal(tradeCost({ liquidityUsd: 100_000, sizeUsd: 100, dexFeePct: -1, platformFeePct: -1, priorityFeeUsd: -1 }).feesRoundTripPct, 0);
  assert.equal(tradeCost({ liquidityUsd: 100_000, sizeUsd: 100, dexFeePct: Number.NaN, platformFeePct: Number.NaN }).feesRoundTripPct, 2.5);
});

// ── 3. classifyMeme ───────────────────────────────────────────────────────────

const aged = { name: "Plain Coin", symbol: "PLAIN", ageDays: 40, liquidityUsd: 200_000, top10Pct: 18, mintAuthorityActive: false as boolean | null, narrativeHits: [] as string[], history: null as ReturnType<typeof rangeStats> | null };
const young = { ...aged, ageDays: 0.3 };
const histWithReclaim = rangeStats(series([100, 300, 90, 310, 200, 250]).concat(flat(250, 40)));

test("verified: classifyMeme reports top10Pct, mintAuthority and history as missing when absent; word boundaries hold on ordinary names; day boundaries agree with linePosition", () => {
  assert.equal(histWithReclaim.dataState, "ok");
  const m = classifyMeme({ ...aged, top10Pct: null, mintAuthorityActive: null });
  assert.deepEqual([...m.missing].sort(), ["history", "mintAuthority", "top10Pct"]);
  assert.equal(classifyMeme({ ...aged, liquidityUsd: null }).missing.includes("liquidityUsd"), true);
  for (const name of ["Dominion", "Notepad", "Reagent", "Minions", "Babylon", "Copycat", "Pitchfork", "iPad"]) {
    assert.deepEqual(META_PATTERNS.filter((p) => p.re.test(`${name} X`)).map((p) => p.tag), [], name);
    assert.equal(classifyMeme({ ...young, name, symbol: "X" }).category, "new-launch", name);
  }
  // 7 days: linePosition (minutes) leaves the launch week as classifyMeme (days) does.
  assert.equal(linePosition(7 * 1440, false).phase, "settled");
  assert.equal(linePosition(7 * 1440 - 1, false).phase, "first-week");
  assert.equal(classifyMeme({ ...young, ageDays: 7 }).category, "maturing");
  assert.equal(classifyMeme({ ...young, ageDays: 6.99 }).category, "new-launch");
});

test("REVIEW FINDING E. confidence must be tentative whenever `missing` is non-empty (documented contract: firm = every input the rule needs was present)", () => {
  // top10Pct and mintAuthority both unread, history shows a reclaimed dip: the
  // module returns community / firm with missing = [top10Pct, mintAuthority].
  const r = classifyMeme({ ...aged, top10Pct: null, mintAuthorityActive: null, history: histWithReclaim });
  assert.equal(r.category, "community");
  assert.ok(r.missing.length > 0, "inputs are missing");
  assert.equal(r.confidence, "tentative", `missing=${JSON.stringify(r.missing)}`);
});

test("REVIEW FINDING F. a non-finite top10Pct is a missing reading, not a failed concentration test", () => {
  // ageDays and liquidityUsd go through finite(); top10Pct does not. NaN yields
  // the reason "top-10 holders NaN% (over 30%)", unclassified / firm, missing [].
  const r = classifyMeme({ ...aged, top10Pct: Number.NaN });
  assert.ok(r.missing.includes("top10Pct"), `missing=${JSON.stringify(r.missing)} reasons=${JSON.stringify(r.reasons)}`);
  assert.ok(!r.reasons.some((s) => /NaN/.test(s)), "no NaN in user-facing text");
  assert.equal(r.category, "community");
});

test("REVIEW FINDING G. partial daily history (7-29 bars) is partial, not 'unavailable', and is not listed as missing", () => {
  // AGENTS.md: missing and partial are different states. A 10-bar history that
  // already contains a reclaimed 70% dip is reported as "daily history
  // unavailable" and pushed into `missing`.
  const partial = rangeStats(series([100, 300, 90, 310, 200, 250, 260, 270, 280, 290]));
  assert.equal(partial.dataState, "partial");
  assert.equal(partial.deepDipsReclaimed, 1);
  const r = classifyMeme({ ...aged, history: partial });
  assert.equal(r.category, "community");
  assert.ok(!r.missing.includes("history"), `history was supplied: missing=${JSON.stringify(r.missing)}`);
  assert.ok(!r.reasons.some((s) => /unavailable/i.test(s)), `reasons=${JSON.stringify(r.reasons)}`);
});

test("REVIEW FINDING H. META_PATTERNS: the bare word 'pad' tags ordinary names as a launchpad meta; a sequel glued to the name ('Pepe2.0') is missed", () => {
  for (const name of ["Lily Pad", "Pad Thai", "Mouse Pad"]) {
    const r = classifyMeme({ ...young, name, symbol: "X" });
    assert.notEqual(r.category, "meta", `${name}: ${r.reasons.join(" | ")}`);
  }
  assert.equal(classifyMeme({ ...young, name: "Pepe2.0", symbol: "PEPE2" }).category, "meta");
});

// ── 4. rangeStats ─────────────────────────────────────────────────────────────

test("verified: rangeStats reclaim at exactly the running high counts, a series that starts in a dip has no phantom dip, NaN closes are dropped, zero-volume bars count in the median, 31 closes give 30 returns", () => {
  const exact = rangeStats(series([100, 300, 90, 300, 250, 260, 270]));
  assert.equal(exact.deepDipsReclaimed, 1);
  assert.equal(exact.deepDipOpen, false);
  const startsLow = rangeStats(series([30, 35, 40, 100, 110, 120, 130]));
  assert.equal(startsLow.deepDipsReclaimed, 0);
  assert.equal(startsLow.deepDipOpen, false);
  assert.equal(startsLow.maxDrawdownPct, 0);
  const nan = series([100, 110, 120, 130, 140, 150, 160, 170]);
  nan[3].c = Number.NaN;
  assert.equal(rangeStats(nan).bars, 7);
  const zeroVol = series([10, 10, 10, 10, 10, 10, 10]).map((b, i) => ({ ...b, v: i < 4 ? 0 : 500 }));
  assert.equal(rangeStats(zeroVol).medianDailyVolumeUsd, 0);        // observed zero volume is a real reading
  const noVol = series([10, 10, 10, 10, 10, 10, 10]).map((b) => ({ ...b, v: Number.NaN }));
  assert.equal(rangeStats(noVol).medianDailyVolumeUsd, null);       // no volume read is not zero
  // 31 closes -> 30 log returns; the 32nd close is outside the vol window.
  const base = new Array(31).fill(100).map((c, i) => (i % 2 ? 110 : c));
  const withOutlier = rangeStats(series([5_000].concat(base)));
  const plain = rangeStats(series(base));
  assert.equal(withOutlier.realizedVol30Pct, plain.realizedVol30Pct);
});

test("REVIEW FINDING I. daysSinceHigh must count from the latest close at the high (a touch of the high is a reclaim elsewhere in the module) and in calendar days when bars are missing", () => {
  // Tie: the high 310 is closed at bar 1 and again at bar 3 of 7. The reclaim
  // rule treats the second 310 as reaching the high; daysSinceHigh must agree
  // and report 3, not 5 (first occurrence).
  const tie = rangeStats(series([100, 310, 200, 310, 250, 260, 270]));
  assert.equal(tie.daysSinceHigh, 3);
  // Gap: four bars after the high, but they start three days late, so the high
  // was seven calendar days before the last bar.
  const gap = series([100, 200, 300, 150, 140, 130, 120]);
  for (let i = 3; i < gap.length; i++) gap[i].t += 3 * 86_400_000;
  const g = rangeStats(gap);
  assert.equal((gap[6].t - gap[2].t) / 86_400_000, 7);
  assert.equal(g.daysSinceHigh, 7);
});

test("REVIEW FINDING J. duplicate timestamps must collapse to one bar; an overlapping page must not turn 15 days into 'ok' coverage or halve the realized vol", () => {
  const fifteen = series([100, 300, 90, 310, 200, 250, 260, 270, 280, 290, 300, 310, 320, 330, 340]);
  const once = rangeStats(fifteen);
  const twice = rangeStats(fifteen.concat(fifteen.map((b) => ({ ...b }))));
  assert.equal(once.dataState, "partial");
  assert.equal(twice.bars, 15, `got ${twice.bars} bars`);
  assert.equal(twice.dataState, "partial");
  assert.equal(twice.realizedVol30Pct, once.realizedVol30Pct);
  assert.equal(twice.deepDipsReclaimed, once.deepDipsReclaimed);
});

test("REVIEW FINDING K. medianDailyVolumeUsd of an even count is the mean of the two middle values", () => {
  const bars = series([10, 10, 10, 10, 10, 10, 10, 10]).map((b, i) => ({ ...b, v: (i + 1) * 10 }));
  // volumes 10..80: median = (40 + 50) / 2 = 45; the module returns element [4] = 50.
  assert.equal(rangeStats(bars).medianDailyVolumeUsd, 45);
});

// ── 5. rotationIllustration ───────────────────────────────────────────────────

test("verified: capture 0 is the holder less two fees per rotation, exactly; the published figure needs cost 0 and capture 1; NaN inputs do not leak", () => {
  for (const cost of [0, 1, 2.5, 7]) {
    const none = rotationIllustration(10_000, ROTATION_EXAMPLE, cost, 0);
    const expected = 10_000 * 3 * 0.3 * Math.pow(1 - cost / 100, 2) * 3;
    close(none.rotatorUsd, expected, 0.5, `cost=${cost}`);
    assert.equal(none.holderUsd, 27_000);
  }
  for (const cost of [0, 0.5, 2]) {
    for (const cap of [0, 0.5, 0.99, 1]) {
      const r = rotationIllustration(10_000, ROTATION_EXAMPLE, cost, cap);
      const published = cost === 0 && cap === 1;
      assert.equal(r.rotatorUsd === 270_000, published, `cost=${cost} cap=${cap}: ${r.rotatorUsd}`);
      assert.ok(Number.isFinite(r.rotatorUsd) && r.rotatorUsd >= 0 && r.costsPaidUsd >= 0);
    }
  }
  const nanEvents: RotationEvent[] = [{ kind: "up", mult: Number.NaN }, { kind: "dip", dip: Number.NaN, otherUp: Number.NaN }];
  const n = rotationIllustration(Number.NaN, nanEvents, Number.NaN, Number.NaN);
  for (const k of ["holderUsd", "rotatorUsd", "ratio", "costsPaidUsd"] as const) assert.ok(Number.isFinite(n[k]), k);
});

test("REVIEW FINDING L. a round-trip cost above 100% must clamp: balances and costs paid can never go negative", () => {
  // At 150% the first fee takes more than the balance: rotator -15,000, then the
  // next fee is negative and costsPaidUsd ends at -22,500.
  const r = rotationIllustration(10_000, ROTATION_EXAMPLE, 150, 1);
  assert.ok(r.roundTripCostPct <= 100, `reported cost ${r.roundTripCostPct}%`);
  assert.ok(r.costsPaidUsd >= 0, `costsPaidUsd ${r.costsPaidUsd}`);
  assert.ok(r.rotatorUsd >= 0 && r.rotatorUsd <= 30_000 * 3, `rotatorUsd ${r.rotatorUsd}`);
});

test("REVIEW FINDING M. ratio 0 means the rotator ended with nothing; when the holder is wiped out and the rotator is not, the ratio must not be 0", () => {
  // Up 3x then a -100% dip while the other coin 3x: holder 0, rotator 90,000.
  const r = rotationIllustration(10_000, [{ kind: "up", mult: 3 }, { kind: "dip", dip: 1, otherUp: 3 }], 0, 1);
  assert.equal(r.holderUsd, 0);
  assert.equal(r.rotatorUsd, 90_000);
  assert.ok(r.ratio > 0, `ratio ${r.ratio}`);
});

// ── 6. Language ───────────────────────────────────────────────────────────────

// Same pattern as tests/quant/no-advice-language.test.ts, which walks client/src
// and server only; shared/ is not covered there, so the module is checked here.
const INSTRUCTION = /\b(buy (the )?(dip|dips|calls|puts)|sell (the )?(rip|rips|calls|puts|premium|wings)|size (up|down|half)|half size|full size|go long|go short|take (the )?profits?|take the trade|enter (long|short|now)|act on (it|this|the)|fade (the|into|rallies|extremes)|ride (the )?(trend|pullbacks)|load up|scale (in|out)|stand aside|you should (buy|sell|enter)|cut size|size accordingly|reduce [\w-]+( [\w-]+){0,2} size|hedge with|tighten (gamma )?exposure)\b/gi;
const IMPERATIVE = /\b(you should|should (buy|sell|enter|exit|size|rotate)|buy now|sell now|enter now|exit now|set a stop|stop[- ]loss at|take profit)\b/gi;

test("verified: every user-facing string the module emits, and its source, is descriptive (no trade-instruction phrases)", () => {
  const emitted: string[] = [];
  for (const size of [0.2, 100, 1_000, 50_000]) emitted.push(...tradeCost({ liquidityUsd: 100_000, sizeUsd: size }).assumptions);
  for (const age of [null, 10, 600, 3 * 1440, 40 * 1440]) emitted.push(linePosition(age, true).note, linePosition(age, false).note);
  const inputs = [
    { ...young }, { ...young, narrativeHits: ["elon"] }, { ...young, name: "Pepe 2.0" }, { ...young, ageDays: 12 }, { ...young, ageDays: null },
    { ...aged }, { ...aged, history: histWithReclaim }, { ...aged, liquidityUsd: 1_000 }, { ...aged, top10Pct: 60 }, { ...aged, mintAuthorityActive: true },
    { ...aged, liquidityUsd: null, top10Pct: null, mintAuthorityActive: null },
  ];
  for (const f of inputs) { const r = classifyMeme(f); emitted.push(...r.reasons, ...r.missing); }
  for (const cap of [0, 0.5, 1]) emitted.push(...rotationIllustration(10_000, ROTATION_EXAMPLE, 2, cap).assumptions);
  const src = readFileSync(new URL("../../shared/memeStructure.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const hits: string[] = [];
  for (const text of [...emitted, src]) {
    for (const m of text.matchAll(INSTRUCTION)) hits.push(m[0]);
    for (const m of text.matchAll(IMPERATIVE)) hits.push(m[0]);
  }
  assert.deepEqual(hits, []);
  assert.ok(emitted.length > 30);
});
