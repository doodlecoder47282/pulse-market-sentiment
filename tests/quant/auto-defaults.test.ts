import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardChartLevels, boardSource, checkLevels, BOARD_LEVEL_MAX, BOARD_LEVEL_REACH } from "../../shared/levelConfluence";
import { mergeLevels, type BoardLevel } from "../../shared/levelBoard";

const L = (price: number, label: string, group = "prior day") => ({ price, label, group });

test("the board's bar levels near the price are taken, with their names, highest first; option landmarks are left out", () => {
  const r = boardChartLevels([L(7094, "pivot S1", "pivots"), L(7046, "gamma flip", "options"), L(6968, "straddle low", "options"), L(7000, "prior-day low"), L(7150, "today's open", "today")], 7018);
  assert.deepEqual(r, { levels: [{ price: 7150, label: "today's open" }, { price: 7094, label: "pivot S1" }, { price: 7000, label: "prior-day low" }], beyond: 0 });
});

test("levels further than the map's reach are counted, not checked; duplicates and bad prices are dropped", () => {
  assert.equal(BOARD_LEVEL_REACH, 0.02);
  const r = boardChartLevels([L(7000, "a"), L(7000, "a again"), L(7140, "edge"), L(7141, "just outside"), L(6500, "20-session low", "range"), L(NaN, "bad"), L(0, "zero")], 7000);
  assert.deepEqual(r.levels.map((l) => l.price), [7140, 7000]);
  assert.equal(r.beyond, 2);
});

test("at most the nearest dozen are kept", () => {
  const many = Array.from({ length: 30 }, (_, i) => L(7000 + (i - 15) * 4, `l${i}`));
  const r = boardChartLevels(many, 7000);
  assert.equal(r.levels.length, BOARD_LEVEL_MAX);
  assert.ok(r.levels.every((l) => Math.abs(l.price - 7000) <= 24));
  assert.ok(r.levels.every((l, i) => i === 0 || r.levels[i - 1].price > l.price));
});

test("no price or no board gives nothing, not a guess", () => {
  assert.deepEqual(boardChartLevels(null, 7000), { levels: [], beyond: 0 });
  assert.deepEqual(boardChartLevels([L(7000, "a")], null), { levels: [], beyond: 0 });
  assert.deepEqual(boardChartLevels([L(7000, "a")], 0), { levels: [], beyond: 0 });
});

test("the board's levels go through the same check as typed ones", () => {
  const map = { spot: 7018, strikes: [{ strike: 7000, share: 0.3, gexPct: -9.2e9, label: null }, { strike: 7095, share: 0.01, gexPct: -1e8, label: null }] };
  const auto = boardChartLevels([L(7094, "pivot S1", "pivots"), L(7000, "prior-day low")], 7018);
  const checks = checkLevels(map as any, auto.levels.map((l) => l.price));
  assert.deepEqual(checks.map((c) => [c.level, c.tag]), [[7094, "weak"], [7000, "chain"]]);
});

// The board as the server builds it: bar levels and option landmarks, merged with the real mergeLevels.
const BARS: BoardLevel[] = [
  { key: "pdh", label: "prior-day high", price: 7048.6, group: "prior day" },
  { key: "pdl", label: "prior-day low", price: 6998.2, group: "prior day" },
  { key: "pp", label: "pivot", price: 7020, group: "pivot" },
];
const OPTS: BoardLevel[] = [
  { key: "wall", label: "wall above", price: 7050, group: "options" },
  { key: "magnet", label: "magnet below", price: 6995, group: "options" },
];
const payload = (o: any = {}) => ({
  forSession: "2026-11-20", sessionOpen: true,
  cases: { symbol: "$SPX", levelsWithoutOptions: mergeLevels(BARS, 7018) },
  tickers: [{ symbol: "$SPX", levelsState: "ok", levelsReason: null, levels: mergeLevels([...BARS, ...OPTS], 7018) }],
  ...o,
});

test("why the full list cannot be filtered by group: the real merge mixes landmarks into bar lines both ways", () => {
  const full = mergeLevels([...BARS, ...OPTS], 7018);
  const byGroup = boardChartLevels(full, 7018).levels;
  assert.ok(!byGroup.some((l) => /prior-day high/.test(l.label)), "the prior-day high went with the wall's line");
  assert.ok(byGroup.some((l) => /magnet below/.test(l.label)), "and an option landmark came through under a bar line");
  // The list the card reads instead has neither fault.
  const src = boardSource({ failed: false, board: payload(), symbol: "$SPX" });
  const used = boardChartLevels(src.levels, 7018).levels;
  assert.deepEqual(used.map((l) => l.label), ["prior-day high", "pivot", "prior-day low"]);
  assert.ok(!used.some((l) => /wall|magnet/.test(l.label)));
  assert.deepEqual([src.state, src.notice], ["ok", null]);
});

test("a board that was not read is never a board with no levels", () => {
  assert.deepEqual(boardSource({ failed: false, board: undefined, symbol: "$SPX" }).state, "reading");
  const failed = boardSource({ failed: true, board: undefined, symbol: "$SPX" });
  assert.deepEqual([failed.state, failed.levels.length], ["failed", 0]);
  assert.match(failed.notice!, /could not be read \(the request failed\)/);
  const noBars = boardSource({ failed: false, symbol: "$SPX", board: payload({ cases: { symbol: "$SPX", levelsWithoutOptions: [] }, tickers: [{ symbol: "$SPX", levelsState: "unavailable", levelsReason: "no daily bars from Schwab for $SPX: self-throttle (100 requests/min)" }] }) });
  assert.equal(noBars.state, "unavailable");
  assert.match(noBars.notice!, /were not read: no daily bars from Schwab for \$SPX: self-throttle/);
  assert.match(noBars.notice!, /This is not a board with no levels\./);
  assert.equal(boardSource({ failed: false, symbol: "$SPX", board: payload({ tickers: [] }) }).state, "unavailable", "the index is missing from the read");
  assert.equal(boardSource({ failed: false, symbol: "$SPX", board: payload({ cases: { symbol: "SPY", levelsWithoutOptions: mergeLevels(BARS, 7018) } }) }).state, "unavailable", "the option-free list is for another symbol");
});

test("levels held from an earlier read, for another session, or marked incomplete are shown with that said", () => {
  const held = boardSource({ failed: true, board: payload(), symbol: "$SPX" });
  assert.equal(held.levels.length, 3);
  assert.equal(held.state, "partial");
  assert.match(held.notice!, /^The latest read of the level board failed; these levels are from the read before it\./);
  const after = boardSource({ failed: false, symbol: "$SPX", board: payload({ forSession: "2026-11-23", sessionOpen: false }) });
  assert.match(after.notice!, /levels for the 2026-11-23 session; the option map beside them is the chain's latest\./);
  const part = boardSource({ failed: false, symbol: "$SPX", board: payload({ tickers: [{ symbol: "$SPX", levelsState: "partial", levelsReason: "daily bars are the copy kept from 2026-11-20 13:17 ET" }] }) });
  assert.equal(part.state, "partial");
  assert.match(part.notice!, /The board marks them incomplete: daily bars are the copy kept from 2026-11-20 13:17 ET\./);
});

test("wiring: the chart-levels card reads the board's option-free list with the level board's own timing, and says the board's state", () => {
  const card = readFileSync("client/src/components/ChartLevelsCard.tsx", "utf8");
  assert.match(card, /queryKey: \["\/api\/desk\/board"\]/);
  const desk = readFileSync("client/src/components/DeskBoard.tsx", "utf8");
  for (const opt of ["refetchInterval: 30_000", "staleTime: 15_000"]) { assert.ok(card.includes(opt) && desk.includes(opt), `${opt} in both, so the two share one read`); }
  assert.match(card, /boardSource\(\{ failed: board\.isError, board: board\.data, symbol \}\)/);
  assert.match(card, /boardChartLevels\(src\.levels, m\?\.spot \?\? null\)/);
  assert.doesNotMatch(card, /tickers\?\.find\([^)]*\)\?\.levels/, "never the full list");
  assert.match(card, /\{src\.notice && \(/, "the board's state is said above the rows too");
  assert.match(card, /The 0DTE map could not be read \(the request failed\)/);
  assert.match(card, /filter\(\(p\) => !levels\.includes\(p\)\)/);
  assert.doesNotMatch(readFileSync("client/src/components/TickerScanCard.tsx", "utf8"), /DEFAULT_SCAN_SYMBOL/, "the scan stays a lookup: a default would add Schwab requests to every app open");
});
