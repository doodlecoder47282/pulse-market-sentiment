import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_POLICY_VERSION, EvidenceEnvelopeSchema, SOURCE_CONTRACTS, ResearchIdentitySchema,
  citationAllowed, getSourceContract, reviewEvidence, type EvidenceEnvelope, type ResearchIdentity,
} from "../shared/evidencePolicy";
import { tradeBriefEnvelopes, reviewTradeBriefEvidence } from "../shared/tradeBriefEvidence";
import { TRADE_BRIEF_INSTRUMENTS } from "../shared/tradeBrief";
import { buildStockTradeBrief } from "../server/tradeBrief";
import { buildAiCatalog, createTradeBriefAiService } from "../server/tradeBriefAi";

const now = Date.parse("2026-10-01T15:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
const identity: ResearchIdentity = { kind: "listed", id: "US:STOCK:INTC", symbol: "INTC", asset_class: "STOCK", currency: "USD" };
function row(patch: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope {
  return {
    schema_version: EVIDENCE_POLICY_VERSION, evidence_id: "quote", research_identity: identity, category: "quote",
    source_id: "schwab.quote", upstream_lineage_id: "schwab.marketdata", datum: 0, unit: "USD/share",
    observed_at: iso(now - 1000), time_precision: "instant", source_time_role: "market_observation",
    captured_at: iso(now), received_at: null, first_seen_at: null, known_at: null, expires_at: iso(now + 45000),
    status: "available", citation_url: "https://developer.schwab.com/products/trader-api--individual",
    formula_id: null, dependency_ids: [], adjustment_basis: "unverified", correction_of: null, ...patch,
  };
}
const review = (rows: unknown[]) => reviewEvidence(rows, identity, now);
const reasons = (e: EvidenceEnvelope) => review([e]).excluded.flatMap(r => r.reasons);
function brief() {
  const stock = TRADE_BRIEF_INSTRUMENTS.find(i => i.symbol === "INTC")!;
  const ok = (value: unknown) => ({ state: "ok" as const, value });
  return buildStockTradeBrief(stock, "swing", {
    quote: ok({ INTC: { symbol: "INTC", assetMainType: "EQUITY", realtime: true,
      quote: { lastPrice: 25, tradeTime: now - 1000, quoteTime: now - 1000, totalVolume: 0 } } }),
    history: ok({ symbol: "INTC", candles: [] }), macro: ok([]),
  }, now);
}

test("source inventory distinguishes contracts, inventory, disabled access and shared lineage", () => {
  assert.equal(SOURCE_CONTRACTS.length, new Set(SOURCE_CONTRACTS.map(s => s.id)).size);
  assert.ok(SOURCE_CONTRACTS.every(s => s.rights === "unverified" && s.publicUse === "blocked"));
  assert.equal(getSourceContract("x")?.integration, "disabled");
  assert.equal(getSourceContract("pumpfun")?.integration, "disabled");
  assert.equal(getSourceContract("bluesky")?.integration, "inventory_only");
  assert.equal(getSourceContract("solana.publicnode")?.lineage, getSourceContract("solana.mainnet")?.lineage);
  assert.equal(getSourceContract("schwab.quote")?.lineage, getSourceContract("schwab.history")?.lineage);
  assert.ok(!SOURCE_CONTRACTS.some(s => s.id === "yahoo.prices"));
  assert.ok(Object.isFrozen(SOURCE_CONTRACTS));
  assert.ok(Object.isFrozen(getSourceContract("schwab.quote")?.units));
});

test("strict identity prevents listing, chain, mint and pool substitutions", () => {
  assert.equal(ResearchIdentitySchema.safeParse({ ...identity, symbol: "AAPL" }).success, false);
  const crypto = { kind: "crypto", id: "solana:mint:pool", chain: "solana",
    contract_or_mint: "mint", pool_id: "pool", quote_currency: "USD" };
  assert.ok(ResearchIdentitySchema.safeParse(crypto).success);
  assert.equal(ResearchIdentitySchema.safeParse({ ...crypto, pool_id: "other" }).success, false);
  assert.ok(reasons(row({ research_identity: { ...identity, id: "US:STOCK:AAPL", symbol: "AAPL" } })).includes("identity_mismatch"));
});

test("zero is preserved; null, NaN and unknown fields never become data", () => {
  assert.equal(EvidenceEnvelopeSchema.parse(row()).datum, 0);
  assert.deepEqual(review([row()]).eligible_ids, ["quote"]);
  for (const datum of [null, NaN, Infinity]) assert.equal(EvidenceEnvelopeSchema.safeParse({ ...row(), datum }).success, false);
  assert.equal(EvidenceEnvelopeSchema.safeParse({ ...row(), token: "not-allowed" }).success, false);
  assert.ok(review([{ ...row(), datum: null }]).excluded.length);
});

test("unregistered, unintegrated, disabled, disallowed unit and wrong lineage fail closed", () => {
  assert.ok(reasons(row({ source_id: "invented" })).includes("unregistered_source"));
  for (const source_id of ["x", "bluesky", "pumpfun"]) assert.ok(reasons(row({ source_id })).includes("adapter_not_admitted"));
  assert.ok(reasons(row({ unit: "BTC" })).includes("unit_mismatch"));
  assert.ok(reasons(row({ upstream_lineage_id: "independent-feed" })).includes("lineage_mismatch"));
  assert.ok(reasons(row({ category: "news" })).includes("category_mismatch"));
});

test("rights remain unverified and public use receives no eligible evidence", () => {
  const result = reviewEvidence([row()], identity, now, "public_multiuser");
  assert.equal(result.scope, "public_multiuser");
  assert.equal(result.eligible_ids.length, 0);
  assert.ok(result.excluded[0].reasons.includes("rights_and_multiuser_release_unverified"));
});

test("stale, future, malformed precision and date rollover cannot be restamped current", () => {
  assert.ok(reasons(row({ observed_at: iso(now - 300000) })).includes("observation_too_old"));
  assert.ok(reasons(row({ observed_at: iso(now + 1) })).includes("future_timestamp"));
  assert.ok(reasons(row({ received_at: iso(now + 1) })).includes("future_timestamp"));
  assert.ok(reasons(row({ expires_at: iso(now) })).includes("expired"));
  assert.ok(reasons(row({ observed_at: "2026-10-01", time_precision: "instant" })).includes("invalid_observation_time"));
  assert.ok(reasons(row({ observed_at: "2026-10-01", time_precision: "date" })).includes("source_precision_mismatch"));
  assert.ok(reasons(row({ observed_at: "2026-02-30", time_precision: "period" })).includes("invalid_observation_time"));
  assert.ok(reasons(row({ status: "delayed" })).includes("status_not_eligible"));
});

test("historical dates stay date precision; unknown receipt and known-at remain null", () => {
  const b = brief(), envelope = tradeBriefEnvelopes(b).rows[0];
  assert.equal(envelope.received_at, null); assert.equal(envelope.known_at, null); assert.equal(envelope.first_seen_at, null);
  const historical = row({ source_id: "schwab.history", category: "levels", time_precision: "period",
    source_time_role: "historical_period", observed_at: "2026-09-15" });
  assert.equal(review([historical]).eligible_ids.length, 1);
  assert.equal(historical.observed_at, "2026-09-15");
});

test("citation allowlist rejects credentials, lookalike hosts, unsafe schemes and undocumented paths", () => {
  assert.ok(citationAllowed("news.marketwatch", "https://www.marketwatch.com/story/fixture"));
  for (const url of ["http://www.marketwatch.com/a", "https://marketwatch.com.evil.test/a",
    "https://user:pass@www.marketwatch.com/a", "https://www.marketwatch.com:5000/a",
    "https://www.marketwatch.com/a?api_key=secret", "javascript:alert(1)"]) assert.equal(citationAllowed("news.marketwatch", url), false);
  assert.equal(citationAllowed("schwab.quote", "https://developer.schwab.com/not-the-docs"), false);
  assert.equal(citationAllowed("fred.observations", "https://fred.stlouisfed.org/series/UNKNOWN"), false);
});

test("derived claims require formulas and recursively eligible dependencies; cycles and duplicate IDs rejected", () => {
  const calc = row({ evidence_id: "calc", source_id: "batcave.calculation", upstream_lineage_id: "dependencies-only",
    category: "levels", dependency_ids: ["quote"], formula_id: "test:formula", source_time_role: "derived_input" });
  assert.deepEqual(review([row(), calc]).eligible_ids, ["quote", "calc"]);
  assert.ok(reasons({ ...calc, formula_id: null }).includes("derived_lineage_missing"));
  const tainted = review([row({ status: "stale" }), calc]);
  assert.equal(tainted.eligible_ids.length, 0);
  assert.ok(tainted.excluded.find(e => e.id === "calc")?.reasons.includes("dependency_rejected"));
  assert.equal(review([calc]).eligible_ids.length, 0);
  assert.equal(review([{ ...calc, dependency_ids: ["calc"] }]).eligible_ids.length, 0);
  assert.equal(review([row(), row(), calc]).eligible_ids.length, 0);
  const b = { ...calc, evidence_id: "b", dependency_ids: ["calc"] };
  assert.equal(review([{ ...calc, dependency_ids: ["b"] }, b]).eligible_ids.length, 0);
  assert.throws(() => review(Array.from({ length: 513 }, () => row())));
});

test("AI recomputes policy, does not trust cached eligibility, and makes zero calls for rejected evidence", async () => {
  const b = brief();
  assert.ok(b.evidence_review?.eligible_ids.includes("quote-last"));
  b.evidence.find(e => e.id === "quote-last")!.source_id = "invented";
  assert.equal(reviewTradeBriefEvidence(b, now).eligible_ids.includes("quote-last"), false);
  assert.throws(() => buildAiCatalog(b, now));
  let calls = 0;
  const service = createTradeBriefAiService(() => b, async () => { calls++; return {}; }, () => now);
  assert.equal((await service.analyze(b.snapshot_id))?.status, "fallback");
  assert.equal(calls, 0);
});

test("legacy evidence without source IDs may display but cannot enter AI", () => {
  const b = brief();
  b.evidence.forEach(e => { delete e.source_id; });
  assert.throws(() => buildAiCatalog(b, now));
  assert.equal(reviewTradeBriefEvidence(b, now).eligible_ids.length, 0);
});
