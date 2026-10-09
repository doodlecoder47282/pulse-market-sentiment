// Gamma-zone vocabulary shared by every consumer of audit.gammaZone.
//
// models.ts emits "y+" (dealers net long gamma: hedging dampens moves),
// "y-" (net short gamma: hedging amplifies moves) or "y?" (GEX missing or
// immaterial). "y?" is "gamma unknown": it must never be rendered, scored or
// alerted as either regime. A transition into or out of "y?" is a data
// state change, not a regime flip.
//
// Pure module: no DB / network imports, so it is unit-testable.

export type GammaZone = "y+" | "y-" | "y?";

/** Normalise any raw value; anything that is not exactly y+ / y- is unknown. */
export function normalizeGammaZone(z: unknown): GammaZone {
  const s = typeof z === "string" ? z.trim().toLowerCase() : "";
  if (s === "y+") return "y+";
  if (s === "y-" || s === "y−") return "y-";
  return "y?";
}

export function isKnownGammaZone(z: unknown): boolean {
  return normalizeGammaZone(z) !== "y?";
}

/** Short human label for cards / alerts. */
export function gammaZoneLabel(z: unknown): string {
  const g = normalizeGammaZone(z);
  if (g === "y+") return "γ+ (dampened)";
  if (g === "y-") return "γ− (volatile)";
  return "γ? (gamma unknown)";
}

/** Upper-case tag for the 0DTE card regime line. */
export function gammaZoneTag(z: unknown): string {
  const g = normalizeGammaZone(z);
  if (g === "y+") return "γ+ DAMPENED";
  if (g === "y-") return "γ− VOLATILE";
  return "γ? UNKNOWN";
}

/** Directional effect of dealer hedging; "unknown" makes no claim. */
export function gammaZoneEffect(z: unknown): "dampening" | "amplifying" | "unknown" {
  const g = normalizeGammaZone(z);
  return g === "y+" ? "dampening" : g === "y-" ? "amplifying" : "unknown";
}

/**
 * Flip detector with dropout tolerance. `lastKnown` is the last KNOWN zone
 * (never "y?"). Returns whether a real regime flip happened (known -> other
 * known) and the next lastKnown to store. An unknown reading neither fires
 * nor overwrites lastKnown, so y+ -> y? -> y+ is silent and y+ -> y? -> y-
 * fires once (a real change between two known readings).
 */
export function detectGammaFlip(
  lastKnown: unknown,
  next: unknown,
): { flip: boolean; prev: GammaZone | null; next: GammaZone; nextLastKnown: GammaZone | null } {
  const prevZ = lastKnown == null ? null : normalizeGammaZone(lastKnown);
  const prev = prevZ === "y?" ? null : prevZ;
  const n = normalizeGammaZone(next);
  if (n === "y?") return { flip: false, prev, next: n, nextLastKnown: prev };
  return { flip: prev != null && prev !== n, prev, next: n, nextLastKnown: n };
}
