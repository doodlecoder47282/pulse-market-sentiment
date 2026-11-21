import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WHALE_WORDS, INDEX_FEE_NOTE, gateSentence, isIndexFeeReason } from "../../shared/whaleWords";

test("the gate line reads as a sentence", () => {
  assert.equal(gateSentence({ premiumFloor: 2_500_000, volOiRatio: 15, minDte: 1, maxDte: 3, requiredTag: "AT_ASK" }),
    "A contract is listed here only when all of these hold: at least $2.5 million paid for it today, today's volume at least 15 times the contracts that were already open, 1 to 3 days to expiry, and trades printed at the seller's asking price (the buyer paid up).");
  assert.match(gateSentence({ premiumFloor: 500_000, volOiRatio: 5, minDte: 0, maxDte: 0, requiredTag: "SWEEP" }), /at least \$500,000 paid .* 0 days to expiry, and trades tagged SWEEP\.$/);
  assert.match(gateSentence({ premiumFloor: 1e6, volOiRatio: 5, minDte: 1, maxDte: 1, requiredTag: "AT_BID" }), /1 day to expiry/);
});

test("every label a new reader meets on the panel is explained, and the fee note's wording matches the server's reason", () => {
  const terms = WHALE_WORDS.map((w) => w.term).join(" | ");
  for (const t of ["whale", "call / put", "premium", "vol/OI", "NEW STRIKE", "CONFLUX", "UOA", "tracking", "mid", "peak", "volume since flagged", "WIN%", "burn"]) assert.ok(terms.includes(t), t);
  assert.ok(WHALE_WORDS.every((w) => w.meaning.length > 20 && /[.)]$/.test(w.meaning)));
  const thrown = /"(index option: exchange fees not configured[^"]*)"/.exec(readFileSync("server/feeConfig.ts", "utf8"));
  assert.ok(thrown && isIndexFeeReason(thrown[1]), "the server's reason is the one the panel shortens");
  assert.equal(isIndexFeeReason("bid quote missing"), false);
  assert.match(INDEX_FEE_NOTE, /is not computed for these/);
});

test("the words describe; they do not say what to do", () => {
  const all = [...WHALE_WORDS.map((w) => w.meaning), INDEX_FEE_NOTE, gateSentence({ premiumFloor: 2.5e6, volOiRatio: 15, minDte: 1, maxDte: 3, requiredTag: "AT_ASK" })].join(" ");
  assert.doesNotMatch(all, /\b(you should|should buy|should sell|follow (it|them)|smart money|institutions? (are|is) buying|expect(ed)? to (rise|fall)|will (rise|fall|go))\b/i);
  assert.match(all, /not a known person or fund/);
  assert.match(all, /they are not a read of who traded or why/);
});

test("wiring: the fee note is said once per group, the row keeps a short form, and the glossary is on the panel", () => {
  const ui = readFileSync("client/src/components/WhaleFlowPanel.tsx", "utf8");
  assert.match(ui, /positions\.some\(\(p\) => isIndexFeeReason\(p\.score\?\.reason\)\)/);
  assert.match(ui, /after costs: not computed \(index fee not set\)/);
  assert.match(ui, /data-testid="whale-words"/);
  assert.match(ui, /gateSentence\(cfg\)/);
  assert.doesNotMatch(ui, />volSE /);
});
