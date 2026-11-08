// One market-cap basis for the desk, and an eviction that lets new pools in.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gradeSignal } from "../../server/cryptoStats";
import { capOf, capOnBasis, evictOverCap, evictionRank, ARRIVAL_RANK, MOMENTUM_CYCLE_MS } from "../../shared/cryptoCap";

test("capOf: marketCap first, FDV second, basis named; nothing invents a cap", () => {
  assert.deepEqual(capOf({ marketCap: 400_000, fdv: 500_000 }), { cap: 400_000, basis: "marketCap" });
  assert.deepEqual(capOf({ marketCap: null, fdv: 500_000 }), { cap: 500_000, basis: "fdv" });
  assert.deepEqual(capOf({ marketCap: 0, fdv: 500_000 }), { cap: 0, basis: "marketCap" }, "an observed zero cap is a cap");
  assert.deepEqual(capOf({ marketCap: null, fdv: null }), { cap: null, basis: "none" });
  assert.deepEqual(capOf({ marketCap: NaN, fdv: NaN }), { cap: null, basis: "none" });
});

test("capOnBasis: a row is priced on the basis it was recorded on; a basis switch mid-life is not a rug", () => {
  assert.equal(capOnBasis({ marketCap: 40_000, fdv: 500_000 }, "fdv"), 500_000, "entry on FDV stays on FDV when marketCap appears");
  assert.equal(capOnBasis({ marketCap: 40_000, fdv: 500_000 }, "marketCap"), 40_000);
  assert.equal(capOnBasis({ marketCap: null, fdv: 500_000 }, "marketCap"), null, "basis no longer reported: unpriced, never the other number");
  assert.equal(capOnBasis({ marketCap: 40_000, fdv: 500_000 }, null), 40_000, "rows from before the basis was recorded: marketCap else FDV");
  assert.equal(capOnBasis({ marketCap: null, fdv: 500_000 }, undefined), 500_000);
  assert.equal(capOnBasis({ marketCap: NaN, fdv: NaN }, "fdv"), null);
  // The grader's own rule on an FDV entry of 500k with live {marketCap 40k, fdv 500k}: 500k vs 500k, not 40k vs 500k.
  const live = { marketCap: 40_000, fdv: 500_000 };
  const onBasis = gradeSignal({ entryMcap: 500_000, entryLiq: 50_000, prevPeak: 500_000, mcap: capOnBasis(live, "fdv"), liq: 50_000, ageMs: 60_000, targetMcap: 5_000_000, horizonMs: 86_400_000 });
  assert.equal(onBasis.outcome, "OPEN", "not RUGGED on a basis switch");
  const offBasis = gradeSignal({ entryMcap: 500_000, entryLiq: 50_000, prevPeak: 500_000, mcap: live.marketCap, liq: 50_000, ageMs: 60_000, targetMcap: 5_000_000, horizonMs: 86_400_000 });
  assert.equal(offBasis.outcome, "RUGGED", "the old mixed-basis read would have called it a rug");
});

test("eviction: 220 scored names plus arrivals keeps the arrivals for one cycle and drops the lowest PASS first", () => {
  const now = 10_000_000_000;
  const entries: Array<[string, { score: number | null; verdict: "ENTER" | "WATCH" | "PASS" | null; firstSeenAt: number }]> = [];
  for (let i = 0; i < 220; i++) entries.push([`scored${i}`, { score: i % 100, verdict: i % 7 === 0 ? "WATCH" : i % 31 === 0 ? "ENTER" : "PASS", firstSeenAt: now - 3600_000 - i * 1000 }]);
  for (let i = 0; i < 20; i++) entries.push([`new${i}`, { score: null, verdict: null, firstSeenAt: now - 30_000 }]);
  const gone = new Set(evictOverCap(entries, 220, now));
  assert.equal(gone.size, 20);
  assert.ok([...gone].every((k) => k.startsWith("scored")), "no arrival is evicted");
  for (const k of gone) {
    const c = entries.find((e) => e[0] === k)![1];
    assert.equal(c.verdict, "PASS", `evicted ${k} should be a PASS`);
  }
  // The lowest-score PASS names went.
  const keptPass = entries.filter(([k, c]) => !gone.has(k) && c.verdict === "PASS").map(([, c]) => c.score as number);
  const gonePass = [...gone].map((k) => entries.find((e) => e[0] === k)![1].score as number);
  assert.ok(Math.max(...gonePass) <= Math.min(...keptPass));
  // An unscored name older than one cycle (DexScreener never answered) goes first of all.
  const stale: [string, { score: null; verdict: null; firstSeenAt: number }] = ["ghost", { score: null, verdict: null, firstSeenAt: now - MOMENTUM_CYCLE_MS - 1 }];
  assert.ok(evictOverCap([...entries, stale], 220, now).includes("ghost"));
  assert.equal(evictionRank(stale[1], now), -1);
  assert.equal(evictionRank({ score: null, verdict: null, firstSeenAt: now }, now), ARRIVAL_RANK);
  // Bounded protection: arrivals outrank every PASS but never a WATCH or an ENTER.
  assert.ok(ARRIVAL_RANK > evictionRank({ score: 99, verdict: "PASS", firstSeenAt: 0 }, now));
  assert.ok(ARRIVAL_RANK < evictionRank({ score: 0, verdict: "WATCH", firstSeenAt: 0 }, now));
  const flood: Array<[string, { score: number | null; verdict: "ENTER" | "WATCH" | "PASS" | null; firstSeenAt: number }]> = [];
  for (let i = 0; i < 200; i++) flood.push([`w${i}`, { score: 50, verdict: i % 2 ? "WATCH" : "ENTER", firstSeenAt: now - 3600_000 }]);
  for (let i = 0; i < 20; i++) flood.push([`p${i}`, { score: 50, verdict: "PASS", firstSeenAt: now - 3600_000 }]);
  for (let i = 0; i < 300; i++) flood.push([`arr${i}`, { score: null, verdict: null, firstSeenAt: now - 1000 - i }]);
  const floodGone = evictOverCap(flood, 220, now);
  assert.equal(floodGone.length, 300);
  assert.ok(floodGone.every((k) => k.startsWith("p") || k.startsWith("arr")), "a flood of arrivals never evicts a WATCH or an ENTER");
  assert.equal(floodGone.filter((k) => k.startsWith("p")).length, 20);
  assert.ok(evictionRank({ score: 10, verdict: "ENTER", firstSeenAt: 0 }, now) > evictionRank({ score: 99, verdict: "WATCH", firstSeenAt: 0 }, now));
  assert.deepEqual(evictOverCap(entries.slice(0, 100), 220, now), []);
});

test("wiring: engine uses capOf at the entry row, the peak and plan samplers, the scorer and the grader's live path; GT does not overwrite a fresh DexScreener read", () => {
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.match(e, /c\.verdict, c\.verdictCode, c\.score, capOf\(c\)\.cap, c\.priceUsd, c\.liquidityUsd,/);
  assert.match(e, /mcapBasis: capOf\(c\)\.basis,/);
  assert.match(e, /const \{ cap \} = capOf\(c\);/);
  assert.match(e, /for \(const basis of PEAK_SAMPLE_BASES\) \{\s*_peakStmt\.run\(peakSampleParams\(capOnBasis\(c, basis\), basis, at,/);
  assert.match(e, /samplePlans\(c\.chain, c\.pairAddress, cap, c\.liquidityUsd/);
  assert.match(e, /const mcap = capOf\(c\)\.cap \?\? 0;/);
  assert.match(e, /mcap = capOnBasis\(live, basis\); liq = live\.liquidityUsd;/);
  assert.match(e, /mcap = capOnBasis\(live, hBasis\); liq = live\.liquidityUsd;/, "horizon live path grades on the entry basis too");
  assert.doesNotMatch(e, /mcap = live\.marketCap/);
  assert.match(e, /json_extract\(features_json, '\$\.mcapBasis'\) AS mcap_basis/);
  assert.match(e, /const dsFresh = c\.lastRefreshAt != null && Date\.now\(\) - c\.lastRefreshAt < MOMENTUM_CYCLE_MS;\s*if \(!dsFresh\) \{/);
  assert.match(e, /for \(const k of evictOverCap\(\[\.\.\.tracked\.entries\(\)\], MAX_TRACKED, now\)\) tracked\.delete\(k\);/);
  assert.doesNotMatch(e, /\(b\[1\]\.score \?\? -1\) - \(a\[1\]\.score \?\? -1\)/);
});
