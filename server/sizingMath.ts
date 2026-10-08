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
//   4. contracts x maxLoss <= accountSize x maxGapLossPct (the GAP cap). A
//      stop is not a guaranteed price: a stop becomes a market order whose
//      "execution price ... can deviate significantly from the stop price"
//      (SEC Investor Bulletin, https://www.investor.gov/additional-resources/news-alerts/alerts-bulletins/investor-bulletin-stop-stop-limit-trailing-stop),
//      and 0DTE options gap through a -20% stop routinely. The loss a long
//      option can actually take is the whole premium (OCC/OIC Options
//      Strategies Quick Guide: long call/put, maximum loss = premium paid,
//      https://prd-web.optionseducation.org/getmedia/68305977-b772-41c8-bf1d-3d405725b3cf/options-strategies-quick-guide-2025.pdf).
//      So the full premium plus fees is bounded by its own stated limit,
//      default 5% of the account (the sizer's hard per-trade ceiling), never raised.
//   5. All dollar arithmetic is done in integer cents, so 1.50 - 1.20 = 0.30
//      exactly (in floating point it is 0.30000000000000004 and floor(300/30.000000000000004) = 9).
//
// Kelly evidence comes from validationMath.kellyFromLedger: p is the Wilson
// lower bound of the realized option win rate in the grade bucket (Wilson 1927;
// Brown, Cai & DasGupta 2001), b and L from the realized ledger, fractional
// Kelly capped at one half (Thorp 2006).

import { kellyFromLedger, settlementStyle, OPTION_MULTIPLIER, type KellyEvidence, type OptionLedgerBucket } from "./validationMath";

/**
 * Default fee for EQUITY and ETF options only: Schwab's published $0 commission
 * + $0.65 per contract (https://www.schwab.com/commissions). Index options
 * (SPX, SPXW, XSP, NDX, RUT, VIX) also carry exchange index fees that Schwab
 * passes through and that could not be verified for this account (Cboe's
 * customer SPX/SPXW fee was $0.36-0.45 per contract on a broker's schedule
 * page, plus regulatory fees), so for index products the fee is REQUIRED input.
 */
export const DEFAULT_FEE_PER_CONTRACT = 0.65;
/** Default and ceiling for the gap cap: full premium + fees as a fraction of the account. */
export const MAX_GAP_LOSS_PCT = 0.05;

/** True for cash-settled index option roots, whose fee must be given explicitly. */
export function isIndexOptionProduct(product: string | null | undefined): boolean {
  if (!product) return false;
  return settlementStyle(product) !== "physical";
}

/** Fee the sizer will use: explicit input, else the equity default; null when an index product has no fee given. */
export function resolveFeePerContract(feePerContract: number | null | undefined, product: string | null | undefined): number | null {
  if (feePerContract != null && Number.isFinite(feePerContract)) return Math.max(0, feePerContract);
  return isIndexOptionProduct(product) ? null : DEFAULT_FEE_PER_CONTRACT;
}
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
  /** Option root, e.g. "SPXW" or "SPY". Index roots require feePerContract. */
  product?: string;
  /** Max loss if the option goes to zero (gaps through the stop), fraction of account. Default and ceiling 0.05. */
  maxGapLossPct?: number;
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
  bindingConstraint: "risk-floor" | "kelly-cap" | "conviction-tier" | "min-contract" | "cash" | "gap-cap";
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
  gapLossBudgetDollars: number;   // accountSize x maxGapLossPct: the most the full-premium loss may be
  maxGapLossPctApplied: number;
  candidates: { riskBudget: number; cash: number; kelly: number; tier: number; gap: number };
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
    gapLossBudgetDollars: 0,
    maxGapLossPctApplied: 0,
    candidates: { riskBudget: 0, cash: 0, kelly: 0, tier: 0, gap: 0 },
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
  const feeResolved = resolveFeePerContract(input.feePerContract, input.product);
  const fee = feeResolved ?? 0;
  const requestedGap = input.maxGapLossPct ?? MAX_GAP_LOSS_PCT;
  const gapPct = Number.isFinite(requestedGap) ? Math.min(MAX_GAP_LOSS_PCT, Math.max(0, requestedGap)) : 0;
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
  if (feeResolved == null) {
    return emptyResult({
      rejectReason: `fee per contract required for index options (${input.product})`,
      reasoning: ["index options carry exchange index fees on top of the broker fee; enter your all-in $ per contract per side from a trade confirmation"],
    }, ctx);
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
  const plannedB = Math.max(0, (targetGrossC - 2 * feeC) / premiumC); // T1 payoff net of round-trip fees
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

  // ── (4) Gap cap: the full premium + fees if it gaps through the stop ──────
  const gapBudgetCents = floorCents(accountSize * gapPct);
  const gapContracts = Math.floor(gapBudgetCents / maxLossC);
  reasoning.push(`gap cap: if the option gaps to zero the loss is ${fmt$(maxLossC)} per contract; ${(gapPct * 100).toFixed(2)}% of account = ${fmt$(gapBudgetCents)} -> ${gapContracts} contracts`);

  // ── (5) Conviction tier ───────────────────────────────────────────────────
  const tierMult = Math.max(0, Math.min(1, deps.tierMultiplier(grade)));
  const tierContracts = Math.floor(Math.min(riskBudgetContracts, cashContracts, kellyContracts, gapContracts) * tierMult);
  reasoning.push(`conviction tier: grade ${grade} -> ${(tierMult * 100).toFixed(0)}% size multiplier`);

  const candidates = [
    { count: riskBudgetContracts, name: "risk-floor" as const },
    { count: cashContracts, name: "cash" as const },
    { count: kellyContracts, name: "kelly-cap" as const },
    { count: gapContracts, name: "gap-cap" as const },
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
    gapLossBudgetDollars: gapBudgetCents / 100,
    maxGapLossPctApplied: gapPct,
    candidates: { riskBudget: riskBudgetContracts, cash: cashContracts, kelly: kellyContracts, tier: tierContracts, gap: gapContracts },
    winEvidence: ev,
  };
}

// ─── Master Alpha dollar-gamma sizing, capped by the premium at risk ────────

/**
 * Contracts for the Master Alpha "trade setup" (ATM long options).
 *   $Gamma per contract   = gamma_ATM x S^2 x 100 shares / 100 = gamma_ATM x S^2   ($)
 *   gamma P&L at move R   = 1/2 gamma (S R)^2 x 100 = 50 x gamma S^2 x R^2   (Hull, OFOD ch. 19, delta-gamma P&L)
 *   gamma_ATM             = phi(0) / (S sigma sqrt T)                         (r = q = 0)
 *   premium per contract  = C_ATM x 100, C_ATM = S [N(v/2) - N(-v/2)], v = sigma sqrt T
 *                           (~ 0.3989 S v; Brenner & Subrahmanyam 1988)
 * The old sizing set contracts so that the gamma P&L AT THE FORECAST move
 * equals the "risk budget", capped at 500. That never bounded the loss: a long
 * option can lose its whole premium (OCC/OIC quick guide: long call max loss =
 * premium paid), and because R^2 is tiny the gamma count is in the tens of
 * thousands, so the 500 cap almost always bound. At S = 6,700, sigma 17%,
 * T = 1 day: premium $2,378.41 per contract, 500 x $2,378.41 = $1,189,203 of
 * premium against a $1M budget. The count is now floored to the premium
 * budget too (420 contracts = $998,930), so contracts x premium <= budget.
 */
export function gammaBudgetContracts(args: {
  spot: number;
  sigma: number;        // decimal
  T: number;            // years, > 0
  rHatBps: number;      // forecast move, basis points (signed)
  riskBudgetDollars: number;
  maxContracts?: number;
}): {
  contracts: number;
  gammaContracts: number;          // gamma P&L at the forecast move = budget
  premiumCapContracts: number;     // premium at risk <= budget
  dollarGammaPerContract: number;  // gamma_ATM x S^2, $ (P&L = 50 x this x R^2)
  premiumPerContract: number;      // ATM option premium x 100, $
  binding: "gamma-target" | "premium-cap" | "max-contracts" | "none";
} {
  const { spot: S, sigma, T, rHatBps, riskBudgetDollars: B } = args;
  const cap = args.maxContracts ?? 500;
  const zero = { contracts: 0, gammaContracts: 0, premiumCapContracts: 0, dollarGammaPerContract: 0, premiumPerContract: 0, binding: "none" as const };
  if (!(S > 0) || !(sigma > 0) || !(T > 0) || !(B > 0) || !(Math.abs(rHatBps) >= 1)) return zero;
  const v = sigma * Math.sqrt(T);
  const gammaATM = 1 / (S * v * Math.sqrt(2 * Math.PI));
  const dollarGamma = gammaATM * S * S;                      // $ per contract (x100 shares / 100)
  const R = rHatBps / 10_000;
  const N = (x: number) => {
    // Abramowitz & Stegun 7.1.26
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x < 0 ? 0.5 * (1 - y) : 0.5 * (1 + y);
  };
  const premium = S * (N(v / 2) - N(-v / 2)) * 100;           // $ per contract
  const gammaContracts = Math.floor(B / (50 * dollarGamma * R * R) + 1e-9);
  const premiumCapContracts = Math.floor(B / premium + 1e-9);
  const contracts = Math.max(0, Math.min(gammaContracts, premiumCapContracts, cap));
  const binding = contracts === cap && cap < Math.min(gammaContracts, premiumCapContracts) ? "max-contracts"
    : contracts === premiumCapContracts && premiumCapContracts < gammaContracts ? "premium-cap"
    : "gamma-target";
  return { contracts, gammaContracts, premiumCapContracts, dollarGammaPerContract: dollarGamma, premiumPerContract: premium, binding };
}
