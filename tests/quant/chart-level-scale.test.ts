// Chart levels vs candles: a level is drawn only on candles of its own
// underlying. Failing example before this fix: the chart on "^GSPC" loaded
// $SPX candles (about 6,834) while /api/gamma-levels answered ^GSPC with the
// SPY snapshot (call wall about 690), so the wall was drawn at 690 on an
// index axis and the banner read about -90% to every level.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chartUnderlying, levelsSourceFor, levelsMatchChart, INDEX_NOT_WIRED_REASON } from "../../shared/chartLevels";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("the S&P 500 index is one underlying under every spelling, and is never answered with SPY's levels", () => {
  for (const s of ["SPX", "spx", "^GSPC", "^SPX", "$SPX", " $spx.x "]) {
    assert.equal(chartUnderlying(s), "SPX", s);
    assert.equal(levelsSourceFor(s), "index_not_wired", s);
  }
  assert.equal(levelsSourceFor("SPY"), "spy_snapshot");
  assert.equal(levelsSourceFor("spy"), "spy_snapshot");
  for (const s of ["QQQ", "NVDA", "IWM"]) assert.equal(levelsSourceFor(s), "per_ticker", s);
  assert.match(INDEX_NOT_WIRED_REASON, /SPY's price scale/);
});

test("levels draw only on their own underlying's candles", () => {
  // The defect: SPY levels on index candles.
  assert.equal(levelsMatchChart("SPY", "^GSPC"), false);
  assert.equal(levelsMatchChart("SPY", "SPX"), false);
  assert.equal(levelsMatchChart("^GSPC", "SPY"), false);
  // Same underlying, any spelling.
  assert.equal(levelsMatchChart("SPY", "SPY"), true);
  assert.equal(levelsMatchChart("$SPX", "^GSPC"), true);
  assert.equal(levelsMatchChart("NVDA", "NVDA"), true);
  assert.equal(levelsMatchChart("QQQ", "NVDA"), false);
  // Nothing to compare: not drawn.
  for (const [a, b] of [[null, "SPY"], ["SPY", null], ["", "SPY"], [undefined, undefined]] as const) assert.equal(levelsMatchChart(a as any, b as any), false);
});

test("the route and the chart use the policy; no fixed SPX/SPY ratio anywhere in the path", () => {
  const routes = src("server/routes.ts");
  const at = routes.indexOf('app.get("/api/gamma-levels"');
  const route = routes.slice(at, routes.indexOf("app.get(", at + 10));
  assert.match(route, /const source = levelsSourceFor\(symbol\);/);
  assert.match(route, /if \(source === "index_not_wired"\) \{\n\s+return res\.json\(\{ symbol, supported: false, spot: null, levels: null, reason: INDEX_NOT_WIRED_REASON/);
  assert.doesNotMatch(route, /symbol === "\^GSPC" \|\| symbol === "SPX"/, "the index no longer takes the SPY branch");
  assert.doesNotMatch(route, /\*\s*10\b|\/\s*10\b/, "no hard-coded 10:1 conversion");
  const chart = src("client/src/components/ChartPanel.tsx");
  assert.match(chart, /const gammaSupported = gamma\?\.supported && gamma\.levels && levelsMatchChart\(gamma\.symbol, activeChart\);/);
  // Every chart engine receives levels only through gammaSupported.
  assert.equal((chart.match(/gamma=\{gammaSupported && showGamma \? gamma!\.levels : null\}/g) ?? []).length, 2);
  const svg = src("client/src/components/CandlestickChart.tsx");
  assert.doesNotMatch(svg, /symbol === "\^GSPC" \|\| symbol === "SPX"/);
  const banner = src("client/src/components/GammaContextBanner.tsx");
  assert.match(banner, /not drawn for \$\{symbol\}: \$\{unsupportedReason\}/, "the banner says why, instead of a generic SPX/SPY note");
});
