// shared/intradayVariance.ts
//
// Time-of-day variance profile for the 0DTE Wiener map. Pure.
//
// The flat Wiener map spreads the day's variance evenly over the remaining
// minutes. Real sessions do not: the first and last half hours carry far more
// variance per minute than lunch. This module estimates that profile from the
// desk's OWN stored $SPX 1-minute bars (spx_minute_bars), as the mean squared
// 1-minute log return per 5-minute slot of the session over the last N full
// sessions, normalised to sum to 1. The Wiener map then runs on the time
// change V(t) (cumulative variance share) instead of t/T:
//
//     X(t) = S + sigma * W(V(t))        V(0) = 0, V(T) = 1
//
// where sigma is still the market's 1-sigma move to the close from the 0DTE
// chain. What changes: the SHAPE of the bands and the clock at which a given
// width is reached. What does not change (and the card says so): the touch
// odds, the close distribution and the expected remaining range all depend on
// the total variance to the close only, so they are identical under either
// time change.
//
// Fallback: with fewer than MIN_SESSIONS complete sessions the profile is flat
// (the old model), and the map states which it used and from how many days.

export const SLOT_MIN = 5;
/** Sessions needed before the empirical profile is used instead of flat. */
export const MIN_SESSIONS = 10;
/** Sessions the profile is estimated over (the most recent complete ones). */
export const PROFILE_SESSIONS = 20;
/** Full-session length in minutes (09:30-16:00). Half days are excluded from the estimate. */
export const FULL_SESSION_MIN = 390;
export const FULL_SESSION_SLOTS = FULL_SESSION_MIN / SLOT_MIN; // 78

export interface MinuteBarLike {
  /** Bar open, epoch ms. */
  t: number;
  close: number;
  /** Bar open price; when present the first bar's own open->close move counts (else slot 0 would lose one return). */
  open?: number;
}

export interface VarianceProfile {
  source: "empirical" | "flat";
  /** Complete full sessions the estimate used (0 for flat). */
  sessions: number;
  /** Per-slot share of the session's variance, length FULL_SESSION_SLOTS, sums to 1. */
  slotShare: number[];
  /** Plain-words description for the card. */
  note: string;
  /** Peak slot share divided by the flat share (1/78): how uneven the day is. 1 for flat. */
  peakRatio: number;
}

export function flatProfile(reason: string, sessionsStored = 0): VarianceProfile {
  const share = 1 / FULL_SESSION_SLOTS;
  return {
    source: "flat", sessions: sessionsStored, slotShare: Array(FULL_SESSION_SLOTS).fill(share), peakRatio: 1,
    note: `variance spread evenly over the remaining minutes (${reason})`,
  };
}

/**
 * Estimate the profile from 1-minute bars. `dayOf(ms)` gives each bar's ET
 * session date and minute-of-session (0 at 09:30), so this module needs no
 * time zone code of its own. Only complete full sessions (a bar in every one
 * of the 78 slots, none after minute 389) are used.
 */
export function estimateVarianceProfile(
  bars: MinuteBarLike[],
  dayOf: (ms: number) => { date: string; mod: number },
  opts: { sessions?: number; minSessions?: number } = {},
): VarianceProfile {
  const want = opts.sessions ?? PROFILE_SESSIONS;
  const minS = opts.minSessions ?? MIN_SESSIONS;
  // Group by session date, in time order.
  const byDay = new Map<string, Array<{ mod: number; close: number; open?: number }>>();
  const sorted = [...bars].filter((b) => Number.isFinite(b.t) && Number.isFinite(b.close) && b.close > 0).sort((a, b) => a.t - b.t);
  for (const b of sorted) {
    const { date, mod } = dayOf(b.t);
    if (mod < 0 || mod >= FULL_SESSION_MIN) continue; // pre/post-market bars are not the session
    let arr = byDay.get(date);
    if (!arr) byDay.set(date, (arr = []));
    arr.push({ mod, close: b.close, open: Number.isFinite(b.open) && (b.open as number) > 0 ? b.open : undefined });
  }
  // Per complete session: squared 1-min log returns summed into slots, then
  // normalised so each session contributes one unit (a quiet day and a wild
  // day weigh the same in the SHAPE).
  const perSession: number[][] = [];
  for (const [, arr] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const slotsSeen = new Set(arr.map((x) => Math.floor(x.mod / SLOT_MIN)));
    if (slotsSeen.size < FULL_SESSION_SLOTS) continue; // partial or half day
    const slots = Array(FULL_SESSION_SLOTS).fill(0);
    // The first bar's own open->close move belongs to slot 0 (otherwise the
    // opening slot, the one this profile exists for, loses one of its returns).
    if (arr[0].open != null) {
      const r0 = Math.log(arr[0].close / arr[0].open);
      if (Number.isFinite(r0)) slots[Math.floor(arr[0].mod / SLOT_MIN)] += r0 * r0;
    }
    for (let k = 1; k < arr.length; k++) {
      const r = Math.log(arr[k].close / arr[k - 1].close);
      if (!Number.isFinite(r)) continue;
      slots[Math.floor(arr[k].mod / SLOT_MIN)] += r * r;
    }
    const tot = slots.reduce((s, v) => s + v, 0);
    if (!(tot > 0)) continue;
    perSession.push(slots.map((v) => v / tot));
  }
  const used = perSession.slice(-want);
  if (used.length < minS) return flatProfile(`${used.length} complete session${used.length === 1 ? "" : "s"} stored, ${minS} needed for the time-of-day profile`, used.length);
  const mean = Array(FULL_SESSION_SLOTS).fill(0);
  for (const s of used) for (let k = 0; k < FULL_SESSION_SLOTS; k++) mean[k] += s[k] / used.length;
  // Floor: no slot may carry zero variance (the map would stand still there).
  const floor = 0.1 / FULL_SESSION_SLOTS;
  const floored = mean.map((v) => Math.max(v, floor));
  const tot = floored.reduce((s, v) => s + v, 0);
  const slotShare = floored.map((v) => v / tot);
  const peak = Math.max(...slotShare);
  return {
    source: "empirical", sessions: used.length, slotShare,
    peakRatio: Math.round((peak * FULL_SESSION_SLOTS) * 100) / 100,
    note: `variance per minute from the desk's own $SPX 1-minute bars over the last ${used.length} full sessions (busiest 5 min carries ${Math.round(peak * 100)}% of a day's variance, ${(peak * FULL_SESSION_SLOTS).toFixed(1)}x flat)`,
  };
}

/**
 * Cumulative variance share V between two minutes-of-session (0 = 09:30),
 * with linear interpolation inside a slot. V(a, b) in [0, 1]; V(0, 390) = 1.
 * For a half day the caller passes its own close minute; the profile's shape
 * for the missing afternoon is simply not reached.
 */
export function cumulativeShare(p: VarianceProfile, fromMin: number, toMin: number): number {
  const a = Math.max(0, Math.min(FULL_SESSION_MIN, fromMin));
  const b = Math.max(0, Math.min(FULL_SESSION_MIN, toMin));
  if (b <= a) return 0;
  let v = 0;
  for (let k = 0; k < FULL_SESSION_SLOTS; k++) {
    const s0 = k * SLOT_MIN, s1 = s0 + SLOT_MIN;
    const lo = Math.max(a, s0), hi = Math.min(b, s1);
    if (hi > lo) v += p.slotShare[k] * ((hi - lo) / SLOT_MIN);
  }
  return v;
}

/**
 * Time-change function for the Wiener map: the share of the REMAINING variance
 * (from `startMin` to `closeMin`) that has elapsed by minute `startMin + t`.
 * Returns a function u(t) in [0, 1], u(0) = 0, u(T) = 1, non-decreasing.
 */
export function remainingVarianceTimeChange(p: VarianceProfile, startMin: number, closeMin: number): (t: number) => number {
  const total = cumulativeShare(p, startMin, closeMin);
  const T = closeMin - startMin;
  if (!(total > 0) || !(T > 0)) return (t) => Math.max(0, Math.min(1, t / Math.max(1, T)));
  return (t) => {
    const tt = Math.max(0, Math.min(T, t));
    return Math.max(0, Math.min(1, cumulativeShare(p, startMin, startMin + tt) / total));
  };
}
