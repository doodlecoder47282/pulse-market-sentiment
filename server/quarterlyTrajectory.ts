/**
 * quarterlyTrajectory.ts
 *
 * Builds a week-by-week (13-week) bull/base/bear trajectory for the 3-month
 * horizon — instead of just the endpoint targets that applyTermStructureRescale
 * produces.
 *
 * For each week k ∈ [1..13]:
 *   - σ(k) = spot · (vix/100) · √(k/52)            (annualized → k weeks)
 *   - drift(k) = (driftPerWeek) · k                (linear; sums composite, GEX, VIX term)
 *   - mean(k)  = spot · (1 + drift(k)) - magnetPull(k)
 *   - bull(k)  = mean(k) + σ(k) · damp(k)
 *   - bear(k)  = mean(k) - σ(k) · damp(k)
 *   - damp(k)  = 1 - 0.15·(k/13)                   (mean-reversion damping growing
 *                                                    with horizon; matches existing
 *                                                    0.85 quarterly damp at week 13)
 *
 * driftPerWeek is the sum of three normalized signals:
 *   - composite tilt: (composite-50)/250 / 13   →  ±0.30%/wk max at composite ±100
 *   - GEX regime: positive GEX = mean-revert toward gammaFlip → 0; negative GEX
 *     amplifies trend → adds momentum from spotVsFlip
 *   - VIX term: backwardation (vix3m < vix < vix9d) = bearish drift; deep contango = bullish
 *
 * Anchor magnets pull the BASE path toward call wall / put wall / JPM strikes
 * that lie within the cone. Pull strength = 0.05 per anchor per week, capped
 * at 0.40 cumulative. Bull/bear paths still extend through anchors.
 *
 * Returns a structure the client renders as a 3-line fan chart with anchor
 * horizontals.
 */

export interface WeeklyPoint {
  weekIndex: number;       // 1..13
  weekLabel: string;       // "WK1", "WK2", ...
  weekEndDate: string;     // YYYY-MM-DD ET
  bull: number;
  base: number;
  bear: number;
  sigmaWeek: number;       // σ at this week
  driftPct: number;        // cumulative drift % (base vs spot)
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
    totalDriftPerWeek: number;   // sum of above (decimal)
    annualizedDrift: number;     // total*52 for display
    magnetCount: number;         // anchors actively pulling
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

/**
 * Magnet pull from anchors that lie within the cone at week k.
 * Returns the signed adjustment to BASE price (negative = pull down, positive = up).
 *
 * Logic: each anchor within ±2σ(k) of the un-magneted base contributes a
 * pull = 0.05 * spot * sign(anchor - base) per week, capped at 0.40 * spot
 * cumulative across all anchors. This way close anchors dominate but no
 * single anchor warps the path.
 */
function computeMagnetPull(
  unmagBase: number,
  sigmaK: number,
  spot: number,
  anchors: { level: number; weight: number }[],
): number {
  let totalPull = 0;
  const cap = 0.04 * spot; // 4% of spot, hard cap (per week)
  for (const a of anchors) {
    const dist = a.level - unmagBase;
    const distSigmas = sigmaK > 0 ? Math.abs(dist) / sigmaK : 999;
    if (distSigmas > 2) continue; // outside cone, no pull
    // Strength decays with distance: full at 0σ, zero at 2σ
    const strength = (1 - distSigmas / 2) * a.weight;
    const pull = Math.sign(dist) * strength * 0.005 * spot;
    totalPull += pull;
  }
  // Cap
  if (Math.abs(totalPull) > cap) totalPull = Math.sign(totalPull) * cap;
  return totalPull;
}

export function buildQuarterlyTrajectory(input: BuildInputs): QuarterlyTrajectory {
  const { spot, vix, vix9d, vix3m, callWall, putWall, gammaFlip, maxPain, totalGex, composite, jpmStrikes } = input;
  const asOf = Math.floor(Date.now() / 1000);

  // ─── Drift components (per week, decimal) ───
  // 1. Composite tilt: ±25 composite points → ±0.04% per week → ±2% annualized cap
  const compositeTilt = ((composite - 50) / 250) / 13;

  // 2. GEX regime tilt:
  //    Positive GEX → market mean-reverts toward gammaFlip. If spot above flip,
  //    that's a downward drift; below flip = upward. Magnitude = 0.10% per week
  //    weighted by spot-vs-flip distance (capped at 1σ_quarterly equivalent).
  //    Negative GEX → momentum regime, drift extends current spot-vs-flip direction.
  const sigmaQ = spot * (vix / 100) * Math.sqrt(63 / 252); // 3M σ
  const spotVsFlip = (spot - gammaFlip) / Math.max(1, sigmaQ);
  const spotVsFlipClamped = Math.max(-1, Math.min(1, spotVsFlip));
  const gexTilt = totalGex >= 0
    ? -0.0008 * spotVsFlipClamped              // pull toward flip (mean-revert)
    : +0.0012 * spotVsFlipClamped;             // amplify away from flip (momentum)

  // 3. VIX term tilt:
  //    Backwardation (vix9d > vix > vix3m) → fear → bearish drift, ~-0.15%/wk
  //    Steep contango (vix9d < vix < vix3m, ratios <0.95) → calm → mild bullish, +0.10%/wk
  //    Otherwise neutral
  let vixTermTilt = 0;
  if (vix9d != null && vix3m != null && vix > 0) {
    const r9 = vix9d / vix;
    const r3 = vix / vix3m;
    if (r9 > 1.05 && r3 > 1.05) vixTermTilt = -0.0015;        // backwardation
    else if (r9 < 0.95 && r3 < 0.95) vixTermTilt = +0.0010;   // steep contango
  }

  const totalDriftPerWeek = compositeTilt + gexTilt + vixTermTilt;

  // ─── Anchor list (with weights) ───
  // Walls/flip = primary (weight 1.0); max pain + JPM = secondary (weight 0.5)
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
  const weeks: WeeklyPoint[] = [];
  let cumMagnetPull = 0;
  for (let k = 1; k <= WEEKS; k++) {
    const sigmaK = spot * (vix / 100) * SQRT_WEEK_FRAC(k);
    const driftK = totalDriftPerWeek * k; // cumulative
    const unmagBase = spot * (1 + driftK);

    // Cumulative magnet pull (each week adds incremental pull)
    const weeklyPull = computeMagnetPull(unmagBase, sigmaK, spot, anchorList);
    cumMagnetPull += weeklyPull / WEEKS; // amortize across all weeks
    const base = unmagBase + cumMagnetPull;

    const sigmaAdj = sigmaK * damp(k);
    const bull = base + sigmaAdj;
    const bear = base - sigmaAdj;

    weeks.push({
      weekIndex: k,
      weekLabel: `WK${k}`,
      weekEndDate: weekEndDateET(k),
      bull: parseFloat(bull.toFixed(2)),
      base: parseFloat(base.toFixed(2)),
      bear: parseFloat(bear.toFixed(2)),
      sigmaWeek: parseFloat(sigmaAdj.toFixed(2)),
      driftPct: parseFloat((driftK * 100).toFixed(3)),
    });
  }

  // Count active magnets (within 2σ of any week's base)
  let activeMagnets = 0;
  for (const a of anchorList) {
    const ok = weeks.some((w) => Math.abs(a.level - w.base) <= 2 * w.sigmaWeek);
    if (ok) activeMagnets++;
  }

  // Anchor list for client (kind labels)
  const anchors: QuarterlyAnchor[] = [
    { level: callWall, label: "Call Wall", kind: "callWall", strength: "primary" },
    { level: putWall,  label: "Put Wall",  kind: "putWall",  strength: "primary" },
    { level: gammaFlip, label: "Gamma Flip", kind: "gammaFlip", strength: "primary" },
    { level: maxPain,  label: "Max Pain",  kind: "maxPain",  strength: "secondary" },
  ];
  if (jpmStrikes) {
    if (jpmStrikes.shortPut) anchors.push({ level: jpmStrikes.shortPut, label: "JPM Short Put", kind: "jpmShortPut", strength: "secondary" });
    if (jpmStrikes.longPut)  anchors.push({ level: jpmStrikes.longPut, label: "JPM Long Put",  kind: "jpmLongPut",  strength: "secondary" });
    if (jpmStrikes.shortCall) anchors.push({ level: jpmStrikes.shortCall, label: "JPM Short Call", kind: "jpmShortCall", strength: "secondary" });
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
      totalDriftPerWeek,
      annualizedDrift: totalDriftPerWeek * WEEKS_PER_YEAR,
      magnetCount: activeMagnets,
    },
    inputs: { vix, vix9d, vix3m, callWall, putWall, gammaFlip, maxPain, totalGex, composite },
    methodology:
      "13-week σ-cone built from VIX (annualized → √k/52). Drift = composite tilt + GEX regime + VIX term, " +
      "anchored by call/put walls, gamma flip, max pain, JPM collar. Mean-reversion damp grows from 1.00 (wk1) to 0.85 (wk13). " +
      "Anchors within ±2σ of base pull the path; pull capped at ±4%/wk per anchor.",
  };
}
