// ─────────────────────────────────────────────────────────────────────────────
// positionSizer.ts — risk-first contract sizing for long 0DTE option trades.
//
// User principles (locked from prior segments):
//   - "we need to target 30% or more trades nothing less 50-100% is ideal"
//   - Risk-management focused, asymmetric returns
//
// The dollar math lives in sizingMath.ts (pure, unit-tested). This wrapper
// supplies the grade gate, the conviction tier and the evidence:
//   1) Risk budget: contracts x (loss at stop incl. stop slippage and
//      round-trip fees) <= account x maxRiskPct. Rounded DOWN to whole contracts.
//   2) Cash: contracts x (premium + opening fee) <= account (long options are
//      paid in full).
//   3) Kelly cap: f* = p/L - q/b (Thorp 2006) with p = Wilson 95% lower bound
//      of the REALIZED option win rate in the grade's bucket of the 0DTE
//      option-P&L ledger (odteGrader), b and L from the same ledger. The
//      point win rate is used only once a bucket has 385 graded fires.
//      Fractional Kelly capped at one half.
//   4) Gap cap: full premium + fees if the option gaps to zero <= account x
//      maxGapLossPct (default and ceiling 5%).
//   5) Conviction tier scales the envelope by grade band.
// The smallest wins.
//
// GRADE GATE (review item 6.4; the Field Manual "trade-desk" entry in
// client/src/components/EdgeInfo.tsx states the same rule — keep them in sync):
//   grade < FIRE_GATE (= odteAlertEngine.MIN_FIRE_SCORE = 72, letter B-): no size.
//   tier multiplier on the envelope:
//     72-79 -> 0.50   80-84 -> 0.70   85-94 -> 0.85   95+ -> 1.00
// The old Field Manual said grades below 80 are rejected; the code has sized
// from 72 at half size since Wire 16, and that is the documented rule now.
//
// Units: entryPrice and stopPrice are $ per share (premium as quoted); one
// contract = 100 x that. Dollar outputs are for the whole position.
// ─────────────────────────────────────────────────────────────────────────────

import { FIRE_GATE as ENGINE_FIRE_GATE, BANGER_MIN_PCT as ENGINE_BANGER_MIN_PCT } from "./odteAlertEngine";
import { loadOptionLedgerBucket } from "./odteGrader";
import { sizeLongOption, resolveFeePerContract, type CoreSizingResult } from "./sizingMath";

export interface SizingInput {
  /** Total account size in dollars */
  accountSize: number;
  /** Max fraction of account risked on this single trade (default 0.01 = 1%, ceiling 0.05) */
  maxRiskPct?: number;
  /**
   * Expected entry FILL, $ per share (e.g. 1.55 = $155 per contract): the ask
   * for a market buy, NOT the mid. The Trade Desk card converts its mid input
   * with shared/sizerRequest.ts (ask = mid + spread/2).
   */
  entryPrice: number;
  /** Stop price, $ per share */
  stopPrice: number;
  /** Grade score 0-100 from odteAlertEngine */
  gradeScore: number;
  /** %-gain target at T1 (floor 30) */
  targetPct?: number;
  /** Fractional Kelly (0.25 = quarter Kelly default, capped at 0.5) */
  kellyFraction?: number;
  /** Commission + exchange fees, $ per contract per side. Default 0.65 (Schwab) for equity/ETF options; REQUIRED for index roots (SPX, SPXW, XSP, ...). */
  feePerContract?: number;
  /** Option root, e.g. "SPXW" or "SPY". */
  product?: string;
  /** Max loss if the option gaps to zero, fraction of account (default and ceiling 0.05). */
  maxGapLossPct?: number;
  /** Expected fill below the stop, $ per share (e.g. half the bid-ask spread). Default 0. */
  stopSlippage?: number;
  /** Contract multiplier (default 100: SPX, SPXW, XSP, SPY, QQQ, equity options) */
  multiplier?: number;
}

export type SizingResult = CoreSizingResult;

// MISSION FIX #9 — single source of truth: the sizer gates at the SAME grade
// floor as the alert engine.
const FIRE_GATE = ENGINE_FIRE_GATE;
const BANGER_MIN_PCT = ENGINE_BANGER_MIN_PCT;

/** Conviction tier multiplier on the size envelope. */
function tierMultiplier(score: number): number {
  if (score >= 95) return 1.00;
  if (score >= 85) return 0.85;
  if (score >= 80) return 0.70;
  if (score >= FIRE_GATE) return 0.50;  // 72-79 band: engine fires, sizer sizes small
  return 0;
}

export function sizePosition(input: SizingInput): SizingResult {
  let ledger = null;
  // The ledger's realized returns are taken net of the same fee the trade will pay.
  const fee = resolveFeePerContract(input.feePerContract, input.product) ?? 0;
  try { ledger = loadOptionLedgerBucket(input.gradeScore, Date.now(), fee); } catch { ledger = null; }
  return sizeLongOption(input, {
    fireGate: FIRE_GATE,
    bangerMinPct: BANGER_MIN_PCT,
    ledger,
    tierMultiplier,
  });
}
