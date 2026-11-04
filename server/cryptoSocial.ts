import { summarizeSocialPosts } from "../shared/cryptoDesk";
import { SOCIAL_EVIDENCE_VERSION, type SocialLane, type SocialTokenEvidence } from "../shared/cryptoSocial";
import type { ReadJson } from "./cryptoCollectors";

const BASE58 = "[1-9A-HJ-NP-Za-km-z]";
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LINK_HOSTS = new Set(["pump.fun", "www.pump.fun", "solscan.io", "dexscreener.com", "jup.ag"]);
function contractLink(raw: unknown, mint: string) {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && LINK_HOSTS.has(u.hostname) &&
      ([...u.pathname.split("/").map(decodeURIComponent), ...u.searchParams.values()].includes(mint));
  } catch { return false; }
}
export function exactContractMention(p: any, mint: string) {
  if (!MINT.test(mint)) return false;
  const text = typeof p?.record?.text === "string" ? p.record.text : "";
  if (new RegExp(`(^|[^1-9A-HJ-NP-Za-km-z])${mint}(?!${BASE58})`).test(text)) return true;
  const links = (Array.isArray(p?.record?.facets) ? p.record.facets : []).flatMap((f: any) =>
    (Array.isArray(f?.features) ? f.features : []).filter((f: any) =>
      f?.$type === "app.bsky.richtext.facet#link").map((f: any) => f.uri));
  links.push(p?.record?.embed?.external?.uri, p?.embed?.external?.uri);
  return links.some((url: unknown) => contractLink(url, mint));
}
function validPost(p: any, now: number) {
  const match = typeof p?.uri === "string" && p.uri.match(/^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9]+)$/);
  const at = Date.parse(p?.record?.createdAt ?? "");
  return !!match && match[1] === p?.author?.did && typeof p?.record?.text === "string" &&
    Number.isFinite(at) && at <= now;
}
function postUrl(p: any) {
  const [did, , key] = p.uri.slice(5).split("/");
  return `https://bsky.app/profile/${encodeURIComponent(did)}/post/${encodeURIComponent(key)}`;
}

/** Two requests total: one contract query and one optional ticker query.
 * No exhaustive-index, bot detection, buyer identity or price prediction claim.
 */
export async function readSocialTokenEvidence(symbol: string, mint: string, now: number, read: ReadJson): Promise<SocialTokenEvidence> {
  if (!MINT.test(mint)) throw new Error("Invalid Solana mint for social attribution");
  const ticker = /^[A-Za-z0-9]{3,20}$/.test(symbol.trim()) ? symbol.trim() : null;
  const receipts: SocialTokenEvidence["receipts"] = [];
  async function lane(query: string, kind: "contract" | "ticker"): Promise<SocialLane> {
    const qs = new URLSearchParams({ q: query, sort: "latest", limit: "100",
      since: new Date(now - 3600_000).toISOString(), until: new Date(now).toISOString() });
    // Keep the already-working documented AppView host. Do not fail over on denial.
    const result = await read(`https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?${qs}`);
    if (!Array.isArray(result?.posts) || result.posts.length > 100) throw new Error("Invalid Bluesky post page");
    const valid = result.posts.every((p: any) => validPost(p, now));
    const seen = new Set<string>();
    const rows = result.posts.filter((p: any) => {
      if (!validPost(p, now) || seen.has(p.uri)) return false;
      seen.add(p.uri);
      const age = now - Date.parse(p.record.createdAt);
      if (age >= 3600_000) return false;
      // Ticker-only chatter is disjoint from exact contract mentions and never scored.
      return kind === "contract" ? exactContractMention(p, mint) :
        !exactContractMention(p, mint) && new RegExp(`\\$${ticker}(?![A-Za-z0-9_])`, "i").test(p.record.text);
    });
    const summary = summarizeSocialPosts(rows, now, { limit: 100, hasMore: !!result.cursor || result.posts.length === 100,
      identity: kind === "contract" ? "exact contract text/link sample; author intent and organic demand unverified" :
        "ticker-only context; token attribution unverified; excluded from score" });
    for (const p of rows.slice(0, 3)) receipts.push({ url: postUrl(p), at: Date.parse(p.record.createdAt),
      match: kind, excerpt: p.record.text.replace(/\s+/g, " ").slice(0, 180) });
    return { ...summary, timestampsComplete: summary.timestampsComplete && valid,
      returnedPosts: result.posts.length, query,
      previous10m: rows.filter((p: any) => { const age = now - Date.parse(p.record.createdAt); return age >= 600000 && age < 1200000; }).length };
  }
  const contract = await lane(mint, "contract");
  let tickerLane: SocialLane | null = null, queryGap = false;
  let tickerReason = "Ticker query not applicable: short/non-ASCII/invalid symbol. Contract query still ran.";
  if (ticker) {
    try { tickerLane = await lane(`$${ticker}`, "ticker"); tickerReason = "Separate ticker-only context, not token confirmation."; }
    catch { queryGap = true; tickerReason = "Ticker query unavailable; contract sample retained. Provider backoff remains active."; }
  }
  const enough = !contract.capped && contract.timestampsComplete && contract.previous10m >= 3 &&
    contract.mentions10m + contract.previous10m >= 6 && contract.uniqueAuthors1h >= 3;
  return { version: SOCIAL_EVIDENCE_VERSION, sampledAt: now, windowStart: now - 3600_000, windowEnd: now,
    contract, ticker: tickerLane, tickerReason, queryGap, receipts,
    pace: { current10m: contract.mentions10m, previous10m: contract.previous10m,
      delta: enough ? contract.mentions10m - contract.previous10m : null,
      ratio: enough ? Math.round(contract.mentions10m / contract.previous10m * 100) / 100 : null,
      state: enough ? "sampled" : "insufficient",
      reason: enough ? "Disjoint 10-minute bins within a bounded search sample; not a validated trend or predictor." :
        "Comparison withheld: capped/invalid sample or insufficient posts, authors or prior-window baseline." } };
}

/** Two priority slots; remaining capacity is oldest-first. One query set per mint. */
export function selectSocialBatch<T extends {
  tokenAddress: string; lastRefreshAt: number | null; marketCap: number | null;
  liquidityUsd: number | null; hardKill: boolean; score: number | null; socialAttemptAt: number | null;
}>(rows: T[], now: number, ceiling: number): T[] {
  const due = rows.filter(c => MINT.test(c.tokenAddress) && c.lastRefreshAt != null &&
    c.lastRefreshAt <= now && now - c.lastRefreshAt <= 300000 && !c.hardKill &&
    c.marketCap != null && Number.isFinite(c.marketCap) && c.marketCap > 0 && c.marketCap <= ceiling &&
    c.liquidityUsd != null && Number.isFinite(c.liquidityUsd) && c.liquidityUsd > 0 &&
    (c.socialAttemptAt == null || now - c.socialAttemptAt > 300000))
    .sort((a,b) => (a.socialAttemptAt ?? 0) - (b.socialAttemptAt ?? 0));
  const chosen: T[] = [], seen = new Set<string>();
  const add = (c: T) => { if (chosen.length < 4 && !seen.has(c.tokenAddress)) { seen.add(c.tokenAddress); chosen.push(c); } };
  due.filter(c => (c.score ?? 0) >= 40).slice(0,2).forEach(add);
  due.forEach(add);
  return chosen;
}
