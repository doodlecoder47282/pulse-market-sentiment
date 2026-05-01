// server/volCalendar.ts
//
// Volatility event calendar — computes upcoming OPEX, VIX expirations,
// triple witching, FOMC meetings, CPI releases, and NFP dates.
//
// Monthly OPEX, VIX exp, and NFP are computed algorithmically.
// FOMC and CPI dates for 2025-2026 are hardcoded from the official schedule.
// Vol calendar is recomputed per request (cheap date math, no external calls).

export type EventType = "monthly_opex" | "vix_exp" | "quad_witching" | "fomc" | "cpi" | "nfp";
export type Importance = "high" | "medium" | "low";

export interface VolEvent {
  date: string;        // YYYY-MM-DD
  type: EventType;
  label: string;
  daysAway: number;
  importance: Importance;
}

export interface VolCalendarResponse {
  events: VolEvent[];
  asOf: string;
  warnings?: string[];
  // Last hardcoded date in each schedule — used by clients to know when the
  // calendar will go stale. If today > lastFomc / lastCpi, we won't surface
  // events of that type and a warning is emitted.
  bounds: {
    lastFomc: string;
    lastCpi: string;
    fomcStale: boolean;
    cpiStale: boolean;
  };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAway(dateStr: string, today: Date): number {
  const d = new Date(dateStr + "T12:00:00Z");
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d.getTime() - t.getTime()) / 86400000);
}

/** Get the Nth occurrence of a weekday (0=Sun, 1=Mon…6=Sat) in a given year/month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const d = new Date(year, month, 1);
  // Advance to first occurrence of weekday
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  // Advance by n-1 more weeks
  d.setDate(d.getDate() + (n - 1) * 7);
  return d;
}

/** Third Friday of month — standard monthly OPEX. */
function thirdFriday(year: number, month: number): Date {
  return nthWeekday(year, month, 5, 3);
}

/** First Friday of month — NFP. */
function firstFriday(year: number, month: number): Date {
  return nthWeekday(year, month, 5, 1);
}

/**
 * VIX expiration = Wednesday 30 calendar days before next SPX monthly expiry.
 * Next SPX monthly expiry = 3rd Friday of the following month.
 */
function vixExpiration(year: number, month: number): Date {
  // Next month's 3rd Friday
  let nextMonth = month + 1;
  let nextYear = year;
  if (nextMonth > 11) { nextMonth = 0; nextYear++; }
  const nextOpex = thirdFriday(nextYear, nextMonth);
  // Subtract 30 calendar days, find the Wednesday of that week
  const rawD = new Date(nextOpex);
  rawD.setDate(rawD.getDate() - 30);
  // Snap to Wednesday (3) of that week
  const dow = rawD.getDay(); // 0=Sun
  const daysToWed = (3 - dow + 7) % 7;
  rawD.setDate(rawD.getDate() + daysToWed);
  return rawD;
}

function isQuadWitching(year: number, month: number): boolean {
  // March=2, June=5, September=8, December=11 (0-indexed)
  return [2, 5, 8, 11].includes(month);
}

// ---- Hardcoded FOMC 2025-2026 meeting dates (decision day = second day) ----
// Source: Federal Reserve meeting calendar
const FOMC_DATES: string[] = [
  // 2025
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18",
  "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
  // 2026
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-16",
];

// ---- Hardcoded CPI release dates 2025-2026 (BLS scheduled) ----
const CPI_DATES: string[] = [
  // 2025
  "2025-01-15", "2025-02-12", "2025-03-12", "2025-04-10",
  "2025-05-13", "2025-06-11", "2025-07-15", "2025-08-12",
  "2025-09-10", "2025-10-15", "2025-11-13", "2025-12-10",
  // 2026
  "2026-01-14", "2026-02-11", "2026-03-11", "2026-04-10",
  "2026-05-13", "2026-06-10", "2026-07-15", "2026-08-12",
  "2026-09-09", "2026-10-14", "2026-11-12", "2026-12-09",
];

export function buildVolCalendar(): VolCalendarResponse {
  const today = new Date();
  const todayStr = toDateStr(today);
  const cutoffDate = new Date(today);
  cutoffDate.setDate(cutoffDate.getDate() + 90);
  const cutoffStr = toDateStr(cutoffDate);

  // #7: bounds check — hardcoded FOMC/CPI lists eventually run out.
  // If today is past the last hardcoded date, log + surface a warning so
  // callers know the calendar is stale and the lists need to be refreshed.
  const lastFomc = FOMC_DATES[FOMC_DATES.length - 1];
  const lastCpi = CPI_DATES[CPI_DATES.length - 1];
  const fomcStale = todayStr > lastFomc;
  const cpiStale = todayStr > lastCpi;
  const warnings: string[] = [];
  if (fomcStale) {
    const msg = `FOMC schedule stale: last hardcoded date ${lastFomc} is past today (${todayStr}). Refresh FOMC_DATES with the next FOMC calendar.`;
    warnings.push(msg);
    console.warn(`[volCalendar] ${msg}`);
  }
  if (cpiStale) {
    const msg = `CPI schedule stale: last hardcoded date ${lastCpi} is past today (${todayStr}). Refresh CPI_DATES with the next BLS release schedule.`;
    warnings.push(msg);
    console.warn(`[volCalendar] ${msg}`);
  }

  const events: VolEvent[] = [];

  // Generate OPEX/VIX/NFP for current month + next 7 months
  for (let offset = 0; offset <= 7; offset++) {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const year = d.getFullYear();
    const month = d.getMonth(); // 0-indexed

    // Monthly OPEX (3rd Friday)
    const opexDate = thirdFriday(year, month);
    const opexStr = toDateStr(opexDate);
    if (opexStr >= todayStr && opexStr <= cutoffStr) {
      const isQuad = isQuadWitching(year, month);
      events.push({
        date: opexStr,
        type: isQuad ? "quad_witching" : "monthly_opex",
        label: isQuad
          ? `${MONTH_NAMES[month]} Quad Witching`
          : `${MONTH_NAMES[month]} OPEX`,
        daysAway: daysAway(opexStr, today),
        importance: isQuad ? "high" : "medium",
      });
    }

    // VIX expiration (Wednesday ~30 days before next month's OPEX)
    const vixDate = vixExpiration(year, month);
    const vixStr = toDateStr(vixDate);
    if (vixStr >= todayStr && vixStr <= cutoffStr) {
      events.push({
        date: vixStr,
        type: "vix_exp",
        label: `VIX ${MONTH_NAMES[month]} Exp`,
        daysAway: daysAway(vixStr, today),
        importance: "medium",
      });
    }

    // NFP — first Friday of month
    const nfpDate = firstFriday(year, month);
    const nfpStr = toDateStr(nfpDate);
    if (nfpStr >= todayStr && nfpStr <= cutoffStr) {
      events.push({
        date: nfpStr,
        type: "nfp",
        label: `${MONTH_NAMES[month]} Jobs Report (NFP)`,
        daysAway: daysAway(nfpStr, today),
        importance: "medium",
      });
    }
  }

  // FOMC dates
  for (const dateStr of FOMC_DATES) {
    if (dateStr >= todayStr && dateStr <= cutoffStr) {
      events.push({
        date: dateStr,
        type: "fomc",
        label: "FOMC Decision",
        daysAway: daysAway(dateStr, today),
        importance: "high",
      });
    }
  }

  // CPI dates
  for (const dateStr of CPI_DATES) {
    if (dateStr >= todayStr && dateStr <= cutoffStr) {
      events.push({
        date: dateStr,
        type: "cpi",
        label: "CPI Release",
        daysAway: daysAway(dateStr, today),
        importance: "medium",
      });
    }
  }

  // Deduplicate dates (FOMC can land on OPEX, etc.) — keep highest importance
  const deduped = new Map<string, VolEvent>();
  const importanceOrder: Record<Importance, number> = { high: 3, medium: 2, low: 1 };
  for (const ev of events) {
    const key = `${ev.date}-${ev.type}`;
    const existing = deduped.get(key);
    if (!existing || importanceOrder[ev.importance] > importanceOrder[existing.importance]) {
      deduped.set(key, ev);
    }
  }

  // Sort ascending by date
  const sorted = Array.from(deduped.values()).sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return importanceOrder[b.importance] - importanceOrder[a.importance];
  });

  return {
    events: sorted,
    asOf: new Date().toISOString(),
    warnings: warnings.length > 0 ? warnings : undefined,
    bounds: {
      lastFomc,
      lastCpi,
      fomcStale,
      cpiStale,
    },
  };
}
