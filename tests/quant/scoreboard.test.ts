// The scoreboard lists each record with its own counts and floor, and forms no rate or judgement of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { buildScoreboard, scoreboardAnswer, SCORE_STATE_LABEL, type ScoreInputs } from "../../shared/scoreboard";

const rec = (graded: number, expected = 0, cancelled = 0, neither = 0, open = 0, ungraded = 0) => ({ graded, expected, cancelled, neither, open, ungraded });
const full: ScoreInputs = {
  windowDays: 30,
  whale: { graded: 99, pending: 57, hit30Rate: 5 / 99, ungradedNoMark: 2 },
  whalePerf: { windowDays: 7, wins: 4, losses: 45, avgPct: -0.62, excludedNoQuote: 3, excludedNoFee: 24 },
  regime: { graded: 110, pending: 17, overallHitRate: 0.6, sessions: 12 },
  setups: { minSample: 100, summary: [{ ruleVersion: "2026.10.21-1", kind: "breakout below the put wall", n: 3, positive: 0 }] },
  protocols: { minGraded: 30, bookVersion: "2026.11.18-1", items: [
    { name: "Sweep under a level and reclaim", graded: true, record: rec(1, 1, 0, 0, 1, 2) },
    { name: "News window", graded: false, record: rec(0) },
  ] },
  replay: { sessions: 12, name: "Sweep under a level and reclaim", record: rec(40, 15, 20, 5) },
  settle: { days: 2, floor: 50, settleInStraddle: { yes: 2, of: 2 } },
};
const row = (rows: ReturnType<typeof buildScoreboard>, id: string) => rows.find((r) => r.id === id)!;

test("each record keeps its own counts and floor, with what was left out", () => {
  const rows = buildScoreboard(full);
  assert.equal(row(rows, "whale").result, "5 of 99 finished up 30% or more; 57 pending; 2 resolved with no usable mark, not graded");
  assert.equal(row(rows, "whale").state, "no_floor");
  assert.equal(row(rows, "whale-perf").result, "4 of 49 closed with a gain; average result −62%; 27 left out for a missing quote or fee");
  const s = rows.find((r) => r.id.startsWith("setup:"))!;
  assert.deepEqual([s.n, s.floor, s.state, s.result], [3, 100, "too_few", "0 of 3 ended with a gain"]);
  const p = rows.find((r) => r.id.startsWith("protocol:"))!;
  assert.deepEqual([p.n, p.floor, p.state], [1, 30, "too_few"]);
  assert.match(p.what, /book 2026\.11\.18-1/);
  assert.match(p.result, /1 reached the rule's outcome price, 0 cancelled, 0 neither; 1 open; 2 could not be graded/);
  assert.ok(!rows.some((r) => /News window/.test(r.what)), "a rule that is not graded has no row");
});

test("the regime row names the proxy the source grades, and never says the regime held", () => {
  const r = row(buildScoreboard(full), "regime");
  assert.match(r.result, /^66 of 110 matched the move-size proxy on the called horizon; 17 pending; counted one per session: 12/);
  assert.match(r.graded, /a proxy, not the regime itself/);
  assert.doesNotMatch(`${r.result} ${r.graded}`, /\bheld\b/);
});

test("the settle row's floor counts settled days, as its source does", () => {
  const r = row(buildScoreboard({ ...full, settle: { days: 52, floor: 50, settleInStraddle: { yes: 30, of: 49 } } }), "settle");
  assert.deepEqual([r.n, r.floor, r.state], [52, 50, "enough"]);
  assert.equal(r.result, "30 of 49 settled inside the range; 3 settled days had no range read");
});

test("a replay is never at a floor; an unread or switched-off replay keeps its row", () => {
  const r = row(buildScoreboard(full), "replay");
  assert.deepEqual([r.n, r.floor, r.state], [40, null, "never"]);
  assert.match(SCORE_STATE_LABEL[r.state], /never counts as tested/);
  const unreadRows = buildScoreboard({ ...full, replay: null });
  assert.deepEqual([row(unreadRows, "replay").state, row(unreadRows, "replay").result], ["unavailable", "not read"]);
  assert.match(scoreboardAnswer(unreadRows), /1 row was not read\.$/);
  const off = row(buildScoreboard({ ...full, replay: { off: "no past session could be replayed yet" } }), "replay");
  assert.deepEqual([off.state, off.result], ["off", "no past session could be replayed yet"]);
});

test("a record that was not read is 'not read', never zero, and the headline counts the same rows the list shows", () => {
  const rows = buildScoreboard({ windowDays: 30 });
  const ids = ["whale", "whale-perf", "setups", "protocols", "replay", "settle", "regime"];
  for (const id of ids) assert.deepEqual([row(rows, id).n, row(rows, id).state, row(rows, id).result], [null, "unavailable", "not read"], id);
  assert.equal(scoreboardAnswer(rows), `No row with a floor was read. ${ids.length} rows were not read.`);
});

test("read with nothing graded is 'nothing graded', distinct from not read", () => {
  const rows = buildScoreboard({ ...full, whale: { graded: 0, pending: 3, hit30Rate: 0 }, setups: { minSample: 100, summary: [] }, settle: { days: 0, floor: 50, settleInStraddle: { yes: 0, of: 0 } } });
  assert.deepEqual([row(rows, "whale").state, row(rows, "whale").result], ["none", "none graded; 3 pending"]);
  assert.deepEqual([row(rows, "setups").state, row(rows, "setups").n], ["none", 0]);
  assert.equal(row(rows, "settle").state, "none");
});

test("the sample edition lists no counts: every row is 'not kept'", () => {
  const rows = buildScoreboard({ ...full, off: "the sample edition keeps no record" });
  assert.ok(rows.length >= 7 && rows.every((r) => r.state === "off" && r.n == null && r.result === "the sample edition keeps no record"));
  assert.equal(scoreboardAnswer(rows), "No record is kept in this edition.");
});

test("the answer counts rows at their floor and says nothing about any flag's worth", () => {
  assert.equal(scoreboardAnswer(buildScoreboard(full)), "0 of 3 rows that set a floor have reached it; the others have fewer graded cases than the floor.");
  const at = buildScoreboard({ ...full, settle: { days: 60, floor: 50, settleInStraddle: { yes: 40, of: 60 } } });
  assert.match(scoreboardAnswer(at), /^1 of 3 rows that set a floor have reached it; the others have/);
  const one = buildScoreboard({ windowDays: 30, settle: { days: 60, floor: 50, settleInStraddle: { yes: 40, of: 60 } } });
  assert.match(scoreboardAnswer(one), /^The one row that sets a floor has reached it\. 6 rows were not read\.$/);
});
