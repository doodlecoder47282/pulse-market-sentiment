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

/** Plain names for the calendar's release families (the `family` join key set in server/sources). */
const FAMILY_LABEL: Record<string, string> = {
  CPI: "CPI", PPI: "PPI", NFP: "Jobs report (NFP)", PCE: "PCE", GDP: "GDP", JOLTS: "JOLTS",
  ECI: "Employment Cost Index", TRADE: "Trade balance", IMPORT_PRICES: "Import and export prices",
  PRODUCTIVITY: "Productivity and costs", REAL_EARNINGS: "Real earnings",
};
/** Rows that are one rate decision. Minutes and speeches are other events and keep their own titles. */
const FOMC_DECISION = /fed(eral reserve)? interest rate decision|\bfomc (rate |interest rate )?(decision|statement|press conference|economic projections)\b|federal funds (target )?rate/i;

/**
 * One release reaches the calendar as several rows when the official read fails (CPI MoM, Core CPI MoM,
 * CPI YoY, a computed "CPI Release"). Rows that share the calendar's own family key on one day are one
 * line; the rows of one rate decision are one line; every other row is its own title.
 */
export function releaseGroup(title: string, family: unknown): { key: string; label: string } {
  if (typeof family === "string" && family) return { key: `family:${family}`, label: FAMILY_LABEL[family] ?? title };
  if (FOMC_DECISION.test(title)) return { key: "fomc-decision", label: "FOMC decision" };
  return { key: `title:${title.toLowerCase()}`, label: title };
}

/**
 * The HIGH-importance scheduled releases on one New York date, earliest first, one line per release.
 * Lower grades are left to the calendar: on an ordinary day they are weekly mortgage applications and the like.
 */
export function eventsOnEtDate(
  calendar: ReadonlyArray<{ kind?: unknown; title?: unknown; when?: unknown; whenLabel?: unknown; importance?: unknown; family?: unknown }> | null | undefined,
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
    const g = releaseGroup(title, e.family);
    hits.push({ ev: { kind, label: g.label, timeLabel: typeof e.whenLabel === "string" ? e.whenLabel : "" }, key: g.key, when: e.when });
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

/** The sources whose rows can be one of today's HIGH releases. Treasury auctions are another kind and never
 *  reach this list; rate decisions are computed and need no source. */
const RELEASE_SOURCES: Array<[string, string]> = [["bls_calendar", "BLS"], ["bea_calendar", "BEA"], ["nasdaq_econ", "Nasdaq"]];

/**
 * Says so when an empty releases list may be empty because a release calendar was not read. `sources` is the
 * news snapshot's per-source status; null means the news read itself failed. A source counts as not read when
 * it failed or is stale. A partly read Nasdaq calendar (one of its fourteen daily requests failed) does not:
 * which day failed is not reported, and the official calendars carry the major releases.
 */
export function releaseCalendarNote(sources: ReadonlyArray<{ id?: unknown; state?: unknown }> | null | undefined): string | null {
  const tail = "This is not a statement that nothing is scheduled.";
  if (!sources) return `Scheduled releases today: not known (the release calendar could not be read). ${tail}`;
  const bad = RELEASE_SOURCES.filter(([id]) => sources.some((s) => s.id === id && (s.state === "failed" || s.state === "stale"))).map(([, name]) => name);
  if (bad.length === 0) return null;
  return `Scheduled releases today: not known (the ${bad.length > 1 ? `${bad.slice(0, -1).join(", ")} and ${bad[bad.length - 1]}` : bad[0]} release calendar${bad.length === 1 ? " was" : "s were"} not read). ${tail}`;
}
