// shared/eventReplay.ts
//
// "Every event against the record", narrowed to what this desk trades: what
// the index did on each tier-1 release day, from daily bars. For an 08:30
// release the event session is that date; for a 14:00 FOMC decision it is
// the same session (the close reacts). Pure: the server feeds it the bars it
// has and the calendar; a date with no bar says so.

import type { MacroEvent } from "./macroCalendar";

export interface DailyBarLike { date: string; open: number; high: number; low: number; close: number }

export interface EventReaction {
  date: string;
  name: MacroEvent["name"];
  time: string;
  note: string | null;
  priorClose: number | null;
  open: number | null;
  close: number | null;
  nextClose: number | null;
  /** Event-session close over the prior close, fraction. */
  closeMovePct: number | null;
  /** Gap at the open over the prior close (the 08:30 print's first mark), fraction. */
  gapPct: number | null;
  /** High-low range of the event session over the prior close, fraction. */
  rangePct: number | null;
  /** Next session's close over the event close, fraction. */
  nextDayPct: number | null;
  state: "ok" | "partial" | "no_bar" | "future";
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function eventReactions(bars: DailyBarLike[], events: MacroEvent[], todayDate: string): EventReaction[] {
  const sorted = bars.slice().sort((a, b) => a.date.localeCompare(b.date));
  const idx = new Map(sorted.map((b, i) => [b.date, i]));
  return events
    .filter((e) => e.tier === 1)
    .map((e): EventReaction => {
      const base: EventReaction = { date: e.date, name: e.name, time: e.time, note: e.note ?? null, priorClose: null, open: null, close: null, nextClose: null, closeMovePct: null, gapPct: null, rangePct: null, nextDayPct: null, state: "no_bar" };
      if (e.date > todayDate) return { ...base, state: "future" as const };
      const i = idx.get(e.date);
      if (i == null) return base;
      const b = sorted[i], prev = i > 0 ? sorted[i - 1] : null, next = i + 1 < sorted.length ? sorted[i + 1] : null;
      const pc = prev?.close ?? null;
      return {
        ...base,
        priorClose: pc, open: b.open, close: b.close, nextClose: next?.close ?? null,
        closeMovePct: pc ? r4((b.close - pc) / pc) : null,
        gapPct: pc ? r4((b.open - pc) / pc) : null,
        rangePct: pc ? r4((b.high - b.low) / pc) : null,
        nextDayPct: next ? r4((next.close - b.close) / b.close) : null,
        state: (pc && next ? "ok" : "partial") as EventReaction["state"],
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export interface EventSummary {
  name: MacroEvent["name"];
  n: number;
  up: number;
  medianAbsClosePct: number | null;
  medianRangePct: number | null;
  largestClosePct: { date: string; pct: number } | null;
}

export function summarizeReactions(rows: EventReaction[]): EventSummary[] {
  const by = new Map<MacroEvent["name"], EventReaction[]>();
  for (const r of rows) if (r.state === "ok" || r.state === "partial") (by.get(r.name) ?? by.set(r.name, []).get(r.name)!).push(r);
  const med = (xs: number[]) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return r4(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
  return Array.from(by.entries()).map(([name, rs]) => {
    const moves = rs.filter((r) => r.closeMovePct != null);
    const largest = moves.reduce<EventSummary["largestClosePct"]>((b, r) => (!b || Math.abs(r.closeMovePct!) > Math.abs(b.pct) ? { date: r.date, pct: r.closeMovePct! } : b), null);
    return {
      name, n: moves.length, up: moves.filter((r) => r.closeMovePct! > 0).length,
      medianAbsClosePct: med(moves.map((r) => Math.abs(r.closeMovePct!))),
      medianRangePct: med(rs.filter((r) => r.rangePct != null).map((r) => r.rangePct!)),
      largestClosePct: largest,
    };
  }).sort((a, b) => b.n - a.n);
}
