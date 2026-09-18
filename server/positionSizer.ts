// ─────────────────────────────────────────────────────────────────────────────
// positionSizer.ts — risk-first contract sizing for whale-aligned banger trades.
//
// User principles (locked from prior segments):
//   - "we need to target 30% or more trades nothing less 50-100% is ideal"
//   - "BANGERS ONLY"
//   - Risk-management focused, asymmetric returns
//   - Uses checklists for risk/entry/exit
//
// Approach: pure-function module, NO side effects, NO DB writes.
//   1) Risk-of-ruin floor: never risk more than `maxRiskPct` of account on a single trade
//   2) Stop-distance sizing: contracts = floor(risk$ / (entry - stop) / 100)
//   3) Kelly fraction cap: cap notional to fractional Kelly (default 1/4 Kelly)
//        - given p (win rate proxy from grade), b (avg win/loss ratio from BANGER target)
//        - f* = (bp - q) / b   where q = 1 - p
//        - we apply 0.25 * f* (quarter-Kelly) for safety
//   4) Conviction tier: scale notional by grade band
//        - A+ (95+): 1.00 of size  | A (85-94): 0.85  | A- (80-84): 0.70  | <80: rejected (banger floor)
// ─────────────────────────────────────────────────────────────────────────────

export interface SizingInput {
  /** Total account size in dollars */
  accountSize: number;
  /** Max % of account risked on this single trade (default 1%) */
  maxRiskPct?: number;
  /** Estimated entry price per contract (premium per share, e.g. $1.50 = $150/contract) */
  entryPrice: number;
  /** Stop price per contract (where you bail) */
  stopPrice: number;
  /** Grade score 0-100 from masterAlpha or odteAlertEngine */
  gradeScore: number;
  /** Estimated %-gain target from T1 (banger floor 30%, ideal 50-100%) */
  targetPct?: number;
  /** Optional override for Kelly fraction (0.25 = quarter Kelly default) */
  kellyFraction?: number;
}

export interface SizingResult {
  /** Recommended # of contracts */
  contracts: number;
  /** Total dollars at risk (entry - stop) * contracts * 100 */
  riskDollars: number;
  /** Total notional cost = contracts * entryPrice * 100 */
  notionalDollars: number;
  /** Kelly-capped fraction of account (decimal, e.g. 0.045 = 4.5%) */
  kellyAccountFraction: number;
  /** Reason for size cap (whichever was binding) */
  bindingConstraint: "risk-floor" | "kelly-cap" | "conviction-tier" | "min-contract";
  /** All-in payoff if T1 hits (gain%) */
  expectedPayoffPct: number;
  /** Rejection if grade < banger gate */
  rejected: boolean;
  rejectReason?: string;
  /** Plain-English breakdown — for the UI to show user */
  reasoning: string[];
}

// MISSION FIX #9 — single source of truth: the sizer gates at the SAME grade
// floor as the alert engine. It used to hardcode 80 while the engine fired at
// 72 (Wire 16), so alerts in the 72-79 band could fire but never size.
import { FIRE_GATE as ENGINE_FIRE_GATE, BANGER_MIN_PCT as ENGINE_BANGER_MIN_PCT } from "./odteAlertEngine";
import { getWinProb } from "./gradeCalibration";

const FIRE_GATE = ENGINE_FIRE_GATE;
const BANGER_MIN_PCT = ENGINE_BANGER_MIN_PCT;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Convert a 0-100 grade into a win probability (0..1).
 *  MISSION FIX #1 — now served by gradeCalibration: empirical isotonic fit
 *  over graded fires when the ledger has enough samples, legacy linear prior
 *  (80=0.50 .. 100=0.78) until then. Source is surfaced in reasoning.
 */
function gradeToWinProb(score: number): { p: number; source: "fitted" | "prior" } {
  const r = getWinProb(score);
  return { p: clamp(r.p, 0.30, 0.92), source: r.source };
}

/** Conviction tier multiplier on the size envelope. */
function tierMultiplier(score: number): number {
  if (score >= 95) return 1.00;
  if (score >= 85) return 0.85;
  if (score >= 80) return 0.70;
  if (score >= FIRE_GATE) return 0.50;  // 72-79 band: engine fires, sizer sizes small
  return 0;
}

export function sizePosition(input: SizingInput): SizingResult {
  const reasoning: string[] = [];
  const accountSize = Math.max(0, input.accountSize);
  const maxRiskPct = clamp(input.maxRiskPct ?? 0.01, 0.001, 0.05);
  const entry = Math.max(0, input.entryPrice);
  const stop = Math.max(0, input.stopPrice);
  const grade = clamp(input.gradeScore, 0, 100);
  const target = Math.max(BANGER_MIN_PCT, input.targetPct ?? BANGER_MIN_PCT);
  const kellyFrac = clamp(input.kellyFraction ?? 0.25, 0.05, 1.0);

  // ── Hard rejections ──────────────────────────────────────────────────────
  if (grade < FIRE_GATE) {
    return {
      contracts: 0,
      riskDollars: 0,
      notionalDollars: 0,
      kellyAccountFraction: 0,
      bindingConstraint: "conviction-tier",
      expectedPayoffPct: 0,
      rejected: true,
      rejectReason: `grade ${grade} < FIRE_GATE ${FIRE_GATE} (banger floor)`,
      reasoning: [`grade ${grade} below ${FIRE_GATE} — no banger, no size`],
    };
  }
  if (target < BANGER_MIN_PCT) {
    return {
      contracts: 0,
      riskDollars: 0,
      notionalDollars: 0,
      kellyAccountFraction: 0,
      bindingConstraint: "conviction-tier",
      expectedPayoffPct: target,
      rejected: true,
      rejectReason: `T1 ${target}% < ${BANGER_MIN_PCT}% banger floor`,
      reasoning: [`target +${target}% below ${BANGER_MIN_PCT}% banger floor`],
    };
  }
  if (entry <= 0 || stop < 0 || stop >= entry) {
    return {
      contracts: 0,
      riskDollars: 0,
      notionalDollars: 0,
      kellyAccountFraction: 0,
      bindingConstraint: "risk-floor",
      expectedPayoffPct: 0,
      rejected: true,
      rejectReason: `invalid entry/stop: entry=${entry}, stop=${stop}`,
      reasoning: [`stop must be below entry and both > 0`],
    };
  }
  if (accountSize <= 0) {
    return {
      contracts: 0,
      riskDollars: 0,
      notionalDollars: 0,
      kellyAccountFraction: 0,
      bindingConstraint: "risk-floor",
      expectedPayoffPct: 0,
      rejected: true,
      rejectReason: "account size must be > 0",
      reasoning: ["account size required"],
    };
  }

  // ── (1) Risk-floor sizing ────────────────────────────────────────────────
  const stopDistancePerContract = (entry - stop) * 100;  // $ per contract
  const maxRiskDollars = accountSize * maxRiskPct;
  const riskFloorContracts = Math.floor(maxRiskDollars / stopDistancePerContract);
  reasoning.push(
    `risk floor: ${(maxRiskPct * 100).toFixed(2)}% of $${accountSize.toLocaleString()} = $${maxRiskDollars.toFixed(0)} max risk → ${riskFloorContracts} contracts`,
  );

  // ── (2) Kelly cap ────────────────────────────────────────────────────────
  const wp = gradeToWinProb(grade);
  const p = wp.p;
  const q = 1 - p;
  reasoning.push(`win probability: ${(p * 100).toFixed(0)}% (${wp.source === "fitted" ? "empirically fitted from graded fires" : "prior — ledger still filling, not yet fitted"})`);
  const b = target / 100;  // payoff ratio at T1 (e.g. +50% → b=0.5; loss = 100% premium)
  // Standard Kelly assumes loss = full premium. Our stop limits loss to (entry-stop)/entry.
  // Use stop-adjusted Kelly: lossFrac = (entry - stop) / entry per contract
  const lossFrac = (entry - stop) / entry;
  const kellyStar = (b * p - q * lossFrac) / (b * lossFrac);
  const cappedKelly = Math.max(0, kellyFrac * kellyStar);
  const kellyMaxNotional = accountSize * cappedKelly;
  const kellyContracts = entry > 0 ? Math.floor(kellyMaxNotional / (entry * 100)) : 0;
  reasoning.push(
    `kelly: p=${p.toFixed(2)}, b=${b.toFixed(2)}, loss=${lossFrac.toFixed(2)} → f*=${kellyStar.toFixed(3)}, ${(kellyFrac * 100).toFixed(0)}%-Kelly = ${(cappedKelly * 100).toFixed(2)}% of acct → ${kellyContracts} contracts`,
  );

  // ── (3) Conviction tier scaling ──────────────────────────────────────────
  const tierMult = tierMultiplier(grade);
  const tierContracts = Math.floor(Math.min(riskFloorContracts, kellyContracts) * tierMult);
  reasoning.push(`conviction tier: grade ${grade} → ${(tierMult * 100).toFixed(0)}% size multiplier`);

  // ── Final binding constraint ─────────────────────────────────────────────
  const candidates = [
    { count: riskFloorContracts, name: "risk-floor" as const },
    { count: kellyContracts, name: "kelly-cap" as const },
    { count: tierContracts, name: "conviction-tier" as const },
  ];
  // Pick the SMALLEST (most conservative)
  candidates.sort((a, b) => a.count - b.count);
  const chosen = candidates[0];
  let contracts = Math.max(0, chosen.count);

  // Ensure we don't size to 0 silently when the user is too small for even 1 contract
  let bindingConstraint: SizingResult["bindingConstraint"] = chosen.name;
  if (contracts === 0) {
    bindingConstraint = "min-contract";
    reasoning.push(`account too small for risk floor — needs ≥ $${stopDistancePerContract.toFixed(0)} risk per contract`);
  }

  const riskDollars = contracts * stopDistancePerContract;
  const notionalDollars = contracts * entry * 100;
  const kellyAccountFraction = accountSize > 0 ? notionalDollars / accountSize : 0;

  return {
    contracts,
    riskDollars: Math.round(riskDollars),
    notionalDollars: Math.round(notionalDollars),
    kellyAccountFraction: Number(kellyAccountFraction.toFixed(4)),
    bindingConstraint,
    expectedPayoffPct: target,
    rejected: false,
    reasoning,
  };
}
