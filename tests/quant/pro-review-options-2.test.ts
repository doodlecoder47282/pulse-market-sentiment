// Practitioner review 2026-11-17, options batch 2: O1 (whale direction basis), O3 (expiry pass after the close).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("O1: a whale that passed the gate as ask-side has one direction, whatever its latest print says", () => {
  const e = read("server/flowAlertEngine.ts");
  const body = /export function whaleDirection\(type: "C" \| "P", askSide: boolean, lastPrintSentiment: string\): string \{([\s\S]*?)\n\}/.exec(e)![1];
  const whaleDirection = new Function("type", "askSide", "lastPrintSentiment", body) as (t: string, a: boolean, s: string) => string;
  // The live case: a call passed as ask-side on the day, latest print at the bid (last-print label BEARISH).
  assert.equal(whaleDirection("C", true, "BEARISH"), "BULLISH");
  assert.equal(whaleDirection("C", true, "NEUTRAL"), "BULLISH");
  assert.equal(whaleDirection("P", true, "BULLISH"), "BEARISH");
  // Ask side not established by the gate: the last print decides, as before.
  assert.equal(whaleDirection("C", false, "BEARISH"), "BEARISH");
  assert.equal(whaleDirection("P", false, "NEUTRAL"), "NEUTRAL");
  // Both places a hit is built use it (the alert and the 30 s preview), so the label cannot differ between them.
  assert.equal((e.match(/sentiment: whaleDirection\(c\.type, g\.askSide, c\.sentiment\)/g) ?? []).length, 2);
  assert.doesNotMatch(e, /sentiment: c\.sentiment,/);
});

test("O3: positions that expired at the close are closed out while the market is closed, stamped at the expiry close", () => {
  const w = read("server/whaleFollowThrough.ts");
  assert.match(w, /export function expirePass\(now: number = Date\.now\(\)\): number \{/);
  assert.match(w, /transitionToTerminal\(p, "EXPIRED", "expiration date passed", Number\.isFinite\(at\) && at <= now \? at : now\);\s*safePersistFollow\(p\);/);
  const e = read("server/flowAlertEngine.ts");
  const i = e.indexOf("if (!isRthNow()) {");
  assert.match(e.slice(i, i + 500), /const \{ expirePass \} = await import\("\.\/whaleFollowThrough"\);\s*const n = expirePass\(\);/);
  assert.match(read("client/src/components/WhaleFlowPanel.tsx"), /\{positions\.length\} closed or expired/);
});
