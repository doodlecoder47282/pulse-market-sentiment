import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-hold-"));
process.env.BATCAVE_OI_HOLD_DIR = dir;
const { applyOiHold } = await import("../../server/oiHold");

const FRI = Date.parse("2026-10-16T15:00:00Z"); // trading day
const SAT = Date.parse("2026-10-17T15:00:00Z"); // weekend
const chain = (oi: number) => ({
  calls: { "2026-10-19:3": { "7650.0": [{ openInterest: oi, totalVolume: 10 }] } },
  puts: { "2026-10-19:3": { "7650.0": [{ openInterest: oi * 2, totalVolume: 5 }] } },
});

test("weekend all-zero OI is filled from the last trading day and labeled held", () => {
  const live = chain(100);
  assert.equal(applyOiHold("$TEST", live.calls, live.puts, FRI).source, "live");
  const wk = chain(0);
  const st = applyOiHold("$TEST", wk.calls, wk.puts, SAT);
  assert.equal(st.source, "held");
  assert.equal(st.sessionDate, "2026-10-16");
  assert.equal(wk.calls["2026-10-19:3"]["7650.0"][0].openInterest, 100);
  assert.equal(wk.puts["2026-10-19:3"]["7650.0"][0].openInterest, 200);
  assert.ok(fs.existsSync(path.join(dir, "_TEST.json")), "saved to disk for restarts");
});

test("no saved OI on a weekend stays zero and says why", () => {
  const wk = chain(0);
  const st = applyOiHold("$NONE", wk.calls, wk.puts, SAT);
  assert.equal(st.source, "none");
  assert.match(st.note ?? "", /non-trading days/);
  assert.equal(wk.calls["2026-10-19:3"]["7650.0"][0].openInterest, 0);
});

test("a trading-day zero-OI chain is never back-filled", () => {
  const live = chain(50);
  applyOiHold("$TD", live.calls, live.puts, FRI);
  const z = chain(0);
  assert.equal(applyOiHold("$TD", z.calls, z.puts, FRI).source, "none");
  assert.equal(z.calls["2026-10-19:3"]["7650.0"][0].openInterest, 0);
});
