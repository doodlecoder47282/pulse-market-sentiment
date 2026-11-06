// News tab AI brief: descriptive schema, rendered as markdown (never raw JSON), no probabilities or trades.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitizeBrief, renderBriefMarkdown } from "../../shared/alphaBrief.ts";

test("brief: model JSON becomes markdown; old probability/trade fields are dropped", () => {
  const raw = {
    summary: "Rates news leads; equities shrug.",
    drivers: ["CPI in line", "", 42],
    levelsToWatch: [{ level: "SPX call wall 6,850", why: "largest positive gamma strike" }, { why: "no level" }],
    dataGaps: ["positioning stale"],
    // old schema the desk no longer asks for:
    verdict: "STRONG_BULL", confidence: 88, scenarios: { bull: { probability: 60 } }, trades: [{ structure: "long calls" }],
  };
  const b = sanitizeBrief(raw)!;
  assert.deepEqual(Object.keys(b).sort(), ["counterpoints", "dataGaps", "drivers", "levelsToWatch", "positioning", "summary", "tapeCheck", "whatWouldChange"]);
  assert.deepEqual(b.drivers, ["CPI in line"]);
  assert.equal(b.levelsToWatch!.length, 1);
  const md = renderBriefMarkdown(b);
  assert.match(md, /^Rates news leads; equities shrug\./);
  assert.match(md, /\*\*Levels to watch\*\*\n\n- SPX call wall 6,850: largest positive gamma strike/);
  assert.match(md, /\*\*Data gaps\*\*\n\n- positioning stale/);
  assert.doesNotMatch(md, /[{}"]/, "no JSON in the card");
  assert.doesNotMatch(md, /STRONG_BULL|88|probability|long calls/);
  assert.equal(sanitizeBrief(null), null);
  assert.equal(sanitizeBrief({ verdict: "MIXED", confidence: 30 }), null, "an old-schema-only answer is not a brief");
});

test("brief route and prompt: descriptive, no probabilities or trades asked for; brief is never the raw model text", () => {
  const r = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  const i = r.indexOf("const ALPHA_FUSION_SYSTEM = `");
  const prompt = r.slice(i, r.indexOf("`;", i));
  assert.doesNotMatch(prompt, /"probability"|"confidence"|"trades"|sizingKelly|probability-weighted|Use the analog returns as base rates/);
  assert.match(prompt, /Do not state probabilities/);
  assert.match(prompt, /Do not propose trades/);
  assert.match(r, /brief: descriptive \? renderBriefMarkdown\(descriptive\) : deterministic,/);
  assert.doesNotMatch(r, /brief: rawText,/);
});

test("email: renders the descriptive brief sections", async () => {
  const { composeAlphaEmail } = await import("../../server/alphaEmailComposer.ts");
  const { body } = composeAlphaEmail({ structured: { summary: "Quiet tape.", drivers: ["Fed speakers"], dataGaps: ["no positioning"] } as any, fusion: null, provider: "claude" });
  assert.match(body, /Quiet tape\./);
  assert.match(body, /drivers:\n  - Fed speakers/);
  assert.match(body, /data gaps:\n  - no positioning/);
});
