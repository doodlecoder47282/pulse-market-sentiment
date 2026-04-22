// server/playbook.ts
// Gamma Squeeze Indicator + AI-style Daily Playbook narrative.
//
// These are rules-based (transparent and auditable), not ML. The scoring is
// derived from well-known dealer-positioning heuristics:
//
//   Squeeze UP fuel:
//     - Spot approaching a dominant CALL WALL from below
//     - Net GEX turning from negative to positive (gamma flip crossed upward)
//     - Low/declining VIX + backwardation easing (vol crush -> vanna adds to
//       delta exposure -> dealers buy stock)
//     - High call OI concentration at 0-5 DTE strikes just above spot
//     - Low PCR (call-heavy speculation)
//
//   Squeeze DOWN fuel:
//     - Spot below zero-gamma with negative net GEX (dealers short gamma ->
//       amplify selling)
//     - VIX rising into backwardation (9D/30D > 1)
//     - High put OI concentration just below spot (dealers short puts ->
//       hedge by selling as price falls)
//     - Elevated SKEW (tail hedging active)
//
// The indicator outputs:
//   score: -100..+100 (positive = upside squeeze risk, negative = downside crash risk)
//   probability: 0..100 (conviction that a >1.5% move could materialize in <3 sessions)
//   direction: "up" | "down" | "neutral"
//   triggers: string[]  (the rules that actually fired)

import type { GammaStructure, TermStructure, VolMetric } from "@shared/schema";
import type { PivotBundle } from "./pivots";
import { proximityAnalysis } from "./pivots";

export type SqueezeIndicator = {
  score: number;            // -100..+100
  probability: number;      // 0..100
  direction: "up" | "down" | "neutral";
  label: string;
  triggers: string[];       // bullet reasons
  riskFactors: string[];    // cautions
  timeHorizon: string;      // e.g. "0-3 sessions"
};

export type GammaMap = {
  zeroGamma: number | null;
  distanceToFlip: number | null;        // spot - zeroGamma (negative = below flip)
  distanceToFlipPct: number | null;
  hedgeZones: Array<{
    strike: number;
    gex: number;
    zone: "call-wall" | "put-wall" | "secondary-resistance" | "secondary-support" | "local-extreme";
    note: string;
  }>;
  regime: "positive" | "negative" | "neutral";
  netGex: number;
  narrative: string;
};

export type DailyPlaybook = {
  headline: string;
  bias: "bullish" | "bearish" | "neutral" | "volatile";
  conviction: "high" | "moderate" | "low";
  summary: string;
  scenarios: Array<{
    name: string;
    trigger: string;
    target: string;
    invalidation: string;
    odds: "primary" | "secondary" | "tail";
  }>;
  keyLevels: {
    resistance: Array<{ level: number; label: string }>;
    support: Array<{ level: number; label: string }>;
  };
  gameplan: string[];        // actionable bullets
};

// ---- Gamma Squeeze Indicator ------------------------------------------------

type SqueezeInputs = {
  spot: number;
  gamma: GammaStructure;
  term: TermStructure;
  vix: VolMetric;
  vvix: VolMetric;
  skew: VolMetric;
};

export function computeSqueezeIndicator(inp: SqueezeInputs): SqueezeIndicator {
  const { spot, gamma, term, vix, vvix, skew } = inp;
  const triggers: string[] = [];
  const risks: string[] = [];
  let upFuel = 0, downFuel = 0;

  // 1. Distance to walls (nearness boosts fuel)
  const distToCallWall = gamma.callWall - spot;
  const distToPutWall = spot - gamma.putWall;
  const callWallPct = spot ? (distToCallWall / spot) * 100 : 0;
  const putWallPct = spot ? (distToPutWall / spot) * 100 : 0;
  if (distToCallWall > 0 && callWallPct < 1.5) {
    upFuel += 25;
    triggers.push(`Spot within ${callWallPct.toFixed(2)}% of call wall ${gamma.callWall.toFixed(0)} — dealer hedging likely to cap or re-accelerate above`);
  }
  if (distToPutWall > 0 && putWallPct < 1.5) {
    downFuel += 25;
    triggers.push(`Spot within ${putWallPct.toFixed(2)}% of put wall ${gamma.putWall.toFixed(0)} — dealers short puts will amplify selling below`);
  }

  // 2. Gamma regime & zero-gamma proximity
  if (gamma.regime === "negative") {
    downFuel += 20;
    triggers.push(`Net negative gamma (${(gamma.totalGex / 1e9).toFixed(2)}B/1%) — dealers sell into weakness, buy into strength = trend amplification`);
  } else if (gamma.regime === "positive") {
    upFuel += 10;
    triggers.push(`Net positive gamma (${(gamma.totalGex / 1e9).toFixed(2)}B/1%) — dealers stabilize; grind-up regime favored`);
  }
  if (gamma.zeroGamma != null) {
    const distToFlip = spot - gamma.zeroGamma;
    const flipPct = spot ? (distToFlip / spot) * 100 : 0;
    if (Math.abs(flipPct) < 0.5) {
      // Near gamma flip — both directions become explosive
      upFuel += 15; downFuel += 15;
      triggers.push(`Spot within ${Math.abs(flipPct).toFixed(2)}% of zero-gamma flip (${gamma.zeroGamma.toFixed(1)}) — regime instability`);
      risks.push("Near gamma flip: a small move in either direction can flip dealer hedging behavior");
    } else if (distToFlip < 0) {
      // Below flip — negative gamma territory
      downFuel += 10;
      triggers.push(`Spot ${Math.abs(flipPct).toFixed(2)}% below zero-gamma (${gamma.zeroGamma.toFixed(1)}) — in negative-gamma zone`);
    } else {
      upFuel += 5;
      triggers.push(`Spot ${flipPct.toFixed(2)}% above zero-gamma (${gamma.zeroGamma.toFixed(1)}) — positive-gamma zone`);
    }
  }

  // 3. Term structure (vol regime)
  const termRatio = term.ratio9dOver30d;
  if (termRatio != null) {
    if (termRatio > 1.05) {
      downFuel += 15;
      triggers.push(`VIX term backwardated (9D/30D=${termRatio.toFixed(3)}) — near-term stress priced in`);
    } else if (termRatio < 0.90) {
      upFuel += 10;
      triggers.push(`Deep contango (9D/30D=${termRatio.toFixed(3)}) — vol crush fuel for vanna-driven drift higher`);
    }
  }

  // 4. VIX level dynamics
  const v = vix.value ?? 0;
  if (v != null && v > 25 && (vix.changePct ?? 0) > 5) {
    downFuel += 12;
    triggers.push(`VIX ${v.toFixed(1)} and rising — hedging demand active, short-gamma dealers forced to press`);
  } else if (v < 16 && (vix.changePct ?? 0) < -3) {
    upFuel += 10;
    triggers.push(`VIX ${v.toFixed(1)} and compressing — vanna/charm flows supportive, systematic vol-sellers re-leveraging`);
  }

  // 5. PCR skew
  if (gamma.pcrOi < 0.85) {
    upFuel += 8;
    triggers.push(`PCR OI ${gamma.pcrOi.toFixed(2)} (call-heavy) — crowded upside positioning can accelerate into call walls`);
  } else if (gamma.pcrOi > 1.8) {
    downFuel += 8;
    triggers.push(`PCR OI ${gamma.pcrOi.toFixed(2)} (put-heavy) — defensive positioning extends room for bear squeeze if hedges unwind`);
  }

  // 6. SKEW (tail risk)
  if (skew.value != null && skew.value > 150) {
    downFuel += 6;
    risks.push(`SKEW at ${skew.value.toFixed(0)} — crash-protection demand is elevated; tail hedges active`);
  }

  // 7. VVIX (vol-of-vol) — explosive material
  if (vvix.value != null && vvix.value > 120) {
    downFuel += 5;
    risks.push(`VVIX ${vvix.value.toFixed(0)} — VIX options rich; market expects vol expansion`);
  }

  // Score = signed net fuel, clamped
  const rawScore = upFuel - downFuel;
  const score = Math.max(-100, Math.min(100, rawScore));

  // Probability = intensity regardless of direction
  const intensity = Math.min(100, upFuel + downFuel);

  let direction: "up" | "down" | "neutral";
  if (score > 15) direction = "up";
  else if (score < -15) direction = "down";
  else direction = "neutral";

  const label =
    score > 60 ? "High Upside Squeeze Risk"
    : score > 25 ? "Moderate Upside Pressure"
    : score > -25 ? "Balanced / Choppy"
    : score > -60 ? "Moderate Downside Pressure"
    : "High Downside Squeeze Risk";

  const timeHorizon =
    intensity > 60 ? "0-2 sessions (imminent)"
    : intensity > 35 ? "1-3 sessions"
    : "3-5 sessions (slow build)";

  return { score, probability: intensity, direction, label, triggers, riskFactors: risks, timeHorizon };
}

// ---- Gamma Map (for the UI) -------------------------------------------------

export function buildGammaMap(gamma: GammaStructure, spot: number): GammaMap {
  const zones: GammaMap["hedgeZones"] = [];

  zones.push({
    strike: gamma.callWall,
    gex: gamma.callWallGex,
    zone: "call-wall",
    note: "Dominant positive-GEX strike. Dealers long calls here. Price often stalls into this level as dealers sell into rallies.",
  });

  zones.push({
    strike: gamma.putWall,
    gex: gamma.putWallGex,
    zone: "put-wall",
    note: "Dominant negative-GEX strike. Dealers short puts here. Price often finds support; breach below accelerates selling.",
  });

  // Find secondary walls: next-largest positive & negative GEX strikes (excluding primary)
  const profile = [...gamma.profile].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex));
  for (const p of profile.slice(0, 6)) {
    if (p.strike === gamma.callWall || p.strike === gamma.putWall) continue;
    if (p.gex > 0 && zones.filter(z => z.zone === "secondary-resistance").length < 2) {
      zones.push({
        strike: p.strike,
        gex: p.gex,
        zone: "secondary-resistance",
        note: "Positive GEX cluster — minor dealer-driven resistance.",
      });
    } else if (p.gex < 0 && zones.filter(z => z.zone === "secondary-support").length < 2) {
      zones.push({
        strike: p.strike,
        gex: p.gex,
        zone: "secondary-support",
        note: "Negative GEX cluster — minor dealer-driven support.",
      });
    }
  }
  // sort by strike ascending for display
  zones.sort((a, b) => a.strike - b.strike);

  const distanceToFlip = gamma.zeroGamma != null ? spot - gamma.zeroGamma : null;
  const distanceToFlipPct = distanceToFlip != null && spot ? (distanceToFlip / spot) * 100 : null;

  const narrative =
    gamma.regime === "positive"
      ? `Dealers are NET LONG gamma ($${(gamma.totalGex / 1e9).toFixed(2)}B/1%). They buy weakness and sell strength — mean-reversion regime. Expect pinning toward ${gamma.maxPain.toFixed(0)}, resistance at the ${gamma.callWall.toFixed(0)} call wall, support at the ${gamma.putWall.toFixed(0)} put wall.`
      : gamma.regime === "negative"
      ? `Dealers are NET SHORT gamma ($${(gamma.totalGex / 1e9).toFixed(2)}B/1%). They sell weakness and buy strength — trend-amplification regime. Breakouts above ${gamma.callWall.toFixed(0)} can extend; breaks below ${gamma.putWall.toFixed(0)} can cascade.`
      : `Dealer gamma is near zero (${(gamma.totalGex / 1e9).toFixed(2)}B/1%). Unstable regime — a small spot move in either direction flips dealer hedging behavior. Key flip level: ${gamma.zeroGamma?.toFixed(1) ?? "n/a"}.`;

  return {
    zeroGamma: gamma.zeroGamma,
    distanceToFlip,
    distanceToFlipPct,
    hedgeZones: zones,
    regime: gamma.regime,
    netGex: gamma.totalGex,
    narrative,
  };
}

// ---- Daily Playbook ---------------------------------------------------------

type PlaybookInputs = {
  spot: number;
  gamma: GammaStructure;
  pivots: PivotBundle | null;
  term: TermStructure;
  vix: VolMetric;
  compositeScore: number;        // 0..100 (fear..greed)
  compositeLabel: string;
  voicesBiasScore?: number | null;  // -100..+100
  squeeze: SqueezeIndicator;
};

export function buildDailyPlaybook(inp: PlaybookInputs): DailyPlaybook {
  const { spot, gamma, pivots, term, vix, compositeScore, voicesBiasScore, squeeze } = inp;
  const v = vix.value ?? 0;
  const vChg = vix.changePct ?? 0;
  const termRatio = term.ratio9dOver30d ?? 1;

  // Determine bias
  let bias: DailyPlaybook["bias"] = "neutral";
  let conviction: DailyPlaybook["conviction"] = "moderate";

  // Bias heuristic: combine composite (0-100), gamma regime, squeeze direction, voices.
  const bullPts =
    (compositeScore > 60 ? 2 : compositeScore > 50 ? 1 : 0) +
    (gamma.regime === "positive" ? 2 : 0) +
    (squeeze.direction === "up" ? 2 : 0) +
    ((voicesBiasScore ?? 0) > 15 ? 1 : 0) +
    (termRatio < 0.95 ? 1 : 0);
  const bearPts =
    (compositeScore < 40 ? 2 : compositeScore < 50 ? 1 : 0) +
    (gamma.regime === "negative" ? 2 : 0) +
    (squeeze.direction === "down" ? 2 : 0) +
    ((voicesBiasScore ?? 0) < -15 ? 1 : 0) +
    (termRatio > 1.05 ? 1 : 0) +
    (v > 25 ? 1 : 0);

  if (bullPts - bearPts >= 4) { bias = "bullish"; conviction = "high"; }
  else if (bullPts - bearPts >= 2) { bias = "bullish"; conviction = "moderate"; }
  else if (bearPts - bullPts >= 4) { bias = "bearish"; conviction = "high"; }
  else if (bearPts - bullPts >= 2) { bias = "bearish"; conviction = "moderate"; }
  else if (Math.abs(squeeze.score) > 50 || v > 30) { bias = "volatile"; conviction = "moderate"; }
  else { bias = "neutral"; conviction = "low"; }

  // Build scenarios
  const scenarios: DailyPlaybook["scenarios"] = [];
  const cw = gamma.callWall, pw = gamma.putWall, zg = gamma.zeroGamma;

  if (gamma.regime === "positive") {
    scenarios.push({
      name: "Base Case — Pin & Fade",
      trigger: `Opens between ${pw.toFixed(0)} and ${cw.toFixed(0)}`,
      target: `Drift toward max pain ${gamma.maxPain.toFixed(0)}; fade touches of ${cw.toFixed(0)} and ${pw.toFixed(0)}`,
      invalidation: `Close above ${cw.toFixed(0)} or below ${pw.toFixed(0)}`,
      odds: "primary",
    });
    scenarios.push({
      name: "Upside Break — Call Wall Roll",
      trigger: `Breach and 15-min close above ${cw.toFixed(0)}`,
      target: `Next call-wall strike or +1% extension`,
      invalidation: `Reclaim below ${cw.toFixed(0)}`,
      odds: "secondary",
    });
    scenarios.push({
      name: "Downside Break — Put Wall Fail",
      trigger: `Breach and 15-min close below ${pw.toFixed(0)}`,
      target: zg != null ? `Test zero-gamma ${zg.toFixed(1)}, then ${(pw - (cw - pw) * 0.5).toFixed(0)}` : `−1% extension`,
      invalidation: `Reclaim above ${pw.toFixed(0)}`,
      odds: "tail",
    });
  } else if (gamma.regime === "negative") {
    scenarios.push({
      name: "Base Case — Trend Day",
      trigger: `Direction of first 30-min range extension`,
      target: `Fast trip to the opposite wall (${cw.toFixed(0)} / ${pw.toFixed(0)}); range-expansion day`,
      invalidation: `Mid-session reversal of 50%+ of morning range`,
      odds: "primary",
    });
    scenarios.push({
      name: "Short-Gamma Cascade Down",
      trigger: `Rejection at ${(zg ?? cw).toFixed(0)} and close below ${pw.toFixed(0)}`,
      target: pivots ? `${pivots.classic.s2.toFixed(1)} / ${pivots.camarilla.l5.toFixed(1)}` : "−1.5% extension",
      invalidation: `Reclaim put wall ${pw.toFixed(0)}`,
      odds: "secondary",
    });
    scenarios.push({
      name: "Reflex Short Squeeze",
      trigger: `Reclaim zero-gamma ${zg?.toFixed(1) ?? "flip"} with vol crush`,
      target: `Mean-revert to ${cw.toFixed(0)} as dealers flip to long gamma`,
      invalidation: `Fails ${zg?.toFixed(1) ?? "flip"} on retest`,
      odds: "tail",
    });
  } else {
    // Near gamma flip
    scenarios.push({
      name: "Unstable Regime — Trade the Flip",
      trigger: `First 30-min closes decide: above ${zg?.toFixed(1) ?? cw.toFixed(0)} = positive gamma day, below = short-gamma trend day`,
      target: `Follow the first-30min direction; size conservatively`,
      invalidation: `Chop back through the flip`,
      odds: "primary",
    });
  }

  // Gameplan bullets
  const gameplan: string[] = [];
  if (gamma.regime === "positive") {
    gameplan.push(`Favor fading extremes. Buy dips to ${pw.toFixed(0)}, sell rips at ${cw.toFixed(0)}. 0DTE iron condors with short strikes at/outside walls favored.`);
  } else if (gamma.regime === "negative") {
    gameplan.push(`Favor trend continuation. Avoid catching knives below ${pw.toFixed(0)}. 0DTE debit spreads in the direction of first-30min break.`);
  } else {
    gameplan.push(`Wait for first-30min close relative to zero-gamma ${zg?.toFixed(1) ?? "flip"}. Size half of normal until regime confirms.`);
  }

  if (pivots) {
    const prox = proximityAnalysis(spot, pivots);
    if (prox.nearest) {
      gameplan.push(`Spot ${spot.toFixed(2)} sits ${Math.abs(prox.nearest.value - spot).toFixed(2)} from ${prox.nearest.name} (${prox.nearest.value.toFixed(2)}). First reaction there tells the day's tone.`);
    }
    gameplan.push(`Camarilla H3 ${pivots.camarilla.h3.toFixed(1)} / L3 ${pivots.camarilla.l3.toFixed(1)} = reversion fade zones. H4 ${pivots.camarilla.h4.toFixed(1)} / L4 ${pivots.camarilla.l4.toFixed(1)} = breakout triggers with stops beyond H5/L5.`);
  }

  if (squeeze.direction === "up" && squeeze.probability > 50) {
    gameplan.push(`Gamma-squeeze setup skewed UP (score ${squeeze.score}, ${squeeze.probability}% conviction). Consider 0-3 DTE call spreads above ${cw.toFixed(0)} for ${squeeze.timeHorizon}.`);
  } else if (squeeze.direction === "down" && squeeze.probability > 50) {
    gameplan.push(`Gamma-squeeze setup skewed DOWN (score ${squeeze.score}, ${squeeze.probability}% conviction). Protect longs with 0-3 DTE put hedges at/below ${pw.toFixed(0)} for ${squeeze.timeHorizon}.`);
  }

  if (v > 25) {
    gameplan.push(`VIX ${v.toFixed(1)} (${vChg > 0 ? "+" : ""}${vChg.toFixed(1)}%) — risk-off regime. Reduce position size and widen stops beyond noise.`);
  }

  // Summary narrative
  const summary = (() => {
    const parts: string[] = [];
    parts.push(`Dealer gamma is ${gamma.regime === "positive" ? "NET LONG" : gamma.regime === "negative" ? "NET SHORT" : "NEAR ZERO"} (${(gamma.totalGex / 1e9).toFixed(2)}B/1%).`);
    parts.push(`${gamma.regime === "positive" ? "Expect mean-reversion and pinning." : gamma.regime === "negative" ? "Expect trend amplification and range expansion." : "Unstable regime; wait for the flip to resolve."}`);
    parts.push(`VIX at ${v.toFixed(2)} (${vChg > 0 ? "+" : ""}${vChg.toFixed(1)}% d/d); term ratio ${termRatio.toFixed(3)} ${termRatio > 1 ? "(backwardation = near-term stress)" : "(contango = calm front-end)"}.`);
    parts.push(`Composite sentiment ${compositeScore}/100 (${bias === "bullish" ? "tilted bullish" : bias === "bearish" ? "tilted bearish" : "mixed"}).`);
    if (squeeze.probability > 40) {
      parts.push(`Gamma-squeeze probability ${squeeze.probability}% with a ${squeeze.direction.toUpperCase()} skew (${squeeze.timeHorizon}).`);
    }
    return parts.join(" ");
  })();

  const headline = (() => {
    if (bias === "bullish" && conviction === "high") return "Structural Bid — Lean Long Into Key Levels";
    if (bias === "bullish") return "Modest Upside Lean — Fade Pullbacks";
    if (bias === "bearish" && conviction === "high") return "Risk-Off Regime — Rallies Are For Sale";
    if (bias === "bearish") return "Defensive Tilt — Protect Longs, Size Down";
    if (bias === "volatile") return "Unstable Regime — Trade The Flip, Not The Trend";
    return "Balanced Tape — Let Levels Do The Talking";
  })();

  // Key levels for the header
  const resistance: { level: number; label: string }[] = [
    { level: cw, label: "Call Wall" },
  ];
  const support: { level: number; label: string }[] = [
    { level: pw, label: "Put Wall" },
  ];
  if (zg != null) {
    if (zg > spot) resistance.push({ level: zg, label: "Zero-Γ Flip" });
    else support.push({ level: zg, label: "Zero-Γ Flip" });
  }
  if (pivots) {
    resistance.push({ level: pivots.camarilla.h3, label: "Cam H3 (fade)" });
    resistance.push({ level: pivots.camarilla.h4, label: "Cam H4 (breakout)" });
    support.push({ level: pivots.camarilla.l3, label: "Cam L3 (fade)" });
    support.push({ level: pivots.camarilla.l4, label: "Cam L4 (breakdown)" });
    resistance.push({ level: pivots.classic.r1, label: "Classic R1" });
    support.push({ level: pivots.classic.s1, label: "Classic S1" });
  }
  resistance.sort((a, b) => a.level - b.level);
  support.sort((a, b) => b.level - a.level);

  return {
    headline,
    bias,
    conviction,
    summary,
    scenarios,
    keyLevels: { resistance, support },
    gameplan,
  };
}
