/**
 * cryptoRules.ts: the crypto desk's rule book, versioned.
 *
 * Every number the scanner uses to decide WATCH / ENTER / PASS, to size a
 * position and to grade a signal lives here with a version string, so a
 * graded row can always be tied to the rules that produced it, and a
 * change to any threshold is a new version (tests/quant pins the hash).
 * The desk is read-only: these rules produce signals and grades, never
 * orders. See docs/CRYPTO_DESK.md for the charter and the method.
 */

export const CRYPTO_RULES_VERSION = "2026.10.27-1";

export const CRYPTO_RULES = {
  universe: {
    /** Chains the scanner reads. On-chain facts (authorities, holders) are Solana only. */
    chains: ["solana"] as const,
    /** Track up to this market cap so the cross of the entry ceiling is seen. */
    trackMcapMaxUsd: 1_500_000,
    /** ENTER only below this market cap (room to the target). */
    enterMcapMaxUsd: 1_000_000,
    /** The desk's ride target; the grader's HIT_5M threshold and the limit-sell level. */
    targetMcapUsd: 5_000_000,
    /** Below this pool liquidity the position cannot be exited: hard kill. */
    liquidityFloorUsd: 8_000,
    /** Tracked names cap (memory and the public feeds' rate budgets). */
    maxTracked: 220,
    /** Drop a candidate after this long without a signal. */
    candidateTtlHours: 48,
  },
  hardKills: {
    /** Mint authority still active: the dev can print supply. */
    mintAuthorityActive: true,
    /** Freeze authority still active: the dev can freeze the holder. */
    freezeAuthorityActive: true,
    /** Liquidity missing (not reported), observed $0, or under the floor. */
    liquidityMissingOrZero: true,
  },
  enter: {
    /** Composite score floor (heuristic, hand-set features, not fitted to outcomes). */
    minScore: 70,
    /** 5-minute volume pace over the hour's pace. */
    minVolAccel: 1.5,
    /** Buys over buys + sells in the last 5 minutes. */
    minNetBuyRatio5m: 0.58,
    /** Jupiter must agree with the pool price within this gap (else WATCH: price unconfirmed). */
    maxJupiterGapPct: 15,
    /** At least one sell observed in the last hour (honeypot check). Missing sells block. */
    requireSellsObserved: true,
    /** Top-10 holder share must have been read; unread blocks. */
    requireTop10Read: true,
    /** Desk risk must be "on"; off or unknown blocks. */
    requireDeskRiskOn: true,
  },
  watch: {
    /** Score floor to list a forming setup. */
    minScore: 50,
    /** Score floor for a WATCH row carrying a hard-kill flag (shown, never ENTER). */
    minScoreWithKill: 55,
  },
  flags: {
    /** Under this age the spread is punitive; flagged, not killed. */
    sniperZoneMinutes: 10,
    /** Aged with observed low volume: dead pool flag (missing volume is not low volume). */
    deadPoolMinVolume24hUsd: 1_000,
    deadPoolMinAgeMinutes: 720,
  },
  deskRisk: {
    /** BTC this far under its Kraken 24 h VWAP turns the desk off. */
    offBelowPct: -5,
    /** A majors read older than this is unknown (fails closed). */
    maxAgeMinutes: 10,
  },
  sizing: {
    /** Position = this share of pool liquidity, capped; the exit is the constraint. */
    poolShare: 0.005,
    maxPositionUsd: 400,
    /** Shown stop levels (descriptive; the desk never places orders). */
    suggestedStopPct: -35,
    liquidityExitStopPct: -30,
    holdHorizonHours: 24,
  },
  grading: {
    /** Signals are graded at this horizon; the hold rule exits here. */
    horizonHours: 72,
    /** RUGGED when liquidity falls under this share of entry liquidity ... */
    ruggedLiquidityShare: 0.15,
    /** ... or market cap under this share of the entry cap. */
    ruggedMcapShare: 0.10,
    /** DOUBLED when the sampled peak reaches this multiple of entry by the horizon. */
    doubledMultiple: 2,
    /** First signal per coin only enters the expectancy sample. */
    firstSignalPerCoin: true,
    /** Minimum graded first-signals before any label other than INSUFFICIENT DATA. */
    minSample: 50,
    /** Above this share of graded rows unpriced past the horizon, the sample is too selected to read. */
    maxNoDataShare: 0.2,
    /** Expectancy is quoted per this position size, net of pool fees and impact on both legs. */
    sizeUsd: 100,
  },
} as const;

export type CryptoRules = typeof CRYPTO_RULES;

export interface CryptoRuleItem {
  path: string;
  value: string;
  text: string;
}

/** Every rule in words, for the card and the method page. */
export function describeCryptoRules(r: CryptoRules = CRYPTO_RULES): CryptoRuleItem[] {
  const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    { path: "universe.chains", value: r.universe.chains.join(", "), text: "chains scanned; on-chain facts read on Solana" },
    { path: "universe.enterMcapMaxUsd", value: usd(r.universe.enterMcapMaxUsd), text: "ENTER only below this market cap" },
    { path: "universe.targetMcapUsd", value: usd(r.universe.targetMcapUsd), text: "ride target; HIT_5M threshold and the graded rule's limit-sell level" },
    { path: "universe.liquidityFloorUsd", value: usd(r.universe.liquidityFloorUsd), text: "pool liquidity floor; under it the position cannot be exited (hard kill)" },
    { path: "hardKills", value: "mint active, freeze active, liquidity missing or $0", text: "any one of these keeps a row at WATCH or PASS whatever the score" },
    { path: "enter.minScore", value: String(r.enter.minScore), text: "composite score floor (heuristic; hand-set, not fitted to outcomes)" },
    { path: "enter.minVolAccel", value: `${r.enter.minVolAccel}x`, text: "5-minute volume pace over the hour's pace" },
    { path: "enter.minNetBuyRatio5m", value: pct(r.enter.minNetBuyRatio5m), text: "buys over buys plus sells in the last 5 minutes" },
    { path: "enter.maxJupiterGapPct", value: `${r.enter.maxJupiterGapPct}%`, text: "Jupiter price must agree with the pool price; a failed or skipped check blocks" },
    { path: "enter.requireSellsObserved", value: "yes", text: "at least one sell observed in the last hour; missing sell counts block (honeypot check)" },
    { path: "enter.requireTop10Read", value: "yes", text: "top-10 holder share read on-chain; unread blocks (retried every 30 min)" },
    { path: "enter.requireDeskRiskOn", value: "yes", text: "desk risk on; off or unknown blocks" },
    { path: "deskRisk.offBelowPct", value: `${r.deskRisk.offBelowPct}%`, text: "BTC vs its Kraken 24 h VWAP; stale or unread majors are unknown (fails closed)" },
    { path: "watch.minScore", value: String(r.watch.minScore), text: "score floor to list a forming setup" },
    { path: "flags.sniperZoneMinutes", value: `${r.flags.sniperZoneMinutes} min`, text: "under this age the spread is punitive (flag, not a kill)" },
    { path: "sizing", value: `${pct(r.sizing.poolShare)} of pool, max ${usd(r.sizing.maxPositionUsd)}`, text: "position sized by the exit, never by conviction; the desk places no orders" },
    { path: "grading.horizonHours", value: `${r.grading.horizonHours} h`, text: "grading horizon; the hold rule exits at this mark" },
    { path: "grading.rugged", value: `liq < ${pct(r.grading.ruggedLiquidityShare)} or cap < ${pct(r.grading.ruggedMcapShare)} of entry`, text: "RUGGED classification" },
    { path: "grading.minSample", value: `${r.grading.minSample} first-signals, no-data share <= ${pct(r.grading.maxNoDataShare)}`, text: "below this the expectancy card reads INSUFFICIENT DATA; passing a test is not a forecast" },
    { path: "grading.sizeUsd", value: usd(r.grading.sizeUsd), text: "expectancy quoted per position, net of pool fees and impact on both legs" },
  ];
}
