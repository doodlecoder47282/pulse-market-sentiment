// server/schwabChainRows.ts
//
// Pure converters from a Schwab option chain (callExpDateMap / putExpDateMap,
// keys "YYYY-MM-DD:N" -> strike -> contract[]) into the row shapes the former
// CBOE consumers used: exposure rows (exposures.ts, models.ts), gamma rows for
// the Signals snapshot (sources.buildGammaStructure), flow rows (flow.ts).
// No DB or network imports; tested in tests/quant/data-r2.test.ts.
//
// Missing is not zero: Schwab's -999 "no value" placeholder, NaN and absent
// fields become null; a contract without open interest is skipped where OI is
// the weight, but a reported 0 stays 0.

import type { ExposureRow } from "./exposureProfile";
import { settlementStyleOf, timeToExpiry, type SettlementStyle } from "./timeToExpiry";
import { ivForClock } from "./chainClock";
import { impliedVol } from "./greeks";

type ExpMap = Record<string, Record<string, any[]>> | null | undefined;
export interface SchwabChainLike {
  callExpDateMap?: ExpMap;
  putExpDateMap?: ExpMap;
  underlying?: { last?: number | null; bid?: number | null; ask?: number | null } | null;
}

export interface FlatContract {
  side: "C" | "P";
  expKey: string;
  /** Expiry date "YYYY-MM-DD" (from the Schwab key). */
  expiry: string;
  /** Calendar days to expiry (Schwab key suffix). */
  dte: number;
  strike: number;
  /** Option root (SPX, SPXW, SPY, ...) when known. */
  root: string | null;
  style: SettlementStyle;
  /** OCC symbol without padding, e.g. "SPXW261009C06700000". */
  occ: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  /** Contracts traded today; null when Schwab omitted it. */
  volume: number | null;
  openInterest: number | null;
  /** Schwab volatility, decimal (Schwab reports percent); null when missing / -999. */
  iv: number | null;
  gamma: number | null;
  delta: number | null;
}

/** Number or null: drops NaN, non-numbers and Schwab's -999 sentinel. */
export function schwabNum(x: unknown): number | null {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  if (!Number.isFinite(n) || n <= -900) return null;
  return n;
}

function rootOf(c: any): string | null {
  const r = typeof c?.optionRoot === "string" && c.optionRoot.trim() ? c.optionRoot.trim().toUpperCase() : null;
  if (r) return r;
  const m = /^([A-Z.]+)\s*\d{6}[CP]/i.exec(String(c?.symbol ?? "").trim());
  return m ? m[1].toUpperCase() : null;
}

/** Every contract of a Schwab chain as a flat row. */
export function flattenSchwabChain(chain: SchwabChainLike): FlatContract[] {
  const out: FlatContract[] = [];
  const passes: Array<[("C" | "P"), ExpMap]> = [["C", chain.callExpDateMap], ["P", chain.putExpDateMap]];
  for (const [side, map] of passes) {
    if (!map) continue;
    for (const expKey of Object.keys(map)) {
      const expiry = expKey.slice(0, 10);
      const dteKey = parseFloat(expKey.split(":")[1] ?? "");
      for (const strikeKey of Object.keys(map[expKey] ?? {})) {
        const kFromKey = parseFloat(strikeKey);
        for (const c of map[expKey][strikeKey] ?? []) {
          const strike = Number.isFinite(kFromKey) ? kFromKey : Number(c?.strikePrice);
          if (!Number.isFinite(strike) || strike <= 0) continue;
          const dte = Number.isFinite(dteKey) ? dteKey : Number(c?.daysToExpiration);
          if (!Number.isFinite(dte) || dte < 0) continue;
          const ivPct = schwabNum(c?.volatility);
          out.push({
            side, expKey, expiry, dte, strike,
            root: rootOf(c),
            style: settlementStyleOf({ symbol: c?.symbol ?? null, optionRoot: c?.optionRoot ?? null, settlementType: c?.settlementType ?? null }),
            occ: String(c?.symbol ?? "").replace(/\s+/g, ""),
            bid: schwabNum(c?.bid),
            ask: schwabNum(c?.ask),
            last: schwabNum(c?.last),
            volume: schwabNum(c?.totalVolume),
            openInterest: schwabNum(c?.openInterest),
            iv: ivPct != null && ivPct > 0 && ivPct < 500 ? ivPct / 100 : null,
            gamma: schwabNum(c?.gamma),
            delta: schwabNum(c?.delta),
          });
        }
      }
    }
  }
  return out;
}

/** Underlying last, else bid/ask mid, else null. */
export function chainSpot(chain: SchwabChainLike): number | null {
  const u = chain.underlying ?? {};
  const last = schwabNum(u.last);
  if (last != null && last > 0) return last;
  const bid = schwabNum(u.bid), ask = schwabNum(u.ask);
  if (bid != null && ask != null && bid > 0 && ask >= bid) return (bid + ask) / 2;
  return null;
}

/**
 * Schwab chain -> ExposureRow[] (exposures.ts / models.ts), 0..maxDte.
 * IV: Schwab vendor IV; within 3 days re-solved from the quote mid on our
 * clock (chainClock.ivForClock, same as gammaProfile.rowsFromChain); when the
 * vendor IV is missing it is solved from the mid (or last) with r, q.
 * Settled contracts (T <= 0: AM SPX after the open, PM after the close) and
 * contracts with no open interest are dropped.
 */
export function exposureRowsFromSchwabChain(
  chain: SchwabChainLike,
  opts: { maxDte?: number; spot: number; r?: number; q?: number; nowMs?: number },
): { rows: ExposureRow[]; solvedIvCount: number; droppedNoIv: number } {
  const r = opts.r ?? 0.05, q = opts.q ?? 0;
  const nowMs = opts.nowMs ?? Date.now();
  const rows: ExposureRow[] = [];
  let solvedIvCount = 0, droppedNoIv = 0;
  for (const c of flattenSchwabChain(chain)) {
    if (opts.maxDte != null && c.dte > opts.maxDte) continue;
    const oi = c.openInterest;
    if (oi == null || oi <= 0) continue;
    const T = timeToExpiry(c.expiry, { nowMs, style: c.style }).years;
    if (!(T > 0)) continue;
    let iv: number | null = c.iv != null && c.iv > 0 && c.iv < 5 ? c.iv : null;
    if (iv != null && opts.spot > 0) {
      const ivc = ivForClock({ vendorIv: iv, bid: c.bid, ask: c.ask, spot: opts.spot, strike: c.strike, T, type: c.side });
      if (Number.isFinite(ivc) && ivc > 0) iv = ivc;
    }
    if (iv == null && opts.spot > 0) {
      const price = c.bid != null && c.ask != null && c.bid > 0 && c.ask >= c.bid ? (c.bid + c.ask) / 2
        : c.last != null && c.last > 0 ? c.last : null;
      if (price != null) {
        const solved = impliedVol(price, opts.spot, c.strike, T, r, q, c.side);
        if (solved != null && solved > 0.01 && solved < 5) { iv = solved; solvedIvCount += 1; }
      }
    }
    if (iv == null) { droppedNoIv += 1; continue; }
    rows.push({ type: c.side, strike: c.strike, iv, oi, dte: c.dte, expiry: c.expiry, style: c.style });
  }
  return { rows, solvedIvCount, droppedNoIv };
}

/** Put / call volume and OI totals of a chain. Missing volume is counted separately, never as 0. */
export function chainVolumeTotals(chain: SchwabChainLike): {
  putVol: number; callVol: number; putOI: number; callOI: number;
  contracts: number; volumeMissing: number;
} {
  let putVol = 0, callVol = 0, putOI = 0, callOI = 0, contracts = 0, volumeMissing = 0;
  for (const c of flattenSchwabChain(chain)) {
    contracts += 1;
    if (c.volume == null) volumeMissing += 1;
    const v = c.volume ?? 0;
    const oi = c.openInterest ?? 0;
    if (c.side === "P") { putVol += v; putOI += oi; } else { callVol += v; callOI += oi; }
  }
  return { putVol, callVol, putOI, callOI, contracts, volumeMissing };
}
