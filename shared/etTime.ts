// Clock times the normal way, in New York time: "4:54 PM", never "16:54".
// One formatter for the server (chart labels) and the screens.

const HM = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true });
const HMS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });

/** Epoch milliseconds to "4:54 PM" (or "4:54:10 PM" with seconds). Empty string for a missing or bad time. */
export function etTime(ms: number | null | undefined, opts?: { seconds?: boolean }): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  // Some runtimes put a narrow no-break space before AM/PM; a plain space keeps the text searchable.
  return (opts?.seconds ? HMS : HM).format(new Date(ms)).replace(/[  ]/g, " ");
}

/** The same with the zone named: "4:54 PM ET". */
export function etTimeLabel(ms: number | null | undefined, opts?: { seconds?: boolean }): string {
  const t = etTime(ms, opts);
  return t ? `${t} ET` : "";
}
