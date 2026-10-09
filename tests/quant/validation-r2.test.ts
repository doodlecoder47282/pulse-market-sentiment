// R2-D — 0DTE plan replay, grade evidence, edge survival, threshold hold-out,
// backtest tolerance. Every expected value is hand-computed or from the cited
// reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  replayOdtePlan, gradeOdteOptionPnl, planUnderlyingCloseOutPct, netOptionReturn, etCloseMs, etDate,
  gradeLabelStatus, gradeEvidenceLine, savedMinuteBarsSql, mergeMinuteBars, ODTE_PLAN_RULES,
  MIN_FIRES_FOR_POINT_ESTIMATE, type MinuteBar, type OptionMark,
} from "../../server/validationMath";
import { formatOdteAlert } from "../../server/odteAlertEngine";

const near = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} +/- ${tol}, got ${a}`);

// 2026-07-15 is a normal session (EDT): 10:00 ET = 14:00 UTC, close 16:00 ET.
const T0 = Date.UTC(2026, 6, 15, 14, 0, 0);
const CLOSE = etCloseMs("2026-07-15");
const M = 60_000;
function flatBars(px: number, from = T0, to = CLOSE): MinuteBar[] {
  const out: MinuteBar[] = [];
  for (let t = from; t < to; t += M) out.push({ datetime: t, open: px, high: px, low: px, close: px });
  return out;
}
/** Bar i opens at T0 + i minutes. */
const setBar = (bars: MinuteBar[], i: number, b: Partial<MinuteBar>) => { bars[i] = { ...bars[i], ...b }; };
function marksFrom(fn: (t: number) => { bid: number; ask: number }, from = T0, to = CLOSE): OptionMark[] {
  const out: OptionMark[] = [];
  for (let t = from; t <= to - 1_000; t += M) out.push({ ts: t + 1_000, ...fn(t + 1_000) });
  return out;
}
const callPlan = { isCall: true, strike: 6000, entryAsk: 10.0, entryTs: T0, t1: 6010, stopLevel: 5990, optionStopPct: 0.2, closeMs: CLOSE };

// ─── Item 1: the published plan, replayed exactly ───────────────────────────

test("plan: a 1-minute poke through the stop does not stop; a 5-minute CLOSE beyond it does", () => {
  const bars = flatBars(6000);
  setBar(bars, 2, { low: 5985 });                 // 10:02 low pierces 5990 but the 10:05 candle closes 6000
  let r = replayOdtePlan({ ...callPlan }, bars);
  assert.equal(r.status, "ok");
  assert.equal(r.legs.length, 0, "no exit on an intrabar touch");
  assert.equal(r.remaining, 1);
  setBar(bars, 9, { low: 5986, close: 5989 });     // 10:09 bar closes the 10:05-10:10 candle at 5989 < 5990
  r = replayOdtePlan({ ...callPlan }, bars);
  assert.equal(r.legs.length, 1);
  assert.equal(r.legs[0].kind, "underlying_stop");
  assert.equal(r.legs[0].time, T0 + 10 * M);       // known at 10:10, the candle's close
  assert.equal(r.legs[0].underlyingPx, 5989);
  assert.equal(r.stoppedBeforeT1, true);
  // a close below the stop on a minute that is NOT a candle end is not a stop
  const b2 = flatBars(6000);
  setBar(b2, 7, { low: 5980, close: 5981 });       // 10:07 close, mid-candle
  assert.equal(replayOdtePlan({ ...callPlan }, b2).legs.length, 0);
});

test("plan: half at T1, runner sold at T2; option P&L is the quantity-weighted fill", () => {
  const bars = flatBars(6000);
  setBar(bars, 10, { high: 6011, close: 6008 });   // 10:10 T1 touch (known 10:11)
  setBar(bars, 30, { high: 6026, close: 6024 });   // 10:30 T2 touch (known 10:31)
  for (let i = 31; i < bars.length; i++) setBar(bars, i, { open: 6024, high: 6024, low: 6024, close: 6024 });
  const marks = marksFrom((t) => (t < T0 + 11 * M ? { bid: 9.9, ask: 10.1 } : t < T0 + 31 * M ? { bid: 13.0, ask: 13.2 } : { bid: 22.0, ask: 22.4 }));
  const g = gradeOdteOptionPnl({ ...callPlan, t2: 6025, bars, marks });
  assert.equal(g.status, "graded");
  assert.deepEqual(g.fills.map((f) => [f.kind, f.fraction, f.price]), [["t1_touch", 0.5, 13.0], ["t2_touch", 0.5, 22.0]]);
  // exit = 0.5 x 13.00 + 0.5 x 22.00 = 17.50; return = (17.50 - 10.00) / 10.00 = +75%
  near(g.exitPrice!, 17.5, 1e-12);
  near(g.realizedReturn!, 0.75, 1e-12);
  assert.equal(g.reason, "t2_touch");
  assert.equal(g.settledFraction, 0);
  // Without a T2 the plan sells everything at T1: (13.00 - 10.00) / 10.00 = +30%
  const all = gradeOdteOptionPnl({ ...callPlan, bars, marks });
  assert.deepEqual(all.fills.map((f) => [f.kind, f.fraction]), [["t1_touch", 1]]);
  near(all.realizedReturn!, 0.3, 1e-12);
});

test("plan: runner trail arms only on a 5-minute close beyond T1, then stops on a 5-minute close below the trail", () => {
  const bars = flatBars(6000);
  setBar(bars, 10, { high: 6011, close: 6009 });   // T1 touch; the 10:10-10:15 candle...
  for (let i = 11; i <= 14; i++) setBar(bars, i, { open: 6012, high: 6013, low: 6011, close: 6012 }); // ...closes 6012 > T1: armed at 10:15
  for (let i = 15; i <= 19; i++) setBar(bars, i, { open: 6006, high: 6007, low: 6005, close: 6006 }); // 10:20 close 6006 < trail 6007
  for (let i = 20; i < bars.length; i++) setBar(bars, i, { open: 6006, high: 6006, low: 6006, close: 6006 });
  const r = replayOdtePlan({ ...callPlan, t2: 6025 }, bars);
  assert.equal(r.trailArmedAt, T0 + 15 * M);
  assert.deepEqual(r.legs.map((l) => [l.kind, l.fraction, l.underlyingPx, l.time]),
    [["t1_touch", 0.5, 6010, T0 + 11 * M], ["trail_stop", 0.5, 6006, T0 + 20 * M]]);
  // Underlying close-out: 0.5 x (6010/6000 - 1) + 0.5 x (6006/6000 - 1) = 0.5 x 0.16667% + 0.5 x 0.1% = 0.13333%
  near(planUnderlyingCloseOutPct(true, 6000, r), 0.133333, 1e-5);
  // Without the arming close (candle closes 6009 < T1), the runner keeps the ORIGINAL stop: 6006 is not below 5990.
  const b2 = flatBars(6000);
  setBar(b2, 10, { high: 6011, close: 6009 });
  for (let i = 11; i < b2.length; i++) setBar(b2, i, { open: 6006, high: 6009, low: 6005, close: 6006 });
  const r2 = replayOdtePlan({ ...callPlan, t2: 6025 }, b2);
  assert.equal(r2.trailArmedAt, null);
  assert.deepEqual(r2.legs.map((l) => l.kind), ["t1_touch"]);
  assert.equal(r2.remaining, 0.5);
  assert.equal(r2.lastClose, 6006);
});

test("plan: runner held to the close settles half at intrinsic; fees charge one side on the settled half", () => {
  const bars = flatBars(6004);
  setBar(bars, 10, { high: 6011, close: 6004 });
  const marks = marksFrom((t) => (t < T0 + 11 * M ? { bid: 9.9, ask: 10.1 } : { bid: 12.0, ask: 12.2 }));
  const g = gradeOdteOptionPnl({ ...callPlan, t2: 6025, bars, marks, settlementValue: 6004.5 });
  assert.equal(g.status, "graded");
  assert.deepEqual(g.fills.map((f) => [f.kind, f.fraction, f.price]), [["t1_touch", 0.5, 12.0], ["settled_at_close", 0.5, 4.5]]);
  near(g.exitPrice!, 8.25, 1e-12);          // 0.5 x 12.00 + 0.5 x 4.50 (official close 6004.50 - 6000)
  assert.equal(g.settledFraction, 0.5);
  assert.equal(g.settled, false);
  // Net of $0.65/contract/side: gross (8.25 - 10.00) x 100 = -175.00; fees 0.65 x (1 + 0.5) = 0.975;
  // net -175.975 / premium 1,000.00 = -0.175975
  near(netOptionReturn(10, 8.25, 0.65, 0.5)!, -0.175975, 1e-12);
  // The boolean form is unchanged: settled whole position -> opening fee only.
  near(netOptionReturn(10, 4.5, 0.65, true)!, (450 - 1000 - 0.65) / 1000, 1e-12);
});

test("plan: -20% stop is on the BID (what can be sold), and after T1 it stops only the runner", () => {
  // Entry 10.00 -> stop price 8.00. Bid 8.05 / ask 7.95 is impossible; use bid 8.05 ask 8.45 (mid 8.25): no stop.
  const noStop = marksFrom((t) => (t < T0 + 5 * M ? { bid: 9.9, ask: 10.1 } : { bid: 8.05, ask: 8.45 }));
  const g0 = gradeOdteOptionPnl({ ...callPlan, bars: flatBars(6000), marks: noStop });
  assert.equal(g0.reason, "settled_at_close"); // bid never <= 8.00
  const atStop = marksFrom((t) => (t < T0 + 5 * M ? { bid: 9.9, ask: 10.1 } : { bid: 8.0, ask: 8.2 }));
  const g1 = gradeOdteOptionPnl({ ...callPlan, bars: flatBars(6000), marks: atStop });
  assert.equal(g1.reason, "option_stop");      // boundary: 8.00 <= 10.00 x 0.80
  near(g1.realizedReturn!, -0.2, 1e-12);
  // T1 half at 13.00, then the option bid collapses to 7.50 at 10:40 -> runner out at 7.50
  const bars = flatBars(6000);
  setBar(bars, 10, { high: 6011, close: 6008 });
  const marks = marksFrom((t) => (t < T0 + 11 * M ? { bid: 9.9, ask: 10.1 } : t < T0 + 40 * M ? { bid: 13.0, ask: 13.2 } : { bid: 7.5, ask: 7.7 }));
  const g = gradeOdteOptionPnl({ ...callPlan, t2: 6025, bars, marks });
  assert.deepEqual(g.fills.map((f) => [f.kind, f.fraction, f.price]), [["t1_touch", 0.5, 13.0], ["option_stop", 0.5, 7.5]]);
  near(g.realizedReturn!, (0.5 * 13 + 0.5 * 7.5 - 10) / 10, 1e-12); // +2.5%
});

test("plan: missing minute bars are never filled: a hole before the exit is ungraded (bar_gap)", () => {
  const bars = flatBars(6000).filter((b) => b.datetime !== T0 + 42 * M);
  const r = replayOdtePlan({ ...callPlan }, bars);
  assert.equal(r.status, "bar_gap");
  assert.equal(r.gapAt, T0 + 42 * M);
  const g = gradeOdteOptionPnl({ ...callPlan, bars, marks: marksFrom(() => ({ bid: 9.9, ask: 10.1 })) });
  assert.equal(g.status, "ungraded");
  assert.equal(g.reason, "bar_gap");
  // A hole AFTER the final exit does not matter.
  const b2 = flatBars(6000);
  setBar(b2, 4, { close: 5980, low: 5980 });     // stopped at 10:05
  const r2 = replayOdtePlan({ ...callPlan }, b2.filter((b) => b.datetime !== T0 + 42 * M));
  assert.equal(r2.status, "ok");
  assert.equal(r2.legs[0].kind, "underlying_stop");
  // Held to the close without the final minute bar: the 15:59 hole is a gap too
  const r3 = replayOdtePlan({ ...callPlan }, flatBars(6000).slice(0, -1));
  assert.equal(r3.status, "bar_gap");
  assert.equal(r3.gapAt, CLOSE - M);
});

test("plan: a fire inside a candle's last minute uses that candle's close but not its high/low", () => {
  const fire = T0 + 4 * M + 30_000;              // 10:04:30
  const bars = flatBars(6000);
  setBar(bars, 4, { high: 6020, low: 5980, close: 5985 }); // 10:04 bar: printed T1 before the fire; closes below the stop at 10:05
  const r = replayOdtePlan({ ...callPlan, entryTs: fire }, bars);
  assert.equal(r.hitT1, false, "the pre-fire high is look-ahead");
  assert.equal(r.legs[0].kind, "underlying_stop"); // the 10:05 close is observable after the fire
  assert.equal(r.legs[0].time, T0 + 5 * M);
});

test("half-day session: SPXW stops at 13:00 ET (Cboe), so exits and settlement use 13:00", () => {
  // 2026-11-27 (day after Thanksgiving) is an early close; EST = UTC-5 -> 18:00 UTC.
  assert.equal(etCloseMs("2026-11-27"), Date.UTC(2026, 10, 27, 18, 0, 0));
  assert.equal(etCloseMs("2026-12-24"), Date.UTC(2026, 11, 24, 18, 0, 0));
  assert.equal(etCloseMs("2026-11-25"), Date.UTC(2026, 10, 25, 21, 0, 0)); // regular day, 16:00 EST
  // A half-day fire held to the close settles on the 12:59 bar / 13:00 close.
  const t0 = Date.UTC(2026, 10, 27, 16, 0, 0);   // 11:00 EST
  const close = etCloseMs("2026-11-27");
  const bars = flatBars(6003, t0, close);
  const marks = marksFrom(() => ({ bid: 9.9, ask: 10.1 }), t0, close);
  const g = gradeOdteOptionPnl({ ...callPlan, entryTs: t0, closeMs: close, bars, marks });
  assert.equal(g.status, "graded");
  assert.equal(g.reason, "settled_at_close");
  assert.equal(g.exitTs, close);
  assert.equal(g.exitPrice, 3);
  assert.equal(etDate(close), "2026-11-27");
});

// ─── Item 1 (text): the alert prints the rules the replay applies ───────────

function sampleAlert(over: Record<string, unknown> = {}): any {
  return {
    setup: "FAILED_BREAK", side: "call", spot: 6001.2, asOf: T0,
    contract: { strike: 6000, last: null, bid: 9.8, ask: 10.0, delta: 0.52, key: "k", expiry: "2026-07-15" },
    reversionFrom: { name: "Put Wall", price: 5993.6 },
    t1: { name: "Call Wall", price: 6010, estPctGain: 45 },
    t2: { name: "Upside Pivot", price: 6025, estPctGain: 90 },
    stopPct: 20, stopLevel: 5990.6, t2TriggerLevel: 6010, t2TrailingStopLevel: 6007,
    greekSignals: "TickVol SLOPE UP", regime: "NEUTRAL",
    grade: { score: 86, letter: "A", reasoning: [] }, reasoning: [],
    ...over,
  };
}

test("alert text states the replayed plan with the exact levels", () => {
  const txt = formatOdteAlert(sampleAlert(), { label: "85-89", n: 10, wins: 8 }).content;
  assert.match(txt, /STOP \(all\):  option bid -20% \(bid <= \$8\.00 on a \$10\.00 fill\)  OR  5-min close BELOW 5990\.60/);
  assert.match(txt, /T1:  6010 .* ->  sell HALF on first touch/);
  assert.match(txt, /RUNNER: keeps the stop above until a 5-min close ABOVE 6010; then stop -> 5-min close BELOW 6007/);
  assert.match(txt, /T2:  6025 .* sell the rest on first touch/);
  assert.match(txt, /SCORE A  \(86\/100\)/);
  assert.doesNotMatch(txt, /CONFIDENCE/);
  // Wilson 95% for 8 of 10 = 49.0%-94.3% (Wilson 1927; see validation.test.ts)
  assert.match(txt, /ledger 85-89: 8\/10 option wins = 80% \(95% CI 49%-94%\), heuristic score/);
  // No T2 -> all out at T1 and no runner line
  const noT2 = formatOdteAlert(sampleAlert({ t2: undefined }), null).content;
  assert.match(noT2, /sell ALL on first touch/);
  assert.doesNotMatch(noT2, /RUNNER/);
  assert.match(noT2, /no ledger bucket for this score/);
  // The replay on the same numbers: a 5-minute close of 5990.59 stops, 5990.60 does not.
  const a = sampleAlert();
  const bars = flatBars(6001);
  setBar(bars, 4, { close: 5990.6, low: 5990 });
  assert.equal(replayOdtePlan({ isCall: true, entryTs: T0, closeMs: CLOSE, t1: a.t1.price, stopLevel: a.stopLevel }, bars).legs.length, 0);
  setBar(bars, 4, { close: 5990.59 });
  assert.equal(replayOdtePlan({ isCall: true, entryTs: T0, closeMs: CLOSE, t1: a.t1.price, stopLevel: a.stopLevel }, bars).legs[0].kind, "underlying_stop");
  assert.equal(ODTE_PLAN_RULES.optionStopPct, 0.2);
});

// ─── Item 3: grade letters are heuristic until the bucket has evidence ───────

test("grade label status uses the same evidence bar as the sizer's point estimate", () => {
  assert.equal(MIN_FIRES_FOR_POINT_ESTIMATE, 385);
  assert.equal(gradeLabelStatus(0), "heuristic");
  assert.equal(gradeLabelStatus(384), "heuristic");
  assert.equal(gradeLabelStatus(385), "ledger_backed");
  assert.match(gradeEvidenceLine({ label: "90-94", n: 0, wins: 0 }), /no option-graded fires yet, heuristic score/);
  assert.match(gradeEvidenceLine({ label: "90-94", n: 400, wins: 200 }), /200\/400 option wins = 50% \(95% CI 45%-55%\), ledger-backed/);
});

// ─── Item 2: saved minute bars, either schema ───────────────────────────────

test("saved spx_minute_bars are read in either writer's layout (real SQLite)", () => {
  const rows = [
    { t: T0, o: 6000, h: 6002, l: 5999, c: 6001 },
    { t: T0 + M, o: 6001, h: 6003, l: 6000, c: 6002 },
  ];
  // mlDataLog layout
  const a = new DatabaseSync(":memory:");
  a.exec(`CREATE TABLE spx_minute_bars (t INTEGER PRIMARY KEY, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL, source TEXT NOT NULL)`);
  for (const r of rows) a.prepare(`INSERT INTO spx_minute_bars VALUES (?, ?, ?, ?, ?, NULL, 'schwab')`).run(r.t, r.o, r.h, r.l, r.c);
  // hazardEngine layout
  const b = new DatabaseSync(":memory:");
  b.exec(`CREATE TABLE spx_minute_bars (ts INTEGER PRIMARY KEY, date TEXT NOT NULL, mod INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v INTEGER NOT NULL DEFAULT 0)`);
  for (const r of rows) b.prepare(`INSERT INTO spx_minute_bars VALUES (?, '2026-07-15', 30, ?, ?, ?, ?, 0)`).run(r.t, r.o, r.h, r.l, r.c);
  for (const db of [a, b]) {
    const cols = (db.prepare("PRAGMA table_info(spx_minute_bars)").all() as Array<{ name: string }>).map((c) => c.name);
    const sql = savedMinuteBarsSql(cols);
    assert.ok(sql);
    const got = db.prepare(sql!).all(T0, T0 + 10 * M) as any[];
    assert.deepEqual(got.map((g) => [g.datetime, g.open, g.high, g.low, g.close]), rows.map((r) => [r.t, r.o, r.h, r.l, r.c]));
  }
  assert.equal(savedMinuteBarsSql(["foo"]), null);
  // live wins on a duplicate bar
  const merged = mergeMinuteBars([{ datetime: T0, open: 1, high: 1, low: 1, close: 1 }], [{ datetime: T0, open: 2, high: 2, low: 2, close: 2 }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].close, 2);
});

// ─── Item 5: edge survival on the realized ledger ───────────────────────────

import { computeEdgeSurvival, repricedThetaOverHold } from "../../server/edgeSurvival";
import { kellyFromLedger, summarizeOptionReturns } from "../../server/validationMath";

const survIn = { gradeScore: 86, bid: 9.8, ask: 10.0, targetPct: 50, stopPct: 20, expectedHoldMin: 45 };

test("edge survival: no ledger evidence is never EXPRESS", () => {
  assert.equal(computeEdgeSurvival(survIn, null).verdict, "INSUFFICIENT_EVIDENCE");
  const empty = summarizeOptionReturns("85-89", []);
  const r = computeEdgeSurvival(survIn, empty);
  assert.equal(r.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(r.pSource, "no_evidence");
});

test("edge survival: a losing ledger stands down; a thin winning ledger is insufficient (sizer also 0)", () => {
  // 3 wins of +40%, 7 losses of -20%: mean = 0.3 x 0.4 - 0.7 x 0.2 = -0.02
  const losing = summarizeOptionReturns("85-89", [0.4, 0.4, 0.4, -0.2, -0.2, -0.2, -0.2, -0.2, -0.2, -0.2]);
  const a = computeEdgeSurvival(survIn, losing);
  assert.equal(a.verdict, "STAND_DOWN");
  near(a.grossEvPct, -2.0, 1e-9);
  // 3 wins of +50%, 2 losses of -20%: mean +22%, but the Wilson 95% lower bound of 3/5 is
  // 23.07% (center 0.55655, half-width 0.32584; Wilson 1927) -> 0.2307 x 0.5 - 0.7693 x 0.2 = -0.038
  const thin = summarizeOptionReturns("85-89", [0.5, 0.5, 0.5, -0.2, -0.2]);
  const b = computeEdgeSurvival(survIn, thin);
  near(b.grossEvPct, 22.0, 1e-9);              // 0.6 x 50 - 0.4 x 20
  near(b.pUsed, 0.231, 1e-3);                  // Wilson lower bound of 3/5
  assert.equal(b.verdict, "INSUFFICIENT_EVIDENCE");
  const k = kellyFromLedger({ bucket: thin, plannedB: 0.5, plannedL: 0.2 });
  assert.equal(k.fApplied, 0, "the sizer sizes zero on the same evidence");
  // gross - rows = net (the waterfall adds up)
  near(b.grossEvPct + b.rows.reduce((s, r) => s + r.pct, 0), b.netEvPct, 0.11);
});

test("edge survival: strong ledger + repriced theta -> EXPRESS; without contract inputs at most MARGINAL", () => {
  // 240 wins of +50%, 160 losses of -20% (n = 400 >= 385: point estimate p = 0.6)
  const rets = [...Array(240).fill(0.5), ...Array(160).fill(-0.2)];
  const strong = summarizeOptionReturns("85-89", rets);
  const noContract = computeEdgeSurvival(survIn, strong);
  near(noContract.netEvPct, 22.0, 1e-9);       // 0.6 x 0.5 - 0.4 x 0.2
  assert.equal(noContract.verdict, "MARGINAL");
  assert.equal(noContract.adverseNetEvPct, null);
  // ATM SPXW call, 12:00 EDT, 240 min to the 16:00 settlement, sigma 15%:
  // C = S (2N(sigma sqrt(T)/2) - 1) ~ S sigma sqrt(T) / sqrt(2 pi) = 8.567 (chainClock note)
  const now = Date.UTC(2026, 6, 15, 16, 0, 0);
  const S = 6700, sig = 0.15, T = 240 / 525_600;
  const c0 = S * sig * Math.sqrt(T) / Math.sqrt(2 * Math.PI);
  const full = computeEdgeSurvival({ ...survIn, bid: c0 - 0.05, ask: c0 + 0.05, spot: S, strike: S, type: "C", expiry: "2026-07-15", symbol: "SPXW", nowMs: now }, strong);
  assert.equal(full.theta.source, "repriced_black_scholes");
  assert.equal(full.verdict, "EXPRESS");
  // adverse = 22 - half spread (0.05 / ask) - extra theta (45 -> 67.5 min)
  const ask = c0 + 0.05;
  const extra = -S * sig * (Math.sqrt(195 / 525_600) - Math.sqrt(172.5 / 525_600)) / Math.sqrt(2 * Math.PI) / ask * 100;
  near(full.adverseNetEvPct!, 22 - (0.05 / ask) * 100 + extra, 0.15);
});

test("repriced theta over the hold (Black-Scholes ATM closed form; settles inside the hold = all extrinsic)", () => {
  const now = Date.UTC(2026, 6, 15, 16, 0, 0);   // 12:00 EDT
  const S = 6700, sig = 0.15;
  const c = (min: number) => S * sig * Math.sqrt(min / 525_600) / Math.sqrt(2 * Math.PI);
  const r = repricedThetaOverHold({ spot: S, strike: S, type: "C", expiry: "2026-07-15", symbol: "SPXW", bid: c(240) - 0.05, ask: c(240) + 0.05, holdMin: 45, nowMs: now })!;
  near(r.sigma, sig, 2e-4);
  near(r.cost, c(195) - c(240), 0.01);          // -0.84 per share: not 45/390 of a day's theta
  // 15:30 EDT, 45-minute hold passes the 16:00 PM settlement: the whole extrinsic value is lost.
  const late = Date.UTC(2026, 6, 15, 19, 30, 0);
  const r2 = repricedThetaOverHold({ spot: S, strike: S, type: "C", expiry: "2026-07-15", symbol: "SPXW", bid: c(30) - 0.02, ask: c(30) + 0.02, holdMin: 45, nowMs: late })!;
  assert.equal(r2.settlesWithinHold, true);
  near(r2.cost, -c(30), 0.01);
  assert.equal(repricedThetaOverHold({ spot: S, strike: S, type: "C", expiry: "bad", bid: 1, ask: 1.1, holdMin: 45, nowMs: now }), null);
});

test("edge survival never says EXPRESS when the sizer's Kelly is zero (seeded random ledgers)", () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const now = Date.UTC(2026, 6, 15, 16, 0, 0);
  for (let k = 0; k < 300; k++) {
    const n = 1 + Math.floor(rnd() * 500);
    const pWin = rnd();
    const rets = Array.from({ length: n }, () => (rnd() < pWin ? 0.1 + rnd() * 1.5 : -(0.05 + rnd() * 0.9)));
    const bucket = summarizeOptionReturns("85-89", rets);
    const target = 20 + rnd() * 80, stop = 10 + rnd() * 30;
    const r = computeEdgeSurvival({ ...survIn, targetPct: target, stopPct: stop, bid: 8.5, ask: 8.6, spot: 6700, strike: 6700, type: "C", expiry: "2026-07-15", symbol: "SPXW", nowMs: now }, bucket);
    const kelly = kellyFromLedger({ bucket, plannedB: target / 100, plannedL: stop / 100 });
    if (r.verdict === "EXPRESS") assert.ok(kelly.fApplied > 0, `EXPRESS with Kelly 0 at n=${n}`);
    if (kelly.fApplied <= 0) assert.notEqual(r.verdict, "EXPRESS");
  }
});

// ─── Items 7-8: threshold hold-out, ungraded visibility ─────────────────────

import {
  twoProportionZ, walkForwardThreshold, selectThresholdInSample, whaleGradingCoverage, WF_Z_CRIT, type WfRow,
} from "../../server/edgeStatsMath";
import { isOutcomeOnOptionMarks } from "../../server/validationMath";

test("two-proportion z (NIST 7.3.3) and the Bonferroni critical value", () => {
  // 30/50 vs 15/50: pooled p = 0.45, z = 0.3 / sqrt(0.45 x 0.55 x 0.04) = 3.015113 (hand / scipy)
  near(twoProportionZ(30, 50, 15, 50)!, 3.015113, 1e-6);
  assert.equal(twoProportionZ(1, 0, 1, 2), null);
  // scipy.stats.norm.ppf(1 - 0.05 / 3) = 2.128045
  near(WF_Z_CRIT, 2.128045, 1e-3);
});

function lcg(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function synthRows(seed: number, n: number, pHi: number, pLo: number): WfRow[] {
  const r = lcg(seed);
  const D = 86_400_000;
  return Array.from({ length: n }, (_, i) => {
    const value = r() * 40;                       // e.g. vol/OI 0-40x
    const p = value >= 20 ? pHi : pLo;
    return { t: i * D, knownAt: i * D + 2 * D, hit: (r() < p ? 1 : 0) as 0 | 1, value };
  });
}

test("walk-forward: a real effect survives out of sample; noise mined in-sample does not", () => {
  const real = walkForwardThreshold(synthRows(7, 240, 0.6, 0.2), [15, 20, 30]);
  assert.equal(real.status, "ok");
  assert.equal(real.supported, true, real.reason);
  assert.ok(real.oos.keptRate! > real.oos.droppedRate!);
  assert.ok(real.oos.keptWilsonLo! > 0.4 && real.oos.keptWilsonHi! < 0.8);
  // Null: hit rate 30% everywhere. Count how often the in-sample rule alone would
  // suggest vs how often the walk-forward gate supports a suggestion (seeded).
  // 1,000 null windows of 60 alerts, seven candidate cut-offs: the in-sample rule
  // fires on noise 9 times (seeded), the walk-forward gate 0 times.
  let inSample = 0, supported = 0;
  const sweep = [5, 10, 15, 20, 25, 30, 35];
  for (let k = 0; k < 1000; k++) {
    const rows = synthRows(1000 + k, 60, 0.3, 0.3);
    if (selectThresholdInSample(rows, sweep) != null) inSample++;
    if (walkForwardThreshold(rows, sweep).supported) supported++;
  }
  assert.ok(inSample > 0, "the in-sample rule alone does mine noise");
  assert.ok(supported <= 5, `false suggestions under the null: ${supported}/1000`);
  assert.ok(supported < inSample, `in-sample ${inSample}, walk-forward ${supported}`);
  // Too few rows: no test, no suggestion
  assert.equal(walkForwardThreshold(synthRows(3, 30, 0.9, 0.1), [20]).status, "insufficient_rows");
});

test("walk-forward purges training rows whose outcome was not known before the test fold", () => {
  const D = 86_400_000;
  // 60 rows one day apart, each outcome known 10 days later: the last 10 rows before each fold are purged.
  const rows: WfRow[] = Array.from({ length: 60 }, (_, i) => ({ t: i * D, knownAt: i * D + 10 * D, hit: (i % 2) as 0 | 1, value: i % 5 }));
  const wf = walkForwardThreshold(rows, [3]);
  assert.equal(wf.folds[0].purged, 10);
  assert.equal(wf.folds[0].trainN, 20); // rows 0..19 known before row 30 fires
});

test("whale coverage: ungraded_no_mark is counted and shown, never a miss; legacy proxy rows are excluded", () => {
  const ok = (ret: number) => ({ graded: 1, pctReturn: ret, outcomeJson: JSON.stringify({ result: "ok", method: "option_marks_v1" }) });
  const nomark = (reason: string) => ({ graded: 1, pctReturn: null, outcomeJson: JSON.stringify({ result: "ungraded_no_mark", method: "option_marks_v1", reason }) });
  const rows = [ok(0.4), ok(-0.2), ok(0.1), nomark("no_entry_quote_logged"), nomark("exit_quote_stale"), nomark("exit_quote_stale"),
    { graded: 0, pctReturn: null, outcomeJson: null }, { graded: 1, pctReturn: 0.5, outcomeJson: JSON.stringify({ result: "ok" }) }];
  const c = whaleGradingCoverage(rows.map((r) => ({ ...r, kind: "whale_alert" })), isOutcomeOnOptionMarks);
  assert.equal(c.graded, 3);
  assert.equal(c.pending, 1);
  assert.equal(c.ungradedNoMark, 3);
  near(c.ungradedShare!, 0.5, 1e-12);          // 3 / (3 + 3)
  assert.deepEqual(c.ungradedReasons, { no_entry_quote_logged: 1, exit_quote_stale: 2 });
  assert.equal(c.legacyProxyExcluded, 1);
  assert.equal(c.total, 7);
});
