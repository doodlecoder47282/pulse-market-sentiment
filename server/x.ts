// server/x.ts
// X (Twitter) API v2 client for Curated Voices.
// Uses Bearer token from process.env.X_BEARER_TOKEN.
// Caches user-ID resolutions and tweets in SQLite (via storage) to keep us
// comfortably under the Basic tier (10k reads/month).

import { storage } from "./storage";

const BASE = "https://api.twitter.com/2";

export type XTweet = {
  id: string;
  handle: string;
  text: string;
  createdAt: string;           // ISO
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  impressions: number;
  url: string;
};

type UserLookupResp = {
  data?: { id: string; username: string; name?: string };
  errors?: { detail: string; title: string }[];
};

type TweetsResp = {
  data?: Array<{
    id: string;
    text: string;
    created_at: string;
    public_metrics?: {
      retweet_count?: number;
      reply_count?: number;
      like_count?: number;
      quote_count?: number;
      impression_count?: number;
    };
  }>;
  meta?: { newest_id?: string; oldest_id?: string; result_count?: number };
  errors?: any[];
  title?: string;
  detail?: string;
  status?: number;
};

function hasToken(): boolean {
  return !!process.env.X_BEARER_TOKEN;
}

async function xFetch(path: string): Promise<any> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error("X_BEARER_TOKEN not set");
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(`${BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "PulseDashboard/1.0",
      },
      signal: ctrl.signal,
    });
    const body = await r.text();
    let json: any = null;
    try { json = JSON.parse(body); } catch { /* noop */ }
    if (!r.ok) {
      // Surface a compact error for caller, but don't throw on rate limit so
      // partial success is possible.
      const err = new Error(
        `X API ${r.status}: ${json?.title || json?.detail || body.slice(0, 200)}`,
      ) as any;
      err.status = r.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(to);
  }
}

/** Resolve a handle -> user id with persistent cache (14-day TTL). */
export async function resolveUserId(handle: string): Promise<string | null> {
  if (!hasToken()) return null;
  const h = handle.toLowerCase().replace(/^@/, "");
  const cached = await storage.getXUser(h);
  const fourteenDays = 14 * 24 * 60 * 60;
  if (cached && Date.now() / 1000 - cached.resolvedAt < fourteenDays) {
    return cached.userId;
  }
  try {
    const resp = (await xFetch(`/users/by/username/${encodeURIComponent(h)}`)) as UserLookupResp;
    const id = resp?.data?.id;
    if (!id) return cached?.userId ?? null;
    await storage.saveXUser(h, id);
    return id;
  } catch (e: any) {
    // If lookup fails but we have a stale cached id, use it rather than losing data.
    if (cached) return cached.userId;
    console.warn(`[x] resolveUserId(${h}) failed:`, e?.message || e);
    return null;
  }
}

/** Fetch recent tweets for a handle, using since_id for incremental reads. */
export async function fetchHandleTweets(
  handle: string,
  maxResults = 10,
): Promise<XTweet[]> {
  if (!hasToken()) return [];
  const h = handle.toLowerCase().replace(/^@/, "");
  const userId = await resolveUserId(h);
  if (!userId) return [];

  // Incremental: only fetch tweets newer than the last cached tweet.
  const newestCached = await storage.getNewestXTweetId(h);
  const mr = Math.max(5, Math.min(100, maxResults));
  const params = new URLSearchParams({
    max_results: String(mr),
    "tweet.fields": "created_at,public_metrics,entities",
    exclude: "retweets,replies",
  });
  if (newestCached) params.set("since_id", newestCached);

  let resp: TweetsResp;
  try {
    resp = (await xFetch(`/users/${userId}/tweets?${params.toString()}`)) as TweetsResp;
  } catch (e: any) {
    console.warn(`[x] fetchHandleTweets(${h}) failed:`, e?.message || e);
    // Fall back to whatever we have in cache.
    const cachedRows = await storage.getRecentXTweets(h, mr);
    return cachedRows.map(deserializeCached);
  }

  const rows = resp.data || [];
  const tweets: XTweet[] = rows.map(t => {
    const m = t.public_metrics || {};
    return {
      id: t.id,
      handle: h,
      text: t.text,
      createdAt: t.created_at,
      likes: m.like_count ?? 0,
      retweets: m.retweet_count ?? 0,
      replies: m.reply_count ?? 0,
      quotes: m.quote_count ?? 0,
      impressions: m.impression_count ?? 0,
      url: `https://x.com/${h}/status/${t.id}`,
    };
  });

  if (tweets.length) {
    await storage.saveXTweets(tweets.map(tw => ({
      id: tw.id,
      handle: tw.handle,
      createdAt: Math.floor(new Date(tw.createdAt).getTime() / 1000),
      text: tw.text,
      payload: JSON.stringify(tw),
    })));
  }

  // Return the union of new + cached (so downstream always has a full window).
  const cachedRows = await storage.getRecentXTweets(h, mr);
  const byId = new Map<string, XTweet>();
  for (const r of cachedRows) byId.set(r.id, deserializeCached(r));
  for (const t of tweets) byId.set(t.id, t);
  const all = Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return all.slice(0, mr);
}

function deserializeCached(r: { id: string; handle: string; createdAt: number; text: string; payload: string }): XTweet {
  try {
    const p = JSON.parse(r.payload);
    if (p && typeof p === "object" && p.id) return p as XTweet;
  } catch { /* fall through */ }
  return {
    id: r.id, handle: r.handle, text: r.text,
    createdAt: new Date(r.createdAt * 1000).toISOString(),
    likes: 0, retweets: 0, replies: 0, quotes: 0, impressions: 0,
    url: `https://x.com/${r.handle}/status/${r.id}`,
  };
}

/** Fetch tweets for many handles with concurrency control. */
export async function fetchTweetsForHandles(
  handles: string[],
  maxResultsPerHandle = 10,
  concurrency = 2,
): Promise<Record<string, XTweet[]>> {
  const result: Record<string, XTweet[]> = {};
  if (!hasToken()) {
    for (const h of handles) result[h.toLowerCase()] = [];
    return result;
  }
  const queue = handles.slice();
  async function worker() {
    while (queue.length) {
      const h = queue.shift();
      if (!h) return;
      try {
        result[h.toLowerCase()] = await fetchHandleTweets(h, maxResultsPerHandle);
      } catch (e: any) {
        console.warn(`[x] fetchHandleTweets failed for ${h}:`, e?.message || e);
        result[h.toLowerCase()] = [];
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, handles.length) }, () => worker());
  await Promise.all(workers);
  return result;
}

export function xEnabled(): boolean {
  return hasToken();
}
