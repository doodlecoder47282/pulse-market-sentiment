/**
 * Heatseeker.tsx — 0DTE live Greeks heatseeker view.
 *
 * Layout (stacked):
 *   1. Header: spot price, expiry, DTE, totals strip, sticky-zone rank top-3
 *   2. Heatmap grid: strikes (rows) × metric (cols: GEX, DEX, Vanna, Charm)
 *      Cell color = signed intensity. Spot row highlighted.
 *      Locked SPX weekly levels overlaid as dashed horizontal guides.
 *   3. Greek profile lines: GEX + DEX + Vanna + Charm across strike axis
 *   4. Sticky-zone cards: top 5 with score breakdown + interpretation
 *
 * Polls /api/heatseeker every 5s. Respects SchwabGate — shows setup prompt if
 * unconnected.
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useMemo, useState } from "react";
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Activity, AlertTriangle, Flame, Target, TrendingDown, TrendingUp } from "lucide-react";
import LiveOdteTracker from "./LiveOdteTracker";
import DepthSkewFlow from "./DepthSkewFlow";

// ─── User's locked SPX weekly targets (from session context) ───────────────
const LOCKED_LEVELS: Array<{ value: number; label: string; kind: "upside" | "downside" | "pin" | "vomma" }> = [
  { value: 7270, label: "T2 UP", kind: "upside" },
  { value: 7265, label: "UPPER VOMMA", kind: "vomma" },
  { value: 7140, label: "UPSIDE", kind: "upside" },
  { value: 7128, label: "CHARM", kind: "pin" },
  { value: 7100, label: "NEG γ", kind: "pin" },
  { value: 7089, label: "VANNA", kind: "pin" },
  { value: 7070, label: "ZOMMA", kind: "pin" },
  { value: 7025, label: "MOPEX", kind: "pin" },
  { value: 6960, label: "LOWER VOMMA", kind: "vomma" },
  { value: 6950, label: "DOWNSIDE", kind: "downside" },
  { value: 6885, label: "T2 DOWN", kind: "downside" },
];

// ─── Types matching /api/heatseeker ────────────────────────────────────────
interface Strike {
  strike: number;
  distancePct: number;
  netGex: number;
  netDex: number;
  netVanna: number;
  netCharm: number;
  callOI: number;
  putOI: number;
  totalOI: number;
  callVol: number;
  putVol: number;
  totalVol: number;
  callIV: number | null;
  putIV: number | null;
}

interface StickyZone {
  strike: number;
  distancePct: number;
  score: number;
  rank: number;
  components: { gexContribution: number; oiContribution: number; charmContribution: number };
  interpretation: string;
}

interface HeatseekerData {
  symbol: string;
  spot: number;
  expiry: string;
  dte: number;
  asOf: number;
  strikes: Strike[];
  stickyZones: StickyZone[];
  totals: {
    netGex: number;
    netDex: number;
    netVanna: number;
    netCharm: number;
    callWall: number | null;
    putWall: number | null;
    zeroGamma: number | null;
  };
}

// ─── Formatters ────────────────────────────────────────────────────────────
const fmtM = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};
const fmtStrike = (n: number) => n.toFixed(0);

// Map a signed value to a background color. Positive = emerald, negative = rose.
function cellColor(value: number, max: number): string {
  if (max === 0 || !isFinite(value)) return "rgba(100,116,139,0.08)";
  const intensity = Math.min(Math.abs(value) / max, 1);
  const alpha = 0.08 + intensity * 0.75;
  if (value >= 0) return `rgba(16,185,129,${alpha.toFixed(3)})`;
  return `rgba(244,63,94,${alpha.toFixed(3)})`;
}

// ─── Main component ────────────────────────────────────────────────────────
export default function Heatseeker() {
  const [symbol] = useState("$SPX");

  const { data, isLoading, error } = useQuery<HeatseekerData>({
    queryKey: ["/api/heatseeker", symbol],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/heatseeker?symbol=${encodeURIComponent(symbol)}`);
      return res.json();
    },
    refetchInterval: 5_000,        // 5-second live tick
    refetchIntervalInBackground: false,
    staleTime: 4_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !data || (data as any).error) {
    const msg = (data as any)?.message ?? (error as Error)?.message ?? "Unable to load heatseeker";
    return (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="flex items-center gap-3 pt-6">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          <div>
            <div className="font-semibold text-amber-400">Schwab connection needed</div>
            <div className="text-sm text-muted-foreground">{msg}</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return <HeatseekerView data={data} />;
}

// ─── View (data guaranteed) ────────────────────────────────────────────────
function HeatseekerView({ data }: { data: HeatseekerData }) {
  const { strikes, stickyZones, totals, spot, expiry, dte, symbol, asOf } = data;

  // Max absolute values for heatmap normalization
  const maxAbsGex = useMemo(() => Math.max(...strikes.map((s) => Math.abs(s.netGex)), 1), [strikes]);
  const maxAbsDex = useMemo(() => Math.max(...strikes.map((s) => Math.abs(s.netDex)), 1), [strikes]);
  const maxAbsVanna = useMemo(() => Math.max(...strikes.map((s) => Math.abs(s.netVanna)), 1), [strikes]);
  const maxAbsCharm = useMemo(() => Math.max(...strikes.map((s) => Math.abs(s.netCharm)), 1), [strikes]);

  // Strikes sorted descending so higher strikes appear at top of heatmap (price chart convention)
  const rows = useMemo(() => [...strikes].sort((a, b) => b.strike - a.strike), [strikes]);

  // Chart data — ascending for x-axis
  const chartData = useMemo(
    () => [...strikes].sort((a, b) => a.strike - b.strike).map((s) => ({
      strike: s.strike,
      gex: s.netGex,
      dex: s.netDex,
      vanna: s.netVanna,
      charm: s.netCharm,
    })),
    [strikes],
  );

  const tickTime = new Date(asOf).toLocaleTimeString("en-US", { hour12: false });

  // Filter locked levels to those visible in the strike window
  const minStrike = Math.min(...strikes.map((s) => s.strike));
  const maxStrike = Math.max(...strikes.map((s) => s.strike));
  const visibleLevels = LOCKED_LEVELS.filter((l) => l.value >= minStrike && l.value <= maxStrike);

  return (
    <div className="space-y-5">
      {/* ── Header strip ──────────────────────────────────────────────── */}
      <Card className="border-primary/20 bg-gradient-to-br from-background to-primary/5">
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Flame className="h-7 w-7 text-orange-500" />
              <div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                  HEATSEEKER · {symbol} · {dte}DTE · exp {expiry}
                </div>
                <div className="mt-0.5 font-mono text-2xl font-bold tabular-nums">
                  {spot.toFixed(2)}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat label="Net GEX" value={fmtM(totals.netGex)} positive={totals.netGex >= 0} />
              <Stat label="Net DEX" value={fmtM(totals.netDex)} positive={totals.netDex >= 0} />
              <Stat label="Net Vanna" value={fmtM(totals.netVanna)} positive={totals.netVanna >= 0} />
              <Stat label="Net Charm" value={fmtM(totals.netCharm)} positive={totals.netCharm >= 0} />
            </div>
            <div className="flex gap-2 text-xs">
              {totals.callWall !== null && (
                <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/5 text-emerald-400">
                  Call Wall {totals.callWall.toFixed(0)}
                </Badge>
              )}
              {totals.putWall !== null && (
                <Badge variant="outline" className="border-rose-500/40 bg-rose-500/5 text-rose-400">
                  Put Wall {totals.putWall.toFixed(0)}
                </Badge>
              )}
              {totals.zeroGamma !== null && (
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/5 text-amber-400">
                  0γ {totals.zeroGamma.toFixed(0)}
                </Badge>
              )}
              <Badge variant="outline" className="font-mono">last {tickTime}</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Heatmap grid ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="h-4 w-4 text-primary" />
            Greek Heatmap · strike × metric
          </CardTitle>
          <div className="text-xs text-muted-foreground">
            Emerald = positive (dealers long / supportive) · Rose = negative (dealers short / accelerant).
            Horizontal guides = your locked weekly targets.
          </div>
        </CardHeader>
        <CardContent>
          <div className="relative overflow-x-auto">
            <div className="min-w-[640px]">
              {/* Header row */}
              <div className="grid grid-cols-[92px_repeat(4,1fr)_96px] gap-px border-b pb-1 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                <div>Strike</div>
                <div className="text-center">GEX</div>
                <div className="text-center">DEX</div>
                <div className="text-center">Vanna</div>
                <div className="text-center">Charm</div>
                <div className="text-right">OI · Vol</div>
              </div>
              {rows.map((s) => {
                const isSpotRow = Math.abs(s.strike - spot) < 2.5;
                const lockedHit = visibleLevels.find((l) => Math.abs(l.value - s.strike) < 2.5);
                return (
                  <div
                    key={s.strike}
                    className={`grid grid-cols-[92px_repeat(4,1fr)_96px] gap-px border-b border-border/30 py-1 ${
                      isSpotRow ? "bg-primary/10 ring-1 ring-primary/30" : ""
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-mono text-sm tabular-nums">
                      <span className={isSpotRow ? "font-bold text-primary" : ""}>{fmtStrike(s.strike)}</span>
                      {lockedHit && (
                        <span
                          className={`rounded-sm px-1 text-[9px] font-semibold ${
                            lockedHit.kind === "upside"
                              ? "bg-emerald-500/20 text-emerald-400"
                              : lockedHit.kind === "downside"
                                ? "bg-rose-500/20 text-rose-400"
                                : lockedHit.kind === "vomma"
                                  ? "bg-violet-500/20 text-violet-400"
                                  : "bg-amber-500/20 text-amber-400"
                          }`}
                        >
                          {lockedHit.label}
                        </span>
                      )}
                    </div>
                    <HeatCell value={s.netGex} max={maxAbsGex} />
                    <HeatCell value={s.netDex} max={maxAbsDex} />
                    <HeatCell value={s.netVanna} max={maxAbsVanna} />
                    <HeatCell value={s.netCharm} max={maxAbsCharm} />
                    <div className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                      {fmtM(s.totalOI)} · {fmtM(s.totalVol)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Depth · Skew · Flow — 3 synchronized real-time views ─────── */}
      <DepthSkewFlow />

      {/* ── Live 0DTE tracker — directly under the Greek heatmap ───────── */}
      <LiveOdteTracker />

      {/* ── Greek profile curves ──────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" />
            Greek Profile · exposures across strikes
          </CardTitle>
          <div className="text-xs text-muted-foreground">
            GEX bars (left axis, $ per 1% move) · DEX / Vanna / Charm lines (right axis, $).
            Dashed vertical = your locked targets · solid vertical = spot.
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-[380px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis
                  dataKey="strike"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => v.toFixed(0)}
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v) => fmtM(v)}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v) => fmtM(v)}
                />
                <Tooltip
                  contentStyle={{
                    background: "rgba(15,23,42,0.95)",
                    border: "1px solid rgba(148,163,184,0.3)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value: any, name) => [fmtM(Number(value)), String(name).toUpperCase()]}
                  labelFormatter={(v) => `Strike ${v}`}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
                <ReferenceLine
                  x={spot}
                  yAxisId="left"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  label={{ value: `SPOT ${spot.toFixed(0)}`, fill: "hsl(var(--primary))", fontSize: 10, position: "top" }}
                />
                {visibleLevels.map((l) => (
                  <ReferenceLine
                    key={l.value}
                    x={l.value}
                    yAxisId="left"
                    stroke={
                      l.kind === "upside"
                        ? "rgba(16,185,129,0.45)"
                        : l.kind === "downside"
                          ? "rgba(244,63,94,0.45)"
                          : l.kind === "vomma"
                            ? "rgba(139,92,246,0.45)"
                            : "rgba(245,158,11,0.45)"
                    }
                    strokeDasharray="4 3"
                    label={{ value: l.label, fontSize: 9, fill: "rgba(148,163,184,0.9)", position: "insideTop" }}
                  />
                ))}
                <Bar
                  yAxisId="left"
                  dataKey="gex"
                  name="GEX"
                  fill="rgba(16,185,129,0.5)"
                  radius={[2, 2, 0, 0]}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="dex"
                  name="DEX"
                  stroke="#38bdf8"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="vanna"
                  name="Vanna"
                  stroke="#c084fc"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="charm"
                  name="Charm"
                  stroke="#fbbf24"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* ── Sticky zone leaderboard ───────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Flame className="h-4 w-4 text-orange-500" />
            Sticky Zones · top 5 ranked by composite score
          </CardTitle>
          <div className="text-xs text-muted-foreground">
            Score = 50% |GEX| + 30% OI density + 20% charm acceleration.
            Higher rank = stronger price magnet for today's action.
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {stickyZones.map((z) => (
              <StickyCard key={z.strike} zone={z} spot={spot} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────
function Stat({ label, value, positive }: { label: string; value: string; positive: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={`flex items-center gap-1 font-mono text-lg font-semibold tabular-nums ${
          positive ? "text-emerald-400" : "text-rose-400"
        }`}
      >
        {positive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
        {value}
      </div>
    </div>
  );
}

function HeatCell({ value, max }: { value: number; max: number }) {
  const bg = cellColor(value, max);
  return (
    <div
      className="flex items-center justify-center rounded-sm px-2 py-1 font-mono text-[10px] tabular-nums"
      style={{ background: bg }}
      title={fmtM(value)}
    >
      {fmtM(value)}
    </div>
  );
}

function StickyCard({ zone, spot }: { zone: StickyZone; spot: number }) {
  const above = zone.strike > spot;
  const rankColor =
    zone.rank === 1
      ? "border-orange-500/50 bg-orange-500/10"
      : zone.rank === 2
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-border/50 bg-muted/30";
  return (
    <div className={`rounded-lg border p-4 ${rankColor}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Badge className="h-6 bg-orange-500/20 font-mono text-sm text-orange-400 hover:bg-orange-500/30">
              #{zone.rank}
            </Badge>
            <span className="font-mono text-xl font-bold tabular-nums">{zone.strike.toFixed(0)}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {above ? "above" : "below"} spot · {zone.distancePct >= 0 ? "+" : ""}
            {zone.distancePct.toFixed(2)}%
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-bold tabular-nums text-orange-400">
            {zone.score.toFixed(0)}
          </div>
          <div className="text-[10px] text-muted-foreground">SCORE</div>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-foreground/80">{zone.interpretation}</p>
      <div className="mt-3 space-y-1.5">
        <ScoreBar label="GEX" value={zone.components.gexContribution} color="emerald" />
        <ScoreBar label="OI" value={zone.components.oiContribution} color="sky" />
        <ScoreBar label="Charm" value={zone.components.charmContribution} color="amber" />
      </div>
    </div>
  );
}

function ScoreBar({ label, value, color }: { label: string; value: number; color: "emerald" | "sky" | "amber" }) {
  const bg = color === "emerald" ? "bg-emerald-500" : color === "sky" ? "bg-sky-500" : "bg-amber-500";
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <div className="w-10 font-mono uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`absolute inset-y-0 left-0 ${bg}`}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
      <div className="w-8 text-right font-mono tabular-nums">{value.toFixed(0)}</div>
    </div>
  );
}
