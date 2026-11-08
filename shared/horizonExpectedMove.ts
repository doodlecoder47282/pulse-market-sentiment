// shared/horizonExpectedMove.ts
//
// The expected move (1 standard deviation of the close at the END of a model
// horizon) that the scenario targets are capped to and the scenario odds are
// read against. Pure.
//
// Why this exists: the audit's scenario targets used to be built from the
// 1-DAY expected move for every horizon, then a route post-processor replaced
// the weekly/monthly/quarterly targets with a VIX cone AFTER the risk-neutral
// odds had already been read at the 1-day targets. So a weekly card showed
// odds of the WEEK closing beyond a ONE-DAY band next to targets a week wide:
// the numbers were about different events. Now the horizon's own expected
// move is chosen first, the targets are capped to it, and the odds are read
// at exactly those targets from the same distribution.
//
// Source preference per horizon, best first; every output names its source.
//   daily      0DTE ATM straddle (prices the residual session exactly), else
//              VIX-implied ATM vol x sqrt(1/252) x 0.55 (hand-set residual-
//              session factor), else 1% x 0.55.
//   others     the SVI-smoothed implied distribution of the horizon's expiry
//              (atmTotalVol = sigma_ATM sqrt(T): the SAME distribution the odds
//              are read from), else VIX-implied ATM vol x sqrt(days/252)
//              (weekly: VIX9D x sqrt(7/365) when available, the term-structure
//              point nearest that horizon), else 1% x sqrt(days).
//              The quarterly VIX fallback keeps the 0.85 mean-reversion damp the
//              route used to apply (hand-set; stated in the note).

import { vixToAtmPct } from "./vol";

export type EmHorizon = "daily" | "weekly" | "monthly" | "quarterly";

export const HORIZON_TRADING_DAYS: Record<EmHorizon, number> = { daily: 1, weekly: 5, monthly: 21, quarterly: 63 };

/** Hand-set factors carried over from the previous code, named so the note can state them. */
export const RESIDUAL_SESSION_FACTOR = 0.55;
export const QUARTERLY_MEAN_REVERSION_DAMP = 0.85;

export type EmSource = "0dte-straddle" | "implied-atm" | "vix-scaled" | "fixed-fallback";

export interface HorizonExpectedMove {
  /** 1 standard deviation of the close at the horizon's end, index points. */
  oneSigma: number;
  source: EmSource;
  horizon: EmHorizon;
  days: number;
  /** Expiry the implied figure refers to (implied-atm), else null. */
  expiry: string | null;
  straddleMid: number | null;
  strike: number | null;
  note: string;
}

export interface HorizonEmInputs {
  spot: number;
  horizon: EmHorizon;
  /** VIX-style level (percent annualised) or null. */
  vix: number | null;
  /** VIX9D level or null (weekly fallback only). */
  vix9d?: number | null;
  /** Same-day ATM straddle read, daily only. */
  straddle?: { oneSigmaMove: number; straddleMid: number; strike: number } | null;
  /** The horizon expiry's implied distribution, when one was fitted and accepted for the odds. */
  implied?: { atmTotalVol: number; expiry: string } | null;
}

const r2 = (x: number) => parseFloat(x.toFixed(2));

export function horizonExpectedMove(i: HorizonEmInputs): HorizonExpectedMove {
  const { spot, horizon } = i;
  const days = HORIZON_TRADING_DAYS[horizon];
  const vix = i.vix != null && Number.isFinite(i.vix) && i.vix > 0 ? i.vix : null;
  const base = { horizon, days, straddleMid: null as number | null, strike: null as number | null, expiry: null as string | null };

  if (horizon === "daily") {
    const s = i.straddle;
    if (s && Number.isFinite(s.oneSigmaMove) && s.oneSigmaMove > 0) {
      return { ...base, oneSigma: r2(s.oneSigmaMove), source: "0dte-straddle", straddleMid: r2(s.straddleMid), strike: s.strike,
        note: "1 sigma to the close from the 0DTE ATM straddle mid (straddle ~ 0.8 sigma S sqrt T)" };
    }
    if (vix != null) {
      return { ...base, oneSigma: r2(spot * (vixToAtmPct(vix) / 100) * Math.sqrt(1 / 252) * RESIDUAL_SESSION_FACTOR), source: "vix-scaled",
        note: `fallback: VIX-implied ATM vol x sqrt(1/252) x ${RESIDUAL_SESSION_FACTOR} (hand-set residual-session factor); no same-day straddle` };
    }
    return { ...base, oneSigma: r2(spot * 0.01 * RESIDUAL_SESSION_FACTOR), source: "fixed-fallback",
      note: `fallback: fixed 1% x ${RESIDUAL_SESSION_FACTOR} (VIX and same-day straddle unavailable)` };
  }

  const imp = i.implied;
  if (imp && Number.isFinite(imp.atmTotalVol) && imp.atmTotalVol > 0) {
    return { ...base, oneSigma: r2(spot * imp.atmTotalVol), source: "implied-atm", expiry: imp.expiry,
      note: `about 1 sigma to the ${imp.expiry} close: spot x the SVI-smoothed at-the-money total vol of that expiry (a log-return vol about the forward, so the band is centred on spot as an approximation; the same distribution the odds are read from)` };
  }
  const damp = horizon === "quarterly" ? QUARTERLY_MEAN_REVERSION_DAMP : 1;
  const dampNote = horizon === "quarterly" ? ` x ${QUARTERLY_MEAN_REVERSION_DAMP} (hand-set mean-reversion damp)` : "";
  const vix9d = i.vix9d != null && Number.isFinite(i.vix9d) && i.vix9d > 0 ? i.vix9d : null;
  if (horizon === "weekly" && vix9d != null) {
    return { ...base, oneSigma: r2(spot * (vixToAtmPct(vix9d) / 100) * Math.sqrt(7 / 365)), source: "vix-scaled",
      note: "fallback: VIX9D-implied ATM vol x sqrt(7/365); no accepted implied distribution for the weekly expiry" };
  }
  if (vix != null) {
    return { ...base, oneSigma: r2(spot * (vixToAtmPct(vix) / 100) * Math.sqrt(days / 252) * damp), source: "vix-scaled",
      note: `fallback: VIX-implied ATM vol x sqrt(${days}/252)${dampNote}; no accepted implied distribution for the ${horizon} expiry` };
  }
  return { ...base, oneSigma: r2(spot * 0.01 * Math.sqrt(days) * damp), source: "fixed-fallback",
    note: `fallback: fixed 1% x sqrt(${days})${dampNote} (VIX and implied distribution unavailable)` };
}
