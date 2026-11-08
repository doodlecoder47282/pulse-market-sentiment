// shared/regimeGrade.ts
//
// Grading a regime call on the event it forecast. Pure.
//
// The predictor says TREND / CHOP / neutral for the next `horizonMinutes`
// (5-120, default 20). The old grader scored it on the SPY close-to-close
// move about 26 hours later, an event the predictor never spoke about. This
// grades the realised $SPX path over the horizon itself, from the desk's own
// stored 1-minute bars:
//
//   netMove   = |close(t0 + H) - close(t0)| / close(t0)
//   threshold = 0.5% * sqrt(H / 390)     (the daily 0.5% proxy scaled to the
//                                          horizon by the square-root rule)
//   TREND hits when netMove >= threshold; CHOP and neutral hit when it is below.
//
// It is still a proxy for "regime" (a path with no sustained direction can
// still net a large move), and the card says so. A horizon that runs past
// the close is graded to the last bar of the session and marked truncated.
// Missing bars at either end: insufficient_history, never a 0% move.

export interface MinuteClose {
  /** Bar open, epoch ms. */
  t: number;
  close: number;
}

export type RegimeCallBucket = "trend" | "chop" | "neutral";

export interface RegimeGrade {
  result: "ok" | "insufficient_history";
  method: typeof REGIME_GRADE_METHOD;
  horizonMinutes: number;
  /** Entry and exit bars actually used (ms) and closes. */
  entryT: number | null;
  exitT: number | null;
  entryClose: number | null;
  exitClose: number | null;
  /** Signed net move over the horizon, fraction. */
  movePct: number | null;
  absMovePct: number | null;
  /** The TREND / CHOP threshold for this horizon, fraction. */
  threshold: number | null;
  expected: RegimeCallBucket;
  /** 1 = the realised path matched the called bucket, 0 = it did not. */
  regimeMatch: 0 | 1 | null;
  /** The horizon ran past the close; graded to the session's last bar. */
  truncatedAtClose: boolean;
  /** Minutes the grade actually covers (entry bar to exit bar). */
  coveredMinutes: number | null;
}

export const REGIME_GRADE_METHOD = "horizon: $SPX 1-min bars (last completed bar at the call and at the horizon end), |net move| over the called horizon vs 0.5% x sqrt(H/390); TREND hits at or above, CHOP/neutral below";
/** The daily |move| proxy the threshold is scaled from. */
export const DAILY_PROXY_PCT = 0.005;
export const SESSION_MINUTES = 390;
/** A grade needs the entry bar within this many minutes of the call (bars are 1-min; the call may land between bars). */
export const ENTRY_TOLERANCE_MS = 2 * 60_000;

export function bucketOf(topCandidate: string | null | undefined): RegimeCallBucket {
  const top = String(topCandidate ?? "");
  if (top.startsWith("TREND")) return "trend";
  if (top.startsWith("CHOP")) return "chop";
  return "neutral";
}

export function horizonThreshold(horizonMinutes: number): number {
  const h = Math.max(1, Math.min(SESSION_MINUTES, horizonMinutes));
  return DAILY_PROXY_PCT * Math.sqrt(h / SESSION_MINUTES);
}

/**
 * @param bars        1-minute closes covering the call's session (any order; only this session's bars matter)
 * @param capturedAt  when the call was made, ms
 * @param sessionCloseMs  the session's close for that date (16:00 ET, or 13:00 on a half day), ms
 */
export function gradeRegimeCallOnPath(
  bars: MinuteClose[],
  capturedAt: number,
  horizonMinutes: number,
  topCandidate: string | null | undefined,
  sessionCloseMs: number,
): RegimeGrade {
  const expected = bucketOf(topCandidate);
  const H = Math.max(1, Math.round(horizonMinutes));
  const base: RegimeGrade = {
    result: "insufficient_history", method: REGIME_GRADE_METHOD, horizonMinutes: H,
    entryT: null, exitT: null, entryClose: null, exitClose: null, movePct: null, absMovePct: null,
    threshold: horizonThreshold(H), expected, regimeMatch: null, truncatedAtClose: false, coveredMinutes: null,
  };
  const sorted = bars.filter((b) => Number.isFinite(b.t) && Number.isFinite(b.close) && b.close > 0).sort((a, b) => a.t - b.t);
  if (!sorted.length) return base;
  // Entry: the last COMPLETED bar at the call (a bar opened at t closes at
  // t + 1 min; using the bar that contains the call would read 60 s ahead),
  // within tolerance: a bar from long before is a different market.
  let entry: MinuteClose | null = null;
  for (const b of sorted) { if (b.t + 60_000 <= capturedAt) entry = b; else break; }
  if (!entry || capturedAt - (entry.t + 60_000) > ENTRY_TOLERANCE_MS) return base;
  // Exit: the horizon end, clamped to the session's last bar.
  const targetT = capturedAt + H * 60_000;
  const lastBarT = sessionCloseMs - 60_000; // the 15:59 bar closes at 16:00
  const truncatedAtClose = targetT > lastBarT;
  const exitTarget = Math.min(targetT, lastBarT);
  let exit: MinuteClose | null = null;
  for (const b of sorted) { if (b.t + 60_000 <= exitTarget + (truncatedAtClose ? 60_000 : 0)) exit = b; else break; }
  if (!exit || exit.t <= entry.t || exitTarget - exit.t > ENTRY_TOLERANCE_MS + 60_000) return base;
  const movePct = (exit.close - entry.close) / entry.close;
  const absMovePct = Math.abs(movePct);
  const threshold = horizonThreshold(H);
  const regimeMatch: 0 | 1 = expected === "trend" ? (absMovePct >= threshold ? 1 : 0) : (absMovePct < threshold ? 1 : 0);
  return {
    ...base, result: "ok",
    entryT: entry.t, exitT: exit.t, entryClose: entry.close, exitClose: exit.close,
    movePct, absMovePct, threshold, regimeMatch, truncatedAtClose,
    coveredMinutes: Math.round((exit.t - entry.t) / 60_000),
  };
}
