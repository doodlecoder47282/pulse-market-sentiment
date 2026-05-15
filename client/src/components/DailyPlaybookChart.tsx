/**
 * DailyPlaybookChart.tsx
 *
 * Additive panel that lives in the Models tab below the existing ML projection.
 * Shows the server-synthesized 3-path scenario plan from /api/playbook/daily.
 *
 *  - 3-path fan chart (Bull / Base / Bear) anchored at spot, fanning out to
 *    each path's target zone by EOD.
 *  - Level magnets (Call Wall / Put Wall / Gamma Flip / Max Pain) as ref lines.
 *  - Live drift overlay vs the 9:00 ET morning lock.
 *  - Calibration footer listing every input + its source + freshness.
 *
 * Plain-English first: every number explained inline, no jargon required.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ComposedChart, Line, Area, ReferenceLine, ReferenceDot,
  ResponsiveContainer, XAxis, YAxis, Tooltip, Label, CartesianGrid,
} from "recharts";
import { apiRequest } from "@/lib/queryClient";
import ErrorBoundary from "@/components/ErrorBoundary";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, Minus, TrendingDown, Lock, Activity, Info, AlertTriangle, Zap, Heart, HeartCrack, Flame, Snowflake } from "lucide-react";

// ─── Types (mirror server/dailyPlaybook.ts) ─────────────────────────────────

type PathKey = "bull" | "base" | "bear";

interface PathScenario {
  key: PathKey;
  label: string;
  probability: number;
  trigger: { level: number; condition: string };
  target: { low: number; high: number };
  invalidation: number;
  oneLiner: string;
  drivers: string[];
}

interface LevelMagnet {
  level: number;
  label: string;
  kind: "callWall" | "putWall" | "gammaFlip" | "maxPain" | "spot";
  strength: "primary" | "secondary";
}

interface InputManifest {
  key: string;
  label: string;
  value: number | string;
  source: "Schwab" | "Schwab+CBOE" | "CBOE delayed" | "Computed" | "Yahoo";
  asOf: number;
  freshSeconds: number;
  calibration?: string;
}

interface CurrentRegime {
  kind: "long-gamma" | "short-gamma";
  label: string;
  spotVsFlip: number;
  totalGexB: number;
}

interface DailyPlaybook {
  symbol: string;
  spot: number;
  asOf: number;
  marketSession: "premarket" | "rth" | "afterhours" | "closed";
  paths: { bull: PathScenario; base: PathScenario; bear: PathScenario };
  magnets: LevelMagnet[];
  expectedRange: { low: number; high: number; method: string };
  headline: string;
  inputs: InputManifest[];
  currentRegime?: CurrentRegime;
}

type PathHealth = "alive" | "weakening" | "dead";
interface PathHealthEntry {
  path: PathKey;
  health: PathHealth;
  reason: string;
  distanceToInvalidation?: number;
}

interface RegimeOverlay {
  current: "long-gamma" | "short-gamma";
  locked: "long-gamma" | "short-gamma";
  flipped: boolean;
  flipDirection?: "toShort" | "toLong";
  spotVsFlip: number;
  totalGexB: number;
  label: string;
}

interface PlaybookDrift {
  hasLock: boolean;
  spotDrift?: number;
  spotDriftPct?: number;
  probabilityShift?: { bull: number; base: number; bear: number };
  triggerHits?: { path: PathKey; hit: boolean; closeness: number }[];
  rangeExpansion?: number;
  notes: string[];
  pathHealth?: PathHealthEntry[];
  regime?: RegimeOverlay;
}

// ─── Color palette (peer-to-peer, not retail) ───────────────────────────────

const PATH_COLORS: Record<PathKey, string> = {
  bull: "#10b981",  // emerald
  base: "#a3a3a3",  // neutral grey
  bear: "#ef4444",  // red
};

const PATH_FILLS: Record<PathKey, string> = {
  bull: "rgba(16,185,129,0.12)",
  base: "rgba(163,163,163,0.10)",
  bear: "rgba(239,68,68,0.12)",
};

const MAGNET_COLORS: Record<LevelMagnet["kind"], string> = {
  callWall:  "#10b981",
  putWall:   "#ef4444",
  gammaFlip: "#fbbf24",
  maxPain:   "#a78bfa",
  spot:      "#60a5fa",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt$(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pathIcon(k: PathKey) {
  if (k === "bull") return <TrendingUp className="h-3.5 w-3.5" />;
  if (k === "bear") return <TrendingDown className="h-3.5 w-3.5" />;
  return <Minus className="h-3.5 w-3.5" />;
}

/** Build the fan-chart series. Each path is anchored at spot at t=0 and
 *  arcs to (target.low, target.high) at t=1 (EOD). Returns an array of
 *  rows the chart can render. */
function buildPathSeries(pb: DailyPlaybook) {
  const STEPS = 12; // 12 buckets across the day
  const rows: any[] = [];
  const spot = pb.spot;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const row: Record<string, number> = { t };
    for (const k of ["bull", "base", "bear"] as PathKey[]) {
      const tgt = pb.paths[k].target;
      const mid = (tgt.low + tgt.high) / 2;
      // ease-out from spot to midpoint
      const eased = 1 - Math.pow(1 - t, 1.6);
      row[`${k}Mid`] = spot + (mid - spot) * eased;
      row[`${k}Lo`]  = spot + (tgt.low - spot)  * eased;
      row[`${k}Hi`]  = spot + (tgt.high - spot) * eased;
    }
    rows.push(row);
  }
  return rows;
}

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  symbol?: "SPY" | "SPX";
}

export default function DailyPlaybookChart({ symbol = "SPY" }: Props) {
  const { data: pb, isLoading } = useQuery<DailyPlaybook>({
    queryKey: ["/api/playbook/daily", symbol],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/playbook/daily?symbol=${symbol}`);
      return r.json();
    },
    refetchInterval: 60_000, // 1min
    staleTime: 30_000,
  });

  const { data: drift } = useQuery<PlaybookDrift>({
    queryKey: ["/api/playbook/daily/drift", symbol],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/playbook/daily/drift?symbol=${symbol}`);
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const series = useMemo(() => (pb ? buildPathSeries(pb) : []), [pb]);

  if (isLoading || !pb) {
    return (
      <div className="rounded-lg border border-border/40 bg-muted/10 p-4 space-y-3" data-testid="playbook-loading">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const { paths, magnets, expectedRange, headline, inputs, currentRegime } = pb;
  const ordered: PathKey[] = ["bull", "base", "bear"]; // visual order top→bottom
  const winningPath = ordered.reduce((acc, k) => paths[k].probability > paths[acc].probability ? k : acc, "base" as PathKey);

  // Path health lookup (from drift); falls back to alive when no lock
  const healthByPath: Record<PathKey, PathHealthEntry | undefined> = {
    bull: drift?.pathHealth?.find(h => h.path === "bull"),
    base: drift?.pathHealth?.find(h => h.path === "base"),
    bear: drift?.pathHealth?.find(h => h.path === "bear"),
  };

  // Regime: prefer drift.regime (compares current vs locked) else fall back to live currentRegime
  const regimeKind = drift?.regime?.current ?? currentRegime?.kind ?? "long-gamma";
  const regimeLabel = drift?.regime?.label ?? currentRegime?.label ?? "";
  const regimeFlipped = drift?.regime?.flipped ?? false;
  const isLongGamma = regimeKind === "long-gamma";

  // Regime accent: long-gamma = cool blue, short-gamma = hot amber
  const regimeAccent = isLongGamma ? "#60a5fa" : "#f59e0b";
  const regimeBg = isLongGamma ? "rgba(96,165,250,0.06)" : "rgba(245,158,11,0.08)";
  const regimeBorder = isLongGamma ? "rgba(96,165,250,0.30)" : "rgba(245,158,11,0.40)";

  // y-axis bounds: pad below put wall and above call wall
  const minLevel = Math.min(...magnets.map(m => m.level), expectedRange.low);
  const maxLevel = Math.max(...magnets.map(m => m.level), expectedRange.high);
  const yPad = (maxLevel - minLevel) * 0.05;

  return (
    <ErrorBoundary label="DailyPlaybookChart">
      <div className="rounded-lg border border-border/40 bg-muted/5 p-4 space-y-4" data-testid="daily-playbook-chart">
        {/* Header strip */}
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/30 pb-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-amber-400" />
              <span className="font-mono text-[10px] uppercase tracking-widest text-amber-400/80">Daily Playbook</span>
              <span className="text-[11px] text-muted-foreground">— {symbol}</span>
            </div>
            <div className="text-[13px] text-foreground/90 leading-snug max-w-2xl">{headline}</div>
          </div>

          {/* Lock + drift status + regime badge */}
          <div className="flex flex-col items-end gap-1">
            {/* Regime badge — always shown */}
            <Badge
              variant="outline"
              className="text-[10px] gap-1 font-mono"
              style={{ borderColor: regimeBorder, background: regimeBg, color: regimeAccent }}
              data-testid={`badge-regime-${regimeKind}`}
            >
              {isLongGamma ? <Snowflake className="h-3 w-3" /> : <Flame className="h-3 w-3" />}
              {regimeLabel}
            </Badge>

            {drift?.hasLock ? (
              <Badge variant="outline" className="border-amber-500/40 bg-amber-500/5 text-amber-300 text-[10px] gap-1">
                <Lock className="h-3 w-3" />
                Locked 9:00 ET
                {drift.spotDriftPct !== undefined && Math.abs(drift.spotDriftPct) > 0.05 && (
                  <span className="ml-1 font-mono">
                    {drift.spotDriftPct >= 0 ? "+" : ""}{drift.spotDriftPct.toFixed(2)}%
                  </span>
                )}
              </Badge>
            ) : (
              <Badge variant="outline" className="border-muted-foreground/30 text-muted-foreground text-[10px]">
                No lock yet (pre-9:00 ET)
              </Badge>
            )}
            <div className="text-[10px] text-muted-foreground font-mono">
              spot ${fmt$(pb.spot)}
            </div>
          </div>
        </div>

        {/* Regime flip alert — prominent banner when regime changed since lock */}
        {regimeFlipped && drift?.regime && (
          <div
            className="rounded-md border p-2.5 flex items-center gap-2 animate-pulse"
            style={{
              borderColor: "rgba(245,158,11,0.50)",
              background: "rgba(245,158,11,0.08)",
            }}
            data-testid="alert-regime-flip"
          >
            <Zap className="h-4 w-4 text-amber-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold text-amber-300">
                Regime flip detected since 9:00 ET lock
              </div>
              <div className="text-[10px] text-amber-200/80 leading-snug">
                {drift.regime.flipDirection === "toShort"
                  ? "Long→short gamma. Pin regime broken. Expect momentum, wider intraday range, dealer hedging amplifies moves."
                  : "Short→long gamma. Momentum regime ending. Expect mean-reversion, range contraction, dealer hedging dampens moves."}
              </div>
              <div className="text-[10px] font-mono text-amber-200/60 mt-0.5">
                spot vs flip: {drift.regime.spotVsFlip >= 0 ? "+" : ""}${drift.regime.spotVsFlip.toFixed(2)} · GEX {drift.regime.totalGexB >= 0 ? "+" : ""}{drift.regime.totalGexB.toFixed(2)}B
              </div>
            </div>
          </div>
        )}

        {/* Path summary cards — with health re-grade against locked invalidation */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {ordered.map(k => {
            const p = paths[k];
            const isWinner = k === winningPath;
            const h = healthByPath[k];
            const isDead = h?.health === "dead";
            const isWeak = h?.health === "weakening";

            // Card styling: dead = greyed + strikethrough, weak = amber border, winner = amber
            const cardClass = isDead
              ? "border-red-500/30 bg-red-500/5 opacity-50"
              : isWeak
              ? "border-amber-500/40 bg-amber-500/5"
              : isWinner
              ? "border-amber-500/50 bg-amber-500/5"
              : "border-border/40 bg-background/40";

            return (
              <div
                key={k}
                className={`rounded-md border p-2.5 space-y-1.5 transition ${cardClass}`}
                data-testid={`path-card-${k}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5" style={{ color: PATH_COLORS[k] }}>
                    {pathIcon(k)}
                    <span
                      className={`text-[11px] font-semibold uppercase tracking-wider ${isDead ? "line-through" : ""}`}
                    >
                      {p.label}
                    </span>
                    {/* Health pill */}
                    {h && drift?.hasLock && (
                      <span
                        className="ml-1 text-[8px] font-mono uppercase px-1 py-0.5 rounded"
                        style={{
                          color: isDead ? "#fca5a5" : isWeak ? "#fcd34d" : "#86efac",
                          background: isDead ? "rgba(239,68,68,0.15)" : isWeak ? "rgba(245,158,11,0.15)" : "rgba(16,185,129,0.10)",
                        }}
                        data-testid={`health-${k}`}
                      >
                        {isDead ? <HeartCrack className="h-2.5 w-2.5 inline" /> : <Heart className="h-2.5 w-2.5 inline" />}
                        {" "}{h.health}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[12px] font-bold" style={{ color: PATH_COLORS[k], textDecoration: isDead ? "line-through" : "none" }}>
                    {Math.round(p.probability * 100)}%
                  </span>
                </div>
                <div className={`text-[11px] leading-snug ${isDead ? "text-muted-foreground" : "text-foreground/80"}`}>{p.oneLiner}</div>
                <div className="grid grid-cols-2 gap-1 text-[10px] text-muted-foreground border-t border-border/20 pt-1.5">
                  <div>Trigger: <span className="font-mono text-foreground">${fmt$(p.trigger.level)}</span></div>
                  <div>Target: <span className="font-mono text-foreground">${fmt$(p.target.low)}–${fmt$(p.target.high)}</span></div>
                </div>
                {p.invalidation > 0 && (
                  <div className="text-[10px] text-muted-foreground">
                    Invalidates: <span className="font-mono text-red-400/80">${fmt$(p.invalidation)}</span>
                  </div>
                )}
                {/* Health reason — one-liner why thesis is dead/weak/alive */}
                {h && drift?.hasLock && (isDead || isWeak) && (
                  <div className="text-[10px] italic leading-snug pt-1 border-t border-border/20"
                       style={{ color: isDead ? "#fca5a5" : "#fcd34d" }}>
                    {h.reason}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Fan chart */}
        <div className="h-64 sm:h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} margin={{ top: 10, right: 60, left: 8, bottom: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" strokeOpacity={0.3} />
              <XAxis
                dataKey="t"
                type="number"
                domain={[0, 1]}
                ticks={[0, 0.25, 0.5, 0.75, 1]}
                tickFormatter={(v) => v === 0 ? "Now" : v === 1 ? "EOD" : `${Math.round(v * 100)}%`}
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                stroke="#4b5563"
              />
              <YAxis
                domain={[minLevel - yPad, maxLevel + yPad]}
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                stroke="#4b5563"
                width={56}
                tickFormatter={(v) => `$${v.toFixed(0)}`}
              />
              <Tooltip
                contentStyle={{ background: "#0a0a0a", border: "1px solid #374151", fontSize: 11, borderRadius: 6 }}
                labelFormatter={(v) => v === 0 ? "Now (spot)" : v === 1 ? "End of day" : `${Math.round(Number(v) * 100)}% through session`}
                formatter={(val: any, name: string) => {
                  const labels: Record<string, string> = {
                    bullMid: "Bull mid", baseMid: "Base mid", bearMid: "Bear mid",
                    bullLo: "Bull low", bullHi: "Bull high",
                    baseLo: "Base low", baseHi: "Base high",
                    bearLo: "Bear low", bearHi: "Bear high",
                  };
                  return [`$${Number(val).toFixed(2)}`, labels[name] ?? name];
                }}
              />

              {/* Path bands (Hi - Lo as area) */}
              {ordered.map(k => (
                <Area
                  key={`band-${k}`}
                  dataKey={`${k}Hi`}
                  stroke="none"
                  fill={PATH_FILLS[k]}
                  isAnimationActive={false}
                  // Use the lower bound as the baseline so the area renders between Lo and Hi
                  baseLine={(d: any) => d[`${k}Lo`]}
                  legendType="none"
                />
              ))}

              {/* Mid lines */}
              {ordered.map(k => (
                <Line
                  key={`mid-${k}`}
                  type="monotone"
                  dataKey={`${k}Mid`}
                  stroke={PATH_COLORS[k]}
                  strokeWidth={k === winningPath ? 2.5 : 1.5}
                  dot={false}
                  isAnimationActive={false}
                  strokeDasharray={k === winningPath ? "0" : "4 4"}
                />
              ))}

              {/* Level magnets */}
              {magnets.map(m => (
                <ReferenceLine
                  key={`${m.kind}-${m.level}`}
                  y={m.level}
                  stroke={MAGNET_COLORS[m.kind]}
                  strokeDasharray={m.strength === "primary" ? "0" : "3 3"}
                  strokeWidth={m.strength === "primary" ? 1.25 : 1}
                  strokeOpacity={0.7}
                >
                  <Label
                    value={`${m.label} ${fmt$(m.level)}`}
                    position="right"
                    fill={MAGNET_COLORS[m.kind]}
                    fontSize={9}
                    offset={5}
                  />
                </ReferenceLine>
              ))}

              {/* Trigger lines — tinted by current regime (long gamma = cool, short = hot) */}
              {ordered.map(k => {
                const trig = paths[k].trigger.level;
                if (!trig || trig === paths[k].invalidation) return null;
                const isAlive = !drift?.hasLock || healthByPath[k]?.health !== "dead";
                return (
                  <ReferenceLine
                    key={`trig-${k}`}
                    y={trig}
                    stroke={regimeAccent}
                    strokeDasharray="6 3"
                    strokeWidth={k === winningPath ? 1.5 : 1}
                    strokeOpacity={isAlive ? 0.55 : 0.2}
                  >
                    <Label
                      value={`${k} trigger`}
                      position="insideLeft"
                      fill={regimeAccent}
                      fontSize={8}
                      offset={4}
                      opacity={isAlive ? 0.85 : 0.4}
                    />
                  </ReferenceLine>
                );
              })}

              {/* Spot dot at t=0 */}
              <ReferenceDot x={0} y={pb.spot} r={4} fill="#60a5fa" stroke="#1e40af" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Drift overlay notes */}
        {drift?.hasLock && drift.notes.length > 0 && (
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5 text-[11px] space-y-1">
            <div className="flex items-center gap-1.5 font-semibold text-amber-300">
              <Activity className="h-3 w-3" />
              Live drift vs morning lock
            </div>
            <div className="text-foreground/80 leading-snug">
              {drift.notes.join(" · ")}
            </div>
            {drift.probabilityShift && (
              <div className="grid grid-cols-3 gap-2 pt-1 border-t border-amber-500/20 text-[10px]">
                {(["bull", "base", "bear"] as PathKey[]).map(k => {
                  const shift = drift.probabilityShift![k];
                  return (
                    <div key={k} style={{ color: PATH_COLORS[k] }}>
                      {k.toUpperCase()}: {shift >= 0 ? "+" : ""}{(shift * 100).toFixed(0)}pp
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Calibration footer — every input traceable */}
        <details className="rounded-md border border-border/30 bg-background/40 px-3 py-2 group" data-testid="playbook-calibration">
          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground transition flex items-center gap-1.5 list-none">
            <Info className="h-3 w-3" />
            <span className="font-semibold">Calibration</span>
            <span className="text-[10px]">— {inputs.length} inputs · click to expand</span>
            <span className="ml-auto text-[10px] group-open:hidden">Show</span>
            <span className="ml-auto text-[10px] hidden group-open:inline">Hide</span>
          </summary>
          <div className="mt-2 space-y-1 text-[10px]">
            {inputs.map(inp => (
              <div
                key={inp.key}
                className="flex items-center justify-between gap-2 border-t border-border/20 py-1 first:border-t-0"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-muted-foreground truncate">{inp.label}:</span>
                  <span className="font-mono text-foreground">
                    {typeof inp.value === "number" ? inp.value.toFixed(2) : inp.value}
                  </span>
                  {inp.calibration && (
                    <span className="text-muted-foreground/70 truncate">· {inp.calibration}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span
                    className="px-1.5 py-0.5 rounded font-mono text-[9px]"
                    style={{
                      color:
                        inp.source === "Schwab" ? "#34d399"
                        : inp.source === "Schwab+CBOE" ? "#a3e635"
                        : inp.source === "CBOE delayed" ? "#fbbf24"
                        : inp.source === "Computed" ? "#60a5fa"
                        : "#fb923c",
                      background:
                        inp.source === "Schwab" ? "rgba(16,185,129,0.08)"
                        : inp.source === "Schwab+CBOE" ? "rgba(163,230,53,0.08)"
                        : inp.source === "CBOE delayed" ? "rgba(251,191,36,0.08)"
                        : inp.source === "Computed" ? "rgba(96,165,250,0.08)"
                        : "rgba(251,146,60,0.08)",
                    }}
                  >
                    {inp.source}
                  </span>
                  <span className="text-muted-foreground/60 font-mono">
                    {inp.freshSeconds < 60 ? "live" : `${Math.round(inp.freshSeconds / 60)}m`}
                  </span>
                </div>
              </div>
            ))}
            <div className="pt-2 text-[10px] text-muted-foreground italic border-t border-border/20">
              Method: 1σ daily range from VIX/√252; path probabilities tilt on gamma sign,
              VIX term structure, composite tilt, and spot vs gamma flip.
            </div>
          </div>
        </details>
      </div>
    </ErrorBoundary>
  );
}
