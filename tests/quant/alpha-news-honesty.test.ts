// AI news verdict honesty: no invented "historical analog" statistics, no
// fixed constants passed off as measurements, scenario "prob" is a labelled
// qualitative weighting, and the prompt asks for description, not advice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeVerdict, deterministicVerdict, VERDICT_SYSTEM_PROMPT, type AlphaEvent } from "../../server/alphaNews";

const event = (over: Partial<AlphaEvent> = {}): AlphaEvent => ({
  id: "e1", ticker: "NVDA", tier: "TIER_1", category: "EARNINGS", title: "NVDA beats", source: "x", url: "https://example.com",
  published: 1_800_000_000, summary: "", initialBias: "BULL", alphaScore: 70, ...over,
});

test("a model-supplied analog is never kept, whatever numbers it carries", () => {
  const raw = {
    direction: "BULL", confidence: 70, expectedMovePct: 3, rrRatio: 2,
    bull: { thesis: "a", prob: 50, targetMovePct: 3 }, base: { thesis: "b", prob: 30, targetMovePct: 0 }, bear: { thesis: "c", prob: 20, targetMovePct: -2 },
    analog: { description: "Last 8 earnings pops", sampleSize: 8, avgMovePct: 4.2, hitRate: 75 },
  };
  const v = normalizeVerdict(event(), raw, "anthropic")!;
  assert.equal(v.analog, null);
  assert.equal(v.basis, "ai_write_up");
  assert.equal(normalizeVerdict(event(), { ...raw, analog: undefined }, "openai")!.analog, null);
  assert.equal(JSON.stringify(v).includes("hitRate"), false);
});

test("the no-model fallback is labelled as fixed category defaults and carries no analog", () => {
  const v = deterministicVerdict(event());
  assert.equal(v.basis, "category_default");
  assert.equal(v.provider, "deterministic");
  assert.equal(v.analog, null);
  assert.match(v.summary, /not a measurement/);
  assert.doesNotMatch(v.summary, /baseline read/);
});

test("the prompt no longer asks for invented statistics or advice-shaped output", () => {
  const p = VERDICT_SYSTEM_PROMPT;
  assert.doesNotMatch(p, /analog/i);
  assert.doesNotMatch(p, /plausible estimate/i);
  assert.doesNotMatch(p, /sampleSize|hitRate/);
  assert.doesNotMatch(p, /tradeable|positioning read|oversized|favorable R:R|senior quant/i);
  assert.match(p, /not measured probabilities/);
  assert.match(p, /do not cite historical statistics/i);
});

test("the overlay shows no analog block and labels weights, move and R:R as AI estimates", () => {
  const src = readFileSync(new URL("../../client/src/components/AlphaNewsOverlay.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Historical Analog|Hit Rate|verdict\.analog\./);
  assert.match(src, /AI weighting, not measured probabilities/);
  assert.match(src, /Move \(AI est\.\)/);
  assert.match(src, /R:R \(AI est\.\)/);
  assert.match(src, /category_default/);
  assert.doesNotMatch(src, />Edge</, "the catalyst kind is not labelled as an edge");
});
