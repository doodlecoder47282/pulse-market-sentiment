// RegimePredictPanel.tsx
// "Regime now" — the regime as read now, in plain English. Not a forecast:
// the server makes no projection and the top-scoring regime is always the
// current one. Top-line sentence, the carried-forward note, how the drivers
// score each regime for the current read, expandable "Why".
// Mobile-friendly: 44px tap targets, vertical stack on small screens, no
// hover-only tooltips. Read-only view of /api/regime/predict.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import UnavailablePanel from "@/components/UnavailablePanel";
import { FLIP_DISTANCE_STRONG_EM, dexSlopeSignFromAudit, flipDistanceText } from "@shared/gammaRegime";
import { Activity, ChevronDown, ChevronUp, Minus } from "lucide-react";

type RegimeBucket =
  | "TREND_STRONG"
  | "TREND_WEAK"
  | "NEUTRAL"
  | "CHOP_WEAK"
  | "CHOP_STRONG"
  | "GAMMA_UNKNOWN"
  | "INPUTS_UNAVAILABLE";

interface RegimeCandidate {
  regime: RegimeBucket;
  probability: number;
  /** Heuristic score out of 100 (hand-set softmax weight), not a calibrated probability. */
  score?: number;
  isCurrent: boolean;
}

interface RegimePredictPayload {
  symbol: string;
  currentRegime: RegimeBucket;
  candidates: RegimeCandidate[];
  horizonMinutes: number;
  confidence: number;
  confidenceScore?: number;
  status: "ready" | "warming" | "degraded";
  headline: string;
  driverNotes: string[];
  drivers: {
    /** Sign of the dealer delta-exposure slope. A sign only. Absent on older servers. */
    dexSlopeSign?: "positive" | "negative" | "flat" | "unavailable";
    /** @deprecated the same sign as +1 / -1 / 0, null when unavailable */
    dfi: number | null;
    /** @deprecated always null */
    dfiSlopePerMin: number | null;
    /** Signed distance of spot from the gamma flip in 1-day expected moves; null when not available. */
    flipDistanceEM?: number | null;
    ivTermDelta: number;
    ivTermLabel: string;
    gammaFlipProxFrac: number | null;
    charmZeroProxFrac: number | null;
    sessionFracRemaining: number;
    flipRatePerMin: number;
    flipsObserved: number;
    historySamples: number;
    vannaBias: "positive" | "negative" | "neutral";
    vixTermRatio: number | null;
    macroStress: "calm" | "normal" | "stress";
    whalePressure: number;
  };
  generatedAt: number;
}

const REGIME_META: Record<
  RegimeBucket,
  { plain: string; tone: string; bar: string; icon: typeof Activity; play: string }
> = {
  TREND_STRONG: {
    plain: "Strong Trend",
    tone: "text-emerald-300",
    bar: "bg-emerald-500/70",
    icon: Activity,
    play: "Negative gamma, and spot is at least half an expected move from the gamma flip. Under the usual dealer convention, hedging tends to amplify moves. No direction is implied.",
  },
  TREND_WEAK: {
    plain: "Weak Trend",
    tone: "text-emerald-200",
    bar: "bg-emerald-500/40",
    icon: Activity,
    play: "Negative gamma, and spot is within half an expected move of the gamma flip (or the flip distance is not available). Under the usual dealer convention, hedging tends to amplify moves. No direction is implied.",
  },
  NEUTRAL: {
    plain: "Neutral",
    tone: "text-slate-200",
    bar: "bg-slate-500/50",
    icon: Minus,
    play: "No conviction: no dominant dealer pressure; key levels matter most.",
  },
  CHOP_WEAK: {
    plain: "Light Chop",
    tone: "text-amber-200",
    bar: "bg-amber-500/40",
    icon: Minus,
    play: "Positive gamma, and spot is within half an expected move of the gamma flip (or the flip distance is not available). Under the usual dealer convention, hedging tends to dampen moves.",
  },
  GAMMA_UNKNOWN: {
    plain: "Gamma unknown",
    tone: "text-muted-foreground",
    bar: "bg-muted/40",
    icon: Minus,
    play: "No regime reading: GEX missing or immaterial at spot, so no trend/chop bucket applies.",
  },
  INPUTS_UNAVAILABLE: {
    plain: "Inputs unavailable",
    tone: "text-muted-foreground",
    bar: "bg-muted/40",
    icon: Minus,
    play: "No regime reading: the gamma zone, pivot or expected move is missing in this build; a zero that was never observed is not read as neutral.",
  },
  CHOP_STRONG: {
    plain: "Heavy Chop",
    tone: "text-amber-300",
    bar: "bg-amber-500/70",
    icon: Minus,
    play: "Positive gamma, and spot is at least half an expected move from the gamma flip. Under the usual dealer convention, hedging tends to dampen moves.",
  },
};

function CandidateRow({ c, max }: { c: RegimeCandidate; max: number }) {
  const meta = REGIME_META[c.regime];
  const pct = Math.round(c.score ?? c.probability * 100);
  const w = max > 0 ? (c.probability / max) * 100 : 0;
  const Icon = meta.icon;
  return (
    <div className="flex items-center gap-3 py-2 min-h-[44px]" data-testid={`regime-row-${c.regime}`}>
      <Icon className={`h-4 w-4 flex-shrink-0 ${meta.tone}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-sm font-semibold ${meta.tone}`}>{meta.plain}</span>
          <span className="font-mono text-sm font-semibold tabular-nums text-foreground" title="Heuristic score out of 100 (hand-set weights), not a calibrated probability">{pct}<span className="text-[11px] font-normal text-muted-foreground">/100</span></span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted/30">
          <div
            className={`h-full ${meta.bar} ${c.isCurrent ? "ring-1 ring-cyan-400/60" : ""}`}
            style={{ width: `${Math.max(w, 2)}%` }}
          />
        </div>
        {c.isCurrent && (
          <div className="mt-1 text-[11px] uppercase tracking-wider text-cyan-300">current read</div>
        )}
      </div>
    </div>
  );
}

export default function RegimePredictPanel() {
  const [showWhy, setShowWhy] = useState(false);

  const { data, isLoading, isError, error } = useQuery<RegimePredictPayload>({
    queryKey: ["/api/regime/predict", "^GSPC", 20],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/regime/predict?symbol=^GSPC&horizonMinutes=20");
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  if (isLoading) {
    return (
      <Card className="border-border" data-testid="card-regime-predict-loading">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">Regime now</span>
          </div>
          <Skeleton className="h-12 w-full" />
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent>
      </Card>
    );
  }

  // A failed or empty answer keeps a card of the skeleton's height and says
  // what happened: returning nothing hid the state and shifted everything
  // below it up by a card (CI UX audit, tablet-portrait CLS 0.16).
  if (isError || !data) {
    return (
      <Card className="border-border" data-testid="card-regime-predict-unavailable">
        <CardContent className="p-4 space-y-3 min-h-[196px]">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">Regime now</span>
          </div>
          <UnavailablePanel title="Regime read" error={isError ? error : undefined} state={isError ? undefined : "unavailable"} reason={isError ? undefined : "the server sent no regime read"} compact />
        </CardContent>
      </Card>
    );
  }

  // Gamma unknown (or no candidates at all): its own state, never "Neutral".
  if (data.currentRegime === "GAMMA_UNKNOWN" || data.currentRegime === "INPUTS_UNAVAILABLE" || data.candidates.length === 0) {
    return (
      <Card className="border-border/60 bg-muted/10" data-testid="card-regime-predict-gamma-unknown">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Minus className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">Regime now — {(REGIME_META[data.currentRegime] ?? REGIME_META.GAMMA_UNKNOWN).plain}</span>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">{data.headline}</p>
        </CardContent>
      </Card>
    );
  }

  const max = Math.max(...data.candidates.map((c) => c.probability));
  const top3 = data.candidates.slice(0, 3);
  const topMeta = REGIME_META[data.candidates[0].regime];
  const conf = Math.round(data.confidenceScore ?? data.confidence * 100);

  // Warming / degraded states get a calm message instead of fake numbers
  if (data.status === "warming") {
    return (
      <Card className="border-amber-500/30 bg-amber-500/5" data-testid="card-regime-predict-warming">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-amber-200">Regime now — warming up</span>
          </div>
          <p className="text-sm text-amber-100/90 leading-relaxed">
            {data.headline}
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-amber-500/20">
            <div
              className="h-full bg-amber-500/70"
              style={{ width: `${Math.min(100, (data.drivers.historySamples / 5) * 100)}%` }}
            />
          </div>
          <div className="mt-2 text-xs text-amber-200/70">
            samples build as the regime sampler runs. typically 2-3 minutes after open.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-purple-500/25" data-testid="card-regime-predict">
      <CardContent className="p-4">
        {/* Header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-purple-400" />
            <span className="text-sm font-semibold text-foreground">Regime now</span>
            <span className="text-xs text-muted-foreground">· current read, not a forecast</span>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium font-mono ${
              conf >= 70
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                : conf >= 40
                ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                : "border-slate-600 bg-slate-700/40 text-slate-300"
            }`}
            data-testid="badge-regime-confidence"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
            heuristic score {conf}/100
          </span>
        </div>

        {/* Plain-English headline */}
        <div
          className="mb-3 rounded-md border border-slate-600 bg-slate-800/30 p-3"
        >
          <p
            className="text-base leading-relaxed text-foreground"
            data-testid="text-regime-headline"
          >
            {data.headline}
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {topMeta.play}
          </p>
        </div>

        {/* Visible without expanding: what this is and is not */}
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground" data-testid="text-regime-no-projection">
          No flip-distance projection is made; this is the current regime carried forward. The scores are hand-set heuristic weights, not probabilities.
        </p>

        {/* How the drivers score each regime for the current read (not alternatives that may come next) */}
        <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">How the drivers score each regime for the current read</div>
        <div className="space-y-1 mb-3">
          {top3.map((c) => (
            <CandidateRow key={c.regime} c={c} max={max} />
          ))}
        </div>

        {/* Expandable "Why" */}
        <button
          type="button"
          onClick={() => setShowWhy((v) => !v)}
          className="flex w-full items-center justify-between rounded-md border border-border bg-muted/20 px-3 py-2.5 min-h-[44px] text-sm font-medium text-foreground hover:bg-muted/30 active:bg-muted/40 transition-colors"
          data-testid="button-regime-why-toggle"
        >
          <span>Why · {data.driverNotes.length} signals</span>
          {showWhy ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {showWhy && (
          <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/10 p-3" data-testid="region-regime-why">
            {data.driverNotes.length === 0 ? (
              <p className="text-sm text-muted-foreground">no driver notes for this read.</p>
            ) : (
              <ul className="space-y-1.5 text-sm leading-relaxed text-foreground/90">
                {data.driverNotes.map((note, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-purple-400 flex-shrink-0">•</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* Raw driver chips, mobile-friendly grid */}
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <DriverChip
                label="flip distance"
                value={flipDistanceText(data.drivers.flipDistanceEM)}
                title={`Distance of spot from the gamma flip in 1-day expected moves. The regime reads strong at ${FLIP_DISTANCE_STRONG_EM} or more and weak when closer or when the distance is not available. The ${FLIP_DISTANCE_STRONG_EM} line is hand-set, not fit to outcomes.`}
              />
              <DriverChip
                label="pivot dist"
                value={data.drivers.gammaFlipProxFrac != null
                  ? `${data.drivers.gammaFlipProxFrac.toFixed(2)}× EM (expected move)`
                  : "not available"}
              />
              <DriverChip
                label="DEX slope"
                value={dexSlopeSignFromAudit(data.drivers)}
                title="Sign of the dealer delta-exposure (DEX) slope at spot. A sign only: it has no magnitude, it is not a flow measure and it does not score any regime."
              />
              {data.drivers.charmZeroProxFrac != null && (
                <DriverChip
                  label="charm dist"
                  value={`${data.drivers.charmZeroProxFrac.toFixed(2)}× EM`}
                />
              )}
              <DriverChip label="vanna" value={data.drivers.vannaBias} />
              <DriverChip label="IV term" value={data.drivers.ivTermLabel} />
              <DriverChip
                label="VIX term"
                value={
                  data.drivers.vixTermRatio != null
                    ? `${data.drivers.vixTermRatio.toFixed(2)}`
                    : "—"
                }
              />
              <DriverChip label="macro" value={data.drivers.macroStress} />
              <DriverChip
                label="whale flow"
                value={`${data.drivers.whalePressure >= 0 ? "+" : ""}${(data.drivers.whalePressure * 100).toFixed(0)}%`}
              />
              <DriverChip
                label="session left"
                value={`${Math.round(data.drivers.sessionFracRemaining * 100)}%`}
              />
              <DriverChip
                label="flips/min"
                value={data.drivers.flipRatePerMin.toFixed(2)}
              />
              <DriverChip
                label="samples"
                value={`${data.drivers.historySamples}`}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DriverChip({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-sm border border-border bg-card/40 px-2 py-1.5" title={title}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-xs tabular-nums text-foreground">{value}</div>
    </div>
  );
}
