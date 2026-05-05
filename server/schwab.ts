/**
 * server/schwab.ts
 * Charles Schwab API integration: OAuth token management + market data helpers.
 * All data functions fall back to Yahoo Finance when Schwab is disconnected.
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

// ─── Generic Schwab fetch ─────────────────────────────────────────────────────

export async function schwabFetch(path: string, params?: Record<string, string | number>): Promise<any | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const url = new URL(`${SCHWAB_BASE}/${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  }
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.warn("[schwab] fetch failed:", res.status, path);
      return null;
    }
    return await res.json();
  } catch (e: any) {
    console.warn("[schwab] fetch exception:", e?.message, path);
    return null;
  }
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
  source: "schwab" | "yahoo";
};

/** Get quotes for multiple symbols. Falls back to Yahoo if Schwab disconnected. */
export async function getQuotes(symbols: string[]): Promise<NormalizedQuote[]> {
  if (!symbols.length) return [];
  const token = await getAccessToken();
  if (token) {
    try {
      const data = await schwabFetch("marketdata/v1/quotes", { symbols: symbols.join(",") });
      if (data && typeof data === "object") {
        const results: NormalizedQuote[] = [];
        for (const sym of symbols) {
          const q = data[sym];
          if (!q) continue;
          // Schwab returns either "quote" (regular) or "reference" depending on type
          const qd = q.quote ?? q.fundamental ?? {};
          const last = qd.lastPrice ?? qd.mark ?? null;
          // Quote-shield observer (flag-only — see MASTER_SYNTHESIS Tier 2 #6)
          try {
            if (last != null && isFinite(last)) observeQuote(sym, last);
          } catch { /* shield must never break ingest */ }
          results.push({
            symbol: sym,
            last,
            change: qd.netChange ?? null,
            changePercent: qd.netPercentChangeInDouble ?? null,
            bid: qd.bidPrice ?? null,
            ask: qd.askPrice ?? null,
            volume: qd.totalVolume ?? null,
            source: "schwab",
          });
        }
        if (results.length > 0) return results;
      }
    } catch (e: any) {
      console.warn("[schwab] getQuotes error:", e?.message);
    }
  }
  // Yahoo fallback
  return yahooGetQuotes(symbols);
}

async function yahooGetQuotes(symbols: string[]): Promise<NormalizedQuote[]> {
  const results: NormalizedQuote[] = [];
  await Promise.allSettled(
    symbols.map(async (sym) => {
      try {
        const enc = encodeURIComponent(sym);
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1m&range=1d`,
          { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
        );
        if (!r.ok) return;
        const d = await r.json();
        const meta = d?.chart?.result?.[0]?.meta;
        if (!meta) return;
        const last = meta.regularMarketPrice ?? null;
        try {
          if (last != null && isFinite(last)) observeQuote(sym, last);
        } catch { /* shield must never break ingest */ }
        results.push({
          symbol: sym,
          last,
          change: meta.regularMarketPrice && meta.chartPreviousClose
            ? meta.regularMarketPrice - meta.chartPreviousClose : null,
          changePercent: meta.regularMarketPrice && meta.chartPreviousClose
            ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 : null,
          bid: null,
          ask: null,
          volume: meta.regularMarketVolume ?? null,
          source: "yahoo",
        });
      } catch { /* skip */ }
    })
  );
  return results;
}

export type PriceHistoryResponse = {
  symbol: string;
  candles: { datetime: number; open: number; high: number; low: number; close: number; volume: number }[];
  source: "schwab" | "yahoo";
};

/** Get price history. Falls back to Yahoo. */
export async function getPriceHistory(
  symbol: string,
  periodType: "day" | "month" | "year" = "year",
  period: number = 1,
  frequencyType: "minute" | "daily" | "weekly" | "monthly" = "daily",
  frequency: number = 1,
): Promise<PriceHistoryResponse> {
  const token = await getAccessToken();
  if (token) {
    try {
      const data = await schwabFetch("marketdata/v1/pricehistory", {
        symbol,
        periodType,
        period,
        frequencyType,
        frequency,
        needExtendedHoursData: "false",
      });
      if (data?.candles?.length) {
        return { symbol, candles: data.candles, source: "schwab" };
      }
    } catch (e: any) {
      console.warn("[schwab] getPriceHistory error:", e?.message);
    }
  }
  // Yahoo fallback
  return yahooPriceHistory(symbol, periodType, period);
}

async function yahooPriceHistory(
  symbol: string,
  periodType: "day" | "month" | "year",
  period: number,
): Promise<PriceHistoryResponse> {
  const rangeMap: Record<string, string> = {
    "day-1": "1d", "day-5": "5d",
    "month-1": "1mo", "month-3": "3mo", "month-6": "6mo",
    "year-1": "1y", "year-2": "2y", "year-5": "5y",
  };
  const range = rangeMap[`${periodType}-${period}`] ?? "1y";
  const interval = periodType === "day" ? "5m" : "1d";
  try {
    const enc = encodeURIComponent(symbol);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=${interval}&range=${range}`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
    );
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return { symbol, candles: [], source: "yahoo" };
    const ts: number[] = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const candles = ts
      .map((t, i) => ({
        datetime: t * 1000,
        open: q.open?.[i] ?? 0,
        high: q.high?.[i] ?? 0,
        low: q.low?.[i] ?? 0,
        close: q.close?.[i] ?? 0,
        volume: q.volume?.[i] ?? 0,
      }))
      .filter((c) => c.open > 0);
    return { symbol, candles, source: "yahoo" };
  } catch {
    return { symbol, candles: [], source: "yahoo" };
  }
}

export type OptionChainResponse = {
  underlying: { last: number | null; bid: number | null; ask: number | null };
  callExpDateMap: Record<string, Record<string, any[]>>;
  putExpDateMap: Record<string, Record<string, any[]>>;
  source: "schwab";
} | { error: "schwab_required"; source: null };

/** Get option chain from Schwab. NO Yahoo fallback (Yahoo chains are unreliable). */
export async function getOptionChain(
  symbol: string,
  dte?: number,
): Promise<OptionChainResponse> {
  const token = await getAccessToken();
  if (!token) return { error: "schwab_required", source: null };
  try {
    const params: Record<string, string | number> = {
      symbol,
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
    if (!data) return { error: "schwab_required", source: null };
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
  } catch (e: any) {
    console.warn("[schwab] getOptionChain error:", e?.message);
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
