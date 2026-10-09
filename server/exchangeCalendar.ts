// server/exchangeCalendar.ts
//
// One US exchange calendar for the whole server: NYSE cash-equity and
// equity/index-option holidays plus early (1:00 p.m. ET) closes.
//
// Pure module: no DB, network or package imports, so it can be unit tested on
// plain Node. Everything is keyed by the America/New_York calendar date
// ("YYYY-MM-DD").
//
// Sources (verified 2026-10-08):
//   - NYSE Group, "NYSE Group Announces 2026, 2027 and 2028 Holiday and Early
//     Closings Calendar" (Business Wire, 23 Dec 2025):
//     https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/default.aspx
//   - NYSE hours and calendars page: https://www.nyse.com/markets/hours-calendars
//   - Cboe U.S. options 2026 holiday schedule (same full closures; RTH
//     09:30-13:00 ET on 27 Nov and 24 Dec 2026):
//     https://www.cboe.com/about/hours/us-options
//   - Cboe SPX/SPXW specification: expiring SPXW trading "will ordinarily
//     cease on the day of expiration, 4:00 pm ET" and "at 1:00 pm ET for any
//     half day holiday":
//     https://www.cboe.com/tradable_products/sp_500/spx_options/specifications/
//
// Notes:
//   - New Year's Day 2028 falls on a Saturday; NYSE observes no holiday
//     (Friday 31 Dec 2027 is a normal trading day).
//   - On early-close days NYSE says "eligible options" close at 1:15 p.m. ET,
//     but the equity close (and so the PM settlement of SPXW and equity
//     options) is 1:00 p.m. ET. sessionClose* below returns the equity close.
//   - Outside 2026-2028 the calendar falls back to "weekday = trading day"
//     and isCovered() returns false. Extend HOLIDAYS / EARLY_CLOSES when NYSE
//     publishes 2029.

export type IsoDate = string; // "YYYY-MM-DD" (America/New_York calendar date)

export const CALENDAR_FIRST_YEAR = 2026;
export const CALENDAR_LAST_YEAR = 2028;

/** Full-day market closures (NYSE equities and options; Cboe matches for 2026). */
export const HOLIDAYS: Readonly<Record<IsoDate, string>> = Object.freeze({
  // 2026
  "2026-01-01": "New Year's Day",
  "2026-01-19": "Martin Luther King, Jr. Day",
  "2026-02-16": "Washington's Birthday",
  "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day",
  "2026-06-19": "Juneteenth National Independence Day",
  "2026-07-03": "Independence Day (observed)",
  "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving Day",
  "2026-12-25": "Christmas Day",
  // 2027
  "2027-01-01": "New Year's Day",
  "2027-01-18": "Martin Luther King, Jr. Day",
  "2027-02-15": "Washington's Birthday",
  "2027-03-26": "Good Friday",
  "2027-05-31": "Memorial Day",
  "2027-06-18": "Juneteenth National Independence Day (observed)",
  "2027-07-05": "Independence Day (observed)",
  "2027-09-06": "Labor Day",
  "2027-11-25": "Thanksgiving Day",
  "2027-12-24": "Christmas Day (observed)",
  // 2028 (no New Year's Day holiday: 1 Jan 2028 is a Saturday)
  "2028-01-17": "Martin Luther King, Jr. Day",
  "2028-02-21": "Washington's Birthday",
  "2028-04-14": "Good Friday",
  "2028-05-29": "Memorial Day",
  "2028-06-19": "Juneteenth National Independence Day",
  "2028-07-04": "Independence Day",
  "2028-09-04": "Labor Day",
  "2028-11-23": "Thanksgiving Day",
  "2028-12-25": "Christmas Day",
});

/** Early closes: equities (and PM-settled option expiries) close 1:00 p.m. ET. */
export const EARLY_CLOSES: Readonly<Record<IsoDate, string>> = Object.freeze({
  "2026-11-27": "Day after Thanksgiving",
  "2026-12-24": "Christmas Eve",
  "2027-11-26": "Day after Thanksgiving",
  "2028-07-03": "Day before Independence Day",
  "2028-11-24": "Day after Thanksgiving",
});

/** Regular session times, ET wall clock, minutes after midnight. */
export const REGULAR_OPEN_MIN = 9 * 60 + 30;   // 09:30 ET
export const REGULAR_CLOSE_MIN = 16 * 60;      // 16:00 ET
export const EARLY_CLOSE_MIN = 13 * 60;        // 13:00 ET

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertIso(date: string): void {
  if (!ISO_RE.test(date)) throw new Error(`exchangeCalendar: expected YYYY-MM-DD, got "${date}"`);
}

/** Day of week of a calendar date (0 = Sunday ... 6 = Saturday). */
export function dayOfWeek(date: IsoDate): number {
  assertIso(date);
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Calendar date plus n days (n may be negative). */
export function addDays(date: IsoDate, n: number): IsoDate {
  assertIso(date);
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True when the date's year is inside the published, verified table range. */
export function isCovered(date: IsoDate): boolean {
  assertIso(date);
  const y = Number(date.slice(0, 4));
  return y >= CALENDAR_FIRST_YEAR && y <= CALENDAR_LAST_YEAR;
}

let warnedUncovered = false;
function noteUncovered(date: IsoDate): void {
  if (warnedUncovered || isCovered(date)) return;
  warnedUncovered = true;
  console.warn(
    `[exchangeCalendar] ${date} is outside the verified ${CALENDAR_FIRST_YEAR}-${CALENDAR_LAST_YEAR} holiday table; ` +
      `treating weekdays as trading days. Add the next NYSE calendar to server/exchangeCalendar.ts.`,
  );
}

export function isWeekend(date: IsoDate): boolean {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
}

/** Name of the full-day holiday on this date, or null. */
export function holidayName(date: IsoDate): string | null {
  assertIso(date);
  return HOLIDAYS[date] ?? null;
}

export function isHoliday(date: IsoDate): boolean {
  return holidayName(date) != null;
}

/** True on a 1:00 p.m. ET early-close trading day. */
export function isEarlyClose(date: IsoDate): boolean {
  assertIso(date);
  return EARLY_CLOSES[date] != null && !isWeekend(date);
}

/** Regular-session trading day: a weekday that is not a full-day holiday. */
export function isTradingDay(date: IsoDate): boolean {
  noteUncovered(date);
  return !isWeekend(date) && !isHoliday(date);
}

/** First trading day strictly after `date`. */
export function nextTradingDay(date: IsoDate): IsoDate {
  let d = addDays(date, 1);
  for (let i = 0; i < 15 && !isTradingDay(d); i++) d = addDays(d, 1);
  return d;
}

/** Last trading day strictly before `date`. */
export function prevTradingDay(date: IsoDate): IsoDate {
  let d = addDays(date, -1);
  for (let i = 0; i < 15 && !isTradingDay(d); i++) d = addDays(d, -1);
  return d;
}

/** Session close as ET minutes after midnight (960 or 780), or null if closed all day. */
export function sessionCloseMinutes(date: IsoDate): number | null {
  if (!isTradingDay(date)) return null;
  return isEarlyClose(date) ? EARLY_CLOSE_MIN : REGULAR_CLOSE_MIN;
}

/** Session close as ET wall clock {hh, mm} (16:00, or 13:00 on half days), or null. */
export function sessionClose(date: IsoDate): { hh: number; mm: number } | null {
  const m = sessionCloseMinutes(date);
  return m == null ? null : { hh: Math.floor(m / 60), mm: m % 60 };
}

/**
 * Epoch ms of an ET wall-clock time on a calendar date. DST-aware: tries both
 * US Eastern offsets and keeps the one that round-trips. (Same method as
 * etTime.etEpochMs; duplicated here so this module has no imports.)
 */
export function etWallToEpochMs(date: IsoDate, minutesAfterMidnight: number): number {
  assertIso(date);
  const hh = Math.floor(minutesAfterMidnight / 60);
  const mm = minutesAfterMidnight % 60;
  const hhs = String(hh).padStart(2, "0");
  const mms = String(mm).padStart(2, "0");
  for (const off of ["-04:00", "-05:00"]) {
    const ms = Date.parse(`${date}T${hhs}:${mms}:00${off}`);
    if (Number.isNaN(ms)) continue;
    const c = etClock(ms);
    if (c.date === date && c.minutes === minutesAfterMidnight) return ms;
  }
  return Date.parse(`${date}T${hhs}:${mms}:00-05:00`);
}

/** Epoch ms of the 09:30 ET open, or null on a non-trading day. */
export function sessionOpenMs(date: IsoDate): number | null {
  return isTradingDay(date) ? etWallToEpochMs(date, REGULAR_OPEN_MIN) : null;
}

/** Epoch ms of the session close (16:00 ET, 13:00 ET on half days), or null. */
export function sessionCloseMs(date: IsoDate): number | null {
  const m = sessionCloseMinutes(date);
  return m == null ? null : etWallToEpochMs(date, m);
}

/** Regular-session minutes on a date: 390, 210 on half days, 0 when closed. */
export function sessionMinutes(date: IsoDate): number {
  const m = sessionCloseMinutes(date);
  return m == null ? 0 : m - REGULAR_OPEN_MIN;
}

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false, weekday: "short",
});
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface EtClock {
  date: IsoDate;   // ET calendar date
  hh: number;
  mm: number;
  ss: number;
  dow: number;     // 0 = Sunday
  minutes: number; // hh*60 + mm
}

/** ET wall clock for an instant (default: now). */
export function etClock(ms: number = Date.now()): EtClock {
  const parts = ET_FMT.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hh = parseInt(get("hour"), 10) % 24; // some ICU builds emit "24" at midnight
  const mm = parseInt(get("minute"), 10);
  const ss = parseInt(get("second"), 10);
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hh, mm, ss,
    dow: DOW[get("weekday")] ?? -1,
    minutes: hh * 60 + mm,
  };
}

/** ET calendar date of an instant (default: now). */
export function etDate(ms: number = Date.now()): IsoDate {
  return etClock(ms).date;
}

/** True while the regular session is open: trading day, 09:30 <= t < close (16:00 or 13:00 ET). */
export function isRegularSessionOpen(ms: number = Date.now()): boolean {
  const c = etClock(ms);
  const close = sessionCloseMinutes(c.date);
  if (close == null) return false;
  return c.minutes >= REGULAR_OPEN_MIN && c.minutes < close;
}

/**
 * Data state of today's intraday tape. Bars are never fabricated: an empty
 * tape is "no_data" with the reason, so a chart shows nothing rather than an
 * invented path.
 *   ok       at least one bar
 *   no_data  no session today, pre-market, or the session is (or was) open
 *            and the feed returned no bars (failed or empty collection).
 */
export function intradayTapeState(barCount: number, ms: number = Date.now()): { dataState: "ok" | "no_data"; reason: string | null } {
  if (barCount > 0) return { dataState: "ok", reason: null };
  const c = etClock(ms);
  if (sessionCloseMinutes(c.date) == null) return { dataState: "no_data", reason: "no session today (weekend or exchange holiday)" };
  if (c.minutes < REGULAR_OPEN_MIN) return { dataState: "no_data", reason: "pre-market: no regular-session bars yet" };
  return { dataState: "no_data", reason: "intraday tape returned no bars (feed failed or empty)" };
}
