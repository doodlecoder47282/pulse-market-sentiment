// server/mlAccuracy.ts
//
// Grades every entry in data/mm-predictions/predictions.jsonl against
// realized SPX/SPY daily closes from Schwab, computes rolling hit-rate,
// directional accuracy, Brier score, and calibration deciles.
//
// Output is consumed by Models tab's MLAccuracyCard component to answer
// "is the ML agent getting better."
//
// Grading rules (peer-to-peer, no false precision):
//   - Daily horizon prediction: realized = next session's close
//   - Weekly horizon prediction: realized = close 5 trading days forward
//   - Directional grading:
//       bias >= +0.15  -> bull call; correct if r > +0.10%
//       bias <= -0.15  -> bear call; correct if r < -0.10%
//       |bias| < 0.15  -> abstain (not graded)
//   - Pin grading (action === 'pin'): correct if |r| < 0.30%
//   - Brier score: (pUp/100 - actualUp)^2  where actualUp = 1 if r > +0.05% else 0

import { promises as fs } from "fs";
import * as path from "path";

const PRED_PATH = path.join(process.cwd(), "data", "mm-predictions", "predictions.jsonl");

export type PredEntry = {
  id: string;
  ts: number;
  sessionDate: string; // YYYY-MM-DD
  horizon: "daily" | "weekly";
  regime: string;
  zone: string;
  pUp: number;
  pDown: number;
  pPin: number;
  bias: number;
  action: string;
  spot: number;
  vixDelta: number | null;
  dfi: number | null;
  masterAlpha?: any;
  kind?: string;
};

export type GradedEntry = PredEntry & {
  realizedClose: number | null;
  realizedReturnPct: number | null;
  realizedDate: string | null;
  // Direction grading
  call: "bull" | "bear" | "pin" | "abstain";
  callCorrect: boolean | null; // null = abstained or no realized
  // Brier
  brier: number | null; // 0..1, lower better
  // Probability bucket for calibration (decile of pUp 0..9)
  pUpBucket: number;
};

export type AccuracySummary = {
  totalPredictions: number;
  gradedPredictions: number; // had realized data
  abstained: number;
  // Directional
  directionalHitRate: number; // 0..1 over non-abstain
  directionalNCalls: number;
  bullHitRate: number | null;
  bullN: number;
  bearHitRate: number | null;
  bearN: number;
  pinHitRate: number | null;
  pinN: number;
  // Brier (lower better; 0.25 = coin flip on binary)
  brierScore: number | null;
  brierN: number;
  // Calibration: 10 deciles of pUp
  calibration: { bucket: number; pUpAvg: number; actualUpRate: number; n: number }[];
  // Rolling windows (most-recent-N)
  windows: {
    last7: { hitRate: number | null; brier: number | null; n: number };
    last14: { hitRate: number | null; brier: number | null; n: number };
    last30: { hitRate: number | null; brier: number | null; n: number };
  };
  // Sparkline-friendly: per-prediction trail (newest last) of running hitRate
  trail: { ts: number; rollingHitRate: number; brier: number | null }[];
  // Meta
  oldestPrediction: string | null;
  newestPrediction: string | null;
  generatedAt: string;
};

async function loadPredictions(): Promise<PredEntry[]> {
  try {
    const raw = await fs.readFile(PRED_PATH, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as PredEntry;
        } catch {
          return null;
        }
      })
      .filter((p): p is PredEntry => p !== null && typeof p.spot === "number");
  } catch {
    return [];
  }
}

/** Fetch a map of YYYY-MM-DD -> close from Schwab daily bars for the symbol.
 *  Pulls 6 months back to cover the entire prediction window comfortably. */
async function fetchCloseMap(symbol: string): Promise<Map<string, number>> {
  const { getPriceHistory } = await import("./schwab");
  // Map ^GSPC -> $SPX for Schwab
  const wireSym = symbol === "^GSPC" ? "$SPX" : symbol;
  const resp = await getPriceHistory(wireSym, "month", 6, "daily", 1);
  const map = new Map<string, number>();
  for (const c of (resp?.candles || []) as any[]) {
    if (c.close == null || !isFinite(c.close)) continue;
    const d = new Date(c.datetime);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    map.set(`${yyyy}-${mm}-${dd}`, c.close);
  }
  return map;
}

/** Get the close N trading sessions after (or on) the given date.
 *  Walks forward through the sorted date keys of the close map. */
function closeAtOffset(
  closeMap: Map<string, number>,
  fromDate: string,
  offsetSessions: number,
): { date: string; close: number } | null {
  const sortedDates = Array.from(closeMap.keys()).sort();
  let i = sortedDates.findIndex((d) => d > fromDate); // strictly after
  if (i === -1) return null;
  const targetIdx = i + (offsetSessions - 1); // offset 1 = next session
  if (targetIdx >= sortedDates.length) return null;
  const d = sortedDates[targetIdx];
  return { date: d, close: closeMap.get(d)! };
}

function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

function gradePrediction(
  p: PredEntry,
  closeMap: Map<string, number>,
): GradedEntry {
  const offset = p.horizon === "weekly" ? 5 : 1;
  const realized = closeAtOffset(closeMap, p.sessionDate, offset);
  const realizedClose = realized?.close ?? null;
  const realizedDate = realized?.date ?? null;
  const r = realizedClose != null ? pctChange(p.spot, realizedClose) : null;

  // Determine call type
  let call: GradedEntry["call"] = "abstain";
  if (p.action === "pin") call = "pin";
  else if (p.bias >= 0.15) call = "bull";
  else if (p.bias <= -0.15) call = "bear";

  // Grade
  let callCorrect: boolean | null = null;
  if (r != null) {
    if (call === "bull") callCorrect = r > 0.1;
    else if (call === "bear") callCorrect = r < -0.1;
    else if (call === "pin") callCorrect = Math.abs(r) < 0.3;
    // abstain stays null
  }

  // Brier (binary up/down where up means r > 0.05%)
  let brier: number | null = null;
  if (r != null) {
    const actualUp = r > 0.05 ? 1 : 0;
    const pUpFrac = Math.max(0, Math.min(1, p.pUp / 100));
    brier = (pUpFrac - actualUp) ** 2;
  }

  // Probability bucket — decile of pUp
  const pUpBucket = Math.min(9, Math.max(0, Math.floor(p.pUp / 10)));

  return {
    ...p,
    realizedClose,
    realizedReturnPct: r,
    realizedDate,
    call,
    callCorrect,
    brier,
    pUpBucket,
  };
}

function rollingWindow(graded: GradedEntry[], n: number): { hitRate: number | null; brier: number | null; n: number } {
  const window = graded.slice(-n);
  const calls = window.filter((g) => g.callCorrect !== null);
  const hits = calls.filter((g) => g.callCorrect === true).length;
  const briers = window.filter((g) => g.brier !== null).map((g) => g.brier as number);
  return {
    hitRate: calls.length ? hits / calls.length : null,
    brier: briers.length ? briers.reduce((a, b) => a + b, 0) / briers.length : null,
    n: calls.length,
  };
}

export async function buildAccuracySummary(symbol = "^GSPC"): Promise<AccuracySummary> {
  const preds = await loadPredictions();
  if (!preds.length) {
    return {
      totalPredictions: 0,
      gradedPredictions: 0,
      abstained: 0,
      directionalHitRate: 0,
      directionalNCalls: 0,
      bullHitRate: null,
      bullN: 0,
      bearHitRate: null,
      bearN: 0,
      pinHitRate: null,
      pinN: 0,
      brierScore: null,
      brierN: 0,
      calibration: [],
      windows: {
        last7: { hitRate: null, brier: null, n: 0 },
        last14: { hitRate: null, brier: null, n: 0 },
        last30: { hitRate: null, brier: null, n: 0 },
      },
      trail: [],
      oldestPrediction: null,
      newestPrediction: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // Sort by ts ascending
  preds.sort((a, b) => a.ts - b.ts);

  // Fetch closes for the prediction symbol
  const closeMap = await fetchCloseMap(symbol);

  const graded = preds.map((p) => gradePrediction(p, closeMap));

  // Aggregate
  const gradedWithRealized = graded.filter((g) => g.realizedClose !== null);
  const calls = graded.filter((g) => g.callCorrect !== null);
  const hits = calls.filter((g) => g.callCorrect === true).length;
  const abstained = graded.filter((g) => g.call === "abstain" || g.callCorrect === null).length;

  const bull = calls.filter((g) => g.call === "bull");
  const bear = calls.filter((g) => g.call === "bear");
  const pin = calls.filter((g) => g.call === "pin");

  const briers = graded.filter((g) => g.brier !== null).map((g) => g.brier as number);
  const brierScore = briers.length ? briers.reduce((a, b) => a + b, 0) / briers.length : null;

  // Calibration deciles
  const buckets: Map<number, { pUpSum: number; upCount: number; n: number }> = new Map();
  for (const g of graded) {
    if (g.realizedReturnPct == null) continue;
    const b = g.pUpBucket;
    const cur = buckets.get(b) ?? { pUpSum: 0, upCount: 0, n: 0 };
    cur.pUpSum += g.pUp;
    cur.upCount += g.realizedReturnPct > 0.05 ? 1 : 0;
    cur.n += 1;
    buckets.set(b, cur);
  }
  const calibration = Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, v]) => ({
      bucket,
      pUpAvg: v.pUpSum / Math.max(1, v.n),
      actualUpRate: (v.upCount / Math.max(1, v.n)) * 100,
      n: v.n,
    }));

  // Rolling trail: running hit rate at each point (smoothed over last 7)
  const trail: { ts: number; rollingHitRate: number; brier: number | null }[] = [];
  for (let i = 0; i < graded.length; i++) {
    const window = graded.slice(Math.max(0, i - 6), i + 1);
    const w = window.filter((g) => g.callCorrect !== null);
    const wHits = w.filter((g) => g.callCorrect === true).length;
    const bs = window.filter((g) => g.brier !== null).map((g) => g.brier as number);
    trail.push({
      ts: graded[i].ts,
      rollingHitRate: w.length ? wHits / w.length : 0,
      brier: bs.length ? bs.reduce((a, b) => a + b, 0) / bs.length : null,
    });
  }

  return {
    totalPredictions: preds.length,
    gradedPredictions: gradedWithRealized.length,
    abstained,
    directionalHitRate: calls.length ? hits / calls.length : 0,
    directionalNCalls: calls.length,
    bullHitRate: bull.length ? bull.filter((g) => g.callCorrect === true).length / bull.length : null,
    bullN: bull.length,
    bearHitRate: bear.length ? bear.filter((g) => g.callCorrect === true).length / bear.length : null,
    bearN: bear.length,
    pinHitRate: pin.length ? pin.filter((g) => g.callCorrect === true).length / pin.length : null,
    pinN: pin.length,
    brierScore,
    brierN: briers.length,
    calibration,
    windows: {
      last7: rollingWindow(graded, 7),
      last14: rollingWindow(graded, 14),
      last30: rollingWindow(graded, 30),
    },
    trail,
    oldestPrediction: preds[0].sessionDate,
    newestPrediction: preds[preds.length - 1].sessionDate,
    generatedAt: new Date().toISOString(),
  };
}
