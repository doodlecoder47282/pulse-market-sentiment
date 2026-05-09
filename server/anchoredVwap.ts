// Anchored VWAP + HVN/LVN extraction from existing intraday bars.
// Anchors: SESSION (default), FOMC, CPI, OPEX, USER_TS.

import type { Candle } from "./ohlc";

export type AnchorKind = "session" | "fomc" | "cpi" | "opex" | "user";

export interface AnchoredVwapResult {
  anchor: AnchorKind;
  anchorTimeMs: number;
  bars: number;
  vwap: number | null;
  upper1Sigma: number | null;
  lower1Sigma: number | null;
  upper2Sigma: number | null;
  lower2Sigma: number | null;
  spotVsVwapPct: number | null;
}

export interface ProfileNode {
  price: number;
  volume: number;
  pctOfTotal: number;
  type: "HVN" | "LVN" | "neutral";
}

export interface ExtendedVolumeProfile {
  poc: number;
  vah: number;
  val: number;
  hvn: ProfileNode[];   // top 5 high-volume nodes
  lvn: ProfileNode[];   // top 3 low-volume nodes within value-area band
  totalVolume: number;
}

function tickRound(p: number, tick: number): number {
  return Math.round(p / tick) * tick;
}

export function computeAnchoredVwap(
  bars: Candle[],
  anchor: AnchorKind,
  anchorTimeMs: number,
  spot: number,
): AnchoredVwapResult {
  const inWindow = bars.filter(b => b.t * 1000 >= anchorTimeMs);
  if (!inWindow.length) {
    return {
      anchor, anchorTimeMs, bars: 0,
      vwap: null, upper1Sigma: null, lower1Sigma: null, upper2Sigma: null, lower2Sigma: null,
      spotVsVwapPct: null,
    };
  }
  let cumPV = 0, cumV = 0;
  for (const b of inWindow) {
    const v = b.v ?? 0; if (v <= 0) continue;
    const typical = (b.h + b.l + b.c) / 3;
    cumPV += typical * v; cumV += v;
  }
  if (cumV === 0) {
    return {
      anchor, anchorTimeMs, bars: inWindow.length,
      vwap: null, upper1Sigma: null, lower1Sigma: null, upper2Sigma: null, lower2Sigma: null,
      spotVsVwapPct: null,
    };
  }
  const vwap = cumPV / cumV;
  // Volume-weighted std dev around the running VWAP
  let varAcc = 0, vAcc = 0;
  for (const b of inWindow) {
    const v = b.v ?? 0; if (v <= 0) continue;
    const typical = (b.h + b.l + b.c) / 3;
    varAcc += v * (typical - vwap) * (typical - vwap);
    vAcc += v;
  }
  const sigma = Math.sqrt(varAcc / vAcc);
  return {
    anchor, anchorTimeMs, bars: inWindow.length,
    vwap,
    upper1Sigma: vwap + sigma,
    lower1Sigma: vwap - sigma,
    upper2Sigma: vwap + 2 * sigma,
    lower2Sigma: vwap - 2 * sigma,
    spotVsVwapPct: ((spot - vwap) / vwap) * 100,
  };
}

export function extractHvnLvn(
  bars: Candle[],
  tickSize = 0.25,
): ExtendedVolumeProfile | null {
  if (!bars.length) return null;
  const histogram = new Map<number, number>();
  let total = 0;
  for (const b of bars) {
    const v = b.v ?? 0; if (v <= 0) continue;
    const typical = (b.h + b.l + b.c) / 3;
    const bucket = tickRound(typical, tickSize);
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + v);
    total += v;
  }
  if (!total) return null;

  const nodes = [...histogram.entries()]
    .map(([price, vol]) => ({ price, volume: vol, pctOfTotal: (vol / total) * 100, type: "neutral" as const }));

  // POC + VA via 70% expansion
  nodes.sort((a, b) => a.price - b.price);
  let poc = nodes[0].price, maxV = 0;
  for (const n of nodes) if (n.volume > maxV) { maxV = n.volume; poc = n.price; }
  const target = total * 0.7;
  let pocIdx = nodes.findIndex(n => n.price === poc);
  let lo = pocIdx, hi = pocIdx, acc = maxV;
  while (acc < target && (lo > 0 || hi < nodes.length - 1)) {
    const dv = lo > 0 ? nodes[lo - 1].volume : -1;
    const uv = hi < nodes.length - 1 ? nodes[hi + 1].volume : -1;
    if (uv >= dv && hi < nodes.length - 1) { hi++; acc += nodes[hi].volume; }
    else if (lo > 0) { lo--; acc += nodes[lo].volume; }
    else { hi++; acc += nodes[hi].volume; }
  }
  const val = nodes[lo].price;
  const vah = nodes[hi].price;

  // HVN = top 5 buckets by volume; LVN = inside-VA buckets in the bottom 25%
  const sortedDesc = [...nodes].sort((a, b) => b.volume - a.volume);
  const hvn: ProfileNode[] = sortedDesc.slice(0, 5).map(n => ({ ...n, type: "HVN" }));
  const insideVA = nodes.filter(n => n.price >= val && n.price <= vah);
  const lvnThresh = insideVA.length ?
    [...insideVA].sort((a, b) => a.volume - b.volume)[Math.floor(insideVA.length * 0.25)]?.volume ?? 0 : 0;
  const lvn: ProfileNode[] = insideVA
    .filter(n => n.volume <= lvnThresh && n.price !== poc)
    .sort((a, b) => a.volume - b.volume).slice(0, 3)
    .map(n => ({ ...n, type: "LVN" }));

  return { poc, vah, val, hvn, lvn, totalVolume: total };
}
