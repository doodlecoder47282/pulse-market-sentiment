// server/wef-themes.ts
// WEF Theme Mapper — scans weforum.org content for the big thematic tags
// (AI, Energy Transition, Cybersecurity, Quantum, Space, Supply Chains,
// Global Risks, etc.), counts mentions, and maps each theme to a curated
// basket of tickers. Then scores basket leaders by 1M relative strength vs
// SPY so you can see which stocks are actually following the narrative.
//
// No public WEF API exists — we scrape the public stories feed. Falls back
// to the baseline mention counts (all = 1) if the scrape fails, so the
// feature still renders.
//
// Cache: 2-hour TTL (themes don't move fast, and we want to stay polite).

import type { WefTheme, WefThemeResponse } from "@shared/schema";

const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0; +market-research)";

// ----- Theme -> ticker basket map -----
// Baskets are curated. Each theme: keywords (scored on mentions) + basket
// (tickers that benefit from the narrative). Basket sizes kept to 5-10 so
// the UI stays legible and the RS leader signal is meaningful.

interface ThemeDef {
  id: string;
  label: string;
  blurb: string;
  /** Case-insensitive substrings; each occurrence counts as 1 mention. */
  keywords: string[];
  basket: string[];
}

export const THEMES: ThemeDef[] = [
  {
    id: "ai",
    label: "Artificial Intelligence",
    blurb: "WEF's Centre for AI Excellence + flagship AI governance work. Global push on frontier-model regulation, workforce disruption, and infrastructure buildout.",
    keywords: ["artificial intelligence", "ai governance", "ai excellence", "generative ai", "foundation model", " ai "],
    basket: ["NVDA", "MSFT", "GOOGL", "META", "AMZN", "AVGO", "ORCL", "PLTR"],
  },
  {
    id: "energy",
    label: "Energy Transition",
    blurb: "Centre for Energy and Materials. Decarbonization, grid buildout, renewable scaling, and the return of nuclear as a baseload solution.",
    keywords: ["energy transition", "decarbonization", "renewable", "clean energy", "grid ", "electrification"],
    basket: ["NEE", "FSLR", "ENPH", "GEV", "VST", "CEG", "ICLN"],
  },
  {
    id: "nuclear",
    label: "Nuclear & Quantum Energy",
    blurb: "Rapidly rising WEF theme — small modular reactors + quantum approaches to fusion control and grid optimization.",
    keywords: ["nuclear", "smr ", "small modular reactor", "quantum for energy", "fusion"],
    basket: ["CEG", "VST", "SMR", "BWXT", "LEU", "URA", "URNM", "OKLO"],
  },
  {
    id: "cyber",
    label: "Cybersecurity",
    blurb: "Centre for Cybersecurity + annual Global Cybersecurity Outlook. Nation-state attacks, critical infrastructure, post-quantum cryptography.",
    keywords: ["cybersecurity", "cyber attack", "ransomware", "cyber risk", "zero trust", "post-quantum"],
    basket: ["CRWD", "PANW", "ZS", "NET", "FTNT", "S", "HACK"],
  },
  {
    id: "quantum",
    label: "Quantum Computing",
    blurb: "Quantum Economy Network — WEF pushing standards for quantum-secure networks and quantum/AI hybrid systems.",
    keywords: ["quantum comput", "quantum technolog", "quantum security", "quantum network"],
    basket: ["IBM", "IONQ", "RGTI", "QBTS", "HON", "GOOGL"],
  },
  {
    id: "supply",
    label: "Supply Chains & Advanced Mfg",
    blurb: "Centre for Advanced Manufacturing and Supply Chains. Reshoring, semiconductor capacity, defense-grade materials, port/logistics resilience.",
    keywords: ["supply chain", "manufacturing", "reshoring", "value chain", "logistics", "semiconductor"],
    basket: ["TSM", "ASML", "LRCX", "AMAT", "GE", "CAT", "UNP", "FDX"],
  },
  {
    id: "defense",
    label: "Defense & Geopolitics",
    blurb: "Geo-Economics and Politics stream. Persistent conflict risk, defense budget expansions, sovereign-AI and dual-use tech.",
    keywords: ["geopolit", "defense", "conflict", "war ", "military", "sovereign "],
    basket: ["LMT", "RTX", "NOC", "GD", "LDOS", "PLTR", "ITA"],
  },
  {
    id: "health",
    label: "Health & Healthcare",
    blurb: "Centre for Health and Healthcare — pandemic preparedness, GLP-1 obesity drugs, healthcare AI, and biotech innovation.",
    keywords: ["healthcare", "health ", "pandemic", "biotech", "pharmaceutical", "obesity"],
    basket: ["LLY", "NVO", "UNH", "JNJ", "ABBV", "VRTX", "MRNA"],
  },
  {
    id: "climate",
    label: "Climate Action & Materials",
    blurb: "Centre for Nature and Climate. Carbon markets, climate adaptation, circular economy, critical minerals for the green build.",
    keywords: ["climate", "carbon", "emissions", "sustainability", "circular econom", "critical mineral"],
    basket: ["LIN", "APD", "ECL", "SHW", "MP", "FCX", "NEM"],
  },
  {
    id: "finance",
    label: "Financial & Monetary Systems",
    blurb: "Centre for Financial and Monetary Systems — CBDCs, systemic risk, insurance resilience, financial inclusion, stablecoins.",
    keywords: ["monetary", "central bank", "systemic risk", "financial system", "insurance", "stablecoin", "cbdc"],
    basket: ["JPM", "GS", "MS", "BLK", "BRK-B", "V", "MA"],
  },
  {
    id: "space",
    label: "Space Economy",
    blurb: "Top-10 Emerging Technologies + dedicated $1.8T space-economy coverage. Satellite networks, launch, earth observation, defense-space.",
    keywords: ["space economy", "space sector", "satellite", "orbital", "launch "],
    basket: ["RKLB", "LMT", "NOC", "IRDM", "PL", "MAXR", "ARKX"],
  },
  {
    id: "work",
    label: "Future of Work",
    blurb: "Jobs of Tomorrow / New Economy Skills — workforce transformation, AI-driven productivity, human capital platforms.",
    keywords: ["future of work", "jobs of tomorrow", "workforce", "human capital", "skills ", "productivity"],
    basket: ["CRM", "NOW", "ADP", "LIN", "WDAY", "PAYC"],
  },
];

/** Distinct tickers referenced anywhere in any theme basket. */
export function allThemeTickers(): string[] {
  const s = new Set<string>(["SPY"]);
  for (const t of THEMES) for (const tk of t.basket) s.add(tk);
  return Array.from(s);
}

// ----- Scrape weforum.org -----

async function fetchText(url: string, timeoutMs = 12_000): Promise<string | null> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml" },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally { clearTimeout(to); }
}

/** Extract page text (strip tags, collapse whitespace). */
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Pull article titles + links from the stories index to build a "sources scanned" count. */
function extractStoryLinks(html: string): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = [];
  // WEF stories link pattern — <a href="/stories/2026/04/..." >Title</a>
  const re = /<a[^>]+href="(\/stories\/[^"\s#]+)"[^>]*>([\s\S]{3,180}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const title = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!title || title.length < 8) continue;
    const url = `https://www.weforum.org${href.split("?")[0]}`;
    if (!out.find((o) => o.url === url)) out.push({ title, url });
    if (out.length >= 60) break;
  }
  return out;
}

// ----- Build response -----

export interface QuotesLike {
  /** Per-symbol 1M return (%) */
  r1m: Map<string, number>;
  /** SPY's 1M return (%) */
  spy1m: number;
}

// Fallback fetcher for theme-only tickers not covered by the sector-web universe.
// TODO: Schwab-only mode — Yahoo source removed, awaiting Schwab equivalent.
async function yChart(symbol: string): Promise<number | null> {
  try {
    const { getPriceHistory } = await import("./schwab");
    const resp = await getPriceHistory(symbol, "month", 3, "daily", 1);
    const closes = resp.candles
      .map((c) => c.close)
      .filter((c) => c != null && isFinite(c) && c > 0);
    if (closes.length < 5) return null;
    const last = closes[closes.length - 1];
    const mIdx = Math.max(0, closes.length - 22);
    if (!closes[mIdx]) return null;
    return ((last - closes[mIdx]) / closes[mIdx]) * 100;
  } catch { return null; }
}

async function ensureQuotes(base: QuotesLike): Promise<QuotesLike> {
  const need: string[] = [];
  for (const t of THEMES) for (const sym of t.basket) {
    if (!base.r1m.has(sym)) need.push(sym);
  }
  const uniq = Array.from(new Set(need));
  // Parallel in batches of 8
  const extra = new Map(base.r1m);
  const BATCH = 8;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const slice = uniq.slice(i, i + BATCH);
    await Promise.all(slice.map(async (s) => {
      const v = await yChart(s);
      if (v != null && isFinite(v)) extra.set(s, v);
    }));
  }
  return { r1m: extra, spy1m: base.spy1m };
}

let _cache: { t: number; data: WefThemeResponse } | null = null;
const TTL_MS = 2 * 60 * 60_000; // 2 hours

export async function buildWefThemes(quotesIn: QuotesLike): Promise<WefThemeResponse> {
  if (_cache && Date.now() - _cache.t < TTL_MS) return _cache.data;
  const quotes = await ensureQuotes(quotesIn);

  // 1) Scrape WEF stories + global risks landing for text + links.
  const urls = [
    "https://www.weforum.org/stories/",
    "https://www.weforum.org/publications/global-risks-report-2025/",
    "https://www.weforum.org/agenda/",
  ];
  let fullText = "";
  let stories: { title: string; url: string }[] = [];
  for (const u of urls) {
    const html = await fetchText(u);
    if (!html) continue;
    fullText += " " + extractText(html);
    if (u.endsWith("stories/") || u.endsWith("agenda/")) {
      stories = stories.concat(extractStoryLinks(html));
    }
  }

  // De-dupe stories
  const seen = new Set<string>();
  stories = stories.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  }).slice(0, 30);

  // 2) Count mentions per theme. If scrape returned no text, everyone gets
  //    mentions=1 so the UI still renders.
  const haveText = fullText.length > 200;
  const themeOut: WefTheme[] = THEMES.map((t) => {
    let mentions = 0;
    if (haveText) {
      for (const kw of t.keywords) {
        // Count non-overlapping occurrences
        const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        const match = fullText.match(re);
        if (match) mentions += match.length;
      }
    } else {
      mentions = 1;
    }

    // Pick sources that mention the theme (for "why this theme" trail)
    const themeSources = stories.filter((s) => {
      const lower = s.title.toLowerCase();
      return t.keywords.some((kw) => lower.includes(kw.trim()));
    }).slice(0, 3);

    // Score basket: RS = ticker 1M - SPY 1M
    type Rank = { symbol: string; r1m: number; rs1m: number };
    const ranked: Rank[] = [];
    for (const sym of t.basket) {
      const r = quotes.r1m.get(sym);
      if (r == null) continue;
      ranked.push({ symbol: sym, r1m: r, rs1m: r - quotes.spy1m });
    }
    ranked.sort((a, b) => b.rs1m - a.rs1m);
    const leaders = ranked.filter((r) => r.rs1m > 0).slice(0, 5);
    const avgRs = ranked.length ? ranked.reduce((a, r) => a + r.rs1m, 0) / ranked.length : 0;

    return {
      id: t.id,
      label: t.label,
      blurb: t.blurb,
      mentions,
      sources: themeSources,
      basket: t.basket,
      leaders,
      basketRs1m: avgRs,
    };
  });

  // Sort themes by mentions desc (most-talked-about first), then by RS heat
  themeOut.sort((a, b) => (b.mentions - a.mentions) || (b.basketRs1m - a.basketRs1m));

  const out: WefThemeResponse = {
    asOf: new Date().toISOString(),
    themes: themeOut,
    sourcesScanned: stories.length,
    summary: haveText
      ? `Scanned ${stories.length} WEF stories + Global Risks 2025 + Agenda landing · mapped to ${THEMES.length} themes`
      : `WEF live fetch unavailable — showing baseline basket universe (${THEMES.length} themes)`,
  };
  _cache = { t: Date.now(), data: out };
  return out;
}
