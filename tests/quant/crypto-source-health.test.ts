// Verify live data: the Jupiter cross-check and the 1-minute candle feed had no
// check. A source passes only when a real call succeeded recently; never
// because nothing was tried.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourceHealthCheck, emptySourceHealth, JUPITER_MAX_QUIET_MS, CANDLES_MAX_QUIET_MS } from "../../shared/cryptoVerify";

const now = 1_800_000_000_000;
const M = 60_000;

test("source health: untried is unavailable, a recent success passes, the latest call failing fails, a long quiet with demand fails", () => {
  const none = sourceHealthCheck("crypto.candles", "candles", emptySourceHealth(), now, CANDLES_MAX_QUIET_MS, { demand: 0 });
  assert.equal(none.state, "unavailable"); assert.match(none.detail!, /nothing has needed this source yet/);
  assert.equal(sourceHealthCheck("x", "x", emptySourceHealth(), now, 1, { demand: 5 }).state, "unavailable", "untried is never a pass");
  assert.equal(sourceHealthCheck("x", "x", null, now, 1).state, "unavailable");
  const ok = { lastOkAt: now - 2 * M, lastFailAt: now - 30 * M, lastError: null, okCount: 40, failCount: 1 };
  const p = sourceHealthCheck("crypto.jupiter", "Jupiter", ok, now, JUPITER_MAX_QUIET_MS, { demand: 100, extra: "https://api.jup.ag/price/v3" });
  assert.equal(p.state, "pass"); assert.match(p.observed, /ok 40 \(last 2 min ago\), failed 1 \(last 30 min ago\); https:\/\/api\.jup\.ag/);
  const failing = { lastOkAt: now - 20 * M, lastFailAt: now - 1 * M, lastError: "404 https://api.jup.ag/price/v3", okCount: 40, failCount: 9 };
  const f = sourceHealthCheck("crypto.jupiter", "Jupiter", failing, now, JUPITER_MAX_QUIET_MS, { demand: 100 });
  assert.equal(f.state, "fail"); assert.match(f.detail!, /404/);
  const neverOk = { lastOkAt: null, lastFailAt: now - M, lastError: "answered but priced 0 of 50 mints", okCount: 0, failCount: 3 };
  assert.equal(sourceHealthCheck("x", "x", neverOk, now, JUPITER_MAX_QUIET_MS, { demand: 50 }).state, "fail");
  const quiet = { lastOkAt: now - 45 * M, lastFailAt: null, lastError: null, okCount: 12, failCount: 0 };
  assert.equal(sourceHealthCheck("crypto.candles", "candles", quiet, now, CANDLES_MAX_QUIET_MS, { demand: 6 }).state, "fail", "work waiting and no success in 45 min");
  assert.equal(sourceHealthCheck("crypto.candles", "candles", quiet, now, CANDLES_MAX_QUIET_MS, { demand: 0 }).state, "pass", "no ENTER/WATCH pair to read: quiet is expected");
  // A failure with no work since cannot clear itself: old and idle reads unavailable, not a standing red.
  const oldFail = { lastOkAt: now - 3 * 3600_000, lastFailAt: now - 2 * 3600_000, lastError: "429", okCount: 9, failCount: 1 };
  assert.equal(sourceHealthCheck("crypto.candles", "candles", oldFail, now, CANDLES_MAX_QUIET_MS, { demand: 0 }).state, "unavailable");
  assert.equal(sourceHealthCheck("crypto.candles", "candles", oldFail, now, CANDLES_MAX_QUIET_MS, { demand: 3 }).state, "fail");
});

test("wiring: the engine counts real calls, a 200 that prices nothing is a failure, and Verify live data reports both sources", () => {
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.match(e, /if \(anyOk && !anyFail\) \{\s*if \(priced > 0\) markOk\(jupHealth\);\s*else if \(asked >= JUP_INCONCLUSIVE_UNDER\) markFail\(jupHealth, `answered but priced 0 of \$\{asked\} mints`\);/);
  assert.match(e, /\} catch \(e\) \{\s*for \(const m of part\) jup\.failedMints\.add\(m\);\s*anyFail = true;\s*markFail\(jupHealth, e\);/);
  assert.match(e, /if \(fresh\.length > 0 \|\| \(Array\.isArray\(rawList\) && rawList\.length === 0\)\) markOk\(candleHealth\);/, "rows that do not parse are a failure of the feed's shape, never ok");
  assert.match(e, /c\.candlesError = msg\.slice\(0, 80\);\s*markFail\(candleHealth, e\);/);
  const v = readFileSync(new URL("../../server/liveVerify.ts", import.meta.url), "utf8");
  assert.match(v, /sourceHealthCheck\("crypto\.jupiter", "Jupiter price cross-check", h\.jupiter, now, JUPITER_MAX_QUIET_MS,/);
  assert.match(v, /sourceHealthCheck\("crypto\.candles", "1-minute candles \(GeckoTerminal\)", h\.candles, now, CANDLES_MAX_QUIET_MS, \{ demand: h\.candlePairsWanted,/);
});

test("a small tracked set that keeps answering inconclusively reads unavailable, never a quiet-window failure; a later failure still fails", () => {
  const now = 1_800_000_000_000;
  const min = 60_000;
  const quietOk = { ...emptySourceHealth(), lastOkAt: now - 30 * min, okCount: 5, lastInconclusiveAt: now - 1 * min };
  assert.equal(sourceHealthCheck("crypto.jupiter", "Jupiter", quietOk, now, JUPITER_MAX_QUIET_MS, { demand: 3 }).state, "unavailable");
  const onlyInc = { ...emptySourceHealth(), lastInconclusiveAt: now - 2 * min };
  const c = sourceHealthCheck("crypto.jupiter", "Jupiter", onlyInc, now, JUPITER_MAX_QUIET_MS, { demand: 3 });
  assert.equal(c.state, "unavailable"); assert.match(JSON.stringify(c), /too small to tell/);
  const failThenInc = { ...emptySourceHealth(), lastFailAt: now - 5 * min, failCount: 1, lastError: "HTTP 500", lastInconclusiveAt: now - 1 * min };
  assert.equal(sourceHealthCheck("crypto.jupiter", "Jupiter", failThenInc, now, JUPITER_MAX_QUIET_MS, { demand: 3 }).state, "unavailable");
  const incThenFail = { ...emptySourceHealth(), lastFailAt: now - 1 * min, failCount: 1, lastError: "HTTP 500", lastInconclusiveAt: now - 5 * min };
  assert.equal(sourceHealthCheck("crypto.jupiter", "Jupiter", incThenFail, now, JUPITER_MAX_QUIET_MS, { demand: 3 }).state, "fail");
  const recentOk = { ...emptySourceHealth(), lastOkAt: now - 2 * min, okCount: 5, lastInconclusiveAt: now - 1 * min };
  assert.equal(sourceHealthCheck("crypto.jupiter", "Jupiter", recentOk, now, JUPITER_MAX_QUIET_MS, { demand: 3 }).state, "pass");
  const oldInc = { ...emptySourceHealth(), lastOkAt: now - 30 * min, okCount: 5, lastInconclusiveAt: now - 25 * min };
  assert.equal(sourceHealthCheck("crypto.jupiter", "Jupiter", oldInc, now, JUPITER_MAX_QUIET_MS, { demand: 3 }).state, "fail");
});
