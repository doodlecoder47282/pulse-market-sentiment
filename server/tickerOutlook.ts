// server/tickerOutlook.ts
//
// Single-name Outlook orchestrator. Fuses the pivot projection (price
// structure + magnets) with the ticker alpha block (news + social + positioning)
// and produces a peer-to-peer verdict card per the user's playbook:
//   • base / bull / bear with probability weights summing to 100
//   • position sizing (fractional Kelly), R:R (min 2:1), invalidation level
//   • edge type identification, counterargument
//   • plain-English setup tags
//
// LLM-augmented when ANTHROPIC_API_KEY or OPENAI_API_KEY is set; otherwise a
// deterministic baseline derived from the rollup composite, gamma walls and
// pivot magnets.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getTickerAlpha, type TickerAlpha } from "./tickerAlpha";
import { buildPivotProjection, type PivotProjectionResponse } from "./pivotProjection";
import { getPriceHistory } from "./schwab";

export type Direction = "BULL" | "BEAR" | "NEUTRAL";

export interface OutlookVerdict {
  direction: Direction;
  /** 0-100 */
  confidence: number;
  /** Expected price target (mid). null if no edge. */
  targetPrice: number | null;
  /** Expected move % (signed, vs spot). */
  expectedMovePct: number | null;
  /** Risk/reward ratio (reward/risk). */
  rr: number | null;
  /** Suggested fractional Kelly position size (0-1.0). */
  kellyFrac: number;
  /** Specific invalidation level — where the thesis dies */
  invalidation: number | null;
  /** Edge type tag */
  edgeType: "informational" | "analytical" | "behavioral" | "environmental" | "none";
  /** Strongest counterargument */
  counterargument: string;
  /** One-line plain-English thesis */
  thesis: string;
  /** Three-path scenarios — sum to 100 */
  scenarios: {
    bull: { prob: number; targetPct: number; thesis: string };
    base: { prob: number; targetPct: number; thesis: string };
    bear: { prob: number; targetPct: number; thesis: string };
  };
  /** What to watch for confirmation/invalidation */
  triggers: string[];
  /** Which engine produced this verdict */
  provider: "anthropic" | "openai" | "deterministic";
}

export interface TickerOutlookResponse {
  ticker: string;
  asOf: string;
  spot: number | null;
  verdict: OutlookVerdict;
  alpha: TickerAlpha;
  pivots: PivotProjectionResponse;
  warnings: string[];
}

// ---- Bar fetch (shared with pivot endpoint) ----

const _barsCache = new Map<string, { ts: number; bars: any[] }>();
const BARS_TTL_MS = 30 * 60 * 1000;

async function getBarsFor(symbol: string): Promise<any[]> {
  const cached = _barsCache.get(symbol);
  if (cached && Date.now() - cached.ts < BARS_TTL_MS) return cached.bars;
  try {
    const resp = await getPriceHistory(symbol, "month", 6, "daily", 1);
    const bars = (resp.candles || [])
      .filter((c: any) => c.close != null && isFinite(c.close))
      .map((c: any) => ({
        t: Math.floor(c.datetime / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
    if (bars.length >= 30) _barsCache.set(symbol, { ts: Date.now(), bars });
    return bars;
  } catch {
    return cached?.bars ?? [];
  }
}

// ---- Deterministic verdict fallback ----

function deterministicVerdict(
  alpha: TickerAlpha,
  pivots: PivotProjectionResponse | null,
  spot: number,
): OutlookVerdict {
  const c = alpha.rollup.composite; // -100..100
  let direction: Direction = "NEUTRAL";
  if (c >= 25) direction = "BULL";
  else if (c <= -25) direction = "BEAR";

  // Use nearest magnet on the side of the bias as the target; nearest opposite
  // magnet as the invalidation level. Re-anchor side using live spot — the pivot
  // engine tags side from its own (potentially stale) bar spot, so we re-bucket.
  let target: number | null = null;
  let invalidation: number | null = null;
  if (pivots && pivots.levels?.length > 0 && spot > 0) {
    const above = pivots.levels
      .filter((l) => l.price > spot)
      .sort((a, b) => a.price - b.price); // closest above first
    const below = pivots.levels
      .filter((l) => l.price < spot)
      .sort((a, b) => b.price - a.price); // closest below first
    if (direction === "BULL") {
      const magnetAbove = above.find((l) => l.confluence >= 2) ?? above[0];
      const magnetBelow = below.find((l) => l.confluence >= 2) ?? below[0];
      target = magnetAbove?.price ?? null;
      invalidation = magnetBelow?.price ?? null;
    } else if (direction === "BEAR") {
      const magnetBelow = below.find((l) => l.confluence >= 2) ?? below[0];
      const magnetAbove = above.find((l) => l.confluence >= 2) ?? above[0];
      target = magnetBelow?.price ?? null;
      invalidation = magnetAbove?.price ?? null;
    } else {
      target = null;
      invalidation = null;
    }
  }
  if (target == null && direction !== "NEUTRAL") {
    target = direction === "BULL" ? spot * 1.04 : spot * 0.96;
    invalidation = direction === "BULL" ? spot * 0.98 : spot * 1.02;
  }

  const expectedMovePct = target != null ? ((target - spot) / spot) * 100 : null;
  let rr: number | null = null;
  if (target != null && invalidation != null) {
    const reward = Math.abs(target - spot);
    const risk = Math.abs(spot - invalidation);
    rr = risk > 0 ? Number((reward / risk).toFixed(2)) : null;
  }

  // Scenarios — distribute around composite
  const bullProb = direction === "BULL" ? 50 : direction === "BEAR" ? 20 : 30;
  const bearProb = direction === "BEAR" ? 50 : direction === "BULL" ? 20 : 30;
  const baseProb = 100 - bullProb - bearProb;

  const confidence = Math.min(70, Math.max(25, Math.abs(c) * 0.6 + 30));
  // Quarter-Kelly default; full Kelly = composite/100 if positive expectation
  const expRet = (expectedMovePct ?? 0) / 100;
  const kellyFrac =
    rr && rr > 0
      ? Math.max(0, Math.min(0.5, (Math.abs(c) / 100) * 0.25))
      : 0;

  const counter =
    direction === "BULL"
      ? "Crowded long sentiment + close to call wall = limited upside before dealers fade the move."
      : direction === "BEAR"
      ? "Put wall + heavy P/C OI = strong downside hedge already on; positioning fuel for a squeeze."
      : "No directional signal — pass or wait for a hard catalyst.";

  return {
    direction,
    confidence: Math.round(confidence),
    targetPrice: target,
    expectedMovePct: expectedMovePct != null ? Number(expectedMovePct.toFixed(2)) : null,
    rr,
    kellyFrac: Number(kellyFrac.toFixed(3)),
    invalidation,
    edgeType: alpha.rollup.edgeType,
    counterargument: counter,
    thesis:
      direction === "NEUTRAL"
        ? `No edge — pass. Composite ${c}. Wait for a hard catalyst or social vol spike.`
        : `${direction === "BULL" ? "Bullish" : "Bearish"} bias from composite ${c} (news ${alpha.rollup.newsBias}/social ${alpha.rollup.socialBias}/positioning ${alpha.rollup.positioningBias}). Magnet ${target?.toFixed(2) ?? "n/a"}, invalidation ${invalidation?.toFixed(2) ?? "n/a"}.`,
    scenarios: {
      bull: {
        prob: bullProb,
        targetPct:
          direction === "BULL"
            ? expectedMovePct ?? 3
            : Math.abs(expectedMovePct ?? 3) * 0.5,
        thesis: "Magnet to nearest stacked resistance, positioning tailwind.",
      },
      base: {
        prob: baseProb,
        targetPct: 0,
        thesis: "Range-bound chop around current pivots, no catalyst.",
      },
      bear: {
        prob: bearProb,
        targetPct:
          direction === "BEAR"
            ? expectedMovePct ?? -3
            : -Math.abs(expectedMovePct ?? 3) * 0.5,
        thesis: "Reject magnet, lose put wall, gamma flip negative.",
      },
    },
    triggers: [
      target != null
        ? `Close ${direction === "BULL" ? "above" : "below"} ${target.toFixed(2)} confirms`
        : "No clean confirmation level — pass",
      invalidation != null ? `Stop at ${invalidation.toFixed(2)}` : "No clean stop — small size only",
      alpha.social.volumeZ >= 2
        ? `Social vol z=${alpha.social.volumeZ.toFixed(1)} — unusual chatter, weight behavioral edge`
        : "Social volume normal",
    ],
    provider: "deterministic",
  };
}

// ---- LLM synthesis ----

const SYNTHESIS_SYSTEM_PROMPT = `You are a senior quant + risk manager + advantage player producing a single-name outlook verdict.

You receive a JSON payload with: ticker, spot price, ranked alpha news events (tier 1/2/sentiment-shift), social exposure (StockTwits + Reddit + X tone & volume), positioning (gamma walls, P/C ratios, IV skew), and a pivot projection (key levels + confluence + magnets).

Speak peer-to-peer with no filler. Identify the edge type. Stress-test the strongest counterargument. If no edge exists, return direction NEUTRAL with confidence < 35 and edgeType "none". Passing is professional.

Output ONLY a single JSON object with this exact schema. No prose, no markdown, no fences.

{
  "direction": "BULL" | "BEAR" | "NEUTRAL",
  "confidence": <0-100>,
  "targetPrice": <number or null>,
  "expectedMovePct": <signed number or null>,
  "rr": <number or null>,
  "kellyFrac": <0-1 number>,
  "invalidation": <number or null>,
  "edgeType": "informational" | "analytical" | "behavioral" | "environmental" | "none",
  "counterargument": "<one sentence: strongest argument AGAINST your call>",
  "thesis": "<one sentence: the trade in plain English>",
  "scenarios": {
    "bull": { "prob": <0-100>, "targetPct": <signed>, "thesis": "<one sentence>" },
    "base": { "prob": <0-100>, "targetPct": <signed>, "thesis": "<one sentence>" },
    "bear": { "prob": <0-100>, "targetPct": <signed>, "thesis": "<one sentence>" }
  },
  "triggers": ["<3-5 plain-English watch items: confirms, stops, social/news flags>"]
}

Rules:
- bull.prob + base.prob + bear.prob MUST equal exactly 100.
- targetPrice + invalidation must use real magnet levels from the pivot projection where possible. Quote them in $.
- rr = |target - spot| / |invalidation - spot|. Min 2:1 to recommend a directional trade; otherwise NEUTRAL.
- kellyFrac is fractional Kelly (0.25 default); never above 0.5.
- Weight news > positioning > social. Sentiment cluster events without hard catalysts get behavioral edge tag.
- If gamma is "negative regime" (negative total GEX), bias trades toward momentum direction; if "positive", bias toward mean-reversion to nearest stacked magnet.
- If P/C OI > 1.5, fading the crowd by going long is contrarian behavioral edge — flag it.
- Never recommend oversizing. Right direction + wrong size = loss.
- Speak in probabilities. Never absolutes.
- If counterargument is stronger than the thesis, return NEUTRAL with thesis "Counter is stronger — pass."`;

function buildSynthesisPayload(alpha: TickerAlpha, pivots: PivotProjectionResponse, spot: number): string {
  return JSON.stringify({
    ticker: alpha.ticker,
    spot,
    asOf: alpha.asOf,
    rollup: alpha.rollup,
    news: {
      events: (alpha.news.events ?? []).slice(0, 8).map((e: any) => ({
        tier: e.tier,
        category: e.category,
        title: e.title,
        publishedAgoMin: Math.max(0, Math.round((Date.now() / 1000 - e.published) / 60)),
        alphaScore: e.alphaScore,
        initialBias: e.initialBias,
        clusterZ: e.clusterZ ?? null,
      })),
      warnings: alpha.news.warnings,
    },
    social: {
      score: alpha.social.score,
      bullish: alpha.social.bullish,
      bearish: alpha.social.bearish,
      messageCount: alpha.social.messageCount,
      volumeZ: alpha.social.volumeZ,
      bySource: alpha.social.bySource,
      topPostsSample: alpha.social.topPosts.slice(0, 5).map((p) => ({
        src: p.source,
        text: p.text.slice(0, 200),
        tone: p.tone,
      })),
    },
    positioning: {
      regime: alpha.positioning.regime,
      totalGex: alpha.positioning.totalGex,
      callWall: alpha.positioning.callWall,
      putWall: alpha.positioning.putWall,
      gammaFlip: alpha.positioning.gammaFlip,
      distToCallWallPct: alpha.positioning.distToCallWallPct,
      distToPutWallPct: alpha.positioning.distToPutWallPct,
      pcrOi: alpha.positioning.pcrOi,
      pcrVol: alpha.positioning.pcrVol,
      ivSkew25d: alpha.positioning.ivSkew25d,
      atmIv: alpha.positioning.atmIv,
    },
    pivots: {
      monthlyPriorOhlc: pivots.monthlyPriorOhlc,
      quarterlyPriorOhlc: pivots.quarterlyPriorOhlc,
      // Send the levels sorted by closeness to spot, top 12
      levels: pivots.levels
        .slice()
        .sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct))
        .slice(0, 12)
        .map((l) => ({
          label: l.label,
          price: l.price,
          source: l.source,
          confluence: l.confluence,
          stackedWith: l.stackedWith,
          distPct: l.distPct,
          side: l.side,
          tier: l.tier,
        })),
      patterns: pivots.patterns,
    },
  });
}

function safeJsonParse(s: string): any | null {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

async function callAnthropicSynthesis(payload: string): Promise<any | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: SYNTHESIS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: payload }],
    });
    const block = msg.content.find((b: any) => b.type === "text");
    return safeJsonParse((block as any)?.text ?? "");
  } catch (e) {
    console.error("[tickerOutlook] claude failed:", (e as any)?.message);
    return null;
  }
}

async function callOpenAiSynthesis(payload: string): Promise<any | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const openai = new OpenAI();
    const msg = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
        { role: "user", content: payload },
      ],
    });
    return safeJsonParse(msg.choices?.[0]?.message?.content ?? "");
  } catch (e) {
    console.error("[tickerOutlook] openai failed:", (e as any)?.message);
    return null;
  }
}

function normalizeVerdict(raw: any, fallback: OutlookVerdict, provider: OutlookVerdict["provider"]): OutlookVerdict {
  if (!raw || typeof raw !== "object") return fallback;
  const sc = raw.scenarios || {};
  // Force probs to sum to 100
  const bp = Math.max(0, Math.min(100, Number(sc.bull?.prob ?? fallback.scenarios.bull.prob)));
  const xp = Math.max(0, Math.min(100, Number(sc.bear?.prob ?? fallback.scenarios.bear.prob)));
  const np = Math.max(0, Math.min(100, 100 - bp - xp));
  return {
    direction: (raw.direction === "BULL" || raw.direction === "BEAR" || raw.direction === "NEUTRAL")
      ? raw.direction : fallback.direction,
    confidence: Math.max(0, Math.min(100, Number(raw.confidence ?? fallback.confidence))),
    targetPrice: typeof raw.targetPrice === "number" ? raw.targetPrice : fallback.targetPrice,
    expectedMovePct: typeof raw.expectedMovePct === "number" ? raw.expectedMovePct : fallback.expectedMovePct,
    rr: typeof raw.rr === "number" ? raw.rr : fallback.rr,
    kellyFrac: Math.max(0, Math.min(0.5, Number(raw.kellyFrac ?? fallback.kellyFrac))),
    invalidation: typeof raw.invalidation === "number" ? raw.invalidation : fallback.invalidation,
    edgeType: ["informational","analytical","behavioral","environmental","none"].includes(raw.edgeType)
      ? raw.edgeType : fallback.edgeType,
    counterargument: typeof raw.counterargument === "string" ? raw.counterargument : fallback.counterargument,
    thesis: typeof raw.thesis === "string" ? raw.thesis : fallback.thesis,
    scenarios: {
      bull: {
        prob: bp,
        targetPct: Number(sc.bull?.targetPct ?? fallback.scenarios.bull.targetPct),
        thesis: String(sc.bull?.thesis ?? fallback.scenarios.bull.thesis),
      },
      base: {
        prob: np,
        targetPct: Number(sc.base?.targetPct ?? fallback.scenarios.base.targetPct),
        thesis: String(sc.base?.thesis ?? fallback.scenarios.base.thesis),
      },
      bear: {
        prob: xp,
        targetPct: Number(sc.bear?.targetPct ?? fallback.scenarios.bear.targetPct),
        thesis: String(sc.bear?.thesis ?? fallback.scenarios.bear.thesis),
      },
    },
    triggers: Array.isArray(raw.triggers) && raw.triggers.length > 0
      ? raw.triggers.slice(0, 6).map(String) : fallback.triggers,
    provider,
  };
}

// ---- 10-min synthesis cache ----

const _verdictCache = new Map<string, { ts: number; verdict: OutlookVerdict }>();
const VERDICT_TTL_MS = 10 * 60 * 1000;

// ---- Main entry ----

export async function buildTickerOutlook(ticker: string, opts?: { forceVerdict?: boolean }): Promise<TickerOutlookResponse> {
  const t = ticker.toUpperCase().replace(/^[$^]/, "");
  const warnings: string[] = [];

  // Bars for pivot projection
  const schwabSymbol = t === "^GSPC" ? "$SPX" : t;
  const bars = await getBarsFor(schwabSymbol);
  if (bars.length < 30) warnings.push(`Insufficient bars for ${t} (${bars.length})`);

  // Run alpha + pivot in parallel
  const alpha = await getTickerAlpha(t);
  const spot = alpha.positioning.spot ?? (bars.length > 0 ? bars[bars.length - 1].close : null);

  let pivots: PivotProjectionResponse;
  if (bars.length >= 30 && spot != null) {
    pivots = buildPivotProjection({
      symbol: t,
      spot,
      bars,
      gammaWalls: {
        callWall: alpha.positioning.callWall,
        putWall: alpha.positioning.putWall,
        gammaFlip: alpha.positioning.gammaFlip,
        zeroGamma: alpha.positioning.gammaFlip,
      },
    });
  } else {
    pivots = {
      symbol: t,
      spot: spot ?? 0,
      asOf: new Date().toISOString(),
      monthlyPriorOhlc: { o: 0, h: 0, l: 0, c: 0 },
      quarterlyPriorOhlc: { o: 0, h: 0, l: 0, c: 0 },
      levels: [],
      historicalReactions: {},
      patterns: [],
    };
  }

  // Verdict — start deterministic, upgrade with LLM if available
  let verdict = deterministicVerdict(alpha, pivots, spot ?? 0);

  // Try LLM synthesis (cached)
  const cacheKey = `${t}-${pivots.levels.length}-${Math.round((spot ?? 0) * 100)}`;
  const cached = _verdictCache.get(cacheKey);
  if (cached && !opts?.forceVerdict && Date.now() - cached.ts < VERDICT_TTL_MS) {
    verdict = cached.verdict;
  } else if (spot != null && (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)) {
    const payload = buildSynthesisPayload(alpha, pivots, spot);
    const ant = await callAnthropicSynthesis(payload);
    if (ant) {
      verdict = normalizeVerdict(ant, verdict, "anthropic");
    } else {
      const oa = await callOpenAiSynthesis(payload);
      if (oa) verdict = normalizeVerdict(oa, verdict, "openai");
    }
    _verdictCache.set(cacheKey, { ts: Date.now(), verdict });
  }

  return {
    ticker: t,
    asOf: new Date().toISOString(),
    spot,
    verdict,
    alpha,
    pivots,
    warnings,
  };
}
