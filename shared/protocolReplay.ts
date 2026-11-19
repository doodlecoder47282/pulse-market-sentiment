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
// Sessions on the same or neighbouring days are not independent events. Counts only, no rate. Pure, no I/O.

import { calendarLevels, sessionLevels, mergeLevels, type DayBar, type IntraBar, type BoardLevel } from "./levelBoard";
import { PROTOCOL_BOOK_VERSION, PROTOCOL_RULES, evalSweepReclaim, gradeProtocol, protocolRecord, type ProtocolCtx, type ProtocolRecord, type ProtocolRules } from "./protocols";
import { etClock, etWallToEpochMs, sessionCloseMinutes, REGULAR_OPEN_MIN } from "./exchangeCalendar";
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
  record: ProtocolRecord;
}

const wall = (ymd: string, h: number, m: number) => etWallToEpochMs(ymd, h * 60 + m);

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

/**
 * Replay the sweep-and-reclaim rule. `daily`: index daily bars, oldest first, reaching back before the first
 * replayed session. `minute`: index 1-minute bars over any number of sessions. A session still in progress at
 * `nowMs`, one with bars missing, or one with no prior daily bar is skipped with its reason, not replayed short.
 */
export function replaySweepReclaim(
  daily: DayBar[], minute: IntraBar[], nowMs: number,
  opts: { rules?: ProtocolRules; events?: MacroEvent[]; validThrough?: string; calendarFrom?: string } = {},
): ReplayResult {
  const r = opts.rules ?? PROTOCOL_RULES;
  const byDate = new Map<string, IntraBar[]>();
  for (const b of minute) {
    if (![b.t, b.open, b.high, b.low, b.close].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    const c = etClock(b.t);
    const close = sessionCloseMinutes(c.date);
    if (close == null || c.minutes < REGULAR_OPEN_MIN || c.minutes >= close) continue;
    (byDate.get(c.date) ?? byDate.set(c.date, []).get(c.date)!).push(b);
  }
  const events: ReplayEvent[] = [];
  const skipped: ReplayResult["skipped"] = [];
  const done: string[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const bars = byDate.get(date)!.sort((a, b) => a.t - b.t);
    const closeMin = sessionCloseMinutes(date)!;
    const openMs = etWallToEpochMs(date, REGULAR_OPEN_MIN);
    const closeMs = etWallToEpochMs(date, closeMin);
    const calFrom = opts.calendarFrom ?? MACRO_COMPLETE_FROM;
    if (date < calFrom) { skipped.push({ date, reason: `the release calendar is not complete before ${calFrom}, so the rule's release condition cannot be checked` }); continue; }
    if (nowMs < closeMs) { skipped.push({ date, reason: "session still in progress" }); continue; }
    const expected = closeMin - REGULAR_OPEN_MIN;
    if (bars[0].t !== openMs) { skipped.push({ date, reason: "no 1-minute bar starting at 09:30" }); continue; }
    if (bars.length < expected * REPLAY_MIN_COVERAGE) { skipped.push({ date, reason: `${bars.length} of ${expected} 1-minute bars present` }); continue; }
    const cal = calendarLevels(daily, date);
    if (!cal.some((l) => l.key === "pdl")) { skipped.push({ date, reason: "no daily bar before this session" }); continue; }
    done.push(date);
    let quietUntil = 0;
    for (let i = 0; i < bars.length; i++) {
      const now = bars[i].t + 60_000; // the minute bar i has just completed
      if (now >= closeMs) break;
      if (now < quietUntil) continue;
      const seen = bars.slice(0, i + 1);
      const price = bars[i].close;
      const levels: BoardLevel[] = mergeLevels([...cal, ...sessionLevels(seen, date, now)], price);
      const news = minutesToNextTier1(now, wall, opts.events ?? MACRO_EVENTS, opts.validThrough ?? MACRO_CALENDAR_VALID_THROUGH);
      const ctx: ProtocolCtx = {
        nowMs: now, sessionOpen: true,
        minutesSinceOpen: (now - openMs) / 60_000, minutesToClose: (closeMs - now) / 60_000,
        spx: price, levels, tech: "unknown", vix: "unknown",
        calendarKnown: news.known, minutesToTier1: news.minutes, minutesSinceTier1: news.minutesSinceLast,
        bars: joinBars(seen, openMs, REPLAY_EVAL_BAR_MIN, now), optionsState: "unavailable",
      };
      const e = evalSweepReclaim(ctx, r);
      if (!e.armed || e.entry == null || e.expectPrice == null || e.cancelPrice == null || e.horizonMin == null || !e.level) continue;
      // armedAt one millisecond before the minute boundary: the grader takes bars strictly after the arm time, and the next bar starts on the boundary.
      const g = gradeProtocol({ direction: "up", expectPrice: e.expectPrice, cancelPrice: e.cancelPrice, armedAt: now - 1, horizonMin: e.horizonMin }, bars, nowMs);
      events.push({
        date, armedAt: now, levelLabel: e.level.label, levelPrice: e.level.price, entry: e.entry, expectPrice: e.expectPrice, cancelPrice: e.cancelPrice,
        status: g.status === "open" ? "ungraded" : g.status, reason: g.status === "open" ? "bars do not reach the end of the horizon" : g.reason,
      });
      // The live engine does not arm a protocol again inside its horizon (30 minutes at least).
      quietUntil = now + Math.max(e.horizonMin, 30) * 60_000;
    }
  }
  return {
    protocol: "sweep_reclaim", bookVersion: PROTOCOL_BOOK_VERSION,
    sessionsReplayed: done.length, firstSession: done[0] ?? null, lastSession: done[done.length - 1] ?? null,
    skipped, events, record: protocolRecord(events.map((e) => e.status), true),
  };
}

/** One sentence for the card: what the replay covers and what it found, counts only. */
export function replayAnswer(x: ReplayResult): string {
  if (!x.sessionsReplayed) return "No past session could be replayed yet.";
  const g = x.record;
  const span = x.firstSession === x.lastSession ? x.firstSession : `${x.firstSession} to ${x.lastSession}`;
  if (!x.events.length) return `Replayed over ${x.sessionsReplayed} past session${x.sessionsReplayed === 1 ? "" : "s"} (${span}), the sweep rule never armed.`;
  return `Replayed over ${x.sessionsReplayed} past session${x.sessionsReplayed === 1 ? "" : "s"} (${span}), the sweep rule armed ${x.events.length} time${x.events.length === 1 ? "" : "s"}: ${g.expected} reached the rule's outcome price, ${g.cancelled} cancelled, ${g.neither} neither.`;
}
