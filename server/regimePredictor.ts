// server/regimePredictor.ts
//
// Regime transition prediction — forward-looking probability scoring for the
// next regime bucket, plus the drivers that pushed us there. Read-only,
// pure-function. Operates on a snapshot of audit + recent history.
//
// Existing system (do not touch):
//   - detectRegime(audit) in realtimeTargets.ts maps current audit to a
//     RegimeBucket via dfi + gammaZone + slope.
//   - applyRegimeHysteresis() requires STABILITY_TICKS=3 of the same raw
//     regime before _appliedRegime switches.
//
// What this module adds:
//   - Forward-looking score: how likely is each candidate regime to be the
//     APPLIED regime in the next ~15-30 minutes? Returns currentRegime,
//     candidates[] sorted by probability, drivers, confidence.
//
// Drivers (each contributes a signed pressure toward a regime):
//   1. DFI distance to nearest boundary (0/1/2/3.5 thresholds) and slope.
//      Movement TOWARD a boundary that flips bucket increases transition prob.
//   2. IV term DoD (iv1d delta). Negative = vol bleed = chop drift. Positive
//      vol expansion = trend pressure.
//   3. Gamma flip proximity. Spot near mainPivot/charmZero (zero-gamma)
//      destabilizes the current applied regime.
//   4. Session time remaining. Late-day chop bias dominates regardless of
//      morning trend (pin pressure rises into close).
//   5. Recent flip frequency from rolling raw-regime history. High flip rate
//      = low confidence = elevated NEUTRAL probability.
//
// All math is bounded, fail-soft, and independent of any LLM.

type RegimeBucket =
  | "TREND_STRONG"
  | "TREND_WEAK"
  | "NEUTRAL"
  | "CHOP_WEAK"
  | "CHOP_STRONG";

const ALL_REGIMES: RegimeBucket[] = [
  "TREND_STRONG",
  "TREND_WEAK",
  "NEUTRAL",
  "CHOP_WEAK",
  "CHOP_STRONG",
];

// ─── Rolling raw-regime history (in-process, ring buffer) ──────────────

interface RawSample {
  ts: number;
  raw: RegimeBucket;
  dfi: number;
}

const HISTORY_CAP = 32;
const _history: RawSample[] = [];

/** Public observer hook — call from any place that has a fresh audit. */
export function recordRawRegime(raw: RegimeBucket, dfi: number, ts: number = Date.now()): void {
  try {
    _history.push({ ts, raw, dfi });
    if (_history.length > HISTORY_CAP) _history.shift();
  } catch {
    // fail-soft
  }
}

/** Test/dev hook. */
export function _resetPredictorHistory(): void {
  _history.length = 0;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function softmax(scores: Record<RegimeBucket, number>): Record<RegimeBucket, number> {
  const max = Math.max(...ALL_REGIMES.map((k) => scores[k]));
  const exps: Record<string, number> = {};
  let sum = 0;
  for (const k of ALL_REGIMES) {
    const v = Math.exp(scores[k] - max);
    exps[k] = v;
    sum += v;
  }
  const out: any = {};
  for (const k of ALL_REGIMES) out[k] = sum > 0 ? exps[k] / sum : 0.2;
  return out as Record<RegimeBucket, number>;
}

function dfiSlopeFromHistory(): { slope: number; samples: number } {
  if (_history.length < 2) return { slope: 0, samples: _history.length };
  // Use last 6 samples or fewer for short-term slope (DFI per minute)
  const window = _history.slice(-6);
  const first = window[0];
  const last = window[window.length - 1];
  const dtMin = Math.max(0.0167, (last.ts - first.ts) / 60_000);
  return { slope: (last.dfi - first.dfi) / dtMin, samples: window.length };
}

function flipRateFromHistory(): { rate: number; flips: number; samples: number } {
  if (_history.length < 3) return { rate: 0, flips: 0, samples: _history.length };
  let flips = 0;
  for (let i = 1; i < _history.length; i++) {
    if (_history[i].raw !== _history[i - 1].raw) flips++;
  }
  const dtMin = Math.max(0.5, (_history[_history.length - 1].ts - _history[0].ts) / 60_000);
  return { rate: flips / dtMin, flips, samples: _history.length };
}

/**
 * Same regime mapping logic as detectRegime() in realtimeTargets.ts, replicated
 * locally so we can score WHAT-IF regimes for each candidate dfi shift without
 * touching the locked module. Keep behavior identical.
 */
function rawRegimeFor(dfi: number, gZone: string, slopeMag: number): RegimeBucket {
  const inGammaPocket = gZone === "y" || gZone === "y+";
  const adfi = Math.abs(dfi);
  if (adfi >= 3.5 && !inGammaPocket) return "TREND_STRONG";
  if (adfi >= 2.0 && !inGammaPocket) return "TREND_WEAK";
  if (adfi >= 1.0 && inGammaPocket && slopeMag < 1.5) return "CHOP_WEAK";
  if (adfi < 1.0 && inGammaPocket) return "CHOP_STRONG";
  if (adfi >= 2.0 && inGammaPocket) return "CHOP_WEAK";
  return "NEUTRAL";
}

// ─── Public types ──────────────────────────────────────────────────────

export interface RegimePredictorInput {
  audit: any;
  /** Live spot for gamma-flip proximity. If absent, falls back to audit.spot. */
  spot?: number;
  /** Override now for testing */
  nowMs?: number;
  /** Forward horizon in minutes (default 20) */
  horizonMinutes?: number;
  /** Optional macro snapshot (vix term, dxy, tnx). Neutral fallback if absent. */
  macro?: {
    vixTermRatio?: number | null; // VIX9D / VIX, <1 = backwardation = stress
    dxyDelta?: number | null;     // intraday %
    tnxDelta?: number | null;     // intraday %
  } | null;
  /** Optional whale herding signal: net signed pressure last 30min, normalized -1..+1. */
  whalePressure?: number | null;
}

export interface RegimeCandidate {
  regime: RegimeBucket;
  probability: number;
  isCurrent: boolean;
}

export interface RegimePredictorOutput {
  currentRegime: RegimeBucket;
  candidates: RegimeCandidate[];
  horizonMinutes: number;
  confidence: number; // 0..1
  /** "warming" when historySamples<5; "ready" when ok; "degraded" when missing audit fields. */
  status: "ready" | "warming" | "degraded";
  /** Plain-English headline for the UI (already synthesized server-side). */
  headline: string;
  /** Plain-English bullets explaining the top drivers right now. */
  driverNotes: string[];
  drivers: {
    dfi: number;
    dfiSlopePerMin: number;
    /** Distance (signed) from current dfi to nearest boundary in the slope direction */
    boundaryDistance: number;
    nextBoundary: number | null;
    ivTermDelta: number;
    ivTermLabel: string;
    /** Spot distance to mainPivot, fraction of one-day expected move */
    gammaFlipProxFrac: number;
    /** Spot distance to charmZero, fraction of one-day EM. null if charmZero absent. */
    charmZeroProxFrac: number | null;
    sessionFracRemaining: number;
    flipRatePerMin: number;
    flipsObserved: number;
    historySamples: number;
    vannaBias: "positive" | "negative" | "neutral";
    vixTermRatio: number | null;
    macroStress: "calm" | "normal" | "stress";
    whalePressure: number; // -1..+1
  };
  generatedAt: number;
}

// ─── Core ──────────────────────────────────────────────────────────────

/** Fraction of RTH session remaining at nowMs (replicated to keep this module standalone). */
function sessionFracRemaining(nowMs: number): number {
  const d = new Date(nowMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || "0", 10);
  const minsFromOpen = (get("hour") - 9) * 60 + (get("minute") - 30) + get("second") / 60;
  if (minsFromOpen <= 0) return 1.0;
  if (minsFromOpen >= 390) return 0.0;
  return 1 - minsFromOpen / 390;
}

const DFI_BOUNDARIES = [-3.5, -2.0, -1.0, 1.0, 2.0, 3.5];

/**
 * Predict the most likely applied regime over the next horizon minutes.
 * Pure-function, fail-soft, returns sane defaults on any error.
 */
export function predictTransition(input: RegimePredictorInput): RegimePredictorOutput {
  const nowMs = input.nowMs ?? Date.now();
  const horizonMinutes = input.horizonMinutes ?? 20;

  const audit = input.audit ?? {};
  const dfi = Number(audit.dfi ?? 0);
  const gZone = String(audit.gammaZone ?? "").toLowerCase();
  const slopeText = String(audit.slope ?? "");
  // Slope text e.g. "DN 0.31° → -0.61"; second number is signed magnitude
  const matches = slopeText.match(/-?\d+(\.\d+)?/g) ?? [];
  const slopeMag = Math.abs(parseFloat(matches[1] ?? "0") || 0);
  const slopeSigned = parseFloat(matches[1] ?? "0") || 0;

  const currentRaw = rawRegimeFor(dfi, gZone, slopeMag);

  // Drivers
  const { slope: dfiSlopePerMin, samples: histSamples } = dfiSlopeFromHistory();
  const { rate: flipRate, flips } = flipRateFromHistory();

  // Find next DFI boundary in slope direction (or nearest if slope ~0)
  let nextBoundary: number | null = null;
  let boundaryDistance = 0;
  if (Math.abs(dfiSlopePerMin) > 0.001) {
    const dir = Math.sign(dfiSlopePerMin);
    const candidates = DFI_BOUNDARIES.filter((b) => (dir > 0 ? b > dfi : b < dfi));
    if (candidates.length) {
      nextBoundary = dir > 0 ? Math.min(...candidates) : Math.max(...candidates);
      boundaryDistance = nextBoundary - dfi;
    }
  } else {
    // No slope info — pick nearest boundary either side
    const nearest = DFI_BOUNDARIES.reduce(
      (best, b) => (Math.abs(b - dfi) < Math.abs(best - dfi) ? b : best),
      DFI_BOUNDARIES[0],
    );
    nextBoundary = nearest;
    boundaryDistance = nearest - dfi;
  }

  // IV term DoD
  const term = audit.termStructureDoD ?? {};
  const ivTermDelta = Number(term.iv1dDelta ?? 0);
  const ivTermLabel = String(term.label ?? "Flat");

  // Gamma flip proximity — spot vs mainPivot, normalized by oneDayEM
  const spot = Number(input.spot ?? audit.spot ?? 0);
  const pivot = Number(audit.mainPivot ?? spot);
  const oneDayEM = Math.max(0.5, Number(audit.scenarioTargets?.oneDayEM ?? 1));
  const gammaFlipProxFrac = clamp(Math.abs(spot - pivot) / oneDayEM, 0, 5);

  const sessionFrac = sessionFracRemaining(nowMs);

  // ─── Score each candidate regime ───
  // Base score = match to current raw regime + projected dfi shift
  const projectedDfi = dfi + dfiSlopePerMin * horizonMinutes;
  const projectedSlope = slopeMag; // we don't model slope evolution; conservative

  const scores: Record<RegimeBucket, number> = {
    TREND_STRONG: 0,
    TREND_WEAK: 0,
    NEUTRAL: 0,
    CHOP_WEAK: 0,
    CHOP_STRONG: 0,
  };

  // 1) projected raw regime gets the largest base bump
  const projectedRaw = rawRegimeFor(projectedDfi, gZone, projectedSlope);
  scores[projectedRaw] += 2.5;

  // 2) current raw regime stays as the strong prior (hysteresis bias)
  scores[currentRaw] += 1.8;

  // 3) IV term direction
  if (ivTermDelta > 0.02) {
    // vol expansion → favor TREND
    scores.TREND_STRONG += 0.6;
    scores.TREND_WEAK += 0.4;
    scores.CHOP_STRONG -= 0.4;
    scores.CHOP_WEAK -= 0.2;
  } else if (ivTermDelta < -0.02) {
    // vol bleed → favor CHOP
    scores.CHOP_STRONG += 0.6;
    scores.CHOP_WEAK += 0.4;
    scores.TREND_STRONG -= 0.4;
    scores.TREND_WEAK -= 0.2;
  }

  // 4) Gamma flip proximity — close to pivot destabilizes trend, favors chop/neutral
  if (gammaFlipProxFrac < 0.25) {
    scores.NEUTRAL += 0.6;
    scores.CHOP_WEAK += 0.4;
    scores.TREND_STRONG -= 0.5;
  } else if (gammaFlipProxFrac > 1.0) {
    // far from pivot → trend persistence
    scores.TREND_STRONG += 0.4;
    scores.TREND_WEAK += 0.3;
  }

  // 5) Session time remaining — late-day pin bias
  if (sessionFrac < 0.25) {
    // last 1.5 hr — pin/chop pressure rises
    scores.CHOP_STRONG += 0.5;
    scores.CHOP_WEAK += 0.3;
    scores.TREND_STRONG -= 0.3;
  } else if (sessionFrac > 0.75) {
    // first 1.5 hr — direction-setting
    scores.TREND_STRONG += 0.3;
    scores.TREND_WEAK += 0.2;
  }

  // 6) Flip rate — high flip frequency means uncertainty, push NEUTRAL
  if (flipRate > 0.3) {
    scores.NEUTRAL += 0.7;
    scores.TREND_STRONG -= 0.3;
    scores.CHOP_STRONG -= 0.2;
  }

  // 7) Slope sign asymmetry — strong directional slope reinforces trend regimes
  if (slopeMag > 1.5) {
    scores.TREND_STRONG += 0.4;
    scores.TREND_WEAK += 0.3;
    scores.NEUTRAL -= 0.2;
  }

  // 8) Boundary proximity — if a flip is one slope-step away, boost the
  //    receiving regime
  if (nextBoundary != null && Math.abs(dfiSlopePerMin) > 0.001) {
    const minutesToBoundary = Math.abs(boundaryDistance / dfiSlopePerMin);
    if (minutesToBoundary < horizonMinutes) {
      // cross-over imminent — projected raw regime gets extra weight
      scores[projectedRaw] += 0.8;
    }
  }

  // 9) Vanna bias — positive vanna stabilizes trend continuation, negative destabilizes
  const vannaBiasRaw = String(audit.vannaBias ?? "").toLowerCase();
  let vannaBias: "positive" | "negative" | "neutral" = "neutral";
  if (vannaBiasRaw === "positive") {
    vannaBias = "positive";
    scores.TREND_STRONG += 0.3;
    scores.TREND_WEAK += 0.2;
    scores.CHOP_STRONG -= 0.2;
  } else if (vannaBiasRaw === "negative") {
    vannaBias = "negative";
    scores.CHOP_STRONG += 0.3;
    scores.CHOP_WEAK += 0.2;
    scores.TREND_STRONG -= 0.2;
  }

  // 10) Charm zero proximity — second pivot, similar pin pressure as mainPivot
  const charmZero = Number(audit.charmZero ?? NaN);
  let charmZeroProxFrac: number | null = null;
  if (Number.isFinite(charmZero) && charmZero > 0 && spot > 0) {
    charmZeroProxFrac = clamp(Math.abs(spot - charmZero) / oneDayEM, 0, 5);
    if (charmZeroProxFrac < 0.20) {
      scores.CHOP_STRONG += 0.4;
      scores.NEUTRAL += 0.3;
      scores.TREND_STRONG -= 0.3;
    }
  }

  // 11) Macro regime — VIX term backwardation = stress, biases CHOP_STRONG/NEUTRAL
  const vixTermRatio = input.macro?.vixTermRatio ?? null;
  let macroStress: "calm" | "normal" | "stress" = "normal";
  if (vixTermRatio != null && Number.isFinite(vixTermRatio)) {
    if (vixTermRatio < 0.95) {
      macroStress = "stress";
      // VIX9D > VIX = front stress = vol expansion likely = TREND or NEUTRAL chop
      scores.TREND_STRONG += 0.3;
      scores.NEUTRAL += 0.3;
      scores.CHOP_WEAK -= 0.2;
    } else if (vixTermRatio > 1.10) {
      macroStress = "calm";
      // Steep contango = vol bleed = chop favored
      scores.CHOP_STRONG += 0.3;
      scores.CHOP_WEAK += 0.2;
      scores.TREND_STRONG -= 0.2;
    }
  }

  // 12) Whale herding pressure — net signed flow last 30min reinforces directional regimes
  const whalePressure = clamp(Number(input.whalePressure ?? 0), -1, 1);
  if (Math.abs(whalePressure) > 0.4) {
    // Strong directional whale flow — reinforces TREND, weakens CHOP
    scores.TREND_STRONG += 0.4 * Math.abs(whalePressure);
    scores.TREND_WEAK += 0.2 * Math.abs(whalePressure);
    scores.CHOP_STRONG -= 0.2 * Math.abs(whalePressure);
  }

  // ─── Convert scores to probabilities ───
  const probs = softmax(scores);

  // Confidence = max prob, scaled by data quality (more samples = more confident)
  const maxProb = Math.max(...ALL_REGIMES.map((k) => probs[k]));
  const sampleQuality = clamp(histSamples / 8, 0.3, 1.0);
  const confidence = clamp(maxProb * sampleQuality, 0, 1);

  const candidates: RegimeCandidate[] = ALL_REGIMES.map((r) => ({
    regime: r,
    probability: probs[r],
    isCurrent: r === currentRaw,
  })).sort((a, b) => b.probability - a.probability);

  // ─── Status gating ─── warming-up if not enough samples
  let status: "ready" | "warming" | "degraded" = "ready";
  if (histSamples < 5) status = "warming";
  if (!Number.isFinite(dfi) || !audit.gammaZone) status = "degraded";

  // ─── Plain-English synthesis ───
  const top = candidates[0];
  const second = candidates[1];
  const isTransition = top && top.regime !== currentRaw;
  const headline = (() => {
    if (status === "warming") {
      return `collecting data — ${histSamples}/5 samples needed before forecast is reliable.`;
    }
    if (status === "degraded") {
      return "audit incomplete — predictor running on partial data.";
    }
    if (!top) return "no signal yet.";
    const pct = Math.round(top.probability * 100);
    if (isTransition) {
      return `${prettyRegime(top.regime)} likely next (${pct}%) — flipping from ${prettyRegime(currentRaw)} in next ${horizonMinutes}min.`;
    }
    return `${prettyRegime(currentRaw)} holds (${pct}%) — no transition expected in next ${horizonMinutes}min.`;
  })();

  const driverNotes: string[] = [];
  if (Math.abs(dfiSlopePerMin) > 0.05) {
    const dir = dfiSlopePerMin > 0 ? "rising" : "falling";
    driverNotes.push(`DFI ${dir} ${Math.abs(dfiSlopePerMin).toFixed(2)}/min toward ${nextBoundary ?? "—"}.`);
  }
  if (gammaFlipProxFrac < 0.25) driverNotes.push(`spot near gamma flip (${(gammaFlipProxFrac * 100).toFixed(0)}% of 1-day EM) — pin pressure.`);
  else if (gammaFlipProxFrac > 1.0) driverNotes.push(`spot far from pivot — trend has room.`);
  if (charmZeroProxFrac != null && charmZeroProxFrac < 0.20) driverNotes.push(`spot near charm zero — second pin.`);
  if (vannaBias === "positive") driverNotes.push(`vanna positive — supports trend continuation.`);
  else if (vannaBias === "negative") driverNotes.push(`vanna negative — destabilizes trend, favors chop.`);
  if (ivTermDelta > 0.02) driverNotes.push(`IV expanding (${ivTermLabel}) — vol regime.`);
  else if (ivTermDelta < -0.02) driverNotes.push(`IV bleeding (${ivTermLabel}) — chop drift.`);
  if (macroStress === "stress") driverNotes.push(`VIX backwardation — macro stress active.`);
  else if (macroStress === "calm") driverNotes.push(`steep contango — vol-bleed environment.`);
  if (Math.abs(whalePressure) > 0.4) driverNotes.push(`whale flow ${whalePressure > 0 ? "bullish" : "bearish"} (${(whalePressure * 100).toFixed(0)}%) — herding pressure.`);
  if (sessionFrac < 0.25) driverNotes.push(`<1.5hr to close — pin/chop bias rising.`);
  else if (sessionFrac > 0.75) driverNotes.push(`first 1.5hr of RTH — direction-setting window.`);
  if (flipRate > 0.3) driverNotes.push(`high flip rate (${flipRate.toFixed(2)}/min) — uncertain regime.`);

  return {
    currentRegime: currentRaw,
    candidates,
    horizonMinutes,
    confidence,
    status,
    headline,
    driverNotes,
    drivers: {
      dfi,
      dfiSlopePerMin,
      boundaryDistance,
      nextBoundary,
      ivTermDelta,
      ivTermLabel,
      gammaFlipProxFrac,
      charmZeroProxFrac,
      sessionFracRemaining: sessionFrac,
      flipRatePerMin: flipRate,
      flipsObserved: flips,
      historySamples: histSamples,
      vannaBias,
      vixTermRatio,
      macroStress,
      whalePressure,
    },
    generatedAt: nowMs,
  };
}

function prettyRegime(r: RegimeBucket): string {
  switch (r) {
    case "TREND_STRONG": return "strong trend";
    case "TREND_WEAK":   return "weak trend";
    case "NEUTRAL":      return "neutral";
    case "CHOP_WEAK":    return "light chop";
    case "CHOP_STRONG":  return "heavy chop";
  }
}
