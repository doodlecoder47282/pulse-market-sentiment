// server/validationMath.ts
//
// Pure math for the validation ledgers, sizing evidence and forecast-coverage
// checks. No DB, network or framework imports, so tests/quant/validation.test.ts
// can load it on plain Node. DB-facing modules (odteGrader, outcomeLogger,
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

/** 16:00 ET regular close on a calendar date (half-days not modelled: callers treat missing bars as ungraded). */
export function etCloseMs(ymd: string): number {
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
  fStar: number;          // full Kelly (may be <= 0)
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
  const fStar = kellyFraction(p, b, L);
  const fApplied = Number.isFinite(fStar) ? Math.max(0, kf * fStar) : 0;
  return { p, pSource, n, wins, wilsonLo: w.lo, wilsonHi: w.hi, b, bSource, L, LSource, fStar, kellyFraction: kf, fApplied, notes };
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
  };
}

// ─── Option trade dollars ───────────────────────────────────────────────────

/** Standard equity/index option contract multiplier (shares or index $ per point). */
export const OPTION_MULTIPLIER = 100;

/** $ -> integer cents, rounding to the nearest cent (removes binary floating error such as 0.30000000000000004). */
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
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

export type OdteExitReason = "t1_touch" | "underlying_stop" | "option_stop" | "settled_at_close";

export interface OdteOptionGrade {
  status: "graded" | "ungraded";
  reason: OdteExitReason | "no_entry_quote" | "no_exit_mark" | "no_close_bar" | "no_bars" | "no_marks_logged" | "mark_gap";
  entryPrice: number | null;       // $ per share, the ask at fire
  exitPrice: number | null;        // $ per share, bid at exit or settlement value
  exitTs: number | null;
  realizedReturn: number | null;   // (exit - entry) / entry
  optionMfe: number | null;        // best bid-based return before exit (diagnostic only)
  underlyingAtExit: number | null;
  settled: boolean;                // true when held to cash settlement (no closing fee)
}

function markMid(m: OptionMark): number | null {
  if (m.mid != null && Number.isFinite(m.mid) && m.mid > 0) return m.mid;
  if (m.bid != null && m.ask != null && m.ask >= m.bid && m.ask > 0) return (m.bid + m.ask) / 2;
  return null;
}

/**
 * Realized 0DTE option P&L from logged option marks (review items 7.2/7.3).
 * Plan replayed: buy at the ask at fire; exit on the first of
 *   - option stop: a logged mark whose mid is <= entry * (1 - optionStopPct);
 *     filled at that quote's bid (the exit brain watches the mid; a market
 *     sell fills at the bid);
 *   - underlying stop or T1 first touch on 1-minute bars that open at or after
 *     the fire (same-bar tie = stop, conservative); known at the bar's close,
 *     filled at the bid of the first logged mark at or after that, within
 *     maxMarkLagMs;
 *   - no trigger: held to the close and cash-settled at intrinsic on the
 *     closing value (Cboe SPXW: PM-settled, cash-settled).
 * Missing entry quote, no logged marks, a gap longer than maxMarkGapMs in the
 * marks between fire and exit (an option stop could have hit unseen), or no
 * exit mark -> "ungraded", never estimated. Without the gap check, trades that
 * would have stopped out while the logger was down would grade as holds and
 * bias the ledger upward.
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
  maxMarkLagMs?: number;
  maxMarkGapMs?: number;
}): OdteOptionGrade {
  const lag = input.maxMarkLagMs ?? 180_000;
  const maxGap = input.maxMarkGapMs ?? 300_000;
  const blank = (reason: OdteOptionGrade["reason"]): OdteOptionGrade => ({
    status: "ungraded", reason, entryPrice: input.entryAsk ?? null, exitPrice: null, exitTs: null,
    realizedReturn: null, optionMfe: null, underlyingAtExit: null, settled: false,
  });
  const entry = input.entryAsk;
  if (entry == null || !Number.isFinite(entry) || entry <= 0) return blank("no_entry_quote");
  // Bars that OPEN at or after the fire: the fire-minute bar's high/low may
  // have printed before the alert existed (look-ahead), so it is excluded.
  const bars = input.bars
    .filter((b) => b.datetime >= input.entryTs && b.datetime < input.closeMs)
    .sort((a, b) => a.datetime - b.datetime);
  if (bars.length === 0) return blank("no_bars");
  const marks = input.marks
    .filter((m) => m.ts >= input.entryTs && m.ts <= input.closeMs)
    .sort((a, b) => a.ts - b.ts);
  if (marks.length === 0) return blank("no_marks_logged");
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

  let uTrigger: { time: number; kind: "t1_touch" | "underlying_stop"; level: number } | null = null;
  for (const b of bars) {
    const stopHit = input.stopLevel > 0 && (input.isCall ? b.low <= input.stopLevel : b.high >= input.stopLevel);
    const t1Hit = input.t1 > 0 && (input.isCall ? b.high >= input.t1 : b.low <= input.t1);
    if (stopHit) { uTrigger = { time: b.datetime + 60_000, kind: "underlying_stop", level: input.stopLevel }; break; }
    if (t1Hit) { uTrigger = { time: b.datetime + 60_000, kind: "t1_touch", level: input.t1 }; break; }
  }

  const stopPx = entry * (1 - input.optionStopPct);
  const horizonEnd = uTrigger ? Math.min(uTrigger.time, input.closeMs) : input.closeMs;
  let oTrigger: OptionMark | null = null;
  if (input.optionStopPct > 0) {
    for (const m of marks) {
      if (m.ts > horizonEnd) break;
      const mid = markMid(m);
      if (mid != null && mid <= stopPx && m.bid != null && m.bid >= 0) { oTrigger = m; break; }
    }
  }

  const mfeUpTo = (t: number): number | null => {
    let best: number | null = null;
    for (const m of marks) {
      if (m.ts > t) break;
      if (m.bid == null || !(m.bid >= 0)) continue;
      const r = (m.bid - entry) / entry;
      if (best == null || r > best) best = r;
    }
    return best;
  };
  const underlyingAt = (t: number): number | null => {
    let px: number | null = null;
    for (const b of bars) { if (b.datetime + 60_000 <= t) px = b.close; else break; }
    return px;
  };
  const done = (reason: OdteExitReason, exitPrice: number, exitTs: number, uPx: number | null, settled: boolean): OdteOptionGrade => {
    const mfe = mfeUpTo(exitTs);
    const realized = (exitPrice - entry) / entry;
    return {
      status: "graded", reason, entryPrice: entry, exitPrice, exitTs,
      realizedReturn: realized,
      optionMfe: mfe == null ? realized : Math.max(mfe, realized),
      underlyingAtExit: uPx,
      settled,
    };
  };

  if (oTrigger) {
    if (!covered(oTrigger.ts)) return blank("mark_gap");
    return done("option_stop", oTrigger.bid as number, oTrigger.ts, underlyingAt(oTrigger.ts), false);
  }

  if (uTrigger && uTrigger.time < input.closeMs) {
    const t = uTrigger.time;
    if (!covered(t)) return blank("mark_gap");
    const fill = marks.find((m) => m.ts >= t && m.ts <= t + lag && m.bid != null && m.bid >= 0);
    if (!fill) return blank("no_exit_mark");
    return done(uTrigger.kind, fill.bid as number, fill.ts, uTrigger.level, false);
  }

  // Held to the close: settle at intrinsic on the closing value (the 15:59 bar close).
  const last = bars[bars.length - 1];
  if (last.datetime + 60_000 < input.closeMs - 120_000) return blank("no_close_bar");
  if (!covered(input.closeMs)) return blank("mark_gap");
  const S = last.close;
  const intrinsic = input.isCall ? Math.max(0, S - input.strike) : Math.max(0, input.strike - S);
  return done("settled_at_close", intrinsic, input.closeMs, S, true);
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
export function levelsFromChainSnapshot(snap: HistoricalChainSnapshot): { callWall: number | null; putWall: number | null; maxPain: number | null } {
  const weight = (c: HistoricalChainSnapshot["contracts"][number]) =>
    Math.max(0, c.openInterest || 0) * (c.gamma != null && Number.isFinite(c.gamma) && c.gamma > 0 ? c.gamma : 1);
  const pick = (type: "C" | "P", above: boolean): number | null => {
    const byStrike = new Map<number, number>();
    for (const c of snap.contracts) {
      if (c.type !== type || !(c.strike > 0)) continue;
      if (above ? c.strike < snap.spot : c.strike > snap.spot) continue;
      byStrike.set(c.strike, (byStrike.get(c.strike) ?? 0) + weight(c));
    }
    let best: number | null = null, w = 0;
    for (const [k, v] of byStrike) if (v > w) { w = v; best = k; }
    return best;
  };
  return { callWall: pick("C", true), putWall: pick("P", false), maxPain: maxPainStrike(snap.contracts) };
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
    return { n: 0, covered: 0, rate: null, wilsonLo: null, wilsonHi: null, nominal, nominalInsideInterval: null, kupiecLR: null, kupiecP: null, meanIntervalScore: null, belowLo: 0, aboveHi: 0 };
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
  return {
    n, covered, rate: covered / n,
    wilsonLo: w.lo, wilsonHi: w.hi, nominal,
    nominalInsideInterval: nominal >= w.lo && nominal <= w.hi,
    kupiecLR, kupiecP,
    meanIntervalScore: isSum / n,
    belowLo, aboveHi,
  };
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
  for (const [h, list] of byH) {
    list.sort((a, b) => a.ts - b.ts);
    let nextFree = -Infinity;
    for (const r of list) {
      if (r.ts >= nextFree) { out.push(r); nextFree = r.ts + h * 60_000; }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
