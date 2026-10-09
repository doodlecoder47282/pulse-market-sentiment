// server/sources/official.ts
//
// Network adapters for official primary sources and publisher RSS. Every
// read goes through one SourceCache so the polling interval in the source
// registry (sources/registry.ts) is respected no matter how often the UI
// polls; a failed refresh serves the last good payload as "stale" (with its
// real fetch time) only inside a stated max age, then "failed".
//
// SEC EDGAR requires a descriptive User-Agent with a contact (SEC, "Accessing
// EDGAR Data": https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data).
// It is read from BATCAVE_SEC_USER_AGENT and never logged or returned; when
// unset, SEC sources report "not_configured" and are not called.

import { SOURCES } from "./registry";
import { SourceCache, type CachedResult } from "./state";
import {
  parseFeed, parseIcs, parseEdgarAtom, parseEdgarSubmissions, parseUpcomingAuctions,
  type FeedItem, type IcsEvent, type EdgarFiling, type TreasuryAuction,
} from "./parse";

const GENERIC_UA = "Batcave/1.0 (personal market terminal; RSS reader)";
const cache = new SourceCache();

export type NotConfigured = { state: "not_configured"; fetchedAtMs: null; error: string; value: null };
export type SourceRead<T> = CachedResult<T> | NotConfigured;

/** The SEC contact User-Agent, or null when unset / missing a contact email. */
export function secUserAgent(env: Record<string, string | undefined> = process.env): string | null {
  const v = (env.BATCAVE_SEC_USER_AGENT ?? "").trim();
  if (!v || !/@/.test(v) || v.length > 200) return null;
  return v;
}

/**
 * User-Agent for other U.S. government hosts (Fed, BLS, BEA, CFTC, Treasury):
 * the contact UA when configured (BLS asks automated clients to identify
 * themselves), otherwise the generic descriptive UA.
 */
function govUserAgent(): string {
  return secUserAgent() ?? GENERIC_UA;
}

const SEC_NOT_CONFIGURED: NotConfigured = {
  state: "not_configured", fetchedAtMs: null, value: null,
  error: "set BATCAVE_SEC_USER_AGENT to \"AppName contact-email\" (SEC fair-access policy) to enable SEC sources",
};

async function fetchText(url: string, ua: string, accept: string, timeoutMs = 10_000): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": ua, Accept: accept }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function ttl(id: string): number {
  return Math.max(60_000, SOURCES[id]?.minIntervalMs ?? 5 * 60_000);
}

// ─── Headline feeds (official + publisher RSS) ───────────────────────────

export interface FeedSourceDef { id: string; url: string; needsSecUa?: boolean; gov?: boolean }

export const HEADLINE_FEEDS: FeedSourceDef[] = [
  // Official primary sources first.
  { id: "fed_press", url: "https://www.federalreserve.gov/feeds/press_all.xml", gov: true },
  { id: "fed_speeches", url: "https://www.federalreserve.gov/feeds/speeches.xml", gov: true },
  { id: "sec_press", url: "https://www.sec.gov/news/pressreleases.rss", needsSecUa: true },
  { id: "cftc_press", url: "https://www.cftc.gov/RSS/RSSGP/rssgp.xml", gov: true },
  // Professional publishers' own syndication feeds.
  { id: "marketwatch", url: "https://feeds.content.dj-n.com/public/rss/mw_topstories" },
  { id: "cnbc", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { id: "ft", url: "https://www.ft.com/markets?format=rss" },
  // Aggregator, secondary (Reuters ended its public RSS).
  { id: "google_news_reuters", url: "https://news.google.com/rss/search?q=when:1d+site:reuters.com+business&hl=en-US&gl=US&ceid=US:en" },
];

/** Feeds the Signals headline strip reads (market news, not agency releases). */
export const SIGNALS_FEED_IDS = ["marketwatch", "cnbc", "ft", "google_news_reuters", "fed_press"];

export async function readFeed(def: FeedSourceDef): Promise<SourceRead<FeedItem[]>> {
  let ua = def.gov ? govUserAgent() : GENERIC_UA;
  if (def.needsSecUa) {
    const sec = secUserAgent();
    if (!sec) return SEC_NOT_CONFIGURED;
    ua = sec;
  }
  const t = ttl(def.id);
  return cache.get(`feed:${def.id}`, t, Math.max(6 * t, 60 * 60_000), async () =>
    parseFeed(await fetchText(def.url, ua, "application/rss+xml, application/atom+xml, application/xml, text/xml")));
}

// ─── Release calendars (BLS, BEA) ────────────────────────────────────────

const DAY = 86_400_000;

export async function readBlsCalendar(): Promise<SourceRead<IcsEvent[]>> {
  const t = ttl("bls_calendar");
  return cache.get("ics:bls", t, 7 * DAY, async () => {
    const ev = parseIcs(await fetchText("https://www.bls.gov/schedule/news_release/bls.ics", govUserAgent(), "text/calendar, */*"));
    if (!ev.length) throw new Error("calendar parsed to zero events");
    return ev;
  });
}

export async function readBeaCalendar(): Promise<SourceRead<IcsEvent[]>> {
  const t = ttl("bea_calendar");
  return cache.get("ics:bea", t, 7 * DAY, async () => {
    const ev = parseIcs(await fetchText("https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics", govUserAgent(), "text/calendar, */*"));
    if (!ev.length) throw new Error("calendar parsed to zero events");
    return ev;
  });
}

// ─── Treasury auctions (Fiscal Data API) ─────────────────────────────────

export async function readTreasuryAuctions(fromDate: string): Promise<SourceRead<TreasuryAuction[]>> {
  const t = ttl("treasury_auctions");
  const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/upcoming_auctions"
    + "?sort=-record_date&page%5Bsize%5D=100";
  const r = await cache.get("api:treasury_auctions", t, DAY, async () => {
    const j = JSON.parse(await fetchText(url, govUserAgent(), "application/json"));
    if (!Array.isArray(j?.data)) throw new Error("unexpected response shape");
    return j;
  });
  if (r.value == null) return { ...r, value: null };
  return { ...r, value: parseUpcomingAuctions(r.value, fromDate) };
}

// ─── SEC EDGAR filings ───────────────────────────────────────────────────

/** Watchlist CIKs (SEC company_tickers.json). Mega caps that move the index. */
export const WATCH_CIKS: Record<string, string> = {
  AAPL: "0000320193", MSFT: "0000789019", NVDA: "0001045810", GOOGL: "0001652044",
  AMZN: "0001018724", META: "0001326801", TSLA: "0001318605",
};
export const WATCH_FORMS: ReadonlySet<string> = new Set(["8-K", "8-K/A", "10-Q", "10-K", "10-K/A", "6-K"]);

export async function readEdgarCurrent8K(): Promise<SourceRead<EdgarFiling[]>> {
  const ua = secUserAgent();
  if (!ua) return SEC_NOT_CONFIGURED;
  const t = ttl("sec_edgar_current");
  const url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=0&count=40&output=atom";
  return cache.get("edgar:current8k", t, 60 * 60_000, async () =>
    parseEdgarAtom(await fetchText(url, ua, "application/atom+xml, application/xml")));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Recent filings for the watchlist, last `days` days. Sequential with 150 ms spacing (< 10 req/s). */
export async function readEdgarWatchlist(days = 7): Promise<SourceRead<{ filings: EdgarFiling[]; failedTickers: string[] }>> {
  const ua = secUserAgent();
  if (!ua) return SEC_NOT_CONFIGURED;
  const t = ttl("sec_edgar_submissions");
  return cache.get("edgar:watchlist", t, 6 * 60 * 60_000, async () => {
    const sinceMs = Date.now() - days * DAY;
    const filings: EdgarFiling[] = [];
    const failedTickers: string[] = [];
    for (const [ticker, cik] of Object.entries(WATCH_CIKS)) {
      try {
        const j = JSON.parse(await fetchText(`https://data.sec.gov/submissions/CIK${cik}.json`, ua, "application/json"));
        filings.push(...parseEdgarSubmissions(j, WATCH_FORMS, sinceMs).map((f) => ({ ...f, company: `${f.company} (${ticker})` })));
      } catch {
        failedTickers.push(ticker);
      }
      await sleep(150);
    }
    if (failedTickers.length === Object.keys(WATCH_CIKS).length) throw new Error("every watchlist request failed");
    filings.sort((a, b) => (b.acceptedMs ?? 0) - (a.acceptedMs ?? 0));
    return { filings, failedTickers };
  });
}

// ─── Nasdaq economic calendar (unofficial secondary), cached ─────────────

export interface NasdaqEconRow { date: string; time: string; eventName: string; country: string; impact: number; previous?: string; forecast?: string; actual?: string }

const BROWSER_UA = "Mozilla/5.0 (compatible; Batcave/1.0)";

/**
 * api.nasdaq.com is the undocumented JSON behind nasdaq.com's calendar page
 * (no published terms for automated use). It is a labeled secondary for
 * consensus values and releases missing from the official calendars, and it
 * is cached for 30 minutes (previously 14 requests per 25 s UI poll).
 */
export async function readNasdaqEcon(dates: string[]): Promise<SourceRead<{ rows: NasdaqEconRow[]; failedDays: number }>> {
  const t = ttl("nasdaq_econ");
  return cache.get(`nasdaq:econ:${dates[0]}:${dates.length}`, t, 6 * 60 * 60_000, async () => {
    const settled = await Promise.allSettled(dates.map(async (date) => {
      const j = JSON.parse(await fetchText(`https://api.nasdaq.com/api/calendar/economicevents?date=${date}`, BROWSER_UA, "application/json", 5000));
      const rows: any[] = j?.data?.rows ?? [];
      return rows.map((row): NasdaqEconRow => ({
        date,
        time: String(row.time ?? ""),
        eventName: String(row.eventName ?? "").trim(),
        country: String(row.gsi ?? row.country ?? ""),
        impact: Number(row.impactLevel ?? row.impact ?? 0),
        previous: row.previous ?? undefined,
        forecast: row.forecast ?? row.consensus ?? undefined,
        actual: row.actual ?? undefined,
      }));
    }));
    const rows = settled.flatMap((x) => (x.status === "fulfilled" ? x.value : []));
    const failedDays = settled.filter((x) => x.status === "rejected").length;
    if (failedDays === dates.length) throw new Error("every Nasdaq calendar day failed");
    return { rows, failedDays };
  });
}
