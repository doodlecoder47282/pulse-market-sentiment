// Schwab sign-in: config check, automatic-callback detection, one-time state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { schwabConfigProblem, isAutomaticCallback, newOAuthState, consumeOAuthState, consumeOAuthStateFor, parseReturnTo, oauthReturnUrl, APP_RETURN_URL } from "../../server/schwabOAuth";

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

// The iOS app starts its sign-in with ?return=app; the callback must send
// that sign-in, and only that one, back to the app's URL scheme. A forged or
// reused state has no owner and goes to the website with the error.
test("sign-in started from the app returns to the app scheme; everything else to the website", () => {
  const t0 = 1_700_000_000_000;
  assert.equal(parseReturnTo("app"), "app");
  assert.equal(parseReturnTo("web"), "web");
  assert.equal(parseReturnTo(undefined), "web");
  assert.equal(parseReturnTo(["app"]), "web");
  const app = newOAuthState(t0, "app");
  const web = newOAuthState(t0);
  assert.deepEqual(consumeOAuthStateFor(app, t0 + 1), { ok: true, returnTo: "app" });
  assert.deepEqual(consumeOAuthStateFor(app, t0 + 2), { ok: false, returnTo: "web" });
  assert.deepEqual(consumeOAuthStateFor(web, t0 + 1), { ok: true, returnTo: "web" });
  assert.deepEqual(consumeOAuthStateFor("forged", t0), { ok: false, returnTo: "web" });
  assert.equal(oauthReturnUrl("web", "connected"), "/?schwab=connected#/");
  assert.equal(oauthReturnUrl("web", "error", "no_code"), "/?schwab=error&reason=no_code#/");
  assert.equal(oauthReturnUrl("app", "connected"), `${APP_RETURN_URL}?schwab=connected`);
  assert.equal(oauthReturnUrl("app", "error", "token_exchange_failed"), `${APP_RETURN_URL}?schwab=error&reason=token_exchange_failed`);
  assert.match(APP_RETURN_URL, /^batcave:\/\//);
});

// The scheme the server redirects to must be the one the iOS app registers,
// and the callback must consume the state before any exchange.
import { readFileSync as readSrc } from "node:fs";
test("iOS app registers the return scheme and the callback consumes state first", () => {
  const plist = readSrc(new URL("../../ios/App/App/Info.plist", import.meta.url), "utf8");
  assert.match(plist, /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>batcave<\/string>/);
  const idx = readSrc(new URL("../../server/index.ts", import.meta.url), "utf8");
  const cb = idx.slice(idx.indexOf("app.get(OAUTH_CALLBACK_PATH"));
  assert.ok(cb.indexOf("consumeOAuthStateFor(state)") < cb.indexOf("exchangeCodeForTokens(code)"));
  assert.match(cb, /oauthReturnUrl\(returnTo, result, reason\)/);
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

// Every Schwab request is bounded (server/schwab.ts): a request that never
// answered used to hold its caller for the undici default of five minutes,
// which is what put every client on the loading skeleton. schwab.ts cannot
// be imported here (it opens the token store), so the guard reads the source.
import { readFileSync } from "node:fs";
test("schwab: legacy fetches have timeouts and extracted validation bounds transport plus body", () => {
  const src = readFileSync(new URL("../../server/schwab.ts", import.meta.url), "utf8");
  const calls = Array.from(src.matchAll(/await fetch\(([\s\S]*?)\);/g));
  assert.ok(calls.length >= 3, `found ${calls.length} legacy fetch calls`);
  for (const m of calls) {
    assert.match(m[1], /signal: AbortSignal\.timeout\(SCHWAB_[A-Z_]+_TIMEOUT_MS\)/, `unbounded fetch: ${m[0].slice(0, 80)}`);
  }
  // Timeouts name themselves in the degraded reason rather than "The operation was aborted".
  assert.match(src, /name === "TimeoutError"/);
  assert.match(src, /timed out after \$\{Math\.round\(timeoutMs \/ 1000\)\} s/);
  assert.match(src, /schwabSelfTest = createSchwabInputValidator\(/);
  const validator = readFileSync(new URL("../../server/schwabInputValidation.ts", import.meta.url), "utf8");
  assert.match(validator, /withRequestDeadline\(async signal => \{[\s\S]*?deps\.fetch\([\s\S]*?\{ signal,[\s\S]*?await res\.json\(\)[\s\S]*?\}, 10_000\)/);
  assert.equal(Array.from(validator.matchAll(/await deps\.fetch\(/g)).length, 1);
});
