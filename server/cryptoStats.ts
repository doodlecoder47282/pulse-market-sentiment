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
  /** Of the above, posts naming the contract address (identity-safe). Absent = not split (old rows). */
  bskyMentionsByAddress10m?: number | null;
  bskyMentionsByAddress1h?: number | null;
  pumpReplyPerHr: number | null;
  pumpLive: boolean;
  hasSocialLinks: boolean | null;
}

/**
 * Weight of a cashtag-only mention relative to one that names the contract
 * address. A "$SYMBOL" post can be about another coin or a plain word; the
 * address identifies the token. Hand-set heuristic (not fitted), labelled.
 */
export const CASHTAG_ONLY_WEIGHT = 0.5;

/** Address matches count fully, cashtag-only matches at CASHTAG_ONLY_WEIGHT. */
export function weightedMentions(total: number | null | undefined, byAddress: number | null | undefined): number {
  const t = total ?? 0;
  if (byAddress == null) return t; // not split (legacy): count all
  const a = Math.min(byAddress, t);
  return a + CASHTAG_ONLY_WEIGHT * (t - a);
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
    s += Math.min(35, weightedMentions(i.bskyMentions10m, i.bskyMentionsByAddress10m) * 12); // fresh mentions are gold
    s += Math.min(20, weightedMentions(i.bskyMentions1h, i.bskyMentionsByAddress1h) * 2.5);
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

/**
 * Survivorship (round 3). A pair DexScreener stops returning after a rug
 * (pool closed, pair delisted) becomes NO_DATA and leaves the graded set, so
 * the observed rug rate is biased DOWN exactly where it matters. Bounds:
 *   observed  = RUGGED / graded,
 *   worst case = (RUGGED + NO_DATA) / (graded + NO_DATA)  (every NO_DATA a rug),
 * reported side by side (Manski-style bounds for missing outcomes:
 * Manski 1989, "Anatomy of the Selection Problem", J. Human Resources 24(3):343-360,
 * https://ideas.repec.org/a/uwp/jhriss/v24y1989i3p343-360.html).
 * The sample gate also requires the NO_DATA share to stay at or below
 * CRYPTO_NO_DATA_MAX_SHARE (heuristic, stated): beyond it the graded sample
 * is too selected to read.
 */
export const CRYPTO_NO_DATA_MAX_SHARE = 0.2;

export interface Survivorship {
  noDataShare: number | null;
  ruggedRateObserved: number | null;
  ruggedRateWorstCase: number | null;
  /** HIT_5M + DOUBLED over graded + NO_DATA: the win rate if every NO_DATA were a loss */
  winRateWorstCase: number | null;
}

export function survivorship(c: CryptoSignalStats): Survivorship {
  const resolved = c.graded + c.noData;
  return {
    noDataShare: resolved > 0 ? c.noData / resolved : null,
    ruggedRateObserved: c.graded > 0 ? c.rugged / c.graded : null,
    ruggedRateWorstCase: resolved > 0 ? (c.rugged + c.noData) / resolved : null,
    winRateWorstCase: resolved > 0 ? (c.hit5m + c.doubled) / resolved : null,
  };
}

/** Sample gate: enough graded coins AND a NO_DATA share low enough to read the graded set. */
export function sampleGate(c: CryptoSignalStats): { ready: boolean; reason: string } {
  const sv = survivorship(c);
  if (c.graded < CRYPTO_SAMPLE_READY_MIN_GRADED) return { ready: false, reason: `${c.graded} graded (need ${CRYPTO_SAMPLE_READY_MIN_GRADED})` };
  if (sv.noDataShare != null && sv.noDataShare > CRYPTO_NO_DATA_MAX_SHARE) {
    return { ready: false, reason: `no-data share ${Math.round(sv.noDataShare * 100)}% > ${Math.round(CRYPTO_NO_DATA_MAX_SHARE * 100)}%: delisted pairs (likely rugs) are missing from the graded set` };
  }
  return { ready: true, reason: `${c.graded} graded, no-data share ${sv.noDataShare == null ? "n/a" : `${Math.round(sv.noDataShare * 100)}%`}` };
}

/**
 * How peaks are observed (round 4): every momentum refresh of a tracked coin
 * (DexScreener batch, no extra API call) raises peak_mcap on that coin's OPEN
 * signal rows; the grader (every CRYPTO_PEAK_SAMPLE_MIN minutes, at most
 * CRYPTO_GRADER_BATCH OPEN rows per pass, oldest first) re-prices rows whose
 * coin is no longer tracked. Before round 4 only the grader wrote peaks, so
 * under a backlog of more than CRYPTO_GRADER_BATCH open rows new signals got
 * no peak samples at all. A spike that tops and fades between two samples is
 * still missed: HIT_5M and DOUBLED are LOWER bounds and the peak market cap
 * is a sampled peak, not the true high. (Faster sampling would need an OHLC
 * source; DexScreener's pair endpoint has no candles.)
 */
export const CRYPTO_PEAK_SAMPLE_MIN = 10;
export const CRYPTO_GRADER_BATCH = 60;
export const CRYPTO_PEAK_SAMPLING_NOTE = `peaks sampled at each momentum refresh of a tracked coin and by the grader every ${CRYPTO_PEAK_SAMPLE_MIN} min (oldest ${CRYPTO_GRADER_BATCH} open rows per pass) once a coin is no longer tracked: spikes between samples are missed, so HIT_5M and DOUBLED are lower bounds`;

/**
 * Sampling label with the live refresh cadence: a tracked coin is refreshed
 * once per ceil(tracked / perTick) momentum ticks of tickMs.
 */
export function peakSamplingNote(tracked: number | null | undefined, tickMs: number, perTick: number): string {
  if (tracked == null || !Number.isFinite(tracked) || tracked <= 0 || !(perTick > 0) || !(tickMs > 0)) return CRYPTO_PEAK_SAMPLING_NOTE;
  const everySec = Math.ceil(tracked / perTick) * tickMs / 1000;
  return `peaks sampled at each momentum refresh of a tracked coin (about every ${everySec} s with ${tracked} tracked) and by the grader every ${CRYPTO_PEAK_SAMPLE_MIN} min (oldest ${CRYPTO_GRADER_BATCH} open rows per pass) once a coin is no longer tracked: spikes between samples are missed, so HIT_5M and DOUBLED are lower bounds`;
}

/**
 * Peak sample for every OPEN row of one pair (params: ?1 mcap, ?2 sample time
 * ms, ?3 liquidity, ?4 chain, ?5 pair address). SQLite evaluates each SET
 * expression on the pre-update row, so peak_at moves only with the peak.
 */
export const CRYPTO_PEAK_SAMPLE_SQL = `UPDATE crypto_signals SET
  peak_at = CASE WHEN peak_mcap IS NULL OR ?1 > peak_mcap THEN ?2 ELSE peak_at END,
  peak_mcap = CASE WHEN peak_mcap IS NULL OR ?1 > peak_mcap THEN ?1 ELSE peak_mcap END,
  last_mcap = ?1, last_liquidity = ?3
WHERE outcome = 'OPEN' AND chain = ?4 AND pair_address = ?5`;

/**
 * Grader write (round 4 follow-up): MONOTONIC peak. The grader awaits network
 * fetches between reading a row and writing it, and a momentum refresh can
 * raise peak_mcap meanwhile; a plain "peak_mcap = ?" would lower it. The peak
 * is max(stored, sample), peak_at moves only when the sample raises it, and
 * the outcome is re-derived from that max: >= target -> HIT_5M (first rule
 * of gradeSignal), a DEAD whose max peak doubled the entry -> DOUBLED.
 * graded_at follows the final outcome. Only OPEN rows are written.
 * Params: ?1 sampled peak (null = no sample), ?2 now ms, ?3 last mcap,
 * ?4 last liquidity, ?5 outcome from gradeSignal, ?6 target mcap, ?7 id.
 */
export const CRYPTO_GRADER_MARK_SQL = `UPDATE crypto_signals SET
  peak_at = CASE WHEN ?1 IS NOT NULL AND (peak_mcap IS NULL OR ?1 > peak_mcap) THEN ?2 ELSE peak_at END,
  peak_mcap = MAX(COALESCE(peak_mcap, ?1), COALESCE(?1, peak_mcap)),
  last_mcap = ?3, last_liquidity = ?4,
  outcome = CASE
    WHEN MAX(COALESCE(peak_mcap, ?1, 0), COALESCE(?1, peak_mcap, 0)) >= ?6 THEN 'HIT_5M'
    WHEN ?5 = 'DEAD' AND mcap_at_signal > 0 AND MAX(COALESCE(peak_mcap, ?1, 0), COALESCE(?1, peak_mcap, 0)) >= 2 * mcap_at_signal THEN 'DOUBLED'
    ELSE ?5 END,
  graded_at = CASE
    WHEN MAX(COALESCE(peak_mcap, ?1, 0), COALESCE(?1, peak_mcap, 0)) >= ?6 THEN ?2
    WHEN ?5 = 'OPEN' THEN NULL
    ELSE ?2 END
WHERE id = ?7 AND outcome = 'OPEN'`;

/** NO_DATA close-out, unless a sampled peak already reached the target
 *  (then HIT_5M: the hit was observed). Params: ?1 now, ?2 id, ?3 target. */
export const CRYPTO_GRADER_NO_DATA_SQL = `UPDATE crypto_signals SET
  outcome = CASE WHEN peak_mcap IS NOT NULL AND peak_mcap >= ?3 THEN 'HIT_5M' ELSE 'NO_DATA' END,
  graded_at = ?1
WHERE id = ?2 AND outcome = 'OPEN'`;

/** New sampled peak from one observation: null mcap (missing) leaves the peak unchanged; observed 0 is a valid sample. */
export function nextPeak(prevPeak: number | null, mcap: number | null): { peak: number | null; improved: boolean } {
  if (mcap == null || !Number.isFinite(mcap)) return { peak: prevPeak, improved: false };
  if (prevPeak == null || mcap > prevPeak) return { peak: mcap, improved: true };
  return { peak: prevPeak, improved: false };
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
  /** survivorship bounds over all coins and over first-ENTER coins (round 3) */
  survivorship: { coins: Survivorship; enterCoins: Survivorship };
  /** the top-level sampleReady is decided on first-ENTER coins (round 3) */
  sampleBasis: "first-ENTER coins";
  sampleReason: string;
  /** all-coins gate, for reference */
  allCoinsSampleReady: boolean;
  peakSampling: string;
}

/**
 * Combine the three aggregate rows. sampleReady is decided on graded
 * first-ENTER COINS (the verdict a trader acts on) and requires the NO_DATA
 * share to be readable (round 3); the all-coins gate is kept for reference.
 */
export function summarizeDeskStats(
  rowCounts: Partial<CryptoSignalCounts> | null | undefined,
  coinCounts: Partial<CryptoSignalCounts> | null | undefined,
  enterCounts: Partial<CryptoSignalCounts> | null | undefined,
  peakNote: string = CRYPTO_PEAK_SAMPLING_NOTE,
): CryptoDeskStats {
  const coins = summarizeSignalCounts(coinCounts);
  const enter = summarizeSignalCounts(enterCounts);
  const resolved = coins.graded + coins.noData;
  const gEnter = sampleGate(enter);
  const gAll = sampleGate(coins);
  return {
    ...coins,
    basis: "distinct coins (first signal per coin)",
    noDataShare: resolved > 0 ? coins.noData / resolved : null,
    rows: summarizeSignalCounts(rowCounts),
    enterCoins: { ...enter, sampleReady: gEnter.ready },
    survivorship: { coins: survivorship(coins), enterCoins: survivorship(enter) },
    sampleReady: gEnter.ready,
    sampleBasis: "first-ENTER coins",
    sampleReason: `first-ENTER coins: ${gEnter.reason}`,
    allCoinsSampleReady: gAll.ready,
    peakSampling: peakNote,
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
  /** "unavailable" when token-account owners could not be read (round 3) */
  state: "ok" | "unavailable";
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
    return { top10Pct: null, excluded: [], poolsMatched: 0, poolsTotal: pools.length, ownersResolved, state: "unavailable", method: "no holder data" };
  }
  // Round 3: without owners, a balance that happens to match a pool reserve
  // could be a whale, and an unmatched vault would be counted as a holder;
  // neither number is trustworthy. Concentration is unavailable, not guessed.
  if (!ownersResolved) {
    return {
      top10Pct: null, excluded: [], poolsMatched: 0, poolsTotal: pools.length, ownersResolved, state: "unavailable",
      method: "unavailable: token-account owners could not be read, so pool vaults cannot be told apart from whales",
    };
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
  // Reserve match (owners known): one account per pool, and never an account
  // whose owner also holds another top account (a wallet spreading a bag
  // over several token accounts is a holder, not a vault).
  const ownerCount = new Map<string, number>();
  for (const a of sorted) if (a.owner) ownerCount.set(a.owner, (ownerCount.get(a.owner) ?? 0) + 1);
  for (const p of pools) {
    if (matchedPools.has(p.pairAddress) || p.baseAmount == null || !(p.baseAmount > 0)) continue;
    const hit = sorted.find((a) => !excludedSet.has(a.address) && a.uiAmount != null && a.owner != null &&
      (ownerCount.get(a.owner) ?? 0) === 1 &&
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
    state: "ok",
    method,
  };
}

// ─── Round 3: flow vs attention (no FOMO double count) ───────────────────

/**
 * Components of the momentum read. The round-2 composite added
 * min(35, 0.35 x FOMO) as "flow" AND 0.10 x FOMO as "fomo", while FOMO
 * itself was acceleration + one-sided tape + trending/boost: the same
 * inputs counted twice (up to 45 of 100 points). Now:
 *   flowPts      = 35 x (accelPts + tapePts) / 90  (acceleration, tape only)
 *   attentionPts = 10 x (trending 10 + boosted 8) / 18
 * and fomoScore (displayed) = accel + tape + trending + boost, capped 100,
 * unchanged, but it no longer enters the composite on its own.
 */
export function momentumPoints(i: { volAccel: number | null; netBuyRatio5m: number | null; trending: boolean; boosted: boolean }): { fomoScore: number; flowPts: number; attentionPts: number } {
  const accelPts = i.volAccel != null ? Math.min(40, i.volAccel * 10) : 0;
  const tapePts = i.netBuyRatio5m != null ? Math.max(0, (i.netBuyRatio5m - 0.5) * 100) : 0;
  const attn = (i.trending ? 10 : 0) + (i.boosted ? 8 : 0);
  return {
    fomoScore: Math.min(100, accelPts + tapePts + attn),
    flowPts: (35 * (accelPts + tapePts)) / 90,
    attentionPts: (10 * attn) / 18,
  };
}

/**
 * Honeypot read on the 1 h sell count. An OBSERVED 0 sells against 25+
 * buys is the honeypot pattern (hard kill); a MISSING sell count is not
 * "zero sells", it is an unverifiable sell side (blocks ENTER, not a kill).
 */
export function honeypotRead(buys1h: number | null, sells1h: number | null): "honeypot" | "sells_missing" | "ok" {
  if (sells1h == null) return "sells_missing";
  if ((buys1h ?? 0) >= 25 && sells1h === 0) return "honeypot";
  return "ok";
}

/** Jupiter states that let an ENTER stand; anything else holds at WATCH (fail-closed). */
export function jupiterAllowsEnter(state: string | null | undefined): boolean {
  return state === "agree" || state === "watch";
}

// ─── Round 2: Bluesky mention counting with an honest cap ────────────────

export interface MentionCount {
  m10: number;
  /** of m10, posts that contain the contract address */
  byAddress10m: number;
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
  let m10 = 0, m1h = 0, byAddress1h = 0, byAddress10m = 0;
  for (const v of Array.from(seen.values())) {
    const age = now - v.t;
    if (age < 0 || age >= 3600_000) continue;
    m1h++;
    if (v.hasAddr) byAddress1h++;
    if (age < 600_000) { m10++; if (v.hasAddr) byAddress10m++; }
  }
  return { m10, byAddress10m, m1h, capped, byAddress1h };
}
