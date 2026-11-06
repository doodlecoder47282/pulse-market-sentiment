// Tab headlines read the current models build and never start one; failed
// models builds back off instead of retrying on every poll; a peek that finds
// no build names which of its states it is in.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  emptyRetryDelayMs, EMPTY_RETRY_BASE_MS, EMPTY_RETRY_CAP_MS, EMPTY_RETRY_SESSION_CAP_MS,
  modelsCacheGate, modelsPeekReason, type ModelsGateArgs,
} from "../../server/modelsBackoff.ts";
import { lastSettledCloseMs, maxServeAgeMs } from "../../server/schwabDataPolicy.ts";
import { isRegularSessionOpen } from "../../server/exchangeCalendar.ts";

const MIN = 60_000;
const CADENCE = 30 * MIN;

test("models backoff: 20 s, doubling per consecutive empty build, capped (5 min, 2 min in the session)", () => {
  assert.equal(emptyRetryDelayMs(1), EMPTY_RETRY_BASE_MS);
  assert.equal(emptyRetryDelayMs(2), 40_000);
  assert.equal(emptyRetryDelayMs(3), 80_000);
  assert.equal(emptyRetryDelayMs(4), 160_000);
  assert.equal(emptyRetryDelayMs(5), EMPTY_RETRY_CAP_MS);
  assert.equal(emptyRetryDelayMs(50), EMPTY_RETRY_CAP_MS);
  assert.equal(emptyRetryDelayMs(50, EMPTY_RETRY_SESSION_CAP_MS), 2 * MIN);
  assert.equal(emptyRetryDelayMs(0), EMPTY_RETRY_BASE_MS, "a missing streak counts as the first");
  assert.equal(emptyRetryDelayMs(NaN), EMPTY_RETRY_BASE_MS);
  // Over 30 minutes of a refused chain a single poller now triggers 9 builds, not 90.
  let t = 0, builds = 0, streak = 0;
  while (t < 30 * MIN) { builds++; streak++; t += emptyRetryDelayMs(streak); }
  assert.ok(builds <= 10, `builds ${builds}`);
});

// Real calendar: args exactly as routes.ts builds them.
const argsAt = (nowMs: number, holdMs = CADENCE): ModelsGateArgs => ({
  nowMs, holdMs, chainMaxAgeMs: maxServeAgeMs("chains", nowMs),
  marketOpen: isRegularSessionOpen(nowMs), settledCloseMs: lastSettledCloseMs(nowMs),
});

test("cache gate in the session: chain age decides (3 min), cadence decides (30 min)", () => {
  const now = Date.parse("2026-11-04T16:00:00Z"); // Wed 11:00 ET
  assert.equal(modelsCacheGate(null, argsAt(now)).serve, false);
  assert.deepEqual(modelsCacheGate(null, argsAt(now)), { serve: false, miss: "never_built" });
  assert.deepEqual(modelsCacheGate({ at: now - MIN, empty: false, chainAsOfMs: now - MIN }, argsAt(now)), { serve: true, lastSession: false });
  assert.deepEqual(modelsCacheGate({ at: now - MIN, empty: false, chainAsOfMs: now - 4 * MIN }, argsAt(now)), { serve: false, miss: "chain_old" });
  assert.deepEqual(modelsCacheGate({ at: now - 31 * MIN, empty: false, chainAsOfMs: now - MIN }, argsAt(now)), { serve: false, miss: "expired" });
  assert.deepEqual(modelsCacheGate({ at: now - 25_000, empty: true, chainAsOfMs: null }, argsAt(now, 20_000)), { serve: false, miss: "empty_hold_elapsed" });
  assert.deepEqual(modelsCacheGate({ at: now - 10_000, empty: true, chainAsOfMs: null }, argsAt(now, 20_000)), { serve: true, lastSession: false });
});

test("cache gate with the market closed: a build made after the settled close is current within its cadence", () => {
  // The chain quote time stops at the last print (16:00 ET) and is never newer.
  const closeQuote = Date.parse("2026-11-04T21:00:00Z"); // Wed 16:00 ET
  for (const [label, iso] of [["Wed 17:00 ET", "2026-11-04T22:00:00Z"], ["Thu 01:00 ET", "2026-11-05T06:00:00Z"], ["Sat 12:00 ET", "2026-11-07T17:00:00Z"]] as const) {
    const now = Date.parse(iso);
    // Built two minutes ago (after the settled close): served, labelled last-session.
    assert.deepEqual(modelsCacheGate({ at: now - 2 * MIN, empty: false, chainAsOfMs: closeQuote }, argsAt(now)), { serve: true, lastSession: true }, label);
    // Past the 30-min cadence: rebuilt (at most twice an hour), never every poll.
    assert.deepEqual(modelsCacheGate({ at: now - 31 * MIN, empty: false, chainAsOfMs: closeQuote }, argsAt(now)), { serve: false, miss: "expired" }, label);
  }
  // A build made before the session settled (15:50 ET) is not current at 17:00 ET.
  const at17 = Date.parse("2026-11-04T22:00:00Z");
  const built1550 = Date.parse("2026-11-04T20:50:00Z");
  assert.deepEqual(modelsCacheGate({ at: built1550, empty: false, chainAsOfMs: built1550 }, argsAt(at17, 3 * CADENCE)), { serve: false, miss: "chain_old" });
});

test("peek reason names each state apart (never 'backing off' when nothing is backing off)", () => {
  const now = Date.parse("2026-11-04T16:00:00Z");
  const a = { nowMs: now, chainMaxAgeMs: 3 * MIN };
  assert.match(modelsPeekReason({ inFlight: true, entry: null, miss: "never_built" }, a), /build is running/);
  assert.match(modelsPeekReason({ inFlight: false, entry: null, miss: "never_built" }, a), /no models build since the server started/);
  const e = { at: Date.parse("2026-11-04T15:20:00Z"), empty: false, chainAsOfMs: now - 7 * MIN };
  assert.match(modelsPeekReason({ inFlight: false, entry: e, miss: "expired" }, a), /last build \(10:20 AM ET\) is past its 30-min rebuild cadence/);
  assert.match(modelsPeekReason({ inFlight: false, entry: e, miss: "chain_old" }, a), /chain \(7 min old\) is past the 3 min limit/);
  assert.match(modelsPeekReason({ inFlight: false, entry: { ...e, empty: true }, miss: "empty_hold_elapsed" }, a), /had no horizon because Schwab did not supply the chain/);
  for (const m of ["never_built", "expired", "chain_old", "empty_hold_elapsed"] as const) {
    assert.doesNotMatch(modelsPeekReason({ inFlight: false, entry: e, miss: m }, a), /backing off|pending/);
  }
});

test("wiring: headline peeks; /api/models and the predictor answer a peek from the cache with no build or Schwab read", () => {
  const src = readFileSync(new URL("../../server/headline.ts", import.meta.url), "utf8");
  assert.match(src, /\/api\/regime\/predict\?symbol=\^GSPC&horizonMinutes=20&peek=1/);
  assert.doesNotMatch(src, /\/api\/regime\/predict\?symbol=\^GSPC&horizonMinutes=20`/, "no non-peek predictor call left");
  assert.match(src, /Regime reading unavailable: \$\{predictWhy/);
  assert.doesNotMatch(src, /No hedging-pressure reading until Schwab chain data arrives/);
  const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  // One gate for both reads.
  assert.match(routes, /gate: modelsCacheGate\(entry, args\)/);
  const peekFn = routes.slice(routes.indexOf("function peekModelsForKey("), routes.indexOf("async function buildModelsForKey("));
  assert.ok(peekFn.length > 0 && peekFn.length < 2000);
  assert.doesNotMatch(peekFn, /buildModelsSnapshot|modelsInFlight\.set|await /, "a peek never builds, joins or waits");
  // /api/models?peek=1 returns before post-processing.
  const models = routes.slice(routes.indexOf('app.get("/api/models"'), routes.indexOf('app.get("/api/models"') + 1500);
  assert.match(models, /if \(String\(req\.query\.peek \?\? ""\) === "1"\) \{\s*const p = peekModelsForKey\(symbol, experimental\);/);
  assert.ok(models.indexOf("peekModelsForKey") < models.indexOf("fetchVixTermData"));
  // The predictor's peek reads the raw build, not /api/models.
  const predict = routes.slice(routes.indexOf('app.get("/api/regime/predict"'), routes.indexOf('app.get("/api/regime/predict"') + 2000);
  assert.match(predict, /if \(peek\) \{\s*const p = peekModelsForKey\(/);
  assert.match(predict, /error: "not_built"/);
});
