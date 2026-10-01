import { z } from "zod";

/** This is a deliberately finite US-listed research universe, not a security master. */
export const TRADE_BRIEF_VERSION = "stock-brief-2026-10-01.2";
export const TRADE_BRIEF_CATEGORIES = [
  "quote", "levels", "news", "options", "volume", "earnings", "macro", "seasonality",
] as const;
export type TradeBriefCategory = typeof TRADE_BRIEF_CATEGORIES[number];
export const HorizonSchema = z.enum(["swing", "intraday"]);
export type TradeBriefHorizon = z.infer<typeof HorizonSchema>;
export const CoverageSchema = z.enum([
  "available", "partial", "delayed", "stale", "missing", "unavailable", "unsupported", "not_applicable",
]);
export type CoverageStatus = z.infer<typeof CoverageSchema>;
export const InstrumentSchema = z.object({
  id: z.string(), symbol: z.string(), name: z.string(),
  asset_class: z.enum(["STOCK", "ETF"]), currency: z.literal("USD"),
  market: z.literal("US listed"),
}).strict();
export type TradeBriefInstrument = z.infer<typeof InstrumentSchema>;

const stocks = [
  ["AAPL", "Apple"], ["MSFT", "Microsoft"], ["NVDA", "NVIDIA"],
  ["AMZN", "Amazon"], ["GOOGL", "Alphabet — Class A"], ["GOOG", "Alphabet — Class C"],
  ["META", "Meta Platforms"], ["TSLA", "Tesla"], ["AMD", "Advanced Micro Devices"],
  ["AVGO", "Broadcom"], ["INTC", "Intel Corporation"], ["PLTR", "Palantir Technologies"], ["COIN", "Coinbase"],
  ["MSTR", "Strategy (MicroStrategy)"], ["NFLX", "Netflix"], ["JPM", "JPMorgan Chase"],
  ["BAC", "Bank of America"], ["F", "Ford Motor"], ["XOM", "Exxon Mobil"],
] as const;
const etfs = [
  ["SPY", "SPDR S&P 500 ETF"], ["QQQ", "Invesco QQQ ETF"],
  ["IWM", "iShares Russell 2000 ETF"], ["DIA", "SPDR Dow Jones Industrial Average ETF"],
  ["GLD", "SPDR Gold Shares"], ["SLV", "iShares Silver Trust"],
  ["TLT", "iShares 20+ Year Treasury Bond ETF"], ["HYG", "iShares High Yield Corporate Bond ETF"],
  ["UUP", "Invesco US Dollar Index Bullish Fund"], ["RSP", "Invesco S&P 500 Equal Weight ETF"],
] as const;
export const TRADE_BRIEF_INSTRUMENTS: readonly TradeBriefInstrument[] = Object.freeze([
  ...stocks.map(([symbol, name]) => Object.freeze({
    id: `US:STOCK:${symbol}`, symbol, name, asset_class: "STOCK" as const,
    currency: "USD" as const, market: "US listed" as const,
  })),
  ...etfs.map(([symbol, name]) => Object.freeze({
    id: `US:ETF:${symbol}`, symbol, name, asset_class: "ETF" as const,
    currency: "USD" as const, market: "US listed" as const,
  })),
]);

export const SearchRequestSchema = z.object({ q: z.string().trim().min(1).max(64) }).strict();
export const BriefRequestSchema = z.object({
  instrument_id: z.string().max(40),
  horizon: HorizonSchema.default("swing"),
}).strict();
export const SearchResponseSchema = z.object({
  instruments: z.array(InstrumentSchema).max(8), total: z.number().int().nonnegative(),
  scope: z.string(), requires_selection: z.literal(true),
}).strict();

export function searchTradeBriefInstruments(query: string): z.infer<typeof SearchResponseSchema> {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/);
  const matches = q ? TRADE_BRIEF_INSTRUMENTS.filter(i =>
    words.every(w => `${i.symbol} ${i.name}`.toLowerCase().includes(w)),
  ).sort((a, b) => Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q)
    || a.symbol.localeCompare(b.symbol)) : [];
  return {
    instruments: matches.slice(0, 8), total: matches.length,
    scope: "Curated US stock/ETF universe only. Select the exact listing; unlisted matches are unsupported, not invalid securities.",
    requires_selection: true,
  };
}

export const SourceStatusSchema = z.object({
  category: z.enum(TRADE_BRIEF_CATEGORIES), applicability: z.enum(["applicable", "not_applicable"]),
  status: CoverageSchema, contributed: z.boolean(), source: z.string(), reason: z.string(),
  observed_at: z.string().nullable(), checked_at: z.string(), max_age_seconds: z.number().nullable(),
  evidence_ids: z.array(z.string()), dependencies: z.array(z.string()),
}).strict();
export type TradeBriefSourceStatus = z.infer<typeof SourceStatusSchema>;
export const EvidenceSchema = z.object({
  id: z.string(), category: z.enum(TRADE_BRIEF_CATEGORIES), label: z.string(),
  value: z.number().finite(), unit: z.string(), observed_at: z.string(),
  time_precision: z.enum(["instant", "date", "period"]),
  status: CoverageSchema, source: z.string(), url: z.string().url(),
  formula_id: z.string().optional(), evidence_ids: z.array(z.string()).optional(),
}).strict();
export type TradeBriefEvidence = z.infer<typeof EvidenceSchema>;
export const ContextItemSchema = z.object({
  id: z.string(), category: z.enum(TRADE_BRIEF_CATEGORIES), text: z.string().max(1600),
  source: z.string(), url: z.string().url(), observed_at: z.string(),
  time_precision: z.enum(["instant", "date", "period"]), status: CoverageSchema,
  evidence_ids: z.array(z.string()),
}).strict();
export type TradeBriefContextItem = z.infer<typeof ContextItemSchema>;
export const LevelSchema = z.object({
  kind: z.enum(["support", "pivot", "resistance"]), label: z.string(),
  value: z.number().finite().positive(), unit: z.literal("USD/share"),
  formula_id: z.string(), evidence_ids: z.array(z.string()).min(1),
  period: z.string(), purpose: z.literal("structure_reference_only"),
}).strict();
export type TradeBriefLevel = z.infer<typeof LevelSchema>;
export const TradeBriefSchema = z.object({
  brief_id: z.string(), snapshot_id: z.string(), instrument_id: z.string(),
  instrument: InstrumentSchema, horizon: HorizonSchema, mode: z.literal("research_only"),
  created_at: z.string(), expires_at: z.string(),
  observed_at_range: z.object({ oldest: z.string().nullable(), newest: z.string().nullable() }),
  session: z.object({ label: z.string(), calendar_verified: z.literal(false) }),
  coverage: z.enum(["partial", "insufficient"]), source_statuses: z.array(SourceStatusSchema).length(8),
  coverage_gaps: z.array(z.string()),
  verdict: z.enum(["WATCH", "INSUFFICIENT DATA"]), thesis: z.string(), counterevidence: z.array(z.string()),
  prerequisites: z.array(z.string()),
  quote: z.object({
    value: z.number().positive().finite(), unit: z.literal("USD/share"),
    observed_at: z.string(), evidence_id: z.string(), source: z.literal("Schwab"),
  }).nullable(),
  levels: z.array(LevelSchema),
  risk: z.object({
    basis: z.literal("withheld"), planned_loss: z.null(), scenario_reward_risk: z.null(),
    assumptions: z.array(z.string()), limitations: z.array(z.string()),
  }),
  trigger: z.string(), events: z.array(z.object({ text: z.string(), evidence_ids: z.array(z.string()) })),
  management_rules: z.array(z.string()), invalidation_rules: z.array(z.string()),
  claims: z.array(z.object({ text: z.string(), evidence_ids: z.array(z.string()) })),
  evidence: z.array(EvidenceSchema), methodology: z.array(z.string()),
  context_items: z.array(ContextItemSchema).max(30).optional(),
  explanation: z.object({ status: z.literal("deterministic"), detail: z.string() }),
  model_version: z.literal("none"), calculation_version: z.string(),
}).strict().superRefine((brief, ctx) => {
  const ids = [...brief.evidence, ...(brief.context_items ?? [])].map(e => e.id);
  const known = new Set(ids);
  if (known.size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate evidence IDs" });
  if (new Set(brief.source_statuses.map(s => s.category)).size !== TRADE_BRIEF_CATEGORIES.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate coverage categories" });
  }
  const references = [
    ...brief.levels, ...brief.source_statuses, ...brief.claims, ...brief.events,
    ...brief.evidence, ...(brief.context_items ?? []),
  ];
  for (const row of references) {
    if (row.evidence_ids?.some(id => !known.has(id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unknown evidence reference" });
    }
  }
  if (brief.quote && !known.has(brief.quote.evidence_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unknown quote evidence" });
  }
  if (brief.instrument_id !== brief.instrument.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Instrument identity mismatch" });
  }
});
export type TradeBrief = z.infer<typeof TradeBriefSchema>;

export function tradeBriefExpired(brief: Pick<TradeBrief, "expires_at">, now = Date.now()): boolean {
  return !Number.isFinite(Date.parse(brief.expires_at)) || now >= Date.parse(brief.expires_at);
}
