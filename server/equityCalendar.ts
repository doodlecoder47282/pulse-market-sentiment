import { etEpochMs } from "./etTime";
import { EQUITY_CALENDAR_VERSION, type EquitySchedule } from "../shared/equityCalendar";

/**
 * Reviewed published COMMON core cash-equity schedule, not live exchange status.
 * 2026 only: NYSE and Nasdaq schedules were cross-checked on 2026-10-02 UTC.
 * No holiday inference outside coverage, live halt feed or historical known-at claim.
 */
export const CALENDAR_SOURCES = Object.freeze([
  "https://www.nyse.com/trade/hours-calendars",
  "https://www.nasdaq.com/market-activity/stock-market-holiday-schedule",
]);
export const CALENDAR_REVIEWED_AT = "2026-10-02T02:09:20.000Z";
const HOLIDAYS: Readonly<Record<string, string>> = Object.freeze({
  "2026-01-01": "New Year's Day", "2026-01-19": "Martin Luther King Jr. Day",
  "2026-02-16": "Presidents Day", "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day", "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day observed", "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving", "2026-12-25": "Christmas",
});
const EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24"]);
const DAY = 86400_000;
function validDate(date: string) {
  const n = Date.parse(`${date}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === date;
}
export function shiftSessionDate(date: string, days: number): string {
  if (!validDate(date) || !Number.isInteger(days)) throw new Error("Invalid calendar date");
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
export function easternDate(now: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(k => parts.find(p => p.type === k)!.value).join("-");
}
export function equityDay(date: string) {
  const base = { date, open: null as number | null, close: null as number | null,
    minutes: null as number | null, holiday: null as string | null };
  if (!validDate(date) || date < "2026-01-01" || date > "2026-12-31") return { ...base, kind: "unknown" as const };
  if (HOLIDAYS[date]) return { ...base, kind: "holiday" as const, holiday: HOLIDAYS[date] };
  if ([0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return { ...base, kind: "weekend" as const };
  const early = EARLY_CLOSES.has(date);
  return { ...base, kind: early ? "early_close" as const : "regular" as const,
    open: etEpochMs(date, 9, 30), close: etEpochMs(date, early ? 13 : 16, 0), minutes: early ? 210 : 390 };
}
export function isScheduledSession(date: string): boolean {
  return equityDay(date).open !== null;
}
/** Ascending expected sessions strictly before the selected date, never backfill across unknown coverage. */
export function previousSessions(before: string, count: number): string[] | null {
  if (!validDate(before) || equityDay(before).kind === "unknown" || !Number.isInteger(count) || count < 1 || count > 60) return null;
  const found: string[] = [];
  let date = before;
  for (let n = 0; n < 110 && found.length < count; n++) {
    date = shiftSessionDate(date, -1);
    const day = equityDay(date);
    if (day.kind === "unknown") return null;
    if (day.open !== null) found.push(date);
  }
  return found.length === count ? found.reverse() : null;
}
export function referenceSessions(today: string, horizon: "swing" | "intraday"): string[] | null {
  if (equityDay(today).kind === "unknown") return null;
  if (horizon === "intraday") return previousSessions(today, 1);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = shiftSessionDate(today, -((weekday + 6) % 7) - 7);
  const dates = Array.from({ length: 5 }, (_, i) => shiftSessionDate(monday, i));
  if (dates.some(d => equityDay(d).kind === "unknown")) return null;
  return dates.filter(isScheduledSession);
}
export function scheduledSession(now: number): { label: string; schedule: EquitySchedule } {
  const date = easternDate(now), day = equityDay(date);
  const phase = day.kind === "unknown" ? "unknown" : day.open === null ? "closed"
    : now < day.open ? "before_core" : now < day.close! ? "core_window" : "after_core";
  const boundary = Math.min(etEpochMs(shiftSessionDate(date, 1), 0, 0),
    ...[day.open, day.close].filter((t): t is number => t !== null && t > now));
  const wording = phase === "unknown" ? "Schedule unavailable outside reviewed 2026 coverage"
    : phase === "closed" ? `Scheduled closed: ${day.holiday ?? "weekend"}`
    : `${phase === "before_core" ? "Before" : phase === "after_core" ? "After" : "Within"} scheduled core session`
      + (day.kind === "early_close" ? " (1:00 p.m. ET early close)" : " (9:30 a.m.–4:00 p.m. ET)");
  return { label: `${wording}. Live venue status and instrument halts unverified.`,
    schedule: {
      version: EQUITY_CALENDAR_VERSION, timezone: "America/New_York",
      coverage_from: "2026-01-01", coverage_through: "2026-12-31",
      reviewed_at: CALENDAR_REVIEWED_AT, source_urls: [...CALENDAR_SOURCES],
      coverage: day.kind === "unknown" ? "unsupported" : "covered",
      session_date: date, day_type: day.kind, phase,
      open_at: day.open === null ? null : new Date(day.open).toISOString(),
      close_at: day.close === null ? null : new Date(day.close).toISOString(),
      session_minutes: day.minutes, holiday: day.holiday, next_boundary_at: new Date(boundary).toISOString(),
      live_status_verified: false, point_in_time_safe: false,
    } };
}
