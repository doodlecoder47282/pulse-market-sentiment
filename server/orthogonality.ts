/**
 * MISSION FIX #7 — signal orthogonality / information-gain report (v1).
 *
 * The whale gate ANDs five conditions (premium, vol/OI, tag, DTE, delta) but
 * nothing ever measured which conditions carry independent information and
 * which are redundant. This module measures it from the closed-loop ledger:
 * graded whale_alert rows in prediction_outcomes.
 *
 * v1 method (deliberately simple, honest about sample size):
 *   - Usable row = graded with a real pct_return (result "ok").
 *   - For each feature (sentiment, premium tier, vol/OI band, delta band,
 *     aggressor tag, DTE band, regime at fire), bucket rows and compute
 *     win rate + mean return per bucket vs the overall base rate.
 *   - "Lift" = bucket win rate minus base rate. Features whose buckets show
 *     large, consistent lift carry information; flat features are redundant
 *     with the rest of the gate.
 *   - Buckets under MIN_CELL rows are shown but flagged untrusted.
 *
 * The whole report self-describes as INSUFFICIENT until the ledger has
 * MIN_USABLE usable rows — no fake precision.
 */

import { sqlite } from "./storage";

const MIN_USABLE = 50;
const MIN_CELL = 10;

interface UsableRow {
  sentiment: string;
  premium: number;
  volOiRatio: number;
  delta: number;
  tag: string;
  dte: number;
  regime: string | null;
  pctReturn: number;
  win: number; // pct_return > 0
}

export interface OrthoBucket { bucket: string; n: number; winRate: number; meanReturn: number; lift: number; trusted: boolean }
export interface OrthoFeature { feature: string; buckets: OrthoBucket[]; spread: number; verdict: string }

export interface OrthogonalityReport {
  asOf: number;
  usableRows: number;
  gradedTotal: number;
  ungradeable: { noHoldingPeriod: number; insufficientHistory: number };
  baseWinRate: number | null;
  baseMeanReturn: number | null;
  status: "ok" | "insufficient";
  features: OrthoFeature[];
  note: string;
}

function loadUsable(): { usable: UsableRow[]; gradedTotal: number; noHold: number; insufHist: number } {
  try {
    const rows = sqlite
      .prepare(`SELECT prediction_json, inputs_json, outcome_json, pct_return
                FROM prediction_outcomes WHERE kind='whale_alert' AND graded=1`)
      .all() as Array<{ prediction_json: string; inputs_json: string; outcome_json: string; pct_return: number | null }>;
    const usable: UsableRow[] = [];
    let noHold = 0, insufHist = 0;
    for (const r of rows) {
      let out: any = {}, pred: any = {}, inp: any = {};
      try { out = JSON.parse(r.outcome_json || "{}"); } catch { /* noop */ }
      if (out?.result === "no_holding_period") { noHold++; continue; }
      if (out?.result === "insufficient_history") { insufHist++; continue; }
      if (r.pct_return == null || !isFinite(r.pct_return)) continue;
      try { pred = JSON.parse(r.prediction_json || "{}"); } catch { continue; }
      try { inp = JSON.parse(r.inputs_json || "{}"); } catch { /* noop */ }
      usable.push({
        sentiment: String(pred.sentiment ?? "UNKNOWN"),
        premium: Number(pred.premium ?? 0),
        volOiRatio: Number(pred.volOiRatio ?? 0),
        delta: Math.abs(Number(pred.delta ?? 0)),
        tag: String(pred.tag ?? "UNKNOWN"),
        dte: Number(pred.dte ?? 0),
        regime: inp?.regimeAtFire != null ? String(inp.regimeAtFire) : null,
        pctReturn: Number(r.pct_return),
        win: Number(r.pct_return) > 0 ? 1 : 0,
      });
    }
    return { usable, gradedTotal: rows.length, noHold, insufHist };
  } catch {
    return { usable: [], gradedTotal: 0, noHold: 0, insufHist: 0 };
  }
}

function bucketize(rows: UsableRow[], name: string, keyFn: (r: UsableRow) => string, base: number): OrthoFeature {
  const map = new Map<string, UsableRow[]>();
  for (const r of rows) {
    const k = keyFn(r);
    const a = map.get(k) ?? []; a.push(r); map.set(k, a);
  }
  const buckets: OrthoBucket[] = Array.from(map.entries())
    .map(([bucket, list]) => {
      const wr = list.reduce((s, r) => s + r.win, 0) / list.length;
      const mr = list.reduce((s, r) => s + r.pctReturn, 0) / list.length;
      return {
        bucket, n: list.length,
        winRate: Number(wr.toFixed(3)),
        meanReturn: Number(mr.toFixed(3)),
        lift: Number((wr - base).toFixed(3)),
        trusted: list.length >= MIN_CELL,
      };
    })
    .sort((a, b) => b.n - a.n);
  const trusted = buckets.filter((b) => b.trusted);
  const spread = trusted.length >= 2
    ? Math.max(...trusted.map((b) => b.winRate)) - Math.min(...trusted.map((b) => b.winRate))
    : 0;
  const verdict = trusted.length < 2
    ? "not enough trusted buckets to judge"
    : spread >= 0.15
      ? "carries information — win rate moves materially across buckets"
      : spread >= 0.07
        ? "weak signal — some separation, needs more sample"
        : "flat — likely redundant with the rest of the gate";
  return { feature: name, buckets, spread: Number(spread.toFixed(3)), verdict };
}

let _cache: { at: number; rep: OrthogonalityReport } | null = null;

export function getOrthogonalityReport(force = false): OrthogonalityReport {
  const now = Date.now();
  if (!force && _cache && now - _cache.at < 10 * 60_000) return _cache.rep;

  const { usable, gradedTotal, noHold, insufHist } = loadUsable();
  const n = usable.length;
  const base = n > 0 ? usable.reduce((s, r) => s + r.win, 0) / n : null;
  const baseRet = n > 0 ? usable.reduce((s, r) => s + r.pctReturn, 0) / n : null;

  const features: OrthoFeature[] = n > 0 && base != null ? [
    bucketize(usable, "sentiment", (r) => r.sentiment, base),
    bucketize(usable, "premium tier", (r) => r.premium >= 10_000_000 ? "$10M+" : r.premium >= 5_000_000 ? "$5-10M" : "$2.5-5M", base),
    bucketize(usable, "vol/OI band", (r) => r.volOiRatio >= 50 ? "50x+" : r.volOiRatio >= 15 ? "15-50x" : "<15x", base),
    bucketize(usable, "delta band", (r) => r.delta >= 0.6 ? "0.6-0.8" : r.delta >= 0.4 ? "0.4-0.6" : "0.2-0.4", base),
    bucketize(usable, "aggressor tag", (r) => r.tag, base),
    bucketize(usable, "dte band", (r) => r.dte <= 1 ? "0-1d" : r.dte <= 3 ? "2-3d" : "4d+", base),
    bucketize(usable, "regime at fire", (r) => r.regime ?? "unknown", base),
  ] : [];

  const status: "ok" | "insufficient" = n >= MIN_USABLE ? "ok" : "insufficient";
  const rep: OrthogonalityReport = {
    asOf: now,
    usableRows: n,
    gradedTotal,
    ungradeable: { noHoldingPeriod: noHold, insufficientHistory: insufHist },
    baseWinRate: base != null ? Number(base.toFixed(3)) : null,
    baseMeanReturn: baseRet != null ? Number(baseRet.toFixed(3)) : null,
    status,
    features,
    note: status === "insufficient"
      ? `only ${n} usable graded rows (< ${MIN_USABLE}) — buckets shown for transparency but no verdict is trustworthy yet. ${noHold} rows graded as no_holding_period never entered the sample; that pipeline leak is the bottleneck.`
      : `v1 marginal-lift analysis over ${n} graded whale alerts. Buckets under ${MIN_CELL} rows are flagged untrusted. This measures marginal separation, not full mutual information — upgrade to conditional analysis when the ledger passes ~300 usable rows.`,
  };
  _cache = { at: now, rep };
  return rep;
}
