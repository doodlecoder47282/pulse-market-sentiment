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
