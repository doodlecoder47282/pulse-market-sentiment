// shared/whaleDays.ts
// HOW A RECORD IS SPREAD OVER DAYS. A win count over a window hides whether the wins came on many days or on
// one. Whale positions flagged on the same day tend to close on the same day and move together, so a single
// session can carry the whole figure. This counts scored closes per day and says, in counts, how much of the
// record one day holds. It describes the record; it does not adjust or reweight it. Pure.

export interface ClosedResult { /** ET date the position closed or expired (YYYY-MM-DD). */ day: string; win: boolean }
export interface DayRow { day: string; n: number; wins: number }
export interface DaySpread {
  total: number;
  wins: number;
  /** Newest day first. */
  byDay: DayRow[];
  /** The day with the most scored closes (the newest on a tie); null when nothing is scored. */
  busiest: DayRow | null;
  /** The day with the most winning closes (the newest on a tie); null when there are no wins. */
  mostWins: DayRow | null;
  /** True when one day holds at least half of the scored closes, or at least half of the wins (two or more of each). */
  oneDayCarries: boolean;
}

export function daySpread(results: ClosedResult[]): DaySpread {
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
  // byDay is newest first, so a strict ">" keeps the newest on a tie.
  let busiest: DayRow | null = null;
  let mostWins: DayRow | null = null;
  for (const r of byDay) {
    if (!busiest || r.n > busiest.n) busiest = r;
    if (r.wins > 0 && (!mostWins || r.wins > mostWins.wins)) mostWins = r;
  }
  const oneDayCarries = (total >= 2 && busiest != null && busiest.n * 2 >= total) || (wins >= 2 && mostWins != null && mostWins.wins * 2 >= wins);
  return { total, wins, byDay, busiest, mostWins, oneDayCarries };
}

/** One sentence in counts; null when nothing is scored. */
export function daySpreadAnswer(s: DaySpread | null | undefined): string | null {
  if (!s || !s.total || !s.busiest) return null;
  const d = s.byDay.length;
  if (s.total === 1) return `One scored close, on ${s.busiest.day}: a single result, not a record.`;
  if (d === 1) return `All ${s.total} scored closes fell on one day (${s.busiest.day}): this is one session's result, not a record across days.`;
  let out = `The ${s.total} scored closes fell on ${d} days; ${s.busiest.n} of them on ${s.busiest.day}.`;
  if (s.wins > 0 && s.mostWins) out += ` ${s.mostWins.wins} of the ${s.wins} that made money closed on ${s.mostWins.day}.`;
  if (s.oneDayCarries) out += " One day holds half or more of this figure, so it moves with that day.";
  return out;
}
