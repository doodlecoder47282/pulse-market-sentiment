import { sqlite } from "./storage";
import { CRYPTO_DESK_VERSION, dedupeHeadlines, evidenceAge, normalizeLiquidQuote, parseDeskRss,
  normalizeDerivative, finiteNumber, type DerivativeObservation, type ChainActivity,
  type CryptoContext, type DeskHeadline, type DeskSource, type LiquidQuote, type MacroObservation } from "../shared/cryptoDesk";

// Fixed read-only URLs, never user-controlled fetches. A cache single-flight
// coalesces all viewers. No model, private exchange endpoint, cookie or key.
const NEWS_SOURCES = [
  { id: "coindesk", name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", group: "crypto" },
  { id: "theblock", name: "The Block", url: "https://www.theblock.co/rss.xml", group: "crypto" },
  { id: "decrypt", name: "Decrypt", url: "https://decrypt.co/feed", group: "crypto" },
  { id: "yahoo-news", name: "Yahoo Finance news", url: "https://finance.yahoo.com/news/rssindex", group: "macro" },
  { id: "fed", name: "Federal Reserve releases", url: "https://www.federalreserve.gov/feeds/press_all.xml", group: "macro" },
  { id: "bls", name: "BLS releases", url: "https://www.bls.gov/feed/bls_latest.rss", group: "macro" },
] as const;
type NewsSnapshot = { at: number; rows: DeskHeadline[]; sources: DeskSource[] };
let newsCache: NewsSnapshot | null = null;
let newsFlight: Promise<NewsSnapshot> | null = null;
let marketCache: { at: number; rows: LiquidQuote[] } | null = null;
let marketFlight: Promise<LiquidQuote[]> | null = null;
let derivativeCache: { at: number; rows: DerivativeObservation[] } | null = null;
let derivativeFlight: Promise<DerivativeObservation[]> | null = null;
let chainCache: { at: number; rows: ChainActivity[] } | null = null;
let chainFlight: Promise<ChainActivity[]> | null = null;
const firstSeen = new Map<string, number>();

async function readBody(url: string, json: boolean) {
  const signal = AbortSignal.timeout(7000);
  const original = new URL(url); let target = original;
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(target, { signal, redirect: "manual",
      headers: { "user-agent": "BatcaveResearch/1.0", accept: json ? "application/json" : "application/rss+xml, application/xml, text/xml" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Redirect missing location");
      const next = new URL(location, target);
      if (next.protocol !== "https:" || next.hostname.replace(/^www\./, "") !== original.hostname.replace(/^www\./, "") ||
          next.username || next.password || (next.port && next.port !== "443")) throw new Error("Unapproved redirect");
      target = next; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty response");
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > 2_000_000) { await reader.cancel(); throw new Error("Response over limit"); }
      chunks.push(part.value);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return json ? JSON.parse(raw) : raw;
  }
  throw new Error("Redirect limit");
}
export async function getCryptoNews(): Promise<NewsSnapshot> {
  if (newsCache && Date.now() - newsCache.at < 300_000) return newsCache;
  if (newsFlight) return newsFlight;
  newsFlight = (async () => {
    const rows: DeskHeadline[] = []; const sources: DeskSource[] = [];
    // Sequential, bounded six-feed sweep. No retry storm or duplicated narrative loop.
    for (const source of NEWS_SOURCES) {
      const fetchedAt = Date.now();
      let items: DeskHeadline[] = [], error: string | null = null;
      try {
        items = parseDeskRss(await readBody(source.url, false), source.name, source.group, fetchedAt);
        for (const item of items) {
          if (!firstSeen.has(item.id)) firstSeen.set(item.id, fetchedAt);
          item.firstSeenAt = firstSeen.get(item.id)!;
        }
      } catch (e: any) { error = String(e?.message ?? "Unavailable").slice(0, 100); }
      const dates = items.flatMap(r => r.publishedAt == null ? [] : [r.publishedAt]);
      const observedAt = dates.length ? Math.max(...dates) : null;
      const cadenceLimit = source.group === "macro" ? 14 * 86400_000 : 3 * 86400_000;
      const age = evidenceAge(observedAt, fetchedAt, cadenceLimit);
      sources.push({ id: source.id, name: source.name, role: `${source.group} headlines`, url: source.url,
        state: error ? "UNAVAILABLE" : age === "HEALTHY" && items.some(i => i.publishedAt == null) ? "PARTIAL" : age,
        fetchedAt, observedAt, cadence: "5 minute shared cache",
        limitation: error ? `${error}; no fresh headlines substituted.` :
          "Public headline metadata only; publisher link for full text. Not complete coverage or verified mint-specific news. Redistribution rights not certified." });
      rows.push(...items);
    }
    while (firstSeen.size > 1500) firstSeen.delete(firstSeen.keys().next().value!);
    newsCache = { at: Date.now(), rows: dedupeHeadlines(rows).slice(0, 150), sources };
    return newsCache;
  })().finally(() => { newsFlight = null; });
  return newsFlight;
}
async function getLiquidQuotes(): Promise<LiquidQuote[]> {
  if (marketCache && Date.now() - marketCache.at < 60_000) return marketCache.rows;
  if (marketFlight) return marketFlight;
  marketFlight = (async () => {
    const rows: LiquidQuote[] = [];
    for (const symbol of ["BTC", "ETH"] as const) {
      const root = `https://api.exchange.coinbase.com/products/${symbol}-USD`;
      let ticker: any = null, stats: any = null;
      try { ticker = await readBody(`${root}/ticker`, true); } catch { /* unknown, not zero */ }
      try { stats = await readBody(`${root}/stats`, true); } catch { /* partial */ }
      rows.push(normalizeLiquidQuote(symbol, ticker, stats, Date.now()));
    }
    marketCache = { at: Date.now(), rows }; return rows;
  })().finally(() => { marketFlight = null; });
  return marketFlight;
}
function macroContext(): MacroObservation[] {
  const series = [
    ["DGS10", "10Y Treasury yield", "%", 5],
    ["DGS2", "2Y Treasury yield", "%", 5],
    ["DTWEXBGS", "Broad dollar index", "index", 7],
    ["BAMLH0A0HYM2", "High-yield credit spread", "%", 5],
    ["WALCL", "Fed balance sheet", "USD millions", 14],
    ["CPIAUCSL", "Consumer price index", "index", 50],
  ] as const;
  return series.map(([id, label, unit, days]) => {
    const r = sqlite.prepare("SELECT date, value, refreshed_at FROM fred_series WHERE series_id = ? AND value IS NOT NULL ORDER BY date DESC LIMIT 1")
      .get(id) as { date: string; value: number; refreshed_at: number } | undefined;
    const dateMs = r ? Date.parse(`${r.date}T00:00:00Z`) : NaN;
    return { id, label, unit, value: r?.value ?? null, date: r?.date ?? null, fetchedAt: r?.refreshed_at ?? null,
      state: r ? evidenceAge(dateMs, Date.now(), days * 86400_000) : "UNAVAILABLE",
      url: `https://fred.stlouisfed.org/series/${id}` };
  });
}
async function getDerivatives() {
  if (derivativeCache && Date.now() - derivativeCache.at < 120000) return derivativeCache.rows;
  if (derivativeFlight) return derivativeFlight;
  derivativeFlight = (async () => {
    const rows: DerivativeObservation[] = [];
    for (const instrument of ["BTC-PERPETUAL", "ETH-PERPETUAL"]) {
      let result: any = null;
      try { result = (await readBody(`https://www.deribit.com/api/v2/public/ticker?instrument_name=${instrument}`, true))?.result; } catch { /* restriction/outage is unavailable, never bypassed */ }
      rows.push(normalizeDerivative(instrument, result, Date.now()));
    }
    derivativeCache = { at: Date.now(), rows }; return rows;
  })().finally(() => { derivativeFlight = null; });
  return derivativeFlight;
}
async function getChainActivity() {
  if (chainCache && Date.now() - chainCache.at < 900000) return chainCache.rows;
  if (chainFlight) return chainFlight;
  chainFlight = (async () => {
    let values: any[] = [];
    try { const data = await readBody("https://api.llama.fi/v2/chains", true); if (Array.isArray(data)) values = data; } catch { /* explicit unavailable */ }
    const rows: ChainActivity[] = ["Ethereum", "Solana"].map(chain => {
      const tvlUsd = finiteNumber(values.find(v => v.name === chain)?.tvl);
      return { chain, tvlUsd: tvlUsd != null && tvlUsd >= 0 ? tvlUsd : null, fetchedAt: Date.now(),
        state: tvlUsd != null && tvlUsd >= 0 ? "PARTIAL" : "UNAVAILABLE" };
    });
    chainCache = { at: Date.now(), rows }; return rows;
  })().finally(() => { chainFlight = null; });
  return chainFlight;
}
export async function getCryptoContext(): Promise<CryptoContext> {
  const [quotes, news, derivatives, chainActivity] = await Promise.all([
    getLiquidQuotes(), getCryptoNews(), getDerivatives(), getChainActivity(),
  ]);
  const macro = macroContext();
  return { version: CRYPTO_DESK_VERSION, asOf: Date.now(), quotes, news: news.rows, macro, derivatives, chainActivity,
    sources: [
      ...quotes.map(q => ({ id: q.product, name: q.product, role: "Single-venue spot market", url: q.url, state: q.state,
        fetchedAt: q.fetchedAt, observedAt: q.observedAt, cadence: "60 second shared cache", limitation: q.note })),
      ...news.sources,
      ...derivatives.map(d => ({ id: d.instrument, name: d.instrument, role: "Inverse perpetual context", url: d.url,
        state: d.state, fetchedAt: d.fetchedAt, observedAt: d.observedAt, cadence: "2 minute shared cache",
        limitation: "One venue. OI in USD for these inverse contracts; raw funding_8h preserved, not annualized. Mark premium is mark/index minus one, not cross-venue basis. No trading access." })),
      { id: "defillama", name: "DefiLlama chain TVL", role: "Chain-level DeFi context", url: "https://api.llama.fi/v2/chains",
        state: chainActivity.some(c => c.tvlUsd != null) ? "PARTIAL" : "UNAVAILABLE", fetchedAt: chainCache?.at ?? null,
        observedAt: null, cadence: "15 minute shared cache", limitation: "Receipt time only; underlying observation time not supplied. TVL is not inflow, stablecoin supply, volume or token demand." },
      ...macro.map(m => ({ id: m.id, name: m.label, role: "Macro context", url: m.url, state: m.state,
        fetchedAt: m.fetchedAt, observedAt: m.date ? Date.parse(`${m.date}T00:00:00Z`) : null,
        cadence: "Existing FRED cache; series-specific age gate", limitation: "Observation date, not release timestamp. Latest revised history, not a vintage-safe surprise or backtest input." })),
    ], gaps: [
      "Streaming depth and gap-repaired trades are not connected; spot quotes are sampled.",
      "Derivatives are single-venue observations only; consolidated liquidations and historical changes are not integrated.",
      "Stablecoin supply and token unlock feeds are not integrated; chain TVL cannot substitute for either.",
      "X is disabled. Sampled Bluesky and pump.fun proxies do not measure the whole social market.",
      "Mint-specific event history, verified pool vaults, unique wallets and sell-route simulation remain unavailable.",
      "Headline clustering, durable first-seen history and point-in-time macro vintages remain incomplete.",
      "No executable sizing, order placement, calibrated probability or institutional-readiness claim.",
    ] };
}
