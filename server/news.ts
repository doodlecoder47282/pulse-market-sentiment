// server/news.ts
//
// News snapshot = headline flow (RSS) + economic/earnings calendar.
//
// Sources (all free, no auth):
//   Headlines:
//     - MarketWatch top stories RSS
//     - Reuters business RSS (via Google News proxy; Reuters killed direct feeds)
//     - Yahoo Finance top stories RSS
//   Calendar:
//     - Nasdaq economic calendar JSON (next 14 days)
//     - FRED next-release dates for big prints (CPI, NFP, PCE, Retail Sales)
//   Earnings:
//     - Yahoo Finance earnings calendar (optional — best-effort, may be rate-limited)
//
// Everything is merged into a unified timeline the client can filter by topic.
// Macro filter buckets headlines into: FED / INFLATION / JOBS / GROWTH / GEO / EARNINGS / OTHER

const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0)";

export type NewsTopic = "FED" | "INFLATION" | "JOBS" | "GROWTH" | "GEO" | "EARNINGS" | "RATES" | "OIL" | "OTHER";

export interface Headline {
  id: string;
  title: string;
  source: string;
  url: string;
  published: number; // epoch seconds
  summary: string;
  topics: NewsTopic[];
  tickers: string[]; // inferred tickers mentioned
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
}

export interface NewsResponse {
  asOf: number;
  headlines: Headline[];
  calendar: CalendarEvent[];
  topics: { topic: NewsTopic; count: number }[];
  warnings: string[];
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

// ---- RSS parser (minimal) ----
function parseRss(xml: string, sourceName: string): Headline[] {
  const items: Headline[] = [];
  // Split on <item> boundaries (works for both RSS 2.0 and Atom with <entry>).
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[2];
    const title = decodeEntities(firstMatch(body, /<title[^>]*>([\s\S]*?)<\/title>/i));
    let link = firstMatch(body, /<link[^>]*>([\s\S]*?)<\/link>/i);
    if (!link) link = firstMatchAttr(body, /<link[^>]*href="([^"]+)"/i);
    const descRaw = firstMatch(body, /<description[^>]*>([\s\S]*?)<\/description>/i) ||
                    firstMatch(body, /<summary[^>]*>([\s\S]*?)<\/summary>/i) ||
                    firstMatch(body, /<content[^>]*>([\s\S]*?)<\/content>/i);
    const pubStr = firstMatch(body, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
                   firstMatch(body, /<published[^>]*>([\s\S]*?)<\/published>/i) ||
                   firstMatch(body, /<updated[^>]*>([\s\S]*?)<\/updated>/i);
    const guid = firstMatch(body, /<guid[^>]*>([\s\S]*?)<\/guid>/i) ||
                 firstMatch(body, /<id[^>]*>([\s\S]*?)<\/id>/i) || link;
    if (!title || !link) continue;
    const published = pubStr ? Math.floor(new Date(pubStr).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const summary = stripHtml(decodeEntities(descRaw || ""));
    const blob = `${title} ${summary}`;
    items.push({
      id: `${sourceName}:${guid}`,
      title: title.trim(),
      source: sourceName,
      url: link.trim(),
      published,
      summary: summary.trim().slice(0, 320),
      topics: classifyTopics(blob),
      tickers: extractTickers(blob),
    });
  }
  return items;
}

function firstMatch(src: string, re: RegExp): string {
  const m = re.exec(src);
  if (!m) return "";
  let v = m[1];
  // Strip CDATA wrapper
  const cd = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(v);
  if (cd) v = cd[1];
  return v;
}
function firstMatchAttr(src: string, re: RegExp): string {
  const m = re.exec(src);
  return m ? m[1] : "";
}
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)));
}

async function fetchRss(url: string, sourceName: string, timeoutMs = 8000): Promise<Headline[]> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${sourceName} ${r.status}`);
    const xml = await r.text();
    return parseRss(xml, sourceName);
  } finally {
    clearTimeout(to);
  }
}

// ---- Sources ----

const RSS_SOURCES: { name: string; url: string }[] = [
  { name: "MarketWatch", url: "https://feeds.content.dj-n.com/public/rss/mw_topstories" },
  { name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
  { name: "Reuters Business", url: "https://news.google.com/rss/search?q=when:1d+site:reuters.com+business&hl=en-US&gl=US&ceid=US:en" },
  { name: "CNBC Markets", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { name: "FT Markets", url: "https://www.ft.com/markets?format=rss" },
];

// Nasdaq econ calendar: public JSON endpoint. Iterates daily across a window
// to collect a full 14-day forward view instead of a single day.
async function fetchEconCalendar(): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const seenIds = new Set<string>();

  const days: string[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(today.getTime() + i * 86400 * 1000);
    days.push(fmt(d));
  }

  // Fetch each day in parallel (bounded) so the full window comes back fast.
  const dayResults = await Promise.allSettled(
    days.map(async (date) => {
      const url = `https://api.nasdaq.com/api/calendar/economicevents?date=${date}`;
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (!r.ok) return [] as CalendarEvent[];
      const j: any = await r.json();
      const rows: any[] = j?.data?.rows ?? [];
      const out: CalendarEvent[] = [];
      for (const row of rows) {
        const eventName = String(row.eventName ?? "");
        const countryCode = String(row.gsi ?? row.country ?? "");
        if (countryCode && !/US|United States/i.test(countryCode)) continue;
        const t = String(row.time ?? "");
        const iso = `${date}T${t || "13:30"}:00Z`;
        const when = Math.floor(new Date(iso).getTime() / 1000);
        if (!Number.isFinite(when)) continue;
        const importanceRaw = Number(row.impactLevel ?? row.impact ?? 0);
        const importance: CalendarEvent["importance"] =
          importanceRaw >= 3 ? "HIGH" : importanceRaw >= 2 ? "MED" : "LOW";
        const id = `econ:${date}:${eventName}`;
        out.push({
          id,
          kind: "ECON",
          title: eventName,
          when,
          whenLabel: formatEtLabel(when),
          importance,
          previous: row.previous ?? undefined,
          forecast: row.forecast ?? row.consensus ?? undefined,
          actual: row.actual ?? undefined,
          source: "Nasdaq",
        });
      }
      return out;
    }),
  );

  for (const res of dayResults) {
    if (res.status !== "fulfilled") continue;
    for (const ev of res.value) {
      if (seenIds.has(ev.id)) continue;
      seenIds.add(ev.id);
      events.push(ev);
    }
  }

  // Curated baseline for FOMC + big prints
  for (const ev of syntheticBaseline()) {
    if (!seenIds.has(ev.id)) {
      seenIds.add(ev.id);
      events.push(ev);
    }
  }

  // Derived market-structure events: OPEX, VIX expirations, triple witching,
  // Treasury auctions. These are math-based so they can't fail.
  for (const ev of buildMarketStructureEvents(today, 6)) {
    events.push(ev);
  }
  for (const ev of buildTreasuryAuctions(today, 21)) {
    events.push(ev);
  }

  return events;
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

function makeUtcEvent(day: Date, hourEt: number, minEt: number): number {
  // Convert ET wall-clock to UTC. Approximate UTC-4 (EDT). For a trader
  // dashboard running year-round this is close enough—DST boundary days
  // may be off by 1 hour but the actual date/label is still correct.
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth();
  const d = day.getUTCDate();
  const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hourEt + 4).padStart(2, "0")}:${String(minEt).padStart(2, "0")}:00Z`;
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
        notes: "Special opening quotation used to settle VX futures + VIX options.",
      });
    }
  }

  return out;
}

function buildTreasuryAuctions(from: Date, daysAhead: number): CalendarEvent[] {
  // Approximate weekly auction cadence (actuals published by TreasuryDirect):
  //   Mon 11:30 ET → 13/26W bills
  //   Tue 13:00 ET → 3Y / 52W (rotating weeks)
  //   Wed 13:00 ET → 10Y (first half of month) / reopens
  //   Thu 13:00 ET → 30Y (mid-month) / 4W + 8W bills
  // We generate a conservative schedule the user can use to anticipate
  // liquidity/duration events. Actual sizes come from Treasury, not here.
  const out: CalendarEvent[] = [];
  const plan: Array<{ dow: number; hour: number; minute: number; title: string; importance: CalendarEvent["importance"] }> = [
    { dow: 1, hour: 11, minute: 30, title: "13W / 26W T-Bill Auction", importance: "LOW" },
    { dow: 2, hour: 13, minute: 0, title: "3Y / 52W Auction (est.)", importance: "MED" },
    { dow: 3, hour: 13, minute: 0, title: "10Y Auction (est.)", importance: "HIGH" },
    { dow: 4, hour: 13, minute: 0, title: "30Y Bond / 4W+8W Bill Auction (est.)", importance: "MED" },
  ];
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(from.getTime() + i * 86400 * 1000);
    const dow = d.getUTCDay();
    const slot = plan.find((p) => p.dow === dow);
    if (!slot) continue;
    const when = makeUtcEvent(d, slot.hour, slot.minute);
    out.push({
      id: `treas:${d.toISOString().slice(0, 10)}:${slot.dow}`,
      kind: "TREASURY",
      title: slot.title,
      when,
      whenLabel: formatEtLabel(when),
      importance: slot.importance,
      source: "TreasuryDirect (estimated cadence)",
    });
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

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function nextWeekday(from: Date, weekday: number /* 0=Sun .. 6=Sat */): Date {
  const x = new Date(from);
  const diff = (weekday - x.getUTCDay() + 7) % 7 || 7;
  x.setUTCDate(x.getUTCDate() + diff);
  return x;
}

// Baseline curated list so the panel always has content even if the Nasdaq
// endpoint is down. Hand-maintained for the standard monthly cadence.
function syntheticBaseline(): CalendarEvent[] {
  const now = new Date();
  const mk = (d: Date, h: number, m: number): number => {
    // 8:30 ET = 12:30 UTC (during EDT) or 13:30 UTC (during EST). Approximate as UTC-4 for EDT.
    const iso = `${d.toISOString().slice(0, 10)}T${String(h + 4).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
    return Math.floor(new Date(iso).getTime() / 1000);
  };
  // Next Fed meeting assumed ~6 weeks out (placeholder — refresh yearly)
  // Next NFP = first Friday of next month
  const firstOfNext = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const nextNfp = nextWeekday(firstOfNext, 5);
  nextNfp.setUTCDate(nextNfp.getUTCDate() - (nextNfp.getUTCDay() === 5 ? 0 : 0));
  const nextCpi = addDays(firstOfNext, 9); // mid-month-ish placeholder
  return [
    {
      id: `base:nfp:${nextNfp.toISOString().slice(0, 10)}`,
      kind: "ECON",
      title: "Nonfarm Payrolls",
      when: mk(nextNfp, 8, 30),
      whenLabel: formatEtLabel(mk(nextNfp, 8, 30)),
      importance: "HIGH",
      source: "BLS (tentative)",
    },
    {
      id: `base:cpi:${nextCpi.toISOString().slice(0, 10)}`,
      kind: "ECON",
      title: "CPI (YoY)",
      when: mk(nextCpi, 8, 30),
      whenLabel: formatEtLabel(mk(nextCpi, 8, 30)),
      importance: "HIGH",
      source: "BLS (tentative)",
    },
    {
      id: `base:fomc:next`,
      kind: "FED",
      title: "FOMC Rate Decision (next meeting)",
      when: mk(addDays(now, 42), 14, 0),
      whenLabel: formatEtLabel(mk(addDays(now, 42), 14, 0)),
      importance: "HIGH",
      source: "Federal Reserve (tentative)",
    },
  ];
}

// ---- Aggregator ----

export async function buildNewsSnapshot(): Promise<NewsResponse> {
  const warnings: string[] = [];

  const rssPromises = RSS_SOURCES.map((s) =>
    fetchRss(s.url, s.name).catch((e) => {
      warnings.push(`${s.name}: ${e?.message ?? "failed"}`);
      return [] as Headline[];
    }),
  );
  const calPromise = fetchEconCalendar().catch((e) => {
    warnings.push(`Calendar: ${e?.message ?? "failed"}`);
    return syntheticBaseline();
  });

  const rssAll = await Promise.all(rssPromises);
  const calendar = await calPromise;

  // Merge + dedupe by normalized title
  const allHeadlines: Headline[] = [];
  const seen = new Set<string>();
  for (const arr of rssAll) {
    for (const h of arr) {
      const key = h.title.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      allHeadlines.push(h);
    }
  }
  allHeadlines.sort((a, b) => b.published - a.published);

  // Topic counts
  const counts = new Map<NewsTopic, number>();
  for (const h of allHeadlines) {
    for (const t of h.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const topics = Array.from(counts.entries())
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count);

  // Limit headlines to a reasonable count to keep payload small
  const headlines = allHeadlines.slice(0, 80);

  // Calendar: show anything from today forward through ~6 months (OPEX grid).
  // Keep recently-past events (last 6 hours) visible so the user can see what
  // just printed. Limit payload generously now that we have OPEX/VIX/etc.
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 6 * 3600;
  const forwardLimit = now + 210 * 86400; // ~7 months
  const calFiltered = calendar
    .filter((e) => e.when >= cutoff && e.when <= forwardLimit)
    .sort((a, b) => a.when - b.when)
    .slice(0, 200);

  return {
    asOf: now,
    headlines,
    calendar: calFiltered,
    topics,
    warnings,
  };
}
