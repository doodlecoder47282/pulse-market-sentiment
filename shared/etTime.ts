// Clock times the normal way, in New York time: "4:54 PM", never "16:54".
// One formatter for the server (chart labels) and the screens.

const HM = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true });
const HMS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });

/** Epoch milliseconds to "4:54 PM" (or "4:54:10 PM" with seconds). Empty string for a missing or bad time. */
export function etTime(at: number | string | null | undefined, opts?: { seconds?: boolean }): string {
  // A stored time can arrive as epoch milliseconds or as an ISO string.
  const ms = typeof at === "string" ? Date.parse(at) : at;
  if (ms == null || !Number.isFinite(ms)) return "";
  // Some runtimes put a narrow no-break space before AM/PM; a plain space keeps the text searchable.
  return (opts?.seconds ? HMS : HM).format(new Date(ms)).replace(/[  ]/g, " ");
}

/** The same with the zone named: "4:54 PM ET". */
export function etTimeLabel(ms: number | string | null | undefined, opts?: { seconds?: boolean }): string {
  const t = etTime(ms, opts);
  return t ? `${t} ET` : "";
}

/** A stored wall-clock time "08:30" or "14:00" (New York) the normal way: "8:30 AM", "2:00 PM". Anything else is returned as given. */
export function clock12(hhmm: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return String(hhmm ?? "");
  const h = Number(m[1]) % 24;
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

const MD = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
/** "Nov 24, 4:54 PM ET": for a read that may be from an earlier day. */
export function etDayTimeLabel(at: number | string | null | undefined): string {
  const t = etTime(at);
  return t && at != null ? `${MD.format(new Date(typeof at === "string" ? Date.parse(at) : at))}, ${t} ET` : "";
}
