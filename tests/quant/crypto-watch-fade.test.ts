// Rule book 2026.11.18-1, watch.fade: a forming setup whose flow has gone is a PASS, not a WATCH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { watchFaded, VERDICT_CODE_TEXT } from "../../shared/cryptoVerdict";
import { CRYPTO_RULES, describeCryptoRules } from "../../shared/cryptoRules";

test("faded: past the first hour with acceleration observed under 1x on each of the last three refreshes", () => {
  assert.equal(watchFaded(90, [0.6, 0.5, 0.7]), true);
  assert.equal(watchFaded(1900, [6.2, 0.9, 0.5, 0.7, 0.4]), true, "only the last three count");
  assert.equal(watchFaded(60, [0, 0, 0]), true, "an observed zero is a low reading; the age boundary is inclusive");
});

test("not faded: young, flow present on any recent refresh, or too few refreshes", () => {
  assert.equal(watchFaded(59.9, [0.5, 0.5, 0.5]), false);
  assert.equal(watchFaded(2000, [0.5, 6.2, 0.5]), false, "one live window keeps it forming");
  assert.equal(watchFaded(2000, [0.5, 0.5, 1]), false, "the threshold itself is not under it");
  assert.equal(watchFaded(2000, [0.5, 0.5]), false);
  assert.equal(watchFaded(2000, []), false);
});

test("unread is not low: a missing acceleration or an unknown age never fades a row", () => {
  assert.equal(watchFaded(2000, [0.5, null, 0.5]), false);
  assert.equal(watchFaded(2000, [null, null, null]), false);
  assert.equal(watchFaded(2000, [0.5, Number.NaN, 0.5]), false);
  assert.equal(watchFaded(null, [0.5, 0.5, 0.5]), false);
});

test("the numbers live in the rule book, the version moved, and the rule is listed", () => {
  assert.deepEqual(CRYPTO_RULES.watch.fade, { afterMinutes: 60, belowVolAccel: 1, polls: 3 });
  assert.ok(describeCryptoRules().some((r) => r.path === "watch.fade" && /after 60 min, accel < 1x on 3 refreshes in a row/.test(r.value)));
  assert.equal(watchFaded(90, [0.6, 0.5, 0.7], { ...CRYPTO_RULES, watch: { ...CRYPTO_RULES.watch, fade: { afterMinutes: 120, belowVolAccel: 1, polls: 3 } } }), false, "the function reads the rules it is given");
  assert.match(VERDICT_CODE_TEXT.watch_faded, /5-minute volume pace under the hour's/);
  assert.doesNotMatch(VERDICT_CODE_TEXT.watch_faded, /gone|dead/, "the rule measures a slowing pace, not absent volume");
});

test("the engine fades only the forming branch, to PASS, and does not count one poll twice", () => {
  const eng = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  const i = eng.indexOf('code = "watch_faded";');
  assert.ok(i > 0);
  const branch = eng.slice(eng.lastIndexOf("} else if", i), eng.indexOf("} else if", i));
  assert.match(branch, /c\.score >= CRYPTO_RULES\.watch\.minScore && !pairDataStale\(c\.lastRefreshAt, now\)\.stale && watchFaded\(c\.ageMinutes, fadeReadings\(c\)\)/, "never faded on stale readings");
  assert.match(branch, /latest \$\{c\.volAccel\?\.toFixed\(2\)\}x/, "two decimals: 0.96 must not print as 1.0x beside 'under 1x'");
  assert.doesNotMatch(branch, /verdict = /, "the verdict stays PASS: no WATCH row is written for it");
  assert.ok(eng.indexOf('code = "watch_faded";') < eng.indexOf('verdict = "WATCH"; code = "forming";'), "checked before the forming branch");
  assert.ok(eng.indexOf('verdict = "ENTER"; code = "enter";') < i, "the ENTER chain is evaluated first and is untouched");
  assert.match(eng, /return last && last\.t === c\.lastRefreshAt \? past : \[\.\.\.past, c\.volAccel\];/);
});
