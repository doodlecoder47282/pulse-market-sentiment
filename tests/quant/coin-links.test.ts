import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("coin links: fomo and pump.fun pages for a Solana mint; nothing for bad input or other chains", async () => {
  const { coinLinks } = await import("../../shared/coinLinks");
  const mint = "FEXGegqeVm5vZurqyC7qsmkLqWspVV1ACb9bbLvcpump";
  assert.deepEqual(coinLinks("solana", mint), { fomo: `https://fomo.family/tokens/solana/${mint}`, pump: `https://pump.fun/coin/${mint}` });
  assert.equal(coinLinks("base", mint), null);
  assert.equal(coinLinks("solana", "not a mint"), null);
  assert.equal(coinLinks("solana", "javascript:alert(1)"), null);
});

test("crypto how-to copy describes, never predicts (brief banned words)", () => {
  const src = readFileSync(new URL("../../client/src/components/CryptoHowTo.tsx", import.meta.url), "utf8");
  const copy = [...src.matchAll(/"([^"]{12,})"/g)].map((m) => m[1]).join(" ");
  assert.doesNotMatch(copy, /\b(will|expect|edge|high probability)\b/i);
});
