// shared/protocolReplay.ts
//
// REPLAY OF A PROTOCOL OVER PAST SESSIONS. The live engine (server/protocolEngine.ts) gets one session a day,
// so a rule needs weeks to reach a count worth reading. A rule whose conditions are prices only can be run
// over sessions that already happened: the same evaluator (shared/protocols.ts) is stepped through each past
// session minute by minute, seeing only the bars that were complete at that minute, and each arm is graded by
// the same grader on the 1-minute bars that followed.
//
// What a replay is not. It is not the live record and is never added to it. The live engine reads a live
// price every 60 seconds; the replay uses the close of the last completed 1-minute bar as that price. The
// replay sees calendar and session levels only (prior day, week, pivots, opening range): option landmarks
// (magnet below, straddle low) need a past option chain, which is not stored, so sweeps of those are absent.
// Sessions on the same or neighbouring days are not independent events, so a replay count never makes a rule
// "tested", whatever its size. Counts only, no rate. Pure, no I/O.

import { calendarLevels, sessionLevels, mergeLevels, OPENING_RANGE_MIN, type DayBar, type IntraBar, type BoardLevel } from "./levelBoard";
import { PROTOCOL_BOOK_VERSION, PROTOCOL_RULES, evalSweepReclaim, gradeProtocol, protocolRecord, type ProtocolCtx, type ProtocolRecord, type ProtocolRules } from "./protocols";
import { etClock, etWallToEpochMs, sessionCloseMinutes, prevTradingDay, REGULAR_OPEN_MIN } from "./exchangeCalendar";
import { minutesToNextTier1, MACRO_EVENTS, MACRO_CALENDAR_VALID_THROUGH, MACRO_COMPLETE_FROM, type MacroEvent } from "./macroCalendar";

/** The live engine evaluates on 5-minute bars (server/deskBoard.ts intraBars); the replay builds the same from 1-minute bars. */
export const REPLAY_EVAL_BAR_MIN = 5;
/** A session is replayed only with at least this share of its 1-minute bars present. */
export const REPLAY_MIN_COVERAGE = 0.95;

export interface ReplayEvent {
  date: string; armedAt: number; levelLabel: string; levelPrice: number;
  entry: number; expectPrice: number; cancelPrice: number;
  status: string; reason: string | null;
}
export interface ReplayResult {
  protocol: "sweep_reclaim";
  bookVersion: string;
  sessionsReplayed: number;
  firstSession: string | null;
  lastSession: string | null;
  skipped: Array<{ date: string; reason: string }>;
  events: ReplayEvent[];
  /** Counts from the shared record; `tested` is always false and `text` is the replay's own wording. */
  record: ProtocolRecord;
}
/** One session's outcome: replayed (with its arms, possibly none) or skipped with the reason. */
export type SessionReplay = { date: string; skipped: string; events: null } | { date: string; skipped: null; events: ReplayEvent[] };
export interface ReplayOpts { rules?: ProtocolRules; events?: MacroEvent[]; validThrough?: string; calendarFrom?: string }

/** 1-minute bars of one session joined into bars of `min` minutes anchored at 09:30; a bucket is kept only when complete at `nowMs`. */
export function joinBars(minute: IntraBar[], openMs: number, min: number, nowMs: number): IntraBar[] {
  const size = min * 60_000;
  const out = new Map<number, IntraBar>();
  for (const b of minute) {
    if (b.t < openMs) continue;
    const t = openMs + Math.floor((b.t - openMs) / size) * size;
    if (t + size > nowMs) continue;
    const cur = out.get(t);
    if (!cur) out.set(t, { t, open: b.open, high: b.high, low: b.low, close: b.close });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/** Regular-session 1-minute bars grouped by ET date, each oldest first. Bars outside the session or with a bad number are dropped. */
export function sessionsOf(minute: IntraBar[]): Map<string, IntraBar[]> {
  const byDate = new Map<string, IntraBar[]>();
  for (const b of minute) {
    if (![b.t, b.open, b.high, b.low, b.close].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    const c = etClock(b.t);
    const close = sessionCloseMinutes(c.date);
    if (close == null || c.minutes < REGULAR_OPEN_MIN || c.minutes >= close) continue;
    (byDate.get(c.date) ?? byDate.set(c.date, []).get(c.date)!).push(b);
  }
  for (const v of byDate.values()) v.sort((a, b) => a.t - b.t);
  return byDate;
}

/**
 * Replay the sweep-and-reclaim rule over ONE session. `bars`: that session's regular-session 1-minute bars,
 * oldest first. `daily`: index daily bars reaching back before the session. A session that cannot be replayed
 * as the live desk would have seen it is skipped with its reason, never replayed short: still in progress,
 * bars missing, the daily bar of the session before it not read, or the release calendar not covering it.
 * A finished session's result depends only on its own bars, the daily bars before it, the rules and the
 * calendar, so a caller may keep it.
 */
export function replaySession(date: string, bars: IntraBar[], daily: DayBar[], nowMs: number, opts: ReplayOpts = {}): SessionReplay {
  const r = opts.rules ?? PROTOCOL_RULES;
  const skip = (reason: string): SessionReplay => ({ date, skipped: reason, events: null });
  const closeMin = sessionCloseMinutes(date);
  if (closeMin == null || !bars.length) return skip("not a trading session with bars");
  const openMs = etWallToEpochMs(date, REGULAR_OPEN_MIN);
  const closeMs = etWallToEpochMs(date, closeMin);
  const calFrom = opts.calendarFrom ?? MACRO_COMPLETE_FROM;
  const validThrough = opts.validThrough ?? MACRO_CALENDAR_VALID_THROUGH;
  if (date < calFrom) return skip(`the release calendar is not complete before ${calFrom}, so the rule's release condition cannot be checked`);
  if (date > validThrough) return skip(`the release calendar is only valid through ${validThrough}, so the rule's release condition cannot be checked`);
  if (nowMs < closeMs) return skip("session still in progress");
  const expected = closeMin - REGULAR_OPEN_MIN;
  if (bars[0].t !== openMs) return skip("no 1-minute bar starting at 09:30");
  if (bars.length < expected * REPLAY_MIN_COVERAGE) return skip(`${bars.length} of ${expected} 1-minute bars present`);
  const prior = daily.filter((b) => b.date < date).map((b) => b.date).sort().pop() ?? null;
  const wantPrior = prevTradingDay(date);
  if (prior !== wantPrior) return skip(prior ? `the newest daily bar before this session is ${prior}, not ${wantPrior}` : "no daily bar before this session");
  const cal = calendarLevels(daily, date);
  if (!cal.some((l) => l.key === "pdl")) return skip("no usable daily bar before this session");

  // Session levels change twice: the open is known from the first bar, the opening range once a bar at or after its end is seen.
  const orEndMs = openMs + OPENING_RANGE_MIN * 60_000;
  const openOnly = sessionLevels(bars.slice(0, 1), date, bars[0].t + 60_000);
  const orIdx = bars.findIndex((b) => b.t >= orEndMs);
  const withRange = orIdx >= 0 ? sessionLevels(bars.slice(0, orIdx + 1), date, bars[orIdx].t + 60_000) : openOnly;
  // Every 5-minute bar of the session, built once; at each minute only those complete by then are passed on.
  const buckets = joinBars(bars, openMs, REPLAY_EVAL_BAR_MIN, closeMs);
  const bucketMs = REPLAY_EVAL_BAR_MIN * 60_000;
  const keep = Math.ceil(r.sweepReclaim.lookbackMin / REPLAY_EVAL_BAR_MIN) + 2;
  const wallMemo = new Map<string, number>();
  const wall = (ymd: string, h: number, m: number) => {
    const k = `${ymd}|${h}|${m}`;
    let v = wallMemo.get(k);
    if (v == null) { v = etWallToEpochMs(ymd, h * 60 + m); wallMemo.set(k, v); }
    return v;
  };

  const events: ReplayEvent[] = [];
  let quietUntil = 0;
  let done = 0; // 5-minute bars complete so far
  for (let i = 0; i < bars.length; i++) {
    const now = bars[i].t + 60_000; // the minute bar i has just completed
    if (now >= closeMs) break;
    while (done < buckets.length && buckets[done].t + bucketMs <= now) done++;
    if (now < quietUntil) continue;
    const price = bars[i].close;
    const levels: BoardLevel[] = mergeLevels([...cal, ...(orIdx >= 0 && i >= orIdx ? withRange : openOnly)], price);
    const news = minutesToNextTier1(now, wall, opts.events ?? MACRO_EVENTS, validThrough);
    const ctx: ProtocolCtx = {
      nowMs: now, sessionOpen: true,
      minutesSinceOpen: (now - openMs) / 60_000, minutesToClose: (closeMs - now) / 60_000,
      spx: price, levels, tech: "unknown", vix: "unknown",
      calendarKnown: news.known, minutesToTier1: news.minutes, minutesSinceTier1: news.minutesSinceLast,
      // The evaluator only reads bars inside its lookback; the last few completed 5-minute bars cover it.
      bars: buckets.slice(Math.max(0, done - keep), done), optionsState: "unavailable",
    };
    const e = evalSweepReclaim(ctx, r);
    if (!e.armed || e.entry == null || e.expectPrice == null || e.cancelPrice == null || e.horizonMin == null || !e.level) continue;
    // armedAt one millisecond before the minute boundary: the grader takes bars strictly after the arm time, and the next bar starts on the boundary.
    const g = gradeProtocol({ direction: "up", expectPrice: e.expectPrice, cancelPrice: e.cancelPrice, armedAt: now - 1, horizonMin: e.horizonMin }, bars, nowMs);
    // A minute missing between the arm and the moment it resolved could hold the other price: not graded.
    const until = g.at ?? now + e.horizonMin * 60_000;
    const used = bars.filter((b) => b.t >= now && b.t <= until);
    const gap = used.length === 0 || used[0].t !== now || used.some((b, j) => j > 0 && b.t - used[j - 1].t > 60_000);
    const status = g.status === "open" ? "ungraded" : gap && g.status !== "ungraded" ? "ungraded" : g.status;
    const reason = g.status === "open" ? "bars do not reach the end of the horizon" : gap && g.status !== "ungraded" ? "1-minute bars missing between the arm and its outcome" : g.reason;
    events.push({ date, armedAt: now, levelLabel: e.level.label, levelPrice: e.level.price, entry: e.entry, expectPrice: e.expectPrice, cancelPrice: e.cancelPrice, status, reason });
    // The live engine does not arm a protocol again inside its horizon (30 minutes at least).
    quietUntil = now + Math.max(e.horizonMin, 30) * 60_000;
  }
  return { date, skipped: null, events };
}

/** The replay record's wording: counts, and a plain statement that a replay never makes a rule tested. */
export function replayRecordText(rec: ProtocolRecord): string {
  const tail = rec.ungraded ? `; ${rec.ungraded} could not be graded` : "";
  return rec.graded === 0 ? `0 graded${tail}. A replay never counts as tested.`
    : `${rec.graded} graded: ${rec.expected} reached the rule's outcome price, ${rec.cancelled} cancelled, ${rec.neither} neither${tail}. Replay arms cluster in neighbouring sessions and are not independent, so this never counts as tested.`;
}

/** Put per-session outcomes together (in date order) into one result. */
export function combineReplays(sessions: SessionReplay[]): ReplayResult {
  const sorted = sessions.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const done = sorted.filter((s) => s.skipped == null);
  const events = done.flatMap((s) => s.events ?? []);
  const rec = protocolRecord(events.map((e) => e.status), true);
  return {
    protocol: "sweep_reclaim", bookVersion: PROTOCOL_BOOK_VERSION,
    sessionsReplayed: done.length, firstSession: done[0]?.date ?? null, lastSession: done[done.length - 1]?.date ?? null,
    skipped: sorted.filter((s) => s.skipped != null).map((s) => ({ date: s.date, reason: s.skipped! })),
    events, record: { ...rec, tested: false, text: replayRecordText(rec) },
  };
}

/** Replay every session found in `minute` (see replaySession). */
export function replaySweepReclaim(daily: DayBar[], minute: IntraBar[], nowMs: number, opts: ReplayOpts = {}): ReplayResult {
  const out: SessionReplay[] = [];
  for (const [date, bars] of sessionsOf(minute)) out.push(replaySession(date, bars, daily, nowMs, opts));
  return combineReplays(out);
}

/** One sentence for the card: what the replay covers and what it found, counts only. */
export function replayAnswer(x: ReplayResult): string {
  if (!x.sessionsReplayed) return "No past session could be replayed yet.";
  const g = x.record;
  const n = `${x.sessionsReplayed} past session${x.sessionsReplayed === 1 ? "" : "s"}`;
  const span = x.firstSession === x.lastSession ? x.firstSession : `${x.firstSession} to ${x.lastSession}`;
  if (!x.events.length) return `Replayed over ${n} (${span}), the sweep rule never armed.`;
  return `Replayed over ${n} (${span}), the sweep rule armed ${x.events.length} time${x.events.length === 1 ? "" : "s"}: ${g.expected} reached the rule's outcome price, ${g.cancelled} cancelled, ${g.neither} neither${g.ungraded ? `, ${g.ungraded} could not be graded` : ""}.`;
}
