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

test("provider and mode describe the text on the card: parseable-but-unusable JSON falls through to the next provider, then to deterministic", () => {
  const r = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  assert.match(r, /const d = sanitizeBrief\(p\.r\.value\.structured\);\s*if \(!d\) continue;/);
  assert.match(r, /let provider: "claude" \| "gpt" \| "sonar" \| "none" = "none";/);
  assert.doesNotMatch(r, /if \(claudeResult\.status === "fulfilled" && claudeResult\.value\.structured\)/);
  // The prompt input carries no trade section.
  assert.match(r, /\$\{briefForPrompt\(deterministic\)\}/);
});

test("email: a descriptive brief never prints a verdict or confidence under the model's name, never PENDING", async () => {
  const { composeAlphaEmail } = await import("../../server/alphaEmailComposer.ts");
  const withBaseline = composeAlphaEmail({ structured: { summary: "Quiet tape." } as any, fusion: { baseline: { verdict: "lean bull", confidence: 58, oneLiner: "base" }, levels: { spot: 680 } } as any, provider: "claude", mode: "with_search" } as any);
  assert.equal(withBaseline.subject, "Alpha Brief: descriptive read · SPY 680");
  assert.doesNotMatch(withBaseline.body, /confidence 58%/);
  assert.match(withBaseline.body, /EDGE LAB BASELINE \(HEURISTIC, NOT THE MODEL'S READ\)/);
  const bare = composeAlphaEmail({ structured: { summary: "Quiet tape." } as any, fusion: null, provider: "claude" } as any);
  assert.doesNotMatch(bare.subject + bare.body, /PENDING/);
  assert.doesNotMatch(bare.body, /─ VERDICT ─/);
});

test("brief helpers: numeric levels kept; trade section stripped from the prompt input; footer states the instruction, not a guarantee", async () => {
  const { sanitizeBrief, briefForPrompt, renderBriefMarkdown } = await import("../../shared/alphaBrief.ts");
  const b = sanitizeBrief({ summary: "x", levelsToWatch: [{ level: 6850, why: "call wall" }] });
  assert.deepEqual(b?.levelsToWatch, [{ level: "6850", why: "call wall" }]);
  const det = "## RANKED IMPACT\n\n- a\n\n## TRADE IMPLICATIONS\n\n- Consider SPY put spreads\n\n## WATCH LIST\n\n- b";
  const p = briefForPrompt(det);
  assert.doesNotMatch(p, /put spreads|TRADE IMPLICATIONS/);
  assert.match(p, /## RANKED IMPACT[\s\S]*## WATCH LIST/);
  assert.match(renderBriefMarkdown(b!), /The model was asked not to give probabilities/);
});
