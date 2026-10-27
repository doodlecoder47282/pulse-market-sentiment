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
  assert.equal(Object.keys(VERDICT_CODE_TEXT).length, 13);
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
