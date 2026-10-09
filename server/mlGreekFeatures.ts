// server/mlGreekFeatures.ts
//
// Live feature dict for the ML quantile forecaster (Model B), feature schema
// v2. IO only: the math is in mlFeatureMath.ts (pure, tested).
//
// Inputs, all from Schwab and all on the SAME index:
//   - today's $SPX 5-minute bars (fetchOHLC "^SPX", Schwab price history);
//   - $SPX spot;
//   - dealer levels computed from the Schwab $SPX option chain (the caller
//     passes the chain; mlFeatureMath.dealerLevelsFromChain), never the
//     Signals snapshot gamma (that was CBOE SPY points measured against SPX
//     spot: review R2-F item 1);
//   - VIX and its previous close.
//
// Missing inputs give NaN features (JSON null on the wire and in the log),
// never 0 or a training median: the served model routes NaN exactly as it was
// trained (LightGBM native missing values). The dict is logged every few
// minutes in RTH by mlDataLog.ts (ml_feature_log, with schema_version) next
// to real Schwab SPX minute bars; the trainer uses only schema-v2 rows.
//
// Result is cached for 30 s.

import { fetchOHLC } from "./ohlc";
import {
  computeMlFeatures, dealerLevelsFromChain, ML_FEATURE_SCHEMA_VERSION,
  type ChainLike, type DealerLevels, type FeatureBuildResult,
} from "./mlFeatureMath";

export { ML_FEATURE_SCHEMA_VERSION };

let CACHE: { at: number; data: Record<string, number> } | null = null;
const CACHE_MS = 30_000;

export interface MlFeatureInputs {
  /** $SPX spot (Schwab). */
  spxNow: number | null;
  /** Symbol of spxNow and of the dealer chain's underlying. */
  spotUnderlying?: string;
  vix: number | null;
  vixPrev: number | null;
  /** Schwab $SPX option chain (any error variant -> pass null). */
  spxChain?: ChainLike | null;
  /** When the chain was fetched (used when the chain carries no asOfMs). */
  chainFetchedAtMs?: number | null;
  /** Why spxChain is null, when it is. */
  chainReason?: string | null;
  /**
   * Optional injected $SPX 5-minute bars (e.g. aggregated from R2-H's
   * streamed spx_minute_bars). Absent: Schwab price history (fetchOHLC).
   * Either way only today's session bars are used (computeMlFeatures).
   * New feature inputs (e.g. R2-H's ml_tick_rv_log) plug in here as
   * optional fields; adding a feature means a new ML_FEATURE_SCHEMA_VERSION.
   */
  bars5m?: Array<{ t: number; o: number; h: number; l: number; c: number; v?: number | null }> | null;
}

export interface MlFeatureProvenance {
  at: number;
  schemaVersion: number;
  missing: string[];
  reasons: Record<string, string>;
  bars5m: number;
  liveChainAudit: boolean;
  dealerAsOfMs: number | null;
  dealer: DealerLevels | null;
  /** Why `dealer` is null, when it is. */
  dealerReason: string | null;
}

let _lastProvenance: MlFeatureProvenance | null = null;

/** Build the schema-v2 feature dict from injected inputs (NaN = missing). */
export async function buildMlFeaturesFromInputs(inputs: MlFeatureInputs, nowMs = Date.now()): Promise<Record<string, number>> {
  let bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number | null }> = [];
  const spot = inputs.spxNow;
  try {
    const ohlc = inputs.bars5m ? null : await fetchOHLC("^SPX", "1D", "5m");
    bars = inputs.bars5m ? inputs.bars5m.map((b) => ({ ...b, v: b.v ?? null })) : (ohlc?.candles ?? []);
    // No fallback to ohlc.price (age unknown, may be a prior close): without a
    // fresh $SPX quote, spot is the last close of TODAY's session bars
    // (computeMlFeatures), else missing.
  } catch {
    bars = [];
  }
  const underlying = inputs.spotUnderlying ?? "$SPX";
  const dl = inputs.spxChain
    ? dealerLevelsFromChain(inputs.spxChain, underlying, { nowMs, fetchedAtMs: inputs.chainFetchedAtMs ?? undefined })
    : { levels: null, reason: inputs.chainReason ?? "chain_unavailable" };
  const r: FeatureBuildResult = computeMlFeatures({
    nowMs, bars, spot, spotUnderlying: underlying, vix: inputs.vix, vixPrev: inputs.vixPrev,
    dealer: dl.levels, dealerReason: dl.reason,
  });
  _lastProvenance = {
    at: nowMs, schemaVersion: r.schemaVersion, missing: r.missing, reasons: r.reasons, bars5m: bars.length,
    liveChainAudit: r.liveChain, dealerAsOfMs: r.dealerAsOfMs, dealer: dl.levels, dealerReason: dl.reason,
  };
  return r.features;
}

/** Provenance of the most recent build: missing features with reasons, dealer levels used. */
export function getLastMlFeatureProvenance(): MlFeatureProvenance | null {
  return _lastProvenance;
}

/** Cached wrapper. Caller injects the input resolver to avoid circular imports. */
export async function buildMlFeatures(
  resolveInputs: () => Promise<MlFeatureInputs>,
): Promise<Record<string, number>> {
  if (CACHE && Date.now() - CACHE.at < CACHE_MS) return CACHE.data;
  const inputs = await resolveInputs();
  const data = await buildMlFeaturesFromInputs(inputs);
  CACHE = { at: Date.now(), data };
  return data;
}

export function _resetMlFeaturesCache() {
  CACHE = null;
}
