// The scoreboard lists each record with its own counts and floor, and forms no rate or judgement of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { buildScoreboard, scoreboardAnswer, SCORE_STATE_LABEL, type ScoreInputs } from "../../shared/scoreboard";

const full: ScoreInputs = {
  windowDays: 30,
  whale: { graded: 99, pending: 57, hit30Rate: 5 / 99 },
  whalePerf: { windowDays: 7, wins: 4, losses: 45, avgPct: -0.62 },
  regime: { graded: 110, pending: 17, overallHitRate: 0.6, sessions: 12 },
  setups: { minSample: 100, summary: [{ ruleVersion: "2026.10.21-1", kind: "breakout below the put wall", n: 3, positive: 0 }] },
  protocols: { minGraded: 30, items: [
    { name: "Sweep under a level and reclaim", graded: true, record: { graded: 1, expected: 1, cancelled: 0, neither: 0 } },
    { name: "News window", graded: false, record: { graded: 0, expected: 0, cancelled: 0, neither: 0 } },
  ] },
  replay: { sessions: 12, record: { graded: 40, expected: 15, cancelled: 20, neither: 5 } },
  settle: { days: 2, floor: 50, settleInStraddle: { yes: 2, of: 2 } },
};
const row = (rows: ReturnType<typeof buildScoreboard>, id: string) => rows.find((r) => r.id === id)!;

test("each record keeps its own counts and floor", () => {
  const rows = buildScoreboard(full);
  assert.match(row(rows, "whale").result, /^5 of 99 finished up 30% or more; 57 pending$/);
  assert.equal(row(rows, "whale").state, "no_floor");
  assert.match(row(rows, "whale-perf").result, /^4 of 49 closed with a gain; average result −62%$/);
  const s = rows.find((r) => r.id.startsWith("setup:"))!;
  assert.deepEqual([s.n, s.floor, s.state, s.result], [3, 100, "too_few", "0 of 3 ended with a gain"]);
  const p = rows.find((r) => r.id.startsWith("protocol:"))!;
  assert.deepEqual([p.n, p.floor, p.state], [1, 30, "too_few"]);
  assert.ok(!rows.some((r) => /News window/.test(r.what)), "a rule that is not graded has no row");
  assert.deepEqual([row(rows, "settle").n, row(rows, "settle").floor, row(rows, "settle").state], [2, 50, "too_few"]);
  assert.match(row(rows, "regime").result, /66 of 110 held; these come from 12 sessions/);
});

test("a replay is never at a floor, whatever its count", () => {
  const r = row(buildScoreboard(full), "replay");
  assert.deepEqual([r.n, r.floor, r.state], [40, null, "never"]);
  assert.match(SCORE_STATE_LABEL[r.state], /never counts as tested/);
});

test("a record that was not read is 'not read', never zero", () => {
  const rows = buildScoreboard({ windowDays: 30 });
  for (const id of ["whale", "whale-perf", "setups", "protocols", "settle", "regime"]) {
    assert.deepEqual([row(rows, id).n, row(rows, id).state, row(rows, id).result], [null, "unavailable", "not read"], id);
  }
  assert.ok(!rows.some((r) => r.id === "replay"), "no replay row when there is no replay");
  assert.match(scoreboardAnswer(rows), /No record with a floor was read\. 6 records were not read\./);
});

test("read with nothing graded is 'nothing graded', distinct from not read", () => {
  const rows = buildScoreboard({ ...full, whale: { graded: 0, pending: 3, hit30Rate: 0 }, setups: { minSample: 100, summary: [] }, settle: { days: 0, floor: 50, settleInStraddle: { yes: 0, of: 0 } } });
  assert.deepEqual([row(rows, "whale").state, row(rows, "whale").result], ["none", "none graded; 3 pending"]);
  assert.deepEqual([row(rows, "setups").state, row(rows, "setups").n], ["none", 0]);
  assert.equal(row(rows, "settle").state, "none");
});

test("the answer counts records at their floor and says nothing about any flag's worth", () => {
  assert.equal(scoreboardAnswer(buildScoreboard(full)), "0 of 3 records that set a floor have reached it; the rest have too few graded cases to read.");
  const at = buildScoreboard({ ...full, settle: { days: 60, floor: 50, settleInStraddle: { yes: 40, of: 60 } } });
  assert.match(scoreboardAnswer(at), /^1 of 3 records/);
  assert.equal(row(at, "settle").state, "enough");
});
