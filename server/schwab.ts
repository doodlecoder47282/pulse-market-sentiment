/**
 * server/schwab.ts
 * Charles Schwab API integration: OAuth token management + market data helpers.
 * Schwab is the sole market-data source. No Yahoo fallback.
 */

import { db, schwabTokens } from "./storage";
import { eq } from "drizzle-orm";
import { observeQuote } from "./quoteShield";

// ─── Credentials from environment (read lazily to avoid import-order issues) ──
const getClientId = () => process.env.SCHWAB_CLIENT_ID ?? "";
const getClientSecret = () => process.env.SCHWAB_CLIENT_SECRET ?? "";
const getRedirectUri = () => process.env.SCHWAB_REDIRECT_URI ?? "https://127.0.0.1";

const SCHWAB_BASE = "https://api.schwabapi.com";
const TOKEN_URL = `${SCHWAB_BASE}/v1/oauth/token`;
const MARKET_BASE = `${SCHWAB_BASE}/marketdata/v1`;

// ─── Token management ─────────────────────────────────────────────────────────

/** Retrieve a valid access token, auto-refreshing if needed. Returns null if not connected. */
export async function getAccessToken(): Promise<string | null> {
  const CLIENT_ID = getClientId();
  const CLIENT_SECRET = getClientSecret();
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  const row = db.select().from(schwabTokens).where(eq(schwabTokens.id, 1)).get();
  if (!row) return null;
  const now = Date.now();
  if (row.refreshExpiresAt < now) return null; // refresh token expired — needs full re-auth
  if (row.expiresAt > now + 60_000) return row.accessToken; // still valid (>1 min left)
  // Attempt silent refresh
  try {
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: row.refreshToken,
      }),
    });
    if (!res.ok) {
      console.warn("[schwab] token refresh failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json();
    const newExpiresAt = now + (data.expires_in ?? 1800) * 1000;
    const newRefreshExpiresAt = now + 7 * 24 * 60 * 60 * 1000; // Schwab refresh tokens live 7 days
    db.update(schwabTokens)
      .set({
        accessToken: data.access_token,
        refreshToken: data.refresh_token || row.refreshToken,
        expiresAt: newExpiresAt,
        refreshExpiresAt: newRefreshExpiresAt,
        updatedAt: now,
      })
      .where(eq(schwabTokens.id, 1))
      .run();
    console.log("[schwab] token refreshed successfully");
    return data.access_token;
  } catch (e: any) {
    console.warn("[schwab] token refresh exception:", e?.message);
    return null;
  }
}

/** Exchange an authorization code for tokens and persist them. */
export async function exchangeCodeForTokens(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const CLIENT_ID = getClientId();
  const CLIENT_SECRET = getClientSecret();
  const REDIRECT_URI = getRedirectUri();
  if (!CLIENT_ID || !CLIENT_SECRET) return { ok: false, error: "Schwab credentials not configured" };
  try {
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const decodedCode = decodeURIComponent(code);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: decodedCode,
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("[schwab] code exchange failed:", res.status, txt);
      return { ok: false, error: `Token exchange failed (${res.status}): ${txt}` };
    }
    const data = await res.json();
    const now = Date.now();
    const expiresAt = now + (data.expires_in ?? 1800) * 1000;
    const refreshExpiresAt = now + 7 * 24 * 60 * 60 * 1000;
    // Upsert row id=1
    const existing = db.select().from(schwabTokens).where(eq(schwabTokens.id, 1)).get();
    if (existing) {
      db.update(schwabTokens)
        .set({ accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, refreshExpiresAt, updatedAt: now })
        .where(eq(schwabTokens.id, 1))
        .run();
    } else {
      db.insert(schwabTokens)
        .values({ id: 1, accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, refreshExpiresAt, updatedAt: now })
        .run();
    }
    console.log("[schwab] tokens persisted — connected!");
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Unknown error" };
  }
}

/** Returns the current Schwab connection status. */
export function getSchwabStatus(): {
  connected: boolean;
  expiresIn: number;
  refreshExpiresIn: number;
  needsReauth: boolean;
} {
  const row = db.select().from(schwabTokens).where(eq(schwabTokens.id, 1)).get();
  if (!row) return { connected: false, expiresIn: 0, refreshExpiresIn: 0, needsReauth: false };
  const now = Date.now();
  const needsReauth = row.refreshExpiresAt < now;
  const connected = !needsReauth && row.expiresAt > 0;
  return {
    connected,
    expiresIn: Math.max(0, Math.floor((row.expiresAt - now) / 1000)),
    refreshExpiresIn: Math.max(0, Math.floor((row.refreshExpiresAt - now) / 1000)),
    needsReauth,
  };
}

/** Returns the OAuth authorize URL to open in a new tab. */
export function getAuthUrl(): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
  });
  return `${SCHWAB_BASE}/v1/oauth/authorize?${params.toString()}`;
}

/** Clears stored tokens (disconnect). */
export function clearTokens(): void {
  db.delete(schwabTokens).where(eq(schwabTokens.id, 1)).run();
}

// ─── Generic Schwab fetch with cache + 429 backoff + self-throttle ────────────

// Per-endpoint cache. Key = path|sortedParams. Value = { data, expiresAt }.
const _cache = new Map<string, { data: any; expiresAt: number }>();

// Per-endpoint TTL (ms). Anything not listed = no cache.
function cacheTtlMs(path: string): number {
  if (path.startsWith("marketdata/v1/quotes")) return 30_000;
  if (path.startsWith("marketdata/v1/pricehistory")) return 300_000; // 5min
  if (path.startsWith("marketdata/v1/chains")) return 60_000;
  if (path.startsWith("marketdata/v1/markets")) return 300_000;
  return 0;
}

// Self-throttle: track requests in last 60s. Schwab limit ~120/min on marketdata.
// We cap at 100/min to leave headroom.
const _reqLog: number[] = [];
const MAX_REQ_PER_MIN = 100;

function _trimReqLog() {
  const cutoff = Date.now() - 60_000;
  while (_reqLog.length && _reqLog[0] < cutoff) _reqLog.shift();
}

// Per-endpoint cooldown after 429. Map<endpoint-prefix, expiresAt>.
const _cooldown = new Map<string, number>();
// Per-endpoint 403 streak counter — reset on success.
const _403Streak = new Map<string, number>();

/** Tracks how often we've fallen back to CBOE for chains, per symbol. Reset every 60s. */
const _cboeFallbackHits = new Map<string, { count: number; lastTs: number }>();
function _recordCboeFallback(symbol: string) {
  const now = Date.now();
  const cur = _cboeFallbackHits.get(symbol);
  if (!cur || now - cur.lastTs > 60_000) {
    _cboeFallbackHits.set(symbol, { count: 1, lastTs: now });
  } else {
    _cboeFallbackHits.set(symbol, { count: cur.count + 1, lastTs: now });
  }
}
export function _getCboeFallbackHits() {
  const now = Date.now();
  // Drop entries older than 5 min
  for (const [k, v] of _cboeFallbackHits) {
    if (now - v.lastTs > 300_000) _cboeFallbackHits.delete(k);
  }
  return Array.from(_cboeFallbackHits.entries()).map(([symbol, v]) => ({
    symbol,
    count: v.count,
    secondsAgo: Math.round((now - v.lastTs) / 1000),
  }));
}
function _endpointKey(path: string): string {
  // Bucket by first 3 path segments (e.g. "marketdata/v1/pricehistory")
  return path.split("?")[0].split("/").slice(0, 3).join("/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function schwabFetch(
  path: string,
  params?: Record<string, string | number>,
  opts?: { skipCache?: boolean },
): Promise<any | null> {
  const token = await getAccessToken();
  if (!token) return null;

  // Build cache key
  const paramStr = params ? Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join("&") : "";
  const cacheKey = `${path}|${paramStr}`;
  const ttl = cacheTtlMs(path);

  // Cache hit
  if (!opts?.skipCache && ttl > 0) {
    const hit = _cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.data;
    }
  }

  // Endpoint cooldown check
  const epKey = _endpointKey(path);
  const coolUntil = _cooldown.get(epKey);
  if (coolUntil && coolUntil > Date.now()) {
    const stale = _cache.get(cacheKey);
    if (stale) return stale.data; // serve stale during cooldown
    return null;
  }

  // Self-throttle
  _trimReqLog();
  if (_reqLog.length >= MAX_REQ_PER_MIN) {
    const stale = _cache.get(cacheKey);
    if (stale) return stale.data;
    // Wait until oldest request ages out
    const waitMs = Math.max(0, _reqLog[0] + 60_000 - Date.now()) + 50;
    if (waitMs < 5000) {
      await sleep(waitMs);
      _trimReqLog();
    } else {
      console.warn("[schwab] self-throttle hit, skipping:", path);
      return null;
    }
  }

  const url = new URL(`${SCHWAB_BASE}/${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  }

  // Retry loop for 429 + transient 5xx
  const maxAttempts = 3;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    _reqLog.push(Date.now());
    try {
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      lastStatus = res.status;
      if (res.ok) {
        // Reset 403 streak on success
        _403Streak.delete(epKey);
        const data = await res.json();
        if (ttl > 0) _cache.set(cacheKey, { data, expiresAt: Date.now() + ttl });
        return data;
      }
      // 401 → token issue, no retry
      if (res.status === 401) {
        console.warn("[schwab] 401 unauthorized:", path);
        return null;
      }
      // 403 → may be permission OR transient (Schwab returns 403 for rate-adjacent
      // refusals). Cool down endpoint 60s, no retry. Track 403 streak — if 3 in a row
      // on same endpoint, escalate to 5min.
      if (res.status === 403) {
        const streak = (_403Streak.get(epKey) ?? 0) + 1;
        _403Streak.set(epKey, streak);
        const coolMs = streak >= 3 ? 5 * 60_000 : 60_000;
        console.warn(`[schwab] 403 forbidden: ${path} (cooldown ${Math.round(coolMs / 1000)}s, streak ${streak})`);
        _cooldown.set(epKey, Date.now() + coolMs);
        return _cache.get(cacheKey)?.data ?? null;
      }
      // 429 → backoff with Retry-After if present
      if (res.status === 429) {
        const retryAfterHdr = res.headers.get("Retry-After");
        const retryAfterSec = retryAfterHdr ? parseInt(retryAfterHdr, 10) : 0;
        const backoffMs = retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 30_000)
          : Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        if (attempt < maxAttempts) {
          await sleep(backoffMs);
          continue;
        }
        // Final 429 → cool down endpoint
        console.warn("[schwab] 429 rate-limited:", path, "(cooldown 60s)");
        _cooldown.set(epKey, Date.now() + 60_000);
        return _cache.get(cacheKey)?.data ?? null;
      }
      // 5xx → retry
      if (res.status >= 500 && attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      console.warn("[schwab] fetch failed:", res.status, path);
      return _cache.get(cacheKey)?.data ?? null;
    } catch (e: any) {
      console.warn("[schwab] fetch exception:", e?.message, path);
      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      return _cache.get(cacheKey)?.data ?? null;
    }
  }
  console.warn("[schwab] all retries exhausted:", path, "last:", lastStatus);
  return null;
}

/** Diagnostic snapshot for /api/schwab/diag. */
export function getSchwabDiagnostics() {
  _trimReqLog();
  const now = Date.now();
  return {
    cacheEntries: _cache.size,
    requestsLastMinute: _reqLog.length,
    maxPerMinute: MAX_REQ_PER_MIN,
    cooldowns: Array.from(_cooldown.entries())
      .filter(([_, exp]) => exp > now)
      .map(([ep, exp]) => ({ endpoint: ep, secondsRemaining: Math.round((exp - now) / 1000) })),
    forbiddenStreaks: Array.from(_403Streak.entries())
      .filter(([_, n]) => n > 0)
      .map(([ep, n]) => ({ endpoint: ep, count: n })),
    cboeFallbackHits: _getCboeFallbackHits(),
  };
}

// ─── Background token refresh ─────────────────────────────────────────────────

let _refreshInterval: ReturnType<typeof setInterval> | null = null;

export function startTokenRefreshCycle(): void {
  if (_refreshInterval) return;
  _refreshInterval = setInterval(async () => {
    const status = getSchwabStatus();
    if (status.connected) {
      await getAccessToken(); // will refresh if within 1-min window
    }
  }, 20 * 60 * 1000); // every 20 minutes
  console.log("[schwab] background token refresh cycle started (20min interval)");
}

// ─── Market data helpers ──────────────────────────────────────────────────────

export type NormalizedQuote = {
  symbol: string;
  last: number | null;
  change: number | null;
  changePercent: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  source: "schwab";
};

/** Normalize legacy `.X` suffix on cash-index symbols. Schwab requires `$VIX`, `$SPX`,
 *  `$VIX9D`, `$VIX3M`, `$VVIX`, `$SKEW`, etc. WITHOUT the `.X` suffix. Some legacy
 *  callers (incl. locked files) still pass `$VIX.X` — silently fix here.
 */
function _normalizeIndexSymbol(sym: string): string {
  if (sym.startsWith("$") && sym.endsWith(".X")) {
    return sym.slice(0, -2);
  }
  return sym;
}

/** Get quotes for multiple symbols via Schwab. Returns empty array if not authenticated. */
export async function getQuotes(symbols: string[]): Promise<NormalizedQuote[]> {
  if (!symbols.length) return [];
  // Normalize legacy .X suffix on cash indexes; preserve original-→-wire mapping
  // so callers that filter by their original symbol still find the quote.
  const wireSymbols = symbols.map(_normalizeIndexSymbol);
  const wireToOriginal = new Map<string, string>();
  symbols.forEach((orig, i) => wireToOriginal.set(wireSymbols[i], orig));
  const token = await getAccessToken();
  if (!token) {
    console.warn("[schwab] not authenticated, returning empty quotes");
    return [];
  }
  try {
    const data = await schwabFetch("marketdata/v1/quotes", { symbols: wireSymbols.join(",") });
    if (data && typeof data === "object") {
      const results: NormalizedQuote[] = [];
      for (const wireSym of wireSymbols) {
        const q = data[wireSym];
        if (!q) continue;
        const origSym = wireToOriginal.get(wireSym) ?? wireSym;
        // Schwab returns either "quote" (regular) or "reference" depending on type
        const qd = q.quote ?? q.fundamental ?? {};
        const last = qd.lastPrice ?? qd.mark ?? null;
        // Quote-shield observer (flag-only — see MASTER_SYNTHESIS Tier 2 #6)
        try {
          if (last != null && isFinite(last)) observeQuote(origSym, last);
        } catch { /* shield must never break ingest */ }
        results.push({
          symbol: origSym,
          last,
          change: qd.netChange ?? null,
          changePercent: qd.netPercentChangeInDouble ?? null,
          bid: qd.bidPrice ?? null,
          ask: qd.askPrice ?? null,
          volume: qd.totalVolume ?? null,
          source: "schwab",
        });
      }
      return results;
    }
  } catch (e: any) {
    console.warn("[schwab] getQuotes error:", e?.message);
  }
  return [];
}

export type PriceHistoryResponse = {
  symbol: string;
  candles: { datetime: number; open: number; high: number; low: number; close: number; volume: number }[];
  source: "schwab";
};

/** Get price history via Schwab. Returns empty candles if not authenticated or on error.
 *  @param needExtendedHours - pass true for pre/post market data (default false)
 */
export async function getPriceHistory(
  symbol: string,
  periodType: "day" | "month" | "year" = "year",
  period: number = 1,
  frequencyType: "minute" | "daily" | "weekly" | "monthly" = "daily",
  frequency: number = 1,
  needExtendedHours: boolean = false,
): Promise<PriceHistoryResponse> {
  // Normalize legacy .X suffix on cash indexes (silent fix for locked callers)
  const wireSymbol = _normalizeIndexSymbol(symbol);
  const token = await getAccessToken();
  if (!token) {
    console.warn("[schwab] not authenticated, returning empty candles");
    return { symbol, candles: [], source: "schwab" };
  }
  try {
    const data = await schwabFetch("marketdata/v1/pricehistory", {
      symbol: wireSymbol,
      periodType,
      period,
      frequencyType,
      frequency,
      needExtendedHoursData: needExtendedHours ? "true" : "false",
    });
    if (data?.candles?.length) {
      return { symbol, candles: data.candles, source: "schwab" };
    }
  } catch (e: any) {
    console.warn("[schwab] getPriceHistory error:", e?.message);
  }
  return { symbol, candles: [], source: "schwab" };
}

export type OptionChainResponse = {
  underlying: { last: number | null; bid: number | null; ask: number | null };
  callExpDateMap: Record<string, Record<string, any[]>>;
  putExpDateMap: Record<string, Record<string, any[]>>;
  source: "schwab" | "cboe";
  lagSeconds?: number;
} | { error: "schwab_required" | "cboe_unavailable"; source: null };

/** Get option chain. Tries Schwab first; on 403/null falls back to CBOE delayed (~15min lag).
 *  CBOE response is normalized to Schwab's callExpDateMap/putExpDateMap shape so all
 *  downstream consumers (gamma walls, GEX, exposures, whale detection) work unchanged.
 *  The `source` field on the response indicates which feed was used.
 */
export async function getOptionChain(
  symbol: string,
  dte?: number,
): Promise<OptionChainResponse> {
  // Normalize legacy .X suffix on cash indexes (silent fix for locked callers)
  const wireSymbol = _normalizeIndexSymbol(symbol);
  const token = await getAccessToken();

  // Try Schwab first if authenticated
  if (token) {
    try {
      const params: Record<string, string | number> = {
        symbol: wireSymbol,
        contractType: "ALL",
        strikeCount: 60,
        includeUnderlyingQuote: "true",
      };
      if (dte !== undefined) {
        const now = new Date();
        const to = new Date(now);
        to.setDate(to.getDate() + Math.max(dte, 1));
        params.fromDate = now.toISOString().split("T")[0];
        params.toDate = to.toISOString().split("T")[0];
      }
      const data = await schwabFetch("marketdata/v1/chains", params);
      if (data && (data.callExpDateMap || data.putExpDateMap)) {
        return {
          underlying: {
            last: data.underlying?.last ?? null,
            bid: data.underlying?.bid ?? null,
            ask: data.underlying?.ask ?? null,
          },
          callExpDateMap: data.callExpDateMap ?? {},
          putExpDateMap: data.putExpDateMap ?? {},
          source: "schwab",
        };
      }
      // null/empty from Schwab → fall through to CBOE
    } catch (e: any) {
      console.warn("[schwab] getOptionChain error, trying CBOE fallback:", e?.message);
    }
  }

  // Fallback: CBOE delayed (~15min lag). Same shape, source="cboe".
  try {
    const { getCboeOptionChain } = await import("./cboeChainAdapter");
    const cboeChain = await getCboeOptionChain(symbol, dte);
    if ("error" in cboeChain) {
      console.warn("[schwab] CBOE fallback failed:", cboeChain.error);
      return { error: "schwab_required", source: null };
    }
    console.log(`[schwab] using CBOE fallback for ${symbol} (lag ${cboeChain.lagSeconds}s)`);
    _recordCboeFallback(symbol);
    return cboeChain;
  } catch (e: any) {
    console.warn("[schwab] CBOE fallback exception:", e?.message);
    return { error: "schwab_required", source: null };
  }
}

/** Compute gamma exposure from a Schwab option chain response.
 *  Returns { callWall, putWall, zeroGamma, gexByStrike[] }
 */
export function computeGEXFromChain(chain: Exclude<OptionChainResponse, { error: string }>) {
  type GexStrike = { strike: number; callGex: number; putGex: number; netGex: number };
  const strikeMap = new Map<number, GexStrike>();
  const spotPrice = chain.underlying.last ?? 1;

  function processMap(map: Record<string, Record<string, any[]>>, side: "call" | "put") {
    for (const expKey of Object.keys(map)) {
      const strikesObj = map[expKey];
      for (const strikeStr of Object.keys(strikesObj)) {
        const contracts = strikesObj[strikeStr];
        const strike = parseFloat(strikeStr);
        if (!isFinite(strike)) continue;
        for (const c of contracts) {
          const gamma = c.gamma ?? 0;
          const oi = c.openInterest ?? 0;
          const gex = gamma * oi * 100 * spotPrice * spotPrice * 0.01;
          if (!strikeMap.has(strike)) {
            strikeMap.set(strike, { strike, callGex: 0, putGex: 0, netGex: 0 });
          }
          const row = strikeMap.get(strike)!;
          if (side === "call") row.callGex += gex;
          else row.putGex -= gex; // puts invert
          row.netGex = row.callGex + row.putGex;
        }
      }
    }
  }

  processMap(chain.callExpDateMap, "call");
  processMap(chain.putExpDateMap, "put");

  const profile = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
  if (!profile.length) return { callWall: null, putWall: null, zeroGamma: null, profile: [] };

  // Call Wall: strike above spot with max positive call GEX
  const aboveSpot = profile.filter((p) => p.strike >= spotPrice);
  const belowSpot = profile.filter((p) => p.strike < spotPrice);

  const callWall = aboveSpot.reduce((best, p) => (!best || p.callGex > best.callGex ? p : best), null as GexStrike | null);
  const putWall = belowSpot.reduce((best, p) => (!best || p.putGex < best.putGex ? p : best), null as GexStrike | null);

  // Zero Gamma: strike closest to where cumulative net GEX flips sign
  let cumGex = 0;
  let zeroGamma: number | null = null;
  for (const p of profile) {
    const prev = cumGex;
    cumGex += p.netGex;
    if (prev < 0 && cumGex >= 0 || prev > 0 && cumGex <= 0) {
      zeroGamma = p.strike;
      break;
    }
  }

  return {
    callWall: callWall?.strike ?? null,
    putWall: putWall?.strike ?? null,
    zeroGamma,
    profile,
  };
}
