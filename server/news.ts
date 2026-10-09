// server/news.ts
//
// News snapshot = headline flow + economic/earnings calendar + SEC filings.
// Context only: nothing here feeds a price, greeks, options or sizing input.
//
// Sources, by tier (full table with terms of use: server/sources/registry.ts):
//   Official primary (keyless, documented):
//     - Federal Reserve press releases + speeches RSS
//     - SEC press releases RSS, EDGAR latest 8-K Atom, data.sec.gov
//       submissions for the watchlist (needs BATCAVE_SEC_USER_AGENT)
//     - CFTC press releases RSS
//     - BLS and BEA release calendars (iCalendar) -> exact release times
//     - U.S. Treasury Fiscal Data upcoming_auctions -> announced auctions
//   Professional publishers (their own RSS): MarketWatch (Dow Jones), CNBC, FT
//   Aggregator, secondary: Google News search for Reuters stories
//   Unofficial, secondary: Nasdaq calendar JSON (consensus values, releases
//     not on the BLS/BEA calendars), Nasdaq earnings calendar
//   Computed: OPEX / VIX expiration / quarterly expirations (exchange rules)
//
// Every headline carries source, publisher, tier, published time (UTC) and
// fetched time; the response carries a per-source state (ok / empty / stale
// / failed / not_configured) so an outage never reads as a quiet tape.

import { etEpochMs } from "./etTime";
import { SOURCES, TIER_LABEL, sourceTable, type SourceTier, type SourceSpec } from "./sources/registry";
import { sourceStatus, aggregateState, type SourceStatus, type SourceState } from "./sources/state";
import {
  HEADLINE_FEEDS, SIGNALS_FEED_IDS, readFeed, readBlsCalendar, readBeaCalendar, readTreasuryAuctions,
  readEdgarCurrent8K, readEdgarWatchlist, readNasdaqEcon, type SourceRead,
} from "./sources/official";
import { tierItems, mergeTiered, mergeEconEvents, type TieredItem } from "./sources/merge";
import { classifyRelease, familyOfEventName, auctionPlacementEt, auctionImportance, type IcsEvent, type EdgarFiling } from "./sources/parse";

export type NewsTopic = "FED" | "INFLATION" | "JOBS" | "GROWTH" | "GEO" | "EARNINGS" | "RATES" | "OIL" | "OTHER";

export interface Headline {
  id: string;
  title: string;
  /** display name of the source, e.g. "Federal Reserve", "CNBC Markets" */
  source: string;
  url: string;
  published: number; // epoch seconds (UTC); undated items are never shown
  summary: string;
  topics: NewsTopic[];
  tickers: string[]; // inferred tickers mentioned
  sourceId: string;
  publisher: string;
  tier: SourceTier;
  tierLabel: string;
  kind: "news" | "official";
  publishedUtc: string;   // ISO UTC
  fetchedAtUtc: string;   // ISO UTC, when the source was last read
}

export type CalendarKind =
  | "ECON"
  | "FED"
  | "EARNINGS"
  | "TREASURY"
  | "OPEX"
  | "VIX_EXP"
  | "WITCH";

export interface CalendarEvent {
  id: string;
  kind: CalendarKind;
  title: string;
  when: number;   // epoch seconds (UTC)
  whenLabel: string; // e.g. "Tue 4/22 · 8:30 AM ET"
  importance: "HIGH" | "MED" | "LOW";
  previous?: string;
  forecast?: string;
  actual?: string;
  source: string;
  ticker?: string; // for earnings
  notes?: string; // optional additional detail
  sourceId?: string;
  tier?: SourceTier;
  tierLabel?: string;
  /** false when the source gives a date but not the clock time */
  timeExact?: boolean;
  /** official page for this event when known */
  sourceUrl?: string;
  /** join key for one release across sources (CPI, NFP, GDP, ...) */
  family?: string | null;
}

export interface FilingItem {
  form: string;
  company: string;
  cik: string;
  accession: string;
  acceptedUtc: string | null;
  filingDate: string | null;
  items: string[];
  url: string;
  source: string;
  tier: SourceTier;
}

export interface NewsResponse {
  asOf: number;
  headlines: Headline[];
  calendar: CalendarEvent[];
  topics: { topic: NewsTopic; count: number }[];
  warnings: string[];
  /** per-source state, every source attempted for this snapshot */
  sources: SourceStatus[];
  /** feed-level state over the headline sources */
  headlineState: SourceState | "unavailable";
  calendarState: SourceState | "unavailable";
  filings: { watchlist: FilingItem[]; wire: FilingItem[]; state: SourceState | "unavailable"; note: string };
  /** static source table (tier, access, terms) for the Sources panel */
  sourceTable: SourceSpec[];
}

// ---- Topic classifier ----
// Keyword sets tuned for macro trader audience.
const TOPIC_KEYWORDS: Record<NewsTopic, RegExp[]> = {
  FED: [/\bfed(eral reserve)?\b/i, /\bfomc\b/i, /\bpowell\b/i, /\brate (hike|cut|decision|path)\b/i, /\bdot plot\b/i, /\bjackson hole\b/i],
  INFLATION: [/\bcpi\b/i, /\bpce\b/i, /\bppi\b/i, /\binflation\b/i, /\bcore price\b/i, /\bdisinflation\b/i],
  JOBS: [/\bnfp\b/i, /\bnon[- ]?farm\b/i, /\bpayroll/i, /\bunemployment\b/i, /\bjobs (report|data)\b/i, /\bjobless claims\b/i, /\bjolts\b/i],
  GROWTH: [/\bgdp\b/i, /\brecession\b/i, /\bism\b/i, /\bpmi\b/i, /\bretail sales\b/i, /\bconsumer (spending|confidence)\b/i, /\bhousing starts\b/i],
  GEO: [/\bchina\b/i, /\brussia\b/i, /\bukraine\b/i, /\bisrael\b/i, /\bgaza\b/i, /\biran\b/i, /\btaiwan\b/i, /\btrade war\b/i, /\btariff/i, /\bwar\b/i, /\bsanction/i],
  EARNINGS: [/\bearnings\b/i, /\beps\b/i, /\bguidance\b/i, /\bbeat(s|\b)\b/i, /\bmiss(es|\b)\b/i, /\bq[1-4] (results|report)\b/i, /\bquarterly\b/i],
  RATES: [/\btreasur(y|ies)\b/i, /\byield/i, /\b10[- ]?year\b/i, /\b2[- ]?year\b/i, /\bbond\b/i, /\bauction\b/i],
  OIL: [/\bopec\b/i, /\bcrude\b/i, /\boil price/i, /\bwti\b/i, /\bbrent\b/i, /\benergy stocks\b/i],
  OTHER: [],
};

// Big-cap tickers commonly referenced
const TICKER_MENTIONS = [
  "SPY", "QQQ", "IWM", "DIA", "VIX",
  "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "META", "AMZN", "TSLA",
  "NFLX", "AMD", "AVGO", "CRM", "ORCL", "ADBE",
  "JPM", "BAC", "WFC", "GS", "MS",
  "XOM", "CVX", "COP",
  "GLD", "SLV", "TLT", "IEF",
  "BTC", "ETH",
];

function classifyTopics(text: string): NewsTopic[] {
  const hits: NewsTopic[] = [];
  for (const topic of Object.keys(TOPIC_KEYWORDS) as NewsTopic[]) {
    if (topic === "OTHER") continue;
    const pats = TOPIC_KEYWORDS[topic];
    if (pats.some((p) => p.test(text))) hits.push(topic);
  }
  return hits.length ? hits : ["OTHER"];
}

function extractTickers(text: string): string[] {
  const found = new Set<string>();
  for (const t of TICKER_MENTIONS) {
    // word boundary match, also allow $TICKER
    const re = new RegExp(`(?:^|[^A-Z])\\$?${t}(?:[^A-Z]|$)`, "i");
    if (re.test(text)) found.add(t);
  }
  return Array.from(found);
}

// ---- Tiered headline items -> Headline ----

function toHeadline(t: TieredItem): Headline {
  const blob = `${t.title} ${t.summary}`;
  return {
    id: `${t.sourceId}:${t.guid}`,
    title: t.title,
    source: t.source,
    url: t.url,
    published: Math.floor(t.publishedMs / 1000),
    summary: t.summary,
    topics: classifyTopics(blob),
    tickers: extractTickers(blob),
    sourceId: t.sourceId,
    publisher: t.publisher,
    tier: t.tier,
    tierLabel: t.tierLabel,
    kind: t.kind,
    publishedUtc: new Date(t.publishedMs).toISOString(),
    fetchedAtUtc: new Date(t.fetchedAtMs).toISOString(),
  };
}

/** Read the given headline feeds; returns headlines (newest first) and per-source states. */
async function collectHeadlines(ids: string[] | null, nowMs: number): Promise<{ headlines: Headline[]; statuses: SourceStatus[] }> {
  const defs = HEADLINE_FEEDS.filter((d) => !ids || ids.includes(d.id));
  const reads = await Promise.all(defs.map((d) => readFeed(d).catch((e: any) => ({
    state: "failed" as const, fetchedAtMs: null, value: null, error: String(e?.message ?? e).slice(0, 120),
  }))));
  const lists: TieredItem[][] = [];
  const statuses: SourceStatus[] = [];
  reads.forEach((r, i) => {
    const id = defs[i].id;
    const fetchedAt = r.fetchedAtMs ?? nowMs;
    const t = r.value ? tierItems(id, r.value, fetchedAt, nowMs) : { items: [], undatedDropped: 0 };
    lists.push(t.items);
    statuses.push(sourceStatus(id, r, t.items.map((x) => ({ publishedMs: x.publishedMs })), nowMs, t.undatedDropped));
  });
  return { headlines: mergeTiered(lists).map(toHeadline), statuses };
}

// ---- Signals headline feed (finding 5.8) ----
// Schwab has no news API. The Signals snapshot reuses the News tab's labeled
// sources (non-price context only: never feeds a price, greeks, options
// or sizing calculation). Each item keeps its source, tier and publish time,
// and the feed carries a status so an outage reads "unavailable", never as an
// empty quiet tape.

export interface HeadlineFeedItem { title: string; url: string; source: string; publishedAt?: string; tier?: SourceTier; tierLabel?: string }
export interface HeadlineFeed {
  items: HeadlineFeedItem[];
  status: "ok" | "partial" | "empty" | "unavailable";
  sources: Array<{ name: string; state: "ok" | "empty" | "failed" | "stale"; items: number; newest: string | null; tier?: SourceTier }>;
  maxAgeHours: number;
  undatedDropped: number;
  asOf: number;
  note: string;
}

export const HEADLINE_FEED_MAX_AGE_HOURS = 24;

type HeadlineLike = Pick<Headline, "title" | "url" | "source" | "published"> & Partial<Pick<Headline, "tier" | "tierLabel">>;

/** Pure: merge per-source results (null = request failed) into the Signals feed. */
export function summarizeHeadlineFeed(
  results: Array<{ name: string; items: HeadlineLike[] | null; stale?: boolean; tier?: SourceTier }>,
  nowMs: number = Date.now(),
  limit = 15,
): HeadlineFeed {
  const sources: HeadlineFeed["sources"] = [];
  const merged: HeadlineLike[] = [];
  const seen = new Set<string>();
  let undatedDropped = 0;
  const minSec = nowMs / 1000 - HEADLINE_FEED_MAX_AGE_HOURS * 3600;
  for (const r of results) {
    if (r.items == null) { sources.push({ name: r.name, state: "failed", items: 0, newest: null, tier: r.tier }); continue; }
    const dated = r.items.filter((h) => Number.isFinite(h.published) && h.published > 0);
    undatedDropped += r.items.length - dated.length;
    const fresh = dated.filter((h) => h.published >= minSec && h.published <= nowMs / 1000 + 300);
    const newest = dated.length ? new Date(Math.max(...dated.map((h) => h.published)) * 1000).toISOString() : null;
    sources.push({ name: r.name, state: r.stale ? "stale" : fresh.length ? "ok" : "empty", items: fresh.length, newest, tier: r.tier });
    for (const h of fresh) {
      const key = h.title.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(h);
    }
  }
  merged.sort((a, b) => b.published - a.published);
  const anyOk = sources.some((x) => x.state === "ok");
  const anyBad = sources.some((x) => x.state === "failed" || x.state === "stale");
  const status: HeadlineFeed["status"] = !results.length || sources.every((x) => x.state === "failed")
    ? "unavailable"
    : !anyOk ? (merged.length ? "partial" : "empty") : anyBad ? "partial" : "ok";
  return {
    items: merged.slice(0, limit).map((h) => ({
      title: h.title, url: h.url, source: h.source, publishedAt: new Date(h.published * 1000).toISOString(),
      tier: h.tier, tierLabel: h.tierLabel,
    })),
    status,
    sources,
    maxAgeHours: HEADLINE_FEED_MAX_AGE_HOURS,
    undatedDropped,
    asOf: nowMs,
    note: status === "unavailable"
      ? "no headline source reachable (feeds failed); Schwab has no news API"
      : `headlines (${sources.filter((x) => x.state === "ok").map((x) => x.name).join(", ") || "none"}), last ${HEADLINE_FEED_MAX_AGE_HOURS}h; context only, never a price input`,
  };
}

export async function fetchMarketHeadlineFeed(): Promise<HeadlineFeed> {
  const now = Date.now();
  const defs = HEADLINE_FEEDS.filter((d) => SIGNALS_FEED_IDS.includes(d.id));
  const reads = await Promise.all(defs.map((d) => readFeed(d).catch(() => null)));
  return summarizeHeadlineFeed(reads.map((r, i) => {
    const id = defs[i].id;
    const spec = SOURCES[id];
    if (!r || r.value == null) return { name: spec.name, items: null, tier: spec.tier };
    const t = tierItems(id, r.value, r.fetchedAtMs ?? now, now);
    return { name: spec.name, items: t.items.map(toHeadline), stale: r.state === "stale", tier: spec.tier };
  }), now);
}

// ---- Official economic calendars (BLS, BEA) ----

const BLS_URL = "https://www.bls.gov/schedule/news_release/";
const BEA_URL = "https://www.bea.gov/news/schedule";

/** Pure: ICS events from an official calendar -> calendar rows in [fromMs, toMs]. */
export function officialReleaseEvents(
  sourceId: "bls_calendar" | "bea_calendar",
  events: IcsEvent[],
  fromMs: number,
  toMs: number,
): CalendarEvent[] {
  const spec = SOURCES[sourceId];
  const out: CalendarEvent[] = [];
  for (const e of events) {
    if (e.startMs < fromMs || e.startMs > toMs) continue;
    const cls = classifyRelease(e.summary);
    const when = Math.floor(e.startMs / 1000);
    out.push({
      id: `${sourceId}:${e.uid}`,
      kind: "ECON",
      title: e.summary,
      when,
      whenLabel: e.timed ? formatEtLabel(when) : formatEtDateLabel(when),
      importance: cls.importance,
      source: spec.name,
      sourceId,
      tier: spec.tier,
      tierLabel: TIER_LABEL[spec.tier],
      timeExact: e.timed,
      sourceUrl: sourceId === "bls_calendar" ? BLS_URL : BEA_URL,
      family: cls.family,
    });
  }
  return out;
}

/** Pure: Nasdaq calendar rows (unofficial) -> calendar rows, US only. */
export function nasdaqEconEvents(rows: Array<{ date: string; time: string; eventName: string; country: string; impact: number; previous?: string; forecast?: string; actual?: string }>): CalendarEvent[] {
  const spec = SOURCES.nasdaq_econ;
  const out: CalendarEvent[] = [];
  for (const row of rows) {
    if (row.country && !/US|United States/i.test(row.country)) continue;
    if (!row.eventName) continue;
    // Nasdaq times are Eastern wall clock. A missing or non-clock time
    // ("All Day", "Tentative") is kept as date-only, not guessed as 8:30.
    const tm = /^(\d{1,2}):(\d{2})$/.exec(row.time.trim());
    const when = Math.floor(etEpochMs(row.date, tm ? Number(tm[1]) : 0, tm ? Number(tm[2]) : 0) / 1000);
    if (!Number.isFinite(when)) continue;
    out.push({
      id: `econ:${row.date}:${row.eventName}`,
      kind: "ECON",
      title: row.eventName,
      when,
      whenLabel: tm ? formatEtLabel(when) : formatEtDateLabel(when),
      importance: row.impact >= 3 ? "HIGH" : row.impact >= 2 ? "MED" : "LOW",
      previous: row.previous || undefined,
      forecast: row.forecast || undefined,
      actual: row.actual || undefined,
      source: spec.name,
      sourceId: spec.id,
      tier: spec.tier,
      tierLabel: TIER_LABEL[spec.tier],
      timeExact: Boolean(tm),
      family: familyOfEventName(row.eventName),
    });
  }
  return out;
}

/** Pure: Treasury Fiscal Data auctions -> calendar rows (date exact, close time per announcement). */
export function treasuryAuctionEvents(auctions: Array<{ cusip: string; securityType: string; securityTerm: string; auctionDate: string; offeringUsd: number | null; reopening: boolean; issueDate: string | null }>): CalendarEvent[] {
  const spec = SOURCES.treasury_auctions;
  return auctions.map((a) => {
    const { hh, mm } = auctionPlacementEt(a.securityType);
    const when = Math.floor(etEpochMs(a.auctionDate, hh, mm) / 1000);
    const size = a.offeringUsd != null ? `$${(a.offeringUsd / 1e9).toFixed(a.offeringUsd % 1e9 === 0 ? 0 : 1)}B` : "size n/a";
    return {
      id: `treas:${a.cusip || a.securityTerm}:${a.auctionDate}`,
      kind: "TREASURY" as const,
      title: `${a.securityTerm} ${a.securityType} Auction${a.reopening ? " (reopening)" : ""} · ${size}`,
      when,
      whenLabel: `${formatEtLabel(when)} (close time per announcement)`,
      importance: auctionImportance(a as any),
      source: spec.name,
      sourceId: spec.id,
      tier: spec.tier,
      tierLabel: TIER_LABEL[spec.tier],
      timeExact: false,
      sourceUrl: "https://www.treasurydirect.gov/auctions/upcoming/",
      notes: `CUSIP ${a.cusip || "n/a"}${a.issueDate ? ` · issues ${a.issueDate}` : ""} · offering amount from Treasury Fiscal Data`,
    };
  });
}

function toFiling(f: EdgarFiling, sourceId: string): FilingItem {
  const spec = SOURCES[sourceId];
  return {
    form: f.form, company: f.company, cik: f.cik, accession: f.accession,
    acceptedUtc: f.acceptedMs != null ? new Date(f.acceptedMs).toISOString() : null,
    filingDate: f.filingDate, items: f.items, url: f.link,
    source: spec.name, tier: spec.tier,
  };
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---- Derived market structure events ----
//
// These are deterministic from the calendar:
//   • Standard OPEX  → 3rd Friday of each month
//   • VIX expiration → Wednesday that is 30 days before the following
//                      month's 3rd Friday (SOQ settlement morning).
//                      Approximation: the Wednesday preceding the standard
//                      OPEX of the NEXT month, offset by 30 days.
//                      Practical shortcut: Wednesday before the 3rd Friday
//                      of the same month—aligns for most months, close enough.
//   • Triple Witch   → 3rd Friday of Mar / Jun / Sep / Dec.

function thirdFriday(year: number, monthIndex: number /* 0-11 */): Date {
  // First day of month (UTC), find first Friday, add 14 days.
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const dow = first.getUTCDay(); // 0=Sun..6=Sat
  const firstFridayOffset = (5 - dow + 7) % 7;
  const firstFriday = new Date(first.getTime() + firstFridayOffset * 86400 * 1000);
  return new Date(firstFriday.getTime() + 14 * 86400 * 1000);
}

// Returns true when the given date falls in US Eastern Daylight Time (UTC-4).
// EST (UTC-5) runs roughly Nov 1st Sunday → Mar 2nd Sunday. We let Intl do
// the heavy lifting so DST transitions are exact for whatever year we're in.
function isEdt(day: Date): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "short",
  });
  const parts = fmt.formatToParts(day);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  return tzName === "EDT";
}

function makeUtcEvent(day: Date, hourEt: number, minEt: number): number {
  // Convert an ET wall-clock time to UTC epoch seconds. Honors EDT (UTC-4)
  // vs EST (UTC-5) automatically so 2:00 PM ET FOMC events land at the right
  // UTC instant year-round, including across DST transitions.
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth();
  const d = day.getUTCDate();
  const offset = isEdt(day) ? 4 : 5; // hours west of UTC
  const utcHour = hourEt + offset;
  // utcHour can be 24+ if event is late-evening ET; Date constructor handles
  // overflow correctly by rolling forward to the next day.
  const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(utcHour).padStart(2, "0")}:${String(minEt).padStart(2, "0")}:00Z`;
  return Math.floor(new Date(iso).getTime() / 1000);
}

function buildMarketStructureEvents(from: Date, monthsAhead: number): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();

  for (let i = 0; i <= monthsAhead; i++) {
    const tm = m + i;
    const year = y + Math.floor(tm / 12);
    const monthIdx = ((tm % 12) + 12) % 12;
    const opex = thirdFriday(year, monthIdx);
    // Skip if already past
    if (opex.getTime() < from.getTime() - 86400_000) continue;

    // Triple/Quad Witching: Mar(2), Jun(5), Sep(8), Dec(11)
    const isWitch = [2, 5, 8, 11].includes(monthIdx);
    const opexWhen = makeUtcEvent(opex, 16, 0); // 4:00 PM ET close settles options
    out.push({
      id: `opex:${opex.toISOString().slice(0, 10)}`,
      kind: isWitch ? "WITCH" : "OPEX",
      title: isWitch
        ? "Triple Witching (Index + Stock + ETF Options)"
        : "Monthly Options Expiration (OPEX)",
      when: opexWhen,
      whenLabel: formatEtLabel(opexWhen),
      importance: isWitch ? "HIGH" : "MED",
      source: "CBOE (computed)",
      sourceId: "exchange_rules", tier: "computed", tierLabel: TIER_LABEL.computed, timeExact: true,
      notes: isWitch
        ? "Quarterly index + stock + ETF options expire on same day; historically elevated volume."
        : "Standard monthly options settle on AM SOQ / PM close.",
    });

    // VIX expiration: Wednesday that is 30 days before NEXT month's 3rd Friday
    const nextOpex = thirdFriday(
      monthIdx === 11 ? year + 1 : year,
      (monthIdx + 1) % 12,
    );
    const vixExp = new Date(nextOpex.getTime() - 30 * 86400 * 1000);
    // Snap to Wednesday (shouldn't need to, but defensive)
    const vdow = vixExp.getUTCDay();
    if (vdow !== 3) {
      // Nudge to nearest Wednesday
      const delta = vdow < 3 ? 3 - vdow : vdow > 3 ? -(vdow - 3) : 0;
      vixExp.setUTCDate(vixExp.getUTCDate() + delta);
    }
    if (vixExp.getTime() >= from.getTime() - 86400_000) {
      const vixWhen = makeUtcEvent(vixExp, 9, 0); // 9:00 AM ET VIX SOQ print
      out.push({
        id: `vixexp:${vixExp.toISOString().slice(0, 10)}`,
        kind: "VIX_EXP",
        title: "VIX Monthly Expiration (SOQ Print)",
        when: vixWhen,
        whenLabel: formatEtLabel(vixWhen),
        importance: "MED",
        source: "CBOE (computed)",
        sourceId: "exchange_rules", tier: "computed", tierLabel: TIER_LABEL.computed, timeExact: true,
        notes: "Special opening quotation used to settle VX futures + VIX options.",
      });
    }
  }

  return out;
}

function formatEtLabel(whenSec: number): string {
  const d = new Date(whenSec * 1000);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${fmt.format(d)} ET`;
}

function formatEtDateLabel(whenSec: number): string {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric" });
  return `${fmt.format(new Date(whenSec * 1000))} (time TBA)`;
}

// ---- Aggregator ----

// Pull deterministic vol-event calendar (OPEX/VIX/quad witch/FOMC/CPI/NFP)
// from volCalendar.ts and convert into unified CalendarEvent shape. This is
// the data the Regime tab's old VolCalendar panel used to render — it carries
// the explicit FOMC/CPI/NFP rhythm with HIGH importance flags.
async function fetchVolEventCalendar(): Promise<CalendarEvent[]> {
  const { buildVolCalendar } = await import("./volCalendar.js").catch(
    () => import("./volCalendar"),
  );
  const data = buildVolCalendar();
  const out: CalendarEvent[] = [];
  for (const ev of data.events) {
    // Map vol-calendar event → news CalendarEvent
    const day = new Date(`${ev.date}T00:00:00Z`);
    let kind: CalendarKind;
    let hourEt = 9, minEt = 30;
    let title = ev.label;
    let notes: string | undefined;
    let source = "VolCalendar (computed)";
    // Tier per row: FOMC and CPI dates are hardcoded copies of the official
    // schedules (computed); NFP is a first-Friday rule (an estimate, weak).
    // The official BLS calendar supersedes CPI/NFP rows when it is reachable.
    let tier: SourceTier = "computed";
    let family: string | null = null;
    switch (ev.type) {
      case "fomc":
        kind = "FED"; hourEt = 14; minEt = 0;
        notes = "FOMC rate decision @ 2pm ET, Powell presser @ 2:30pm ET. Largest single-day vol catalyst.";
        source = "Federal Reserve schedule (hardcoded copy)";
        break;
      case "cpi":
        kind = "ECON"; hourEt = 8; minEt = 30;
        title = `${ev.label} (CPI)`;
        notes = "Inflation print @ 8:30am ET. Hot read = bond selloff + risk-off; cool = rally.";
        source = "BLS schedule (hardcoded copy)";
        family = "CPI";
        break;
      case "nfp":
        kind = "ECON"; hourEt = 8; minEt = 30;
        notes = "Jobs print @ 8:30am ET (estimated by the first-Friday rule; BLS sometimes releases on another Friday). Watch headline + average hourly earnings + revisions.";
        source = "First-Friday rule (estimate)";
        tier = "weak";
        family = "NFP";
        break;
      case "monthly_opex":
        kind = "OPEX"; hourEt = 16; minEt = 0;
        notes = "Monthly options expiration. Gamma roll-off after 4pm — dealer hedging unwinds.";
        source = "CBOE";
        break;
      case "vix_exp":
        kind = "VIX_EXP"; hourEt = 9; minEt = 0;
        notes = "VIX SOQ print @ 9am ET. VX futures + VIX options settle.";
        source = "CBOE";
        break;
      case "quad_witching":
        kind = "WITCH"; hourEt = 16; minEt = 0;
        notes = "Quad witching — index futures, index options, single-stock futures, equity options ALL expire. Historically the highest-volume day of the quarter.";
        source = "CBOE";
        break;
      default:
        kind = "ECON";
    }
    const when = makeUtcEvent(day, hourEt, minEt);
    const importance: CalendarEvent["importance"] =
      ev.importance === "high" ? "HIGH" : ev.importance === "medium" ? "MED" : "LOW";
    out.push({
      id: `vol:${ev.type}:${ev.date}`,
      kind,
      title,
      when,
      whenLabel: formatEtLabel(when),
      importance,
      source,
      notes,
      sourceId: tier === "weak" ? "estimate" : "exchange_rules",
      tier,
      tierLabel: tier === "weak" ? "estimate" : TIER_LABEL[tier],
      timeExact: tier !== "weak",
      family,
    });
  }
  return out;
}

// Pull MAG7 + high-importance earnings from getEarnings() and convert into
// CalendarEvent shape so they appear in the unified News tab calendar.
async function fetchEarningsCalendar(): Promise<CalendarEvent[]> {
  // Lazy import to avoid circular load issues at module init time.
  const { getEarnings } = await import("./earnings.js").catch(
    () => import("./earnings"),
  );
  const data = await getEarnings("monthly"); // 30-day window
  const out: CalendarEvent[] = [];
  for (const week of data.weeks) {
    for (const day of week.days) {
      for (const r of day.rows) {
        // Only include MAG7 + HIGH-impact mega caps to keep payload tight.
        if (!r.isMag7 && r.importance !== "HIGH") continue;
        // Time-of-day from BMO/AMC/DMH timing
        const hourEt = r.timing === "BMO" ? 7 : r.timing === "AMC" ? 16 : r.timing === "DMH" ? 12 : 16;
        const minEt = r.timing === "BMO" ? 30 : 30;
        const dayDate = new Date(`${r.date}T00:00:00Z`);
        const when = makeUtcEvent(dayDate, hourEt, minEt);
        out.push({
          id: `earn:${r.date}:${r.ticker}`,
          kind: "EARNINGS",
          title: `${r.ticker} ${r.fiscalQuarter} Earnings${r.isMag7 ? " (MAG7)" : ""}`,
          when,
          whenLabel: formatEtLabel(when),
          importance: r.isMag7 ? "HIGH" : r.importance,
          source: r.source === "estimated" ? "Estimated date (Nasdaq failed)" : "Nasdaq (unofficial API)",
          sourceId: r.source === "estimated" ? "mag7_baseline" : "nasdaq_earnings",
          tier: "weak",
          tierLabel: r.source === "estimated" ? "estimate" : TIER_LABEL.weak,
          timeExact: false,
          ticker: r.ticker,
          forecast: r.epsForecast != null ? `EPS est ${r.epsForecast}` : undefined,
          previous: r.lastYearEps != null ? `LY EPS ${r.lastYearEps}` : undefined,
          notes: `${r.company} · ${r.timingLabel}${r.marketCapBucket ? " · " + r.marketCapBucket : ""}`,
        });
      }
    }
  }
  return out;
}

export async function buildNewsSnapshot(): Promise<NewsResponse> {
  const warnings: string[] = [];
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const fromMs = nowMs - 6 * 3600_000;
  const toMs = nowMs + 60 * 86400_000;
  const nasdaqDays: string[] = [];
  for (let i = 0; i < 14; i++) nasdaqDays.push(isoDate(nowMs + i * 86400_000));

  const failedRead = (e: any) => ({ state: "failed" as const, fetchedAtMs: null, value: null, error: String(e?.message ?? e).slice(0, 120) });
  const [head, bls, bea, treas, nasdaq, wire, watch, earningsEvents, volEvents] = await Promise.all([
    collectHeadlines(null, nowMs),
    readBlsCalendar().catch(failedRead),
    readBeaCalendar().catch(failedRead),
    readTreasuryAuctions(isoDate(nowMs - 86400_000)).catch(failedRead),
    readNasdaqEcon(nasdaqDays).catch(failedRead),
    readEdgarCurrent8K().catch(failedRead),
    readEdgarWatchlist().catch(failedRead),
    fetchEarningsCalendar().catch((e) => {
      warnings.push(`Earnings calendar: ${e?.message ?? "failed"}`);
      return [] as CalendarEvent[];
    }),
    fetchVolEventCalendar().catch((e) => {
      warnings.push(`Vol calendar: ${e?.message ?? "failed"}`);
      return [] as CalendarEvent[];
    }),
  ]);

  const statuses: SourceStatus[] = [...head.statuses];
  const pushStatus = (id: string, r: SourceRead<unknown>, items: Array<{ publishedMs: number | null }>, reason?: string) => {
    const st = sourceStatus(id, r, items, nowMs);
    if (reason && st.state === "ok") { st.state = "partial"; st.reason = reason; }
    statuses.push(st);
  };

  // Official calendars
  const blsEvents = bls.value ? officialReleaseEvents("bls_calendar", bls.value, fromMs, toMs) : [];
  const beaEvents = bea.value ? officialReleaseEvents("bea_calendar", bea.value, fromMs, toMs) : [];
  pushStatus("bls_calendar", bls, blsEvents.map((e) => ({ publishedMs: null })));
  pushStatus("bea_calendar", bea, beaEvents.map((e) => ({ publishedMs: null })));
  const treasEvents = treas.value ? treasuryAuctionEvents(treas.value) : [];
  pushStatus("treasury_auctions", treas, treasEvents.map(() => ({ publishedMs: null })));
  const nasdaqVal = nasdaq.value;
  const nasdaqEvents = nasdaqVal ? nasdaqEconEvents(nasdaqVal.rows) : [];
  pushStatus("nasdaq_econ", nasdaq, nasdaqEvents.map(() => ({ publishedMs: null })),
    nasdaqVal && nasdaqVal.failedDays ? `${nasdaqVal.failedDays} of ${nasdaqDays.length} days failed` : undefined);

  // ECON merge: official BLS/BEA set the time; Nasdaq consensus folds in;
  // hardcoded/estimated CPI/NFP rows drop when the official schedule has them.
  const volEcon = volEvents.filter((e) => e.kind === "ECON");
  const volOther = volEvents.filter((e) => e.kind !== "ECON");
  const econ = mergeEconEvents<CalendarEvent>([...blsEvents, ...beaEvents], [...nasdaqEvents, ...volEcon]);
  const calendar: CalendarEvent[] = [
    ...volOther,                 // FOMC + expirations from the vol calendar win kind/day dedupe
    ...econ,
    ...treasEvents,
    ...buildMarketStructureEvents(new Date(nowMs), 6),
    ...earningsEvents,
  ];

  // SEC filings
  const wireItems = wire.value ? wire.value.map((f) => toFiling(f, "sec_edgar_current")) : [];
  pushStatus("sec_edgar_current", wire, wireItems.map((f) => ({ publishedMs: f.acceptedUtc ? Date.parse(f.acceptedUtc) : null })));
  const watchVal = watch.value;
  const watchItems = watchVal ? watchVal.filings.map((f) => toFiling(f, "sec_edgar_submissions")) : [];
  pushStatus("sec_edgar_submissions", watch, watchItems.map((f) => ({ publishedMs: f.acceptedUtc ? Date.parse(f.acceptedUtc) : null })),
    watchVal && watchVal.failedTickers.length ? `failed: ${watchVal.failedTickers.join(", ")}` : undefined);
  const filingStates = statuses.filter((x) => x.id === "sec_edgar_current" || x.id === "sec_edgar_submissions").map((x) => x.state);
  const filingsState = aggregateState(filingStates);
  const filingsNote = filingStates.every((x) => x === "not_configured")
    ? "SEC EDGAR not configured: set BATCAVE_SEC_USER_AGENT (app name + contact email) per the SEC fair-access policy"
    : "SEC EDGAR: watchlist filings (last 7 days) and the latest 8-K wire, acceptance time from EDGAR";

  for (const st of statuses) {
    if (st.state === "failed" || st.state === "stale") warnings.push(`${st.name}: ${st.state}${st.reason ? ` (${st.reason})` : ""}`);
  }

  const allHeadlines = head.headlines;
  const counts = new Map<NewsTopic, number>();
  for (const h of allHeadlines) for (const t of h.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
  const topics = Array.from(counts.entries()).map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count);
  const headlines = allHeadlines.slice(0, 80);

  // Calendar window: recently past (6 h) through ~7 months (OPEX grid).
  const cutoff = now - 6 * 3600;
  const forwardLimit = now + 210 * 86400;
  // Dedupe by id AND by (kind + same day) for one-per-day kinds (FOMC,
  // expirations): the vol-calendar rows come first and win.
  const seenIds = new Set<string>();
  const seenKindDay = new Set<string>();
  const isoDay = (whenSec: number) => new Date(whenSec * 1000).toISOString().slice(0, 10);
  const calFiltered = calendar
    .filter((e) => {
      if (seenIds.has(e.id)) return false;
      seenIds.add(e.id);
      if (e.when < cutoff || e.when > forwardLimit) return false;
      if (e.kind !== "EARNINGS" && e.kind !== "TREASURY" && e.kind !== "ECON") {
        const k = `${e.kind}:${isoDay(e.when)}`;
        if (seenKindDay.has(k)) return false;
        seenKindDay.add(k);
      }
      return true;
    })
    .sort((a, b) => a.when - b.when)
    .slice(0, 400);

  const headlineState = aggregateState(head.statuses.map((x) => x.state));
  const calendarState = aggregateState(statuses
    .filter((x) => ["bls_calendar", "bea_calendar", "treasury_auctions", "nasdaq_econ"].includes(x.id))
    .map((x) => x.state));

  return {
    asOf: now,
    headlines,
    calendar: calFiltered,
    topics,
    warnings,
    sources: statuses,
    headlineState,
    calendarState,
    filings: { watchlist: watchItems.slice(0, 40), wire: wireItems.slice(0, 40), state: filingsState, note: filingsNote },
    sourceTable: sourceTable(),
  };
}
