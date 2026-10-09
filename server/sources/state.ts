// server/sources/state.ts
//
// Per-source data states and a polite TTL cache. Pure: no network, no DB;
// the clock is injected so tests are deterministic.
//
// States are distinct and never collapse into each other (user rule 5):
//   ok             - fetched now (or within the source's polling interval)
//                    and returned at least one usable item
//   empty          - fetched fine, observed zero usable items (a real zero)
//   stale          - the latest fetch failed; showing the last good payload
//                    with its real fetch time, inside the stated max age
//   failed         - fetch failed and no payload young enough to show
//   not_configured - an optional setting (e.g. the SEC contact User-Agent)
//                    is missing, so the source was not called at all
//   partial        - (aggregates) some sub-requests failed, some succeeded

import { SOURCES, TIER_LABEL, type SourceTier } from "./registry";

export type SourceState = "ok" | "empty" | "stale" | "failed" | "not_configured" | "partial";

export interface SourceStatus {
  id: string;
  name: string;
  tier: SourceTier;
  tierLabel: string;
  unofficial: boolean;
  state: SourceState;
  items: number;
  /** newest item time (UTC ISO) or null when nothing dated was returned */
  newestUtc: string | null;
  /** when the payload being shown was fetched (UTC ISO); null if never */
  fetchedAtUtc: string | null;
  /** seconds since fetchedAt (null if never fetched) */
  ageSec: number | null;
  /** items dropped for missing or future timestamps */
  undatedDropped: number;
  reason: string | null;
}

export interface CacheEntry<T> {
  value: T;
  fetchedAtMs: number;
}

export interface CachedResult<T> {
  value: T | null;
  fetchedAtMs: number | null;
  state: "fresh" | "stale" | "failed";
  error: string | null;
}

/**
 * TTL cache with stale-if-error. A refresh happens at most once per ttlMs;
 * if it fails, the last good value is served as "stale" while younger than
 * staleMaxMs, then "failed" (value null). Concurrent callers share one
 * in-flight request so a burst of UI polls never fans out upstream.
 */
export class SourceCache {
  private entries = new Map<string, CacheEntry<unknown>>();
  private lastError = new Map<string, { atMs: number; msg: string }>();
  private inflight = new Map<string, Promise<unknown>>();
  constructor(private now: () => number = Date.now) {}

  async get<T>(key: string, ttlMs: number, staleMaxMs: number, fetcher: () => Promise<T>): Promise<CachedResult<T>> {
    const t = this.now();
    const hit = this.entries.get(key) as CacheEntry<T> | undefined;
    const err = this.lastError.get(key);
    // Within the polling interval: serve the cache (or the cached failure)
    // without calling upstream again.
    if (hit && t - hit.fetchedAtMs < ttlMs && !(err && err.atMs > hit.fetchedAtMs)) {
      return { value: hit.value, fetchedAtMs: hit.fetchedAtMs, state: "fresh", error: null };
    }
    if (err && t - err.atMs < Math.min(ttlMs, 60_000)) return this.fallback(hit, t, staleMaxMs, err.msg);
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fetcher();
      this.inflight.set(key, p);
    }
    try {
      const value = await p;
      const fetchedAtMs = this.now();
      this.entries.set(key, { value, fetchedAtMs });
      this.lastError.delete(key);
      return { value, fetchedAtMs, state: "fresh", error: null };
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 160);
      this.lastError.set(key, { atMs: this.now(), msg });
      return this.fallback(hit, this.now(), staleMaxMs, msg);
    } finally {
      this.inflight.delete(key);
    }
  }

  private fallback<T>(hit: CacheEntry<T> | undefined, t: number, staleMaxMs: number, msg: string): CachedResult<T> {
    if (hit && t - hit.fetchedAtMs <= staleMaxMs) {
      return { value: hit.value, fetchedAtMs: hit.fetchedAtMs, state: "stale", error: msg };
    }
    return { value: null, fetchedAtMs: hit?.fetchedAtMs ?? null, state: "failed", error: msg };
  }
}

/** Build the client-facing status of one source from a cache result and its items. */
export function sourceStatus(
  id: string,
  r: { state: CachedResult<unknown>["state"] | "not_configured"; fetchedAtMs: number | null; error: string | null },
  items: Array<{ publishedMs: number | null }>,
  nowMs: number,
  undatedDropped = 0,
  nameOverride?: string,
): SourceStatus {
  const spec = SOURCES[id];
  const tier: SourceTier = spec?.tier ?? "weak";
  const dated = items.map((i) => i.publishedMs).filter((x): x is number => x != null && Number.isFinite(x));
  const newest = dated.length ? new Date(Math.max(...dated)).toISOString() : null;
  let state: SourceState;
  if (r.state === "not_configured") state = "not_configured";
  else if (r.state === "failed") state = "failed";
  else if (r.state === "stale") state = "stale";
  else state = items.length > 0 ? "ok" : "empty";
  return {
    id,
    name: nameOverride ?? spec?.name ?? id,
    tier,
    tierLabel: TIER_LABEL[tier],
    unofficial: tier === "weak",
    state,
    items: r.state === "failed" || r.state === "not_configured" ? 0 : items.length,
    newestUtc: r.state === "failed" || r.state === "not_configured" ? null : newest,
    fetchedAtUtc: r.fetchedAtMs != null ? new Date(r.fetchedAtMs).toISOString() : null,
    ageSec: r.fetchedAtMs != null ? Math.max(0, Math.round((nowMs - r.fetchedAtMs) / 1000)) : null,
    undatedDropped,
    reason: r.state === "not_configured" ? (r.error ?? "not configured") : r.error,
  };
}

/** Roll many source states into one feed-level state. */
export function aggregateState(states: SourceState[]): SourceState | "unavailable" {
  const live = states.filter((s) => s !== "not_configured");
  if (live.length === 0) return "unavailable";
  if (live.every((s) => s === "failed")) return "unavailable";
  const anyBad = live.some((s) => s === "failed" || s === "stale");
  const anyOk = live.some((s) => s === "ok");
  if (!anyOk) return live.some((s) => s === "stale") ? "stale" : live.every((s) => s === "empty") ? "empty" : "partial";
  return anyBad ? "partial" : "ok";
}
