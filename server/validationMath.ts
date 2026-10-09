// server/validationMath.ts
//
// Pure math for the validation ledgers, sizing evidence and forecast-coverage
// checks. No DB, network or framework imports (only the pure exchangeCalendar),
// so tests/quant/validation*.test.ts can load it on plain Node. DB-facing modules (odteGrader, outcomeLogger,
// whaleBacktest, positionSizer, mlDataLog) call into these helpers.
//
// Units convention used throughout this file:
//   - option prices (bid, ask, mark, entry, exit) are $ PER SHARE, as quoted;
//   - "per contract" dollars = per-share price x contract multiplier (100 for
//     SPX/SPXW/XSP/SPY/QQQ and US single-name equity options);
//   - returns are fractions of the premium paid (0.30 = +30%).
//
// References (recorded next to each function):
//   Wilson (1927) JASA 22:209-212; Brown, Cai & DasGupta (2001) "Interval
//     Estimation for a Binomial Proportion", Statistical Science 16(2):101-133
//     (abstract: "we recommend the Wilson interval or the equal-tailed Jeffreys
//     prior interval for small n") https://repository.upenn.edu/handle/20.500.14332/47517
//   Kelly (1956) Bell System Technical Journal 35(4):917-926; Thorp (2006)
//     "The Kelly Criterion in Blackjack, Sports Betting and the Stock Market",
//     https://www.gwern.net/doc/statistics/decision/2006-thorp.pdf
//     (f* = m/(ab) with m = bp - aq; half Kelly keeps 3/4 of the growth rate;
//     overbetting is penalised far more than underbetting; assume the true
//     edge is smaller than the estimate).
//   Gneiting & Raftery (2007) "Strictly Proper Scoring Rules, Prediction, and
//     Estimation", JASA 102:359-378, sec. 6.2 interval score
//     https://apps.dtic.mil/sti/pdfs/ADA459827.pdf
//   Kupiec (1995) J. Derivatives 3(2):73-84; Christoffersen (1998)
//     "Evaluating Interval Forecasts", International Economic Review 39(4)
//     https://ideas.repec.org/a/ier/iecrev/v39y1998i4p841-62.html
//   Hull, "Options, Futures, and Other Derivatives", ch. 10: payoff of a long
//     call at expiry is max(S_T - K, 0), of a long put max(K - S_T, 0).
//   Cboe SPXW (Weeklys) specification: PM-settled, cash-settled, $100 multiplier
//     https://cboe.com/tradable_products/sp_500/spx_weekly_options/specifications/

import { sessionCloseMinutes } from "./exchangeCalendar";

// ─── Time (America/New_York) ────────────────────────────────────────────────

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
});

export interface EtParts { ymd: string; y: number; mo: number; d: number; h: number; mi: number; s: number }

export function etParts(ms: number): EtParts {
  const parts = ET_FMT.formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const y = g("year"), mo = g("month"), d = g("day");
  const h = g("hour") % 24, mi = g("minute"), s = g("second");
  const ymd = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { ymd, y, mo, d, h, mi, s };
}

/** ET calendar date (YYYY-MM-DD) of an epoch-ms instant. */
export function etDate(ms: number): string {
  return etParts(ms).ymd;
}

/**
 * Epoch ms of an America/New_York wall-clock time on a calendar date.
 * DST-correct (fixed-point on the zone offset): 16:00 ET is 20:00 UTC in
 * summer (EDT) and 21:00 UTC in winter (EST). The older code hard-coded
 * 20:00 UTC, which is 15:00 ET from November to March.
 */
export function etWallToUtcMs(ymd: string, hour: number, minute: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return NaN;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const target = Date.UTC(y, mo - 1, d, hour, minute, 0);
  let guess = target + 5 * 3600_000; // ET is UTC-5/-4: start near the answer
  for (let i = 0; i < 3; i++) {
    const p = etParts(guess);
    const wallAsUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    const diff = target - wallAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/**
 * Regular-session close on a calendar date from the exchange calendar:
 * 16:00 ET, or 13:00 ET on an early-close day (Cboe SPXW specification:
 * "Trading in SPXW options will ordinarily cease on the day of expiration,
 * 4:00 pm ET, and at 1:00 pm ET for any half day holiday",
 * https://www.cboe.com/tradable_products/sp_500/spx_options/specifications/).
 * The old 16:00 hard-code left half-day 0DTE and whale exits waiting for
 * bars and quotes that never come. A date the calendar marks closed (no
 * listed expiry should fall on one) keeps the 16:00 wall clock.
 */
export function etCloseMs(ymd: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    const m = sessionCloseMinutes(ymd);
    if (m != null) return etWallToUtcMs(ymd, Math.floor(m / 60), m % 60);
  }
  return etWallToUtcMs(ymd, 16, 0);
}

// ─── Binomial intervals ─────────────────────────────────────────────────────

/**
 * Wilson score interval for a binomial proportion (Wilson 1927). Brown, Cai &
 * DasGupta (2001) recommend it over the Wald interval for small n because its
 * coverage stays near nominal. z = 1.96 is the two-sided 95% interval.
 * n = 0 returns the vacuous interval [0, 1].
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): { lo: number; hi: number; center: number } {
  if (!(n > 0)) return { lo: 0, hi: 1, center: 0.5 };
  const k = Math.max(0, Math.min(n, successes));
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), center };
}

// ─── Kelly sizing ───────────────────────────────────────────────────────────

/**
 * Kelly fraction for a binary bet that wins +b or loses -L per unit staked:
 *   f* = p/L - q/b   (Thorp 2006 sec. 2: f* = m/(ab) with m = bp - aq, a = L).
 * Can be negative (no bet). Returns -Infinity on invalid b or L.
 */
export function kellyFraction(p: number, b: number, L: number): number {
  if (!(b > 0) || !(L > 0) || !Number.isFinite(p)) return -Infinity;
  const q = 1 - p;
  return p / L - q / b;
}

/**
 * Fires a grade bucket needs before the sizer may use the bucket's point win
 * rate instead of the Wilson lower bound. Worst case (p = 0.5) the 95% Wald
 * half-width is z*sqrt(p(1-p)/n); asking for <= 5 points gives
 * n >= 1.96^2 * 0.25 / 0.05^2 = 384.2, so 385. Below that the gap between the
 * point estimate and the lower bound is large enough that Kelly on the point
 * estimate overbets (Thorp 2006: overbetting is penalised far more than
 * underbetting; assume the true edge is smaller than the estimate). At 50 fires
 * the half-width is ~14 points, at 100 fires ~10.
 */
export const MIN_FIRES_FOR_POINT_ESTIMATE = 385;

/** Fractional-Kelly ceiling. Thorp 2006: half Kelly keeps ~3/4 of the growth rate with far less drawdown risk. */
export const MAX_KELLY_FRACTION = 0.5;
export const DEFAULT_KELLY_FRACTION = 0.25;

/** Grade buckets shared by the option-P&L ledger and the sizer (same cut points as gradeCalibration.ts). */
export const GRADE_BUCKETS: ReadonlyArray<{ lo: number; hi: number; label: string }> = [
  { lo: 72, hi: 79, label: "72-79" },
  { lo: 80, hi: 84, label: "80-84" },
  { lo: 85, hi: 89, label: "85-89" },
  { lo: 90, hi: 94, label: "90-94" },
  { lo: 95, hi: 100, label: "95-100" },
];

export function gradeBucketFor(score: number): { lo: number; hi: number; label: string } | null {
  // Scores are integers in the ledger; round so 79.6 lands in a bucket instead of falling between 79 and 80.
  const s = Math.round(score);
  return GRADE_BUCKETS.find((b) => s >= b.lo && s <= b.hi) ?? null;
}

/** One grade bucket of the realized option-P&L ledger. Returns are fractions of premium paid. */
export interface OptionLedgerBucket {
  label: string;
  n: number;                    // option-graded fires in the bucket
  wins: number;                 // realized option return > 0
  avgWinReturn: number | null;  // mean realized return of winners (> 0)
  avgLossReturn: number | null; // mean |realized return| of losers (> 0)
  /** Every realized return in the bucket (net of fees when built by netOptionReturn). Feeds log-optimal Kelly. */
  returns?: number[];
}

export interface KellyEvidence {
  p: number;
  pSource: "wilson_lower_bound" | "point_estimate";
  n: number;
  wins: number;
  wilsonLo: number;
  wilsonHi: number;
  b: number;
  bSource: "planned" | "realized_min_planned";
  L: number;
  LSource: "planned" | "realized_max_planned";
  fStar: number;          // full Kelly used (may be <= 0): min of binary Kelly and log-optimal Kelly when returns exist
  fBinary: number;        // p/L - q/b with p = Wilson lower bound
  fLogOptimal: number | null; // argmax mean log(1 + f r) on the realized returns; null without returns
  worstReturn: number | null; // most negative realized return in the bucket
  kellyFraction: number;  // applied fraction after the cap
  fApplied: number;       // max(0, kellyFraction * fStar): fraction of account staked as premium
  notes: string[];
}

/**
 * Kelly inputs from the realized option-P&L ledger (review items 6.2 / 7.2).
 *  - p: Wilson 95% lower bound of the bucket's realized win rate until the
 *    bucket has MIN_FIRES_FOR_POINT_ESTIMATE fires, the point rate after.
 *    No fires: p = 0, so Kelly sizes zero (no evidence of edge).
 *  - b: the smaller of the planned T1 payoff and the realized mean winner.
 *  - L: the larger of the planned stop loss and the realized mean loser
 *    (realized stop-outs slip past the planned stop, review item 6.6).
 *  - fractional Kelly in (0, MAX_KELLY_FRACTION]; a smaller requested
 *    fraction is honoured, never raised.
 */
export function kellyFromLedger(args: {
  bucket: OptionLedgerBucket | null;
  plannedB: number;
  plannedL: number;
  kellyFraction?: number;
}): KellyEvidence {
  const notes: string[] = [];
  const bucket = args.bucket ?? { label: "none", n: 0, wins: 0, avgWinReturn: null, avgLossReturn: null };
  const n = Math.max(0, Math.floor(bucket.n));
  const wins = Math.max(0, Math.min(n, Math.floor(bucket.wins)));
  const w = wilsonInterval(wins, n);
  let p: number;
  let pSource: KellyEvidence["pSource"];
  if (n >= MIN_FIRES_FOR_POINT_ESTIMATE) {
    p = wins / n;
    pSource = "point_estimate";
  } else {
    p = n > 0 ? w.lo : 0;
    pSource = "wilson_lower_bound";
    notes.push(n === 0
      ? "no option-graded fires in this grade bucket: p = 0, Kelly size 0 until the ledger has evidence"
      : `${n} option-graded fires (< ${MIN_FIRES_FOR_POINT_ESTIMATE}): p = Wilson 95% lower bound`);
  }
  let b = args.plannedB;
  let bSource: KellyEvidence["bSource"] = "planned";
  if (bucket.avgWinReturn != null && bucket.avgWinReturn > 0 && wins > 0) {
    b = Math.min(args.plannedB, bucket.avgWinReturn);
    bSource = "realized_min_planned";
  }
  let L = args.plannedL;
  let LSource: KellyEvidence["LSource"] = "planned";
  if (bucket.avgLossReturn != null && bucket.avgLossReturn > 0 && n - wins > 0) {
    L = Math.max(args.plannedL, Math.min(1, bucket.avgLossReturn));
    LSource = "realized_max_planned";
  }
  const requested = args.kellyFraction ?? DEFAULT_KELLY_FRACTION;
  const kf = Number.isFinite(requested) && requested > 0 ? Math.min(MAX_KELLY_FRACTION, requested) : 0;
  if (requested > MAX_KELLY_FRACTION) notes.push(`Kelly fraction capped at ${MAX_KELLY_FRACTION} (half Kelly)`);
  const fBinary = kellyFraction(p, b, L);
  // Log-optimal Kelly on the realized distribution (Kelly 1956; Thorp 2006
  // sec. 7: maximize E[log(1 + f X)]). It needs 1 + f * min(X) > 0, so it can
  // never stake more than 1/|worst loss|, which the two-point p/L - q/b
  // approximation ignores when the average loser is much smaller than the worst.
  const rets = (bucket.returns ?? []).filter((r) => Number.isFinite(r));
  const fLog = rets.length > 0 ? logOptimalKelly(rets) : null;
  const worst = rets.length > 0 ? Math.min(...rets) : null;
  let fStar = fBinary;
  if (fLog != null && Number.isFinite(fBinary) && fLog < fBinary) {
    fStar = fLog;
    notes.push(`log-optimal Kelly on ${rets.length} realized returns (worst ${(worst! * 100).toFixed(0)}%) is smaller than the two-point Kelly: using it`);
  }
  const fApplied = Number.isFinite(fStar) ? Math.max(0, kf * fStar) : 0;
  return { p, pSource, n, wins, wilsonLo: w.lo, wilsonHi: w.hi, b, bSource, L, LSource, fStar, fBinary, fLogOptimal: fLog, worstReturn: worst, kellyFraction: kf, fApplied, notes };
}

/**
 * Growth-optimal fraction for i.i.d. returns X (fraction of stake):
 * f* = argmax_f mean(log(1 + f X)) on [0, 1/|min X|). The objective is
 * concave, so its derivative g(f) = mean(X / (1 + f X)) is decreasing: solved
 * by bisection. 0 when mean(X) <= 0. Without any loss the bound is 1 (a long
 * option can lose at most its premium), so f* <= 1 always.
 */
export function logOptimalKelly(returns: number[]): number {
  const xs = returns.filter((r) => Number.isFinite(r));
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!(mean > 0)) return 0;
  const minX = Math.min(...xs);
  const hi0 = minX < 0 ? Math.min(1, 1 / -minX) : 1;
  const g = (f: number) => xs.reduce((a, x) => a + x / (1 + f * x), 0) / xs.length;
  let lo = 0, hi = hi0 * (1 - 1e-9);
  if (g(hi) >= 0) return hi;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Realized option return NET of fees, as a fraction of the premium paid:
 * (exit - entry) x mult - fees, over entry x mult. Fees are per contract per
 * side; a cash-settled hold or a worthless expiry pays the opening fee only.
 * The sizer's planned loss includes fees, so the ledger it compares with must too.
 *
 * `settled` may be the FRACTION of the position held to cash settlement (a
 * plan that sells half at T1 and lets the runner settle pays the closing fee
 * on half): fees = fee x (1 + (1 - settledFraction)) per contract, and `exit`
 * is the position's quantity-weighted average exit price.
 */
export function netOptionReturn(entry: number, exit: number, feePerContract: number, settled: boolean | number, multiplier = OPTION_MULTIPLIER): number | null {
  if (!(entry > 0) || !Number.isFinite(exit)) return null;
  if (typeof settled === "boolean") {
    const d = optionTradeDollars({ entry, exit, contracts: 1, multiplier, feePerContract, settled });
    return d.perContractNet / (toCents(entry * multiplier) / 100);
  }
  const s = Math.max(0, Math.min(1, Number.isFinite(settled) ? settled : 0));
  const fee = Math.max(0, feePerContract);
  const premium = toCents(entry * multiplier) / 100;
  const gross = (exit - entry) * multiplier;
  return (gross - fee * (2 - s)) / premium;
}

/** Summarize realized option returns into a ledger bucket. Wins are returns > 0. */
export function summarizeOptionReturns(label: string, returns: number[]): OptionLedgerBucket {
  const xs = returns.filter((r) => Number.isFinite(r));
  const winners = xs.filter((r) => r > 0);
  const losers = xs.filter((r) => r <= 0);
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const avgLoss = mean(losers.map((r) => -r));
  return {
    label,
    n: xs.length,
    wins: winners.length,
    avgWinReturn: mean(winners),
    avgLossReturn: avgLoss != null && avgLoss > 0 ? avgLoss : null,
    returns: xs,
  };
}

// ─── Option trade dollars ───────────────────────────────────────────────────

/** Standard equity/index option contract multiplier (shares or index $ per point). */
export const OPTION_MULTIPLIER = 100;

/**
 * $ -> integer cents, nearest cent, halves away from zero for either sign
 * (Math.round alone rounds -0.005 up to -0). Removes binary floating error
 * such as 0.30000000000000004.
 */
export function toCents(dollars: number): number {
  const c = Math.round(Math.abs(dollars) * 100 + 1e-9);
  return dollars < 0 ? -c : c;
}

/**
 * Dollar P&L of a long option round trip.
 *   entry, exit: $ per share; fee: $ per contract per side (commission plus
 *   exchange fees). A cash-settled option held to settlement pays no closing
 *   commission, so settled = true charges one side only.
 * All outputs are $ and exact to the cent (computed in integer cents).
 */
export function optionTradeDollars(args: {
  entry: number;
  exit: number;
  contracts: number;
  multiplier?: number;
  feePerContract?: number;
  settled?: boolean;
}): {
  perContractGross: number;  // (exit - entry) x multiplier, $ per contract
  perContractFees: number;   // fees per contract for the round trip
  perContractNet: number;    // gross - fees, $ per contract
  contracts: number;
  totalGross: number;
  totalFees: number;
  totalNet: number;          // $ for the whole position
} {
  const mult = args.multiplier ?? OPTION_MULTIPLIER;
  const n = Math.max(0, Math.floor(args.contracts));
  const fee = Math.max(0, args.feePerContract ?? 0);
  const grossC = toCents(args.exit * mult) - toCents(args.entry * mult);
  const feeC = toCents(fee) * (args.settled ? 1 : 2);
  const netC = grossC - feeC;
  return {
    perContractGross: grossC / 100,
    perContractFees: feeC / 100,
    perContractNet: netC / 100,
    contracts: n,
    totalGross: (grossC * n) / 100,
    totalFees: (feeC * n) / 100,
    totalNet: (netC * n) / 100,
  };
}

// ─── Option marks: 0DTE grading ─────────────────────────────────────────────

export interface OptionMark { ts: number; bid: number | null; ask: number | null; mid?: number | null }
export interface MinuteBar { datetime: number; open: number; high: number; low: number; close: number }

/**
 * The published 0DTE trade plan, replayed exactly (review item 7.1 of the
 * round-2 re-grade). The alert text (odteAlertEngine.formatOdteAlert) prints
 * these same rules; ODTE_PLAN_RULES is the one wording both use.
 *
 *  1. Entry: buy n contracts at the ask at the fire. A fire whose entry bid
 *     is already at or below entry x 0.80 is untradable (the stop would fire
 *     on the first quote): it is not graded as a trade, win or loss.
 *  2. Stop, whole position: the option bid at or below entry x (1 - 20%),
 *     before fees (what can actually be sold), OR a 5-minute candle closing beyond the
 *     stop level (CALL: close < stop; PUT: close > stop). 5-minute candles are
 *     clock-aligned from 09:30 ET; a candle's close is the close of its last
 *     1-minute bar, known when that minute ends.
 *  3. T1: on the first 1-minute bar whose high (CALL) / low (PUT) reaches T1,
 *     sell floor(n/2) of the n contracts when the alert has a T2 (all of
 *     them when n = 1 or there is no T2). Whole contracts only.
 *  4. Runner (the rest): keeps the stops of rule 2 until a 5-minute
 *     candle closes beyond T1 (CALL: close > T1); from then its level stop is
 *     the trail level (T1 - 3 for a CALL, T1 + 3 for a PUT). It is sold on the
 *     first bar that reaches T2 (counted from the bar after the T1 bar).
 *  5. Anything still open at the session close (16:00 ET, 13:00 ET on half
 *     days) cash-settles at intrinsic on the closing value (SPXW is PM- and
 *     cash-settled, Cboe SPXW specification).
 * Ordering when two rules trigger on the same 1-minute bar: the stop is
 * taken first (the bar's sequence is unknown; this is the pessimistic order),
 * and a runner's T2 is never credited on the bar that hit T1.
 *
 * Path-dependent exits evaluated in time order with the first barrier hit
 * deciding the outcome are the triple-barrier labelling of Lopez de Prado,
 * "Advances in Financial Machine Learning" (Wiley 2018), ch. 3 (Labeling),
 * https://www.wiley.com/en-us/Advances+in+Financial+Machine+Learning-p-9781119482086
 */
export const ODTE_PLAN_RULES = {
  version: "odte-plan-v2",
  optionStopPct: 0.20,
  /** Position size the ledger grades when no size is configured (the smallest that exercises the runner rule). */
  referenceContracts: 2,
  trailOffsetPts: 3,
  stopRule: "5-min candle close beyond the level (clock-aligned from 09:30 ET)",
  optionStopRule: "option bid at or below entry x 0.80, before fees",
  t1SaleRule: "sell floor(n/2) of n contracts at T1 (all when n = 1 or there is no T2)",
} as const;

/** Whole contracts sold at T1 (ODTE_PLAN_RULES.t1SaleRule). */
export function t1SaleContracts(n: number, hasT2: boolean): number {
  const k = Math.max(1, Math.floor(n));
  return hasT2 && k >= 2 ? Math.floor(k / 2) : k;
}

/** True when the entry quote already sits at or under the option stop: untradable, not a loss. */
export function untradableAtEntry(entryAsk: number | null, entryBid: number | null | undefined, optionStopPct: number = ODTE_PLAN_RULES.optionStopPct): boolean {
  if (entryAsk == null || !(entryAsk > 0) || entryBid == null || !Number.isFinite(entryBid)) return false;
  return entryBid <= entryAsk * (1 - optionStopPct) + 1e-12;
}

export type OdteExitReason = "t1_touch" | "t2_touch" | "underlying_stop" | "trail_stop" | "option_stop" | "settled_at_close";

export interface OdtePlanInput {
  isCall: boolean;
  entryTs: number;
  closeMs: number;
  t1: number;
  /** Level for the 5-minute-close stop (whole position before the runner arms). */
  stopLevel: number;
  /** Runner target. Null/absent (or not beyond T1) -> everything is sold at T1. */
  t2?: number | null;
  /** Runner level stop once a 5-minute close beyond T1 arms it; default T1 -/+ ODTE_PLAN_RULES.trailOffsetPts. */
  trailStopLevel?: number | null;
  /** Contracts in the position (whole number, default ODTE_PLAN_RULES.referenceContracts); sets the T1 split. */
  contracts?: number;
  /** Spot at the fire, the reference for the favorable excursion (default: open of the first bar after the fire). */
  spot0?: number | null;
}

/** One underlying-triggered exit of the plan: `time` = when it is known (bar close). */
export interface PlanLeg { kind: Exclude<OdteExitReason, "option_stop" | "settled_at_close">; time: number; fraction: number; underlyingPx: number }

export interface PlanReplay {
  status: "ok" | "no_bars" | "bar_gap" | "no_close_bar";
  gapAt: number | null;
  legs: PlanLeg[];
  /** Fraction still open at the session close (settles at intrinsic). */
  remaining: number;
  /** T1 reached before the whole position was stopped. */
  hitT1: boolean;
  /** Whole position stopped (5-min close) before T1. */
  stoppedBeforeT1: boolean;
  trailArmedAt: number | null;
  lastClose: number | null;
  /** Best favorable excursion (index points) on bars after the fire, up to the final exit. */
  mfePts: number;
  barsUsed: number;
}

const MIN = 60_000;
const isWindowEndBar = (barOpenMs: number) => (Math.floor(barOpenMs / MIN) + 1) % 5 === 0;

/**
 * Replay rules 2-5 of the plan on 1-minute index bars (bar `datetime` = bar
 * open). Bars must be contiguous from the fire to the final exit: one missing
 * minute could hide a touch or a 5-minute close, so a hole returns
 * "bar_gap" (never filled or interpolated). Bars that opened before the fire
 * are used only for a 5-minute close that ends after the fire (that close is
 * observable after the alert); their highs and lows are not (look-ahead).
 */
export function replayOdtePlan(plan: OdtePlanInput, allBars: MinuteBar[]): PlanReplay {
  const { isCall, entryTs, closeMs, t1, stopLevel } = plan;
  const hasT2 = plan.t2 != null && Number.isFinite(plan.t2) && plan.t2 > 0 && (isCall ? plan.t2 > t1 : plan.t2 < t1);
  const t2 = hasT2 ? (plan.t2 as number) : null;
  const n = Math.max(1, Math.floor(plan.contracts ?? ODTE_PLAN_RULES.referenceContracts));
  const partial = t1SaleContracts(n, hasT2) / n;
  const trail = plan.trailStopLevel != null && Number.isFinite(plan.trailStopLevel) && plan.trailStopLevel > 0
    ? plan.trailStopLevel
    : (isCall ? t1 - ODTE_PLAN_RULES.trailOffsetPts : t1 + ODTE_PLAN_RULES.trailOffsetPts);
  const out: PlanReplay = { status: "ok", gapAt: null, legs: [], remaining: 1, hitT1: false, stoppedBeforeT1: false, trailArmedAt: null, lastClose: null, mfePts: 0, barsUsed: 0 };

  // First bar that matters: the minute containing the fire if it closes a
  // 5-minute candle after the fire, else the first minute opening at/after it.
  let chainStart = Math.floor(entryTs / MIN) * MIN;
  if (chainStart < entryTs && !isWindowEndBar(chainStart)) chainStart += MIN;
  const byOpen = new Map<number, MinuteBar>();
  for (const b of allBars) {
    if (b.datetime >= chainStart && b.datetime < closeMs && [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v))) byOpen.set(b.datetime, b);
  }
  if (!Array.from(byOpen.keys()).some((t) => t >= entryTs)) return { ...out, status: "no_bars" };

  const spot0Ref = { v: NaN };
  let phase: "pre" | "runner" | "armed" = "pre";
  let remaining = 1;
  for (let t = chainStart; t < closeMs && remaining > 1e-12; t += MIN) {
    const b = byOpen.get(t);
    if (!b) return { ...out, status: "bar_gap", gapAt: t, legs: out.legs, remaining };
    out.barsUsed++;
    out.lastClose = b.close;
    const known = t + MIN;
    const touchBar = t >= entryTs;
    if (touchBar && !Number.isFinite(spot0Ref.v)) spot0Ref.v = plan.spot0 != null && plan.spot0 > 0 ? plan.spot0 : b.open;
    if (touchBar) {
      const fav = isCall ? b.high - spot0Ref.v : spot0Ref.v - b.low;
      if (fav > out.mfePts) out.mfePts = fav;
    }
    const windowEnd = isWindowEndBar(t);
    // Same-bar order (round 3): a touch is an intrabar event and the 5-minute
    // stop is judged on the bar's CLOSE, the last print of the minute, so in
    // a bar that both touches a target and closes a 5-minute candle beyond
    // the stop the touch happened first. (A) touches, then (B) the close
    // stop on whatever is still open, with the level in force at the close.
    // (A) touches, on bars that opened at or after the fire. Prices are
    // continuous: a call bar that reaches T2 from below T1 passed T1 first,
    // so both legs fill in that bar, T1 then T2.
    if (touchBar) {
      if (phase === "pre" && (isCall ? b.high >= t1 : b.low <= t1)) {
        out.legs.push({ kind: "t1_touch", time: known, fraction: partial, underlyingPx: t1 });
        remaining -= partial;
        out.hitT1 = true;
        phase = "runner";
        if (remaining > 1e-12 && t2 != null && (isCall ? b.high >= t2 : b.low <= t2)) {
          out.legs.push({ kind: "t2_touch", time: known, fraction: remaining, underlyingPx: t2 });
          remaining = 0;
          break;
        }
      } else if (phase !== "pre" && t2 != null && (isCall ? b.high >= t2 : b.low <= t2)) {
        out.legs.push({ kind: "t2_touch", time: known, fraction: remaining, underlyingPx: t2 });
        remaining = 0;
        break;
      }
    }
    if (remaining <= 1e-12) { remaining = 0; break; }
    // (B) 5-minute close stop on what is still open. The runner keeps the
    // original stop until a 5-minute close beyond T1 arms the trail (C).
    if (windowEnd) {
      const lvl = phase === "armed" ? trail : stopLevel;
      if (lvl > 0 && (isCall ? b.close < lvl : b.close > lvl)) {
        out.legs.push({ kind: phase === "armed" ? "trail_stop" : "underlying_stop", time: known, fraction: remaining, underlyingPx: b.close });
        if (phase === "pre") out.stoppedBeforeT1 = true;
        remaining = 0;
        break;
      }
    }
    // (C) arm the runner's trail on a 5-minute close beyond T1.
    if (windowEnd && phase === "runner" && (isCall ? b.close > t1 : b.close < t1)) {
      phase = "armed";
      out.trailArmedAt = known;
    }
  }
  out.remaining = Math.max(0, remaining);
  if (out.remaining > 0) {
    // Held to the close: the final minute (opening at close - 1 min) must exist.
    if (!byOpen.has(closeMs - MIN)) return { ...out, status: "no_close_bar" };
    out.lastClose = (byOpen.get(closeMs - MIN) as MinuteBar).close;
  }
  return out;
}

export interface OdteOptionFill { kind: OdteExitReason; fraction: number; price: number; ts: number; underlyingPx: number | null }

export interface OdteOptionGrade {
  status: "graded" | "ungraded";
  reason: OdteExitReason | "no_entry_quote" | "untradable_at_entry" | "no_exit_mark" | "no_close_bar" | "no_bars" | "no_marks_logged" | "mark_gap" | "bar_gap";
  entryPrice: number | null;       // $ per share, the ask at fire
  exitPrice: number | null;        // $ per share, quantity-weighted average of the fills
  exitTs: number | null;           // time of the last fill (or the close for a settled runner)
  realizedReturn: number | null;   // (exit - entry) / entry, before fees
  optionMfe: number | null;        // best bid-based return before the final exit (diagnostic only)
  underlyingAtExit: number | null;
  settled: boolean;                // true when the WHOLE position was held to cash settlement
  settledFraction: number;         // fraction of the position that cash-settled (no closing fee on it)
  fills: OdteOptionFill[];
  plan: PlanReplay | null;
}

/**
 * Realized 0DTE option P&L of the published plan on logged Schwab marks
 * (review items 7.2/7.3; round-2 item 7.1). Underlying-triggered exits come
 * from replayOdtePlan; each is filled at the bid of the first logged mark at
 * or after the moment it is known, within maxMarkLagMs. The -20% option stop
 * fires on the first logged mark whose BID is at or below entry x (1 -
 * optionStopPct) and sells everything still open at that bid. A runner still
 * open at the close settles at intrinsic on the official close.
 * Missing entry quote, no logged marks, a hole in the bars or a gap longer
 * than maxMarkGapMs in the marks between the fire and the final exit (an
 * option stop could have hit unseen), or no exit mark -> "ungraded", never
 * estimated.
 */
export function gradeOdteOptionPnl(input: {
  isCall: boolean;
  strike: number;
  entryAsk: number | null;
  entryTs: number;
  t1: number;
  stopLevel: number;
  optionStopPct: number;
  closeMs: number;
  bars: MinuteBar[];
  marks: OptionMark[];
  t2?: number | null;
  trailStopLevel?: number | null;
  contracts?: number;
  /** Bid at the fire: an entry bid at or under the option stop makes the fire untradable (ungraded, not a loss). */
  entryBid?: number | null;
  maxMarkLagMs?: number;
  maxMarkGapMs?: number;
  /** Official index close for the day (SPXW PM settlement value). Falls back to the last minute-bar close when absent. */
  settlementValue?: number | null;
}): OdteOptionGrade {
  const lag = input.maxMarkLagMs ?? 180_000;
  const maxGap = input.maxMarkGapMs ?? 300_000;
  const blank = (reason: OdteOptionGrade["reason"], plan: PlanReplay | null = null): OdteOptionGrade => ({
    status: "ungraded", reason, entryPrice: input.entryAsk ?? null, exitPrice: null, exitTs: null,
    realizedReturn: null, optionMfe: null, underlyingAtExit: null, settled: false, settledFraction: 0, fills: [], plan,
  });
  const entry = input.entryAsk;
  if (entry == null || !Number.isFinite(entry) || entry <= 0) return blank("no_entry_quote");
  // The stop would fire on the entry quote itself: the trade cannot be put on
  // under the plan. Not a loss, not in the ledger (the engine rejects these).
  if (untradableAtEntry(entry, input.entryBid, input.optionStopPct)) return blank("untradable_at_entry");
  const plan = replayOdtePlan({
    isCall: input.isCall, entryTs: input.entryTs, closeMs: input.closeMs, t1: input.t1, stopLevel: input.stopLevel,
    t2: input.t2, trailStopLevel: input.trailStopLevel, contracts: input.contracts,
  }, input.bars);
  if (plan.status !== "ok") return blank(plan.status, plan);
  const marks = input.marks
    .filter((m) => m.ts >= input.entryTs && m.ts <= input.closeMs)
    .sort((a, b) => a.ts - b.ts);
  if (marks.length === 0) return blank("no_marks_logged", plan);
  /** True when logged marks cover [entryTs, t] with no hole longer than maxGap. */
  const covered = (t: number): boolean => {
    let prev = input.entryTs;
    for (const m of marks) {
      if (m.ts > t) break;
      if (m.ts - prev > maxGap) return false;
      prev = m.ts;
    }
    return t - prev <= maxGap;
  };
  const stopPx = entry * (1 - input.optionStopPct);
  const optStop = input.optionStopPct > 0
    ? marks.find((m) => m.bid != null && Number.isFinite(m.bid) && m.bid >= 0 && m.bid <= stopPx + 1e-12) ?? null
    : null;

  const fills: OdteOptionFill[] = [];
  let open = 1;
  for (const leg of plan.legs) {
    // optStop is the FIRST mark at or under the stop price, so if it is not
    // before this leg it is after every fill so far.
    if (optStop && optStop.ts <= leg.time) break;
    const fill = marks.find((m) => m.ts >= leg.time && m.ts <= leg.time + lag && m.bid != null && m.bid >= 0);
    if (!fill) return blank("no_exit_mark", plan);
    // The option stop prints inside this leg's fill delay (at or before the
    // fill quote): the whole remainder goes out at the stop mark.
    if (optStop && optStop.ts <= fill.ts) break;
    const frac = Math.min(open, leg.fraction);
    fills.push({ kind: leg.kind, fraction: frac, price: fill.bid as number, ts: fill.ts, underlyingPx: leg.underlyingPx });
    open -= frac;
    if (open <= 1e-12) { open = 0; break; }
  }
  if (open > 0 && optStop) {
    // The option stop comes before the next underlying exit, or while the runner is held to the close.
    fills.push({ kind: "option_stop", fraction: open, price: optStop.bid as number, ts: optStop.ts, underlyingPx: null });
    open = 0;
  }
  let settledFraction = 0;
  if (open > 0) {
    const S = input.settlementValue != null && input.settlementValue > 0 ? input.settlementValue : (plan.lastClose as number);
    const intrinsic = input.isCall ? Math.max(0, S - input.strike) : Math.max(0, input.strike - S);
    fills.push({ kind: "settled_at_close", fraction: open, price: intrinsic, ts: input.closeMs, underlyingPx: S });
    settledFraction = open;
    open = 0;
  }
  const last = fills[fills.length - 1];
  if (!covered(last.kind === "settled_at_close" ? input.closeMs : last.ts)) return blank("mark_gap", plan);
  const exitAvg = fills.reduce((s, f) => s + f.fraction * f.price, 0);
  let mfe: number | null = null;
  for (const m of marks) {
    if (m.ts > last.ts) break;
    if (m.bid == null || !(m.bid >= 0)) continue;
    const r = (m.bid - entry) / entry;
    if (mfe == null || r > mfe) mfe = r;
  }
  const realized = (exitAvg - entry) / entry;
  return {
    status: "graded",
    reason: last.kind,
    entryPrice: entry,
    exitPrice: exitAvg,
    exitTs: last.ts,
    realizedReturn: realized,
    optionMfe: mfe == null ? realized : Math.max(mfe, realized),
    underlyingAtExit: last.underlyingPx,
    settled: settledFraction >= 1 - 1e-12,
    settledFraction,
    fills,
    plan,
  };
}

/**
 * Underlying close-out of the replayed plan, % of spot at the fire, signed in
 * the trade's direction: each leg at its level (T1/T2) or 5-minute close
 * (stops), the rest at the session's last close. Statistics use this; the
 * best favorable excursion stays a diagnostic (review item 7.3).
 */
export function planUnderlyingCloseOutPct(isCall: boolean, spot0: number, plan: PlanReplay): number {
  if (!(spot0 > 0)) return NaN;
  let pct = 0;
  for (const leg of plan.legs) pct += leg.fraction * underlyingCloseOutPct(isCall, spot0, leg.underlyingPx);
  if (plan.remaining > 0) {
    if (plan.lastClose == null) return NaN;
    pct += plan.remaining * underlyingCloseOutPct(isCall, spot0, plan.lastClose);
  }
  return pct;
}

// ─── Streamed option marks (round 3, Sector 7) ──────────────────────────────

/** Heartbeat: an unchanged streamed quote is still re-logged this often, so a quiet but live contract shows no mark gap. */
export const STREAM_MARK_HEARTBEAT_MS = 5_000;

/**
 * Normalize one Schwab LEVELONE_OPTIONS update into a loggable mark, or null.
 * A delayed quote is never logged as a mark (Schwab-only, real-time rule);
 * a negative bid or a non-positive ask is not a quote. ts = Schwab quote
 * time when present and not in the future (5 s clock slack), else the
 * receive time. Every update that changes the bid or the ask is logged (the
 * mark path is piecewise constant between changes, so this is lossless);
 * an unchanged quote is re-logged after STREAM_MARK_HEARTBEAT_MS.
 */
export function streamMarkToLog(
  prev: { ts: number; bid: number | null; ask: number | null } | undefined,
  q: { bid: number | null; ask: number | null; quoteTimeMs: number | null; delayed: boolean | null; receivedAtMs: number },
  heartbeatMs = STREAM_MARK_HEARTBEAT_MS,
): { ts: number; bid: number | null; ask: number | null; mid: number | null } | null {
  if (q.delayed === true) return null;
  const bid = q.bid != null && Number.isFinite(q.bid) && q.bid >= 0 ? q.bid : null;
  const ask = q.ask != null && Number.isFinite(q.ask) && q.ask > 0 ? q.ask : null;
  if (bid == null && ask == null) return null;
  const ts = q.quoteTimeMs != null && q.quoteTimeMs > 0 && q.quoteTimeMs <= q.receivedAtMs + 5_000 ? q.quoteTimeMs : q.receivedAtMs;
  if (prev) {
    const same = prev.bid === bid && prev.ask === ask;
    if (ts <= prev.ts) return null;
    if (same && ts - prev.ts < heartbeatMs) return null;
  }
  const mid = bid != null && ask != null && ask >= bid ? (bid + ask) / 2 : null;
  return { ts, bid, ask, mid };
}

// ─── Persisted minute bars (review item 7.7) ────────────────────────────────

/**
 * SELECT for the persisted Schwab $SPX 1-minute bars in spx_minute_bars,
 * given that table's column names (PRAGMA table_info). Two writers create
 * the table with different columns (mlDataLog: t/open/high/low/close;
 * hazardEngine: ts/o/h/l/c) and whichever runs first owns the schema, so the
 * reader adapts. Both key the bar by its open, epoch ms. Two parameters:
 * [fromMs, toMs). Null when the table is missing or has neither layout.
 */
export function savedMinuteBarsSql(columns: string[]): string | null {
  const has = (c: string) => columns.includes(c);
  if (has("t") && has("open") && has("high") && has("low") && has("close")) {
    // source (when present) says how the bar was built: 'schwab' = Schwab
    // REST candle, 'schwab_stream_chart' = Streamer CHART_EQUITY bar,
    // 'schwab_stream_l1' = aggregated from streamed LEVELONE last prices.
    return `SELECT t AS datetime, open, high, low, close${has("source") ? ", source" : ""} FROM spx_minute_bars WHERE t >= ? AND t < ? ORDER BY t ASC`;
  }
  if (has("ts") && has("o") && has("h") && has("l") && has("c")) {
    return `SELECT ts AS datetime, o AS open, h AS high, l AS low, c AS close FROM spx_minute_bars WHERE ts >= ? AND ts < ? ORDER BY ts ASC`;
  }
  return null;
}

/** Merge persisted and live bars by bar open; live wins on a duplicate. Sorted by time. */
export function mergeMinuteBars(saved: MinuteBar[], live: MinuteBar[]): MinuteBar[] {
  const byT = new Map<number, MinuteBar>();
  for (const b of saved) byT.set(b.datetime, b);
  for (const b of live) byT.set(b.datetime, b);
  return Array.from(byT.values()).sort((a, b) => a.datetime - b.datetime);
}

/** Minute-bar provenance counts of the bars a grade actually used. */
export interface BarsProvenance {
  /** Schwab REST price-history candles fetched at grading time */
  schwabRestLive: number;
  /** persisted Schwab REST candles */
  savedSchwabRest: number;
  /** persisted Streamer CHART_EQUITY bars */
  savedStreamChart: number;
  /** persisted bars aggregated from streamed LEVELONE last prices (not Schwab's own candles) */
  savedStreamLastPrice: number;
  /** persisted bars with no recorded source (older hazardEngine layout) */
  savedUnknown: number;
}

/**
 * Count the merged bars by origin (live wins on a duplicate, as in
 * mergeMinuteBars) and say in words when any came from stream last prices:
 * those bars' highs and lows are the extremes of the prints the streamer
 * delivered, which can miss an intrabar extreme a full candle would show.
 */
export function minuteBarsProvenance(
  saved: Array<MinuteBar & { source?: string | null }>,
  live: MinuteBar[],
): { counts: BarsProvenance; fromStreamLastPrices: boolean; label: string } {
  const liveT = new Set(live.map((b) => b.datetime));
  const counts: BarsProvenance = { schwabRestLive: liveT.size, savedSchwabRest: 0, savedStreamChart: 0, savedStreamLastPrice: 0, savedUnknown: 0 };
  const seen = new Set<number>();
  for (const b of saved) {
    if (liveT.has(b.datetime) || seen.has(b.datetime)) continue;
    seen.add(b.datetime);
    const src = b.source ?? null;
    if (src === "schwab") counts.savedSchwabRest++;
    else if (src === "schwab_stream_chart") counts.savedStreamChart++;
    else if (src === "schwab_stream_l1") counts.savedStreamLastPrice++;
    else counts.savedUnknown++;
  }
  const parts: string[] = [];
  if (counts.schwabRestLive) parts.push(`${counts.schwabRestLive} Schwab REST`);
  if (counts.savedSchwabRest) parts.push(`${counts.savedSchwabRest} saved Schwab REST`);
  if (counts.savedStreamChart) parts.push(`${counts.savedStreamChart} saved Schwab stream CHART_EQUITY`);
  if (counts.savedStreamLastPrice) parts.push(`${counts.savedStreamLastPrice} built from Schwab stream last prices (highs/lows are the delivered prints)`);
  if (counts.savedUnknown) parts.push(`${counts.savedUnknown} saved, source not recorded`);
  return { counts, fromStreamLastPrices: counts.savedStreamLastPrice > 0, label: parts.length ? `minute bars: ${parts.join(", ")}` : "minute bars: none" };
}

// ─── Grade labels vs the realized ledger (review item 7.6) ──────────────────

/**
 * A grade letter is a hand-weighted heuristic score until its bucket of the
 * realized option ledger is large enough that the sizer uses the bucket's
 * point win rate (MIN_FIRES_FOR_POINT_ESTIMATE, the same evidence bar).
 */
export function gradeLabelStatus(n: number): "heuristic" | "ledger_backed" {
  return n >= MIN_FIRES_FOR_POINT_ESTIMATE ? "ledger_backed" : "heuristic";
}

/** Evidence a grade is printed with: the ledger bucket plus what its returns are net of and which position size they grade. */
export interface GradeEvidence {
  label: string;
  n: number;
  wins: number;
  /** e.g. "net of $0.95/contract/side" or "gross of fees (no index fee configured)" */
  feeNote?: string;
  /** e.g. "2-contract plan (reference size)" */
  positionNote?: string;
}

/** One-line evidence text for a grade bucket: realized option hit rate, Wilson 95% interval and n. */
export function gradeEvidenceLine(bucket: GradeEvidence | null): string {
  if (!bucket) return "no ledger bucket for this score: heuristic score only";
  const status = gradeLabelStatus(bucket.n);
  const tag = status === "heuristic" ? `heuristic score (ledger-backed at ${MIN_FIRES_FOR_POINT_ESTIMATE} fires)` : "ledger-backed";
  const basis = [bucket.positionNote, bucket.feeNote].filter(Boolean).join(", ");
  const basisTxt = basis ? ` [${basis}]` : "";
  if (!(bucket.n > 0)) return `ledger ${bucket.label}: no option-graded fires yet, ${tag}${basisTxt}`;
  const w = wilsonInterval(bucket.wins, bucket.n);
  const pc = (x: number) => `${Math.round(x * 100)}%`;
  return `ledger ${bucket.label}: ${bucket.wins}/${bucket.n} option wins = ${pc(bucket.wins / bucket.n)} (95% CI ${pc(w.lo)}-${pc(w.hi)}), ${tag}${basisTxt}`;
}

/**
 * Realized underlying close-out return (directional, in %) for the
 * first-touch plan: exit at T1 on a T1 touch, at the stop on a stop touch,
 * else at the last close. Review item 7.3: statistics use this, MFE stays a
 * diagnostic.
 */
export function underlyingCloseOutPct(isCall: boolean, spot0: number, exitUnderlying: number): number {
  if (!(spot0 > 0) || !Number.isFinite(exitUnderlying)) return NaN;
  const mv = (exitUnderlying - spot0) / spot0;
  return (isCall ? mv : -mv) * 100;
}

// ─── Option marks: whale alerts ─────────────────────────────────────────────

export interface LoggedQuote { bid: number | null; ask: number | null; mark?: number | null; at: number }

/**
 * Accept a logged exit quote only if it was taken inside
 * [exitTimeMs - maxAgeMs, exitTimeMs] and carries a usable bid. Anything else
 * is "no mark" and the outcome stays ungraded (review item 8.2).
 */
export function acceptExitQuote(q: LoggedQuote | null | undefined, exitTimeMs: number, maxAgeMs: number): { ok: true; bid: number; at: number } | { ok: false; reason: string } {
  if (!q || !Number.isFinite(q.at)) return { ok: false, reason: "no_exit_quote_logged" };
  if (q.at > exitTimeMs) return { ok: false, reason: "quote_after_exit_time" };
  if (q.at < exitTimeMs - maxAgeMs) return { ok: false, reason: "exit_quote_stale" };
  if (q.bid == null || !Number.isFinite(q.bid) || q.bid < 0) return { ok: false, reason: "exit_quote_no_bid" };
  return { ok: true, bid: q.bid, at: q.at };
}

/** A logged entry quote is usable if the ask is positive and not below the bid. */
export function usableEntryAsk(q: { bid?: number | null; ask?: number | null } | null | undefined): number | null {
  if (!q || q.ask == null || !Number.isFinite(q.ask) || !(q.ask > 0)) return null;
  if (q.bid != null && Number.isFinite(q.bid) && q.bid > q.ask) return null; // crossed quote
  return q.ask;
}

/** Option return buying at the ask and selling at the bid (fraction of premium). */
export function askToBidReturn(entryAsk: number, exitBid: number): number {
  if (!(entryAsk > 0)) return NaN;
  return (exitBid - entryAsk) / entryAsk;
}

/**
 * Modeled exit for a long option held to expiration (review item 4.4).
 * At expiry the option is worth its intrinsic value on the closing value
 * (Hull ch. 10), so the whole time value paid at entry has decayed: this is
 * the exact theta over the hold, no IV model needed.
 *  - cash-settled (SPXW, XSP, PM-settled index): receive intrinsic exactly.
 *  - physically settled (equity, ETF): assume the holder sells in the last
 *    minutes at the bid, i.e. intrinsic minus half the quoted spread; the
 *    entry half-spread is the best available estimate. Floored at 0.
 * Out of the money: 0.
 */
export function modeledExpiryExit(args: {
  isCall: boolean;
  strike: number;
  underlyingClose: number;
  entryBid: number | null;
  entryAsk: number;
  cashSettled: boolean;
}): { exitPrice: number; intrinsic: number; halfSpread: number } {
  const intrinsic = args.isCall ? Math.max(0, args.underlyingClose - args.strike) : Math.max(0, args.strike - args.underlyingClose);
  const bid = args.entryBid != null && Number.isFinite(args.entryBid) && args.entryBid >= 0 ? args.entryBid : null;
  const halfSpread = bid != null ? Math.max(0, (args.entryAsk - bid) / 2) : 0;
  const exitPrice = intrinsic > 0 ? (args.cashSettled ? intrinsic : Math.max(0, intrinsic - halfSpread)) : 0;
  return { exitPrice, intrinsic, halfSpread };
}

/**
 * Settlement style from an OCC/Schwab option symbol root. Index roots that
 * cash-settle on the PM closing value: SPXW, XSP, NDXP, RUTW. The standard
 * monthly SPX root (AM, SOQ settlement) and VIX are flagged "am_settled":
 * the daily close is NOT their settlement value.
 */
export function settlementStyle(occOrRoot: string): "cash_pm" | "am_settled" | "physical" {
  const root = String(occOrRoot ?? "").trim().replace(/^[.$]/, "").split(/[\s_\d]/)[0].toUpperCase();
  if (["SPXW", "XSP", "NDXP", "RUTW", "MRUT"].includes(root)) return "cash_pm";
  if (["SPX", "NDX", "RUT", "VIX", "DJX"].includes(root)) return "am_settled";
  return "physical";
}

export interface WhaleTradeEval {
  reason: "ok_logged_mark" | "ok_modeled_expiry" | "no_entry_quote" | "no_exit" | "am_settled_no_settlement_value";
  entryAsk: number | null;        // $ per share paid
  exitPrice: number | null;       // $ per share received
  exitSource: "logged_bid" | "expiry_intrinsic_cash" | "expiry_intrinsic_less_half_spread" | null;
  pctReturn: number | null;       // (exit - entry) / entry, before fees
  contracts: number;              // whole contracts the notional buys (premium + opening fee)
  pnlPerContract: number | null;  // $ per contract after round-trip fees
  dollarPnl: number | null;       // contracts x pnlPerContract
  feesDollars: number;
}

/**
 * Option P&L of one whale alert held to expiry (review items 4.4 / 8.2):
 * buy at the logged ask at detection; exit at the logged bid at the expiry
 * close when one was logged, else at the modeled expiry value (intrinsic on
 * the expiry-day close; minus half the entry spread when physically settled).
 * No logged entry ask -> not traded (no leverage proxy). AM-settled index
 * roots (SPX monthly, settled on the opening print) are not modeled from the
 * daily close. `notional` is the $ budget per trade; contracts round down.
 */
export function evaluateWhaleTrade(args: {
  isCall: boolean;
  strike: number;
  occ: string;
  entryBid: number | null;
  entryAsk: number | null;
  loggedExitBid: number | null;
  underlyingCloseAtExpiry: number | null;
  notional: number;
  feePerContract: number;
  multiplier?: number;
}): WhaleTradeEval {
  const mult = args.multiplier ?? OPTION_MULTIPLIER;
  const ask = usableEntryAsk({ bid: args.entryBid, ask: args.entryAsk });
  const base: WhaleTradeEval = { reason: "no_entry_quote", entryAsk: ask, exitPrice: null, exitSource: null, pctReturn: null, contracts: 0, pnlPerContract: null, dollarPnl: null, feesDollars: 0 };
  if (ask == null) return base;
  let exit: number | null = null;
  let exitSource: WhaleTradeEval["exitSource"] = null;
  let reason: WhaleTradeEval["reason"] = "no_exit";
  let settled = false;
  if (args.loggedExitBid != null && Number.isFinite(args.loggedExitBid) && args.loggedExitBid >= 0) {
    exit = args.loggedExitBid; exitSource = "logged_bid"; reason = "ok_logged_mark";
  } else if (args.underlyingCloseAtExpiry != null && args.underlyingCloseAtExpiry > 0) {
    const style = settlementStyle(args.occ);
    if (style === "am_settled") return { ...base, reason: "am_settled_no_settlement_value" };
    const m = modeledExpiryExit({ isCall: args.isCall, strike: args.strike, underlyingClose: args.underlyingCloseAtExpiry, entryBid: args.entryBid, entryAsk: ask, cashSettled: style === "cash_pm" });
    exit = m.exitPrice;
    exitSource = style === "cash_pm" ? "expiry_intrinsic_cash" : "expiry_intrinsic_less_half_spread";
    reason = "ok_modeled_expiry";
    settled = style === "cash_pm" || m.exitPrice === 0; // settled or expired worthless: no closing trade
  }
  if (exit == null) return { ...base, reason: "no_exit" };
  const fee = Math.max(0, args.feePerContract);
  const costC = toCents(ask * mult) + toCents(fee);
  const contracts = costC > 0 ? Math.floor(toCents(Math.max(0, args.notional)) / costC) : 0;
  const d = optionTradeDollars({ entry: ask, exit, contracts, multiplier: mult, feePerContract: fee, settled });
  return {
    reason, entryAsk: ask, exitPrice: exit, exitSource,
    pctReturn: (exit - ask) / ask,
    contracts,
    pnlPerContract: d.perContractNet,
    dollarPnl: d.totalNet,
    feesDollars: d.totalFees,
  };
}

// ─── Prediction-outcome provenance (whale alerts) ───────────────────────────

/** Method tag on whale outcomes graded from real option marks (outcomeLogger). */
export const WHALE_MARKS_METHOD = "option_marks_v1";

/**
 * SQL condition (no parameters) that keeps regime calls and only those whale
 * outcomes graded on option marks. Older whale rows were graded by an
 * underlying-move x leverage proxy; they stay stored untouched and are
 * excluded at query time. outcome_json is written with JSON.stringify, so the
 * tag appears exactly as "method":"option_marks_v1".
 */
export const OUTCOME_ON_OPTION_MARKS_SQL =
  `(kind != 'whale_alert' OR outcome_json LIKE '%"method":"${WHALE_MARKS_METHOD}"%')`;

/** Same rule for a row already loaded (camelCase or snake_case outcome JSON). */
export function isOutcomeOnOptionMarks(row: { kind?: string | null; outcomeJson?: string | null; outcome_json?: string | null }): boolean {
  if (row.kind != null && row.kind !== "whale_alert") return true;
  const raw = row.outcomeJson ?? row.outcome_json ?? "";
  try { return JSON.parse(raw || "{}")?.method === WHALE_MARKS_METHOD; } catch { return false; }
}

// ─── Per-trade Sharpe / Sortino ─────────────────────────────────────────────

/**
 * Annualized Sharpe ratio of per-period returns: mean/sd x sqrt(q), q = periods
 * per year (Lo 2002, "The Statistics of Sharpe Ratios", FAJ 58(4), IID case).
 * For a sparse signal the period is one TRADE, so q = trades per year, not
 * 252: multiplying per-trade Sharpe by sqrt(252) overstates it by
 * sqrt(252 / tradesPerYear). Null below 5 returns.
 */
export function annualizedSharpe(rets: number[], periodsPerYear: number): number | null {
  const xs = rets.filter((r) => Number.isFinite(r));
  if (xs.length < 5 || !(periodsPerYear > 0)) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  const sd = Math.sqrt(v);
  return sd > 0 ? (m / sd) * Math.sqrt(periodsPerYear) : null;
}

/**
 * Annualized Sortino ratio with target 0: mean / sqrt(mean(min(r, 0)^2)) x sqrt(q)
 * (Sortino & van der Meer 1991: downside deviation averages over ALL periods,
 * not only the losing ones). Null when there is no downside or below 5 returns.
 */
export function annualizedSortino(rets: number[], periodsPerYear: number): number | null {
  const xs = rets.filter((r) => Number.isFinite(r));
  if (xs.length < 5 || !(periodsPerYear > 0)) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const dd = Math.sqrt(xs.reduce((a, r) => a + Math.min(0, r) ** 2, 0) / xs.length);
  return dd > 0 ? (m / dd) * Math.sqrt(periodsPerYear) : null;
}

// ─── Historical chain levels (pluggable volatility-band backtest source) ────

/** One end-of-day chain. openInterest in contracts; gamma per share per $1 (vendor convention). */
export interface HistoricalChainSnapshot {
  date: string;
  spot: number;
  contracts: Array<{ strike: number; type: "C" | "P"; openInterest: number; gamma?: number | null }>;
}

/**
 * Max-pain strike: the settlement price that minimizes the total intrinsic
 * value paid to option holders, sum_calls OI*max(0, K* - K) + sum_puts OI*max(0, K - K*),
 * searched over listed strikes (the common definition). Null on an empty chain.
 */
export function maxPainStrike(contracts: HistoricalChainSnapshot["contracts"]): number | null {
  const strikes = Array.from(new Set(contracts.filter((c) => c.strike > 0).map((c) => c.strike))).sort((a, b) => a - b);
  if (strikes.length === 0) return null;
  let best: number | null = null, bestPay = Infinity;
  for (const k of strikes) {
    let pay = 0;
    for (const c of contracts) {
      const oi = Math.max(0, c.openInterest || 0);
      pay += c.type === "C" ? oi * Math.max(0, k - c.strike) : oi * Math.max(0, c.strike - k);
    }
    if (pay < bestPay - 1e-9) { bestPay = pay; best = k; }
  }
  return best;
}

/**
 * Chain-derived levels for the backtest: call wall = strike at or above spot
 * with the largest call gamma exposure (OI x gamma; OI alone when the vendor
 * gives no gamma), put wall = the same for puts at or below spot, max pain as
 * above. Levels the chain cannot define stay null and are not scored.
 */
export function levelsFromChainSnapshot(snap: HistoricalChainSnapshot): { callWall: number | null; putWall: number | null; maxPain: number | null; weighting: "oi_x_gamma" | "oi_only" } {
  // One weighting per snapshot: OI x gamma only when EVERY contract with open
  // interest carries a gamma; otherwise OI alone for all strikes. Mixing would
  // compare OI x gamma (~0.001-0.01 per share) with raw OI on other strikes.
  const withOi = snap.contracts.filter((c) => (c.openInterest || 0) > 0);
  const useGamma = withOi.length > 0 && withOi.every((c) => c.gamma != null && Number.isFinite(c.gamma) && c.gamma > 0);
  const weight = (c: HistoricalChainSnapshot["contracts"][number]) =>
    Math.max(0, c.openInterest || 0) * (useGamma ? (c.gamma as number) : 1);
  const pick = (type: "C" | "P", above: boolean): number | null => {
    const byStrike = new Map<number, number>();
    for (const c of snap.contracts) {
      if (c.type !== type || !(c.strike > 0)) continue;
      if (above ? c.strike < snap.spot : c.strike > snap.spot) continue;
      byStrike.set(c.strike, (byStrike.get(c.strike) ?? 0) + weight(c));
    }
    let best: number | null = null, w = 0;
    for (const [k, v] of Array.from(byStrike)) if (v > w) { w = v; best = k; }
    return best;
  };
  return { callWall: pick("C", true), putWall: pick("P", false), maxPain: maxPainStrike(snap.contracts), weighting: useGamma ? "oi_x_gamma" : "oi_only" };
}

// ─── Forecast interval coverage ─────────────────────────────────────────────

/** erfc via Numerical Recipes' Chebyshev fit (|rel err| < 1.2e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/**
 * Interval score of a central (1 - alpha) prediction interval [lo, hi] for
 * outcome x (Gneiting & Raftery 2007, sec. 6.2; negatively oriented, lower is
 * better): (hi - lo) + (2/alpha)(lo - x)1{x < lo} + (2/alpha)(x - hi)1{x > hi}.
 * The 10-90% band is alpha = 0.2.
 */
export function intervalScore(lo: number, hi: number, x: number, alpha: number): number {
  const l = Math.min(lo, hi), u = Math.max(lo, hi);
  let s = u - l;
  if (x < l) s += (2 / alpha) * (l - x);
  if (x > u) s += (2 / alpha) * (x - u);
  return s;
}

export interface CoverageScore {
  n: number;
  covered: number;
  rate: number | null;
  wilsonLo: number | null;
  wilsonHi: number | null;
  nominal: number;
  nominalInsideInterval: boolean | null;
  kupiecLR: number | null;   // unconditional-coverage likelihood ratio, chi2(1) under H0
  kupiecP: number | null;
  meanIntervalScore: number | null; // Gneiting-Raftery interval score, same units as the outcome
  belowLo: number;           // misses under the band
  aboveHi: number;           // misses over the band
  independenceLR: number | null; // Christoffersen (1998) LR_ind on the time-ordered miss sequence, chi2(1)
  independenceP: number | null;
}

/**
 * Score realized outcomes against their predicted [lo, hi] bands.
 * Coverage = fraction inside (inclusive); Wilson 95% interval on it; Kupiec
 * (1995) proportion-of-failures LR test of coverage == nominal (Christoffersen
 * 1998 calls it the unconditional-coverage test); mean interval score. The
 * binomial model assumes independent outcomes, which is why the logger keeps
 * one forecast per horizon per non-overlapping window.
 */
export function scoreIntervalCoverage(rows: Array<{ lo: number; hi: number; realized: number }>, nominal = 0.8): CoverageScore {
  const ok = rows.filter((r) => Number.isFinite(r.lo) && Number.isFinite(r.hi) && Number.isFinite(r.realized));
  const n = ok.length;
  let covered = 0, belowLo = 0, aboveHi = 0, isSum = 0;
  const alpha = 1 - nominal;
  for (const r of ok) {
    const l = Math.min(r.lo, r.hi), u = Math.max(r.lo, r.hi);
    if (r.realized < l) belowLo++;
    else if (r.realized > u) aboveHi++;
    else covered++;
    isSum += intervalScore(l, u, r.realized, alpha);
  }
  if (n === 0) {
    return { n: 0, covered: 0, rate: null, wilsonLo: null, wilsonHi: null, nominal, nominalInsideInterval: null, kupiecLR: null, kupiecP: null, meanIntervalScore: null, belowLo: 0, aboveHi: 0, independenceLR: null, independenceP: null };
  }
  const w = wilsonInterval(covered, n);
  const x = n - covered;          // misses
  const pi0 = 1 - nominal;        // expected miss rate
  const ll = (k: number, nn: number, pr: number) =>
    (nn - k > 0 ? (nn - k) * Math.log(1 - pr) : 0) + (k > 0 ? k * Math.log(pr) : 0);
  const pHat = x / n;
  const lr = -2 * (ll(x, n, pi0) - ll(x, n, pHat));
  const kupiecLR = Math.max(0, lr);
  const kupiecP = erfc(Math.sqrt(kupiecLR / 2)); // chi2(1) survival function
  // Rows are expected in time order (callers pass nonOverlappingForecasts output).
  const ind = christoffersenIndependence(ok.map((r) => r.realized < Math.min(r.lo, r.hi) || r.realized > Math.max(r.lo, r.hi)));
  return {
    n, covered, rate: covered / n,
    wilsonLo: w.lo, wilsonHi: w.hi, nominal,
    nominalInsideInterval: nominal >= w.lo && nominal <= w.hi,
    kupiecLR, kupiecP,
    meanIntervalScore: isSum / n,
    belowLo, aboveHi,
    independenceLR: ind?.lr ?? null,
    independenceP: ind?.p ?? null,
  };
}

/**
 * Christoffersen (1998) independence test for an interval forecast's hit
 * sequence (true = realized outside the band, a "violation"), in time order.
 * First-order Markov alternative: with n_ij = count of state i followed by j,
 *   pi01 = n01/(n00+n01), pi11 = n11/(n10+n11), pi = (n01+n11)/total,
 *   LR_ind = -2 ln[(1-pi)^(n00+n10) pi^(n01+n11)]
 *            + 2 ln[(1-pi01)^n00 pi01^n01 (1-pi11)^n10 pi11^n11]  ~ chi2(1).
 * Clustered misses (a model that is wrong for a whole regime) reject it even
 * when the unconditional rate is near nominal. Null below 2 transitions.
 */
export function christoffersenIndependence(violations: boolean[]): { lr: number; p: number; n00: number; n01: number; n10: number; n11: number } | null {
  let n00 = 0, n01 = 0, n10 = 0, n11 = 0;
  for (let i = 1; i < violations.length; i++) {
    const a = violations[i - 1] ? 1 : 0, b = violations[i] ? 1 : 0;
    if (a === 0 && b === 0) n00++; else if (a === 0) n01++; else if (b === 0) n10++; else n11++;
  }
  const total = n00 + n01 + n10 + n11;
  if (total < 2) return null;
  const xlogy = (k: number, q: number) => (k > 0 ? k * Math.log(q) : 0);
  const pi = (n01 + n11) / total;
  const pi01 = n00 + n01 > 0 ? n01 / (n00 + n01) : 0;
  const pi11 = n10 + n11 > 0 ? n11 / (n10 + n11) : 0;
  const l0 = xlogy(n00 + n10, 1 - pi) + xlogy(n01 + n11, pi);
  const l1 = xlogy(n00, 1 - pi01) + xlogy(n01, pi01) + xlogy(n10, 1 - pi11) + xlogy(n11, pi11);
  const lr = Math.max(0, -2 * (l0 - l1));
  return { lr, p: erfc(Math.sqrt(lr / 2)), n00, n01, n10, n11 };
}

/**
 * Index price at instant T from 1-minute bars (bar `datetime` = bar open):
 * the close of the latest bar that finished by T, if that bar is no older
 * than maxStaleMs. Null when the series has a gap (never a filled value).
 */
export function priceAtFromBars(bars: MinuteBar[], T: number, maxStaleMs = 180_000): number | null {
  let best: MinuteBar | null = null;
  for (const b of bars) {
    if (b.datetime + 60_000 <= T) { if (!best || b.datetime > best.datetime) best = b; }
  }
  if (!best) return null;
  if (T - (best.datetime + 60_000) > maxStaleMs) return null;
  return best.close;
}

/** Forward simple return over h minutes from 1-minute bars; null on gaps. */
export function forwardReturnFromBars(bars: MinuteBar[], t: number, hMinutes: number): number | null {
  const p0 = priceAtFromBars(bars, t);
  const p1 = priceAtFromBars(bars, t + hMinutes * 60_000);
  if (p0 == null || p1 == null || !(p0 > 0)) return null;
  return p1 / p0 - 1;
}

/**
 * Pick forecasts for coverage scoring so that, per horizon, no two kept
 * forecasts have overlapping outcome windows [t, t + h]. Greedy in time order.
 * Overlapping windows share the same realized path, so counting them as
 * independent Bernoulli trials would overstate the evidence.
 */
export function nonOverlappingForecasts<T extends { ts: number; horizonMin: number }>(rows: T[]): T[] {
  const byH = new Map<number, T[]>();
  for (const r of rows) {
    if (!byH.has(r.horizonMin)) byH.set(r.horizonMin, []);
    byH.get(r.horizonMin)!.push(r);
  }
  const out: T[] = [];
  for (const [h, list] of Array.from(byH)) {
    list.sort((a, b) => a.ts - b.ts);
    let nextFree = -Infinity;
    for (const r of list) {
      if (r.ts >= nextFree) { out.push(r); nextFree = r.ts + h * 60_000; }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// ─── Whale re-fire snapshot ─────────────────────────────────────────────────

/**
 * One whale fire as a self-consistent triple: premium ($, cumulative day
 * premium = volume x mark x 100), volume (contracts, session cumulative) and
 * the implied mark ($ per share = premium / (volume x 100)). The follow-through
 * entry is the FIRST fire and is never rewritten (its mark is the P&L basis
 * and the DB row keeps it); later fires are recorded with this snapshot so
 * premium and volume always describe the same moment.
 */
export function whaleFireSnapshot(hit: { premium: number; volume: number; detectedAt: number }): { premium: number; volume: number; mark: number | null; at: number } {
  const volume = Number.isFinite(hit.volume) && hit.volume > 0 ? hit.volume : 0;
  const premium = Number.isFinite(hit.premium) && hit.premium > 0 ? hit.premium : 0;
  return { premium, volume, mark: volume > 0 ? premium / (volume * OPTION_MULTIPLIER) : null, at: hit.detectedAt };
}
