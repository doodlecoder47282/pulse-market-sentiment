// shared/cryptoHistory.ts
//
// Per-candidate observation history and what can be read from it. Pure.
//
// Every DexScreener refresh of a tracked pair appends one observation
// (liquidity, market cap, top-10 share when read). From that history:
//   liquidityVelocity   how the pool's depth moved over the last window, as a
//                       measured percent change with the span it was measured
//                       over, never extrapolated;
//   exitCostStress      the round trip of the sized position if liquidity were
//                       pulled by 25 / 50 / 75 / 100%: closed-form arithmetic
//                       on the SAME constant-product model the desk already
//                       prices with (shared/memeStructure.ts tradeCost), a
//                       stated model, not a forecast of a pull.
// Nothing here changes a verdict or a threshold; the rule book is untouched.

import { tradeCost, type TradeCost } from "./memeStructure";

export interface Observation {
  /** Refresh time, epoch ms. */
  at: number;
  liquidityUsd: number | null;
  marketCap: number | null;
  /** Top-10 holder share when the security read is current; null when unread. */
  top10Pct: number | null;
}

/** Observations kept per candidate (about 4 hours at the ~4-minute refresh cycle). */
export const HISTORY_CAP = 60;

export function appendObservation(history: Observation[] | null | undefined, o: Observation): Observation[] {
  const h = Array.isArray(history) ? history : [];
  // Same refresh instant twice (a re-score without a new read) is not a new observation.
  if (h.length && h[h.length - 1].at === o.at) return h;
  const next = [...h, o];
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
}

export interface LiquidityVelocity {
  state: "ok" | "insufficient" | "unavailable";
  /** Percent change in liquidity from the first to the last reading in the window. */
  changePct: number | null;
  /** Minutes the measurement spans (first to last reading), rounded. */
  spanMinutes: number | null;
  /** Readings used. */
  readings: number;
  /** Liquidity at the first and last reading. */
  fromUsd: number | null;
  toUsd: number | null;
  /** Largest drop between successive readable readings in the window, percent (a pull shows here first;
   *  a step can span an unreadable refresh in between). */
  worstStepPct: number | null;
  text: string;
}

/** Fewest readings for a velocity; fewer is "insufficient", never a number. */
export const VELOCITY_MIN_READINGS = 3;

export function liquidityVelocity(history: Observation[] | null | undefined, windowMs: number, nowMs: number): LiquidityVelocity {
  const h = (history ?? []).filter((o) => o.at >= nowMs - windowMs && o.liquidityUsd != null && Number.isFinite(o.liquidityUsd));
  if (!h.length) return { state: "unavailable", changePct: null, spanMinutes: null, readings: 0, fromUsd: null, toUsd: null, worstStepPct: null, text: "liquidity history: no readings in the window" };
  if (h.length < VELOCITY_MIN_READINGS) return { state: "insufficient", changePct: null, spanMinutes: null, readings: h.length, fromUsd: h[0].liquidityUsd, toUsd: h[h.length - 1].liquidityUsd, worstStepPct: null, text: `liquidity history: ${h.length} reading${h.length === 1 ? "" : "s"}, ${VELOCITY_MIN_READINGS} needed` };
  const from = h[0].liquidityUsd as number, to = h[h.length - 1].liquidityUsd as number;
  const span = Math.round((h[h.length - 1].at - h[0].at) / 60_000);
  const changePct = from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : null;
  let worst = 0;
  for (let i = 1; i < h.length; i++) {
    const a = h[i - 1].liquidityUsd as number, b = h[i].liquidityUsd as number;
    if (a > 0) worst = Math.min(worst, ((b - a) / a) * 100);
  }
  const worstStepPct = Math.round(worst * 10) / 10;
  const dir = changePct == null ? "from $0 (percent undefined)" : changePct > 1 ? "added" : changePct < -1 ? "pulled" : "flat";
  return {
    state: "ok", changePct, spanMinutes: span, readings: h.length, fromUsd: from, toUsd: to, worstStepPct,
    text: changePct == null ? `liquidity ${dir} to $${Math.round(to).toLocaleString("en-US")} over ${span} min (${h.length} readings)`
      : `liquidity ${dir} ${changePct >= 0 ? "+" : ""}${changePct}% over ${span} min (${h.length} readings${worstStepPct < -5 ? `, worst single step ${worstStepPct}%` : ""})`,
  };
}

export interface ExitStressRow {
  /** Share of liquidity assumed pulled. */
  pullPct: number;
  liquidityUsd: number | null;
  cost: TradeCost;
}

export interface ExitCostStress {
  state: "ok" | "unavailable";
  sizeUsd: number;
  rows: ExitStressRow[];
  /** The smallest pull (0 = already, with no pull) at which the sized position's zero-edge round trip costs more than `ruinPct` of size, or null if none of the tested pulls does. */
  firstRuinousPullPct: number | null;
  ruinPct: number;
  text: string;
}

export const STRESS_PULLS = [0, 25, 50, 75, 100] as const;
/** A round trip costing more than this share of size is called ruinous in the readout (a label, not a rule). */
export const STRESS_RUIN_PCT = 50;

export function exitCostStress(liquidityUsd: number | null, sizeUsd: number): ExitCostStress {
  if (liquidityUsd == null || !Number.isFinite(liquidityUsd) || liquidityUsd <= 0 || !(sizeUsd > 0)) {
    return { state: "unavailable", sizeUsd, rows: [], firstRuinousPullPct: null, ruinPct: STRESS_RUIN_PCT, text: "exit-cost stress: liquidity or size not usable" };
  }
  const rows: ExitStressRow[] = STRESS_PULLS.map((pullPct) => {
    const liq = pullPct >= 100 ? 0 : liquidityUsd * (1 - pullPct / 100);
    return { pullPct, liquidityUsd: liq, cost: tradeCost({ liquidityUsd: liq, sizeUsd }) };
  });
  const ruin = rows.find((r) => r.cost.roundTripPct == null || r.cost.roundTripPct > STRESS_RUIN_PCT || r.cost.dataState === "observed_zero");
  // Same rounding as the card's own round trip (tradeCost: two decimals).
  const fmt = (r: ExitStressRow) => r.cost.dataState === "observed_zero" ? "no exit" : r.cost.roundTripPct == null ? "no exit at this size" : `${r.cost.roundTripPct}%`;
  return {
    state: "ok", sizeUsd, rows, firstRuinousPullPct: ruin ? ruin.pullPct : null, ruinPct: STRESS_RUIN_PCT,
    text: `round trip of $${Math.round(sizeUsd)} if liquidity were pulled: ${rows.map((r) => `${r.pullPct}% → ${fmt(r)}`).join(", ")}. Constant-product arithmetic at each depth; not a forecast that liquidity will move.`,
  };
}
