// server/sources/dexCross.ts
//
// Pure helpers: cross-check a DexScreener pair price against Jupiter's
// route-aggregated price, and classify crypto narrative feed reads.
//
// Jupiter Price API v3 (keyless, 0.5 req/s; up to 50 mints per call):
//   https://developers.jup.ag/docs/api-setup.md
//   https://developers.jup.ag/docs/price/v3
//   "Tokens without a reliable price are omitted entirely from the
//   response" (no trade in 7 days, or flagged unreliable), so an omitted
//   mint is its own state, not a zero and not a failure.
//
// Thresholds (operating rules, not fitted): a pool price within 5% of
// Jupiter agrees; 5-15% is "watch"; beyond 15% the pool price is not
// trusted for an entry (thin or manipulated pool, or a stale pair).

export const JUP_AGREE_PCT = 5;
export const JUP_DIVERGE_PCT = 15;
export const JUP_MAX_IDS = 50;

export type JupState = "agree" | "watch" | "diverge" | "no-reliable-price" | "failed" | "unchecked";

export function parseJupiterPrices(j: any, requested: string[]): { prices: Map<string, number>; omitted: string[] } {
  const prices = new Map<string, number>();
  const src = j && typeof j === "object" ? (j.data && typeof j.data === "object" ? j.data : j) : {};
  for (const mint of requested) {
    const v = src?.[mint]?.usdPrice ?? src?.[mint]?.price;
    const n = typeof v === "number" ? v : Number(v);
    if (v != null && Number.isFinite(n) && n > 0) prices.set(mint, n);
  }
  return { prices, omitted: requested.filter((m) => !prices.has(m)) };
}

export function jupiterCheck(dexPrice: number | null, jup: { price: number | null; omitted: boolean; failed: boolean } | null): { state: JupState; gapPct: number | null } {
  if (!jup) return { state: "unchecked", gapPct: null };
  if (jup.failed) return { state: "failed", gapPct: null };
  if (jup.omitted || jup.price == null) return { state: "no-reliable-price", gapPct: null };
  if (dexPrice == null || !(dexPrice > 0)) return { state: "unchecked", gapPct: null };
  const gap = (Math.abs(dexPrice - jup.price) / jup.price) * 100;
  return { state: gap <= JUP_AGREE_PCT ? "agree" : gap <= JUP_DIVERGE_PCT ? "watch" : "diverge", gapPct: gap };
}

/** Narrative heat counts only titles published inside this window. */
export const NARRATIVE_WINDOW_MS = 24 * 3600_000;

export function narrativeCounts(
  feeds: Array<{ name: string; items: Array<{ title: string; publishedMs: number | null }> | null }>,
  terms: string[],
  nowMs: number,
): { heat: Array<{ term: string; hits: number; sources: string[] }>; sources: Array<{ name: string; state: "ok" | "empty" | "failed"; titles: number; undated: number }> } {
  const counts = new Map<string, { hits: number; sources: Set<string> }>();
  const sources: Array<{ name: string; state: "ok" | "empty" | "failed"; titles: number; undated: number }> = [];
  for (const f of feeds) {
    if (f.items == null) { sources.push({ name: f.name, state: "failed", titles: 0, undated: 0 }); continue; }
    const undated = f.items.filter((i) => i.publishedMs == null).length;
    const fresh = f.items.filter((i) => i.publishedMs != null && nowMs - i.publishedMs <= NARRATIVE_WINDOW_MS && i.publishedMs <= nowMs + 5 * 60_000);
    sources.push({ name: f.name, state: fresh.length ? "ok" : "empty", titles: fresh.length, undated });
    for (const it of fresh) {
      for (const term of terms) {
        if (new RegExp(`\\b${term}\\b`, "i").test(it.title)) {
          const e = counts.get(term) ?? { hits: 0, sources: new Set<string>() };
          e.hits++;
          e.sources.add(f.name);
          counts.set(term, e);
        }
      }
    }
  }
  const heat = Array.from(counts.entries())
    .map(([term, v]) => ({ term, hits: v.hits, sources: Array.from(v.sources) }))
    .sort((a, b) => b.hits - a.hits);
  return { heat, sources };
}
