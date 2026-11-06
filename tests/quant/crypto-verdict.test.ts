// tests/quant/crypto-verdict.test.ts
//
// Desk risk from the majors read fails closed, and every verdict code has a
// plain-language meaning.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deskRiskFromMajors, VERDICT_CODE_TEXT, DESK_RISK_OFF_PCT } from "../../shared/cryptoVerdict";

const snap = (mid: number | null, vwap: number | null, state: "ok" | "partial" | "unavailable" = "ok") => ({
  state, rows: [{ asset: "BTC", kraken: { mid, vwap24h: vwap }, coinbase: { mid } }, { asset: "ETH", kraken: { mid: 2000, vwap24h: 2000 }, coinbase: { mid: 2000 } }],
});

test("desk risk: on above the line, off at or under it, unknown when the majors cannot be read", () => {
  assert.equal(deskRiskFromMajors(snap(100_000, 99_000), 1).state, "on");
  const off = deskRiskFromMajors(snap(94_000, 100_000), 1);
  assert.equal(off.state, "off");
  assert.equal(off.btcVsVwap24hPct, -6);
  assert.equal(deskRiskFromMajors(snap(95_000, 100_000), 1).state, "off", `exactly ${DESK_RISK_OFF_PCT}% is off`);
  assert.equal(deskRiskFromMajors(snap(95_100, 100_000), 1).state, "on");
  assert.equal(deskRiskFromMajors(snap(100_000, null), 1).state, "unknown");
  assert.equal(deskRiskFromMajors(snap(100_000, 100_000, "unavailable"), 1).state, "unknown");
  assert.equal(deskRiskFromMajors(null, 1).state, "unknown");
});

test("every verdict code has a meaning and none says buy, sell or enter a trade", () => {
  for (const [code, text] of Object.entries(VERDICT_CODE_TEXT)) {
    assert.ok(text.length > 8, code);
    assert.ok(!/\b(buy|sell) (now|it|this)\b/i.test(text), code);
  }
  assert.equal(Object.keys(VERDICT_CODE_TEXT).length, 14);
});

test("desk risk: a stale or failed venue read is unknown, never on or off; the reason names the venue", () => {
  const stale = { state: "partial" as const, rows: [{ asset: "BTC", kraken: { state: "stale", mid: 90_000, vwap24h: 100_000 }, coinbase: { state: "ok", mid: null } }] };
  assert.equal(deskRiskFromMajors(stale, 1).state, "unknown");
  assert.match(deskRiskFromMajors(stale, 1).reason, /Kraken BTC read stale/);
  const cbOnly = { state: "partial" as const, rows: [{ asset: "BTC", kraken: { state: "ok", mid: null, vwap24h: 100_000 }, coinbase: { state: "ok", mid: 94_000 } }] };
  const r = deskRiskFromMajors(cbOnly, 1);
  assert.equal(r.state, "off");
  assert.match(r.reason, /Coinbase mid/);
  const cbStale = { state: "partial" as const, rows: [{ asset: "BTC", kraken: { state: "ok", mid: null, vwap24h: 100_000 }, coinbase: { state: "stale", mid: 94_000 } }] };
  assert.equal(deskRiskFromMajors(cbStale, 1).state, "unknown");
});

test("served verdict: an ENTER on pair data older than the freshness limit is WATCH stale_data, hold reason first", async () => {
  const { servedVerdict, pairDataStale, staleDataReason, ENTER_MAX_AGE_MS, VERDICT_CODE_TEXT: T } = await import("../../shared/cryptoVerdict");
  const now = Date.parse("2026-11-06T15:00:00Z");
  const on = { state: "on" as const, reason: "ok" };
  const enter = (ageMs: number | null) => ({ verdict: "ENTER" as const, verdictCode: "enter" as const, verdictReasons: ["score 80, flow sustained", "pool price confirmed", "top-10 18%", "narrative confirm: x"], lastRefreshAt: ageMs == null ? null : now - ageMs });
  assert.equal(ENTER_MAX_AGE_MS, 10 * 60_000);
  assert.equal(T.stale_data.length > 8, true);
  // Exactly at the limit stands; just over is held.
  assert.equal(servedVerdict(enter(ENTER_MAX_AGE_MS), on, now).verdict, "ENTER");
  const held = servedVerdict(enter(ENTER_MAX_AGE_MS + 1), on, now);
  assert.equal(held.verdict, "WATCH");
  assert.equal(held.verdictCode, "stale_data");
  assert.match(held.verdictReasons[0], /^held at WATCH: pair data last refreshed 10\.1 min ago \(limit 10 min\)/);
  assert.equal(held.verdictReasons.length, 5, "the hold reason is prepended, the ENTER reasons kept after it");
  // A just-over age never reads as under the limit.
  assert.match(staleDataReason(10 * 60_000 + 6_000), /10\.1 min ago/);
  // Never refreshed fails closed.
  assert.deepEqual(pairDataStale(null, now), { stale: true, ageMs: null });
  assert.equal(servedVerdict(enter(null), on, now).verdictCode, "stale_data");
  // Stale AND desk off: stale is the code, both reasons first, stale first.
  const both = servedVerdict(enter(3 * 3600_000), { state: "off", reason: "BTC -6% vs VWAP" }, now);
  assert.equal(both.verdictCode, "stale_data");
  assert.match(both.verdictReasons[0], /pair data last refreshed 180\.0 min ago/);
  assert.match(both.verdictReasons[1], /desk risk off \(BTC -6% vs VWAP\)/);
  // Fresh and desk off: risk_off.
  assert.equal(servedVerdict(enter(60_000), { state: "off", reason: "r" }, now).verdictCode, "risk_off");
  assert.equal(servedVerdict(enter(60_000), { state: "unknown", reason: "r" }, now).verdictCode, "risk_unknown");
  // Non-ENTER rows pass through untouched.
  const w = { verdict: "WATCH" as const, verdictCode: "forming" as const, verdictReasons: ["x"], lastRefreshAt: now - 3600_000 };
  assert.equal(servedVerdict(w, on, now), w);
});
