// WS4 — validation ledgers, sizing, forecast coverage.
// Every expected value is hand-computed or from the cited reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wilsonInterval, kellyFraction, kellyFromLedger, summarizeOptionReturns, MIN_FIRES_FOR_POINT_ESTIMATE,
  optionTradeDollars, gradeOdteOptionPnl, underlyingCloseOutPct, acceptExitQuote, askToBidReturn,
  modeledExpiryExit, settlementStyle, evaluateWhaleTrade, erfc, intervalScore, scoreIntervalCoverage,
  etCloseMs, etDate, priceAtFromBars, forwardReturnFromBars, nonOverlappingForecasts, gradeBucketFor,
  maxPainStrike, levelsFromChainSnapshot, logOptimalKelly, netOptionReturn, christoffersenIndependence, toCents,
  isOutcomeOnOptionMarks, OUTCOME_ON_OPTION_MARKS_SQL,
  type MinuteBar, type OptionMark,
} from "../../server/validationMath";
import { sizeLongOption, resolveFeePerContract, type CoreSizingDeps } from "../../server/sizingMath";
import { buildSizerRequest } from "../../shared/sizerRequest";

const near = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} +/- ${tol}, got ${a}`);

// ─── Binomial / Kelly ────────────────────────────────────────────────────────

test("Wilson 95% interval, 8 of 10 (Wilson 1927 closed form)", () => {
  // center = (0.8 + 1.96^2/20) / (1 + 1.96^2/10) = 0.71674; half = 0.22658
  const w = wilsonInterval(8, 10);
  near(w.lo, 0.49016, 1e-4, "lo");
  near(w.hi, 0.94332, 1e-4, "hi");
  const z = wilsonInterval(0, 0);
  assert.deepEqual([z.lo, z.hi], [0, 1]);
});

test("Kelly f* = p/L - q/b (Thorp 2006 f* = m/(ab))", () => {
  near(kellyFraction(0.6, 1, 1), 0.2, 1e-12, "even money: 2p - 1");
  // p = 0.5, win +50%, lose -20%: 0.5/0.2 - 0.5/0.5 = 1.5
  near(kellyFraction(0.5, 0.5, 0.2), 1.5, 1e-12);
  assert.ok(kellyFraction(0.2, 0.5, 0.5) < 0, "negative edge -> no bet");
});

test("kellyFromLedger uses the Wilson lower bound below 385 fires and caps at half Kelly", () => {
  assert.equal(MIN_FIRES_FOR_POINT_ESTIMATE, 385); // ceil(1.96^2 * 0.25 / 0.05^2) = ceil(384.16)
  const bucket = { label: "90-94", n: 20, wins: 14, avgWinReturn: 0.5, avgLossReturn: 0.2 };
  const ev = kellyFromLedger({ bucket, plannedB: 0.5, plannedL: 0.2, kellyFraction: 0.25 });
  // Wilson lo for 14/20: center 0.66777, half 0.18675 -> 0.48102
  near(ev.p, 0.48102, 1e-4, "p = Wilson lower bound");
  assert.equal(ev.pSource, "wilson_lower_bound");
  near(ev.fStar, 0.48102 / 0.2 - (1 - 0.48102) / 0.5, 1e-3, "f*");
  near(ev.fApplied, 0.25 * ev.fStar, 1e-12);
  // realized winners smaller than plan -> b shrinks; realized losers bigger -> L grows
  const ev2 = kellyFromLedger({ bucket: { ...bucket, avgWinReturn: 0.35, avgLossReturn: 0.31 }, plannedB: 0.5, plannedL: 0.2 });
  assert.equal(ev2.b, 0.35);
  assert.equal(ev2.L, 0.31);
  // fraction above half Kelly is capped; a small fraction is honoured (never raised)
  assert.equal(kellyFromLedger({ bucket, plannedB: 0.5, plannedL: 0.2, kellyFraction: 1 }).kellyFraction, 0.5);
  assert.equal(kellyFromLedger({ bucket, plannedB: 0.5, plannedL: 0.2, kellyFraction: 0.01 }).kellyFraction, 0.01);
  // no evidence -> p = 0 -> nothing staked
  const none = kellyFromLedger({ bucket: null, plannedB: 0.5, plannedL: 0.2 });
  assert.equal(none.p, 0);
  assert.equal(none.fApplied, 0);
  // point estimate once the bucket is large
  const big = kellyFromLedger({ bucket: { label: "x", n: 400, wins: 240, avgWinReturn: 0.6, avgLossReturn: 0.25 }, plannedB: 0.5, plannedL: 0.2 });
  assert.equal(big.pSource, "point_estimate");
  near(big.p, 0.6, 1e-12);
});

test("summarizeOptionReturns and grade buckets", () => {
  const s = summarizeOptionReturns("85-89", [0.4, -0.2, 0.6, -0.3, 0]);
  assert.equal(s.n, 5);
  assert.equal(s.wins, 2);
  near(s.avgWinReturn!, 0.5, 1e-12);
  near(s.avgLossReturn!, (0.2 + 0.3 + 0) / 3, 1e-12);
  assert.equal(gradeBucketFor(79.6)?.label, "80-84");
  assert.equal(gradeBucketFor(71), null);
});

// ─── Sizing dollars (hand-computed) ──────────────────────────────────────────

const deps = (ledger: CoreSizingDeps["ledger"]): CoreSizingDeps => ({
  fireGate: 72,
  bangerMinPct: 30,
  ledger,
  tierMultiplier: (g) => (g >= 95 ? 1 : g >= 85 ? 0.85 : g >= 80 ? 0.7 : g >= 72 ? 0.5 : 0),
});
const strongLedger = { label: "95-100", n: 400, wins: 240, avgWinReturn: 0.6, avgLossReturn: 0.25 };

test("sizer: $30,000, 1% risk, 1.50 entry, 1.20 stop, no fees -> exactly 10 contracts ($300 at risk)", () => {
  // Per contract: (1.50 - 1.20) x 100 = $30.00. $300 / $30 = 10. In binary floating point
  // (1.5 - 1.2) * 100 = 30.000000000000004 and the old code floored 9.9999 to 9.
  const r = sizeLongOption({ accountSize: 30_000, maxRiskPct: 0.01, entryPrice: 1.5, stopPrice: 1.2, gradeScore: 96, targetPct: 50, feePerContract: 0 }, deps(strongLedger));
  // Kelly: p = 0.6 (n = 400), b = min(0.5, 0.6) = 0.5, L = max(0.2, 0.25) = 0.25
  // f* = 0.6/0.25 - 0.4/0.5 = 1.6; quarter Kelly = 0.40 -> $12,000 / $150 = 80 contracts
  assert.equal(r.candidates.kelly, 80);
  assert.equal(r.candidates.riskBudget, 10);
  assert.equal(r.candidates.cash, 200); // $30,000 / $150
  assert.equal(r.contracts, 10);
  assert.equal(r.bindingConstraint, "risk-floor");
  assert.equal(r.riskDollars, 300);
  assert.equal(r.notionalDollars, 1500);
  assert.equal(r.maxLossDollars, 1500);
  assert.equal(r.perContract?.premium, 150);
  assert.equal(r.multiplier, 100);
});

test("sizer: fees and stop slippage are inside the risk budget", () => {
  // Per contract: price loss (1.50 - (1.20 - 0.05)) x 100 = $35.00, fees 2 x 0.65 = $1.30 -> $36.30.
  // $300 / $36.30 = 8.26 -> 8 contracts, $290.40 at risk.
  const r = sizeLongOption({ accountSize: 30_000, maxRiskPct: 0.01, entryPrice: 1.5, stopPrice: 1.2, gradeScore: 96, targetPct: 50, feePerContract: 0.65, stopSlippage: 0.05 }, deps(strongLedger));
  assert.equal(r.perContract?.riskAtStop, 36.3);
  assert.equal(r.contracts, 8);
  assert.equal(r.riskDollars, 290.4);
  assert.equal(r.feesDollars, 10.4);            // 8 x $1.30
  assert.equal(r.maxLossDollars, 1210.4);       // 8 x ($150 + $1.30)
  assert.equal(r.targetProfitDollars, 589.6);   // 8 x ($75.00 - $1.30)
  assert.equal(r.notionalDollars, 1200);
});

test("sizer: small account cannot afford one contract's risk -> 0, min-contract", () => {
  // $1,000 x 1% = $10 < $30 per contract
  const r = sizeLongOption({ accountSize: 1_000, maxRiskPct: 0.01, entryPrice: 1.5, stopPrice: 1.2, gradeScore: 96, feePerContract: 0 }, deps(strongLedger));
  assert.equal(r.contracts, 0);
  assert.equal(r.bindingConstraint, "min-contract");
  assert.equal(r.riskDollars, 0);
});

test("sizer: no option-graded evidence -> Kelly sizes zero", () => {
  const r = sizeLongOption({ accountSize: 100_000, maxRiskPct: 0.01, entryPrice: 2, stopPrice: 1.6, gradeScore: 90, feePerContract: 0.65 }, deps({ label: "90-94", n: 0, wins: 0, avgWinReturn: null, avgLossReturn: null }));
  assert.equal(r.contracts, 0);
  assert.equal(r.bindingConstraint, "kelly-cap");
  assert.ok(r.candidates.riskBudget > 0);
});

test("sizer: risk above the 5% ceiling is lowered, a tiny risk is never raised, cash caps notional", () => {
  const hi = sizeLongOption({ accountSize: 10_000, maxRiskPct: 0.5, entryPrice: 1, stopPrice: 0.5, gradeScore: 96, feePerContract: 0 }, deps(strongLedger));
  assert.equal(hi.maxRiskPctApplied, 0.05);
  assert.ok(hi.riskDollars <= 500);
  const lo = sizeLongOption({ accountSize: 10_000, maxRiskPct: 0.0005, entryPrice: 1, stopPrice: 0.5, gradeScore: 96, feePerContract: 0 }, deps(strongLedger));
  assert.equal(lo.riskBudgetDollars, 5); // $10,000 x 0.05% = $5, not raised to 0.1%
  assert.equal(lo.contracts, 0);         // $5 < $50 per contract
  // Tight stop: risk budget alone would buy 100 contracts at $10 = $100,000 notional on a $20,000 account.
  // Cash would allow 20 ($20,000). The gap cap (full premium <= 5% = $1,000) allows 1.
  const cash = sizeLongOption({ accountSize: 20_000, maxRiskPct: 0.05, entryPrice: 10, stopPrice: 9.9, gradeScore: 96, feePerContract: 0, kellyFraction: 0.5 },
    deps({ label: "95-100", n: 1000, wins: 900, avgWinReturn: 0.9, avgLossReturn: 0.01 }));
  assert.equal(cash.candidates.cash, 20);
  assert.equal(cash.candidates.gap, 1);
  assert.equal(cash.contracts, 1);
  assert.equal(cash.bindingConstraint, "gap-cap");
  assert.ok(cash.maxLossDollars <= 1_000);
});

test("sizer invariants hold for random accounts (seeded)", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ledgerFor = (n: number, u: number) => ({ label: "x", n, wins: Math.floor(n * (0.3 + 0.6 * u)), avgWinReturn: 0.8, avgLossReturn: 0.3 });
  let sized = 0;
  for (let i = 0; i < 2000; i++) {
    const account = Math.round(500 + rnd() * 2_000_000);
    const riskPct = rnd() * 0.06;
    const entry = Math.round((0.05 + rnd() * 30) * 100) / 100;
    const stop = Math.round(entry * rnd() * 100) / 100;
    const fee = Math.round(rnd() * 150) / 100;
    const slip = Math.round(rnd() * 20) / 100;
    if (stop >= entry) continue;
    const r = sizeLongOption({ accountSize: account, maxRiskPct: riskPct, entryPrice: entry, stopPrice: stop, gradeScore: 72 + Math.floor(rnd() * 29), feePerContract: fee, stopSlippage: slip, kellyFraction: rnd() },
      deps(ledgerFor(Math.floor(rnd() * 600), rnd())));
    if (r.contracts > 0) sized++;
    assert.ok(Number.isInteger(r.contracts) && r.contracts >= 0);
    const budget = Math.min(0.05, riskPct) * account;
    assert.ok(r.riskDollars <= budget + 1e-9, `risk ${r.riskDollars} > budget ${budget}`);
    assert.ok(r.notionalDollars + r.contracts * fee <= account + 1e-9, "cost > account");
    assert.ok(r.maxLossDollars <= 0.05 * account + 1e-9, `gap loss ${r.maxLossDollars} > 5% of ${account}`);
    if (r.perContract) assert.ok(Math.abs(r.riskDollars - r.contracts * r.perContract.riskAtStop) < 1e-6);
  }
  assert.ok(sized > 200, `only ${sized} non-zero sizes: invariants not exercised`);
});

// ─── Trade dollars ───────────────────────────────────────────────────────────

test("optionTradeDollars: 3 contracts 1.50 -> 1.75 with $0.65/side", () => {
  // gross (1.75 - 1.50) x 100 = $25.00, fees $1.30, net $23.70 per contract; x3 = $71.10
  const d = optionTradeDollars({ entry: 1.5, exit: 1.75, contracts: 3, feePerContract: 0.65 });
  assert.equal(d.perContractGross, 25);
  assert.equal(d.perContractFees, 1.3);
  assert.equal(d.perContractNet, 23.7);
  assert.equal(d.totalNet, 71.1);
  // cash-settled at expiry: only the opening fee
  assert.equal(optionTradeDollars({ entry: 1.5, exit: 4, contracts: 1, feePerContract: 0.65, settled: true }).perContractNet, 249.35);
});

// ─── 0DTE option-mark grading ────────────────────────────────────────────────

const T0 = Date.UTC(2026, 6, 15, 14, 0, 0); // 10:00 EDT
const CLOSE = etCloseMs("2026-07-15");
function flatBars(px: number, from = T0, to = CLOSE): MinuteBar[] {
  const out: MinuteBar[] = [];
  for (let t = from; t < to; t += 60_000) out.push({ datetime: t, open: px, high: px, low: px, close: px });
  return out;
}
function minuteMarks(bid: number, ask: number, from = T0, to = CLOSE): OptionMark[] {
  const out: OptionMark[] = [];
  for (let t = from; t <= to - 1_000; t += 60_000) out.push({ ts: t + 1_000, bid, ask });
  return out;
}
const baseGrade = { isCall: true, strike: 6000, entryAsk: 10.2, entryTs: T0, t1: 6010, stopLevel: 5990, optionStopPct: 0.2, closeMs: CLOSE };

test("0DTE grade: T1 touch exits at the next logged bid", () => {
  const bars = flatBars(6000);
  bars[10] = { ...bars[10], high: 6011 };
  const marks = minuteMarks(10.0, 10.2).map((m) => (m.ts >= T0 + 11 * 60_000 ? { ...m, bid: 14.0, ask: 14.3 } : m));
  const g = gradeOdteOptionPnl({ ...baseGrade, bars, marks });
  assert.equal(g.status, "graded");
  assert.equal(g.reason, "t1_touch");
  assert.equal(g.exitPrice, 14.0);
  near(g.realizedReturn!, (14.0 - 10.2) / 10.2, 1e-12); // +37.25%
});

test("0DTE grade: -20% option stop on the mid fills at the bid", () => {
  const marks = minuteMarks(10.0, 10.2).map((m) => (m.ts >= T0 + 5 * 60_000 ? { ...m, bid: 7.9, ask: 8.1 } : m));
  const g = gradeOdteOptionPnl({ ...baseGrade, bars: flatBars(6000), marks });
  assert.equal(g.reason, "option_stop"); // mid 8.00 <= 10.2 x 0.8 = 8.16
  near(g.realizedReturn!, (7.9 - 10.2) / 10.2, 1e-12); // -22.5%: slipped past -20%
});

test("0DTE grade: no trigger settles at intrinsic on the close", () => {
  const g = gradeOdteOptionPnl({ ...baseGrade, bars: flatBars(6004), marks: minuteMarks(9.9, 10.1) });
  assert.equal(g.reason, "settled_at_close");
  assert.equal(g.exitPrice, 4); // 6004 - 6000
  assert.equal(g.settled, true);
  near(g.realizedReturn!, (4 - 10.2) / 10.2, 1e-12);
});

test("0DTE grade: missing data stays ungraded (never estimated)", () => {
  assert.equal(gradeOdteOptionPnl({ ...baseGrade, bars: flatBars(6000), marks: [] }).reason, "no_marks_logged");
  assert.equal(gradeOdteOptionPnl({ ...baseGrade, entryAsk: null, bars: flatBars(6000), marks: minuteMarks(10, 10.2) }).reason, "no_entry_quote");
  const gappy = minuteMarks(10, 10.2).filter((m) => m.ts < T0 + 30 * 60_000 || m.ts > T0 + 90 * 60_000);
  assert.equal(gradeOdteOptionPnl({ ...baseGrade, bars: flatBars(6000), marks: gappy }).reason, "mark_gap");
  // same-bar tie: T1 touched on the 10:04 bar whose close (the 10:00-10:05
  // candle's close) is below the stop -> stop wins (conservative). The stop is
  // a 5-minute CLOSE rule since round 2 (published plan), not a 1-minute touch.
  const bars = flatBars(6000);
  bars[4] = { ...bars[4], high: 6011, low: 5988, close: 5989 };
  const g = gradeOdteOptionPnl({ ...baseGrade, bars, marks: minuteMarks(10, 10.2) });
  assert.equal(g.reason, "underlying_stop");
});

test("0DTE: realized close-out vs MFE", () => {
  near(underlyingCloseOutPct(true, 6000, 6010), 0.16667, 1e-4);
  near(underlyingCloseOutPct(false, 6000, 6010), -0.16667, 1e-4);
});

// ─── Whale grading / backtest ────────────────────────────────────────────────

test("whale: exit quote must be at or shortly before the exit time", () => {
  const T = etCloseMs("2026-07-17");
  assert.equal(acceptExitQuote({ bid: 1.2, ask: 1.3, at: T - 60_000 }, T, 20 * 60_000).ok, true);
  assert.equal(acceptExitQuote({ bid: 1.2, ask: 1.3, at: T - 3600_000 }, T, 20 * 60_000).ok, false);
  assert.equal(acceptExitQuote({ bid: 1.2, ask: 1.3, at: T + 60_000 }, T, 20 * 60_000).ok, false);
  assert.equal(acceptExitQuote(null, T, 20 * 60_000).ok, false);
  near(askToBidReturn(2.0, 2.6), 0.3, 1e-12);
});

test("whale backtest: theta and spread at expiry", () => {
  // Hull ch.10 terminal payoff. Call K = 100, S_T = 105: intrinsic 5.
  assert.equal(modeledExpiryExit({ isCall: true, strike: 100, underlyingClose: 105, entryBid: 2.0, entryAsk: 2.2, cashSettled: false }).exitPrice, 4.9);
  assert.equal(modeledExpiryExit({ isCall: true, strike: 100, underlyingClose: 105, entryBid: 2.0, entryAsk: 2.2, cashSettled: true }).exitPrice, 5);
  assert.equal(modeledExpiryExit({ isCall: false, strike: 100, underlyingClose: 105, entryBid: 2.0, entryAsk: 2.2, cashSettled: false }).exitPrice, 0);
  assert.equal(settlementStyle("SPXW  261009C06700000"), "cash_pm");
  assert.equal(settlementStyle("SPX   261016C06700000"), "am_settled");
  assert.equal(settlementStyle("AAPL  261016C00200000"), "physical");

  // AAPL call bought at the 3.10 ask (bid 3.00), K = 200, close at expiry 204: exit 4.00 - 0.05 = 3.95.
  // $1,000 notional, $0.65 fee: cost $310.65 -> 3 contracts. Per contract (3.95 - 3.10) x 100 - 1.30 = $83.70; x3 = $251.10.
  const w = evaluateWhaleTrade({ isCall: true, strike: 200, occ: "AAPL  261016C00200000", entryBid: 3.0, entryAsk: 3.1, loggedExitBid: null, underlyingCloseAtExpiry: 204, notional: 1000, feePerContract: 0.65 });
  assert.equal(w.reason, "ok_modeled_expiry");
  near(w.exitPrice!, 3.95, 1e-12);
  assert.equal(w.contracts, 3);
  assert.equal(w.pnlPerContract, 83.7);
  assert.equal(w.dollarPnl, 251.1);
  near(w.pctReturn!, (3.95 - 3.1) / 3.1, 1e-12);
  // Expired worthless: lose the premium plus the opening fee only: -$310.65 per contract.
  const dead = evaluateWhaleTrade({ isCall: true, strike: 200, occ: "AAPL  261016C00200000", entryBid: 3.0, entryAsk: 3.1, loggedExitBid: null, underlyingCloseAtExpiry: 190, notional: 1000, feePerContract: 0.65 });
  assert.equal(dead.pnlPerContract, -310.65);
  assert.equal(dead.dollarPnl, -931.95);
  // A logged bid wins over the model; no entry quote -> not traded
  assert.equal(evaluateWhaleTrade({ isCall: true, strike: 200, occ: "AAPL", entryBid: 3, entryAsk: 3.1, loggedExitBid: 3.5, underlyingCloseAtExpiry: 204, notional: 1000, feePerContract: 0 }).exitSource, "logged_bid");
  assert.equal(evaluateWhaleTrade({ isCall: true, strike: 200, occ: "AAPL", entryBid: null, entryAsk: null, loggedExitBid: 3.5, underlyingCloseAtExpiry: 204, notional: 1000, feePerContract: 0 }).reason, "no_entry_quote");
  assert.equal(evaluateWhaleTrade({ isCall: true, strike: 6700, occ: "SPX   261016C06700000", entryBid: 3, entryAsk: 3.1, loggedExitBid: null, underlyingCloseAtExpiry: 6800, notional: 1000, feePerContract: 0 }).reason, "am_settled_no_settlement_value");
});

// ─── Time ────────────────────────────────────────────────────────────────────

test("16:00 ET close is DST-correct", () => {
  assert.equal(etCloseMs("2026-07-15"), Date.UTC(2026, 6, 15, 20, 0, 0));  // EDT, UTC-4
  assert.equal(etCloseMs("2026-12-15"), Date.UTC(2026, 11, 15, 21, 0, 0)); // EST, UTC-5
  assert.equal(etDate(Date.UTC(2026, 11, 16, 3, 0, 0)), "2026-12-15");      // 22:00 EST previous day
});

// ─── Coverage (Gneiting-Raftery 2007; Kupiec 1995 / Christoffersen 1998) ────

test("erfc and interval score", () => {
  near(erfc(1), 0.157299207, 2e-7);
  near(erfc(0), 1, 2e-7);
  // [lo, hi] = [-1, 1], x = 2, alpha = 0.2: width 2 + (2/0.2) x 1 = 12
  assert.equal(intervalScore(-1, 1, 2, 0.2), 12);
  assert.equal(intervalScore(-1, 1, 0, 0.2), 2);
});

test("coverage: 8 of 10 inside a 10-90% band is nominal; 70 of 100 rejects at 5%", () => {
  const rows8 = Array.from({ length: 10 }, (_, i) => ({ lo: -1, hi: 1, realized: i < 8 ? 0 : 5 }));
  const s8 = scoreIntervalCoverage(rows8, 0.8);
  assert.equal(s8.rate, 0.8);
  near(s8.kupiecLR!, 0, 1e-12);
  near(s8.kupiecP!, 1, 1e-6);
  assert.equal(s8.aboveHi, 2);
  const rows70 = Array.from({ length: 100 }, (_, i) => ({ lo: -1, hi: 1, realized: i < 70 ? 0 : -3 }));
  const s70 = scoreIntervalCoverage(rows70, 0.8);
  // LR = -2[70 ln 0.8 + 30 ln 0.2 - 70 ln 0.7 - 30 ln 0.3] = 5.633512; chi2(1) sf = 0.017620 (scipy.stats.chi2.sf)
  near(s70.kupiecLR!, 5.633512, 1e-5);
  near(s70.kupiecP!, 0.017620, 1e-5);
  assert.equal(s70.belowLo, 30);
  assert.equal(s70.nominalInsideInterval, false);
});

test("forward returns from minute bars refuse gaps; overlapping forecasts are thinned", () => {
  const bars: MinuteBar[] = [
    { datetime: 0, open: 100, high: 100, low: 100, close: 100 },
    { datetime: 60_000, open: 100, high: 101, low: 100, close: 101 },
    { datetime: 120_000, open: 101, high: 102, low: 101, close: 102 },
  ];
  assert.equal(priceAtFromBars(bars, 120_000), 101);
  near(forwardReturnFromBars(bars, 120_000, 1)!, 102 / 101 - 1, 1e-12);
  assert.equal(priceAtFromBars(bars, 3_600_000), null); // last bar 58 min stale
  const kept = nonOverlappingForecasts([
    { ts: 0, horizonMin: 30 }, { ts: 10 * 60_000, horizonMin: 30 }, { ts: 30 * 60_000, horizonMin: 30 }, { ts: 61 * 60_000, horizonMin: 30 },
  ]);
  assert.deepEqual(kept.map((k) => k.ts / 60_000), [0, 30, 61]);
});

// ─── Pluggable chain source for the volatility-band backtest ────────────────

test("max pain and chain walls from a toy chain", () => {
  // Calls: 100 OI at K=95, 300 at K=105. Puts: 200 at K=100, 50 at K=90.
  // Payout at K*=95: puts (100-95)*200 = 1000 -> 1000; at 100: calls 5*100 = 500 -> 500;
  // at 105: calls 10*100 = 1000, puts 0 + 0 -> 1000; at 90: puts 10*200 = 2000. Max pain = 100.
  const contracts = [
    { strike: 95, type: "C" as const, openInterest: 100 },
    { strike: 105, type: "C" as const, openInterest: 300 },
    { strike: 100, type: "P" as const, openInterest: 200 },
    { strike: 90, type: "P" as const, openInterest: 50 },
  ];
  assert.equal(maxPainStrike(contracts), 100);
  const lv = levelsFromChainSnapshot({ date: "2026-01-02", spot: 101, contracts });
  assert.equal(lv.callWall, 105); // only call strike at or above spot
  assert.equal(lv.putWall, 100);  // largest put OI at or below spot
  assert.equal(lv.maxPain, 100);
  assert.equal(maxPainStrike([]), null);
});

// ─── ML real-data pipeline (Python, no lightgbm needed) ──────────────────────

test("ML quantile pipeline: real-data labels, day-based gate, purged walk-forward folds (python)", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const probe = spawnSync("python3", ["-I", "-c", "import numpy, pandas"], { encoding: "utf8", timeout: 15_000 });
  if (probe.error || probe.status !== 0) { t.skip("python3 with numpy and pandas not available"); return; }
  const script = fileURLToPath(new URL("./ml_quantile_data.py", import.meta.url));
  const r = spawnSync("python3", ["-I", script], { encoding: "utf8", timeout: 15_000 });
  assert.equal(r.status, 0, `python checks failed:\n${r.stdout}\n${r.stderr}`);
});

test("per-trade Sharpe is annualized by trades per year (Lo 2002), Sortino by full-sample downside deviation", async () => {
  const { annualizedSharpe, annualizedSortino } = await import("../../server/validationMath");
  const r = [0.02, -0.01, 0.03, -0.02, 0.01, 0.02]; // mean 0.008333, sample sd 0.019408
  near(annualizedSharpe(r, 12)!, (0.0083333 / 0.0194079) * Math.sqrt(12), 1e-4); // 12 trades/yr -> 1.4874
  near(annualizedSharpe(r, 12)! / annualizedSharpe(r, 252)!, Math.sqrt(12 / 252), 1e-12);
  // downside deviation: sqrt((0.01^2 + 0.02^2) / 6) = 0.0091287
  near(annualizedSortino(r, 12)!, (0.0083333 / 0.0091287) * Math.sqrt(12), 1e-4);
  assert.equal(annualizedSortino([0.01, 0.02, 0.03, 0.01, 0.02], 12), null); // no downside: undefined, not infinite
  assert.equal(annualizedSharpe([0.01], 12), null);
});

// ─── Fix round (WS3 review) ──────────────────────────────────────────────────

test("client path: mid + spread is converted to an ask fill; true loss at stop stays inside the budget", () => {
  // Repro: $10,000, 2% risk ($200), mid 1.50, stop 1.20 (mid level), spread 0.10, $0.65/side, SPXW.
  const body = buildSizerRequest({ accountSize: "10000", maxRiskPctPercent: "2", midPrice: "1.50", stopPrice: "1.20", spreadDollars: "0.10",
    gradeScore: "96", targetPct: "50", kellyPercent: "25", feePerContract: "0.65", product: "SPXW", maxGapLossPctPercent: "5" });
  assert.equal(body.entryPrice, 1.55);   // ask = mid + 0.05
  assert.equal(body.stopSlippage, 0.05); // the stop sells at the bid, 0.05 under its mid
  assert.equal(body.maxRiskPct, 0.02);
  const r = sizeLongOption(body, deps(strongLedger));
  // True loss at stop per contract: (1.55 - 1.15) x 100 + 1.30 = $41.30 -> floor(200 / 41.30) = 4 by the risk budget.
  assert.equal(r.perContract?.riskAtStop, 41.3);
  assert.equal(r.candidates.riskBudget, 4);
  // Gap cap: premium + fees = $156.30; 5% of $10,000 = $500 -> 3 contracts, which binds.
  assert.equal(r.contracts, 3);
  assert.equal(r.bindingConstraint, "gap-cap");
  assert.ok(r.riskDollars <= 200, `risk ${r.riskDollars}`);
  assert.equal(r.riskDollars, 123.9);   // 3 x $41.30
  // The old card sent the mid as entryPrice and no slippage: 5 contracts whose true loss was 5 x $41.30 = $206.50 > $200.
  const old = sizeLongOption({ accountSize: 10_000, maxRiskPct: 0.02, entryPrice: 1.5, stopPrice: 1.2, gradeScore: 96, targetPct: 50, feePerContract: 0.65, maxGapLossPct: 0.05 }, deps(strongLedger));
  assert.equal(old.candidates.riskBudget, 6); // (1.50 - 1.20) x 100 + 1.30 = $31.30 -> 6, understated risk
  assert.ok(5 * 41.3 > 200);
});

test("gap cap bounds the full-premium loss (WS3 repro: $25k, 5% risk, 2.00 entry, 1.90 stop, half Kelly)", () => {
  const ledger = { label: "95-100", n: 400, wins: 240, avgWinReturn: 0.6, avgLossReturn: 0.25 };
  const r = sizeLongOption({ accountSize: 25_000, maxRiskPct: 0.05, entryPrice: 2, stopPrice: 1.9, gradeScore: 96, targetPct: 50, kellyFraction: 0.5, feePerContract: 0.65 }, deps(ledger));
  // Before: 66 contracts, $13,200 premium, $13,285.80 lost on a gap through the stop.
  // Now: max loss per contract $200 + $1.30 = $201.30; 5% of $25,000 = $1,250 -> 6 contracts.
  assert.equal(r.candidates.gap, 6);
  assert.equal(r.contracts, 6);
  assert.equal(r.bindingConstraint, "gap-cap");
  assert.equal(r.maxLossDollars, 1207.8);
  assert.equal(r.gapLossBudgetDollars, 1250);
  // A smaller stated gap limit is honoured; a larger one is lowered to 5%.
  assert.equal(sizeLongOption({ accountSize: 25_000, maxRiskPct: 0.05, entryPrice: 2, stopPrice: 1.9, gradeScore: 96, feePerContract: 0.65, kellyFraction: 0.5, maxGapLossPct: 0.02 }, deps(ledger)).contracts, 2);
  assert.equal(sizeLongOption({ accountSize: 25_000, maxRiskPct: 0.05, entryPrice: 2, stopPrice: 1.9, gradeScore: 96, feePerContract: 0.65, kellyFraction: 0.5, maxGapLossPct: 0.5 }, deps(ledger)).maxGapLossPctApplied, 0.05);
});

test("log-optimal Kelly on realized returns (Kelly 1956 / Thorp 2006: max E log(1 + f X))", () => {
  // Two-point check: +1 w.p. 0.6, -1 w.p. 0.4 -> f* = 2p - 1 = 0.2
  near(logOptimalKelly([1, 1, 1, -1, -1]), 0.2, 1e-9);
  // 6 x +50%, 3 x -20%, 1 x -100%: scipy bounded minimize gives f* = 0.443534;
  // the two-point approximation (p 0.6, b 0.5, L = mean loser 0.4) says 0.70.
  near(logOptimalKelly([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.2, -0.2, -0.2, -1]), 0.443534, 1e-5);
  assert.equal(logOptimalKelly([-0.1, 0.05]), 0); // negative mean: no bet
  assert.ok(logOptimalKelly([0.5, -1, 0.5, 0.5]) < 1); // never 1/|worst loss| or more
  // kellyFromLedger takes the smaller of the two
  const ev = kellyFromLedger({ bucket: summarizeOptionReturns("x", [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.2, -0.2, -0.2, -1]), plannedB: 0.5, plannedL: 0.2 });
  assert.ok(ev.fLogOptimal != null && ev.fStar <= ev.fLogOptimal + 1e-12 && ev.fStar <= ev.fBinary + 1e-12);
});

test("ledger returns are net of fees; index options require an explicit fee", () => {
  // Entry 2.00, exit 2.60, $0.65/side: ($60.00 - $1.30) / $200 = 0.2935
  near(netOptionReturn(2, 2.6, 0.65, false)!, 0.2935, 1e-12);
  // Settled worthless: -($200 + $0.65) / $200 = -1.00325 (opening fee only)
  near(netOptionReturn(2, 0, 0.65, true)!, -1.00325, 1e-12);
  assert.equal(resolveFeePerContract(undefined, "SPXW"), null);
  assert.equal(resolveFeePerContract(undefined, "SPY"), 0.65);
  assert.equal(resolveFeePerContract(0.9, "SPXW"), 0.9);
  const r = sizeLongOption({ accountSize: 25_000, entryPrice: 2, stopPrice: 1.6, gradeScore: 96, product: "SPXW" }, deps(strongLedger));
  assert.equal(r.rejected, true);
  assert.match(r.rejectReason ?? "", /fee per contract required/);
  assert.equal(toCents(-0.005), -1); // halves away from zero for losses too
  assert.equal(toCents(0.005), 1);
});

test("Christoffersen independence test (1998) on a miss sequence", () => {
  // Sequence 0011000111000010: transitions n00 6, n01 3, n10 3, n11 3; LR 0.415329, p 0.519277 (scipy chi2.sf)
  const v = [0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 0].map((x) => x === 1);
  const r = christoffersenIndependence(v)!;
  assert.deepEqual([r.n00, r.n01, r.n10, r.n11], [6, 3, 3, 3]);
  near(r.lr, 0.415329, 1e-5);
  near(r.p, 0.519277, 1e-5);
  assert.equal(christoffersenIndependence([true]), null);
});

test("chain walls use gamma for every strike or for none", () => {
  // Strike 105 has gamma 0.01 x 300 OI = 3; strike 110 has 200 OI and no gamma. Mixing would pick 110 (200 > 3).
  const mixed = levelsFromChainSnapshot({ date: "d", spot: 101, contracts: [
    { strike: 105, type: "C", openInterest: 300, gamma: 0.01 }, { strike: 110, type: "C", openInterest: 200 } ] });
  assert.equal(mixed.weighting, "oi_only");
  assert.equal(mixed.callWall, 105); // OI alone: 300 > 200
  const full = levelsFromChainSnapshot({ date: "d", spot: 101, contracts: [
    { strike: 105, type: "C", openInterest: 300, gamma: 0.01 }, { strike: 110, type: "C", openInterest: 200, gamma: 0.02 } ] });
  assert.equal(full.weighting, "oi_x_gamma");
  assert.equal(full.callWall, 110); // 4 > 3
});

test("proxy-graded whale outcomes are excluded at query time, not rewritten", () => {
  assert.equal(isOutcomeOnOptionMarks({ kind: "whale_alert", outcomeJson: JSON.stringify({ result: "ok", leverage: 12 }) }), false);
  assert.equal(isOutcomeOnOptionMarks({ kind: "whale_alert", outcome_json: JSON.stringify({ result: "ok", method: "option_marks_v1" }) }), true);
  assert.equal(isOutcomeOnOptionMarks({ kind: "regime_call", outcomeJson: "{}" }), true);
  assert.ok(OUTCOME_ON_OPTION_MARKS_SQL.includes('"method":"option_marks_v1"'));
});

test("whale trade smaller than one contract is flagged by zero contracts", () => {
  const w = evaluateWhaleTrade({ isCall: true, strike: 200, occ: "AAPL  261016C00200000", entryBid: 3.0, entryAsk: 3.1, loggedExitBid: 3.5, underlyingCloseAtExpiry: null, notional: 300, feePerContract: 0.65 });
  assert.equal(w.contracts, 0);  // $310.65 per contract > $300
  assert.equal(w.dollarPnl, 0);  // the backtest maps this to reason below_one_contract and excludes it from totals
});
