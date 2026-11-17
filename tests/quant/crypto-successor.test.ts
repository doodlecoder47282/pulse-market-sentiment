// Practitioner review C11: a coin whose original pair left the feed is graded on its successor pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickSuccessorPool } from "../../server/cryptoStats";

const mk = (pairAddress: string, token: string, liq: number | null, chainId = "solana") => ({ chainId, pairAddress, baseToken: { address: token }, liquidity: liq == null ? {} : { usd: liq }, marketCap: 1 });

test("successor pool: the same token's deepest other pool on the same chain, at least as deep as the floor, or none", () => {
  const pairs = [mk("CURVE", "MintA", 5_000), mk("SWAP1", "MintA", 80_000), mk("SWAP2", "MintA", 20_000), mk("OTHER", "MintB", 900_000), mk("BASE", "MintA", 500_000, "base"), mk("NOLIQ", "MintA", null)];
  assert.equal(pickSuccessorPool(pairs, "solana", "MintA", "CURVE", 8_000).pairAddress, "SWAP1");
  // Never the original pair, never another token's pool, never another chain, never a pool with no liquidity figure.
  assert.equal(pickSuccessorPool([mk("CURVE", "MintA", 50_000)], "solana", "MintA", "CURVE", 8_000), null);
  assert.equal(pickSuccessorPool([mk("OTHER", "MintB", 900_000)], "solana", "MintA", "CURVE", 8_000), null);
  assert.equal(pickSuccessorPool([mk("BASE", "MintA", 500_000, "base")], "solana", "MintA", "CURVE", 8_000), null);
  assert.equal(pickSuccessorPool([mk("NOLIQ", "MintA", null)], "solana", "MintA", "CURVE", 8_000), null);
  assert.equal(pickSuccessorPool(null, "solana", "MintA", "CURVE", 8_000), null);
  assert.equal(pickSuccessorPool(pairs, "solana", "", "CURVE", 8_000), null);
  assert.equal(pickSuccessorPool(pairs, "solana", "MintA", "CURVE", NaN), null);
});

test("review: a thin side pool is never a successor, so an empty pair answer cannot write a wrong RUGGED or HIT", async () => {
  const { gradeSignal } = await import("../../server/cryptoStats");
  // The reviewer's case: $40k entry liquidity, the pair answer comes back empty once, the only other pool is $3k.
  const thin = [mk("SIDE", "MintA", 3_000)];
  assert.equal(pickSuccessorPool(thin, "solana", "MintA", "CURVE", Math.max(8_000, 40_000)), null, "no successor: the row stays as it was");
  // Had it been chosen, the grade would have been a permanent RUGGED.
  assert.equal(gradeSignal({ entryMcap: 300_000, entryLiq: 40_000, prevPeak: 320_000, mcap: 310_000, liq: 3_000, ageMs: 3_600_000, targetMcap: 5_000_000, horizonMs: 72 * 3_600_000 }).outcome, "RUGGED");
  // A dust pool with an off-market cap above the target is not chosen either.
  assert.equal(pickSuccessorPool([{ ...mk("DUST", "MintA", 200), marketCap: 9_000_000 }], "solana", "MintA", "CURVE", 40_000), null);
  // A successor at least as deep as the entry pool cannot trip the liquidity test and grades on its cap.
  const deep = pickSuccessorPool([mk("SWAP", "MintA", 120_000)], "solana", "MintA", "CURVE", 40_000);
  assert.equal(deep.pairAddress, "SWAP");
  assert.equal(gradeSignal({ entryMcap: 300_000, entryLiq: 40_000, prevPeak: 320_000, mcap: 900_000, liq: 120_000, ageMs: 3_600_000, targetMcap: 5_000_000, horizonMs: 72 * 3_600_000 }).outcome, "OPEN");
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.match(e, /return Math\.max\(LIQ_FLOOR_USD, Number\.isFinite\(e\) && e > 0 \? e : 0\);/);
});

test("wiring: the grader and the horizon pass fall back to the successor only when the pair is absent", () => {
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.equal((e.match(/if \(!p && row\.token_address\) \{\s*const byToken = await getJson\(`\$\{DS_BASE\}\/latest\/dex\/tokens\/\$\{row\.token_address\}`\);\s*p = pickSuccessorPool\(byToken\?\.pairs, String\(row\.chain\), String\(row\.token_address\), String\(row\.pair_address\), successorFloor\(row\.liquidity_at_signal\)\);/g) ?? []).length, 2);
  assert.match(e, /SELECT id, pair_address, token_address, chain, detected_at, mcap_at_signal,/);
});
