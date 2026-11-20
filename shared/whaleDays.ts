// shared/whaleDays.ts
// HOW A RECORD IS SPREAD OVER DAYS. A win count over a window hides whether the wins came on many days or on
// one. Whale positions flagged on the same day tend to move together, so a single session's alerts can carry
// the whole figure. This counts scored positions by the ET day they were FLAGGED (not the day they closed:
// most short-dated contracts expire on a Friday, so close days pile up by the calendar whatever the results)
// and says, in counts, how much of the record one day holds. It describes the record; it does not adjust or
// reweight it. Pure.

export interface FlaggedResult { /** ET date the position was flagged (YYYY-MM-DD). */ day: string; win: boolean }
export interface DayRow { day: string; n: number; wins: number }
/** Wins needed before "most of the wins came from one day" is said at all. */
export const DAY_WINS_FLOOR = 3;
export interface DaySpread {
  total: number;
  wins: number;
  /** Newest day first. */
  byDay: DayRow[];
  /** The one day with more scored positions than any other; null on a tie or when nothing is scored. */
  busiest: DayRow | null;
  /** The one day with more wins than any other; null on a tie or when there are no wins. */
  mostWins: DayRow | null;
  /** That one day holds more than half of the scored positions (two or more days in the record). */
  dayHoldsMostPositions: boolean;
  /** That one day holds more than half of the wins (at least DAY_WINS_FLOOR wins, two or more days in the record). */
  dayHoldsMostWins: boolean;
}

const single = (rows: DayRow[], f: (r: DayRow) => number): DayRow | null => {
  let best: DayRow | null = null;
  let tie = false;
  for (const r of rows) {
    if (!best || f(r) > f(best)) { best = r; tie = false; } else if (f(r) === f(best)) tie = true;
  }
  return best && !tie && f(best) > 0 ? best : null;
};

export function daySpread(results: FlaggedResult[]): DaySpread {
  const m = new Map<string, DayRow>();
  for (const r of results) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.day)) continue;
    const row = m.get(r.day) ?? { day: r.day, n: 0, wins: 0 };
    row.n++;
    if (r.win) row.wins++;
    m.set(r.day, row);
  }
  const byDay = Array.from(m.values()).sort((a, b) => (a.day < b.day ? 1 : -1));
  const total = byDay.reduce((a, r) => a + r.n, 0);
  const wins = byDay.reduce((a, r) => a + r.wins, 0);
  const busiest = single(byDay, (r) => r.n);
  const mostWins = single(byDay, (r) => r.wins);
  const many = byDay.length >= 2;
  return {
    total, wins, byDay, busiest, mostWins,
    dayHoldsMostPositions: many && busiest != null && busiest.n * 2 > total,
    dayHoldsMostWins: many && wins >= DAY_WINS_FLOOR && mostWins != null && mostWins.wins * 2 > wins,
  };
}

/** One or two sentences in counts; null when nothing is scored. */
export function daySpreadAnswer(s: DaySpread | null | undefined): string | null {
  if (!s || !s.total || !s.byDay.length) return null;
  const d = s.byDay.length;
  if (s.total === 1) return `One scored position, flagged on ${s.byDay[0].day}: a single result, not a record.`;
  if (d === 1) return `${s.total === 2 ? "Both" : `All ${s.total}`} scored positions were flagged on one day (${s.byDay[0].day}): this is one session's alerts, not a record across days.`;
  let out = `The ${s.total} scored positions were flagged on ${d} days.`;
  if (s.dayHoldsMostPositions && s.busiest) out += ` ${s.busiest.day} holds ${s.busiest.n} of the ${s.total}.`;
  if (s.dayHoldsMostWins && s.mostWins) out += ` ${s.mostWins.day} holds ${s.mostWins.wins} of the ${s.wins} that made money, so the win count moves with that day's alerts.`;
  return out;
}
