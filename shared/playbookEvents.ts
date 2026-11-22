// shared/playbookEvents.ts
//
// The calendar events that fall on one New York date, in the shape the daily playbook reads. Pure.
// A calendar event carries its time as epoch seconds (`when`), a `title` and a `whenLabel`. The playbook
// route used to filter on a `date` field the events do not have, so its list was always empty.

import { etDate } from "./exchangeCalendar";

export interface PlaybookEvent { kind: string; label: string; timeLabel?: string }

/** Kinds shown: scheduled data releases and Fed events. An expiry, an auction or an earnings date has its
 *  own place in the calendar. */
export const PLAYBOOK_KINDS: readonly string[] = ["ECON", "FED"];
/** Most releases listed. */
export const PLAYBOOK_EVENTS_MAX = 4;

/** One release reaches the calendar as several rows (CPI MoM, Core CPI MoM, CPI YoY, a computed "CPI
 *  Release"). Rows of one family on one day are one line on the card, under the family's plain name. */
const FAMILIES: Array<[RegExp, string]> = [
  [/\bfomc\b|fed(eral reserve)? (interest )?rate decision|federal funds/i, "FOMC"],
  [/\bcpi\b|consumer price/i, "CPI"],
  [/\bppi\b|producer price/i, "PPI"],
  [/\bpce\b|personal consumption expenditure/i, "PCE"],
  [/non-?farm|payroll|employment situation|\bnfp\b/i, "Payrolls"],
  [/jobless claims|initial claims/i, "Jobless claims"],
];
export function releaseFamily(title: string): string | null {
  for (const [re, name] of FAMILIES) if (re.test(title)) return name;
  return null;
}

/**
 * The HIGH-importance scheduled releases on one New York date, earliest first, one line per release.
 * Lower grades are left to the calendar: on an ordinary day they are weekly mortgage applications and the like.
 */
export function eventsOnEtDate(
  calendar: ReadonlyArray<{ kind?: unknown; title?: unknown; when?: unknown; whenLabel?: unknown; importance?: unknown }> | null | undefined,
  dayIso: string,
): PlaybookEvent[] {
  const hits: Array<{ ev: PlaybookEvent; key: string; when: number }> = [];
  for (const e of calendar ?? []) {
    if (typeof e?.when !== "number" || !Number.isFinite(e.when)) continue;
    if (etDate(e.when * 1000) !== dayIso) continue;
    const kind = String(e.kind ?? "");
    if (!PLAYBOOK_KINDS.includes(kind) || e.importance !== "HIGH") continue;
    const title = typeof e.title === "string" ? e.title.trim() : "";
    if (!title) continue;
    const fam = releaseFamily(title);
    hits.push({ ev: { kind, label: fam ?? title, timeLabel: typeof e.whenLabel === "string" ? e.whenLabel : "" }, key: (fam ?? title).toLowerCase(), when: e.when });
  }
  hits.sort((a, b) => a.when - b.when);
  const seen = new Set<string>();
  const out: PlaybookEvent[] = [];
  for (const h of hits) {
    if (seen.has(h.key)) continue;
    seen.add(h.key);
    out.push(h.ev);
    if (out.length === PLAYBOOK_EVENTS_MAX) break;
  }
  return out;
}
