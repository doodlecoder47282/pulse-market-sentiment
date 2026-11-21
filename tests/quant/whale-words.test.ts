import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { whaleWords, directionSentence, INDEX_FEE_NOTE, INDEX_FEE_SHORT, gateSentence, isIndexFeeReason } from "../../shared/whaleWords";

const src = (p: string) => readFileSync(p, "utf8");
const GATE = { premiumFloor: 2_500_000, volOiRatio: 15, minDte: 1, maxDte: 3, requiredTag: "AT_ASK", deltaMin: 0.2, deltaMax: 0.8 };

test("the gate line reads as a sentence, with every condition the gate applies", () => {
  const s = gateSentence(GATE);
  assert.match(s, /^A contract is listed here only when all of these hold: an estimated \$2\.5 million or more traded in it today; /);
  assert.match(s, /today's volume at least 15 times the contracts already open \(or none were open before today\); 1 to 3 calendar days to expiry; /);
  assert.match(s, /a delta between 0\.20 and 0\.80 in size when Schwab reports one; and the trading seen today was mostly on the ask side \(an estimate: /);
  // No side condition: no side clause, and no made-up tag.
  const any = gateSentence({ ...GATE, requiredTag: "ANY" });
  assert.doesNotMatch(any, /ask|tagged/);
  assert.match(any, /; and a delta between 0\.20 and 0\.80 in size when Schwab reports one\.$/);
  assert.match(gateSentence({ ...GATE, requiredTag: "ABOVE_ASK" }), /and the last trade was above the asking price\.$/);
  assert.match(gateSentence({ premiumFloor: 500_000, volOiRatio: 5, minDte: 0, maxDte: 0, requiredTag: "ANY" }), /\$500,000 or more .*; and 0 calendar days to expiry\.$/);
});

test("the gate's settings are the ones the server can hold, and the server sends the delta bounds", () => {
  assert.match(src("server/flowConfig.ts"), /deltaMin: parseNum\(process\.env\.FLOW_DELTA_MIN, 0\.20\)/);
  const eng = src("server/flowAlertEngine.ts");
  assert.match(eng, /deltaMin: cfg\.deltaMin,\s+deltaMax: cfg\.deltaMax,\s+requiredTag: cfg\.requiredTag,/);
});

test("the direction label is described as the gate makes it", () => {
  assert.match(directionSentence("AT_ASK"), /a call row shows BULLISH and a put row BEARISH: the label names the contract type, not who traded or why\./);
  assert.match(directionSentence("ANY"), /follows where the last trade printed against the quote/);
  assert.equal(whaleWords("ANY").find((w) => w.term === "call / put")!.meaning, directionSentence("ANY"));
});

test("every label a new reader meets is explained, and the claims the first draft got wrong stay corrected", () => {
  const words = whaleWords();
  const by = (t: string) => words.find((w) => w.term.startsWith(t))!.meaning;
  for (const t of ["whale", "call / put", "premium", "vol/OI", "NEW STRIKE", "CONFLUX", "UOA", "tracking", "entry / mark / mid", "peak", "volume since flagged", "W / L", "burn"]) assert.ok(by(t), t);
  assert.match(by("premium"), /an estimate of today's dollars traded/);
  assert.match(by("vol/OI"), /does not show whether trades opened or closed positions/);
  assert.match(by("UOA"), /scans of quotes, not individual trades/);
  assert.match(by("CONFLUX"), /in both the whale list and the UOA cluster list/);
  assert.match(by("tracking"), /nobody sold it/);
  assert.match(by("volume since flagged"), /on the day it was flagged only/);
  assert.match(by("W / L"), /^on the Whale row: .* Other rows are mid to mid without fees and say so\.$/);
  assert.match(by("burn"), /best bid while tracked .* Other rows use the mid\.$/);
  assert.ok(words.every((w) => w.meaning.length > 20 && /[.)]$/.test(w.meaning)));
});

test("the words describe; they do not say what to do or who traded", () => {
  const all = [...whaleWords("AT_ASK"), ...whaleWords("ANY")].map((w) => w.meaning).concat(INDEX_FEE_NOTE, gateSentence(GATE)).join(" ");
  assert.doesNotMatch(all, /\b(you should|should buy|should sell|follow (it|them)|smart money|institutions? (are|is) buying|expect(ed)? to (rise|fall)|will (rise|fall|go))\b/i);
  assert.doesNotMatch(all, /\b(buyers?|sellers?) (paid|accepted|is|are|was|were)\b/i, "no claim about who traded");
  assert.doesNotMatch(all, /most of today's trading is new/);
  assert.match(all, /not a known person or fund/);
});

test("the fee note matches the server's reason and what the server says about the fee", () => {
  const cfg = src("server/feeConfig.ts");
  const thrown = /"(index option: exchange fees not configured[^"]*)"/.exec(cfg);
  assert.ok(thrown && isIndexFeeReason(thrown[1]));
  assert.equal(isIndexFeeReason("bid quote missing"), false);
  assert.match(INDEX_FEE_NOTE, /per contract per side for index options \(Schwab adds exchange fees for these\) is not set on this server/);
  assert.doesNotMatch(INDEX_FEE_NOTE, /differs by broker/);
});

test("wiring: the fee note once per tracked group, the short form on open and closed rows, the glossary on the panel", () => {
  const ui = src("client/src/components/WhaleFlowPanel.tsx");
  assert.match(ui, /positions\.some\(\(p\) => isIndexFeeReason\(p\.score\?\.reason\)\)/);
  assert.equal((ui.match(/isIndexFeeReason\(pos\.score\?\.reason\) \? INDEX_FEE_SHORT/g) ?? []).length, 2, "tracking rows and closed rows");
  assert.equal(INDEX_FEE_SHORT, "after costs: not computed (index fee not set)");
  assert.match(ui, /data-testid="whale-words"/);
  assert.match(ui, /whaleWords\(cfg\?\.requiredTag\)/);
  assert.match(ui, /<summary className="flex min-h-\[44px\]/, "a full tap target on phones");
  assert.doesNotMatch(ui, />volSE /);
});
