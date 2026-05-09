// Skew Engine
// Computes 25-delta put skew, 25-delta call skew, and ATM IV term structure
// from the live option chain. Pairs naturally with VIX9D inversion alert.

import { getOptionChain } from "./schwab";

export interface SkewPoint {
  tenorDays: number;
  expiry: string;
  atmIv: number | null;
  put25dIv: number | null;
  call25dIv: number | null;
  putSkew: number | null;     // put25d - atm   (positive = puts richer)
  callSkew: number | null;    // call25d - atm  (positive = calls richer)
  riskReversal25d: number | null;  // call25d - put25d (negative = put-heavy = fear)
}

export interface SkewSnapshot {
  symbol: string;
  spot: number | null;
  asOf: number;
  points: SkewPoint[];
  termStructure: {
    front: number | null;   // ATM IV at the front-month expiry
    second: number | null;
    third: number | null;
    slope: "contango" | "backwardation" | "flat" | "n/a";
    slopeNote: string;
  };
  riskReversalNow: number | null;
  riskReversalNote: string;
  source: "schwab";
}

interface ContractRow { strike: number; iv: number; delta: number; }

function pickByDelta(rows: ContractRow[], target: number): ContractRow | null {
  let best: ContractRow | null = null;
  let bestDiff = Infinity;
  for (const r of rows) {
    if (!Number.isFinite(r.delta) || !Number.isFinite(r.iv) || r.iv <= 0) continue;
    const d = Math.abs(Math.abs(r.delta) - target);
    if (d < bestDiff) { bestDiff = d; best = r; }
  }
  return bestDiff <= 0.15 ? best : null;
}

function pickAtm(rows: ContractRow[], spot: number): ContractRow | null {
  let best: ContractRow | null = null;
  let bestDiff = Infinity;
  for (const r of rows) {
    if (!Number.isFinite(r.iv) || r.iv <= 0) continue;
    const d = Math.abs(r.strike - spot);
    if (d < bestDiff) { bestDiff = d; best = r; }
  }
  return best;
}

function flattenChainSide(map: Record<string, Record<string, any[]>>, side: "C" | "P"):
  Map<string, { dte: number; rows: ContractRow[] }> {
  const out = new Map<string, { dte: number; rows: ContractRow[] }>();
  if (!map) return out;
  for (const key of Object.keys(map)) {
    const [date, dteStr] = key.split(":");
    const dte = parseInt(dteStr, 10);
    if (!Number.isFinite(dte)) continue;
    const rows: ContractRow[] = [];
    for (const strikeKey of Object.keys(map[key])) {
      const strike = parseFloat(strikeKey);
      const opt = (map[key][strikeKey] ?? [])[0];
      if (!opt) continue;
      const iv = (opt.volatility ?? 0) / 100; // Schwab returns percent
      const delta = side === "P" ? -(opt.delta ?? 0) : (opt.delta ?? 0); // normalize to magnitude-positive for puts
      rows.push({ strike, iv, delta });
    }
    out.set(date, { dte, rows });
  }
  return out;
}

export async function computeSkew(symbol: string): Promise<SkewSnapshot | { error: string }> {
  const chain = await getOptionChain(symbol, 100);
  if (!chain || "error" in chain) return { error: "chain unavailable" };

  const spot = (chain as any).underlying?.last ?? (chain as any).underlyingPrice ?? null;
  if (!Number.isFinite(spot)) return { error: "no spot" };

  const callMap = flattenChainSide((chain as any).callExpDateMap, "C");
  const putMap = flattenChainSide((chain as any).putExpDateMap, "P");

  // Common expiries between call and put maps
  const expiries: { date: string; dte: number }[] = [];
  for (const [date, info] of callMap) {
    if (putMap.has(date)) expiries.push({ date, dte: info.dte });
  }
  expiries.sort((a, b) => a.dte - b.dte);

  // Pick canonical tenors: front, ~30d, ~60d, ~90d
  const targetDtes = [7, 30, 60, 90];
  const picked: { date: string; dte: number }[] = [];
  const used = new Set<string>();
  for (const t of targetDtes) {
    let best: { date: string; dte: number } | null = null;
    let bestDiff = Infinity;
    for (const e of expiries) {
      if (used.has(e.date)) continue;
      const d = Math.abs(e.dte - t);
      if (d < bestDiff) { bestDiff = d; best = e; }
    }
    if (best && bestDiff <= t * 0.6) {
      picked.push(best);
      used.add(best.date);
    }
  }

  const points: SkewPoint[] = picked.map(({ date, dte }) => {
    const calls = callMap.get(date)?.rows ?? [];
    const puts = putMap.get(date)?.rows ?? [];
    const atmC = pickAtm(calls, spot);
    const atmP = pickAtm(puts, spot);
    const atmIv = atmC && atmP ? (atmC.iv + atmP.iv) / 2 : (atmC?.iv ?? atmP?.iv ?? null);
    const c25 = pickByDelta(calls, 0.25);
    const p25 = pickByDelta(puts, 0.25);
    const putSkew = (p25 && atmIv != null) ? p25.iv - atmIv : null;
    const callSkew = (c25 && atmIv != null) ? c25.iv - atmIv : null;
    const rr = (c25 && p25) ? c25.iv - p25.iv : null;
    return {
      tenorDays: dte,
      expiry: date,
      atmIv,
      put25dIv: p25?.iv ?? null,
      call25dIv: c25?.iv ?? null,
      putSkew,
      callSkew,
      riskReversal25d: rr,
    };
  });

  // Term-structure slope
  const front = points[0]?.atmIv ?? null;
  const second = points[1]?.atmIv ?? null;
  const third = points[2]?.atmIv ?? null;
  let slope: SkewSnapshot["termStructure"]["slope"] = "n/a";
  let slopeNote = "";
  if (front != null && second != null) {
    const diff = second - front;
    if (diff > 0.005) { slope = "contango"; slopeNote = "back-month IV richer than front — calm regime, sellers favored"; }
    else if (diff < -0.005) { slope = "backwardation"; slopeNote = "front IV richer than back — stress / event in next 30d, buyers favored"; }
    else { slope = "flat"; slopeNote = "term flat — no event premium being priced"; }
  }

  // 30d 25-delta risk reversal — single most actionable skew number
  const rrPoint = points.find(p => Math.abs(p.tenorDays - 30) <= 10) ?? points[0];
  const rrNow = rrPoint?.riskReversal25d ?? null;
  let rrNote = "";
  if (rrNow != null) {
    if (rrNow < -0.04) rrNote = "deep negative RR — heavy put-skew, downside crash premium priced";
    else if (rrNow < -0.02) rrNote = "negative RR — typical put-heavy regime";
    else if (rrNow > 0.01) rrNote = "positive RR — call-skew rare for indices, melt-up positioning or single-name FOMO";
    else rrNote = "RR near zero — symmetric tail pricing, unusually calm";
  }

  return {
    symbol: symbol.toUpperCase(),
    spot,
    asOf: Date.now(),
    points,
    termStructure: { front, second, third, slope, slopeNote },
    riskReversalNow: rrNow,
    riskReversalNote: rrNote,
    source: "schwab",
  };
}
