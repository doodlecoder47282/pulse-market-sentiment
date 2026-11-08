// shared/cryptoCap.ts
//
// Two pure rules the crypto engine applies to every tracked candidate.
//
// capOf: ONE market-cap basis for the desk, DexScreener marketCap else FDV,
// with the basis named. The scorer, persistSignal, the peak sampler, the plan
// sampler and the grader's live path all read it, so an entry recorded on FDV
// is graded on FDV (not RUGGED against a later marketCap that happens to be
// reported), and a pair with no marketCap but an FDV is still sampled.
//
// evictionRank: keep-rank when the tracked set is over its cap. An unscored
// arrival younger than one momentum cycle is kept (a scored name, even a PASS
// at 0, used to outrank every unscored arrival, so new pools were evicted the
// tick they appeared and the universe froze about 15 minutes after a restart).
// Older unscored names go first, then PASS before WATCH before ENTER, lower
// score first; ties by age (older first).

export const MOMENTUM_CYCLE_MS = 75_000 * 4; // one pass over the 220-name universe at 90 names per 75 s tick

export interface CapLike { marketCap: number | null; fdv: number | null }
export interface RankLike { score: number | null; verdict: "ENTER" | "WATCH" | "PASS" | null; firstSeenAt: number }

export function capOf(c: CapLike): { cap: number | null; basis: "marketCap" | "fdv" | "none" } {
  if (c.marketCap != null && Number.isFinite(c.marketCap)) return { cap: c.marketCap, basis: "marketCap" };
  if (c.fdv != null && Number.isFinite(c.fdv)) return { cap: c.fdv, basis: "fdv" };
  return { cap: null, basis: "none" };
}

export function evictionRank(c: RankLike, nowMs: number): number {
  if (c.score == null) return c.firstSeenAt >= nowMs - MOMENTUM_CYCLE_MS ? Number.POSITIVE_INFINITY : -1;
  const v = c.verdict === "ENTER" ? 2000 : c.verdict === "WATCH" ? 1000 : 0;
  return v + c.score;
}

/** The keys to evict so that at most `cap` remain, lowest keep-rank first. */
export function evictOverCap<K>(entries: Array<[K, RankLike]>, cap: number, nowMs: number): K[] {
  if (entries.length <= cap) return [];
  const sorted = [...entries].sort((a, b) => evictionRank(b[1], nowMs) - evictionRank(a[1], nowMs) || b[1].firstSeenAt - a[1].firstSeenAt);
  return sorted.slice(cap).map(([k]) => k);
}
