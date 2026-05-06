// server/realtimeTargets.ts
//
// Real-time CLOSE TARGETS compression.
//
// Problem: the model's `audit.scenarioTargets` is computed off the EOD picture
// — full-session vol, full-day expected move. At 9:30 ET that's exactly what
// we want. At 3:50 ET it's stale: the day's range is mostly realized, IV has
// bled, and a target that's 40 pts away with 10 minutes left is fantasy.
//
// We need the same target NUMBER to compress as the session ages so the card
// gives us a tight, fade-able range to take calls / puts off of as we hover
// near the actual bull/bear endpoints.
//
// User picked the BLENDED approach (regime-weighted mix of three methods):
//
//   1. SQRT-TIME DECAY        — shrink scenarioTargets by sqrt(t_left / t_full)
//                               around the BASE midpoint. Smooth, vol-correct.
//   2. SPOT REANCHOR + DECAY  — recenter midpoint on live spot, then sqrt-decay
//                               around live spot. Best on TREND days where
//                               scenarioBase has drifted away from realized.
//   3. RANGE-AWARE (HOD/LOD)  — clip targets to today's realized HOD/LOD bracket
//                               extended by remaining-day expected move. Best
//                               on CHOP days where realized range is the cage.
//
// Regime weighting (from audit.dfi + audit.gammaZone + slope direction):
//
//   TREND_STRONG  -> reanchor 0.55, sqrt 0.30, range 0.15
//   TREND_WEAK    -> reanchor 0.40, sqrt 0.40, range 0.20
//   NEUTRAL       -> reanchor 0.20, sqrt 0.55, range 0.25
//   CHOP_WEAK     -> reanchor 0.10, sqrt 0.40, range 0.50
//   CHOP_STRONG   -> reanchor 0.05, sqrt 0.30, range 0.65
//
// Read-only. Pure function. Try/catch wrapped at every external surface.

import { getPriceHistory } from "./schwab";

// ─── Time helpers (America/New_York session math) ──────────────────────

const RTH_OPEN_HH = 9;
const RTH_OPEN_MM = 30;
const RTH_CLOSE_HH = 16;
const RTH_CLOSE_MM = 0;
const RTH_FULL_MINUTES = (16 - 9) * 60 + (0 - 30); // 390 min

function etParts(ms: number): {
  dateKey: string;
  hh: number;
  mm: number;
  ss: number;
} {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "0";
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  const hh = parseInt(get("hour"), 10);
  const mm = parseInt(get("minute"), 10);
  const ss = parseInt(get("second"), 10);
  return { dateKey, hh, mm, ss };
}

/**
 * Fraction of RTH session remaining at the given timestamp.
 * Returns 1.0 before 9:30 ET, 0.0 after 16:00 ET, linear in between.
 */
export function sessionFractionRemaining(nowMs: number = Date.now()): number {
  const { hh, mm, ss } = etParts(nowMs);
  // Convert ET wall-clock to minutes since 9:30
  const minsFromOpen =
    (hh - RTH_OPEN_HH) * 60 + (mm - RTH_OPEN_MM) + ss / 60;
  if (minsFromOpen <= 0) return 1.0;
  if (minsFromOpen >= RTH_FULL_MINUTES) return 0.0;
  return Math.max(0, Math.min(1, 1 - minsFromOpen / RTH_FULL_MINUTES));
}

// ─── HOD / LOD pull (from Schwab 1m bars, today only) ──────────────────

interface SessionRange {
  hod: number | null;
  lod: number | null;
  source: "schwab" | "none";
  barCount: number;
}

let _rangeCache: { ts: number; payload: SessionRange | null } = { ts: 0, payload: null };
const RANGE_CACHE_TTL_MS = 30_000;

async function fetchSessionRange(symbol: string): Promise<SessionRange> {
  const now = Date.now();
  if (_rangeCache.payload && now - _rangeCache.ts < RANGE_CACHE_TTL_MS) {
    return _rangeCache.payload;
  }
  try {
    const resp = await getPriceHistory(symbol, "day", 2, "minute", 1);
    if (!resp || (resp as any).error || !(resp as any).candles?.length) {
      const out: SessionRange = { hod: null, lod: null, source: "none", barCount: 0 };
      _rangeCache = { ts: now, payload: out };
      return out;
    }
    const candles = ((resp as any).candles as Array<{
      datetime: number;
      high: number;
      low: number;
    }>);
    // Filter to TODAY's RTH only (>= 9:30 ET on today's ET date)
    const todayKey = etParts(now).dateKey;
    let hod: number | null = null;
    let lod: number | null = null;
    let n = 0;
    for (const c of candles) {
      const p = etParts(c.datetime);
      if (p.dateKey !== todayKey) continue;
      const m = (p.hh - RTH_OPEN_HH) * 60 + (p.mm - RTH_OPEN_MM);
      if (m < 0) continue;
      if (m > RTH_FULL_MINUTES) continue;
      if (hod == null || c.high > hod) hod = c.high;
      if (lod == null || c.low < lod) lod = c.low;
      n++;
    }
    const out: SessionRange = {
      hod,
      lod,
      source: ((resp as any).source as "schwab") ?? "schwab",
      barCount: n,
    };
    _rangeCache = { ts: now, payload: out };
    return out;
  } catch {
    return { hod: null, lod: null, source: "none", barCount: 0 };
  }
}

// ─── Regime detection ──────────────────────────────────────────────────

type RegimeBucket = "TREND_STRONG" | "TREND_WEAK" | "NEUTRAL" | "CHOP_WEAK" | "CHOP_STRONG";

function detectRegime(audit: any): RegimeBucket {
  const dfi = Math.abs(Number(audit?.dfi ?? 0));
  // dfi is normalized [-5..+5]. dominantMag/charm-flat regime in y/y+ → chop
  const gZone = String(audit?.gammaZone ?? "").toLowerCase();
  const inGammaPocket = gZone === "y" || gZone === "y+";
  // Slope text e.g. "DN 0.70° → -1.40" — magnitude proxy
  const slopeText = String(audit?.slope ?? "");
  const slopeMag = Math.abs(parseFloat(slopeText.match(/-?\d+(\.\d+)?/g)?.[1] ?? "0"));

  if (dfi >= 3.5 && !inGammaPocket) return "TREND_STRONG";
  if (dfi >= 2.0 && !inGammaPocket) return "TREND_WEAK";
  if (dfi >= 1.0 && inGammaPocket && slopeMag < 1.5) return "CHOP_WEAK";
  if (dfi < 1.0 && inGammaPocket) return "CHOP_STRONG";
  if (dfi >= 2.0 && inGammaPocket) return "CHOP_WEAK";
  return "NEUTRAL";
}

const REGIME_WEIGHTS: Record<
  RegimeBucket,
  { reanchor: number; sqrt: number; range: number }
> = {
  TREND_STRONG: { reanchor: 0.55, sqrt: 0.30, range: 0.15 },
  TREND_WEAK: { reanchor: 0.40, sqrt: 0.40, range: 0.20 },
  NEUTRAL: { reanchor: 0.20, sqrt: 0.55, range: 0.25 },
  CHOP_WEAK: { reanchor: 0.10, sqrt: 0.40, range: 0.50 },
  CHOP_STRONG: { reanchor: 0.05, sqrt: 0.30, range: 0.65 },
};

// ─── Regime hysteresis ─────────────────────────────────────────────────
// Audit fix: prevent regime flapping at the boundary (e.g. dfi oscillating
// 1.95↔2.05 between TREND_WEAK and NEUTRAL) from rapidly re-weighting targets
// every tick. Require the candidate regime to be stable for STABILITY_TICKS
// consecutive observations before applying it. Until then, keep using the
// last *applied* regime.
const STABILITY_TICKS = 3;
let _appliedRegime: RegimeBucket | null = null;
let _candidateRegime: RegimeBucket | null = null;
let _candidateStreak = 0;

function applyRegimeHysteresis(rawRegime: RegimeBucket): {
  applied: RegimeBucket;
  raw: RegimeBucket;
  streak: number;
  switched: boolean;
} {
  // First-ever observation — lock in immediately
  if (_appliedRegime == null) {
    _appliedRegime = rawRegime;
    _candidateRegime = rawRegime;
    _candidateStreak = STABILITY_TICKS;
    return { applied: rawRegime, raw: rawRegime, streak: STABILITY_TICKS, switched: true };
  }
  // Same as currently applied — reset candidate streak (no transition pending)
  if (rawRegime === _appliedRegime) {
    _candidateRegime = rawRegime;
    _candidateStreak = STABILITY_TICKS;
    return { applied: _appliedRegime, raw: rawRegime, streak: STABILITY_TICKS, switched: false };
  }
  // Different from applied — build/extend candidate streak
  if (rawRegime === _candidateRegime) {
    _candidateStreak += 1;
  } else {
    _candidateRegime = rawRegime;
    _candidateStreak = 1;
  }
  if (_candidateStreak >= STABILITY_TICKS) {
    const prev = _appliedRegime;
    _appliedRegime = rawRegime;
    return { applied: rawRegime, raw: rawRegime, streak: _candidateStreak, switched: prev !== rawRegime };
  }
  // Not stable yet — stick with last applied regime
  return { applied: _appliedRegime, raw: rawRegime, streak: _candidateStreak, switched: false };
}

/** Test/dev hook — reset hysteresis state. */
export function _resetRegimeHysteresis(): void {
  _appliedRegime = null;
  _candidateRegime = null;
  _candidateStreak = 0;
}

// ─── Three method primitives ───────────────────────────────────────────

interface Triple {
  bull: number;
  base: number;
  bear: number;
}

/**
 * Method 1: sqrt-time decay around the model's BASE midpoint.
 * As session ages, bull/bear collapse toward base by sqrt(t_left/t_full).
 */
function sqrtTimeDecay(eod: Triple, fracRemaining: number): Triple {
  const f = Math.sqrt(Math.max(0, Math.min(1, fracRemaining)));
  return {
    bull: eod.base + (eod.bull - eod.base) * f,
    base: eod.base,
    bear: eod.base + (eod.bear - eod.base) * f,
  };
}

/**
 * Method 2: spot reanchor — collapse around live spot, then sqrt-decay.
 * Use when the day has drifted away from scenarioBase.
 */
function spotReanchorDecay(eod: Triple, spot: number, fracRemaining: number): Triple {
  const f = Math.sqrt(Math.max(0, Math.min(1, fracRemaining)));
  // Preserve EOD asymmetry (bull-base spread vs base-bear spread) but reanchor on spot
  const bullSpread = Math.max(0, eod.bull - eod.base);
  const bearSpread = Math.max(0, eod.base - eod.bear);
  return {
    bull: spot + bullSpread * f,
    base: spot,
    bear: spot - bearSpread * f,
  };
}

/**
 * Method 3: range-aware. Today's HOD/LOD is the realized cage.
 * Bull = max(spot, HOD) + remaining-day move budget (sqrt-decayed).
 * Bear = min(spot, LOD) − remaining-day move budget (sqrt-decayed).
 * If bars are missing, falls back to sqrt-time decay.
 */
function rangeAware(
  eod: Triple,
  spot: number,
  oneDayEM: number,
  fracRemaining: number,
  range: SessionRange,
): Triple {
  if (range.hod == null || range.lod == null) {
    return sqrtTimeDecay(eod, fracRemaining);
  }
  const f = Math.sqrt(Math.max(0, Math.min(1, fracRemaining)));
  // Remaining move budget for today (one-sided)
  const budget = (oneDayEM ?? Math.abs(eod.bull - eod.bear) / 2) * f * 0.5;
  return {
    bull: Math.max(spot, range.hod) + budget,
    base: spot,
    bear: Math.min(spot, range.lod) - budget,
  };
}

// ─── Public: compute compressed real-time targets ──────────────────────

export interface RealtimeTargetsInput {
  /** Live spot price */
  spot: number;
  /** audit.scenarioTargets from /api/models */
  scenarioTargets: { bull: number; base: number; bear: number; oneDayEM?: number };
  /** audit object (uses dfi, gammaZone, slope for regime detection) */
  audit: any;
  /** Override now (for testing) */
  nowMs?: number;
  /** Symbol for HOD/LOD lookup; default ^GSPC */
  symbol?: string;
}

export interface RealtimeTargetsOutput {
  /** Compressed bull/base/bear (the headline numbers for the card) */
  compressed: Triple;
  /** Untouched EOD targets, for transparency */
  eod: Triple;
  /** Diagnostic detail */
  diag: {
    regime: RegimeBucket;
    /** Raw regime detected this tick (before hysteresis filter) */
    regimeRaw: RegimeBucket;
    /** Stability streak of the raw regime; weights re-apply only at >= 3 */
    regimeStreak: number;
    /** True if hysteresis just transitioned applied regime this tick */
    regimeSwitched: boolean;
    weights: { reanchor: number; sqrt: number; range: number };
    fracRemaining: number;
    minutesRemaining: number;
    methods: { sqrt: Triple; reanchor: Triple; range: Triple };
    sessionRange: SessionRange;
    /** Compression % vs EOD: 0 = no compression, 1 = fully collapsed to base */
    compressionPct: { bull: number; bear: number };
  };
}

export async function computeRealtimeTargets(
  input: RealtimeTargetsInput,
): Promise<RealtimeTargetsOutput> {
  const now = input.nowMs ?? Date.now();
  const fracRemaining = sessionFractionRemaining(now);
  const minutesRemaining = Math.round(fracRemaining * RTH_FULL_MINUTES);

  const eod: Triple = {
    bull: Number(input.scenarioTargets?.bull ?? input.spot),
    base: Number(input.scenarioTargets?.base ?? input.spot),
    bear: Number(input.scenarioTargets?.bear ?? input.spot),
  };
  const oneDayEM = Number(input.scenarioTargets?.oneDayEM ?? 0);

  const symbol = input.symbol ?? "^GSPC";
  let sessionRange: SessionRange = { hod: null, lod: null, source: "none", barCount: 0 };
  try {
    sessionRange = await fetchSessionRange(symbol);
  } catch {
    // leave default
  }

  const m_sqrt = sqrtTimeDecay(eod, fracRemaining);
  const m_reanchor = spotReanchorDecay(eod, input.spot, fracRemaining);
  const m_range = rangeAware(eod, input.spot, oneDayEM, fracRemaining, sessionRange);

  const rawRegime = detectRegime(input.audit ?? {});
  const hyst = applyRegimeHysteresis(rawRegime);
  const regime = hyst.applied;
  const w = REGIME_WEIGHTS[regime];

  const blend = (a: number, b: number, c: number) =>
    a * w.sqrt + b * w.reanchor + c * w.range;

  const compressed: Triple = {
    bull: blend(m_sqrt.bull, m_reanchor.bull, m_range.bull),
    base: blend(m_sqrt.base, m_reanchor.base, m_range.base),
    bear: blend(m_sqrt.bear, m_reanchor.bear, m_range.bear),
  };

  // Sanity: ensure bull >= base >= bear (rare blend artifact when spot is
  // outside [bear,bull] range). If violated, snap to monotonic.
  if (compressed.bull < compressed.base) compressed.bull = compressed.base;
  if (compressed.bear > compressed.base) compressed.bear = compressed.base;

  const eodBullSpread = Math.max(0.001, eod.bull - eod.base);
  const eodBearSpread = Math.max(0.001, eod.base - eod.bear);
  const liveBullSpread = Math.max(0, compressed.bull - compressed.base);
  const liveBearSpread = Math.max(0, compressed.base - compressed.bear);
  const compressionBull = Math.max(0, Math.min(1, 1 - liveBullSpread / eodBullSpread));
  const compressionBear = Math.max(0, Math.min(1, 1 - liveBearSpread / eodBearSpread));

  return {
    compressed,
    eod,
    diag: {
      regime,
      regimeRaw: hyst.raw,
      regimeStreak: hyst.streak,
      regimeSwitched: hyst.switched,
      weights: w,
      fracRemaining,
      minutesRemaining,
      methods: { sqrt: m_sqrt, reanchor: m_reanchor, range: m_range },
      sessionRange,
      compressionPct: { bull: compressionBull, bear: compressionBear },
    },
  };
}
