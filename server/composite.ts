/**
 * Composite sentiment score. Maps each raw signal to a 0..100 sub-score
 * (0 = extreme fear, 50 = neutral, 100 = extreme greed), then combines
 * by weights. Weights are transparent so the user can reason about them.
 *
 * De-duplication (review finding 5.5). VIX, VVIX, the 9D/30D term ratio and
 * SKEW are all reads of one implied-vol factor, and CNN Fear & Greed itself
 * contains VIX and the put/call ratio (2 of its 7 indicators,
 * https://edition.cnn.com/markets/fear-and-greed). Averaging them as if
 * independent gave the vol factor about half the score. Gauges are grouped
 * into blocks and weighted block first, then within the block, so adding
 * another vol gauge cannot raise the vol factor's share.
 *
 * Two weight sources:
 *  1. ESTIMATED (preferred): estimateGaugeWeights() on the daily history of
 *     gauge sub-scores stored in the snapshots table. Hierarchical risk
 *     parity with the blocks as fixed clusters (Lopez de Prado 2016,
 *     "Building Diversified Portfolios that Outperform Out of Sample",
 *     https://papers.ssrn.com/abstract=2708678): inverse-variance weights of
 *     the daily sub-score changes within a block, then inverse block
 *     variance between blocks, on a Ledoit-Wolf constant-correlation shrunk
 *     covariance. Used only when the sample gate passes (>= 60 daily
 *     changes on complete days). Reports the effective number of
 *     independent gauges, (sum w)^2 / (w' R w).
 *  2. HAND-SET (until the gate passes): fixed block weights below, labelled
 *     a heuristic; F&G's block weight is cut by its 2/7 overlap. No method
 *     citation is claimed for these numbers.
 * The score is a heuristic sentiment reading, not a probability.
 */
import type { Composite, Gauge, Snapshot_Public } from "@shared/schema";
import { ledoitWolfConstantCorrelation } from "./macroStats";

/** Clamp to 0..100. */
const clamp = (v: number) => Math.max(0, Math.min(100, v));

export type GaugeBlock = "implied-vol" | "options-positioning" | "crowd" | "fear-greed";

/** Block weights (hand-set heuristic). Sum 1 before F&G's overlap haircut. */
export const BLOCK_WEIGHTS: Record<GaugeBlock, number> = {
  "implied-vol": 0.30,          // VIX, VVIX, term, SKEW: one factor
  "options-positioning": 0.30,  // put/call OI, dealer gamma
  "crowd": 0.25,                // social, AAII, curated voices
  "fear-greed": 0.15 * (5 / 7), // CNN F&G minus its VIX and put/call components
};

/**
 * Hierarchical weights: each present block gets its block weight, shared
 * among its present gauges by their intra-block weights; everything is then
 * renormalized over the blocks present. Pure, exported for tests.
 */
export function blockWeights(gauges: Array<{ block: GaugeBlock; intra: number }>): number[] {
  const intraSum = new Map<GaugeBlock, number>();
  for (const g of gauges) intraSum.set(g.block, (intraSum.get(g.block) ?? 0) + g.intra);
  let total = 0;
  for (const [b, v] of Array.from(intraSum.entries())) if (v > 0) total += BLOCK_WEIGHTS[b];
  if (total <= 0) return gauges.map(() => 0);
  return gauges.map((g) => {
    const v = intraSum.get(g.block) ?? 0;
    return v > 0 ? (BLOCK_WEIGHTS[g.block] / total) * (g.intra / v) : 0;
  });
}

// ─── Estimated weights from gauge history ─────────────────────────────────

/** Gauge name -> block (names as computeComposite writes them). */
export const GAUGE_BLOCK: Record<string, GaugeBlock> = {
  "VIX Level": "implied-vol",
  "VVIX (Vol-of-Vol)": "implied-vol",
  "Term Structure (9D/30D)": "implied-vol",
  "SKEW Index": "implied-vol",
  "Put/Call OI (0-45 DTE)": "options-positioning",
  "Dealer Gamma Regime": "options-positioning",
  "Social Sentiment (StockTwits + Reddit)": "crowd",
  "AAII Bull-Bear Spread": "crowd",
  "Curated Voices Bias": "crowd",
  "CNN Fear & Greed": "fear-greed",
};

export const WEIGHT_MIN_DAYS = 60;

export interface EstimatedGaugeWeights {
  method: "hrp-blocks";
  /** daily sub-score changes used (complete days) */
  days: number;
  /** effective weight per gauge name, summing to 1 */
  weights: Record<string, number>;
  blockWeights: Partial<Record<GaugeBlock, number>>;
  /** (sum w)^2 / (w' R w) with R the correlation of daily sub-score changes */
  effectiveN: number;
  gauges: string[];
}

/**
 * HRP with fixed clusters on daily gauge sub-score CHANGES (levels are
 * persistent and would show spurious correlation). `history` = one row per
 * ET day, gauge name -> 0..100 sub-score (missing gauges absent). Gauges
 * observed on fewer than WEIGHT_MIN_DAYS + 1 days are left out; the
 * remaining gauges must share >= WEIGHT_MIN_DAYS complete day-to-day
 * changes, otherwise the gate fails (ok: false with the reason).
 */
export function estimateGaugeWeights(
  history: Array<Record<string, number>>,
): { ok: true; est: EstimatedGaugeWeights } | { ok: false; reason: string; days: number } {
  const names = Object.keys(GAUGE_BLOCK).filter((n) => history.filter((h) => Number.isFinite(h[n])).length >= WEIGHT_MIN_DAYS + 1);
  if (names.length < 2) return { ok: false, reason: `fewer than 2 gauges with ${WEIGHT_MIN_DAYS + 1}+ days of history`, days: 0 };
  const D: number[][] = [];
  for (let t = 1; t < history.length; t++) {
    const a = history[t - 1], b = history[t];
    if (names.every((n) => Number.isFinite(a[n]) && Number.isFinite(b[n]))) D.push(names.map((n) => b[n] - a[n]));
  }
  if (D.length < WEIGHT_MIN_DAYS) return { ok: false, reason: `${D.length} complete daily changes (need ${WEIGHT_MIN_DAYS})`, days: D.length };
  const lw = ledoitWolfConstantCorrelation(D);
  if (!lw) return { ok: false, reason: "covariance not estimable (a gauge never changed)", days: D.length };
  const S = lw.cov;
  const blocks = Array.from(new Set(names.map((n) => GAUGE_BLOCK[n])));
  const within: Record<string, number> = {};
  const blockVar: Partial<Record<GaugeBlock, number>> = {};
  for (const b of blocks) {
    const idx = names.map((n, i) => (GAUGE_BLOCK[n] === b ? i : -1)).filter((i) => i >= 0);
    const inv = idx.map((i) => 1 / S[i][i]);
    const tot = inv.reduce((x, y) => x + y, 0);
    const w = inv.map((v) => v / tot);
    idx.forEach((i, k) => { within[names[i]] = w[k]; });
    let v = 0;
    for (let a = 0; a < idx.length; a++) for (let c = 0; c < idx.length; c++) v += w[a] * w[c] * S[idx[a]][idx[c]];
    blockVar[b] = v;
  }
  const invB = blocks.map((b) => 1 / (blockVar[b] as number));
  const totB = invB.reduce((x, y) => x + y, 0);
  const bw: Partial<Record<GaugeBlock, number>> = {};
  blocks.forEach((b, k) => { bw[b] = invB[k] / totB; });
  const weights: Record<string, number> = {};
  for (const n of names) weights[n] = (bw[GAUGE_BLOCK[n]] as number) * within[n];
  const sd = names.map((_, i) => Math.sqrt(S[i][i]));
  const wv = names.map((n) => weights[n]);
  let q = 0;
  for (let i = 0; i < names.length; i++) for (let j = 0; j < names.length; j++) q += wv[i] * wv[j] * S[i][j] / (sd[i] * sd[j]);
  return { ok: true, est: { method: "hrp-blocks", days: D.length, weights, blockWeights: bw, effectiveN: 1 / q, gauges: names } };
}

/**
 * VIX sub-score: low VIX = greed (high score), high VIX = fear.
 * Calibration: 12 → 90 (complacent), 20 → 50, 30 → 20, 40+ → 5.
 */
function vixScore(vix: number): number {
  // Piecewise linear
  if (vix <= 12) return 90;
  if (vix <= 20) return 90 - ((vix - 12) / 8) * 40;       // 90 → 50
  if (vix <= 30) return 50 - ((vix - 20) / 10) * 30;      // 50 → 20
  if (vix <= 40) return 20 - ((vix - 30) / 10) * 15;      // 20 → 5
  return 5;
}

/**
 * VVIX (vol-of-vol). Typical range 80-140. Elevated VVIX = stress on VIX options.
 * 80 → 70, 100 → 50, 120 → 30, 150 → 10.
 */
function vvixScore(v: number): number {
  if (v <= 80) return 70;
  if (v <= 100) return 70 - ((v - 80) / 20) * 20;
  if (v <= 120) return 50 - ((v - 100) / 20) * 20;
  if (v <= 150) return 30 - ((v - 120) / 30) * 20;
  return 10;
}

/** Term-structure: VIX9D/VIX. Backwardation (>1) = near-term stress. */
function termScore(ratio9d30d: number): number {
  if (ratio9d30d <= 0.80) return 85;   // deep contango, complacent
  if (ratio9d30d <= 0.90) return 75;
  if (ratio9d30d <= 1.00) return 60;
  if (ratio9d30d <= 1.10) return 35;
  if (ratio9d30d <= 1.25) return 20;
  return 10;
}

/** SKEW: 100-125 normal, >140 tail risk priced in. Higher = more hedging = fear. */
function skewScore(sk: number): number {
  if (sk <= 110) return 70;
  if (sk <= 130) return 60 - ((sk - 110) / 20) * 10;  // 60→50
  if (sk <= 150) return 50 - ((sk - 130) / 20) * 20;  // 50→30
  return 25;
}

/**
 * PCR open interest for 0-45 DTE. >1.5 = heavy hedge demand (fear).
 * <0.7 = call-heavy (greed).
 */
function pcrScore(pcr: number): number {
  if (pcr <= 0.6) return 85;
  if (pcr <= 0.9) return 70 - ((pcr - 0.6) / 0.3) * 15;  // 70→55
  if (pcr <= 1.2) return 55 - ((pcr - 0.9) / 0.3) * 15;  // 55→40
  if (pcr <= 1.8) return 40 - ((pcr - 1.2) / 0.6) * 15;  // 40→25
  if (pcr <= 2.5) return 25 - ((pcr - 1.8) / 0.7) * 10;  // 25→15
  return 15;
}

/**
 * Gamma regime: positive gamma = stable / calm (leans greed), negative = reflexive (leans fear).
 * Use total GEX normalized roughly by magnitude.
 */
function gammaScore(totalGex: number): number {
  const bn = totalGex / 1e9; // in $B per 1%
  if (bn >= 2) return 75;
  if (bn >= 0.5) return 65;
  if (bn >= 0) return 55;
  if (bn >= -0.5) return 45;
  if (bn >= -2) return 30;
  return 20;
}

/** Social sentiment score is already -100..+100 → map to 0..100. */
function socialScore(s: number): number {
  return clamp(50 + s / 2);
}

export function computeComposite(
  snap: Omit<Snapshot_Public, "composite">,
  voicesBias?: { score: number; sampleSize: number } | null,
  estimated?: { ok: true; est: EstimatedGaugeWeights } | { ok: false; reason: string; days: number } | null,
): Composite {
  // `weight` here is the INTRA-block weight; blockWeights() turns it into
  // the effective composite weight below.
  const gauges: Array<Gauge & { block: GaugeBlock }> = [];

  const vix = snap.vol.vix.value;
  if (vix != null) {
    const v = clamp(vixScore(vix));
    gauges.push({
      name: "VIX Level",
      value: v,
      block: "implied-vol",
      weight: 0.45,
      interpretation:
        vix < 14 ? "Complacent — cheap hedges, low realized vol expected"
        : vix < 20 ? "Calm — normal range, positioning friendly"
        : vix < 28 ? "Elevated — hedging demand, wider daily ranges"
        : "Stress — risk-off regime, expect large intraday swings",
    });
  }

  const vvix = snap.vol.vvix.value;
  if (vvix != null) {
    gauges.push({
      name: "VVIX (Vol-of-Vol)",
      value: clamp(vvixScore(vvix)),
      block: "implied-vol",
      weight: 0.15,
      interpretation:
        vvix < 90 ? "VIX options cheap — tail risk under-priced"
        : vvix < 110 ? "Normal VIX options pricing"
        : vvix < 130 ? "Upside VIX calls bid — hedgers active"
        : "Tail-hedge panic — VIX options unusually rich",
    });
  }

  const r = snap.term.ratio9dOver30d;
  if (r != null) {
    gauges.push({
      name: "Term Structure (9D/30D)",
      value: clamp(termScore(r)),
      block: "implied-vol",
      weight: 0.25,
      interpretation:
        r < 0.9 ? "Deep contango — front-end calm, trend-friendly"
        : r < 1.0 ? "Normal contango"
        : r < 1.1 ? "Flat / mild backwardation — near-term event risk"
        : "Backwardation — acute near-term fear",
    });
  }

  const skew = snap.vol.skew.value;
  if (skew != null) {
    gauges.push({
      name: "SKEW Index",
      value: clamp(skewScore(skew)),
      block: "implied-vol",
      weight: 0.15,
      interpretation:
        skew < 120 ? "Tail risk under-priced"
        : skew < 140 ? "Normal skew"
        : skew < 155 ? "Elevated tail-hedging demand"
        : "Extreme crash-protection bid",
    });
  }

  gauges.push({
    name: "Put/Call OI (0-45 DTE)",
    value: clamp(pcrScore(snap.gamma.pcrOi)),
    block: "options-positioning",
    weight: 0.45,
    interpretation:
      snap.gamma.pcrOi < 0.8 ? "Call-heavy — speculative greed"
      : snap.gamma.pcrOi < 1.2 ? "Balanced"
      : snap.gamma.pcrOi < 1.8 ? "Put-heavy — hedging bias"
      : "Very put-heavy — defensive positioning dominates",
  });

  gauges.push({
    name: "Dealer Gamma Regime",
    value: clamp(gammaScore(snap.gamma.totalGex)),
    block: "options-positioning",
    weight: 0.55,
    interpretation:
      snap.gamma.regime === "positive"
        ? `Positive gamma — dealers buy dips / sell rips. Mean-reversion regime. Call wall at ${snap.gamma.callWall}.`
        : snap.gamma.regime === "negative"
        ? `Negative gamma — dealers amplify moves. Trend / breakout regime. Put wall at ${snap.gamma.putWall}.`
        : "Near gamma flip — unstable regime",
  });

  // Social gauge only when collection produced a score. A failed, stale or
  // too-small sample is left out (weights renormalise below) instead of
  // entering as a neutral 50.
  const socialRaw = snap.social.score;
  if (socialRaw != null && Number.isFinite(socialRaw)) {
    gauges.push({
      name: "Social Sentiment (StockTwits + Reddit)", // history key: do not rename
      label: "Social Sentiment (StockTwits)", // display text
      value: clamp(socialScore(socialRaw)),
      block: "crowd",
      weight: 0.40,
      interpretation:
        (socialRaw > 30 ? "Retail chatter skews bullish"
        : socialRaw > -30 ? "Retail chatter mixed"
        : "Retail chatter skews bearish") + (snap.social.status === "partial" ? " (partial: a source failed or was stale)" : ""),
    });
  }

  // A stale or undated CNN reading is left out (not scored as current).
  if (snap.fearGreed && !snap.fearGreed.stale) {
    gauges.push({
      name: "CNN Fear & Greed",
      value: snap.fearGreed.value,
      block: "fear-greed",
      weight: 1,
      interpretation: `CNN index: ${snap.fearGreed.label}${snap.fearGreed.asOf ? ` (as of ${snap.fearGreed.asOf.slice(0, 10)})` : ""}`,
    });
  }

  if (snap.aaii) {
    const net = snap.aaii.bullish - snap.aaii.bearish; // percentage points
    // map -40..+40 to 10..90
    const v = clamp(50 + net * 1.0);
    gauges.push({
      name: "AAII Bull-Bear Spread",
      value: v,
      block: "crowd",
      weight: 0.25,
      interpretation:
        net > 20 ? "Retail survey very bullish (contrarian bearish)"
        : net > 0 ? "Retail survey leans bullish"
        : net > -20 ? "Retail survey leans bearish"
        : "Retail survey very bearish (contrarian bullish)",
    });
  }

  // Curated Voices bias: weighted net sentiment from analyst tweets/feeds.
  // Only contributes if we have a meaningful sample.
  if (voicesBias && voicesBias.sampleSize >= 5) {
    const v = clamp(50 + voicesBias.score / 2);
    gauges.push({
      name: "Curated Voices Bias",
      value: v,
      block: "crowd",
      weight: 0.35,
      interpretation:
        voicesBias.score > 20 ? `Analysts lean bullish (net +${voicesBias.score.toFixed(0)}, n=${voicesBias.sampleSize})`
        : voicesBias.score > -20 ? `Analysts split (net ${voicesBias.score.toFixed(0)}, n=${voicesBias.sampleSize})`
        : `Analysts lean bearish (net ${voicesBias.score.toFixed(0)}, n=${voicesBias.sampleSize})`,
    });
  }

  // Hierarchical (block-first) weights; blocks with no gauge drop out and the
  // rest renormalize. Each gauge's `weight` becomes its effective share.
  // Estimated weights when the gate passed and they cover every present
  // gauge; otherwise the hand-set heuristic.
  const est = estimated && estimated.ok ? estimated.est : null;
  const useEst = !!est && gauges.length > 0 && gauges.every((g) => Number.isFinite(est.weights[g.name]) && est.weights[g.name] > 0);
  let eff: number[];
  if (useEst) {
    const raw = gauges.map((g) => est!.weights[g.name]);
    const tot = raw.reduce((a, b) => a + b, 0);
    eff = raw.map((v) => v / tot);
  } else {
    eff = blockWeights(gauges.map((g) => ({ block: g.block, intra: g.weight })));
  }
  gauges.forEach((g, i) => { g.weight = eff[i]; });
  const weightNote = useEst
    ? `estimated: hierarchical risk parity on ${est!.days} days of gauge sub-score changes (blocks as clusters, Ledoit-Wolf shrunk covariance); about ${est!.effectiveN.toFixed(1)} independent gauges`
    : `heuristic hand-set block weights (implied vol 30%, options positioning 30%, crowd 25%, CNN F&G 15% x 5/7 for its VIX and put/call overlap)${estimated && !estimated.ok ? `; estimated weights not used: ${estimated.reason}` : est ? "; estimated weights not used: a present gauge has no estimated weight" : ""}`;
  const totalW = eff.reduce((a, b) => a + b, 0);
  const score = totalW ? Math.round(gauges.reduce((a, g) => a + g.value * g.weight, 0) / totalW) : 50;

  // Market-data-only score (rule 2): the implied-vol and options-positioning
  // blocks only. Social, AAII, curated voices and CNN F&G are non-price
  // context and must not feed a price or path calculation, so consumers that
  // tilt scenario probabilities or drift (dailyPlaybook, quarterly
  // trajectory) read this, not `score`. null when no market gauge exists.
  const mkt = gauges.filter((g) => g.block === "implied-vol" || g.block === "options-positioning");
  const mktW = mkt.reduce((a, g) => a + g.weight, 0);
  const marketScore = mktW > 0 ? Math.round(mkt.reduce((a, g) => a + g.value * g.weight, 0) / mktW) : null;

  const label =
    score <= 20 ? "Extreme Fear"
    : score <= 40 ? "Fear"
    : score <= 55 ? "Neutral"
    : score <= 75 ? "Greed"
    : "Extreme Greed";

  const tradingRegime =
    snap.gamma.regime === "positive"
      ? `Positive gamma — mean-reversion favored. Expect pinning toward ${snap.gamma.maxPain}, resistance at ${snap.gamma.callWall}, support at ${snap.gamma.putWall}.`
      : snap.gamma.regime === "negative"
      ? `Negative gamma — trend / breakout regime. Range-expansion likely. Key support ${snap.gamma.putWall}, key resistance ${snap.gamma.callWall}.`
      : `Near gamma flip (${snap.gamma.zeroGamma?.toFixed(1) ?? "n/a"}) — unstable; directional risk elevated.`;

  const takeaway = buildTakeaway(score, label, snap);

  return {
    score, label, gauges, takeaway, tradingRegime, marketScore,
    method: `${weightNote}; weights renormalize over the gauges present; a heuristic reading, not a probability`,
    weightSource: useEst ? "estimated" : "heuristic",
    effectiveGauges: useEst ? +est!.effectiveN.toFixed(2) : null,
  };
}

function buildTakeaway(score: number, label: string, snap: Omit<Snapshot_Public, "composite">): string {
  const v = snap.vol.vix.value;
  const parts: string[] = [];
  parts.push(`Composite reads ${score}/100 (${label}).`);
  if (v != null) parts.push(`VIX ${v.toFixed(2)}${v > 20 ? ", above the 20 stress line" : ""}.`);
  parts.push(
    snap.gamma.regime === "negative"
      ? `Dealers are net short gamma (${(snap.gamma.totalGex / 1e9).toFixed(2)}B/1%) → expect amplified moves.`
      : snap.gamma.regime === "positive"
      ? `Dealers are net long gamma (${(snap.gamma.totalGex / 1e9).toFixed(2)}B/1%) → expect pinning.`
      : "Gamma is near zero — unstable regime, prepare for regime shift.",
  );
  if (snap.gamma.pcrOi > 1.8) parts.push(`PCR OI at ${snap.gamma.pcrOi.toFixed(2)} signals heavy put hedging.`);
  const social = snap.social.score;
  if (social != null && social < -20) parts.push(`Social tone skews bearish (${social}).`);
  else if (social != null && social > 20) parts.push(`Social tone skews bullish (+${social}).`);
  return parts.join(" ");
}
