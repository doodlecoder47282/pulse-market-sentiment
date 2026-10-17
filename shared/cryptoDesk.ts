/** Read-only research contracts. Receipt time is never substituted for event time. */
export type EvidenceState = "HEALTHY" | "PARTIAL" | "STALE" | "UNAVAILABLE" | "DISABLED" | "UNKNOWN";
export interface DeskSource {
  id: string; name: string; role: string; url: string; state: EvidenceState;
  fetchedAt: number | null; observedAt: number | null; cadence: string; limitation: string;
}
export interface DeskHeadline {
  id: string; title: string; url: string; publisher: string;
  publishedAt: number | null; firstSeenAt: number; group: "crypto" | "macro";
}
export interface LiquidQuote {
  symbol: "BTC" | "ETH"; product: string; venue: string; currency: "USD";
  price: number | null; bid: number | null; ask: number | null;
  spreadBps: number | null; change24hPct: number | null; volumeBase24h: number | null;
  high24h: number | null; low24h: number | null; observedAt: number | null;
  fetchedAt: number; state: EvidenceState; note: string; url: string;
}
export interface MacroObservation {
  id: string; label: string; value: number | null; unit: string;
  date: string | null; fetchedAt: number | null; state: EvidenceState; url: string;
}
export interface CryptoContext {
  version: string; asOf: number; quotes: LiquidQuote[]; news: DeskHeadline[];
  macro: MacroObservation[]; sources: DeskSource[]; gaps: string[];
  derivatives: DerivativeObservation[]; chainActivity: ChainActivity[];
}
export interface DerivativeObservation {
  instrument: string; venue: string; observedAt: number | null; fetchedAt: number;
  openInterestUsd: number | null; funding8hRaw: number | null; markPremiumBps: number | null;
  state: EvidenceState; url: string;
}
export interface ChainActivity { chain: string; tvlUsd: number | null; fetchedAt: number; state: EvidenceState; }
export const CRYPTO_DESK_VERSION = "crypto-desk-2026-09-30.1";

export function finiteNumber(value: unknown): number | null {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function evidenceAge(observedAt: number | null, now: number, maxAge: number): EvidenceState {
  if (observedAt == null || !Number.isFinite(observedAt)) return "UNKNOWN";
  if (observedAt > now + 5000) return "UNKNOWN";
  return now - observedAt > maxAge ? "STALE" : "HEALTHY";
}
export function safeNewsUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) return null;
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.href;
  } catch { return null; }
}
function text(raw: string): string {
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}
export function parseDeskRss(xml: string, publisher: string, group: DeskHeadline["group"], now: number): DeskHeadline[] {
  if (!/<(?:rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new Error("Expected RSS/Atom, not an HTML success page");
  const rows: DeskHeadline[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const body = m[2];
    const title = text(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const rawUrl = body.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]
      ?? body.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ?? "";
    const url = safeNewsUrl(text(rawUrl));
    if (!title || !url) continue;
    const rawDate = body.match(/<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\//i)?.[1];
    const date = rawDate ? Date.parse(text(rawDate)) : NaN;
    const publishedAt = Number.isFinite(date) && date <= now + 300_000 ? date : null;
    rows.push({ id: `${publisher}:${url}`, title: title.slice(0, 300), url, publisher, publishedAt, firstSeenAt: now, group });
    if (rows.length >= 60) break;
  }
  if (!rows.length) throw new Error("Feed has no usable entries");
  return rows;
}
export function dedupeHeadlines(rows: DeskHeadline[]): DeskHeadline[] {
  const seen = new Set<string>();
  return rows.filter(r => {
    // Exact URL duplicates only. Similar reporting is not presumed syndicated.
    if (seen.has(r.url)) return false;
    seen.add(r.url); return true;
  }).sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
}
export function normalizeLiquidQuote(symbol: "BTC" | "ETH", ticker: any, stats: any, now: number): LiquidQuote {
  const price = finiteNumber(ticker?.price), bid = finiteNumber(ticker?.bid), ask = finiteNumber(ticker?.ask);
  const eventTime = Date.parse(ticker?.time ?? "");
  const observedAt = Number.isFinite(eventTime) ? eventTime : null;
  const usable = price != null && price > 0 && bid != null && bid > 0 && ask != null && ask >= bid;
  const state = usable ? evidenceAge(observedAt, now, 120_000) : "UNAVAILABLE";
  const open = finiteNumber(stats?.open);
  const high = finiteNumber(stats?.high), low = finiteNumber(stats?.low);
  const rangeValid = high != null && low != null && low > 0 && high >= low;
  return { symbol, product: `${symbol}-USD`, venue: "Coinbase Exchange", currency: "USD",
    price: usable ? price : null, bid: usable ? bid : null, ask: usable ? ask : null,
    spreadBps: usable ? (ask! - bid!) / ((ask! + bid!) / 2) * 10000 : null,
    change24hPct: usable && open != null && open > 0 ? (price! / open - 1) * 100 : null,
    volumeBase24h: finiteNumber(ticker?.volume) != null && Number(ticker.volume) >= 0 ? Number(ticker.volume) : null,
    high24h: rangeValid ? high : null, low24h: rangeValid ? low : null, observedAt, fetchedAt: now,
    state: state === "HEALTHY" && !rangeValid ? "PARTIAL" : state,
    note: "REST observation, not a streaming order book. Trade time is provider time; 24h statistics have receipt time only. Single venue; no execution or target inference.",
    url: `https://api.exchange.coinbase.com/products/${symbol}-USD/ticker` };
}
export function normalizeDerivative(instrument: string, result: any, now: number): DerivativeObservation {
  const valid = ["BTC-PERPETUAL", "ETH-PERPETUAL"].includes(instrument) && result?.instrument_name === instrument && result?.state === "open";
  const mark = finiteNumber(result?.mark_price), index = finiteNumber(result?.index_price), oi = finiteNumber(result?.open_interest);
  const funding = finiteNumber(result?.funding_8h);
  const observedAt = finiteNumber(result?.timestamp);
  const age = evidenceAge(observedAt, now, 180000);
  const complete = oi != null && oi >= 0 && mark != null && mark > 0 && index != null && index > 0 && funding != null;
  return { instrument, venue: "Deribit", observedAt, fetchedAt: now,
    openInterestUsd: valid && oi != null && oi >= 0 ? oi : null,
    funding8hRaw: valid ? funding : null,
    markPremiumBps: valid && mark != null && mark > 0 && index != null && index > 0 ? (mark / index - 1) * 10000 : null,
    state: valid ? age === "HEALTHY" && !complete ? "PARTIAL" : age : "UNAVAILABLE",
    url: `https://www.deribit.com/api/v2/public/ticker?instrument_name=${instrument}` };
}
export function summarizeSocialPosts(posts: any[], now: number, options: { limit?: number; hasMore?: boolean; identity?: string } = {}) {
  const seen = new Set<string>();
  const rows = posts.filter(p => {
    const id = String(p?.uri ?? "");
    if (!id || seen.has(id)) return false;
    seen.add(id); return true;
  }).map(p => ({ at: Date.parse(p?.record?.createdAt ?? ""), author: p?.author?.did,
    text: String(p?.record?.text ?? "").toLowerCase().replace(/\s+/g, " ").trim() }))
    .filter(p => Number.isFinite(p.at) && p.at <= now && now - p.at < 3600000);
  const authors = new Set(rows.map(p => p.author).filter(a => typeof a === "string" && a));
  const recent = rows.filter(p => now - p.at < 600000);
  const recentAuthors = new Set(recent.map(p => p.author).filter(a => typeof a === "string" && a));
  const texts = new Set(rows.map(p => p.text).filter(Boolean));
  return { sampledPosts: posts.length, mentions1h: rows.length, mentions10m: recent.length,
    uniqueAuthors1h: authors.size, uniqueAuthors10m: recentAuthors.size,
    repeatedTextShare: rows.length ? 1 - texts.size / rows.length : null,
    capped: !!options.hasMore || posts.length >= (options.limit ?? 25),
    timestampsComplete: posts.every(p => Number.isFinite(Date.parse(p?.record?.createdAt ?? "")) &&
      Date.parse(p.record.createdAt) <= now),
    identity: options.identity ?? "cashtag sample, not verified mint attribution" };
}
