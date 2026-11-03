import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-hold-"));
process.env.BATCAVE_OI_HOLD_DIR = dir;
const oiHoldMod: any = await import("../../server/oiHold");
const { applyOiHold, occKey } = oiHoldMod;

const FRI = Date.parse("2026-10-16T15:00:00Z"); // trading day
const SAT = Date.parse("2026-10-17T15:00:00Z"); // weekend
const MON_PRE = Date.parse("2026-10-19T11:00:00Z"); // Monday 07:00 ET, before OI posts
const WED = Date.parse("2026-10-21T15:00:00Z"); // two sessions later
const chain = (oi: number, sym = "SPXW  261019C07650000", psym = "SPXW  261019P07650000") => ({
  calls: { "2026-10-19:3": { "7650.0": [{ symbol: sym, openInterest: oi, totalVolume: 10 }] } },
  puts: { "2026-10-19:3": { "7650.0": [{ symbol: psym, openInterest: oi * 2, totalVolume: 5 }] } },
});

test("occKey matches Schwab's padded root and Cboe's unpadded symbol", () => {
  assert.equal(occKey("SPXW  261019C07650000"), "SPXW|261019|C|7650");
  assert.equal(occKey("SPXW261019C07650000"), "SPXW|261019|C|7650");
  assert.equal(occKey("SPY   261019P00762500"), "SPY|261019|P|762.5");
  assert.equal(occKey("garbage"), null);
});

test("weekend all-zero OI is filled from the last trading day and labeled held", async () => {
  const live = chain(100);
  assert.equal(applyOiHold("$TEST", live.calls, live.puts, FRI).source, "live");
  const wk = chain(0);
  const st = applyOiHold("$TEST", wk.calls, wk.puts, SAT, { seed: false });
  assert.equal(st.source, "held");
  assert.equal(st.sessionDate, "2026-10-16");
  assert.equal(st.heldFrom, "schwab");
  assert.equal(wk.calls["2026-10-19:3"]["7650.0"][0].openInterest, 100);
  assert.equal(wk.puts["2026-10-19:3"]["7650.0"][0].openInterest, 200);
  await new Promise((r) => setTimeout(r, 10_500)); // debounced flush
  assert.ok(fs.existsSync(path.join(dir, "_TEST.json")), "saved to disk for restarts");
});

test("Monday before OI posts keeps Friday's OI; it lapses two sessions later", () => {
  const pre = chain(0);
  assert.equal(applyOiHold("$TEST", pre.calls, pre.puts, MON_PRE, { seed: false }).source, "held");
  const late = chain(0);
  assert.equal(applyOiHold("$TEST", late.calls, late.puts, WED, { seed: false }).source, "none");
});

test("SPX and SPXW at the same strike/expiry keep their own OI", () => {
  const live = chain(0);
  live.calls["2026-10-19:3"]["7650.0"] = [
    { symbol: "SPX   261019C07650000", openInterest: 7 },
    { symbol: "SPXW  261019C07650000", openInterest: 900 },
  ] as any;
  live.puts["2026-10-19:3"]["7650.0"] = [{ symbol: "SPXW  261019P07650000", openInterest: 3 }] as any;
  applyOiHold("$ROOTS", live.calls, live.puts, FRI);
  const wk = chain(0);
  wk.calls["2026-10-19:3"]["7650.0"] = [
    { symbol: "SPX   261019C07650000", openInterest: 0 },
    { symbol: "SPXW  261019C07650000", openInterest: 0 },
  ] as any;
  applyOiHold("$ROOTS", wk.calls, wk.puts, SAT, { seed: false });
  assert.deepEqual(wk.calls["2026-10-19:3"]["7650.0"].map((c: any) => c.openInterest), [7, 900]);
});

test("no saved OI stays zero and says why", () => {
  const wk = chain(0);
  const st = applyOiHold("$NONE", wk.calls, wk.puts, SAT, { seed: false });
  assert.equal(st.source, "none");
  assert.match(st.note ?? "", /non-trading days/);
  assert.equal(wk.calls["2026-10-19:3"]["7650.0"][0].openInterest, 0);
});

test("Schwab only: no Cboe seed, a non-Schwab store is ignored, the gap stays unavailable", () => {
  assert.equal(oiHoldMod.parseCboeOi, undefined, "Cboe parser removed (AGENTS.md: Schwab only)");
  fs.writeFileSync(path.join(dir, "_MIX.json"), JSON.stringify({ v: 2, symbol: "$MIX", sessionDate: "2026-10-16", savedAtMs: FRI, source: "schwab+cboe", oi: { "SPXW|261019|C|7650": 999 } }));
  const wk = chain(0);
  const st = applyOiHold("$MIX", wk.calls, wk.puts, SAT);
  assert.equal(st.source, "none");
  assert.equal(wk.calls["2026-10-19:3"]["7650.0"][0].openInterest, 0, "a failed read is never filled from another feed");
  assert.doesNotMatch(st.note ?? "", /cboe/i);
  assert.match(st.note ?? "", /unavailable/);
});

test("weekend partial OI (Schwab keeps a few contracts) still fills the rest from the store", () => {
  const live = chain(40, "SPXW  261019C07700000", "SPXW  261019P07700000");
  applyOiHold("$PART", live.calls, live.puts, FRI);
  const wk = chain(0, "SPXW  261019C07700000", "SPXW  261019P07700000");
  wk.calls["2026-10-19:3"]["7800.0"] = [{ symbol: "SPXW  261019C07800000", openInterest: 5 }] as any;
  const st = applyOiHold("$PART", wk.calls, wk.puts, SAT, { seed: false });
  assert.equal(st.source, "held");
  assert.equal(wk.calls["2026-10-19:3"]["7650.0"][0].openInterest, 40);
  assert.equal(wk.calls["2026-10-19:3"]["7800.0"][0].openInterest, 5, "Schwab's own value kept");
});

test("after today's OI posts, real zeros stay zero", () => {
  const c = chain(30);
  c.calls["2026-10-19:3"]["7800.0"] = [{ symbol: "SPXW  261019C07800000", openInterest: 0 }] as any;
  applyOiHold("$POST", c.calls, c.puts, FRI);
  const again = chain(30);
  again.calls["2026-10-19:3"]["7800.0"] = [{ symbol: "SPXW  261019C07800000", openInterest: 0 }] as any;
  assert.equal(applyOiHold("$POST", again.calls, again.puts, FRI, { seed: false }).source, "live");
  assert.equal(again.calls["2026-10-19:3"]["7800.0"][0].openInterest, 0);
});

test("a re-served (cached) chain that was filled stays labeled held", () => {
  const live = chain(60, "SPXW  261019C07600000", "SPXW  261019P07600000");
  applyOiHold("$CACHE", live.calls, live.puts, FRI);
  const wk = chain(0, "SPXW  261019C07600000", "SPXW  261019P07600000");
  assert.equal(applyOiHold("$CACHE", wk.calls, wk.puts, SAT, { seed: false }).source, "held");
  assert.equal(applyOiHold("$CACHE", wk.calls, wk.puts, SAT, { seed: false }).source, "held", "second read of the same objects");
});
