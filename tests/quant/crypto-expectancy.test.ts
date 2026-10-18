// Net return of graded crypto signals under a stated exit rule
// (shared/cryptoExpectancy.ts): bookkeeping on what a position did, net of
// both legs' fees and impact, never a forecast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { legReturnPct, signalReturn, summarizeExpectancy, wilson } from "../../shared/cryptoExpectancy";
import { tradeCost } from "../../shared/memeStructure";

const row = (o: Partial<{ outcome: string; mcapAtSignal: number | null; liquidityAtSignal: number | null; peakMcap: number | null; lastMcap: number | null; lastLiquidity: number | null }>) =>
  ({ outcome: "DEAD", mcapAtSignal: 200_000, liquidityAtSignal: 40_000, peakMcap: 260_000, lastMcap: 150_000, lastLiquidity: 35_000, ...o });

test("legReturnPct: an unchanged quote in the same pool loses exactly the zero-edge round trip of tradeCost", () => {
  const rt = tradeCost({ liquidityUsd: 40_000, sizeUsd: 100 }).roundTripPct!;
  const net = legReturnPct(100, 40_000, 40_000, 1)!;
  assert.ok(Math.abs(net + rt) < 0.006, `net ${net} vs -round trip ${rt} (tradeCost rounds to 2 decimals)`);
  // A doubled quote in the same pool nets less than +100% (fees, impact on the way out); a halved one loses more than 50%.
  assert.ok(legReturnPct(100, 40_000, 40_000, 2)! < 100 && legReturnPct(100, 40_000, 40_000, 2)! > 80);
  assert.ok(legReturnPct(100, 40_000, 40_000, 0.5)! < -50);
  // Thinner exit pool: the same multiple returns less.
  assert.ok(legReturnPct(100, 40_000, 5_000, 2)! < legReturnPct(100, 40_000, 40_000, 2)!);
  // Pulled pool: nothing to sell into.
  assert.equal(legReturnPct(100, 40_000, 0, 2), -100);
  // A size below the fees is a total loss; bad inputs are null.
  assert.equal(legReturnPct(0.2, 40_000, 40_000, 1), -100);
  assert.equal(legReturnPct(100, 0, 40_000, 1), null);
  assert.equal(legReturnPct(100, 40_000, 40_000, -1), null);
});

test("signalReturn: graded rule uses the values the grader closed the row at, peak rule the sampled peak at entry depth; open and no-data rows are not returns", () => {
  const dead = signalReturn(row({}), "graded");
  assert.equal(dead.grossMultiple, 0.75);
  assert.ok(dead.netPct! < -25 && dead.netPct! > -40, `dead net ${dead.netPct}`);
  const peak = signalReturn(row({}), "peak");
  assert.equal(peak.grossMultiple, 1.3);
  assert.ok(peak.netPct! > 20 && peak.netPct! < 30, `peak net ${peak.netPct}`);
  assert.equal(signalReturn(row({ outcome: "OPEN" }), "graded").missing, "still open");
  assert.equal(signalReturn(row({ outcome: "NO_DATA" }), "graded").missing, "no price past the horizon");
  assert.equal(signalReturn(row({ mcapAtSignal: null }), "graded").missing, "no market cap at the signal");
  assert.equal(signalReturn(row({ lastLiquidity: null }), "graded").missing, "no liquidity at the horizon");
  // A rug with the pool gone is -100 whatever the last market cap says.
  assert.equal(signalReturn(row({ outcome: "RUGGED", lastLiquidity: 0, lastMcap: 20_000 }), "graded").netPct, -100);
  assert.equal(signalReturn(row({ outcome: "RUGGED", lastLiquidity: null, lastMcap: null }), "graded").netPct, -100);
  // A rug with a sliver of liquidity left is priced through it, and is nearly -100.
  const sliver = signalReturn(row({ outcome: "RUGGED", lastLiquidity: 300, lastMcap: 4_000 }), "graded");
  assert.ok(sliver.netPct! < -90 && sliver.netPct! > -100);
  // A hit priced through a deeper exit pool keeps most of the move.
  const hit = signalReturn(row({ outcome: "HIT_5M", lastMcap: 5_200_000, lastLiquidity: 600_000, peakMcap: 6_000_000 }), "graded");
  assert.ok(hit.grossMultiple! > 25 && hit.netPct! > 2000, `hit ${hit.netPct}`);
});

test("legReturnPct: an unknown exit depth is null, an observed-zero exit depth is -100; a rugged row with no exit mark has no gross multiple", () => {
  assert.equal(legReturnPct(100, 20_000, NaN, 1), null);
  assert.equal(legReturnPct(100, 20_000, 0, 1), -100);
  const r = signalReturn({ outcome: "RUGGED", mcapAtSignal: 100_000, liquidityAtSignal: 20_000, peakMcap: null, lastMcap: null, lastLiquidity: null }, "graded");
  assert.equal(r.netPct, -100);
  assert.equal(r.grossMultiple, null, "an unread exit is not a 0x");
});

test("summarizeExpectancy: median, mean, positive share with Wilson interval, skipped reasons, and the sample gate", () => {
  const rows = [
    row({}), row({ outcome: "RUGGED", lastLiquidity: 0 }), row({ outcome: "DOUBLED", lastMcap: 450_000, lastLiquidity: 60_000 }),
    row({ outcome: "OPEN" }), row({ outcome: "NO_DATA" }), row({ lastLiquidity: null }),
  ];
  const s = summarizeExpectancy(rows, "graded", { sizeUsd: 100, minSample: 50 });
  assert.equal(s.n, 3);
  assert.equal(s.skipped, 2, "NO_DATA and the missing-liquidity row are skipped; OPEN is not graded at all");
  assert.deepEqual(s.skippedReasons, { "no price past the horizon": 1, "no liquidity at the horizon": 1 });
  assert.equal(s.positiveShare.yes, 1); assert.equal(s.positiveShare.of, 3);
  assert.ok(s.positiveShare.lo! < 33.3 && s.positiveShare.hi! > 33.3);
  assert.equal(s.worstNetPct, -100);
  assert.ok(s.medianNetPct! < 0 && s.meanNetPct! < s.bestNetPct!);
  assert.equal(s.sampleReady, false);
  assert.match(s.note, /3 of a 50-signal minimum: counts only, no claim of edge/);
  const big = summarizeExpectancy(Array.from({ length: 60 }, () => row({})), "graded", { minSample: 50 });
  assert.equal(big.sampleReady, true);
  assert.match(big.note, /what happened, not a forecast/);
  assert.equal(summarizeExpectancy([], "peak").n, 0);
  assert.equal(summarizeExpectancy([], "peak").medianNetPct, null);
});

test("wilson: textbook values and bounds", () => {
  const w = wilson(0, 10)!; assert.equal(w.lo, 0); assert.ok(w.hi > 0.27 && w.hi < 0.29);
  const h = wilson(5, 10)!; assert.ok(h.lo > 0.23 && h.lo < 0.24 && h.hi > 0.76 && h.hi < 0.77);
  assert.equal(wilson(0, 0), null);
});
