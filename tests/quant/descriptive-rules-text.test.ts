import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDeterministicAlphaBrief, ruleCounts } from "../../server/alphaEngine";
import { riskReversalNote } from "../../shared/vol";

// Words that instruct, claim an edge, or say who is positioned how. None may appear in rules-written text.
const BANNED = /favou?red|tighten|consider|keep size|range-trade|pair trade|defined-risk|should be on|expect|FOMO|melt-up|crash premium|sellers|buyers|trade the tape|wait for the next|sizing|cleanest/i;

test("the rules-based news brief describes the feed and gives no instruction", () => {
  const feeds = [
    [],
    [{ title: "Fed cuts rates in surprise move", source: "Reuters", time: "09:00" }, { title: "Oil surges as OPEC cuts output", source: "Bloomberg" }],
    Array.from({ length: 6 }, (_, i) => ({ title: `Stocks plunge as war escalates, CPI hot, Nvidia earnings miss ${i}`, source: "WSJ" })),
    Array.from({ length: 6 }, (_, i) => ({ title: `Stocks rally to record after Fed signals rate cuts, Apple beats ${i}`, source: "WSJ" })),
  ];
  for (const f of feeds) {
    const b = buildDeterministicAlphaBrief(f);
    assert.doesNotMatch(b, BANNED);
    assert.doesNotMatch(b, /TRADE IMPLICATIONS|4\.20|15\/18\/22/);
    assert.match(b, /## WHAT THE RULES COUNTED/);
    assert.match(b, /not a forecast/);
    assert.doesNotMatch(b, /Upcoming|WATCH LIST|SCHEDULED RELEASES/);
  }
});

test("rule counts are counts", () => {
  const scored = [
    { impact: 8, direction: "Bearish", category: "RATES/FED" },
    { impact: 6, direction: "Bearish", category: "GEOPOLITICS" },
    { impact: 6, direction: "Bullish", category: "CORPORATE" },
    { impact: 5, direction: "Bullish", category: "ENERGY" },
    { impact: 3, direction: "Mixed", category: "OTHER" },
  ];
  assert.deepEqual(ruleCounts(scored), [
    "3 of 5 scored headlines are at 6 or higher: 1 tagged bullish, 2 tagged bearish, 0 tagged two-sided or mixed.",
    "1 headline scored 7 or higher.",
    "1 rates or Fed headline scored 6 or higher.",
    "1 geopolitics headline scored 6 or higher.",
    "1 energy headline scored 5 or higher.",
  ]);
  assert.deepEqual(ruleCounts([]), ["0 of 0 scored headlines are at 6 or higher: 0 tagged bullish, 0 tagged bearish, 0 tagged two-sided or mixed."]);
});

test("the risk reversal note states the number and the expiry it came from", () => {
  assert.equal(riskReversalNote(-0.045, 31), "25-delta puts carry 4.5 vol points more implied volatility than 25-delta calls at the 31-day expiry");
  assert.equal(riskReversalNote(0.012, 7), "25-delta calls carry 1.2 vol points more implied volatility than 25-delta puts at the 7-day expiry");
  assert.equal(riskReversalNote(0, 30), "25-delta calls and puts are within 0.05 vol points of each other at the 30-day expiry");
  const panel = readFileSync("client/src/components/edgelab/SkewPanel.tsx", "utf8") + readFileSync("server/edgeLabBrief.ts", "utf8").split("\n").filter((l) => l.includes('panel: "skew"') || l.includes("options skew")).join("\n");
  assert.doesNotMatch(panel, /fear|panic|greed|mean-revert|market expects|paid up/i);
  const src = readFileSync("server/skewEngine.ts", "utf8");
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /"[^"]*(favored|FOMO|melt-up|crash premium|calm regime)[^"]*"/);
});
