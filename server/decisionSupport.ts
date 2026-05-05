// server/decisionSupport.ts
//
// Formats the "decision support" block that lives below CLOSE TARGETS on
// the Pulse Batcave SPX Daily Model card. ADDITIVE only — never modifies
// the existing card body. If anything throws, callers should fall back to
// omitting this block entirely.
//
// Layout (tightened May 2026 — right-aligned column for at-a-glance read):
//
//   ─── decision support ───
//     STANCE              long-leaning · half-Kelly · 7126–7276
//     Kelly ½ (long)                                       4.2%
//     Base rate up                          55 / 59 / 63 / 73%
//     Vol drag (σ=27%)                                    -3.6%
//     Close band  P5 / P95                         7126 / 7276
//
// Sources:
//   Kelly                ← Mauboussin footnote 73 (half-Kelly stable variance)
//   Base rates           ← Mauboussin p. 24 (SPX d/w/m/y up-rates)
//   Vol drag             ← Mauboussin p. 20 (σ²/2 rule of thumb, gated >25%)
//   P5 / P95             ← 3-Min Data Science (PPF on EM≈1σ daily band)

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

// Right-pad label, right-align value to total width = 56 chars (matches the
// other card sections). Label gets 32 chars, value gets 22 chars right-aligned.
const LABEL_W = 32;
const VAL_W = 22;
function row(label: string, value: string): string {
  const lbl = label.length >= LABEL_W ? label.slice(0, LABEL_W) : label + " ".repeat(LABEL_W - label.length);
  const val = value.length >= VAL_W ? value : " ".repeat(VAL_W - value.length) + value;
  return `  ${lbl}${val}`;
}

export function formatDecisionBlock(inp: DecisionInputs): string {
  const lines: string[] = [];

  // Pre-compute the pieces we need for the STANCE verdict line and the
  // individual rows. Any individual try/catch keeps the block partially
  // functional even if one piece blows up.
  let kellyPct = 0;
  let kellySide: "long" | "short" | "flat" = "flat";
  try {
    const directional = Math.max(inp.probBull, inp.probBear);
    if (directional > inp.probBase) {
      kellyPct = kellyFraction(directional, 0.5) * 100;
      kellySide = inp.probBull >= inp.probBear ? "long" : "short";
    }
  } catch { /* keep defaults */ }

  let p05 = NaN, p95 = NaN;
  try {
    const dailySigma = inp.oneDayEM; // EM ≈ 1σ daily (Schwab/cboe convention)
    p05 = normPpf(0.05, inp.spot, dailySigma);
    p95 = normPpf(0.95, inp.spot, dailySigma);
  } catch { /* keep NaN */ }

  // 1. STANCE — one-glance verdict. Combines side, Kelly size, and band.
  try {
    const sideLabel =
      kellySide === "long" ? "long-leaning" :
      kellySide === "short" ? "short-leaning" :
      "neutral";
    const kellyTag = kellyPct > 0 ? `½-Kelly ${kellyPct.toFixed(1)}%` : "no edge";
    const bandTag = isFinite(p05) && isFinite(p95)
      ? `${Math.round(p05)}–${Math.round(p95)}`
      : "—";
    lines.push(row("STANCE", `${sideLabel} · ${kellyTag} · ${bandTag}`));
  } catch { /* skip */ }

  // 2. Kelly ½ row (broken out so the user sees the raw number too)
  try {
    if (kellySide === "flat") {
      lines.push(row("Kelly ½", "0.0%  (no edge)"));
    } else {
      lines.push(row(`Kelly ½ (${kellySide})`, `${kellyPct.toFixed(1)}%`));
    }
  } catch { /* skip */ }

  // 3. Base-rate strip (Mauboussin p. 24) — d/w/m/y SPX up-rates
  try {
    const r = SPX_BASE_RATES_UP;
    const strip = `${(r.daily * 100).toFixed(0)} / ${(r.weekly * 100).toFixed(0)} / ${(r.monthly * 100).toFixed(0)} / ${(r.yearly * 100).toFixed(0)}%`;
    lines.push(row("Base rate up  d/w/m/y", strip));
  } catch { /* skip */ }

  // 4. Vol drag — only when 20-day σ is elevated (>25% annualized).
  //    The arithmetic-vs-geometric gap matters most when vol is large.
  try {
    if (
      typeof inp.realizedSigma20d === "number" &&
      isFinite(inp.realizedSigma20d) &&
      inp.realizedSigma20d > 0.25
    ) {
      const drag = volDrag(inp.realizedSigma20d);
      lines.push(row(`Vol drag  (σ=${(inp.realizedSigma20d * 100).toFixed(0)}%)`, `-${(drag * 100).toFixed(1)}%`));
    }
  } catch { /* skip */ }

  // 5. P5 / P95 close band (PPF)
  try {
    if (isFinite(p05) && isFinite(p95)) {
      lines.push(row("Close band  P5 / P95", `${Math.round(p05)} / ${Math.round(p95)}`));
    }
  } catch { /* skip */ }

  if (lines.length === 0) return "";
  return ["─── decision support ───", ...lines].join("\n");
}
