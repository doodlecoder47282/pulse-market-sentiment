// server/cryptoStats.ts
//
// Pure helpers for the crypto desk (no DB, no network), so the data-state
// rules can be tested without the engine:
//
//   1. Social collection state. A failed Bluesky or pump.fun fetch is a
//      FAILED collection, not zero attention. The social score is published
//      only from a complete collection (every attempted source succeeded);
//      a failed refresh keeps the last complete score until it expires, and
//      a score older than SOCIAL_TTL_MS is dropped (null, "stale") so it can
//      never feed FOMO as if it were current.
//   2. Signal stats from ONE query over ONE window (all logged signals), so
//      total / open / graded always add up. `sampleReady` is a sample-size
//      flag (graded ≥ 50), not a calibration claim.
//   3. (round 2) Stats and the sample gate count DISTINCT COINS (first
//      signal per coin), not rows: one coin logs WATCH and ENTER rows on
//      several days. NO_DATA share is reported.
//   4. (round 2) Observed zero vs missing: DexScreener's Pair has
//      `liquidity` (nullable object), `liquidity.usd`, `marketCap`, `fdv`
//      and `priceUsd` all nullable (https://docs.dexscreener.com/api/reference).
//      `Number(x) || null` turned an observed $0 (a full liquidity pull)
//      into "missing"; observedNumber() keeps 0 as 0 and absent as null, and
//      the grader marks a full pull RUGGED.
//   5. (round 2) Social score normalized over the sources that APPLY to the
//      token (pump.fun only for pump tokens), with coverage labelled.
//   6. (round 2) Holder concentration excludes only identified pool vaults
//      and burn accounts, never "the largest holder" blindly.

export type SocialSourceStatus = "ok" | "failed" | "skipped";
export type SocialStatus = "ok" | "partial" | "failed" | "stale" | "unavailable";

/** A complete score older than this is expired: 3x the 5-minute refresh cadence. */
export const SOCIAL_TTL_MS = 15 * 60_000;

export interface SocialState {
  socialScore: number | null;
  socialCheckedAt: number | null;   // time of the last COMPLETE collection
  socialStatus: SocialStatus | null;
}

export interface SocialInputs {
  bskyMentions10m: number | null;
  bskyMentions1h: number | null;
  pumpReplyPerHr: number | null;
  pumpLive: boolean;
  hasSocialLinks: boolean | null;
}

/** Points available per source in computeSocialScore. */
export const SOCIAL_MAX_POINTS = { bsky: 35 + 20, pump: 30 + 10 + 5 };

/**
 * 0-100 social score from the fields a complete collection produced,
 * normalized over the sources that APPLY to the token (round 2, item 15):
 * pump.fun reply rate, livestream and links exist only for pump.fun tokens,
 * so a non-pump token scored on Bluesky alone used to top out at 55. With
 * both sources applicable the scale is unchanged. Returns null when no
 * source applies (no score, not zero).
 */
export function computeSocialScore(
  i: SocialInputs,
  applicable: { bsky: boolean; pump: boolean } = { bsky: true, pump: true },
): number | null {
  let s = 0;
  let max = 0;
  if (applicable.bsky) {
    s += Math.min(35, (i.bskyMentions10m ?? 0) * 12);          // fresh mentions are gold
    s += Math.min(20, (i.bskyMentions1h ?? 0) * 2.5);
    max += SOCIAL_MAX_POINTS.bsky;
  }
  if (applicable.pump) {
    s += Math.min(30, Math.max(0, (i.pumpReplyPerHr ?? 0)) * 0.75); // 40 replies/hr = max
    if (i.pumpLive) s += 10;
    if (i.hasSocialLinks) s += 5;
    max += SOCIAL_MAX_POINTS.pump;
  }
  if (max === 0) return null;
  return Math.round(Math.min(100, (100 * s) / max));
}

/** Human label for which sources a social score covers. */
export function socialCoverage(applicable: { bsky: boolean; pump: boolean }): string {
  if (applicable.bsky && applicable.pump) return "bluesky + pump.fun";
  if (applicable.bsky) return "bluesky only (pump.fun n/a for this token)";
  if (applicable.pump) return "pump.fun only (ticker too short for bluesky search)";
  return "no applicable source";
}

/**
 * Fold one collection attempt into the social state.
 * - every attempted source ok → fresh score, checkedAt = now, "ok"
 * - some ok, some failed      → "partial": keep the last complete score if
 *                               still within TTL, else null
 * - all attempted failed      → "failed": same retention rule
 * - nothing attempted         → "unavailable": score null (no source applies)
 */
export function resolveSocialCollection(
  prev: SocialState,
  sources: { bsky: SocialSourceStatus; pump: SocialSourceStatus },
  freshScore: number | null,
  now: number,
): SocialState {
  const attempted = [sources.bsky, sources.pump].filter((s) => s !== "skipped");
  if (attempted.length === 0) {
    return { socialScore: null, socialCheckedAt: prev.socialCheckedAt, socialStatus: "unavailable" };
  }
  const failed = attempted.filter((s) => s === "failed").length;
  if (failed === 0) {
    if (freshScore == null) return { socialScore: null, socialCheckedAt: prev.socialCheckedAt, socialStatus: "unavailable" };
    return { socialScore: freshScore, socialCheckedAt: now, socialStatus: "ok" };
  }
  const fresh = prev.socialCheckedAt != null && now - prev.socialCheckedAt <= SOCIAL_TTL_MS;
  return {
    socialScore: fresh ? prev.socialScore : null,
    socialCheckedAt: prev.socialCheckedAt,
    socialStatus: failed === attempted.length ? "failed" : "partial",
  };
}

/** Drop a score whose last complete collection is older than the TTL. */
export function expireSocial(s: SocialState, now: number): SocialState {
  if (s.socialScore != null && s.socialCheckedAt != null && now - s.socialCheckedAt > SOCIAL_TTL_MS) {
    return {
      socialScore: null,
      socialCheckedAt: s.socialCheckedAt,
      socialStatus: s.socialStatus === "ok" || s.socialStatus == null ? "stale" : s.socialStatus,
    };
  }
  return s;
}

// ─── Signal stats ───────────────────────────────────────────────────────

export const CRYPTO_SAMPLE_READY_MIN_GRADED = 50;

export interface CryptoSignalCounts {
  total: number;
  open: number;
  hit5m: number;
  doubled: number;
  rugged: number;
  dead: number;
  noData?: number;           // past the horizon but unpriceable: MISSING, not an outcome
}

export interface CryptoSignalStats extends CryptoSignalCounts {
  graded: number;            // rows with a terminal outcome (HIT_5M/DOUBLED/RUGGED/DEAD)
  noData: number;            // NO_DATA rows, excluded from graded (never counted as DEAD)
  other: number;             // rows in none of the states above (should be 0)
  sampleReady: boolean;      // graded ≥ 50 — a sample-size flag, NOT calibration
  minGradedForSample: number;
  window: "all logged signals";
}

/** The single SQL the engine runs: every count over the same table, same window. */
export const CRYPTO_SIGNAL_COUNTS_SQL = `
  SELECT
    COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN outcome = 'OPEN'    THEN 1 ELSE 0 END), 0) AS open,
    COALESCE(SUM(CASE WHEN outcome = 'HIT_5M'  THEN 1 ELSE 0 END), 0) AS hit5m,
    COALESCE(SUM(CASE WHEN outcome = 'DOUBLED' THEN 1 ELSE 0 END), 0) AS doubled,
    COALESCE(SUM(CASE WHEN outcome = 'RUGGED'  THEN 1 ELSE 0 END), 0) AS rugged,
    COALESCE(SUM(CASE WHEN outcome = 'DEAD'    THEN 1 ELSE 0 END), 0) AS dead,
    COALESCE(SUM(CASE WHEN outcome = 'NO_DATA' THEN 1 ELSE 0 END), 0) AS noData
  FROM crypto_signals`;

export function summarizeSignalCounts(row: Partial<CryptoSignalCounts> | null | undefined): CryptoSignalStats {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  const total = num(row?.total);
  const open = num(row?.open);
  const hit5m = num(row?.hit5m);
  const doubled = num(row?.doubled);
  const rugged = num(row?.rugged);
  const dead = num(row?.dead);
  const noData = num(row?.noData);
  const graded = hit5m + doubled + rugged + dead;
  return {
    total, open, hit5m, doubled, rugged, dead,
    graded,
    noData,
    other: Math.max(0, total - open - graded - noData),
    sampleReady: graded >= CRYPTO_SAMPLE_READY_MIN_GRADED,
    minGradedForSample: CRYPTO_SAMPLE_READY_MIN_GRADED,
    window: "all logged signals",
  };
}

// ─── Round 2: observed zero vs missing ───────────────────────────────────

/** A field that is absent/null/blank/non-numeric is null (missing); an observed 0 stays 0. */
export function observedNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export type SignalOutcome = "OPEN" | "HIT_5M" | "DOUBLED" | "RUGGED" | "DEAD" | "NO_DATA";

/**
 * Grade one logged signal from a fresh read (pure). `liq`/`mcap` null =
 * the source did not report them (missing); 0 = observed zero.
 *  - a full liquidity pull (observed liquidity < 15% of entry, including 0)
 *    is RUGGED even when market cap is missing;
 *  - mcap below 10% of entry is RUGGED;
 *  - otherwise, with no mcap, the outcome stays OPEN until the 72 h horizon,
 *    then NO_DATA (missing, never DEAD).
 */
export function gradeSignal(input: {
  entryMcap: number; entryLiq: number; prevPeak: number | null;
  mcap: number | null; liq: number | null; ageMs: number;
  targetMcap: number; horizonMs: number;
}): { outcome: SignalOutcome; peak: number | null } {
  const { entryMcap, entryLiq, prevPeak, mcap, liq, ageMs, targetMcap, horizonMs } = input;
  const peak = mcap != null ? Math.max(prevPeak ?? 0, mcap) : prevPeak;
  if ((peak ?? 0) >= targetMcap) return { outcome: "HIT_5M", peak };
  if (entryLiq > 0 && liq != null && liq < entryLiq * 0.15) return { outcome: "RUGGED", peak };
  if (mcap == null) return { outcome: ageMs > horizonMs ? "NO_DATA" : "OPEN", peak };
  if (entryMcap > 0 && mcap < entryMcap * 0.1) return { outcome: "RUGGED", peak };
  if (ageMs > horizonMs) return { outcome: (peak ?? 0) >= entryMcap * 2 ? "DOUBLED" : "DEAD", peak };
  return { outcome: "OPEN", peak };
}

// ─── Round 2: stats on distinct coins ────────────────────────────────────

/** Coin identity: the token mint, or the pair when the mint is unknown. */
const COIN_KEY = "COALESCE(NULLIF(token_address, ''), pair_address)";

/**
 * Counts over the FIRST logged signal of each coin (optionally of one
 * verdict), so a coin that logged WATCH then ENTER on several days counts
 * once. Same columns as CRYPTO_SIGNAL_COUNTS_SQL.
 */
export function cryptoCoinCountsSql(verdict?: "ENTER" | "WATCH"): string {
  const where = verdict ? `WHERE verdict = '${verdict}'` : "";
  return `
  WITH firsts AS (
    SELECT outcome, ROW_NUMBER() OVER (PARTITION BY ${COIN_KEY} ORDER BY detected_at ASC, id ASC) AS rn
    FROM crypto_signals ${where}
  )
  SELECT
    COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN outcome = 'OPEN'    THEN 1 ELSE 0 END), 0) AS open,
    COALESCE(SUM(CASE WHEN outcome = 'HIT_5M'  THEN 1 ELSE 0 END), 0) AS hit5m,
    COALESCE(SUM(CASE WHEN outcome = 'DOUBLED' THEN 1 ELSE 0 END), 0) AS doubled,
    COALESCE(SUM(CASE WHEN outcome = 'RUGGED'  THEN 1 ELSE 0 END), 0) AS rugged,
    COALESCE(SUM(CASE WHEN outcome = 'DEAD'    THEN 1 ELSE 0 END), 0) AS dead,
    COALESCE(SUM(CASE WHEN outcome = 'NO_DATA' THEN 1 ELSE 0 END), 0) AS noData
  FROM firsts WHERE rn = 1`;
}

export interface CryptoDeskStats extends CryptoSignalStats {
  /** what the top-level counts are: distinct coins, first signal each */
  basis: "distinct coins (first signal per coin)";
  /** NO_DATA / (graded + NO_DATA) over coins: how much of the resolved sample is missing */
  noDataShare: number | null;
  /** row-level counts (every WATCH/ENTER row, all days) for reference */
  rows: CryptoSignalStats;
  /** first ENTER per coin: the verdict a trader would act on */
  enterCoins: CryptoSignalStats;
}

/** Combine the three aggregate rows; sampleReady is decided on graded COINS. */
export function summarizeDeskStats(
  rowCounts: Partial<CryptoSignalCounts> | null | undefined,
  coinCounts: Partial<CryptoSignalCounts> | null | undefined,
  enterCounts: Partial<CryptoSignalCounts> | null | undefined,
): CryptoDeskStats {
  const coins = summarizeSignalCounts(coinCounts);
  const resolved = coins.graded + coins.noData;
  return {
    ...coins,
    basis: "distinct coins (first signal per coin)",
    noDataShare: resolved > 0 ? coins.noData / resolved : null,
    rows: summarizeSignalCounts(rowCounts),
    enterCoins: summarizeSignalCounts(enterCounts),
  };
}

// ─── Round 2: holder concentration without the "largest = pool" guess ────

/** Solana incinerator (burn) owner: https://learn.backpack.exchange/zh-cn/articles/solana-burn-address-explained */
export const SOLANA_INCINERATOR = "1nc1nerator11111111111111111111111111111111";

export interface HolderAccount { address: string; uiAmount: number | null; owner?: string | null }
export interface DexPool { pairAddress: string; baseAmount: number | null }

export interface ConcentrationResult {
  /** top-10 non-pool, non-burn holders as % of supply */
  top10Pct: number | null;
  excluded: Array<{ address: string; reason: "pool-owned" | "pool-reserve-match" | "burn"; pct: number }>;
  /** pools whose vault was identified among the largest accounts */
  poolsMatched: number;
  poolsTotal: number;
  ownersResolved: boolean;
  method: string;
}

/**
 * Concentration from getTokenLargestAccounts (top 20 token accounts) with
 * pool vaults and burn accounts removed by IDENTITY, not rank:
 *  - owner is one of the token's DEX pair addresses (pool-owned vault), or
 *  - owner is the incinerator (burned), or
 *  - the balance matches a pool's DexScreener `liquidity.base` reserve within
 *    `tol` (2%) (vaults owned by an AMM authority), one account per pool.
 * Everything else counts, including the single largest account: a whale or
 * deployer at the top is exactly what this flag must see. When no pool vault
 * can be identified the result includes it (overstates, conservative) and
 * says so in `method`.
 */
export function holderConcentration(
  accounts: HolderAccount[],
  pools: DexPool[],
  supplyUi: number,
  opts: { tol?: number } = {},
): ConcentrationResult {
  const tol = opts.tol ?? 0.02;
  const ownersResolved = accounts.length > 0 && accounts.every((a) => a.owner != null);
  if (!(supplyUi > 0) || accounts.length === 0) {
    return { top10Pct: null, excluded: [], poolsMatched: 0, poolsTotal: pools.length, ownersResolved, method: "no holder data" };
  }
  const poolAddrs = new Set(pools.map((p) => p.pairAddress));
  const excluded: ConcentrationResult["excluded"] = [];
  const excludedSet = new Set<string>();
  const matchedPools = new Set<string>();
  const sorted = accounts.slice().sort((a, b) => (b.uiAmount ?? 0) - (a.uiAmount ?? 0));
  for (const a of sorted) {
    if (a.owner && poolAddrs.has(a.owner)) {
      excluded.push({ address: a.address, reason: "pool-owned", pct: 100 * (a.uiAmount ?? 0) / supplyUi });
      excludedSet.add(a.address);
      matchedPools.add(a.owner);
    } else if (a.owner === SOLANA_INCINERATOR) {
      excluded.push({ address: a.address, reason: "burn", pct: 100 * (a.uiAmount ?? 0) / supplyUi });
      excludedSet.add(a.address);
    }
  }
  for (const p of pools) {
    if (matchedPools.has(p.pairAddress) || p.baseAmount == null || !(p.baseAmount > 0)) continue;
    const hit = sorted.find((a) => !excludedSet.has(a.address) && a.uiAmount != null &&
      Math.abs(a.uiAmount - p.baseAmount!) <= tol * p.baseAmount!);
    if (hit) {
      excluded.push({ address: hit.address, reason: "pool-reserve-match", pct: 100 * (hit.uiAmount ?? 0) / supplyUi });
      excludedSet.add(hit.address);
      matchedPools.add(p.pairAddress);
    }
  }
  const rest = sorted.filter((a) => !excludedSet.has(a.address)).slice(0, 10);
  const top = rest.reduce((s, a) => s + (a.uiAmount ?? 0), 0);
  const poolsMatched = matchedPools.size;
  const method = poolsMatched > 0
    ? `top-10 holders excluding ${poolsMatched} identified pool vault(s)${excluded.some((e) => e.reason === "burn") ? " and burned supply" : ""} (by owner = pair address or reserve match to DexScreener liquidity.base)`
    : "top-10 holders INCLUDING any pool vault (vault not identified: overstates concentration, conservative)";
  return {
    top10Pct: Number(((100 * top) / supplyUi).toFixed(1)),
    excluded,
    poolsMatched,
    poolsTotal: pools.length,
    ownersResolved,
    method,
  };
}

// ─── Round 2: Bluesky mention counting with an honest cap ────────────────

export interface MentionCount {
  m10: number;
  m1h: number;
  /** the search hit its page cap with posts still inside the hour: counts are lower bounds */
  capped: boolean;
  /** of m1h, posts that contain the token's contract address (identity-safe) */
  byAddress1h: number;
}

/**
 * Union the cashtag and contract-address searches by post URI and count
 * posts in the last 10 / 60 minutes. A query is "capped" when it returned a
 * full last page and its cursor was not exhausted while still inside the
 * hour: then the counts are lower bounds, labelled, not exact.
 */
export function countMentions(
  queries: Array<{ kind: "cashtag" | "address"; posts: Array<{ uri?: string; createdAt?: string; text?: string }>; capped: boolean }>,
  address: string,
  now: number,
): MentionCount {
  const seen = new Map<string, { t: number; hasAddr: boolean }>();
  let capped = false;
  for (const q of queries) {
    if (q.capped) capped = true;
    for (const p of q.posts) {
      const t = Date.parse(p.createdAt ?? "");
      if (!Number.isFinite(t)) continue;
      const key = p.uri ?? `${q.kind}:${t}:${(p.text ?? "").slice(0, 40)}`;
      const hasAddr = q.kind === "address" || (!!address && (p.text ?? "").includes(address));
      const prev = seen.get(key);
      seen.set(key, { t, hasAddr: hasAddr || (prev?.hasAddr ?? false) });
    }
  }
  let m10 = 0, m1h = 0, byAddress1h = 0;
  for (const v of Array.from(seen.values())) {
    const age = now - v.t;
    if (age < 0 || age >= 3600_000) continue;
    m1h++;
    if (v.hasAddr) byAddress1h++;
    if (age < 600_000) m10++;
  }
  return { m10, m1h, capped, byAddress1h };
}
