/**
 * MISSION FIX #2 — Edge survival: does the theoretical edge survive the costs
 * of expressing it?
 *
 * A 12% theoretical edge that costs 8% to enter and exit is not a 12% edge.
 * This module takes a graded setup + its contract quote and produces an
 * itemized waterfall:
 *
 *   gross EV (grade-implied p x payoff structure)
 *     - spread cost        (full bid/ask spread as % of mid — you pay it round-trip)
 *     - slippage           (depth-blind estimate: half-spread again on exit urgency)
 *     - theta cost         (contract theta bleed over the expected hold)
 *     - model uncertainty  (haircut p to the Wilson lower bound of its bucket)
 *   = net EV, plus a 1-sigma adverse scenario (wider spread, longer hold).
 *
 * Verdict: EXPRESS when net EV > 0 in base case, MARGINAL when base > 0 but
 * adverse <= 0, STAND_DOWN when base <= 0.
 */

import { getWinProb, getCalibrationReport } from "./gradeCalibration";

export interface EdgeSurvivalInput {
  gradeScore: number;
  /** contract quote */
  bid: number;
  ask: number;
  /** projected T1 option gain, percent (e.g. 45 = +45%) */
  targetPct: number;
  /** stop as percent loss on contract (positive number, e.g. 20 = -20%) */
  stopPct: number;
  /** contract theta ($ per day, negative) and mid price for theta% conversion */
  theta?: number | null;
  /** expected hold in minutes (default 45 for 0DTE reversion setups) */
  expectedHoldMin?: number;
}

export interface EdgeSurvivalRow { label: string; pct: number; note: string }

export interface EdgeSurvivalResult {
  grossEvPct: number;
  rows: EdgeSurvivalRow[];
  netEvPct: number;
  adverseNetEvPct: number;
  verdict: "EXPRESS" | "MARGINAL" | "STAND_DOWN";
  pUsed: number;
  pSource: "fitted" | "prior";
  note: string;
}

export function computeEdgeSurvival(inp: EdgeSurvivalInput): EdgeSurvivalResult {
  const mid = (Math.max(0, inp.bid) + Math.max(0, inp.ask)) / 2;
  const { p, source } = getWinProb(inp.gradeScore);

  const target = Math.max(1, inp.targetPct);
  const stop = Math.max(1, inp.stopPct);

  // Gross EV in contract-% terms
  const grossEv = p * target - (1 - p) * stop;

  const rows: EdgeSurvivalRow[] = [];

  // 1. Spread: you cross it going in; assume you cross it again coming out.
  const spreadPct = mid > 0 ? ((inp.ask - inp.bid) / mid) * 100 : 8;
  const spreadCost = Math.max(0, spreadPct);
  rows.push({
    label: "spread (round trip)",
    pct: -spreadCost,
    note: mid > 0 ? `${spreadPct.toFixed(1)}% wide at quote` : "no quote — assumed 8%",
  });

  // 2. Slippage: urgency exits eat roughly another half-spread.
  const slippage = spreadCost * 0.5;
  rows.push({ label: "slippage (urgency exit)", pct: -slippage, note: "half-spread again on the way out" });

  // 3. Theta over the expected hold.
  const holdMin = Math.max(5, inp.expectedHoldMin ?? 45);
  let thetaCost = 0;
  if (inp.theta != null && isFinite(inp.theta) && mid > 0) {
    const thetaPctPerDay = (Math.abs(inp.theta) / mid) * 100;
    thetaCost = thetaPctPerDay * (holdMin / 390); // trading-day fraction
  } else {
    thetaCost = 0.06 * holdMin; // 0DTE fallback: ~6%/100min decay heuristic near the money
  }
  rows.push({ label: `theta (${holdMin} min hold)`, pct: -thetaCost, note: inp.theta != null ? "from contract theta" : "0DTE decay heuristic — no theta on quote" });

  // 4. Model uncertainty: recompute EV at the Wilson lower bound of the bucket.
  const rep = getCalibrationReport();
  const bucket = rep.buckets.find((b) => inp.gradeScore >= b.lo && inp.gradeScore <= b.hi);
  const pAdverse = bucket?.wilsonLo != null && bucket.n >= 8
    ? Math.min(p, bucket.wilsonLo)
    : Math.max(0.30, p - 0.08); // no data: 8-point probability haircut
  const evAtAdverseP = pAdverse * target - (1 - pAdverse) * stop;
  const uncertaintyCost = Math.max(0, grossEv - evAtAdverseP);
  rows.push({
    label: "model uncertainty",
    pct: -uncertaintyCost,
    note: bucket?.wilsonLo != null && bucket.n >= 8
      ? `p haircut to Wilson lower bound ${(pAdverse * 100).toFixed(0)}%`
      : `p haircut -8pts (bucket has ${bucket?.n ?? 0} graded samples)`,
  });

  const totalCosts = rows.reduce((s, r) => s + r.pct, 0); // negative
  const netEv = grossEv + totalCosts;

  // Adverse scenario: spread 1.5x wider, hold 1.5x longer, p at lower bound.
  const advSpread = spreadCost * 1.5 + spreadCost * 0.75;
  const advTheta = thetaCost * 1.5;
  const adverseNetEv = evAtAdverseP - advSpread - advTheta;

  const verdict: EdgeSurvivalResult["verdict"] =
    netEv <= 0 ? "STAND_DOWN" : adverseNetEv <= 0 ? "MARGINAL" : "EXPRESS";

  return {
    grossEvPct: Number(grossEv.toFixed(1)),
    rows: rows.map((r) => ({ ...r, pct: Number(r.pct.toFixed(1)) })),
    netEvPct: Number(netEv.toFixed(1)),
    adverseNetEvPct: Number(adverseNetEv.toFixed(1)),
    verdict,
    pUsed: Number(p.toFixed(3)),
    pSource: source,
    note: verdict === "EXPRESS"
      ? "edge survives costs in base and adverse cases"
      : verdict === "MARGINAL"
        ? "edge survives base case only — dies under adverse execution. size down or pass"
        : "costs eat the edge — do not express this trade",
  };
}
