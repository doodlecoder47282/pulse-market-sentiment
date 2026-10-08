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

/** 0-100 social score from the fields a complete collection produced (unchanged weights). */
export function computeSocialScore(i: SocialInputs): number {
  let s = 0;
  s += Math.min(35, (i.bskyMentions10m ?? 0) * 12);          // fresh mentions are gold
  s += Math.min(20, (i.bskyMentions1h ?? 0) * 2.5);
  s += Math.min(30, Math.max(0, (i.pumpReplyPerHr ?? 0)) * 0.75); // 40 replies/hr = max
  if (i.pumpLive) s += 10;
  if (i.hasSocialLinks) s += 5;
  return Math.round(Math.min(100, s));
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
  freshScore: number,
  now: number,
): SocialState {
  const attempted = [sources.bsky, sources.pump].filter((s) => s !== "skipped");
  if (attempted.length === 0) {
    return { socialScore: null, socialCheckedAt: prev.socialCheckedAt, socialStatus: "unavailable" };
  }
  const failed = attempted.filter((s) => s === "failed").length;
  if (failed === 0) {
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
