// tests/quant/crypto-rules-version.test.ts
//
// The crypto rule book (shared/cryptoRules.ts) is pinned to its version: a
// threshold change under an unchanged version would mix grades from two rule
// sets. Change a rule -> bump CRYPTO_RULES_VERSION -> pin the new hash here in
// the same commit. The engine, stats and verdict modules must read the book,
// never carry their own copies of these numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CRYPTO_RULES, CRYPTO_RULES_VERSION, describeCryptoRules } from "../../shared/cryptoRules";

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const PINNED: Record<string, string> = {
  // 2026.10.27-1: first versioned book; every number lifted verbatim from the engine as it ran since the 2026-10-23 audit.
  "2026.10.27-1": "e164980d995195297bde2284ec128fe30569458b150c057ea97bb74002b9cdf4",
  // 2026.10.27-2: review of PR #28: the book now owns the sustained-flow window, Jupiter bands, exit-door / mid-rug /
  // honeypot kills, top-10 / LP-lock / liq-over-mcap flags, security retry, desk-risk age and the cost constants;
  // watch.minScoreWithKill renamed mcapCeiling.watchMinScore (it was never a hard-kill floor). No number changed.
  "2026.10.27-2": "66e21bc4fa45805d9223eba61ef55b29a1ca58b6854ce03820f75226dc09e0f3",
};

test("crypto rule book content is pinned to its version", () => {
  const hash = createHash("sha256").update(canonical(CRYPTO_RULES)).digest("hex");
  const pinned = PINNED[CRYPTO_RULES_VERSION];
  assert.ok(pinned, `no pin for rule version ${CRYPTO_RULES_VERSION}: add PINNED["${CRYPTO_RULES_VERSION}"] = "${hash}"`);
  assert.equal(hash, pinned, `rule book changed under version ${CRYPTO_RULES_VERSION}: bump CRYPTO_RULES_VERSION and pin ${hash}`);
  const items = describeCryptoRules();
  assert.ok(items.length >= 18);
  for (const it of items) { assert.ok(it.path && it.value && it.text, `rule item incomplete: ${JSON.stringify(it)}`); }
});

test("the engine, stats and verdict read the book instead of carrying their own thresholds", () => {
  const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
  const eng = src("server/cryptoEngine.ts");
  for (const re of [/c\.score >= 70 &&/, />= 1\.5 &&/, />= 1\.5\)/, />= 0\.58\)/, /c\.score >= 55 \?/, /c\.score >= 50\)/, /liq \* 0\.005, 400/, /suggestedStopPct: -35,/, /= 72 \* 3600_000;/, /= 8_000;/, /= 5_000_000;/,
    /< 0\.03\)/, /< -55\)/, /> 45\)/, /< 50\)/, /mcap \* 2\)/, /> 30 \* 60_000/, /updated_at\) > 10 \* 60_000/, /deskRisk\.asOf > 10 \* 60_000/, /1M entry ceiling/, /0\.5% of pool liquidity/, /least 50 first-ENTER/]) {
    assert.doesNotMatch(eng, re, `literal threshold still in cryptoEngine.ts: ${re}`);
  }
  // Every NUMERIC leaf of the book is read by some module under server/ or shared/
  // (a threshold nobody reads is a hollow pin). Descriptive leaves (booleans,
  // the chain list) document the gate; their enforcement is asserted above.
  const leaves = (o: any, prefix: string): Array<[string, unknown]> => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? leaves(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v] as [string, unknown]]));
  const corpus = ["server/cryptoEngine.ts", "server/cryptoStats.ts", "server/sources/dexCross.ts", "shared/cryptoVerdict.ts", "shared/cryptoVerify.ts", "shared/memeStructure.ts", "shared/cryptoExpectancy.ts"].map(src).join("\n");
  const referenced = (leaf: string) => {
    const parent = leaf.replace(/\.[^.]+$/, "");
    return [`CRYPTO_RULES.${leaf}`, `rules.${leaf}`, `CRYPTO_RULES.${parent};`, `CRYPTO_RULES.${parent}.`, `= CRYPTO_RULES.${parent}`].some((needle) => corpus.includes(needle));
  };
  const unused = leaves(CRYPTO_RULES, "").filter(([leaf, v]) => typeof v === "number" && !referenced(leaf)).map(([leaf]) => leaf);
  assert.deepEqual(unused, [], `numeric rule leaves no module reads: ${unused.join(", ")}`);
  assert.match(eng, /rules: \{ version: CRYPTO_RULES_VERSION, items: describeCryptoRules\(\) \}/);
  assert.match(eng, /rulesVersion: CRYPTO_RULES_VERSION,/);
  const st = src("server/cryptoStats.ts");
  assert.doesNotMatch(st, /entryLiq \* 0\.15\b/);
  assert.doesNotMatch(st, /entryMcap \* 0\.1\b/);
  assert.match(st, /CRYPTO_SAMPLE_READY_MIN_GRADED = CRYPTO_RULES\.grading\.minSample/);
  const vd = src("shared/cryptoVerdict.ts");
  assert.match(vd, /DESK_RISK_OFF_PCT = CRYPTO_RULES\.deskRisk\.offBelowPct/);
  const dx = src("server/sources/dexCross.ts");
  assert.match(dx, /JUP_AGREE_PCT = CRYPTO_RULES\.jupiter\.agreePct/);
  assert.match(dx, /JUP_DIVERGE_PCT = CRYPTO_RULES\.jupiter\.divergePct/);
  const ms = src("shared/memeStructure.ts");
  assert.match(ms, /DEFAULT_DEX_FEE_PCT = CRYPTO_RULES\.cost\.dexFeePct/);
  assert.match(st, /honeypotMinBuys1h && sells1h === 0/);
  // Hard kill is PASS, never WATCH; the 55 floor is the retrace watch above the cap ceiling.
  assert.match(eng, /CRYPTO_RULES\.mcapCeiling\.watchMinScore \? "WATCH" : "PASS"/);
  assert.doesNotMatch(src("shared/cryptoRules.ts"), /minScoreWithKill/);
  // Served feed re-applies the desk gate at read time.
  assert.match(eng, /c\.verdict === "ENTER" && risk\.state !== "on"/);
});
