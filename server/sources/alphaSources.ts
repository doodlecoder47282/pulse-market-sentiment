// server/sources/alphaSources.ts
//
// Pure helpers for the Chart tab's alpha-news indicator (server/alphaNews.ts):
// source corroboration and SEC EDGAR filings as official events. No network,
// no SDK imports, so they are testable on plain Node.

import type { AlphaEvent } from "../alphaNews";

/** Pure: count distinct sources among clustered headline ids. Corroboration
 *  means independent outlets, not one feed repeating a story. */
export function distinctSourceCount(ids: string[], byId: Map<string, { sourceId?: string; source: string }>): number {
  const set = new Set<string>();
  for (const id of ids) {
    const h = byId.get(id);
    if (h) set.add(h.sourceId ?? h.source);
  }
  return set.size;
}

/** Pure: SEC EDGAR watchlist filings for one ticker -> alpha events (official). */
export function filingEvents(
  ticker: string,
  filings: Array<{ form: string; company: string; accession: string; acceptedUtc: string | null; filingDate: string | null; items: string[]; url: string }>,
): AlphaEvent[] {
  const T = ticker.toUpperCase();
  const out: AlphaEvent[] = [];
  for (const f of filings) {
    if (!f.company.endsWith(`(${T})`)) continue;
    const t = f.acceptedUtc ? Date.parse(f.acceptedUtc) : NaN;
    if (!Number.isFinite(t)) continue; // no acceptance time: not shown as timed news
    const is8k = /^8-K/.test(f.form);
    const items = f.items.length ? ` (items ${f.items.join(", ")})` : "";
    out.push({
      id: `sec:${f.accession}`,
      ticker: T,
      tier: is8k ? "TIER_1" : "TIER_2",
      category: is8k ? "MATERIAL_8K" : "FILING",
      title: `${f.company} filed ${f.form}${items}`,
      source: "SEC EDGAR",
      url: f.url,
      published: Math.floor(t / 1000),
      summary: `${f.form} accepted by EDGAR ${f.acceptedUtc}${f.filingDate ? `, filing date ${f.filingDate}` : ""}. Primary source; read the filing before acting.`,
      initialBias: "NEUTRAL",
      alphaScore: is8k ? 86 : 60,
      sourceTier: "primary",
      sourceTierLabel: "official",
      publishedUtc: new Date(t).toISOString(),
      distinctSources: 1,
    });
  }
  return out;
}

