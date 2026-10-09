// econWeek.ts
// ────────────────────────────────────────────────────────────────────────────
// Weekly econ event feed for the Models chart's top "event band".
//
// Strategy: combine sources, in priority order (tiers: server/sources/registry.ts)
//   0) Official release calendars (primary): BLS and BEA iCalendar
//      subscriptions -> CPI, Employment Situation, PPI, JOLTS, ECI, GDP,
//      Personal Income and Outlays (PCE), Trade, at the exact release time.
//   1) Nasdaq economic-events API (undocumented, labeled unofficial; cached
//      30 min) — releases the official calendars do not carry (ISM, claims,
//      retail sales, sentiment). A Nasdaq row of a family the official
//      calendar has on the same day is dropped.
//   2) Synthetic US macro pattern — ESTIMATES by cadence rule, labeled
//      "estimate" in every chip. A synthetic CPI/NFP (BLS) or PCE/GDP (BEA)
//      chip is dropped whenever that official calendar was read, because the
//      official schedule then says whether the release is this week.
//      Patterns:
//         · Jobless Claims        — every Thursday  8:30 ET
//         · ISM Mfg PMI           — first business day  10:00 ET
//         · ISM Services PMI      — third business day  10:00 ET
//         · ADP Employment        — first Wednesday 8:15 ET
//         · NFP                   — first Friday    8:30 ET
//         · CPI / PPI             — mid-month (varies; placeholder ~10th–15th)
//         · PCE                   — last business day of month 8:30 ET
//         · GDP advance/2nd/3rd   — last week of month-after-quarter 8:30 ET
//         · Retail Sales          — mid-month 8:30 ET (placeholder ~15th)
//         · FOMC (curated 2026)   — exact dates pinned from FOMC schedule
//   3) Earnings — Nasdaq earnings calendar filtered to MAG7 + a configurable
//      "majors" watch list, mapped to the requested week.
//
// Output: a 5-element [Mon..Fri] array of EconDayEvents, each with a pre-sorted
// list of titled chips ready to render directly above the model chart.
//
// All times are stored as epoch seconds + a pre-formatted ET label.
// ────────────────────────────────────────────────────────────────────────────

import { readBlsCalendar, readBeaCalendar, readNasdaqEcon } from "./sources/official";
import { classifyRelease, familyOfEventName, type IcsEvent } from "./sources/parse";

const UA = "Mozilla/5.0 (compatible; Batcave/1.0)";

export type EconKind =
  | "FOMC"
  | "ECON"
  | "EARN"
  | "OPEX"
  | "WITCH"
  | "VIX_EXP"
  | "TREASURY"
  | "OTHER";

export interface EconChip {
  id: string;
  kind: EconKind;
  /** Short human label, e.g. "FOMC 2pm", "PCE 8:30am", "MSFT AC". */
  title: string;
  /** Long form for tooltip/legend, e.g. "FOMC Rate Decision · 2:00 PM ET". */
  longTitle: string;
  /** Importance tier from upstream (drives color + sort priority). */
  importance: "HIGH" | "MED" | "LOW";
  /** Epoch seconds (UTC). */
  when: number;
  /** "8:30 AM ET" formatted for chip subtitle. */
  timeLabel: string;
  /** Optional ticker for earnings. */
  ticker?: string;
  /** Optional short note (e.g. "Day 1", "BMO" before market open). */
  note?: string;
  /** Source label and tier, e.g. "BLS" / "primary", "cadence rule" / "weak". */
  source?: string;
  tier?: "primary" | "computed" | "weak";
  /** true for cadence-rule placeholders: the date is a guess, not a schedule. */
  estimated?: boolean;
  /** release family join key (CPI, NFP, GDP, PCE, ...) */
  family?: string | null;
}

export interface EconDay {
  /** "MON 4/27" — matches model waypoint label exactly. */
  label: string;
  /** ISO YYYY-MM-DD (UTC) for join keys. */
  iso: string;
  /** Sorted by importance desc, then time asc. */
  events: EconChip[];
}

export interface EconWeek {
  weekOfMon: string;       // ISO date of the Monday of the week
  weekLabel: string;       // "APR 27 - MAY 1, 2026"
  asOf: number;            // epoch seconds
  days: EconDay[];         // length 5 (Mon..Fri)
  source: string;          // diagnostic
  /** per-source state for this week */
  sources?: Array<{ name: string; tier: string; state: "ok" | "stale" | "failed" | "partial"; note?: string }>;
}

// ---------------------------------------------------------------------------
// Public entry: build the week starting on `mondayIso` (YYYY-MM-DD UTC).
// If `mondayIso` is not provided, picks the upcoming Monday from "now".
// ---------------------------------------------------------------------------
export async function buildEconWeek(mondayIso?: string): Promise<EconWeek> {
  const monday = mondayIso ? new Date(`${mondayIso}T00:00:00Z`) : nextMonday(new Date());
  const days: Date[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    days.push(d);
  }
  const friday = days[4];
  const weekLabel = formatWeekLabel(monday, friday);

  // Fan out sources in parallel
  const failed = (e: any) => ({ state: "failed" as const, value: null, fetchedAtMs: null, error: String(e?.message ?? e).slice(0, 100) });
  const [bls, bea, nasdaq, earningsRes] = await Promise.all([
    readBlsCalendar().catch(failed),
    readBeaCalendar().catch(failed),
    readNasdaqEcon(days.map(isoDay)).catch(failed),
    fetchMag7Earnings(days).then((v) => ({ ok: true, v }), () => ({ ok: false, v: [] as EconChip[] })),
  ]);
  const earningsEvents = earningsRes.v;
  const fromMs = days[0].getTime();
  const toMs = days[4].getTime() + 2 * 86400_000;
  const official = [
    ...(bls.value ? officialChips("BLS", bls.value, fromMs, toMs) : []),
    ...(bea.value ? officialChips("BEA", bea.value, fromMs, toMs) : []),
  ];
  const coveredFamilies = new Set<string>([
    ...(bls.value ? ["CPI", "NFP", "PPI", "JOLTS", "ECI"] : []),
    ...(bea.value ? ["GDP", "PCE", "TRADE"] : []),
  ]);
  const nasdaqEvents = nasdaq.value ? nasdaqChips(nasdaq.value.rows) : [];

  // Synthetic macro pattern (never fails — pure date math), estimates only
  const synthetic = buildSyntheticMacro(days).map((c) => ({ ...c, ...syntheticLabel(c) }));

  // Curated FOMC schedule (exact dates)
  const fomc = buildFomcSchedule(days).map((c) => ({
    ...c, source: "Federal Reserve schedule (hardcoded copy)", tier: "computed" as const,
    longTitle: `${c.longTitle} · Federal Reserve schedule`,
  }));

  // Official first; Nasdaq and estimates of an officially covered family drop.
  const econ = mergeOfficialWeek(official, nasdaqEvents, synthetic, coveredFamilies);

  const st = (r: { state: string; value: unknown }): "ok" | "stale" | "failed" =>
    r.value == null ? "failed" : r.state === "stale" ? "stale" : "ok";
  const sources: NonNullable<EconWeek["sources"]> = [
    { name: "BLS", tier: "primary", state: st(bls) },
    { name: "BEA", tier: "primary", state: st(bea) },
    { name: "Nasdaq (unofficial API)", tier: "weak", state: nasdaq.value ? (nasdaq.value.failedDays ? "partial" : st(nasdaq)) : "failed" },
    { name: "Cadence rule (estimate)", tier: "weak", state: "ok", note: "placeholders only for releases no official calendar covered" },
    { name: "Nasdaq earnings (unofficial API)", tier: "weak", state: earningsRes.ok ? "ok" : "failed" },
  ];

  // Merge with dedupe (official/Nasdaq/estimates → FOMC → earnings)
  const seen = new Set<string>();
  const merged: EconChip[] = [];
  for (const list of [econ, fomc, earningsEvents]) {
    for (const ev of list) {
      const key = `${ev.kind}|${isoDay(new Date(ev.when * 1000))}|${normalizeTitle(ev.title)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(ev);
    }
  }

  // Bucket by day
  const byDay = new Map<string, EconChip[]>();
  for (const d of days) byDay.set(isoDay(d), []);
  for (const ev of merged) {
    const key = isoDay(new Date(ev.when * 1000));
    if (!byDay.has(key)) continue;
    byDay.get(key)!.push(ev);
  }

  // Sort each day: importance HIGH→MED→LOW, then earlier time first.
  const impRank = { HIGH: 0, MED: 1, LOW: 2 } as const;
  for (const list of byDay.values()) {
    list.sort((a, b) => impRank[a.importance] - impRank[b.importance] || a.when - b.when);
  }

  const result: EconDay[] = days.map((d) => ({
    label: dayLabel(d),
    iso: isoDay(d),
    events: byDay.get(isoDay(d)) ?? [],
  }));

  return {
    weekOfMon: isoDay(monday),
    weekLabel,
    asOf: Math.floor(Date.now() / 1000),
    days: result,
    source: `official:${official.length} nasdaq:${nasdaqEvents.length} estimates:${econ.filter((c) => c.estimated).length} fomc:${fomc.length} earnings:${earningsEvents.length}`,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Source 0: official BLS / BEA release calendars (exact times)
// ---------------------------------------------------------------------------
const CHIP_NAME: Record<string, string> = { CPI: "CPI", NFP: "NFP", PPI: "PPI", JOLTS: "JOLTS", ECI: "ECI", GDP: "GDP", PCE: "PCE", TRADE: "Trade", REAL_EARNINGS: "Real Earn", IMPORT_PRICES: "Import Px", PRODUCTIVITY: "Productivity" };

/** "8:30am" style chip time in Eastern. */
function chipTime(whenSec: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(whenSec * 1000)).replace(/\s?(AM|PM)$/, (m) => m.trim().toLowerCase());
}

/** Pure: official ICS events -> chips for the major release families only. */
export function officialChips(agency: "BLS" | "BEA", events: IcsEvent[], fromMs: number, toMs: number): EconChip[] {
  const out: EconChip[] = [];
  for (const e of events) {
    if (e.startMs < fromMs || e.startMs >= toMs) continue;
    const cls = classifyRelease(e.summary);
    if (!cls.family) continue; // band shows market-moving releases only
    const when = Math.floor(e.startMs / 1000);
    const t = e.timed ? formatTimeLabel(when) : "time TBA";
    out.push({
      id: `${agency.toLowerCase()}:${e.uid}`,
      kind: "ECON",
      title: `${CHIP_NAME[cls.family] ?? cls.family} ${e.timed ? chipTime(when) : "TBA"}`,
      longTitle: `${e.summary} · ${t} · ${agency} (official)`,
      importance: cls.importance,
      when,
      timeLabel: t,
      source: agency,
      tier: "primary",
      family: cls.family,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source 1: Nasdaq economic-events API (undocumented; labeled unofficial)
// ---------------------------------------------------------------------------
/** Pure: Nasdaq rows -> chips. A non-clock time ("All Day") is not guessed. */
export function nasdaqChips(rows: Array<{ date: string; time: string; eventName: string; country: string; impact: number }>): EconChip[] {
  const out: EconChip[] = [];
  for (const row of rows) {
    if (row.country && !/US|United States/i.test(row.country)) continue;
    if (!row.eventName) continue;
    const tm = /^(\d{1,2}):(\d{2})$/.exec(row.time.trim());
    const t = tm ? `${tm[1].padStart(2, "0")}:${tm[2]}` : null;
    const when = isoToEpoch(`${row.date}T${t ?? "00:00"}:00`, "America/New_York");
    if (!Number.isFinite(when)) continue;
    const importance: EconChip["importance"] = row.impact >= 3 ? "HIGH" : row.impact >= 2 ? "MED" : "LOW";
    const label = t ? formatTimeLabel(when) : "time TBA";
    out.push({
      id: `nasdaq:${row.date}:${row.eventName}`,
      kind: "ECON",
      title: shortenEventTitle(row.eventName, t ?? "TBA"),
      longTitle: `${row.eventName} · ${label} · Nasdaq (unofficial)`,
      importance,
      when,
      timeLabel: label,
      source: "Nasdaq (unofficial API)",
      tier: "weak",
      family: familyOfEventName(row.eventName),
    });
  }
  return out;
}

const SYNTHETIC_FAMILY: Record<string, string> = { nfp: "NFP", cpi: "CPI", pce: "PCE", gdp: "GDP" };

function syntheticLabel(c: EconChip): Partial<EconChip> {
  const fam = SYNTHETIC_FAMILY[c.id.split(":")[1] ?? ""] ?? null;
  return {
    source: "Cadence rule (estimate)",
    tier: "weak",
    estimated: true,
    family: fam,
    note: c.note ? `estimate · ${c.note}` : "estimate (cadence rule, not a published schedule)",
    longTitle: `${c.longTitle} · ESTIMATE (cadence rule)`,
  };
}

/**
 * Pure merge for the week band: official chips first; a Nasdaq chip of a
 * family the official calendar lists on the same ET day is dropped; an
 * estimated chip of a family an official calendar covers is dropped (when
 * the calendar was read, its schedule decides whether the release is this
 * week), and any estimate on a day that already has a real chip of the same
 * family is dropped.
 */
export function mergeOfficialWeek(official: EconChip[], nasdaq: EconChip[], synthetic: EconChip[], coveredFamilies: Set<string>): EconChip[] {
  const day = (c: EconChip) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(c.when * 1000));
  const offKeys = new Set(official.filter((c) => c.family).map((c) => `${c.family}|${day(c)}`));
  const keptNasdaq = nasdaq.filter((c) => !(c.family && offKeys.has(`${c.family}|${day(c)}`)));
  const realKeys = new Set([...official, ...keptNasdaq].filter((c) => c.family).map((c) => `${c.family}|${day(c)}`));
  const keptSyn = synthetic.filter((c) => {
    if (c.family && coveredFamilies.has(c.family)) return false;
    if (c.family && realKeys.has(`${c.family}|${day(c)}`)) return false;
    return true;
  });
  return [...official, ...keptNasdaq, ...keptSyn];
}

// ---------------------------------------------------------------------------
// Source 2: synthetic US macro cadence
// ---------------------------------------------------------------------------
function buildSyntheticMacro(days: Date[]): EconChip[] {
  const out: EconChip[] = [];
  for (const d of days) {
    const dow = d.getUTCDay(); // 0..6
    const dom = d.getUTCDate();

    // Thursday 8:30 ET — Initial Jobless Claims (every week)
    if (dow === 4) {
      const when = makeEtEpoch(d, 8, 30);
      out.push({
        id: `syn:jobless:${isoDay(d)}`,
        kind: "ECON",
        title: "Jobless Claims 8:30am",
        longTitle: "Initial Jobless Claims · 8:30 AM ET",
        importance: "MED",
        when,
        timeLabel: formatTimeLabel(when),
      });
    }

    // Friday 8:30 ET if it's the FIRST Friday of the month → NFP
    if (dow === 5 && dom <= 7) {
      const when = makeEtEpoch(d, 8, 30);
      out.push({
        id: `syn:nfp:${isoDay(d)}`,
        kind: "ECON",
        title: "NFP 8:30am",
        longTitle: "Nonfarm Payrolls / Unemployment · 8:30 AM ET",
        importance: "HIGH",
        when,
        timeLabel: formatTimeLabel(when),
      });
    }

    // Wednesday 8:15 ET if it's the FIRST Wednesday → ADP
    if (dow === 3 && dom <= 7) {
      const when = makeEtEpoch(d, 8, 15);
      out.push({
        id: `syn:adp:${isoDay(d)}`,
        kind: "ECON",
        title: "ADP 8:15am",
        longTitle: "ADP Private Employment · 8:15 AM ET",
        importance: "MED",
        when,
        timeLabel: formatTimeLabel(when),
      });
    }

    // ISM Mfg PMI — first business day of month at 10:00 ET
    if (isFirstBusinessDay(d)) {
      const when = makeEtEpoch(d, 10, 0);
      out.push({
        id: `syn:ism-mfg:${isoDay(d)}`,
        kind: "ECON",
        title: "ISM Mfg 10am",
        longTitle: "ISM Manufacturing PMI · 10:00 AM ET",
        importance: "MED",
        when,
        timeLabel: formatTimeLabel(when),
      });
    }

    // ISM Services — third business day at 10:00 ET
    if (isNthBusinessDay(d, 3)) {
      const when = makeEtEpoch(d, 10, 0);
      out.push({
        id: `syn:ism-svc:${isoDay(d)}`,
        kind: "ECON",
        title: "ISM Svc 10am",
        longTitle: "ISM Services PMI · 10:00 AM ET",
        importance: "MED",
        when,
        timeLabel: formatTimeLabel(when),
      });
    }

    // CPI placeholder: 10th–14th of month, weekday only
    if (dom >= 10 && dom <= 14 && dow >= 1 && dow <= 5) {
      // Only emit on a Tuesday or Wednesday (most common BLS slot)
      if (dow === 2 || dow === 3) {
        const when = makeEtEpoch(d, 8, 30);
        out.push({
          id: `syn:cpi:${isoDay(d)}`,
          kind: "ECON",
          title: "CPI 8:30am",
          longTitle: "Consumer Price Index · 8:30 AM ET",
          importance: "HIGH",
          when,
          timeLabel: formatTimeLabel(when),
          note: "tentative — confirm via BLS",
        });
      }
    }

    // PCE: last business day of the month at 8:30 ET
    if (isLastBusinessDay(d)) {
      const when = makeEtEpoch(d, 8, 30);
      out.push({
        id: `syn:pce:${isoDay(d)}`,
        kind: "ECON",
        title: "Core PCE 8:30am",
        longTitle: "Core PCE Price Index · 8:30 AM ET",
        importance: "HIGH",
        when,
        timeLabel: formatTimeLabel(when),
        note: "tentative — confirm via BEA",
      });
    }

    // GDP advance: last Thursday of month-after-quarter (Apr/Jul/Oct/Jan)
    if (
      dow === 4 &&
      isLastNthWeekday(d, 4, 1) &&
      [0, 3, 6, 9].includes(d.getUTCMonth())
    ) {
      const when = makeEtEpoch(d, 8, 30);
      out.push({
        id: `syn:gdp:${isoDay(d)}`,
        kind: "ECON",
        title: "GDP 8:30am",
        longTitle: "GDP (advance/second/third) · 8:30 AM ET",
        importance: "HIGH",
        when,
        timeLabel: formatTimeLabel(when),
      });
    }

    // Retail Sales: ~15th-ish, weekday, 8:30 ET
    if (dom >= 14 && dom <= 17 && dow >= 1 && dow <= 5) {
      // pick first weekday in window
      if (isFirstWeekdayInDomRange(d, 14, 17)) {
        const when = makeEtEpoch(d, 8, 30);
        out.push({
          id: `syn:retail:${isoDay(d)}`,
          kind: "ECON",
          title: "Retail Sales 8:30am",
          longTitle: "Advance Retail Sales · 8:30 AM ET",
          importance: "MED",
          when,
          timeLabel: formatTimeLabel(when),
          note: "tentative",
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source 3: FOMC schedule (curated; refresh annually)
// ---------------------------------------------------------------------------
const FOMC_2026: string[] = [
  // Decision days per federalreserve.gov FOMC calendar (verified Sep 2026).
  // Old list had 11-04 and 12-16, which are not FOMC dates.
  "2026-01-28",
  "2026-03-18",
  "2026-04-29",
  "2026-06-17",
  "2026-07-29",
  "2026-09-16",
  "2026-10-28",
  "2026-12-09",
];

function buildFomcSchedule(days: Date[]): EconChip[] {
  const isoSet = new Set(days.map(isoDay));
  const out: EconChip[] = [];
  for (const fomcIso of FOMC_2026) {
    if (!isoSet.has(fomcIso)) continue;
    const d = new Date(`${fomcIso}T00:00:00Z`);
    // Day 2 (release day) — 2pm rate decision + 2:30pm presser
    const decision = makeEtEpoch(d, 14, 0);
    out.push({
      id: `fomc:decision:${fomcIso}`,
      kind: "FOMC",
      title: "FOMC 2pm",
      longTitle: "FOMC Rate Decision · 2:00 PM ET (presser 2:30 PM)",
      importance: "HIGH",
      when: decision,
      timeLabel: formatTimeLabel(decision),
      note: "Powell presser 2:30pm",
    });
    // Day 1 (start) — flag the day before
    const day1 = new Date(d);
    day1.setUTCDate(d.getUTCDate() - 1);
    if (isoSet.has(isoDay(day1))) {
      const when = makeEtEpoch(day1, 9, 30);
      out.push({
        id: `fomc:day1:${isoDay(day1)}`,
        kind: "FOMC",
        title: "FOMC Day 1",
        longTitle: "FOMC Meeting begins (no statement)",
        importance: "MED",
        when,
        timeLabel: "all day",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source 4: MAG7 + select majors earnings (Nasdaq earnings API)
// ---------------------------------------------------------------------------
const EARNINGS_WATCHLIST = new Set([
  "AAPL","MSFT","GOOGL","GOOG","AMZN","META","NVDA","TSLA",
  // Also commonly market-moving
  "JPM","XOM","BAC","V","MA","UNH","NFLX","AMD","AVGO","COST","WMT",
]);

async function fetchMag7Earnings(days: Date[]): Promise<EconChip[]> {
  const out: EconChip[] = [];
  let failedDays = 0;
  await Promise.all(
    days.map(async (d) => {
      const date = isoDay(d);
      const url = `https://api.nasdaq.com/api/calendar/earnings?date=${date}`;
      // 4s timeout to keep the feed responsive even when Nasdaq is slow.
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: ctrl.signal,
      }).catch(() => null);
      clearTimeout(to);
      if (!r || !r.ok) { failedDays++; return; }
      const j: any = await r.json().catch(() => null);
      if (!j) { failedDays++; return; }
      const rows: any[] = j?.data?.rows ?? [];
      for (const row of rows) {
        const sym = String(row.symbol ?? "").toUpperCase();
        if (!EARNINGS_WATCHLIST.has(sym)) continue;
        const beforeAfter = String(row.time ?? "").toLowerCase(); // "time-pre-market" / "time-after-hours" / "time-not-supplied"
        const isAC = beforeAfter.includes("after");
        const isBMO = beforeAfter.includes("pre");
        const tag = isAC ? "AC" : isBMO ? "BMO" : "TBD";
        const hour = isAC ? 16 : isBMO ? 7 : 12;
        const min = isAC ? 30 : isBMO ? 0 : 0;
        const when = makeEtEpoch(d, hour, min);
        out.push({
          id: `earn:${sym}:${date}`,
          kind: "EARN",
          title: `${sym} ${tag}`,
          longTitle: `${sym} Earnings · ${tag === "AC" ? "After Close" : tag === "BMO" ? "Before Open" : "TBD"} · Nasdaq (unofficial)`,
          importance: ["AAPL","MSFT","GOOGL","GOOG","AMZN","META","NVDA","TSLA"].includes(sym) ? "HIGH" : "MED",
          when,
          timeLabel: tag,
          ticker: sym,
          note: tag,
          source: "Nasdaq earnings (unofficial API)",
          tier: "weak",
        });
      }
    }),
  );
  // Every day failed: a failed source, not a week with no earnings.
  if (failedDays === days.length) throw new Error("every Nasdaq earnings day failed");
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayLabel(d: Date): string {
  const days = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
  return `${days[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function formatWeekLabel(mon: Date, fri: Date): string {
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const mMo = months[mon.getUTCMonth()];
  const fMo = months[fri.getUTCMonth()];
  if (mon.getUTCMonth() === fri.getUTCMonth()) {
    return `${mMo} ${mon.getUTCDate()} - ${fri.getUTCDate()}, ${fri.getUTCFullYear()}`;
  }
  return `${mMo} ${mon.getUTCDate()} - ${fMo} ${fri.getUTCDate()}, ${fri.getUTCFullYear()}`;
}

function nextMonday(from: Date): Date {
  // Monday of the CURRENT trading week. The old `8 - dow` jumped to NEXT
  // week's Monday on Tue-Sat, so without an explicit `from` the econ strip
  // showed next week and the client's day-label matching found nothing —
  // econ chips were silently empty four days out of five.
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const dow = d.getUTCDay();
  if (dow === 1) return d;
  const offset = dow === 0 ? 1 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

// Build epoch seconds for an Eastern Time wall-clock (handles EDT/EST).
function makeEtEpoch(d: Date, hour: number, minute: number): number {
  // Approximate: ET = UTC-4 from 2nd Sun of Mar to 1st Sun of Nov (EDT), else UTC-5.
  const isEdt = isUsEasternDaylight(d);
  const offsetHours = isEdt ? 4 : 5;
  const utcHour = hour + offsetHours;
  // Handle day rollover if utcHour >= 24
  let dayShift = 0;
  let h = utcHour;
  if (h >= 24) { dayShift = Math.floor(h / 24); h = h % 24; }
  const dd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dayShift, h, minute, 0));
  return Math.floor(dd.getTime() / 1000);
}

function isUsEasternDaylight(d: Date): boolean {
  // 2nd Sunday of March → 1st Sunday of November
  const y = d.getUTCFullYear();
  const startMar = nthWeekdayOfMonth(y, 2 /* Mar */, 0 /* Sun */, 2);
  const endNov = nthWeekdayOfMonth(y, 10 /* Nov */, 0 /* Sun */, 1);
  return d.getTime() >= startMar.getTime() && d.getTime() < endNov.getTime();
}

function nthWeekdayOfMonth(year: number, monthIdx: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, monthIdx, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, monthIdx, 1 + offset + (n - 1) * 7, 7, 0, 0));
}

function isoToEpoch(localIso: string, _tz: string): number {
  // localIso is "YYYY-MM-DDTHH:MM:00" assumed to be in America/New_York
  const m = localIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  const [, y, mo, da, h, mi, s] = m;
  const d = new Date(Date.UTC(+y, +mo - 1, +da));
  return makeEtEpoch(d, +h, +mi) + +s;
}

function formatTimeLabel(whenSec: number): string {
  const d = new Date(whenSec * 1000);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${fmt.format(d).toLowerCase().replace(/\s/g, "")} et`;
}

function shortenEventTitle(name: string, time: string): string {
  // Compress canonical names to chip-friendly labels
  const lower = name.toLowerCase();
  const t = time.replace(/^0/, "");
  if (lower.includes("nonfarm")) return `NFP ${t}`;
  if (lower.includes("jobless")) return `Jobless ${t}`;
  if (lower.includes("cpi")) return `CPI ${t}`;
  if (lower.includes("ppi")) return `PPI ${t}`;
  if (lower.includes("pce")) return `PCE ${t}`;
  if (lower.includes("ism") && lower.includes("manuf")) return `ISM Mfg ${t}`;
  if (lower.includes("ism") && lower.includes("serv")) return `ISM Svc ${t}`;
  if (lower.includes("retail sales")) return `Retail ${t}`;
  if (lower.includes("gdp")) return `GDP ${t}`;
  if (lower.includes("adp")) return `ADP ${t}`;
  if (lower.includes("durable")) return `Durables ${t}`;
  if (lower.includes("housing starts")) return `Housing ${t}`;
  if (lower.includes("consumer confidence")) return `Conf ${t}`;
  if (lower.includes("consumer sentiment") || lower.includes("michigan")) return `UoM ${t}`;
  if (lower.includes("fomc") && lower.includes("rate")) return `FOMC ${t}`;
  if (lower.includes("powell") || lower.includes("fed chair")) return `Powell ${t}`;
  // Default: first 12 chars + time
  const shortName = name.length > 14 ? name.slice(0, 12).replace(/[\s.,()\-]+$/, "") : name;
  return `${shortName} ${t}`;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function isFirstBusinessDay(d: Date): boolean {
  const dom = d.getUTCDate();
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (dom <= 3 && (dow >= 1 && dow <= 5)) {
    // Confirm previous days were weekend
    for (let i = 1; i <= dom - 1; i++) {
      const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), i));
      const pdow = prev.getUTCDay();
      if (pdow !== 0 && pdow !== 6) return false;
    }
    return true;
  }
  return false;
}

function isNthBusinessDay(d: Date, n: number): boolean {
  let count = 0;
  for (let i = 1; i <= d.getUTCDate(); i++) {
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), i));
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
    if (i === d.getUTCDate()) return count === n;
  }
  return false;
}

function isLastBusinessDay(d: Date): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  // Check if all subsequent days in this month are weekends
  const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  for (let i = d.getUTCDate() + 1; i <= monthEnd.getUTCDate(); i++) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), i));
    const ndow = next.getUTCDay();
    if (ndow !== 0 && ndow !== 6) return false;
  }
  return true;
}

function isLastNthWeekday(d: Date, weekday: number, n: number): boolean {
  // Returns true if d is the n-th-from-last `weekday` (e.g. last Thursday) of its month
  if (d.getUTCDay() !== weekday) return false;
  let count = 0;
  for (let i = d.getUTCDate(); i >= 1; i--) {
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), i));
    if (day.getUTCDay() === weekday) {
      count += 1;
      if (i === d.getUTCDate()) return count === n;
    }
  }
  return false;
}

function isFirstWeekdayInDomRange(d: Date, lo: number, hi: number): boolean {
  const dom = d.getUTCDate();
  if (dom < lo || dom > hi) return false;
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  for (let i = lo; i < dom; i++) {
    const test = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), i));
    const tdow = test.getUTCDay();
    if (tdow !== 0 && tdow !== 6) return false;
  }
  return true;
}
