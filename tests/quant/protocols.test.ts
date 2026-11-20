// The protocol book (shared/protocols.ts): triggers, grading, the counts-only record and the level-hit log.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROTOCOL_BOOK_VERSION, PROTOCOL_RULES, protocolBook, evalWallRejection, evalSweepReclaim, evalNewsWindow, evalProtocols, findSweep,
  gradeProtocol, protocolRecord, levelHits, completedRecent, protocolsWatching, type ProtocolCtx,
} from "../../shared/protocols";
import type { BoardLevel, IntraBar } from "../../shared/levelBoard";

const T0 = Date.UTC(2026, 10, 11, 16, 0); // 11:00 ET
const levels: BoardLevel[] = [
  { key: "wallAbove", label: "wall above", price: 7400, group: "options" },
  { key: "pdl+s1", label: "prior-day low + pivot S1", price: 7300, group: "prior day" },
  { key: "pdh", label: "prior-day high", price: 7450, group: "prior day" },
];
const ctx = (o: Partial<ProtocolCtx> = {}): ProtocolCtx => ({
  nowMs: T0, sessionOpen: true, minutesSinceOpen: 90, minutesToClose: 300, spx: 7398, levels, tech: "lagging", vix: "firm",
  calendarKnown: true, minutesToTier1: 600, minutesSinceTier1: 900, bars: [], ...o,
});
const bar = (minAgo: number, o: number, h: number, l: number, c: number): IntraBar => ({ t: T0 - minAgo * 60_000, open: o, high: h, low: l, close: c });

test("the book states its thresholds and is versioned", () => {
  const b = protocolBook();
  assert.equal(PROTOCOL_BOOK_VERSION, "2026.11.18-1");
  assert.deepEqual(b.map((p) => p.id), ["wall_rejection", "sweep_reclaim", "news_window"]);
  assert.match(b[0].expected, /^The rule's author looks for SPX to trade 20 points below the armed price within 90 minutes\. Untested\.$/);
  assert.ok(PROTOCOL_RULES.notAfterMin >= Math.max(PROTOCOL_RULES.wallRejection.horizonMin, PROTOCOL_RULES.sweepReclaim.horizonMin), "every horizon ends inside the session");
  for (const p of b) assert.doesNotMatch(p.expected + p.structure, /\bexpect|spread/i);
  assert.match(b[0].cancel, /10 points above the wall first/);
  assert.match(b[1].trigger, /2 to 10 points under a support level/);
  assert.equal(b[2].graded, false);
  for (const p of b) for (const s of [p.trigger, p.expected, p.cancel, p.structure]) assert.doesNotMatch(s, /\bbuy\b|\bsell\b|should|will |guarantee|edge|probab|%\s*chance/i);
});

test("wall rejection arms only with every condition met, and an unread input is never met", () => {
  const e = evalWallRejection(ctx());
  assert.equal(e.armed, true);
  assert.deepEqual([e.direction, e.entry, e.expectPrice, e.cancelPrice, e.horizonMin], ["down", 7398, 7378, 7410, 90]);
  assert.equal(evalWallRejection(ctx({ spx: 7380 })).armed, false, "20 points from the wall is not at it");
  assert.equal(evalWallRejection(ctx({ vix: "flat" })).armed, false);
  assert.equal(evalWallRejection(ctx({ tech: "in line" })).armed, false);
  const unread = evalWallRejection(ctx({ vix: "unknown" }));
  assert.equal(unread.armed, false);
  assert.equal(unread.conditions.find((c) => c.name === "VIX firm")!.met, null);
  assert.equal(evalWallRejection(ctx({ spx: null })).conditions[0].met, null);
  assert.equal(evalWallRejection(ctx({ levels: levels.slice(1) })).conditions[0].detail, "no wall above on the option map");
  assert.equal(evalWallRejection(ctx({ minutesSinceOpen: 5 })).armed, false);
  assert.equal(evalWallRejection(ctx({ minutesToClose: 80 })).armed, false);
  const staleMap = evalWallRejection(ctx({ optionsState: "stale" }));
  assert.deepEqual([staleMap.armed, staleMap.conditions[0].met, staleMap.conditions[0].detail], [false, null, "option map stale: wall not read"]);
  assert.equal(evalWallRejection(ctx({ sessionOpen: false })).armed, false);
  assert.equal(evalWallRejection(ctx({ minutesToTier1: 20 })).armed, false);
  assert.equal(evalWallRejection(ctx({ calendarKnown: false })).armed, false, "an unknown calendar is not quiet");
});

test("sweep and reclaim: under a support level by 2 to 10 points, then back above", () => {
  const bars = [bar(15, 7306, 7308, 7303, 7304), bar(10, 7304, 7305, 7295, 7297), bar(5, 7297, 7303, 7296, 7302)];
  const s = findSweep({ bars, levels, nowMs: T0 })!;
  assert.deepEqual([s.level.price, s.low, s.close], [7300, 7295, 7302]);
  const e = evalSweepReclaim(ctx({ spx: 7302, bars }));
  assert.equal(e.armed, true);
  assert.deepEqual([e.direction, e.entry, e.expectPrice, e.cancelPrice], ["up", 7302, 7317, 7295]);
  // Too shallow, too deep, not reclaimed, and never above the level inside the window.
  assert.equal(findSweep({ bars: [bar(10, 7304, 7305, 7299, 7300), bar(5, 7300, 7303, 7299.5, 7302)], levels, nowMs: T0 }), null);
  assert.equal(findSweep({ bars: [bar(10, 7304, 7305, 7280, 7285), bar(5, 7285, 7303, 7284, 7302)], levels, nowMs: T0 }), null);
  assert.equal(findSweep({ bars: [bar(10, 7304, 7305, 7295, 7297), bar(5, 7297, 7299, 7296, 7298)], levels, nowMs: T0 }), null);
  assert.equal(findSweep({ bars: [bar(10, 7296, 7299, 7294, 7297), bar(5, 7297, 7303, 7296, 7302)], levels, nowMs: T0 }), null);
  // Bars older than the lookback do not count.
  assert.equal(findSweep({ bars: [bar(40, 7304, 7305, 7295, 7297), bar(5, 7301, 7303, 7300.5, 7302)], levels, nowMs: T0 }), null);
  assert.equal(evalSweepReclaim(ctx({ bars: [] })).conditions[0].met, null);
  assert.equal(evalSweepReclaim(ctx({ spx: 7298, bars })).armed, false, "price already back under the level");
  assert.equal(evalSweepReclaim(ctx({ spx: null, bars })).armed, false);
  // The bar still forming is not used: its close is a live print.
  const forming = [bar(10, 7306, 7308, 7303, 7304), bar(5, 7304, 7305, 7295, 7297), bar(0, 7297, 7303, 7296, 7302)];
  assert.equal(findSweep({ bars: forming, levels, nowMs: T0 }), null);
  assert.equal(completedRecent({ bars: forming, nowMs: T0 }).length, 2);
  // Bars that are not current are "not read", not "no sweep".
  const old = evalSweepReclaim(ctx({ bars: [bar(60, 7306, 7308, 7303, 7304), bar(55, 7304, 7305, 7295, 7297)] }));
  assert.equal(old.conditions[0].met, null);
  assert.match(old.conditions[0].detail, /bars not current/);
  assert.equal(evalSweepReclaim(ctx({ bars, minutesToTier1: 10 })).armed, false);
});

test("the news window arms near a release, and the others cannot arm with it", () => {
  assert.equal(evalNewsWindow(ctx({ minutesToTier1: 25 })).armed, true);
  assert.equal(evalNewsWindow(ctx({ minutesSinceTier1: 10 })).armed, true);
  assert.equal(evalNewsWindow(ctx()).armed, false);
  assert.equal(evalNewsWindow(ctx({ calendarKnown: false })).armed, false);
  assert.equal(evalNewsWindow(ctx({ calendarKnown: false })).conditions[0].met, null);
  const all = evalProtocols(ctx({ minutesToTier1: 25 }));
  assert.deepEqual(all.map((e) => e.armed), [false, false, true]);
  assert.equal(PROTOCOL_RULES.newsBeforeMin, 30);
});

test("grading: expected first, cancel first, both in one bar, neither, open, no bars", () => {
  const e = { direction: "down" as const, expectPrice: 7378, cancelPrice: 7410, armedAt: T0, horizonMin: 90 };
  const after = (min: number, h: number, l: number): IntraBar => ({ t: T0 + min * 60_000, open: l, high: h, low: l, close: h });
  const late = T0 + 200 * 60_000;
  assert.equal(gradeProtocol(e, [after(5, 7400, 7390), after(10, 7392, 7377)], late).status, "expected");
  assert.equal(gradeProtocol(e, [after(5, 7411, 7395), after(10, 7392, 7370)], late).status, "cancelled");
  const both = gradeProtocol(e, [after(5, 7412, 7375)], late);
  assert.deepEqual([both.status, both.reason], ["cancelled", "both prices inside one bar: counted as cancelled"]);
  assert.equal(gradeProtocol(e, [after(5, 7400, 7390), after(89, 7399, 7385)], late).status, "neither");
  // Bars that stop short of the horizon are not evidence of "neither", however late it is.
  const short = gradeProtocol(e, [after(5, 7400, 7390), after(60, 7399, 7385)], late);
  assert.deepEqual([short.status, short.reason], ["open", "bars do not reach the end of the horizon yet"]);
  assert.equal(gradeProtocol(e, [after(5, 7400, 7390)], T0 + 6 * 60_000).status, "open");
  assert.equal(gradeProtocol(e, [], late).status, "ungraded");
  assert.equal(gradeProtocol(e, [], T0 + 60_000).status, "open");
  // Bars at or before the arm time and after the horizon are ignored.
  assert.equal(gradeProtocol(e, [after(0, 7400, 7300), after(90, 7400, 7300), after(91, 7400, 7300), after(89, 7400, 7390)], late).status, "neither");
  const up = { direction: "up" as const, expectPrice: 7317, cancelPrice: 7295, armedAt: T0, horizonMin: 90 };
  assert.equal(gradeProtocol(up, [after(5, 7318, 7300)], late).status, "expected");
  assert.equal(gradeProtocol(up, [after(5, 7310, 7294)], late).status, "cancelled");
});

test("the record is counts only and says untested until enough are graded", () => {
  assert.equal(protocolRecord([], true).text, "untested: 0 graded");
  assert.equal(protocolRecord(["open", "open"], true).text, "untested: 0 graded; 2 open");
  const r = protocolRecord(["expected", "expected", "cancelled", "neither", "open"], true);
  assert.equal(r.text, "4 graded: 2 reached the rule's outcome price, 1 cancelled, 1 neither; 1 open. Too few to judge (under 30).");
  assert.equal(r.tested, false);
  assert.doesNotMatch(r.text, /%|rate|win/);
  const many = protocolRecord(Array(20).fill("expected").concat(Array(12).fill("cancelled")), true);
  assert.equal(many.tested, true);
  assert.equal(many.text, "32 graded: 20 reached the rule's outcome price, 12 cancelled, 0 neither.");
  assert.equal(protocolRecord(["not_graded", "not_graded"], false).text, "armed 2 times; not graded (no price behaviour is stated)");
});

test("level hits: a cross between two reads, with the protocols that watch the level", () => {
  assert.deepEqual(levelHits(7395, 7401, levels), [{ key: "wallAbove", label: "wall above", price: 7400, direction: "up" }]);
  assert.deepEqual(levelHits(7302, 7299, levels).map((h) => [h.key, h.direction]), [["pdl+s1", "down"]]);
  assert.deepEqual(levelHits(7395, 7400, levels).map((h) => h.direction), ["up"], "landing on the level counts");
  assert.deepEqual(levelHits(7400, 7401, levels), [], "starting on the level is not a new cross");
  assert.deepEqual(levelHits(null, 7401, levels), []);
  assert.deepEqual(levelHits(7395, 7395, levels), []);
  assert.deepEqual(protocolsWatching("wallAbove"), ["At the wall above, VIX firm, tech lagging"]);
  // A level that moved between the two reads is not a cross.
  const moved = levels.map((l) => (l.key === "wallAbove" ? { ...l, price: 7398 } : l));
  assert.deepEqual(levelHits(7395, 7401, levels, moved), []);
  assert.deepEqual(levelHits(7395, 7401, levels, levels.filter((l) => l.key !== "wallAbove")), [], "a level that was not there at the last read");
  assert.deepEqual(protocolsWatching("pdl+s1"), ["Sweep under a level and reclaim"]);
  assert.deepEqual(protocolsWatching("pdh"), []);
});

test("wiring: engine starts with the server, stores nothing in the demo, and the card sits under the board", () => {
  const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  assert.match(routes, /app\.get\("\/api\/desk\/protocols"/);
  assert.match(routes, /startProtocolEngine\(\)/);
  const eng = readFileSync(new URL("../../server/protocolEngine.ts", import.meta.url), "utf8");
  assert.match(eng, /if \(editionFromEnv\(\) === "demo"\) return;/);
  assert.match(eng, /spx && spx\.quoteState === "ok" \? spx\.price : null/);
  assert.doesNotMatch(eng, /postToDiscord|placeOrder|sendMessage/);
  const desk = readFileSync(new URL("../../client/src/components/TradeDesk.tsx", import.meta.url), "utf8");
  assert.ok(desk.indexOf("<DeskBoard />") < desk.indexOf("<DeskProtocols />") && desk.indexOf("<DeskProtocols />") < desk.indexOf("<OdteMapCard />"));
  const card = readFileSync(new URL("../../client/src/components/DeskProtocols.tsx", import.meta.url), "utf8");
  assert.match(card, /A category only: not a suggestion to trade; no contract, size or order\./);
  assert.match(card, /Rule author's stated outcome \(untested\):/);
  assert.doesNotMatch(card, />Expected:|did what was expected/);
  // Stale inputs are not reads; one release is one row.
  assert.match(eng, /tech: okQ\("QQQ"\) && okQ\("SPY"\) \? board\.tech\.state : "unknown"/);
  assert.match(eng, /vix: okQ\("\$VIX"\) \? board\.vix\.state : "unknown"/);
  assert.match(eng, /l\.group !== "options" \|\| board\.cases\.optionsState === "ok"/);
  assert.match(eng, /PROTOCOL_RULES\.newsBeforeMin \+ PROTOCOL_RULES\.newsAfterMin \+ 5/);
  assert.match(eng, /lastRead\.delete\(t\.symbol\)/);
});

test("context row: taken from the rule's own context, so it carries the gated reads and the merged lines the rule saw", async () => {
  const { contextRow } = await import("../../shared/protocols");
  const raw = { qqqPct: -1.2, spyPct: -0.5, vixPct: 4, quotes: { SPX: "ok", QQQ: "stale", SPY: "ok", VIX: "ok" }, optionsAsOfMs: 900 };
  const ctx: any = {
    nowMs: 1_000, sessionOpen: true, minutesSinceOpen: 45, minutesToClose: 345, spx: 7200,
    levels: [
      { key: "wallAbove+pdh", label: "wall above 7,250 + prior-day high 7,253", price: 7253, group: "prior day" },
      { key: "pdl", label: "prior-day low", price: 7100, group: "prior day" },
      { key: "flip", label: "gamma flip", price: 7300, group: "options" },
    ],
    optionsState: "ok", tech: "unknown", vix: "firm", calendarKnown: true, minutesToTier1: 600, minutesSinceTier1: null, bars: [],
  };
  const row = contextRow(ctx, "2026-11-20", raw);
  assert.deepEqual(row.optionLines, [{ key: "wallAbove+pdh", price: 7253 }, { key: "flip", price: 7300 }], "the merged line and price the rule compared against, not the raw landmark");
  assert.equal(row.tech, "unknown", "a stale QQQ quote: the rule saw no tech read, and that is what is written");
  assert.deepEqual([row.vix, row.spx, row.calendarKnown, row.minutesToTier1, row.minutesSinceOpen, row.session], ["firm", 7200, true, 600, 45, "2026-11-20"]);
  assert.deepEqual(row.raw, raw, "what sat behind the gated reads is kept beside them");
  const unread = contextRow({ ...ctx, spx: null, levels: [], optionsState: "stale" }, "2026-11-20", raw);
  assert.deepEqual([unread.spx, unread.optionLines.length, unread.optionsState], [null, 0, "stale"]);
});

test("wiring: the context write comes after the rules run and cannot stop them", () => {
  const src = readFileSync(new URL("../../server/protocolEngine.ts", import.meta.url), "utf8");
  const evalAt = src.indexOf("const evals = evalProtocols(ctx);");
  const writeAt = src.indexOf("INSERT OR REPLACE INTO desk_rule_context");
  assert.ok(evalAt > 0 && writeAt > evalAt, "written after evaluation");
  const block = src.slice(src.lastIndexOf("try {", writeAt), src.indexOf("lastContextError = String", writeAt));
  assert.match(block, /contextRow\(ctx, today,/);
  assert.match(block, /\} catch \(e: any\) \{/, "its own try: a failed write is recorded, not thrown into the tick");
});
