// server/exposures.ts
//
// /api/exposures — fetches the Schwab option chain for the requested symbol
// (0-45 DTE), converts it to per-contract IV + OI + expiry rows
// (schwabChainRows.exposureRowsFromSchwabChain) and returns DEX/GEX/VEX/Charm
// profiles across a +-10% spot band. Schwab is the only source (user decision
// 2026-10-08; this was the CBOE delayed chain): when Schwab cannot answer,
// the build throws and the route returns unavailable.
//
// Supported symbols mirror the Flow panel: SPY, QQQ, IWM + Mag 7 tickers, and
// cash indexes (SPX -> $SPX, NDX, RUT).

import { buildExposureProfile, type ExposureProfile } from "./exposureProfile";
import { exposureRowsFromSchwabChain, chainSpot } from "./schwabChainRows";
import { CASH_INDEX_TO_SCHWAB } from "./schwabSymbols";

export interface ExposuresResponse {
  profile: ExposureProfile;
  meta: {
    provider: "schwab";
    symbol: string;
    solvedIvCount: number;     // how many rows needed an IV solve (vendor IV missing)
    chainSize: number;         // rows used in the profile
    warnings: string[];
    /** When Schwab produced the chain, epoch ms; ageMs at build time. */
    chainAsOfMs: number;
    chainAgeMs: number;
    /** true = a refresh failed and an older chain (within its max age) was used. */
    chainStale: boolean;
    servedFromCache: boolean;
    /** Strike coverage the chain delivered (decimal each side of spot). */
    coverage: { belowPct: number | null; abovePct: number | null; complete: boolean } | null;
  };
}

/**
 * Build an exposure snapshot for a single symbol from the Schwab chain.
 * Throws if Schwab cannot answer or the chain is empty.
 */
export async function buildExposuresSnapshot(symbol: string): Promise<ExposuresResponse> {
  const warnings: string[] = [];
  const sym = symbol.toUpperCase();
  const wire = CASH_INDEX_TO_SCHWAB[sym] ?? sym;

  const { getOptionChain } = await import("./schwab");
  const chain = await getOptionChain(wire, 45);
  if ("error" in chain) throw new Error(`Schwab chain unavailable for ${sym}: ${chain.reason ?? chain.error}`);
  const spot = chainSpot(chain);
  if (!spot) throw new Error(`No spot price for ${sym} in the Schwab chain`);

  // Different dividend assumption per symbol. SPY ~1.3%, QQQ ~0.6%, IWM ~1.2%,
  // single names default to 0 (no clean divs signal). Rate: 5% flat.
  const q = DIV_YIELD[sym] ?? 0;
  const r = 0.05;

  const { rows, solvedIvCount, droppedNoIv } = exposureRowsFromSchwabChain(chain, { maxDte: 45, spot, r, q });
  if (!rows.length) throw new Error(`No valid option rows for ${sym}`);

  const profile = buildExposureProfile(sym, rows, spot, { r, q });

  if (solvedIvCount > 0) warnings.push(`Solved IV from the quote for ${solvedIvCount} rows (Schwab IV missing).`);
  if (droppedNoIv > 0) warnings.push(`${droppedNoIv} contracts dropped: no IV and no usable quote.`);
  if (chain.stale) warnings.push(`Schwab chain is ${Math.round(chain.ageMs / 1000)} s old (${chain.staleReason ?? "refresh failed"}).`);
  if (chain.strikeCoverage && !chain.strikeCoverage.complete) {
    warnings.push(`Strike coverage short of target: ${((chain.strikeCoverage.belowPct ?? 0) * 100).toFixed(1)}% below / ${((chain.strikeCoverage.abovePct ?? 0) * 100).toFixed(1)}% above spot.`);
  }

  return {
    profile,
    meta: {
      provider: "schwab",
      symbol: sym,
      solvedIvCount,
      chainSize: rows.length,
      warnings,
      chainAsOfMs: chain.asOfMs,
      chainAgeMs: chain.ageMs,
      chainStale: chain.stale,
      servedFromCache: chain.servedFromCache,
      coverage: chain.strikeCoverage
        ? { belowPct: chain.strikeCoverage.belowPct, abovePct: chain.strikeCoverage.abovePct, complete: chain.strikeCoverage.complete }
        : null,
    },
  };
}

const DIV_YIELD: Record<string, number> = {
  SPX: 0.013,
  NDX: 0.006,
  RUT: 0.012,
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
