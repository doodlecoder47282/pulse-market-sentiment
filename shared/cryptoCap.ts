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
// arrival younger than one momentum cycle ranks ABOVE every PASS and BELOW
// every WATCH and ENTER (a scored name, even a PASS at 0, used to outrank every
// unscored arrival, so new pools were evicted the tick they appeared and the
// universe froze about 15 minutes after a restart). Bounded on purpose: a
// flood of arrivals can only displace PASS names, never a WATCH or an ENTER.
// Older unscored names go first, then PASS before arrivals before WATCH before
// ENTER, lower score first; ties by age (older first).

/** One momentum pass over a full 220-name universe: 220 / 90 names per 75 s tick = 2.4 ticks, rounded up to 3 ticks (225 s) plus margin. */
export const MOMENTUM_CYCLE_MS = 300_000;
/** Keep-rank of an unscored arrival inside its first cycle: above PASS (0-99), below WATCH (1000+). */
export const ARRIVAL_RANK = 500;

export interface CapLike { marketCap: number | null; fdv: number | null }
export interface RankLike { score: number | null; verdict: "ENTER" | "WATCH" | "PASS" | null; firstSeenAt: number }

export function capOf(c: CapLike): { cap: number | null; basis: "marketCap" | "fdv" | "none" } {
  if (c.marketCap != null && Number.isFinite(c.marketCap)) return { cap: c.marketCap, basis: "marketCap" };
  if (c.fdv != null && Number.isFinite(c.fdv)) return { cap: c.fdv, basis: "fdv" };
  return { cap: null, basis: "none" };
}

export function evictionRank(c: RankLike, nowMs: number): number {
  if (c.score == null) return c.firstSeenAt >= nowMs - MOMENTUM_CYCLE_MS ? ARRIVAL_RANK : -1;
  const v = c.verdict === "ENTER" ? 2000 : c.verdict === "WATCH" ? 1000 : 0;
  return v + c.score;
}

/** The keys to evict so that at most `cap` remain, lowest keep-rank first. */
export function evictOverCap<K>(entries: Array<[K, RankLike]>, cap: number, nowMs: number): K[] {
  if (entries.length <= cap) return [];
  const sorted = [...entries].sort((a, b) => evictionRank(b[1], nowMs) - evictionRank(a[1], nowMs) || b[1].firstSeenAt - a[1].firstSeenAt);
  return sorted.slice(cap).map(([k]) => k);
}

/**
 * The cap on the basis a signal row was RECORDED on (features_json.mcapBasis):
 * "fdv" rows are graded on FDV, "marketCap" rows on marketCap; a row whose
 * basis is not reported any more gets null (unpriced on its basis), never the
 * other number. Rows from before the basis was recorded ("none" / missing)
 * take marketCap, else FDV, as before.
 */
export function capOnBasis(c: CapLike, basis: string | null | undefined): number | null {
  const mc = c.marketCap != null && Number.isFinite(c.marketCap) ? c.marketCap : null;
  const fd = c.fdv != null && Number.isFinite(c.fdv) ? c.fdv : null;
  if (basis === "fdv") return fd;
  if (basis === "marketCap") return mc;
  return mc ?? fd;
}
