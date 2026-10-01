import { finiteNonnegative, type CryptoObservation } from "./cryptoReliability";
import { summarizeSocialPosts } from "../shared/cryptoDesk";

export interface CollectorCheck {
  state: "ok" | "partial" | "unavailable" | "blocked" | "cooldown" | "not_applicable";
  reason: string;
  checkedAt: number;
  retryAt?: number;
}
export type ReadJson = (url: string) => Promise<any>;

/** Oldest-first majority prevents the priority tier starving the rest forever. */
export function selectMintBatch<T extends {
  tokenAddress: string; securityAttemptAt: number | null; score: number | null; hardKill: boolean;
}>(due: T[], limit = 8): T[] {
  const sorted = [...due].sort((a, b) => (a.securityAttemptAt ?? 0) - (b.securityAttemptAt ?? 0));
  const selected: T[] = [], seen = new Set<string>();
  const add = (c: T) => { if (!seen.has(c.tokenAddress) && selected.length < limit) { seen.add(c.tokenAddress); selected.push(c); } };
  sorted.filter(c => !c.hardKill && (c.score ?? 0) >= 40).slice(0, 2).forEach(add);
  sorted.forEach(add);
  return selected;
}

export function unwrapMintBatch(result: any, mints: string[]) {
  if (!Number.isSafeInteger(result?.context?.slot) || result.context.slot < 0 ||
      !Array.isArray(result?.value) || result.value.length !== mints.length) {
    throw new Error("RPC mint batch length/context invalid");
  }
  return mints.map((mint, i) => ({ mint, account: { context: result.context, value: result.value[i] } }));
}

/** A bounded search sample, never proof of exhaustive social coverage. */
export async function readBlueskySample(
  symbol: string, mint: string, now: number, read: ReadJson,
) {
  const cleaned = symbol.trim();
  const cashtag = /^[A-Za-z0-9]{3,20}$/.test(cleaned) ? cleaned : null;
  const query = cashtag ? `$${cashtag}` : mint;
  const posts: any[] = [];
  let cursor: string | undefined, hasMore = false;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 2; page++) {
    const qs = new URLSearchParams({ q: query, sort: "latest", limit: "100",
      since: new Date(now - 3600_000).toISOString(), until: new Date(now).toISOString() });
    if (cursor) qs.set("cursor", cursor);
    const result = await read(`https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?${qs}`);
    if (!Array.isArray(result?.posts) || result.posts.length > 100) throw new Error("Invalid Bluesky post page");
    posts.push(...result.posts);
    hasMore = typeof result.cursor === "string" && !!result.cursor || result.posts.length === 100;
    if (!result.cursor) break;
    if (typeof result.cursor !== "string" || seenCursors.has(result.cursor)) { hasMore = true; break; }
    cursor = result.cursor as string; seenCursors.add(result.cursor as string);
  }
  // Provider search can return lexical collisions. Count only the requested
  // cashtag, or the exact mint string; this still does not prove author intent.
  const re = cashtag ? new RegExp(`\\$${cashtag}(?![A-Za-z0-9_])`, "i") : null;
  const matched = posts.filter(p => typeof p?.record?.text === "string" &&
    (re ? re.test(p.record.text) : p.record.text.includes(mint)));
  const summary = summarizeSocialPosts(matched, now, {
    limit: 200, hasMore, identity: cashtag ? "cashtag sample, not verified mint attribution" : "exact mint text sample, not verified organic demand",
  });
  // Check malformed entries in the full received set, not just matches.
  const complete = posts.every(p => typeof p?.uri === "string" && typeof p?.author?.did === "string" &&
    Number.isFinite(Date.parse(p?.record?.createdAt)) && Date.parse(p.record.createdAt) <= now);
  return { ...summary, returnedPosts: posts.length, query, timestampsComplete: summary.timestampsComplete && complete };
}

export class ProviderBackoff {
  private until = 0;
  private failures = 0;
  private reason = "";
  available(now: number) { return now >= this.until; }
  snapshot(now: number): CollectorCheck | null {
    return this.available(now) ? null : { state: "cooldown", reason: this.reason, checkedAt: now, retryAt: this.until };
  }
  success() { this.until = 0; this.failures = 0; this.reason = ""; }
  failure(error: unknown, now: number): CollectorCheck {
    this.failures++;
    const msg = String(error instanceof Error ? error.message : error);
    const denied = /\b40[13]\b/.test(msg), limited = /\b429\b/.test(msg);
    const delay = denied ? 30 * 60_000 : limited ? 5 * 60_000 : Math.min(15 * 60_000, 60_000 * 2 ** Math.min(this.failures - 1, 4));
    this.until = now + delay;
    this.reason = denied ? "Provider denied public access; no transport or identity bypass attempted."
      : limited ? "Provider rate limit; requests paused for cooldown." : "Provider response unavailable; bounded retry backoff.";
    return { state: denied ? "blocked" : "unavailable", reason: this.reason, checkedAt: now, retryAt: this.until };
  }
}

export function parsePumpCoin(coin: any, mint: string) {
  if (coin?.mint !== mint) throw new Error("Pump response mint mismatch");
  const replies = finiteNonnegative(coin.reply_count);
  if (replies == null || !Number.isSafeInteger(replies)) throw new Error("Pump reply count missing or invalid");
  return { replies, live: coin.is_currently_live === true,
    links: [coin.twitter, coin.telegram, coin.website].some(x => typeof x === "string" && !!x.trim()) };
}

/** Exact-pool fallback only: never substitute another pool or FDV for cap. */
export function parseGeckoGradePool(result: any, row: any, now: number): CryptoObservation {
  const p = result?.data, a = p?.attributes;
  if (!row.token_address || p?.id !== `${row.chain}_${row.pair_address}` ||
      a?.address !== row.pair_address ||
      p?.relationships?.base_token?.data?.id !== `${row.chain}_${row.token_address}`) {
    throw new Error("Fallback pool/mint identity mismatch or pool unavailable");
  }
  return { mcap: finiteNonnegative(a.market_cap_usd), liq: finiteNonnegative(a.reserve_in_usd),
    observedAt: now, source: "GeckoTerminal exact pool (receipt time)" };
}

export function createGradeObserver(read: ReadJson, now = () => Date.now(), fallbackBackoff = new ProviderBackoff()) {
  let fallbackReads = 0;
  const memo = new Map<string, Promise<CryptoObservation>>();
  return (row: any): Promise<CryptoObservation> => {
    const key = `${row.chain}:${row.pair_address}:${row.token_address}`;
    if (memo.has(key)) return memo.get(key)!;
    const request = (async () => {
      let primary: CryptoObservation | null = null;
      try {
        const r = await read(`https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(row.chain)}/${encodeURIComponent(row.pair_address)}`);
        const p = (r?.pairs ?? (r?.pair ? [r.pair] : [])).find((p: any) => p.chainId === row.chain &&
          p.pairAddress === row.pair_address && !!row.token_address && p.baseToken?.address === row.token_address);
        if (p) primary = { mcap: finiteNonnegative(p.marketCap), liq: finiteNonnegative(p.liquidity?.usd),
          observedAt: now(), source: "DexScreener exact pool (receipt time)" };
        if (primary?.mcap != null && primary.liq != null) return primary;
      } catch { /* Fallback remains independent and identity checked. */ }
      if (row.chain === "solana" && fallbackReads < 4 && fallbackBackoff.available(now())) {
        fallbackReads++;
        try {
          const fallback = parseGeckoGradePool(await read(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(row.pair_address)}`), row, now());
          fallbackBackoff.success();
          if (fallback.mcap != null && fallback.liq != null) return fallback;
          // Do not manufacture a complete observation by mixing timestamps.
          if (!primary && (fallback.mcap != null || fallback.liq != null)) return fallback;
        } catch (e) {
          if (/\b(?:401|403|429)\b/.test(String(e))) fallbackBackoff.failure(e, now());
          // Both missing is unknown, never zero or a rug outcome.
        }
      }
      if (primary && (primary.mcap != null || primary.liq != null)) return primary;
      throw new Error("Exact pool unavailable; no replacement pool, FDV or zero substituted");
    })();
    memo.set(key, request);
    return request;
  };
}
