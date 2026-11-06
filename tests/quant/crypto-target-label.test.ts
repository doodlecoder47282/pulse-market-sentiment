// HIT_5M is a market-cap grade (the rule book's target), never a time; copy reads the book.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

test("Crypto copy names the market-cap target from the rule book and no 5-minute target", () => {
  const p = src("client/src/components/CryptoPanel.tsx");
  const h = src("client/src/components/CryptoHowTo.tsx");
  for (const s of [p, h]) {
    assert.doesNotMatch(s, /5-minute target|hit 5M\b/);
  }
  assert.match(p, /const TARGET_CAP = `\$\$\{\(CRYPTO_RULES\.universe\.targetMcapUsd \/ 1e6\)/);
  assert.match(p, /s\.outcome === "HIT_5M" \? `\$\{TARGET_CAP\} CAP` : s\.outcome/);
  assert.match(h, /graded over \$\{CRYPTO_RULES\.grading\.horizonHours\} hours/);
  assert.match(h, /no data, its own outcome/);
  assert.match(h, /CRYPTO_RULES\.grading\.maxNoDataShare/);
});
