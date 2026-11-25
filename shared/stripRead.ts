// The strip above every tab, in plain words.
//
// The server classifies the market into one of six states from three measured inputs with fixed rules
// (server/routes.ts, /api/regime/headline). This turns that state and its inputs into a short label, one
// sentence and three facts a new options trader can read. Nothing here is a forecast: it names which
// conditions are present and what the model says they usually go with.
//
// The inputs and their plain names:
//   - VIX and its change today: "the market's fear gauge".
//   - The VIX curve (9-day against 3-month): short-term fear above longer-term means traders are paying up
//     for protection right now; below is the usual, calmer shape.
//   - Net dealer gamma across SPX options out to 30 days: whether the model has dealer hedging leaning
//     with moves (bigger swings) or against them (smaller swings). This is a DIFFERENT set of options from
//     the top card, which reads today's expiry only, so the two can differ; the sentence says which it is.

export type StripRegime = "vol_expansion" | "gamma_squeeze" | "pinning" | "mean_reversion" | "trend_continuation" | "neutral" | "unavailable";

export interface StripInputs {
  vix9d: number | null; vix: number | null; vix3m: number | null;
  vixChangePct: number | null;
  termState: string;      // "contango" | "backwardation" | "flat" | "unknown"
  gexRegime: string;      // "long_gamma" | "short_gamma" | "unknown"
  gexShare: number;       // -1..+1
}

export interface StripRead {
  label: string;
  sentence: string;
  /** The rule that produced the label, for the tooltip. */
  rule: string;
  facts: string[];
}

export const STRIP_LABELS: Record<StripRegime, string> = {
  vol_expansion: "Stress rising",
  gamma_squeeze: "Calm, hedging absorbing more",
  pinning: "Quiet, hedging absorbs moves",
  mean_reversion: "Stress easing",
  trend_continuation: "Bigger swings, VIX moving",
  neutral: "No clear setup",
  unavailable: "Not read",
};

const RULES: Record<StripRegime, string> = {
  vol_expansion: "short-term fear above longer-term, VIX up more than 3% today, and 30-day dealer hedging leaning with moves",
  gamma_squeeze: "30-day dealer hedging leaning strongly against moves, SPX dealer hedging rising over the last 24 hours, and VIX down more than 1% today",
  pinning: "30-day dealer hedging leaning against moves, the usual VIX curve, and VIX moving less than 2% today",
  mean_reversion: "30-day dealer hedging leaning with moves, the fear curve read and short-term fear not above longer-term, and VIX down more than 1% today",
  trend_continuation: "30-day dealer hedging leaning with moves, SPX dealer hedging rising or falling over the last 24 hours, and VIX moving more than 1% today",
  neutral: "none of the five named rules matched",
  unavailable: "an input is missing",
};

const f1 = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(1) : null);

export function stripRead(regime: StripRegime, i: StripInputs): StripRead {
  const label = STRIP_LABELS[regime] ?? STRIP_LABELS.neutral;
  const rule = `Fixed rule, not a forecast: ${RULES[regime] ?? RULES.neutral}.`;
  const vix = f1(i.vix);
  const chg = typeof i.vixChangePct === "number" && Number.isFinite(i.vixChangePct) ? i.vixChangePct : null;
  // Short clauses: the strip sits above every tab and must stay one or two lines.
  const vixPart = vix == null ? "VIX not read"
    : chg == null ? `VIX ${vix}`
    : Math.abs(chg) < 0.05 ? `VIX ${vix}, flat today`
    : `VIX ${vix}, ${chg > 0 ? "up" : "down"} ${Math.abs(chg).toFixed(1)}% today`;
  const curvePart = i.termState === "backwardation" ? "short-term fear above longer-term"
    : i.termState === "contango" ? "short-term fear below longer-term (the usual shape)"
    : i.termState === "flat" ? "short-term and longer-term fear about equal"
    : "fear curve not read";
  const dealerPart = i.gexRegime === "short_gamma" ? "30-day SPX options: dealer hedging leans with moves (bigger swings in the model)"
    : i.gexRegime === "long_gamma" ? "30-day SPX options: dealer hedging leans against moves (smaller swings in the model)"
    : "30-day dealer hedging not read";
  const sentence = regime === "unavailable"
    ? `Not read: ${[vix == null ? "VIX" : null, i.termState === "unknown" ? "the fear curve" : null, i.gexRegime === "unknown" ? "30-day dealer hedging" : null].filter(Boolean).join(" and ") || "an input"} did not come back from Schwab.`
    : `${label}: ${vixPart} · ${curvePart} · ${dealerPart}.`;
  const facts: string[] = [];
  const v9 = f1(i.vix9d), v3 = f1(i.vix3m);
  if (vix != null) facts.push(`VIX (the fear gauge): 9-day ${v9 ?? "n/a"} · 30-day ${vix} · 3-month ${v3 ?? "n/a"}`);
  if (i.gexRegime !== "unknown" && Number.isFinite(i.gexShare)) {
    facts.push(`30-day options: ${Math.abs(i.gexShare * 100).toFixed(0)}% net leaning ${i.gexShare < 0 ? "with" : "against"} moves`);
  }
  return { label, sentence, rule, facts };
}
