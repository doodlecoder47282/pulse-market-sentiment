// ModelsPanel.tsx — BATCAVE Daily Model
//
// Rebuilt to match the @OptionsDepth / Green Room "SPX DAILY MODEL" layout:
//
//   ┌─────────────────────────────────────────────────────────────────────────────┐
//   │ HEADER STRIP: SPX DAILY MODEL | DATE | TIME ET | SPOT | DFI                 │
//   ├──────────────────────────────────────────────┬──────────────────────────────┤
//   │ AUDIT BOX (top-left)                         │ RIGHT-RAIL LEVEL STACK       │
//   │  • live pivot / gamma-zero / charm-zero       │  • CEILING / ACCEL ZONE      │
//   │  • DFI / Vanna / Gamma / Double-Zero zone    │  • CALL WALL / PUT WALL      │
//   ├──────────────────────────────────────────────┤  • CHARM POCKET / VANNA SQ.  │
//   │ MAIN CHART (path projections)                │  • DOUBLE ZERO ZONE          │
//   │  • BULL / BASE / BEAR lines                  │  • BULL / BASE / BEAR proj.  │
//   │  • Inline callout text on each path          │  • DOWNSIDE TARGET           │
//   │  • Spot + open circles                       │  • BEAR / ZOMMA / FLOOR      │
//   ├──────────────────────────────────────────────┴──────────────────────────────┤
//   │ SCENARIO LEGEND + BOTTOM STATUS STRIP                                        │
//   └─────────────────────────────────────────────────────────────────────────────┘
//
// Data source: GET /api/models?symbol=^GSPC|SPY

import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { RegimeChip } from "@/components/RegimeChip";
import {
  LineChart, Line, ReferenceLine, ReferenceDot, ReferenceArea,
  ResponsiveContainer, XAxis, YAxis, Tooltip, Label, LabelList,
  ComposedChart, Area, Legend,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RefreshCw, AlertTriangle, Activity } from "lucide-react";
import { BatmanLogo } from "./BatmanLogo";
import { apiRequest } from "@/lib/queryClient";
import ErrorBoundary from "@/components/ErrorBoundary";
import ChainAudit from "@/components/ChainAudit";
import { BacktestBadge, BacktestPanel, type BacktestHorizon } from "@/components/BacktestOverlay";
import PivotProjection from "@/components/models/PivotProjection";
import MLAccuracyCard from "@/components/models/MLAccuracyCard";

// ─── Types mirror server/models.ts ──────────────────────────────────────────

type Horizon = "daily" | "weekly" | "monthly" | "quarterly";

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
  vannaM: number;
  gammaZone: "y+" | "y-";
  gammaZoneLabel: string;
  gammaAtSpot: number;
  dfi: number;
  dfiLabel: string;
  dfiFlipped: boolean;
  contractCount: number;
  mainPivot: number | null;
  charmZero: number | null;
  charmZeros?: number[];
  charmTightening?: {
    rate: number;
    label: "DECEL" | "STEADY" | "EXPANDING";
    chopFlag: boolean;
    note: string;
  };
  doubleZeroLow: number | null;
  doubleZeroHigh: number | null;
  scenarioProb: { bull: number; base: number; bear: number };
  closeTargets?: {
    bull: { price: number; prob: number } | null;
    base: { price: number; prob: number } | null;
    bear: { price: number; prob: number } | null;
  };
  lastRecal?: {
    at: number;
    dfi: number;
    dfiDeltaSinceOpen: number | null;
  } | null;
  termStructureDoD?: {
    iv1d: number | null;
    iv1dPrev: number | null;
    iv1dDelta: number | null;
    charmNow: number;
    charmPrev: number | null;
    label: string;
  };
  nearby: { price: number; note: string; dir: "up" | "down" }[];
}

type MMRegime = "LONG_GAMMA" | "NEUTRAL" | "SHORT_GAMMA" | "VANNA_DRIVEN" | "CHARM_DRIVEN";
type MMZone = "ABOVE_CALL" | "CW_TO_0G" | "AT_0G" | "0G_TO_PW" | "BELOW_PW";
type DealerAction = "defend" | "accelerate" | "fade" | "pin" | "capitulate";

interface MMCell {
  regime: MMRegime;
  zone: MMZone;
  pUp: number;
  pDown: number;
  pPin: number;
  magnitude: number;
  action: DealerAction;
  bias: number;
  intensity: number;
}

interface MMMatrix {
  asOf: number;
  currentRegime: MMRegime;
  currentZone: MMZone;
  regimes: MMRegime[];
  zones: MMZone[];
  cells: MMCell[];
  notes: { regime: string; zone: string; summary: string };
}

interface ModelHorizon {
  horizon: Horizon;
  label: string;
  symbol: string;
  displaySymbol: string;
  spot: number;
  spotAnchorDate: string;
  targetDate: string;
  targetDateLong?: string;
  priceRange: [number, number];
  levels: ModelLevel[];
  paths: ModelPath[];
  audit: ModelAudit;
  vol: { vix: number | null; vixChangePct: number | null; termRatio: number | null; termLabel: string };
  vomma: "elevated" | "normal";
  confidence: "HIGH" | "MODERATE" | "LOW";
  mmMatrix?: MMMatrix;
  weeklyTrajectory?: WeeklyTrajectory;
}

// ─── 13-week trajectory (quarterly horizon only) ─────────────────────────────
interface TrajectoryWeek {
  weekIndex: number;
  weekLabel: string;
  weekEndDate: string;
  bull: number;
  base: number;
  bear: number;
  sigmaWeek: number;          // INCREMENTAL one-week σ (event bumps visible here)
  sigmaCum?: number;          // CUMULATIVE σ thru week k — drives the cone
  cumDriftPct?: number;       // cumulative drift % vs spot
  /** @deprecated renamed to cumDriftPct — kept for one release for old payloads */
  driftPct?: number;
  events?: string[];
  vixSegment?: "VIX9D" | "VIX" | "VIX3M" | "BLEND";
}
interface TrajectoryAnchor {
  level: number;
  label: string;
  kind: string;
  strength: "primary" | "secondary";
}
interface WeeklyTrajectory {
  spot: number;
  asOf: number;
  weeks: TrajectoryWeek[];
  endpoint: { bull: number; base: number; bear: number };
  anchors: TrajectoryAnchor[];
  drivers: {
    compositeTilt: number;
    gexTilt: number;
    vixTermTilt: number;
    skewTilt?: number;
    totalDriftPerWeek: number;
    annualizedDrift: number;
    magnetCount: number;
    vrpRatio?: number | null;
    vrpScale?: number;
    eventWeeks?: number;
  };
  inputs: {
    vix: number | null;
    vix9d: number | null;
    vix3m: number | null;
    callWall: number | null;
    putWall: number | null;
    gammaFlip: number | null;
    maxPain: number | null;
    totalGex: number | null;
    composite: number;
    skew?: number | null;
    realizedVol20d?: number | null;
  };
  methodology?: string;
}

interface ModelsResponse {
  asOf: number;
  session: "live" | "last-close";
  horizons: Record<Horizon, ModelHorizon | null>;
  warnings: string[];
  experimental?: boolean;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function fmtNum(n: number, d = 0): string {
  if (!isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtK(n: number): string {
  if (n >= 1000) return Math.round(n).toLocaleString();
  return n.toFixed(2);
}

function fmtPct(n: number | null, d = 2): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
}

function fmtSignedM(n: number): string {
  if (!isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(n / 1e6).toFixed(1)}M`;
}

function fmtSignedB(n: number): string {
  if (!isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}B`;
}

function etTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ─── Color palette ────────────────────────────────────────────────────────────

const COLORS = {
  bull:      "#22c55e",  // green-500
  base:      "#06b6d4",  // cyan-500
  bear:      "#ef4444",  // red-500
  amber:     "#f59e0b",  // amber-500
  callWall:  "#22c55e",
  putWall:   "#ef4444",
  zeroGamma: "#f59e0b",
  charm:     "#c084fc",  // purple-400
  vanna:     "#06b6d4",  // cyan-500
  pivot:     "#94a3b8",  // slate-400
  dz:        "#fde047",  // yellow-300
  negGamma:  "#64748b",  // slate-500
};

function levelColor(kind: string): string {
  switch (kind) {
    case "callWall":      return COLORS.callWall;
    case "putWall":       return COLORS.putWall;
    case "zeroGamma":     return COLORS.zeroGamma;
    case "dominantMag":   return "#14b8a6";
    case "strongMag":     return "#0ea5e9";
    case "extremeVac":    return "#ef4444";
    case "mopexMaxPain":  return "#f59e0b";
    case "upsidePivot":   return "#a855f7";
    case "downsidePivot": return "#a855f7";
    case "t1Up": case "t2Up": return "#065f46";
    case "t1Down": case "t2Down": return "#7f1d1d";
    case "vannaFlip":     return "#06b6d4";
    case "zommaBridge":   return "#fde047";
    case "charmTarget":   return "#c084fc";
    case "negGammaEntry": return "#fb7185";
    case "upperVomma":    return "#84cc16";
    case "lowerVomma":    return "#f97316";
    default: return "#64748b";
  }
}

function levelShortName(kind: string): string {
  switch (kind) {
    case "callWall":      return "CALL WALL";
    case "putWall":       return "PUT WALL";
    case "zeroGamma":     return "0-\u0393 FLIP";
    case "dominantMag":   return "DOM MAG";
    case "strongMag":     return "STRONG MAG";
    case "extremeVac":    return "VAC";
    case "mopexMaxPain":  return "MAX PAIN";
    case "upsidePivot":   return "UP PIVOT";
    case "downsidePivot": return "DN PIVOT";
    case "t1Up":          return "T1 UP";
    case "t2Up":          return "T2 UP";
    case "t1Down":        return "T1 DN";
    case "t2Down":        return "T2 DN";
    case "vannaFlip":     return "VANNA";
    case "zommaBridge":   return "ZOMMA";
    case "charmTarget":   return "CHARM";
    case "negGammaEntry": return "NEG-\u0393";
    case "upperVomma":    return "UP VOMMA";
    case "lowerVomma":    return "DN VOMMA";
    default: return kind.toUpperCase();
  }
}

// ─── Right-rail level row ─────────────────────────────────────────────────────

function RailRow({
  label,
  value,
  sub,
  color,
  highlight = false,
  backtestKind,
  backtestHorizon,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  highlight?: boolean;
  backtestKind?: string;
  backtestHorizon?: BacktestHorizon;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-2 border-b border-border/20 py-0.5 text-[10px] font-mono ${
        highlight ? "bg-yellow-400/10" : ""
      }`}
    >
      <span className="uppercase tracking-wider text-muted-foreground/70">
        {label}
        {backtestKind && backtestHorizon && <BacktestBadge horizon={backtestHorizon} kind={backtestKind} />}
      </span>
      <div className="text-right">
        <span className="font-semibold" style={{ color }}>{value}</span>
        {sub && <span className="ml-1 text-[9px] text-muted-foreground">({sub})</span>}
      </div>
    </div>
  );
}

function RailDivider({ label }: { label?: string }) {
  return (
    <div className="my-0.5 border-t border-border/40 py-0.5 text-[8px] uppercase tracking-widest text-muted-foreground/40">
      {label}
    </div>
  );
}

// ─── Right-rail level stack ───────────────────────────────────────────────────

function RightRail({ horizon }: { horizon: ModelHorizon }) {
  const a = horizon.audit;
  const spot = horizon.spot;
  const byKind = (k: string) => horizon.levels.find((l) => l.kind === k);

  const callWall  = byKind("callWall");
  const putWall   = byKind("putWall");
  const zeroGamma = byKind("zeroGamma");
  const domMag    = byKind("dominantMag");
  const extVac    = byKind("extremeVac");
  const upPivot   = byKind("upsidePivot");
  const dnPivot   = byKind("downsidePivot");
  const charmTgt  = byKind("charmTarget");
  const vannaFlip = byKind("vannaFlip");
  const zomma     = byKind("zommaBridge");
  const negGamma  = byKind("negGammaEntry");
  const upVomma   = byKind("upperVomma");
  const loVomma   = byKind("lowerVomma");

  const pFmt = (p: number | undefined) => p != null ? fmtK(p) : "—";
  const distPct = (p: number | undefined) => {
    if (p == null) return "";
    const d = ((p - spot) / spot * 100);
    return `${d >= 0 ? "+" : ""}${d.toFixed(2)}%`;
  };

  const probs = a.scenarioProb;

  // Double zero zone
  const dzLow  = a.doubleZeroLow;
  const dzHigh = a.doubleZeroHigh;
  const dzStr  = dzLow != null && dzHigh != null
    ? `${fmtK(dzLow)}-${fmtK(dzHigh)}`
    : zeroGamma?.price != null ? fmtK(zeroGamma.price) : "—";

  // Bull / bear scenario close range (±0.5% around bull / bear targets)
  const bullTgt  = horizon.paths.find(p => p.kind === "bull")?.target ?? spot;
  const bearTgt  = horizon.paths.find(p => p.kind === "bear")?.target ?? spot;
  const baseTgt  = horizon.paths.find(p => p.kind === "base")?.target ?? spot;
  const bullRange = `${fmtK(bullTgt * 0.998)}-${fmtK(bullTgt * 1.002)}`;
  const bearRange = `${fmtK(bearTgt * 0.998)}-${fmtK(bearTgt * 1.002)}`;
  const baseRange = `${fmtK(baseTgt * 0.998)}-${fmtK(baseTgt * 1.002)}`;

  // Charm pocket (between zero-charm and charm target)
  const charmPocketLow  = a.charmZero != null ? Math.min(a.charmZero, charmTgt?.price ?? a.charmZero) : null;
  const charmPocketHigh = a.charmZero != null ? Math.max(a.charmZero, charmTgt?.price ?? a.charmZero) : null;
  const charmPocketStr  = charmPocketLow != null && charmPocketHigh != null
    ? `${fmtK(charmPocketLow)}-${fmtK(charmPocketHigh)}`
    : a.charmZero != null ? fmtK(a.charmZero) : "—";

  return (
    <div className="w-52 flex-shrink-0 overflow-y-auto border-l border-border/40 bg-black/30 px-2.5 py-2 font-mono text-[10px]">
      <div className="mb-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">Levels</div>

      {/* Upside */}
      <RailDivider label="resistance" />
      <RailRow label="CEILING" value={pFmt(callWall?.price)} sub={distPct(callWall?.price)} color={COLORS.bear} backtestKind="callWall" backtestHorizon={horizon.horizon as BacktestHorizon} />
      {upVomma && <RailRow label="ACCEL ZONE" value={pFmt(upVomma?.price)} sub={distPct(upVomma?.price)} color={COLORS.bear} />}
      {callWall && <RailRow label="CALL WALL" value={pFmt(callWall.price)} sub={callWall.gex != null ? `${(callWall.gex/1e6).toFixed(1)}M GEX` : undefined} color={COLORS.callWall} backtestKind="callWall" backtestHorizon={horizon.horizon as BacktestHorizon} />}
      {upPivot  && <RailRow label="UPSIDE TARGET" value={pFmt(upPivot.price)} sub={distPct(upPivot.price)} color={COLORS.bull} backtestKind="upsidePivot" backtestHorizon={horizon.horizon as BacktestHorizon} />}
      {vannaFlip && <RailRow label="VANNA FLIP" value={pFmt(vannaFlip.price)} sub={distPct(vannaFlip.price)} color={COLORS.vanna} />}

      {/* Double Zero Zone */}
      <RailDivider label="pivot zone" />
      {a.charmZero && <RailRow label="CHARM ZERO" value={fmtK(a.charmZero)} sub={distPct(a.charmZero)} color={COLORS.charm} />}
      <RailRow label="DOUBLE ZERO" value={dzStr} color={COLORS.dz} highlight />
      {zeroGamma && <RailRow label="GAMMA ZERO" value={pFmt(zeroGamma.price)} sub={distPct(zeroGamma.price)} color={COLORS.zeroGamma} backtestKind="zeroGamma" backtestHorizon={horizon.horizon as BacktestHorizon} />}
      {charmPocketLow && <RailRow label="CHARM POCKET" value={charmPocketStr} color={COLORS.charm} />}
      {domMag && <RailRow label="DOM MAGNET" value={pFmt(domMag.price)} sub={domMag.gex != null ? `${(domMag.gex/1e6).toFixed(1)}M` : undefined} color={COLORS.base} backtestKind="dominantMag" backtestHorizon={horizon.horizon as BacktestHorizon} />}
      {a.mainPivot && <RailRow label="MAIN PIVOT" value={fmtK(a.mainPivot)} sub={distPct(a.mainPivot)} color={COLORS.amber} />}

      {/* Scenario projections */}
      <RailDivider label="scenarios" />
      <RailRow label={`BULL ${probs.bull}%`} value={bullRange} color={COLORS.bull} />
      <RailRow label={`BASE ${probs.base}%`} value={baseRange} color={COLORS.base} />
      <RailRow label={`BEAR ${probs.bear}%`} value={bearRange} color={COLORS.bear} />

      {/* Downside */}
      <RailDivider label="support" />
      {dnPivot  && <RailRow label="DOWNSIDE PIVOT" value={pFmt(dnPivot.price)} sub={distPct(dnPivot.price)} color={COLORS.pivot} backtestKind="downsidePivot" backtestHorizon={horizon.horizon as BacktestHorizon} />}
      {putWall  && <RailRow label="PUT WALL" value={pFmt(putWall.price)} sub={putWall.gex != null ? `${(Math.abs(putWall.gex)/1e6).toFixed(1)}M GEX` : undefined} color={COLORS.callWall} backtestKind="putWall" backtestHorizon={horizon.horizon as BacktestHorizon} />}
      {loVomma  && <RailRow label="LOWER VOMMA" value={pFmt(loVomma.price)} sub={distPct(loVomma.price)} color={COLORS.negGamma} />}
      {negGamma && <RailRow label="NEG-Γ ENTRY" value={pFmt(negGamma.price)} sub={distPct(negGamma.price)} color={COLORS.bear} />}
      {extVac   && <RailRow label="EXT VACUUM" value={pFmt(extVac.price)} sub={distPct(extVac.price)} color={COLORS.bear} backtestKind="extremeVac" backtestHorizon={horizon.horizon as BacktestHorizon} />}
      {zomma    && <RailRow label="ZOMMA BRIDGE" value={pFmt(zomma.price)} sub={distPct(zomma.price)} color={COLORS.dz} />}
      {byKind("mopexMaxPain") && <RailRow label="MAX PAIN" value={pFmt(byKind("mopexMaxPain")?.price)} color={COLORS.amber} backtestKind="mopexMaxPain" backtestHorizon={horizon.horizon as BacktestHorizon} />}

      <div className="mt-2 text-[8px] text-muted-foreground/40 leading-tight">
        Red = resistance · Green = support<br />
        Cyan = pivot/data · Yellow = flip zone<br />
        <span className="text-emerald-400/70">POS Γ</span> = fade moves · <span className="text-rose-400/70">NEG Γ</span> = follow moves
      </div>
    </div>
  );
}

// ─── Audit box ────────────────────────────────────────────────────────────────

function AuditBox({ horizon }: { horizon: ModelHorizon }) {
  const a = horizon.audit;
  const spot = horizon.spot;
  const probs = a.scenarioProb;

  const timeStr = etTime(a.asOf);
  const spotStr = fmtK(spot);

  // Distance to gamma zero in points
  const zg = horizon.levels.find(l => l.kind === "zeroGamma")?.price;
  const zgDist = zg != null ? (zg - spot).toFixed(1) : null;
  const zgDistStr = zgDist != null
    ? `${Math.abs(parseFloat(zgDist))} pt ${parseFloat(zgDist) >= 0 ? "above" : "below"} spot`
    : null;

  // Double zero zone text
  const dzLow  = a.doubleZeroLow;
  const dzHigh = a.doubleZeroHigh;
  const dzStr  = dzLow != null && dzHigh != null
    ? `${fmtK(dzLow)}-${fmtK(dzHigh)}`
    : (zg != null ? `${fmtK(zg)}` : "—");
  const aboveDz = spot > (dzHigh ?? spot) ? "ABOVE = POSITIVE GAMMA" : (spot < (dzLow ?? spot) ? "BELOW = NEGATIVE GAMMA" : "KNIFE EDGE — WATCH");

  return (
    <div
      className="rounded border border-border/60 bg-black/60 p-2.5 font-mono text-[10px] leading-[1.55] text-muted-foreground"
      data-testid="batcave-audit-box"
    >
      {/* Line 1: live stats */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-bold text-foreground">LIVE {spotStr}</span>
        <span>|</span>
        <span>{horizon.spotAnchorDate}</span>
        <span>|</span>
        <span>{timeStr} ET</span>
      </div>

      {/* Line 2: pivot levels */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {a.mainPivot && (
          <>
            <span>MAIN PIVOT: <span className="text-amber-400">{fmtK(a.mainPivot)}</span></span>
            <span>|</span>
          </>
        )}
        {horizon.levels.find(l => l.kind === "upsidePivot") && (
          <>
            <span>UPSIDE PIVOT: <span className="text-green-400">{fmtK(horizon.levels.find(l => l.kind === "upsidePivot")!.price)}</span></span>
            <span>|</span>
          </>
        )}
        {horizon.levels.find(l => l.kind === "downsidePivot") && (
          <span>DOWNSIDE PIVOT: <span className="text-red-400">{fmtK(horizon.levels.find(l => l.kind === "downsidePivot")!.price)}</span></span>
        )}
      </div>

      {/* Line 3: gamma zero + charm zero */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {zg && (
          <>
            <span>
              GAMMA ZERO: <span className="text-amber-400">{fmtK(zg)}</span>
              {zgDistStr && <span className="text-muted-foreground/60"> ({zgDistStr})</span>}
            </span>
            <span>|</span>
          </>
        )}
        {a.charmZero && (
          <span>
            CHARM ZERO: <span className="text-purple-400">{fmtK(a.charmZero)}</span>
          </span>
        )}
      </div>

      {/* Line 4: DFI + Vanna */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span>
          DFI:{" "}
          <span className={a.dfi >= 0 ? "text-green-400" : "text-red-400"}>
            {a.dfi >= 0 ? "+" : ""}{a.dfi.toFixed(2)} {a.dfiLabel}
          </span>
          {a.dfiFlipped && <span className="ml-1 text-yellow-400">(FIRST FLIP)</span>}
        </span>
        <span>|</span>
        <span>
          VANNA:{" "}
          <span className={a.vannaM >= 0 ? "text-cyan-400" : "text-red-400"}>
            {a.vannaM >= 0 ? "+" : ""}{a.vannaM.toFixed(1)}M
          </span>
        </span>
      </div>

      {/* Line 5: Gamma at spot */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span>
          GAMMA zSpot:{" "}
          <span className={a.gammaAtSpot >= 0 ? "text-green-400" : "text-red-400"}>
            {a.gammaAtSpot >= 0 ? "+" : ""}{a.gammaAtSpot.toLocaleString()}
          </span>
        </span>
        <span>|</span>
        <span>
          GEX: <span className={a.gexTotal >= 0 ? "text-green-400" : "text-red-400"}>
            {fmtSignedM(a.gexTotal)}/1%
          </span>
        </span>
        <span>|</span>
        <span>
          DEX: <span className="text-cyan-400">{fmtSignedB(a.dex)}</span>
        </span>
        <span>|</span>
        <span>
          CHARM: <span className={a.charmPerDay >= 0 ? "text-green-400" : "text-red-400"}>
            {fmtSignedB(a.charmPerDay)}/d
          </span>
        </span>
      </div>

      {/* Line 6: Double zero zone */}
      {(dzLow != null || zg != null) && (
        <div className="mt-0.5">
          <span className="text-yellow-400 font-semibold">DOUBLE ZERO ZONE {dzStr}</span>
          <span className="ml-2 text-muted-foreground/70">| {aboveDz}</span>
        </div>
      )}

      {/* Charm-zero CLUSTER (Batcave #1) + tightening (Batcave #2) */}
      {((a.charmZeros && a.charmZeros.length > 1) || a.charmTightening) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border/20 pt-0.5">
          {a.charmZeros && a.charmZeros.length > 0 && (
            <span>
              CHARM-ZERO CLUSTER:{" "}
              <span className="text-purple-400">
                {a.charmZeros.map((x) => fmtK(x)).join(" / ")}
              </span>
            </span>
          )}
          {a.charmZeros && a.charmZeros.length > 0 && a.charmTightening && <span>|</span>}
          {a.charmTightening && (
            <span>
              SLOPE:{" "}
              <span className={
                a.charmTightening.label === "DECEL" ? "text-amber-400 font-semibold" :
                a.charmTightening.label === "EXPANDING" ? "text-cyan-400" :
                "text-muted-foreground"
              }>
                {a.charmTightening.label} {a.charmTightening.rate.toFixed(2)}
              </span>
              {a.charmTightening.chopFlag && (
                <span className="ml-1 text-amber-400 font-semibold">• CHOP RISK</span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Line 7: Scenario probabilities */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border/30 pt-0.5">
        <span className="text-green-400">BULL {probs.bull}%</span>
        <span>·</span>
        <span className="text-cyan-400">BASE {probs.base}%</span>
        <span>·</span>
        <span className="text-red-400">BEAR {probs.bear}%</span>
        <span>|</span>
        <span>PATH: <span className="text-foreground">{a.path}</span></span>
        <span>|</span>
        <span>γ {a.gammaZone} {a.gammaZoneLabel}</span>
      </div>
    </div>
  );
}

// ─── Scenario legend bottom strip ─────────────────────────────────────────────

function ScenarioLegend({ horizon }: { horizon: ModelHorizon }) {
  const a = horizon.audit;
  const probs = a.scenarioProb;
  const spot = horizon.spot;

  const bullPath = horizon.paths.find(p => p.kind === "bull");
  const basePath = horizon.paths.find(p => p.kind === "base");
  const bearPath = horizon.paths.find(p => p.kind === "bear");

  const zg = horizon.levels.find(l => l.kind === "zeroGamma")?.price;
  const cw = horizon.levels.find(l => l.kind === "callWall")?.price;
  const pw = horizon.levels.find(l => l.kind === "putWall")?.price;
  const charmZ = a.charmZero;

  return (
    <div className="space-y-0.5 border-t border-border/40 pt-2 font-mono text-[10px]">
      <div className="text-[9px] uppercase tracking-widest text-muted-foreground/50">Scenario projections</div>
      {bullPath && (
        <div className="text-green-400">
          BULL {probs.bull}% → Clear {zg ? `${fmtK(zg)} Gamma Zero` : "resistance"}
          {charmZ ? ` + ${fmtK(charmZ)} Charm Zero` : ""}
          {cw ? ` → ${fmtK(cw)} Call Wall` : ""}
          {" → CLOSE "}
          <span className="text-green-300">{fmtK(bullPath.target * 0.999)}-{fmtK(bullPath.target * 1.001)}</span>
        </div>
      )}
      {basePath && (
        <div className="text-cyan-400">
          BASE {probs.base}% → Chop {fmtK(spot * 0.997)}-{fmtK(spot * 1.003)} → Gamma Zero Ceiling
          {" → CLOSE "}
          <span className="text-cyan-300">{fmtK(basePath.target * 0.999)}-{fmtK(basePath.target * 1.001)}</span>
        </div>
      )}
      {bearPath && (
        <div className="text-red-400">
          BEAR {probs.bear}% → Break {pw ? `${fmtK(pw)} Put Wall` : "support"} → Vol expansion
          {" → CLOSE "}
          <span className="text-red-300">{fmtK(bearPath.target * 0.999)}-{fmtK(bearPath.target * 1.001)}</span>
        </div>
      )}
    </div>
  );
}

// ─── MM Probability Matrix — 5×5 regime × zone heatmap ─────────────────────

const REGIME_LABEL: Record<MMRegime, string> = {
  LONG_GAMMA:   "LONG Γ",
  NEUTRAL:      "NEUTRAL",
  SHORT_GAMMA:  "SHORT Γ",
  VANNA_DRIVEN: "VANNA",
  CHARM_DRIVEN: "CHARM",
};
const ZONE_LABEL: Record<MMZone, string> = {
  ABOVE_CALL: "> CW",
  CW_TO_0G:   "CW→0Γ",
  AT_0G:      "AT 0Γ",
  "0G_TO_PW": "0Γ→PW",
  BELOW_PW:   "< PW",
};
const ACTION_COLOR: Record<DealerAction, string> = {
  defend:     "#22c55e",
  accelerate: "#f59e0b",
  fade:       "#ef4444",
  pin:        "#06b6d4",
  capitulate: "#7f1d1d",
};
const ACTION_LABEL: Record<DealerAction, string> = {
  defend:     "DEFEND",
  accelerate: "CHASE",
  fade:       "FADE",
  pin:        "PIN",
  capitulate: "STEP OUT",
};

function cellBg(c: MMCell): string {
  // Color by bias direction + intensity. Green/red for directional, cyan for pin-heavy.
  const pinDominant = c.pPin >= Math.max(c.pUp, c.pDown);
  const alpha = Math.round(c.intensity * 70) + 10; // 10..80
  const a = (alpha / 255).toFixed(2);
  if (pinDominant) return `rgba(6,182,212,${a})`;       // cyan
  if (c.bias > 0.05) return `rgba(34,197,94,${a})`;      // green
  if (c.bias < -0.05) return `rgba(239,68,68,${a})`;     // red
  return `rgba(148,163,184,${a})`;                        // slate
}

function MMMatrixHeatmap({ horizon }: { horizon: ModelHorizon }) {
  const mm = horizon.mmMatrix;
  if (!mm) return null;

  const byKey = new Map<string, MMCell>();
  for (const c of mm.cells) byKey.set(`${c.regime}:${c.zone}`, c);

  return (
    <div className="mt-3 border-t border-border/40 pt-2">
      <div className="flex items-baseline justify-between mb-1.5">
        <div className="text-[9px] uppercase tracking-widest text-muted-foreground/50 font-mono">
          Market-maker probability matrix
        </div>
        <div className="font-mono text-[9px] text-muted-foreground/70">
          <span className="text-amber-400">YOU ARE HERE:</span> {REGIME_LABEL[mm.currentRegime]} · {ZONE_LABEL[mm.currentZone]}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="font-mono text-[9px] border-separate" style={{ borderSpacing: 2 }} data-testid="mm-matrix">
          <thead>
            <tr>
              <th className="p-1 text-left text-muted-foreground/60 font-normal w-20"></th>
              {mm.zones.map((z) => (
                <th key={z} className="p-1 text-center text-muted-foreground/70 font-semibold uppercase tracking-wider">
                  {ZONE_LABEL[z]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mm.regimes.map((r) => (
              <tr key={r}>
                <td className="p-1 text-right text-muted-foreground/80 font-semibold uppercase tracking-wider">
                  {REGIME_LABEL[r]}
                </td>
                {mm.zones.map((z) => {
                  const c = byKey.get(`${r}:${z}`);
                  if (!c) return <td key={z} />;
                  const isCurrent = r === mm.currentRegime && z === mm.currentZone;
                  return (
                    <td key={z} className="p-0" style={{ width: 80 }}>
                      <UITooltip>
                        <TooltipTrigger asChild>
                          <div
                            className={`relative rounded px-1.5 py-1 cursor-help border ${isCurrent ? "ring-2 ring-amber-400 border-amber-400/80" : "border-border/30"}`}
                            style={{ background: cellBg(c) }}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold" style={{ color: ACTION_COLOR[c.action] }}>
                                {ACTION_LABEL[c.action]}
                              </span>
                              <span className="text-foreground/80 text-[8px]">±{c.magnitude}</span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-1 text-[8px]">
                              <span className="text-green-300">↑{c.pUp}</span>
                              <span className="text-cyan-300">·{c.pPin}</span>
                              <span className="text-red-300">↓{c.pDown}</span>
                            </div>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="font-mono text-[10px] max-w-xs">
                          <div className="font-semibold mb-1">{REGIME_LABEL[r]} · {ZONE_LABEL[z]}</div>
                          <div>Action: <span style={{ color: ACTION_COLOR[c.action] }}>{ACTION_LABEL[c.action]}</span></div>
                          <div>P(up): {c.pUp}% · P(pin): {c.pPin}% · P(down): {c.pDown}%</div>
                          <div>Expected move: ±{c.magnitude}pt</div>
                        </TooltipContent>
                      </UITooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-1.5 space-y-0.5 font-mono text-[9px] leading-tight">
        <div className="text-muted-foreground/70"><span className="text-amber-400">Regime:</span> {mm.notes.regime}</div>
        <div className="text-muted-foreground/70"><span className="text-amber-400">Zone:</span> {mm.notes.zone}</div>
        <div className="text-foreground/90 font-semibold">→ {mm.notes.summary}</div>
      </div>
    </div>
  );
}

// ─── Bottom status strip ──────────────────────────────────────────────────────

function StatusStrip({ horizon }: { horizon: ModelHorizon }) {
  const a = horizon.audit;
  const spot = horizon.spot;
  const probs = a.scenarioProb;
  const zg = horizon.levels.find(l => l.kind === "zeroGamma")?.price;
  const timeStr = etTime(a.asOf);
  const dateStr = horizon.targetDateLong ?? horizon.spotAnchorDate;

  const dzStr = a.doubleZeroLow != null && a.doubleZeroHigh != null
    ? `${fmtK(a.doubleZeroLow)}/${fmtK(a.doubleZeroHigh)}`
    : zg != null ? fmtK(zg) : "—";

  const zgDist = zg != null ? (zg - spot) : null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border/40 bg-black/40 px-3 py-1.5 font-mono text-[9px] text-muted-foreground/70"
      data-testid="batcave-status-strip"
    >
      <span className="text-foreground font-semibold">LIVE {fmtK(spot)}</span>
      <span>|</span>
      <span>{timeStr} ET</span>
      <span>|</span>
      <span className={a.dfi >= 0 ? "text-green-400" : "text-red-400"}>
        DFI {a.dfi >= 0 ? "+" : ""}{a.dfi.toFixed(2)} {a.dfiLabel}
        {a.dfiFlipped ? " FLIP" : ""}
      </span>
      <span>|</span>
      <span>
        GAMMA {a.gammaAtSpot >= 0 ? "+" : ""}{a.gammaAtSpot.toLocaleString()}
      </span>
      <span>|</span>
      {zg && (
        <>
          <span>GZ {fmtK(zg)}{zgDist != null ? ` (${Math.abs(zgDist).toFixed(0)}pt)` : ""}</span>
          <span>|</span>
        </>
      )}
      <span>DOUBLE ZERO {dzStr}</span>
      <span>|</span>
      <span className="text-red-400">BEAR {probs.bear}%</span>
      <span>/</span>
      <span className="text-cyan-400">BASE {probs.base}%</span>
      <span>/</span>
      <span className="text-green-400">BULL {probs.bull}%</span>
      <span>|</span>
      <span>{dateStr}</span>
    </div>
  );
}

// ─── Main chart with projection paths ────────────────────────────────────────

function ModelChart({ horizon }: { horizon: ModelHorizon }) {
  const a = horizon.audit;

  const chartData = useMemo(() => {
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
  const yPad = (yMax - yMin) * 0.06;

  // Build a filtered + deduplicated level set for the chart
  const displayLevels = useMemo(() => {
    // Increased from 0.018 → 0.030 so left-edge level labels (PUT WALL / DN VOMMA / 0Γ
    // / ZOMMA) stop colliding when the price band is dense.
    const gap = (yMax - yMin) * 0.030;
    const priority = (k: string) =>
      ["callWall", "putWall", "zeroGamma", "dominantMag", "mopexMaxPain"].includes(k) ? 3
      : ["vannaFlip", "charmTarget", "zommaBridge", "negGammaEntry", "upperVomma", "lowerVomma"].includes(k) ? 2
      : ["strongMag", "upsidePivot", "downsidePivot"].includes(k) ? 1
      : 0;
    const sorted = [...horizon.levels].sort((a, b) => {
      const pd = priority(b.kind) - priority(a.kind);
      return pd !== 0 ? pd : b.price - a.price;
    });
    const shown: { kind: string; price: number; showLabel: boolean; origIdx: number }[] = [];
    for (const lv of sorted) {
      const clash = shown.some(s => s.showLabel && Math.abs(s.price - lv.price) < gap);
      shown.push({ kind: lv.kind, price: lv.price, showLabel: !clash, origIdx: horizon.levels.indexOf(lv) });
    }
    return horizon.levels.map((lv, i) => {
      const s = shown.find(x => x.origIdx === i);
      return { ...lv, showLabel: s?.showLabel ?? true };
    });
  }, [horizon, yMin, yMax]);

  const probs = a.scenarioProb;

  return (
    <div className="flex-1 min-w-0">
      <div className="h-[620px] xl:h-[700px] w-full" data-testid="batcave-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 28, right: 24, left: 4, bottom: 20 }}>
            <XAxis
              dataKey="label"
              stroke="#64748b"
              tick={{ fontSize: 12, fill: "#94a3b8", fontWeight: 500 }}
              tickLine={false}
              axisLine={{ stroke: "#334155" }}
            />
            <YAxis
              domain={[yMin - yPad, yMax + yPad]}
              stroke="#64748b"
              tick={{ fontSize: 12, fill: "#94a3b8", fontWeight: 500 }}
              tickFormatter={(v) => fmtK(v)}
              width={64}
              tickLine={false}
              axisLine={{ stroke: "#334155" }}
            />
            <Tooltip
              contentStyle={{
                background: "rgba(2,6,23,0.97)",
                border: "1px solid #334155",
                borderRadius: 4,
                fontSize: 12,
                color: "#f1f5f9",
                fontFamily: "var(--font-mono)",
              }}
              formatter={(value: number, name: string) => [fmtK(value), name.toUpperCase()]}
              labelStyle={{ color: "#94a3b8", fontWeight: 600 }}
            />

            {/* Gamma regime background */}
            {a.gammaZone === "y-" && (
              <ReferenceArea
                y1={yMin - yPad}
                y2={horizon.levels.find(l => l.kind === "zeroGamma")?.price ?? horizon.spot}
                fill="#ef4444"
                fillOpacity={0.04}
                strokeOpacity={0}
              />
            )}
            {a.gammaZone === "y+" && (
              <ReferenceArea
                y1={horizon.levels.find(l => l.kind === "zeroGamma")?.price ?? horizon.spot}
                y2={yMax + yPad}
                fill="#22c55e"
                fillOpacity={0.03}
                strokeOpacity={0}
              />
            )}

            {/* Double zero zone band */}
            {a.doubleZeroLow != null && a.doubleZeroHigh != null && (
              <ReferenceArea
                y1={a.doubleZeroLow}
                y2={a.doubleZeroHigh}
                fill="#fde047"
                fillOpacity={0.08}
                stroke="#fde047"
                strokeOpacity={0.3}
                strokeDasharray="3 3"
              />
            )}

            {/* Batcave #1 — charm-zero CLUSTER band (min→max of all flips) */}
            {a.charmZeros && a.charmZeros.length >= 2 && (
              <ReferenceArea
                y1={Math.min(...a.charmZeros)}
                y2={Math.max(...a.charmZeros)}
                fill="#c084fc"
                fillOpacity={0.06}
                stroke="#c084fc"
                strokeOpacity={0.35}
                strokeDasharray="4 4"
              />
            )}
            {a.charmZeros && a.charmZeros.length > 0 && a.charmZeros.map((cz, i) => (
              <ReferenceLine
                key={`czc-${i}-${cz}`}
                y={cz}
                stroke="#c084fc"
                strokeDasharray="2 4"
                strokeOpacity={0.6}
                strokeWidth={1}
                ifOverflow="extendDomain"
              />
            ))}

            {/* Primary pivots — thicker line + inline LEFT-edge label with price.
                Labels are deduplicated (collision-aware via displayLevels.showLabel). */}
            {displayLevels.map((lv) => {
              if (["t1Up","t2Up","t1Down","t2Down"].includes(lv.kind)) return null;
              const color = levelColor(lv.kind);
              const primary = [
                "callWall","putWall","zeroGamma","dominantMag","mopexMaxPain",
                "vannaFlip","charmTarget","zommaBridge","upperVomma","lowerVomma","negGammaEntry",
              ].includes(lv.kind);
              const showLabel = primary && (lv as any).showLabel !== false;
              const shortName = levelShortName(lv.kind);
              return (
                <ReferenceLine
                  key={`${lv.kind}-${lv.price}`}
                  y={lv.price}
                  stroke={color}
                  strokeDasharray={primary ? "5 3" : "2 4"}
                  strokeOpacity={primary ? 0.8 : 0.4}
                  strokeWidth={primary ? 1.4 : 1}
                  ifOverflow="extendDomain"
                  label={showLabel ? {
                    value: `${shortName} ${fmtK(lv.price)}`,
                    position: "insideTopLeft",
                    fill: color,
                    fontSize: 10,
                    fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                    offset: 4,
                  } : undefined}
                />
              );
            })}

            {/* Path lines — thicker + bigger dots for readability.
                Weekly view: per-day price prints at each waypoint via <LabelList>.
                Bull labels go above the line, bear below, base above-but-offset so they
                don't collide. The last point is skipped because the right-edge close-target
                dots already render the final price. */}
            {horizon.paths.map(p => {
              const stroke = p.kind === "bull" ? COLORS.bull : p.kind === "base" ? COLORS.base : COLORS.bear;
              const prob = p.kind === "bull" ? probs.bull : p.kind === "base" ? probs.base : probs.bear;
              const showPrints = horizon.horizon === "weekly";
              const labelPos: "top" | "bottom" = p.kind === "bear" ? "bottom" : "top";
              const labelDy = p.kind === "base" ? -14 : (p.kind === "bull" ? -4 : 4);
              return (
                <Line
                  key={p.kind}
                  type="monotone"
                  dataKey={p.kind}
                  stroke={stroke}
                  strokeWidth={p.kind === "base" ? 3 : 2.6}
                  strokeDasharray={p.kind === "bear" ? "6 3" : p.kind === "bull" ? undefined : "8 3"}
                  dot={{ r: 4, fill: stroke, strokeWidth: 0 }}
                  activeDot={{ r: 6, fill: stroke, strokeWidth: 2, stroke: "#fff" }}
                  isAnimationActive={false}
                  name={`${p.name} ${prob}%`}
                >
                  {showPrints && (
                    <LabelList
                      dataKey={p.kind}
                      position={labelPos}
                      offset={8}
                      content={(props: any) => {
                        const { x, y, value, index } = props;
                        if (value == null || x == null || y == null) return null;
                        // Skip the last waypoint — the close-target dot covers it.
                        if (index === chartData.length - 1) return null;
                        return (
                          <text
                            x={x}
                            y={y + labelDy}
                            fill={stroke}
                            fontSize={10}
                            fontWeight={600}
                            fontFamily="var(--font-mono)"
                            textAnchor="middle"
                            opacity={0.95}
                          >
                            {fmtK(value)}
                          </text>
                        );
                      }}
                    />
                  )}
                </Line>
              );
            })}

            {/* Spot marker — bigger, glowing */}
            <ReferenceDot
              x={chartData[0]?.label}
              y={horizon.spot}
              r={7}
              fill={COLORS.amber}
              stroke="#000"
              strokeWidth={2}
            />

            {/* Batcave #5 — close targets render as colored marker dots at right edge only.
                Full text moved to the ScenarioLegend strip below to prevent overlap. */}
            {a.closeTargets?.bull && (
              <ReferenceDot x={chartData[chartData.length - 1]?.label} y={a.closeTargets.bull.price}
                r={5} fill={COLORS.bull} stroke="#000" strokeWidth={1.5} ifOverflow="extendDomain" />
            )}
            {a.closeTargets?.base && (
              <ReferenceDot x={chartData[chartData.length - 1]?.label} y={a.closeTargets.base.price}
                r={5} fill={COLORS.base} stroke="#000" strokeWidth={1.5} ifOverflow="extendDomain" />
            )}
            {a.closeTargets?.bear && (
              <ReferenceDot x={chartData[chartData.length - 1]?.label} y={a.closeTargets.bear.price}
                r={5} fill={COLORS.bear} stroke="#000" strokeWidth={1.5} ifOverflow="extendDomain" />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Event Band — top strip showing FOMC / econ / earnings per weekday ─────────
//
// Renders a 5-column grid (MON–FRI) above the weekly chart. Each column lists
// the day's events as small colored chips, color-coded by importance:
//   HIGH = amber  (FOMC, NFP, CPI, PCE, GDP)
//   MED  = cyan   (jobless, ISM, retail sales, FOMC day-1, MAG7 earnings)
//   LOW  = muted  (lower-tier prints)
//
// Pulls from /api/econ-week which fans out across Nasdaq + synthetic macro +
// FOMC schedule + earnings — so the band stays populated even when one
// upstream source rate-limits.

interface EconChip {
  id: string;
  kind: string;
  title: string;
  longTitle?: string;
  importance: "HIGH" | "MED" | "LOW";
  when: number;
  timeLabel: string;
  ticker?: string;
  note?: string;
}
interface EconDay { label: string; iso: string; events: EconChip[]; }
interface EconWeek {
  weekOfMon: string;
  weekLabel: string;
  asOf: number;
  days: EconDay[];
  source: string;
}

function chipTone(imp: "HIGH" | "MED" | "LOW"): { fg: string; bg: string; border: string } {
  switch (imp) {
    case "HIGH": return { fg: "text-amber-300",        bg: "bg-amber-500/10",  border: "border-amber-500/50" };
    case "MED":  return { fg: "text-cyan-300",         bg: "bg-cyan-500/10",   border: "border-cyan-500/40" };
    default:     return { fg: "text-muted-foreground", bg: "bg-muted/20",      border: "border-border/40" };
  }
}

function EventBand({ horizon }: { horizon: ModelHorizon }) {
  // Match each waypoint label ("MON 4/27") to a day in /api/econ-week. We use
  // the chart's own labels as the source of truth for which 5 columns to render —
  // that way the band never drifts out of sync with the path lines below.
  // The chart's last weekly waypoint label has the target price baked in
  // (e.g. "FRI 5/1 7,176"). Strip everything after the date so it matches
  // the day labels returned by /api/econ-week ("FRI 5/1").
  const dayLabels = useMemo(() => {
    const longest = horizon.paths.reduce((a, b) => a.waypoints.length >= b.waypoints.length ? a : b);
    return longest.waypoints.map(w => {
      const m = w.label.match(/^([A-Z]{3}\s+\d{1,2}\/\d{1,2})/);
      return m ? m[1] : w.label;
    });
  }, [horizon]);

  const { data, isLoading, isError } = useQuery<EconWeek>({
    queryKey: ["/api/econ-week", dayLabels[0]],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/econ-week");
      return r.json();
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const dayMap = useMemo(() => {
    const m = new Map<string, EconChip[]>();
    if (!data) return m;
    for (const d of data.days) m.set(d.label, d.events);
    return m;
  }, [data]);

  return (
    <div className="mb-2 rounded border border-border/40 bg-black/30">
      <div className="flex items-center justify-between border-b border-border/30 px-2 py-1">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
          <span className="inline-block h-1 w-1 rounded-full bg-amber-400" />
          <span>Catalysts · Week</span>
          {data && <span className="text-muted-foreground/50">{data.weekLabel}</span>}
        </div>
        <div className="font-mono text-[9px] text-muted-foreground/40">
          {isLoading ? "loading…" : isError ? "feed error" : data ? data.source : ""}
        </div>
      </div>
      <div className="grid grid-cols-5 divide-x divide-border/30">
        {dayLabels.map((label) => {
          const events = dayMap.get(label) ?? [];
          return (
            <div key={label} className="flex flex-col gap-1 p-2 min-h-[64px]">
              <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
                {label}
              </div>
              <div className="flex flex-col gap-1">
                {events.length === 0 && (
                  <span className="font-mono text-[9px] text-muted-foreground/30">—</span>
                )}
                {events.slice(0, 4).map((e) => {
                  const tone = chipTone(e.importance);
                  return (
                    <div
                      key={e.id}
                      title={e.longTitle ?? e.title}
                      className={`inline-flex items-center gap-1 rounded border ${tone.border} ${tone.bg} px-1.5 py-0.5 font-mono text-[9px] leading-tight ${tone.fg}`}
                    >
                      <span className="truncate">{e.title}</span>
                    </div>
                  );
                })}
                {events.length > 4 && (
                  <span className="font-mono text-[9px] text-muted-foreground/40">+{events.length - 4} more</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Levels in play — inline grouped strip (replaces right-edge chart labels) ───

function LevelsStrip({ horizon }: { horizon: ModelHorizon }) {
  const spot = horizon.spot;
  const a = horizon.audit;
  const levels = horizon.levels;

  const distPct = (p: number) => {
    const d = ((p - spot) / spot) * 100;
    const sign = d >= 0 ? "+" : "";
    return `${sign}${d.toFixed(2)}%`;
  };

  type Row = { name: string; price: number; color: string; sub?: string };

  const byKind = (k: string) => levels.find(l => l.kind === k);

  const rows: Row[] = [];
  const push = (kind: string, name: string, color: string, subKey?: "gex") => {
    const lv = byKind(kind);
    if (!lv) return;
    const sub = subKey === "gex" && lv.gex != null ? `${(Math.abs(lv.gex)/1e6).toFixed(1)}M GEX` : undefined;
    rows.push({ name, price: lv.price, color, sub });
  };

  // Include all key reference levels — directional pivots, walls, vol-structure anchors.
  // Zero gamma & call/put walls are added so traders see the full picture without
  // having to cross-reference the chart.
  push("t2Up",          "T2 UP",           "#ef4444");
  push("t1Up",          "T1 UP",           "#f87171");
  push("callWall",      "CALL WALL",       "#dc2626", "gex");
  push("upsidePivot",   "UP PIVOT",        "#a855f7");
  push("strongMag",     "STRONG MAG",      "#0ea5e9");
  push("vannaFlip",     "VANNA",           "#06b6d4");
  push("charmTarget",   "CHARM",           "#c084fc");
  push("zommaBridge",   "ZOMMA",           "#fde047");
  push("upperVomma",    "UP VOMMA",        "#84cc16");
  push("zeroGamma",     "0\u0393 GAMMA",   "#fbbf24");
  push("dominantMag",   "DOM MAG",         "#eab308");
  push("lowerVomma",    "DN VOMMA",        "#f97316");
  push("negGammaEntry", "NEG-\u0393",       "#fb7185");
  push("putWall",       "PUT WALL",        "#16a34a", "gex");
  push("downsidePivot", "DN PIVOT",        "#a855f7");
  push("t1Down",        "T1 DN",           "#4ade80");
  push("t2Down",        "T2 DN",           "#22c55e");

  const above = rows.filter(r => r.price > spot).sort((a, b) => b.price - a.price);
  const below = rows.filter(r => r.price <= spot).sort((a, b) => b.price - a.price);

  const Chip = ({ r }: { r: Row }) => (
    <div className="inline-flex items-center gap-1.5 rounded border border-border/40 bg-black/30 px-1.5 py-0.5 font-mono text-[10px]">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: r.color }} />
      <span className="text-muted-foreground/80 uppercase tracking-wide">{r.name}</span>
      <span className="font-semibold text-foreground">{fmtK(r.price)}</span>
      <span className="text-muted-foreground/60">{distPct(r.price)}</span>
      {r.sub && <span className="text-muted-foreground/50">· {r.sub}</span>}
    </div>
  );

  // Vol structure quick read — 3 bands that traders can scan in one glance.
  const callWallPrice = byKind("callWall")?.price;
  const putWallPrice  = byKind("putWall")?.price;
  const zgPrice       = byKind("zeroGamma")?.price;
  const regimeLabel   = a.gammaAtSpot >= 0
    ? { text: "POS \u0393 · mean-revert", color: "text-emerald-400", dot: "bg-emerald-400" }
    : { text: "NEG \u0393 · trend/breakout", color: "text-rose-400", dot: "bg-rose-400" };

  return (
    <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
      <div className="flex items-baseline justify-between">
        <div className="text-[9px] uppercase tracking-widest text-muted-foreground/50 font-mono">
          Pivot Ladder — by horizon
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[9px]">
          <span className={`h-1.5 w-1.5 rounded-full ${regimeLabel.dot}`} />
          <span className={regimeLabel.color}>{regimeLabel.text}</span>
        </div>
      </div>

      {/* Vol structure quick-read — 3 bands */}
      <div className="flex flex-wrap items-center gap-1.5 rounded border border-border/30 bg-muted/10 px-2 py-1 font-mono text-[9px]">
        <span className="uppercase tracking-widest text-muted-foreground/60">Vol Structure</span>
        <span className="text-border/60">|</span>
        <span className="text-rose-400">
          Sell zone {callWallPrice ? `≥ ${fmtK(callWallPrice)}` : "—"}
        </span>
        <span className="text-border/60">·</span>
        <span className="text-amber-400">
          Chop {zgPrice && callWallPrice && putWallPrice
            ? `${fmtK(putWallPrice)}–${fmtK(callWallPrice)} (0Γ ${fmtK(zgPrice)})`
            : "—"}
        </span>
        <span className="text-border/60">·</span>
        <span className="text-emerald-400">
          Buy zone {putWallPrice ? `≤ ${fmtK(putWallPrice)}` : "—"}
        </span>
      </div>
      {above.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="font-mono text-[9px] uppercase tracking-wider text-red-400/70 w-16">Above ↑</span>
          {above.map((r) => <Chip key={`a-${r.name}-${r.price}`} r={r} />)}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <span className="font-mono text-[9px] uppercase tracking-wider text-amber-400/80 w-16">Spot</span>
        <div className="inline-flex items-center gap-1.5 rounded border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
          <span className="font-bold text-amber-300">LIVE {fmtK(spot)}</span>
        </div>
        {a.charmZero != null && (
          <div className="inline-flex items-center gap-1.5 rounded border border-purple-500/40 bg-purple-500/5 px-1.5 py-0.5 font-mono text-[10px]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-purple-400" />
            <span className="text-purple-300/80 uppercase tracking-wide">Charm 0</span>
            <span className="font-semibold text-purple-200">{fmtK(a.charmZero)}</span>
            <span className="text-purple-400/60">{distPct(a.charmZero)}</span>
          </div>
        )}
        {a.charmZeros && a.charmZeros.length > 0 && a.charmZeros.map((cz, i) => (
          <div key={`cz-${i}`} className="inline-flex items-center gap-1.5 rounded border border-purple-500/30 bg-purple-500/5 px-1.5 py-0.5 font-mono text-[10px]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-purple-400/70" />
            <span className="text-purple-300/70 uppercase tracking-wide">Charm·0</span>
            <span className="font-semibold text-purple-200/90">{fmtK(cz)}</span>
          </div>
        ))}
      </div>
      {below.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="font-mono text-[9px] uppercase tracking-wider text-green-400/70 w-16">Below ↓</span>
          {below.map((r) => <Chip key={`b-${r.name}-${r.price}`} r={r} />)}
        </div>
      )}

      {a.closeTargets && (
        <div className="mt-1 flex flex-wrap items-center gap-1 border-t border-border/20 pt-1">
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60 w-16">Close</span>
          {a.closeTargets.bull && (
            <div className="inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10px]" style={{ borderColor: `${COLORS.bull}55`, background: `${COLORS.bull}10` }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: COLORS.bull }} />
              <span className="uppercase tracking-wide" style={{ color: COLORS.bull }}>Bull</span>
              <span className="font-semibold text-foreground">~{fmtK(a.closeTargets.bull.price)}</span>
              <span className="text-muted-foreground/70">{a.closeTargets.bull.prob}%</span>
            </div>
          )}
          {a.closeTargets.base && (
            <div className="inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10px]" style={{ borderColor: `${COLORS.base}55`, background: `${COLORS.base}10` }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: COLORS.base }} />
              <span className="uppercase tracking-wide" style={{ color: COLORS.base }}>Base</span>
              <span className="font-semibold text-foreground">~{fmtK(a.closeTargets.base.price)}</span>
              <span className="text-muted-foreground/70">{a.closeTargets.base.prob}%</span>
            </div>
          )}
          {a.closeTargets.bear && (
            <div className="inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10px]" style={{ borderColor: `${COLORS.bear}55`, background: `${COLORS.bear}10` }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: COLORS.bear }} />
              <span className="uppercase tracking-wide" style={{ color: COLORS.bear }}>Bear</span>
              <span className="font-semibold text-foreground">~{fmtK(a.closeTargets.bear.price)}</span>
              <span className="text-muted-foreground/70">{a.closeTargets.bear.prob}%</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Schwab intraday SPX chart ───────────────────────────────────────────────

function SpxIntradayChart({ symbol, horizon }: { symbol: string; horizon: ModelHorizon }) {
  const { data, isLoading } = useQuery<{
    symbol: string; candles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
    price?: number; prevClose?: number; change?: number; changePct?: number;
  }>({
    queryKey: ["/api/ohlc", symbol, "1D", "5m"],
    queryFn: async () => {
      const r = await apiRequest(
        "GET",
        `/api/ohlc?symbol=${encodeURIComponent(symbol)}&tf=1D&interval=5m`
      );
      return r.json();
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const candles = data?.candles ?? [];
  const spot = horizon.spot;
  const prevClose = data?.prevClose;

  const lineData = useMemo(() =>
    candles.map(c => ({
      t: c.t,
      label: new Date(c.t * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }),
      price: c.c,
    })),
  [candles]);

  const cw = horizon.levels.find(l => l.kind === "callWall")?.price;
  const pw = horizon.levels.find(l => l.kind === "putWall")?.price;
  const zg = horizon.levels.find(l => l.kind === "zeroGamma")?.price;
  const dm = horizon.levels.find(l => l.kind === "dominantMag")?.price;

  const sessionHigh = candles.length ? Math.max(...candles.map(c => c.h)) : spot;
  const sessionLow = candles.length ? Math.min(...candles.map(c => c.l)) : spot;
  const yMin = Math.min(sessionLow, prevClose ?? sessionLow, pw ?? sessionLow, zg ?? sessionLow) - 5;
  const yMax = Math.max(sessionHigh, prevClose ?? sessionHigh, cw ?? sessionHigh, zg ?? sessionHigh) + 5;

  if (isLoading) {
    return (
      <div className="flex h-[180px] items-center justify-center border-b border-border/30 bg-black/40 font-mono text-[10px] text-muted-foreground">
        loading intraday tape...
      </div>
    );
  }

  if (!candles.length) {
    return (
      <div className="flex h-[180px] items-center justify-center border-b border-border/30 bg-black/40 font-mono text-[10px] text-muted-foreground">
        intraday tape unavailable (market closed or Schwab throttled)
      </div>
    );
  }

  const change = data?.change ?? 0;
  const changePct = data?.changePct ?? 0;

  return (
    <div className="border-b border-border/30 bg-black/60 p-2">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 font-mono text-[9px] text-muted-foreground">
        <span className="text-amber-400 font-semibold uppercase tracking-widest">SPX Intraday · 5m</span>
        <span>SCHWAB TAPE</span>
        {prevClose != null && <span>· PREV {fmtK(prevClose)}</span>}
        <span>· HI {fmtK(sessionHigh)}</span>
        <span>· LO {fmtK(sessionLow)}</span>
        <span className={change >= 0 ? "text-green-400" : "text-red-400"}>
          · {change >= 0 ? "+" : ""}{change.toFixed(2)} ({changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%)
        </span>
        <span className="text-muted-foreground/50">· dashed lines = dealer levels from model</span>
      </div>
      <div className="h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={lineData} margin={{ top: 6, right: 60, left: 4, bottom: 4 }}>
            <XAxis
              dataKey="label"
              stroke="#64748b"
              tick={{ fontSize: 9, fill: "#64748b" }}
              tickLine={false}
              axisLine={{ stroke: "#1e293b" }}
              interval={"preserveStartEnd"}
              minTickGap={40}
            />
            <YAxis
              domain={[yMin, yMax]}
              stroke="#64748b"
              tick={{ fontSize: 9, fill: "#64748b" }}
              tickFormatter={(v) => fmtK(v)}
              width={52}
              tickLine={false}
              axisLine={{ stroke: "#1e293b" }}
            />
            <Tooltip
              contentStyle={{
                background: "rgba(2,6,23,0.97)",
                border: "1px solid #334155",
                borderRadius: 4,
                fontSize: 10,
                color: "#f1f5f9",
                fontFamily: "var(--font-mono)",
              }}
              formatter={(v: number) => [fmtK(v), "SPX"]}
            />
            {prevClose != null && (
              <ReferenceLine y={prevClose} stroke="#64748b" strokeDasharray="2 4" strokeOpacity={0.6}>
                <Label value={`PREV ${fmtK(prevClose)}`} position="right" offset={4} fill="#64748b" fontSize={9} style={{ fontFamily: "var(--font-mono)" }} />
              </ReferenceLine>
            )}
            {cw != null && (
              <ReferenceLine y={cw} stroke={COLORS.callWall} strokeDasharray="4 3" strokeOpacity={0.55} strokeWidth={1}>
                <Label value={`CW ${fmtK(cw)}`} position="right" offset={4} fill={COLORS.callWall} fontSize={9} fontWeight={600} style={{ fontFamily: "var(--font-mono)" }} />
              </ReferenceLine>
            )}
            {zg != null && (
              <ReferenceLine y={zg} stroke={COLORS.zeroGamma} strokeDasharray="4 3" strokeOpacity={0.55} strokeWidth={1}>
                <Label value={`0Γ ${fmtK(zg)}`} position="right" offset={4} fill={COLORS.zeroGamma} fontSize={9} fontWeight={600} style={{ fontFamily: "var(--font-mono)" }} />
              </ReferenceLine>
            )}
            {dm != null && dm !== cw && dm !== pw && (
              <ReferenceLine y={dm} stroke="#14b8a6" strokeDasharray="4 3" strokeOpacity={0.45} strokeWidth={1}>
                <Label value={`DM ${fmtK(dm)}`} position="right" offset={4} fill="#14b8a6" fontSize={9} fontWeight={600} style={{ fontFamily: "var(--font-mono)" }} />
              </ReferenceLine>
            )}
            {pw != null && (
              <ReferenceLine y={pw} stroke={COLORS.putWall} strokeDasharray="4 3" strokeOpacity={0.55} strokeWidth={1}>
                <Label value={`PW ${fmtK(pw)}`} position="right" offset={4} fill={COLORS.putWall} fontSize={9} fontWeight={600} style={{ fontFamily: "var(--font-mono)" }} />
              </ReferenceLine>
            )}
            <Line
              type="monotone"
              dataKey="price"
              stroke="#fcd34d"
              strokeWidth={1.6}
              dot={false}
              activeDot={{ r: 4, fill: "#fcd34d", stroke: "#000", strokeWidth: 1 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Full model view ──────────────────────────────────────────────────────────

// ─── 13-Week Trajectory Panel (quarterly only) ──────────────────────────────
function WeeklyTrajectoryPanel({ traj, symbol }: { traj: WeeklyTrajectory; symbol: string }) {
  const isSpx = symbol === "^GSPC";
  const fmtPrice = (n: number | null | undefined): string => {
    if (n == null || !isFinite(n)) return "\u2014";
    return isSpx ? Math.round(n).toLocaleString() : n.toFixed(2);
  };

  // Build chart data ─ prepend WK0 (today, all three lines = spot)
  const chartData = useMemo(() => {
    const rows: Array<{
      wk: string; date: string; bull: number; base: number; bear: number;
      sigma: number; sigmaIncr?: number; drift: number; events: string; segment: string;
    }> = [
      { wk: "NOW", date: "today", bull: traj.spot, base: traj.spot, bear: traj.spot, sigma: 0, sigmaIncr: 0, drift: 0, events: "", segment: "" },
    ];
    for (const w of traj.weeks) {
      // Prefer cumulative σ (drives the cone). Fall back to incremental for old payloads.
      const sigmaForCone = w.sigmaCum ?? w.sigmaWeek;
      const cumDrift = w.cumDriftPct ?? w.driftPct ?? 0;
      rows.push({
        wk: w.weekLabel,
        date: w.weekEndDate,
        bull: w.bull,
        base: w.base,
        bear: w.bear,
        sigma: sigmaForCone,
        sigmaIncr: w.sigmaWeek,  // exposed in tooltip so user sees this week's piece
        drift: cumDrift,
        events: (w.events ?? []).join(","),
        segment: w.vixSegment ?? "",
      });
    }
    return rows;
  }, [traj]);

  // y-domain: pad 1.5% above highest bull / below lowest bear
  const [yMin, yMax] = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const w of traj.weeks) {
      if (w.bear < lo) lo = w.bear;
      if (w.bull > hi) hi = w.bull;
    }
    if (traj.spot < lo) lo = traj.spot;
    if (traj.spot > hi) hi = traj.spot;
    // Include only anchors that fall within (or near) the cone ─ within 1.5x cone width of spot
    const coneRange = Math.max(hi - lo, traj.spot * 0.05);
    for (const a of traj.anchors) {
      if (Math.abs(a.level - traj.spot) <= coneRange * 1.2) {
        if (a.level < lo) lo = a.level;
        if (a.level > hi) hi = a.level;
      }
    }
    const pad = (hi - lo) * 0.05;
    return [lo - pad, hi + pad];
  }, [traj]);

  // Anchors that are visible in the y-domain
  const visibleAnchors = useMemo(
    () => traj.anchors.filter(a => a.level >= yMin && a.level <= yMax),
    [traj.anchors, yMin, yMax],
  );

  const anchorColor = (kind: string): string => {
    if (kind === "callWall") return "#ef4444"; // red ceiling
    if (kind === "putWall") return "#10b981"; // green floor
    if (kind === "gammaFlip") return "#a855f7"; // purple
    if (kind === "maxPain") return "#f59e0b"; // amber
    if (kind.startsWith("jpm")) return "#06b6d4"; // cyan
    return "#64748b";
  };

  const driftDirLabel = traj.drivers.totalDriftPerWeek > 0.0005
    ? "BULLISH TILT"
    : traj.drivers.totalDriftPerWeek < -0.0005
      ? "BEARISH TILT"
      : "NEUTRAL";
  const driftDirColor = traj.drivers.totalDriftPerWeek > 0.0005
    ? "text-green-400"
    : traj.drivers.totalDriftPerWeek < -0.0005
      ? "text-red-400"
      : "text-muted-foreground";

  const TooltipFmt = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;
    const row = payload[0]?.payload;
    if (!row) return null;
    return (
      <div className="rounded border border-amber-500/40 bg-black/95 px-3 py-2 font-mono text-[10px] shadow-lg">
        <div className="font-bold text-amber-400 mb-1">{label} · <span className="text-muted-foreground">{row.date}</span></div>
        <div className="text-yellow-400">BULL {fmtPrice(row.bull)}</div>
        <div className="text-foreground">BASE {fmtPrice(row.base)}</div>
        <div className="text-red-400">BEAR {fmtPrice(row.bear)}</div>
        {row.sigma > 0 && (
          <div className="mt-1 text-[9px] text-muted-foreground">
            ±1σ ±{fmtPrice(row.sigma)} · cum drift {(row.drift * 100).toFixed(2)}%
          </div>
        )}
        {row.segment && (
          <div className="text-[9px] text-cyan-400/70">σ source: {row.segment}</div>
        )}
        {row.events && (
          <div className="mt-1 inline-block rounded border border-amber-500/50 bg-amber-500/10 px-1 text-[9px] font-bold text-amber-400">
            {row.events.replace(/,/g, " + ")}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="border-t border-amber-500/30 bg-black/40 p-3"
      data-testid="weekly-trajectory-panel"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
        <span className="text-amber-400 font-bold">13-WEEK TRAJECTORY</span>
        <span className="text-border">|</span>
        <span className="text-muted-foreground">BULL / BASE / BEAR · WEEK BY WEEK</span>
        <span className="text-border">|</span>
        <span className={driftDirColor + " font-bold"}>{driftDirLabel}</span>
        <span className="text-border">|</span>
        <span className="text-cyan-400/80">
          DRIFT {(traj.drivers.annualizedDrift * 100).toFixed(1)}%/yr
        </span>
        <span className="text-border">|</span>
        <span className="text-muted-foreground">{traj.drivers.magnetCount} ANCHORS PULLING</span>
      </div>

      <div className="h-[280px] w-full" data-testid="weekly-trajectory-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 10, right: 60, bottom: 10, left: 10 }}>
            <XAxis
              dataKey="wk"
              tick={{ fill: "#94a3b8", fontSize: 10, fontFamily: "monospace" }}
              axisLine={{ stroke: "#334155" }}
              tickLine={{ stroke: "#334155" }}
            />
            <YAxis
              domain={[yMin, yMax]}
              tickFormatter={(v) => fmtPrice(v)}
              tick={{ fill: "#94a3b8", fontSize: 10, fontFamily: "monospace" }}
              axisLine={{ stroke: "#334155" }}
              tickLine={{ stroke: "#334155" }}
              width={60}
            />
            <Tooltip content={<TooltipFmt />} />

            {/* Anchor reference lines */}
            {visibleAnchors.map((a) => (
              <ReferenceLine
                key={a.kind}
                y={a.level}
                stroke={anchorColor(a.kind)}
                strokeDasharray={a.strength === "primary" ? "4 2" : "2 4"}
                strokeWidth={a.strength === "primary" ? 1.5 : 1}
                strokeOpacity={a.strength === "primary" ? 0.7 : 0.45}
              >
                <Label
                  value={`${a.label} ${fmtPrice(a.level)}`}
                  position="right"
                  fill={anchorColor(a.kind)}
                  fontSize={9}
                  fontFamily="monospace"
                  offset={5}
                />
              </ReferenceLine>
            ))}

            {/* Spot reference */}
            <ReferenceLine
              y={traj.spot}
              stroke="#fbbf24"
              strokeDasharray="1 3"
              strokeOpacity={0.6}
            />

            {/* Event-week vertical markers (OPEX / FOMC) */}
            {traj.weeks.filter(w => w.events && w.events.length > 0).map(w => {
              const isFomc = w.events!.includes("FOMC");
              return (
                <ReferenceLine
                  key={`evt-${w.weekIndex}`}
                  x={w.weekLabel}
                  stroke={isFomc ? "#f97316" : "#a855f7"}
                  strokeDasharray="3 2"
                  strokeOpacity={0.4}
                />
              );
            })}

            {/* Bull / Base / Bear lines */}
            <Line
              type="monotone"
              dataKey="bull"
              name="BULL"
              stroke="#facc15"
              strokeWidth={2}
              dot={{ r: 2.5, fill: "#facc15" }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="base"
              name="BASE"
              stroke="#f1f5f9"
              strokeWidth={2.5}
              dot={{ r: 3, fill: "#f1f5f9" }}
              activeDot={{ r: 4.5 }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="bear"
              name="BEAR"
              stroke="#ef4444"
              strokeWidth={2}
              dot={{ r: 2.5, fill: "#ef4444" }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />

            <Legend
              wrapperStyle={{ fontFamily: "monospace", fontSize: 10 }}
              iconSize={8}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Endpoint summary + drivers footer */}
      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
        {/* Endpoint */}
        <div className="rounded border border-amber-500/20 bg-black/50 p-2 font-mono text-[10px]">
          <div className="mb-1 text-[9px] uppercase tracking-widest text-amber-400/80">3-MONTH ENDPOINT (WK13 · {traj.weeks[12]?.weekEndDate})</div>
          <div className="flex items-center gap-3">
            <span className="text-yellow-400">BULL <span className="font-bold">{fmtPrice(traj.endpoint.bull)}</span></span>
            <span className="text-foreground">BASE <span className="font-bold">{fmtPrice(traj.endpoint.base)}</span></span>
            <span className="text-red-400">BEAR <span className="font-bold">{fmtPrice(traj.endpoint.bear)}</span></span>
          </div>
          <div className="mt-1 text-[9px] text-muted-foreground">
            ±1σ cone ±{fmtPrice(traj.weeks[12]?.sigmaCum ?? traj.weeks[12]?.sigmaWeek ?? 0)} · ±2σ ±{fmtPrice((traj.weeks[12]?.sigmaCum ?? traj.weeks[12]?.sigmaWeek ?? 0) * 2)} (cumulative thru WK13)
          </div>
        </div>

        {/* Drivers — v2 with 4 components */}
        <div className="rounded border border-cyan-500/20 bg-black/50 p-2 font-mono text-[10px]">
          <div className="mb-1 text-[9px] uppercase tracking-widest text-cyan-400/80">DRIFT DRIVERS (PER WEEK)</div>
          <div className="grid grid-cols-4 gap-2 text-[10px]">
            <div>
              <div className="text-[8px] text-muted-foreground/70">COMPOSITE</div>
              <div className={traj.drivers.compositeTilt >= 0 ? "text-green-400" : "text-red-400"}>
                {(traj.drivers.compositeTilt * 100).toFixed(3)}%
              </div>
              <div className="text-[8px] text-muted-foreground/50">{traj.inputs.composite}</div>
            </div>
            <div>
              <div className="text-[8px] text-muted-foreground/70">GEX</div>
              <div className={traj.drivers.gexTilt >= 0 ? "text-green-400" : "text-red-400"}>
                {(traj.drivers.gexTilt * 100).toFixed(3)}%
              </div>
              <div className="text-[8px] text-muted-foreground/50">
                {traj.inputs.totalGex != null ? `${(traj.inputs.totalGex / 1e9).toFixed(1)}B` : "\u2014"}
              </div>
            </div>
            <div>
              <div className="text-[8px] text-muted-foreground/70">VIX TERM</div>
              <div className={traj.drivers.vixTermTilt >= 0 ? "text-green-400" : "text-red-400"}>
                {(traj.drivers.vixTermTilt * 100).toFixed(3)}%
              </div>
              <div className="text-[8px] text-muted-foreground/50">
                v {traj.inputs.vix?.toFixed(1) ?? "\u2014"}
              </div>
            </div>
            <div>
              <div className="text-[8px] text-muted-foreground/70">SKEW</div>
              <div className={(traj.drivers.skewTilt ?? 0) >= 0 ? "text-green-400" : "text-red-400"}>
                {((traj.drivers.skewTilt ?? 0) * 100).toFixed(3)}%
              </div>
              <div className="text-[8px] text-muted-foreground/50">
                {traj.inputs.skew?.toFixed(1) ?? "\u2014"}
              </div>
            </div>
          </div>
          <div className="mt-1 border-t border-cyan-500/15 pt-1 text-[9px]">
            <span className="text-muted-foreground/70">TOTAL </span>
            <span className={traj.drivers.totalDriftPerWeek >= 0 ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
              {(traj.drivers.totalDriftPerWeek * 100).toFixed(3)}%/wk
            </span>
            <span className="text-muted-foreground/50"> · {(traj.drivers.annualizedDrift * 100).toFixed(1)}%/yr</span>
          </div>
        </div>
      </div>

      {/* v2: σ scaling row — VRP + event weeks + segments */}
      <div className="mt-2 rounded border border-purple-500/20 bg-black/50 p-2 font-mono text-[10px]">
        <div className="mb-1 text-[9px] uppercase tracking-widest text-purple-400/80">σ SCALING (— cone width drivers)</div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 text-[10px]">
          <div>
            <div className="text-[8px] text-muted-foreground/70">VRP RATIO</div>
            <div className={
              (traj.drivers.vrpRatio ?? 1) < 0.85 ? "text-cyan-400" :
              (traj.drivers.vrpRatio ?? 1) > 1.05 ? "text-amber-400" :
              "text-foreground"
            }>
              {traj.drivers.vrpRatio != null ? traj.drivers.vrpRatio.toFixed(2) : "\u2014"}
              <span className="text-[8px] text-muted-foreground/60"> RV/IV</span>
            </div>
            <div className="text-[8px] text-muted-foreground/50">
              rv {traj.inputs.realizedVol20d != null ? (traj.inputs.realizedVol20d * 100).toFixed(1) + "%" : "\u2014"} / iv {traj.inputs.vix?.toFixed(1) ?? "\u2014"}%
            </div>
          </div>
          <div>
            <div className="text-[8px] text-muted-foreground/70">VRP SCALE</div>
            <div className={
              (traj.drivers.vrpScale ?? 1) < 0.95 ? "text-cyan-400" :
              (traj.drivers.vrpScale ?? 1) > 1.05 ? "text-amber-400" :
              "text-foreground"
            }>
              ×{(traj.drivers.vrpScale ?? 1).toFixed(2)}
            </div>
            <div className="text-[8px] text-muted-foreground/50">cone narrow/wide</div>
          </div>
          <div>
            <div className="text-[8px] text-muted-foreground/70">EVENT WEEKS</div>
            <div className={(traj.drivers.eventWeeks ?? 0) > 0 ? "text-amber-400" : "text-foreground"}>
              {traj.drivers.eventWeeks ?? 0}
              <span className="text-[8px] text-muted-foreground/60"> /13</span>
            </div>
            <div className="text-[8px] text-muted-foreground/50">σ +12% on OPEX/FOMC</div>
          </div>
          <div>
            <div className="text-[8px] text-muted-foreground/70">TERM SEG</div>
            <div className="text-cyan-400 text-[10px]">VIX9D → VIX → VIX3M</div>
            <div className="text-[8px] text-muted-foreground/50">
              {traj.inputs.vix9d?.toFixed(1) ?? "\u2014"} → {traj.inputs.vix?.toFixed(1) ?? "\u2014"} → {traj.inputs.vix3m?.toFixed(1) ?? "\u2014"}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-2 text-[9px] text-muted-foreground/50 font-mono">
        Drift-tilted GBM cone with magnet pull toward dealer levels. σ segmented across VIX9D/VIX/VIX3M, scaled by
        VRP (RV÷IV clamped 0.7-1.3), bumped +12% on OPEX/FOMC weeks. Drift = composite + GEX + VIX term + SKEW.
        Walls/flip pull primary, max pain + JPM secondary, capped ±4%/wk per anchor. NOT a forecast — a probability cone.
      </div>
    </div>
  );
}

function ModelView({ horizon, session, symbol }: { horizon: ModelHorizon; session: "live" | "last-close"; symbol: string }) {
  const a = horizon.audit;
  const timeStr = etTime(a.asOf);
  const probs = a.scenarioProb;

  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-[#030712] text-foreground"
      data-testid="batcave-model-view"
    >
      {/* ── Top header strip ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-black/70 px-3 py-2 font-mono text-[10px]">
        <div className="flex flex-wrap items-center gap-2">
          <BatmanLogo className="h-5 w-10 text-amber-500" />
          <span className="font-bold text-amber-400 tracking-widest text-[11px]">BATCAVE</span>
          <span className="text-border">|</span>
          <span className="font-bold text-foreground tracking-wider" data-testid="text-model-label">
            {horizon.label}
          </span>
          <span className="text-border">|</span>
          <span className="text-muted-foreground">{horizon.targetDateLong ?? horizon.spotAnchorDate}</span>
          <span className="text-border">|</span>
          <span className={session === "live" ? "text-green-400" : "text-amber-400"}>
            {session === "live" ? "LIVE" : "LAST SESSION"} {timeStr} ET
          </span>
          <span className="text-border">|</span>
          <span className="text-foreground font-bold">SPOT {fmtK(horizon.spot)}</span>
          <span className="text-border">|</span>
          <span className={a.dfi >= 0 ? "text-green-400" : "text-red-400"}>
            DFI {a.dfi >= 0 ? "+" : ""}{a.dfi.toFixed(2)} {a.dfiLabel}
            {a.dfiFlipped && <span className="ml-1 text-yellow-400 text-[9px]">⚡ FLIP</span>}
          </span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground/60 text-[9px]">
          <BatmanLogo className="h-3 w-5 text-muted-foreground/40" />
          <span>DATA: PULSE / BATCAVE MODEL</span>
        </div>
      </div>

      {/* ── VIX + confidence strip ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/30 bg-black/40 px-3 py-1 font-mono text-[9px] text-muted-foreground/60">
        <span>VIX {horizon.vol.vix?.toFixed(2) ?? "—"} {fmtPct(horizon.vol.vixChangePct)}</span>
        <span>·</span>
        <span>TERM {horizon.vol.termRatio?.toFixed(3) ?? "—"} ({horizon.vol.termLabel})</span>
        {horizon.vomma === "elevated" && (
          <><span>·</span><span className="text-amber-400">⚠ VOL ELEVATED</span></>
        )}
        <span>·</span>
        <span>CONF: <span className={
          horizon.confidence === "HIGH" ? "text-green-400" :
          horizon.confidence === "MODERATE" ? "text-amber-400" : "text-red-400"
        }>{horizon.confidence}</span></span>
        <span>·</span>
        <span>BEAR {probs.bear}% / BASE {probs.base}% / BULL {probs.bull}%</span>
      </div>

      {/* Batcave #3 + #4 — recal tracking + DoD term structure strip */}
      {(a.lastRecal || a.termStructureDoD) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/30 bg-black/50 px-3 py-1 font-mono text-[9px]" data-testid="recal-dod-strip">
          {a.lastRecal && (
            <>
              <span className="text-muted-foreground/60">LAST RECAL</span>
              <span className="text-foreground">{etTime(a.lastRecal.at)} ET</span>
              <span className="text-muted-foreground/40">·</span>
              <span>
                DFI{" "}
                <span className={a.lastRecal.dfi >= 0 ? "text-green-400" : "text-red-400"}>
                  {a.lastRecal.dfi >= 0 ? "+" : ""}{a.lastRecal.dfi.toFixed(2)}
                </span>
                {a.lastRecal.dfiDeltaSinceOpen != null && (
                  <span className="ml-1 text-muted-foreground/60">
                    ({a.lastRecal.dfiDeltaSinceOpen >= 0 ? "+" : ""}{a.lastRecal.dfiDeltaSinceOpen.toFixed(2)} since open)
                  </span>
                )}
              </span>
            </>
          )}
          {a.lastRecal && a.termStructureDoD && <span className="text-border/60">|</span>}
          {a.termStructureDoD && (
            <>
              <span className="text-muted-foreground/60">1D IV</span>
              <span className="text-foreground">
                {a.termStructureDoD.iv1d != null ? `${a.termStructureDoD.iv1d.toFixed(2)}%` : "—"}
              </span>
              {a.termStructureDoD.iv1dDelta != null && (
                <span className={a.termStructureDoD.iv1dDelta >= 0 ? "text-amber-400" : "text-cyan-400"}>
                  ({a.termStructureDoD.iv1dDelta >= 0 ? "+" : ""}{a.termStructureDoD.iv1dDelta.toFixed(2)}%)
                </span>
              )}
              <span className="text-muted-foreground/40">·</span>
              <span className="text-muted-foreground/60">CHARM</span>
              <span className={a.termStructureDoD.charmNow >= 0 ? "text-green-400" : "text-red-400"}>
                {a.termStructureDoD.charmNow >= 0 ? "+" : ""}{a.termStructureDoD.charmNow.toFixed(2)}B
              </span>
              {a.termStructureDoD.charmPrev != null && (
                <span className="text-muted-foreground/60">
                  (was {a.termStructureDoD.charmPrev >= 0 ? "+" : ""}{a.termStructureDoD.charmPrev.toFixed(2)}B)
                </span>
              )}
              <span className="text-muted-foreground/40">·</span>
              <span className={
                a.termStructureDoD.label === "Vol Bid Up" ? "text-amber-400 font-semibold" :
                a.termStructureDoD.label === "Vol Offered" ? "text-cyan-400 font-semibold" :
                a.termStructureDoD.label === "Charm Lifting" ? "text-green-400 font-semibold" :
                a.termStructureDoD.label === "Charm Pressing" ? "text-red-400 font-semibold" :
                "text-muted-foreground"
              }>
                {a.termStructureDoD.label}
              </span>
            </>
          )}
        </div>
      )}

      {/* ── Schwab intraday tape (SPX only, daily/weekly views) ── */}
      {(horizon.horizon === "daily" || horizon.horizon === "weekly") && symbol === "^GSPC" && (
        <SpxIntradayChart symbol={symbol} horizon={horizon} />
      )}

      {/* ── Audit + chart + rail ── */}
      <div className="flex flex-col gap-0 xl:flex-row">
        {/* Left column: audit + chart + legend */}
        <div className="flex flex-1 flex-col gap-0 overflow-hidden">
          {/* Audit box */}
          <div className="border-b border-border/30 p-3">
            <AuditBox horizon={horizon} />
          </div>

          {/* Chart */}
          <div className="flex gap-0 overflow-hidden">
            <div className="flex-1 min-w-0 p-3">
              {horizon.horizon === "weekly" && <EventBand horizon={horizon} />}
              <ModelChart horizon={horizon} />
              <LevelsStrip horizon={horizon} />
              <ScenarioLegend horizon={horizon} />
              <MMMatrixHeatmap horizon={horizon} />
            </div>
          </div>
        </div>

        {/* Right rail */}
        <RightRail horizon={horizon} />
      </div>

      {/* ── 13-Week Trajectory (quarterly horizon only) ── */}
      {horizon.horizon === "quarterly" && horizon.weeklyTrajectory && (
        <ErrorBoundary label="Weekly Trajectory">
          <WeeklyTrajectoryPanel traj={horizon.weeklyTrajectory} symbol={symbol} />
        </ErrorBoundary>
      )}

      {/* ── Bottom status strip ── */}
      <StatusStrip horizon={horizon} />
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function ModelsPanel() {
  const [symbol, setSymbol] = useState<"^GSPC" | "SPY">("^GSPC");
  const [horizon, setHorizon] = useState<Horizon>("daily");

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
    // 30-min refresh — BULL / BASE / BEAR scenarios re-roll every half hour so the
    // user sees current price, current dealer levels, and live scenario targets.
    refetchInterval: 30 * 60_000,
    staleTime: 25 * 60_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  // Live "updated Xm ago" ticker — re-renders every 30s so the badge counts up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const updatedAgo = useMemo(() => {
    if (!data?.asOf) return null;
    const ageSec = Math.max(0, Math.floor((now - data.asOf * 1000) / 1000));
    if (ageSec < 60) return `${ageSec}s ago`;
    const m = Math.floor(ageSec / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ago`;
  }, [data?.asOf, now]);

  const active = data?.horizons[horizon];

  return (
    <div className="space-y-3" data-testid="models-panel">
      {/* Cross-tab regime conditioning chip */}
      <div className="flex items-center gap-2">
        <RegimeChip origin="models" />
      </div>

      {/* ── Live Chain Audit — at the top, before existing controls ── */}
      {/* Inserted as a collapsible section heading + ChainAudit */}
      {/* Control bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-2">
        <Activity className="h-4 w-4 text-amber-400" />
        <BatmanLogo className="h-4 w-8 text-amber-400" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-amber-400">Batcave Model</span>
        <span className="text-border/60 mx-1">·</span>

        {/* Horizon pills */}
        <div className="flex gap-1 rounded border border-border/60 bg-black/30 p-0.5">
          {(["daily", "weekly", "monthly", "quarterly"] as Horizon[]).map((h) => (
            <Button
              key={h}
              variant={horizon === h ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2.5 text-[10px] uppercase tracking-wider"
              onClick={() => setHorizon(h)}
              data-testid={`btn-horizon-${h}`}
            >
              {h === "quarterly" ? "3M" : h}
            </Button>
          ))}
        </div>

        {/* Symbol toggle */}
        <div className="flex gap-1 rounded border border-border/60 bg-black/30 p-0.5">
          {([
            { k: "^GSPC" as const, label: "SPX" },
            { k: "SPY" as const, label: "SPY" },
          ]).map(({ k, label }) => (
            <Button
              key={k}
              variant={symbol === k ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2.5 text-[10px]"
              onClick={() => setSymbol(k)}
              data-testid={`btn-symbol-${label}`}
            >
              {label}
            </Button>
          ))}
        </div>

        {data && (
          <Badge
            variant="outline"
            className={
              data.session === "live"
                ? "border-green-500/40 font-mono text-[9px] text-green-400"
                : "border-amber-500/40 font-mono text-[9px] text-amber-300"
            }
            data-testid="badge-models-session"
          >
            {data.session === "live" ? "● LIVE" : "◌ LAST SESSION"}
          </Badge>
        )}

        {updatedAgo && (
          <Badge
            variant="outline"
            className="border-cyan-500/30 font-mono text-[9px] text-cyan-300/90"
            data-testid="badge-models-updated"
            title="Bull / Base / Bear scenarios refresh every 30 minutes"
          >
            <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full bg-cyan-400 ${isFetching ? "animate-pulse" : ""}`} />
            UPDATED {updatedAgo} · NEXT 30M
          </Badge>
        )}

        {experimental && (
          <Badge variant="outline" className="border-violet-500/50 font-mono text-[9px] text-violet-300" data-testid="badge-experimental">
            EXP · DEALER MAP
          </Badge>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto h-6 gap-1 font-mono text-[10px]"
          data-testid="btn-models-refresh"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {isLoading && (
        <div className="rounded-lg border border-border bg-[#030712] p-6">
          <Skeleton className="h-[540px] w-full bg-muted/20" />
        </div>
      )}
      {isError && !isLoading && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-center font-mono text-[11px] text-red-400">
          <AlertTriangle className="mx-auto mb-2 h-5 w-5" />
          Couldn't build model. Options chain may be rate-limited — try again in a minute.
        </div>
      )}
      {data && !active && !isLoading && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-6 text-center font-mono text-[11px] text-amber-300">
          {data.warnings.length
            ? data.warnings.join(" · ")
            : `${horizon.toUpperCase()} model couldn't be built for ${symbol}.`}
        </div>
      )}
      {active && (
        <ErrorBoundary label="BATCAVE Model View">
          <ModelView horizon={active} session={data!.session} symbol={symbol} />
        </ErrorBoundary>
      )}

      {/* ── Backtest accuracy overlay ── */}
      <BacktestPanel defaultHorizon={horizon as BacktestHorizon} />

      {/* ── ML Agent Scorecard ─ honest accuracy history ── */}
      <ErrorBoundary label="ML Accuracy">
        <MLAccuracyCard defaultSymbol={symbol} />
      </ErrorBoundary>

      {/* ── Pivot Point Projection ─ 1-2 month directional outlook ── */}
      <ErrorBoundary label="Pivot Projection">
        <PivotProjection defaultSymbol={symbol} />
      </ErrorBoundary>

      {/* ── Live Chain Audit section ── */}
      <div
        className="rounded-lg border border-cyan-500/20 bg-black/30"
        data-testid="chain-audit-section"
      >
        <div className="flex items-center gap-2 border-b border-cyan-500/20 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-cyan-400/80">
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
          Live Chain Audit — Schwab
          <span className="text-muted-foreground/40">· SPX / DEX / Vanna / Charm / Skew / Term / Vol / Dealer / GEX / Pin / VRP</span>
        </div>
        <div className="p-3">
          <ErrorBoundary label="Chain Audit">
            <ChainAudit />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
