// shared/macroCalendar.ts
//
// Tier-1 scheduled releases the setup rules keep clear of. A static list,
// keyless, checked against the agencies' own calendars (BLS schedule, BEA
// schedule, FOMC calendar) on 2026-10-20; it is valid through the date
// below and reports itself unknown after that, so a stale calendar is never
// mistaken for "no event". Times are America/New_York wall clock.

export interface MacroEvent {
  /** YYYY-MM-DD, ET. */
  date: string;
  /** HH:MM, ET. */
  time: string;
  name: "CPI" | "NFP" | "PCE" | "FOMC";
  tier: 1;
  note?: string;
}

export const MACRO_CALENDAR_VALID_THROUGH = "2026-12-31";

/**
 * Coverage note for the event replay: NFP is complete for 2026 (BLS
 * schedule); FOMC decision days are the Federal Reserve's published 2026
 * meetings; CPI and PCE are loaded from the fourth quarter only, so a
 * replay of those two before October 2026 is "not loaded", never empty.
 * Sources disagreed on one PCE date (Nov 4 vs Nov 25); the agency-cited
 * Nov 25 is kept and flagged for verification against bea.gov.
 */
export const MACRO_COVERAGE: Record<MacroEvent["name"], string> = {
  NFP: "all 2026 releases",
  FOMC: "all 2026 decision days",
  CPI: "October 2026 onward",
  PCE: "October 2026 onward (Nov 25 to verify against bea.gov)",
};

export const MACRO_EVENTS: MacroEvent[] = [
  { date: "2026-01-09", time: "08:30", name: "NFP", tier: 1, note: "December 2025 data" },
  { date: "2026-01-28", time: "14:00", name: "FOMC", tier: 1, note: "decision; meeting Jan 27-28" },
  { date: "2026-02-11", time: "08:30", name: "NFP", tier: 1, note: "January data (delayed release)" },
  { date: "2026-03-06", time: "08:30", name: "NFP", tier: 1, note: "February data" },
  { date: "2026-03-18", time: "14:00", name: "FOMC", tier: 1, note: "decision; meeting Mar 17-18" },
  { date: "2026-04-03", time: "08:30", name: "NFP", tier: 1, note: "March data" },
  { date: "2026-04-29", time: "14:00", name: "FOMC", tier: 1, note: "decision; meeting Apr 28-29" },
  { date: "2026-05-08", time: "08:30", name: "NFP", tier: 1, note: "April data" },
  { date: "2026-06-05", time: "08:30", name: "NFP", tier: 1, note: "May data" },
  { date: "2026-06-17", time: "14:00", name: "FOMC", tier: 1, note: "decision; meeting Jun 16-17" },
  { date: "2026-07-02", time: "08:30", name: "NFP", tier: 1, note: "June data (early for the holiday)" },
  { date: "2026-07-29", time: "14:00", name: "FOMC", tier: 1, note: "decision; meeting Jul 28-29" },
  { date: "2026-08-07", time: "08:30", name: "NFP", tier: 1, note: "July data" },
  { date: "2026-09-04", time: "08:30", name: "NFP", tier: 1, note: "August data" },
  { date: "2026-09-16", time: "14:00", name: "FOMC", tier: 1, note: "decision; meeting Sep 15-16" },
  { date: "2026-10-02", time: "08:30", name: "NFP", tier: 1, note: "September data" },
  { date: "2026-10-28", time: "14:00", name: "FOMC", tier: 1, note: "decision; meeting Oct 27-28" },
  { date: "2026-10-29", time: "08:30", name: "PCE", tier: 1, note: "September data" },
  { date: "2026-11-06", time: "08:30", name: "NFP", tier: 1, note: "October data" },
  { date: "2026-11-10", time: "08:30", name: "CPI", tier: 1, note: "October data" },
  { date: "2026-11-25", time: "08:30", name: "PCE", tier: 1, note: "October data" },
  { date: "2026-12-04", time: "08:30", name: "NFP", tier: 1, note: "November data" },
  { date: "2026-12-09", time: "14:00", name: "FOMC", tier: 1, note: "decision; meeting Dec 8-9" },
  { date: "2026-12-10", time: "08:30", name: "CPI", tier: 1, note: "November data" },
  { date: "2026-12-23", time: "08:30", name: "PCE", tier: 1, note: "November data" },
];

/**
 * Minutes from `nowMs` to the next tier-1 event, given a function that turns
 * an ET date and time into epoch ms (server/validationMath.etWallToUtcMs or
 * a test stub). Returns { minutes: null, known: false } once the calendar's
 * validity has passed: an unknown calendar is reported, never treated as
 * quiet.
 */
export function minutesToNextTier1(
  nowMs: number,
  etWallToUtcMs: (ymd: string, hour: number, minute: number) => number,
  events: MacroEvent[] = MACRO_EVENTS,
  validThrough: string = MACRO_CALENDAR_VALID_THROUGH,
): { minutes: number | null; next: MacroEvent | null; known: boolean } {
  const validUntilMs = etWallToUtcMs(validThrough, 23, 59);
  if (nowMs > validUntilMs) return { minutes: null, next: null, known: false };
  let best: { minutes: number; ev: MacroEvent } | null = null;
  for (const ev of events) {
    const [h, m] = ev.time.split(":").map(Number);
    const at = etWallToUtcMs(ev.date, h, m);
    const minutes = (at - nowMs) / 60_000;
    if (minutes < 0) continue;
    if (!best || minutes < best.minutes) best = { minutes, ev };
  }
  return { minutes: best ? Math.round(best.minutes) : null, next: best?.ev ?? null, known: true };
}
