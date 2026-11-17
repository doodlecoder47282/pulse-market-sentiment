// Signal record: gate rules, Wilson reuse, no pooling, and wiring.
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/signal-record.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_MIN_GRADED, SIGNAL_RECORD_NOTE, buildSource, unavailableSource, makeSignalRecord, resolveMinSample,
  winsFromRate, resultText, meanNetText, countText, insufficientText, countsReconcile, remainder, gateText, gateFor, kindText,
  type SourceInput, type SignalRecordSource,
} from "../../shared/signalRecord";
import { wilsonInterval } from "../../server/validationMath";
import {
  assembleSignalRecord, getSignalRecord, _resetSignalRecordCache, SOURCE_ADAPTERS, SOURCE_META, whaleAlertExpirySource, odteT1Source, mmMatrixSource, whaleFollowSource, cryptoDeskSource, scenarioOddsSource,
  wienerOddsSource, odteOptionLedgerSource, regimeCallsSource, trackedSignalsSource,
  type SignalRecordDeps,
} from "../../server/signalRecord";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const wilson = (k: number, n: number) => wilsonInterval(k, n);

const input = (over: Partial<SourceInput> = {}): SourceInput => ({
  id: "x", name: "X", kind: "win_loss",
  basis: { entry: "ask", exit: "bid; win = positive", costs: "fees" },
  n: { emitted: 100, graded: 60, open: 30, excluded: 10 },
  wins: 33, meanNet: 0.04, meanNetUnit: "mean return", meanNetScale: "fraction",
  ...over,
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

test("default minimum sample is one named, hand-set constant of 30", () => {
  assert.equal(DEFAULT_MIN_GRADED, 30);
  assert.deepEqual(resolveMinSample(null), { minSample: 30, from: "default" });
  assert.deepEqual(resolveMinSample(undefined), { minSample: 30, from: "default" });
  assert.deepEqual(resolveMinSample(385), { minSample: 385, from: "source" });
  assert.match(read("shared/signalRecord.ts"), /Hand-set/);
});

test("under the gate: insufficient, counts only, every figure null", () => {
  const s = buildSource(input({ n: { emitted: 40, graded: 29, open: 11, excluded: 0 }, wins: 20 }), wilson);
  assert.equal(s.state, "insufficient");
  assert.equal(s.reason, "INSUFFICIENT DATA: 29 of 30 needed");
  assert.equal(s.winShare, null);
  assert.equal(s.winLo, null);
  assert.equal(s.winHi, null);
  assert.equal(s.meanNet, null);
  assert.deepEqual(s.n, { emitted: 40, graded: 29, open: 11, excluded: 0 });
  assert.equal(resultText(s), "INSUFFICIENT DATA: 29 of 30 needed");
  assert.equal(meanNetText(s), null);
});

test("the source's own minimum is used when it has one", () => {
  const s = buildSource(input({ minSample: 385, n: { emitted: 500, graded: 384, open: 0, excluded: 116 }, wins: 200 }), wilson);
  assert.equal(s.state, "insufficient");
  assert.equal(s.minSample, 385);
  assert.equal(s.minSampleFrom, "source");
  assert.equal(s.reason, insufficientText(384, 385));
  assert.equal(s.winShare, null);
});

test("a source's further gate blocks the figures even above the minimum", () => {
  const s = buildSource(input({ sourceGate: { ready: false, reason: "40 of 100 graded signals could not be priced" } }), wilson);
  assert.equal(s.state, "insufficient");
  assert.match(s.reason ?? "", /^INSUFFICIENT DATA: 40 of 100/);
  assert.equal(s.winShare, null);
  assert.equal(s.meanNet, null);
});

test("at the gate: win share with the repo's Wilson interval and n", () => {
  const s = buildSource(input({ n: { emitted: 50, graded: 30, open: 20, excluded: 0 }, wins: 18 }), wilson);
  assert.equal(s.state, "ok");
  assert.equal(s.reason, null);
  assert.equal(s.winShare, 18 / 30);
  const w = wilsonInterval(18, 30);
  assert.equal(s.winLo, w.lo);
  assert.equal(s.winHi, w.hi);
  assert.equal(s.meanNet, 0.04);
  // The text never carries the share without the interval and n.
  assert.equal(resultText(s), "60% wins (95% interval 42% to 75%, n=30)");
  assert.equal(meanNetText(s), "+4.0% mean return");
});

test("the interval comes from the injected helper, not a formula in the shared file", () => {
  let calls = 0;
  const s = buildSource(input(), (k, n) => { calls++; assert.equal(k, 33); assert.equal(n, 60); return { lo: 0.111, hi: 0.999 }; });
  assert.equal(calls, 1);
  assert.equal(s.winLo, 0.111);
  assert.equal(s.winHi, 0.999);
  const src = read("shared/signalRecord.ts");
  assert.doesNotMatch(src, /Math\.sqrt|1\.96/);
});

test("calibration and counts-only sources never get a win share", () => {
  for (const kind of ["calibration", "counts_only"] as const) {
    const s = buildSource(input({ kind, wins: 33 }), wilson);
    assert.equal(s.state, "ok");
    assert.equal(s.winShare, null);
    assert.equal(s.winLo, null);
    assert.ok(s.reason && s.reason.length > 0);
    assert.doesNotMatch(resultText(s), /%/);
  }
});

test("a win-loss source whose summary reports no usable win count shows counts only", () => {
  for (const wins of [null, -1, 61, NaN]) {
    const s = buildSource(input({ wins }), wilson);
    assert.equal(s.state, "ok");
    assert.equal(s.winShare, null);
    assert.equal(resultText(s), "counts only");
  }
});

test("unavailable: reason set, counts null (never zero), no figures", () => {
  const s = unavailableSource(SOURCE_META.whale_follow, "could not be read: no such table: whale_follows");
  assert.equal(s.state, "unavailable");
  assert.match(s.reason ?? "", /no such table/);
  assert.deepEqual(s.n, { emitted: null, graded: null, open: null, excluded: null });
  assert.equal(s.winShare, null);
  assert.equal(s.meanNet, null);
  assert.equal(countText(s.n.emitted), "-");
  assert.equal(countText(0), "0");
  assert.match(resultText(s), /^UNAVAILABLE: /);
  assert.equal(unavailableSource(SOURCE_META.whale_follow, "  ").reason, "the store could not be read");
});

test("winsFromRate recovers the whole count from an unrounded rate; bad rates are null", () => {
  assert.equal(winsFromRate(17 / 43, 43), 17);
  assert.equal(winsFromRate(0, 0), 0);
  assert.equal(winsFromRate(NaN, 10), null);
  assert.equal(winsFromRate(1.2, 10), null);
  assert.equal(winsFromRate(null, 10), null);
});

test("mean net is shown in the unit the source reports it in", () => {
  const frac = buildSource(input({ meanNet: -0.125, meanNetScale: "fraction", meanNetUnit: "mean return on cash paid, after fees" }), wilson);
  assert.equal(meanNetText(frac), "-12.5% mean return on cash paid, after fees");
  const pct = buildSource(input({ meanNet: 7.3, meanNetScale: "percent", meanNetUnit: "mean net return on a $100 position" }), wilson);
  assert.equal(meanNetText(pct), "+7.3% mean net return on a $100 position");
  assert.equal(meanNetText(buildSource(input({ meanNet: null }), wilson)), null);
});

test("no pooling: the record has sources and no overall figure", () => {
  const a = buildSource(input({ id: "a" }), wilson);
  const b = buildSource(input({ id: "b", wins: 10 }), wilson);
  const r = makeSignalRecord([a, b], 123);
  assert.deepEqual(Object.keys(r).sort(), ["asOf", "defaultMinSample", "note", "sources"]);
  assert.equal(r.sources.length, 2);
  assert.notEqual(r.sources[0].winShare, r.sources[1].winShare);
  assert.match(r.note, /not comparable/);
  assert.match(r.note, /not a forecast and not a claim of edge/);
  for (const f of ["shared/signalRecord.ts", "server/signalRecord.ts", "client/src/components/edgelab/SignalRecordCard.tsx"]) {
    assert.doesNotMatch(read(f), /overall(WinShare|WinRate|Wins)|pooledWin|totalWins/, f);
  }
});

// ─── Server adapters with injected summaries ────────────────────────────────

const scoreRow = (over: Record<string, unknown> = {}) => ({
  source: "overall", count: 0, wins: 0, losses: 0, burns: 0, burnsEvaluated: 0, winRate: null, avgPct: null, totalPnLPct: 0,
  avgPeakPct: null, bestPct: null, worstPct: null, avgPnlPerContract: null, excludedNoQuote: 0, excludedNoFee: 0, priceBasis: "ask_in_bid_out_net_fees",
  ...over,
});
const expectancy = (over: Record<string, unknown> = {}) => ({
  rule: "graded", sizeUsd: 100, n: 0, skipped: 0, skippedReasons: {}, medianNetPct: null, meanNetPct: null,
  positiveShare: { yes: 0, of: 0, lo: null, hi: null }, worstNetPct: null, bestNetPct: null, sampleReady: false, minSample: 50,
  validation: "INSUFFICIENT DATA", validationReason: "0 of a 50-signal minimum", noData: 0, noDataShare: null, maxNoDataShare: 0.2, note: "",
  ...over,
});
const emptyCal = { n: 0, buckets: [], brier: null, brierBaseRate: null };

function fakeDeps(over: Partial<SignalRecordDeps> = {}): SignalRecordDeps {
  return {
    now: () => 1_800_000_000_000,
    wilson,
    mins: { odteCalibrationTotal: 40, odteLedgerPerBucket: 385, scenarioDays: 20, wienerDays: 50, cryptoGraded: 50 },
    whaleFollowStoreRows: () => 0,
    whalePerformance: (windowDays) => ({ asOf: 0, windowDays, totalTerminal: 0, bySource: [], overall: scoreRow() }) as any,
    whaleFollowSnapshot: () => ({ asOf: 0, total: 0, byStatus: { OPEN: 0, TRIMMING: 0, CLOSING: 0, CLOSED: 0, EXPIRED: 0 }, positions: [] }) as any,
    trackedSignals: () => [],
    odteAuditCounts: () => ({ fired: 0, open: 0, rejected: 0, firstAt: null }),
    odteCalibration: () => ({ asOf: 0, source: "prior", totalGradedFires: 0, buckets: [], rejectedCounterfactual: { n: 0, winRate: null, note: "" }, note: "" }) as any,
    odteIndexFee: () => null,
    odteLedger: () => [],
    predictionOutcomeRows: () => 0,
    edgeStats: (windowDays) => ({
      asOf: 0, windowDays, windowFrom: 1_700_000_000_000,
      whaleAlerts: { total: 0, graded: 0, pending: 0, ungradedNoMark: 0, legacyProxyExcluded: 0, hit30Rate: 0, avgPctReturn: 0 },
      regimeCalls: { total: 0, graded: 0, pending: 0, overallHitRate: 0, calibration: [], calibrationSessions: 0, legacyProxyGraded: 0 },
    }) as any,
    scenarioCounts: () => ({ predictionDays: 0, settledDays: 0 }),
    scenarioBrier: () => null,
    mapDayCounts: () => ({ mapped: 0, settled: 0 }),
    wienerScorecard: () => ({ days: 0, touch: emptyCal, close: emptyCal, minDays: 50, tested: false }),
    mmLogProbe: async () => "absent",
    mmStats: async () => ({ total: 0, graded: 0 }),
    crypto: () => ({ enterCoins: { total: 0, open: 0, graded: 0, noData: 0 }, graded: expectancy() as any, basis: "", currentVersion: "v" }),
    ...over,
  };
}

test("assemble: one row per source in a fixed order, each on its own basis, none pooled", async () => {
  const r = await assembleSignalRecord(fakeDeps());
  assert.deepEqual(r.sources.map((s) => s.id), SOURCE_ADAPTERS.map((a) => a.id));
  assert.equal(new Set(r.sources.map((s) => s.id)).size, r.sources.length);
  const noGate = new Set(["tracked_signals", "mm_matrix"]); // rows that never show a win share and have no gate of their own
  for (const s of r.sources) {
    assert.equal(s.state, noGate.has(s.id) ? "ok" : "insufficient", s.id);
    assert.ok(countsReconcile(s.n), s.id);
    assert.equal(s.winShare, null, s.id);
    assert.equal(s.meanNet, null, s.id);
    assert.ok(s.basis.entry && s.basis.exit && s.basis.costs, s.id);
    assert.equal(s.n.emitted, 0, s.id); // an empty store that was read is an observed 0
  }
  assert.equal(r.note, SIGNAL_RECORD_NOTE);
  assert.ok(!("overall" in r));
});

test("assemble: a store that throws is unavailable with the reason; the other rows are unaffected", async () => {
  const r = await assembleSignalRecord(fakeDeps({
    odteAuditCounts: () => { throw new Error("no such table: odte_alert_audit"); },
    mmLogProbe: async () => { throw new Error("EACCES: permission denied"); },
  }));
  const by = new Map(r.sources.map((s) => [s.id, s] as const));
  for (const id of ["odte_t1", "odte_option_ledger"]) {
    const s = by.get(id)!;
    assert.equal(s.state, "unavailable");
    assert.match(s.reason ?? "", /no such table: odte_alert_audit/);
    assert.equal(s.n.emitted, null);
    assert.equal(s.n.graded, null);
  }
  assert.equal(by.get("odte_t1")!.minSample, 40);
  // An unavailable source still states its own gate, not the default 30.
  assert.equal(by.get("odte_option_ledger")!.minSample, 385);
  assert.equal(by.get("odte_option_ledger")!.minSampleFrom, "source");
  assert.match(gateText(by.get("odte_option_ledger")!), /^minimum sample 385 option-graded fires per grade bucket \(this source's own gate\)$/);
  assert.equal(by.get("mm_matrix")!.state, "unavailable");
  assert.match(by.get("mm_matrix")!.reason ?? "", /EACCES/);
  assert.equal(by.get("whale_follow")!.state, "insufficient");
  assert.equal(by.get("whale_follow")!.n.emitted, 0);
});

test("whale follow-through: figures are the scoreboard row's own, on its 90-day window", () => {
  let asked = 0;
  const d = fakeDeps({
    whalePerformance: (windowDays) => { asked = windowDays; return { asOf: 0, windowDays, totalTerminal: 45, bySource: [], overall: scoreRow({ count: 40, wins: 14, losses: 26, avgPct: -0.18, excludedNoQuote: 3, excludedNoFee: 2 }) } as any; },
    whaleFollowSnapshot: () => ({ asOf: 0, total: 67, byStatus: { OPEN: 15, TRIMMING: 4, CLOSING: 3, CLOSED: 20, EXPIRED: 25 }, positions: [] }) as any,
  });
  const s = whaleFollowSource(d);
  assert.equal(asked, 90);
  assert.equal(s.state, "ok");
  // Store (default 0 rows) holds fewer than memory: emitted is the memory count and says so.
  assert.deepEqual(s.n, { emitted: 67, graded: 40, open: 22, excluded: 5 });
  assert.ok(s.notes.some((x) => /emitted counts the 67 positions held in memory/.test(x)));
  // Store readable and larger: emitted is the store's count; rows not in memory are excluded and said so.
  const big = whaleFollowSource({ ...d, whaleFollowStoreRows: () => 900 });
  assert.deepEqual(big.n, { emitted: 900, graded: 40, open: 22, excluded: 838 });
  assert.ok(countsReconcile(big.n));
  assert.ok(big.notes.some((x) => /store holds 900 positions and 67 are held in memory/.test(x)));
  // Store unreadable but memory populated: memory counts, labelled.
  const mem = whaleFollowSource({ ...d, whaleFollowStoreRows: () => { throw new Error("no such table: whale_follows"); } });
  assert.equal(mem.n.emitted, 67);
  assert.ok(mem.notes.some((x) => /positions held in memory: the whale_follows table could not be read \(no such table/.test(x)));
  // Failed hydration: the store has rows, memory has none. Never "emitted 0".
  const cold = whaleFollowSource(fakeDeps({ whaleFollowStoreRows: () => 300 }));
  assert.deepEqual(cold.n, { emitted: 300, graded: 0, open: 0, excluded: 300 });
  // Store unreadable and memory empty: unknown, so the source is unavailable.
  assert.throws(() => whaleFollowSource(fakeDeps({ whaleFollowStoreRows: () => { throw new Error("locked"); } })), /could not be read and no positions are held in memory: locked/);
  assert.equal(s.winShare, 14 / 40);
  assert.equal(s.winLo, wilsonInterval(14, 40).lo);
  assert.equal(s.meanNet, -0.18);
  assert.equal(s.minSampleFrom, "default");
  assert.match(s.basis.entry, /ask/);
  assert.match(s.basis.exit, /bid/);
  assert.match(s.basis.costs, /fee per contract/);
});

test("tracked signals: counts only (no summary function), mid to mid stated", () => {
  const mk = (source: string, status: string, at: number) => ({ id: `${source}${at}`, source, symbol: "SPY", entry: { at }, status, statusAt: at }) as any;
  const all = [
    ...Array.from({ length: 31 }, (_, i) => mk("flow-alert", "CLOSED", 1000 + i)),
    mk("manual", "OPEN", 5000), mk("unusual-flow", "EXPIRED", 900),
  ];
  const s = trackedSignalsSource(fakeDeps({ trackedSignals: () => all }));
  assert.equal(s.kind, "counts_only");
  assert.deepEqual(s.n, { emitted: 33, graded: 32, open: 1, excluded: 0 });
  assert.equal(s.state, "ok");
  // Under 30 it is still what it is: counts only, no countdown to a share that never comes.
  const few = trackedSignalsSource(fakeDeps({ trackedSignals: () => all.slice(0, 4) }));
  assert.equal(few.state, "ok");
  assert.equal(resultText(few), kindText("counts_only"));
  assert.doesNotMatch(resultText(few), /INSUFFICIENT|needed/);
  assert.equal(few.minSampleFrom, "not_applicable");
  assert.equal(gateText(few), "no minimum sample applies to this row");
  assert.equal(s.winShare, null);
  assert.equal(s.since, 900);
  assert.match(s.basis.exit, /mid to mid/);
  assert.match(s.basis.costs, /no fees/);
});

test("0DTE option ledger: the 385 gate is per grade bucket; no share is pooled across buckets", () => {
  const bucket = (label: string, n: number, wins: number) => ({ label, n, wins, avgWinReturn: null, avgLossReturn: null, winRate: n ? wins / n : null, wilsonLo: null, wilsonHi: null, labelStatus: n >= 385 ? "ledger_backed" : "heuristic", minFiresForLedgerBacked: 385, positionContracts: {}, returnDefinition: "" }) as any;
  let feeAsked = -1;
  const d = fakeDeps({
    odteAuditCounts: () => ({ fired: 120, open: 5, rejected: 300, firstAt: 1_700_000_000_000 }),
    odteLedger: (fee) => { feeAsked = fee; return [bucket("72-79", 30, 12), bucket("80-84", 50, 26)]; },
  });
  const gross = odteOptionLedgerSource(d);
  assert.equal(feeAsked, 0);
  assert.match(gross.basis.costs, /before fees/);
  assert.equal(gross.state, "insufficient");
  assert.equal(gross.reason, "INSUFFICIENT DATA: 50 of 385 needed in one grade bucket (largest: 80-84); the gate is per bucket, not on the 80 graded in total");
  assert.equal(gross.winShare, null);
  assert.deepEqual(gross.n, { emitted: 120, graded: 80, open: 5, excluded: 35 });
  assert.equal(gateText(gross), "minimum sample 385 option-graded fires per grade bucket (this source's own gate)");
  const net = odteOptionLedgerSource({ ...d, odteIndexFee: () => 0.95 });
  assert.equal(feeAsked, 0.95);
  assert.match(net.basis.costs, /\$0\.95 per contract per side/);

  // 400 fires spread over the buckets: over 385 in total, but every bucket is still heuristic. Counts only.
  const spread = odteOptionLedgerSource(fakeDeps({
    odteAuditCounts: () => ({ fired: 450, open: 0, rejected: 0, firstAt: null }),
    odteLedger: () => [bucket("72-79", 80, 40), bucket("80-84", 80, 44), bucket("85-89", 80, 50), bucket("90-94", 80, 52), bucket("95-100", 80, 60)],
  }));
  assert.equal(spread.n.graded, 400);
  assert.equal(spread.state, "insufficient");
  assert.equal(spread.winShare, null);
  assert.match(spread.reason ?? "", /^INSUFFICIENT DATA: 80 of 385 needed in one grade bucket/);

  // One bucket at the gate: the share shown is that bucket's own (the ledger's figure), named, with its own n.
  const one = odteOptionLedgerSource(fakeDeps({
    odteAuditCounts: () => ({ fired: 520, open: 0, rejected: 0, firstAt: null }),
    odteLedger: () => [bucket("72-79", 100, 30), bucket("80-84", 390, 195)],
  }));
  assert.equal(one.state, "ok");
  assert.equal(one.n.graded, 490);
  assert.equal(one.winN, 390);
  assert.equal(one.winShare, 195 / 390);          // not (30 + 195) / 490
  assert.equal(one.winLo, wilsonInterval(195, 390).lo);
  assert.match(resultText(one), /^50% wins \(95% interval 45% to 55%, n=390; grade bucket 80-84 only, the ledger's largest; the ledger states no figure across buckets\)$/);
  assert.ok(one.notes.some((x) => /grade buckets at the ledger's gate: 80-84;/.test(x)));
});

test("regime calls: independent sessions are the sample; repeats and legacy rows are excluded and counted", () => {
  const d = fakeDeps({
    edgeStats: (windowDays) => ({
      asOf: 0, windowDays, windowFrom: 1_700_000_000_000,
      whaleAlerts: { total: 0, graded: 0, pending: 0, ungradedNoMark: 0, legacyProxyExcluded: 0, hit30Rate: 0, avgPctReturn: 0 },
      regimeCalls: {
        total: 900, graded: 700, pending: 150, overallHitRate: 0.6, legacyProxyGraded: 50, calibrationSessions: 35,
        calibration: [{ predictedProb: 0.4, actualHitRate: 0.5, n: 20, hits: 10 }, { predictedProb: 0.6, actualHitRate: 0.6, n: 15, hits: 9 }],
      },
    }) as any,
  });
  const s = regimeCallsSource(d);
  assert.deepEqual(s.n, { emitted: 900, graded: 35, open: 150, excluded: 50 + 665 });
  assert.equal(s.state, "ok");
  assert.equal(s.winShare, 19 / 35);
  assert.equal(s.since, 1_700_000_000_000);
});

test("scenario odds: the source's own day gate holds the figures back", () => {
  const brier = (n: number, gated: boolean) => ({ n, total: 0.61, trivialTotal: 0.64, topPickHits: Math.floor(n / 2), topPickN: n, gated, minDays: 20 });
  const under = scenarioOddsSource(fakeDeps({ scenarioCounts: () => ({ predictionDays: 12, settledDays: 10 }), scenarioBrier: () => brier(10, true) }));
  assert.equal(under.state, "insufficient");
  assert.equal(under.minSample, 20);
  assert.equal(under.winShare, null);
  assert.ok(!under.notes.some((x) => /Brier score/.test(x)));
  const over = scenarioOddsSource(fakeDeps({ scenarioCounts: () => ({ predictionDays: 70, settledDays: 68 }), scenarioBrier: () => brier(30, false) }));
  assert.equal(over.state, "ok");
  assert.equal(over.winShare, 15 / 30);
  assert.deepEqual(over.n, { emitted: 70, graded: 30, open: 2, excluded: 38 });
  assert.ok(over.notes.some((x) => /Brier score/.test(x)));
  // The figure is named for what it is, and the pooled forecasters are stated.
  assert.equal(over.winLabel, "top-pick hits");
  assert.match(resultText(over), /^50% top-pick hits \(95% interval /);
  assert.ok(over.notes.some((x) => /did not report which odds/.test(x)));
  const mixed = scenarioOddsSource(fakeDeps({ scenarioCounts: () => ({ predictionDays: 70, settledDays: 68 }), scenarioBrier: () => ({ ...brier(30, false), probSourceMix: { "risk-neutral-implied": 12, "hand-set-heuristic": 18 } }) }));
  assert.ok(mixed.notes.some((x) => x === "odds recorded as: risk-neutral-implied 12, hand-set-heuristic 18 (two forecasters are pooled in this row, as in the source's own score)"));
  const single = scenarioOddsSource(fakeDeps({ scenarioCounts: () => ({ predictionDays: 70, settledDays: 68 }), scenarioBrier: () => ({ ...brier(30, false), probSourceMix: { "risk-neutral-implied": 25, unrecorded: 5 } }) }));
  assert.ok(single.notes.some((x) => x === "odds recorded as: risk-neutral-implied 25, unrecorded 5"));
});

test("Wiener scorecard: a calibration row, gated at its own 50 days, never a win share", () => {
  const cal = { n: 400, buckets: [], brier: 0.19, brierBaseRate: 0.21 };
  const under = wienerOddsSource(fakeDeps({ mapDayCounts: () => ({ mapped: 30, settled: 28 }), wienerScorecard: () => ({ days: 27, touch: cal, close: cal, minDays: 50, tested: false }) }));
  assert.equal(under.state, "insufficient");
  // Says what the row is; never a countdown to a win share it will not show.
  assert.doesNotMatch(under.reason ?? "", /INSUFFICIENT DATA|needed/);
  assert.match(resultText(under), /^calibration: stated odds scored against outcomes; .* The source reads its scorecard from 50 graded; 27 so far$/);
  assert.ok(!under.notes.some((x) => /Brier/.test(x)));
  const over = wienerOddsSource(fakeDeps({ mapDayCounts: () => ({ mapped: 60, settled: 58 }), wienerScorecard: () => ({ days: 55, touch: cal, close: cal, minDays: 50, tested: true }) }));
  assert.equal(over.state, "ok");
  assert.equal(over.winShare, null);
  assert.deepEqual(over.n, { emitted: 60, graded: 55, open: 2, excluded: 3 });
  assert.ok(over.notes.some((x) => /touch odds: Brier 0\.19 against 0\.21/.test(x)));
});

test("crypto desk: the expectancy summary's own figures and its own INSUFFICIENT DATA label are respected", () => {
  const ok = cryptoDeskSource(fakeDeps({
    crypto: () => ({ enterCoins: { total: 90, open: 10, graded: 70, noData: 4 }, basis: "", currentVersion: "2026.11.17-1",
      graded: expectancy({ n: 60, skipped: 14, meanNetPct: -31.4, positiveShare: { yes: 21, of: 60, lo: 24.2, hi: 47.6 }, sampleReady: true, validation: "NO DEMONSTRATED EDGE", validationReason: null, noData: 4 }) as any }),
  }));
  assert.equal(ok.state, "ok");
  assert.deepEqual(ok.n, { emitted: 90, graded: 60, open: 10, excluded: 20 });
  assert.equal(ok.winShare, 21 / 60);
  assert.equal(ok.meanNet, -31.4);
  assert.equal(ok.meanNetScale, "percent");
  assert.equal(ok.minSampleFrom, "source");
  const selected = cryptoDeskSource(fakeDeps({
    crypto: () => ({ enterCoins: { total: 200, open: 10, graded: 100, noData: 80 }, basis: "", currentVersion: "v",
      graded: expectancy({ n: 60, skipped: 80, meanNetPct: 12, positiveShare: { yes: 40, of: 60, lo: 54, hi: 77 }, sampleReady: true, validation: "INSUFFICIENT DATA", validationReason: "80 of 140 graded signals (57%) could not be priced past the horizon", noData: 80 }) as any }),
  }));
  assert.equal(selected.state, "insufficient");
  assert.match(selected.reason ?? "", /could not be priced/);
  assert.equal(selected.winShare, null);
  assert.equal(selected.meanNet, null);
});

test("counts reconcile: emitted = graded + open + excluded on every row whose four counts are numbers", async () => {
  const bucket = (label: string, n: number, wins: number) => ({ label, lo: 0, hi: 0, n, wins, winRate: null, wilsonLo: null, wilsonHi: null, fitted: null, prior: 0.5, labelStatus: "heuristic", minFiresForLedgerBacked: 385 }) as any;
  const r = await assembleSignalRecord(fakeDeps({
    whaleFollowStoreRows: () => 510,
    whalePerformance: (windowDays) => ({ asOf: 0, windowDays, totalTerminal: 60, bySource: [], overall: scoreRow({ count: 50, wins: 20, avgPct: 0.01, excludedNoQuote: 6, excludedNoFee: 4 }) }) as any,
    // 3 terminal positions without a closing print sit in no scoreboard bucket: they must land in excluded.
    whaleFollowSnapshot: () => ({ asOf: 0, total: 500, byStatus: { OPEN: 400, TRIMMING: 20, CLOSING: 17, CLOSED: 30, EXPIRED: 33 }, positions: [] }) as any,
    trackedSignals: () => [{ id: "a", source: "manual", symbol: "SPY", entry: { at: 1 }, status: "OPEN", statusAt: 1 } as any],
    odteAuditCounts: () => ({ fired: 200, open: 12, rejected: 50, firstAt: 1 }),
    odteCalibration: () => ({ asOf: 0, source: "fitted", totalGradedFires: 150, buckets: [bucket("72-79", 90, 40), bucket("80-84", 55, 30)], rejectedCounterfactual: { n: 40, winRate: 0.4, note: "" }, note: "" }) as any,
    odteLedger: () => [bucket("72-79", 70, 30), bucket("80-84", 40, 20)],
    edgeStats: (windowDays) => ({
      asOf: 0, windowDays, windowFrom: 1,
      // total (graded + pending + ungraded) leaves the 9 legacy-proxy rows out: they are still emitted.
      whaleAlerts: { total: 131, graded: 100, pending: 20, ungradedNoMark: 11, legacyProxyExcluded: 9, hit30Rate: 0.31, avgPctReturn: -0.2 },
      regimeCalls: { total: 900, graded: 700, pending: 150, overallHitRate: 0.6, legacyProxyGraded: 50, calibrationSessions: 35, calibration: [{ predictedProb: 0.5, actualHitRate: 0.5, n: 35, hits: 18 }] },
    }) as any,
    scenarioCounts: () => ({ predictionDays: 70, settledDays: 68 }),
    scenarioBrier: () => ({ n: 30, total: 0.6, trivialTotal: 0.64, topPickHits: 15, topPickN: 29, gated: false, minDays: 20 }),
    mapDayCounts: () => ({ mapped: 60, settled: 58 }),
    wienerScorecard: () => ({ days: 55, touch: emptyCal, close: emptyCal, minDays: 50, tested: true }),
    mmLogProbe: async () => "present",
    mmStats: async () => ({ total: 400, graded: 380 }),
    crypto: () => ({ enterCoins: { total: 90, open: 10, graded: 70, noData: 4 }, basis: "", currentVersion: "v", graded: expectancy({ n: 60, skipped: 20, meanNetPct: -3, positiveShare: { yes: 21, of: 60, lo: 24, hi: 47 }, sampleReady: true, validation: "NO DEMONSTRATED EDGE", validationReason: null }) as any }),
  }));
  for (const s of r.sources) {
    const all = [s.n.emitted, s.n.graded, s.n.open, s.n.excluded].every((v) => typeof v === "number");
    assert.ok(all, `${s.id}: every count is a number in this fixture`);
    assert.equal(s.n.emitted, (s.n.graded as number) + (s.n.open as number) + (s.n.excluded as number), s.id);
  }
  const by = new Map(r.sources.map((s) => [s.id, s] as const));
  assert.deepEqual(by.get("whale_follow")!.n, { emitted: 510, graded: 50, open: 437, excluded: 23 });      // 10 unscored + 3 without a print + 10 not in memory
  assert.deepEqual(by.get("whale_alert_expiry")!.n, { emitted: 140, graded: 100, open: 20, excluded: 20 }); // 11 no mark + 9 legacy
});

test("counts that cannot add up are unknown (null), never forced", async () => {
  assert.equal(remainder(10, 4, 3), 3);
  assert.equal(remainder(10, 8, 3), null);
  // The source reports more graded than emitted: the remainder is unknown.
  const t1 = odteT1Source(fakeDeps({
    odteAuditCounts: () => ({ fired: 10, open: 2, rejected: 0, firstAt: null }),
    odteCalibration: () => ({ asOf: 0, source: "prior", totalGradedFires: 12, buckets: [{ label: "72-79", lo: 72, hi: 79, n: 12, wins: 5 }], rejectedCounterfactual: { n: 0, winRate: null, note: "" }, note: "" }) as any,
  }));
  assert.equal(t1.n.excluded, null);
  assert.ok(!countsReconcile(t1.n));
  const mm = await mmMatrixSource(fakeDeps({ mmLogProbe: async () => "present", mmStats: async () => ({ total: 5, graded: 9 }) }));
  assert.equal(mm.n.open, null);
  assert.equal(mm.n.excluded, null);
  assert.ok(mm.notes.some((x) => /open and excluded are unknown/.test(x)));
  // An input whose four numbers disagree is not passed through as if it added up.
  const bad = buildSource(input({ n: { emitted: 100, graded: 60, open: 30, excluded: 3 } }), wilson);
  assert.equal(bad.n.excluded, null);
  assert.ok(bad.notes.some((x) => /do not add up/.test(x)));
  assert.equal(countText(bad.n.excluded), "-");
});

test("a row that never shows a win share carries its own gate or none, never the default 30", () => {
  assert.deepEqual(gateFor("win_loss", null), { minSample: 30, from: "default" });
  assert.deepEqual(gateFor("calibration", null), { minSample: 0, from: "not_applicable" });
  assert.deepEqual(gateFor("counts_only", null), { minSample: 0, from: "not_applicable" });
  assert.deepEqual(gateFor("calibration", 50), { minSample: 50, from: "source" });
  const u = unavailableSource(SOURCE_META.mm_matrix, "x");
  assert.equal(u.minSampleFrom, "not_applicable");
});

test("whale alerts held to expiry: legacy-proxy rows are emitted and excluded", () => {
  const s = whaleAlertExpirySource(fakeDeps({
    edgeStats: (windowDays) => ({ asOf: 0, windowDays, windowFrom: 5, whaleAlerts: { total: 60, graded: 40, pending: 12, ungradedNoMark: 8, legacyProxyExcluded: 7, hit30Rate: 10 / 40, avgPctReturn: -0.3 }, regimeCalls: {} }) as any,
  }));
  assert.deepEqual(s.n, { emitted: 67, graded: 40, open: 12, excluded: 15 });
  assert.equal(s.winShare, 10 / 40);
});

test("assemble: the edge stats two rows share are computed once", async () => {
  let calls = 0, probes = 0;
  const base = fakeDeps();
  const r = await assembleSignalRecord({ ...base, edgeStats: (w) => { calls++; return base.edgeStats(w); }, predictionOutcomeRows: () => { probes++; return 0; } });
  assert.equal(calls, 1);
  assert.equal(probes, 1);
  assert.equal(r.sources.length, SOURCE_ADAPTERS.length);
  // A failure is shared too: both rows are unavailable, and it is still one call.
  let failed = 0;
  const f = await assembleSignalRecord({ ...base, edgeStats: () => { failed++; throw new Error("database is locked"); } });
  assert.equal(failed, 1);
  for (const id of ["whale_alert_expiry", "regime_calls"]) {
    const s = f.sources.find((x) => x.id === id)!;
    assert.equal(s.state, "unavailable");
    assert.match(s.reason ?? "", /database is locked/);
  }
});

test("getSignalRecord: concurrent callers on a cold cache share one assembly", async () => {
  _resetSignalRecordCache();
  let loads = 0;
  const load = async () => { loads++; await new Promise((r) => setTimeout(r, 15)); return fakeDeps(); };
  const [a, b, c] = await Promise.all([getSignalRecord(false, load), getSignalRecord(false, load), getSignalRecord(false, load)]);
  assert.equal(loads, 1);
  assert.equal(a, b);
  assert.equal(b, c);
  await getSignalRecord(false, load);          // warm cache: no new assembly
  assert.equal(loads, 1);
  await getSignalRecord(true, load);           // forced: one more
  assert.equal(loads, 2);
  // A failed assembly is not cached and does not stick as the in-flight promise.
  _resetSignalRecordCache();
  await assert.rejects(getSignalRecord(false, async () => { throw new Error("boom"); }), /boom/);
  await new Promise((r) => setTimeout(r, 0));
  const ok = await getSignalRecord(false, load);
  assert.equal(ok.sources.length, SOURCE_ADAPTERS.length);
  _resetSignalRecordCache();
});

// ─── The server module calls the existing summaries; it does not re-derive them ──

test("server module reads each source through its existing summary function", () => {
  const src = read("server/signalRecord.ts");
  const wired: Array<[string, RegExp]> = [
    ["./validationMath", /\{ wilsonInterval, MIN_FIRES_FOR_POINT_ESTIMATE \} = await import\("\.\/validationMath"\)/],
    ["./whaleFollowThrough", /\{ getPerformanceSnapshot, getFollowSnapshot \} = await import\("\.\/whaleFollowThrough"\)/],
    ["./signalTracker", /\{ getAllTracked \} = await import\("\.\/signalTracker"\)/],
    ["./gradeCalibration", /\{ getCalibrationReport, MIN_TOTAL \} = await import\("\.\/gradeCalibration"\)/],
    ["./odteGrader", /\{ getOptionLedgerSummary, configuredIndexFee \} = await import\("\.\/odteGrader"\)/],
    ["./edgeStats", /\{ computeEdgeStats \} = await import\("\.\/edgeStats"\)/],
    ["./calibration", /\{ rollingBrier, CALIBRATION_MIN_DAYS \} = await import\("\.\/calibration"\)/],
    ["./odteMapLedger", /\{ ledgerSummary \} = await import\("\.\/odteMapLedger"\)/],
    ["./mmPredictions", /\{ empiricalStats, MM_PREDICTIONS_LOG_FILE \} = await import\("\.\/mmPredictions"\)/],
    ["./cryptoEngine", /\{ getCryptoSignals \} = await import\("\.\/cryptoEngine"\)/],
  ];
  for (const [name, re] of wired) assert.match(src, re, name);
  for (const call of ["getPerformanceSnapshot({ windowDays })", "getCalibrationReport()", "getOptionLedgerSummary(Date.now(), fee)", "computeEdgeStats(windowDays)", "rollingBrier(days)", "ledgerSummary(symbol).wienerScorecard", "empiricalStats()", "getCryptoSignals()", "wilsonInterval(k, n)"]) {
    assert.ok(src.includes(call), call);
  }
});

test("server module holds no grading or interval arithmetic of its own", () => {
  const src = read("server/signalRecord.ts");
  // No interval formula, no option P&L, no Brier: those live in the sources.
  assert.doesNotMatch(src, /Math\.sqrt|1\.96|\*\* ?2|Math\.pow/);
  assert.doesNotMatch(src, /scoreAskToBid|askToBidReturn|optionTradeDollars|netOptionReturn|signalReturn|summarizeExpectancy\(/);
  // The only SQL it runs is counts on a source's store (never a write, never a return or a price column).
  const sql = src.match(/SELECT[\s\S]*?FROM \w+/g) ?? [];
  assert.ok(sql.length >= 5);
  for (const q of sql) {
    assert.match(q, /COUNT\(|SUM\(CASE WHEN/, q);
    assert.doesNotMatch(q, /pct_return|option_return|option_exit|option_entry|hit_t1|hit_30|brier|mcap/i, q);
  }
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/);
  // Server modules come in as types only at the top, so nothing is opened on import.
  for (const line of src.split("\n").filter((l) => /^import .* from "\.\//.test(l))) assert.match(line, /^import type /, line);
});

test("the existing grading modules are not edited to feed the record", () => {
  for (const f of ["server/whaleScoreboard.ts", "server/gradeCalibration.ts", "server/odteGrader.ts", "server/edgeStats.ts", "server/calibration.ts", "server/signalTracker.ts", "shared/odteWiener.ts", "shared/cryptoExpectancy.ts"]) {
    assert.doesNotMatch(read(f), /signalRecord/, f);
  }
  // mmPredictions exports its log path for the existence probe and nothing else changed there.
  assert.match(read("server/mmPredictions.ts"), /export const MM_PREDICTIONS_LOG_FILE = LOG_FILE;/);
});

// ─── Wiring ─────────────────────────────────────────────────────────────────

test("route: GET /api/record/signals is registered once, read-only, under /api (behind the access gate)", () => {
  const routes = read("server/routes.ts");
  assert.equal(routes.split('"/api/record/signals"').length - 1, 1);
  assert.match(routes, /app\.get\("\/api\/record\/signals", async \(_req, res\) => \{\s+try \{\s+const \{ getSignalRecord \} = await import\("\.\/signalRecord"\);/);
  assert.doesNotMatch(routes, /app\.(post|put|patch|delete)\("\/api\/record/);
  // The gate is mounted on the whole /api prefix, and only /api/health sits before it.
  const index = read("server/index.ts");
  assert.match(index, /app\.use\("\/api", makeAccessGate\(/);
  assert.doesNotMatch(index, /api\/record/);
});

test("card: in the Edge Lab Truth panel, with failed, insufficient and unavailable states", () => {
  const truth = read("client/src/components/edgelab/TruthPanel.tsx");
  assert.match(truth, /import SignalRecordCard from "\.\/SignalRecordCard";/);
  assert.match(truth, /<SignalRecordCard \/>/);
  const card = read("client/src/components/edgelab/SignalRecordCard.tsx");
  assert.match(card, /queryKey: \["\/api\/record\/signals"\]/);
  assert.match(card, /q\.isError && <DataStateChip state="failed"/);
  assert.match(card, /data-testid="text-record-failed"/);
  assert.match(card, /r && !q\.isError &&/);          // a failed request never renders rows
  assert.match(card, /resultText\(s\)/);               // the tested text, not a local formatter
  assert.match(card, /countText\(value\)/);
  assert.match(card, /data-state="insufficient"/);
  assert.doesNotMatch(card, /insufficient: "(ok|partial)"/); // a thin sample is never dressed as a data-feed state
  assert.match(card, /unavailable: "unavailable"/);
  assert.doesNotMatch(card, /<table/);                 // stacked rows: nothing to overflow at 360 px
  assert.match(card, /min-h-6/);                       // the one interactive element is at least 24 px tall
  assert.doesNotMatch(card, /winShare|winLo|winHi/);   // the card never formats a share itself
});

test("copy: descriptive, no advice, no claim of edge, no probability-of-profit wording", () => {
  const texts = [
    SIGNAL_RECORD_NOTE,
    ...Object.values(SOURCE_META).flatMap((m) => [m.name, m.basis.entry, m.basis.exit, m.basis.costs]),
    read("client/src/components/edgelab/SignalRecordCard.tsx"),
  ].join("\n");
  assert.doesNotMatch(texts, /\b(should|recommend|buy now|sell now|guarantee|profitable|probability of profit|chance of profit|expected profit|outperform|beats the market)\b/i);
  assert.doesNotMatch(texts, /has an edge|proven edge|edge of \d/i);
  assert.match(SIGNAL_RECORD_NOTE, /What a win means differs by source and is stated per row/);
  assert.doesNotMatch(texts, /\p{Extended_Pictographic}/u);
  // Every win-loss source says what a win is.
  for (const m of Object.values(SOURCE_META)) if (m.kind === "win_loss") assert.match(m.basis.exit, /Win = /, m.id);
});
