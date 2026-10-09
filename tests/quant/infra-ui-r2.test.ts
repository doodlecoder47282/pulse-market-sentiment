// R2-G tests: security, storage, engineering quality, client UI honesty.
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/infra-ui-r2.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDataState,
  describeDataState,
  formatAge,
  classifyAge,
  ageFromAsOf,
  effectiveDataState,
} from "../../shared/dataState";
import { ofiApiPayload, type OfiTrendLike } from "../../server/ofiPayload";

// ─── Item 7: data-state vocabulary ─────────────────────────────────────────

test("dataState: known states keep their meaning; unknown/empty fail closed", () => {
  assert.equal(normalizeDataState("ok"), "ok");
  assert.equal(normalizeDataState("partial"), "partial");
  assert.equal(normalizeDataState("no_spot"), "no_spot");
  assert.equal(normalizeDataState("no-data"), "no_data");
  assert.equal(normalizeDataState("live"), "ok");
  // Fail closed: nothing unknown is ever "ok".
  assert.equal(normalizeDataState(undefined), "unavailable");
  assert.equal(normalizeDataState(""), "unavailable");
  assert.equal(normalizeDataState("weird"), "unavailable");
  assert.equal(describeDataState("weird").label, "unknown state");
  assert.equal(describeDataState("weird").tone, "bad");
});

test("dataState: failed, missing, stale, partial and observed-zero are distinct", () => {
  const views = ["failed", "unavailable", "stale", "partial", "observed_zero", "no_data", "no_spot"].map((s) => describeDataState(s));
  const labels = new Set(views.map((v) => v.label));
  assert.equal(labels.size, views.length, "every state has its own label");
  for (const v of views) assert.notEqual(v.label, "ok");
  // Only observed_zero and partial may still be read; failures block the signal.
  assert.equal(describeDataState("observed_zero").blocksSignal, false);
  assert.equal(describeDataState("observed_zero").tone, "neutral");
  assert.equal(describeDataState("unavailable").blocksSignal, true);
  assert.equal(describeDataState("failed").blocksSignal, true);
  assert.equal(describeDataState("stale").blocksSignal, true);
  assert.match(describeDataState("unavailable", "Schwab 503").title, /Reason: Schwab 503/);
});

test("dataState: age formatting never turns unknown into 0s", () => {
  assert.equal(formatAge(null), "age unknown");
  assert.equal(formatAge(NaN), "age unknown");
  assert.equal(formatAge(-5), "~0s");
  assert.equal(formatAge(0), "0s");
  assert.equal(formatAge(59_999), "59s");
  assert.equal(formatAge(60_000), "1m");
  assert.equal(formatAge(3_600_000 + 5 * 60_000), "1h 05m");
  assert.equal(formatAge(26 * 3_600_000), "1d 2h");
});

test("dataState: age classification and as-of parsing (ms, s, ISO)", () => {
  const now = Date.UTC(2026, 9, 8, 15, 0, 0);
  assert.equal(ageFromAsOf(now - 30_000, now), 30_000);
  assert.equal(ageFromAsOf((now - 30_000) / 1000, now), 30_000); // epoch seconds
  assert.equal(ageFromAsOf(new Date(now - 90_000).toISOString(), now), 90_000);
  assert.equal(ageFromAsOf("not a date", now), null);
  assert.equal(ageFromAsOf(0, now), null);
  assert.equal(classifyAge(60_000, 60_000), "fresh");
  assert.equal(classifyAge(60_001, 60_000), "stale");
  assert.equal(classifyAge(null, 60_000), "unknown");
  assert.equal(classifyAge(10, null), "unknown");
  // Age only ever downgrades: ok -> stale, but unavailable never becomes ok.
  assert.equal(effectiveDataState("ok", 120_000, 60_000), "stale");
  assert.equal(effectiveDataState("partial", 120_000, 60_000), "stale");
  assert.equal(effectiveDataState("ok", 10_000, 60_000), "ok");
  assert.equal(effectiveDataState("unavailable", 10, 60_000), "unavailable");
});

// ─── Item 7: /api/ofi payload ───────────────────────────────────────────────

function bars(n: number, missingIdx: number[] = [], t0 = 1_760_000_000_000) {
  let cum = 0;
  return Array.from({ length: n }, (_, i) => {
    const missing = missingIdx.includes(i);
    const sv = missing ? 0 : (i % 2 === 0 ? 100 : -40);
    cum += sv;
    return { ts: t0 + i * 60_000, signedVolume: sv, cumulative: cum, ...(missing ? { volumeMissing: true } : {}) };
  });
}
function trend(b: ReturnType<typeof bars>, dataState: OfiTrendLike["dataState"]): OfiTrendLike {
  return {
    bars: b, cumulativeNow: b.length ? b[b.length - 1].cumulative : 0, slope15m: 0, slope5m: 0,
    trend: "BULLISH", acceleration: "FLAT", dataState,
    volumeMissingBars: b.filter((x) => (x as any).volumeMissing).length,
  };
}

test("ofi payload: complete tape passes dataState ok and a complete trend", () => {
  const b = bars(30);
  const p = ofiApiPayload(trend(b, "ok"), b[29].ts + 5_000);
  assert.equal(p.dataState, "ok");
  assert.equal(p.dataStateReason, null);
  assert.equal(p.trendComplete, true);
  assert.equal(p.bars.length, 30);
  assert.equal(p.asOfMs, b[29].ts, "asOf is the data time of the last bar");
  assert.ok(p.bars.every((x) => x.volumeMissing === false && typeof x.signedVolume === "number"));
});

test("ofi payload: missing-volume bars are gaps (null), not zero, and withhold the trend", () => {
  const b = bars(30, [27]); // inside the last-15 window
  const p = ofiApiPayload(trend(b, "partial"), Date.now());
  assert.equal(p.dataState, "partial");
  assert.match(p.dataStateReason ?? "", /1 of 30 minute bars arrived without volume/);
  const gap = p.bars[27];
  assert.equal(gap.volumeMissing, true);
  assert.equal(gap.signedVolume, null);
  assert.equal(p.trendWindowMissingBars, 1);
  assert.equal(p.trendComplete, false);
  // A gap outside the 15-bar window keeps the trend readable (state still partial).
  const early = ofiApiPayload(trend(bars(30, [2]), "partial"), Date.now());
  assert.equal(early.trendWindowMissingBars, 0);
  assert.equal(early.trendComplete, true);
  assert.equal(early.dataState, "partial");
});

test("ofi payload: unavailable says why and is never a flat read", () => {
  const none = ofiApiPayload(trend([], "unavailable"), Date.now());
  assert.equal(none.dataState, "unavailable");
  assert.match(none.dataStateReason ?? "", /could not be fetched/);
  assert.equal(none.trendComplete, false);
  assert.equal(none.asOfMs, null);
  const allMissing = bars(20, Array.from({ length: 20 }, (_, i) => i));
  const p = ofiApiPayload(trend(allMissing, "unavailable"), Date.now());
  assert.match(p.dataStateReason ?? "", /every SPY minute bar arrived without volume/);
  assert.ok(p.bars.every((x) => x.signedVolume === null));
});

test("ofi payload: fewer than 15 bars is not a 15-minute slope", () => {
  const p = ofiApiPayload(trend(bars(10), "ok"), Date.now());
  assert.equal(p.trendComplete, false);
  assert.equal(p.totalBars, 10);
});
