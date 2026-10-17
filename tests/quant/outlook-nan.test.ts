// tests/quant/outlook-nan.test.ts
//
// Regression: with no Schwab spot (0), the outlook's expected move was
// (0 - 0) / 0 = NaN, which JSON serialises as null, and the scenario card's
// toFixed on it crashed the whole Chart tab (CI UX audit, every viewport).
// tickerOutlook.ts cannot be imported without npm modules, so this holds the
// source to the guard on both sides and checks the JSON round trip that bit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("NaN serialises as null, which is why the server must never emit it", () => {
  assert.equal(JSON.stringify({ targetPct: (0 - 0) / 0 }), '{"targetPct":null}');
});

test("server: expected move is null without a positive spot; LLM scenario targets fall back when not finite", () => {
  const s = src("server/tickerOutlook.ts");
  assert.match(s, /const expectedMovePct = target != null && spot > 0 \? \(\(target - spot\) \/ spot\) \* 100 : null;/);
  assert.equal((s.match(/targetPct: finiteOr\(Number\(sc\.(bull|base|bear)\?\.targetPct\), fallback\.scenarios\.\1\.targetPct\)/g) || []).length, 3);
});

test("client: the scenario card prints n/a for a null or non-finite target instead of calling toFixed on it", () => {
  const c = src("client/src/components/TickerOutlookCard.tsx");
  assert.match(c, /s\.targetPct != null && Number\.isFinite\(s\.targetPct\) \? `\$\{s\.targetPct >= 0 \? "\+" : ""\}\$\{s\.targetPct\.toFixed\(2\)\}%` : "n\/a"/);
  assert.ok(!/\n\s*\{s\.targetPct\.toFixed\(2\)\}%/.test(c), "no bare toFixed on the scenario target");
});
