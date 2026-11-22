// shared/playbookEvents.ts
//
// The calendar events that fall on one New York date, in the shape the daily playbook reads. Pure.
// A calendar event carries its time as epoch seconds (`when`), a `title` and a `whenLabel`. The playbook
// route used to filter on a `date` field the events do not have, so its list was always empty.

import { etDate } from "./exchangeCalendar";

export interface PlaybookEvent { kind: string; label: string; timeLabel?: string }

/** The scheduled releases the playbook's reaction wording was written for. An expiry, an auction or an
 *  earnings date is not a "print" with a hot or cool side, so those kinds are left to the calendar. */
export const PLAYBOOK_KINDS: readonly string[] = ["ECON", "FED"];
/** Most events shown: the card draws two boxes per event. */
export const PLAYBOOK_EVENTS_MAX = 4;
const RANK: Record<string, number> = { HIGH: 0, MED: 1, LOW: 2 };

export function eventsOnEtDate(
  calendar: ReadonlyArray<{ kind?: unknown; title?: unknown; when?: unknown; whenLabel?: unknown; importance?: unknown }> | null | undefined,
  dayIso: string,
): PlaybookEvent[] {
  const hits: Array<{ ev: PlaybookEvent; rank: number; when: number }> = [];
  for (const e of calendar ?? []) {
    if (typeof e?.when !== "number" || !Number.isFinite(e.when)) continue;
    if (etDate(e.when * 1000) !== dayIso) continue;
    const kind = String(e.kind ?? "");
    if (!PLAYBOOK_KINDS.includes(kind)) continue;
    hits.push({
      ev: { kind, label: typeof e.title === "string" ? e.title : "", timeLabel: typeof e.whenLabel === "string" ? e.whenLabel : "" },
      rank: RANK[String(e.importance)] ?? 3, when: e.when,
    });
  }
  // Most important first, then by time; the cut keeps the most important.
  hits.sort((a, b) => a.rank - b.rank || a.when - b.when);
  return hits.slice(0, PLAYBOOK_EVENTS_MAX).map((h) => h.ev);
}
