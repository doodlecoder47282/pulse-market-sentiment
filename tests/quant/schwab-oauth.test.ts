// Schwab sign-in: config check, automatic-callback detection, one-time state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { schwabConfigProblem, isAutomaticCallback, newOAuthState, consumeOAuthState } from "../../server/schwabOAuth";

test("config problem names every missing variable, null when complete", () => {
  assert.match(schwabConfigProblem({})!, /SCHWAB_CLIENT_ID.*SCHWAB_CLIENT_SECRET.*SCHWAB_REDIRECT_URI/);
  assert.match(schwabConfigProblem({ SCHWAB_CLIENT_ID: "a", SCHWAB_CLIENT_SECRET: " ", SCHWAB_REDIRECT_URI: "https://127.0.0.1" })!, /SCHWAB_CLIENT_SECRET/);
  assert.equal(schwabConfigProblem({ SCHWAB_CLIENT_ID: "a", SCHWAB_CLIENT_SECRET: "b", SCHWAB_REDIRECT_URI: "https://127.0.0.1" }), null);
});

test("automatic callback only for this app's callback route", () => {
  assert.equal(isAutomaticCallback("https://x.up.railway.app/api/schwab/oauth/callback"), true);
  assert.equal(isAutomaticCallback("https://x.up.railway.app/api/schwab/oauth/callback/"), true);
  assert.equal(isAutomaticCallback("https://127.0.0.1"), false);
  assert.equal(isAutomaticCallback("not a url"), false);
});

test("state is single-use and expires after 15 minutes", () => {
  const t0 = 1_700_000_000_000;
  const s = newOAuthState(t0);
  assert.equal(consumeOAuthState(s, t0 + 1000), true);
  assert.equal(consumeOAuthState(s, t0 + 2000), false);
  const s2 = newOAuthState(t0);
  assert.equal(consumeOAuthState(s2, t0 + 16 * 60_000), false);
  assert.equal(consumeOAuthState(null, t0), false);
  assert.equal(consumeOAuthState("forged", t0), false);
});

import { lastSessionDate } from "../../server/exchangeCalendar";

test("last session date is the ET date of the newest bar", () => {
  // Fri 2026-10-09 15:59 ET and Thu 2026-10-08 10:00 ET (EDT = UTC-4)
  const fri = Date.parse("2026-10-09T19:59:00Z");
  const thu = Date.parse("2026-10-08T14:00:00Z");
  assert.equal(lastSessionDate([{ datetime: thu }, { datetime: fri }]), "2026-10-09");
  assert.equal(lastSessionDate([]), null);
  assert.equal(lastSessionDate([{ datetime: "x" }]), null);
});
