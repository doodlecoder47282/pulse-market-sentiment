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

export const CRYPTO_RULES_VERSION = "2026.10.27-2";

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
    /** Exit door: liquidity under this share of market cap cannot absorb an exit. */
    exitDoorMinLiqToMcap: 0.03,
    /** Mid-rug or post-dump: 1 h price change at or under this. */
    midRugChg1hPct: -55,
    /** Honeypot pattern: at least this many buys in 1 h with ZERO sells observed (missing sells block ENTER, never kill). */
    honeypotMinBuys1h: 25,
  },
  jupiter: {
    /** Pool price within this gap of Jupiter: "agree". */
    agreePct: 5,
    /** Within this gap: "watch" (ENTER still allowed); beyond it: "diverge" (no entry). */
    divergePct: 15,
  },
  enter: {
    /** Composite score floor (heuristic, hand-set features, not fitted to outcomes). */
    minScore: 70,
    /** 5-minute volume pace over the hour's pace. */
    minVolAccel: 1.5,
    /** Whale-blink filter: volAccel at the floor on at least `need` of the last `window` refreshes. */
    sustainedPolls: { window: 3, need: 2 },
    /** Buys over buys + sells in the last 5 minutes. */
    minNetBuyRatio5m: 0.58,
    /** Jupiter must agree or watch (gap <= jupiter.divergePct); failed, skipped or diverged blocks. */
    requireJupiterAgreeOrWatch: true,
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
  },
  mcapCeiling: {
    /** Above the entry ceiling a row can only be a retrace WATCH, and only from this score. */
    watchMinScore: 55,
  },
  flags: {
    /** Under this age the spread is punitive; flagged, not killed. */
    sniperZoneMinutes: 10,
    /** Aged with observed low volume: dead pool flag (missing volume is not low volume). */
    deadPoolMinVolume24hUsd: 1_000,
    deadPoolMinAgeMinutes: 720,
    /** Top-10 holder share above this is flagged (coordinated dump risk). */
    top10MaxPct: 45,
    /** LP locked share under this is flagged (pull risk). */
    lpLockMinPct: 50,
    /** Liquidity above this multiple of market cap is flagged (likely mispriced data). */
    liqOverMcapMultiple: 2,
  },
  security: {
    /** Re-read authorities while one is active, and retry an unread top-10 share, every this many minutes. */
    retryMinutes: 30,
  },
  deskRisk: {
    /** BTC this far under its Kraken 24 h VWAP turns the desk off. */
    offBelowPct: -5,
    /** A majors read older than this is unknown (fails closed), live and at restart. */
    maxAgeMinutes: 10,
  },
  cost: {
    /** Pool fee per leg, percent of size. */
    dexFeePct: 0.25,
    /** Platform / router fee per leg, percent of size. */
    platformFeePct: 1.0,
    /** Priority fee per leg, USD. */
    priorityFeeUsd: 0.25,
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
    { path: "hardKills", value: `mint or freeze active; liquidity missing, $0 or under the floor; liq/mcap < ${pct(r.hardKills.exitDoorMinLiqToMcap)}; 1 h change <= ${r.hardKills.midRugChg1hPct}%; >= ${r.hardKills.honeypotMinBuys1h} buys with zero sells`, text: "any one of these is PASS (code hard_kill) whatever the score" },
    { path: "enter.minScore", value: String(r.enter.minScore), text: "composite score floor (heuristic; hand-set, not fitted to outcomes)" },
    { path: "enter.minVolAccel", value: `${r.enter.minVolAccel}x`, text: "5-minute volume pace over the hour's pace" },
    { path: "enter.sustainedPolls", value: `${r.enter.sustainedPolls.need} of last ${r.enter.sustainedPolls.window}`, text: "whale-blink filter: the accel floor must hold on this many recent refreshes" },
    { path: "enter.minNetBuyRatio5m", value: pct(r.enter.minNetBuyRatio5m), text: "buys over buys plus sells in the last 5 minutes" },
    { path: "jupiter", value: `agree <= ${r.jupiter.agreePct}%, watch <= ${r.jupiter.divergePct}%`, text: "pool price vs Jupiter; ENTER needs agree or watch; failed, skipped or diverged blocks" },
    { path: "enter.requireSellsObserved", value: "yes", text: "at least one sell observed in the last hour; missing sell counts block (honeypot check)" },
    { path: "enter.requireTop10Read", value: "yes", text: "top-10 holder share read on-chain; unread blocks (retried every 30 min)" },
    { path: "enter.requireDeskRiskOn", value: "yes", text: "desk risk on; off or unknown blocks" },
    { path: "deskRisk.offBelowPct", value: `${r.deskRisk.offBelowPct}%`, text: "BTC vs its Kraken 24 h VWAP; stale or unread majors are unknown (fails closed)" },
    { path: "watch.minScore", value: String(r.watch.minScore), text: "score floor to list a forming setup" },
    { path: "mcapCeiling.watchMinScore", value: String(r.mcapCeiling.watchMinScore), text: "above the entry ceiling: retrace WATCH from this score, else PASS" },
    { path: "flags", value: `sniper < ${r.flags.sniperZoneMinutes} min; dead pool < $${r.flags.deadPoolMinVolume24hUsd} after ${r.flags.deadPoolMinAgeMinutes} min; top-10 > ${r.flags.top10MaxPct}%; LP lock < ${r.flags.lpLockMinPct}%; liq > ${r.flags.liqOverMcapMultiple}x mcap`, text: "flags move the structure score; none is a kill on its own" },
    { path: "security.retryMinutes", value: `${r.security.retryMinutes} min`, text: "authorities re-read while active; unread top-10 retried" },
    { path: "cost", value: `${r.cost.dexFeePct}% + ${r.cost.platformFeePct}% per leg, $${r.cost.priorityFeeUsd} priority per leg`, text: "every net-of-cost figure and expectancy label uses these with constant-product impact at the pool's depth" },
    { path: "sizing", value: `${pct(r.sizing.poolShare)} of pool, max ${usd(r.sizing.maxPositionUsd)}`, text: "position sized by the exit, never by conviction; the desk places no orders" },
    { path: "grading.horizonHours", value: `${r.grading.horizonHours} h`, text: "grading horizon; the hold rule exits at this mark" },
    { path: "grading.rugged", value: `liq < ${pct(r.grading.ruggedLiquidityShare)} or cap < ${pct(r.grading.ruggedMcapShare)} of entry`, text: "RUGGED classification" },
    { path: "grading.minSample", value: `${r.grading.minSample} first-signals, no-data share <= ${pct(r.grading.maxNoDataShare)}`, text: "below this the expectancy card reads INSUFFICIENT DATA; passing a test is not a forecast" },
    { path: "grading.sizeUsd", value: usd(r.grading.sizeUsd), text: "expectancy quoted per position, net of pool fees and impact on both legs" },
  ];
}
