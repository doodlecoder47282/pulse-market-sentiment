import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSchwabCallback } from "../../shared/schwabCallback";
import { newOAuthState, consumeOAuthState } from "../../server/schwabOAuth";

const redirect = "https://127.0.0.1";
test("fresh full callback preserves percent-encoded code exactly once", () => {
  assert.deepEqual(parseSchwabCallback(" https://127.0.0.1/?code=a%2Bb%3D&state=test ", "test", redirect), { code: "a+b=", state: "test" });
});
test("raw code and query fragment remain supported with current issued state", () => {
  assert.equal(parseSchwabCallback("a+b=", "test", redirect).code, "a+b=");
  assert.equal(parseSchwabCallback("?code=a%2Bb%3D", "test", redirect).code, "a+b=");
});
test("callback host/path and explicit state must match", () => {
  for (const url of ["https://evil.example/?code=x", "https://127.0.0.1/not-callback?code=x", "https://127.0.0.1/?code=x&state=old"]) {
    assert.throws(() => parseSchwabCallback(url, "test", redirect));
  }
});
test("empty, missing code, provider cancellation and missing state reject without echoing secrets", () => {
  for (const raw of ["", "https://127.0.0.1/", "https://127.0.0.1/?error=private-value", "<secret>", "x".repeat(8193)]) {
    assert.throws(() => parseSchwabCallback(raw, "test", redirect), e => e instanceof Error && !e.message.includes("private-value"));
  }
  assert.throws(() => parseSchwabCallback("x", "", redirect));
});
test("manual flow uses single-use expiring server state", () => {
  const now = 1_800_000_000_000;
  const state = newOAuthState(now);
  const parsed = parseSchwabCallback(`https://127.0.0.1/?code=fixture&state=${state}`, state, redirect);
  assert.equal(consumeOAuthState(parsed.state, now + 1), true);
  assert.equal(consumeOAuthState(parsed.state, now + 2), false);
  assert.equal(consumeOAuthState(newOAuthState(now), now + 16 * 60_000), false);
});
test("callback route consumes state before exchange and does not echo provider failure", () => {
  const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  const route = routes.slice(routes.indexOf('app.post("/api/schwab/callback"'), routes.indexOf('app.get("/api/schwab/status"'));
  assert.ok(route.indexOf("consumeOAuthState(parsed.state)") < route.indexOf("exchangeCodeForTokens(parsed.code)"));
  assert.doesNotMatch(route, /message: (result\.error|e\??\.message)/);
  assert.match(route, /isAutomaticCallback/);
});
test("settings is explicit-submit only with in-flight lock and truthful authorization wording", () => {
  const s = readFileSync(new URL("../../client/src/components/SchwabSettings.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(s, /setTimeout\(\(\) => connectMut\.mutate/);
  assert.match(s, /if \(connectionInFlight\.current/);
  assert.match(s, /connectionInFlight\.current = true/);
  assert.doesNotMatch(s, /Live market data is now active/);
  assert.match(s, /schwab-automatic-return/);
});
test("thermal views withhold unavailable data and provide accessible exact values", () => {
  const s = readFileSync(new URL("../../client/src/components/ThermalHeatmap.tsx", import.meta.url), "utf8");
  assert.match(s, /!error && data\.dataState === "ok"/);
  assert.match(s, /canPlot && data && grid && viewMode === "surface"/);
  assert.match(s, /thermal-data-table/);
  const surface = readFileSync(new URL("../../client/src/components/ThermalSurface.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(surface, /Green up = dealers long gamma/);
  assert.match(surface, /equally spaced categories/);
});
