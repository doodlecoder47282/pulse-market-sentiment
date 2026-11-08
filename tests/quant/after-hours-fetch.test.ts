// After the close, a chain or daily-bar payload fetched SUCCESSFULLY is the
// last-session copy too (not only one re-served after a failed refresh), and a
// Schwab 401 forces one token refresh and then shows on the connection status.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshFreshness, staleServeDecision } from "../../server/schwabDataPolicy";

test("freshFreshness: closed market + fetched after the settled close = last session; open market or quotes = not", () => {
  const sat = Date.parse("2026-11-07T20:00:00Z"); // Saturday 15:00 ET
  const f = freshFreshness(sat - 10_000, "chains", false, sat);
  assert.equal(f.lastSession, true);
  assert.equal(f.stale, false);
  assert.match(String(f.reason), /market closed, last-session copy/);
  assert.equal(freshFreshness(sat - 10_000, "daily_bars", true, sat).lastSession, true);
  // Quotes and minute bars move after hours: not a settled copy.
  assert.ok(!freshFreshness(sat - 10_000, "quotes", false, sat).lastSession);
  assert.ok(!freshFreshness(sat - 10_000, "minute_bars", false, sat).lastSession);
  // In the session: a fresh fetch is simply fresh.
  const wed = Date.parse("2026-11-04T16:00:00Z");
  assert.ok(!freshFreshness(wed - 5_000, "chains", false, wed).lastSession);
  // One rule with the failed-refresh path.
  const failed = staleServeDecision(Date.parse("2026-11-06T21:16:00Z"), "chains", "timeout", sat);
  assert.equal((failed as any).freshness?.lastSession, true);
});

test("wiring: weekend minute-bar fallback is last session; 401 forces one refresh then marks the connection", () => {
  const s = readFileSync(new URL("../../server/schwab.ts", import.meta.url), "utf8");
  assert.match(s, /f = \{ \.\.\.r2\.freshness, lastSession: true \};/);
  assert.match(s, /if \(!retried401\) \{\s*retried401 = true;\s*const fresh = await getAccessToken\(Number\.POSITIVE_INFINITY\);\s*if \(fresh && fresh !== token\) \{ token = fresh; continue; \}/);
  assert.match(s, /_lastUnauthorizedAt = Date\.now\(\);/);
  assert.match(s, /const needsReauth = refreshExpired \|\| refreshKnownBad \|\| unauthorizedRecently;/);
  assert.match(s, /unauthorizedAt: unauthorizedRecently \? _lastUnauthorizedAt : null,/);
  assert.match(readFileSync(new URL("../../client/src/components/SchwabSettings.tsx", import.meta.url), "utf8"), /Schwab refused the access token at/);
});
