// Daily Discord model card header (pure; no DB / network imports so it is
// unit-testable). Used by discord.ts postDailyModelCard.
import { gammaZoneLabel, normalizeGammaZone } from "./gammaZone";

// Pure header builder for the daily card (exported for tests). Every input
// may be missing; missing renders as unavailable, never as a default value.
export function dailyCardHeader(
  audit: any,
  vol: { termRatio?: number | null; vix?: number | null } | null,
  quoteVix: number | null,
): {
  scen: { bull: number; base: number; bear: number } | null;
  top: "bull" | "base" | "bear" | null;
  scenarioSourceLabel: string;
  scenarioFieldName: string;
  description: string;
} {
  const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const sp = audit?.scenarioProb;
  const scen = sp && fin(sp.bull) && fin(sp.base) && fin(sp.bear) && sp.bull + sp.base + sp.bear > 0
    ? { bull: sp.bull, base: sp.base, bear: sp.bear } : null;
  const top = scen == null ? null
    : scen.bull >= scen.bear && scen.bull >= scen.base ? "bull"
    : scen.bear >= scen.base ? "bear" : "base";
  const src = audit?.scenarioProbSource;
  const scenarioSourceLabel = src === "risk-neutral-implied"
    ? "risk-neutral, options-implied (Breeden-Litzenberger); not a real-world forecast"
    : src === "hand-set-heuristic"
      ? "hand-set heuristic weights; not calibrated probabilities"
      : "source unlabelled: treat as heuristic";
  const scenarioFieldName = src === "risk-neutral-implied" ? "Scenarios (risk-neutral)" : "Scenarios (heuristic)";
  const dfiTxt = fin(audit?.dfi) ? `DFI ${audit.dfi >= 0 ? "+" : ""}${audit.dfi.toFixed(2)}` : "DFI unavailable";
  const gz = audit?.gammaZone == null ? "\u03b3 unavailable" : gammaZoneLabel(normalizeGammaZone(audit.gammaZone));
  const vix = fin(quoteVix) ? quoteVix : fin(vol?.vix) ? (vol!.vix as number) : null;
  // termRatio = VIX3M / VIX: > 1 contango (calm front), < 1 backwardation.
  const tr = fin(vol?.termRatio) && (vol!.termRatio as number) > 0 ? (vol!.termRatio as number) : null;
  const termLabel = tr == null ? "" : tr < 1 ? "backwardation (stress)" : tr > 1.05 ? "contango (calm)" : "flat";
  const volLine = (vix != null ? `VIX ${vix.toFixed(2)}` : "VIX unavailable") +
    (tr != null ? `  ·  term ${tr.toFixed(2)} (${termLabel})` : "  ·  term unavailable");
  return { scen, top, scenarioSourceLabel, scenarioFieldName, description: `${gz}  ·  ${dfiTxt}  ·  ${volLine}` };
}

