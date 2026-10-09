/**
 * Data source adapters: Schwab (quotes), CBOE (SPY options chain),
 * CNN Fear & Greed (undocumented JSON, context only) and the StockTwits
 * public symbol streams (social, context only). Reddit was dropped: its Data
 * API requires OAuth. Source tiers and terms: server/sources/registry.ts.
 */
import type {
  GammaStructure, GexStrikePoint, SocialPost, SocialSentiment,
} from "@shared/schema";
import { buildGammaProfile, type OptionRow } from "./gammaProfile";
import { fetchMarketHeadlineFeed, type HeadlineFeed } from "./news";

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
export async function getQuote(symbol: string): Promise<{ last: number | null; prev: number | null; stale?: boolean | null; ageMs?: number | null }> {
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
    // Freshness of the quote itself (server/quoteFreshness.ts).
    return { last, prev, stale: q.stale ?? null, ageMs: q.ageMs ?? null };
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
    // expiry date -> the shared clock (timeToExpiry, PM: SPY options settle on the close)
    .map((rr) => ({ type: rr.type, strike: rr.strike, iv: rr.iv, oi: rr.oi, dte: rr.dte, expiry: rr.expiry }));
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

/** A CNN reading older than this is stale (the index updates every US trading day). */
export const FEAR_GREED_MAX_AGE_MS = 4 * 24 * 3600_000;

/** Pure: parse the CNN graphdata payload, keeping the reading's own timestamp. */
export function parseFearGreed(d: any, nowMs: number = Date.now()): { value: number; label: string; source: string; asOf: string | null; stale: boolean } | null {
  const v = d?.fear_and_greed?.score;
  const label = d?.fear_and_greed?.rating || "";
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const ts = d?.fear_and_greed?.timestamp;
  const t = typeof ts === "number" ? ts : typeof ts === "string" ? Date.parse(ts) : NaN;
  const asOf = Number.isFinite(t) ? new Date(t).toISOString() : null;
  // unknown age is treated as stale: it cannot be shown as current
  const stale = !Number.isFinite(t) || nowMs - t > FEAR_GREED_MAX_AGE_MS;
  return { value: Math.round(v), label: String(label).replace(/\b\w/g, (c: string) => c.toUpperCase()), source: "CNN Fear & Greed (cnn.com)", asOf, stale };
}

/** CNN Fear & Greed (undocumented but stable JSON endpoint). Context only: never a price/options/sizing input. */
export async function cnnFearGreed(): Promise<{ value: number; label: string; source: string; asOf: string | null; stale: boolean } | null> {
  try {
    const d = await fetchJson(
      "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
      { Referer: "https://www.cnn.com/markets/fear-and-greed" },
    );
    return parseFearGreed(d);
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

// Throws on a failed request so gatherSocial can tell "failed" from "no posts".
async function fetchStockTwits(symbol: string, limit = 30): Promise<SocialPost[]> {
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
      source: "StockTwits" as const,
      author: "@" + (m.user?.username ?? "?"),
      text: body.slice(0, 240),
      url: `https://stocktwits.com/${m.user?.username}/message/${m.id}`,
      timestamp: m.created_at,
      tone,
    };
  });
}

// Reddit was dropped (round 2, R2-I): the Reddit Data API requires a
// registered OAuth client and blocks unauthenticated traffic ("Reddit Data
// API Wiki", https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki),
// so the keyless /hot.json read violated the terms. The gauge runs on
// StockTwits alone and its sources list says so.

/**
 * Post age window for the score. The gauge is a same-session read that sits
 * next to VIX, gamma and Fear & Greed in a composite refreshed every snapshot,
 * so it should reflect the current session plus overnight/pre-market chatter:
 * 24 hours. (A 72 h window let Friday's chatter set Monday's read.) The
 * StockTwits SPY stream (latest 30 messages) normally spans minutes, so the
 * window only bites when that feed is frozen; older posts are dropped
 * rather than scored.
 */
export const SOCIAL_MAX_AGE_HOURS = 24;
/** Fewer tagged (bullish + bearish) posts than this gives no score: one post would read +/-100. */
export const SOCIAL_MIN_TAGGED = 5;

type SocialSourceState = NonNullable<SocialSentiment["sources"]>[number];

const INVERT_TONE: Record<SocialPost["tone"], SocialPost["tone"]> = {
  bullish: "bearish", bearish: "bullish", neutral: "neutral",
};

export interface CollectedSocialSource {
  name: string;
  /** null = the request failed. */
  posts: SocialPost[] | null;
  /** The source's tone is about an asset that moves against equities (VIX):
   *  "bullish VIX" is bearish for stocks, so tone is inverted before scoring. */
  invertTone?: boolean;
}

/**
 * Pure scoring step, exported for tests. Missing, stale, undated and
 * too-small samples yield score = null with a status, never a neutral 0
 * (which the composite would map to a 50 "neutral" gauge). A post enters the
 * score only with a readable timestamp inside SOCIAL_MAX_AGE_HOURS; posts of
 * unknown age are dropped and mark the result as partial.
 */
export function summarizeSocial(
  collected: CollectedSocialSource[],
  nowMs: number = Date.now(),
): SocialSentiment {
  const sources: SocialSourceState[] = [];
  const used: SocialPost[] = [];
  const maxAgeMs = SOCIAL_MAX_AGE_HOURS * 3600_000;
  let undatedDropped = 0;
  for (const src of collected) {
    if (src.posts == null) {
      sources.push({ name: src.name, state: "failed", posts: 0, newest: null });
      continue;
    }
    if (src.posts.length === 0) {
      sources.push({ name: src.name, state: "empty", posts: 0, newest: null });
      continue;
    }
    const dated = src.posts
      .map((p) => ({ p, t: p.timestamp ? Date.parse(p.timestamp) : NaN }))
      .filter((x) => Number.isFinite(x.t));
    const undated = src.posts.length - dated.length;
    undatedDropped += undated;
    const newestMs = dated.length ? Math.max(...dated.map((x) => x.t)) : null;
    const newest = newestMs != null ? new Date(newestMs).toISOString() : null;
    const fresh = dated.filter((x) => nowMs - x.t <= maxAgeMs && x.t <= nowMs + 5 * 60_000).map((x) => x.p);
    if (dated.length === 0) {
      sources.push({ name: src.name, state: "undated", posts: src.posts.length, newest: null, dropped: undated });
    } else if (fresh.length === 0) {
      sources.push({ name: src.name, state: "stale", posts: src.posts.length, newest, dropped: src.posts.length });
    } else {
      sources.push({ name: src.name, state: "ok", posts: fresh.length, newest, dropped: src.posts.length - fresh.length });
      used.push(...(src.invertTone ? fresh.map((p) => ({ ...p, tone: INVERT_TONE[p.tone] })) : fresh));
    }
  }
  const bullish = used.filter((p) => p.tone === "bullish").length;
  const bearish = used.filter((p) => p.tone === "bearish").length;
  const neutral = used.filter((p) => p.tone === "neutral").length;
  const tagged = bullish + bearish;
  const anyUsable = sources.some((x) => x.state === "ok");
  const degraded = undatedDropped > 0 || sources.some((x) => x.state !== "ok");
  let status: NonNullable<SocialSentiment["status"]>;
  let score: number | null = null;
  if (!anyUsable) status = "unavailable";
  else if (tagged < SOCIAL_MIN_TAGGED) status = "insufficient";
  else {
    score = Math.round(((bullish - bearish) / tagged) * 100);
    status = degraded ? "partial" : "ok";
  }
  return { score, bullish, bearish, neutral, posts: used.slice(0, 40), status, sources, asOf: nowMs };
}

/** StockTwits SPY + VIX streams into one SocialSentiment payload (keyword/tag
 *  tone, a heuristic). Social media: a weak, context-only source (see
 *  server/sources/registry.ts), never a price, greeks, options or sizing input. */
export async function gatherSocial(): Promise<SocialSentiment> {
  const settle = async (name: string, p: Promise<SocialPost[]>, invertTone = false): Promise<CollectedSocialSource> => {
    try { return { name, posts: await p, invertTone }; } catch { return { name, posts: null, invertTone }; }
  };
  const collected = await Promise.all([
    settle("StockTwits SPY", fetchStockTwits("SPY", 30)),
    // VIX chatter: tone inverted (bullish VIX = bearish equities); the post's
    // tone shown on the card is the equity read, and the author is tagged.
    settle("StockTwits VIX (tone inverted)", fetchStockTwits("VIX", 15).then((ps) =>
      ps.map((p) => ({ ...p, author: `${p.author ?? ""} on $VIX (tone shown for equities)` }))), true),
  ]);
  return summarizeSocial(collected);
}

/** Market news headlines for the Signals snapshot (finding 5.8).
 *  Schwab has no news API; this reuses the News tab's labeled RSS sources
 *  (server/news.ts) with source, publish time and a feed status, so a failed
 *  collection reads "unavailable" instead of an always-empty list. Context
 *  only: headlines never feed a price, greeks, options or sizing calculation.
 */
export async function fetchHeadlines(): Promise<HeadlineFeed> {
  try {
    return await fetchMarketHeadlineFeed();
  } catch (e: any) {
    return {
      items: [], status: "unavailable", sources: [], maxAgeHours: 24, undatedDropped: 0, asOf: Date.now(),
      note: `no headline source: ${String(e?.message ?? e).slice(0, 120)}`,
    };
  }
}
