// R3-4: client UI and engineering. Pure/server-side parts only (no React runtime here);
// the UI edits are covered by source-level assertions plus tsc.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("regime predictor: candidates carry a 0..100 heuristic score, not a probability claim", async () => {
  const { predictTransition } = await import("../../server/regimePredictor");
  const out: any = predictTransition({ audit: { dfi: 1.2, gammaZone: "positive" } } as any);
  assert.equal(out.scoreKind, "heuristic_softmax_weight");
  let sum = 0;
  for (const c of out.candidates) {
    assert.equal(c.score, Math.round(c.probability * 1000) / 10);
    sum += c.score;
  }
  assert.ok(Math.abs(sum - 100) < 0.6, `scores sum to ~100, got ${sum}`);
  assert.equal(out.confidenceScore, Math.round(out.confidence * 1000) / 10);
  // Headline and UI never say "% confidence" or a bare percent probability.
  assert.ok(!/%/.test(out.headline), out.headline);
  assert.match(out.headline, /heuristic \d+\/100|collecting data|audit incomplete/);
  const ui = read("client/src/components/RegimePredictPanel.tsx");
  assert.ok(!/% confidence/.test(ui));
  assert.match(ui, /heuristic score \{conf\}\/100/);
});

test("composite: social gauge has a display label, history key unchanged", async () => {
  const { computeComposite, GAUGE_BLOCK } = await import("../../server/composite");
  const base: any = {
    vol: { vix: { value: null }, vvix: { value: null }, vix9d: { value: null }, vix3m: { value: null }, skew: { value: null } },
    term: { ratio9dOver30d: null, ratio30dOver3m: null },
    gamma: { totalGex: 1e9, regime: "positive", callWall: 0, putWall: 0, maxPain: 0, zeroGamma: null, pcrOi: 1, pcrVol: 1 },
    fearGreed: null, aaii: null, spy: { price: 1, prevClose: 1, changePct: 0 },
    social: { score: 40, bullish: 7, bearish: 3, neutral: 0, posts: [], status: "ok" },
  };
  const g: any = computeComposite(base).gauges.find((x: any) => /Social/.test(x.name));
  assert.equal(g.name, "Social Sentiment (StockTwits + Reddit)");
  assert.equal(g.label, "Social Sentiment (StockTwits)");
  assert.equal(GAUGE_BLOCK[g.name], "crowd");
});

test("internal api: a handler that responds after returning is awaited; one that never responds ends in no_response", async () => {
  const { internalRoute, callInternal, _resetInternalRoutes } = await import("../../server/internalApi");
  _resetInternalRoutes();
  // Returns immediately, responds from a timer (used to be reported as no_response at once).
  internalRoute("/api/quotes", (_req: any, res: any) => { setTimeout(() => res.json({ late: true }), 15); });
  const late = await callInternal("/api/quotes", { noResponseMs: 500 });
  assert.equal(late.ok, true);
  assert.deepEqual(late.body, { late: true });
  // Never responds: bounded by noResponseMs (default 30 s), reported as 504 no_response.
  internalRoute("/api/models", async () => {});
  const t0 = Date.now();
  const never = await callInternal("/api/models", { noResponseMs: 30 });
  assert.equal(never.error, "no_response");
  assert.equal(never.status, 504);
  assert.ok(Date.now() - t0 < 1000);
  // Caller timeout still wins and reports "timeout".
  const to = await callInternal("/api/models", { timeoutMs: 20 });
  assert.equal(to.error, "timeout");
  _resetInternalRoutes();
});

test("self-calls: converted engines make no local HTTP hop; new routes are registered and allow-listed", async () => {
  for (const f of ["alphaFusion.ts", "headline.ts", "mmScheduler.ts", "regimeHistoryTicker.ts"]) {
    assert.ok(!/127\.0\.0\.1/.test(read(`server/${f}`)), `${f} still calls local HTTP`);
  }
  const routes = read("server/routes.ts");
  assert.ok(!/127\.0\.0\.1:\$\{\w+\}\/api\//.test(routes), "routes.ts still self-calls over HTTP");
  const { INTERNAL_ROUTES } = await import("../../server/internalApi");
  for (const p of ["/api/ohlc", "/api/regime", "/api/regime/predict", "/api/mm-snapshot", "/api/alpha-brief", "/api/gamma-levels-enhanced"]) {
    assert.ok((INTERNAL_ROUTES as readonly string[]).includes(p), p);
  }
  // Remaining HTTP in discord/edgeBriefing files is only the fallback for paths that are not registered.
  for (const f of ["discord.ts", "discordBatcaveCard.ts", "discordScheduler.ts", "edgeBriefing.ts"]) {
    assert.match(read(`server/${f}`), /isInternalRoute\(/, f);
  }
});

test("schwab token refresh failure logs status and error code only, never the body", () => {
  const s = read("server/schwab.ts");
  assert.ok(!/console\.warn\("\[schwab\] token refresh failed:", res\.status, errTxt\)/.test(s));
  assert.match(s, /token refresh failed:", res\.status, errCode/);
  assert.ok(!/message: errTxt/.test(s));
});

test("UI: unavailable heatseeker is never 0, empty/feed-down chart states differ, one shared chip", () => {
  const d = read("client/src/components/DepthSkewFlow.tsx");
  assert.match(d, /heatUnavailable/);
  assert.match(d, /pcrOI == null \? "unavailable"/);
  // every reduce() over rows has an initial value (empty arrays cannot throw)
  for (const m of d.matchAll(/\.reduce\(\(best[\s\S]*?\)\s*(?:\?\.strike|\.strike|,\s*\n?\s*\);)/g)) {
    assert.match(m[0], /(?:strikes|depthData|skewData|flowData)\[0\]/, m[0].slice(0, 80));
  }
  const c = read("client/src/components/ChartPanel.tsx");
  assert.match(c, /dataState === "empty"/);
  assert.match(c, /chart-feed-down/);
  assert.match(c, /servedFromCache/);
  const age = read("client/src/components/DataAgeChip.tsx");
  assert.match(age, /import DataStateChip/);
  for (const f of ["WhaleFlowPanel", "EdgeStatsPanel"]) assert.match(read(`client/src/components/${f}.tsx`), /DataStateChip/);
});
