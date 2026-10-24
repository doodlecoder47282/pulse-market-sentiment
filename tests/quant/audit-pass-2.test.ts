// Audit pass 2 (Models, Heatseeker, Regime, Flow): each test fails on the
// code as reviewed on 2026-10-23 and pins the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildHeatseeker } from "../../server/heatseeker";
import { rollingWindow, type GradedEntry } from "../../server/mlAccuracy";
import { mergeAlerts, alertKey, type FlowAlert } from "../../shared/flowAlerts";

const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

function chainFor0dte(expDate: string, rows: Array<{ K: number; side: "C" | "P"; oi: number; iv: number }>) {
  const callExpDateMap: any = { [`${expDate}:0`]: {} };
  const putExpDateMap: any = { [`${expDate}:0`]: {} };
  for (const r of rows) {
    const map = r.side === "C" ? callExpDateMap : putExpDateMap;
    const sym = `SPXW  ${expDate.slice(2).replace(/-/g, "")}${r.side}0${r.K}000`;
    map[`${expDate}:0`][`${r.K.toFixed(1)}`] = [{ symbol: sym, gamma: 0.001, delta: r.side === "C" ? 0.5 : -0.5, volatility: r.iv * 100, openInterest: r.oi, totalVolume: 0 }];
  }
  return { underlying: { last: 6700 }, callExpDateMap, putExpDateMap };
}

test("heatseeker walls are signed: a put-heavy expiry with no positive strike above spot has no call wall", () => {
  const nowMs = Date.UTC(2026, 9, 8, 15, 0); // 11:00 ET, PM-settled 0DTE
  // Every strike at or above spot is put-dominated (negative net); the old
  // -Infinity start named the least-negative one a "call wall".
  const chain: any = chainFor0dte("2026-10-08", [
    { K: 6700, side: "P", oi: 30000, iv: 0.12 },
    { K: 6725, side: "P", oi: 20000, iv: 0.12 },
    { K: 6750, side: "P", oi: 10000, iv: 0.12 },
    { K: 6650, side: "P", oi: 25000, iv: 0.14 },
  ]);
  const h = buildHeatseeker(chain, "$SPX", 6700, null, nowMs);
  assert.ok(h.strikes.filter((s) => s.strike >= 6700).every((s) => s.netGex < 0), "fixture: all strikes above spot negative");
  assert.equal(h.totals.callWall, null);
  assert.ok(h.totals.putWall != null && h.totals.putWall <= 6700);
  // One positive strike above spot: that is the call wall.
  const chain2: any = chainFor0dte("2026-10-08", [
    { K: 6700, side: "P", oi: 30000, iv: 0.12 },
    { K: 6725, side: "C", oi: 20000, iv: 0.12 },
    { K: 6650, side: "P", oi: 25000, iv: 0.14 },
  ]);
  const h2 = buildHeatseeker(chain2, "$SPX", 6700, null, nowMs);
  assert.equal(h2.totals.callWall, 6725);
});

test("flow alerts: the same condition on the next poll updates its row instead of adding a copy", () => {
  const mk = (type: string, strike: number | undefined, side: string | undefined, severity: FlowAlert["severity"], ts: number): FlowAlert =>
    ({ id: alertKey(type, "SPY", strike, side), ts, type: type as any, symbol: "SPY", strike, side: side as any, message: `${type} ${strike} ${severity}`, severity });
  const poll1 = [mk("WALL", 600, "C", "med", 1000), mk("BLOCK", 598, "P", "low", 1000)];
  const list1 = mergeAlerts([], poll1);
  assert.equal(list1.length, 2);
  const poll2 = [mk("WALL", 600, "C", "med", 2000), mk("BLOCK", 598, "P", "high", 2000), mk("UNUSUAL_VOL", 605, "C", "high", 2000)];
  const list2 = mergeAlerts(list1, poll2);
  assert.equal(list2.length, 3, "one new condition, two updated in place");
  const wall = list2.find((a) => a.id === alertKey("WALL", "SPY", 600, "C"))!;
  assert.equal(wall.ts, 1000, "unchanged severity keeps its first timestamp");
  const block = list2.find((a) => a.id === alertKey("BLOCK", "SPY", 598, "P"))!;
  assert.equal(block.severity, "high");
  assert.equal(block.ts, 2000, "a severity rise is a new event");
  assert.equal(list2.filter((a) => a.severity === "high").length, 2);
  // Twice the same poll: list unchanged.
  assert.deepEqual(mergeAlerts(list2, poll2).map((a) => a.id), list2.map((a) => a.id));
  // Copy says what OI is.
  const panel = src("client/src/components/FlowAlertsPanel.tsx");
  assert.doesNotMatch(panel, /wall building/);
  assert.doesNotMatch(panel, /generateAlertId/);
});

test("ML accuracy windows are session dates with n; no calls is null, not 0%", () => {
  const row = (sessionDate: string, ts: number, callCorrect: boolean | null): GradedEntry =>
    ({ sessionDate, ts, callCorrect, brier: 0.2, horizon: "1d", realizedClose: 1, realizedReturnPct: 0.1, realizedDate: sessionDate, call: callCorrect == null ? "abstain" : "bull", pUpBucket: 5 } as any);
  // 20 rows on 2 session dates: a "7" window covers 2 sessions, not 7 rows.
  const graded: GradedEntry[] = [];
  for (let i = 0; i < 10; i++) graded.push(row("2026-10-21", 1000 + i, i % 2 === 0));
  for (let i = 0; i < 10; i++) graded.push(row("2026-10-22", 2000 + i, true));
  const w7 = rollingWindow(graded, 7);
  assert.equal(w7.sessions, 2);
  assert.equal(w7.n, 20);
  assert.ok(Math.abs((w7.hitRate ?? 0) - 15 / 20) < 1e-9);
  const w1 = rollingWindow(graded, 1);
  assert.equal(w1.sessions, 1);
  assert.equal(w1.n, 10);
  assert.equal(w1.hitRate, 1);
  const abstains = rollingWindow(graded.map((g) => ({ ...g, callCorrect: null, call: "abstain" as const })), 7);
  assert.equal(abstains.hitRate, null);
  assert.equal(abstains.n, 0);
  const ml = src("server/mlAccuracy.ts");
  assert.match(ml, /directionalHitRate: calls\.length \? hits \/ calls\.length : null/);
  assert.match(ml, /rollingHitRate: w\.length \? wHits \/ w\.length : null/);
  const card = src("client/src/components/models/MLAccuracyCard.tsx");
  assert.doesNotMatch(card, /\["7d"/);
  assert.match(card, /rolling \(sessions\)/);
});

test("killbox: no vendor gamma outside (0, 1], unpriced contracts counted, no_iv state; cone footer comes from the server", () => {
  const routes = src("server/routes.ts");
  const kb = routes.slice(routes.indexOf('app.get("/api/killbox/forward"'), routes.indexOf('app.get("/api/killbox/stats"'));
  assert.doesNotMatch(kb, /\(c\.gamma \?\? 0\)/);
  assert.match(kb, /rawGamma != null && rawGamma > 0 && rawGamma <= 1 \? rawGamma : 0/);
  assert.match(kb, /if \(!\(gamma > 0\)\) \{ contractsUnpriced\+\+; continue; \}/);
  assert.match(kb, /dataState: contractsPriced > 0 \? "ok" : "no_iv"/);
  assert.match(kb, /regime: "long_gamma" \| "short_gamma" \| "indeterminate"/);
  const killbox = src("client/src/components/Killbox.tsx");
  assert.match(killbox, /value: p \? p\.exposure : null/);
  assert.match(killbox, /if \(v == null\) return "not priced";/);
  const models = src("client/src/components/ModelsPanel.tsx");
  assert.doesNotMatch(models, /VRP \(RV÷IV clamped 0\.7-1\.3\)/);
  assert.match(models, /traj\.methodology \?\?/);
  const dsf = src("client/src/components/DepthSkewFlow.tsx");
  assert.doesNotMatch(dsf, /sell_inferred/);
  const hs = src("client/src/components/Heatseeker.tsx");
  assert.match(hs, /\$\{expiry \?\? "nearest"\}\|\$\{strike\}/);
  assert.doesNotMatch(hs, /% from open/);
  const fae = src("server/flowAlertEngine.ts");
  assert.doesNotMatch(fae, /historically lifts/);
  assert.match(fae, /n=\$\{result\.inRegimeN\} in regime of \$\{result\.n\}/);
  const fp = src("client/src/components/FlowPanel.tsx");
  assert.match(fp, /if \(sum <= total \|\| sum === 0\) return \{ bought: b, sold: so, scale: 1, retagged: false \};/);
});
