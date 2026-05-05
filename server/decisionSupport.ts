// server/decisionSupport.ts
//
// Formats the new "decision support" block that lives below CLOSE TARGETS on
// every Pulse Selz daily card. ADDITIVE only — never modifies the existing
// card body. If anything throws, callers should fall back to omitting this
// block entirely.
//
// Five lines, each one source-attributed in MASTER_SYNTHESIS.md:
//   1. Kelly (frac):   X%        ← Mauboussin footnote 73
//   2. Base rate up:   d/w/m/y   ← Mauboussin p. 24
//   3. Vol drag:       -X.X%     ← Mauboussin p. 20 (rule of thumb)
//   4. P5 / P95 close: L / H     ← 3-Min Data Science PPF
//   5. (Resolution metric is rendered on the WEEKLY calibration card, not here)

import {
  kellyFraction,
  volDrag,
  normPpf,
  SPX_BASE_RATES_UP,
} from "./stats";

export type DecisionInputs = {
  spot: number;
  probBull: number; // 0-1
  probBase: number; // 0-1
  probBear: number; // 0-1
  oneDayEM: number; // expected move in price units (one-day)
  realizedSigma20d?: number; // annualized 20-day σ in decimal (e.g. 0.18) — optional
};

export function formatDecisionBlock(inp: DecisionInputs): string {
  const lines: string[] = [];

  // 1. Kelly. Display half-Kelly because full Kelly is famously volatile
  //    (Mauboussin p. 19). User sees the number, never executes anything.
  //    We use the dominant scenario's prob: the max of (bull, bear) framed
  //    as the directional bet; if base wins, we show 0% (no directional edge).
  try {
    const directional = Math.max(inp.probBull, inp.probBear);
    if (directional > inp.probBase) {
      const f = kellyFraction(directional, 0.5);
      const side = inp.probBull >= inp.probBear ? "long" : "short";
      lines.push(`  Kelly ½ (${side}):  ${(f * 100).toFixed(1)}%`);
    } else {
      lines.push(`  Kelly ½:           0.0%  (no directional edge)`);
    }
  } catch {
    // skip line on any error
  }

  // 2. Base-rate strip (Mauboussin p. 24)
  try {
    const r = SPX_BASE_RATES_UP;
    lines.push(
      `  Base rate up:      ${(r.daily * 100).toFixed(0)}% / ${(r.weekly * 100).toFixed(0)}% / ${(r.monthly * 100).toFixed(0)}% / ${(r.yearly * 100).toFixed(0)}%   (d/w/m/y)`,
    );
  } catch {
    // skip
  }

  // 3. Vol drag — only displayed when 20-day σ is elevated (>25% annualized).
  //    Spec from MASTER_SYNTHESIS Tier 1 #3 — Mauboussin p. 20 rule of thumb.
  //    The arithmetic-vs-geometric gap matters most when vol is large.
  try {
    if (
      typeof inp.realizedSigma20d === "number" &&
      isFinite(inp.realizedSigma20d) &&
      inp.realizedSigma20d > 0.25
    ) {
      const drag = volDrag(inp.realizedSigma20d);
      lines.push(`  Vol drag:          -${(drag * 100).toFixed(1)}%   (σ = ${(inp.realizedSigma20d * 100).toFixed(0)}%)`);
    }
  } catch {
    // skip
  }

  // 4. P5 / P95 close bands. Convert one-day EM to a daily σ via EM ≈ 0.84·σ
  //    (the standard option-implied 1σ ≈ EM relationship — see Schwab/cboe).
  try {
    const dailySigma = inp.oneDayEM; // EM is already roughly 1σ in price units
    const p05 = normPpf(0.05, inp.spot, dailySigma);
    const p95 = normPpf(0.95, inp.spot, dailySigma);
    lines.push(`  P5 / P95 close:    ${Math.round(p05)} / ${Math.round(p95)}`);
  } catch {
    // skip
  }

  if (lines.length === 0) return "";
  return ["─── decision support ───", ...lines].join("\n");
}
