// server/schwabCacheStore.ts
//
// DAILY BARS SURVIVE A RESTART. The Schwab response cache (server/schwab.ts) lives in memory, so every deploy
// starts cold: the first page load asks for every panel's daily price history at once (about 25 requests seen
// live on 2026-11-19), the per-minute request limit is reached, and whatever loads last reads "unavailable".
// Price-history payloads that are not minute bars (daily, weekly, monthly) are also written here once the
// session has settled, and read back once after a restart. A restored entry keeps its real fetch time; its
// expiry is the original, capped (schwabDataPolicy.planDailyRestore). The cache rules (fresh TTL, stale age
// cap, last-session copy) then treat it as if the process had not restarted. Copies read in the session are
// not written: today's bar moves and such a copy is only servable for minutes. Quotes, chains and minute
// bars are not kept.
//
// Best effort throughout: a failure to save or restore leaves the in-memory cache as it was.

import { sqlite } from "./storage";
import { isLastSessionCopy, planDailyRestore } from "./schwabDataPolicy";

let ready = false;
let saveStmt: { run(...a: unknown[]): unknown } | null = null;

function ensure(): void {
  if (ready) return;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schwab_daily_cache (
    cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`);
  ready = true;
}

/** Keep a payload, only when it is a last-session copy at its own fetch time (market closed, read after the settle). */
export function saveDailyPayload(cacheKey: string, data: unknown, fetchedAt: number, expiresAt: number): void {
  try {
    if (!isLastSessionCopy("daily_bars", fetchedAt, fetchedAt)) return;
    ensure();
    saveStmt ??= sqlite.prepare(`INSERT OR REPLACE INTO schwab_daily_cache (cache_key, payload, fetched_at, expires_at) VALUES (?, ?, ?, ?)`);
    saveStmt.run(cacheKey, JSON.stringify(data), fetchedAt, expiresAt);
  } catch { /* the in-memory cache already holds it */ }
}

export interface RestoredEntry { cacheKey: string; data: any; fetchedAt: number; expiresAt: number }

/** Every kept payload the cache rules could still serve at `nowMs`; rows past that, damaged rows and rows over the cap are deleted. */
export function restoreDailyPayloads(nowMs: number = Date.now()): RestoredEntry[] {
  const out: RestoredEntry[] = [];
  try {
    ensure();
    const meta = sqlite.prepare(`SELECT cache_key, fetched_at, expires_at FROM schwab_daily_cache`).all() as Array<{ cache_key: string; fetched_at: number; expires_at: number }>;
    const plan = planDailyRestore(meta, nowMs);
    const drop = sqlite.prepare(`DELETE FROM schwab_daily_cache WHERE cache_key = ?`);
    for (const k of plan.drop) drop.run(k);
    const get = sqlite.prepare(`SELECT payload FROM schwab_daily_cache WHERE cache_key = ?`);
    for (const r of plan.keep) {
      try { out.push({ cacheKey: r.cache_key, data: JSON.parse((get.get(r.cache_key) as { payload: string }).payload), fetchedAt: r.fetched_at, expiresAt: r.expires_at }); }
      catch { drop.run(r.cache_key); }
    }
  } catch { /* nothing restored */ }
  return out;
}
