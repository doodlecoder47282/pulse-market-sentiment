// A missing day change is shown as missing, never as +0.00%.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

test("Trade Desk chart header: missing changePct is null (fmt.pct shows a dash), neutral tone", () => {
  const t = src("client/src/components/TradeDesk.tsx");
  assert.doesNotMatch(t, /const chg = quote\?\.changePct \?\? 0;/);
  assert.match(t, /const chgTone = chg == null \? "text-muted-foreground"/);
});

test("Models intraday tape: missing change reads 'change unavailable', not +0.00 (0.00%)", () => {
  const m = src("client/src/components/ModelsPanel.tsx");
  assert.doesNotMatch(m, /const changePct = data\?\.changePct \?\? 0;/);
  assert.doesNotMatch(m, /const change = data\?\.change \?\? 0;/);
  assert.match(m, /· change unavailable/);
});
