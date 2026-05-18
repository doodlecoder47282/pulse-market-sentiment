// server/alphaNews.ts
//
// Alpha-only news indicator for the Chart tab. Filters the general news flow
// down to events that matter for one ticker, scores them by alpha tier, and
// generates an AI positioning verdict per event (verdict + bull/base/bear
// scenarios + historical analog).
//
// Alpha definition (widest setting per user):
//   Tier-1: earnings, guidance, M&A, FDA, Fed, downgrades/upgrades from top
//           desks, 8-K material events
//   Tier-2: unusual flow / dark-pool prints, analyst PT changes, insider Form 4
//   Sentiment shift: >2 sigma headline-cluster volume vs the trailing 20-day
//
// Architecture: thin module. Reuses buildNewsSnapshot() for the underlying
// headline flow + calendar, then bolts on ticker filtering, tiering, clustering
// and an LLM positioning call.

import { buildNewsSnapshot, type Headline, type CalendarEvent, type NewsTopic } from "./news";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ---- Types ----

export type AlphaTier = "TIER_1" | "TIER_2" | "SENTIMENT_SHIFT";

export type AlphaDirection = "BULL" | "BEAR" | "NEUTRAL";

export interface AlphaEvent {
  id: string;
  ticker: string;
  tier: AlphaTier;
  /** Bucket label: EARNINGS, GUIDANCE, M&A, FDA, FED, RATING, FLOW, INSIDER, SENTIMENT_CLUSTER, MATERIAL_8K */
  category: string;
  title: string;
  source: string;
  url: string;
  /** Epoch seconds */
  published: number;
  /** Short blurb */
  summary: string;
  /** Initial directional bias from keyword + tier scoring; LLM refines later. */
  initialBias: AlphaDirection;
  /** 0-100 — how much this headline stands out vs the day's flow. */
  alphaScore: number;
  /** Headline-cluster z-score (number of similar headlines published in last 6h vs 20d avg). */
  clusterZ?: number;
  /** Related headline IDs that cluster with this event (for the sigma shift detection). */
  clusterIds?: string[];
}

export interface AlphaScenario {
  thesis: string;
  prob: number;       // 0-100
  targetMovePct: number; // signed: +1.2 means +1.2%
}

export interface HistoricalAnalog {
  description: string; // human readable: "Last 8 NVDA earnings after-hours pops..."
  sampleSize: number;
  avgMovePct: number;
  hitRate: number;     // 0-100 — pct of times this direction won
}

export interface AlphaVerdict {
  eventId: string;
  ticker: string;
  direction: AlphaDirection;
  confidence: number;     // 0-100
  expectedMovePct: number; // signed
  rrRatio: number;        // expected reward / expected risk
  invalidation: string;   // specific price/condition where thesis dies
  edgeType: "informational" | "analytical" | "behavioral" | "timing" | "environmental" | "none";
  summary: string;        // 1-2 sentences
  bull: AlphaScenario;
  base: AlphaScenario;
  bear: AlphaScenario;
  counterargument: string;
  analog: HistoricalAnalog | null;
  provider: "anthropic" | "openai" | "deterministic";
  asOf: number;
}

export interface AlphaNewsResponse {
  ticker: string;
  asOf: number;
  events: AlphaEvent[];
  warnings: string[];
}

// ---- Ticker resolution ----
// Map common aliases (^GSPC -> SPY/SPX semantics) and pull in sector ETF
// context so a chart on SPY also surfaces broad macro alpha.
const TICKER_ALIASES: Record<string, string[]> = {
  "^GSPC": ["SPX", "SPY", "^GSPC"],
  "SPY": ["SPY", "SPX", "^GSPC"],
  "SPX": ["SPX", "SPY", "^GSPC"],
  "^NDX": ["NDX", "QQQ", "^NDX", "^IXIC"],
  "QQQ": ["QQQ", "NDX", "^NDX"],
  "^DJI": ["DJI", "DIA", "^DJI"],
};

function expandTickerSet(ticker: string): Set<string> {
  const upper = ticker.toUpperCase();
  const set = new Set<string>([upper]);
  const aliases = TICKER_ALIASES[upper] ?? TICKER_ALIASES[ticker];
  if (aliases) aliases.forEach((a) => set.add(a.toUpperCase()));
  return set;
}

// ---- Tier classification ----

interface TierMatch {
  tier: AlphaTier;
  category: string;
  bias: AlphaDirection;
  score: number; // base alpha contribution before clustering
}

// Higher-priority patterns are checked first. First match wins.
const TIER_RULES: Array<{ pattern: RegExp; tier: AlphaTier; category: string; bias?: AlphaDirection; score: number }> = [
  // Tier 1: hard catalysts
  { pattern: /\b(beats|tops|crushes)\b.*\b(estimates|expectations|forecast|street)\b/i, tier: "TIER_1", category: "EARNINGS", bias: "BULL", score: 95 },
  { pattern: /\b(misses|misses on|falls short of|disappoints)\b.*\b(estimates|expectations|forecast)\b/i, tier: "TIER_1", category: "EARNINGS", bias: "BEAR", score: 95 },
  { pattern: /\b(raises|hikes|boosts|lifts)\b.*\b(guidance|outlook|forecast|fy|full[- ]year)\b/i, tier: "TIER_1", category: "GUIDANCE", bias: "BULL", score: 92 },
  { pattern: /\b(cuts|lowers|slashes|trims|withdraws)\b.*\b(guidance|outlook|forecast)\b/i, tier: "TIER_1", category: "GUIDANCE", bias: "BEAR", score: 92 },
  { pattern: /\b(announc(es|ed)|to acquire|buys?|acquires?|merger|takeover|tender offer|all[- ]cash deal)\b/i, tier: "TIER_1", category: "M&A", bias: "BULL", score: 90 },
  { pattern: /\bfda\b.*\b(approv|reject|crl|clearance|breakthrough|priority review|fast track|advisory)\b/i, tier: "TIER_1", category: "FDA", score: 88 },
  { pattern: /\b(approves|approved)\b.*\bfda\b/i, tier: "TIER_1", category: "FDA", bias: "BULL", score: 90 },
  { pattern: /\b(rejects|complete response letter|crl)\b.*\b(drug|treatment|therapy)\b/i, tier: "TIER_1", category: "FDA", bias: "BEAR", score: 90 },
  { pattern: /\b(fomc|fed|powell)\b.*\b(cut|hike|hold|pivot|hawkish|dovish|press conference|minutes)\b/i, tier: "TIER_1", category: "FED", score: 85 },
  { pattern: /\b(upgrade|upgraded|raised to (buy|outperform|overweight))\b/i, tier: "TIER_1", category: "RATING", bias: "BULL", score: 80 },
  { pattern: /\b(downgrade|downgraded|cut to (sell|underperform|underweight))\b/i, tier: "TIER_1", category: "RATING", bias: "BEAR", score: 82 },
  { pattern: /\b8[- ]?k\b|\bmaterial (event|definitive agreement)\b|\bgoing concern\b|\brestatement\b/i, tier: "TIER_1", category: "MATERIAL_8K", score: 86 },

  // Tier 2: positioning-driven
  { pattern: /\b(unusual options|dark pool|block trade|sweep|whale|massive call|massive put)\b/i, tier: "TIER_2", category: "FLOW", score: 70 },
  { pattern: /\b(price target|pt) (raised|lifted|hiked) to/i, tier: "TIER_2", category: "PT_CHANGE", bias: "BULL", score: 65 },
  { pattern: /\b(price target|pt) (cut|lowered|reduced) to/i, tier: "TIER_2", category: "PT_CHANGE", bias: "BEAR", score: 65 },
  { pattern: /\b(insider (buy|sell)|form 4|10b5[- ]1|executive (purchase|sale))\b/i, tier: "TIER_2", category: "INSIDER", score: 62 },
  { pattern: /\b(buyback|repurchase|share repurchase|authorize.*\$.*billion)\b/i, tier: "TIER_2", category: "BUYBACK", bias: "BULL", score: 68 },
  { pattern: /\b(dividend|special dividend|raises dividend|cuts dividend|suspends dividend)\b/i, tier: "TIER_2", category: "DIVIDEND", score: 60 },
  { pattern: /\b(layoffs|workforce reduction|restructur(ing|e)|cost cut)\b/i, tier: "TIER_2", category: "RESTRUCTURE", score: 60 },
];

function classifyHeadline(h: Headline): TierMatch | null {
  for (const rule of TIER_RULES) {
    if (rule.pattern.test(h.title) || rule.pattern.test(h.summary)) {
      return { tier: rule.tier, category: rule.category, bias: rule.bias ?? "NEUTRAL", score: rule.score };
    }
  }
  return null;
}

// ---- Headline clustering for sentiment-shift detection ----
// Two headlines cluster if they share >= 3 meaningful tokens (>3 chars, not stopwords).

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "over", "after", "before",
  "says", "said", "will", "shares", "stock", "stocks", "ticker", "report", "reports",
  "amid", "while", "could", "would", "may", "might", "should", "more", "less", "than",
  "new", "old", "up", "down", "high", "low", "today", "year", "week", "month",
  "company", "companies", "market", "markets", "trading", "trader",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3 && !STOPWORDS.has(t)),
  );
}

function clusterOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

interface Cluster {
  size: number;
  ids: string[];
  tokens: Set<string>;
  exemplar: Headline;
}

function clusterHeadlines(headlines: Headline[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const h of headlines) {
    const t = tokenize(`${h.title} ${h.summary}`);
    let added = false;
    for (const c of clusters) {
      if (clusterOverlap(t, c.tokens) >= 3) {
        c.size++;
        c.ids.push(h.id);
        // merge tokens
        for (const tok of t) c.tokens.add(tok);
        added = true;
        break;
      }
    }
    if (!added) clusters.push({ size: 1, ids: [h.id], tokens: t, exemplar: h });
  }
  return clusters;
}

// Compute z-score of cluster size against an assumed baseline (mean=1.2,
// stdev=0.8 — reasonable for an aggregated RSS pull when no historical store
// is available). If we ever wire a persistent cluster history, swap in real
// percentiles here.
const CLUSTER_BASELINE_MEAN = 1.2;
const CLUSTER_BASELINE_STD = 0.8;

function clusterZScore(size: number): number {
  return (size - CLUSTER_BASELINE_MEAN) / CLUSTER_BASELINE_STD;
}

// ---- Build the alpha event list for a ticker ----

export async function getAlphaEventsForTicker(ticker: string): Promise<AlphaNewsResponse> {
  const expanded = expandTickerSet(ticker);
  const warnings: string[] = [];

  let snapshot;
  try {
    snapshot = await buildNewsSnapshot();
  } catch (err) {
    warnings.push(`news_snapshot_failed: ${(err as any)?.message ?? "unknown"}`);
    return { ticker, asOf: Math.floor(Date.now() / 1000), events: [], warnings };
  }

  // Filter headlines that reference our ticker set (or are macro tier-1 events
  // for index tickers like SPY/SPX).
  const isIndex = expanded.has("SPX") || expanded.has("SPY") || expanded.has("^GSPC") || expanded.has("QQQ") || expanded.has("NDX") || expanded.has("^NDX");
  const tickerHeadlines = snapshot.headlines.filter((h) => {
    const refs = h.tickers.map((t) => t.toUpperCase());
    if (refs.some((r) => expanded.has(r))) return true;
    if (isIndex) {
      // Macro topics count for index charts even without ticker mention
      const macroTopics: NewsTopic[] = ["FED", "INFLATION", "JOBS", "GROWTH", "RATES"];
      if (h.topics.some((t) => macroTopics.includes(t))) return true;
    }
    return false;
  });

  // Cluster ALL filtered headlines to detect sentiment shifts
  const clusters = clusterHeadlines(tickerHeadlines);
  // Map headline id -> cluster (size, z-score, sibling ids)
  const idToCluster = new Map<string, { z: number; size: number; ids: string[] }>();
  for (const c of clusters) {
    const z = clusterZScore(c.size);
    for (const id of c.ids) idToCluster.set(id, { z, size: c.size, ids: c.ids });
  }

  const events: AlphaEvent[] = [];
  const seenClusters = new Set<string>(); // dedupe: one event per cluster

  for (const h of tickerHeadlines) {
    const cluster = idToCluster.get(h.id);
    const clusterKey = cluster?.ids.slice().sort().join("|") ?? h.id;
    const tierMatch = classifyHeadline(h);

    // Sentiment-shift event: cluster of 3+ similar headlines (z > 2.25)
    const isSigmaShift = (cluster?.z ?? 0) > 2.25 && (cluster?.size ?? 0) >= 3;

    if (!tierMatch && !isSigmaShift) continue;
    if (seenClusters.has(clusterKey)) continue;
    seenClusters.add(clusterKey);

    // Resolve which ticker this event tags (prefer explicit mention, fall back
    // to the chart's ticker for macro index events).
    const explicitTicker = h.tickers.map((t) => t.toUpperCase()).find((r) => expanded.has(r));
    const eventTicker = explicitTicker ?? ticker.toUpperCase();

    if (tierMatch) {
      // Cluster amplification: a tier-1 event corroborated by 2+ headlines is
      // scored higher than an isolated single source.
      const clusterBonus = cluster && cluster.size > 1 ? Math.min(8, cluster.size * 2) : 0;
      events.push({
        id: h.id,
        ticker: eventTicker,
        tier: tierMatch.tier,
        category: tierMatch.category,
        title: h.title,
        source: h.source,
        url: h.url,
        published: h.published,
        summary: h.summary,
        initialBias: tierMatch.bias,
        alphaScore: Math.min(100, tierMatch.score + clusterBonus),
        clusterZ: cluster?.z,
        clusterIds: cluster && cluster.size > 1 ? cluster.ids : undefined,
      });
    } else if (isSigmaShift) {
      events.push({
        id: h.id,
        ticker: eventTicker,
        tier: "SENTIMENT_SHIFT",
        category: "SENTIMENT_CLUSTER",
        title: h.title,
        source: h.source,
        url: h.url,
        published: h.published,
        summary: `${cluster!.size} correlated headlines clustering on this story (z=${cluster!.z.toFixed(2)}σ).`,
        initialBias: "NEUTRAL",
        alphaScore: Math.min(100, 55 + cluster!.z * 8),
        clusterZ: cluster!.z,
        clusterIds: cluster!.ids,
      });
    }
  }

  // Sort by alpha score descending, then by recency
  events.sort((a, b) => (b.alphaScore - a.alphaScore) || (b.published - a.published));

  if (snapshot.warnings?.length) warnings.push(...snapshot.warnings);

  return {
    ticker: ticker.toUpperCase(),
    asOf: Math.floor(Date.now() / 1000),
    events: events.slice(0, 30), // cap for UI sanity
    warnings,
  };
}

// ---- AI verdict generation ----

const VERDICT_SYSTEM_PROMPT = `You are a senior quant and risk manager generating a tradeable positioning read on a single news event for one ticker.

Output strict JSON only — no prose outside the JSON. Schema:
{
  "direction": "BULL" | "BEAR" | "NEUTRAL",
  "confidence": <0-100 integer>,
  "expectedMovePct": <signed number, e.g. -1.4 means -1.4%>,
  "rrRatio": <number, expected reward / expected risk, e.g. 2.3>,
  "invalidation": "<specific price level or condition where this thesis dies>",
  "edgeType": "informational" | "analytical" | "behavioral" | "timing" | "environmental" | "none",
  "summary": "<one or two short sentences, peer-to-peer tone>",
  "bull": { "thesis": "<one sentence>", "prob": <0-100>, "targetMovePct": <signed number> },
  "base": { "thesis": "<one sentence>", "prob": <0-100>, "targetMovePct": <signed number> },
  "bear": { "thesis": "<one sentence>", "prob": <0-100>, "targetMovePct": <signed number> },
  "counterargument": "<strongest argument AGAINST your direction call>",
  "analog": {
    "description": "<brief historical analog: similar setups for this ticker/category>",
    "sampleSize": <integer estimate>,
    "avgMovePct": <signed number>,
    "hitRate": <0-100 integer>
  }
}

Rules:
- bull.prob + base.prob + bear.prob MUST equal exactly 100.
- Direction is the side with the highest probability AND favorable R:R.
- If no edge exists, return direction "NEUTRAL", confidence < 35, edgeType "none".
- Be honest about uncertainty. Single-source rumor != hard catalyst.
- For sentiment-cluster events (no single hard catalyst), treat as a behavioral/timing edge with lower confidence.
- Never recommend oversized positioning. Right direction + wrong size is still a loss.
- If you don't know real historical stats, return a plausible estimate based on the catalyst type with sampleSize <= 20.`;

function buildVerdictPayload(event: AlphaEvent, context?: { spot?: number; vix?: number; regime?: string }): string {
  return JSON.stringify({
    ticker: event.ticker,
    event: {
      tier: event.tier,
      category: event.category,
      title: event.title,
      source: event.source,
      summary: event.summary,
      publishedAgoMin: Math.max(0, Math.round((Date.now() / 1000 - event.published) / 60)),
      clusterSize: event.clusterIds?.length ?? 1,
      clusterZ: event.clusterZ ?? null,
      alphaScore: event.alphaScore,
      initialBias: event.initialBias,
    },
    marketContext: context ?? {},
  });
}

async function callAnthropicVerdict(payload: string): Promise<any | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 900,
      system: VERDICT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: payload }],
    });
    const block = msg.content.find((b: any) => b.type === "text");
    const text = (block as any)?.text ?? "";
    return safeJsonParse(text);
  } catch (e) {
    console.error("[alphaNews] claude failed:", (e as any)?.message);
    return null;
  }
}

async function callOpenAiVerdict(payload: string): Promise<any | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const openai = new OpenAI();
    const r: any = await (openai.responses as any).create({
      model: "gpt-4o-mini",
      input: `${VERDICT_SYSTEM_PROMPT}\n\n---\n\n${payload}`,
    });
    const text = r.output_text ?? "";
    return safeJsonParse(text);
  } catch (e) {
    console.error("[alphaNews] openai failed:", (e as any)?.message);
    return null;
  }
}

function safeJsonParse(text: string): any | null {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// Deterministic fallback when no LLM keys present. Uses tier + category +
// initialBias to produce a sensible baseline read. This is the documented
// behavior — engine works without LLM keys, but the verdicts are coarser.
function deterministicVerdict(event: AlphaEvent): AlphaVerdict {
  const dir = event.initialBias;
  const conf =
    event.tier === "TIER_1" ? 60 :
    event.tier === "TIER_2" ? 45 :
    35;

  // Default move expectations by category (rough — meant as visible baseline)
  const moveByCategory: Record<string, number> = {
    EARNINGS: 4.5, GUIDANCE: 5.0, "M&A": 8.0, FDA: 12.0, FED: 1.5,
    RATING: 1.8, MATERIAL_8K: 3.5, FLOW: 1.2, PT_CHANGE: 1.5,
    INSIDER: 1.0, BUYBACK: 2.0, DIVIDEND: 1.0, RESTRUCTURE: 3.0,
    SENTIMENT_CLUSTER: 2.0,
  };
  const baseMove = moveByCategory[event.category] ?? 1.5;
  const signedMove = dir === "BULL" ? baseMove : dir === "BEAR" ? -baseMove : 0;

  const bullProb = dir === "BULL" ? 55 : dir === "BEAR" ? 18 : 30;
  const bearProb = dir === "BEAR" ? 55 : dir === "BULL" ? 18 : 30;
  const baseProb = 100 - bullProb - bearProb;

  return {
    eventId: event.id,
    ticker: event.ticker,
    direction: dir,
    confidence: conf,
    expectedMovePct: signedMove,
    rrRatio: 1.8,
    invalidation: dir === "BULL"
      ? "Break and close below the pre-news low invalidates the bull case."
      : dir === "BEAR"
        ? "Break and close above the pre-news high invalidates the bear case."
        : "Outside the pre-news range either way forces a re-evaluation.",
    edgeType: event.tier === "TIER_1" ? "informational" : event.tier === "TIER_2" ? "analytical" : "behavioral",
    summary: `${event.category} catalyst — baseline read, no LLM available. Initial bias ${dir}, expected move ${signedMove >= 0 ? "+" : ""}${signedMove.toFixed(1)}%.`,
    bull: { thesis: `Catalyst confirms bull case for ${event.ticker}.`, prob: bullProb, targetMovePct: Math.abs(baseMove) },
    base: { thesis: `Market digests but no sustained move.`, prob: baseProb, targetMovePct: 0 },
    bear: { thesis: `Catalyst confirms bear case for ${event.ticker}.`, prob: bearProb, targetMovePct: -Math.abs(baseMove) },
    counterargument: "Deterministic baseline — full counterargument requires LLM verdict (set ANTHROPIC_API_KEY or OPENAI_API_KEY).",
    analog: null,
    provider: "deterministic",
    asOf: Math.floor(Date.now() / 1000),
  };
}

// Validate + normalize an LLM response into AlphaVerdict shape
function normalizeVerdict(event: AlphaEvent, raw: any, provider: "anthropic" | "openai"): AlphaVerdict | null {
  if (!raw || typeof raw !== "object") return null;
  const direction = ["BULL", "BEAR", "NEUTRAL"].includes(raw.direction) ? raw.direction : "NEUTRAL";
  const num = (v: any, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);
  const str = (v: any, d = "") => (typeof v === "string" ? v : d);

  // Normalize scenario probs to sum 100
  let bullP = num(raw.bull?.prob, 33);
  let baseP = num(raw.base?.prob, 34);
  let bearP = num(raw.bear?.prob, 33);
  const tot = bullP + baseP + bearP;
  if (tot > 0 && Math.abs(tot - 100) > 1) {
    bullP = Math.round((bullP / tot) * 100);
    bearP = Math.round((bearP / tot) * 100);
    baseP = 100 - bullP - bearP;
  }

  const analog = raw.analog && typeof raw.analog === "object" ? {
    description: str(raw.analog.description, "No historical analog data available."),
    sampleSize: Math.max(0, Math.floor(num(raw.analog.sampleSize, 0))),
    avgMovePct: num(raw.analog.avgMovePct, 0),
    hitRate: Math.max(0, Math.min(100, num(raw.analog.hitRate, 50))),
  } : null;

  return {
    eventId: event.id,
    ticker: event.ticker,
    direction,
    confidence: Math.max(0, Math.min(100, Math.round(num(raw.confidence, 50)))),
    expectedMovePct: num(raw.expectedMovePct, 0),
    rrRatio: Math.max(0, num(raw.rrRatio, 1)),
    invalidation: str(raw.invalidation, "No invalidation level specified."),
    edgeType: ["informational", "analytical", "behavioral", "timing", "environmental", "none"].includes(raw.edgeType)
      ? raw.edgeType : "none",
    summary: str(raw.summary, "No summary available."),
    bull: { thesis: str(raw.bull?.thesis, ""), prob: bullP, targetMovePct: num(raw.bull?.targetMovePct, 0) },
    base: { thesis: str(raw.base?.thesis, ""), prob: baseP, targetMovePct: num(raw.base?.targetMovePct, 0) },
    bear: { thesis: str(raw.bear?.thesis, ""), prob: bearP, targetMovePct: num(raw.bear?.targetMovePct, 0) },
    counterargument: str(raw.counterargument, ""),
    analog,
    provider,
    asOf: Math.floor(Date.now() / 1000),
  };
}

// In-memory cache: 10-minute TTL per (eventId). Avoids re-burning LLM credits
// when the user clicks the same marker repeatedly.
interface CachedVerdict { verdict: AlphaVerdict; expiresAt: number; }
const verdictCache = new Map<string, CachedVerdict>();
const VERDICT_TTL_MS = 10 * 60 * 1000;

export async function getAlphaVerdict(
  event: AlphaEvent,
  context?: { spot?: number; vix?: number; regime?: string },
  force = false,
): Promise<AlphaVerdict> {
  const cacheKey = event.id;
  if (!force) {
    const cached = verdictCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.verdict;
  }

  const payload = buildVerdictPayload(event, context);

  // Try Anthropic, then OpenAI, then deterministic
  let verdict: AlphaVerdict | null = null;
  const claudeRaw = await callAnthropicVerdict(payload);
  if (claudeRaw) verdict = normalizeVerdict(event, claudeRaw, "anthropic");
  if (!verdict) {
    const openaiRaw = await callOpenAiVerdict(payload);
    if (openaiRaw) verdict = normalizeVerdict(event, openaiRaw, "openai");
  }
  if (!verdict) verdict = deterministicVerdict(event);

  verdictCache.set(cacheKey, { verdict, expiresAt: Date.now() + VERDICT_TTL_MS });
  return verdict;
}
