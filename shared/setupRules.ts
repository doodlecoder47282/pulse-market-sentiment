// shared/setupRules.ts
//
// The setup pipeline's rule book: what a setup IS, stated as thresholds a
// reader can see and the owner can tweak. The server detects setups from
// these rules (shared/setupDetect.ts), logs every candidate with the rule
// version that fired, and grades the outcome later with the achievable-exit
// test. A tweak bumps the version, so grading stays per version and a new
// threshold never contaminates the history of the old one.
//
// None of this is a probability. A setup is a stated condition that was met;
// what it has paid is measured afterwards, per version, and shown with an
// interval only once the sample clears the gate.

export const SETUP_RULES_VERSION = "2026.10.21-1";

/** Minimum graded setups per rule version before any letter grade is shown. */
export const SETUP_GRADE_MIN_SAMPLE = 100;

export interface SetupRules {
  version: string;
  /** Equities: index and ETF structure read from the per-name chain. */
  structure: {
    /** A level is "at" a landmark when spot is within this fraction of spot (0.001 = 0.1%). */
    atLandmarkPct: number;
    /** Share of the map's gross exposure a strike needs to count as a wall or magnet. */
    minWallShare: number;
  };
  flow: {
    /** Lowest premium ($) for a print to count as confirming flow. */
    minPremiumUsd: number;
    /** Lowest volume / open interest at the strike. */
    minVolOi: number;
    /** DTE window the confirming print must sit in. */
    dteMin: number;
    dteMax: number;
    /** Print must have been bought at the ask: calls for an up move, puts for a down move. */
    requireAggressor: boolean;
    /** How old a print can be and still confirm, minutes. */
    maxAgeMin: number;
  };
  vol: {
    /** Setup is skipped when the straddle-implied move is wider than this fraction of spot (news-priced tape). */
    maxImpliedMovePct: number;
  };
  regime: {
    /** Required dealer gamma sign at spot for a fade setup. */
    fadeRequires: "long";
    /** Required dealer gamma sign at spot for a breakout setup. */
    breakoutRequires: "short";
  };
  events: {
    /** No tier-1 event (CPI, FOMC, NFP, PCE) inside this many minutes ahead. */
    tier1QuietMin: number;
    /** No setup inside this many minutes after a tier-1 release (the print is still being traded). */
    tier1QuietAfterMin: number;
  };
  session: {
    /** Minutes after the open before a setup can fire (opening rotation). */
    notBeforeMin: number;
    /** Minutes before the close after which no setup fires (no horizon left). */
    notAfterMin: number;
  };
  outcome: {
    /** Horizon for the achievable-exit test, minutes. */
    horizonMin: number;
    /** Target: the next landmark on the trade's side; fallback distance as a fraction of spot when none. */
    fallbackTargetPct: number;
    /** Invalidation: beyond the landmark by this fraction of spot. */
    invalidationPct: number;
    /** Cost the target must clear, as a multiple of the modelled round-trip cost. */
    minTargetToCostMultiple: number;
    /** Reward to risk: target distance over invalidation distance must be at least this. */
    minRMultiple: number;
  };
  rank: {
    /** How many open setups the ranked list shows. */
    topN: number;
    /** At most this many from one sector, so the list is not one bet ten times. */
    maxPerSector: number;
  };
  crypto: {
    /** ENTER-grade setups need these on-chain facts read (not null). */
    requireMintAuthorityRead: boolean;
    requireTop10Read: boolean;
    maxTop10Pct: number;
    /** Round trip of the modelled size must cost under this percent of size. */
    maxRoundTripCostPct: number;
    sizeUsd: number;
    horizonMin: number;
  };
}

export const DEFAULT_SETUP_RULES: SetupRules = {
  version: SETUP_RULES_VERSION,
  structure: { atLandmarkPct: 0.001, minWallShare: 0.03 },
  flow: { minPremiumUsd: 2_500_000, minVolOi: 15, dteMin: 1, dteMax: 3, requireAggressor: true, maxAgeMin: 45 },
  vol: { maxImpliedMovePct: 0.02 },
  regime: { fadeRequires: "long", breakoutRequires: "short" },
  events: { tier1QuietMin: 90, tier1QuietAfterMin: 60 },
  session: { notBeforeMin: 15, notAfterMin: 45 },
  outcome: { horizonMin: 120, fallbackTargetPct: 0.004, invalidationPct: 0.002, minTargetToCostMultiple: 3, minRMultiple: 2 },
  rank: { topN: 10, maxPerSector: 3 },
  crypto: { requireMintAuthorityRead: true, requireTop10Read: true, maxTop10Pct: 30, maxRoundTripCostPct: 4, sizeUsd: 1_000, horizonMin: 72 * 60 },
};

/** Flat list of every rule for the Method panel: path, value, and what it means. */
export function describeRules(r: SetupRules = DEFAULT_SETUP_RULES): Array<{ path: string; value: string | number | boolean; meaning: string }> {
  return [
    { path: "structure.atLandmarkPct", value: r.structure.atLandmarkPct, meaning: "spot counts as at a landmark within this fraction of spot" },
    { path: "structure.minWallShare", value: r.structure.minWallShare, meaning: "share of the map's gross exposure a strike needs to be a wall or magnet" },
    { path: "flow.minPremiumUsd", value: r.flow.minPremiumUsd, meaning: "lowest premium at observed prices for a confirming print" },
    { path: "flow.minVolOi", value: r.flow.minVolOi, meaning: "lowest volume / open interest at the print's strike" },
    { path: "flow.dteMin", value: r.flow.dteMin, meaning: "earliest expiry the print may sit in (days)" },
    { path: "flow.dteMax", value: r.flow.dteMax, meaning: "latest expiry the print may sit in (days)" },
    { path: "flow.requireAggressor", value: r.flow.requireAggressor, meaning: "the print must have been bought at the ask (calls for up, puts for down)" },
    { path: "flow.maxAgeMin", value: r.flow.maxAgeMin, meaning: "a print older than this no longer confirms" },
    { path: "vol.maxImpliedMovePct", value: r.vol.maxImpliedMovePct, meaning: "no setup when the straddle prices a move wider than this (news-priced tape)" },
    { path: "regime.fadeRequires", value: r.regime.fadeRequires, meaning: "dealer gamma sign at spot a fade needs" },
    { path: "regime.breakoutRequires", value: r.regime.breakoutRequires, meaning: "dealer gamma sign at spot a breakout needs" },
    { path: "events.tier1QuietMin", value: r.events.tier1QuietMin, meaning: "minutes of clear air before a tier-1 event" },
    { path: "events.tier1QuietAfterMin", value: r.events.tier1QuietAfterMin, meaning: "minutes after a tier-1 release before a setup can fire" },
    { path: "session.notBeforeMin", value: r.session.notBeforeMin, meaning: "minutes after the open before a setup can fire" },
    { path: "session.notAfterMin", value: r.session.notAfterMin, meaning: "minutes before the close after which none fires" },
    { path: "outcome.horizonMin", value: r.outcome.horizonMin, meaning: "minutes the achievable-exit test runs" },
    { path: "outcome.fallbackTargetPct", value: r.outcome.fallbackTargetPct, meaning: "target distance when no landmark sits on the trade's side" },
    { path: "outcome.invalidationPct", value: r.outcome.invalidationPct, meaning: "beyond the landmark by this fraction of spot, the setup failed" },
    { path: "outcome.minTargetToCostMultiple", value: r.outcome.minTargetToCostMultiple, meaning: "the target must clear the modelled round-trip cost by this multiple" },
    { path: "outcome.minRMultiple", value: r.outcome.minRMultiple, meaning: "reward to risk: target distance over invalidation distance, at least this" },
    { path: "rank.topN", value: r.rank.topN, meaning: "open setups shown in the ranked list, by margin over the rules" },
    { path: "rank.maxPerSector", value: r.rank.maxPerSector, meaning: "at most this many ranked setups from one sector" },
    { path: "crypto.requireMintAuthorityRead", value: r.crypto.requireMintAuthorityRead, meaning: "a crypto setup needs the mint authority read, not assumed" },
    { path: "crypto.requireTop10Read", value: r.crypto.requireTop10Read, meaning: "a crypto setup needs the top-10 holder share read" },
    { path: "crypto.maxTop10Pct", value: r.crypto.maxTop10Pct, meaning: "top-10 holders above this share: no setup" },
    { path: "crypto.maxRoundTripCostPct", value: r.crypto.maxRoundTripCostPct, meaning: "round trip of the modelled size must cost under this percent" },
    { path: "crypto.sizeUsd", value: r.crypto.sizeUsd, meaning: "size the crypto cost model prices" },
    { path: "crypto.horizonMin", value: r.crypto.horizonMin, meaning: "minutes the crypto achievable-exit test runs" },
  ];
}
