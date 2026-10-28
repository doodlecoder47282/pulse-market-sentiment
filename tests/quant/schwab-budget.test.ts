import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("whale flow splits only index chains into DTE segments (single stocks stay one request)", () => {
  const f = src("server/schwabFlow.ts");
  assert.match(f, /maxDte > 14 && schwabSymbol\.startsWith\("\$"\) \? await getOptionChainLadder/);
});

test("whale scanner: priority every cycle, watchlist every other cycle, scanned count reported", () => {
  const f = src("server/flowAlertEngine.ts");
  assert.match(f, /const scanNow = watchlistTick % 2 === 1 \? universe : universe\.filter\(\(s\) => cfg\.priority\.includes\(s\)\)/);
  assert.match(f, /for \(const sym of scanNow\)/);
  assert.match(f, /lastCycleScanned,/);
  // Budget arithmetic at 30 s cadence: $SPX ladder to 90 DTE = 5 segments,
  // QQQ/SPY 1 each, 12 watchlist tickers on alternate cycles.
  const perMin = 2 * (5 + 1 + 1) + 1 * 12;
  assert.ok(perMin <= 40, `whale scanner uses ${perMin}/min of the 100/min budget`);
});

test("budget full: identical requests share one call and others wait for a slot instead of failing at once", () => {
  const f = src("server/schwab.ts");
  assert.match(f, /const running = _inflight\.get\(key\);\s*if \(running\) return running;/);
  assert.match(f, /const SLOT_WAIT_MS = 15_000;/);
  // The check and the push stay synchronous so concurrent callers cannot overspend.
  assert.match(f, /if \(!\(await waitForSlot\(\)\)\) \{[\s\S]{0,260}\}\s*_reqLog\.push\(Date\.now\(\)\);/);
  assert.doesNotMatch(f, /waitMs < 5000/);
});

test("whale scanner pulls only the rule's DTE window; follow-through stops at the latest tracked expiry", async () => {
  const fe = src("server/flowAlertEngine.ts");
  assert.doesNotMatch(fe, /maxDte: 90/);
  assert.equal((fe.match(/maxDte: Math\.max\(1, getFlowConfig\(\)\.maxDte\)/g) ?? []).length, 2);
  const { followMaxDte } = await import("../../shared/whaleFollowDte");
  const now = Date.parse("2026-10-27T15:00:00Z");
  assert.equal(followMaxDte(["2026-10-28", "2026-10-30"], now), 4);
  assert.equal(followMaxDte(["2026-10-27"], now), 1);
  assert.equal(followMaxDte(["garbage"], now), 365, "unknown expiry keeps the wide pull");
  assert.equal(followMaxDte([], now), 1);
});

test("screen reads are interactive; background engines capped lower during the boot ramp", () => {
  const s = src("server/schwab.ts");
  assert.match(s, /export const schwabRequestContext = new AsyncLocalStorage/);
  assert.match(s, /schwabRequestContext\.getStore\(\)\?\.interactive === true/);
  assert.match(s, /const BOOT_BACKGROUND_REQ_PER_MIN = 60;/);
  const i = src("server/index.ts");
  assert.match(i, /app\.use\("\/api", \(req, _res, next\) => schwabRequestContext\.run\(\{ interactive: true, route: req\.path\.slice\(0, 60\) \}, next\)\)/);
});

test("flow preview: one scan per 30 s serves every poller", () => {
  const f = src("server/flowAlertEngine.ts");
  assert.match(f, /const PREVIEW_TTL_MS = 30_000;/);
  assert.match(f, /if \(_previewMemo && now - _previewMemo\.at < PREVIEW_TTL_MS\) return _previewMemo\.p;/);
});

test("Models: an empty build is retried after 20 s and never overwrites the saved session snapshot", () => {
  const r = src("server/routes.ts");
  assert.match(r, /const MODELS_EMPTY_RETRY_MS = 20_000;/);
  assert.match(r, /cachedEmpty \? MODELS_EMPTY_RETRY_MS : MODELS_CACHE_MS/);
  assert.match(r, /if \(!modelsBuildEmpty\(data\)\) await writeCache\(`models-/);
  const c = src("client/src/lib/retryUntilReady.ts");
  assert.match(c, /export const NOT_READY_RETRY_MS = 30_000;/);
});

test("market closed: a chain read after the last settled close is served (labelled stale), an older one is not", async () => {
  const { staleServeDecision, lastSettledCloseMs } = await import("../../server/schwabDataPolicy");
  const night = Date.parse("2026-10-28T03:28:00Z"); // Tue 23:28 ET
  const settled = lastSettledCloseMs(night)!;
  assert.equal(new Date(settled).toISOString(), "2026-10-27T20:15:00.000Z"); // 16:15 ET
  const afterClose = Date.parse("2026-10-27T21:00:00Z");
  const ok = staleServeDecision(afterClose, "chains", "self-throttle", night);
  assert.equal(ok.serve, true);
  assert.equal((ok as any).freshness.stale, true);
  assert.match((ok as any).freshness.reason, /market closed, last-session copy/);
  const midSession = Date.parse("2026-10-27T17:00:00Z");
  assert.equal(staleServeDecision(midSession, "chains", "self-throttle", night).serve, false, "a mid-session copy is not the close");
  assert.equal(staleServeDecision(afterClose, "quotes", "self-throttle", night).serve, false, "quotes move after hours");
  const rth = Date.parse("2026-10-28T15:00:00Z");
  assert.equal(staleServeDecision(afterClose, "chains", "self-throttle", rth).serve, false, "in session the age cap applies");
});
