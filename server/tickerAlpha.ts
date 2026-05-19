// server/tickerAlpha.ts
//
// Single-name alpha synthesis. For any ticker (ASTS, NVDA, AMD, whatever the
// user types), fuse three independent signal streams into one alpha card:
//
//   1. NEWS  — ticker-tagged headlines, ranked by tier
//   2. SOCIAL — StockTwits cashtag volume + sentiment, Reddit mention scan
//   3. POSITIONING — gamma walls, OI shifts, dealer regime, options skew
//
// Output: a unified "TickerAlpha" block that the synthesis layer
// (LLM-augmented in tickerOutlook.ts) digests into a verdict card.
//
// This is the lift the user asked for: "Alpha news for tickers must be huge
// news talk and social media exposure mixed with positioning in the stock so
// AI can make the best summary of it all to provide said alpha."

// Local fetchJson — sources.ts keeps its copy private. Mirrors the shape exactly.
async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      ...headers,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
import { getAlphaEventsForTicker, type AlphaEvent } from "./alphaNews";
import { getOptionChain, getQuotes } from "./schwab";

// ---- Types ----

export type AlphaTone = "bullish" | "bearish" | "neutral";

export interface SocialPost {
  source: "StockTwits" | "Reddit" | "X";
  author: string;
  text: string;
  url: string;
  ts?: number;
  tone: AlphaTone;
}

export interface SocialExposure {
  /** -100..100 net tone (bull - bear) / total */
  score: number;
  bullish: number;
  bearish: number;
  neutral: number;
  /** Total messages observed in the window. The talk-volume number. */
  messageCount: number;
  /** Z-score of messageCount vs 7-day baseline. >2 = unusual social spike. */
  volumeZ: number;
  /** Top 8 posts by recency/quality */
  topPosts: SocialPost[];
  /** Where the chatter is coming from */
  bySource: { stocktwits: number; reddit: number; x: number };
  warnings: string[];
}

export interface PositioningSnapshot {
  spot: number | null;
  /** Net gamma exposure in $ */
  totalGex: number | null;
  /** "positive" = mean-reverting / chop ; "negative" = momentum / trend */
  regime: "positive" | "negative" | "unknown";
  callWall: number | null;
  callWallGex: number | null;
  putWall: number | null;
  putWallGex: number | null;
  gammaFlip: number | null;
  maxPain: number | null;
  /** Distance from spot to nearest wall in % */
  distToCallWallPct: number | null;
  distToPutWallPct: number | null;
  /** Put/Call open interest ratio. >1 = put-heavy (typically bearish hedge demand). */
  pcrOi: number | null;
  /** Put/Call volume ratio for the day. */
  pcrVol: number | null;
  /** Implied vol skew (25d put IV - 25d call IV). High = fear, low = greed. */
  ivSkew25d: number | null;
  /** ATM IV (front month). */
  atmIv: number | null;
  /** Strike-level GEX profile within ±15% of spot */
  profile: { strike: number; gex: number; callOi: number; putOi: number }[];
  warnings: string[];
}

export interface TickerAlpha {
  ticker: string;
  asOf: string;
  news: {
    events: AlphaEvent[];
    warnings: string[];
  };
  social: SocialExposure;
  positioning: PositioningSnapshot;
  /** Quick rollup the verdict layer keys off */
  rollup: {
    /** -100..100 */
    newsBias: number;
    socialBias: number;
    positioningBias: number;
    /** Composite -100..100 */
    composite: number;
    /** Edge-type tag for the verdict layer */
    edgeType: "informational" | "analytical" | "behavioral" | "environmental" | "none";
  };
}

// ---- Helpers ----

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

const BULL_TERMS = /\b(moon|rocket|🚀|squeeze|breakout|rip|rally|long|calls|buy(?:ing)?|bullish|run|pump|🟢|gainer|target raised|beat|upgraded|accumulate)\b/i;
const BEAR_TERMS = /\b(crash|dump|short|puts|bearish|sell(?:ing)?|drop|tank|red|🔴|loss|miss|downgrade|cut|guide down|fade|sell-off)\b/i;

function scoreText(text: string): AlphaTone {
  const t = text.toLowerCase();
  const b = (t.match(BULL_TERMS) || []).length;
  const r = (t.match(BEAR_TERMS) || []).length;
  if (b > r) return "bullish";
  if (r > b) return "bearish";
  return "neutral";
}

// ---- Social: StockTwits cashtag ----

async function fetchStockTwitsForSymbol(symbol: string, limit = 30): Promise<SocialPost[]> {
  try {
    const d = await fetchJson(
      `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json?limit=${limit}`
    );
    const msgs = d?.messages ?? [];
    return msgs.map((m: any) => {
      const body = decodeEntities(m.body || "");
      const explicit = m?.entities?.sentiment?.basic?.toLowerCase();
      const tone: AlphaTone =
        explicit === "bullish" ? "bullish"
        : explicit === "bearish" ? "bearish"
        : scoreText(body);
      return {
        source: "StockTwits" as const,
        author: "@" + (m.user?.username ?? "?"),
        text: body.slice(0, 280),
        url: `https://stocktwits.com/${m.user?.username}/message/${m.id}`,
        ts: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : undefined,
        tone,
      };
    });
  } catch {
    return [];
  }
}

// ---- Social: Reddit cashtag/mention scan ----

const REDDIT_SUBS = ["wallstreetbets", "stocks", "options", "investing", "StockMarket"];

async function fetchRedditMentions(ticker: string, perSub = 25): Promise<SocialPost[]> {
  const out: SocialPost[] = [];
  // Reddit search for the ticker symbol with cashtag and bare-word variants
  const queries = [`%24${ticker}`, ticker];
  for (const sub of REDDIT_SUBS) {
    for (const q of queries) {
      try {
        const d = await fetchJson(
          `https://www.reddit.com/r/${sub}/search.json?q=${q}&restrict_sr=1&sort=new&limit=${perSub}&t=week`
        );
        const items = d?.data?.children ?? [];
        for (const c of items) {
          const title = c?.data?.title || "";
          const body = c?.data?.selftext || "";
          const text = `${title} ${body}`.slice(0, 360);
          if (!title) continue;
          // De-duplicate
          const url = `https://www.reddit.com${c.data.permalink}`;
          if (out.some((p) => p.url === url)) continue;
          out.push({
            source: "Reddit",
            author: `r/${sub}`,
            text,
            url,
            ts: c?.data?.created_utc,
            tone: scoreText(text),
          });
        }
      } catch {
        // continue silently
      }
    }
  }
  return out;
}

// ---- Social: X cashtag (when X_BEARER_TOKEN is set) ----

async function fetchXCashtag(ticker: string): Promise<SocialPost[]> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return [];
  try {
    // Recent search — last 24h, English, no retweets, max_results=50
    const q = encodeURIComponent(`$${ticker} -is:retweet lang:en`);
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${q}&max_results=50&tweet.fields=created_at,public_metrics,author_id`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const d = await res.json();
    const tweets = d?.data ?? [];
    return tweets.map((t: any) => ({
      source: "X" as const,
      author: t.author_id ? `user_${String(t.author_id).slice(-6)}` : "x",
      text: (t.text || "").slice(0, 280),
      url: `https://x.com/i/status/${t.id}`,
      ts: t.created_at ? Math.floor(new Date(t.created_at).getTime() / 1000) : undefined,
      tone: scoreText(t.text || ""),
    }));
  } catch {
    return [];
  }
}

// ---- Social aggregation + 7-day volume baseline ----

const _socialBaseline = new Map<string, { samples: number[]; lastUpdated: number }>();

function recordSocialVolume(ticker: string, n: number) {
  const b = _socialBaseline.get(ticker) ?? { samples: [], lastUpdated: 0 };
  // Keep up to 7 daily-equivalent samples; one new sample per >= 12h gap
  const now = Date.now();
  if (now - b.lastUpdated > 12 * 60 * 60 * 1000) {
    b.samples.push(n);
    if (b.samples.length > 7) b.samples.shift();
    b.lastUpdated = now;
  }
  _socialBaseline.set(ticker, b);
}

function getSocialVolumeZ(ticker: string, current: number): number {
  const b = _socialBaseline.get(ticker);
  if (!b || b.samples.length < 3) return 0;
  const mean = b.samples.reduce((a, x) => a + x, 0) / b.samples.length;
  const variance =
    b.samples.reduce((a, x) => a + (x - mean) ** 2, 0) / b.samples.length;
  const std = Math.sqrt(variance) || 1;
  return (current - mean) / std;
}

export async function gatherSocialForTicker(ticker: string): Promise<SocialExposure> {
  const t = ticker.toUpperCase().replace(/^[$^]/, "");
  const warnings: string[] = [];
  const [st, rd, x] = await Promise.all([
    fetchStockTwitsForSymbol(t, 30).catch(() => { warnings.push("StockTwits: fetch failed"); return []; }),
    fetchRedditMentions(t, 15).catch(() => { warnings.push("Reddit: fetch failed"); return []; }),
    fetchXCashtag(t).catch(() => []),
  ]);
  if (!process.env.X_BEARER_TOKEN) warnings.push("X disabled (no X_BEARER_TOKEN)");

  const all = [...st, ...rd, ...x];
  const bullish = all.filter((p) => p.tone === "bullish").length;
  const bearish = all.filter((p) => p.tone === "bearish").length;
  const neutral = all.filter((p) => p.tone === "neutral").length;
  const tagged = bullish + bearish;
  const score = tagged > 0 ? Math.round(((bullish - bearish) / tagged) * 100) : 0;
  const messageCount = all.length;
  recordSocialVolume(t, messageCount);
  const volumeZ = getSocialVolumeZ(t, messageCount);

  // Rank top posts: explicit-toned, recent, from any source
  const ranked = all
    .slice()
    .sort((a, b) => {
      const ats = a.ts ?? 0;
      const bts = b.ts ?? 0;
      return bts - ats;
    })
    .slice(0, 8);

  return {
    score,
    bullish,
    bearish,
    neutral,
    messageCount,
    volumeZ: Number(volumeZ.toFixed(2)),
    topPosts: ranked,
    bySource: { stocktwits: st.length, reddit: rd.length, x: x.length },
    warnings,
  };
}

// ---- Positioning: per-ticker gamma from Schwab chain ----

interface GammaProfileRow {
  strike: number;
  gex: number;
  callOi: number;
  putOi: number;
}

interface PerTickerGamma {
  spot: number | null;
  totalGex: number;
  callWall: number | null;
  callWallGex: number;
  putWall: number | null;
  putWallGex: number;
  zeroGamma: number | null;
  maxPain: number | null;
  pcrOi: number;
  pcrVol: number;
  atmIv: number | null;
  ivSkew25d: number | null;
  profile: GammaProfileRow[];
}

function approxGamma(K: number, S: number, T: number, iv: number): number {
  // Black-Scholes gamma approximation (r=0, q=0). T in years, iv as decimal.
  if (T <= 0 || iv <= 0 || S <= 0) return 0;
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  const phi = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  return phi / (S * iv * Math.sqrt(T));
}

/**
 * Build a per-ticker gamma structure from a Schwab chain response.
 * Aggregates 0-45 DTE strikes, computes GEX with sign convention
 * (calls positive, puts negative for dealer-perspective dealer-long-vol view).
 */
function buildPerTickerGamma(chain: any, ticker: string): PerTickerGamma | null {
  if (!chain || chain.error) return null;
  const S =
    Number(chain?.underlying?.last) ||
    Number(chain?.underlyingPrice) ||
    null;
  if (!S || !isFinite(S)) return null;

  const callMap = chain.callExpDateMap || {};
  const putMap = chain.putExpDateMap || {};

  const gexByStrike = new Map<number, number>();
  const callOiByStrike = new Map<number, number>();
  const putOiByStrike = new Map<number, number>();
  let totalCallOi = 0,
    totalPutOi = 0,
    callVol = 0,
    putVol = 0;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const ivSamples: { K: number; iv: number; type: "C" | "P" }[] = [];

  function ingest(
    map: any,
    type: "C" | "P"
  ) {
    for (const expKey of Object.keys(map)) {
      // expKey format e.g. "2026-05-30:12" (date:dteDays)
      const dteMatch = /:(\d+)/.exec(expKey);
      const dteDays = dteMatch ? parseInt(dteMatch[1]) : NaN;
      if (!isFinite(dteDays) || dteDays < 0 || dteDays > 45) continue;
      const T = Math.max(dteDays, 1) / 365;
      const strikes = map[expKey];
      for (const strikeKey of Object.keys(strikes)) {
        const K = parseFloat(strikeKey);
        if (!isFinite(K)) continue;
        const arr = strikes[strikeKey];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const c = arr[0];
        const oi = Number(c.openInterest) || 0;
        const vol = Number(c.totalVolume) || 0;
        if (oi <= 0) continue;
        let g = Number(c.gamma);
        const iv = Number(c.volatility);
        if (!isFinite(g) || g === 0) {
          // Compute from IV if Schwab gamma is missing
          if (isFinite(iv) && iv > 0) {
            g = approxGamma(K, S, T, iv / 100);
          } else {
            continue;
          }
        }
        const sign = type === "C" ? 1 : -1;
        const gex = sign * g * oi * 100 * S * S * 0.01;
        gexByStrike.set(K, (gexByStrike.get(K) || 0) + gex);
        if (type === "C") {
          callOiByStrike.set(K, (callOiByStrike.get(K) || 0) + oi);
          totalCallOi += oi;
          callVol += vol;
        } else {
          putOiByStrike.set(K, (putOiByStrike.get(K) || 0) + oi);
          totalPutOi += oi;
          putVol += vol;
        }
        if (isFinite(iv) && iv > 0) {
          ivSamples.push({ K, iv: iv / 100, type });
        }
      }
    }
  }
  ingest(callMap, "C");
  ingest(putMap, "P");

  const strikes = Array.from(gexByStrike.keys()).sort((a, b) => a - b);
  if (strikes.length === 0) return null;
  const totalGex = strikes.reduce((a, k) => a + (gexByStrike.get(k) || 0), 0);

  // Walls — strike with most positive GEX (call wall) and most negative (put wall)
  let callWall: number | null = null,
    callWallGex = -Infinity;
  let putWall: number | null = null,
    putWallGex = Infinity;
  for (const k of strikes) {
    const g = gexByStrike.get(k) || 0;
    if (g > callWallGex) {
      callWallGex = g;
      callWall = k;
    }
    if (g < putWallGex) {
      putWallGex = g;
      putWall = k;
    }
  }

  // Zero gamma: linear interp where cumulative GEX flips sign
  let zeroGamma: number | null = null;
  let cum = 0;
  for (let i = 0; i < strikes.length - 1; i++) {
    const k = strikes[i];
    const kNext = strikes[i + 1];
    const cumNext = cum + (gexByStrike.get(k) || 0);
    if (cum <= 0 && cumNext > 0) {
      zeroGamma = k + ((kNext - k) * -cum) / Math.max(cumNext - cum, 1);
      break;
    }
    cum = cumNext;
  }
  if (zeroGamma == null) {
    // fallback: strike where running sum is minimum |sum|
    let best = Infinity;
    let bestK = strikes[Math.floor(strikes.length / 2)];
    let run = 0;
    for (const k of strikes) {
      run += gexByStrike.get(k) || 0;
      if (Math.abs(run) < best) {
        best = Math.abs(run);
        bestK = k;
      }
    }
    zeroGamma = bestK;
  }

  // Max pain — strike that minimizes total option pain (open interest × distance)
  let maxPain: number | null = null;
  let minPain = Infinity;
  for (const k of strikes) {
    let pain = 0;
    for (const k2 of strikes) {
      const co = callOiByStrike.get(k2) || 0;
      const po = putOiByStrike.get(k2) || 0;
      if (k > k2) pain += co * (k - k2);
      if (k < k2) pain += po * (k2 - k);
    }
    if (pain < minPain) {
      minPain = pain;
      maxPain = k;
    }
  }

  // ATM IV — average call+put IV nearest to spot
  const atmSamples = ivSamples
    .slice()
    .sort((a, b) => Math.abs(a.K - S) - Math.abs(b.K - S))
    .slice(0, 4)
    .map((s) => s.iv);
  const atmIv =
    atmSamples.length > 0
      ? atmSamples.reduce((a, b) => a + b, 0) / atmSamples.length
      : null;

  // 25-delta-ish skew proxy: IV at ~0.92S puts minus IV at ~1.08S calls
  function nearestIv(target: number, type: "C" | "P"): number | null {
    const s = ivSamples
      .filter((x) => x.type === type)
      .sort((a, b) => Math.abs(a.K - target) - Math.abs(b.K - target));
    return s.length > 0 ? s[0].iv : null;
  }
  const otmPutIv = nearestIv(S * 0.92, "P");
  const otmCallIv = nearestIv(S * 1.08, "C");
  const ivSkew25d =
    otmPutIv != null && otmCallIv != null ? otmPutIv - otmCallIv : null;

  const pcrOi = totalCallOi > 0 ? totalPutOi / totalCallOi : 0;
  const pcrVol = callVol > 0 ? putVol / callVol : 0;

  // Build the strike profile within ±15% of spot
  const profile: GammaProfileRow[] = strikes
    .filter((k) => k >= S * 0.85 && k <= S * 1.15)
    .map((k) => ({
      strike: k,
      gex: gexByStrike.get(k) || 0,
      callOi: callOiByStrike.get(k) || 0,
      putOi: putOiByStrike.get(k) || 0,
    }));

  return {
    spot: S,
    totalGex,
    callWall,
    callWallGex,
    putWall,
    putWallGex,
    zeroGamma,
    maxPain,
    pcrOi,
    pcrVol,
    atmIv,
    ivSkew25d,
    profile,
  };
}

const _posCache = new Map<string, { ts: number; data: PositioningSnapshot }>();
const POS_TTL_MS = 5 * 60 * 1000;

export async function gatherPositioningForTicker(ticker: string): Promise<PositioningSnapshot> {
  const t = ticker.toUpperCase().replace(/^[$^]/, "");
  const cached = _posCache.get(t);
  if (cached && Date.now() - cached.ts < POS_TTL_MS) return cached.data;

  const warnings: string[] = [];
  let spot: number | null = null;
  let gamma: PerTickerGamma | null = null;

  try {
    const quotes = await getQuotes([t]);
    const q = quotes && quotes[0];
    spot = (q && (q.last ?? (q as any).mark)) ?? null;
  } catch (e: any) {
    warnings.push(`Schwab quote failed: ${e?.message ?? "unknown"}`);
  }

  try {
    const chain = await getOptionChain(t, 45);
    if (chain && !("error" in chain)) {
      gamma = buildPerTickerGamma(chain, t);
      if (!gamma) warnings.push("Chain returned but gamma build failed");
    } else {
      warnings.push("Schwab chain unavailable");
    }
  } catch (e: any) {
    warnings.push(`Schwab chain failed: ${e?.message ?? "unknown"}`);
  }

  const s = spot ?? gamma?.spot ?? null;
  const data: PositioningSnapshot = {
    spot: s,
    totalGex: gamma?.totalGex ?? null,
    regime:
      gamma?.totalGex == null
        ? "unknown"
        : gamma.totalGex >= 0
        ? "positive"
        : "negative",
    callWall: gamma?.callWall ?? null,
    callWallGex: gamma?.callWallGex ?? null,
    putWall: gamma?.putWall ?? null,
    putWallGex: gamma?.putWallGex ?? null,
    gammaFlip: gamma?.zeroGamma ?? null,
    maxPain: gamma?.maxPain ?? null,
    distToCallWallPct:
      s && gamma?.callWall ? ((gamma.callWall - s) / s) * 100 : null,
    distToPutWallPct:
      s && gamma?.putWall ? ((gamma.putWall - s) / s) * 100 : null,
    pcrOi: gamma?.pcrOi ?? null,
    pcrVol: gamma?.pcrVol ?? null,
    ivSkew25d: gamma?.ivSkew25d ?? null,
    atmIv: gamma?.atmIv ?? null,
    profile: gamma?.profile ?? [],
    warnings,
  };
  _posCache.set(t, { ts: Date.now(), data });
  return data;
}

// ---- Rollup ----

function rollupBias(
  news: { events: any[] },
  social: SocialExposure,
  positioning: PositioningSnapshot,
): TickerAlpha["rollup"] {
  // News bias: weighted by tier + initial bias
  let newsScore = 0;
  let newsWeight = 0;
  for (const e of news.events ?? []) {
    const w = e.tier === "TIER_1" ? 3 : e.tier === "TIER_2" ? 2 : 1;
    const dir = e.initialBias === "BULL" ? 1 : e.initialBias === "BEAR" ? -1 : 0;
    newsScore += w * dir * (e.alphaScore ?? 50);
    newsWeight += w * 100;
  }
  const newsBias = newsWeight > 0 ? Math.round((newsScore / newsWeight) * 100) : 0;

  // Social bias: tone score, dampened by low message count
  let socialBias = social.score;
  if (social.messageCount < 20) socialBias = Math.round(socialBias * 0.5);

  // Positioning bias: combine GEX regime + P/C OI + skew
  let posBias = 0;
  if (positioning.regime === "positive") posBias += 15;
  else if (positioning.regime === "negative") posBias -= 15;
  if (positioning.pcrOi != null) {
    // P/C OI > 1.2 → put-heavy (bearish hedge demand); < 0.7 → call-heavy (bullish chase)
    if (positioning.pcrOi > 1.2) posBias -= 20;
    else if (positioning.pcrOi < 0.7) posBias += 20;
  }
  if (positioning.ivSkew25d != null) {
    // Positive skew = put IV > call IV = fear bid = contrarian bull (small weight)
    if (positioning.ivSkew25d > 0.03) posBias += 10;
    else if (positioning.ivSkew25d < -0.01) posBias -= 10;
  }
  if (positioning.distToCallWallPct != null && positioning.distToPutWallPct != null) {
    // Closer to call wall than put wall = pinned by chasers above
    const aboveDist = Math.abs(positioning.distToCallWallPct);
    const belowDist = Math.abs(positioning.distToPutWallPct);
    if (aboveDist < belowDist * 0.5) posBias += 8;
    if (belowDist < aboveDist * 0.5) posBias -= 8;
  }
  posBias = Math.max(-100, Math.min(100, posBias));

  // Composite: equal-weight by default; if news is heavy, weight news more
  const newsHeavy = (news.events?.length ?? 0) >= 3;
  const composite = newsHeavy
    ? Math.round(0.45 * newsBias + 0.25 * socialBias + 0.30 * posBias)
    : Math.round(0.30 * newsBias + 0.30 * socialBias + 0.40 * posBias);

  // Edge type
  let edgeType: TickerAlpha["rollup"]["edgeType"] = "none";
  if (news.events?.some((e: any) => e.tier === "TIER_1")) edgeType = "informational";
  else if (social.volumeZ >= 2) edgeType = "behavioral";
  else if (Math.abs(posBias) >= 25) edgeType = "analytical";
  else if (Math.abs(composite) >= 20) edgeType = "environmental";

  return {
    newsBias: Math.max(-100, Math.min(100, newsBias)),
    socialBias: Math.max(-100, Math.min(100, socialBias)),
    positioningBias: posBias,
    composite: Math.max(-100, Math.min(100, composite)),
    edgeType,
  };
}

// ---- Main entry ----

const _alphaCache = new Map<string, { ts: number; data: TickerAlpha }>();
const ALPHA_TTL_MS = 90_000; // 90s — keep responsive but avoid hammering APIs

export async function getTickerAlpha(ticker: string): Promise<TickerAlpha> {
  const t = ticker.toUpperCase().replace(/^[$^]/, "");
  const cached = _alphaCache.get(t);
  if (cached && Date.now() - cached.ts < ALPHA_TTL_MS) return cached.data;

  const [newsResp, social, positioning] = await Promise.all([
    getAlphaEventsForTicker(t).catch(() => ({ events: [] as AlphaEvent[], warnings: ["news fetch failed"] })),
    gatherSocialForTicker(t),
    gatherPositioningForTicker(t),
  ]);
  const news = { events: newsResp.events ?? [], warnings: newsResp.warnings ?? [] };

  const rollup = rollupBias(news, social, positioning);

  const data: TickerAlpha = {
    ticker: t,
    asOf: new Date().toISOString(),
    news,
    social,
    positioning,
    rollup,
  };

  _alphaCache.set(t, { ts: Date.now(), data });
  return data;
}
