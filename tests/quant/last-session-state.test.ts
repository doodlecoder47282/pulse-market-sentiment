// Market closed: the settled last-session chain / daily bars are a state of
// their own ("last session": readable, dated, neutral), never "stale" by age
// (stale means a failed refresh of data that could have moved) and never "live".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeDataState, effectiveDataState, normalizeDataState } from "../../shared/dataState";

const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

test("shared state: last_session is known, neutral, readable; age never downgrades it to stale", () => {
  assert.equal(normalizeDataState("last_session"), "last_session");
  assert.equal(normalizeDataState("last-session"), "last_session");
  assert.equal(normalizeDataState("stale_session"), "last_session", "the 0DTE map's after-close state");
  const v = describeDataState("last_session");
  assert.equal(v.label, "last session");
  assert.equal(v.tone, "neutral");
  assert.equal(v.blocksSignal, false);
  const fiveHours = 5 * 3600_000, cap = 30 * 60_000;
  assert.equal(effectiveDataState("ok", fiveHours, cap), "stale", "without the flag an old payload is stale");
  assert.equal(effectiveDataState("ok", fiveHours, cap, true), "last_session");
  assert.equal(effectiveDataState("stale", fiveHours, cap, true), "last_session", "a settled copy a server still marked stale reads last session");
  assert.equal(effectiveDataState("unavailable", fiveHours, cap, true), "unavailable", "never upgrades a bad state");
  assert.equal(effectiveDataState("ok", 1000, cap, false), "ok");
});

test("wiring: the flag travels from the policy to every chip and badge", () => {
  const pol = src("server/schwabDataPolicy.ts");
  assert.match(pol, /stale: false, lastSession: true, maxAgeMs, reason: why/);
  const sch = src("server/schwab.ts");
  assert.match(sch, /lastSession: f\.lastSession === true,\s*maxAgeMs: f\.maxAgeMs,\s*staleReason: f\.reason,/, "chain payload");
  assert.match(sch, /stale: f\.stale, lastSession: f\.lastSession === true, maxAgeMs: f\.maxAgeMs,/, "price history payload");
  const routes = src("server/routes.ts");
  assert.equal((routes.match(/chainLastSession: chain\.lastSession === true,/g) ?? []).length, 3);
  assert.match(src("server/models.ts"), /chainLastSession: chain\.lastSession === true,/);
  assert.match(src("server/exposures.ts"), /chainLastSession: chain\.lastSession === true,/);
  assert.match(src("server/ohlc.ts"), /lastSession: resp\.lastSession === true,/);
  const chip = src("client/src/components/DataStateChip.tsx");
  assert.match(chip, /effectiveDataState\(state, ageMs, maxAgeMs, lastSession\)/);
  assert.match(src("client/src/components/DataAgeChip.tsx"), /lastSession=\{lastSession\}/);
  for (const f of ["ChainAudit", "ExposurePanel", "Heatseeker", "Killbox", "ModelsPanel", "ChartLevelsCard", "TodayCard"]) {
    assert.match(src(`client/src/components/${f}.tsx`), /chainLastSession/, f);
  }
  assert.match(src("client/src/components/ChartPanel.tsx"), /lastSession=\{ohlc\.lastSession\}/);
  const badge = src("client/src/components/LivenessBadge.tsx");
  assert.match(badge, /: stale\s*\? "STALE"\s*: lastSession\s*\? "CLOSED"\s*: schwabLive\s*\? "LIVE"/);
  assert.match(badge, /CLOSED:\s*\{[^}]*label: "closed"[^}]*pulse: false/);
});
