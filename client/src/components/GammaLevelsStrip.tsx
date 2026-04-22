// GammaLevelsStrip.tsx
// Right-side vertical legend strip showing key gamma/Greek levels for SPX.
// Displays each level with name, strike, distance from SPX, and color-coded dot.
// Collapsible on mobile (horizontal scroll chip row).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Zap } from "lucide-react";

interface GammaLevelEntry {
  value: number;
  source: "computed" | "user_targets";
}

interface GammaLevelsEnhanced {
  gammaFlip: GammaLevelEntry | null;
  callWall: GammaLevelEntry;
  putWall: GammaLevelEntry;
  topGexStrikes: Array<{ strike: number; gex: number; source: "computed" }>;
  vanna: GammaLevelEntry | null;
  charm: GammaLevelEntry | null;
  vommaUpper: GammaLevelEntry | null;
  vommaLower: GammaLevelEntry | null;
  zomma: GammaLevelEntry | null;
  negGamma: GammaLevelEntry | null;
  mopex: GammaLevelEntry | null;
  weeklyTargets: {
    upside: GammaLevelEntry;
    downside: GammaLevelEntry;
    t2Up: GammaLevelEntry;
    t2Down: GammaLevelEntry;
  };
  spxNow: number;
  asOf: string;
}

interface EnhancedGammaResponse {
  symbol: string;
  supported: boolean;
  enhanced: GammaLevelsEnhanced;
  asOf: number;
}

type DotColor = "green" | "red" | "amber";

interface LevelRow {
  name: string;
  value: number | null;
  source: "computed" | "user_targets";
  dotColor: DotColor;
  section?: string;
}

const DOT_CLASS: Record<DotColor, string> = {
  green: "bg-emerald-500",
  red:   "bg-rose-500",
  amber: "bg-amber-400",
};

const SOURCE_TAG_CLASS: Record<"computed" | "user_targets", string> = {
  computed:     "text-cyan-400/60",
  user_targets: "text-violet-400/60",
};

function buildRows(e: GammaLevelsEnhanced): LevelRow[] {
  const rows: LevelRow[] = [];

  // --- Computed from chain ---
  rows.push({
    name: "GAMMA FLIP",
    value: e.gammaFlip?.value ?? null,
    source: e.gammaFlip?.source ?? "computed",
    dotColor: "amber",
    section: "Computed",
  });
  rows.push({
    name: "CALL WALL",
    value: e.callWall.value,
    source: e.callWall.source,
    dotColor: "red",
  });
  rows.push({
    name: "PUT WALL",
    value: e.putWall.value,
    source: e.putWall.source,
    dotColor: "green",
  });

  // Top GEX strikes
  e.topGexStrikes.forEach((s, i) => {
    rows.push({
      name: `GEX ${i + 1}`,
      value: s.strike,
      source: "computed",
      dotColor: s.gex >= 0 ? "red" : "green",
    });
  });

  // --- Weekly targets (user-defined) ---
  rows.push({
    name: "MOPEX",
    value: e.mopex?.value ?? null,
    source: e.mopex?.source ?? "user_targets",
    dotColor: "amber",
    section: "Targets",
  });
  rows.push({
    name: "VANNA",
    value: e.vanna?.value ?? null,
    source: e.vanna?.source ?? "user_targets",
    dotColor: "amber",
  });
  rows.push({
    name: "ZOMMA",
    value: e.zomma?.value ?? null,
    source: e.zomma?.source ?? "user_targets",
    dotColor: "amber",
  });
  rows.push({
    name: "CHARM",
    value: e.charm?.value ?? null,
    source: e.charm?.source ?? "user_targets",
    dotColor: "amber",
  });
  rows.push({
    name: "NEG \u03b3",
    value: e.negGamma?.value ?? null,
    source: e.negGamma?.source ?? "user_targets",
    dotColor: "amber",
  });
  rows.push({
    name: "UPPER VOMMA",
    value: e.vommaUpper?.value ?? null,
    source: e.vommaUpper?.source ?? "user_targets",
    dotColor: "red",
  });
  rows.push({
    name: "LOWER VOMMA",
    value: e.vommaLower?.value ?? null,
    source: e.vommaLower?.source ?? "user_targets",
    dotColor: "green",
  });
  rows.push({
    name: "UPSIDE T1",
    value: e.weeklyTargets.upside.value,
    source: e.weeklyTargets.upside.source,
    dotColor: "red",
    section: "Weekly",
  });
  rows.push({
    name: "DOWNSIDE T1",
    value: e.weeklyTargets.downside.value,
    source: e.weeklyTargets.downside.source,
    dotColor: "green",
  });
  rows.push({
    name: "T2 UP",
    value: e.weeklyTargets.t2Up.value,
    source: e.weeklyTargets.t2Up.source,
    dotColor: "red",
  });
  rows.push({
    name: "T2 DOWN",
    value: e.weeklyTargets.t2Down.value,
    source: e.weeklyTargets.t2Down.source,
    dotColor: "green",
  });

  return rows.filter((r) => r.value != null);
}

export default function GammaLevelsStrip() {
  const [expanded, setExpanded] = useState(true);

  const { data, isLoading } = useQuery<EnhancedGammaResponse>({
    queryKey: ["/api/gamma-levels-enhanced"],
    queryFn: async () =>
      apiRequest("GET", "/api/gamma-levels-enhanced?symbol=SPY").then((r) => r.json()),
    refetchInterval: 5 * 60_000, // 5min
    staleTime: 4 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-2 rounded-xl border border-border/60 bg-card/40 p-3">
        <Skeleton className="h-5 w-32" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </div>
    );
  }

  if (!data?.supported || !data?.enhanced) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/40 p-3 text-[11px] text-muted-foreground">
        Gamma levels only available for SPY/SPX.
      </div>
    );
  }

  const enhanced = data.enhanced;
  const rows = buildRows(enhanced);
  const spxNow = enhanced.spxNow;

  // Mobile: horizontal chip row (first 6 only to avoid overflow)
  const mobileRows = rows.slice(0, 8);

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 backdrop-blur" data-testid="gamma-levels-strip">
      {/* Header */}
      <button
        className="flex w-full items-center justify-between px-3 py-2.5 hover:bg-white/5 transition"
        onClick={() => setExpanded((v) => !v)}
        data-testid="gamma-levels-toggle"
      >
        <div className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Gamma Levels
          </span>
        </div>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      {/* Mobile: horizontal chips */}
      <div className="lg:hidden px-2 pb-2 overflow-x-auto">
        <div className="flex gap-1.5 min-w-max">
          {mobileRows.map((row) => {
            // Computed levels are in SPY units; user targets are in SPX units — don't mix distances
            const isSpy = row.source === "computed";
            const dist = isSpy && row.value != null ? ((row.value - spxNow) / spxNow) * 100 : null;
            return (
              <div
                key={row.name}
                className="flex shrink-0 items-center gap-1 rounded-full border border-border/50 bg-card/60 px-2 py-0.5"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[row.dotColor]}`} />
                <span className="text-[10px] text-muted-foreground">{row.name}</span>
                <span className="font-mono text-[10px] font-semibold text-foreground">
                  {row.value?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  {!isSpy && <span className="ml-0.5 text-[8px] text-muted-foreground/60">spx</span>}
                </span>
                {dist != null && (
                  <span className={`text-[9px] font-mono ${dist >= 0 ? "text-rose-400" : "text-emerald-400"}`}>
                    {dist >= 0 ? "+" : ""}{dist.toFixed(1)}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Desktop: vertical strip */}
      {expanded && (
        <div className="hidden lg:block px-2 pb-2 space-y-0.5">
          {(() => {
            let lastSection = "";
            return rows.map((row, i) => {
              // Computed levels are SPY price units; user targets are SPX units — only show % for computed
              const isSpy = row.source === "computed";
              const dist = isSpy && row.value != null ? ((row.value - spxNow) / spxNow) * 100 : null;
              const showSection = row.section && row.section !== lastSection;
              if (showSection) lastSection = row.section!;

              return (
                <div key={`${row.name}-${i}`}>
                  {showSection && (
                    <div className="mt-2 mb-1 px-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">
                      {row.section}
                    </div>
                  )}
                  <div
                    className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-white/5 transition"
                    data-testid={`gamma-level-${row.name.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[row.dotColor]}`} />
                    <span className="flex-1 text-[10px] font-medium tracking-wide text-muted-foreground truncate">
                      {row.name}
                    </span>
                    <div className="flex flex-col items-end">
                      <span className="font-mono text-[11px] font-semibold text-foreground tabular-nums">
                        {row.value?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        {!isSpy && <span className="ml-0.5 text-[8px] text-muted-foreground/50">spx</span>}
                      </span>
                      {dist != null && (
                        <span className={`text-[9px] font-mono tabular-nums ${dist >= 0 ? "text-rose-400" : "text-emerald-400"}`}>
                          {dist >= 0 ? "+" : ""}{dist.toFixed(1)}%
                        </span>
                      )}
                    </div>
                    <span className={`text-[8px] shrink-0 ${SOURCE_TAG_CLASS[row.source]}`}>
                      {row.source === "computed" ? "calc" : "tgt"}
                    </span>
                  </div>
                </div>
              );
            });
          })()}

          <div className="mt-2 px-1 text-[9px] text-muted-foreground/40 leading-tight">
            <span className={SOURCE_TAG_CLASS.computed}>calc</span> = from CBOE chain ·{" "}
            <span className={SOURCE_TAG_CLASS.user_targets}>tgt</span> = user weekly targets
          </div>
        </div>
      )}
    </div>
  );
}
