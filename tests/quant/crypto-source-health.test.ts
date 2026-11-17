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
});

test("wiring: the engine counts real calls, a 200 that prices nothing is a failure, and Verify live data reports both sources", () => {
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.match(e, /if \(r\.prices\.size > 0\) markOk\(jupHealth\); else markFail\(jupHealth, `answered but priced 0 of \$\{jupMints\.length\} mints`\);/);
  assert.match(e, /\} catch \(e\) \{\s*jup = \{ prices: new Map\(\), omitted: new Set\(\), failed: true, at: Date\.now\(\) \};\s*markFail\(jupHealth, e\);/);
  assert.match(e, /markOk\(candleHealth\); else markFail\(candleHealth, "answered without data\.attributes\.ohlcv_list"\);/);
  assert.match(e, /c\.candlesError = msg\.slice\(0, 80\);\s*markFail\(candleHealth, e\);/);
  const v = readFileSync(new URL("../../server/liveVerify.ts", import.meta.url), "utf8");
  assert.match(v, /sourceHealthCheck\("crypto\.jupiter", "Jupiter price cross-check", h\.jupiter, now, JUPITER_MAX_QUIET_MS,/);
  assert.match(v, /sourceHealthCheck\("crypto\.candles", "1-minute candles \(GeckoTerminal\)", h\.candles, now, CANDLES_MAX_QUIET_MS, \{ demand: h\.candlePairsWanted,/);
});
