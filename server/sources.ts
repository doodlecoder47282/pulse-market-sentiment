/**
 * Data source adapters: Schwab (quotes), CBOE (SPY options chain),
 * CNN Fear & Greed, AAII (via fallback), and web-based X/Reddit sentiment
 * aggregated from public search pages (no login / no API key).
 */
import type {
  GammaStructure, GexStrikePoint, SocialPost, SocialSentiment,
} from "@shared/schema";
import { buildGammaProfile, type OptionRow } from "./gammaProfile";

const UA = "Mozilla/5.0 (compatible; SentimentDash/1.0)";

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function fetchText(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

/** Quote endpoint: last-close + previous-close via Schwab getQuotes.
 *  Symbol mapping: Yahoo ^ prefix → Schwab $ prefix (e.g. ^VIX → $VIX, ^GSPC → $SPX).
 *  Bug #4 fix: renamed from yahooQuote → getQuote. Function was never calling
 *  Yahoo — the implementation has always been Schwab-only. The misleading name
 *  was a vestige from the pre-Schwab era.
 */
export async function getQuote(symbol: string): Promise<{ last: number | null; prev: number | null; }> {
  try {
    // Map Yahoo-style symbols to Schwab equivalents
    const schwabSymbol = toSchwabSymbol(symbol);
    const { getQuotes } = await import("./schwab");
    const quotes = await getQuotes([schwabSymbol]);
    const q = quotes.find((q) => q.symbol === schwabSymbol);
    if (!q || q.last == null) return { last: null, prev: null };
    // changePercent is vs prev close; back-calculate prev from last + change
    const last = q.last;
    const prev = (q.change != null && isFinite(q.change)) ? last - q.change : null;
    return { last, prev };
  } catch {
    return { last: null, prev: null };
  }
}

/** Map Yahoo-style symbols to Schwab equivalents.
 *  Schwab cash indexes use "$" prefix WITHOUT ".X" suffix (verified empirically:
 *  $VIX returns 17.08, $VIX.X returns nothing). For SPX option chains the param
 *  is also "$SPX" (see routes.ts:1870 comment).
 */
function toSchwabSymbol(symbol: string): string {
  const map: Record<string, string> = {
    "^VIX": "$VIX",
    "^VIX9D": "$VIX9D",
    "^VIX3M": "$VIX3M",
    "^VVIX": "$VVIX",
    "^SKEW": "$SKEW",
    "^GSPC": "$SPX",
    "^SPX": "$SPX",
    "^VXN": "$VXN",
    "^RVX": "$RVX",
    "^DJI": "$DJI",
    "^IXIC": "$COMPX",
    "^RUT": "$RUT",
  };
  return map[symbol] ?? symbol;
}

export { toSchwabSymbol };

/**
 * @deprecated Use getQuote instead. Kept as alias to avoid touching every legacy
 * callsite in one PR — function body lives in getQuote.
 */
export const yahooQuote = getQuote;

/** CBOE delayed options chain for SPY (includes per-contract Greeks). */
export async function cboeSpyChain(): Promise<any> {
  const url = "https://cdn.cboe.com/api/global/delayed_quotes/options/SPY.json";
  return fetchJson(url, { Referer: "https://www.cboe.com/" });
}

/** Build gamma structure from the CBOE chain, limited to 0-45 DTE. */
export function buildGammaStructure(chain: any): GammaStructure {
  const data = chain.data;
  const S: number = Number(data.current_price);
  const opts: any[] = data.options;

  // OCC symbol pattern. Note: the underlying prefix is variable length for SPX
  // but for SPY it's always "SPY". For SPX weeklys (SPXW), also match.
  const pat = /^(SPY|SPXW|SPX)(\d{6})([CP])(\d{8})$/;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  type Row = { type: "C" | "P"; strike: number; gamma: number; iv: number; oi: number; vol: number; dte: number; expiry: string };
  const rows: Row[] = [];
  for (const o of opts) {
    const m = pat.exec(o.option);
    if (!m) continue;
    const ymd = m[2];
    const year = 2000 + parseInt(ymd.slice(0, 2));
    const month = parseInt(ymd.slice(2, 4)) - 1;
    const day = parseInt(ymd.slice(4, 6));
    const exp = new Date(Date.UTC(year, month, day));
    const dte = Math.round((exp.getTime() - today.getTime()) / 86400000);
    if (dte < 0 || dte > 45) continue;
    const strike = parseInt(m[4]) / 1000;
    const gamma = Number(o.gamma) || 0;
    const iv = Number(o.iv) || 0;
    const oi = Number(o.open_interest) || 0;
    if (gamma === 0 || oi === 0) continue;
    const expiry = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    rows.push({
      type: m[3] as "C" | "P",
      strike, gamma, iv, oi,
      vol: Number(o.volume) || 0,
      dte,
      expiry,
    });
  }

  const gexByStrike = new Map<number, number>();
  const callOiByStrike = new Map<number, number>();
  const putOiByStrike = new Map<number, number>();
  let totalCallOi = 0, totalPutOi = 0, callVol = 0, putVol = 0;

  for (const r of rows) {
    const sign = r.type === "C" ? 1 : -1;
    const gex = sign * r.gamma * r.oi * 100 * S * S * 0.01;
    gexByStrike.set(r.strike, (gexByStrike.get(r.strike) || 0) + gex);
    if (r.type === "C") {
      callOiByStrike.set(r.strike, (callOiByStrike.get(r.strike) || 0) + r.oi);
      totalCallOi += r.oi; callVol += r.vol;
    } else {
      putOiByStrike.set(r.strike, (putOiByStrike.get(r.strike) || 0) + r.oi);
      totalPutOi += r.oi; putVol += r.vol;
    }
  }

  const strikes = Array.from(gexByStrike.keys()).sort((a, b) => a - b);
  const totalGex = strikes.reduce((a, k) => a + (gexByStrike.get(k) || 0), 0);

  let callWall = strikes[0], putWall = strikes[0];
  let callWallGex = -Infinity, putWallGex = Infinity;
  for (const k of strikes) {
    const g = gexByStrike.get(k) || 0;
    if (g > callWallGex) { callWallGex = g; callWall = k; }
    if (g < putWallGex)  { putWallGex = g; putWall = k; }
  }

  // GEX Crossover Strike: legacy metric — strike at which cumulative per-strike
  // GEX flips sign (where the GEX centroid lies). Kept for continuity but NOT
  // the canonical "zero-gamma flip" level.
  let gexCrossoverStrike: number | null = null;
  let run = 0;
  let prev: { k: number; v: number } | null = null;
  for (const k of strikes) {
    run += gexByStrike.get(k) || 0;
    if (prev && prev.v * run < 0) {
      const frac = (0 - prev.v) / (run - prev.v);
      gexCrossoverStrike = prev.k + frac * (k - prev.k);
      break;
    }
    prev = { k, v: run };
  }

  // Canonical zero-gamma level (Perfiliev-style): recompute Black-Scholes gamma
  // across a band of hypothetical spot levels, find where total signed dealer
  // gamma flips sign. This is the level SpotGamma / MenthorQ publish.
  const profileRows: OptionRow[] = rows
    .filter((rr) => rr.iv > 0 && rr.oi > 0)
    .map((rr) => ({ type: rr.type, strike: rr.strike, iv: rr.iv, oi: rr.oi, dte: rr.dte }));
  const gammaProfile = buildGammaProfile(profileRows, S);
  const zeroGamma: number | null = gammaProfile.zeroGammaSpot;

  // Max pain (nearest expiry only).
  const nearestDte = rows.reduce((a, r) => Math.min(a, r.dte), 45);
  const nearRows = rows.filter((r) => r.dte === nearestDte);
  const candidateStrikes = Array.from(new Set(nearRows.map((r) => r.strike))).sort((a, b) => a - b);
  let maxPain = S;
  let minPain = Infinity;
  for (const K of candidateStrikes) {
    let tot = 0;
    for (const r of nearRows) {
      if (r.type === "C") tot += Math.max(K - r.strike, 0) * r.oi * 100;
      else tot += Math.max(r.strike - K, 0) * r.oi * 100;
    }
    if (tot < minPain) { minPain = tot; maxPain = K; }
  }

  const profile: GexStrikePoint[] = strikes
    .filter((k) => Math.abs(k - S) <= 60)
    .map((k) => ({
      strike: k,
      gex: gexByStrike.get(k) || 0,
      callOi: callOiByStrike.get(k) || 0,
      putOi: putOiByStrike.get(k) || 0,
    }));

  // Per-strike dominant-expiry lookup for Top OI: which single expiry concentrates the most OI at that strike?
  const callExpByStrike = new Map<number, Map<string, { oi: number; dte: number }>>();
  const putExpByStrike  = new Map<number, Map<string, { oi: number; dte: number }>>();
  for (const r of rows) {
    const map = r.type === "C" ? callExpByStrike : putExpByStrike;
    let inner = map.get(r.strike);
    if (!inner) { inner = new Map(); map.set(r.strike, inner); }
    const prev = inner.get(r.expiry);
    inner.set(r.expiry, { oi: (prev?.oi || 0) + r.oi, dte: r.dte });
  }
  const dominantExpiry = (inner: Map<string, { oi: number; dte: number }> | undefined): { expiry: string; dte: number } => {
    if (!inner) return { expiry: "", dte: 0 };
    let best = { expiry: "", dte: 0, oi: -1 };
    for (const [expiry, v] of Array.from(inner.entries())) {
      if (v.oi > best.oi) best = { expiry, dte: v.dte, oi: v.oi };
    }
    return { expiry: best.expiry, dte: best.dte };
  };

  const topCallOi = Array.from(callOiByStrike.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([strike, oi]) => { const d = dominantExpiry(callExpByStrike.get(strike)); return { strike, oi, expiry: d.expiry, dte: d.dte }; });
  const topPutOi = Array.from(putOiByStrike.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([strike, oi]) => { const d = dominantExpiry(putExpByStrike.get(strike)); return { strike, oi, expiry: d.expiry, dte: d.dte }; });

  // PCR by DTE bucket — lets the UI pivot the ratio to a specific horizon.
  const buckets: { label: string; dteMax: number }[] = [
    { label: "0DTE",   dteMax: 0 },
    { label: "0-1W",   dteMax: 7 },
    { label: "0-2W",   dteMax: 14 },
    { label: "0-1M",   dteMax: 30 },
    { label: "0-45D",  dteMax: 45 },
  ];
  const pcrByBucket = buckets.map(({ label, dteMax }) => {
    let cOi = 0, pOi = 0, cVol = 0, pVol = 0;
    for (const r of rows) {
      if (r.dte > dteMax) continue;
      if (r.type === "C") { cOi += r.oi; cVol += r.vol; }
      else                { pOi += r.oi; pVol += r.vol; }
    }
    return {
      label, dteMax,
      pcrOi:  cOi  ? pOi  / cOi  : 0,
      pcrVol: cVol ? pVol / cVol : 0,
      callOi: cOi, putOi: pOi,
    };
  });

  const regime = totalGex > 5e7 ? "positive" : totalGex < -5e7 ? "negative" : "neutral";

  return {
    spot: S,
    totalGex,
    regime,
    callWall, callWallGex,
    putWall, putWallGex,
    zeroGamma,
    maxPain,
    nearestDte,
    pcrOi: totalCallOi ? totalPutOi / totalCallOi : 0,
    pcrVol: callVol ? putVol / callVol : 0,
    profile,
    topCallOi,
    topPutOi,
    pcrByBucket,
    gexCrossoverStrike,
    gammaProfile: gammaProfile.curve,
  };
}

/** CNN Fear & Greed (undocumented but stable JSON endpoint). */
export async function cnnFearGreed(): Promise<{ value: number; label: string; source: string } | null> {
  try {
    const d = await fetchJson(
      "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
      { Referer: "https://www.cnn.com/markets/fear-and-greed" },
    );
    const v = d?.fear_and_greed?.score;
    const label = d?.fear_and_greed?.rating || "";
    if (typeof v !== "number") return null;
    return { value: Math.round(v), label: label.replace(/\b\w/g, (c: string) => c.toUpperCase()), source: "CNN" };
  } catch {
    return null;
  }
}

// Lightweight sentiment lexicon (keyword-based, transparent, no API key).
const BULL_WORDS = [
  "moon","rally","breakout","squeeze","pump","calls","long","buy the dip","bottomed",
  "all-time high","ath","green","bullish","upside","strong","bid","support held","gamma squeeze",
  "melt up","short squeeze","recovery","rip","ripping","go up","higher","reclaim",
];
const BEAR_WORDS = [
  "crash","plunge","dump","sell-off","selloff","bearish","puts","short","breakdown",
  "capitulation","red","weak","downside","rejection","lower","death cross","bear","recession",
  "collapse","drawdown","losing","fear","panic","blood","rug","correction","risk-off",
];

function scoreText(t: string): "bullish" | "bearish" | "neutral" {
  const s = t.toLowerCase();
  let b = 0, r = 0;
  for (const w of BULL_WORDS) if (s.includes(w)) b++;
  for (const w of BEAR_WORDS) if (s.includes(w)) r++;
  if (b === 0 && r === 0) return "neutral";
  if (b > r) return "bullish";
  if (r > b) return "bearish";
  return "neutral";
}

/**
 * StockTwits public stream for a symbol. Posts often carry an explicit
 * Bullish/Bearish tag from the poster; when absent we lexicon-score the body.
 * StockTwits is a trader-focused social feed and is the closest public
 * analogue to X cashtag search without requiring a paid API.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

async function fetchStockTwits(symbol: string, limit = 30): Promise<SocialPost[]> {
  try {
    const d = await fetchJson(`https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json?limit=${limit}`);
    const msgs = d?.messages ?? [];
    return msgs.map((m: any) => {
      const body = decodeEntities(m.body || "");
      const explicit = m?.entities?.sentiment?.basic?.toLowerCase();
      const tone: SocialPost["tone"] =
        explicit === "bullish" ? "bullish"
        : explicit === "bearish" ? "bearish"
        : scoreText(body);
      return {
        source: "X" as const,
        author: "@" + (m.user?.username ?? "?"),
        text: body.slice(0, 240),
        url: `https://stocktwits.com/${m.user?.username}/message/${m.id}`,
        timestamp: m.created_at,
        tone,
      };
    });
  } catch {
    return [];
  }
}

/** Reddit public JSON (no auth). Works well for /r/wallstreetbets + /r/options. */
async function fetchReddit(sub: string, limit = 30): Promise<SocialPost[]> {
  try {
    const d = await fetchJson(`https://www.reddit.com/r/${sub}/hot.json?limit=${limit}`);
    const items = d?.data?.children ?? [];
    return items.map((c: any) => {
      const t = `${c.data.title || ""} ${c.data.selftext || ""}`.slice(0, 300);
      return {
        source: "Reddit" as const,
        author: "r/" + sub,
        text: c.data.title || "",
        url: `https://www.reddit.com${c.data.permalink}`,
        tone: scoreText(t),
      };
    });
  } catch {
    return [];
  }
}

/** Aggregate X + Reddit into one SocialSentiment payload. */
export async function gatherSocial(): Promise<SocialSentiment> {
  const [stSpy, stVix, rOpts] = await Promise.all([
    fetchStockTwits("SPY", 30),
    fetchStockTwits("VIX", 15),
    fetchReddit("options", 25),
  ]);
  const posts = [...stSpy, ...stVix, ...rOpts];
  const bullish = posts.filter((p) => p.tone === "bullish").length;
  const bearish = posts.filter((p) => p.tone === "bearish").length;
  const neutral = posts.filter((p) => p.tone === "neutral").length;
  const tagged = bullish + bearish;
  const score = tagged > 0 ? Math.round(((bullish - bearish) / tagged) * 100) : 0;
  return { score, bullish, bearish, neutral, posts: posts.slice(0, 40) };
}

/** Market news headlines relevant to SPX/SPY.
 *  // TODO: Schwab-only mode — Yahoo source removed, awaiting Schwab equivalent.
 *  Returns empty array gracefully.
 */
export async function fetchHeadlines(): Promise<{ title: string; url: string; source: string; publishedAt?: string }[]> {
  return [];
}
