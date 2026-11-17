// Candidate rule sets on the record (practitioner review, 2026-11-17).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { candidatesReadout, sameNameCounts, CANDIDATE_SETS, CANDIDATE_PARAMS, CANDIDATES_VERSION, RULES } from "../../shared/cryptoCandidates";
import type { ReplayRow } from "../../shared/cryptoReplay";

const T0 = 1_800_000_000_000;
let seq = 0;
function row(over: Partial<ReplayRow> & { f?: Partial<ReplayRow["features"]> } = {}): ReplayRow {
  const id = `r${++seq}`;
  const { f, ...rest } = over;
  return {
    id, detectedAt: T0 + seq * 60_000, verdict: "WATCH", symbol: `SYM${seq}`, coinKey: `mint${seq}`,
    outcome: "DEAD", mcapAtSignal: 200_000, liquidityAtSignal: 40_000, peakMcap: 220_000, lastMcap: 50_000, lastLiquidity: 20_000,
    features: {
      ageMinutes: 30, netBuyRatio5m: 0.7, boosted: false, narrativeHits: [], bskyMentions1h: 0,
      gates: { flowReadings: [2, 2], histLen: 2, jupState: "agree", jupGapPct: 1, buys1h: 80, sells1h: 20, deskRisk: "on" },
      ...f,
    },
    ...rest,
  };
}

test("a rule whose input was not recorded does not pass the row, and the row is counted as not evaluable", () => {
  seq = 0;
  const rows = [
    row({ f: { boosted: true } }),                                   // passes everything
    row({ f: { gates: null, boosted: true } }),                       // tape unread
    row({ f: { ageMinutes: 2, boosted: true } }),                     // too young: a real fail
    row({ f: { boosted: undefined, narrativeHits: null, bskyMentions1h: null } }), // attention unread
  ];
  const r = candidatesReadout(rows);
  const combined = r.sets.find((s) => s.id === "combined")!;
  assert.equal(combined.considered, 4);
  assert.equal(combined.passed, 1);
  assert.equal(combined.notEvaluable, 2);
  const tape = combined.rules.find((x) => x.id === "twoSidedTape")!;
  assert.deepEqual([tape.pass, tape.fail, tape.unread], [3, 0, 1]);
  assert.equal(combined.insufficient, true, "one priced row: counts only");
  const age = combined.rules.find((x) => x.id === "minAge")!;
  assert.deepEqual([age.pass, age.fail, age.unread], [3, 1, 0]);
  assert.equal(r.version, CANDIDATES_VERSION);
});

test("each rule reads what it says", () => {
  seq = 0;
  const ctx = { sameNameBefore: new Map<string, number>() };
  assert.equal(RULES.twoSidedTape.test(row(), ctx), "pass");
  assert.equal(RULES.twoSidedTape.test(row({ f: { netBuyRatio5m: 1 } }), ctx), "fail", "a buy share of 1.00 is the no-information case");
  assert.equal(RULES.twoSidedTape.test(row({ f: { gates: { flowReadings: [], histLen: 0, jupState: null, jupGapPct: null, buys1h: 80, sells1h: 4, deskRisk: null } } }), ctx), "fail");
  assert.equal(RULES.minCap.test(row({ mcapAtSignal: 99_999 }), ctx), "fail");
  assert.equal(RULES.minCap.test(row({ mcapAtSignal: null }), ctx), "unread");
  assert.equal(RULES.top10WhenRead.test(row({ f: { top10Pct: 60 } }), ctx), "fail");
  assert.equal(RULES.top10WhenRead.test(row({ f: { top10Pct: null } }), ctx), "pass-unread");
  assert.equal(RULES.top10WhenRead.test(row({ f: { top10Pct: 20 } }), ctx), "pass");
  assert.equal(RULES.noActiveAuthority.test(row(), ctx), "pass-unread");
  assert.equal(RULES.noActiveAuthority.test(row({ f: { mintAuthorityActive: false, freezeAuthorityActive: false } }), ctx), "pass");
  assert.equal(RULES.jupiterNotAgainst.test(row(), ctx), "pass");
  assert.equal(RULES.jupiterNotAgainst.test(row({ f: { gates: null } }), ctx), "pass-unread");
  assert.equal(RULES.noActiveAuthority.test(row({ f: { mintAuthorityActive: true } }), ctx), "fail");
  assert.equal(RULES.jupiterNotAgainst.test(row({ f: { gates: { flowReadings: [], histLen: 0, jupState: "diverge", jupGapPct: 30, buys1h: 1, sells1h: 1, deskRisk: "on" } } }), ctx), "fail");
  assert.equal(RULES.attention.test(row({ f: { bskyMentions1h: CANDIDATE_PARAMS.minBskyMentions1h } }), ctx), "pass");
  assert.equal(RULES.attention.test(row(), ctx), "fail");
});

test("serial relaunches: the third copy of a symbol inside 24 h fails; counts are case-insensitive and windowed", () => {
  seq = 0;
  const a = row({ symbol: "BAWSAQ" }), b = row({ symbol: "bawsaq" }), c = row({ symbol: "BAWSAQ " }), d = row({ symbol: "OTHER" });
  const late = { ...row({ symbol: "BAWSAQ" }), detectedAt: T0 + 30 * 3_600_000 };
  const counts = sameNameCounts([a, b, c, d, late]);
  assert.equal(counts.get(a.id), 0); assert.equal(counts.get(b.id), 1); assert.equal(counts.get(c.id), 2); assert.equal(counts.get(d.id), 0);
  assert.equal(counts.get(late.id), 0, "outside the 24 h window");
  const ctx = { sameNameBefore: counts };
  assert.equal(RULES.notRelaunch.test(b, ctx), "pass");
  assert.equal(RULES.notRelaunch.test(c, ctx), "fail");
  assert.equal(RULES.notRelaunch.test({ ...d, symbol: null }, ctx), "unread");
  assert.equal(RULES.notRelaunch.test({ ...d, symbol: "   " }, ctx), "unread");
});

test("the pass set is scored net of cost and split by detection date; open and no-data rows are not credited", () => {
  seq = 0;
  const rows: ReplayRow[] = [];
  for (let i = 0; i < 6; i++) rows.push(row({ outcome: i % 2 ? "DOUBLED" : "DEAD", peakMcap: i % 2 ? 500_000 : 210_000, lastMcap: i % 2 ? 450_000 : 20_000, f: { boosted: true } }));
  rows.push(row({ outcome: "OPEN", f: { boosted: true } }));
  rows.push(row({ outcome: "NO_DATA", f: { boosted: true } }));
  const s = candidatesReadout(rows).sets.find((x) => x.id === "attention")!;
  assert.equal(s.considered, 7, "the open row is not considered");
  assert.equal(s.passed, 7);
  assert.equal(s.all.n, 6, "the no-data row is left out of n");
  assert.equal(s.all.wins, 3);
  assert.equal(s.inSample.n + s.outOfSample.n, 6);
  assert.ok(s.all.meanNetGradedPct != null);
  assert.equal(s.insufficient, true);
  assert.equal(typeof s.holdN, "number");
});

test("declared sets and wiring: five sets, no live rule is touched, the readout carries its caveats", () => {
  assert.deepEqual(CANDIDATE_SETS.map((s) => s.id), ["base", "tape", "attention", "survivors", "combined"]);
  const src = readFileSync(new URL("../../shared/cryptoCandidates.ts", import.meta.url), "utf8");
  // Reads the live rule book only for the grading target; writes nothing.
  assert.doesNotMatch(src, /CRYPTO_RULES\.(enter|watch|kill|flow)\b/);
  const r = candidatesReadout([]);
  assert.equal(r.considered, 0);
  assert.ok(r.caveats.some((c) => /biased upward/.test(c)));
  assert.ok(r.caveats.some((c) => /none is a claim of edge/.test(c)));
  assert.ok(r.caveats.some((c) => /not out-of-sample/.test(c)));
  assert.ok(r.caveats.some((c) => /structure rules block only on a recorded objection/.test(c)));
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.match(e, /const data = \{ \.\.\.buildReplay\(like, now\), candidates: candidatesReadout\(like\) \};/);
  assert.match(readFileSync(new URL("../../client/src/components/CryptoPanel.tsx", import.meta.url), "utf8"), /data-testid="crypto-replay-candidates"/);
});

test("review: structure rules pass a row with nothing recorded and say so in the tally", () => {
  seq = 0;
  const bare = () => row({ f: { top10Pct: null, gates: null, mintAuthorityActive: undefined, freezeAuthorityActive: undefined } });
  const base = candidatesReadout([bare(), bare(), bare()]).sets.find((s) => s.id === "base")!;
  assert.equal(base.passed, 3); assert.equal(base.notEvaluable, 0);
  for (const rule of base.rules) assert.deepEqual([rule.pass, rule.passUnread, rule.fail, rule.unread], [3, 3, 0, 0], rule.id);
});

test("review: the candidate parameters and set ids are pinned to the version string", async () => {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update(JSON.stringify({ p: CANDIDATE_PARAMS, sets: CANDIDATE_SETS.map((s) => [s.id, s.rules.map((x) => x.id)]) })).digest("hex");
  const PINNED: Record<string, string> = { "candidates-2026.11.17-1": "d1a98c8634848127f6b1506c9ac04e5140235b43219b51f94101dcb1ae54db9f" };
  assert.equal(PINNED[CANDIDATES_VERSION], h, `a changed candidate parameter or set needs a new CANDIDATES_VERSION; PINNED["${CANDIDATES_VERSION}"] = "${h}"`);
  // Only the replay imports the module: no verdict, score, gate, exit plan or autopsy reads it.
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("grep", ["-rl", "cryptoCandidates", "server", "shared", "client/src"], { cwd: new URL("../../", import.meta.url).pathname }).toString().trim().split("\n").sort();
  assert.deepEqual(out, ["client/src/components/CryptoPanel.tsx", "server/cryptoEngine.ts", "shared/cryptoCandidates.ts", "shared/cryptoReplay.ts"].filter((f) => out.includes(f)));
  assert.ok(!out.some((f) => /Verdict|Autopsy|exitPlan|cryptoRules/.test(f)));
});

