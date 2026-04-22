// server/exposures.ts
//
// /api/exposures — fetches a CBOE options chain for the requested symbol, parses
// per-contract IV + OI + DTE, and returns DEX/GEX/VEX/Charm profiles across a
// ±10% spot band. Falls back to Newton-Raphson IV solve when the chain row has
// no impliedVolatility field.
//
// Supported symbols mirror the Flow panel: SPY, QQQ, IWM + Mag 7 tickers.
// Any symbol whose CBOE chain responds works — no allow-list.

import { buildExposureProfile, type ExposureRow, type ExposureProfile } from "./exposureProfile";
import { impliedVol } from "./greeks";
import { getCboeChain } from "./cboeCache";

const OCC_RE = /^([A-Z]+)(\d{6})([CP])(\d{8})$/;

/**
 * Convert CBOE chain → ExposureRow[] (0-45 DTE).
 * Uses chain IV when present; otherwise solves via Newton-Raphson from mid price.
 * Fills trading-years downstream in exposureProfile.
 */
export function chainToRows(
  chain: any,
  maxDte = 45,
  r = 0.05,
  q = 0.013,
): { rows: ExposureRow[]; spot: number; solvedIvCount: number } {
  const data = chain?.data ?? {};
  const spot = Number(data.current_price);
  if (!spot || !isFinite(spot)) return { rows: [], spot: 0, solvedIvCount: 0 };
  const opts: any[] = data.options ?? [];

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const rows: ExposureRow[] = [];
  let solvedIvCount = 0;

  for (const o of opts) {
    const m = OCC_RE.exec(String(o.option ?? ""));
    if (!m) continue;
    const ymd = m[2];
    const year = 2000 + parseInt(ymd.slice(0, 2));
    const month = parseInt(ymd.slice(2, 4)) - 1;
    const day = parseInt(ymd.slice(4, 6));
    const exp = new Date(Date.UTC(year, month, day));
    const dte = Math.round((exp.getTime() - today.getTime()) / 86400000);
    if (dte < 0 || dte > maxDte) continue;

    const strike = parseInt(m[4]) / 1000;
    const oi = Number(o.open_interest ?? 0);
    if (!oi || oi <= 0) continue;
    const type = m[3] as "C" | "P";

    let iv = Number(o.iv ?? 0);

    // Fallback: solve IV from last/mid/bid+ask avg if missing or absurd.
    if (!isFinite(iv) || iv <= 0 || iv > 5) {
      const bid = Number(o.bid ?? 0);
      const ask = Number(o.ask ?? 0);
      const last = Number(o.last_trade_price ?? 0);
      let price = 0;
      if (bid > 0 && ask > 0 && ask >= bid) price = (bid + ask) / 2;
      else if (last > 0) price = last;
      if (price > 0 && dte > 0) {
        // Convert calendar DTE to trading years for IV solve (match exposureProfile).
        const tradingDays = Math.max(1, Math.round(dte * (262 / 365)));
        const T = tradingDays / 262;
        const solved = impliedVol(price, spot, strike, T, r, q, type);
        if (solved && solved > 0.01 && solved < 5) {
          iv = solved;
          solvedIvCount += 1;
        }
      }
    }

    if (!iv || iv <= 0) continue;
    rows.push({ type, strike, iv, oi, dte });
  }

  return { rows, spot, solvedIvCount };
}

export interface ExposuresResponse {
  profile: ExposureProfile;
  meta: {
    provider: "cboe";
    symbol: string;
    solvedIvCount: number;     // how many rows needed Newton-Raphson fallback
    chainSize: number;         // rows used in the profile
    warnings: string[];
  };
}

/**
 * Build an exposure snapshot for a single symbol.
 * Throws if the CBOE chain is unavailable or empty.
 */
export async function buildExposuresSnapshot(symbol: string): Promise<ExposuresResponse> {
  const warnings: string[] = [];
  const sym = symbol.toUpperCase();

  const chain = await getCboeChain(sym);
  const { rows, spot, solvedIvCount } = chainToRows(chain);

  if (!spot) throw new Error(`No spot price for ${sym}`);
  if (!rows.length) throw new Error(`No valid option rows for ${sym}`);

  // Different dividend assumption per symbol. SPY ~1.3%, QQQ ~0.6%, IWM ~1.2%,
  // single names default to 0 (no clean divs signal). Rate: 5% flat.
  const q = DIV_YIELD[sym] ?? 0;
  const r = 0.05;

  const profile = buildExposureProfile(sym, rows, spot, { r, q });

  if (solvedIvCount > 0) {
    warnings.push(`Solved IV via Newton-Raphson for ${solvedIvCount} rows (chain missing IV).`);
  }

  return {
    profile,
    meta: {
      provider: "cboe",
      symbol: sym,
      solvedIvCount,
      chainSize: rows.length,
      warnings,
    },
  };
}

const DIV_YIELD: Record<string, number> = {
  SPY: 0.013,
  QQQ: 0.006,
  IWM: 0.012,
  AAPL: 0.005,
  MSFT: 0.007,
  NVDA: 0.0003,
  GOOGL: 0,
  META: 0.004,
  AMZN: 0,
  TSLA: 0,
};
