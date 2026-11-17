// server/regimePredictor.ts
//
// Regime read — the regime bucket as read NOW, with a hand-set heuristic score
// per bucket and the drivers that support or weaken that read. It is not a
// forecast: no projection is made, and the top-scoring bucket is always the
// current regime (the function keeps the name predictTransition for its
// callers). Read-only, pure-function. Operates on a snapshot of audit + recent
// history.
//
// Existing system (do not touch):
//   - detectRegime(audit) in realtimeTargets.ts maps current audit to a
//     RegimeBucket via the gamma zone and the distance of spot from the
//     gamma flip (shared/gammaRegime.ts).
//   - applyRegimeHysteresis() requires STABILITY_TICKS=3 of the same raw
//     regime before _appliedRegime switches.
//
// What this module adds:
//   - A heuristic score (hand-set softmax weights, not calibrated
//     probabilities): how the drivers score each regime bucket for the current
//     read. Returns currentRegime, candidates[] sorted by score, drivers,
//     confidence.
//
// Drivers (each contributes a signed pressure toward a regime):
//   1. The current regime bucket (gamma zone + distance of spot from the gamma
//      flip in 1-day expected moves), carried forward. NO projection of the
//      flip distance is made: a slope over a few samples of spot is tick
//      noise, and extrapolating it over the horizon turned 2-point moves into
//      opposite-family calls. (Until 2026-11-17 this was a "DFI" boundary /
//      slope / projected DFI; DFI was pinned at +5 / -5, so none of it could
//      move. Removed.)
//   2. IV term DoD (iv1d delta). Negative = vol bleed = chop drift. Positive
//      vol expansion = trend pressure.
//   3. Distance of spot from the main pivot and from the charm zero, in 1-day
//      expected moves. Close to either weakens a trend read.
//   4. Session time remaining. A hand-set chop weight in the last 1.5 hours
//      and a trend weight in the first 1.5 hours.
//   5. Recent flip frequency from rolling raw-regime history. High flip rate
//      = low confidence = elevated NEUTRAL probability.
//
// All math is bounded, fail-soft, and independent of any LLM.

import { gammaZoneEffect } from "./gammaZone";
import { FLIP_DISTANCE_STRONG_EM, dexSlopeSignFromAudit, dexSlopeSignValue, flipDistanceEM, regimeBucketFor, type DexSlopeSign } from "@shared/gammaRegime";

type RegimeBucket =
  | "TREND_STRONG"
  | "TREND_WEAK"
  | "NEUTRAL"
  | "CHOP_WEAK"
  | "CHOP_STRONG"
  // Round 4: GEX missing or immaterial ("y?"). Its own state, never NEUTRAL:
  // the buckets below are defined by the gamma sign, so none applies.
  | "GAMMA_UNKNOWN"
  // No gamma zone in the audit at all: no regime is read from nothing.
  | "INPUTS_UNAVAILABLE";

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
}

const HISTORY_CAP = 32;
const _history: RawSample[] = [];

/** Public observer hook — call from any place that has a fresh audit. */
export function recordRawRegime(raw: RegimeBucket, ts: number = Date.now()): void {
  // A regime read from missing inputs is not a sample.
  if (raw === "INPUTS_UNAVAILABLE") return;
  try {
    _history.push({ ts, raw });
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

/**
 * Regime flips per minute over the known-gamma samples only: a GAMMA_UNKNOWN
 * sample is a data dropout, so known -> unknown -> known is not two flips.
 */
export function flipRateOf(history: ReadonlyArray<{ ts: number; raw: string }>): { rate: number; flips: number; samples: number } {
  const h = history.filter((x) => x.raw !== "GAMMA_UNKNOWN" && x.raw !== "INPUTS_UNAVAILABLE");
  if (h.length < 3) return { rate: 0, flips: 0, samples: h.length };
  let flips = 0;
  for (let i = 1; i < h.length; i++) {
    if (h[i].raw !== h[i - 1].raw) flips++;
  }
  const dtMin = Math.max(0.5, (h[h.length - 1].ts - h[0].ts) / 60_000);
  return { rate: flips / dtMin, flips, samples: h.length };
}

function flipRateFromHistory(): { rate: number; flips: number; samples: number } {
  return flipRateOf(_history);
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
    vixTermRatio?: number | null; // VIX9D / VIX30D. >1 = backwardation = stress; <0.95 = steep contango = calm
    dxyDelta?: number | null;     // intraday %
    tnxDelta?: number | null;     // intraday %
  } | null;
  /** Optional large-print signal: net call-minus-put premium of large SPY prints over the last 30min, normalized -1..+1. */
  whalePressure?: number | null;
}

export interface RegimeCandidate {
  regime: RegimeBucket;
  /**
   * Hand-set softmax weight in 0..1 (sums to 1 over candidates). It is a
   * heuristic score, NOT a calibrated probability: the driver weights are not
   * fitted to outcomes. Kept under this name for existing readers; the UI
   * shows `score` (0..100) instead.
   */
  probability: number;
  /** probability * 100, rounded to 1 decimal: a heuristic score out of 100, not a likelihood. */
  score: number;
  isCurrent: boolean;
}

export interface RegimePredictorOutput {
  currentRegime: RegimeBucket;
  candidates: RegimeCandidate[];
  horizonMinutes: number;
  confidence: number; // 0..1 heuristic (max softmax weight x sample quality), not a calibrated probability
  /** confidence * 100, 1 decimal: heuristic confidence score out of 100. */
  confidenceScore: number;
  /** Always "heuristic_softmax_weight": the scores are hand-set weights, not calibrated probabilities. */
  scoreKind: "heuristic_softmax_weight";
  /** "warming" when historySamples<5; "ready" when ok; "degraded" when missing audit fields. */
  status: "ready" | "warming" | "degraded";
  /** Plain-English headline for the UI (already synthesized server-side). */
  headline: string;
  /** Plain-English bullets explaining the top drivers right now. */
  driverNotes: string[];
  drivers: {
    /** Sign of the dealer delta-exposure slope at spot. A sign only, shown as a secondary fact; it does not score any regime. */
    dexSlopeSign: DexSlopeSign;
    /** @deprecated The same sign as +1 / -1 / 0; null when unavailable. Was the pinned "DFI". */
    dfi: number | null;
    /** @deprecated Always null: the "DFI slope" could never move and is removed. */
    dfiSlopePerMin: null;
    /** Signed distance of spot from the gamma flip in 1-day expected moves (+ above the flip); null when the flip or the EM is missing. */
    flipDistanceEM: number | null;
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

/** A day-over-day VIX move of at least this many points counts as vol expanding or bleeding (the label threshold in models.ts). */
const IV_TERM_MOVE_PTS = 1.0;

/**
 * Read the current regime and score each bucket for that read (no forecast: the
 * top-scoring bucket is always the current regime; horizonMinutes is echoed for
 * the outcome logger, which grades the carried regime over it).
 * Pure-function, fail-soft, returns sane defaults on any error.
 */
export function predictTransition(input: RegimePredictorInput): RegimePredictorOutput {
  const nowMs = input.nowMs ?? Date.now();
  const horizonMinutes = input.horizonMinutes ?? 20;

  const audit = input.audit ?? {};
  // Missing inputs are missing, not zero: a null pivot or 1-day EM makes the
  // call "degraded" with no candidates, instead of a pivot-distance note read
  // from nothing. The DEX slope sign is reported, not scored.
  const dexSlopeSign = dexSlopeSignFromAudit(audit);
  const pivotMissing = audit.mainPivot == null || !Number.isFinite(Number(audit.mainPivot));
  const emMissing = audit.scenarioTargets?.oneDayEM == null || !Number.isFinite(Number(audit.scenarioTargets.oneDayEM)) || Number(audit.scenarioTargets.oneDayEM) <= 0;
  const missingInputs = [audit.gammaZone == null ? "gamma zone" : null, pivotMissing ? "main pivot" : null, emMissing ? "1-day expected move" : null].filter(Boolean) as string[];
  const slopeText = String(audit.slope ?? "");
  // Slope text e.g. "DN 0.31° → -0.61"; second number is signed magnitude
  const matches = slopeText.match(/-?\d+(\.\d+)?/g) ?? [];
  const slopeMag = Math.abs(parseFloat(matches[1] ?? "0") || 0);
  const slopeSigned = parseFloat(matches[1] ?? "0") || 0;

  // Gamma flip distance: spot vs the zero-gamma level, in 1-day expected moves.
  const spot = Number(input.spot ?? audit.spot ?? 0);
  const flipDist = flipDistanceEM(spot, audit.gammaFlip, audit.scenarioTargets?.oneDayEM);

  const currentRaw: RegimeBucket = regimeBucketFor(audit.gammaZone, flipDist);

  // Drivers
  const histSamples = Math.min(6, _history.length);
  const { rate: flipRate, flips } = flipRateFromHistory();

  // IV term DoD
  const term = audit.termStructureDoD ?? {};
  // Day-over-day change in VIX POINTS. iv1dDelta is a daily sigma in percent (about 18x smaller) and was
  // tested here against a vol-point threshold, so the vol driver needed a ~4.5-point VIX day.
  const ivTermDelta = Number(term.vixDeltaPts ?? 0);
  const ivTermLabel = String(term.label ?? "Flat");

  // Gamma flip proximity — spot vs mainPivot, normalized by oneDayEM
  const pivot = pivotMissing ? NaN : Number(audit.mainPivot);
  const oneDayEM = emMissing ? NaN : Math.max(0.5, Number(audit.scenarioTargets.oneDayEM));
  // NaN when any input is missing: no proximity driver fires from it.
  const gammaFlipProxFrac = pivotMissing || emMissing ? NaN : clamp(Math.abs(spot - pivot) / oneDayEM, 0, 5);

  const sessionFrac = sessionFracRemaining(nowMs);

  // ─── Score each candidate regime ───
  // Base score = the current raw regime, carried forward. No flip-distance projection is made
  // (see the header): the other drivers below are the only adjustments.
  const scores: Record<RegimeBucket, number> = {
    TREND_STRONG: 0,
    TREND_WEAK: 0,
    NEUTRAL: 0,
    CHOP_WEAK: 0,
    CHOP_STRONG: 0,
    GAMMA_UNKNOWN: 0, // never scored: not in ALL_REGIMES
    INPUTS_UNAVAILABLE: 0,
  };

  // 1) + 2) the current raw regime carries both base bumps (2.5 that used to go to the
  //    "projected" regime, which was always the current one while DFI was pinned, + 1.8 prior)
  scores[currentRaw] += 2.5 + 1.8;

  // 3) IV term direction
  // Same 1.0 VIX point as the "Vol Bid Up / Vol Offered" label printed beside it (models.ts).
  if (ivTermDelta >= IV_TERM_MOVE_PTS) {
    // vol expansion → favor TREND
    scores.TREND_STRONG += 0.6;
    scores.TREND_WEAK += 0.4;
    scores.CHOP_STRONG -= 0.4;
    scores.CHOP_WEAK -= 0.2;
  } else if (ivTermDelta <= -IV_TERM_MOVE_PTS) {
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

  // 5) Session time remaining — hand-set late-day chop weight
  if (sessionFrac < 0.25) {
    // last 1.5 hr — chop weight
    scores.CHOP_STRONG += 0.5;
    scores.CHOP_WEAK += 0.3;
    scores.TREND_STRONG -= 0.3;
  } else if (sessionFrac > 0.75) {
    // first 1.5 hr — hand-set trend weight
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

  // 8) (removed: boundary-crossing bonus for a projected regime; no projection is made)

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

  // 10) Charm zero proximity — second pivot, same kind of weight as the mainPivot distance
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

  // 11) Macro regime — vixTermRatio = VIX9D / VIX30D.
  //   ratio > 1   → backwardation (front IV > 30d IV) → STRESS, vol expansion → TREND/NEUTRAL
  //   ratio < 0.95 → steep contango (front much cheaper than 30d) → CALM, vol bleed → CHOP
  //   0.95–1.10 → normal
  // (Bug fix 2026-05-08: prior version had inverted thresholds — it labeled
  //  contango as stress and ignored real backwardation entirely.)
  const vixTermRatio = input.macro?.vixTermRatio ?? null;
  let macroStress: "calm" | "normal" | "stress" = "normal";
  if (vixTermRatio != null && Number.isFinite(vixTermRatio)) {
    if (vixTermRatio > 1.05) {
      // VIX9D > VIX30D → backwardation → vol expansion likely
      macroStress = "stress";
      scores.TREND_STRONG += 0.3;
      scores.NEUTRAL += 0.3;
      scores.CHOP_WEAK -= 0.2;
    } else if (vixTermRatio < 0.95) {
      // Steep contango → vol bleed → chop favored
      macroStress = "calm";
      scores.CHOP_STRONG += 0.3;
      scores.CHOP_WEAK += 0.2;
      scores.TREND_STRONG -= 0.2;
    }
  }

  // 12) Large-print pressure — net signed premium last 30min adds weight to the TREND buckets
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
    score: Math.round(probs[r] * 1000) / 10,
    isCurrent: r === currentRaw,
  })).sort((a, b) => b.probability - a.probability);

  // ─── Status gating ─── warming-up if not enough samples
  let status: "ready" | "warming" | "degraded" = "ready";
  if (histSamples < 5) status = "warming";
  if (missingInputs.length || gammaZoneEffect(audit.gammaZone) === "unknown") status = "degraded";

  // ─── Plain-English synthesis ───
  const top = candidates[0];
  const headline = (() => {
    if (status === "warming") {
      return `collecting data — ${histSamples}/5 samples needed before the regime read is formed.`;
    }
    if (status === "degraded") {
      return missingInputs.length
        ? `no regime call: ${missingInputs.join(", ")} not available in this build.`
        : "audit incomplete — predictor running on partial data.";
    }
    if (!top) return "no signal yet.";
    // Heuristic score out of 100 (hand-set softmax weight), not a probability.
    const pct = Math.round(top.probability * 100);
    // The top-scoring bucket is always the current regime: this is the read now, not a forecast.
    return `${prettyRegime(currentRaw)} is the regime read now (heuristic ${pct}/100, a hand-set score, not a probability). This is the current read carried forward, not a forecast.`;
  })();

  const driverNotes: string[] = [];
  if (flipDist != null) {
    driverNotes.push(`spot ${Math.abs(flipDist).toFixed(2)} expected moves ${flipDist >= 0 ? "above" : "below"} the gamma flip (${Math.abs(flipDist) >= FLIP_DISTANCE_STRONG_EM ? "at or beyond" : "inside"} the ${FLIP_DISTANCE_STRONG_EM} line).`);
  }
  driverNotes.push("no flip-distance projection is made: the current regime is carried forward, adjusted by the other drivers.");
  // Each note states the measurement and which way its hand-set weight leans; none is a forecast.
  if (gammaFlipProxFrac < 0.25) driverNotes.push(`spot is ${gammaFlipProxFrac.toFixed(2)} expected moves from the main pivot (under 0.25): weighs against a strong-trend read.`);
  else if (gammaFlipProxFrac > 1.0) driverNotes.push(`spot is ${gammaFlipProxFrac.toFixed(2)} expected moves from the main pivot (over 1.0): weighs toward a trend read.`);
  if (charmZeroProxFrac != null && charmZeroProxFrac < 0.20) driverNotes.push(`spot is ${charmZeroProxFrac.toFixed(2)} expected moves from the charm zero (under 0.20): weighs toward a chop read.`);
  if (vannaBias === "positive") driverNotes.push(`vanna exposure positive: weighs toward a trend read.`);
  else if (vannaBias === "negative") driverNotes.push(`vanna exposure negative: weighs toward a chop read.`);
  if (ivTermDelta >= IV_TERM_MOVE_PTS) driverNotes.push(`VIX up ${ivTermDelta.toFixed(1)} points day over day (${ivTermLabel}): weighs toward a trend read.`);
  else if (ivTermDelta <= -IV_TERM_MOVE_PTS) driverNotes.push(`VIX down ${Math.abs(ivTermDelta).toFixed(1)} points day over day (${ivTermLabel}): weighs toward a chop read.`);
  if (macroStress === "stress") driverNotes.push(`VIX9D above VIX (ratio ${(vixTermRatio as number).toFixed(2)}, backwardation): weighs toward a trend or neutral read.`);
  else if (macroStress === "calm") driverNotes.push(`VIX9D below VIX (ratio ${(vixTermRatio as number).toFixed(2)}, steep contango): weighs toward a chop read.`);
  if (Math.abs(whalePressure) > 0.4) driverNotes.push(`large SPY option prints, last 30 minutes: ${Math.abs(whalePressure * 100).toFixed(0)}% net premium on the ${whalePressure > 0 ? "call" : "put"} side (calls counted +, puts -, by premium; the buyer or seller side is not known): weighs toward a trend read.`);
  if (sessionFrac < 0.25) driverNotes.push(`under 1.5 hours to the close: a hand-set weight toward a chop read.`);
  else if (sessionFrac > 0.75) driverNotes.push(`first 1.5 hours of the session: a hand-set weight toward a trend read.`);
  if (flipRate > 0.3) driverNotes.push(`the regime read changed ${flipRate.toFixed(2)} times per minute over the recent samples: weighs toward a neutral read.`);

  // Gamma unknown, or an input missing: no bucket applies, so no candidates,
  // no confidence (the outcome logger skips confidence < 0.3) and no drivers
  // computed from the missing value.
  const gammaUnknown = currentRaw === "GAMMA_UNKNOWN";
  const noRead = gammaUnknown || missingInputs.length > 0;
  return {
    currentRegime: currentRaw,
    candidates: noRead ? [] : candidates,
    horizonMinutes,
    confidence: noRead ? 0 : confidence,
    confidenceScore: noRead ? 0 : Math.round(confidence * 1000) / 10,
    scoreKind: "heuristic_softmax_weight",
    status,
    headline: gammaUnknown
      ? "gamma unknown (GEX missing or immaterial at spot): no regime reading; the trend/chop buckets need the gamma sign."
      : missingInputs.length
        ? `no regime call: ${missingInputs.join(", ")} not available in this build.`
        : headline,
    driverNotes: noRead ? driverNotes.filter((n) => !/gamma flip|main pivot|charm zero|flip distance|flip-distance/.test(n)) : driverNotes,
    drivers: {
      dexSlopeSign,
      dfi: dexSlopeSign === "unavailable" ? null : dexSlopeSignValue(dexSlopeSign),
      dfiSlopePerMin: null,
      flipDistanceEM: flipDist,
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
    case "GAMMA_UNKNOWN": return "gamma unknown";
    case "INPUTS_UNAVAILABLE": return "inputs unavailable";
  }
}
