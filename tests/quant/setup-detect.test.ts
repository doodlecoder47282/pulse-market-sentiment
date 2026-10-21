// tests/quant/setup-detect.test.ts
//
// The setup detector fires only when every stated condition is met, names
// the blocker otherwise, and the grader applies the achievable-exit test
// conservatively. Fixture: SPX 7,659 with the 7,700 call wall.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSetups, gradeSetup, impliedMove1dPct, summarizeOutcomes, marginScore, rankSetups, type StructureInput, type FlowInput, type ContextInput } from "../../shared/setupDetect";
import { sectorOf } from "../../shared/sectors";
import { DEFAULT_SETUP_RULES } from "../../shared/setupRules";
import { minutesToNextTier1, MACRO_EVENTS } from "../../shared/macroCalendar";

const R = DEFAULT_SETUP_RULES;
const NOW = Date.UTC(2026, 9, 20, 15, 30); // 11:30 ET
const atWall: StructureInput = { spot: 7_697, callWall: 7_700, putWall: 7_630, gammaFlip: 7_655, regime: "positive", callWallShare: 0.22, putWallShare: 0.13, atmIv: 0.14 };
const putPrint: FlowInput = { type: "P", strike: 7_650, dte: 2, premium: 4_000_000, volOiRatio: 22, isNewStrike: false, tag: "AT_ASK", detectedAt: NOW - 10 * 60_000 };
const ctx: ContextInput = { nowMs: NOW, minutesSinceOpen: 120, minutesToClose: 270, minutesToTier1: 60 * 24 * 8, minutesSinceTier1: 60 * 24 * 12, calendarKnown: true, spreadPct: 0.0002 };

test("fade at the call wall fires when structure, regime, flow, calendar, session and cost all agree", () => {
  const { fired, blocked } = detectSetups(atWall, [putPrint], ctx, R);
  assert.equal(fired.length, 1);
  const c = fired[0];
  assert.equal(c.kind, "fade_call_wall");
  assert.equal(c.direction, "down");
  assert.equal(c.target, 7_655, "target is the flip below spot");
  assert.equal(c.invalidation, Math.round(7_700 * 1.002 * 1e4) / 1e4);
  assert.equal(c.features.flow?.premium, 4_000_000);
  assert.equal(c.ruleVersion, R.version);
  assert.ok(c.rMultiple >= 2, `reward to risk ${c.rMultiple}`);
  assert.equal(Math.round(c.margins.premium! * 100) / 100, 1.6, "print is 1.6x the premium floor");
  assert.ok(c.margins.rMultiple! >= 1 && c.margins.costMultiple > 1);

  // 7,695 against the same wall: R = 1.96, under the rule, so it is a named blocker.
  const tight = detectSetups({ ...atWall, spot: 7_695 }, [putPrint], ctx, R);
  assert.equal(tight.fired.length, 0);
  assert.ok(tight.blocked.find((b) => b.kind === "fade_call_wall")!.blockers.some((x) => /reward to risk 1\.9\d, rule needs 2/.test(x)));
  assert.ok(blocked.find((b) => b.kind === "breakout_above")!.blockers.some((x) => /dealer gamma long, a breakout needs short/.test(x)));
});

test("each missing condition is named as the blocker, and nothing fires", () => {
  const noFlow = detectSetups(atWall, [], ctx, R);
  assert.equal(noFlow.fired.length, 0);
  assert.ok(noFlow.blocked.find((b) => b.kind === "fade_call_wall")!.blockers.some((x) => /no confirming put print/.test(x)));

  const callPrint = { ...putPrint, type: "C" as const };
  assert.equal(detectSetups(atWall, [callPrint], ctx, R).fired.length, 0, "a call print does not confirm a fade down");

  const stale = { ...putPrint, detectedAt: NOW - 60 * 60_000 };
  assert.equal(detectSetups(atWall, [stale], ctx, R).fired.length, 0, "a print older than maxAgeMin does not confirm");

  const far = detectSetups({ ...atWall, spot: 7_660 }, [putPrint], ctx, R);
  assert.ok(far.blocked.find((b) => b.kind === "fade_call_wall")!.blockers.some((x) => /from the call wall/.test(x)));

  const event = detectSetups(atWall, [putPrint], { ...ctx, minutesToTier1: 30 }, R);
  assert.ok(event.blocked.find((b) => b.kind === "fade_call_wall")!.blockers.some((x) => /tier-1 event in 30 min/.test(x)));

  const late = detectSetups(atWall, [putPrint], { ...ctx, minutesToClose: 20 }, R);
  assert.ok(late.blocked.find((b) => b.kind === "fade_call_wall")!.blockers.some((x) => /to the close/.test(x)));

  const noCost = detectSetups(atWall, [putPrint], { ...ctx, spreadPct: null }, R);
  assert.ok(noCost.blocked.find((b) => b.kind === "fade_call_wall")!.blockers.some((x) => /cost not modelled/.test(x)));

  const wide = detectSetups(atWall, [putPrint], { ...ctx, spreadPct: 0.003 }, R);
  assert.ok(wide.blocked.find((b) => b.kind === "fade_call_wall")!.blockers.some((x) => /does not clear 3x/.test(x)));

  const hot = detectSetups({ ...atWall, atmIv: 0.6 }, [putPrint], ctx, R);
  assert.ok(hot.blocked.find((b) => b.kind === "fade_call_wall")!.blockers.some((x) => /news-priced tape/.test(x)));

  const unknownCal = detectSetups(atWall, [putPrint], { ...ctx, minutesToTier1: null, calendarKnown: false }, R);
  assert.equal(unknownCal.fired.length, 0, "an unknown calendar blocks: the gate cannot be checked, so it never passes");
  assert.ok(unknownCal.blocked.find((b) => b.kind === "fade_call_wall")!.blockers.some((x) => /calendar unknown/.test(x)));

  const justAfter = detectSetups(atWall, [putPrint], { ...ctx, minutesSinceTier1: 20 }, R);
  assert.ok(justAfter.blocked.find((b) => b.kind === "fade_call_wall")!.blockers.some((x) => /release 20 min ago, rule needs 60 after/.test(x)));

  const locked = detectSetups(atWall, [putPrint], { ...ctx, spreadPct: 0 }, R);
  assert.ok(locked.blocked.find((b) => b.kind === "fade_call_wall")!.blockers.some((x) => /zero spread/.test(x)));
});

test("breakout above fires in short gamma with a call print; implied move helper", () => {
  const s: StructureInput = { ...atWall, regime: "negative" };
  const callPrint: FlowInput = { ...putPrint, type: "C", strike: 7_720 };
  const { fired } = detectSetups(s, [callPrint], ctx, R);
  assert.deepEqual(fired.map((f) => f.kind), ["breakout_above"]);
  assert.equal(fired[0].direction, "up");
  assert.ok(fired[0].target > 7_695 && fired[0].invalidation < 7_700);
  assert.equal(Math.round(impliedMove1dPct(0.16)! * 1e4) / 1e4, Math.round((0.16 / Math.sqrt(252)) * 1e4) / 1e4);
  assert.equal(impliedMove1dPct(null), null);
});

test("gradeSetup: hit before invalidation, invalidation first, same-bar loss, expiry at the horizon close, open horizon", () => {
  const c = { direction: "down" as const, spot: 7_695, target: 7_655, invalidation: 7_715.4, horizonMin: 120, costPct: 0.0002 };
  const t0 = NOW;
  const bar = (min: number, o: number, h: number, l: number, cl: number) => ({ t: t0 + min * 60_000, open: o, high: h, low: l, close: cl });
  const hit = gradeSetup(c, t0, [bar(1, 7_695, 7_700, 7_690, 7_692), bar(2, 7_692, 7_693, 7_654, 7_660)], t0 + 3 * 60_000);
  assert.equal(hit.status, "hit");
  assert.equal(hit.exitPrice, 7_655);
  assert.equal(hit.movePct, Math.round(((7_695 - 7_655) / 7_695) * 1e4) / 1e4);
  assert.equal(hit.netPct, Math.round((hit.movePct! - 0.0002) * 1e4) / 1e4);

  const loss = gradeSetup(c, t0, [bar(1, 7_695, 7_716, 7_694, 7_710)], t0 + 3 * 60_000);
  assert.equal(loss.status, "invalidated");
  assert.ok(loss.movePct! < 0);

  const both = gradeSetup(c, t0, [bar(1, 7_695, 7_716, 7_650, 7_700)], t0 + 3 * 60_000);
  assert.equal(both.status, "invalidated");
  assert.match(both.reason!, /same bar/);

  const quiet = Array.from({ length: 120 }, (_, i) => bar(i + 1, 7_695, 7_698, 7_690, 7_693));
  const exp = gradeSetup(c, t0, quiet, t0 + 121 * 60_000);
  assert.equal(exp.status, "expired");
  assert.equal(exp.exitPrice, 7_693);

  const open = gradeSetup(c, t0, quiet.slice(0, 10), t0 + 11 * 60_000);
  assert.equal(open.status, "ungraded");
  assert.equal(open.reason, "horizon still open");

  const beforeOnly = gradeSetup(c, t0, [bar(-5, 7_700, 7_701, 7_699, 7_700)], t0 + 200 * 60_000);
  assert.equal(beforeOnly.status, "ungraded");
});

test("summarizeOutcomes gates at the minimum sample and gives a Wilson interval", () => {
  const few = summarizeOutcomes([0.01, -0.005, 0.002], 100);
  assert.equal(few.sampleReady, false);
  assert.equal(few.positive, 2);
  assert.equal(few.lo, null, "no interval below the gate: counts only, no probability claim");
  assert.equal(few.hi, null);
  assert.ok(few.meanNetPct != null);
  const many = summarizeOutcomes(Array.from({ length: 120 }, (_, i) => (i % 3 ? 0.004 : -0.006)), 100);
  assert.equal(many.sampleReady, true);
  assert.equal(many.n, 120);
  assert.ok(many.lo! < 0.6667 && many.hi! > 0.6667);
});

test("macro calendar: next tier-1 event from a fixed instant, unknown after validity", () => {
  const toMs = (ymd: string, h: number, m: number) => Date.parse(`${ymd}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`);
  const r = minutesToNextTier1(toMs("2026-10-28", 12, 0), toMs, MACRO_EVENTS);
  assert.equal(r.known, true);
  assert.equal(r.next?.name, "FOMC");
  assert.equal(r.minutes, 120);
  const after = minutesToNextTier1(toMs("2027-01-05", 12, 0), toMs, MACRO_EVENTS);
  assert.equal(after.known, false);
  assert.equal(after.minutes, null);
});

test("ranking: margin score is auditable, sector cap keeps one bet from filling the list", () => {
  const m = { premium: 2, volOi: 4, wallShare: 8, costMultiple: 1, rMultiple: 1, calendarQuiet: 100, impliedMoveRoom: 2 };
  const sc = marginScore(m);
  // Ranked margins only (calendar distance is a gate, not a merit): log2 1, 2, 3 (capped), 0, 0, 1 over a fixed six -> 7/6
  assert.equal(sc.score, Math.round((7 / 6) * 1000) / 1000);
  assert.equal(sc.parts.length, 7, "every margin is still shown");
  assert.equal(marginScore({ premium: null, volOi: null, wallShare: null, costMultiple: 1, rMultiple: 1, calendarQuiet: null, impliedMoveRoom: null }).score, 0, "exactly at every rule scores 0");
  assert.equal(marginScore({ ...m, impliedMoveRoom: null }).score, Math.round((6 / 6) * 1000) / 1000, "a missing margin counts 0, never raises a rank by omission");

  const mk = (symbol: string, premium: number) => ({ symbol, sector: sectorOf(symbol), margins: { ...m, premium } });
  const items = [mk("NVDA", 6), mk("AMD", 5), mk("AVGO", 4), mk("SPY", 3), mk("TSLA", 1.1), mk("PLTR", 1.05), mk("ZZZ", 1)];
  const top = rankSetups(items, 10, 2);
  assert.deepEqual(top.map((t) => t.symbol), ["NVDA", "AMD", "SPY", "TSLA", "PLTR", "ZZZ"], "AVGO is the third semiconductor and is capped out; ZZZ is its own sector");
  assert.ok(top[0].score > top[1].score);
  assert.equal(rankSetups(items, 2, 3).length, 2);
});
