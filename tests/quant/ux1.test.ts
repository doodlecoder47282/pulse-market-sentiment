// UX batch 1: Edge Lab never shows a verdict, score or another symbol's
// levels without real inputs.
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/ux1.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLevels, synthesizeVerdict, weeklyTargetsGate } from "../../server/edgeBriefing";

const NOW = Date.parse("2026-10-09T16:00:00Z");
const seed = {
  version: 1,
  updatedAt: 0, // the seed file: never set by the user
  levels: [
    { id: "upside", value: 7140 }, { id: "downside", value: 6950 },
    { id: "upper-vomma", value: 7265 }, { id: "lower-vomma", value: 6960 }, { id: "charm", value: 7128 },
  ],
};

test("SPX weekly targets are never shown as SPY levels", () => {
  const fresh = { ...seed, updatedAt: NOW - 86_400_000 };
  const lv = buildLevels("SPY", fresh, null, null, NOW);
  assert.equal(lv.upside, null);
  assert.equal(lv.downside, null);
  assert.equal(lv.vomma.up, null);
  assert.equal(lv.charm, null);
  assert.equal(lv.targets.shown, false);
  assert.match(lv.targets.note, /SPX levels; not shown for SPY/);
});

test("seed or stale weekly targets are hidden even for SPX", () => {
  assert.equal(buildLevels("SPX", seed, null, null, NOW).upside, null);
  const stale = { ...seed, updatedAt: NOW - 8 * 86_400_000 };
  const lv = buildLevels("$SPX", stale, null, null, NOW);
  assert.equal(lv.upside, null);
  assert.match(lv.targets.note, /last set 2026-10-01/);
});

test("fresh SPX weekly targets are shown and labelled", () => {
  const fresh = { ...seed, updatedAt: NOW - 2 * 86_400_000 };
  const lv = buildLevels("SPX", fresh, null, null, NOW);
  assert.equal(lv.upside, 7140);
  assert.equal(lv.downside, 6950);
  assert.equal(lv.targets.shown, true);
  assert.equal(weeklyTargetsGate("^GSPC", fresh.updatedAt, NOW).shown, true);
});

test("walls come from the symbol's own routes only, not the targets store", () => {
  const fresh = { ...seed, updatedAt: NOW, levels: [...seed.levels, { id: "call-wall", value: 7200 }] };
  const lv = buildLevels("SPY", fresh, null, null, NOW);
  assert.equal(lv.callWall, null);
  assert.equal(lv.zeroGamma, null);
});

const empty = {
  regime: null, crossAsset: null, playbook: null, weekAhead: [], news: [],
  models: { daily: null, weekly: null },
  levels: buildLevels("SPY", null, null, null, NOW),
};

test("no inputs: insufficient data and no score", () => {
  const v = synthesizeVerdict(empty as any);
  assert.equal(v.verdict, "insufficient data");
  assert.equal(v.confidence, null);
  assert.match(v.oneLiner, /0 of 5 inputs/);
});

test("blank cross-asset rows and a no-reading regime do not count as inputs", () => {
  const b = {
    ...empty,
    regime: { headline: "Rotation read unavailable", narrative: "", riskAxisLabel: null, riskAxisDirection: null, notes: [] },
    crossAsset: {
      rows: [{ symbol: "SPY", last: null, d1Pct: null, w1Pct: null, m1Pct: null, corr20d: null, corrRegime: "n/a" }],
      vix: null, vixChangePct: null,
    },
    playbook: {
      marketSession: "closed",
      paths: {
        bull: { label: "—", probability: 0, trigger: "—", targetLow: 0, targetHigh: 0, oneLiner: "", drivers: [] },
        base: { label: "—", probability: 0, trigger: "—", targetLow: 0, targetHigh: 0, oneLiner: "", drivers: [] },
        bear: { label: "—", probability: 0, trigger: "—", targetLow: 0, targetHigh: 0, oneLiner: "", drivers: [] },
      },
      levels: { support: null, resistance: null },
    },
  };
  const v = synthesizeVerdict(b as any);
  assert.equal(v.verdict, "insufficient data");
  assert.equal(v.confidence, null);
});

test("real inputs still produce a read", () => {
  const b = {
    ...empty,
    regime: { headline: "Risk-on leadership", narrative: "", riskAxisLabel: "Risk", riskAxisDirection: "risk-on", notes: [] },
    crossAsset: {
      rows: [{ symbol: "SPY", last: 650, d1Pct: 0.4, w1Pct: 1.6, m1Pct: 3, corr20d: null, corrRegime: "n/a" }],
      vix: 14.2, vixChangePct: -2,
    },
  };
  const v = synthesizeVerdict(b as any);
  assert.equal(v.verdict, "strong bull");
  assert.equal(v.confidence, 75);
});
