import { useQuery } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Activity, AlertTriangle } from "lucide-react";

type Tier = "bullish" | "bearish" | "neutral" | "warning";

interface HeadlineResponse {
  regime: "vol_expansion" | "gamma_squeeze" | "pinning" | "mean_reversion" | "trend_continuation" | "neutral";
  headline: string;
  confidence: "high" | "medium" | "low";
  tier: Tier;
  asOf: number;
  inputs: {
    vix9d: number | null;
    vix: number | null;
    vix3m: number | null;
    vvix: number | null;
    vixChangePct: number | null;
    termSlope: number | null;
    termState: string;
    netGex: number;
    totalAbsGex: number;
    gexShare: number;
    gexRegime: string;
    gexTrend: string;
    gexTrendPct: number | null;
    spot: number | null;
    weightMode: string;
  };
}

const TIER_STYLES: Record<Tier, { bar: string; text: string; icon: string; label: string }> = {
  bullish:  { bar: "bg-emerald-500/15 border-emerald-500/40", text: "text-emerald-300", icon: "text-emerald-400", label: "text-emerald-400" },
  bearish:  { bar: "bg-rose-500/15 border-rose-500/40",        text: "text-rose-200",     icon: "text-rose-400",     label: "text-rose-400" },
  warning:  { bar: "bg-amber-500/15 border-amber-500/40",      text: "text-amber-200",    icon: "text-amber-400",    label: "text-amber-400" },
  neutral:  { bar: "bg-slate-500/10 border-slate-500/30",      text: "text-slate-200",    icon: "text-slate-400",    label: "text-slate-400" },
};

function IconForTier({ tier, regime }: { tier: Tier; regime: string }) {
  if (tier === "warning") return <AlertTriangle className="h-4 w-4" strokeWidth={2.5} />;
  if (regime === "gamma_squeeze" || tier === "bullish") return <TrendingUp className="h-4 w-4" strokeWidth={2.5} />;
  if (regime === "vol_expansion" || tier === "bearish") return <TrendingDown className="h-4 w-4" strokeWidth={2.5} />;
  return <Activity className="h-4 w-4" strokeWidth={2.5} />;
}

const REGIME_LABEL: Record<HeadlineResponse["regime"], string> = {
  vol_expansion: "VOL EXPANSION",
  gamma_squeeze: "GAMMA SQUEEZE",
  pinning: "PINNING",
  mean_reversion: "MEAN REVERSION",
  trend_continuation: "TREND",
  neutral: "NEUTRAL",
};

export default function RegimeHeadline() {
  const { data, isLoading, isError } = useQuery<HeadlineResponse>({
    queryKey: ["/api/regime/headline"],
    refetchInterval: 60_000, // refresh every minute
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="border-b border-border bg-background/60 px-4 py-2 text-xs font-mono text-muted-foreground" data-testid="regime-headline-loading">
        loading regime read…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="border-b border-border bg-background/60 px-4 py-2 text-xs font-mono text-muted-foreground" data-testid="regime-headline-error">
        regime read unavailable
      </div>
    );
  }

  const style = TIER_STYLES[data.tier];
  const { vix9d, vix, vix3m, vixChangePct, gexShare } = data.inputs;
  const vixChgStr = vixChangePct != null ? `${vixChangePct >= 0 ? "+" : ""}${vixChangePct.toFixed(2)}%` : "—";
  const sharePct = (gexShare * 100).toFixed(0);

  return (
    <div
      className={`sticky top-[57px] z-[9] border-b ${style.bar} backdrop-blur supports-[backdrop-filter]:bg-background/40`}
      data-testid="regime-headline"
    >
      <div className="mx-auto flex max-w-[1800px] items-center gap-3 px-3 py-2 sm:px-4 md:px-8 xl:px-10">
        <div className={`flex items-center gap-1.5 ${style.icon}`}>
          <IconForTier tier={data.tier} regime={data.regime} />
          <span className={`font-mono text-[10px] uppercase tracking-widest ${style.label}`} data-testid="regime-label">
            {REGIME_LABEL[data.regime]}
          </span>
        </div>
        <div className={`flex-1 truncate text-sm font-medium ${style.text}`} data-testid="regime-headline-text">
          {data.headline}
        </div>
        <div className="hidden items-center gap-3 font-mono text-[10px] text-muted-foreground md:flex" data-testid="regime-headline-meta">
          <span>
            <span className="opacity-60">VIX </span>
            {vix9d?.toFixed(1) ?? "—"}/{vix?.toFixed(1) ?? "—"}/{vix3m?.toFixed(1) ?? "—"} <span className={vixChangePct != null && vixChangePct >= 0 ? "text-rose-400" : "text-emerald-400"}>{vixChgStr}</span>
          </span>
          <span>
            <span className="opacity-60">NET GEX </span>
            <span className={gexShare >= 0 ? "text-emerald-400" : "text-rose-400"}>{sharePct}%</span>
          </span>
          <span className="opacity-60 uppercase">{data.confidence}</span>
        </div>
      </div>
    </div>
  );
}
