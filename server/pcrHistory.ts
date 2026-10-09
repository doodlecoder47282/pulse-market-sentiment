// server/pcrHistory.ts
//
// Put/call volume ratio read against each symbol's OWN history (review item
// 4.5). Pure: no DB, no network.
//
// Why: a fixed cut-off (the old 0.75 / 1.05) is the same for every ticker,
// but index puts are bought as portfolio hedges, so SPX/SPY sit structurally
// higher than single names and read "bearish" most days. The level only means
// something relative to that symbol's normal. Practitioners track the ratio
// against its own moving average or percentile rather than fixed levels
// (W. A. Thorp, "The Put-Call Ratio: Viewing Market Sentiment Through Options
// Activity", AAII Journal, June 2025,
// https://www.aaii.com/journal/article/295384-the-put-call-ratio-viewing-market-sentiment-through-options-activity),
// and the stock-level evidence is per symbol (J. Pan & A. Poteshman, "The
// Information in Option Volume for Future Stock Prices", RFS 19(3), 2006;
// NBER w10925, https://www.nber.org/papers/w10925). Pan-Poteshman's
// informative ratio uses OPEN-BUY volume, which the Schwab chain does not
// carry; this module uses total volume and claims no predictive power: the
// zone is descriptive ("put-heavy for this symbol"), not a forecast.
//
// Method:
//   x_t = ln((P_t + 0.5) / (C_t + 0.5))   per completed session t
// The log makes the ratio symmetric (a 2x put-heavy day and a 2x call-heavy
// day are +-ln 2) and the +0.5 is the Haldane-Anscombe continuity correction,
// so an observed-zero side stays finite instead of becoming missing.
//   z = (x_today - mean(x_{t-W..t-1})) / sd(x_{t-W..t-1})   (sample sd, n-1)
// over the last W = 60 completed sessions, today excluded (no look-ahead).
// Below MIN = 20 completed sessions the read is "insufficient_history" and no
// colour is shown; there is NO fixed-threshold fallback.
// Zones: z >= +1 "bearish" (put-heavy vs own history), z <= -1 "bullish"
// (call-heavy), else "neutral". The thresholds are also reported back in
// ratio units, exp(mean +- 1 sd), so the chart can draw them.
//
// Comparability: today's value is a PARTIAL session while history holds full
// sessions; the read says so. Only sessions whose last snapshot was taken in
// the final 10 minutes of the session or after the close are "complete" and
// enter the history (pcrHistoryStore.ts).

export const PCR_HISTORY_WINDOW = 60;
export const PCR_HISTORY_MIN = 20;
export const PCR_Z_THRESHOLD = 1.0;
export const PCR_CONTINUITY = 0.5;

export type PcrZone = "bullish" | "neutral" | "bearish" | "insufficient_history" | "unavailable";

export interface PcrDay {
  date: string;      // ET session date YYYY-MM-DD
  putVol: number;
  callVol: number;
}

export interface PcrRead {
  zone: PcrZone;
  z: number | null;
  /** Completed sessions used (<= window). */
  n: number;
  /** Mean / sd of ln-ratio over the window. */
  meanLog: number | null;
  sdLog: number | null;
  /** Empirical percentile of today's ln-ratio within the window, 0..100. */
  percentile: number | null;
  /** Ratio levels of the zone edges: exp(mean -+ k sd). */
  bullishBelow: number | null;
  bearishAbove: number | null;
  method: string;
  reason: string | null;
}

/** ln((P + 0.5) / (C + 0.5)); null when the volumes are not finite or both sides are missing. */
export function logPcr(putVol: number | null | undefined, callVol: number | null | undefined): number | null {
  if (putVol == null || callVol == null) return null;
  const p = Number(putVol), c = Number(callVol);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) return null;
  if (p === 0 && c === 0) return null; // no prints at all: nothing observed yet
  return Math.log((p + PCR_CONTINUITY) / (c + PCR_CONTINUITY));
}

export const PCR_METHOD =
  "z-score of ln((puts+0.5)/(calls+0.5)) vs this symbol's last 60 completed sessions (min 20); " +
  "|z| >= 1 colours the tile; today is a partial session compared with full-session history; total volume, not opening volume";

export function pcrReadFromHistory(
  current: { putVol: number; callVol: number } | null,
  history: PcrDay[],
  opts: { today?: string; window?: number; min?: number; zThreshold?: number } = {},
): PcrRead {
  const window = opts.window ?? PCR_HISTORY_WINDOW;
  const min = opts.min ?? PCR_HISTORY_MIN;
  const k = opts.zThreshold ?? PCR_Z_THRESHOLD;
  const empty: PcrRead = {
    zone: "unavailable", z: null, n: 0, meanLog: null, sdLog: null, percentile: null,
    bullishBelow: null, bearishAbove: null, method: PCR_METHOD, reason: null,
  };
  const x = current ? logPcr(current.putVol, current.callVol) : null;
  if (x == null) return { ...empty, reason: "no put/call volume for this symbol (missing, not zero)" };

  // One value per date, strictly before today, newest `window` sessions.
  const byDate = new Map<string, number>();
  for (const d of history) {
    if (opts.today && d.date >= opts.today) continue;
    const v = logPcr(d.putVol, d.callVol);
    if (v != null) byDate.set(d.date, v);
  }
  const xs = Array.from(byDate.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-window).map((e) => e[1]);
  const n = xs.length;
  if (n < min) {
    return { ...empty, zone: "insufficient_history", n, reason: `${n} of ${min} completed sessions recorded for this symbol; no zone until then` };
  }
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  const below = xs.filter((v) => v < x).length;
  const ties = xs.filter((v) => v === x).length;
  const percentile = ((below + 0.5 * ties) / n) * 100;
  if (!(sd > 0)) {
    return { ...empty, zone: "insufficient_history", n, meanLog: mean, sdLog: sd, percentile, reason: "history has no dispersion; z undefined" };
  }
  const z = (x - mean) / sd;
  const zone: PcrZone = z >= k ? "bearish" : z <= -k ? "bullish" : "neutral";
  return {
    zone, z, n, meanLog: mean, sdLog: sd, percentile,
    bullishBelow: Math.exp(mean - k * sd),
    bearishAbove: Math.exp(mean + k * sd),
    method: PCR_METHOD,
    reason: null,
  };
}

/**
 * Is a snapshot taken at `capturedAtMs` a complete-session reading for its
 * ET session? Complete = taken within the last `withinMin` minutes of the
 * session or after the close of that same session date.
 */
export function isCompleteSessionSnapshot(capturedAtMs: number, sessionCloseMs: number | null, withinMin = 10): boolean {
  if (sessionCloseMs == null || !Number.isFinite(capturedAtMs)) return false;
  return capturedAtMs >= sessionCloseMs - withinMin * 60_000;
}
