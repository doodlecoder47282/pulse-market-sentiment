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
  // The 15 minutes between the close and the settle: index options still
  // trade, so a chain fetched then is live data of an unsettled session.
  const settling = Date.parse("2026-11-05T21:05:00Z"); // Thursday 16:05 ET
  assert.ok(!freshFreshness(settling - 2_000, "chains", false, settling).lastSession, "16:05 ET is not a last-session copy");
  assert.ok(!(staleServeDecision(settling - 2_000, "chains", "timeout", settling) as any).freshness?.lastSession);
  const settled = Date.parse("2026-11-05T21:16:00Z"); // 16:16 ET
  assert.equal(freshFreshness(settled - 1_000, "chains", false, settled).lastSession, true);
  const halfDay = Date.parse("2026-11-27T18:05:00Z"); // Black Friday 13:05 ET
  assert.ok(!freshFreshness(halfDay - 2_000, "chains", false, halfDay).lastSession, "half day 13:05 ET is still settling");
  assert.equal(freshFreshness(halfDay + 11 * 60_000, "chains", false, halfDay + 12 * 60_000).lastSession, true);
  // Pre-market: an approximation the policy accepts (SPX GTH options trade until 09:15 ET); stated, not changed.
  const pre = Date.parse("2026-11-05T12:00:00Z"); // 07:00 ET
  assert.equal(freshFreshness(pre - 1_000, "daily_bars", false, pre).lastSession, true);
});

test("wiring: weekend minute-bar fallback is last session; 401 forces one refresh then marks the connection", () => {
  const s = readFileSync(new URL("../../server/schwab.ts", import.meta.url), "utf8");
  assert.match(s, /f = \{ \.\.\.r2\.freshness, lastSession: true \};/);
  // One forced refresh per call AND at most one a minute across all callers (no refresh storm on a persistent 401).
  assert.match(s, /if \(!retried401 && nowMs - _forced401RefreshAt >= FORCED_401_REFRESH_MIN_GAP_MS && attempt < maxAttempts\) \{\s*retried401 = true;\s*_forced401RefreshAt = nowMs;\s*const fresh = await getAccessToken\(Number\.POSITIVE_INFINITY\);\s*if \(fresh && fresh !== token\) \{ token = fresh; continue; \}/);
  assert.match(s, /const FORCED_401_REFRESH_MIN_GAP_MS = 60_000;/);
  assert.match(s, /_lastUnauthorizedAt = Date\.now\(\);/);
  // A request Schwab accepts clears the unauthorized mark; a dead refresh token keeps it until re-auth.
  assert.match(s, /_403Streak\.delete\(epKey\);\s*_lastUnauthorizedAt = null;/);
  assert.match(s, /&& \(_refreshDead \|\| now - _lastUnauthorizedAt < 10 \* 60_000\);/);
  assert.match(s, /unauthorizedAt\?: number \| null;\s*\} \{/);
  assert.match(s, /const needsReauth = refreshExpired \|\| refreshKnownBad \|\| unauthorizedRecently;/);
  assert.match(s, /unauthorizedAt: unauthorizedRecently \? _lastUnauthorizedAt : null,/);
  assert.match(readFileSync(new URL("../../client/src/components/SchwabSettings.tsx", import.meta.url), "utf8"), /Schwab refused the access token at/);
});
