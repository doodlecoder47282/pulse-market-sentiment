// server/sources/registry.ts
//
// Inventory of every external NON-Schwab source Batcave reads, with a
// publisher tier, access method, cost, terms-of-use status and what it feeds.
// Pure data (no network, no DB) so tests and the UI can read the same table.
//
// Tiers (most to least authoritative):
//   primary    - the official issuer of the information (Federal Reserve,
//                SEC EDGAR, BLS, BEA, U.S. Treasury, CFTC) or the exchange
//                that printed the trade (Coinbase Exchange, Kraken)
//   publisher  - professional newsroom syndicating its own reporting through
//                a feed it publishes for that purpose (official RSS)
//   aggregator - reputable third party that re-serves other parties' data
//                through a documented API (DexScreener, GeckoTerminal,
//                CoinGecko, Jupiter, rugcheck, Google News)
//   computed   - derived from a published rule (exchange expiration rules),
//                not fetched
//   weak       - undocumented frontend API, social media, or an estimate.
//                Shown with an explicit label; never a sole input to a grade
//                and never a price, greeks, options or sizing input.
//
// Terms-of-use evidence (checked 2026-10-09):
//   SEC fair access: declared User-Agent "Company Name admin@domain", max 10
//     requests/second, no crawling. "Accessing EDGAR Data",
//     https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
//   SEC APIs need no key: "EDGAR Application Programming Interfaces",
//     https://www.sec.gov/edgar/sec-api-documentation
//   SEC RSS list incl. latest-filings Atom: https://www.sec.gov/about/rss-feeds
//   Federal Reserve RSS feeds: https://www.federalreserve.gov/feeds/feeds.htm
//   BLS release calendar (iCalendar): https://www.bls.gov/help/hlpical.htm
//   BEA release schedule (ICS link on the page): https://www.bea.gov/news/schedule
//     (the apps.bea.gov JSON variant is disallowed by robots.txt, so unused)
//   Treasury Fiscal Data API, open, no key: https://fiscaldata.treasury.gov/api-documentation/
//   CFTC RSS feeds: https://www.cftc.gov/RSS/index.htm
//   Coinbase Exchange public REST, 10 req/s per IP (bursts 15):
//     https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits
//   Kraken public REST Ticker/Trades, no auth:
//     https://docs.kraken.com/api/docs/rest-api/get-ticker-information
//   Jupiter Price API v3, keyless 0.5 req/s: https://developers.jup.ag/docs/api-setup.md
//   DexScreener API reference: https://docs.dexscreener.com/api/reference
//   GeckoTerminal free API, 10 calls/min: https://www.geckoterminal.com/dex-api
//   Solana public RPC: 100 req/10 s per IP, "not intended for production
//     applications": https://solana.com/docs/references/clusters
//   Reddit Data API terms: OAuth required, unauthenticated traffic blocked:
//     https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki

export type SourceTier = "primary" | "publisher" | "aggregator" | "computed" | "weak";

export type SourceArea = "news" | "calendar" | "filings" | "earnings" | "sentiment" | "crypto-majors" | "crypto-dex" | "crypto-news" | "crypto-social" | "macro-context";

export interface SourceSpec {
  id: string;
  name: string;            // short label shown next to every item
  publisher: string;       // who stands behind the content
  tier: SourceTier;
  /** Why a weak source is weak (shown in the UI). */
  weakReason?: "undocumented frontend API" | "social media" | "estimate" | "aggregator search";
  area: SourceArea;
  access: string;          // how we read it
  cost: "free";
  key: "none" | "optional env" | "contact User-Agent env";
  terms: string;           // terms-of-use status for automated access
  termsUrl: string | null;
  feeds: string;           // what it feeds in Batcave
  /** Our polling cadence (ms) after caching; respects the stated limit. */
  minIntervalMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export const SOURCES: Record<string, SourceSpec> = {
  // ── Official primary sources: news, filings, calendar ──
  fed_press: {
    id: "fed_press", name: "Federal Reserve", publisher: "Board of Governors of the Federal Reserve System",
    tier: "primary", area: "news", access: "official RSS (press_all.xml)", cost: "free", key: "none",
    terms: "official feed published for subscription", termsUrl: "https://www.federalreserve.gov/feeds/feeds.htm",
    feeds: "News headlines (FOMC statements, minutes, rules)", minIntervalMs: 5 * MIN,
  },
  fed_speeches: {
    id: "fed_speeches", name: "Fed speeches", publisher: "Board of Governors of the Federal Reserve System",
    tier: "primary", area: "news", access: "official RSS (speeches.xml)", cost: "free", key: "none",
    terms: "official feed published for subscription", termsUrl: "https://www.federalreserve.gov/feeds/feeds.htm",
    feeds: "News headlines (Board member speeches)", minIntervalMs: 10 * MIN,
  },
  sec_press: {
    id: "sec_press", name: "SEC", publisher: "U.S. Securities and Exchange Commission",
    tier: "primary", area: "news", access: "official RSS (pressreleases.rss)", cost: "free", key: "contact User-Agent env",
    terms: "SEC fair access: declared User-Agent with contact, <=10 req/s; we poll once per 10 min",
    termsUrl: "https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data",
    feeds: "News headlines (SEC press releases)", minIntervalMs: 10 * MIN,
  },
  sec_edgar_current: {
    id: "sec_edgar_current", name: "SEC EDGAR 8-K", publisher: "U.S. Securities and Exchange Commission",
    tier: "primary", area: "filings", access: "EDGAR latest-filings Atom (action=getcurrent, type=8-K)", cost: "free", key: "contact User-Agent env",
    terms: "listed on the SEC RSS page; fair access (declared User-Agent, <=10 req/s); one request per 5 min",
    termsUrl: "https://www.sec.gov/about/rss-feeds",
    feeds: "Filings wire: latest 8-K current reports, exact acceptance time", minIntervalMs: 5 * MIN,
  },
  sec_edgar_submissions: {
    id: "sec_edgar_submissions", name: "SEC EDGAR", publisher: "U.S. Securities and Exchange Commission",
    tier: "primary", area: "filings", access: "data.sec.gov submissions JSON per CIK", cost: "free", key: "contact User-Agent env",
    terms: "documented API, no key; fair access (declared User-Agent, <=10 req/s); 7 requests per 10 min",
    termsUrl: "https://www.sec.gov/edgar/sec-api-documentation",
    feeds: "Watchlist filings (8-K, 10-Q, 10-K) with acceptance time", minIntervalMs: 10 * MIN,
  },
  bls_calendar: {
    id: "bls_calendar", name: "BLS", publisher: "U.S. Bureau of Labor Statistics",
    tier: "primary", area: "calendar", access: "official iCalendar (bls.ics)", cost: "free", key: "none",
    terms: "official subscription calendar; updated weekly (Fri ~3:30 PM ET); we poll every 6 h",
    termsUrl: "https://www.bls.gov/help/hlpical.htm",
    feeds: "Economic calendar: CPI, Employment Situation, PPI, JOLTS, ECI with exact release time", minIntervalMs: 6 * HOUR,
  },
  bea_calendar: {
    id: "bea_calendar", name: "BEA", publisher: "U.S. Bureau of Economic Analysis",
    tier: "primary", area: "calendar", access: "official ICS subscription", cost: "free", key: "none",
    terms: "official subscription calendar linked from the schedule page; we poll every 6 h",
    termsUrl: "https://www.bea.gov/news/schedule",
    feeds: "Economic calendar: GDP, Personal Income and Outlays (PCE), Trade with exact release time", minIntervalMs: 6 * HOUR,
  },
  treasury_auctions: {
    id: "treasury_auctions", name: "U.S. Treasury", publisher: "U.S. Department of the Treasury, Bureau of the Fiscal Service",
    tier: "primary", area: "calendar", access: "Fiscal Data API upcoming_auctions", cost: "free", key: "none",
    terms: "open API, no registration; we poll hourly",
    termsUrl: "https://fiscaldata.treasury.gov/api-documentation/",
    feeds: "Economic calendar: announced auctions (date, term, size, CUSIP)", minIntervalMs: HOUR,
  },
  cftc_press: {
    id: "cftc_press", name: "CFTC", publisher: "Commodity Futures Trading Commission",
    tier: "primary", area: "news", access: "official RSS (rssgp.xml)", cost: "free", key: "none",
    terms: "official feed published for subscription", termsUrl: "https://www.cftc.gov/RSS/index.htm",
    feeds: "News headlines (CFTC press releases)", minIntervalMs: 10 * MIN,
  },
  // ── Professional publishers (their own syndication feeds) ──
  marketwatch: {
    id: "marketwatch", name: "MarketWatch", publisher: "Dow Jones & Company",
    tier: "publisher", area: "news", access: "Dow Jones RSS host (feeds.content.dj-n.com)", cost: "free", key: "none",
    terms: "publisher RSS for headline + link display with attribution; full text stays on the publisher site",
    termsUrl: null, feeds: "News headlines", minIntervalMs: 2 * MIN,
  },
  cnbc: {
    id: "cnbc", name: "CNBC Markets", publisher: "CNBC (NBCUniversal)",
    tier: "publisher", area: "news", access: "publisher RSS", cost: "free", key: "none",
    terms: "publisher RSS for headline + link display with attribution; full text stays on the publisher site",
    termsUrl: null, feeds: "News headlines", minIntervalMs: 2 * MIN,
  },
  ft: {
    id: "ft", name: "FT Markets", publisher: "The Financial Times",
    tier: "publisher", area: "news", access: "publisher RSS (section ?format=rss)", cost: "free", key: "none",
    terms: "publisher RSS for headline + link display with attribution; articles are paywalled",
    termsUrl: null, feeds: "News headlines", minIntervalMs: 2 * MIN,
  },
  google_news_reuters: {
    id: "google_news_reuters", name: "Google News (Reuters search)", publisher: "Google News aggregator; stories by Reuters",
    tier: "aggregator", weakReason: "aggregator search", area: "news", access: "Google News RSS search (Reuters discontinued its public RSS)", cost: "free", key: "none",
    terms: "aggregator RSS; secondary only, never the sole headline source",
    termsUrl: null, feeds: "News headlines (secondary)", minIntervalMs: 5 * MIN,
  },
  // ── Calendar / earnings secondaries ──
  nasdaq_econ: {
    id: "nasdaq_econ", name: "Nasdaq (unofficial API)", publisher: "Nasdaq.com",
    tier: "weak", weakReason: "undocumented frontend API", area: "calendar", access: "api.nasdaq.com calendar JSON used by nasdaq.com pages", cost: "free", key: "none",
    terms: "undocumented; no published terms for automated use. Secondary: consensus/previous values only; official release times win",
    termsUrl: null, feeds: "Economic calendar consensus and events not on the BLS/BEA calendars (Census, ISM, claims)", minIntervalMs: 30 * MIN,
  },
  nasdaq_earnings: {
    id: "nasdaq_earnings", name: "Nasdaq (unofficial API)", publisher: "Nasdaq.com",
    tier: "weak", weakReason: "undocumented frontend API", area: "earnings", access: "api.nasdaq.com earnings calendar JSON", cost: "free", key: "none",
    terms: "undocumented; no published terms for automated use. No free official forward earnings-date source exists (SEC filings are after the fact)",
    termsUrl: null, feeds: "Earnings calendar", minIntervalMs: 30 * MIN,
  },
  mag7_baseline: {
    id: "mag7_baseline", name: "Estimated date", publisher: "Batcave hardcoded baseline",
    tier: "weak", weakReason: "estimate", area: "earnings", access: "static table", cost: "free", key: "none",
    terms: "n/a (shown only for dates Nasdaq failed, labeled estimated)", termsUrl: null,
    feeds: "Earnings calendar fallback (MAG7 only)", minIntervalMs: 0,
  },
  exchange_rules: {
    id: "exchange_rules", name: "Exchange rule (computed)", publisher: "Cboe expiration rules",
    tier: "computed", area: "calendar", access: "date arithmetic", cost: "free", key: "none",
    terms: "n/a", termsUrl: null, feeds: "OPEX, VIX expiration, quarterly expirations", minIntervalMs: 0,
  },
  // ── Sentiment context ──
  cnn_fear_greed: {
    id: "cnn_fear_greed", name: "CNN Fear & Greed", publisher: "CNN Business",
    tier: "weak", weakReason: "undocumented frontend API", area: "sentiment", access: "dataviz JSON behind cnn.com page", cost: "free", key: "none",
    terms: "undocumented endpoint; context only, labeled with its timestamp", termsUrl: null,
    feeds: "Signals sentiment gauge (context only)", minIntervalMs: 5 * MIN,
  },
  stocktwits: {
    id: "stocktwits", name: "StockTwits", publisher: "StockTwits",
    tier: "weak", weakReason: "social media", area: "sentiment", access: "public symbol stream JSON", cost: "free", key: "none",
    terms: "public stream, no registration; social chatter, context only", termsUrl: null,
    feeds: "Signals social gauge (context only)", minIntervalMs: 2 * MIN,
  },
  reddit: {
    id: "reddit", name: "Reddit", publisher: "Reddit",
    tier: "weak", weakReason: "social media", area: "sentiment", access: "DROPPED (no Reddit request is made)",
    cost: "free", key: "none",
    terms: "Reddit Data API requires a registered OAuth client; unauthenticated traffic is blocked, so the keyless read was removed",
    termsUrl: "https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki",
    feeds: "dropped from the Signals social gauge and the Ticker Outlook mention scan (shown as not available, never 0)",
    minIntervalMs: 0,
  },
  // ── Crypto majors (exchange-direct) ──
  coinbase: {
    id: "coinbase", name: "Coinbase Exchange", publisher: "Coinbase",
    tier: "primary", area: "crypto-majors", access: "public REST /products/{id}/ticker and /trades", cost: "free", key: "none",
    terms: "public endpoints, 10 req/s per IP; we use 6 requests per 60 s",
    termsUrl: "https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits",
    feeds: "BTC/ETH/SOL top of book, last trade, taker flow", minIntervalMs: MIN,
  },
  kraken: {
    id: "kraken", name: "Kraken", publisher: "Payward (Kraken)",
    tier: "primary", area: "crypto-majors", access: "public REST /0/public/Ticker and /Trades", cost: "free", key: "none",
    terms: "public endpoints, no auth; per-client counter max 15, decay 0.33/s (https://docs.kraken.com/exchange/guides/rest/ratelimits.md); we use 4 requests per 60 s",
    termsUrl: "https://docs.kraken.com/api/docs/rest-api/get-ticker-information",
    feeds: "BTC/ETH/SOL top of book, last trade, taker flow, cross-check", minIntervalMs: MIN,
  },
  coingecko: {
    id: "coingecko", name: "CoinGecko (reference)", publisher: "CoinGecko",
    tier: "aggregator", area: "crypto-majors", access: "Demo API simple/price (free key, optional env BATCAVE_COINGECKO_DEMO_KEY)", cost: "free", key: "optional env",
    terms: "keyless tier is documented as not for scheduled polling, so it is read only with a free Demo key (100 calls/min); one call per 5 min; reference only, never in the exchange cross-check",
    termsUrl: "https://docs.coingecko.com/docs/keyless-public-api.md", feeds: "Crypto majors reference price", minIntervalMs: 5 * MIN,
  },
  // ── Solana DEX ──
  dexscreener: {
    id: "dexscreener", name: "DexScreener", publisher: "DexScreener",
    tier: "aggregator", area: "crypto-dex", access: "documented public API", cost: "free", key: "none",
    terms: "documented API; boosts 60 rpm, pairs batched (3 calls per 75 s)",
    termsUrl: "https://docs.dexscreener.com/api/reference",
    feeds: "Pairs, liquidity, volume, buys/sells (primary DEX input)", minIntervalMs: 75_000,
  },
  geckoterminal: {
    id: "geckoterminal", name: "GeckoTerminal", publisher: "CoinGecko",
    tier: "aggregator", area: "crypto-dex", access: "documented public API v2", cost: "free", key: "none",
    terms: "keyless public API, about 10 calls/min; CoinGecko documents the keyless tier as not meant for scheduled polling (https://docs.coingecko.com/docs/keyless-public-api.md). OPEN TERMS RISK: the scanner polls 2 calls/min; no keyless documented alternative for new-pool discovery was found",
    termsUrl: "https://www.geckoterminal.com/dex-api",
    feeds: "New and trending Solana pools (discovery)", minIntervalMs: MIN,
  },
  jupiter: {
    id: "jupiter", name: "Jupiter Price v3", publisher: "Jupiter",
    tier: "aggregator", area: "crypto-dex", access: "keyless api.jup.ag/price/v3", cost: "free", key: "none",
    terms: "keyless 0.5 req/s; we send 1 request per 75 s",
    termsUrl: "https://developers.jup.ag/docs/api-setup.md",
    feeds: "DEX pool price cross-check against DexScreener; a >15% gap or no reliable Jupiter price holds ENTER at WATCH", minIntervalMs: 75_000,
  },
  solana_rpc: {
    id: "solana_rpc", name: "Solana RPC", publisher: "Solana Foundation / PublicNode",
    tier: "primary", area: "crypto-dex", access: "public JSON-RPC (mainnet-beta, publicnode)", cost: "free", key: "none",
    terms: "public endpoints are rate limited and not meant for production load; 3 calls per 45 s",
    termsUrl: "https://solana.com/docs/references/clusters",
    feeds: "On-chain mint/freeze authority, holder concentration", minIntervalMs: 45_000,
  },
  rugcheck: {
    id: "rugcheck", name: "rugcheck.xyz", publisher: "RugCheck",
    tier: "aggregator", area: "crypto-dex", access: "public report summary API", cost: "free", key: "none",
    terms: "public keyless API (terms not published); cached third-party analysis; flags only, never a hard kill", termsUrl: null,
    feeds: "LP lock and named risks", minIntervalMs: 45_000,
  },
  pumpfun: {
    id: "pumpfun", name: "pump.fun (unofficial)", publisher: "pump.fun",
    tier: "weak", weakReason: "undocumented frontend API", area: "crypto-social", access: "frontend-api-v3 coin object", cost: "free", key: "none",
    terms: "undocumented frontend API with no published terms; kept because no documented source gives reply counts; attention proxy only",
    termsUrl: null, feeds: "Reply velocity, livestream flag (attention proxy shown and logged; not in the score, verdict or RUGGED/DEAD grading)", minIntervalMs: 5 * MIN,
  },
  bluesky: {
    id: "bluesky", name: "Bluesky", publisher: "Bluesky Social (AT Protocol AppView)",
    tier: "weak", weakReason: "social media", area: "crypto-social", access: "documented app.bsky.feed.searchPosts", cost: "free", key: "none",
    terms: "documented public AppView endpoint; low-grade attention proxy, never a fundamental input",
    termsUrl: "https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/searchPosts.json",
    feeds: "Mention counts (low-grade attention proxy shown and logged; not in the score, verdict or RUGGED/DEAD grading)", minIntervalMs: 5 * MIN,
  },
  coindesk: {
    id: "coindesk", name: "CoinDesk", publisher: "CoinDesk",
    tier: "publisher", area: "crypto-news", access: "publisher RSS", cost: "free", key: "none",
    terms: "publisher RSS; titles only for narrative keyword heat", termsUrl: null,
    feeds: "Crypto narrative heat (confirms, never triggers)", minIntervalMs: 5 * MIN,
  },
  theblock: {
    id: "theblock", name: "The Block", publisher: "The Block",
    tier: "publisher", area: "crypto-news", access: "publisher RSS", cost: "free", key: "none",
    terms: "publisher RSS; titles only", termsUrl: null,
    feeds: "Crypto narrative heat", minIntervalMs: 5 * MIN,
  },
  decrypt: {
    id: "decrypt", name: "Decrypt", publisher: "Decrypt",
    tier: "publisher", area: "crypto-news", access: "publisher RSS", cost: "free", key: "none",
    terms: "publisher RSS; titles only", termsUrl: null,
    feeds: "Crypto narrative heat", minIntervalMs: 5 * MIN,
  },
};

/**
 * Context sources read by modules outside this workstream (inventory only:
 * listed so the source table is complete; their adapters live in the named
 * files). Terms marked "not re-verified" were not re-checked this round.
 */
export const CONTEXT_SOURCES: Record<string, SourceSpec> = {
  fred: {
    id: "fred", name: "FRED", publisher: "Federal Reserve Bank of St. Louis",
    tier: "primary", area: "macro-context", access: "fredgraph.csv public series download (server/fredClient.ts)", cost: "free", key: "none",
    terms: "public download link behind FRED graphs; the documented FRED API needs a free key. Not re-verified this round",
    termsUrl: "https://fred.stlouisfed.org/docs/api/terms_of_use.html", feeds: "Regime / macro context (never a price input)", minIntervalMs: HOUR,
  },
  cftc_cot: {
    id: "cftc_cot", name: "CFTC COT", publisher: "Commodity Futures Trading Commission",
    tier: "primary", area: "macro-context", access: "publicreporting.cftc.gov Socrata API (server/cotClient.ts)", cost: "free", key: "none",
    terms: "official public reporting API; weekly data. Not re-verified this round", termsUrl: "https://publicreporting.cftc.gov/",
    feeds: "Positioning context (never a price input)", minIntervalMs: HOUR,
  },
  noaa_swpc: {
    id: "noaa_swpc", name: "NOAA SWPC", publisher: "NOAA Space Weather Prediction Center",
    tier: "primary", area: "macro-context", access: "services.swpc.noaa.gov JSON (server/cosmos.ts)", cost: "free", key: "none",
    terms: "U.S. government public data. Not re-verified this round", termsUrl: "https://www.swpc.noaa.gov/",
    feeds: "Cosmos tab (Kp index)", minIntervalMs: HOUR,
  },
  frankfurter: {
    id: "frankfurter", name: "Frankfurter (ECB rates)", publisher: "Frankfurter open-source API serving ECB euro reference rates",
    tier: "aggregator", area: "macro-context", access: "api.frankfurter.dev (server/macro.ts)", cost: "free", key: "none",
    terms: "keyless open API; ECB reference rates are published for information only, once per business day. Not re-verified this round",
    termsUrl: "https://frankfurter.dev/", feeds: "FX context (never a price input)", minIntervalMs: HOUR,
  },
  google_news_voices: {
    id: "google_news_voices", name: "Google News (Voices)", publisher: "Google News aggregator",
    tier: "aggregator", weakReason: "aggregator search", area: "macro-context", access: "Google News RSS search per named commentator (server/voices.ts)", cost: "free", key: "none",
    terms: "aggregator RSS search; secondary context only", termsUrl: null, feeds: "Voices panel", minIntervalMs: 10 * MIN,
  },
  x_api: {
    id: "x_api", name: "X API", publisher: "X Corp.",
    tier: "weak", weakReason: "social media", area: "macro-context", access: "api.twitter.com v2 recent search with optional X_BEARER_TOKEN (server/x.ts, server/tickerAlpha.ts)", cost: "free", key: "optional env",
    terms: "official API, keyed; social posts, context only; disabled when the token is empty", termsUrl: "https://developer.x.com/en/developer-terms",
    feeds: "Voices panel, Ticker Outlook social", minIntervalMs: 5 * MIN,
  },
  stocktwits_ticker: {
    id: "stocktwits_ticker", name: "StockTwits (Ticker Outlook)", publisher: "StockTwits",
    tier: "weak", weakReason: "social media", area: "macro-context", access: "public symbol stream JSON (server/tickerAlpha.ts)", cost: "free", key: "none",
    terms: "public stream, no registration; social chatter, context only", termsUrl: null, feeds: "Ticker Outlook social", minIntervalMs: 5 * MIN,
  },
};

export const TIER_RANK: Record<SourceTier, number> = { primary: 0, publisher: 1, aggregator: 2, computed: 3, weak: 4 };

export const TIER_LABEL: Record<SourceTier, string> = {
  primary: "official",
  publisher: "publisher",
  aggregator: "aggregator",
  computed: "computed",
  weak: "unofficial",
};

export function sourceSpec(id: string): SourceSpec {
  const s = SOURCES[id];
  if (!s) throw new Error(`unknown source id ${id}`);
  return s;
}

/** Public, client-safe view of the table (no secrets live here; it is static). */
export function sourceTable(area?: SourceArea): SourceSpec[] {
  return [...Object.values(SOURCES), ...Object.values(CONTEXT_SOURCES)]
    .filter((s) => !area || s.area === area)
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.name.localeCompare(b.name));
}
