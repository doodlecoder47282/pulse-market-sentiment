// ModelsPanel.tsx
//
// Forward-model visualization — BASE / BULL / BEAR price paths with structural
// levels (call wall, put wall, zero-gamma, dominant magnet, extreme vacuum,
// MOPEX max pain, upside/downside pivots) anchored to dealer exposure math.
//
// Three horizons: Daily, Weekly, Monthly. Symbol toggle: SPX / SPY.
// Top-left audit box mirrors the original screenshot style (slope, path, OPEX
// gravity, DEX, GEX, VEX, Charm, gamma zone badge).
//
// Data source: GET /api/models?symbol=^GSPC|SPY
// Persistence: server responds with session="live" or "last-close"; last-close
// displays a prominent badge and "Last session" note.

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, ReferenceLine, ReferenceDot, ReferenceArea,
  ResponsiveContainer, XAxis, YAxis, Tooltip, Label,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity, AlertTriangle, Target, Zap, TrendingUp, TrendingDown, Minus, CircleDot, RefreshCw,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

// ─── Types mirror server/models.ts ──────────────────────────────────────────

type Horizon = "daily" | "weekly" | "monthly";

interface ModelLevel {
  label: string;
  name: string;
  price: number;
  kind: string;
  gex?: number;
  tag?: string;
  note?: string;
}

interface ModelPathWaypoint {
  label: string;
  t: number;
  price: number;
}

interface ModelPath {
  kind: "base" | "bull" | "bear";
  name: string;
  probability: number;
  target: number;
  waypoints: ModelPathWaypoint[];
  color: "base" | "bull" | "bear";
}

interface ModelAudit {
  asOf: number;
  spot: number;
  spotChange: string;
  slope: string;
  path: string;
  opexGravity: string;
  gexTotal: number;
  dex: number;
  charmPerDay: number;
  vexPerVolPct: number;
  vannaBias: "positive" | "negative";
  gammaZone: "y+" | "y-";
  gammaZoneLabel: string;
  nearby: { price: number; note: string; dir: "up" | "down" }[];
}

interface ModelHorizon {
  horizon: Horizon;
  label: string;
  symbol: string;
  displaySymbol: string;
  spot: number;
  spotAnchorDate: string;
  targetDate: string;
  priceRange: [number, number];
  levels: ModelLevel[];
  paths: ModelPath[];
  audit: ModelAudit;
  vol: { vix: number | null; vixChangePct: number | null; termRatio: number | null; termLabel: string };
  vomma: "elevated" | "normal";
  confidence: "HIGH" | "MODERATE" | "LOW";
}

interface ModelsResponse {
  asOf: number;
  session: "live" | "last-close";
  horizons: Record<Horizon, ModelHorizon | null>;
  warnings: string[];
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function fmtNum(n: number, d = 0): string {
  if (!isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtB(n: number, d = 2): string {
  if (!isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(d)}B`;
}

function fmtM(n: number, d = 0): string {
  if (!isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(n / 1e6).toFixed(d)}M`;
}

function fmtPct(n: number | null, d = 2): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
}

// Color coding for levels
function levelColor(kind: string): string {
  switch (kind) {
    case "callWall":      return "#10b981"; // emerald
    case "putWall":       return "#f43f5e"; // rose
    case "zeroGamma":     return "#f59e0b"; // amber
    case "dominantMag":   return "#14b8a6"; // teal
    case "strongMag":     return "#0ea5e9"; // sky
    case "extremeVac":    return "#ef4444"; // red
    case "mopexMaxPain":  return "#f59e0b"; // amber
    case "upsidePivot":   return "#a855f7"; // purple
    case "downsidePivot": return "#a855f7"; // purple
    case "t1Up": case "t2Up": return "#065f46";
    case "t1Down": case "t2Down": return "#7f1d1d";
    // experimental dealer-map kinds
    case "vannaFlip":     return "#06b6d4"; // cyan
    case "zommaBridge":   return "#fde047"; // yellow
    case "charmTarget":   return "#c084fc"; // purple-light
    case "negGammaEntry": return "#fb7185"; // rose-light
    case "upperVomma":    return "#84cc16"; // lime
    case "lowerVomma":    return "#f97316"; // orange
    default: return "#64748b";
  }
}

function levelLabelStyle(kind: string): { opacity: number; strokeDasharray?: string } {
  const major = ["callWall", "putWall", "zeroGamma", "dominantMag", "extremeVac", "mopexMaxPain"];
  return major.includes(kind)
    ? { opacity: 1.0, strokeDasharray: "4 4" }
    : { opacity: 0.6, strokeDasharray: "2 3" };
}

// ─── Main panel ─────────────────────────────────────────────────────────────

export default function ModelsPanel() {
  const [symbol, setSymbol] = useState<"^GSPC" | "SPY">("^GSPC");
  const [horizon, setHorizon] = useState<Horizon>("weekly");
  // Experimental dealer-map levels: enabled when the main URL contains
  // ?experimental=1 (before the hash) — check window.location.search.
  // Safe in SSR because we guard for `window`.
  const experimental = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("experimental") === "1";
  }, []);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<ModelsResponse>({
    queryKey: ["/api/models", symbol, experimental],
    queryFn: async () => {
      const qs = new URLSearchParams({ symbol });
      if (experimental) qs.set("experimental", "1");
      const r = await apiRequest("GET", `/api/models?${qs.toString()}`);
      return r.json();
    },
    refetchInterval: 5 * 60_000,
    staleTime: 4 * 60_000,
  });

  const active = data?.horizons[horizon];

  return (
    <div className="space-y-4">
      {/* Header: horizon pills + symbol toggle + session badge */}
      <Card className="border-border">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-primary" />
            <div>
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Forward Models</div>
              <div className="text-sm font-semibold">GEX-anchored path projections</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Horizon pills */}
            <div className="flex gap-1 rounded-md border border-border bg-card/40 p-1">
              {(["daily", "weekly", "monthly"] as Horizon[]).map((h) => (
                <Button
                  key={h}
                  variant={horizon === h ? "default" : "ghost"}
                  size="sm"
                  className="h-7 text-[11px] uppercase tracking-wider"
                  onClick={() => setHorizon(h)}
                  data-testid={`btn-horizon-${h}`}
                >
                  {h}
                </Button>
              ))}
            </div>

            {/* Symbol toggle */}
            <div className="flex gap-1 rounded-md border border-border bg-card/40 p-1">
              {([
                { k: "^GSPC" as const, label: "SPX" },
                { k: "SPY" as const, label: "SPY" },
              ]).map(({ k, label }) => (
                <Button
                  key={k}
                  variant={symbol === k ? "default" : "ghost"}
                  size="sm"
                  className="h-7 text-[11px] tracking-wider"
                  onClick={() => setSymbol(k)}
                  data-testid={`btn-symbol-${label}`}
                >
                  {label}
                </Button>
              ))}
            </div>

            {/* Session badge */}
            {data && (
              <Badge
                variant="outline"
                className={
                  data.session === "live"
                    ? "border-emerald-500/40 text-emerald-400"
                    : "border-amber-500/40 text-amber-300"
                }
              >
                {data.session === "live" ? "LIVE" : "LAST SESSION"}
              </Badge>
            )}

            {/* Experimental dealer-map flag */}
            {experimental && (
              <Badge
                variant="outline"
                className="border-violet-500/50 bg-violet-500/10 text-violet-300"
                data-testid="badge-experimental"
                title="Dealer-map levels (Vanna Flip, Zomma Bridge, Charm Target, Neg γ Entry, Upper/Lower Vomma) are active"
              >
                EXPERIMENTAL · DEALER MAP
              </Badge>
            )}

            <Button
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="h-7 gap-1 text-[11px]"
              data-testid="btn-models-refresh"
            >
              <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading && <ModelsSkeleton />}
      {isError && !isLoading && (
        <Card className="border-rose-500/30 bg-rose-500/5">
          <CardContent className="p-6 text-center text-rose-400">
            Couldn't build model. The options chain may be rate-limited — try again in a minute.
          </CardContent>
        </Card>
      )}
      {data && !active && !isLoading && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-6 text-center text-amber-300">
            {data.warnings.length
              ? data.warnings.join(" · ")
              : `${horizon.toUpperCase()} model couldn't be built for ${symbol}.`}
          </CardContent>
        </Card>
      )}
      {active && <ModelView horizon={active} />}
    </div>
  );
}

// ─── Horizon view ───────────────────────────────────────────────────────────

function ModelView({ horizon }: { horizon: ModelHorizon }) {
  const a = horizon.audit;

  // Build chart data — merged path per date
  const chartData = useMemo(() => {
    // Take the longest path's waypoint labels as x-axis
    const longest = horizon.paths.reduce((a, b) =>
      a.waypoints.length >= b.waypoints.length ? a : b,
    );
    return longest.waypoints.map((wp, i) => {
      const row: any = { t: wp.t, label: wp.label };
      for (const p of horizon.paths) {
        const point = p.waypoints[i];
        if (point) row[p.kind] = point.price;
      }
      return row;
    });
  }, [horizon]);

  const [yMin, yMax] = horizon.priceRange;
  const yPad = (yMax - yMin) * 0.04;

  // Collision-avoidance pass on level labels — hide labels whose price sits
  // within ~1.5% of the y-range of a higher-priority label already shown.
  // Priority ranking: major levels (call wall / put wall / zero-gamma /
  // dominant magnet / extreme vac / max pain) beat minor (t1/t2/strong mag).
  const displayLevels = useMemo(() => {
    const gap = (yMax - yMin) * 0.025;
    const priority = (k: string) =>
      ["callWall", "putWall", "zeroGamma", "dominantMag", "extremeVac", "mopexMaxPain", "upsidePivot", "downsidePivot"].includes(k) ? 2
      : ["strongMag"].includes(k) ? 1
      : 0;
    const sorted = [...horizon.levels].sort((a, b) => {
      const pd = priority(b.kind) - priority(a.kind);
      if (pd !== 0) return pd;
      return b.price - a.price;
    });
    const shown: { kind: string; price: number; showLabel: boolean; origIdx: number }[] = [];
    for (const lv of sorted) {
      const clash = shown.some((s) => s.showLabel && Math.abs(s.price - lv.price) < gap);
      shown.push({ kind: lv.kind, price: lv.price, showLabel: !clash, origIdx: horizon.levels.indexOf(lv) });
    }
    // Back to original order with showLabel flag attached
    return horizon.levels.map((lv, i) => {
      const s = shown.find((x) => x.origIdx === i);
      return { ...lv, showLabel: s?.showLabel ?? true };
    });
  }, [horizon, yMin, yMax]);

  return (
    <div className="space-y-4">
      {/* Title bar */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-bold tracking-wider" data-testid="text-model-label">
            {horizon.label}
          </h2>
          <span className="text-sm text-muted-foreground">
            {horizon.spotAnchorDate} → {horizon.targetDate}
          </span>
          <Badge variant="outline" className="text-[10px] uppercase tracking-widest">
            Full Audit
          </Badge>
          {horizon.vomma === "elevated" && (
            <Badge variant="outline" className="border-amber-500/40 text-amber-300 text-[10px] uppercase">
              <AlertTriangle className="mr-1 h-3 w-3" />
              Vol Elevated
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>VIX {horizon.vol.vix?.toFixed(2) ?? "—"}</span>
          <span>·</span>
          <span>{fmtPct(horizon.vol.vixChangePct)}</span>
          <span>·</span>
          <span>term {horizon.vol.termRatio?.toFixed(3) ?? "—"}</span>
          <span className="italic">({horizon.vol.termLabel})</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Chart */}
        <Card className="xl:col-span-9">
          <CardContent className="p-4">
            <div className="h-[500px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 16, right: 140, left: 0, bottom: 22 }}>
                  <XAxis
                    dataKey="label"
                    stroke="#94a3b8"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: "#334155" }}
                  />
                  <YAxis
                    domain={[yMin - yPad, yMax + yPad]}
                    stroke="#94a3b8"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => fmtNum(v, 0)}
                    width={58}
                    tickLine={false}
                    axisLine={{ stroke: "#334155" }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(15,23,42,0.97)",
                      border: "1px solid #334155",
                      borderRadius: 6,
                      fontSize: 11,
                      color: "#e2e8f0",
                    }}
                    formatter={(value: number, name: string) => [fmtNum(value, 2), name.toUpperCase()]}
                    labelStyle={{ color: "#94a3b8" }}
                  />

                  {/* Background zone shading by gamma regime */}
                  {a.gammaZone === "y-" && (
                    <ReferenceArea
                      y1={yMin - yPad}
                      y2={horizon.levels.find((l) => l.kind === "zeroGamma")?.price ?? horizon.spot}
                      fill="#f43f5e"
                      fillOpacity={0.05}
                      strokeOpacity={0}
                    />
                  )}
                  {a.gammaZone === "y+" && (
                    <ReferenceArea
                      y1={horizon.levels.find((l) => l.kind === "zeroGamma")?.price ?? horizon.spot}
                      y2={yMax + yPad}
                      fill="#10b981"
                      fillOpacity={0.04}
                      strokeOpacity={0}
                    />
                  )}

                  {/* Structural levels — one ReferenceLine per level, labels
                      suppressed when collision-avoidance flags them */}
                  {displayLevels.map((lv) => {
                    const color = levelColor(lv.kind);
                    const st = levelLabelStyle(lv.kind);
                    return (
                      <ReferenceLine
                        key={`${lv.kind}-${lv.price}`}
                        y={lv.price}
                        stroke={color}
                        strokeDasharray={st.strokeDasharray}
                        strokeOpacity={st.opacity}
                        ifOverflow="extendDomain"
                      >
                        {lv.showLabel && (
                          <Label
                            value={`${lv.name} ${fmtNum(lv.price, 0)}`}
                            position="right"
                            offset={6}
                            fill={color}
                            fontSize={10}
                            style={{ fontFamily: "ui-monospace, monospace", opacity: st.opacity }}
                          />
                        )}
                      </ReferenceLine>
                    );
                  })}

                  {/* Path lines */}
                  {horizon.paths.map((p) => {
                    const stroke = p.kind === "base" ? "#f59e0b" : p.kind === "bull" ? "#10b981" : "#ef4444";
                    return (
                      <Line
                        key={p.kind}
                        type="monotone"
                        dataKey={p.kind}
                        stroke={stroke}
                        strokeWidth={p.kind === "base" ? 2 : 2.5}
                        dot={{ r: 3.5, fill: stroke, strokeWidth: 0 }}
                        activeDot={{ r: 5, fill: stroke, strokeWidth: 2, stroke: "#fff" }}
                        isAnimationActive={false}
                      />
                    );
                  })}

                  {/* Spot marker on first waypoint */}
                  <ReferenceDot
                    x={chartData[0]?.label}
                    y={horizon.spot}
                    r={6}
                    fill="#f59e0b"
                    stroke="#fff"
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Legend */}
            <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-border pt-3 text-[11px]">
              {horizon.paths.map((p) => {
                const stroke = p.kind === "base" ? "#f59e0b" : p.kind === "bull" ? "#10b981" : "#ef4444";
                return (
                  <div key={p.kind} className="flex items-center gap-2">
                    <div className="h-[3px] w-8 rounded" style={{ background: stroke }} />
                    <span className="font-mono">
                      {p.name} {Math.round(p.probability * 100)}% → {fmtNum(p.target, 0)}
                    </span>
                  </div>
                );
              })}
              <div className="mx-2 h-3 border-l border-border" />
              <div className="flex items-center gap-2">
                <CircleDot className="h-3 w-3 text-amber-400" />
                <span className="font-mono">Spot {fmtNum(horizon.spot, 2)}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500/60" />
                <span className="text-muted-foreground">γ+ zone (dampening)</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-rose-500/60" />
                <span className="text-muted-foreground">γ− zone (amplifying)</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Audit panel */}
        <Card className="xl:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Target className="h-4 w-4 text-amber-400" />
              Audit
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 p-4 pt-0 font-mono text-[11px]">
            <div>
              <div className="text-muted-foreground">Spot</div>
              <div className="text-lg font-bold text-foreground">{fmtNum(horizon.spot, 2)}</div>
              {a.spotChange && <div className="text-[10px] text-muted-foreground">{a.spotChange}</div>}
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-2">
              <div>
                <div className="text-[10px] text-muted-foreground">SLOPE</div>
                <div>{a.slope}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground">PATH</div>
                <div>{a.path}</div>
              </div>
            </div>
            <div className="border-t border-border pt-2">
              <div className="text-[10px] text-muted-foreground">OPEX GRAVITY</div>
              <div>{a.opexGravity}</div>
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-2">
              <div>
                <div className="text-[10px] text-muted-foreground">GEX TOTAL</div>
                <div className={a.gexTotal >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  {fmtM(a.gexTotal)}/1%
                </div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground">DEX</div>
                <div>{fmtB(a.dex)}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground">CHARM</div>
                <div className={a.charmPerDay >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  {fmtB(a.charmPerDay)}/d
                </div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground">VEX</div>
                <div>{fmtB(a.vexPerVolPct)}/1%v</div>
              </div>
            </div>
            <div className="border-t border-border pt-2">
              <div className="text-[10px] text-muted-foreground">γ ZONE</div>
              <Badge
                variant="outline"
                className={
                  a.gammaZone === "y+"
                    ? "border-emerald-500/40 text-emerald-400"
                    : "border-rose-500/40 text-rose-400"
                }
              >
                {a.gammaZone} · {a.gammaZoneLabel}
              </Badge>
            </div>
            <div className="border-t border-border pt-2">
              <div className="text-[10px] text-muted-foreground">VANNA BIAS</div>
              <Badge
                variant="outline"
                className={
                  a.vannaBias === "positive"
                    ? "border-sky-500/40 text-sky-400"
                    : "border-amber-500/40 text-amber-300"
                }
              >
                {a.vannaBias}
              </Badge>
            </div>
            <div className="border-t border-border pt-2">
              <div className="mb-1 text-[10px] text-muted-foreground">NEAR</div>
              {a.nearby.slice(0, 6).map((n, i) => {
                // n.note still arrives as "624bp · UPSIDE PIVOT" from the
                // server; parse the bp + name so we can render three
                // clean columns (signed bp | price | name).
                const m = /^(-?\d+)bp\s+·\s+(.+)$/.exec(n.note);
                const bp = m ? Number(m[1]) : null;
                const name = m ? m[2] : n.note;
                const signedBp =
                  bp == null ? "—" : `${bp > 0 ? "+" : ""}${bp}bp`;
                const bpCls =
                  bp == null ? "text-muted-foreground"
                  : bp > 0 ? "text-emerald-400"
                  : bp < 0 ? "text-rose-400"
                  : "text-foreground";
                return (
                  <div
                    key={i}
                    className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-x-2 py-0.5 text-[10px]"
                    data-testid={`near-row-${i}`}
                  >
                    <span className={`font-mono tabular-nums ${bpCls}`}>
                      {signedBp}
                    </span>
                    <span className="font-mono tabular-nums text-foreground">
                      {n.price.toFixed(n.price >= 100 ? 2 : 2)}
                    </span>
                    <span className="truncate text-muted-foreground">{name}</span>
                    {n.dir === "up" ? (
                      <TrendingUp className="h-3 w-3 flex-shrink-0 text-emerald-400" />
                    ) : (
                      <TrendingDown className="h-3 w-3 flex-shrink-0 text-rose-400" />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="border-t border-border pt-2 text-[10px] text-muted-foreground">
              Confidence: <span className="text-foreground">{horizon.confidence}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ModelsSkeleton() {
  return (
    <Card>
      <CardContent className="p-4">
        <Skeleton className="h-[500px] w-full" />
      </CardContent>
    </Card>
  );
}
