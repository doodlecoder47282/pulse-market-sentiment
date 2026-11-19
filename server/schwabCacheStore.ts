// server/schwabCacheStore.ts
//
// DAILY BARS SURVIVE A RESTART. The Schwab response cache (server/schwab.ts) lives in memory, so every deploy
// starts cold: the first page load asks for every panel's daily price history at once (about 25 requests seen
// live on 2026-11-19), the per-minute request limit is reached, and whatever loads last reads "unavailable".
// Completed daily bars do not change, so daily price-history payloads are also written here and read back
// once after a restart. A restored entry keeps its real fetch time and its original expiry: the cache rules
// (fresh TTL, stale age cap, last-session copy) then treat it exactly as if the process had not restarted.
// Nothing else is kept: quotes, chains and minute bars move and are small wins against their size.
//
// Best effort throughout: a failure to save or restore leaves the in-memory cache as it was.

import { sqlite } from "./storage";
import { cacheEntryUnservable } from "./schwabDataPolicy";

/** Rows kept at most; the oldest fetches go first. A year of daily bars is about 25 KB. */
const MAX_ROWS = 300;
let ready = false;

function ensure(): void {
  if (ready) return;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schwab_daily_cache (
    cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`);
  ready = true;
}

export function saveDailyPayload(cacheKey: string, data: unknown, fetchedAt: number, expiresAt: number): void {
  try {
    ensure();
    sqlite.prepare(`INSERT OR REPLACE INTO schwab_daily_cache (cache_key, payload, fetched_at, expires_at) VALUES (?, ?, ?, ?)`).run(cacheKey, JSON.stringify(data), fetchedAt, expiresAt);
  } catch { /* the in-memory cache already holds it */ }
}

export interface RestoredEntry { cacheKey: string; data: any; fetchedAt: number; expiresAt: number }

/** Every kept payload that the cache rules could still serve at `nowMs`; rows past that are deleted. */
export function restoreDailyPayloads(nowMs: number = Date.now()): RestoredEntry[] {
  const out: RestoredEntry[] = [];
  try {
    ensure();
    const rows = sqlite.prepare(`SELECT cache_key, payload, fetched_at, expires_at FROM schwab_daily_cache ORDER BY fetched_at DESC`).all() as Array<{ cache_key: string; payload: string; fetched_at: number; expires_at: number }>;
    const drop = sqlite.prepare(`DELETE FROM schwab_daily_cache WHERE cache_key = ?`);
    rows.forEach((r, i) => {
      if (i >= MAX_ROWS || !keepRestored(r.fetched_at, nowMs)) { drop.run(r.cache_key); return; }
      try { out.push({ cacheKey: r.cache_key, data: JSON.parse(r.payload), fetchedAt: r.fetched_at, expiresAt: r.expires_at }); }
      catch { drop.run(r.cache_key); }
    });
  } catch { /* nothing restored */ }
  return out;
}

/** A kept daily payload is worth restoring only while the cache could still serve it; a fetch time in the future is not trusted. */
export function keepRestored(fetchedAt: number, nowMs: number): boolean {
  return Number.isFinite(fetchedAt) && fetchedAt <= nowMs && !cacheEntryUnservable("daily_bars", fetchedAt, nowMs);
}
