// server/sizingMath.ts
//
// Pure dollar math for the long-option position sizer (positionSizer.ts is the
// DB-facing wrapper). No imports beyond validationMath, so the tests can load
// it on plain Node.
//
// Units:
//   entryPrice, stopPrice, stopSlippage   $ per share (option premium as quoted)
//   multiplier                             shares (or index $ per point) per contract: 100
//   feePerContract                         $ per contract per side (commission + exchange fees)
//   every *Dollars output                  $ for the whole position unless named perContract
//
// Invariants (tested):
//   1. contracts is a whole number >= 0 (rounded DOWN).
//   2. contracts x riskPerContract <= accountSize x maxRiskPct (the stated risk
//      budget), where riskPerContract = loss at the stop including the stop
//      slippage and round-trip fees.
//   3. contracts x costPerContract <= accountSize. Long options with nine months
//      or less to expiry must be paid in full (Cboe strategy-based margin table:
//      "Pay for each put or call in full", https://www.cboe.com/us/options/strategy_based_margin),
//      so the position can never cost more than the account.
//   4. All dollar arithmetic is done in integer cents, so 1.50 - 1.20 = 0.30
//      exactly (in floating point it is 0.30000000000000004 and floor(300/30.000000000000004) = 9).
//
// Kelly evidence comes from validationMath.kellyFromLedger: p is the Wilson
// lower bound of the realized option win rate in the grade bucket (Wilson 1927;
// Brown, Cai & DasGupta 2001), b and L from the realized ledger, fractional
// Kelly capped at one half (Thorp 2006).

import { kellyFromLedger, OPTION_MULTIPLIER, type KellyEvidence, type OptionLedgerBucket } from "./validationMath";

/** Schwab's published online options fee: $0 commission + $0.65 per contract (https://www.schwab.com/commissions). Index options (SPX) add exchange fees: pass the real figure. */
export const DEFAULT_FEE_PER_CONTRACT = 0.65;
/** Hard ceiling on the per-trade risk budget (fraction of account). Inputs above it are lowered, never raised. */
export const MAX_RISK_PCT = 0.05;
export const DEFAULT_RISK_PCT = 0.01;

export interface CoreSizingInput {
  accountSize: number;
  maxRiskPct?: number;
  entryPrice: number;
  stopPrice: number;
  gradeScore: number;
  targetPct?: number;
  kellyFraction?: number;
  multiplier?: number;
  feePerContract?: number;
  stopSlippage?: number;
}

export interface CoreSizingDeps {
  fireGate: number;
  bangerMinPct: number;
  /** Realized option-P&L ledger bucket for this grade (null = no evidence). */
  ledger: OptionLedgerBucket | null;
  /** Conviction multiplier on the size envelope by grade (0..1). */
  tierMultiplier: (grade: number) => number;
}

export interface PerContractDollars {
  premium: number;        // entry x multiplier, $ paid per contract before fees
  costWithFee: number;    // premium + opening fee
  riskAtStop: number;     // (entry - (stop - slippage)) x multiplier + round-trip fees
  maxLoss: number;        // premium + round-trip fees (option goes to zero; closing fee as upper bound)
  feesRoundTrip: number;  // 2 x feePerContract
  targetGross: number;    // entry x target% x multiplier, before fees
}

export interface CoreSizingResult {
  contracts: number;
  riskDollars: number;            // contracts x riskAtStop
  notionalDollars: number;        // contracts x premium (premium paid, ex fees)
  kellyAccountFraction: number;   // notional / account
  bindingConstraint: "risk-floor" | "kelly-cap" | "conviction-tier" | "min-contract" | "cash";
  expectedPayoffPct: number;
  rejected: boolean;
  rejectReason?: string;
  reasoning: string[];
  // Added fields (additive; existing readers unaffected)
  multiplier: number;
  feePerContract: number;
  stopSlippage: number;
  riskBudgetDollars: number;      // accountSize x maxRiskPct actually applied
  maxRiskPctApplied: number;
  perContract: PerContractDollars | null;
  maxLossDollars: number;         // contracts x maxLoss: what you lose if the option goes to zero
  feesDollars: number;            // contracts x round-trip fees
  targetProfitDollars: number;    // contracts x (targetGross - fees), if T1 fills at entry x (1 + target)
  candidates: { riskBudget: number; cash: number; kelly: number; tier: number };
  winEvidence: KellyEvidence | null;
}

const ceilCents = (dollars: number) => Math.ceil(dollars * 100 - 1e-6);
const floorCents = (dollars: number) => Math.floor(dollars * 100 + 1e-6);
const roundCents = (dollars: number) => Math.round(dollars * 100);
const fmt$ = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function emptyResult(over: Partial<CoreSizingResult> & { reasoning: string[] }, ctx: { multiplier: number; fee: number; slip: number; riskPct: number; budgetCents: number }): CoreSizingResult {
  return {
    contracts: 0,
    riskDollars: 0,
    notionalDollars: 0,
    kellyAccountFraction: 0,
    bindingConstraint: "risk-floor",
    expectedPayoffPct: 0,
    rejected: true,
    multiplier: ctx.multiplier,
    feePerContract: ctx.fee,
    stopSlippage: ctx.slip,
    riskBudgetDollars: ctx.budgetCents / 100,
    maxRiskPctApplied: ctx.riskPct,
    perContract: null,
    maxLossDollars: 0,
    feesDollars: 0,
    targetProfitDollars: 0,
    candidates: { riskBudget: 0, cash: 0, kelly: 0, tier: 0 },
    winEvidence: null,
    ...over,
  };
}

export function sizeLongOption(input: CoreSizingInput, deps: CoreSizingDeps): CoreSizingResult {
  const reasoning: string[] = [];
  const accountSize = Number.isFinite(input.accountSize) ? Math.max(0, input.accountSize) : 0;
  const requestedRisk = input.maxRiskPct ?? DEFAULT_RISK_PCT;
  const riskPct = Number.isFinite(requestedRisk) ? Math.min(MAX_RISK_PCT, Math.max(0, requestedRisk)) : 0;
  const multiplier = input.multiplier != null && input.multiplier > 0 ? input.multiplier : OPTION_MULTIPLIER;
  const fee = input.feePerContract != null && Number.isFinite(input.feePerContract) ? Math.max(0, input.feePerContract) : DEFAULT_FEE_PER_CONTRACT;
  const slip = input.stopSlippage != null && Number.isFinite(input.stopSlippage) ? Math.max(0, input.stopSlippage) : 0;
  const entry = Number.isFinite(input.entryPrice) ? input.entryPrice : 0;
  const stop = Number.isFinite(input.stopPrice) ? input.stopPrice : -1;
  const grade = Math.max(0, Math.min(100, Number.isFinite(input.gradeScore) ? input.gradeScore : 0));
  const target = Math.max(deps.bangerMinPct, input.targetPct ?? deps.bangerMinPct);
  // Risk budget in whole cents, rounded DOWN so the budget is never overstated.
  const budgetCents = floorCents(accountSize * riskPct);
  const ctx = { multiplier, fee, slip, riskPct, budgetCents };

  if (grade < deps.fireGate) {
    return emptyResult({
      bindingConstraint: "conviction-tier",
      rejectReason: `grade ${grade} < FIRE_GATE ${deps.fireGate} (banger floor)`,
      reasoning: [`grade ${grade} below ${deps.fireGate}: no size`],
    }, ctx);
  }
  if (!(entry > 0) || stop < 0 || stop >= entry) {
    return emptyResult({
      rejectReason: `invalid entry/stop: entry=${entry}, stop=${stop}`,
      reasoning: ["stop must be below entry; entry > 0, stop >= 0 (both $ per share)"],
    }, ctx);
  }
  if (!(accountSize > 0)) {
    return emptyResult({ rejectReason: "account size must be > 0", reasoning: ["account size required"] }, ctx);
  }

  if (requestedRisk > MAX_RISK_PCT) reasoning.push(`risk per trade lowered from ${(requestedRisk * 100).toFixed(2)}% to the ${(MAX_RISK_PCT * 100).toFixed(0)}% ceiling`);

  // ── Per-contract dollars (integer cents) ───────────────────────────────────
  const premiumC = roundCents(entry * multiplier);
  const feeC = roundCents(fee);
  const exitAtStop = Math.max(0, stop - slip);                 // $/share fill if the stop slips by `slip`
  const priceLossC = premiumC - roundCents(exitAtStop * multiplier); // price loss at the stop, cents per contract
  const riskC = Math.max(1, Math.min(premiumC, priceLossC) + 2 * feeC);
  const costC = premiumC + feeC;
  const maxLossC = premiumC + 2 * feeC;
  const targetGrossC = roundCents(entry * (target / 100) * multiplier);
  const perContract: PerContractDollars = {
    premium: premiumC / 100,
    costWithFee: costC / 100,
    riskAtStop: riskC / 100,
    maxLoss: maxLossC / 100,
    feesRoundTrip: (2 * feeC) / 100,
    targetGross: targetGrossC / 100,
  };
  reasoning.push(
    `per contract (x${multiplier}): premium ${fmt$(premiumC)}, loss at stop ${fmt$(riskC)} ` +
    `(${fmt$(priceLossC)} price + ${fmt$(2 * feeC)} fees${slip > 0 ? `, stop fill ${slip.toFixed(2)} below stop` : ""}), max loss ${fmt$(maxLossC)}`,
  );

  // ── (1) Risk budget: contracts x riskAtStop <= budget ──────────────────────
  const riskBudgetContracts = Math.floor(budgetCents / riskC);
  reasoning.push(`risk budget: ${(riskPct * 100).toFixed(2)}% of ${fmt$(roundCents(accountSize))} = ${fmt$(budgetCents)} -> ${riskBudgetContracts} contracts`);

  // ── (2) Cash: long options are paid in full ───────────────────────────────
  const cashContracts = Math.floor(floorCents(accountSize) / costC);

  // ── (3) Kelly from the realized option ledger ─────────────────────────────
  const plannedB = target / 100;
  const plannedL = Math.min(1, riskC / premiumC); // loss at stop incl. fees, as a fraction of premium
  const ev = kellyFromLedger({ bucket: deps.ledger, plannedB, plannedL, kellyFraction: input.kellyFraction });
  const stakeCents = Math.floor(floorCents(accountSize) * Math.min(1, ev.fApplied));
  const kellyContracts = Math.floor(stakeCents / costC);
  reasoning.push(
    `win rate: p = ${(ev.p * 100).toFixed(1)}% (${ev.pSource === "point_estimate" ? "realized option win rate" : "Wilson 95% lower bound"}, ` +
    `${ev.wins}/${ev.n} realized option wins in bucket ${deps.ledger?.label ?? "none"}, interval ${(ev.wilsonLo * 100).toFixed(0)}-${(ev.wilsonHi * 100).toFixed(0)}%)`,
  );
  reasoning.push(
    `kelly: b=${ev.b.toFixed(2)} (${ev.bSource}), L=${ev.L.toFixed(2)} (${ev.LSource}) -> f*=${ev.fStar.toFixed(3)}, ` +
    `${(ev.kellyFraction * 100).toFixed(0)}% Kelly = ${(ev.fApplied * 100).toFixed(2)}% of account as premium -> ${kellyContracts} contracts`,
  );
  for (const n of ev.notes) reasoning.push(n);

  // ── (4) Conviction tier ───────────────────────────────────────────────────
  const tierMult = Math.max(0, Math.min(1, deps.tierMultiplier(grade)));
  const tierContracts = Math.floor(Math.min(riskBudgetContracts, cashContracts, kellyContracts) * tierMult);
  reasoning.push(`conviction tier: grade ${grade} -> ${(tierMult * 100).toFixed(0)}% size multiplier`);

  const candidates = [
    { count: riskBudgetContracts, name: "risk-floor" as const },
    { count: cashContracts, name: "cash" as const },
    { count: kellyContracts, name: "kelly-cap" as const },
    { count: tierContracts, name: "conviction-tier" as const },
  ];
  // Smallest wins; on ties report the most fundamental constraint first.
  let chosen = candidates[0];
  for (const c of candidates) if (c.count < chosen.count) chosen = c;
  const contracts = Math.max(0, chosen.count);
  let bindingConstraint: CoreSizingResult["bindingConstraint"] = chosen.name;
  if (contracts === 0) {
    if (riskBudgetContracts === 0) {
      bindingConstraint = "min-contract";
      reasoning.push(`risk budget ${fmt$(budgetCents)} is below one contract's loss at stop (${fmt$(riskC)})`);
    } else if (kellyContracts === 0) {
      reasoning.push("Kelly sizes zero: the realized ledger does not yet show an edge at the Wilson lower bound");
    }
  }

  const riskDollars = (contracts * riskC) / 100;
  const notionalDollars = (contracts * premiumC) / 100;
  return {
    contracts,
    riskDollars,
    notionalDollars,
    kellyAccountFraction: Number((notionalDollars / accountSize).toFixed(4)),
    bindingConstraint,
    expectedPayoffPct: target,
    rejected: false,
    reasoning,
    multiplier,
    feePerContract: fee,
    stopSlippage: slip,
    riskBudgetDollars: budgetCents / 100,
    maxRiskPctApplied: riskPct,
    perContract,
    maxLossDollars: (contracts * maxLossC) / 100,
    feesDollars: (contracts * 2 * feeC) / 100,
    targetProfitDollars: (contracts * (targetGrossC - 2 * feeC)) / 100,
    candidates: { riskBudget: riskBudgetContracts, cash: cashContracts, kelly: kellyContracts, tier: tierContracts },
    winEvidence: ev,
  };
}
