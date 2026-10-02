import { z } from "zod";

/** Application policy, NOT provider availability, legal approval or an API quota claim. */
export const EVIDENCE_POLICY_VERSION = "evidence-policy-2026-10-01.1";
type SourceContract = {
  id: string; name: string; endpoint: string; lineage: string;
  categories: readonly string[]; units: readonly string[]; citationHosts: readonly string[];
  maxAgeSeconds: number | null; timeBasis: string; cadence: string; limitation: string;
  integration: "enforced_stock_brief" | "inventory_only" | "disabled";
  rights: "unverified"; publicUse: "blocked"; auth: "existing_oauth" | "public" | "local" | "none";
};
const equityUnits = ["USD/share", "shares", "shares/session", "percent", "ATR14 units",
  "ratio (not time-of-day normalized)"];
const schwabHost = ["developer.schwab.com"];
function source(id: string, name: string, endpoint: string, lineage: string,
  categories: string[], units: readonly string[], citationHosts: readonly string[],
  maxAgeSeconds: number | null, timeBasis: string, cadence: string, limitation: string,
  integration: SourceContract["integration"] = "enforced_stock_brief",
  auth: SourceContract["auth"] = "public"): SourceContract {
  return Object.freeze({ id, name, endpoint, lineage,
    categories: Object.freeze(categories), units: Object.freeze([...units]), citationHosts: Object.freeze([...citationHosts]),
    maxAgeSeconds, timeBasis, cadence, limitation, integration, auth,
    rights: "unverified" as const, publicUse: "blocked" as const });
}
export const SOURCE_CONTRACTS: readonly SourceContract[] = Object.freeze([
  source("schwab.quote", "Schwab quotes", "https://api.schwabapi.com/marketdata/v1/quotes", "schwab.marketdata",
    ["quote", "volume"], ["USD/share", "shares"], schwabHost, 300, "Provider trade/quote timestamp",
    "Existing bounded manual brief request", "Intraday tightens to 60s; explicit real-time entitlement required.", undefined, "existing_oauth"),
  source("schwab.history", "Schwab daily history", "https://api.schwabapi.com/marketdata/v1/pricehistory", "schwab.marketdata",
    ["levels", "volume"], equityUnits, schwabHost, 90 * 86400, "Completed session date / period end",
    "Reuse the existing three-month daily-history read", "Historical inputs, not live observations; calendar and adjustments unverified.", undefined, "existing_oauth"),
  source("schwab.options", "Schwab option samples", "https://api.schwabapi.com/marketdata/v1/chains", "schwab.marketdata",
    ["options"], ["contracts", "contracts traded", "USD/share underlying", "USD/share premium"], schwabHost, 60,
    "Provider underlying and contract quote times", "Existing manual request; no delayed fallback",
    "Partial sample, not directional flow, OI freshness, GEX or executable fills.", undefined, "existing_oauth"),
  source("fred.observations", "FRED observations", "https://api.stlouisfed.org/fred/series/observations", "fred.series",
    ["macro"], ["percent", "percentage points", "index"], ["fred.stlouisfed.org"], 7 * 86400,
    "Observation date; release time and vintage unknown", "Existing local cache only",
    "Daily context, not point-in-time release history. Upstream series may share a publisher."),
  source("nasdaq.earnings", "Nasdaq earnings calendar", "https://api.nasdaq.com/api/calendar/earnings", "nasdaq.calendar",
    ["earnings"], ["text"], ["api.nasdaq.com"], 1800, "Calendar row checked_at, NOT future event time",
    "Existing local cache only", "Real-row provenance required; not issuer-confirmed and revisions remain unknown."),
  source("news.marketwatch", "MarketWatch", "https://feeds.content.dj-n.com/public/rss/mw_topstories", "dowjones.marketwatch",
    ["news"], ["text"], ["marketwatch.com", "www.marketwatch.com"], 86400, "Verified publication time",
    "Existing cached feed; health must be checked within 15m", "Headline/context only; content and redistribution rights unverified."),
  source("news.reuters-google", "Reuters Business", "https://news.google.com/rss/search", "reuters.via-google-news",
    ["news"], ["text"], ["news.google.com", "reuters.com", "www.reuters.com"], 86400, "Verified feed publication time",
    "Existing cached Google News feed", "Proxy/index discovery is not a direct Reuters feed or independent corroboration."),
  source("news.cnbc", "CNBC Markets", "https://www.cnbc.com/id/100003114/device/rss/rss.html", "cnbc",
    ["news"], ["text"], ["cnbc.com", "www.cnbc.com"], 86400, "Verified publication time",
    "Existing cached feed; health must be checked within 15m", "Text attribution is not verified issuer materiality."),
  source("news.ft", "FT Markets", "https://www.ft.com/markets?format=rss", "financial-times",
    ["news"], ["text"], ["ft.com", "www.ft.com"], 86400, "Verified publication time",
    "Existing cached feed; health must be checked within 15m", "No full-text/paywall bypass or redistribution approval."),
  source("batcave.calculation", "Batcave deterministic calculations", "local:versioned-calculators", "dependencies-only",
    ["levels", "volume", "macro", "options"], [...equityUnits, "percentage points", "text"],
    [...schwabHost, "fred.stlouisfed.org"], null, "Input observation dates; no new observation",
    "In-process only", "Every dependency must pass. Not an independent source or validated edge.", undefined, "local"),
  ...[
    ["geckoterminal", "GeckoTerminal", "https://api.geckoterminal.com/api/v2", "geckoterminal", "Pool discovery/reserves; sampled, not a continuous tape."],
    ["dexscreener", "DEX Screener", "https://api.dexscreener.com", "dexscreener", "Receipt-only timing must not be called provider observation time."],
    ["solana.publicnode", "Solana RPC PublicNode", "https://solana-rpc.publicnode.com", "solana.ledger", "Read-only sampled accounts; exact mint and commitment required."],
    ["solana.mainnet", "Solana public RPC", "https://api.mainnet-beta.solana.com", "solana.ledger", "Same ledger as PublicNode, not independent corroboration."],
    ["rugcheck", "Rugcheck", "https://api.rugcheck.xyz", "rugcheck", "Cached risk flags are not a complete security audit."],
    ["bluesky", "Bluesky public search", "https://api.bsky.app", "bluesky.search", "Bounded attributed samples, not complete social activity."],
    ["coinbase", "Coinbase BTC/ETH spot", "https://api.exchange.coinbase.com/products", "coinbase.exchange", "Venue-specific observations, not a consolidated market."],
    ["deribit", "Deribit public ticker", "https://www.deribit.com/api/v2/public/ticker", "deribit", "Regional/provider access limits remain explicit."],
    ["defillama", "DefiLlama chain TVL", "https://api.llama.fi/v2/chains", "defillama", "Chain context, not token-specific investment flow."],
    ["coindesk", "CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/", "coindesk", "Headline context, not independently verified events."],
    ["theblock", "The Block", "https://www.theblock.co/rss.xml", "theblock", "Headline context, not independently verified events."],
    ["decrypt", "Decrypt", "https://decrypt.co/feed", "decrypt", "Headline context, not independently verified events."],
    ["yahoo-news", "Yahoo Finance news only", "https://finance.yahoo.com/news/rssindex", "yahoo.syndication", "News only. Yahoo equities prices remain excluded."],
    ["fed", "Federal Reserve releases", "https://www.federalreserve.gov/feeds/press_all.xml", "federal-reserve", "Release context; actual/consensus surprise not implemented."],
    ["bls", "BLS releases", "https://www.bls.gov/feed/bls_latest.rss", "bls", "Release context; release-vintage storage not implemented."],
  ].map(([id, name, url, lineage, limitation]) => source(id, name, url, lineage,
    ["crypto-context"], [], [], null, "Existing adapter semantics; shared envelope migration pending",
    "Existing cache/scheduler only; no new polling", limitation, "inventory_only")),
  source("pumpfun", "Pump.fun", "https://frontend-api-v3.pump.fun", "pumpfun", ["social"], [], [], null,
    "Unavailable when denied", "Existing cooldown; no bypass", "Access denial is a gap, never zero activity.", "disabled"),
  source("x", "X", "https://x.com", "x", ["social"], [], [], null,
    "No authorized source", "Disabled; do not reconnect automatically", "No source connected for this integration.", "disabled", "none"),
]);
export function getSourceContract(id: string) { return SOURCE_CONTRACTS.find(s => s.id === id); }
export function newsSourceId(name: string): string | undefined {
  return SOURCE_CONTRACTS.find(s => s.categories.includes("news") && s.name === name)?.id;
}
/** Citation validation only. This does NOT authorize network fetches or redirects. */
export function citationAllowed(sourceId: string, value: string): boolean {
  const contract = getSourceContract(sourceId);
  if (!contract) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
      || !contract.citationHosts.includes(url.hostname)
      || [...url.searchParams.keys()].some(k => /token|secret|password|api.?key|authorization/i.test(k))) return false;
    if (url.hostname === "developer.schwab.com") return url.pathname === "/products/trader-api--individual" && !url.search;
    if (url.hostname === "fred.stlouisfed.org") return /^\/series\/(DGS2|DGS10|BAMLH0A0HYM2|DTWEXBGS)$/.test(url.pathname) && !url.search;
    if (sourceId === "nasdaq.earnings") return url.pathname === "/api/calendar/earnings"
      && /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") ?? "")
      && [...url.searchParams.keys()].length === 1;
    return true;
  } catch { return false; }
}

export const ResearchIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("listed"), id: z.string().regex(/^US:(STOCK|ETF):[A-Z.]{1,12}$/),
    symbol: z.string().min(1), asset_class: z.enum(["STOCK", "ETF"]), currency: z.literal("USD") }).strict(),
  z.object({ kind: z.literal("crypto"), id: z.string().min(1), chain: z.string().min(1),
    contract_or_mint: z.string().min(1), pool_id: z.string().min(1).nullable(),
    quote_currency: z.string().min(1) }).strict(),
]).superRefine((identity, ctx) => {
  const expected = identity.kind === "listed" ? `US:${identity.asset_class}:${identity.symbol}`
    : `${identity.chain}:${identity.contract_or_mint}:${identity.pool_id ?? "asset"}`;
  if (identity.id !== expected) ctx.addIssue({ code: "custom", message: "Non-canonical identity" });
});
export type ResearchIdentity = z.infer<typeof ResearchIdentitySchema>;
const instant = z.string().datetime({ offset: true });
export const EvidenceEnvelopeSchema = z.object({
  schema_version: z.literal(EVIDENCE_POLICY_VERSION), evidence_id: z.string().min(1).max(120),
  research_identity: ResearchIdentitySchema, category: z.string().min(1),
  source_id: z.string().min(1), upstream_lineage_id: z.string().min(1),
  datum: z.union([z.number().finite(), z.string().min(1).max(1600)]), unit: z.string().min(1),
  observed_at: z.string().min(1), time_precision: z.enum(["instant", "date", "period"]),
  source_time_role: z.enum(["market_observation", "publication", "calendar_checked", "historical_period", "derived_input"]),
  captured_at: instant, received_at: instant.nullable(), first_seen_at: instant.nullable(), known_at: instant.nullable(),
  expires_at: instant, status: z.enum(["available", "partial", "delayed", "stale", "missing", "unavailable", "unsupported", "not_applicable"]),
  citation_url: z.string().url(), formula_id: z.string().min(1).nullable(),
  dependency_ids: z.array(z.string().min(1)).max(100), adjustment_basis: z.literal("unverified"),
  correction_of: z.string().nullable(),
}).strict();
export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;
export const EvidenceReviewSchema = z.object({
  version: z.literal(EVIDENCE_POLICY_VERSION), scope: z.enum(["restricted_owner_research", "public_multiuser"]),
  checked_at: instant, eligible_ids: z.array(z.string()), source_ids: z.array(z.string()),
  excluded: z.array(z.object({ id: z.string(), reasons: z.array(z.string()) }).strict()),
  limitations: z.array(z.string()),
}).strict();
export type EvidenceReview = z.infer<typeof EvidenceReviewSchema>;

/** Pure, bounded admission. No I/O, model, provider request or fake timestamp. */
export function reviewEvidence(rows: readonly unknown[], identity: ResearchIdentity, now: number,
  scope: "restricted_owner_research" | "public_multiuser" = "restricted_owner_research"): EvidenceReview {
  const records = new Map<string, EvidenceEnvelope>();
  const reasons = new Map<string, Set<string>>();
  const add = (id: string, why: string) => { if (!reasons.has(id)) reasons.set(id, new Set()); reasons.get(id)!.add(why); };
  const parsedIdentity = ResearchIdentitySchema.safeParse(identity);
  const identityKey = parsedIdentity.success ? JSON.stringify(parsedIdentity.data) : null;
  if (rows.length > 512) throw new Error("Evidence batch exceeds bounded admission limit");
  rows.forEach((raw, index) => {
    const parsed = EvidenceEnvelopeSchema.safeParse(raw);
    const id = parsed.success ? parsed.data.evidence_id
      : `invalid-row-${index}`;
    if (!parsed.success) { add(id, "invalid_contract"); return; }
    const e = parsed.data, c = getSourceContract(e.source_id);
    if (records.has(id)) add(id, "duplicate_id");
    else records.set(id, e);
    if (identityKey === null || JSON.stringify(e.research_identity) !== identityKey) add(id, "identity_mismatch");
    if (!c) { add(id, "unregistered_source"); return; }
    if (c.integration !== "enforced_stock_brief") add(id, "adapter_not_admitted");
    if (scope !== "restricted_owner_research") add(id, "rights_and_multiuser_release_unverified");
    if (e.upstream_lineage_id !== c.lineage) add(id, "lineage_mismatch");
    if (!c.categories.includes(e.category)) add(id, "category_mismatch");
    if (!c.units.includes(e.unit) || (typeof e.datum === "string") !== (e.unit === "text")) add(id, "unit_mismatch");
    if (!citationAllowed(e.source_id, e.citation_url)) add(id, "citation_not_allowed");
    if (e.status !== "available" && e.status !== "partial") add(id, "status_not_eligible");
    const precisionOK = e.source_id === "batcave.calculation"
      || (e.source_id === "schwab.history" ? e.time_precision !== "instant"
        : e.source_id === "fred.observations" ? e.time_precision === "date" : e.time_precision === "instant");
    if (!precisionOK) add(id, "source_precision_mismatch");
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(e.observed_at);
    const observed = Date.parse(dateOnly ? `${e.observed_at}T00:00:00Z` : e.observed_at);
    if (!Number.isFinite(observed) || (dateOnly && new Date(observed).toISOString().slice(0, 10) !== e.observed_at)
      || (e.time_precision === "instant" ? !instant.safeParse(e.observed_at).success : !dateOnly)) add(id, "invalid_observation_time");
    if (observed > now || Date.parse(e.captured_at) > now || [e.received_at, e.first_seen_at, e.known_at].some(t => t !== null && Date.parse(t) > now)) add(id, "future_timestamp");
    if (Date.parse(e.expires_at) <= now || Date.parse(e.expires_at) <= Date.parse(e.captured_at)) add(id, "expired");
    if (c.maxAgeSeconds !== null && now - observed >= c.maxAgeSeconds * 1000) add(id, "observation_too_old");
    if (e.source_id === "batcave.calculation" && (!e.formula_id || !e.dependency_ids.length)) add(id, "derived_lineage_missing");
    if (e.formula_id && !e.dependency_ids.length) add(id, "derived_lineage_missing");
    if (new Set(e.dependency_ids).size !== e.dependency_ids.length) add(id, "duplicate_dependency");
    const expectedRole = e.source_id === "batcave.calculation" ? "derived_input"
      : e.category === "news" ? "publication" : e.category === "earnings" ? "calendar_checked"
      : e.time_precision === "instant" ? "market_observation" : "historical_period";
    if (e.source_time_role !== expectedRole) add(id, "time_role_mismatch");
  });
  const done = new Set<string>(), visiting = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) { add(id, "dependency_cycle"); return false; }
    if (done.has(id)) return !reasons.has(id);
    const record = records.get(id);
    if (!record) return false;
    visiting.add(id);
    for (const dep of record.dependency_ids) if (!visit(dep)) add(id, "dependency_rejected");
    visiting.delete(id); done.add(id);
    return !reasons.has(id);
  }
  for (const id of records.keys()) visit(id);
  return EvidenceReviewSchema.parse({
    version: EVIDENCE_POLICY_VERSION, scope, checked_at: new Date(now).toISOString(),
    eligible_ids: [...records.keys()].filter(id => !reasons.has(id)),
    source_ids: [...new Set([...records.values()].map(e => e.source_id))].sort(),
    excluded: [...reasons].map(([id, why]) => ({ id, reasons: [...why] })),
    limitations: [
      "Eligibility is a data-contract check for restricted research, not verified accuracy, a trading probability or legal approval.",
      "Source rights, multi-user security, release vintages and persistent point-in-time history remain unverified.",
      "Captured time is processing time. Unknown receipt, first-seen and known-at times remain null.",
      "Crypto sources are inventoried only; their existing adapters have not migrated to this shared contract.",
    ],
  });
}
