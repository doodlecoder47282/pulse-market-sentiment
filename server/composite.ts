/**
 * Composite sentiment score. Maps each raw signal to a 0..100 sub-score
 * (0 = extreme fear, 50 = neutral, 100 = extreme greed), then combines
 * by weights. Weights are transparent so the user can reason about them.
 */
import type { Composite, Gauge, Snapshot_Public } from "@shared/schema";

/** Clamp to 0..100. */
const clamp = (v: number) => Math.max(0, Math.min(100, v));

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
): Composite {
  const gauges: Gauge[] = [];

  const vix = snap.vol.vix.value;
  if (vix != null) {
    const v = clamp(vixScore(vix));
    gauges.push({
      name: "VIX Level",
      value: v,
      weight: 0.22,
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
      weight: 0.08,
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
      weight: 0.12,
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
      weight: 0.08,
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
    weight: 0.12,
    interpretation:
      snap.gamma.pcrOi < 0.8 ? "Call-heavy — speculative greed"
      : snap.gamma.pcrOi < 1.2 ? "Balanced"
      : snap.gamma.pcrOi < 1.8 ? "Put-heavy — hedging bias"
      : "Very put-heavy — defensive positioning dominates",
  });

  gauges.push({
    name: "Dealer Gamma Regime",
    value: clamp(gammaScore(snap.gamma.totalGex)),
    weight: 0.15,
    interpretation:
      snap.gamma.regime === "positive"
        ? `Positive gamma — dealers buy dips / sell rips. Mean-reversion regime. Call wall at ${snap.gamma.callWall}.`
        : snap.gamma.regime === "negative"
        ? `Negative gamma — dealers amplify moves. Trend / breakout regime. Put wall at ${snap.gamma.putWall}.`
        : "Near gamma flip — unstable regime",
  });

  gauges.push({
    name: "Social Sentiment (X + Reddit)",
    value: clamp(socialScore(snap.social.score)),
    weight: 0.10,
    interpretation:
      snap.social.score > 30 ? "Retail chatter skews bullish"
      : snap.social.score > -30 ? "Retail chatter mixed"
      : "Retail chatter skews bearish",
  });

  if (snap.fearGreed) {
    gauges.push({
      name: "CNN Fear & Greed",
      value: snap.fearGreed.value,
      weight: 0.08,
      interpretation: `CNN index: ${snap.fearGreed.label}`,
    });
  }

  if (snap.aaii) {
    const net = snap.aaii.bullish - snap.aaii.bearish; // percentage points
    // map -40..+40 to 10..90
    const v = clamp(50 + net * 1.0);
    gauges.push({
      name: "AAII Bull-Bear Spread",
      value: v,
      weight: 0.05,
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
      weight: 0.08,
      interpretation:
        voicesBias.score > 20 ? `Analysts lean bullish (net +${voicesBias.score.toFixed(0)}, n=${voicesBias.sampleSize})`
        : voicesBias.score > -20 ? `Analysts split (net ${voicesBias.score.toFixed(0)}, n=${voicesBias.sampleSize})`
        : `Analysts lean bearish (net ${voicesBias.score.toFixed(0)}, n=${voicesBias.sampleSize})`,
    });
  }

  // Weighted composite (re-normalize weights that were actually supplied)
  const totalW = gauges.reduce((a, g) => a + g.weight, 0);
  const score = totalW ? Math.round(gauges.reduce((a, g) => a + g.value * g.weight, 0) / totalW) : 50;

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

  return { score, label, gauges, takeaway, tradingRegime };
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
  if (snap.social.score < -20) parts.push(`Social tone skews bearish (${snap.social.score}).`);
  else if (snap.social.score > 20) parts.push(`Social tone skews bullish (+${snap.social.score}).`);
  return parts.join(" ");
}
