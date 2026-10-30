// Replay / diagnostics over the logged record (shared/cryptoReplay.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReplay, firstPerCoin, timingReadout, bandReadout, featureReadout, wouldEnterNow, reevalReadout, type ReplayRow } from "../../shared/cryptoReplay";
import { CRYPTO_RULES } from "../../shared/cryptoRules";

const T0 = Date.UTC(2026, 9, 1);
let seq = 0;
const row = (o: Partial<ReplayRow> & { f?: Partial<ReplayRow["features"]> } = {}): ReplayRow => {
  const i = seq++;
  const { f, ...rest } = o;
  return {
    id: `s${i}`, detectedAt: T0 + i * 3600_000, verdict: "ENTER", coinKey: `coin${i}`, outcome: "DEAD",
    mcapAtSignal: 200_000, liquidityAtSignal: 30_000, peakMcap: 240_000, peakAt: T0 + i * 3600_000 + 30 * 60_000, peakLiquidity: 30_000,
    lastMcap: 150_000, lastLiquidity: 25_000, horizonMcap: 150_000, horizonLiquidity: 25_000, horizonAt: T0 + i * 3600_000 + 72 * 3600_000,
    rulesVersion: "2026.10.27-2",
    features: { score: 80, volAccel: 2, netBuyRatio5m: 0.65, ageMinutes: 40, top10Pct: 20, mintAuthorityActive: false, freezeAuthorityActive: false, securityCheckedAt: 1, rcLpLockedPct: 90, socialScore: 30, narrativeHits: [], boosted: false, pumpfunGraduate: true, bskyMentions1h: 5, ...f },
    ...rest,
  };
};

test("first signal per coin, oldest first; verdict filter", () => {
  const a = row({ coinKey: "x", verdict: "WATCH" }), b = row({ coinKey: "x", verdict: "ENTER" }), c = row({ coinKey: "y" });
  assert.deepEqual(firstPerCoin([b, a, c]).map((r) => r.id), [a.id, c.id]);
  assert.deepEqual(firstPerCoin([b, a, c], "ENTER").map((r) => r.id), [b.id, c.id]);
});

test("timing: a peak inside 5 min of the signal counts as 'at or before'; no peak is counted, not binned", () => {
  const at = (minutes: number) => { const r = row(); r.peakAt = r.detectedAt + minutes * 60_000; return r; };
  const rows = [at(2), at(10), at(50), at(300), row({ peakAt: null, peakMcap: null }), row({ outcome: "OPEN" })];
  const t = timingReadout(rows);
  assert.deepEqual([t.n, t.peakAtOrBeforeSignal, t.within15min, t.within60min, t.later, t.noPeak], [5, 1, 1, 1, 1, 1]);
  assert.equal(t.medianMinutesToPeak, 30);
});

test("cap bands: outcomes bucketed by cap at signal with win share and interval; NO_DATA outside the priced denominator", () => {
  const rows = [
    row({ mcapAtSignal: 50_000, outcome: "DOUBLED", peakMcap: 120_000 }),
    row({ mcapAtSignal: 60_000, outcome: "DEAD" }),
    row({ mcapAtSignal: 70_000, outcome: "NO_DATA", peakMcap: null, lastMcap: null, lastLiquidity: null }),
    row({ mcapAtSignal: 600_000, outcome: "DEAD" }),
    row({ mcapAtSignal: 700_000, outcome: "RUGGED", lastLiquidity: 1_000 }),
  ];
  const b = bandReadout(rows);
  const low = b.find((x) => x.band === "< $100k")!, mid = b.find((x) => x.band === "$300k-1M")!;
  assert.deepEqual([low.n, low.doubled, low.dead, low.noData, low.winShare], [3, 1, 1, 1, 50]);
  assert.deepEqual([mid.n, mid.dead, mid.rugged, mid.winShare], [2, 1, 1, 0]);
  assert.ok(low.winLo! < 50 && low.winHi! > 50);
});

test("features vs outcome: medians per group and top/bottom-third win shares, with n", () => {
  const rows: ReplayRow[] = [];
  for (let i = 0; i < 12; i++) rows.push(row({ outcome: i < 4 ? "DOUBLED" : "DEAD", peakMcap: i < 4 ? 500_000 : 240_000, f: { volAccel: i < 4 ? 4 : 1.6 } }));
  const fr = featureReadout(rows).find((x) => x.feature === "volAccel")!;
  assert.equal(fr.nWin, 4); assert.equal(fr.nLoss, 8);
  assert.equal(fr.medianWin, 4); assert.equal(fr.medianLoss, 1.6);
  assert.equal(fr.thirdN, 4);
  assert.equal(fr.topThirdWinShare, 100);
  assert.equal(fr.bottomThirdWinShare, 0);
});

test("re-evaluation reads only signal-time fields: outcome, peak and horizon cannot change the answer; gates not stored are listed as unchecked", () => {
  const base = row();
  const w = wouldEnterNow(base);
  assert.equal(w.enter, true);
  for (const mutated of [{ outcome: "RUGGED" }, { peakMcap: 9e9 }, { horizonMcap: 1 }, { lastMcap: 0 }] as Partial<ReplayRow>[]) {
    assert.equal(wouldEnterNow({ ...base, ...mutated }).enter, true, JSON.stringify(mutated));
  }
  assert.deepEqual(wouldEnterNow({ ...base, features: { ...base.features, score: 60 } }).blockers, ["score"]);
  assert.deepEqual(wouldEnterNow({ ...base, features: { ...base.features, mintAuthorityActive: null } }).blockers, ["mint authority unread"]);
  assert.deepEqual(wouldEnterNow({ ...base, mcapAtSignal: 1_500_000, liquidityAtSignal: 100_000 }).blockers, ["cap ceiling"]);
  assert.deepEqual(wouldEnterNow({ ...base, liquidityAtSignal: 5_000 }).blockers, ["liquidity floor", "exit door"]);
  assert.ok(w.unchecked.includes("Jupiter agree/watch") && w.unchecked.includes("desk risk on"));
});

test("re-evaluation splits by detection date, older half in-sample, and scores net of cost under the graded rule", () => {
  const rows: ReplayRow[] = [];
  for (let i = 0; i < 10; i++) rows.push(row({ outcome: i % 2 ? "DOUBLED" : "DEAD", peakMcap: i % 2 ? 500_000 : 240_000, lastMcap: i % 2 ? 450_000 : 150_000 }));
  rows.push(row({ verdict: "WATCH", f: { score: 55 } })); // would not enter
  const re = reevalReadout(rows);
  assert.equal(re.consideredFirstSignals, 11);
  assert.equal(re.wouldEnter, 10);
  assert.equal(re.originallyEnter, 10);
  assert.equal(re.blockerCounts["score"], 1);
  assert.equal(re.inSample.n, 5); assert.equal(re.outOfSample.n, 5);
  assert.ok(re.inSample.to! < re.outOfSample.from!);
  assert.ok(re.all.meanNetGradedPct != null && re.all.maxDrawdownPct != null && re.all.maxDrawdownPct <= 0);
  assert.match(re.lookAhead, /only fields written at detection/);
  const r = buildReplay(rows, T0 + 1e9);
  assert.equal(r.rows.firstSignals, 11);
  assert.equal(r.rows.versions["2026.10.27-2"], 11);
  assert.match(r.samplingLimit, /DOUBLED counts are a floor/);
  assert.equal(r.reeval.rulesVersion, r.rulesVersion);
  assert.equal(CRYPTO_RULES.universe.targetMcapUsd, 5_000_000);
});

test("recorded decision-time gate evidence is re-checked; absent evidence stays unchecked (upper bound)", () => {
  const base = row();
  const good = { flowPolls: 3, flowHits: 2, flowNeed: 2, flowWindow: 3, jupState: "agree", jupGapPct: 1, buys1h: 80, sells1h: 60, deskRisk: "on" };
  const withG = (g: any) => ({ ...base, features: { ...base.features, gates: g } });
  const ok = wouldEnterNow(withG(good));
  assert.equal(ok.enter, true);
  assert.deepEqual(ok.unchecked, []);
  assert.deepEqual(wouldEnterNow(withG({ ...good, flowHits: 1 })).blockers, ["flow not sustained"]);
  assert.deepEqual(wouldEnterNow(withG({ ...good, flowPolls: 1, flowHits: 1 })).blockers, ["flow not sustained"], "one poll cannot be sustained");
  assert.deepEqual(wouldEnterNow(withG({ ...good, jupState: "failed" })).blockers, ["Jupiter failed"]);
  assert.deepEqual(wouldEnterNow(withG({ ...good, jupState: "watch" })).blockers, []);
  assert.deepEqual(wouldEnterNow(withG({ ...good, jupState: null })).blockers, ["Jupiter unread"]);
  assert.deepEqual(wouldEnterNow(withG({ ...good, sells1h: null })).blockers, ["1 h sells unread"]);
  assert.deepEqual(wouldEnterNow(withG({ ...good, sells1h: 0, buys1h: 25 })).blockers, ["honeypot pattern"]);
  assert.deepEqual(wouldEnterNow(withG({ ...good, sells1h: 0, buys1h: 24 })).blockers, []);
  assert.deepEqual(wouldEnterNow(withG({ ...good, deskRisk: "off" })).blockers, ["desk risk off"]);
  assert.deepEqual(wouldEnterNow(withG({ ...good, deskRisk: null })).blockers, ["desk risk unread"]);
  // Outcome fields still cannot change the answer.
  assert.equal(wouldEnterNow({ ...withG(good), outcome: "RUGGED", peakMcap: 9e9 } as ReplayRow).enter, true);
});

test("reevalReadout reports how many first signals carry decision-time gate evidence", () => {
  const mk = (id: string, t: number, g: any) => ({ ...row({ id, coinKey: id, detectedAt: t }), features: { ...row().features, gates: g } });
  const good = { flowPolls: 3, flowHits: 3, flowNeed: 2, flowWindow: 3, jupState: "agree", jupGapPct: 0, buys1h: 9, sells1h: 9, deskRisk: "on" };
  const re = reevalReadout([mk("a", 1, good), mk("b", 2, null), mk("c", 3, good)] as ReplayRow[]);
  assert.equal(re.gateEvidence.recorded, 2);
  assert.equal(re.gateEvidence.of, 3);
  assert.ok(re.unchecked.includes("desk risk on"), "the row without evidence keeps the gates unchecked");
});

test("the engine writes the gate evidence it later re-checks, and the replay loader reads it back", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.match(src, /gates: gateEvidence\(c\)/);
  assert.match(src, /gates: f\.gates && typeof f\.gates === "object" \? f\.gates : null/);
  for (const k of ["flowPolls", "flowHits", "jupState", "sells1h", "deskRisk"]) assert.match(src, new RegExp(`${k}[,:]`));
});
