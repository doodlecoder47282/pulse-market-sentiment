// Tab headlines read the current models build and never start one; failed
// models builds back off instead of retrying on every poll.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyRetryDelayMs, EMPTY_RETRY_BASE_MS, EMPTY_RETRY_CAP_MS } from "../../server/modelsBackoff.ts";

test("models backoff: 20 s, doubling per consecutive empty build, capped at 5 min", () => {
  assert.equal(emptyRetryDelayMs(1), EMPTY_RETRY_BASE_MS);
  assert.equal(emptyRetryDelayMs(2), 40_000);
  assert.equal(emptyRetryDelayMs(3), 80_000);
  assert.equal(emptyRetryDelayMs(4), 160_000);
  assert.equal(emptyRetryDelayMs(5), EMPTY_RETRY_CAP_MS);
  assert.equal(emptyRetryDelayMs(50), EMPTY_RETRY_CAP_MS);
  assert.equal(emptyRetryDelayMs(0), EMPTY_RETRY_BASE_MS, "a missing streak counts as the first");
  assert.equal(emptyRetryDelayMs(NaN), EMPTY_RETRY_BASE_MS);
  // Over 30 minutes of a refused chain a single poller now triggers 9 builds, not 90.
  let t = 0, builds = 0, streak = 0;
  while (t < 30 * 60_000) { builds++; streak++; t += emptyRetryDelayMs(streak); }
  assert.ok(builds <= 10, `builds ${builds}`);
});

test("headline: the predictor is peeked (no models build from a headline poll), with the reason when not built", () => {
  const src = readFileSync(new URL("../../server/headline.ts", import.meta.url), "utf8");
  assert.match(src, /\/api\/regime\/predict\?symbol=\^GSPC&horizonMinutes=20&peek=1/);
  assert.doesNotMatch(src, /\/api\/regime\/predict\?symbol=\^GSPC&horizonMinutes=20`/, "no non-peek predictor call left");
  assert.match(src, /Regime reading unavailable: \$\{predictWhy/);
  const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  assert.match(routes, /if \(opts\.peek\) return null;/, "peek returns before the in-flight check and the build");
  assert.ok(routes.indexOf("if (opts.peek) return null;") < routes.indexOf("const pending = modelsInFlight.get(cacheKey);"));
  assert.match(routes, /error: "not_built"/);
  assert.doesNotMatch(routes, /MODELS_EMPTY_RETRY_MS\s*[<)]/, "the fixed 20 s retry is gone");
});
