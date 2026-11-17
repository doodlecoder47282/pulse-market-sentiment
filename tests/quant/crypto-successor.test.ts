// Practitioner review C11: a coin whose original pair left the feed is graded on its successor pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickSuccessorPool } from "../../server/cryptoStats";

const mk = (pairAddress: string, token: string, liq: number | null, chainId = "solana") => ({ chainId, pairAddress, baseToken: { address: token }, liquidity: liq == null ? {} : { usd: liq }, marketCap: 1 });

test("successor pool: the same token's deepest other pool on the same chain, or none", () => {
  const pairs = [mk("CURVE", "MintA", 5_000), mk("SWAP1", "MintA", 80_000), mk("SWAP2", "MintA", 20_000), mk("OTHER", "MintB", 900_000), mk("BASE", "MintA", 500_000, "base"), mk("NOLIQ", "MintA", null)];
  assert.equal(pickSuccessorPool(pairs, "solana", "MintA", "CURVE").pairAddress, "SWAP1");
  // Never the original pair, never another token's pool, never another chain, never a pool with no liquidity figure.
  assert.equal(pickSuccessorPool([mk("CURVE", "MintA", 5_000)], "solana", "MintA", "CURVE"), null);
  assert.equal(pickSuccessorPool([mk("OTHER", "MintB", 900_000)], "solana", "MintA", "CURVE"), null);
  assert.equal(pickSuccessorPool([mk("BASE", "MintA", 500_000, "base")], "solana", "MintA", "CURVE"), null);
  assert.equal(pickSuccessorPool([mk("NOLIQ", "MintA", null)], "solana", "MintA", "CURVE"), null);
  // An observed $0 pool is a real reading (a pulled pool must be able to grade RUGGED).
  assert.equal(pickSuccessorPool([mk("ZERO", "MintA", 0)], "solana", "MintA", "CURVE").pairAddress, "ZERO");
  assert.equal(pickSuccessorPool(null, "solana", "MintA", "CURVE"), null);
  assert.equal(pickSuccessorPool(pairs, "solana", "", "CURVE"), null);
});

test("wiring: the grader and the horizon pass fall back to the successor only when the pair is absent", () => {
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.equal((e.match(/if \(!p && row\.token_address\) \{\s*const byToken = await getJson\(`\$\{DS_BASE\}\/latest\/dex\/tokens\/\$\{row\.token_address\}`\);\s*p = pickSuccessorPool\(byToken\?\.pairs, String\(row\.chain\), String\(row\.token_address\), String\(row\.pair_address\)\);/g) ?? []).length, 2);
  assert.match(e, /SELECT id, pair_address, token_address, chain, detected_at, mcap_at_signal,/);
});
