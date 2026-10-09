/**
 * server/schwab.ts
 * Charles Schwab API integration: OAuth token management + market data helpers.
 * Schwab is the only market-data source (user decision 2026-10-08): no CBOE,
 * no Yahoo. When Schwab cannot answer, callers get null / an error state.
 */

import { db, schwabTokens } from "./storage";
import { eq } from "drizzle-orm";
import { observeQuote } from "./quoteShield";
import { etDate, addDays } from "./exchangeCalendar";
import { quoteFreshness } from "./quoteFreshness";
import { gexByStrikeFromChain } from "./gammaProfile";
import {
  FRESH_TTL_MS, schwabDataKind, staleServeDecision, freshFreshness, maxServeAgeMs,
  chainStrikePlan, strikeCoverage, inferStrikeCountSemantics, atmIvFromChain,
  type SchwabDataKind, type SchwabFreshness, type StrikeCoverage, type StrikeCountSemantics,
} from "./schwabDataPolicy";

// ─── Credentials from environment (read lazily to avoid import-order issues) ──
const getClientId = () => process.env.SCHWAB_CLIENT_ID ?? "";
const getClientSecret = () => process.env.SCHWAB_CLIENT_SECRET ?? "";
const getRedirectUri = () => process.env.SCHWAB_REDIRECT_URI ?? "https://127.0.0.1";

const SCHWAB_BASE = "https://api.schwabapi.com";
const TOKEN_URL = `${SCHWAB_BASE}/v1/oauth/token`;
const MARKET_BASE = `${SCHWAB_BASE}/marketdata/v1`;

// ─── Token management ─────────────────────────────────────────────────────────

// Refresh-storm guards: when a refresh fails, every caller used to retry on
// its own poll cycle (thousands of doomed refresh POSTs per day, which also
// trips Akamai 403s). One in-flight refresh is shared, failures back off 60s,
// and an invalid_grant response stops attempts until the user re-auths.
let _refreshInflight: Promise<string | null> | null = null;
let _refreshFailUntil = 0;
let _refreshDead = false; // invalid_grant: refresh token revoked/expired

export function clearRefreshBackoff(): void {
  _refreshFailUntil = 0;
  _refreshDead = false;
}

/** Retrieve a valid access token, auto-refreshing if needed. Returns null if not connected. */
export async function getAccessToken(lookaheadMs = 60_000): Promise<string | null> {
  const CLIENT_ID = getClientId();
  const CLIENT_SECRET = getClientSecret();
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  const row = db.select().from(schwabTokens).where(eq(schwabTokens.id, 1)).get();
  if (!row) return null;
  const now = Date.now();
  if (row.refreshExpiresAt < now) return null; // refresh token expired — needs full re-auth
  if (row.expiresAt > now + lookaheadMs) return row.accessToken; // still valid
  if (_refreshDead || now < _refreshFailUntil) return null; // backing off
  if (_refreshInflight) return _refreshInflight; // coalesce concurrent callers
  _refreshInflight = doRefresh(row, CLIENT_ID, CLIENT_SECRET).finally(() => {
    _refreshInflight = null;
  });
  return _refreshInflight;
}

async function doRefresh(
  row: { refreshToken: string; refreshExpiresAt: number },
  CLIENT_ID: string,
  CLIENT_SECRET: string,
): Promise<string | null> {
  const now = Date.now();
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
      const errTxt = await res.text().catch(() => "");
      console.warn("[schwab] token refresh failed:", res.status, errTxt);
      _lastRefreshError = { at: now, status: res.status, message: errTxt.slice(0, 200) };
      if (/invalid_grant/i.test(errTxt)) {
        _refreshDead = true; // refresh token is gone; retrying is pointless until re-auth
      } else {
        _refreshFailUntil = Date.now() + 60_000;
      }
      return null;
    }
    const data = await res.json();
    const newExpiresAt = now + (data.expires_in ?? 1800) * 1000;
    // Only extend the 7-day refresh-token clock when Schwab actually issues a
    // NEW refresh token. Extending it on every access refresh hid the real
    // expiry: status showed days left while every refresh was 401'ing.
    const newRefreshExpiresAt = data.refresh_token
      ? now + 7 * 24 * 60 * 60 * 1000
      : row.refreshExpiresAt;
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
    _lastRefreshError = null;
    return data.access_token;
  } catch (e: any) {
    console.warn("[schwab] token refresh exception:", e?.message);
    _lastRefreshError = { at: Date.now(), status: 0, message: e?.message ?? "unknown" };
    _refreshFailUntil = Date.now() + 60_000;
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
    clearRefreshBackoff(); // fresh tokens: forget any invalid_grant dead state
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Unknown error" };
  }
}

// In-memory last-refresh-error tracker. Cleared on successful refresh.
let _lastRefreshError: { at: number; status: number; message: string } | null = null;

/** Returns the current Schwab connection status.
 *  needsReauth fires when:
 *    • no tokens stored, OR
 *    • refresh token expired, OR
 *    • last refresh attempt failed AND access token already expired
 *  The third case fixes the silent-death bug where the row sat with a valid
 *  refreshExpiresAt but every refresh attempt was 401’ing.
 */
export function getSchwabStatus(): {
  connected: boolean;
  expiresIn: number;
  refreshExpiresIn: number;
  needsReauth: boolean;
  staleAccessToken: boolean;
  lastRefreshError: { at: number; status: number; message: string } | null;
} {
  const row = db.select().from(schwabTokens).where(eq(schwabTokens.id, 1)).get();
  if (!row) {
    return {
      connected: false,
      expiresIn: 0,
      refreshExpiresIn: 0,
      needsReauth: true,
      staleAccessToken: false,
      lastRefreshError: _lastRefreshError,
    };
  }
  const now = Date.now();
  const refreshExpired = row.refreshExpiresAt < now;
  const accessExpired = row.expiresAt < now;
  // If access token is expired AND the most recent refresh attempt failed,
  // we're effectively dead even if refreshExpiresAt looks fine. This is the bug
  // that lets the dashboard sit silent for hours.
  const refreshKnownBad =
    _lastRefreshError != null &&
    _lastRefreshError.at > row.updatedAt &&
    accessExpired;
  const needsReauth = refreshExpired || refreshKnownBad;
  const connected = !needsReauth && row.expiresAt > 0;
  return {
    connected,
    expiresIn: Math.max(0, Math.floor((row.expiresAt - now) / 1000)),
    refreshExpiresIn: Math.max(0, Math.floor((row.refreshExpiresAt - now) / 1000)),
    needsReauth,
    staleAccessToken: accessExpired && !refreshExpired,
    lastRefreshError: _lastRefreshError,
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
//
// Every cached payload keeps its real fetch time. A payload younger than its
// FRESH_TTL is reused as fresh. When a refresh fails (403/429/5xx/throttle/
// network) the cached payload is served only while it is younger than
// maxServeAgeMs(kind) and is marked stale with its age; past that the caller
// gets null (unavailable). Policy and limits: server/schwabDataPolicy.ts.

type CacheEntry = { data: any; fetchedAt: number; expiresAt: number };
const _cache = new Map<string, CacheEntry>();

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

/** Stale serves and refusals per data kind (diagnostics; reset after 5 min idle). */
const _degraded = new Map<string, { staleServed: number; unavailable: number; lastTs: number; lastReason: string }>();
function _recordDegraded(kind: SchwabDataKind, served: boolean, reason: string) {
  const now = Date.now();
  const cur = _degraded.get(kind);
  const base = !cur || now - cur.lastTs > 300_000 ? { staleServed: 0, unavailable: 0, lastTs: now, lastReason: reason } : cur;
  if (served) base.staleServed += 1; else base.unavailable += 1;
  base.lastTs = now;
  base.lastReason = reason;
  _degraded.set(kind, base);
}

/** Last chain payload per symbol: strikeCount sent, bytes received, contracts, coverage. */
const _chainCost = new Map<string, { strikeCount: number; bytes: number; contracts: number; at: number; coverage: StrikeCoverage | null }>();
let _lastResponseBytes = 0;

function _endpointKey(path: string): string {
  // Bucket by first 3 path segments (e.g. "marketdata/v1/pricehistory")
  return path.split("?")[0].split("/").slice(0, 3).join("/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface SchwabFetchResult {
  /** Parsed payload, or null when unavailable. */
  data: any | null;
  /** Provenance of `data` (null when unavailable). */
  freshness: SchwabFreshness | null;
  /** Why the data is unavailable or stale; null when fresh. */
  reason: string | null;
  /** Response size in bytes when a request was made and succeeded. */
  bytes?: number;
}

/** Raw data only (legacy shape). Stale payloads are bounded by maxServeAgeMs; use schwabFetchMeta for asOf. */
export async function schwabFetch(
  path: string,
  params?: Record<string, string | number>,
  opts?: { skipCache?: boolean },
): Promise<any | null> {
  return (await schwabFetchMeta(path, params, opts)).data;
}

export async function schwabFetchMeta(
  path: string,
  params?: Record<string, string | number>,
  opts?: { skipCache?: boolean },
): Promise<SchwabFetchResult> {
  const token = await getAccessToken();
  if (!token) return { data: null, freshness: null, reason: "Schwab not connected" };

  // Build cache key — exclude endDate from key for pricehistory minute bars
  // because we use endDate=now() to force Schwab to return today's tape, but
  // we still want all in-flight callers within a TTL window to share the same
  // cache slot (otherwise every 20s bucket misses cache and burns rate budget).
  const cacheParams = params ? { ...params } : undefined;
  if (cacheParams && path.startsWith("marketdata/v1/pricehistory") && String(cacheParams.frequencyType ?? "").toLowerCase() === "minute") {
    delete cacheParams.endDate;
  }
  const paramStr = cacheParams ? Object.entries(cacheParams).sort().map(([k, v]) => `${k}=${v}`).join("&") : "";
  const cacheKey = `${path}|${paramStr}`;
  const kind = schwabDataKind(path, params);
  const ttl = FRESH_TTL_MS[kind];

  // Fresh cache hit (younger than the TTL): real fetch time, not stale.
  if (!opts?.skipCache && ttl > 0) {
    const hit = _cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return { data: hit.data, freshness: freshFreshness(hit.fetchedAt, kind, true), reason: null };
    }
  }

  // A refresh failed: serve the cached payload only within its max age.
  const serveStale = (reason: string): SchwabFetchResult => {
    const entry = _cache.get(cacheKey);
    const d = staleServeDecision(entry?.fetchedAt, kind, reason);
    _recordDegraded(kind, d.serve, d.serve ? reason : d.reason);
    if (d.serve && entry) return { data: entry.data, freshness: d.freshness, reason };
    return { data: null, freshness: null, reason: d.serve ? reason : d.reason };
  };

  // Endpoint cooldown check
  const epKey = _endpointKey(path);
  const coolUntil = _cooldown.get(epKey);
  if (coolUntil && coolUntil > Date.now()) {
    return serveStale(`Schwab ${epKey.split("/").pop()} cooling down ${Math.round((coolUntil - Date.now()) / 1000)} s after 403/429`);
  }

  // Self-throttle
  _trimReqLog();
  if (_reqLog.length >= MAX_REQ_PER_MIN) {
    const entry = _cache.get(cacheKey);
    if (entry && staleServeDecision(entry.fetchedAt, kind, "self-throttle").serve) {
      return serveStale("self-throttle (100 requests/min)");
    }
    // Wait until oldest request ages out
    const waitMs = Math.max(0, _reqLog[0] + 60_000 - Date.now()) + 50;
    if (waitMs < 5000) {
      await sleep(waitMs);
      _trimReqLog();
    } else {
      console.warn("[schwab] self-throttle hit, skipping:", path);
      return serveStale("self-throttle (100 requests/min)");
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
        const text = await res.text();
        const bytes = text.length;
        _lastResponseBytes = bytes;
        const data = JSON.parse(text);
        const fetchedAt = Date.now();
        if (ttl > 0) _cache.set(cacheKey, { data, fetchedAt, expiresAt: fetchedAt + ttl });
        return { data, freshness: freshFreshness(fetchedAt, kind, false), reason: null, bytes };
      }
      // 401 → token issue, no retry
      if (res.status === 401) {
        console.warn("[schwab] 401 unauthorized:", path);
        return { data: null, freshness: null, reason: "Schwab 401 unauthorized" };
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
        return serveStale(`Schwab 403 (streak ${streak})`);
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
        return serveStale("Schwab 429 rate limit");
      }
      // 5xx → retry
      if (res.status >= 500 && attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      console.warn("[schwab] fetch failed:", res.status, path);
      return serveStale(`Schwab HTTP ${res.status}`);
    } catch (e: any) {
      console.warn("[schwab] fetch exception:", e?.message, path);
      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      return serveStale(`Schwab request failed (${e?.message ?? "network"})`);
    }
  }
  console.warn("[schwab] all retries exhausted:", path, "last:", lastStatus);
  return serveStale(`Schwab retries exhausted (last HTTP ${lastStatus})`);
}

/** Diagnostic snapshot for /api/schwab/diag. */
export function getSchwabDiagnostics() {
  _trimReqLog();
  const now = Date.now();
  for (const [k, v] of Array.from(_degraded.entries())) {
    if (now - v.lastTs > 300_000) _degraded.delete(k);
  }
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
    /** Per data kind in the last 5 min: cached payloads served stale (within max age) and requests left unavailable. */
    degraded: Array.from(_degraded.entries()).map(([kind, v]) => ({
      kind, staleServed: v.staleServed, unavailable: v.unavailable,
      secondsAgo: Math.round((now - v.lastTs) / 1000), lastReason: v.lastReason,
    })),
    /** Max serve age per kind right now (ms): past it, data is unavailable. */
    maxServeAgeMs: {
      quotes: maxServeAgeMs("quotes", now),
      chains: maxServeAgeMs("chains", now),
      minute_bars: maxServeAgeMs("minute_bars", now),
      daily_bars: maxServeAgeMs("daily_bars", now),
    },
    /** Option-chain request cost: strikeCount sent, bytes received, contracts parsed, coverage. */
    chainCost: Array.from(_chainCost.entries()).map(([symbol, v]) => ({
      symbol, strikeCount: v.strikeCount, bytes: v.bytes, contracts: v.contracts,
      secondsAgo: Math.round((now - v.at) / 1000), coverage: v.coverage,
    })),
    strikeCountSemantics: _strikeCountSemantics,
    lastResponseBytes: _lastResponseBytes,
  };
}

// ─── Background token refresh ─────────────────────────────────────────────────

let _refreshInterval: ReturnType<typeof setInterval> | null = null;

export function startTokenRefreshCycle(): void {
  if (_refreshInterval) return;
  // 10-min cadence with a 25-min lookahead: tokens live 30 min, so the old
  // 20-min timer + 1-min lookahead could let a token lapse between ticks and
  // leave a dead window for every poller in between.
  _refreshInterval = setInterval(async () => {
    const status = getSchwabStatus();
    if (!status.connected) return;
    await getAccessToken(25 * 60 * 1000); // refresh when <25 min left
  }, 10 * 60 * 1000); // every 10 minutes
  console.log("[schwab] background token refresh cycle started (10min interval)");
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
  /** Schwab quote closePrice: the previous regular session's close ($/share or index pts). */
  prevClose?: number | null;
  /** Schwab quoteTime (else tradeTime), epoch ms, when provided. */
  quoteTimeMs?: number | null;
  /** now - quoteTimeMs (ms); null when the quote had no timestamp. */
  ageMs?: number | null;
  /** Older than 2 min during the regular session (quoteFreshness.ts), or re-served from cache after a failed refresh; null = age unknown. */
  stale?: boolean | null;
  /** Schwab regularMarketLastPrice (last regular-session trade). */
  regularMarketLast?: number | null;
  /** When this quote payload was received from Schwab, epoch ms. */
  fetchedAtMs?: number | null;
  /** true when the payload came from the in-memory cache. */
  servedFromCache?: boolean;
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
    const meta = await schwabFetchMeta("marketdata/v1/quotes", { symbols: wireSymbols.join(",") });
    const data = meta.data;
    if (data && typeof data === "object") {
      const results: NormalizedQuote[] = [];
      for (const wireSym of wireSymbols) {
        const q = data[wireSym];
        if (!q) continue;
        const origSym = wireToOriginal.get(wireSym) ?? wireSym;
        // Schwab returns either "quote" (regular) or "reference" depending on type
        const qd = q.quote ?? q.fundamental ?? {};
        const last = qd.lastPrice ?? qd.mark ?? null;
        const quoteTimeMs: number | null = typeof qd.quoteTime === "number" ? qd.quoteTime
          : typeof qd.tradeTime === "number" ? qd.tradeTime : null;
        const fresh = quoteFreshness(quoteTimeMs);
        // Quote-shield observer (flag-only — see MASTER_SYNTHESIS Tier 2 #6)
        try {
          // Only new payloads: a cached payload re-served carries no new information.
          if (last != null && isFinite(last) && !meta.freshness?.servedFromCache) observeQuote(origSym, last, quoteTimeMs ?? Date.now());
        } catch { /* shield must never break ingest */ }
        results.push({
          symbol: origSym,
          last,
          change: qd.netChange ?? null,
          // Schwab field is netPercentChange; netPercentChangeInDouble was the
          // old TDA name and is always undefined here (left canary dead).
          changePercent: qd.netPercentChange ?? qd.netPercentChangeInDouble ?? null,
          bid: qd.bidPrice ?? null,
          ask: qd.askPrice ?? null,
          volume: qd.totalVolume ?? null,
          source: "schwab",
          prevClose: typeof qd.closePrice === "number" && qd.closePrice > 0 ? qd.closePrice : null,
          regularMarketLast: typeof qd.regularMarketLastPrice === "number" && qd.regularMarketLastPrice > 0 ? qd.regularMarketLastPrice : null,
          quoteTimeMs,
          ageMs: fresh.ageMs,
          // A payload re-served after a failed refresh is stale even if its own
          // quoteTime is recent; within the session fresh.stale also applies.
          stale: meta.freshness?.stale ? true : fresh.stale,
          fetchedAtMs: meta.freshness?.asOfMs ?? null,
          servedFromCache: meta.freshness?.servedFromCache ?? false,
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
  /** "ok" = candles present; "empty" = Schwab answered with no candles; "unavailable" = no answer (not connected, error, or cache past max age). */
  dataState?: "ok" | "empty" | "unavailable";
  /** When Schwab produced the payload, epoch ms (null when unavailable). */
  asOfMs?: number | null;
  ageMs?: number | null;
  servedFromCache?: boolean;
  /** true = a refresh failed and an older payload (within maxAgeMs) is served. */
  stale?: boolean;
  maxAgeMs?: number | null;
  reason?: string | null;
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
  const unavailable = (reason: string): PriceHistoryResponse => ({
    symbol, candles: [], source: "schwab", dataState: "unavailable",
    asOfMs: null, ageMs: null, servedFromCache: false, stale: false, maxAgeMs: null, reason,
  });
  const token = await getAccessToken();
  if (!token) {
    console.warn("[schwab] not authenticated, returning empty candles");
    return unavailable("Schwab not connected");
  }
  try {
    // CRITICAL: Schwab returns the PREVIOUS business day when endDate is omitted.
    // Pass endDate=now (epoch ms) so intraday tape includes the current session.
    const params: Record<string, string | number> = {
      symbol: wireSymbol,
      periodType,
      period,
      frequencyType,
      frequency,
      needExtendedHoursData: needExtendedHours ? "true" : "false",
    };
    // Only add endDate for minute bars where intraday freshness matters.
    // Daily/weekly/monthly already include latest completed bar without it.
    // Round to 20s buckets so the cache key stays stable within the TTL window
    // and we don't bypass _cache on every call.
    if (frequencyType === "minute") {
      params.endDate = Math.floor(Date.now() / 20_000) * 20_000;
    }
    const r = await schwabFetchMeta("marketdata/v1/pricehistory", params);
    if (r.data == null || !r.freshness) return unavailable(r.reason ?? "Schwab price history unavailable");
    const f = r.freshness;
    const candles = Array.isArray(r.data?.candles) ? r.data.candles : [];
    return {
      symbol, candles, source: "schwab",
      dataState: candles.length ? "ok" : "empty",
      asOfMs: f.asOfMs, ageMs: f.ageMs, servedFromCache: f.servedFromCache, stale: f.stale, maxAgeMs: f.maxAgeMs,
      reason: f.reason,
    };
  } catch (e: any) {
    console.warn("[schwab] getPriceHistory error:", e?.message);
    return unavailable(`Schwab price history error: ${e?.message ?? "unknown"}`);
  }
}

/** Schwab chain underlying block (index points or $/share). */
export interface ChainUnderlying {
  last: number | null;
  bid: number | null;
  ask: number | null;
  /** Schwab underlying.close: previous session close as reported by the chain. */
  close?: number | null;
  /** Schwab underlying.quoteTime, epoch ms. */
  quoteTimeMs?: number | null;
  /** Schwab chain isDelayed flag (true would mean the entitlement serves delayed data). */
  delayed?: boolean | null;
}

export type OptionChainOk = {
  underlying: ChainUnderlying;
  callExpDateMap: Record<string, Record<string, any[]>>;
  putExpDateMap: Record<string, Record<string, any[]>>;
  source: "schwab";
  /** When Schwab produced this chain (our receive time), epoch ms. */
  asOfMs: number;
  ageMs: number;
  servedFromCache: boolean;
  /** true = a refresh failed and an older chain (within maxAgeMs) is served. */
  stale: boolean;
  maxAgeMs: number;
  staleReason: string | null;
  /** strikeCount sent to Schwab, and the coverage the response actually delivered. */
  strikeCount: number;
  strikePlan: string;
  strikeCoverage: StrikeCoverage | null;
};

/** Error: "schwab_required" = not connected (auth); "schwab_unavailable" = Schwab could not answer (or cache past max age). */
export type OptionChainResponse = OptionChainOk | { error: "schwab_required" | "schwab_unavailable"; source: null; reason?: string };

// Last known spot and ATM IV per wire symbol: sizes the next strikeCount.
const _chainHints = new Map<string, { spot: number; atmIv: number | null; at: number }>();
let _strikeCountSemantics: StrikeCountSemantics = "unknown";

async function _spotHint(wireSymbol: string): Promise<{ spot: number | null; atmIv: number | null }> {
  const h = _chainHints.get(wireSymbol);
  if (h && Date.now() - h.at < 6 * 3600_000) return { spot: h.spot, atmIv: h.atmIv };
  try {
    const qs = await getQuotes([wireSymbol]);
    const last = qs[0]?.last;
    return { spot: last != null && last > 0 ? last : null, atmIv: null };
  } catch {
    return { spot: null, atmIv: null };
  }
}

/** Get an option chain from Schwab. Schwab is the only source: when it cannot
 *  answer (or its cached chain is past maxServeAgeMs) the result is an error
 *  ("schwab_required" when not connected, "schwab_unavailable" otherwise).
 *  Every chain carries asOfMs / servedFromCache / stale and the strike
 *  coverage it delivered.
 *  @param dte      last expiry in calendar days from today (window starts today)
 *  @param opts.fromDte first expiry in calendar days (default 0): lets a caller
 *                  that needs one tenor (e.g. 60-90 DTE skew) skip the front.
 */
export async function getOptionChain(
  symbol: string,
  dte?: number,
  opts?: { fromDte?: number },
): Promise<OptionChainResponse> {
  // Normalize legacy .X suffix on cash indexes (silent fix for locked callers)
  const wireSymbol = _normalizeIndexSymbol(symbol);
  const token = await getAccessToken();
  if (!token) return { error: "schwab_required", source: null, reason: "Schwab not connected" };

  try {
    const hint = await _spotHint(wireSymbol);
    const plan = chainStrikePlan({
      symbol: wireSymbol, spot: hint.spot, dteMax: dte ?? 60, atmIv: hint.atmIv, semantics: _strikeCountSemantics,
    });
    const params: Record<string, string | number> = {
      symbol: wireSymbol,
      contractType: "ALL",
      strikeCount: plan.strikeCount,
      includeUnderlyingQuote: "true",
    };
    if (dte !== undefined) {
      // Expiration window in ET calendar dates. It was built from UTC dates,
      // so after 20:00 ET (00:00 UTC) the request started on the next day.
      const fromEt = etDate();
      const fromDte = Math.max(0, Math.min(opts?.fromDte ?? 0, Math.max(dte, 1)));
      params.fromDate = addDays(fromEt, fromDte);
      params.toDate = addDays(fromEt, Math.max(dte, 1));
    }
    const r = await schwabFetchMeta("marketdata/v1/chains", params);
    const data = r.data;
    if (!data || !(data.callExpDateMap || data.putExpDateMap) || !r.freshness) {
      return { error: "schwab_unavailable", source: null, reason: r.reason ?? "Schwab returned no chain" };
    }
    const u = data.underlying ?? {};
    const num = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    const last = num(u.last);
    const spot = last != null && last > 0 ? last : num(data.underlyingPrice);
    const coverage = spot != null && spot > 0 ? strikeCoverage(data, spot, plan.halfWidthPct, plan.spacing) : null;
    if (spot != null && spot > 0) {
      _chainHints.set(wireSymbol, { spot, atmIv: atmIvFromChain(data, spot), at: Date.now() });
      if (coverage && !r.freshness.servedFromCache && _strikeCountSemantics === "unknown") {
        const inferred = inferStrikeCountSemantics(plan.strikeCount, coverage.nearestBelow, coverage.nearestAbove);
        if (inferred !== "unknown") _strikeCountSemantics = inferred;
      }
    }
    if (r.bytes != null) {
      let contracts = 0;
      for (const m of [data.callExpDateMap, data.putExpDateMap]) {
        for (const ek of Object.keys(m ?? {})) for (const sk of Object.keys(m[ek] ?? {})) contracts += (m[ek][sk] ?? []).length;
      }
      _chainCost.set(wireSymbol, { strikeCount: plan.strikeCount, bytes: r.bytes, contracts, at: Date.now(), coverage });
    }
    const f = r.freshness;
    return {
      underlying: {
        last,
        bid: num(u.bid),
        ask: num(u.ask),
        close: num(u.close),
        quoteTimeMs: num(u.quoteTime),
        delayed: typeof data.isDelayed === "boolean" ? data.isDelayed : typeof u.delayed === "boolean" ? u.delayed : null,
      },
      callExpDateMap: data.callExpDateMap ?? {},
      putExpDateMap: data.putExpDateMap ?? {},
      source: "schwab",
      asOfMs: f.asOfMs,
      ageMs: f.ageMs,
      servedFromCache: f.servedFromCache,
      stale: f.stale,
      maxAgeMs: f.maxAgeMs,
      staleReason: f.reason,
      strikeCount: plan.strikeCount,
      strikePlan: plan.basis,
      strikeCoverage: coverage,
    };
  } catch (e: any) {
    console.warn("[schwab] getOptionChain error:", e?.message);
    return { error: "schwab_unavailable", source: null, reason: `Schwab chain error: ${e?.message ?? "unknown"}` };
  }
}

/** Compute gamma exposure from a Schwab option chain response.
 *  Pure math lives in gammaProfile.gexByStrikeFromChain (tested); this keeps
 *  the import path callers already use. Returns { callWall, putWall,
 *  zeroGamma, zeroGammaCumulative, profile[], dataState }. A chain without
 *  underlying.last is dataState "no_spot" with an empty profile: GEX is
 *  S^2-scaled, so the old placeholder spot of 1 gave numbers ~S^2 too small.
 */
export function computeGEXFromChain(chain: Exclude<OptionChainResponse, { error: string }>) {
  return gexByStrikeFromChain(chain);
}
