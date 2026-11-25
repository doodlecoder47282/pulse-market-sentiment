// Hand-set tallies are shown as tallies, not as graded calls.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { synthesizeVerdict } from "../../server/edgeBriefing";

const read = (p: string) => readFileSync(p, "utf8");

test("the Edge Lab line says how many inputs lean each way", () => {
  const v = synthesizeVerdict({
    regime: { headline: "Risk-off", narrative: "", riskAxisLabel: "risk", riskAxisDirection: "risk-off", notes: [] },
    playbook: null, weekAhead: [], news: [], models: { daily: null, weekly: null }, levels: {} as any,
    crossAsset: { rows: [{ symbol: "SPY", last: 690, d1Pct: 4.7, w1Pct: -2.39, m1Pct: -5, corr20d: null, corrRegime: "n/a", barDate: "2026-11-23", stale: false }], expectedBarDate: "2026-11-23", vix: 26.4, vixChangePct: 0 },
  } as any);
  assert.match(v.oneLiner, /^Rule tally: 3 of 5 inputs lean down, 0 lean up \(3 of 5 inputs counted\) · /);
  assert.doesNotMatch(v.oneLiner, /strong bear/i);
});

test("the screens no longer show a graded call for a hand-set tally", () => {
  const edge = read("client/src/components/edgelab/EdgeBriefing.tsx");
  assert.doesNotMatch(edge, /score \{d\.confidence\}\/100/);
  assert.match(edge, /\{tallyLabel\(d\.verdict\)\}/);
  assert.match(edge, /if \(v\.includes\("bear"\)\) return "Rule tally leans down";/);
  const desk = read("client/src/components/TradeDesk.tsx");
  assert.doesNotMatch(desk, /intensity \{squeeze\.probability\}\/100/);
  const pb = read("server/playbook.ts");
  assert.doesNotMatch(pb, /dealers sell into weakness|bear squeeze if hedges unwind|crowded upside positioning/);
});
