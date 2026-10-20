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
//   peak     sell at the sampled peak. Not achievable (the peak is known
//            only afterwards and spikes between samples are missed), shown
//            as the ceiling the graded rule is measured against. Priced at
//            the entry pool's depth because peak liquidity is not recorded.
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

export type ExitRule = "graded" | "peak";

export interface GradedSignalLike {
  outcome: string | null | undefined;
  mcapAtSignal: number | null | undefined;
  liquidityAtSignal: number | null | undefined;
  peakMcap: number | null | undefined;
  lastMcap: number | null | undefined;
  lastLiquidity: number | null | undefined;
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
  const exitMcap = rule === "peak" ? fin(row.peakMcap) : fin(row.lastMcap);
  const exitLiq = rule === "peak" ? entryLiq : fin(row.lastLiquidity);
  if (outcome === "RUGGED" && (exitLiq == null || exitLiq <= 0 || exitMcap == null)) {
    return { ...base, grossMultiple: exitMcap != null ? exitMcap / entryMcap : null, netPct: -100 };
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
  note: string;
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
    : "sell at the sampled peak (a ceiling, not an achievable exit)";
  const costText = rule === "graded"
    ? "net of pool fees and impact on both legs at the liquidity that existed at each"
    : "net of pool fees and impact on both legs, the exit priced at the entry pool's depth (peak liquidity is not recorded; the ceiling is understated when depth grew with price)";
  return {
    rule, sizeUsd, n, skipped, skippedReasons,
    medianNetPct: median(nets) == null ? null : Math.round(median(nets)! * 10) / 10,
    meanNetPct: mean == null ? null : Math.round(mean * 10) / 10,
    positiveShare: { yes, of: n, lo: w ? Math.round(w.lo * 1000) / 10 : null, hi: w ? Math.round(w.hi * 1000) / 10 : null },
    worstNetPct: n ? Math.min(...nets) : null,
    bestNetPct: n ? Math.max(...nets) : null,
    sampleReady: ready,
    minSample,
    note: `${ruleText}; $${sizeUsd} per signal, ${costText}; ` +
      (ready ? `${n} signals: what happened, not a forecast` : `${n} of a ${minSample}-signal minimum: counts only, no claim of edge`),
  };
}
