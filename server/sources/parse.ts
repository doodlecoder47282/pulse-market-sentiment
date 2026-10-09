// server/sources/parse.ts
//
// Pure parsers for official and publisher feeds: RSS 2.0 / Atom, iCalendar
// (RFC 5545), SEC EDGAR latest-filings Atom, SEC submissions JSON, and the
// Treasury Fiscal Data upcoming_auctions dataset. No network, no DB.
//
// Time handling: every parsed instant is epoch milliseconds UTC. An item
// whose publish time cannot be read is returned with publishedMs = null
// (undated), never stamped with the fetch time.

import { etEpochMs } from "../etTime";

// ─── RSS / Atom ──────────────────────────────────────────────────────────

export interface FeedItem {
  title: string;
  link: string;
  summary: string;
  guid: string;
  category: string | null;
  publishedMs: number | null;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, "&");
}

function unCdata(v: string): string {
  const cd = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(v);
  return cd ? cd[1] : v;
}

function tag(body: string, name: string): string {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(body);
  return m ? unCdata(m[1]) : "";
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** RFC 822 (RSS) and ISO 8601 (Atom) dates; null when unreadable. */
export function parseFeedDate(s: string): number | null {
  const v = s.trim();
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[2];
    const title = stripHtml(decodeEntities(tag(body, "title")));
    let link = tag(body, "link").trim();
    if (!link) {
      const alt = /<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/i.exec(body) ?? /<link\b[^>]*href="([^"]+)"/i.exec(body);
      link = alt ? alt[1] : "";
    }
    link = decodeEntities(link).trim();
    const summaryRaw = tag(body, "description") || tag(body, "summary") || tag(body, "content");
    const pub = tag(body, "pubDate") || tag(body, "published") || tag(body, "updated") || tag(body, "dc:date");
    const guid = (tag(body, "guid") || tag(body, "id") || link).trim();
    const catText = tag(body, "category").trim();
    const catAttr = /<category\b[^>]*term="([^"]+)"/i.exec(body);
    if (!title || !link) continue;
    out.push({
      title,
      link,
      summary: stripHtml(decodeEntities(decodeEntities(summaryRaw))).slice(0, 320),
      guid,
      category: catText ? decodeEntities(catText) : catAttr ? catAttr[1] : null,
      publishedMs: parseFeedDate(decodeEntities(pub)),
    });
  }
  return out;
}

// ─── iCalendar (RFC 5545) ────────────────────────────────────────────────

export interface IcsEvent {
  uid: string;
  summary: string;
  startMs: number;
  /** true when DTSTART carried a time (UTC "Z", TZID, or calendar zone) */
  timed: boolean;
}

const TZ_ALIASES: Record<string, string> = {
  "US-Eastern": "America/New_York",
  "US/Eastern": "America/New_York",
  "Eastern Standard Time": "America/New_York",
  "America/New_York": "America/New_York",
};

function unescapeIcs(v: string): string {
  return v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

/**
 * DTSTART forms handled: "...Z" (UTC), ";TZID=US-Eastern:" / America/New_York
 * (Eastern wall clock, DST-aware via etEpochMs), floating time with an
 * Eastern X-WR-TIMEZONE, and ";VALUE=DATE:" (all-day, placed at 00:00 ET,
 * timed=false). Other zones are not guessed: the event is skipped.
 */
export function parseIcs(text: string): IcsEvent[] {
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const calTz = /^X-WR-TIMEZONE:(.+)$/m.exec(unfolded)?.[1]?.trim() ?? /^TZID:(.+)$/m.exec(unfolded)?.[1]?.trim() ?? null;
  const out: IcsEvent[] = [];
  const blocks = unfolded.split("BEGIN:VEVENT").slice(1);
  for (const raw of blocks) {
    const block = raw.split("END:VEVENT")[0];
    const lines = block.split("\n");
    let summary = "", uid = "", dt: string | null = null;
    for (const ln of lines) {
      if (ln.startsWith("SUMMARY")) summary = unescapeIcs(ln.slice(ln.indexOf(":") + 1));
      else if (ln.startsWith("UID")) uid = ln.slice(ln.indexOf(":") + 1).trim();
      else if (ln.startsWith("DTSTART")) dt = ln;
    }
    if (!dt || !summary) continue;
    const params = dt.slice(0, dt.indexOf(":"));
    const value = dt.slice(dt.indexOf(":") + 1).trim();
    const dm = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
    if (!dm) continue;
    const [, y, mo, d, hh, mi, ss, z] = dm;
    const dateIso = `${y}-${mo}-${d}`;
    let startMs: number;
    let timed = true;
    if (hh == null) {
      startMs = etEpochMs(dateIso, 0, 0);
      timed = false;
    } else if (z) {
      startMs = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
    } else {
      const tzid = /TZID=([^;:]+)/.exec(params)?.[1] ?? calTz;
      const zone = tzid ? TZ_ALIASES[tzid.replace(/^"|"$/g, "")] : undefined;
      if (zone !== "America/New_York") continue; // unknown zone: do not guess
      startMs = etEpochMs(dateIso, +hh, +mi, +ss);
    }
    if (!Number.isFinite(startMs)) continue;
    out.push({ uid: uid || `${summary}:${value}`, summary, startMs, timed });
  }
  return out;
}

// ─── SEC EDGAR ───────────────────────────────────────────────────────────

export interface EdgarFiling {
  form: string;
  company: string;
  cik: string;          // 10-digit, zero padded
  accession: string;    // 0000000000-YY-NNNNNN
  acceptedMs: number | null;
  filingDate: string | null; // YYYY-MM-DD
  items: string[];      // 8-K item numbers/descriptions when given
  link: string;
}

/**
 * EDGAR latest-filings Atom (browse-edgar?action=getcurrent&output=atom).
 * Entry title: "8-K - COMPANY NAME (0000320193) (Filer)"; the same filing
 * repeats for each role (Filer / Subject / Reporting), deduped by accession.
 * <updated> carries an explicit UTC offset.
 */
export function parseEdgarAtom(xml: string): EdgarFiling[] {
  const out: EdgarFiling[] = [];
  const seen = new Set<string>();
  for (const it of parseFeed(xml)) {
    const tm = /^(.+?)\s+-\s+(.+?)\s+\((\d{1,10})\)\s*(?:\(([^)]+)\))?\s*$/.exec(it.title);
    if (!tm) continue;
    const form = (it.category ?? tm[1]).trim();
    const accession = /accession-number=([\d-]+)/.exec(it.guid)?.[1] ?? /AccNo:\s*([\d-]+)/i.exec(it.summary)?.[1] ?? "";
    if (!accession || seen.has(accession)) continue;
    seen.add(accession);
    const filed = /Filed:\s*(\d{4}-\d{2}-\d{2})/i.exec(it.summary)?.[1] ?? null;
    const items = Array.from(it.summary.matchAll(/Item\s+(\d+\.\d+)(?::\s*([^]*?))?(?=\s*Item\s+\d+\.\d+|$)/gi))
      .map((x) => (x[2] ? `${x[1]} ${x[2].trim()}` : x[1]));
    out.push({
      form,
      company: tm[2].trim(),
      cik: tm[3].padStart(10, "0"),
      accession,
      acceptedMs: it.publishedMs,
      filingDate: filed,
      items,
      link: it.link,
    });
  }
  return out;
}

/**
 * data.sec.gov/submissions/CIK##########.json -> recent filings of the given
 * forms. acceptanceDateTime is ISO with "Z" and is read as UTC: checked live
 * on 2026-10-09 (AAPL filingDate 2026-10-08, acceptance 2026-10-09T02:30:32Z
 * = 22:30 ET on the filing date; an Eastern reading would put it on the next
 * day, after the filing date).
 */
export function parseEdgarSubmissions(
  j: any,
  forms: ReadonlySet<string>,
  sinceMs: number,
): EdgarFiling[] {
  const r = j?.filings?.recent;
  if (!r || !Array.isArray(r.accessionNumber)) return [];
  const cikNum = String(j?.cik ?? "").replace(/^0+/, "");
  const company = String(j?.name ?? "");
  const out: EdgarFiling[] = [];
  for (let i = 0; i < r.accessionNumber.length; i++) {
    const form = String(r.form?.[i] ?? "");
    if (!forms.has(form)) continue;
    const acc = String(r.accessionNumber[i]);
    const acceptedRaw = String(r.acceptanceDateTime?.[i] ?? "");
    const t = Date.parse(acceptedRaw);
    const acceptedMs = Number.isFinite(t) ? t : null;
    const filingDate = r.filingDate?.[i] ? String(r.filingDate[i]) : null;
    const ref = acceptedMs ?? (filingDate ? Date.parse(`${filingDate}T00:00:00Z`) : NaN);
    if (!Number.isFinite(ref) || ref < sinceMs) continue;
    const doc = String(r.primaryDocument?.[i] ?? "");
    const base = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc.replace(/-/g, "")}`;
    const items = String(r.items?.[i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    out.push({
      form,
      company,
      cik: cikNum.padStart(10, "0"),
      accession: acc,
      acceptedMs,
      filingDate,
      items,
      link: doc ? `${base}/${doc}` : `${base}/${acc}-index.htm`,
    });
  }
  return out;
}

// ─── Treasury Fiscal Data: upcoming auctions ─────────────────────────────

export interface TreasuryAuction {
  cusip: string;
  securityType: string;   // Bill | Note | Bond | TIPS | FRN | CMB
  securityTerm: string;   // "8-Week", "10-Year"
  auctionDate: string;    // YYYY-MM-DD
  announcementDate: string | null;
  issueDate: string | null;
  offeringUsd: number | null;
  reopening: boolean;
  recordDate: string | null;
}

/**
 * api.fiscaldata.treasury.gov .../v1/accounting/od/upcoming_auctions rows ->
 * auctions on or after fromDate, deduped by CUSIP + auction date (the newest
 * record_date wins). Fields per the dataset's meta.labels: record_date,
 * security_type, security_term, reopening, cusip, offering_amt,
 * announcemt_date, auction_date, issue_date. "null" strings stay null.
 */
export function parseUpcomingAuctions(j: any, fromDate: string): TreasuryAuction[] {
  const rows: any[] = Array.isArray(j?.data) ? j.data : [];
  const clean = (v: any): string | null => (v == null || v === "null" || v === "" ? null : String(v));
  const best = new Map<string, TreasuryAuction>();
  for (const row of rows) {
    const auctionDate = clean(row.auction_date);
    const cusip = clean(row.cusip) ?? "";
    if (!auctionDate || auctionDate < fromDate) continue;
    const amt = clean(row.offering_amt);
    const a: TreasuryAuction = {
      cusip,
      securityType: clean(row.security_type) ?? "",
      securityTerm: clean(row.security_term) ?? "",
      auctionDate,
      announcementDate: clean(row.announcemt_date),
      issueDate: clean(row.issue_date),
      offeringUsd: amt != null && Number.isFinite(Number(amt)) ? Number(amt) : null,
      reopening: String(row.reopening ?? "").toLowerCase() === "yes",
      recordDate: clean(row.record_date),
    };
    const key = `${cusip || a.securityTerm}:${auctionDate}`;
    const prev = best.get(key);
    if (!prev || (a.recordDate ?? "") > (prev.recordDate ?? "")) best.set(key, a);
  }
  return Array.from(best.values()).sort((a, b) => (a.auctionDate < b.auctionDate ? -1 : a.auctionDate > b.auctionDate ? 1 : 0));
}

/**
 * The dataset gives the auction DATE only. Each auction announcement sets
 * the close time (TreasuryDirect, "How Auctions Work":
 * https://www.treasurydirect.gov/auctions/how-auctions-work/). The calendar
 * places the event at the customary competitive close (bills/FRN/CMB 11:30
 * ET, notes/bonds/TIPS 1:00 PM ET) and marks the time as not exact.
 */
export function auctionPlacementEt(securityType: string): { hh: number; mm: number } {
  return /bill|frn|floating|cmb/i.test(securityType) ? { hh: 11, mm: 30 } : { hh: 13, mm: 0 };
}

/** Auction importance: long-duration coupons move rates vol; bills rarely do. */
export function auctionImportance(a: TreasuryAuction): "HIGH" | "MED" | "LOW" {
  if (/bill|cmb/i.test(a.securityType)) return "LOW";
  const yrs = Number(/(\d+)-Year/i.exec(a.securityTerm)?.[1] ?? NaN);
  if (Number.isFinite(yrs) && yrs >= 10) return "HIGH";
  return "MED";
}

// ─── Economic release classification (BLS / BEA calendar titles) ─────────

export interface ReleaseClass {
  family: string | null;   // join key across sources (CPI, NFP, GDP, ...)
  importance: "HIGH" | "MED" | "LOW";
  short: string;
}

const RELEASE_FAMILIES: Array<{ re: RegExp; family: string; importance: ReleaseClass["importance"]; short: string }> = [
  { re: /^employment situation/i, family: "NFP", importance: "HIGH", short: "Jobs report (NFP)" },
  { re: /^consumer price index/i, family: "CPI", importance: "HIGH", short: "CPI" },
  { re: /^producer price index/i, family: "PPI", importance: "MED", short: "PPI" },
  { re: /^job openings and labor turnover/i, family: "JOLTS", importance: "MED", short: "JOLTS" },
  { re: /^employment cost index/i, family: "ECI", importance: "MED", short: "ECI" },
  { re: /^real earnings/i, family: "REAL_EARNINGS", importance: "LOW", short: "Real Earnings" },
  { re: /^u\.s\. import and export price/i, family: "IMPORT_PRICES", importance: "LOW", short: "Import/Export Prices" },
  { re: /productivity and costs/i, family: "PRODUCTIVITY", importance: "LOW", short: "Productivity" },
  { re: /^gross domestic product(?!\s+by)/i, family: "GDP", importance: "HIGH", short: "GDP" },
  { re: /^personal income and outlays/i, family: "PCE", importance: "HIGH", short: "Personal Income & Outlays (PCE)" },
  { re: /international trade in goods and services/i, family: "TRADE", importance: "MED", short: "Trade Balance" },
];

export function classifyRelease(title: string): ReleaseClass {
  for (const f of RELEASE_FAMILIES) if (f.re.test(title.trim())) return { family: f.family, importance: f.importance, short: f.short };
  return { family: null, importance: "LOW", short: title };
}

/** Map a secondary (e.g. Nasdaq) event name to the same family keys. */
export function familyOfEventName(name: string): string | null {
  const n = name.toLowerCase();
  if (/\bcpi\b|consumer price/.test(n)) return "CPI";
  if (/\bppi\b|producer price/.test(n)) return "PPI";
  if (/nonfarm|non-farm|payrolls|unemployment rate|average hourly/.test(n)) return "NFP";
  if (/jolts|job openings/.test(n)) return "JOLTS";
  if (/employment cost/.test(n)) return "ECI";
  if (/\bgdp\b|gross domestic/.test(n)) return "GDP";
  if (/\bpce\b|personal (income|spending|consumption)/.test(n)) return "PCE";
  if (/trade balance|international trade/.test(n)) return "TRADE";
  if (/import price|export price/.test(n)) return "IMPORT_PRICES";
  if (/productivity|unit labor/.test(n)) return "PRODUCTIVITY";
  if (/real earnings/.test(n)) return "REAL_EARNINGS";
  return null;
}
