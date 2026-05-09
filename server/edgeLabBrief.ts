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
 *   confidence: 0..100,
 *   summary: string (2-4 sentences, plain english, 15-year-old understandable),
 *   baseCase: { thesis: string, prob: number },
 *   bullCase: { thesis: string, prob: number },
 *   bearCase: { thesis: string, prob: number },
 *   actionable: string,         // what a trader does with this RIGHT NOW
 *   invalidation: string,       // condition where the read flips
 *   counterargument: string,    // strongest opposing read
 *   bullets: string[]           // 2-5 short "what stands out" lines
 * }
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

export type PanelName =
  | "clv"
  | "iv-rv"
  | "gamma-curve"
  | "cross-asset"
  | "skew"
  | "macro-flow"
  | "anomaly"
  | "backtest";

export interface EdgeBrief {
  verdict: string;
  verdictColor: "emerald" | "rose" | "amber" | "neutral";
  edgeType: "informational" | "analytical" | "behavioral" | "timing" | "environmental" | "none";
  confidence: number;
  summary: string;
  baseCase: { thesis: string; prob: number };
  bullCase: { thesis: string; prob: number };
  bearCase: { thesis: string; prob: number };
  actionable: string;
  invalidation: string;
  counterargument: string;
  bullets: string[];
  panel: PanelName;
  asOf: number;
  source: "claude" | "openai" | "deterministic";
  contextSnapshot?: any;
}

const SYSTEM_PROMPT = `You are a senior quant + risk manager + advantage player writing internal briefs for a peer trader. Voice rules:

- direct, sharp, peer-to-peer, casual lowercase ("look", "the read here", "boss")
- never speak in absolutes — think probabilities, base/bull/bear with rough probability weights that sum to 100
- identify edge type on every brief: informational, analytical, behavioral, timing, environmental, or none
- if no edge exists, say "no edge — pass". passing is professional.
- every brief includes an actionable step, an invalidation level/condition, and the strongest counterargument
- a 15-year-old should understand the summary. no jargon dumps. if you use a term, briefly translate it.
- never use emojis
- never recommend oversizing. flat or fractional Kelly only
- "insufficient data" is a valid answer when the data is thin

Return ONLY valid JSON matching this exact schema (no prose before/after, no code fences):
{
  "verdict": "1-3 word call",
  "verdictColor": "emerald" | "rose" | "amber" | "neutral",
  "edgeType": "informational" | "analytical" | "behavioral" | "timing" | "environmental" | "none",
  "confidence": integer 0-100,
  "summary": "2-4 sentences plain english",
  "baseCase": { "thesis": "string", "prob": integer },
  "bullCase": { "thesis": "string", "prob": integer },
  "bearCase": { "thesis": "string", "prob": integer },
  "actionable": "what a trader does with this right now",
  "invalidation": "condition that flips the read",
  "counterargument": "strongest opposing case",
  "bullets": ["2-5 short observations"]
}

Probabilities for baseCase + bullCase + bearCase should sum to 100.
Color guidance: emerald = clear edge / favorable, rose = unfavorable / risk-off, amber = mixed / fair, neutral = no edge / insufficient data.`;

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

function deterministicFallback(panel: PanelName, ctx: any): EdgeBrief {
  const base: EdgeBrief = {
    verdict: "data only",
    verdictColor: "neutral",
    edgeType: "none",
    confidence: 0,
    summary: "",
    baseCase: { thesis: "", prob: 60 },
    bullCase: { thesis: "", prob: 20 },
    bearCase: { thesis: "", prob: 20 },
    actionable: "",
    invalidation: "",
    counterargument: "",
    bullets: [],
    panel,
    asOf: Date.now(),
    source: "deterministic",
    contextSnapshot: ctx,
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
        base.confidence = 20;
        base.summary = `only ${total} graded fills logged. need 30+ before CLV says anything real. log more trades, then check back.`;
        base.actionable = "keep logging fills with timestamps. revisit at 30+ samples.";
        base.invalidation = "sample reaches 30 and mean stays negative — that's a real signal, not noise.";
        base.counterargument = "small samples can flatter or punish you randomly. don't read into it yet.";
        base.bullets = [`graded: ${total}`, `mean bps: ${mean.toFixed(1)}`, `positive%: ${pos.toFixed(0)}%`];
      } else if (mean > 2 && pos > 55) {
        base.verdict = "real edge";
        base.verdictColor = "emerald";
        base.edgeType = "informational";
        base.confidence = 70;
        base.summary = `you're beating the close by ${mean.toFixed(1)} bps on average across ${total} fills, with ${pos.toFixed(0)}% positive. that's a skill signal — your entries are pricing in info before the market closes the gap.`;
        base.baseCase = { thesis: "current CLV edge persists at similar magnitude", prob: 60 };
        base.bullCase = { thesis: `rolling 20 (${r20.toFixed(1)} bps) confirms edge isn't decaying`, prob: 25 };
        base.bearCase = { thesis: "edge erodes as market adapts or sample regression hits", prob: 15 };
        base.actionable = "keep position sizing where it is. don't oversize on a hot streak — let the edge compound.";
        base.invalidation = "rolling 20 turns negative for 2 consecutive weeks.";
        base.counterargument = "CLV is path-dependent on liquidity environment. low-vol regime can flatter fills.";
        base.bullets = [`mean: +${mean.toFixed(1)} bps`, `positive: ${pos.toFixed(0)}%`, `rolling 20: ${r20.toFixed(1)} bps`, `total $: ${(e.totalDollars ?? 0).toFixed(0)}`];
      } else if (mean < -2) {
        base.verdict = "negative CLV";
        base.verdictColor = "rose";
        base.edgeType = "none";
        base.confidence = 65;
        base.summary = `you're losing ${Math.abs(mean).toFixed(1)} bps to the close on average. either entries are late or you're chasing — the market is fading you. fix execution before scaling size.`;
        base.baseCase = { thesis: "execution lag persists, slow bleed continues", prob: 55 };
        base.bullCase = { thesis: "recent process changes already turning rolling 20 around", prob: 20 };
        base.bearCase = { thesis: "adverse selection — edge thesis itself is wrong", prob: 25 };
        base.actionable = "cut size 50%. audit last 20 entries — late fills, chasing, or wrong-side adds?";
        base.invalidation = "rolling 20 flips positive for 2 weeks straight.";
        base.counterargument = "could be regime mismatch — strategy is fine, market just isn't paying for this style right now.";
        base.bullets = [`mean: ${mean.toFixed(1)} bps`, `positive: ${pos.toFixed(0)}%`, `rolling 20: ${r20.toFixed(1)} bps`];
      } else {
        base.verdict = "flat";
        base.verdictColor = "amber";
        base.edgeType = "none";
        base.confidence = 50;
        base.summary = `CLV is hovering near zero (${mean.toFixed(1)} bps). no informational edge in entries — you're a coin flip vs the close. profit has to come from sizing/exits, not entries.`;
        base.actionable = "focus on exit discipline and risk management. entries aren't your edge right now.";
        base.invalidation = "rolling 20 breaks above +3 bps or below -3 bps cleanly.";
        base.counterargument = "flat CLV with positive PnL is fine — exits or hold time may carry the edge.";
        base.bullets = [`mean: ${mean.toFixed(1)} bps`, `positive: ${pos.toFixed(0)}%`, `total fills: ${total}`];
      }
    } else if (panel === "iv-rv") {
      const sym = ctx?.symbol ?? "";
      const v = ctx?.verdict ?? "";
      const r = ctx?.ratio;
      const ratioRaw = typeof r === "number" ? r : (r?.iv30_rv20 ?? r?.iv30_rv30 ?? r?.iv60_rv60);
      const ratio: number = (ratioRaw == null || !isFinite(Number(ratioRaw))) ? 0 : Number(ratioRaw);
      const iv30 = ctx?.iv?.iv30;
      const rv20 = ctx?.rv?.rv20;
      const ivStr = (iv30 == null) ? "n/a" : (iv30 * (iv30 < 5 ? 100 : 1)).toFixed(1) + "%";
      const rvStr = (rv20 == null) ? "n/a" : (rv20 * (rv20 < 5 ? 100 : 1)).toFixed(1) + "%";
      if (!ratio || v === "insufficient") {
        base.verdict = "insufficient data";
        base.verdictColor = "neutral";
        base.edgeType = "none";
        base.confidence = 20;
        base.summary = `${sym} option chain or daily bars too thin to score IV/RV right now. ${ctx?.notes ?? ""}`;
        base.actionable = "wait for the chain to populate. retry during regular hours.";
        base.invalidation = "chain returns full data and ratio crosses 0.85 or 1.25.";
        base.counterargument = "missing data is missing data — don't infer.";
        base.bullets = [`IV30: ${ivStr}`, `RV20: ${rvStr}`, `model: ${v}`];
      } else if (ratio > 1.25) {
        base.verdict = "options rich";
        base.verdictColor = "emerald";
        base.edgeType = "analytical";
        base.confidence = 65;
        base.summary = `${sym} IV/RV ratio is ${ratio.toFixed(2)}x — options are pricing way more vol than the stock has actually delivered. premium sellers have edge here.`;
        base.baseCase = { thesis: "IV mean-reverts toward RV, premium decays in your favor", prob: 55 };
        base.bullCase = { thesis: "vol crush within days as event premium bleeds out", prob: 25 };
        base.bearCase = { thesis: "realized vol catches up — gap event prints, IV was right", prob: 20 };
        base.actionable = "sell premium structures (iron condors, credit spreads) sized small. defined risk only.";
        base.invalidation = "RV jumps above IV in next 5 sessions — vol regime shifted.";
        base.counterargument = "IV is forward-looking. if there's a known catalyst, the premium is fair.";
        base.bullets = [`IV: ${ivStr}`, `RV20: ${rvStr}`, `ratio: ${ratio.toFixed(2)}x`];
      } else if (ratio < 0.85) {
        base.verdict = "options cheap";
        base.verdictColor = "emerald";
        base.edgeType = "analytical";
        base.confidence = 60;
        base.summary = `${sym} IV/RV ratio at ${ratio.toFixed(2)}x — options are underpricing the actual movement. long premium has edge.`;
        base.baseCase = { thesis: "IV catches up to RV, long vol structures appreciate", prob: 50 };
        base.bullCase = { thesis: "vol expansion accelerates on next catalyst", prob: 30 };
        base.bearCase = { thesis: "RV decays before IV expands, theta bleed wins", prob: 20 };
        base.actionable = "long straddles or calendars on liquid expiries. small size, defined max loss.";
        base.invalidation = "RV collapses next 5 days while IV holds — thesis dies.";
        base.counterargument = "cheap IV often means market knows something is settling — don't fight known calm.";
        base.bullets = [`IV: ${ivStr}`, `RV20: ${rvStr}`, `ratio: ${ratio.toFixed(2)}x`];
      } else {
        base.verdict = "fair";
        base.verdictColor = "neutral";
        base.edgeType = "none";
        base.confidence = 40;
        base.summary = `${sym} IV/RV at ${ratio.toFixed(2)}x — options are roughly fair. no vol arb edge here. pass and look elsewhere.`;
        base.actionable = "no trade. wait for ratio to push above 1.25 or below 0.85.";
        base.invalidation = "ratio breaks the band cleanly.";
        base.counterargument = "fair IV doesn't mean no opportunity — directional setups still work.";
        base.bullets = [`IV: ${ivStr}`, `RV20: ${rvStr}`, `ratio: ${ratio.toFixed(2)}x`, v ? `model: ${v}` : ""].filter(Boolean) as string[];
      }
    } else if (panel === "gamma-curve") {
      const sym = ctx?.symbol ?? "";
      const spot = Number(ctx?.spot ?? 0);
      const zg = Number(ctx?.zeroGamma ?? 0);
      const asymObj = ctx?.asymmetry;
      const asymRatio = typeof asymObj === "number" ? asymObj : Number(asymObj?.asymmetryRatio ?? 0);
      const bias = asymObj?.bias ?? "";
      const above = spot > zg;
      base.verdict = above ? "positive gamma" : "negative gamma";
      base.verdictColor = above ? "emerald" : "rose";
      base.edgeType = "environmental";
      base.confidence = 60;
      const wall = ctx?.walls?.[0];
      base.summary = `${sym} ${spot.toFixed(2)} vs zero-gamma ${zg.toFixed(2)} — ${above ? "dealers long gamma, they sell rallies / buy dips. expect mean reversion and pinning." : "dealers short gamma, they chase moves. expect trending and acceleration into walls."}${wall ? ` nearest wall: ${wall.strike} (${wall.type ?? ""}).` : ""}`;
      base.baseCase = { thesis: above ? "chop in the zero-gamma corridor, fade extremes" : "trend continues until a wall absorbs it", prob: 55 };
      base.bullCase = { thesis: above ? "price pins to highest call wall into expiry" : "breakout through nearest wall triggers cascade", prob: 25 };
      base.bearCase = { thesis: above ? "flip below zero-gamma flips regime to trend" : "squeeze back through zero-gamma into pin", prob: 20 };
      base.actionable = above ? "fade wall touches with defined risk. avoid breakout chases." : "trade with the trend until walls. tight stops, no fades.";
      base.invalidation = above ? `clean break below ${zg.toFixed(2)} flips regime` : `reclaim of ${zg.toFixed(2)} ends short-gamma trend`;
      base.counterargument = "gamma is a positioning snapshot. fundamentals or macro shocks override dealer flow.";
      base.bullets = [`spot: ${spot.toFixed(2)}`, `zero-γ: ${zg.toFixed(2)}`, `asym: ${asymRatio.toFixed(2)}`, bias ? `bias: ${bias}` : "", wall ? `wall: ${wall.strike}` : ""].filter(Boolean) as string[];
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
      base.confidence = 55;
      base.summary = `cross-asset matrix says ${verdictLabel}. ${isRisk ? "stocks, credit, cyclicals moving together — clean risk-on tape, lean into longs." : isOff ? "safe-haven bid in bonds/dollar/gold while equities/credit lag — defensive regime, trim risk." : "correlations are decoupled — regime is in transition. wait for confirmation before taking macro views."}`;
      base.baseCase = { thesis: `${verdictLabel} regime persists near-term`, prob: 55 };
      base.bullCase = { thesis: "correlations tighten in current direction, trend extends", prob: 25 };
      base.bearCase = { thesis: "regime flip on next macro print or liquidity event", prob: 20 };
      base.actionable = isRisk ? "size up directional longs in equities/credit. tight stops on bonds." : isOff ? "reduce equity beta. bonds/gold/dollar have edge." : "smaller size across the board until matrix confirms direction.";
      base.invalidation = "matrix flips verdict and holds 3+ sessions.";
      base.counterargument = "correlation is path-dependent. one liquidity event can rewrite the whole matrix.";
      base.bullets = [`regime: ${verdictLabel}`, `assets tracked: ${rows.length}`];
    } else if (panel === "skew") {
      const sym = ctx?.symbol ?? "";
      const skew25 = Number(ctx?.skew25 ?? ctx?.skew?.skew25 ?? 0);
      const verdict = ctx?.verdict ?? "";
      const isFear = skew25 > 5;
      const isGreed = skew25 < -2;
      base.verdict = isFear ? "put fear bid" : isGreed ? "call greed bid" : "balanced";
      base.verdictColor = isFear ? "rose" : isGreed ? "emerald" : "neutral";
      base.edgeType = "behavioral";
      base.confidence = 55;
      base.summary = `${sym} 25d skew ${skew25.toFixed(2)}. ${isFear ? "crowd is paying up for downside protection — fear is priced. classic fade-the-skew setup." : isGreed ? "upside calls richer than puts — speculative greed. reversal often follows." : "skew is balanced — no behavioral extreme to fade."}`;
      base.baseCase = { thesis: isFear ? "skew compresses as fear unwinds" : isGreed ? "skew normalizes as call demand cools" : "skew chops in current band", prob: 55 };
      base.bullCase = { thesis: "contrarian setup pays — fade succeeds", prob: 25 };
      base.bearCase = { thesis: "skew is right — tail event prints", prob: 20 };
      base.actionable = isFear ? "sell put spreads / put ratio if you're directional bullish." : isGreed ? "sell call spreads or buy puts on the upside extreme." : "no skew trade. look elsewhere.";
      base.invalidation = "skew expands further past current extreme — crowd was right.";
      base.counterargument = "skew often persists for valid macro reasons. don't fade on level alone — need a catalyst.";
      base.bullets = [`25d skew: ${skew25.toFixed(2)}`, verdict ? `model: ${verdict}` : ""].filter(Boolean) as string[];
    } else if (panel === "macro-flow") {
      const f = ctx?.fred ?? {};
      const c = ctx?.cot ?? {};
      base.verdict = "macro snapshot";
      base.verdictColor = "neutral";
      base.edgeType = "environmental";
      base.confidence = 50;
      const parts: string[] = [];
      if (f.dgs10) parts.push(`10y at ${f.dgs10}`);
      if (f.vixcls) parts.push(`VIX ${f.vixcls}`);
      if (f.dxy) parts.push(`DXY ${f.dxy}`);
      base.summary = `macro stack: ${parts.join(", ") || "data loading"}. use as regime input — ${c?.summary ? "COT positioning shows " + c.summary : "check positioning before sizing macro views."}`;
      base.actionable = "frame your trades against this regime. don't fight rates/dollar trends without a clear catalyst.";
      base.invalidation = "key levels break: 10y above 5%, VIX above 25, DXY above 110 = regime shift.";
      base.counterargument = "macro signals lag intraday flow. don't trade off macro alone — pair with technicals.";
      base.bullets = parts;
    } else if (panel === "anomaly") {
      const a = ctx?.anomaly ?? {};
      const dr = ctx?.drift ?? {};
      const pct = Number(a?.pctileVsHistory ?? 0);
      const score = pct / 10; // map 0-100 to 0-10 scale
      const driftScore = Number(dr?.driftScore ?? dr?.score ?? 0);
      const isAnom = !!a?.isAnomaly || pct >= 95;
      const isHot = isAnom || score > 7;
      const isCold = score < 3;
      const drift = driftScore;
      base.verdict = isHot ? "anomalous tape" : isCold ? "baseline" : "mild";
      base.verdictColor = isHot ? "amber" : "neutral";
      base.edgeType = isHot ? "timing" : "none";
      base.confidence = isHot ? 60 : 40;
      base.summary = `today sits at the ${pct.toFixed(0)}th percentile vs history (score ${score.toFixed(1)}/10), drift ${drift.toFixed(2)}. ${isHot ? "tape is statistically unusual — something's moving the model didn't expect. tighten risk and watch for follow-through." : isCold ? "normal regime, indicators aligned with baseline. no urgency." : "mildly elevated — keep eyes open but no action required."}`;
      base.actionable = isHot ? "cut size or use defined-risk only. anomaly days punish complacency." : "trade your normal book.";
      base.invalidation = "score drops back under 5 — tape normalized.";
      base.counterargument = "anomaly score can flag noise as signal. wait for confirmation before reacting hard.";
      base.bullets = [`pctile: ${pct.toFixed(0)}`, `score: ${score.toFixed(1)}/10`, `drift: ${drift.toFixed(2)}`, `analogs: ${(a?.closestDates?.length ?? 0)}`];
    } else if (panel === "backtest") {
      const lr = ctx?.lastRun ?? {};
      const winRate = lr.winRate ?? 0;
      const pf = lr.profitFactor ?? 0;
      const trades = lr.trades ?? 0;
      const isGood = winRate > 0.55 && pf > 1.4;
      base.verdict = isGood ? "backtest passes" : trades < 30 ? "insufficient sample" : "weak";
      base.verdictColor = isGood ? "emerald" : trades < 30 ? "neutral" : "rose";
      base.edgeType = isGood ? "analytical" : "none";
      base.confidence = trades < 30 ? 25 : isGood ? 65 : 60;
      base.summary = `${trades} trades, ${(winRate * 100).toFixed(0)}% win rate, PF ${pf.toFixed(2)}. ${isGood ? "strategy has historical edge. forward-test small size before committing capital." : trades < 30 ? "sample too small for confidence. need 100+ trades minimum to trust the result." : "edge isn't there in-sample. don't deploy."}`;
      base.actionable = isGood ? "paper-trade or 25% size for 4 weeks. confirm forward." : "don't deploy. iterate the rules or kill it.";
      base.invalidation = "out-of-sample win rate drops below 50% over 30+ trades.";
      base.counterargument = "backtest fit is half the story. live execution friction (slippage, missed fills) eats edge fast.";
      base.bullets = [`trades: ${trades}`, `win: ${(winRate * 100).toFixed(0)}%`, `PF: ${pf.toFixed(2)}`];
    } else {
      base.summary = "data loaded — no rule-based read available for this panel.";
      base.actionable = "read the panel data directly.";
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
    description: "Closing Line Value — measures whether trades got filled at better prices than the close. Positive CLV = real skill edge.",
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
    description: "compares implied vol (what option markets price in) to realized vol (what actually happened). Rich = options expensive, sell premium edge. Cheap = options cheap, buy premium edge.",
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
    description: "Gamma exposure curve — where dealers have the most options exposure. Walls = price magnets. Vacuums = thin pockets where price moves fast. Asymmetry tells you bias.",
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
    description: "FRED = official macro plumbing (rates, fed balance sheet, credit spreads, financial conditions). COT = how big specs are positioned in futures — extremes mean-revert.",
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

Read the data, identify the edge type (or say "no edge — pass"), and write a peer brief in the JSON schema. The summary should be the kind of thing a sharp trader friend would tell another trader in 3 sentences. The actionable line should be specific. The invalidation should name a real number or condition.`;

  // Try Claude first, then OpenAI, then deterministic
  let parsed = await callClaude(userPayload);
  let source: "claude" | "openai" | "deterministic" = "claude";
  if (!parsed) {
    parsed = await callOpenAi(userPayload);
    source = "openai";
  }
  if (!parsed) {
    return deterministicFallback(panel, ctx);
  }

  // normalize
  const colorOk = ["emerald", "rose", "amber", "neutral"];
  const edgeOk = ["informational", "analytical", "behavioral", "timing", "environmental", "none"];

  const brief: EdgeBrief = {
    verdict: String(parsed.verdict ?? "—").slice(0, 40),
    verdictColor: colorOk.includes(parsed.verdictColor) ? parsed.verdictColor : "neutral",
    edgeType: edgeOk.includes(parsed.edgeType) ? parsed.edgeType : "none",
    confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
    summary: String(parsed.summary ?? ""),
    baseCase: {
      thesis: String(parsed.baseCase?.thesis ?? "—"),
      prob: Math.max(0, Math.min(100, Number(parsed.baseCase?.prob) || 0)),
    },
    bullCase: {
      thesis: String(parsed.bullCase?.thesis ?? "—"),
      prob: Math.max(0, Math.min(100, Number(parsed.bullCase?.prob) || 0)),
    },
    bearCase: {
      thesis: String(parsed.bearCase?.thesis ?? "—"),
      prob: Math.max(0, Math.min(100, Number(parsed.bearCase?.prob) || 0)),
    },
    actionable: String(parsed.actionable ?? "—"),
    invalidation: String(parsed.invalidation ?? "—"),
    counterargument: String(parsed.counterargument ?? "—"),
    bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 6).map(String) : [],
    panel,
    asOf: Date.now(),
    source,
    contextSnapshot: ctx,
  };

  return brief;
}
