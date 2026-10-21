// shared/cryptoExpectancy.ts
//
// What a graded crypto signal would have returned to a holder who followed
// one stated rule, net of the cost of getting in and out of a thin pool.
// The desk's outcome labels (HIT_5M, DOUBLED, RUGGED, DEAD) say what the
// sampled market cap did; this says what a position did. Pure: the server
// feeds it rows from crypto_signals and the panel shows the result.
//
// Exit rules
//   graded   buy at the signal, sell when the grader closed the row:
//            HIT_5M rows at the first sample at or above the $5M target (a
//            limit-sell-at-target, not a hold), RUGGED rows at rug
//            detection, DOUBLED / DEAD rows at the 72 h horizon. last_mcap
//            and last_liquidity are the values the grader saw at that
//            moment. Replicable in the sense that each exit is a stated
//            rule applied to sampled data, not a top somebody called; it
//            is NOT a hold-to-horizon return, which would give part of a
//            HIT_5M row's gain back and is not recorded.
//   hold     buy at the signal, sell at the 72 h horizon mark (horizon_mcap /
//            horizon_liquidity, recorded once for every row that crosses the
//            horizon, whatever its outcome). The replicable rule; rows from
//            before the mark existed are skipped, never approximated.
//   peak     sell at the sampled peak. Not achievable (the peak is known
//            only afterwards and spikes between samples are missed), shown
//            as the ceiling the other rules are measured against. Priced at
//            the liquidity recorded at the peak, or the entry pool's depth
//            for rows older than that recording.
//
// Costs: the same constant-product mechanics as shared/memeStructure
// tradeCost, with the entry pool at the signal's liquidity and the exit
// pool at the liquidity that existed at the exit. A pulled pool (liquidity
// observed 0, or a RUGGED outcome with no exit liquidity) returns nothing.
// The market-cap multiple stands in for the price multiple; with an active
// mint authority supply can grow between the two marks, which overstates
// the price move.
//
// Aggregates are per-signal returns on a fixed notional (default $100),
// median and mean, the share of positive outcomes with a Wilson interval,
// and a gate: below the desk's minimum sample the numbers are counts, not
// a claim. None of this is a forecast; it is bookkeeping on what happened.

import { DEFAULT_DEX_FEE_PCT, DEFAULT_PLATFORM_FEE_PCT, DEFAULT_PRIORITY_USD } from "./memeStructure";

export type ExitRule = "graded" | "hold" | "peak";

export interface GradedSignalLike {
  outcome: string | null | undefined;
  mcapAtSignal: number | null | undefined;
  liquidityAtSignal: number | null | undefined;
  peakMcap: number | null | undefined;
  lastMcap: number | null | undefined;
  lastLiquidity: number | null | undefined;
  peakLiquidity?: number | null;
  horizonMcap?: number | null;
  horizonLiquidity?: number | null;
  /** Set once the horizon pass ran (mcap may still be null: tried and unavailable). */
  horizonAt?: number | null;
}

export interface LegCosts {
  dexFeePct?: number;
  platformFeePct?: number;
  priorityFeeUsd?: number;
}

export interface SignalReturn {
  rule: ExitRule;
  sizeUsd: number;
  /** Market-cap multiple at the exit (exit / entry); null when the exit value is unknown. */
  grossMultiple: number | null;
  /** Return on the notional after both legs' fees and impact, percent; -100 for a pulled pool. */
  netPct: number | null;
  /** Why netPct is null. */
  missing: string | null;
}

const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Net return of one position: size in at the entry pool, out at the exit
 * pool after the quote moved by `multiple`. Pure constant-product legs.
 */
export function legReturnPct(sizeUsd: number, entryLiqUsd: number, exitLiqUsd: number, multiple: number, costs: LegCosts = {}): number | null {
  const dexFee = Math.max(0, fin(costs.dexFeePct) ?? DEFAULT_DEX_FEE_PCT);
  const platFee = Math.max(0, fin(costs.platformFeePct) ?? DEFAULT_PLATFORM_FEE_PCT);
  const prio = Math.max(0, fin(costs.priorityFeeUsd) ?? DEFAULT_PRIORITY_USD);
  if (!(sizeUsd > 0) || !(entryLiqUsd > 0) || !(multiple >= 0)) return null;
  if (!Number.isFinite(exitLiqUsd)) return null;     // unknown exit depth is not a pulled pool
  const feeFrac = Math.min(1, (dexFee + platFee) / 100);
  const x = sizeUsd * (1 - feeFrac) - prio;
  if (!(x > 0)) return -100;
  const Q1 = entryLiqUsd / 2;
  const v0 = (Q1 * x) / (Q1 + x);          // token value at the entry quote
  if (!(exitLiqUsd > 0)) return -100;       // observed 0: nothing to sell into
  const Q2 = exitLiqUsd / 2;
  const v = v0 * multiple;                  // token value at the exit quote
  const proceeds = Math.max(0, ((Q2 * v) / (Q2 + v)) * (1 - feeFrac) - prio);
  return Math.max(-100, (100 * (proceeds - sizeUsd)) / sizeUsd);
}

/** One graded signal under one exit rule. OPEN rows are not returns yet. */
export function signalReturn(row: GradedSignalLike, rule: ExitRule, sizeUsd = 100, costs: LegCosts = {}): SignalReturn {
  const base: SignalReturn = { rule, sizeUsd, grossMultiple: null, netPct: null, missing: null };
  const outcome = String(row.outcome ?? "");
  if (outcome === "OPEN" || outcome === "") return { ...base, missing: "still open" };
  if (outcome === "NO_DATA") return { ...base, missing: "no price past the horizon" };
  const entryMcap = fin(row.mcapAtSignal), entryLiq = fin(row.liquidityAtSignal);
  if (entryMcap == null || !(entryMcap > 0)) return { ...base, missing: "no market cap at the signal" };
  if (entryLiq == null || !(entryLiq > 0)) return { ...base, missing: "no liquidity at the signal" };
  if (rule === "hold" && row.horizonAt == null) return { ...base, missing: "no horizon mark (row predates the horizon pass or has not reached it)" };
  const exitMcap = rule === "peak" ? fin(row.peakMcap) : rule === "hold" ? fin(row.horizonMcap) : fin(row.lastMcap);
  const exitLiq = rule === "peak" ? (fin(row.peakLiquidity) ?? entryLiq) : rule === "hold" ? fin(row.horizonLiquidity) : fin(row.lastLiquidity);
  if (outcome === "RUGGED" && rule !== "hold" && (exitLiq == null || exitLiq <= 0 || exitMcap == null)) {
    return { ...base, grossMultiple: exitMcap != null ? exitMcap / entryMcap : null, netPct: -100 };
  }
  if (rule === "hold" && exitMcap == null) {
    // The horizon pass ran and could not price the pool: a pulled pool is -100 only when liquidity was observed 0; otherwise unknown.
    if (exitLiq != null && exitLiq <= 0) return { ...base, grossMultiple: null, netPct: -100 };
    return { ...base, missing: "horizon mark unavailable (pool not priced at the horizon)" };
  }
  if (exitMcap == null) return { ...base, missing: rule === "peak" ? "no sampled peak" : "no market cap at the horizon" };
  if (exitLiq == null) return { ...base, grossMultiple: exitMcap / entryMcap, missing: "no liquidity at the horizon" };
  const multiple = exitMcap / entryMcap;
  const net = legReturnPct(sizeUsd, entryLiq, exitLiq, multiple, costs);
  return { ...base, grossMultiple: multiple, netPct: net == null ? null : Math.round(net * 10) / 10, missing: net == null ? "cost not computable" : null };
}

export interface ExpectancySummary {
  rule: ExitRule;
  sizeUsd: number;
  /** Graded signals with a computable net return. */
  n: number;
  /** Graded signals whose return could not be computed, with the reasons. */
  skipped: number;
  skippedReasons: Record<string, number>;
  medianNetPct: number | null;
  meanNetPct: number | null;
  /** Share of returns above zero, with a 95% Wilson interval. */
  positiveShare: { yes: number; of: number; lo: number | null; hi: number | null };
  worstNetPct: number | null;
  bestNetPct: number | null;
  /** Below the desk's minimum sample the numbers are counts, not a claim. */
  sampleReady: boolean;
  minSample: number;
  /** Four-way read of the sample against stated tests; never a forecast. */
  validation: ValidationLabel;
  note: string;
}

export type ValidationLabel = "PASSES PREDEFINED TESTS" | "MIXED RESULTS" | "NO DEMONSTRATED EDGE" | "INSUFFICIENT DATA";

/**
 * The tests: at least minSample graded returns; mean net > 0 and the share
 * positive's Wilson lower bound > 50% passes; mean net <= 0 or an upper
 * bound under 50% shows no edge; anything else is mixed. Passing a
 * historical test does not establish future profitability.
 */
export function validationLabel(n: number, minSample: number, meanNetPct: number | null, lo: number | null, hi: number | null): ValidationLabel {
  if (n < minSample || meanNetPct == null || lo == null || hi == null) return "INSUFFICIENT DATA";
  if (meanNetPct > 0 && lo > 50) return "PASSES PREDEFINED TESTS";
  if (meanNetPct <= 0 || hi < 50) return "NO DEMONSTRATED EDGE";
  return "MIXED RESULTS";
}

export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (!(n > 0)) return null;
  const p = k / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarizeExpectancy(rows: GradedSignalLike[], rule: ExitRule, opts: { sizeUsd?: number; minSample?: number; costs?: LegCosts } = {}): ExpectancySummary {
  const sizeUsd = opts.sizeUsd ?? 100;
  const minSample = opts.minSample ?? 50;
  const nets: number[] = [];
  const skippedReasons: Record<string, number> = {};
  let skipped = 0;
  for (const r of rows) {
    const out = String(r.outcome ?? "");
    if (out === "OPEN" || out === "") continue; // not graded: not in the denominator
    const s = signalReturn(r, rule, sizeUsd, opts.costs);
    if (s.netPct == null) { skipped++; const k = s.missing ?? "unknown"; skippedReasons[k] = (skippedReasons[k] ?? 0) + 1; continue; }
    nets.push(s.netPct);
  }
  const n = nets.length;
  const yes = nets.filter((x) => x > 0).length;
  const w = wilson(yes, n);
  const mean = n ? nets.reduce((a, b) => a + b, 0) / n : null;
  const ready = n >= minSample;
  const ruleText = rule === "graded"
    ? "buy at the signal, sell when the row was graded (HIT_5M at the first sample at or above the target, RUGGED at rug detection, otherwise at the horizon)"
    : rule === "hold"
      ? "buy at the signal, sell at the 72 h horizon mark whatever happened in between (the replicable rule)"
      : "sell at the sampled peak (a ceiling, not an achievable exit)";
  const costText = rule === "peak"
    ? "net of pool fees and impact on both legs, the exit priced at the liquidity recorded at the peak, or the entry pool's depth for rows older than that recording (the ceiling is understated when depth grew with price)"
    : "net of pool fees and impact on both legs at the liquidity that existed at each";
  const lo = w ? Math.round(w.lo * 1000) / 10 : null, hi = w ? Math.round(w.hi * 1000) / 10 : null;
  const meanR = mean == null ? null : Math.round(mean * 10) / 10;
  return {
    rule, sizeUsd, n, skipped, skippedReasons,
    medianNetPct: median(nets) == null ? null : Math.round(median(nets)! * 10) / 10,
    meanNetPct: meanR,
    positiveShare: { yes, of: n, lo, hi },
    worstNetPct: n ? Math.min(...nets) : null,
    bestNetPct: n ? Math.max(...nets) : null,
    sampleReady: ready,
    minSample,
    validation: validationLabel(n, minSample, meanR, lo, hi),
    note: `${ruleText}; $${sizeUsd} per signal, ${costText}; ` +
      (ready ? `${n} signals: what happened, not a forecast` : `${n} of a ${minSample}-signal minimum: counts only, no claim of edge`),
  };
}
