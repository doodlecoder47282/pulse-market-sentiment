// shared/odteFreshness.ts
// Is a 0DTE forward read still the current one? A browser tab left in the background stops polling, and a
// phone that slept wakes with whatever it last held: the read on screen can then be hours or a day old while
// its heading says "today" and its countdown still counts. This decides, from the read's own time and expiry
// against the clock, whether it may be shown as current. Pure: no I/O.
import { etDate } from "./exchangeCalendar";

/** The panel polls every 60 s; a read older than this has missed five polls in a row. */
export const FORWARD_MAX_AGE_MS = 5 * 60_000;

export type ForwardFreshness =
  | { state: "current"; ageMs: number }
  | { state: "out_of_date"; ageMs: number | null; reason: string };

export interface ForwardStamp {
  /** ISO time the server computed the read. */
  asOf?: string | null;
  /** Expiry date of the chain it was computed from (YYYY-MM-DD). */
  expiry?: string | null;
  horizon?: "rest_of_today" | "next_session" | null;
}

const etClockText = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

export function ageText(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

export function forwardFreshness(stamp: ForwardStamp | null | undefined, nowMs: number): ForwardFreshness {
  const at = stamp?.asOf ? Date.parse(stamp.asOf) : NaN;
  if (!Number.isFinite(at)) return { state: "out_of_date", ageMs: null, reason: "the read carries no time, so its age is not known" };
  const ageMs = Math.max(0, nowMs - at);
  const today = etDate(nowMs);
  const readDay = etDate(at);
  if (ageMs > FORWARD_MAX_AGE_MS) {
    const when = readDay === today ? `${etClockText(at)} ET` : `${etClockText(at)} ET on ${readDay}`;
    return { state: "out_of_date", ageMs, reason: `the last read is from ${when}, ${ageText(ageMs)} ago` };
  }
  const exp = stamp?.expiry ?? null;
  if (exp && /^\d{4}-\d{2}-\d{2}$/.test(exp)) {
    if (exp < today) return { state: "out_of_date", ageMs, reason: `its chain expired ${exp}, before today (${today})` };
    if (stamp?.horizon === "rest_of_today" && exp !== today) return { state: "out_of_date", ageMs, reason: `its chain expires ${exp}, not today (${today})` };
  }
  return { state: "current", ageMs };
}
