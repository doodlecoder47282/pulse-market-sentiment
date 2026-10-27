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
  for (const re of [/c\.score >= 70 &&/, />= 1\.5 &&/, />= 0\.58\)/, /c\.score >= 55 \?/, /c\.score >= 50\)/, /liq \* 0\.005, 400/, /suggestedStopPct: -35,/, /= 72 \* 3600_000;/, /= 8_000;/, /= 5_000_000;/]) {
    assert.doesNotMatch(eng, re, `literal threshold still in cryptoEngine.ts: ${re}`);
  }
  assert.match(eng, /rules: \{ version: CRYPTO_RULES_VERSION, items: describeCryptoRules\(\) \}/);
  assert.match(eng, /rulesVersion: CRYPTO_RULES_VERSION,/);
  const st = src("server/cryptoStats.ts");
  assert.doesNotMatch(st, /entryLiq \* 0\.15\b/);
  assert.doesNotMatch(st, /entryMcap \* 0\.1\b/);
  assert.match(st, /CRYPTO_SAMPLE_READY_MIN_GRADED = CRYPTO_RULES\.grading\.minSample/);
  const vd = src("shared/cryptoVerdict.ts");
  assert.match(vd, /DESK_RISK_OFF_PCT = CRYPTO_RULES\.deskRisk\.offBelowPct/);
});
