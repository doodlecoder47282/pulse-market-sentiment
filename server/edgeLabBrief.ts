/**
 * Edge Lab AI brief generator.
 * Given a panel name + symbol, builds the same data the UI shows and asks
 * Claude (fallback OpenAI) to return a structured peer-to-peer brief.
 *
 * Output schema (always JSON):
 * {
 *   verdict: string (1-3 word call: "edge", "no edge", "rich", "compressed", etc),
 *   verdictColor: "emerald" | "rose" | "amber" | "neutral",
 *   edgeType: "informational" | "analytical" | "behavioral" | "timing" | "environmental" | "none",
 *   confidence: null,           // no hand-set number (R3-2 item 7)
 *   summary: string (2-4 sentences, plain english, 15-year-old understandable),
 *   baseCase: { thesis: string, prob: null },   // scenarios, no weights
 *   bullCase: { thesis: string, prob: null },
 *   bearCase: { thesis: string, prob: null },
 *   actionable: string,         // "what to watch" (field name kept for the client); never trade or size advice
 *   invalidation: string,       // condition where the read flips
 *   counterargument: string,    // strongest opposing read
 *   bullets: string[]           // 2-5 short "what stands out" lines
 * }
 *
 * Both paths (LLM and deterministic) pass through scrubBrief
 * (edgeBriefText.ts): confidence and case weights become null and any
 * sentence with trade, structure, sizing, probability or edge-claim
 * language is dropped. The old hand-set weights (55/25/20, 60/25/15) and
 * confidence (70/65/60) were never estimated from data.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { computeIvRvSnapshot } from "./ivRv";
import { buildGammaCurve } from "./gammaCurve";
import { buildCrossAssetMatrix } from "./crossAsset";
import { computeSkew } from "./skewEngine";
import { getFredSnapshot } from "./fredClient";
import { getCotSnapshot } from "./cotClient";
import { scoreAnomalyToday, computeDrift } from "./anomalyDetector";
import { getClvSummary } from "./clvTracker";
import { scrubBrief } from "./edgeBriefText";

export type PanelName =
  | "clv"
  | "iv-rv"
  | "gamma-curve"
  | "cross-asset"
  | "skew"
  | "macro-flow"
  | "anomaly"
  | "backtest"
  | "edge-synthesis";

export interface EdgeBrief {
  verdict: string;
  verdictColor: "emerald" | "rose" | "amber" | "neutral";
  edgeType: "informational" | "analytical" | "behavioral" | "timing" | "environmental" | "none";
  /** Always null: no hand-set confidence number (kept for API shape). */
  confidence: number | null;
  summary: string;
  /** Scenario theses; prob is always null (no hand-set weights). */
  baseCase: { thesis: string; prob: number | null };
  bullCase: { thesis: string; prob: number | null };
  bearCase: { thesis: string; prob: number | null };
  /** What to watch (descriptive); never trade, structure or size advice. */
  actionable: string;
  invalidation: string;
  counterargument: string;
  bullets: string[];
  panel: PanelName;
  asOf: number;
  source: "claude" | "openai" | "deterministic";
  /** Sentences or bullets dropped by the output filter (scrubBrief). */
  removedSentences?: number;
  contextSnapshot?: any;
}

const SYSTEM_PROMPT = `You are a senior quant writing a short internal note that DESCRIBES what one data panel shows. Voice: direct, plain english, lowercase is fine; a 15-year-old should follow the summary. never use emojis.

Hard rules (a filter deletes any sentence that breaks them):
- describe the data; do not recommend a trade. no buy/sell/long/short calls, no option structures (spreads, condors, straddles, calendars, collars), no hedging instructions.
- no position sizing of any kind (no "size up/down", no percentages of size, no Kelly).
- no probabilities, odds, likelihood percentages or confidence numbers. the panel scores are hand-set heuristics, not calibrated probabilities.
- do not claim an edge exists. say what the data shows and what would change the read. "insufficient data" is a valid answer.
- name the source and age of macro or sentiment context (FRED, CFTC COT); they are context, not price signals.

Return ONLY valid JSON matching this exact schema (no prose before/after, no code fences):
{
  "verdict": "1-3 word description of the reading",
  "verdictColor": "emerald" | "rose" | "amber" | "neutral",
  "edgeType": "informational" | "analytical" | "behavioral" | "timing" | "environmental" | "none",
  "summary": "2-4 sentences plain english describing the data",
  "baseCase": { "thesis": "what continues if nothing changes" },
  "bullCase": { "thesis": "the upside scenario" },
  "bearCase": { "thesis": "the downside scenario" },
  "actionable": "what to watch next (a level, a series or an event), never a trade",
  "invalidation": "condition that flips the read",
  "counterargument": "strongest opposing case",
  "bullets": ["2-5 short observations"]
}

Color guidance: emerald = reading leans favorable, rose = reading leans risk-off, amber = mixed, neutral = nothing notable or insufficient data.`;

function safeJsonParse(text: string): any | null {
  if (!text) return null;
  // strip code fences if model added them
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // try direct
  try { return JSON.parse(t); } catch {}
  // try first {...} block
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function callClaude(userPayload: string): Promise<any | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1400,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPayload }],
    });
    const block = msg.content.find((b: any) => b.type === "text");
    const text = (block as any)?.text ?? "";
    return safeJsonParse(text);
  } catch (e) {
    console.error("[edgeLabBrief] claude failed:", (e as any)?.message);
    return null;
  }
}

async function callOpenAi(userPayload: string): Promise<any | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const openai = new OpenAI();
    const r: any = await (openai.responses as any).create({
      model: "gpt-4o-mini",
      input: `${SYSTEM_PROMPT}\n\n---\n\n${userPayload}`,
    });
    const text = r.output_text ?? "";
    return safeJsonParse(text);
  } catch (e) {
    console.error("[edgeLabBrief] openai failed:", (e as any)?.message);
    return null;
  }
}

// Deterministic read when no LLM answers. Descriptive only (R3-2 item 7):
// no case weights, no confidence number, no trade / structure / size advice
// and no claim that an edge exists. `actionable` carries "what to watch".
function deterministicFallback(panel: PanelName, ctx: any): EdgeBrief {
  const base: EdgeBrief = {
    verdict: "data only",
    verdictColor: "neutral",
    edgeType: "none",
    confidence: null,
    summary: "",
    baseCase: { thesis: "", prob: null },
    bullCase: { thesis: "", prob: null },
    bearCase: { thesis: "", prob: null },
    actionable: "",
    invalidation: "",
    counterargument: "",
    bullets: [],
    panel,
    asOf: Date.now(),
    source: "deterministic",
    contextSnapshot: ctx,
  };
  const cases = (b: string, u: string, d: string) => {
    base.baseCase = { thesis: b, prob: null };
    base.bullCase = { thesis: u, prob: null };
    base.bearCase = { thesis: d, prob: null };
  };

  try {
    if (panel === "clv") {
      const e = ctx?.edge ?? {};
      const total = ctx?.counts?.graded ?? 0;
      const mean = e.meanBps ?? 0;
      const pos = e.positivePct ?? 0;
      const r20 = e.rolling20Bps ?? 0;
      if (total < 10) {
        base.verdict = "insufficient sample";
        base.verdictColor = "neutral";
        base.edgeType = "none";
        base.summary = `only ${total} graded fills logged. CLV on fewer than 30 fills is mostly noise.`;
        base.actionable = "watch: the graded count. the read means little before 30+ fills.";
        base.invalidation = "sample reaches 30 and the mean keeps its sign.";
        base.counterargument = "small samples can flatter or punish entries at random.";
        base.bullets = [`graded: ${total}`, `mean bps: ${mean.toFixed(1)}`, `positive%: ${pos.toFixed(0)}%`];
      } else if (mean > 2 && pos > 55) {
        base.verdict = "positive CLV";
        base.verdictColor = "emerald";
        base.edgeType = "informational";
        base.summary = `entries beat the close by ${mean.toFixed(1)} bps on average across ${total} fills, ${pos.toFixed(0)}% positive. descriptive only: no significance test or out-of-sample check is applied here.`;
        cases("CLV stays near its current mean", `rolling 20 (${r20.toFixed(1)} bps) stays above the full-sample mean`, "CLV regresses toward zero as the sample grows");
        base.actionable = `watch: rolling 20 (${r20.toFixed(1)} bps) against the full-sample mean.`;
        base.invalidation = "rolling 20 turns negative for 2 consecutive weeks.";
        base.counterargument = "CLV depends on the liquidity environment; a low-vol regime can flatter fills.";
        base.bullets = [`mean: +${mean.toFixed(1)} bps`, `positive: ${pos.toFixed(0)}%`, `rolling 20: ${r20.toFixed(1)} bps`, `total $: ${(e.totalDollars ?? 0).toFixed(0)}`];
      } else if (mean < -2) {
        base.verdict = "negative CLV";
        base.verdictColor = "rose";
        base.edgeType = "none";
        base.summary = `entries lose ${Math.abs(mean).toFixed(1)} bps to the close on average across ${total} fills: fills tend to come after the move.`;
        cases("execution lag persists", "rolling 20 turns positive", "the entry signal itself is late");
        base.actionable = "watch: timestamps of the last 20 entries vs the signal time (late fills or chasing).";
        base.invalidation = "rolling 20 flips positive for 2 weeks straight.";
        base.counterargument = "could be a regime mismatch rather than an execution problem.";
        base.bullets = [`mean: ${mean.toFixed(1)} bps`, `positive: ${pos.toFixed(0)}%`, `rolling 20: ${r20.toFixed(1)} bps`];
      } else {
        base.verdict = "flat CLV";
        base.verdictColor = "amber";
        base.edgeType = "none";
        base.summary = `CLV is near zero (${mean.toFixed(1)} bps): entries are neither ahead of nor behind the close on average.`;
        base.actionable = "watch: whether results come from exits or hold time rather than entries.";
        base.invalidation = "rolling 20 breaks above +3 bps or below -3 bps cleanly.";
        base.counterargument = "flat CLV with positive PnL is possible: exits or hold time may carry the result.";
        base.bullets = [`mean: ${mean.toFixed(1)} bps`, `positive: ${pos.toFixed(0)}%`, `total fills: ${total}`];
      }
    } else if (panel === "iv-rv") {
      const sym = ctx?.symbol ?? "";
      const v = ctx?.verdict ?? "";
      const r = ctx?.ratio;
      const ratioRaw = typeof r === "number" ? r : (r?.iv30_rv20 ?? r?.iv30_rv30 ?? r?.iv60_rv60);
      const ratio: number | null = (ratioRaw == null || !isFinite(Number(ratioRaw))) ? null : Number(ratioRaw);
      const iv30 = ctx?.iv?.iv30;
      const rv20 = ctx?.rv?.rv20;
      const ivStr = (iv30 == null) ? "n/a" : (iv30 * (iv30 < 5 ? 100 : 1)).toFixed(1) + "%";
      const rvStr = (rv20 == null) ? "n/a" : (rv20 * (rv20 < 5 ? 100 : 1)).toFixed(1) + "%";
      if (ratio == null || ratio <= 0 || v === "insufficient") {
        base.verdict = "insufficient data";
        base.verdictColor = "neutral";
        base.edgeType = "none";
        base.summary = `${sym} option chain or daily bars too thin to compare IV with RV right now. ${ctx?.notes ?? ""}`.trim();
        base.actionable = "watch: the chain during regular hours.";
        base.invalidation = "chain returns full data.";
        base.counterargument = "missing data is missing data: nothing to infer.";
        base.bullets = [`IV30: ${ivStr}`, `RV20: ${rvStr}`, `model: ${v}`];
      } else if (ratio > 1.25) {
        // IV above RV on average is the variance risk premium: Carr & Wu (2009),
        // "Variance Risk Premiums", Review of Financial Studies 22(3),
        // https://doi.org/10.1093/rfs/hhn038. A high ratio is therefore not by
        // itself a mispricing, and the brief does not call it an edge.
        base.verdict = "IV above RV";
        base.verdictColor = "amber";
        base.edgeType = "analytical";
        base.summary = `${sym} IV/RV is ${ratio.toFixed(2)}x: options price more volatility than the stock has realized over 20 days. IV usually sits above RV (the variance risk premium); the ratio alone does not say whether this premium is fair.`;
        cases("IV drifts toward RV", "IV falls after a scheduled event passes", "realized volatility rises to meet IV");
        base.actionable = "watch: RV over the next 5 sessions and any scheduled catalyst inside the expiry.";
        base.invalidation = "RV rises above IV.";
        base.counterargument = "IV is forward-looking: a known catalyst can justify the gap.";
        base.bullets = [`IV: ${ivStr}`, `RV20: ${rvStr}`, `ratio: ${ratio.toFixed(2)}x`];
      } else if (ratio < 0.85) {
        base.verdict = "IV below RV";
        base.verdictColor = "amber";
        base.edgeType = "analytical";
        base.summary = `${sym} IV/RV at ${ratio.toFixed(2)}x: options price less volatility than the stock has realized over 20 days.`;
        cases("IV rises toward RV", "volatility expands further on the next catalyst", "RV decays before IV moves");
        base.actionable = "watch: whether the recent realized moves continue or settle.";
        base.invalidation = "RV falls back under IV over the next 5 sessions.";
        base.counterargument = "low IV after a burst often means the market expects calm to return.";
        base.bullets = [`IV: ${ivStr}`, `RV20: ${rvStr}`, `ratio: ${ratio.toFixed(2)}x`];
      } else {
        base.verdict = "IV near RV";
        base.verdictColor = "neutral";
        base.edgeType = "none";
        base.summary = `${sym} IV/RV at ${ratio.toFixed(2)}x: implied and realized volatility are close.`;
        base.actionable = "watch: the ratio leaving the 0.85-1.25 band.";
        base.invalidation = "ratio breaks the band cleanly.";
        base.counterargument = "a ratio near 1 says nothing about direction.";
        base.bullets = [`IV: ${ivStr}`, `RV20: ${rvStr}`, `ratio: ${ratio.toFixed(2)}x`, v ? `model: ${v}` : ""].filter(Boolean) as string[];
      }
    } else if (panel === "gamma-curve") {
      const sym = ctx?.symbol ?? "";
      const spot = Number(ctx?.spot ?? NaN);
      const zg = Number(ctx?.zeroGamma ?? NaN);
      const asymObj = ctx?.asymmetry;
      const asymRatio = typeof asymObj === "number" ? asymObj : Number(asymObj?.asymmetryRatio ?? NaN);
      const bias = asymObj?.bias ?? "";
      const wall = ctx?.walls?.[0];
      if (!Number.isFinite(spot) || !Number.isFinite(zg) || zg <= 0) {
        base.verdict = "insufficient data";
        base.summary = `${sym} gamma curve unavailable${ctx?.error ? `: ${ctx.error}` : ""}.`;
        base.actionable = "watch: the chain during regular hours.";
      } else {
        const above = spot > zg;
        base.verdict = above ? "above zero-gamma" : "below zero-gamma";
        base.verdictColor = above ? "emerald" : "rose";
        base.edgeType = "environmental";
        base.summary = `${sym} ${spot.toFixed(2)} vs zero-gamma ${zg.toFixed(2)}: ${above ? "estimated dealer gamma is positive, so hedging flow tends to lean against moves (mean reversion, pinning)." : "estimated dealer gamma is negative, so hedging flow tends to add to moves (trending, acceleration into walls)."} the dealer sign is a model assumption, not observed positions.${wall ? ` nearest wall: ${wall.strike} (${wall.type ?? ""}).` : ""}`;
        cases(above ? "price stays inside the zero-gamma corridor" : "the move continues until a wall absorbs it",
          above ? "price pins near the largest call wall into expiry" : "a break through the nearest wall extends",
          above ? "a break below zero-gamma changes the regime" : "price reclaims zero-gamma and the regime flips");
        base.actionable = `watch: price relative to zero-gamma ${zg.toFixed(2)}${wall ? ` and the ${wall.strike} wall` : ""}.`;
        base.invalidation = above ? `clean break below ${zg.toFixed(2)} flips the regime` : `reclaim of ${zg.toFixed(2)} ends the short-gamma regime`;
        base.counterargument = "gamma is a positioning snapshot. macro shocks override dealer hedging flow.";
        base.bullets = [`spot: ${spot.toFixed(2)}`, `zero-γ: ${zg.toFixed(2)}`, Number.isFinite(asymRatio) ? `asym: ${asymRatio.toFixed(2)}` : "", bias ? `bias: ${bias}` : "", wall ? `wall: ${wall.strike}` : ""].filter(Boolean) as string[];
      }
    } else if (panel === "cross-asset") {
      const rv = ctx?.regimeVerdict;
      // regimeVerdict can be either a string or {label, confidence, risk, notes}
      const verdictLabel: string = typeof rv === "string" ? rv : (rv?.label ?? rv?.risk ?? "mixed");
      const rows = ctx?.rows ?? [];
      const isRisk = /risk-?on/i.test(verdictLabel);
      const isOff = /risk-?off/i.test(verdictLabel);
      base.verdict = verdictLabel;
      base.verdictColor = isRisk ? "emerald" : isOff ? "rose" : "amber";
      base.edgeType = "environmental";
      base.summary = `cross-asset matrix reads ${verdictLabel}. ${isRisk ? "stocks, credit and cyclicals are moving together." : isOff ? "bonds, dollar and gold are bid while equities and credit lag." : "correlations are decoupled: the regime is in transition."}`;
      cases(`${verdictLabel} regime persists near-term`, "correlations tighten in the current direction", "regime flips on the next macro print or liquidity event");
      base.actionable = "watch: whether the matrix verdict holds for 3+ sessions.";
      base.invalidation = "matrix flips verdict and holds 3+ sessions.";
      base.counterargument = "correlation is path-dependent. one liquidity event can rewrite the matrix.";
      base.bullets = [`regime: ${verdictLabel}`, `assets tracked: ${rows.length}`];
    } else if (panel === "skew") {
      const sym = ctx?.symbol ?? "";
      const raw = ctx?.skew25 ?? ctx?.skew?.skew25;
      const skew25 = raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
      const verdict = ctx?.verdict ?? "";
      if (skew25 == null) {
        base.verdict = "insufficient data";
        base.summary = `${sym} 25-delta skew unavailable${ctx?.error ? `: ${ctx.error}` : ""}.`;
        base.actionable = "watch: the chain during regular hours.";
      } else {
        const isFear = skew25 > 5;
        const isGreed = skew25 < -2;
        base.verdict = isFear ? "puts bid" : isGreed ? "calls bid" : "balanced";
        base.verdictColor = isFear ? "rose" : isGreed ? "emerald" : "neutral";
        base.edgeType = "behavioral";
        base.summary = `${sym} 25d skew ${skew25.toFixed(2)}. ${isFear ? "downside protection is priced above upside calls: demand for puts is high." : isGreed ? "upside calls are richer than puts: speculative call demand." : "skew is balanced: no extreme in either wing."}`;
        cases(isFear ? "skew compresses as protection demand fades" : isGreed ? "skew normalizes as call demand cools" : "skew stays in its current band", "skew moves back toward its usual level", "skew was right: a tail move prints");
        base.actionable = "watch: skew relative to its own recent range and any catalyst that explains it.";
        base.invalidation = "skew expands further past the current extreme.";
        base.counterargument = "skew often persists for valid macro reasons; a level alone is not a signal.";
        base.bullets = [`25d skew: ${skew25.toFixed(2)}`, verdict ? `model: ${verdict}` : ""].filter(Boolean) as string[];
      }
    } else if (panel === "macro-flow") {
      const f = ctx?.fred ?? {};
      const c = ctx?.cot ?? {};
      base.verdict = "macro snapshot";
      base.verdictColor = "neutral";
      base.edgeType = "environmental";
      const parts: string[] = [];
      if (f.dgs10) parts.push(`10y at ${f.dgs10}`);
      if (f.vixcls) parts.push(`VIX close (FRED) ${f.vixcls}`);
      if (f.dxy) parts.push(`DXY ${f.dxy}`);
      base.summary = `macro context (FRED, CFTC COT; daily or weekly, not live): ${parts.join(", ") || "data loading"}.${c?.summary ? " COT positioning: " + c.summary : ""}`;
      base.actionable = "watch: rates and dollar trend against any equity read.";
      base.invalidation = "10y above 5%, VIX above 25 or DXY above 110 marks a regime shift.";
      base.counterargument = "macro data lags intraday flow by days.";
      base.bullets = parts;
    } else if (panel === "anomaly") {
      const a = ctx?.anomaly ?? {};
      const dr = ctx?.drift ?? {};
      const pctRaw = a?.pctileVsHistory;
      const pct = pctRaw == null || !Number.isFinite(Number(pctRaw)) ? null : Number(pctRaw);
      if (pct == null) {
        base.verdict = "insufficient data";
        base.summary = `anomaly score unavailable${a?.error ? `: ${a.error}` : ""}.`;
        base.actionable = "watch: the feature history filling in.";
      } else {
        const score = pct / 10; // map 0-100 to 0-10 scale
        const drift = Number(dr?.driftScore ?? dr?.score ?? NaN);
        const isAnom = !!a?.isAnomaly || pct >= 95;
        const isHot = isAnom || score > 7;
        const isCold = score < 3;
        base.verdict = isHot ? "unusual tape" : isCold ? "baseline" : "mild";
        base.verdictColor = isHot ? "amber" : "neutral";
        base.edgeType = isHot ? "timing" : "none";
        base.summary = `today sits at the ${pct.toFixed(0)}th percentile vs history (score ${score.toFixed(1)}/10)${Number.isFinite(drift) ? `, drift ${drift.toFixed(2)}` : ""}. ${isHot ? "the market vector is statistically unusual against its history." : isCold ? "indicators are close to their baseline." : "mildly elevated."}`;
        base.actionable = isHot ? "watch: the closest analog dates and whether the unusual features persist." : "watch: nothing unusual in the feature vector.";
        base.invalidation = "score drops back under 5.";
        base.counterargument = "an anomaly score can flag noise as signal.";
        base.bullets = [`pctile: ${pct.toFixed(0)}`, `score: ${score.toFixed(1)}/10`, Number.isFinite(drift) ? `drift: ${drift.toFixed(2)}` : "", `analogs: ${(a?.closestDates?.length ?? 0)}`].filter(Boolean) as string[];
      }
    } else if (panel === "backtest") {
      const lr = ctx?.lastRun ?? {};
      const winRate = lr.winRate ?? 0;
      const pf = lr.profitFactor ?? 0;
      const trades = lr.trades ?? 0;
      const passes = trades >= 30 && winRate > 0.55 && pf > 1.4;
      base.verdict = trades < 30 ? "insufficient sample" : passes ? "in-sample positive" : "in-sample weak";
      base.verdictColor = trades < 30 ? "neutral" : passes ? "emerald" : "rose";
      base.edgeType = passes ? "analytical" : "none";
      base.summary = `${trades} trades, ${(winRate * 100).toFixed(0)}% win rate, PF ${pf.toFixed(2)}. ${trades < 30 ? "sample too small to say anything." : passes ? "in-sample results are positive; in-sample fit is not evidence of out-of-sample performance." : "in-sample results do not hold up."}`;
      base.actionable = "watch: the same rules on out-of-sample dates, with fees and spread.";
      base.invalidation = "out-of-sample win rate drops below 50% over 30+ trades.";
      base.counterargument = "backtest fit is half the story: slippage and missed fills cost real money.";
      base.bullets = [`trades: ${trades}`, `win: ${(winRate * 100).toFixed(0)}%`, `PF: ${pf.toFixed(2)}`];
    } else if (panel === "edge-synthesis") {
      const sigs: any[] = ctx?.signals ?? [];
      const conf = ctx?.confluence ?? { bullish: 0, bearish: 0, neutral: 0, total: 0 };
      const sym = ctx?.symbol ?? "SPY";
      const total = sigs.length || 1;
      const dominant = conf.bullish > conf.bearish + 1 ? "bullish" : conf.bearish > conf.bullish + 1 ? "bearish" : "mixed";
      const strong = Math.max(conf.bullish, conf.bearish) >= 4;

      base.verdict = dominant === "mixed" ? "mixed" : `${strong ? "broad" : "partial"} ${dominant === "bullish" ? "bull" : "bear"} agreement`;
      base.verdictColor = dominant === "bullish" ? "emerald" : dominant === "bearish" ? "rose" : "amber";
      base.edgeType = conf.neutral > total / 2 ? "none" : "environmental";
      base.summary = `${sym} read across ${total} edge panels: ${conf.bullish} bullish, ${conf.bearish} bearish, ${conf.neutral} neutral or mixed. the panels overlap (they share inputs), so agreement is not independent confirmation.`;
      cases(dominant === "mixed" ? "panels stay split" : `${dominant} agreement holds`, "more panels move to the bullish side", "more panels move to the bearish side");
      base.actionable = "watch: which panels flip first; two or more flipping inverts the read.";
      base.invalidation = "two or more panels flip direction.";
      base.counterargument = "a single macro or liquidity event can flip several panels at once.";
      base.bullets = sigs.slice(0, 6).map(s => `${s.label}: ${s.bias} (${s.value})`);
    } else {
      base.summary = "data loaded: no rule-based read available for this panel.";
      base.actionable = "watch: the panel data directly.";
    }
  } catch (e) {
    console.error("[edgeLabBrief] deterministic fallback error:", (e as any)?.message);
    base.summary = "data loaded but read layer hit an error. check the raw panel metrics.";
  }

  return base;
}

// ------- PANEL DATA BUILDERS -------

function buildClvContext(): any {
  const s = getClvSummary();
  return {
    panel: "clv",
    description: "Closing Line Value — measures whether trades got filled at better prices than the close. Descriptive; no significance test is applied.",
    counts: { total: s.count, graded: s.gradedCount },
    edge: {
      meanBps: Number(s.meanBps?.toFixed(2)),
      medianBps: Number(s.medianBps?.toFixed(2)),
      positivePct: Number(s.positivePct?.toFixed(1)),
      rolling20Bps: Number(s.rolling20Bps?.toFixed(2)),
      rolling50Bps: Number(s.rolling50Bps?.toFixed(2)),
      totalDollars: Number(s.totalDollars?.toFixed(2)),
    },
    bySignal: s.bySignal.slice(0, 8),
    bySymbol: s.bySymbol.slice(0, 8),
    recentSize: s.recent.length,
  };
}

async function buildIvRvContext(symbol: string): Promise<any> {
  const snap = await computeIvRvSnapshot(symbol);
  return {
    panel: "iv-rv",
    description: "compares implied vol (what option markets price in) to realized vol (what actually happened). IV usually exceeds RV (variance risk premium); the ratio alone does not say whether options are mispriced.",
    symbol: snap.symbol,
    spot: snap.spot,
    rv: snap.rv,
    iv: snap.iv,
    ratio: snap.ratio,
    verdict: snap.verdict,
    notes: snap.notes,
    cones: snap.rvCones,
  };
}

async function buildGammaContext(symbol: string): Promise<any> {
  const c = await buildGammaCurve(symbol);
  if ("error" in c) return { panel: "gamma-curve", error: c.error };
  return {
    panel: "gamma-curve",
    description: "Gamma exposure curve — estimated from open interest with an assumed dealer sign (not observed dealer positions). Walls = strikes with the largest exposure. Vacuums = strikes with little exposure.",
    symbol: c.symbol,
    spot: c.spot,
    zeroGamma: c.zeroGamma,
    asymmetry: c.asymmetry,
    walls: c.walls.slice(0, 6),
    vacuums: c.vacuums.slice(0, 3),
  };
}

function buildCrossAssetContext(): any {
  const m = buildCrossAssetMatrix();
  return {
    panel: "cross-asset",
    description: "cross-asset correlation matrix — confirms or breaks the macro regime read. risk-on means stocks/credit/cyclicals rally together. mixed/broken = decorrelation, regime change in motion.",
    rows: m.rows,
    regimeVerdict: m.regimeVerdict,
  };
}

async function buildSkewContext(symbol: string): Promise<any> {
  const s = await computeSkew(symbol);
  if ("error" in s) return { panel: "skew", error: s.error };
  return {
    panel: "skew",
    description: "options skew — is the market paying up for downside protection (negative RR = puts richer than calls = fear) or upside (positive RR = greed). term structure: contango = calm front, vol expected later. backwardation = front-month panic.",
    symbol: s.symbol,
    spot: s.spot,
    termStructure: s.termStructure,
    riskReversalNow: s.riskReversalNow,
    riskReversalNote: s.riskReversalNote,
    points: s.points.slice(0, 4),
  };
}

function buildMacroContext(): any {
  const fred = getFredSnapshot();
  const cot = getCotSnapshot();
  return {
    panel: "macro-flow",
    description: "FRED = official macro series (rates, fed balance sheet, credit spreads, financial conditions; daily or slower). CFTC COT = weekly futures positioning by trader category. Context only, not price signals.",
    fred: fred.slice(0, 18),
    cot: cot.slice(0, 9),
  };
}

function buildAnomalyContext(): any {
  const a = scoreAnomalyToday();
  const d = computeDrift();
  return {
    panel: "anomaly",
    description: "anomaly score = how far today's market vector sits from history. ≥95th percentile = unusual day, look at closest analogs. drift = is the model getting worse over time?",
    anomaly: "error" in a ? { error: a.error } : {
      pctileVsHistory: a.pctileVsHistory,
      isAnomaly: a.isAnomaly,
      features: a.features,
      closestDates: a.closestDates,
      notes: a.notes,
    },
    drift: d,
  };
}

// Edge synthesis: fuse all 7 market-edge panels into one combined view.
// Each panel produces a tagged signal (edge: bull/bear/neutral, weight, summary line).
// Confluence = multiple signals pointing the same direction = high confidence read.
async function buildEdgeSynthesisContext(symbol: string): Promise<any> {
  const sym = symbol || "SPY";
  // Run all panel context builders in parallel
  const [ivrv, gamma, cross, skew, macro, anomaly] = await Promise.all([
    buildIvRvContext(sym).catch((e: any) => ({ error: e?.message })),
    buildGammaContext(sym).catch((e: any) => ({ error: e?.message })),
    Promise.resolve(buildCrossAssetContext()).catch((e: any) => ({ error: e?.message })),
    buildSkewContext(sym).catch((e: any) => ({ error: e?.message })),
    Promise.resolve(buildMacroContext()).catch((e: any) => ({ error: e?.message })),
    Promise.resolve(buildAnomalyContext()).catch((e: any) => ({ error: e?.message })),
  ]);

  // Distill each panel into a normalized signal
  const signals: any[] = [];

  // 1) IV/RV — premium rich/cheap signal
  try {
    const r = ivrv?.ratio;
    const ratioRaw = typeof r === "number" ? r : (r?.iv30_rv20 ?? r?.iv30_rv30 ?? r?.iv60_rv60);
    const ratio = Number(ratioRaw) || 0;
    if (ratio > 0) {
      const bias = ratio > 1.25 ? "iv-above-rv" : ratio < 0.85 ? "iv-below-rv" : "neutral";
      signals.push({ key: "iv-rv", label: "IV vs RV", bias, value: ratio.toFixed(2) + "x", note: bias === "iv-above-rv" ? "options price more vol than realized" : bias === "iv-below-rv" ? "options price less vol than realized" : "IV close to realized" });
    } else {
      signals.push({ key: "iv-rv", label: "IV vs RV", bias: "insufficient", value: "n/a", note: "chain too thin to grade" });
    }
  } catch {}

  // 2) Gamma curve — dealer regime
  try {
    if (!gamma?.error) {
      const spot = Number(gamma?.spot ?? 0);
      const zg = Number(gamma?.zeroGamma ?? 0);
      const above = spot > zg && zg > 0;
      const bias = above ? "mean-revert" : "trending";
      const wall = gamma?.walls?.[0];
      signals.push({ key: "gamma-curve", label: "dealer gamma", bias, value: spot.toFixed(2) + " vs " + zg.toFixed(2), note: above ? "positive gamma — dealers fade moves, expect chop/pinning" : "negative gamma — dealers chase, expect trend acceleration", wall: wall?.strike ?? null });
    } else {
      signals.push({ key: "gamma-curve", label: "dealer gamma", bias: "insufficient", value: "n/a", note: gamma?.error });
    }
  } catch {}

  // 3) Cross-asset regime
  try {
    const rv = cross?.regimeVerdict;
    const verdictLabel = typeof rv === "string" ? rv : (rv?.label ?? rv?.risk ?? "mixed");
    const isRisk = /risk-?on/i.test(verdictLabel);
    const isOff = /risk-?off/i.test(verdictLabel);
    const bias = isRisk ? "risk-on" : isOff ? "risk-off" : "mixed";
    signals.push({ key: "cross-asset", label: "cross-asset", bias, value: verdictLabel, note: isRisk ? "stocks/credit/cyclicals confirming" : isOff ? "safe-haven bid, equities lagging" : "correlations decoupled — regime in transition" });
  } catch {}

  // 4) Skew — behavioral fear/greed
  try {
    if (!skew?.error) {
      const rr = Number(skew?.riskReversalNow ?? 0);
      // negative RR = puts richer = fear. positive RR = calls richer = greed
      const bias = rr < -1.5 ? "fear-priced" : rr > 1.5 ? "greed-priced" : "balanced";
      signals.push({ key: "skew", label: "skew RR", bias, value: rr.toFixed(2), note: bias === "fear-priced" ? "puts priced above calls: protection demand" : bias === "greed-priced" ? "calls richer than puts: speculative call demand" : "skew balanced, no extreme" });
    } else {
      signals.push({ key: "skew", label: "skew RR", bias: "insufficient", value: "n/a", note: skew?.error });
    }
  } catch {}

  // 5) Macro flow — regime context
  try {
    const fred = Array.isArray(macro?.fred) ? macro.fred : [];
    const findVal = (id: string) => {
      const f = fred.find((x: any) => (x?.seriesId ?? x?.id ?? "").toUpperCase() === id);
      return Number(f?.value ?? f?.latest ?? NaN);
    };
    const vix = findVal("VIXCLS");
    const dgs10 = findVal("DGS10");
    const dxy = findVal("DTWEXBGS");
    const parts: string[] = [];
    // FRED VIXCLS is the prior daily close (context only, not the live Schwab $VIX).
    if (isFinite(vix)) parts.push(`VIX close (FRED VIXCLS) ${vix.toFixed(1)}`);
    if (isFinite(dgs10)) parts.push(`10y ${dgs10.toFixed(2)}%`);
    if (isFinite(dxy)) parts.push(`DXY ${dxy.toFixed(1)}`);
    const bias = isFinite(vix) && vix > 22 ? "risk-off" : isFinite(vix) && vix < 14 ? "risk-on" : "mixed";
    signals.push({ key: "macro-flow", label: "macro", bias, value: parts.join(" · ") || "loading", note: "macro plumbing — regime input only, not standalone signal" });
  } catch {}

  // 6) Anomaly — timing/regime stability
  try {
    const a = anomaly?.anomaly ?? {};
    const pct = Number(a?.pctileVsHistory ?? 0);
    const isAnom = !!a?.isAnomaly || pct >= 95;
    const bias = isAnom ? "anomalous" : pct > 80 ? "elevated" : "baseline";
    signals.push({ key: "anomaly", label: "anomaly", bias, value: pct.toFixed(0) + "th pctile", note: isAnom ? "market vector statistically unusual vs history" : pct > 80 ? "mildly elevated" : "indicators near baseline" });
  } catch {}

  // Confluence scoring
  const bullishSignals = signals.filter(s => /iv-below-rv|mean-revert|risk-on|greed-priced/.test(s.bias)).length;
  const bearishSignals = signals.filter(s => /iv-above-rv|trending|risk-off|fear-priced|anomalous/.test(s.bias)).length;
  const neutralSignals = signals.filter(s => /neutral|mixed|balanced|baseline|elevated|insufficient/.test(s.bias)).length;

  return {
    panel: "edge-synthesis",
    description: "fused read across IV/RV, dealer gamma, cross-asset, skew, macro, anomaly. the panels share inputs, so agreement is not independent confirmation.",
    symbol: sym,
    signals,
    confluence: {
      bullish: bullishSignals,
      bearish: bearishSignals,
      neutral: neutralSignals,
      total: signals.length,
    },
  };
}

function buildBacktestContext(extra: any): any {
  // backtest is interactive, brief is for the LAST run if provided
  return {
    panel: "backtest",
    description: "vectorized signal backtest with realistic costs. Sharpe = annualized risk-adjusted return; Sortino punishes downside vol only. small sample with low Sharpe = noise.",
    lastRun: extra?.lastRun ?? null,
    note: extra?.lastRun ? "interpret this run" : "no run provided — give general backtest interpretation guidance",
  };
}

// ------- MAIN ENTRY -------

export async function generateEdgeBrief(
  panel: PanelName,
  symbol: string | null,
  extra?: any
): Promise<EdgeBrief> {
  let ctx: any;
  try {
    switch (panel) {
      case "clv": ctx = buildClvContext(); break;
      case "iv-rv": ctx = await buildIvRvContext(symbol || "SPY"); break;
      case "gamma-curve": ctx = await buildGammaContext(symbol || "SPY"); break;
      case "cross-asset": ctx = buildCrossAssetContext(); break;
      case "skew": ctx = await buildSkewContext(symbol || "SPY"); break;
      case "macro-flow": ctx = buildMacroContext(); break;
      case "anomaly": ctx = buildAnomalyContext(); break;
      case "backtest": ctx = buildBacktestContext(extra); break;
      case "edge-synthesis": ctx = await buildEdgeSynthesisContext(symbol || "SPY"); break;
      default: ctx = { panel, error: "unknown panel" };
    }
  } catch (e: any) {
    ctx = { panel, error: e?.message ?? "context build failed" };
  }

  const userPayload = `Panel: ${panel}
Symbol: ${symbol ?? "n/a"}
Timestamp: ${new Date().toISOString()}

DATA CONTEXT:
${JSON.stringify(ctx, null, 2)}

Read the data and describe it in the JSON schema: what it shows, what to watch next, and what would change the read. No trade, structure or size advice and no probabilities. The invalidation should name a real number or condition.`;

  // Try Claude first, then OpenAI, then deterministic
  let parsed = await callClaude(userPayload);
  let source: "claude" | "openai" | "deterministic" = "claude";
  if (!parsed) {
    parsed = await callOpenAi(userPayload);
    source = "openai";
  }
  if (!parsed) {
    return scrubBrief(deterministicFallback(panel, ctx));
  }

  // normalize
  const colorOk = ["emerald", "rose", "amber", "neutral"];
  const edgeOk = ["informational", "analytical", "behavioral", "timing", "environmental", "none"];

  const brief: EdgeBrief = {
    verdict: String(parsed.verdict ?? "—").slice(0, 40),
    verdictColor: colorOk.includes(parsed.verdictColor) ? parsed.verdictColor : "neutral",
    edgeType: edgeOk.includes(parsed.edgeType) ? parsed.edgeType : "none",
    // Any number the model returns for confidence or case weights is discarded.
    confidence: null,
    summary: String(parsed.summary ?? ""),
    baseCase: { thesis: String(parsed.baseCase?.thesis ?? "—"), prob: null },
    bullCase: { thesis: String(parsed.bullCase?.thesis ?? "—"), prob: null },
    bearCase: { thesis: String(parsed.bearCase?.thesis ?? "—"), prob: null },
    actionable: String(parsed.actionable ?? "—"),
    invalidation: String(parsed.invalidation ?? "—"),
    counterargument: String(parsed.counterargument ?? "—"),
    bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 6).map(String) : [],
    panel,
    asOf: Date.now(),
    source,
    contextSnapshot: ctx,
  };

  // LLM output: strict descriptive allow-list (deterministic text above is
  // code-reviewed and uses the deny-list only).
  return scrubBrief(brief, { strict: true });
}
