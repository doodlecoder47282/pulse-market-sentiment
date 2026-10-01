import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildStockTradeBrief } from "../server/tradeBrief";
import { TRADE_BRIEF_INSTRUMENTS, type TradeBrief } from "../shared/tradeBrief";
import { AiBriefRequestSchema, validateAiSelection } from "../shared/tradeBriefAi";
import { buildAiCatalog, createTradeBriefAiService } from "../server/tradeBriefAi";

const now = Date.parse("2026-10-01T15:00:00Z");
const stock = TRADE_BRIEF_INSTRUMENTS.find(row => row.symbol === "INTC")!;
const ok = (value: unknown) => ({ state: "ok" as const, value });
function fixture() {
  return buildStockTradeBrief(stock, "swing", {
    quote: ok({ INTC: { symbol: "INTC", assetMainType: "EQUITY", realtime: true, quote: { lastPrice: 25, tradeTime: now - 1000, quoteTime: now - 500, totalVolume: 1500 } } }),
    history: ok({ symbol: "INTC", candles: [] }), macro: ok([]),
  }, now);
}
const select = (catalog: ReturnType<typeof buildAiCatalog>) => ({
  lead_claim_id: catalog.claims[0].id, supporting_claim_ids: [],
  caution_ids: [catalog.cautions[0].id], check_ids: [catalog.checks[0].id],
});

test("curation accepts only known unique IDs, no arbitrary prose/numbers/targets", () => {
  const catalog = buildAiCatalog(fixture());
  assert.deepEqual(validateAiSelection(select(catalog), catalog), select(catalog));
  for (const raw of [
    { ...select(catalog), price: 1000 }, { ...select(catalog), lead_claim_id: "invented" },
    { ...select(catalog), supporting_claim_ids: [catalog.claims[0].id] },
    { ...select(catalog), caution_ids: [] }, { ...select(catalog), check_ids: ["claim-0"] },
  ]) assert.throws(() => validateAiSelection(raw, catalog));
  assert.equal(AiBriefRequestSchema.safeParse({ snapshot_id: "a", evidence: [] }).success, false);
  assert.equal(AiBriefRequestSchema.safeParse({ snapshot_id: "a", model: "expensive" }).success, false);
});

test("AI renders immutable server text, preserves verdict and deduplicates requests", async () => {
  const brief = fixture();
  assert.ok(brief.explanation.detail.includes("Optional AI curation"));
  assert.ok(!brief.explanation.detail.includes("AI is not enabled"));
  let calls = 0;
  const service = createTradeBriefAiService(id => id === brief.snapshot_id ? brief : null, async catalog => {
    calls++; await new Promise(resolve => setTimeout(resolve, 10)); return select(catalog);
  }, () => now);
  const [a, b] = await Promise.all([service.analyze(brief.snapshot_id), service.analyze(brief.snapshot_id)]);
  assert.equal(calls, 1); assert.deepEqual(a, b);
  assert.equal(a?.status, "curated");
  assert.equal(a?.lead?.text, buildAiCatalog(brief).claims[0].text);
  assert.equal(a?.verdict, brief.verdict);
  assert.equal(await service.analyze("foreign-snapshot"), null);
});

test("invalid output and provider failure fall back once without spending on retries", async () => {
  for (const curator of [
    async () => ({ lead_claim_id: "go-buy", supporting_claim_ids: [], caution_ids: [], check_ids: [] }),
    async () => { throw new Error("provider unavailable"); },
  ]) {
    let calls = 0;
    const brief = fixture();
    const service = createTradeBriefAiService(() => brief, async catalog => { calls++; return curator(); }, () => now);
    const result = await service.analyze(brief.snapshot_id);
    assert.equal(result?.status, "fallback"); assert.equal(result?.lead, null);
    await service.analyze(brief.snapshot_id); assert.equal(calls, 1);
  }
});

test("stale evidence is not selectable; unknown references and empty evidence cause safe fallback", async () => {
  const brief = fixture();
  brief.evidence.forEach(e => { e.status = "stale"; });
  assert.throws(() => buildAiCatalog(brief));
  let calls = 0;
  const service = createTradeBriefAiService(() => brief, async () => { calls++; return {}; }, () => now);
  assert.equal((await service.analyze(brief.snapshot_id))?.status, "fallback");
  assert.equal(calls, 0);
});

test("expiry during model call withholds output; expired snapshot never calls model", async () => {
  const brief = fixture();
  let time = now, calls = 0;
  const service = createTradeBriefAiService(() => brief, async catalog => {
    calls++; time = Date.parse(brief.expires_at) + 1; return select(catalog);
  }, () => time);
  const result = await service.analyze(brief.snapshot_id);
  assert.equal(result?.status, "fallback");
  assert.equal(await service.analyze(brief.snapshot_id), null);
  assert.equal(calls, 1);
});

test("new AI path is isolated, authenticated, bounded and has no automatic SDK retries", () => {
  const worker = readFileSync(new URL("../server/briefAiWorker.ts", import.meta.url), "utf8");
  assert.ok(worker.includes('maxRetries: 0'));
  assert.ok(worker.includes("hour >= 6 || day >= 30"));
  assert.ok(worker.includes("timingSafeEqual"));
  assert.ok(worker.indexOf("INSERT INTO attempts") < worker.indexOf("client.messages.create"));
  assert.ok(worker.includes("max_tokens: 350"));
  assert.ok(worker.includes('mode: 0o600'));
  const parent = readFileSync(new URL("../server/tradeBriefAi.ts", import.meta.url), "utf8");
  assert.ok(!parent.includes('from "@anthropic-ai/sdk"'));
  assert.ok(!parent.includes("ANTHROPIC_API_KEY"));
});
