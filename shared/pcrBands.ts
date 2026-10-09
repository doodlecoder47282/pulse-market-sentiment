// shared/pcrBands.ts
// Colour bands for a P/C value drawn against the symbol's own history
// (server/pcrHistory.ts: ln((P+0.5)/(C+0.5)) z-scored over its last 60
// sessions at the same clock time; bullishBelow = exp(mean - sd),
// bearishAbove = exp(mean + sd)). Replaces the fixed 0.75 / 1.05 cut-offs
// in FlowPanel (R3-2 item 1): with no history there are no bands and the
// value is not coloured as a zone.

export type PcrBands = { bullishBelow: number | null; bearishAbove: number | null };
export type PcrBandTone = "bullish" | "neutral" | "bearish" | "no_bands";

export function hasPcrBands(b: PcrBands | null | undefined): b is { bullishBelow: number; bearishAbove: number } {
  return !!b && b.bullishBelow != null && b.bearishAbove != null
    && Number.isFinite(b.bullishBelow) && Number.isFinite(b.bearishAbove)
    && b.bullishBelow > 0 && b.bearishAbove > b.bullishBelow;
}

/** Tone of a P/C value against the symbol's +-1 sd band (inclusive at the edges, as z <= -1 / z >= +1). */
export function pcrBandTone(v: number | null | undefined, b: PcrBands | null | undefined): PcrBandTone {
  if (v == null || !Number.isFinite(v) || !hasPcrBands(b)) return "no_bands";
  if (v <= b.bullishBelow) return "bullish";
  if (v >= b.bearishAbove) return "bearish";
  return "neutral";
}
