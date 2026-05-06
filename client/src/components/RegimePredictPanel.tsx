// RegimePredictPanel.tsx
// Visualizes /api/regime/predict — current regime + top transition candidates
// with driver context. Read-only. Lives on Trade Desk.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Activity, TrendingUp, TrendingDown, Minus } from "lucide-react";

type RegimeBucket =
  | "TREND_STRONG"
  | "TREND_WEAK"
  | "NEUTRAL"
  | "CHOP_WEAK"
  | "CHOP_STRONG";

interface RegimeCandidate {
  regime: RegimeBucket;
  probability: number;
  isCurrent: boolean;
}

interface RegimePredictPayload {
  symbol: string;
  currentRegime: RegimeBucket;
  candidates: RegimeCandidate[];
  horizonMinutes: number;
  confidence: number;
  drivers: {
    dfi: number;
    dfiSlopePerMin: number;
    boundaryDistance: number;
    nextBoundary: number | null;
    ivTermDelta: number;
    ivTermLabel: string;
    gammaFlipProxFrac: number;
    sessionFracRemaining: number;
    flipRatePerMin: number;
    flipsObserved: number;
    historySamples: number;
  };
  generatedAt: number;
}

const REGIME_META: Record<
  RegimeBucket,
  { label: string; tone: string; icon: typeof Activity; desc: string }
> = {
  TREND_STRONG: {
    label: "Trend Strong",
    tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    icon: TrendingUp,
    desc: "Directional bias dominant — fade tries fail",
  },
  TREND_WEAK: {
    label: "Trend Weak",
    tone: "border-emerald-500/25 bg-emerald-500/5 text-emerald-200",
    icon: TrendingUp,
    desc: "Directional bias soft — fades may hold",
  },
  NEUTRAL: {
    label: "Neutral",
    tone: "border-border bg-muted/40 text-foreground",
    icon: Minus,
    desc: "No regime conviction — wait or scalp",
  },
  CHOP_WEAK: {
    label: "Chop Weak",
    tone: "border-amber-500/25 bg-amber-500/5 text-amber-200",
    icon: Minus,
    desc: "Range-bound — trim into walls",
  },
  CHOP_STRONG: {
    label: "Chop Strong",
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    icon: TrendingDown,
    desc: "Pin pressure dominant — sell wings",
  },
};

function RegimeBar({ c, max }: { c: RegimeCandidate; max: number }) {
  const meta = REGIME_META[c.regime];
  const pct = Math.round(c.probability * 100);
  const w = max > 0 ? (c.probability / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2" data-testid={`regime-bar-${c.regime}`}>
      <div className="w-28 flex-shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {meta.label}
      </div>
      <div className="relative h-4 flex-1 overflow-hidden rounded-sm border border-border bg-muted/20">
        <div
          className={`h-full ${meta.tone.split(" ").filter((cls) => cls.startsWith("bg-")).join(" ")} ${c.isCurrent ? "ring-1 ring-amber-500/60" : ""}`}
          style={{ width: `${w}%`, minWidth: c.probability > 0.001 ? "2px" : "0" }}
        />
        <div className="absolute inset-0 flex items-center justify-between px-1.5">
          <span className="font-mono text-[9.5px] text-foreground/80">{c.isCurrent ? "● now" : ""}</span>
          <span className="font-mono text-[10px] tabular-nums text-foreground/90">{pct}%</span>
        </div>
      </div>
    </div>
  );
}

function DriverPill({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "bull" | "bear" | "neutral" | "warn" }) {
  const cls =
    tone === "bull"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
      : tone === "bear"
      ? "border-red-500/30 bg-red-500/5 text-red-300"
      : tone === "warn"
      ? "border-amber-500/30 bg-amber-500/5 text-amber-300"
      : "border-border bg-card/40 text-muted-foreground";
  return (
    <div className={`rounded-sm border px-2 py-1 ${cls}`} data-testid={`driver-${label}`}>
      <div className="text-[9px] uppercase tracking-wider opacity-70">{label}</div>
      <div className="font-mono text-[11px] tabular-nums">{value}</div>
    </div>
  );
}

export default function RegimePredictPanel() {
  const { data, isLoading, isError } = useQuery<RegimePredictPayload>({
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
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Regime Transition Forecast
            </span>
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return null; // fail-soft: hide if endpoint dies
  }

  const max = Math.max(...data.candidates.map((c) => c.probability));
  const conf = Math.round(data.confidence * 100);
  const top = data.candidates[0];
  const topMeta = REGIME_META[top.regime];

  // Slope tone
  const slopeTone: "bull" | "bear" | "neutral" =
    data.drivers.dfiSlopePerMin > 0.05 ? "bull" : data.drivers.dfiSlopePerMin < -0.05 ? "bear" : "neutral";
  const ivTone: "bull" | "bear" | "neutral" =
    data.drivers.ivTermDelta > 0.02 ? "bull" : data.drivers.ivTermDelta < -0.02 ? "bear" : "neutral";
  const flipTone: "warn" | "neutral" = data.drivers.flipRatePerMin > 0.3 ? "warn" : "neutral";

  return (
    <Card className="border-purple-500/25" data-testid="card-regime-predict">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-purple-400" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-purple-400">
              Regime Transition Forecast
            </span>
            <span className="text-[9px] text-muted-foreground">
              · next {data.horizonMinutes}m · {data.drivers.historySamples} samples
            </span>
          </div>
          <Badge
            variant="outline"
            className={`font-mono text-[10px] uppercase ${
              conf >= 70 ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : conf >= 40 ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
              : "border-border bg-muted/30 text-muted-foreground"
            }`}
            data-testid="badge-regime-confidence"
          >
            {conf}% confidence
          </Badge>
        </div>

        {/* Headline */}
        <div className="mb-3 flex items-center justify-between rounded-sm border border-border bg-card/40 px-3 py-2">
          <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Most likely next</div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-foreground" data-testid="text-top-regime">
                {topMeta.label}
              </span>
              {top.isCurrent && (
                <span className="font-mono text-[9px] uppercase tracking-wider text-emerald-400">persisting</span>
              )}
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{topMeta.desc}</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-2xl font-semibold tabular-nums text-foreground">
              {Math.round(top.probability * 100)}%
            </div>
          </div>
        </div>

        {/* Probability bars */}
        <div className="space-y-1.5">
          {data.candidates.map((c) => (
            <RegimeBar key={c.regime} c={c} max={max} />
          ))}
        </div>

        {/* Drivers */}
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-6">
          <DriverPill label="DFI" value={data.drivers.dfi.toFixed(2)} />
          <DriverPill
            label="Slope/min"
            value={`${data.drivers.dfiSlopePerMin >= 0 ? "+" : ""}${data.drivers.dfiSlopePerMin.toFixed(3)}`}
            tone={slopeTone}
          />
          <DriverPill label="IV term" value={data.drivers.ivTermLabel} tone={ivTone} />
          <DriverPill
            label="γ-flip"
            value={`${data.drivers.gammaFlipProxFrac.toFixed(2)}× EM`}
            tone={data.drivers.gammaFlipProxFrac < 0.25 ? "warn" : "neutral"}
          />
          <DriverPill
            label="Session"
            value={`${Math.round(data.drivers.sessionFracRemaining * 100)}% left`}
          />
          <DriverPill
            label="Flips/min"
            value={data.drivers.flipRatePerMin.toFixed(2)}
            tone={flipTone}
          />
        </div>
      </CardContent>
    </Card>
  );
}
