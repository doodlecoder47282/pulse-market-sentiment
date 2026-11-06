// Gamma banner time and missing walls on the chart.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { asOfToMs } from "../../shared/asOfTime.ts";

test("asOf: seconds, milliseconds and ISO all read; junk is null (no 'Invalid Date')", () => {
  assert.equal(asOfToMs(1793858867), 1793858867000);
  assert.equal(asOfToMs(1793858867000), 1793858867000);
  assert.equal(asOfToMs("2026-11-05T05:47:47.000Z"), Date.parse("2026-11-05T05:47:47.000Z"));
  assert.equal(asOfToMs("1793858867"), 1793858867000);
  for (const bad of [null, undefined, "", "not a date", NaN, 0, -5, {}]) assert.equal(asOfToMs(bad as any), null, String(bad));
});

test("gamma-levels: the per-ticker branch sends epoch seconds like the SPY branch", () => {
  const r = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  const i = r.indexOf("// Per-ticker path — builds gamma from Schwab callExpDateMap/putExpDateMap");
  assert.ok(i > 0);
  const block = r.slice(i, i + 2500);
  assert.match(block, /asOf: Math\.floor\(Date\.now\(\) \/ 1000\)/);
  assert.doesNotMatch(block, /asOf: new Date\(\)\.toISOString\(\)/);
});

test("charts: a missing call or put wall is skipped, never formatted", () => {
  const lw = readFileSync(new URL("../../client/src/components/LightweightCandlestick.tsx", import.meta.url), "utf8");
  assert.match(lw, /if \(gamma\.callWall != null && Number\.isFinite\(gamma\.callWall\)\) add\(gamma\.callWall/);
  assert.match(lw, /if \(gamma\.putWall != null && Number\.isFinite\(gamma\.putWall\)\) add\(gamma\.putWall/);
  const svg = readFileSync(new URL("../../client/src/components/CandlestickChart.tsx", import.meta.url), "utf8");
  assert.match(svg, /\{gamma\.callWall != null && Number\.isFinite\(gamma\.callWall\) && \(/);
  assert.match(svg, /\{gamma\.putWall != null && Number\.isFinite\(gamma\.putWall\) && \(/);
});

test("Gamma context banner accepts a missing wall (pill hidden), matching the chart's nullable walls", () => {
  const b = readFileSync(new URL("../../client/src/components/GammaContextBanner.tsx", import.meta.url), "utf8");
  assert.match(b, /callWall: number \| null;/);
  assert.match(b, /putWall: number \| null;/);
  assert.match(b, /if \(value == null\) return null;/);
});
