import { vixToAtmPct } from "@shared/vol";
import { studentTSumQuantileFft, totalVarianceAt, type AtmIvPoint } from "./tickerConeMath";
import { addDays, dayOfWeek, etDate, isTradingDay, nextTradingDay, prevTradingDay, sessionCloseMs } from "./exchangeCalendar";
/**
 * quarterlyTrajectory.ts  —  v2 (precision pass)
 *
 * Builds a week-by-week (13-week) bull/base/bear trajectory for the 3-month
 * horizon — instead of just the endpoint targets that applyTermStructureRescale
 * produces.
 *
 * v2 upgrades over v1 (items 1, 2 and 4 SUPERSEDED in round 4, see below:
 * the cone width is now the SPX ATM IV term structure with t(4) bands):
 *   1. VRP scaling — σ damped by realized-vol / implied-vol ratio (clamped 0.7–1.3).
 *   2. Term-structure σ segmentation — wk1-4 use VIX9D, wk5-8 VIX, wk9-13 VIX3M.
 *      Smooth weighted blend at boundaries so the cone doesn't kink.
 *   3. Skew-adjusted drift — Cboe SKEW index (100-150, Schwab $SKEW quote) drives an extra bearish drift
 *      component when tail-hedging demand is elevated.
 *   4. OPEX/FOMC σ bumps — event-week sigma expands +12% on monthly OPEX (3rd
 *      Fri) and FOMC weeks; tagged in the weekly output.
 *
 * For each week k ∈ [1..13] (round 4):
 *   - w(k) = SPX ATM implied total variance to week k's last close (or RV20^2 x n/252, labelled)
 *   - base(k) = spot                     (ZERO drift: the median is spot)
 *   - bull(k), bear(k) = spot x exp(z_{0.8413 / 0.1587}(n_k) x sqrt(w(k))), z = t(4)-sum quantile
 *   - scenarioBase(k) = spot · (1 + tilt·k) + magnetPull(k): a LABELLED
 *     heuristic scenario line only (tilt = composite + GEX + VIX term + SKEW
 *     hand-set per-week tilts; anchors = walls/flip primary, max pain + JPM
 *     secondary, pull capped at ±4%/wk).
 *
 * Round 3 (N3-2): the hand-set tilts and anchor pulls used to move the BASE
 * path (the median of the cone). None of them is a fitted or validated drift,
 * so they are no longer in the median, which is spot (zero drift, as the
 * index cone: server/multiDayProjection.ts); they survive only as the
 * separate scenarioBase line, labelled as a heuristic scenario, never a
 * forecast.
 *
 * Round 4 (cone width): the cone is no longer VIX-segmented x VRP scale x
 * hand-set damping (1 - 0.15 k/13) x hand-set event bump (x1.12) with
 * Gaussian +-1 sigma bands. That stack made the width effectively a multiple
 * of 20-day realized vol with two unvalidated multipliers. It is now the
 * single-name cone's model (server/tickerConeMath.ts, tickerProjection.ts)
 * applied to the index:
 *   w(T_k)  = Schwab $SPX ATM implied total variance to the close of week k's
 *             last session, linear in total variance between listed expiries
 *             on the running max (no calendar arbitrage): J. Gatheral, "The
 *             Volatility Surface", Wiley 2006, ch. 3; Gatheral & Jacquier,
 *             "Arbitrage-free SVI volatility surfaces", Quant. Finance 14(1)
 *             2014, https://arxiv.org/abs/1204.0646 ;
 *   log(S_k/S_0) = sqrt(w) x Z_n, Z_n the standardised sum of n iid
 *             unit-variance Student-t(4) daily shocks (n = sessions to week
 *             k's close): R. Cont, "Empirical properties of asset returns:
 *             stylized facts and statistical issues", Quant. Finance 1(2) 2001;
 *   BULL / BEAR = the 84.13% / 15.87% quantiles (the coverage of +-1 sigma
 *             under a normal), q10/q90 also returned; median = spot.
 * No damping, VRP multiplier or event bump: the option prices already carry
 * FOMC/OPEX inside each expiry's ATM vol (events are still tagged). Without a
 * usable SPX chain the cone falls back to 20-day realized vol, UNSCALED and
 * labelled (sigmaSource "realized_20d"); with neither it is unavailable.
 * Band coverage is untested on held-out data: heuristic bands, not
 * calibrated probabilities.
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
  cumDriftPct: number;     // cumulative drift % of the BASE (median) vs spot: 0 (zero drift, round 3)
  /** Heuristic scenario line (hand-set tilts + anchor pulls), NOT the median. */
  scenarioBase?: number;
  /** Cumulative % of the scenario line vs spot. */
  scenarioDriftPct?: number;
  events?: string[];       // ["OPEX"], ["FOMC"], ["OPEX","FOMC"], etc. (tags only: no sigma bump)
  vixSegment?: "VIX9D" | "VIX" | "VIX3M" | "BLEND";
  /** Round 4: t(4)-sum quantile bands (price) and the variance behind them. */
  q10?: number;
  q90?: number;
  /** Total log variance to this week's close (decimal^2). */
  totalVariance?: number;
  /** Trading sessions from now to this week's close. */
  sessions?: number;
  /** Years (calendar, 365 d) from now to this week's close. */
  tYears?: number;
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
    skewTilt: number;            // weekly drift contribution from the Cboe SKEW index (decimal)  [NEW v2]
    totalDriftPerWeek: number;   // sum of above (decimal): SCENARIO tilt only, not in the median
    /** Drift in the BASE (median) path per week: 0 (round 3, N3-2). */
    medianDriftPerWeek?: number;
    /** false: the tilts and anchor pulls are not in the median, only in scenarioBase. */
    tiltsInMedian?: boolean;
    annualizedDrift: number;     // total*52 for display
    magnetCount: number;         // anchors actively pulling
    vrpRatio: number | null;     // RV / IV ratio (decimal, null if RV unknown)  [NEW v2]
    vrpScale: number;            // always 1 since round 4 (not applied); was the clamped RV/IV multiplier
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
    skew: number | null;            // Cboe SKEW index 100-150 via Schwab $SKEW; null = unavailable  [NEW v2]
    realizedVol20d: number | null;  // 20D RV annualized decimal  [NEW v2]
  };
  methodology: string;
  /** Cone variance source: Schwab SPX ATM IV term, or labelled 20d realized fallback. */
  sigmaSource?: "spx_atm_iv_term" | "realized_20d";
  /** ATM IV per listed SPX expiry behind the cone (spx_atm_iv_term only). */
  ivTerm?: AtmIvPoint[];
  tailModel?: string;
}

/** Thrown when neither the IV term structure nor realized vol is available. */
export class QuarterlyConeUnavailableError extends Error {}

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
  skew?: number | null;          // Cboe SKEW index 100-150 via Schwab $SKEW (tail-hedging demand)
  realizedVol20d?: number | null;  // 20D realized vol, annualized decimal (e.g. 0.18)
  /** Schwab $SPX ATM IV term structure (tickerConeMath.atmIvTermFromChain). */
  ivTerm?: AtmIvPoint[] | null;
  /** Clock (tests). */
  nowMs?: number;
}

const WEEKS = 13;
const WEEKS_PER_YEAR = 52;

const YEAR_MS = 365 * 86_400_000;
/** Unit-variance probability of +-1 sigma under a normal: Phi(1). */
const P_ONE_SIGMA = 0.8413447460685429;

/**
 * Week k's last session (ET): the Friday k weeks out (next Friday for k = 1,
 * or the following one when today is Friday, as before), moved back to the
 * prior trading day when that Friday is an exchange holiday.
 */
function weekEndSessionET(k: number, nowMs: number): { weekEnd: string; session: string } {
  const today = etDate(nowMs);
  const dow = dayOfWeek(today); // 0 = Sun .. 6 = Sat
  const daysUntilFri = (5 - dow + 7) % 7 || 7;
  const weekEnd = addDays(today, daysUntilFri + (k - 1) * 7);
  return { weekEnd, session: isTradingDay(weekEnd) ? weekEnd : prevTradingDay(weekEnd) };
}

/** Sessions whose close is after nowMs, up to and including `last`. */
function sessionsUntil(nowMs: number, last: string): number {
  let d = etDate(nowMs);
  let n = 0;
  const closeToday = isTradingDay(d) ? sessionCloseMs(d) : null;
  if (closeToday != null && closeToday > nowMs && d <= last) n++;
  for (;;) {
    d = nextTradingDay(d);
    if (d > last) break;
    n++;
  }
  return n;
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
  const iv = vixToAtmPct(vix) / 100; // VIX → true ATM vol (annualized fraction)
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
  const nowMs = input.nowMs ?? Date.now();
  const asOf = Math.floor(nowMs / 1000);

  // ─── Drift components (per week, decimal) ───
  // 1. Composite tilt
  const compositeTilt = ((composite - 50) / 250) / 13;

  // 2. GEX regime tilt
  const sigmaQ = spot * (vixToAtmPct(vix) / 100) * Math.sqrt(63 / 252);
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
  //    The Cboe SKEW index measures cost of OTM puts vs OTM calls. 100=neutral, 130=normal,
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
  // RV / IV ratio reported for context only; it no longer scales the cone.
  const { ratio: vrpRatio } = computeVrpScale(realizedVol20d, vix);

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
  // Cone variance per week from the SPX ATM IV term structure (total
  // variance to week k's close), else 20d realized vol (labelled), else
  // unavailable. Bands: Student-t(4) n-session sum quantiles.
  const ivTerm = (input.ivTerm ?? []).filter((p) => p && p.T > 0 && p.atmIv > 0);
  const rv = realizedVol20d != null && Number.isFinite(realizedVol20d) && realizedVol20d > 0 ? realizedVol20d : null;
  const sigmaSource: "spx_atm_iv_term" | "realized_20d" | null = ivTerm.length ? "spx_atm_iv_term" : rv != null ? "realized_20d" : null;
  if (sigmaSource == null) {
    throw new QuarterlyConeUnavailableError("13-week cone unavailable: no Schwab SPX ATM IV term structure and no 20-day realized vol");
  }
  const sched = Array.from({ length: WEEKS }, (_, i) => {
    const { weekEnd, session } = weekEndSessionET(i + 1, nowMs);
    const closeMs = sessionCloseMs(session) ?? nowMs;
    return { weekEnd, T: Math.max(0, closeMs - nowMs) / YEAR_MS, n: Math.max(1, sessionsUntil(nowMs, session)) };
  });
  const nMax = Math.max(...sched.map((x) => x.n));
  const varianceAt = (x: { T: number; n: number }): number =>
    sigmaSource === "spx_atm_iv_term" ? (totalVarianceAt(ivTerm, x.T) ?? 0) : (rv as number) ** 2 * x.n / 252;

  const weeks: WeeklyPoint[] = [];
  let cumMagnetPull = 0;
  let eventWeeksCount = 0;
  let prevW = 0;
  for (let k = 1; k <= WEEKS; k++) {
    const { weekEnd, T, n } = sched[k - 1];
    const events: string[] = [];
    if (isOpexWeek(weekEnd)) events.push("OPEX");
    if (isFomcWeek(weekEnd)) events.push("FOMC");
    if (events.length > 0) eventWeeksCount++;

    const w = Math.max(prevW, varianceAt({ T, n })); // total variance never decreases
    const sd = Math.sqrt(w);
    const zUp = studentTSumQuantileFft(P_ONE_SIGMA, n, 4, nMax);
    const zDn = studentTSumQuantileFft(1 - P_ONE_SIGMA, n, 4, nMax);
    const z90 = studentTSumQuantileFft(0.9, n, 4, nMax);
    const z10 = studentTSumQuantileFft(0.1, n, 4, nMax);
    const sigmaCum = spot * sd;                                  // 1 sd of log price, in price units
    const sigmaWeekIncr = spot * Math.sqrt(Math.max(0, w - prevW));
    prevW = w;

    // Heuristic scenario line (NOT the median): hand-set tilts + anchor pulls.
    const driftK = totalDriftPerWeek * k;
    const unmagBase = spot * (1 + driftK);
    const weeklyPull = computeMagnetPull(unmagBase, sigmaCum, spot, anchorList);
    cumMagnetPull += weeklyPull / WEEKS;
    const scenarioBase = unmagBase + cumMagnetPull;

    // Median: zero drift.
    const base = spot;
    const bull = spot * Math.exp(zUp * sd);
    const bear = spot * Math.exp(zDn * sd);

    weeks.push({
      weekIndex: k,
      weekLabel: `WK${k}`,
      weekEndDate: weekEnd,
      bull: parseFloat(bull.toFixed(2)),
      base: parseFloat(base.toFixed(2)),
      bear: parseFloat(bear.toFixed(2)),
      sigmaWeek: parseFloat(sigmaWeekIncr.toFixed(2)),
      sigmaCum: parseFloat(sigmaCum.toFixed(2)),
      cumDriftPct: 0,
      scenarioBase: parseFloat(scenarioBase.toFixed(2)),
      scenarioDriftPct: parseFloat((((scenarioBase - spot) / spot) * 100).toFixed(3)),
      events: events.length > 0 ? events : undefined,
      q10: parseFloat((spot * Math.exp(z10 * sd)).toFixed(2)),
      q90: parseFloat((spot * Math.exp(z90 * sd)).toFixed(2)),
      totalVariance: w,
      sessions: n,
      tYears: T,
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
      medianDriftPerWeek: 0,
      tiltsInMedian: false,
      magnetCount: activeMagnets,
      vrpRatio,
      vrpScale: 1, // round 4: informational ratio only, NOT applied to the cone (was clamped RV/IV)
      eventWeeks: eventWeeksCount,
    },
    inputs: {
      vix, vix9d, vix3m, callWall, putWall, gammaFlip, maxPain, totalGex, composite,
      skew: skew ?? null,
      realizedVol20d: realizedVol20d ?? null,
    },
    methodology: sigmaSource === "spx_atm_iv_term"
      ? "13-week cone from the Schwab $SPX ATM implied-vol term structure: total variance w(T) interpolated linearly " +
        "between listed expiries (running max, no calendar arbitrage) to each week's last session close; log price = " +
        "sqrt(w) x standardised sum of n iid unit-variance Student-t(4) daily shocks. BASE = spot (zero drift); " +
        "BULL/BEAR = 84.13%/15.87% quantiles; q10/q90 also given. No damping, VRP multiplier or event bump (OPEX/FOMC " +
        "are tagged; the option prices carry them). Band coverage untested. The SCENARIO line (not a forecast, not in " +
        "the median) adds hand-set tilts and anchor pulls."
      : "13-week cone FALLBACK: no usable Schwab $SPX chain, so 20-day realized vol, unscaled (w = RV^2 x sessions/252); " +
        "Student-t(4) daily-shock sum quantiles; BASE = spot; BULL/BEAR = 84.13%/15.87% quantiles. Band coverage untested. " +
        "The SCENARIO line (not a forecast) adds hand-set tilts and anchor pulls.",
    sigmaSource,
    ivTerm: sigmaSource === "spx_atm_iv_term" ? ivTerm : undefined,
    tailModel: "standardised sum of n iid unit-variance Student-t(4) daily shocks",
  };
}
