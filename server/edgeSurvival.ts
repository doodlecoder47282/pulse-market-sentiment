/**
 * Edge survival: does the edge survive the costs of expressing it?
 * Rebuilt on the realized option ledger (round-2 item 8, sector 8).
 *
 * The old card took p from the UNDERLYING first-touch win rate (or a hand-set
 * prior when the ledger was thin), multiplied it by the option target/stop,
 * then charged theta linearly at theta/390 per minute. It could say EXPRESS
 * while the sizer, which bets on the realized option ledger, sized zero.
 *
 * Now the evidence is the same ledger the sizer uses (odteGrader.
 * loadOptionLedgerBucket: fired 0DTE alerts replayed on logged Schwab marks,
 * ask in, bid out, net of the per-contract fee). Those realized returns
 * already contain the spread paid, the theta that decayed during the hold
 * and the fees, so they are not charged twice:
 *
 *   gross EV   = realized mean net return of the grade bucket (point estimate)
 *              = p_hat x avgWin - (1 - p_hat) x avgLoss
 *   - model uncertainty: p at the Wilson 95% lower bound (Wilson 1927;
 *     Brown, Cai & DasGupta 2001), same rule as kellyFromLedger
 *   - plan caps: b = min(planned T1 payoff, realized avgWin),
 *     L = max(planned stop loss, realized avgLoss) (the sizer's b and L)
 *   = net EV   = p_lo x b - (1 - p_lo) x L: the expected value the sizer's
 *                binary Kelly sees, so net EV > 0 <=> Kelly f > 0.
 *   adverse    = net EV - an exit spread twice as wide (one more half-spread)
 *                - theta for a hold 50% longer, by Black-Scholes repricing on
 *                the session clock (chainClock / timeToExpiry; sigma solved
 *                from the quote mid inside 3 days), not theta x minutes/390.
 *
 * Verdicts:
 *   INSUFFICIENT_EVIDENCE  no ledger bucket / no graded fires, or the point
 *                          EV is positive but not at the Wilson lower bound;
 *   STAND_DOWN             the realized ledger shows no edge after costs;
 *   MARGINAL               net EV > 0 but the adverse case fails, or theta
 *                          could not be repriced (no contract inputs);
 *   EXPRESS                net EV > 0, Kelly sizes > 0 and the adverse case
 *                          survives. Never without ledger evidence.
 * Scores are heuristics; nothing here is a calibrated probability.
 */

import {
  kellyFromLedger, DEFAULT_KELLY_FRACTION, type KellyEvidence, type OptionLedgerBucket,
} from "./validationMath";
import { roundTripFeePct } from "./sizingMath";
import { ivForClock } from "./chainClock";
import { settlementStyleOf, timeToExpiry } from "./timeToExpiry";
import { bsPrice } from "./greeks";

export interface EdgeSurvivalInput {
  gradeScore: number;
  /** contract quote, $ per share */
  bid: number;
  ask: number;
  /** projected T1 option gain, percent (e.g. 45 = +45%) */
  targetPct: number;
  /** stop as percent loss on contract (positive number, e.g. 20 = -20%) */
  stopPct: number;
  /** vendor theta ($ per share per day). Display only: theta is repriced, never theta x minutes/390. */
  theta?: number | null;
  /** expected hold in minutes (default 45 for 0DTE reversion setups) */
  expectedHoldMin?: number;
  /** all-in fee, $ per contract per side (commission + exchange fees). Omitted = not counted, and the row says so. */
  feePerContract?: number | null;
  /** Contract inputs for repriced theta (all optional; without them theta is not repriced). */
  spot?: number | null;
  strike?: number | null;
  type?: "C" | "P" | null;
  expiry?: string | null;        // YYYY-MM-DD
  symbol?: string | null;        // OCC/Schwab symbol: SPX (AM) vs SPXW (PM) settlement
  iv?: number | null;            // vendor IV, decimal (used only when sigma cannot be solved from the mid)
  nowMs?: number;
}

export interface EdgeSurvivalRow { label: string; pct: number; note: string }

export type EdgeSurvivalVerdict = "EXPRESS" | "MARGINAL" | "STAND_DOWN" | "INSUFFICIENT_EVIDENCE";

export interface EdgeSurvivalResult {
  /** Realized mean net return of the bucket, % of premium (null without evidence). */
  grossEvPct: number;
  /** Deductions from gross to net (model uncertainty, plan caps). */
  rows: EdgeSurvivalRow[];
  /** p_lo x b - (1 - p_lo) x L, % of premium: what the sizer's Kelly sees. */
  netEvPct: number;
  /** Net EV under the stress rows; null when theta could not be repriced. */
  adverseNetEvPct: number | null;
  /** Stress deductions applied to reach the adverse case. */
  stress: EdgeSurvivalRow[];
  /** Costs of THIS quote, for reference: already inside the realized ledger returns, not deducted again. */
  reference: EdgeSurvivalRow[];
  verdict: EdgeSurvivalVerdict;
  pUsed: number;
  pSource: "ledger_wilson_lower_bound" | "ledger_point_estimate" | "no_evidence";
  evidence: {
    bucket: string | null;
    n: number;
    wins: number;
    wilsonLo: number | null;
    wilsonHi: number | null;
    b: number | null;
    L: number | null;
    kellyFStar: number | null;
    kellyApplied: number | null;
    feesCounted: boolean;
  };
  theta: { source: "repriced_black_scholes" | "not_repriced"; holdCostPct: number | null; extraHoldCostPct: number | null; note: string };
  note: string;
}

/**
 * Theta over a hold by full repricing, $ per share (negative = cost):
 * P(S, sigma, T - hold) - P(S, sigma, T) with S and sigma held, T on the
 * calendar-minute clock to the real settlement instant (timeToExpiry). A
 * contract that settles inside the hold is worth intrinsic at the end of it
 * (Hull, OFOD, ch. 11). sigma is re-solved from the mid inside 3 days
 * (chainClock.ivForClock). Null when inputs are missing or sigma is unusable.
 */
export function repricedThetaOverHold(args: {
  spot: number; strike: number; type: "C" | "P"; expiry: string; symbol?: string | null;
  bid: number; ask: number; vendorIv?: number | null; holdMin: number; nowMs: number;
}): { cost: number; T: number; sigma: number; settlesWithinHold: boolean } | null {
  const { spot, strike, type } = args;
  if (!(spot > 0) || !(strike > 0) || !(args.holdMin >= 0) || !/^\d{4}-\d{2}-\d{2}$/.test(args.expiry)) return null;
  const tte = timeToExpiry(args.expiry, { nowMs: args.nowMs, style: settlementStyleOf(args.symbol ?? null) });
  if (tte.expired || !(tte.years > 0)) return null;
  const T = tte.years;
  const sigma = ivForClock({ vendorIv: args.vendorIv != null && args.vendorIv > 0 ? args.vendorIv : NaN, bid: args.bid, ask: args.ask, spot, strike, T, type });
  if (!(sigma > 0) || !Number.isFinite(sigma)) return null;
  const pNow = bsPrice(spot, strike, sigma, T, 0, 0, type);
  const holdEnd = args.nowMs + args.holdMin * 60_000;
  const settles = tte.settlementMs <= holdEnd;
  const tH = settles ? 0 : T - args.holdMin / 525_600;
  const intrinsic = type === "C" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const pH = tH > 1e-12 ? bsPrice(spot, strike, sigma, tH, 0, 0, type) : intrinsic;
  const cost = pH - pNow;
  return Number.isFinite(cost) ? { cost: Math.min(0, cost), T, sigma, settlesWithinHold: settles } : null;
}

const r1 = (x: number) => Number(x.toFixed(1));

export function computeEdgeSurvival(inp: EdgeSurvivalInput, bucket: OptionLedgerBucket | null): EdgeSurvivalResult {
  const ask = Math.max(0, inp.ask);
  const bid = Math.max(0, inp.bid);
  const mid = (ask + bid) / 2;
  const target = Math.max(0, inp.targetPct);
  const stop = Math.max(0, inp.stopPct);
  const holdMin = Math.max(5, inp.expectedHoldMin ?? 45);
  const nowMs = inp.nowMs ?? Date.now();
  const feePct = roundTripFeePct(inp.feePerContract, ask); // % of premium, both sides
  const feesCounted = feePct != null;

  // ── Reference costs of this quote (inside realized returns, not deducted) ─
  const reference: EdgeSurvivalRow[] = [];
  const spreadPct = ask > 0 ? ((ask - bid) / ask) * 100 : null;
  reference.push({
    label: "spread (ask in, bid out)",
    pct: spreadPct != null ? -r1(spreadPct) : 0,
    note: spreadPct != null ? `${spreadPct.toFixed(1)}% of the premium at this quote; the ledger fills at real asks and bids` : "no quote",
  });
  reference.push({
    label: "fees (round trip)",
    pct: -r1(feePct ?? 0),
    note: feePct != null
      ? `$${(inp.feePerContract as number).toFixed(2)}/contract/side x 2 on a $${(ask * 100).toFixed(2)} premium; ledger returns are net of it`
      : "fee not given: not counted, ledger returns are gross (index options carry exchange fees on top of commission)",
  });
  let thetaHold: ReturnType<typeof repricedThetaOverHold> = null;
  let thetaLong: ReturnType<typeof repricedThetaOverHold> = null;
  if (inp.spot != null && inp.strike != null && inp.type && inp.expiry) {
    const base = { spot: inp.spot, strike: inp.strike, type: inp.type, expiry: inp.expiry, symbol: inp.symbol, bid, ask, vendorIv: inp.iv, nowMs };
    thetaHold = repricedThetaOverHold({ ...base, holdMin });
    thetaLong = repricedThetaOverHold({ ...base, holdMin: holdMin * 1.5 });
  }
  const thetaHoldPct = thetaHold && ask > 0 ? (thetaHold.cost / ask) * 100 : null;
  const extraThetaPct = thetaHold && thetaLong && ask > 0 ? ((thetaLong.cost - thetaHold.cost) / ask) * 100 : null; // <= 0
  reference.push({
    label: `theta (${holdMin} min hold)`,
    pct: thetaHoldPct != null ? r1(thetaHoldPct) : 0,
    note: thetaHold
      ? `Black-Scholes repricing to the end of the hold (sigma ${(thetaHold.sigma * 100).toFixed(1)}%${thetaHold.settlesWithinHold ? ", settles inside the hold: all extrinsic" : ""}); realized returns already carry it`
      : "not repriced: send spot, strike, type and expiry",
  });

  // ── Evidence: the realized option ledger, as the sizer reads it ──────────
  const plannedB = Math.max(0, target / 100 - (feePct ?? 0) / 100);
  const plannedL = Math.min(1, stop / 100 + (feePct ?? 0) / 100);
  const ev: KellyEvidence | null = bucket ? kellyFromLedger({ bucket, plannedB, plannedL, kellyFraction: DEFAULT_KELLY_FRACTION }) : null;
  const n = bucket ? Math.max(0, Math.floor(bucket.n)) : 0;
  const wins = bucket ? Math.max(0, Math.min(n, Math.floor(bucket.wins))) : 0;
  const theta = {
    source: (thetaHold ? "repriced_black_scholes" : "not_repriced") as EdgeSurvivalResult["theta"]["source"],
    holdCostPct: thetaHoldPct != null ? r1(thetaHoldPct) : null,
    extraHoldCostPct: extraThetaPct != null ? r1(extraThetaPct) : null,
    note: thetaHold ? "repriced on the session clock (chainClock / timeToExpiry)" : "contract inputs missing: the adverse case cannot be computed",
  };
  const evidence: EdgeSurvivalResult["evidence"] = {
    bucket: bucket?.label ?? null, n, wins,
    wilsonLo: ev && n > 0 ? ev.wilsonLo : null,
    wilsonHi: ev && n > 0 ? ev.wilsonHi : null,
    b: ev ? ev.b : null, L: ev ? ev.L : null,
    kellyFStar: ev && Number.isFinite(ev.fStar) ? ev.fStar : null,
    kellyApplied: ev ? ev.fApplied : null,
    feesCounted,
  };

  const insufficient = (why: string): EdgeSurvivalResult => ({
    grossEvPct: 0, rows: [], netEvPct: 0, adverseNetEvPct: null, stress: [], reference,
    verdict: "INSUFFICIENT_EVIDENCE", pUsed: ev ? ev.p : 0, pSource: "no_evidence", evidence, theta,
    note: why,
  });
  if (!bucket) return insufficient("no ledger bucket for this score (below the fire gate): no evidence of edge");
  if (n === 0) return insufficient(`no option-graded fires in bucket ${bucket.label}: insufficient evidence, the sizer sizes 0`);

  const avgWin = bucket.avgWinReturn ?? 0;
  const avgLoss = bucket.avgLossReturn ?? 0;
  const pHat = wins / n;
  const pointEv = pHat * avgWin - (1 - pHat) * avgLoss; // = realized mean net return
  const pLo = ev!.p;
  const evAtPlo = pLo * avgWin - (1 - pLo) * avgLoss;
  const netEv = pLo * ev!.b - (1 - pLo) * ev!.L;
  const rows: EdgeSurvivalRow[] = [
    {
      label: "model uncertainty",
      pct: -r1(Math.max(0, (pointEv - evAtPlo) * 100)),
      note: ev!.pSource === "point_estimate"
        ? `${n} fires: point win rate used`
        : `p ${(pHat * 100).toFixed(0)}% -> Wilson 95% lower bound ${(pLo * 100).toFixed(0)}% (${wins}/${n})`,
    },
    {
      label: "plan caps (sizer b and L)",
      pct: -r1(Math.max(0, (evAtPlo - netEv) * 100)),
      note: `b = min(planned ${(plannedB * 100).toFixed(0)}%, realized ${(avgWin * 100).toFixed(0)}%), L = max(planned ${(plannedL * 100).toFixed(0)}%, realized ${(avgLoss * 100).toFixed(0)}%)`,
    },
  ];
  const halfSpreadPct = ask > 0 && mid > 0 ? ((ask - bid) / 2 / ask) * 100 : 0;
  const stress: EdgeSurvivalRow[] = [
    { label: "exit spread 2x wide", pct: -r1(halfSpreadPct), note: "one more half-spread on the exit" },
    {
      label: `hold 50% longer (${Math.round(holdMin * 1.5)} min)`,
      pct: extraThetaPct != null ? r1(extraThetaPct) : 0,
      note: extraThetaPct != null ? "extra theta by repricing" : "theta not repriced: adverse case not computed",
    },
  ];
  const adverse = extraThetaPct != null ? netEv * 100 - halfSpreadPct + extraThetaPct : null;
  const kellyPositive = (ev!.fApplied ?? 0) > 0;

  let verdict: EdgeSurvivalVerdict;
  let note: string;
  if (!(pointEv > 0)) {
    verdict = "STAND_DOWN";
    note = `the realized ledger (${n} fires, bucket ${bucket.label}) shows no edge after costs: mean ${(pointEv * 100).toFixed(1)}% per trade`;
  } else if (!(netEv > 0) || !kellyPositive) {
    verdict = "INSUFFICIENT_EVIDENCE";
    note = `realized mean is positive but not at the Wilson lower bound with ${n} fires: the sizer sizes 0`;
  } else if (adverse == null) {
    verdict = "MARGINAL";
    note = "ledger edge survives at the lower bound; adverse case not computed (theta not repriced without contract inputs)";
  } else if (!(adverse > 0)) {
    verdict = "MARGINAL";
    note = "ledger edge survives the base case only: dies under a wider exit spread and a longer hold. size down or pass";
  } else {
    verdict = "EXPRESS";
    note = `ledger edge survives at the Wilson lower bound and under the adverse case (${n} fires). still a heuristic, not a calibrated probability`;
  }
  if (!feesCounted) note += "; fees not counted";

  return {
    grossEvPct: r1(pointEv * 100),
    rows,
    netEvPct: r1(netEv * 100),
    adverseNetEvPct: adverse != null ? r1(adverse) : null,
    stress,
    reference,
    verdict,
    pUsed: Number(pLo.toFixed(3)),
    pSource: ev!.pSource === "point_estimate" ? "ledger_point_estimate" : "ledger_wilson_lower_bound",
    evidence,
    theta,
    note,
  };
}
