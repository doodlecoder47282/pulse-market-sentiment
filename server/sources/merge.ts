// server/sources/merge.ts
//
// Pure merge rules for the News tab: headlines from tiered sources and the
// economic calendar from official + secondary sources. No network, no DB.

import { SOURCES, TIER_LABEL, TIER_RANK, type SourceTier } from "./registry";
import type { FeedItem } from "./parse";
import { familyOfEventName } from "./parse";

/** Items stamped more than this far in the future are treated as undated. */
export const FUTURE_SKEW_MS = 5 * 60_000;

export interface TieredItem {
  sourceId: string;
  source: string;        // display name
  publisher: string;
  tier: SourceTier;
  tierLabel: string;
  kind: "news" | "official";
  title: string;
  url: string;
  summary: string;
  guid: string;
  publishedMs: number;
  fetchedAtMs: number;
}

/**
 * Attach source metadata to parsed feed items. Undated items and items
 * stamped in the future (beyond FUTURE_SKEW_MS) are dropped and counted:
 * the feed never invents a publish time.
 */
export function tierItems(
  sourceId: string,
  items: FeedItem[],
  fetchedAtMs: number,
  nowMs: number,
): { items: TieredItem[]; undatedDropped: number } {
  const spec = SOURCES[sourceId];
  const tier: SourceTier = spec?.tier ?? "weak";
  let undatedDropped = 0;
  const out: TieredItem[] = [];
  for (const it of items) {
    if (it.publishedMs == null || it.publishedMs > nowMs + FUTURE_SKEW_MS) { undatedDropped++; continue; }
    out.push({
      sourceId,
      source: spec?.name ?? sourceId,
      publisher: spec?.publisher ?? sourceId,
      tier,
      tierLabel: TIER_LABEL[tier],
      kind: tier === "primary" ? "official" : "news",
      title: it.title,
      url: it.link,
      summary: it.summary,
      guid: it.guid,
      publishedMs: it.publishedMs,
      fetchedAtMs,
    });
  }
  return { items: out, undatedDropped };
}

export function titleKey(t: string): string {
  return t.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 120);
}

/**
 * Merge headline lists: when the same story arrives from several sources the
 * highest tier wins (an official release beats a publisher's write-up of the
 * same title, a publisher beats an aggregator); ties keep the earliest
 * publish time. Output is newest first.
 */
export function mergeTiered(lists: TieredItem[][]): TieredItem[] {
  const best = new Map<string, TieredItem>();
  for (const list of lists) {
    for (const it of list) {
      const k = titleKey(it.title);
      if (!k) continue;
      const prev = best.get(k);
      if (!prev) { best.set(k, it); continue; }
      const better = TIER_RANK[it.tier] < TIER_RANK[prev.tier]
        || (TIER_RANK[it.tier] === TIER_RANK[prev.tier] && it.publishedMs < prev.publishedMs);
      if (better) best.set(k, it);
    }
  }
  return Array.from(best.values()).sort((a, b) => b.publishedMs - a.publishedMs);
}

// ─── Economic calendar merge ─────────────────────────────────────────────

export interface MergeableEvent {
  id: string;
  kind: string;
  title: string;
  when: number;          // epoch seconds
  family?: string | null;
  tier?: SourceTier;
  source: string;
  previous?: string;
  forecast?: string;
  actual?: string;
  notes?: string;
}

function etDay(whenSec: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(whenSec * 1000));
}

/**
 * Official releases (BLS/BEA, tier primary) set the event and its time.
 *  - A secondary row (Nasdaq, unofficial) of the same family on the same ET
 *    day is folded in: its previous/forecast/actual values are attached to
 *    the official event (labeled as Nasdaq values) and the row is dropped.
 *  - A computed/estimated row of the same family (hardcoded CPI list,
 *    first-Friday NFP rule) within 7 days of an official one is dropped:
 *    the official schedule supersedes the estimate.
 * Rows of a family with no official event are kept with their own labels.
 */
export function mergeEconEvents<T extends MergeableEvent>(official: T[], others: T[]): T[] {
  const famOf = (e: T) => e.family ?? familyOfEventName(e.title);
  const byFamDay = new Map<string, T>();
  for (const o of official) {
    const f = famOf(o);
    if (f) byFamDay.set(`${f}|${etDay(o.when)}`, o);
  }
  const officialFamWhen = official.map((o) => ({ f: famOf(o), when: o.when })).filter((x) => x.f);
  const kept: T[] = [];
  for (const e of others) {
    const f = famOf(e);
    if (!f) { kept.push(e); continue; }
    const same = byFamDay.get(`${f}|${etDay(e.when)}`);
    if (same && e.tier === "weak" && e.source.startsWith("Nasdaq")) {
      if (e.previous && !same.previous) same.previous = e.previous;
      if (e.forecast && !same.forecast) same.forecast = e.forecast;
      if (e.actual && !same.actual) same.actual = e.actual;
      if (e.previous || e.forecast || e.actual) {
        const parts = [e.previous ? `prev ${e.previous}` : "", e.forecast ? `cons ${e.forecast}` : "", e.actual ? `act ${e.actual}` : ""].filter(Boolean);
        const n = `${e.title}: ${parts.join(", ")} (Nasdaq, unofficial)`;
        same.notes = same.notes ? `${same.notes} · ${n}` : n;
      }
      continue;
    }
    if (same) continue; // any other duplicate of an official release
    if (e.tier === "computed" || e.tier === "weak") {
      const near = officialFamWhen.some((x) => x.f === f && Math.abs(x.when - e.when) <= 7 * 86400);
      if (near) continue;
    }
    kept.push(e);
  }
  return [...official, ...kept];
}
