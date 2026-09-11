// server/etTime.ts
//
// DST-aware Eastern Time helpers. Several modules previously hardcoded
// "-05:00" (EST) when building ET timestamps, which shifted every session
// window by one hour during daylight time (March-November): "9:30 ET"
// filters actually started at 10:30 ET, dropping the first hour of bars.

/**
 * Epoch milliseconds for a given ET wall-clock time on a given date.
 * DST-aware: tries both UTC offsets and keeps the one that round-trips
 * to the requested wall time in America/New_York.
 */
export function etEpochMs(dateStr: string, hh: number, mm: number, ss = 0): number {
  const t = (off: string) =>
    Date.parse(
      `${dateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}${off}`,
    );
  for (const off of ["-04:00", "-05:00"]) {
    const ms = t(off);
    if (isNaN(ms)) continue;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ms));
    const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "-1", 10) % 24;
    const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "-1", 10);
    if (h === hh && m === mm) return ms;
  }
  return t("-05:00"); // unreachable in practice; safe fallback
}

/** Today's date in ET as YYYY-MM-DD. */
export function etToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
