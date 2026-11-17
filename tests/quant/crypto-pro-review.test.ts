// Practitioner review 2026-11-17 (meme-coin desk), first batch: Jupiter coverage and the graduate flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const eng = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");

test("Jupiter: every mint refreshed in a tick is asked (two spaced calls), and a failed call fails only its own mints", () => {
  assert.match(eng, /const JUP_CALLS_PER_TICK = 2;\s*const JUP_CALL_GAP_MS = 2_500;/);
  assert.match(eng, /\.slice\(0, JUP_MAX_IDS \* JUP_CALLS_PER_TICK\);/);
  assert.match(eng, /for \(let k = 0; k < jupMints\.length; k \+= JUP_MAX_IDS\) \{\s*const part = jupMints\.slice\(k, k \+ JUP_MAX_IDS\);\s*if \(k > 0\) await sleep\(JUP_CALL_GAP_MS\);/);
  assert.match(eng, /for \(const m of part\) jup\.failedMints\.add\(m\);/);
  assert.match(eng, /failed: jup\.failedMints\.has\(c\.tokenAddress\)/);
  // The keyless tier is 0.5 req/s: the gap between the two calls is at least 2 s.
  assert.ok(2_500 >= 2_000);
  // Health: a full batch pricing nothing still fails; a small one is inconclusive.
  assert.match(eng, /else if \(asked >= JUP_INCONCLUSIVE_UNDER\) markFail\(jupHealth, `answered but priced 0 of \$\{asked\} mints`\);/);
});

test("graduate flag: only a coin trading on PumpSwap is called graduated; a bonding-curve pair is not", () => {
  const body = /function isPumpGraduate\(dexId: string \| null \| undefined\): boolean \{([\s\S]*?)\n\}/.exec(eng)![1];
  const isPumpGraduate = new Function("dexId", body) as (d: unknown) => boolean;
  assert.equal(isPumpGraduate("pumpswap"), true);
  assert.equal(isPumpGraduate("PumpSwap"), true);
  assert.equal(isPumpGraduate("pump-fun"), false);
  assert.equal(isPumpGraduate("pumpfun"), false);
  assert.equal(isPumpGraduate("raydium"), false);
  assert.equal(isPumpGraduate(null), false);
  assert.doesNotMatch(eng, /pumpfunGraduate: isPumpDex\(/);
  // The pump.fun coin read still covers bonding-curve pairs.
  assert.match(eng, /c\.tokenAddress\.endsWith\("pump"\) \|\| isPumpDex\(c\.dexId\)/);
});
