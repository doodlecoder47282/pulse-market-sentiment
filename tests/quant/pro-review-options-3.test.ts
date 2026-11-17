// Practitioner review 2026-11-17, options batch 3 (copy): O6, O7, O9, O10 and the follow-ups from the review of #94.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("O6: the net-premium tile is named for what it is, carries no BULL/BEAR verdict, and says how it differs from P/C and dominance", () => {
  const f = read("client/src/components/FlowPanel.tsx");
  assert.doesNotMatch(f, /label="Net Bias"/);
  assert.doesNotMatch(f, /\? "BULL" : "BEAR"/);
  assert.match(f, /label="Last-print net premium"/);
  assert.match(f, /data-testid="flow-net-premium-note"/);
  assert.match(f, /one print can move a day of premium between sides/);
  assert.doesNotMatch(f, /Net bias \$/);
});

test("O7/O9/O10: gamma copy states the dealer convention as a convention, the prior-session open interest, and calendar time", () => {
  const e = read("client/src/components/ExposurePanel.tsx");
  assert.doesNotMatch(e, /262 trading days/);
  assert.match(e, /calendar time to expiry/);
  assert.match(e, /intraday values use the prior session's OI/);
  assert.match(e, /The convention is an assumption, not an observation\./);
  const d = read("client/src/pages/dashboard.tsx");
  // The convention matches the sign the code applies (calls +, puts -): dealers long calls, short puts.
  assert.match(d, /customers sell calls and buy puts, so dealers are long calls and short puts/);
  for (const f of ["client/src/components/ExposurePanel.tsx", "client/src/pages/dashboard.tsx", "client/src/pages/method.tsx"]) {
    assert.doesNotMatch(read(f), /customers (are )?long calls,? (and )?short puts/, `${f} states the dealer convention backwards`);
  }
  assert.match(read("server/exposureProfile.ts"), /dealers? (are )?long calls?/i);
  assert.match(d, /intraday bars use the prior session's OI/);
  assert.match(d, /"Net GEX": "[^"]*Uses the prior session's open interest\."/);
});

test("whale copy matches the direction basis now used", () => {
  const i = read("client/src/components/EdgeInfo.tsx");
  assert.doesNotMatch(i, /Side comes from the latest print vs the quote, not from each trade\./);
  assert.match(i, /whether the trade opened or closed a position is not known/);
  assert.doesNotMatch(read("server/tradeEnvironment.ts"), /by last-print side\)/);
});
