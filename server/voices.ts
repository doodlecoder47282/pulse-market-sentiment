// server/voices.ts
// Aggregate market-actionable posts and mentions from curated analyst voices.

export type VoiceDef = {
  handle: string;
  name: string;
  weight: number;
  tags: string[];
  bio: string;
  feeds: { kind: "rss" | "gnews"; url: string }[];
  xUrl: string;
};

export type VoiceItem = {
  voice: string;         // display name
  handle: string;
  weight: number;
  title: string;
  summary: string;       // short text
  source: string;        // domain
  url: string;
  published: string;     // ISO
  dataScore: number;     // 0-100 (how data-rich / market-actionable)
  sentiment: "bull" | "bear" | "neutral";
  topics: string[];      // e.g. ["vix", "gamma", "fed"]
  claims: string[];      // extracted quantitative claims
  factCheck?: { verdict: "consistent" | "conflicting" | "unverified"; note: string };
  native?: "x";          // marker for native X tweet payload
  tweet?: {
    id: string;
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    impressions: number;
  };
};

const VOICES: VoiceDef[] = [
  {
    handle: "spotgamma", name: "SpotGamma", weight: 0.13,
    tags: ["gamma", "options", "dealer-flow"],
    bio: "Institutional options positioning & dealer gamma research.",
    xUrl: "https://x.com/spotgamma",
    feeds: [
      { kind: "gnews", url: "https://news.google.com/rss/search?q=%22SpotGamma%22&hl=en-US&gl=US&ceid=US:en" },
    ],
  },
  {
    handle: "jam_croissant", name: "Cem Karsan", weight: 0.12,
    tags: ["vol", "vanna", "regime"],
    bio: "Founder Kai Volatility. 26y quant/vol/flow PM, ex-market-maker.",
    xUrl: "https://x.com/jam_croissant",
    feeds: [
      { kind: "gnews", url: "https://news.google.com/rss/search?q=%22Cem+Karsan%22+OR+%22Kai+Volatility%22&hl=en-US&gl=US&ceid=US:en" },
    ],
  },
  {
    handle: "SqueezeMetrics", name: "SqueezeMetrics", weight: 0.11,
    tags: ["gex", "dix", "dark-pool"],
    bio: "Original GEX / dark-pool index.",
    xUrl: "https://x.com/SqueezeMetrics",
    feeds: [
      { kind: "gnews", url: "https://news.google.com/rss/search?q=%22SqueezeMetrics%22+OR+%22DIX%22+gamma&hl=en-US&gl=US&ceid=US:en" },
    ],
  },
  {
    handle: "VolSignals", name: "VolSignals", weight: 0.10,
    tags: ["dealer", "spx", "market-maker"],
    bio: "Career SPX market maker; publishes dealer hedging flow research.",
    xUrl: "https://x.com/VolSignals",
    feeds: [
      { kind: "gnews", url: "https://news.google.com/rss/search?q=%22VolSignals%22+SPX&hl=en-US&gl=US&ceid=US:en" },
    ],
  },
  {
    handle: "profplum99", name: "Michael Green", weight: 0.10,
    tags: ["macro", "passive", "vol"],
    bio: "Chief Strategist, Simplify Asset Management.",
    xUrl: "https://x.com/profplum99",
    feeds: [
      { kind: "gnews", url: "https://news.google.com/rss/search?q=%22Michael+Green%22+Simplify+markets&hl=en-US&gl=US&ceid=US:en" },
    ],
  },
  {
    handle: "RayDalio", name: "Ray Dalio", weight: 0.10,
    tags: ["macro", "regime", "debt-cycle"],
    bio: "Bridgewater founder; Principles author.",
    xUrl: "https://x.com/RayDalio",
    feeds: [
      { kind: "gnews", url: "https://news.google.com/rss/search?q=%22Ray+Dalio%22&hl=en-US&gl=US&ceid=US:en" },
    ],
  },
  {
    handle: "LizAnnSonders", name: "Liz Ann Sonders", weight: 0.09,
    tags: ["macro", "equity", "data"],
    bio: "Chief Investment Strategist, Schwab Center for Financial Research.",
    xUrl: "https://x.com/LizAnnSonders",
    feeds: [
      { kind: "gnews", url: "https://news.google.com/rss/search?q=%22Liz+Ann+Sonders%22&hl=en-US&gl=US&ceid=US:en" },
    ],
  },
  {
    handle: "unusual_whales", name: "unusual_whales", weight: 0.09,
    tags: ["flow", "options", "politics"],
    bio: "Real-time options flow + congressional trade disclosures.",
    xUrl: "https://x.com/unusual_whales",
    feeds: [
      { kind: "gnews", url: "https://news.google.com/rss/search?q=%22unusual+whales%22&hl=en-US&gl=US&ceid=US:en" },
    ],
  },
  {
    handle: "profstonge", name: "Peter St Onge", weight: 0.08,
    tags: ["macro", "monetary", "fed"],
    bio: "Economist (PhD). Daily videos on Fed, liquidity, credit.",
    xUrl: "https://x.com/profstonge",
    feeds: [
      { kind: "rss", url: "https://feeds.simplecast.com/Kzni63mP" }, // his podcast — best feed
      { kind: "gnews", url: "https://news.google.com/rss/search?q=%22Peter+St+Onge%22&hl=en-US&gl=US&ceid=US:en" },
    ],
  },
  {
    handle: "Convertbond", name: "Larry McDonald", weight: 0.08,
    tags: ["credit", "risk", "bonds"],
    bio: "Bear Traps Report founder. Ex-Lehman trader, NYT bestseller.",
    xUrl: "https://x.com/Convertbond",
    feeds: [
      { kind: "rss", url: "https://brandtp.substack.com/feed" },
      { kind: "gnews", url: "https://news.google.com/rss/search?q=%22Larry+McDonald%22+Bear+Traps&hl=en-US&gl=US&ceid=US:en" },
    ],
  },
];

export function listVoices() {
  return VOICES.map(v => ({
    handle: v.handle, name: v.name, weight: v.weight,
    tags: v.tags, bio: v.bio, xUrl: v.xUrl,
  }));
}

// --- XML / RSS parsing (minimal, no deps) ---

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripCdata(s: string): string {
  const m = s.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return m ? m[1] : s;
}

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  return decodeEntities(stripCdata(m[1].trim()));
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function extractItems(xml: string): string[] {
  const items: string[] = [];
  // RSS <item> or Atom <entry>
  const re = /<(item|entry)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) items.push(m[2]);
  return items;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// --- Scoring ---

const TICKER_RE = /\$?\b(SPX|SPY|VIX|VVIX|QQQ|NDX|NQ|ES|DXY|TLT|HYG|LQD|BTC|ETH|GLD)\b/gi;
const NUMERIC_RE = /(\$?\d+[\d,\.]*\s*(?:%|bps|bp|bn|billion|trillion|tn|pts|\/1%|strike|call|put|bp\b))/gi;
const KEYWORDS_MARKET = [
  "gamma", "vanna", "charm", "dealer", "flow", "skew", "put/call", "pcr",
  "vix", "vvix", "term structure", "contango", "backwardation",
  "fed", "fomc", "powell", "cpi", "jobs", "payroll", "treasury", "bond", "yield",
  "spx", "spy", "earnings", "options", "strike", "expiry", "opex",
  "liquidity", "credit", "spread", "high yield", "hyg",
];

function computeDataScore(text: string): { score: number; claims: string[]; topics: string[] } {
  const lower = text.toLowerCase();
  const tickers = text.match(TICKER_RE) || [];
  const numeric = text.match(NUMERIC_RE) || [];
  const kw = KEYWORDS_MARKET.filter(k => lower.includes(k));
  const tickerScore = Math.min(tickers.length * 10, 30);
  const numericScore = Math.min(numeric.length * 12, 40);
  const keywordScore = Math.min(kw.length * 6, 30);
  const score = Math.min(100, tickerScore + numericScore + keywordScore);
  // Extract top numeric claims (unique, first 6)
  const claims = Array.from(new Set(numeric.map(s => s.trim()))).slice(0, 6);
  // Topic tags (uppercase tickers + keyword families)
  const topicSet = new Set<string>();
  tickers.forEach(t => topicSet.add(t.replace(/\$/g, "").toUpperCase()));
  kw.forEach(k => topicSet.add(k.replace(/\s+/g, "-")));
  return { score, claims, topics: Array.from(topicSet).slice(0, 8) };
}

function detectSentiment(text: string): "bull" | "bear" | "neutral" {
  const l = text.toLowerCase();
  const bullKw = ["rally", "breakout", "bullish", "squeeze higher", "upside", "melt up", "supportive", "dovish", "risk-on"];
  const bearKw = ["selloff", "bearish", "breakdown", "crash", "risk off", "risk-off", "hawkish", "panic", "capitulate", "vol spike", "sell signal"];
  let b = 0, s = 0;
  for (const k of bullKw) if (l.includes(k)) b++;
  for (const k of bearKw) if (l.includes(k)) s++;
  if (b > s && b >= 1) return "bull";
  if (s > b && s >= 1) return "bear";
  return "neutral";
}

// Live-market fact-check: compare claim numbers against current snapshot where possible.
export function factCheckItem(item: VoiceItem, snap: { vix: number; spy: number; vvix: number; skew: number; pcr: number }): void {
  // Look for claims like "VIX 25" / "VIX at 22" and compare to live
  const txt = (item.title + " " + item.summary).toLowerCase();
  const checks: { kind: string; stated: number; live: number }[] = [];
  const patterns: { re: RegExp; kind: keyof typeof snap }[] = [
    { re: /\bvix\s*(?:at\s*|=\s*|is\s*|hits?\s*|above\s*|below\s*)?(\d{1,3}(?:\.\d+)?)/i, kind: "vix" },
    { re: /\bvvix\s*(?:at\s*|=\s*|is\s*|hits?\s*)?(\d{1,3}(?:\.\d+)?)/i, kind: "vvix" },
    { re: /\bspy\s*(?:at\s*|=\s*|\$\s*)?(\d{3,4}(?:\.\d+)?)/i, kind: "spy" },
    { re: /\bskew\s*(?:at\s*|=\s*|is\s*)?(\d{2,3}(?:\.\d+)?)/i, kind: "skew" },
    { re: /\b(?:put\/call|pcr)\s*(?:ratio\s*)?(?:at\s*|=\s*|is\s*)?(\d+(?:\.\d+)?)/i, kind: "pcr" },
  ];
  for (const p of patterns) {
    const m = txt.match(p.re);
    if (m) {
      const stated = parseFloat(m[1]);
      const live = snap[p.kind];
      if (Number.isFinite(stated) && Number.isFinite(live)) {
        checks.push({ kind: p.kind, stated, live });
      }
    }
  }
  if (!checks.length) {
    item.factCheck = { verdict: "unverified", note: "No directly comparable live metric claimed." };
    return;
  }
  // Allow 10% tolerance
  const conflicts = checks.filter(c => Math.abs(c.stated - c.live) / Math.max(c.live, 1) > 0.10);
  if (conflicts.length === 0) {
    const note = checks.map(c => `${c.kind.toUpperCase()} stated ${c.stated} vs live ${c.live.toFixed(2)}`).join("; ");
    item.factCheck = { verdict: "consistent", note };
  } else {
    const note = conflicts.map(c => `${c.kind.toUpperCase()} stated ${c.stated} vs live ${c.live.toFixed(2)} (Δ ${(Math.abs(c.stated - c.live) / c.live * 100).toFixed(1)}%)`).join("; ");
    item.factCheck = { verdict: "conflicting", note };
  }
}

async function fetchOne(url: string, ms = 8000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (PulseDashboard/1.0)",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
    });
    clearTimeout(to);
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

export async function fetchVoiceFeed(voice: VoiceDef, maxItems = 8): Promise<VoiceItem[]> {
  const out: VoiceItem[] = [];
  for (const f of voice.feeds) {
    const xml = await fetchOne(f.url);
    if (!xml) continue;
    const rawItems = extractItems(xml).slice(0, maxItems);
    for (const it of rawItems) {
      const title = stripHtml(extractTag(it, "title") || "");
      const link = (extractTag(it, "link") || "").trim();
      const pub = extractTag(it, "pubDate") || extractTag(it, "published") || extractTag(it, "updated") || "";
      const descRaw = extractTag(it, "description") || extractTag(it, "summary") || extractTag(it, "content:encoded") || extractTag(it, "content") || "";
      const summary = stripHtml(descRaw).slice(0, 400);
      const fullText = title + " " + summary;
      const { score, claims, topics } = computeDataScore(fullText);
      const sentiment = detectSentiment(fullText);
      const item: VoiceItem = {
        voice: voice.name,
        handle: voice.handle,
        weight: voice.weight,
        title,
        summary,
        source: hostOf(link) || "news",
        url: link,
        published: pub ? new Date(pub).toISOString() : new Date().toISOString(),
        dataScore: score,
        sentiment,
        topics,
        claims,
      };
      out.push(item);
    }
  }
  return out;
}

// Convert an XTweet into a VoiceItem, with engagement bonus added to dataScore.
function tweetToVoiceItem(voice: VoiceDef, tw: import("./x").XTweet): VoiceItem {
  const text = tw.text.replace(/https?:\/\/\S+$/g, "").trim();
  const { score, claims, topics } = computeDataScore(text);
  const engagement = Math.max(0, tw.likes + tw.retweets * 2 + tw.quotes * 2 + tw.replies * 0.5 + tw.impressions / 100);
  const engagementBonus = engagement > 0 ? Math.min(30, Math.log10(engagement + 1) * 8) : 0;
  const dataScore = Math.min(100, Math.round(score + engagementBonus));
  return {
    voice: voice.name,
    handle: voice.handle,
    weight: voice.weight,
    title: text.length > 140 ? text.slice(0, 137) + "…" : text,
    summary: text,
    source: "x.com",
    url: tw.url,
    published: new Date(tw.createdAt).toISOString(),
    dataScore,
    sentiment: detectSentiment(text),
    topics,
    claims,
    native: "x",
    tweet: {
      id: tw.id,
      likes: tw.likes,
      retweets: tw.retweets,
      replies: tw.replies,
      quotes: tw.quotes,
      impressions: tw.impressions,
    },
  };
}

export async function fetchAllVoices(): Promise<{
  voices: (ReturnType<typeof listVoices>[number] & { lastTweetedAt?: string })[];
  items: VoiceItem[];
}> {
  // Run RSS and X fetches in parallel. X is optional — degrades gracefully.
  const { fetchTweetsForHandles, xEnabled } = await import("./x");
  const handles = VOICES.map(v => v.handle);

  const [rssSettled, tweetsByHandle] = await Promise.all([
    Promise.allSettled(VOICES.map(v => fetchVoiceFeed(v))),
    xEnabled() ? fetchTweetsForHandles(handles, 10, 2) : Promise.resolve({} as Record<string, any[]>),
  ]);

  const items: VoiceItem[] = [];
  for (const r of rssSettled) {
    if (r.status === "fulfilled") items.push(...r.value);
  }

  // Merge X tweets
  const lastTweetedByHandle: Record<string, string> = {};
  for (const v of VOICES) {
    const tws = tweetsByHandle[v.handle.toLowerCase()] || [];
    for (const tw of tws) items.push(tweetToVoiceItem(v, tw));
    if (tws.length) lastTweetedByHandle[v.handle] = new Date(tws[0].createdAt).toISOString();
  }

  // Dedupe by URL
  const seen = new Set<string>();
  const unique = items.filter(i => i.url && !seen.has(i.url) && seen.add(i.url));
  // Drop items older than 60 days and items with zero data signal + no title
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const fresh = unique.filter(i => {
    const t = new Date(i.published).getTime();
    if (!Number.isFinite(t) || t < cutoff) return false;
    if (!i.title || i.title.length < 10) return false;
    return true;
  });
  // Sort: dataScore DESC, then recency DESC
  fresh.sort((a, b) => (b.dataScore - a.dataScore) || (new Date(b.published).getTime() - new Date(a.published).getTime()));

  const voicesWithLast = listVoices().map(v => ({
    ...v,
    lastTweetedAt: lastTweetedByHandle[v.handle],
  }));

  return { voices: voicesWithLast, items: fresh.slice(0, 120) };
}

/**
 * Aggregate weighted net sentiment bias from voices items.
 * Returns a score in -100..+100 (bearish..bullish).
 */
export function computeVoicesBias(items: VoiceItem[]): { score: number; sampleSize: number } {
  if (!items.length) return { score: 0, sampleSize: 0 };
  // Weight each item by analyst weight * (dataScore/100). Bull → +, bear → −.
  let weighted = 0, totalW = 0;
  for (const it of items) {
    const w = Math.max(0.05, it.weight) * Math.max(0.1, it.dataScore / 100);
    totalW += w;
    if (it.sentiment === "bull") weighted += w;
    else if (it.sentiment === "bear") weighted -= w;
  }
  const score = totalW > 0 ? Math.max(-100, Math.min(100, (weighted / totalW) * 100)) : 0;
  return { score, sampleSize: items.length };
}
