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

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, ReferenceLine, ReferenceDot, ReferenceArea,
  ResponsiveContainer, XAxis, YAxis, Tooltip, Label,
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
  doubleZeroLow: number | null;
  doubleZeroHigh: number | null;
  scenarioProb: { bull: number; base: number; bear: number };
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
  targetDateLong?: string;
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

// ─── Right-rail level row ─────────────────────────────────────────────────────

function RailRow({
  label,
  value,
  sub,
  color,
  highlight = false,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-2 border-b border-border/20 py-0.5 text-[10px] font-mono ${
        highlight ? "bg-yellow-400/10" : ""
      }`}
    >
      <span className="uppercase tracking-wider text-muted-foreground/70">{label}</span>
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
      <RailRow label="CEILING" value={pFmt(callWall?.price)} sub={distPct(callWall?.price)} color={COLORS.bear} />
      {upVomma && <RailRow label="ACCEL ZONE" value={pFmt(upVomma?.price)} sub={distPct(upVomma?.price)} color={COLORS.bear} />}
      {callWall && <RailRow label="CALL WALL" value={pFmt(callWall.price)} sub={callWall.gex != null ? `${(callWall.gex/1e6).toFixed(1)}M GEX` : undefined} color={COLORS.callWall} />}
      {upPivot  && <RailRow label="UPSIDE TARGET" value={pFmt(upPivot.price)} sub={distPct(upPivot.price)} color={COLORS.bull} />}
      {vannaFlip && <RailRow label="VANNA FLIP" value={pFmt(vannaFlip.price)} sub={distPct(vannaFlip.price)} color={COLORS.vanna} />}

      {/* Double Zero Zone */}
      <RailDivider label="pivot zone" />
      {a.charmZero && <RailRow label="CHARM ZERO" value={fmtK(a.charmZero)} sub={distPct(a.charmZero)} color={COLORS.charm} />}
      <RailRow label="DOUBLE ZERO" value={dzStr} color={COLORS.dz} highlight />
      {zeroGamma && <RailRow label="GAMMA ZERO" value={pFmt(zeroGamma.price)} sub={distPct(zeroGamma.price)} color={COLORS.zeroGamma} />}
      {charmPocketLow && <RailRow label="CHARM POCKET" value={charmPocketStr} color={COLORS.charm} />}
      {domMag && <RailRow label="DOM MAGNET" value={pFmt(domMag.price)} sub={domMag.gex != null ? `${(domMag.gex/1e6).toFixed(1)}M` : undefined} color={COLORS.base} />}
      {a.mainPivot && <RailRow label="MAIN PIVOT" value={fmtK(a.mainPivot)} sub={distPct(a.mainPivot)} color={COLORS.amber} />}

      {/* Scenario projections */}
      <RailDivider label="scenarios" />
      <RailRow label={`BULL ${probs.bull}%`} value={bullRange} color={COLORS.bull} />
      <RailRow label={`BASE ${probs.base}%`} value={baseRange} color={COLORS.base} />
      <RailRow label={`BEAR ${probs.bear}%`} value={bearRange} color={COLORS.bear} />

      {/* Downside */}
      <RailDivider label="support" />
      {dnPivot  && <RailRow label="DOWNSIDE PIVOT" value={pFmt(dnPivot.price)} sub={distPct(dnPivot.price)} color={COLORS.pivot} />}
      {putWall  && <RailRow label="PUT WALL" value={pFmt(putWall.price)} sub={putWall.gex != null ? `${(Math.abs(putWall.gex)/1e6).toFixed(1)}M GEX` : undefined} color={COLORS.callWall} />}
      {loVomma  && <RailRow label="LOWER VOMMA" value={pFmt(loVomma.price)} sub={distPct(loVomma.price)} color={COLORS.negGamma} />}
      {negGamma && <RailRow label="NEG-Γ ENTRY" value={pFmt(negGamma.price)} sub={distPct(negGamma.price)} color={COLORS.bear} />}
      {extVac   && <RailRow label="EXT VACUUM" value={pFmt(extVac.price)} sub={distPct(extVac.price)} color={COLORS.bear} />}
      {zomma    && <RailRow label="ZOMMA BRIDGE" value={pFmt(zomma.price)} sub={distPct(zomma.price)} color={COLORS.dz} />}
      {byKind("mopexMaxPain") && <RailRow label="MAX PAIN" value={pFmt(byKind("mopexMaxPain")?.price)} color={COLORS.amber} />}

      <div className="mt-2 text-[8px] text-muted-foreground/40 leading-tight">
        Red = resistance · Green = support<br />
        Cyan = pivot/data · Yellow = flip zone
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
        {a.contractCount > 0 && (
          <>
            <span>|</span>
            <span>{a.contractCount.toLocaleString()} ROWS (CBOE)</span>
          </>
        )}
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
    const gap = (yMax - yMin) * 0.018;
    const priority = (k: string) =>
      ["callWall", "putWall", "zeroGamma", "dominantMag", "mopexMaxPain"].includes(k) ? 2
      : ["strongMag", "upsidePivot", "downsidePivot", "vannaFlip", "charmTarget"].includes(k) ? 1
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
      <div className="h-[460px] w-full" data-testid="batcave-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 12, right: 8, left: 0, bottom: 16 }}>
            <XAxis
              dataKey="label"
              stroke="#475569"
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickLine={false}
              axisLine={{ stroke: "#1e293b" }}
            />
            <YAxis
              domain={[yMin - yPad, yMax + yPad]}
              stroke="#475569"
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickFormatter={(v) => fmtK(v)}
              width={56}
              tickLine={false}
              axisLine={{ stroke: "#1e293b" }}
            />
            <Tooltip
              contentStyle={{
                background: "rgba(2,6,23,0.97)",
                border: "1px solid #1e293b",
                borderRadius: 4,
                fontSize: 10,
                color: "#e2e8f0",
                fontFamily: "var(--font-mono)",
              }}
              formatter={(value: number, name: string) => [fmtK(value), name.toUpperCase()]}
              labelStyle={{ color: "#64748b" }}
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

            {/* Level reference lines */}
            {displayLevels.map((lv) => {
              // Skip t1/t2 targets — too many lines
              if (["t1Up","t2Up","t1Down","t2Down"].includes(lv.kind)) return null;
              const color = levelColor(lv.kind);
              const dashed = !["callWall","putWall","zeroGamma","dominantMag"].includes(lv.kind);
              return (
                <ReferenceLine
                  key={`${lv.kind}-${lv.price}`}
                  y={lv.price}
                  stroke={color}
                  strokeDasharray={dashed ? "3 3" : "4 4"}
                  strokeOpacity={lv.showLabel ? 0.8 : 0.4}
                  ifOverflow="extendDomain"
                >
                  {lv.showLabel && (
                    <Label
                      value={`${lv.name} ${fmtK(lv.price)}`}
                      position="insideRight"
                      offset={4}
                      fill={color}
                      fontSize={9}
                      style={{ fontFamily: "var(--font-mono)", opacity: 0.85 }}
                    />
                  )}
                </ReferenceLine>
              );
            })}

            {/* Path lines */}
            {horizon.paths.map(p => {
              const stroke = p.kind === "bull" ? COLORS.bull : p.kind === "base" ? COLORS.base : COLORS.bear;
              const prob = p.kind === "bull" ? probs.bull : p.kind === "base" ? probs.base : probs.bear;
              return (
                <Line
                  key={p.kind}
                  type="monotone"
                  dataKey={p.kind}
                  stroke={stroke}
                  strokeWidth={p.kind === "base" ? 2 : 1.8}
                  strokeDasharray={p.kind === "bear" ? "5 3" : p.kind === "bull" ? undefined : "7 3"}
                  dot={{ r: 3, fill: stroke, strokeWidth: 0 }}
                  activeDot={{ r: 4.5, fill: stroke, strokeWidth: 2, stroke: "#fff" }}
                  isAnimationActive={false}
                  name={`${p.name} ${prob}%`}
                />
              );
            })}

            {/* Spot marker */}
            <ReferenceDot
              x={chartData[0]?.label}
              y={horizon.spot}
              r={5}
              fill={COLORS.amber}
              stroke="#000"
              strokeWidth={1.5}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Full model view ──────────────────────────────────────────────────────────

function ModelView({ horizon, session }: { horizon: ModelHorizon; session: "live" | "last-close" }) {
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
              <ModelChart horizon={horizon} />
              <ScenarioLegend horizon={horizon} />
            </div>
          </div>
        </div>

        {/* Right rail */}
        <RightRail horizon={horizon} />
      </div>

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
    refetchInterval: 5 * 60_000,
    staleTime: 4 * 60_000,
  });

  const active = data?.horizons[horizon];

  return (
    <div className="space-y-3" data-testid="models-panel">
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
          {(["daily", "weekly", "monthly"] as Horizon[]).map((h) => (
            <Button
              key={h}
              variant={horizon === h ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2.5 text-[10px] uppercase tracking-wider"
              onClick={() => setHorizon(h)}
              data-testid={`btn-horizon-${h}`}
            >
              {h}
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
          >
            {data.session === "live" ? "● LIVE" : "◌ LAST SESSION"}
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
          <ModelView horizon={active} session={data!.session} />
        </ErrorBoundary>
      )}

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
