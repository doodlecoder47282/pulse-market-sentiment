// Regime bucket from the gamma zone and the distance of spot from the gamma
// flip, plus the sign of the dealer delta-exposure (DEX) slope.
//
// History (2026-11-17): the "Delta Flow Indicator" (DFI) was
// (dDEX/dS) / |GEX| * 1e9 clamped to [-5, 5]. The 1e9 scale pinned it at the
// clamp, so it only ever carried the SIGN of the DEX slope, and the regime
// bucket that was keyed on |DFI| thresholds was constant within a gamma zone.
// DFI is retired as a magnitude. What remains is this sign, stated as a sign,
// and a regime bucket keyed on the gamma zone directly.
//
// Pure module: no DB / network imports, so it is unit-testable and shared by
// the server and the client.

/** Sign of dDEX/dS at spot. "flat" only when the slope is exactly 0. */
export type DexSlopeSign = "positive" | "negative" | "flat" | "unavailable";

/**
 * Spot must be at least this many 1-day expected moves from the gamma flip for
 * the regime to read STRONG; closer reads WEAK. Hand-set, not fit to outcomes.
 */
export const FLIP_DISTANCE_STRONG_EM = 0.5;

export type GammaRegimeBucket =
  | "TREND_STRONG"
  | "TREND_WEAK"
  | "CHOP_WEAK"
  | "CHOP_STRONG"
  | "GAMMA_UNKNOWN"
  | "INPUTS_UNAVAILABLE";

/**
 * Sign of the DEX slope on the exposure curve at the point nearest to spot
 * (central difference over the neighbouring points). Fewer than 3 curve
 * points, a zero spot step or a non-finite difference is "unavailable".
 */
export function dexSlopeSignAt(curve: ReadonlyArray<{ spot: number; dex: number }> | null | undefined, spot: number): DexSlopeSign {
  const n = curve?.length ?? 0;
  if (!curve || n < 3 || !Number.isFinite(spot)) return "unavailable";
  let idx = 0;
  for (let i = 1; i < n; i++) {
    if (Math.abs(curve[i].spot - spot) < Math.abs(curve[idx].spot - spot)) idx = i;
  }
  const lo = curve[Math.max(0, idx - 1)];
  const hi = curve[Math.min(n - 1, idx + 1)];
  const dS = hi.spot - lo.spot;
  const dDex = hi.dex - lo.dex;
  if (!Number.isFinite(dS) || !Number.isFinite(dDex) || dS === 0) return "unavailable";
  const slope = dDex / dS;
  return slope > 0 ? "positive" : slope < 0 ? "negative" : "flat";
}

/** The sign as +1 / -1 / 0 for the legacy `dfi` field (0 for flat and for unavailable). */
export function dexSlopeSignValue(sign: DexSlopeSign): 1 | -1 | 0 {
  return sign === "positive" ? 1 : sign === "negative" ? -1 : 0;
}

/** Legacy `dfiLabel` text. A slope sign, never a bullish / bearish reading. */
export function dexSlopeLegacyLabel(sign: DexSlopeSign): "POSITIVE SLOPE" | "NEGATIVE SLOPE" | "FLAT" | "UNAVAILABLE" {
  return sign === "positive" ? "POSITIVE SLOPE" : sign === "negative" ? "NEGATIVE SLOPE" : sign === "flat" ? "FLAT" : "UNAVAILABLE";
}

/**
 * Read the sign back from a payload: the new `dexSlopeSign` field when present,
 * otherwise the legacy `dfi` number (any magnitude: only its sign was ever
 * information) gated by `dfiState`.
 */
export function dexSlopeSignFromAudit(audit: { dexSlopeSign?: unknown; dfi?: unknown; dfiState?: unknown } | null | undefined): DexSlopeSign {
  const s = audit?.dexSlopeSign;
  if (s === "positive" || s === "negative" || s === "flat" || s === "unavailable") return s;
  if (audit?.dfiState === "unavailable") return "unavailable";
  const d = audit?.dfi;
  if (typeof d !== "number" || !Number.isFinite(d)) return "unavailable";
  return d > 0 ? "positive" : d < 0 ? "negative" : "flat";
}

/**
 * Signed distance of spot from the gamma flip in 1-day expected moves:
 * (spot - flip) / EM. null when the flip, the expected move or spot is missing
 * or not positive.
 */
export function flipDistanceEM(spot: unknown, gammaFlip: unknown, oneDayEM: unknown): number | null {
  if (spot == null || gammaFlip == null || oneDayEM == null) return null;
  const s = Number(spot);
  const f = Number(gammaFlip);
  const em = Number(oneDayEM);
  if (!Number.isFinite(s) || !Number.isFinite(f) || !Number.isFinite(em) || s <= 0 || f <= 0 || em <= 0) return null;
  return (s - f) / em;
}

/**
 * Regime bucket. Positive-gamma zone ("y+", and the legacy "y" pocket value)
 * reads CHOP; negative-gamma zone ("y-") reads TREND. STRONG when spot is at
 * least FLIP_DISTANCE_STRONG_EM expected moves from the flip, WEAK when closer
 * or when the flip distance is not available. A gamma zone that is present but
 * unknown ("y?") is GAMMA_UNKNOWN; no gamma zone at all is INPUTS_UNAVAILABLE.
 */
export function regimeBucketFor(gammaZone: unknown, flipDistEM: number | null | undefined): GammaRegimeBucket {
  if (gammaZone == null) return "INPUTS_UNAVAILABLE";
  const z = String(gammaZone).trim().toLowerCase();
  const family = z === "y+" || z === "y" ? "CHOP" : z === "y-" || z === "y−" ? "TREND" : null;
  if (family == null) return "GAMMA_UNKNOWN";
  const strong = flipDistEM != null && Number.isFinite(flipDistEM) && Math.abs(flipDistEM) >= FLIP_DISTANCE_STRONG_EM;
  return `${family}_${strong ? "STRONG" : "WEAK"}` as GammaRegimeBucket;
}

/**
 * The bucket for a models audit: gamma zone from audit.gammaZone, flip distance
 * from the live spot (else audit.spot), audit.gammaFlip and the 1-day expected
 * move. A missing audit is INPUTS_UNAVAILABLE.
 */
export function regimeBucketFromAudit(audit: any, liveSpot?: number | null): GammaRegimeBucket {
  if (audit == null) return "INPUTS_UNAVAILABLE";
  const dist = flipDistanceEM(liveSpot ?? audit.spot, audit.gammaFlip, audit.scenarioTargets?.oneDayEM);
  return regimeBucketFor(audit.gammaZone, dist);
}

/** "0.62 expected moves above the gamma flip" / "gamma flip distance unavailable". */
export function flipDistanceText(flipDistEM: number | null | undefined): string {
  if (flipDistEM == null || !Number.isFinite(flipDistEM)) return "gamma flip distance unavailable";
  const side = flipDistEM > 0 ? "above" : flipDistEM < 0 ? "below" : "at";
  return side === "at" ? "at the gamma flip" : `${Math.abs(flipDistEM).toFixed(2)} expected moves ${side} the gamma flip`;
}
