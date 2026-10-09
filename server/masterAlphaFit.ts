// server/masterAlphaFit.ts
//
// Re-estimates masterAlpha's component weights on the app's OWN logged
// history instead of borrowing β = −0.18 and the $80M net-charm σ from the
// Baltussen-Terstegge-Whelan sample (different OI coverage, sign conventions
// and time units than this app's net-charm).
//
// Model (OLS, one row per independent session):
//   realized_bps = c + Σ_j m_j · componentBps_j + ε
// m_j is the realized bps per bps the component predicted. Under the
// hand-set formula the implied m_j is the component weight w_j (× regime and
// triple-witching multipliers), so m_j ≈ w_j means the weights are right and
// m_j ≈ 0 means the component carries no information.
//
// Sample-size gate. For one predictor with true R² = 3.2% (the paper's
// value), the slope t-statistic has noncentrality ≈ √(n·R²/(1 − R²)).
// Requiring 80% power for a two-sided 5% test gives
//   n ≈ (z_{0.975} + z_{0.80})² (1 − R²)/R² = (1.960 + 0.842)² × 0.968 / 0.032 ≈ 237
// independent sessions (only 50% power at n ≈ 116), plus one per
// regressor: MIN_SESSIONS = 250, about one trading year of daily sessions.
// Below that the fit is reported as "insufficient-data" and the live formula
// keeps its hand-set weights, labeled as such. Even at "fit-ready" the
// weights are NOT swapped in automatically: a fitted model replaces a
// hand-set one only after a human reviews the out-of-sample R² below
// (Campbell & Thompson 2008, RFS 21:1509 — OOS R² vs the training mean).

import { olsFit } from "./stats";
import { DEFAULT_RISK_PCT, MAX_RISK_PCT } from "./sizingMath";

export const MASTER_ALPHA_MIN_SESSIONS = 250;
const OOS_FRACTION = 0.3;

export interface MasterAlphaFitSample {
  ts: number;                    // epoch seconds of the snapshot
  sessionDate: string;           // YYYY-MM-DD
  horizon: string;
  components: Array<{ name: string; directionBps: number; weight?: number }>;
  realizedBps: number;           // snapshot spot → session close, bps
}

export interface MasterAlphaFit {
  status: "insufficient-data" | "fit-ready" | "fit-failed";
  horizon: string;
  sessions: number;              // independent sessions used (one per date)
  minSessions: number;
  intercept: number | null;
  coefficients: Array<{ component: string; multiplier: number; se: number; t: number; handSetWeight: number | null }>;
  droppedComponents: string[];   // constant (e.g. always 0) in the sample
  sessionsDroppedMissing: number; // sessions dropped because a used component was not logged (never filled with 0)
  r2: number | null;
  oosR2: number | null;          // last 30% of sessions, model fit on the first 70%
  note: string;
}

/** Stable component key: "Charm — daily window" → "charm". */
export function componentKey(name: string): string {
  return (name.split(/[\s—-]+/)[0] ?? name).toLowerCase();
}

export function fitMasterAlphaWeights(
  samples: MasterAlphaFitSample[],
  opts: { horizon?: string; minSessions?: number } = {},
): MasterAlphaFit {
  const horizon = opts.horizon ?? "daily";
  const minSessions = opts.minSessions ?? MASTER_ALPHA_MIN_SESSIONS;
  // One observation per session: the first snapshot of the day for this
  // horizon. Several snapshots on one date share one realized close, so
  // counting them separately would overstate the evidence.
  const firstBySession = new Map<string, MasterAlphaFitSample>();
  for (const s of samples) {
    if (s.horizon !== horizon || !Number.isFinite(s.realizedBps) || !Array.isArray(s.components)) continue;
    const prev = firstBySession.get(s.sessionDate);
    if (!prev || s.ts < prev.ts) firstBySession.set(s.sessionDate, s);
  }
  const rows = Array.from(firstBySession.values()).sort((a, b) => a.ts - b.ts);
  const base: MasterAlphaFit = {
    status: "insufficient-data", horizon, sessions: rows.length, minSessions,
    intercept: null, coefficients: [], droppedComponents: [], sessionsDroppedMissing: 0, r2: null, oosR2: null,
    note: `hand-set weights: need ≥${minSessions} independent ${horizon} sessions with logged components, have ${rows.length}`,
  };
  if (rows.length < minSessions) return base;

  const keys = Array.from(new Set<string>(rows.flatMap((r) => r.components.map((c) => componentKey(c.name))))).sort();
  const handSet = new Map<string, number>();
  for (const r of rows) for (const c of r.components) {
    if (typeof c.weight === "number" && !handSet.has(componentKey(c.name))) handSet.set(componentKey(c.name), c.weight);
  }
  // A component that was not logged (or not finite) is MISSING, not 0 bps:
  // filling it with 0 would bias its multiplier toward 0 and the others with it.
  const value = (r: MasterAlphaFitSample, k: string): number => {
    const c = r.components.find((x) => componentKey(x.name) === k);
    return c && Number.isFinite(c.directionBps) ? c.directionBps : NaN;
  };
  const used = keys.filter((k) => {
    const v = rows.map((r) => value(r, k)).filter(Number.isFinite);
    return v.length > 0 && Math.max(...v) - Math.min(...v) > 1e-9;
  });
  const dropped = keys.filter((k) => !used.includes(k));
  // Complete-case fit: drop sessions missing any used component, and say how many.
  const complete = rows.filter((r) => used.every((k) => Number.isFinite(value(r, k))));
  const sessionsDroppedMissing = rows.length - complete.length;
  if (complete.length < minSessions) {
    return {
      ...base, sessions: complete.length, droppedComponents: dropped, sessionsDroppedMissing,
      note: `hand-set weights: need ≥${minSessions} independent ${horizon} sessions with every component logged, have ${complete.length} (${sessionsDroppedMissing} dropped for a missing component)`,
    };
  }
  const X = complete.map((r) => [1, ...used.map((k) => value(r, k))]);
  const y = complete.map((r) => r.realizedBps);
  const f = olsFit(X, y);
  if (!f.ok) {
    return { ...base, status: "fit-failed", sessions: complete.length, droppedComponents: dropped, sessionsDroppedMissing, note: "hand-set weights: OLS failed (collinear components)" };
  }

  // Out-of-sample check: fit on the first 70%, score the last 30% against
  // the training-mean forecast.
  let oosR2: number | null = null;
  const nTrain = Math.floor(complete.length * (1 - OOS_FRACTION));
  const tr = olsFit(X.slice(0, nTrain), y.slice(0, nTrain));
  if (tr.ok && nTrain < complete.length) {
    const yBar = y.slice(0, nTrain).reduce((s, v) => s + v, 0) / nTrain;
    let sse = 0, sseBench = 0;
    for (let i = nTrain; i < complete.length; i++) {
      const yh = X[i].reduce((s, v, j) => s + v * tr.coef[j], 0);
      sse += (y[i] - yh) ** 2;
      sseBench += (y[i] - yBar) ** 2;
    }
    oosR2 = sseBench > 0 ? 1 - sse / sseBench : null;
  }

  return {
    status: "fit-ready",
    horizon,
    sessions: complete.length,
    minSessions,
    intercept: f.coef[0],
    coefficients: used.map((k, j) => ({
      component: k,
      multiplier: f.coef[j + 1],
      se: f.se[j + 1],
      t: f.t[j + 1],
      handSetWeight: handSet.get(k) ?? null,
    })),
    droppedComponents: dropped,
    sessionsDroppedMissing,
    r2: f.r2,
    oosR2,
    note: "fit available for review; live formula still uses hand-set weights until a reviewed fit is promoted",
  };
}

// ─── Promotion gate (R2-C 9) ─────────────────────────────────────────────────
// masterAlpha may print a direction label (LONG / SHORT, STRONG_*) and a
// contract count ONLY from a fit that a person reviewed and promoted. The
// promotion record is a JSON file written by that reviewer (no endpoint, no
// automatic swap); this gate re-checks it independently so a record cannot
// promote an under-sampled or out-of-sample-failing fit:
//   - sessions >= MASTER_ALPHA_MIN_SESSIONS (250, power argument above)
//   - out-of-sample R^2 > 0 against the training mean (Campbell & Thompson 2008)
//   - finite intercept and multipliers, horizon matches, reviewer and date set
// Until then the composite is a hand-set HEURISTIC score: no direction-strength
// label and no size.

export interface MasterAlphaPromotion {
  horizon: string;
  promotedAt: string;           // ISO date of the review
  reviewer: string;
  sessions: number;
  oosR2: number;
  intercept: number;
  coefficients: Array<{ component: string; multiplier: number }>;
}

export type MasterAlphaGate =
  | { promoted: true; reason: string; model: MasterAlphaPromotion }
  | { promoted: false; reason: string };

export function masterAlphaPromotionGate(
  rec: MasterAlphaPromotion | null | undefined,
  horizon: string,
  minSessions: number = MASTER_ALPHA_MIN_SESSIONS,
): MasterAlphaGate {
  if (!rec) return { promoted: false, reason: "no reviewed fit promoted: heuristic score only (hand-set weights)" };
  if (rec.horizon !== horizon) return { promoted: false, reason: `promoted fit is for ${rec.horizon}, not ${horizon}` };
  if (!rec.reviewer || !rec.promotedAt) return { promoted: false, reason: "promotion record lacks reviewer or date" };
  if (!(rec.sessions >= minSessions)) return { promoted: false, reason: `promoted fit has ${rec.sessions} sessions < ${minSessions}` };
  if (!(Number.isFinite(rec.oosR2) && rec.oosR2 > 0)) return { promoted: false, reason: `promoted fit out-of-sample R^2 ${rec.oosR2} is not > 0` };
  if (!Number.isFinite(rec.intercept) || !Array.isArray(rec.coefficients) || rec.coefficients.length === 0
      || rec.coefficients.some((c) => !c || typeof c.component !== "string" || !Number.isFinite(c.multiplier))) {
    return { promoted: false, reason: "promotion record has missing or non-finite coefficients" };
  }
  return { promoted: true, reason: `fit promoted ${rec.promotedAt} by ${rec.reviewer}: ${rec.sessions} sessions, OOS R^2 ${rec.oosR2.toFixed(3)}`, model: rec };
}

/** Fitted forecast (bps) from a promoted model; null when a used component is missing (never filled with 0). */
export function promotedForecastBps(
  model: MasterAlphaPromotion,
  components: Array<{ name: string; directionBps: number }>,
): number | null {
  let y = model.intercept;
  for (const c of model.coefficients) {
    const comp = components.find((x) => componentKey(x.name) === c.component);
    if (!comp || !Number.isFinite(comp.directionBps)) return null;
    y += c.multiplier * comp.directionBps;
  }
  return y;
}

/**
 * Premium-at-risk budget for a masterAlpha size, from the USER's inputs only
 * (no default dollar amount; the old route defaulted to $1M):
 *   accountSize x riskPct (default 1%, capped at 5%: sizingMath limits), or an
 *   explicit riskBudgetDollars, or the legacy explicit riskBudget_M.
 * Null when the request carries none of them.
 */
export function resolveMasterAlphaRiskBudget(b: {
  accountSize?: unknown; riskPct?: unknown; riskBudgetDollars?: unknown; riskBudget_M?: unknown;
}): { dollars: number | null; source: string } {
  const num = (v: unknown) => (v == null || v === "" ? NaN : Number(v));
  const acct = num(b.accountSize);
  if (acct > 0) {
    const req = num(b.riskPct);
    const pct = Number.isFinite(req) && req > 0 ? Math.min(MAX_RISK_PCT, req) : DEFAULT_RISK_PCT;
    return { dollars: Math.floor(acct * pct * 100) / 100, source: `account ${acct} x ${(pct * 100).toFixed(2)}%` };
  }
  const usd = num(b.riskBudgetDollars);
  if (usd > 0) return { dollars: Math.floor(usd * 100) / 100, source: "riskBudgetDollars input" };
  const m = num(b.riskBudget_M);
  if (m > 0) return { dollars: Math.floor(m * 1e6 * 100) / 100, source: "riskBudget_M input" };
  return { dollars: null, source: "no account size or risk budget given" };
}

/**
 * Whole contracts of the CHOSEN contract that fit a premium-at-risk budget
 * (SF-7): floor(budget / (ask x m + fee)) in integer cents, so contracts x
 * (ask x m + opening fee) <= budget (a long option's maximum loss if it
 * expires worthless: no closing fee). `cap` is an optional extra limit (the
 * gamma-target count). Null without a Schwab ask or a fee (index root with no
 * configured fee): no size, never a guessed premium.
 */
export function contractsFromAsk(args: { budgetDollars: number; ask: number | null; fee: number | null; multiplier?: number; cap?: number | null }): {
  contracts: number; costPerContract: number; premiumAtRisk: number; binding: "budget" | "cap";
} | null {
  const m = args.multiplier ?? 100;
  if (args.ask == null || !(args.ask > 0) || args.fee == null || !(args.fee >= 0) || !(args.budgetDollars > 0)) return null;
  const costC = Math.round(args.ask * m * 100) + Math.round(args.fee * 100);
  const budgetC = Math.floor(args.budgetDollars * 100 + 1e-9);
  const byBudget = Math.floor(budgetC / costC);
  const cap = args.cap != null && Number.isFinite(args.cap) && args.cap >= 0 ? Math.floor(args.cap) : Infinity;
  const contracts = Math.max(0, Math.min(byBudget, cap));
  return { contracts, costPerContract: costC / 100, premiumAtRisk: (contracts * costC) / 100, binding: cap < byBudget ? "cap" : "budget" };
}

/** Nearest-to-spot contract with a two-sided Schwab quote in an expDateMap slice ({ strike: [contract] }). */
export function atmContractFrom(strikes: Record<string, any[]> | null | undefined, spot: number): { strike: number; bid: number; ask: number; symbol: string | null } | null {
  if (!strikes || !(spot > 0)) return null;
  let best: { strike: number; bid: number; ask: number; symbol: string | null } | null = null;
  for (const [ks, arr] of Object.entries(strikes)) {
    const k = parseFloat(ks);
    const c = Array.isArray(arr) ? arr[0] : null;
    if (!Number.isFinite(k) || !c || !(typeof c.ask === "number" && c.ask > 0 && typeof c.bid === "number" && c.bid >= 0 && c.bid <= c.ask)) continue;
    if (!best || Math.abs(k - spot) < Math.abs(best.strike - spot)) best = { strike: k, bid: c.bid, ask: c.ask, symbol: typeof c.symbol === "string" ? c.symbol : null };
  }
  return best;
}
