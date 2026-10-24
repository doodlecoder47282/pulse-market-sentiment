// server/tickerAlpha.ts
//
// Single-name alpha synthesis. For any ticker (ASTS, NVDA, AMD, whatever the
// user types), fuse three independent signal streams into one alpha card:
//
//   1. NEWS  — ticker-tagged headlines, ranked by tier
//   2. SOCIAL — StockTwits cashtag volume + sentiment (X when configured)
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
import { gexByStrikeFromChain, gexRegime } from "./gammaProfile";
import { contractYears } from "./chainClock";
import { schwabNum } from "./schwabChainRows";

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
  /** -100..100 net tone (bull - bear) / total. null = no tagged posts (or
   *  none read); see scoreReason. Missing is not zero. */
  score: number | null;
  /** Why score is null; null when a score exists. */
  scoreReason: string | null;
  bullish: number;
  bearish: number;
  neutral: number;
  /** Total messages observed in the window. The talk-volume number. */
  messageCount: number;
  /** Z-score of messageCount vs 7-day baseline. >2 = unusual social spike. */
  volumeZ: number;
  /** Top 8 posts by recency/quality */
  topPosts: SocialPost[];
  /** Where the chatter is coming from: post counts per source; null = the
   *  source was not read (failed, not configured, or removed), never 0 posts. */
  bySource: { stocktwits: number | null; reddit: number | null; x: number | null };
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
    /** null = no social tone score available (not zero) */
    socialBias: number | null;
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
  } catch (e) {
    // Rethrown so the caller reports "failed" (count null), not 0 posts.
    throw e;
  }
}

// ---- Social: Reddit (removed) ----
// The keyless Reddit search was removed (round 2, R2-I): the Reddit Data API
// requires a registered OAuth client and blocks unauthenticated traffic
// ("Reddit Data API Wiki",
// https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki).
// bySource.reddit is null ("not available"), never 0 posts.

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
  let stOk = true;
  const xConfigured = Boolean(process.env.X_BEARER_TOKEN);
  const [st, x] = await Promise.all([
    fetchStockTwitsForSymbol(t, 30).catch(() => { stOk = false; warnings.push("StockTwits: fetch failed"); return [] as SocialPost[]; }),
    fetchXCashtag(t).catch(() => [] as SocialPost[]),
  ]);
  if (!xConfigured) warnings.push("X disabled (no X_BEARER_TOKEN)");
  warnings.push("Reddit not available (its Data API requires OAuth; keyless read removed)");

  const all = [...st, ...x];
  const bullish = all.filter((p) => p.tone === "bullish").length;
  const bearish = all.filter((p) => p.tone === "bearish").length;
  const neutral = all.filter((p) => p.tone === "neutral").length;
  const tagged = bullish + bearish;
  const score = tagged > 0 ? Math.round(((bullish - bearish) / tagged) * 100) : null;
  const scoreReason = score != null
    ? null
    : all.length === 0
      ? "no posts read from any social source"
      : "no bullish/bearish-tagged posts in the window";
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
    scoreReason,
    bullish,
    bearish,
    neutral,
    messageCount,
    volumeZ: Number(volumeZ.toFixed(2)),
    topPosts: ranked,
    bySource: { stocktwits: stOk ? st.length : null, reddit: null, x: xConfigured ? x.length : null },
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
  pcrOi: number | null;
  pcrVol: number | null;
  atmIv: number | null;
  ivSkew25d: number | null;
  profile: GammaProfileRow[];
  /** Largest |net exposure| on one strike; the regime's materiality floor. */
  peakAbsGex: number;
  /** Priced contracts behind the profile. */
  contracts: number;
}

/**
 * Build a per-ticker gamma structure from a Schwab chain response.
 *
 * Exposure, walls and flip come from the app-wide re-priced basis
 * (gammaProfile.gexByStrikeFromChain: Black-Scholes gamma from the chain's
 * implied volatility on the shared settlement clock, open-interest weight,
 * 0-45 DTE, calls positive / puts negative). The vendor `gamma` field is not
 * used: Schwab emits -999 when it has not computed greeks (closed market,
 * illiquid names), and -999 is finite and non-zero, so the old branch priced
 * those contracts at -999 gamma and put walls on sentinel strikes. Every
 * contract in a strike cell is read (an adjusted deliverable or the SPX/SPXW
 * pair on a monthly opex share a cell); the clock drops settled ones.
 * Open interest, volume and IV totals use schwabNum: a missing field is
 * missing, never zero, and a ratio with no denominator is null, never 0.
 */
export function buildPerTickerGamma(chain: any, ticker: string, nowMs: number = Date.now()): PerTickerGamma | null {
  if (!chain || chain.error) return null;
  const spotRaw =
    Number(chain?.underlying?.last) ||
    Number(chain?.underlyingPrice) ||
    null;
  if (!spotRaw || !isFinite(spotRaw)) return null;
  const S: number = spotRaw;

  const gex = gexByStrikeFromChain({ ...chain, symbol: chain.symbol ?? ticker }, nowMs);
  if (gex.dataState !== "ok") return null;

  const callMap = chain.callExpDateMap || {};
  const putMap = chain.putExpDateMap || {};
  const callOiByStrike = new Map<number, number>();
  const putOiByStrike = new Map<number, number>();
  let totalCallOi = 0, totalPutOi = 0, callVol = 0, putVol = 0;
  let sawCallVol = false, sawPutVol = false;
  const ivSamples: { K: number; iv: number; type: "C" | "P" }[] = [];

  function ingest(map: any, type: "C" | "P") {
    for (const expKey of Object.keys(map)) {
      const dteMatch = /:(\d+)/.exec(expKey);
      const dteDays = dteMatch ? parseInt(dteMatch[1]) : NaN;
      if (!isFinite(dteDays) || dteDays < 0 || dteDays > 45) continue;
      const strikes = map[expKey];
      for (const strikeKey of Object.keys(strikes)) {
        const K = parseFloat(strikeKey);
        if (!isFinite(K)) continue;
        const arr = strikes[strikeKey];
        if (!Array.isArray(arr)) continue;
        for (const c of arr) {
          const T = contractYears(expKey, c, nowMs);
          if (!(T > 0)) continue;
          const oi = schwabNum(c?.openInterest);
          const vol = schwabNum(c?.totalVolume);
          if (oi == null || oi <= 0) continue;
          if (type === "C") {
            callOiByStrike.set(K, (callOiByStrike.get(K) || 0) + oi);
            totalCallOi += oi;
            if (vol != null) { callVol += vol; sawCallVol = true; }
          } else {
            putOiByStrike.set(K, (putOiByStrike.get(K) || 0) + oi);
            totalPutOi += oi;
            if (vol != null) { putVol += vol; sawPutVol = true; }
          }
          const ivPct = schwabNum(c?.volatility);
          if (ivPct != null && ivPct > 0 && ivPct < 500) ivSamples.push({ K, iv: ivPct / 100, type });
        }
      }
    }
  }
  ingest(callMap, "C");
  ingest(putMap, "P");

  const byStrike = new Map(gex.profile.map((p) => [p.strike, p.netGex] as const));
  const strikes = gex.profile.map((p) => p.strike);
  if (strikes.length === 0) return null;
  const totalGex = gex.profile.reduce((a, p) => a + p.netGex, 0);
  const peakAbs = gex.profile.reduce((a, p) => Math.max(a, Math.abs(p.netGex)), 0);

  const callWall = gex.callWall;
  const putWall = gex.putWall;
  const callWallGex = callWall != null ? (gex.profile.find((p) => p.strike === callWall)?.callGex ?? null) : null;
  const putWallGex = putWall != null ? (gex.profile.find((p) => p.strike === putWall)?.putGex ?? null) : null;
  const zeroGamma = gex.zeroGamma;

  // Max pain over the same 0-45 DTE open interest (strike minimising OI x distance).
  const painStrikes = Array.from(new Set([...callOiByStrike.keys(), ...putOiByStrike.keys()])).sort((a, b) => a - b);
  let maxPain: number | null = null;
  let minPain = Infinity;
  for (const k of painStrikes) {
    let pain = 0;
    for (const k2 of painStrikes) {
      const co = callOiByStrike.get(k2) || 0;
      const po = putOiByStrike.get(k2) || 0;
      if (k > k2) pain += co * (k - k2);
      if (k < k2) pain += po * (k2 - k);
    }
    if (pain < minPain) { minPain = pain; maxPain = k; }
  }

  // Nearest-strike IV (mean of the 4 samples nearest spot, 0-45 DTE, all expiries).
  const atmSamples = ivSamples
    .slice()
    .sort((a, b) => Math.abs(a.K - S) - Math.abs(b.K - S))
    .slice(0, 4)
    .map((s) => s.iv);
  const atmIv = atmSamples.length > 0 ? atmSamples.reduce((a, b) => a + b, 0) / atmSamples.length : null;

  // Skew proxy: IV at the put strike nearest 0.92 S minus the call strike nearest 1.08 S (all 0-45 DTE expiries).
  function nearestIv(target: number, type: "C" | "P"): number | null {
    const s = ivSamples.filter((x) => x.type === type).sort((a, b) => Math.abs(a.K - target) - Math.abs(b.K - target));
    return s.length > 0 ? s[0].iv : null;
  }
  const otmPutIv = nearestIv(S * 0.92, "P");
  const otmCallIv = nearestIv(S * 1.08, "C");
  const ivSkew25d = otmPutIv != null && otmCallIv != null ? otmPutIv - otmCallIv : null;

  const pcrOi = totalCallOi > 0 ? totalPutOi / totalCallOi : null;
  const pcrVol = sawCallVol && sawPutVol && callVol > 0 ? putVol / callVol : null;

  const profile: GammaProfileRow[] = strikes
    .filter((k) => k >= S * 0.85 && k <= S * 1.15)
    .map((k) => ({
      strike: k,
      gex: byStrike.get(k) || 0,
      callOi: callOiByStrike.get(k) || 0,
      putOi: putOiByStrike.get(k) || 0,
    }));

  return {
    spot: S,
    totalGex,
    peakAbsGex: peakAbs,
    contracts: gex.profile.length,
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

const INDEX_WIRE_SYMBOLS = new Set(["SPX", "NDX", "RUT", "VIX", "DJX", "OEX", "XSP"]);
const _posCache = new Map<string, { ts: number; data: PositioningSnapshot }>();
const POS_TTL_MS = 5 * 60 * 1000;

export async function gatherPositioningForTicker(ticker: string): Promise<PositioningSnapshot> {
  const t = ticker.toUpperCase().replace(/^[$^]/, "");
  // Schwab wants cash indexes as $SPX / $NDX / $RUT / $VIX; the bare name is
  // the cache key and the display name only.
  const wire = INDEX_WIRE_SYMBOLS.has(t) ? `$${t}` : t;
  const cached = _posCache.get(t);
  if (cached && Date.now() - cached.ts < POS_TTL_MS) return cached.data;

  const warnings: string[] = [];
  let spot: number | null = null;
  let gamma: PerTickerGamma | null = null;

  try {
    const quotes = await getQuotes([wire]);
    const q = quotes && quotes[0];
    spot = (q && (q.last ?? (q as any).mark)) ?? null;
  } catch (e: any) {
    warnings.push(`Schwab quote failed: ${e?.message ?? "unknown"}`);
  }

  try {
    const chain = await getOptionChain(wire, 45);
    if (chain && !("error" in chain)) {
      gamma = buildPerTickerGamma(chain, wire);
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
    // Sign only when it clears the materiality floor; an exact 0 or sub-noise
    // total is "unknown", never "positive".
    regime: gexRegime(gamma?.totalGex, gamma?.peakAbsGex, gamma?.contracts ?? 0),
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
  // null when there is no tone score (missing, not zero): the composite then
  // drops the social leg and renormalises the remaining weights.
  let socialBias: number | null = social.score;
  if (socialBias != null && social.messageCount < 20) socialBias = Math.round(socialBias * 0.5);

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
  const composite = socialBias == null
    ? (newsHeavy
        ? Math.round((0.45 * newsBias + 0.30 * posBias) / 0.75)
        : Math.round((0.30 * newsBias + 0.40 * posBias) / 0.70))
    : newsHeavy
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
    socialBias: socialBias == null ? null : Math.max(-100, Math.min(100, socialBias)),
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
