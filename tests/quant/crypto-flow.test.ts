// Rule version 2026.11.17-1: volume acceleration against the coin's own life (practitioner review C2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { volumeAcceleration } from "../../shared/cryptoFlow";
import { CRYPTO_RULES, CRYPTO_RULES_VERSION } from "../../shared/cryptoRules";

test("acceleration: the old artifact is gone; a young coin is not read; a coin under an hour is compared with its own life", () => {
  assert.equal(CRYPTO_RULES.flow.accelMinAgeMinutes, 10);
  assert.ok(CRYPTO_RULES_VERSION >= "2026.11.17-1");
  // The artifact: a 3-minute-old coin whose 1 h volume is its 5 m volume read (v/5)/(v/60) = 12.
  assert.equal((5000 / 5) / (5000 / 60), 12);
  assert.equal(volumeAcceleration(5000, 5000, 3), null, "too young: no baseline, not a number");
  assert.equal(volumeAcceleration(5000, 5000, 9.9), null);
  // 20 minutes old with even volume: 1.0x (was 3.0x).
  assert.equal(volumeAcceleration(2500, 10_000, 20), 1);
  // 20 minutes old, half of all volume in the last 5 minutes: 2.0x.
  assert.equal(volumeAcceleration(5000, 10_000, 20), 2);
  // An hour or older, and an unknown age: the hour, unchanged from before.
  assert.equal(volumeAcceleration(1000, 6000, 600), 2);
  assert.equal(volumeAcceleration(1000, 6000, null), 2);
  // Missing volume is not zero flow; an observed zero hour with 5 m volume keeps the old cap value.
  assert.equal(volumeAcceleration(null, 6000, 30), null);
  assert.equal(volumeAcceleration(1000, null, 30), null);
  assert.equal(volumeAcceleration(0, 0, 30), 0);
  assert.equal(volumeAcceleration(10, 0, 30), 5);
  // The boundary is inclusive of the minimum age.
  assert.equal(volumeAcceleration(5000, 10_000, 10), 1);
});

test("wiring: the engine has one acceleration formula, from the shared module", () => {
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.match(e, /c\.volAccel = volumeAcceleration\(c\.vol5m, c\.vol1h, accelAgeMinutes\(c\.pairCreatedAt, c\.lastRefreshAt, now\)\);/);
  // Review must-fix: the age is the data's (the last pair refresh), so a re-score without a refresh cannot
  // move the figure. The reviewer's case: vol5m 6000, vol1h 10000 read at age 12.0.
  const body = /export function accelAgeMinutes\(pairCreatedAt: number \| null, lastRefreshAt: number \| null, now: number\): number \| null \{([\s\S]*?)\n\}/.exec(e)![1];
  const accelAge = new Function("pairCreatedAt", "lastRefreshAt", "now", body) as (a: number | null, b: number | null, c: number) => number | null;
  const created = 1_800_000_000_000, refreshed = created + 12 * 60_000;
  const atRefresh = volumeAcceleration(6000, 10_000, accelAge(created, refreshed, refreshed));
  const aMinuteLater = volumeAcceleration(6000, 10_000, accelAge(created, refreshed, refreshed + 60_000));
  assert.equal(atRefresh, aMinuteLater);
  assert.ok(Math.abs((atRefresh as number) - 1.44) < 1e-9);
  // A 9.5-minute read stays unread however long ago it was made.
  assert.equal(volumeAcceleration(6000, 10_000, accelAge(created, created + 9.5 * 60_000, created + 30 * 60_000)), null);
  assert.equal(accelAge(null, refreshed, refreshed), null);
  assert.doesNotMatch(e, /c\.vol1h \/ 60/);
  // Age is computed before the acceleration that depends on it.
  // The ceiling by age (all volume in the last 5 minutes) is age / 5: 2x at 10, 4x at 20, 12x from an hour.
  assert.equal(volumeAcceleration(1000, 1000, 10), 2);
  assert.equal(volumeAcceleration(1000, 1000, 20), 4);
  assert.equal(volumeAcceleration(1000, 1000, 90), 12);
  const a = readFileSync(new URL("../../shared/cryptoAutopsy.ts", import.meta.url), "utf8");
  assert.match(a, /value: "not read", state: "unread" as const, detail: `the pair is under \$\{rules\.flow\.accelMinAgeMinutes\} minutes old/);
});
