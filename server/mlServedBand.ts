// server/mlServedBand.ts
//
// Pure: which forward-return band is served (drawn and scored), and how it is
// labeled (review items R2-F 3, 5, 8). No DB, network or framework imports.
//
// Serving rule. A quantile model is drawn only when the ML sidecar says it
// passed the promotion gate (ml_service/forecast_eval.py: walk-forward
// pinball loss beats the baseline cone by a stated margin with a
// Diebold-Mariano test, and its 10-90% coverage is no worse) AND it was
// trained on real data. Otherwise the baseline volatility cone below is
// served, labeled as a baseline. The morning-anchor model is blended in only
// under the same gate (it has only ever been trained on simulated bars, so
// today it never is).
//
// Baseline volatility cone (also the yardstick in the promotion gate, same
// math in ml_service/forecast_eval.py):
//   sigma per 5-minute bar = rv_session_5m (RMS of today's 5-minute SPX log
//     returns, at least 12 of them), else VIX / 100 / sqrt(252 x 78)
//     (VIX-implied, flat across the day), else unavailable;
//   horizon h minutes: s_h = sigma x sqrt(h / 5) (square-root-of-time,
//     zero drift);
//   quantile q: expm1(z_q x s_h), z_q = the standard normal quantile, or,
//     once the trainer has fitted them on real data, the empirical quantiles
//     of standardized returns log(1 + r_h) / s_h per horizon (filtered
//     historical simulation: Barone-Adesi, Giannopoulos & Vosper, "VaR without
//     correlations for portfolios of derivative securities", Journal of
//     Futures Markets 19(5), 1999,
//     https://ideas.repec.org/a/wly/jfutmk/v19y1999i5p583-602.html).
//   Known limitation, stated: it ignores the intraday volatility U-shape, so
//   it is a yardstick, not a forecast.
//
// Blending quantiles (morning model) is quantile averaging ("Vincentization"):
// Lichtendahl, Grushka-Cockayne & Winkler, "Is it better to average
// probabilities or quantiles?", Management Science 59(7), 2013. A convex
// combination of two sorted quantile vectors stays sorted.

export const Q_KEYS = ["q10", "q25", "q50", "q75", "q90"] as const;
export type QKey = (typeof Q_KEYS)[number];
export type QBands = Record<QKey, number>;

/** Standard normal quantiles at 10/25/50/75/90% (Phi^-1). */
export const GAUSS_Z: QBands = {
  q10: -1.2815515655446004,
  q25: -0.6744897501960817,
  q50: 0,
  q75: 0.6744897501960817,
  q90: 1.2815515655446004,
};

export const BARS_PER_DAY_5M = 78;
export const TRADING_DAYS = 252;

/** Empirical standardized-return quantiles fitted by the trainer (FHS). */
export interface BaselineZ {
  method: "fhs";
  byHorizon: Record<string, QBands>;
  nDays: number;
  fittedAt: number | null;
}

export interface BaselineCone {
  bands: Record<string, QBands>;
  sigmaPerBar: number;
  sigmaSource: "rv_session" | "vix_implied";
  zMethod: "gaussian" | "fhs";
  label: string;
  versionKey: string;
}

/** Sigma per 5-minute bar for the baseline cone, or null when neither input exists. */
export function baselineSigmaPerBar(features: Record<string, number | null | undefined>): { sigma: number; source: "rv_session" | "vix_implied" } | null {
  const rv = Number(features.rv_session_5m);
  if (features.rv_session_5m != null && Number.isFinite(rv) && rv > 0) return { sigma: rv, source: "rv_session" };
  const vix = Number(features.vix_level);
  if (features.vix_level != null && Number.isFinite(vix) && vix > 0) {
    return { sigma: vix / 100 / Math.sqrt(TRADING_DAYS * BARS_PER_DAY_5M), source: "vix_implied" };
  }
  return null;
}

/** Baseline volatility cone (simple forward returns) per horizon in minutes; null = unavailable. */
export function baselineCone(
  features: Record<string, number | null | undefined>,
  horizons: number[],
  z: BaselineZ | null = null,
): BaselineCone | null {
  const s = baselineSigmaPerBar(features);
  if (!s) return null;
  const bands: Record<string, QBands> = {};
  let usedFhs = false;
  for (const h of horizons) {
    const sh = s.sigma * Math.sqrt(h / 5);
    const zz = z?.byHorizon?.[String(h)];
    const valid = !!zz && Q_KEYS.every((k) => Number.isFinite(zz[k]));
    if (valid) usedFhs = true;
    const vals = Q_KEYS.map((k) => Math.expm1((valid ? zz![k] : GAUSS_Z[k]) * sh)).sort((a, b) => a - b);
    bands[String(h)] = { q10: vals[0], q25: vals[1], q50: vals[2], q75: vals[3], q90: vals[4] };
  }
  const zMethod = usedFhs ? "fhs" : "gaussian";
  const sigmaTxt = s.source === "rv_session" ? "today's realized 5-min SPX volatility" : "VIX-implied volatility (under 1 hour of bars)";
  const zTxt = usedFhs ? `empirical standardized quantiles from ${z!.nDays} real sessions` : "normal quantiles";
  return {
    bands,
    sigmaPerBar: s.sigma,
    sigmaSource: s.source,
    zMethod,
    label: `baseline volatility cone (not a learned model): zero drift, ${sigmaTxt}, square-root-of-time, ${zTxt}`,
    versionKey: `baseline_cone:${zMethod}${usedFhs && z?.fittedAt ? `:${z.fittedAt}` : ""}`,
  };
}

export interface ModelBandsIn {
  bands: Record<string, Partial<QBands>> | null;
  status: string;
  version: string;
  trainingData: string | null;
  /** Sidecar says this model passed the promotion gate. Absent = not promoted. */
  promoted?: boolean | null;
}

export interface ServedComponent {
  name: "quantile_overlay" | "morning_anchor" | "baseline_cone";
  version: string;
  trainingData: string | null;
  promoted: boolean;
  /** Weight in the drawn band at the horizons it shares with the base. */
  weight: number;
  horizons: number[];
  note: string;
}

export interface ServedBand {
  source: "quantile_overlay" | "baseline_cone" | "unavailable";
  bands: Record<string, QBands> | null;
  components: ServedComponent[];
  /** True only when a promoted, real-data model contributes to the drawn band. */
  learned: boolean;
  label: string;
  /** Why no model is drawn (null when one is). */
  reason: string | null;
  /** Keys the live coverage of THIS band is logged and reported under. */
  coverageModel: string;
  coverageVersion: string;
  trainingData: string | null;
}

function cleanBands(b: Record<string, Partial<QBands>> | null | undefined, horizons: number[]): Record<string, QBands> | null {
  if (!b) return null;
  const out: Record<string, QBands> = {};
  for (const h of horizons) {
    const x = b[String(h)];
    if (!x || !Q_KEYS.every((k) => Number.isFinite(x[k] as number))) return null; // partial bands are not served
    const v = Q_KEYS.map((k) => x[k] as number).sort((p, q) => p - q);
    out[String(h)] = { q10: v[0], q25: v[1], q50: v[2], q75: v[3], q90: v[4] };
  }
  return out;
}

function usable(m: ModelBandsIn | null | undefined): boolean {
  return !!m && m.promoted === true && m.trainingData === "real";
}

/**
 * Decide the served band. `overlayHorizons` are the base horizons (5/15/30/60);
 * the morning model may add longer ones. `reasonIfNoModel` explains a missing
 * or unpromoted overlay (sidecar unreachable, not installed, no promoted model).
 */
export function composeServedBand(args: {
  overlay: ModelBandsIn | null;
  morning: ModelBandsIn | null;
  morningWeight: number;
  baseline: BaselineCone | null;
  overlayHorizons: number[];
  morningHorizons?: number[];
  reasonIfNoModel?: string | null;
}): ServedBand {
  const comps: ServedComponent[] = [];
  let base: Record<string, QBands> | null = null;
  let source: ServedBand["source"] = "unavailable";
  let reason: string | null = null;
  let trainingData: string | null = null;
  const ov = usable(args.overlay) ? cleanBands(args.overlay!.bands, args.overlayHorizons) : null;
  if (ov) {
    base = ov;
    source = "quantile_overlay";
    trainingData = "real";
    comps.push({ name: "quantile_overlay", version: String(args.overlay!.version), trainingData: "real", promoted: true, weight: 1,
      horizons: args.overlayHorizons, note: "real-data quantile model, passed the promotion gate" });
  } else {
    reason = args.overlay && args.overlay.bands && Object.keys(args.overlay.bands).length > 0 && !usable(args.overlay)
      ? `quantile model v${args.overlay.version} not served: ${args.overlay.trainingData !== "real" ? "not trained on real data" : "did not pass the promotion gate"}`
      : (args.reasonIfNoModel ?? "no quantile model has passed the promotion gate");
    if (args.baseline) {
      base = args.baseline.bands;
      source = "baseline_cone";
      comps.push({ name: "baseline_cone", version: args.baseline.versionKey, trainingData: null, promoted: false, weight: 1,
        horizons: args.overlayHorizons, note: args.baseline.label });
    }
  }
  if (!base) {
    return { source: "unavailable", bands: null, components: [], learned: false,
      label: "no band: neither a promoted model nor the baseline cone inputs (realized vol or VIX) are available",
      reason: reason ?? "baseline inputs unavailable", coverageModel: "none", coverageVersion: "none", trainingData: null };
  }

  const w = Math.max(0, Math.min(1, Number.isFinite(args.morningWeight) ? args.morningWeight : 0));
  const mh = args.morningHorizons ?? Object.keys(args.morning?.bands ?? {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const mb = usable(args.morning) && w > 0 ? cleanBands(args.morning!.bands, mh) : null;
  const out: Record<string, QBands> = {};
  for (const [k, b] of Object.entries(base)) out[k] = { ...b };
  if (mb) {
    for (const [k, m] of Object.entries(mb)) {
      const b = out[k];
      out[k] = b
        ? { q10: w * m.q10 + (1 - w) * b.q10, q25: w * m.q25 + (1 - w) * b.q25, q50: w * m.q50 + (1 - w) * b.q50, q75: w * m.q75 + (1 - w) * b.q75, q90: w * m.q90 + (1 - w) * b.q90 }
        : { ...m };
    }
    comps[0].weight = 1 - w;
    const only = mh.filter((h) => !(String(h) in base!));
    comps.push({ name: "morning_anchor", version: String(args.morning!.version), trainingData: "real", promoted: true, weight: w, horizons: mh,
      note: `blended at ${(w * 100).toFixed(0)}% on shared horizons${only.length ? `; ${only.join("/")} min are the morning model alone` : ""}` });
  }

  const learned = comps.some((c) => c.promoted && c.weight > 0);
  const label = comps.map((c) => c.name === "baseline_cone" ? c.note
    : c.name === "quantile_overlay" ? `quantile model v${c.version} (real data, passed promotion gate)${mb ? ` x ${((1 - w) * 100).toFixed(0)}%` : ""}`
    : `morning-anchor v${c.version} x ${(c.weight * 100).toFixed(0)}%`).join(" + ");
  return {
    source,
    bands: out,
    components: comps,
    learned,
    label,
    reason,
    coverageModel: comps.map((c) => c.name).join("+"),
    coverageVersion: comps.map((c) => (c.name === "baseline_cone" ? c.version : `${c.name}:v${c.version}`)).join("+"),
    trainingData,
  };
}
