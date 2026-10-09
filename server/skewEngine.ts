// Skew Engine
// Computes 25-delta put skew, 25-delta call skew, and ATM IV term structure
// from the live option chain. Pairs naturally with VIX9D inversion alert.

import { getOptionChain } from "./schwab";
import { ivAtAbsDelta } from "@shared/vol";
import { tenorWindow, tenorWindowWide } from "./schwabDataPolicy";

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

/** Canonical tenors: front, ~30d, ~60d, ~90d. */
export const SKEW_TARGET_DTES = [7, 30, 60, 90] as const;

/**
 * One Schwab request per target tenor (round 3, N1-1): a narrow window around
 * the tenor (schwabDataPolicy.tenorWindow, e.g. 86-94 DTE for 90) with strikes
 * sized to reach the 25-delta wing ("wing25"), widened to the picker's own
 * +-60% tolerance only when the narrow window lists no expiry (single stocks
 * with monthly expiries). The old request was every expiry 0-100 DTE at up
 * to 300 strikes, ~70 SPX expiries per call.
 */
async function fetchTenorChains(symbol: string): Promise<Array<{ target: number; chain: any | null }>> {
  return Promise.all(SKEW_TARGET_DTES.map(async (t) => {
    const hasExpiry = (c: any) => c && !("error" in c) && Object.keys(c.callExpDateMap ?? {}).length > 0;
    const w = tenorWindow(t);
    let chain: any = await getOptionChain(symbol, w.toDte, { fromDte: w.fromDte, coverage: "wing25" });
    if (!hasExpiry(chain)) {
      const ww = tenorWindowWide(t);
      chain = await getOptionChain(symbol, ww.toDte, { fromDte: ww.fromDte, coverage: "wing25" });
    }
    return { target: t, chain: hasExpiry(chain) ? chain : null };
  }));
}

export async function computeSkew(symbol: string): Promise<SkewSnapshot | { error: string }> {
  const tenorChains = await fetchTenorChains(symbol);
  const okChains = tenorChains.filter((x) => x.chain != null);
  if (!okChains.length) return { error: "chain unavailable" };
  const frontChain = okChains[0].chain;

  const spot = frontChain.underlying?.last ?? frontChain.underlyingPrice ?? null;
  if (!Number.isFinite(spot)) return { error: "no spot" };

  // Expiries common to the call and put maps, per tenor request.
  const callMap = new Map<string, { dte: number; rows: ContractRow[] }>();
  const putMap = new Map<string, { dte: number; rows: ContractRow[] }>();
  const expiriesByTarget = new Map<number, { date: string; dte: number }[]>();
  for (const { target, chain } of okChains) {
    const c = flattenChainSide(chain.callExpDateMap, "C");
    const p = flattenChainSide(chain.putExpDateMap, "P");
    const list: { date: string; dte: number }[] = [];
    for (const [date, info] of Array.from(c.entries())) {
      if (!p.has(date)) continue;
      list.push({ date, dte: info.dte });
      callMap.set(date, info);
      putMap.set(date, p.get(date)!);
    }
    expiriesByTarget.set(target, list.sort((a, b) => a.dte - b.dte));
  }

  // Pick the expiry nearest each canonical tenor from its own request.
  const picked: { date: string; dte: number }[] = [];
  const used = new Set<string>();
  for (const t of SKEW_TARGET_DTES) {
    let best: { date: string; dte: number } | null = null;
    let bestDiff = Infinity;
    for (const e of expiriesByTarget.get(t) ?? []) {
      if (used.has(e.date)) continue;
      const d = Math.abs(e.dte - t);
      if (d < bestDiff) { bestDiff = d; best = e; }
    }
    if (best && bestDiff <= t * 0.6) {
      picked.push(best);
      used.add(best.date);
    }
  }
  picked.sort((a, b) => a.dte - b.dte);
  const chainAsOfMs = Math.min(...okChains.map((x) => Number(x.chain.asOfMs)).filter((v) => Number.isFinite(v)));

  const points: SkewPoint[] = picked.map(({ date, dte }) => {
    const calls = callMap.get(date)?.rows ?? [];
    const puts = putMap.get(date)?.rows ?? [];
    const atmC = pickAtm(calls, spot);
    const atmP = pickAtm(puts, spot);
    const atmIv = atmC && atmP ? (atmC.iv + atmP.iv) / 2 : (atmC?.iv ?? atmP?.iv ?? null);
    // Exact 25-delta vols, interpolated in delta between bracketing strikes
    // (the old nearest-contract pick within +/-0.15 could be 10D to 40D).
    const c25iv = ivAtAbsDelta(calls, 0.25);
    const p25iv = ivAtAbsDelta(puts, 0.25);
    const putSkew = (p25iv != null && atmIv != null) ? p25iv - atmIv : null;
    const callSkew = (c25iv != null && atmIv != null) ? c25iv - atmIv : null;
    const rr = (c25iv != null && p25iv != null) ? c25iv - p25iv : null;
    return {
      tenorDays: dte,
      expiry: date,
      atmIv,
      put25dIv: p25iv,
      call25dIv: c25iv,
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
    // Oldest of the tenor chains (Schwab quote time; receive time fallback).
    asOf: Number.isFinite(chainAsOfMs) ? chainAsOfMs : Date.now(),
    points,
    termStructure: { front, second, third, slope, slopeNote },
    riskReversalNow: rrNow,
    riskReversalNote: rrNote,
    source: "schwab",
  };
}
