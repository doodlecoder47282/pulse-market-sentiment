// ExposurePanel.tsx
// Dealer exposure profiles — DEX / GEX / VEX / Charm across ±10% spot band.
// Data source: GET /api/exposures?symbol=SYM (backed by CBOE chain + full BS Greeks).
//
// Layout: 2×2 grid of mini area charts. Each shows the exposure curve with:
//   - vertical dashed line at current spot
//   - vertical dashed orange line at zero-flip level (where that exposure crosses zero)
//   - horizontal zero line
//   - green fill above zero, red fill below (dealer-hedge convention)

import { useQuery } from "@tanstack/react-query";
import {
  Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Info, RefreshCw, Zap, TrendingUp, Clock, Activity, HelpCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ExposurePoint {
  spot: number;
  dex: number;
  gex: number;
  vex: number;
  charm: number;
}

interface ExposureProfileData {
  symbol: string;
  asOf: number;
  currentSpot: number;
  r: number;
  q: number;
  curve: ExposurePoint[];
  current: ExposurePoint;
  zeroGammaSpot: number | null;
  zeroCharmSpot: number | null;
  zeroVannaSpot: number | null;
  contractCount: number;
}

interface ExposuresResponse {
  profile: ExposureProfileData;
  meta: {
    provider: string;
    symbol: string;
    solvedIvCount: number;
    chainSize: number;
    warnings: string[];
  };
}

interface Props {
  symbol: string;
}

// ---------------------------------------------------------------------------

export default function ExposurePanel({ symbol }: Props) {
  const sym = symbol.toUpperCase();
  const { data, isLoading, isError, error, refetch } = useQuery<ExposuresResponse>({
    queryKey: ["/api/exposures", sym],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/exposures?symbol=${encodeURIComponent(sym)}`);
      return r.json();
    },
    // Exposures are structural, not tick-level — 5 min refresh keeps CBOE happy.
    refetchInterval: 5 * 60_000,
    staleTime: 4 * 60_000,
  });

  if (isLoading && !data) {
    return (
      <Card>
        <CardContent className="flex h-80 items-center justify-center text-sm text-muted-foreground">
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          Computing dealer exposures for {sym}…
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="flex h-80 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <Info className="h-5 w-5 text-amber-500" />
          <div>Couldn't compute exposures for {sym}.</div>
          <div className="text-xs opacity-70">
            {(error as any)?.message ?? "CBOE chain may be unavailable. SPY/QQQ/IWM + Mag7 work best."}
          </div>
          <button
            className="mt-2 rounded-md border border-border/60 px-3 py-1 text-xs hover:bg-muted"
            onClick={() => refetch()}
            data-testid="button-retry-exposures"
          >
            Retry
          </button>
        </CardContent>
      </Card>
    );
  }

  const p = data.profile;
  const cur = p.current;

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div className="space-y-0.5">
            <CardTitle className="text-base" data-testid="text-exposure-title">
              Dealer exposure — {sym}
            </CardTitle>
            <div className="text-xs text-muted-foreground">
              {data.meta.chainSize.toLocaleString()} contracts · 0-45 DTE · spot {p.currentSpot.toFixed(2)} · r {(p.r * 100).toFixed(1)}% · q {(p.q * 100).toFixed(1)}%
              {data.meta.solvedIvCount > 0 && (
                <> · <span className="text-amber-500">{data.meta.solvedIvCount} IV solved</span></>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <CurrentBadge icon={<Activity className="h-3 w-3" />} label="DEX"   value={cur.dex}   units="$"    />
            <CurrentBadge icon={<Zap className="h-3 w-3" />}       label="GEX"   value={cur.gex}   units="$/1%" />
            <CurrentBadge icon={<TrendingUp className="h-3 w-3" />}label="VEX"   value={cur.vex}   units="$/1%vol" />
            <CurrentBadge icon={<Clock className="h-3 w-3" />}     label="Charm" value={cur.charm} units="$/day" />
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <ExposureChart
              title="DEX — Delta Exposure"
              subtitle="Pin risk · dealer directional hedge"
              data={p.curve}
              dataKey="dex"
              spot={p.currentSpot}
              zeroSpot={null}
              testId="chart-dex"
            />
            <ExposureChart
              title="GEX — Gamma Exposure"
              subtitle="Hedge flow per 1% spot move"
              data={p.curve}
              dataKey="gex"
              spot={p.currentSpot}
              zeroSpot={p.zeroGammaSpot}
              flipLabel="γ-flip"
              testId="chart-gex"
            />
            <ExposureChart
              title="VEX — Vanna Exposure"
              subtitle="dΔ per 1% vol · vol-crush flows"
              data={p.curve}
              dataKey="vex"
              spot={p.currentSpot}
              zeroSpot={p.zeroVannaSpot}
              flipLabel="vanna-flip"
              testId="chart-vex"
            />
            <ExposureChart
              title="Charm — Delta Decay"
              subtitle="dΔ per calendar day · EOD pinning"
              data={p.curve}
              dataKey="charm"
              spot={p.currentSpot}
              zeroSpot={p.zeroCharmSpot}
              flipLabel="charm-flip"
              testId="chart-charm"
            />
          </div>
          <Footnote />
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

const EXPOSURE_TOOLTIPS: Record<string, string> = {
  "DEX": "Delta Exposure: total dealer delta in dollars. Positive = dealers are net long delta (bought calls/sold puts); negative = net short delta. Drives the directional hedging flow.",
  "GEX": "Gamma Exposure: total dealer gamma in dollars per 1% move. Positive = dealers stabilize price (buy dips, sell rips); negative = dealers amplify moves.",
  "VEX": "Vega Exposure: dealer sensitivity to implied volatility per 1% vol change. Negative VEX = dealers short vol (sell spikes); positive = long vol (buy spikes).",
  "Charm": "Charm (delta decay) exposure: how dealer delta changes with time. Accelerates into expiry — can create persistent directional drift near OPEX.",
};

function CurrentBadge({
  icon, label, value, units,
}: { icon: React.ReactNode; label: string; value: number; units: string }) {
  const positive = value >= 0;
  const tip = EXPOSURE_TOOLTIPS[label];
  const badge = (
    <Badge
      variant="outline"
      className={`gap-1 cursor-default ${positive ? "border-emerald-500/40 text-emerald-500" : "border-rose-500/40 text-rose-500"}`}
      data-testid={`badge-${label.toLowerCase()}`}
    >
      {icon}
      <span className="font-semibold">{label}</span>
      <span className="tabular-nums">{fmtMoney(value)}</span>
      <span className="text-[10px] opacity-70">{units}</span>
    </Badge>
  );
  if (!tip) return badge;
  return (
    <UITooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">{tip}</TooltipContent>
    </UITooltip>
  );
}

interface ChartProps {
  title: string;
  subtitle: string;
  data: ExposurePoint[];
  dataKey: keyof ExposurePoint;
  spot: number;
  zeroSpot: number | null;
  flipLabel?: string;
  testId: string;
}

function ExposureChart({ title, subtitle, data, dataKey, spot, zeroSpot, flipLabel, testId }: ChartProps) {
  // Scale values to millions for readability.
  const scaled = data.map((p) => ({
    spot: p.spot,
    v: (p[dataKey] as number) / 1e6,
  }));

  return (
    <div className="rounded-lg border border-border/50 p-3" data-testid={testId}>
      <div className="mb-1 flex items-baseline justify-between">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{subtitle}</div>
      </div>
      <div className="h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={scaled} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <defs>
              <linearGradient id={`grad-pos-${testId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(142 71% 45%)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="hsl(142 71% 45%)" stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id={`grad-neg-${testId}`} x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="hsl(0 84% 55%)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="hsl(0 84% 55%)" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
            <XAxis
              dataKey="spot"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v) => v.toFixed(0)}
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              tickMargin={2}
            />
            <YAxis
              tickFormatter={fmtAxisM}
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              width={52}
            />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--popover))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                fontSize: 11,
              }}
              formatter={(v: any) => [fmtTooltipM(Number(v)), title.split(" — ")[0]]}
              labelFormatter={(v) => `Spot ${Number(v).toFixed(2)}`}
            />
            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
            <ReferenceLine
              x={spot}
              stroke="hsl(var(--foreground))"
              strokeDasharray="4 2"
              label={{ value: `Spot ${spot.toFixed(2)}`, position: "insideTopRight", fill: "hsl(var(--foreground))", fontSize: 9 }}
            />
            {zeroSpot != null && flipLabel && (
              <ReferenceLine
                x={zeroSpot}
                stroke="#f59e0b"
                strokeDasharray="3 3"
                label={{ value: `${flipLabel} ${zeroSpot.toFixed(1)}`, position: "insideBottomLeft", fill: "#f59e0b", fontSize: 9 }}
              />
            )}
            {/* Positive side fill */}
            <Area
              type="monotone"
              dataKey={(d: any) => Math.max(0, d.v)}
              stroke="hsl(142 71% 45%)"
              strokeWidth={1.5}
              fill={`url(#grad-pos-${testId})`}
              isAnimationActive={false}
            />
            {/* Negative side fill (plot as positive but colored red, uses separate gradient) */}
            <Area
              type="monotone"
              dataKey={(d: any) => Math.min(0, d.v)}
              stroke="hsl(0 84% 55%)"
              strokeWidth={1.5}
              fill={`url(#grad-neg-${testId})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Footnote() {
  return (
    <div className="mt-3 rounded-md bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
      <span className="font-semibold text-foreground">Read:</span>{" "}
      Green = dealers long that Greek at that spot (stabilizing). Red = short (amplifying).
      GEX flip level is where dealer hedging regime inverts — above it, rallies get sold; below, sell-offs get chased.
      VEX and Charm flips are less well-known but drive vol-crush (VEX) and EOD pinning (Charm) behavior.
      Math: Black-Scholes with continuous dividend · 262 trading days/yr · OI weighted.
    </div>
  );
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

/** Y-axis tick formatter. Input is already scaled to millions (divided by 1e6). */
function fmtAxisM(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}B`;
  if (abs >= 1)    return `${sign}${abs.toFixed(0)}M`;
  if (abs === 0)   return "0";
  return `${sign}${abs.toFixed(1)}M`;
}

/** Tooltip formatter. Input is scaled to millions. */
function fmtTooltipM(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  const abs = Math.abs(v);
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(2)}B`;
  return `${sign}${abs.toFixed(1)}M`;
}
