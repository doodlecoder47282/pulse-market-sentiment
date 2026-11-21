import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardChartLevels, checkLevels, BOARD_LEVEL_MAX, BOARD_LEVEL_REACH } from "../../shared/levelConfluence";

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

test("wiring: the chart-levels card checks the board with nothing typed, and the ticker scan starts on a default", () => {
  const card = readFileSync("client/src/components/ChartLevelsCard.tsx", "utf8");
  assert.match(card, /queryKey: \["\/api\/desk\/board"\]/, "the same key the level board uses: no extra request");
  assert.match(card, /boardChartLevels\(board\.data\?\.tickers\?\.find\(\(t\) => t\.symbol === symbol\)\?\.levels, m\?\.spot \?\? null\)/);
  assert.match(card, /filter\(\(p\) => !levels\.includes\(p\)\)/, "a level the user also typed is shown once, in their list");
  assert.match(card, /The level board could not be read \(the request failed\), so its levels are not checked\./);
  const scan = readFileSync("client/src/components/TickerScanCard.tsx", "utf8");
  assert.match(scan, /export const DEFAULT_SCAN_SYMBOL = "SPY";/);
  assert.match(scan, /localStorage\.getItem\(KEY\) \|\| DEFAULT_SCAN_SYMBOL/);
});
