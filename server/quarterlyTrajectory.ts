/**
 * quarterlyTrajectory.ts  —  v2 (precision pass)
 *
 * Builds a week-by-week (13-week) bull/base/bear trajectory for the 3-month
 * horizon — instead of just the endpoint targets that applyTermStructureRescale
 * produces.
 *
 * v2 upgrades over v1:
 *   1. VRP scaling — σ damped by realized-vol / implied-vol ratio (clamped 0.7–1.3).
 *   2. Term-structure σ segmentation — wk1-4 use VIX9D, wk5-8 VIX, wk9-13 VIX3M.
 *      Smooth weighted blend at boundaries so the cone doesn't kink.
 *   3. Skew-adjusted drift — CBOE SKEW (100-150) drives an extra bearish drift
 *      component when tail-hedging demand is elevated.
 *   4. OPEX/FOMC σ bumps — event-week sigma expands +12% on monthly OPEX (3rd
 *      Fri) and FOMC weeks; tagged in the weekly output.
 *
 * For each week k ∈ [1..13]:
 *   - σ(k) = spot · (vixSegmented(k)/100) · √(k/52) · vrpScale · damp(k) · eventBump(k)
 *   - drift(k) = (driftPerWeek) · k     (linear; sums composite + GEX + VIX term + skew)
 *   - mean(k)  = spot · (1 + drift(k)) - magnetPull(k)
 *   - bull(k)  = mean(k) + σ(k)
 *   - bear(k)  = mean(k) - σ(k)
 *   - damp(k)  = 1 - 0.15·(k/13)
 *
 * Anchors pull the BASE path. Walls/flip = primary (weight 1.0); max pain +
 * JPM = secondary (weight 0.4–0.6). Pull capped at ±4%/wk per anchor.
 *
 * Returns a structure the client renders as a 3-line fan chart with anchor
 * horizontals + event markers.
 */

export interface WeeklyPoint {
  weekIndex: number;       // 1..13
  weekLabel: string;       // "WK1", "WK2", ...
  weekEndDate: string;     // YYYY-MM-DD ET
  bull: number;
  base: number;
  bear: number;
  sigmaWeek: number;       // INCREMENTAL σ for this single week (events visible here)
  sigmaCum: number;        // CUMULATIVE σ thru week k = sqrt(Σ σ_i² for i=1..k) — drives bull/bear cone
  cumDriftPct: number;     // cumulative drift % (base vs spot)
  events?: string[];       // ["OPEX"], ["FOMC"], ["OPEX","FOMC"], etc.
  vixSegment?: "VIX9D" | "VIX" | "VIX3M" | "BLEND";
}

export interface QuarterlyAnchor {
  level: number;
  label: string;
  kind: "callWall" | "putWall" | "gammaFlip" | "maxPain" | "jpmShortPut" | "jpmLongPut" | "jpmShortCall";
  strength: "primary" | "secondary";
}

export interface QuarterlyTrajectory {
  spot: number;
  asOf: number;             // unix sec
  weeks: WeeklyPoint[];
  endpoint: { bull: number; base: number; bear: number };
  anchors: QuarterlyAnchor[];
  drivers: {
    compositeTilt: number;       // weekly drift contribution from composite (decimal)
    gexTilt: number;             // weekly drift contribution from GEX regime (decimal)
    vixTermTilt: number;         // weekly drift contribution from VIX term (decimal)
    skewTilt: number;            // weekly drift contribution from CBOE SKEW (decimal)  [NEW v2]
    totalDriftPerWeek: number;   // sum of above (decimal)
    annualizedDrift: number;     // total*52 for display
    magnetCount: number;         // anchors actively pulling
    vrpRatio: number | null;     // RV / IV ratio (decimal, null if RV unknown)  [NEW v2]
    vrpScale: number;            // σ multiplier from VRP (clamped 0.7-1.3)  [NEW v2]
    eventWeeks: number;          // count of weeks with event bumps  [NEW v2]
  };
  inputs: {
    vix: number;
    vix9d: number | null;
    vix3m: number | null;
    callWall: number;
    putWall: number;
    gammaFlip: number;
    maxPain: number;
    totalGex: number;
    composite: number;
    skew: number | null;            // CBOE SKEW value 100-150  [NEW v2]
    realizedVol20d: number | null;  // 20D RV annualized decimal  [NEW v2]
  };
  methodology: string;
}

interface BuildInputs {
  spot: number;
  vix: number;                   // VIX 30d annualized %
  vix9d: number | null;
  vix3m: number | null;
  callWall: number;
  putWall: number;
  gammaFlip: number;
  maxPain: number;
  totalGex: number;              // sign drives regime
  composite: number;             // 0..100
  jpmStrikes?: { shortPut: number; longPut: number; shortCall: number } | null;
  skew?: number | null;          // CBOE SKEW 100-150 (tail-hedging demand)
  realizedVol20d?: number | null;  // 20D realized vol, annualized decimal (e.g. 0.18)
}

const WEEKS = 13;
const WEEKS_PER_YEAR = 52;
const SQRT_WEEK_FRAC = (k: number) => Math.sqrt(k / WEEKS_PER_YEAR);

/** Mean-reversion damping growing with horizon. Week 1 = 1.0, week 13 = 0.85. */
function damp(k: number): number {
  return 1 - 0.15 * (k / WEEKS);
}

/** ET date string for a week-end (Friday close) k weeks from now. */
function weekEndDateET(k: number): string {
  const now = new Date();
  // Find next Friday
  const day = now.getDay(); // 0=Sun..6=Sat
  const daysUntilFri = (5 - day + 7) % 7 || 7;
  const target = new Date(now);
  target.setDate(now.getDate() + daysUntilFri + (k - 1) * 7);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(target);
}

/** Parse YYYY-MM-DD into a Date at midnight ET (using UTC math is fine here for date arithmetic). */
function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Is this date within an OPEX week? OPEX = 3rd Friday of the month.
 * A "week" here = Mon-Fri of that calendar week (the week ending on Friday).
 */
function isOpexWeek(weekEndISO: string): boolean {
  const d = parseISO(weekEndISO);
  // weekEndISO is always a Friday. Is it the 3rd Friday of its month?
  const dayOfMonth = d.getUTCDate();
  return dayOfMonth >= 15 && dayOfMonth <= 21;
}

/**
 * Hardcoded FOMC meeting schedule for next ~12 months from May 2026 baseline.
 * Source: Fed published calendar. Two-day meetings; we tag the WEEK containing
 * the announcement Wednesday.
 *
 * As of May 2026, remaining FY26 meetings: Jun 16-17, Jul 28-29, Sep 15-16,
 * Oct 27-28, Dec 8-9. FY27: Jan 26-27, Mar 16-17, Apr 27-28, Jun 15-16, Jul 27-28.
 *
 * We list the Wednesday announcement date (the day market reacts).
 */
const FOMC_DATES_ET = [
  "2026-06-17",
  "2026-07-29",
  "2026-09-16",
  "2026-10-28",
  "2026-12-09",
  "2027-01-27",
  "2027-03-17",
  "2027-04-28",
];

/**
 * Is this week-ending Friday in a week that contains an FOMC announcement?
 * Friday ISO covers the work week Mon-Fri ending on that Friday.
 */
function isFomcWeek(weekEndISO: string): boolean {
  const friday = parseISO(weekEndISO);
  const monday = new Date(friday); monday.setUTCDate(friday.getUTCDate() - 4);
  return FOMC_DATES_ET.some((iso) => {
    const fomc = parseISO(iso);
    return fomc >= monday && fomc <= friday;
  });
}

/**
 * Pick segmented IV for a given week index k (1..13).
 *   k 1..4   → VIX9D heavy
 *   k 5..8   → VIX
 *   k 9..13  → VIX3M
 * Returns { iv, segmentLabel } in percent (e.g. 17.3 not 0.173).
 *
 * Smooth blend across boundaries to avoid kinks: 80/20 blend at boundary weeks.
 * Falls back gracefully when VIX9D or VIX3M missing.
 */
function pickSegmentedVix(
  k: number,
  vix: number,
  vix9d: number | null,
  vix3m: number | null,
): { iv: number; segment: WeeklyPoint["vixSegment"] } {
  // Defaults if specific segment unavailable
  const v9 = vix9d ?? vix;
  const v3 = vix3m ?? vix;

  if (k <= 3) return { iv: v9, segment: "VIX9D" };
  if (k === 4) return { iv: 0.6 * v9 + 0.4 * vix, segment: "BLEND" };
  if (k <= 7) return { iv: vix, segment: "VIX" };
  if (k === 8) return { iv: 0.4 * vix + 0.6 * v3, segment: "BLEND" };
  return { iv: v3, segment: "VIX3M" };
}

/**
 * Compute VRP scale: realized vol / implied vol ratio, clamped to [0.7, 1.3].
 * RV<IV → calmer than implied → narrow cone (typical: ratio 0.75-0.90).
 * RV>IV → realized is exceeding implied → widen cone (rare, regime change).
 *
 * Returns { ratio, scale } — ratio is the raw RV/IV (or null if RV unknown),
 * scale is the clamped multiplier applied to σ.
 */
function computeVrpScale(
  realizedVol20d: number | null | undefined,
  vix: number,
): { ratio: number | null; scale: number } {
  if (realizedVol20d == null || !isFinite(realizedVol20d) || realizedVol20d <= 0) {
    return { ratio: null, scale: 1.0 };
  }
  const iv = vix / 100; // VIX 17.3 → 0.173 (annualized fraction)
  if (iv <= 0) return { ratio: null, scale: 1.0 };
  const ratio = realizedVol20d / iv;
  const scale = Math.max(0.7, Math.min(1.3, ratio));
  return { ratio, scale };
}

/**
 * Magnet pull from anchors that lie within the cone at week k.
 * Returns the signed adjustment to BASE price (negative = pull down, positive = up).
 *
 * Logic: each anchor within ±2σ(k) of the un-magneted base contributes a
 * pull = strength * 0.005 * spot per week, capped at 4% of spot per week
 * cumulative.
 */
function computeMagnetPull(
  unmagBase: number,
  sigmaK: number,
  spot: number,
  anchors: { level: number; weight: number }[],
): number {
  let totalPull = 0;
  const cap = 0.04 * spot;
  for (const a of anchors) {
    const dist = a.level - unmagBase;
    const distSigmas = sigmaK > 0 ? Math.abs(dist) / sigmaK : 999;
    if (distSigmas > 2) continue;
    const strength = (1 - distSigmas / 2) * a.weight;
    const pull = Math.sign(dist) * strength * 0.005 * spot;
    totalPull += pull;
  }
  if (Math.abs(totalPull) > cap) totalPull = Math.sign(totalPull) * cap;
  return totalPull;
}

export function buildQuarterlyTrajectory(input: BuildInputs): QuarterlyTrajectory {
  const {
    spot, vix, vix9d, vix3m, callWall, putWall, gammaFlip, maxPain,
    totalGex, composite, jpmStrikes, skew, realizedVol20d,
  } = input;
  const asOf = Math.floor(Date.now() / 1000);

  // ─── Drift components (per week, decimal) ───
  // 1. Composite tilt
  const compositeTilt = ((composite - 50) / 250) / 13;

  // 2. GEX regime tilt
  const sigmaQ = spot * (vix / 100) * Math.sqrt(63 / 252);
  const spotVsFlip = (spot - gammaFlip) / Math.max(1, sigmaQ);
  const spotVsFlipClamped = Math.max(-1, Math.min(1, spotVsFlip));
  const gexTilt = totalGex >= 0
    ? -0.0008 * spotVsFlipClamped
    : +0.0012 * spotVsFlipClamped;

  // 3. VIX term tilt
  let vixTermTilt = 0;
  if (vix9d != null && vix3m != null && vix > 0) {
    const r9 = vix9d / vix;
    const r3 = vix / vix3m;
    if (r9 > 1.05 && r3 > 1.05) vixTermTilt = -0.0015;
    else if (r9 < 0.95 && r3 < 0.95) vixTermTilt = +0.0010;
  }

  // 4. NEW v2: Skew-adjusted drift
  //    CBOE SKEW measures cost of OTM puts vs OTM calls. 100=neutral, 130=normal,
  //    150+=elevated tail hedging demand. High skew = institutions paying up for
  //    crash insurance = bearish prior. Cap contribution at ±0.0006/wk.
  let skewTilt = 0;
  if (skew != null && isFinite(skew)) {
    if (skew > 145) skewTilt = -0.0006;
    else if (skew > 135) skewTilt = -0.0004;
    else if (skew > 125) skewTilt = -0.0002;
    else if (skew < 115) skewTilt = +0.0002;
  }

  const totalDriftPerWeek = compositeTilt + gexTilt + vixTermTilt + skewTilt;

  // ─── NEW v2: VRP scaling ───
  const { ratio: vrpRatio, scale: vrpScale } = computeVrpScale(realizedVol20d, vix);

  // ─── Anchor list (with weights) ───
  const anchorList: { level: number; weight: number }[] = [
    { level: callWall, weight: 1.0 },
    { level: putWall,  weight: 1.0 },
    { level: gammaFlip, weight: 0.7 },
    { level: maxPain,  weight: 0.5 },
  ];
  if (jpmStrikes) {
    if (jpmStrikes.shortPut)  anchorList.push({ level: jpmStrikes.shortPut,  weight: 0.6 });
    if (jpmStrikes.longPut)   anchorList.push({ level: jpmStrikes.longPut,   weight: 0.4 });
    if (jpmStrikes.shortCall) anchorList.push({ level: jpmStrikes.shortCall, weight: 0.6 });
  }

  // ─── Build weekly points ───
  // Two-pass: first compute per-week INCREMENTAL σ, then accumulate variance for
  // the cone. This guarantees monotonic cone growth (no inversions on event
  // weeks) and makes event bumps additive in variance space (correct).
  const weeks: WeeklyPoint[] = [];
  let cumMagnetPull = 0;
  let eventWeeksCount = 0;
  let varianceAccum = 0;  // Σ σ_i²
  // Pre-compute baseline σ ladder for the magnet check (cumulative)
  for (let k = 1; k <= WEEKS; k++) {
    // NEW v2: segmented IV per week
    const { iv: ivK, segment } = pickSegmentedVix(k, vix, vix9d, vix3m);

    // NEW v2: event week σ bump
    const weekEnd = weekEndDateET(k);
    const events: string[] = [];
    if (isOpexWeek(weekEnd)) events.push("OPEX");
    if (isFomcWeek(weekEnd)) events.push("FOMC");
    const eventBump = events.length > 0 ? 1.12 : 1.0;
    if (events.length > 0) eventWeeksCount++;

    // INCREMENTAL one-week σ — spot · (iv/100) · √(1/52) · vrpScale · damp · eventBump.
    // The damp uses the cumulative week index so longer-horizon increments are
    // mean-reverted, but each week's piece is still one-week sized.
    const sigmaWeekIncr = spot * (ivK / 100) * Math.sqrt(1 / WEEKS_PER_YEAR)
      * vrpScale * damp(k) * eventBump;

    // Accumulate variance → cumulative σ for the cone
    varianceAccum += sigmaWeekIncr * sigmaWeekIncr;
    const sigmaCum = Math.sqrt(varianceAccum);

    const driftK = totalDriftPerWeek * k;
    const unmagBase = spot * (1 + driftK);

    // Magnet pull uses the cumulative σ — anchors only relevant when within reach
    const weeklyPull = computeMagnetPull(unmagBase, sigmaCum, spot, anchorList);
    cumMagnetPull += weeklyPull / WEEKS;
    const base = unmagBase + cumMagnetPull;

    const bull = base + sigmaCum;
    const bear = base - sigmaCum;

    weeks.push({
      weekIndex: k,
      weekLabel: `WK${k}`,
      weekEndDate: weekEnd,
      bull: parseFloat(bull.toFixed(2)),
      base: parseFloat(base.toFixed(2)),
      bear: parseFloat(bear.toFixed(2)),
      sigmaWeek: parseFloat(sigmaWeekIncr.toFixed(2)),
      sigmaCum: parseFloat(sigmaCum.toFixed(2)),
      cumDriftPct: parseFloat((driftK * 100).toFixed(3)),
      events: events.length > 0 ? events : undefined,
      vixSegment: segment,
    });
  }

  // Count active magnets — use cumulative σ (the actual cone width) for the gate
  let activeMagnets = 0;
  for (const a of anchorList) {
    const ok = weeks.some((w) => Math.abs(a.level - w.base) <= 2 * w.sigmaCum);
    if (ok) activeMagnets++;
  }

  // Anchor list for client.
  // JPM collar strikes far below spot (>15%) get filtered — they're real
  // structural levels but won't magnetize the 13wk cone, so they're noise on
  // the chart. Walls / flip / max pain always show.
  const jpmRangeLimit = 0.15 * spot;
  const anchors: QuarterlyAnchor[] = [
    { level: callWall, label: "Call Wall", kind: "callWall", strength: "primary" },
    { level: putWall,  label: "Put Wall",  kind: "putWall",  strength: "primary" },
    { level: gammaFlip, label: "Gamma Flip", kind: "gammaFlip", strength: "primary" },
    { level: maxPain,  label: "Max Pain",  kind: "maxPain",  strength: "secondary" },
  ];
  if (jpmStrikes) {
    if (jpmStrikes.shortPut && Math.abs(jpmStrikes.shortPut - spot) <= jpmRangeLimit) {
      anchors.push({ level: jpmStrikes.shortPut, label: "JPM Short Put", kind: "jpmShortPut", strength: "secondary" });
    }
    if (jpmStrikes.longPut && Math.abs(jpmStrikes.longPut - spot) <= jpmRangeLimit) {
      anchors.push({ level: jpmStrikes.longPut, label: "JPM Long Put", kind: "jpmLongPut", strength: "secondary" });
    }
    if (jpmStrikes.shortCall && Math.abs(jpmStrikes.shortCall - spot) <= jpmRangeLimit) {
      anchors.push({ level: jpmStrikes.shortCall, label: "JPM Short Call", kind: "jpmShortCall", strength: "secondary" });
    }
  }

  return {
    spot,
    asOf,
    weeks,
    endpoint: weeks[weeks.length - 1]
      ? { bull: weeks[weeks.length - 1].bull, base: weeks[weeks.length - 1].base, bear: weeks[weeks.length - 1].bear }
      : { bull: spot, base: spot, bear: spot },
    anchors,
    drivers: {
      compositeTilt,
      gexTilt,
      vixTermTilt,
      skewTilt,
      totalDriftPerWeek,
      annualizedDrift: totalDriftPerWeek * WEEKS_PER_YEAR,
      magnetCount: activeMagnets,
      vrpRatio,
      vrpScale,
      eventWeeks: eventWeeksCount,
    },
    inputs: {
      vix, vix9d, vix3m, callWall, putWall, gammaFlip, maxPain, totalGex, composite,
      skew: skew ?? null,
      realizedVol20d: realizedVol20d ?? null,
    },
    methodology:
      "13-week σ-cone. Per-week incremental σ from VIX-segmented term structure (wk1-3 VIX9D, wk4 BLEND, " +
      "wk5-7 VIX, wk8 BLEND, wk9-13 VIX3M), scaled by VRP (RV/IV clamped 0.7-1.3) and ×1.12 on OPEX/FOMC weeks. " +
      "Cumulative σ(k) = √(Σ σ_i²) for monotonic cone growth. Drift = composite + GEX regime + VIX term + " +
      "CBOE SKEW. Anchored by walls, gamma flip, max pain, JPM collar (within ±15% of spot, ±2σ reach, capped ±4%/wk).",
  };
}
