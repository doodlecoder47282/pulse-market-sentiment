// VolCalendarPanel.tsx
// Volatility event calendar — upcoming OPEX, VIX exp, quad witching, FOMC, CPI, NFP.
// Grouped by THIS WEEK / NEXT WEEK / LATER with filter pills and importance dots.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Calendar, Zap, TrendingUp, BarChart2, Database, Activity, AlertTriangle,
} from "lucide-react";

type EventType = "monthly_opex" | "vix_exp" | "quad_witching" | "fomc" | "cpi" | "nfp";
type Importance = "high" | "medium" | "low";
type Filter = "all" | "opex" | "vix" | "fomc" | "data";

interface VolEvent {
  date: string;
  type: EventType;
  label: string;
  daysAway: number;
  importance: Importance;
}

interface VolCalendarResponse {
  events: VolEvent[];
  asOf: string;
}

const TYPE_ICON: Record<EventType, React.ReactNode> = {
  monthly_opex:  <BarChart2 className="h-3.5 w-3.5" />,
  vix_exp:       <Activity className="h-3.5 w-3.5" />,
  quad_witching: <Zap className="h-3.5 w-3.5" />,
  fomc:          <Database className="h-3.5 w-3.5" />,
  cpi:           <TrendingUp className="h-3.5 w-3.5" />,
  nfp:           <TrendingUp className="h-3.5 w-3.5" />,
};

const TYPE_COLOR: Record<EventType, string> = {
  monthly_opex:  "text-cyan-400",
  vix_exp:       "text-violet-400",
  quad_witching: "text-amber-400",
  fomc:          "text-rose-400",
  cpi:           "text-blue-400",
  nfp:           "text-emerald-400",
};

const IMPORTANCE_DOT: Record<Importance, string> = {
  high:   "bg-rose-500",
  medium: "bg-amber-400",
  low:    "bg-emerald-500",
};

const FILTER_LABELS: Array<{ id: Filter; label: string }> = [
  { id: "all",  label: "All" },
  { id: "opex", label: "OPEX" },
  { id: "vix",  label: "VIX" },
  { id: "fomc", label: "Fed" },
  { id: "data", label: "Data" },
];

function matchFilter(type: EventType, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "opex") return type === "monthly_opex" || type === "quad_witching";
  if (filter === "vix")  return type === "vix_exp";
  if (filter === "fomc") return type === "fomc";
  if (filter === "data") return type === "cpi" || type === "nfp";
  return true;
}

function getDayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

function getGroup(daysAway: number): "THIS WEEK" | "NEXT WEEK" | "LATER" {
  if (daysAway <= 7) return "THIS WEEK";
  if (daysAway <= 14) return "NEXT WEEK";
  return "LATER";
}

export default function VolCalendarPanel() {
  const [filter, setFilter] = useState<Filter>("all");

  const { data, isLoading, isError } = useQuery<VolCalendarResponse>({
    queryKey: ["/api/vol-calendar"],
    queryFn: async () => apiRequest("GET", "/api/vol-calendar").then((r) => r.json()),
    refetchInterval: 60 * 60_000, // 1hr
    staleTime: 30 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        <div className="flex gap-1.5">
          {FILTER_LABELS.map((f) => <Skeleton key={f.id} className="h-6 w-14 rounded-full" />)}
        </div>
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-400 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Vol calendar unavailable.
      </div>
    );
  }

  const filtered = data.events.filter((ev) => matchFilter(ev.type, filter));

  // Group into THIS WEEK / NEXT WEEK / LATER
  const groups: Array<{ label: "THIS WEEK" | "NEXT WEEK" | "LATER"; events: VolEvent[] }> = [
    { label: "THIS WEEK", events: filtered.filter((ev) => getGroup(ev.daysAway) === "THIS WEEK") },
    { label: "NEXT WEEK", events: filtered.filter((ev) => getGroup(ev.daysAway) === "NEXT WEEK") },
    { label: "LATER",     events: filtered.filter((ev) => getGroup(ev.daysAway) === "LATER") },
  ].filter((g) => g.events.length > 0);

  const groupBg: Record<string, string> = {
    "THIS WEEK": "bg-amber-500/10 border-amber-500/20",
    "NEXT WEEK": "bg-card/60 border-border/40",
    "LATER":     "bg-card/30 border-border/30",
  };
  const groupLabel: Record<string, string> = {
    "THIS WEEK": "text-amber-400",
    "NEXT WEEK": "text-muted-foreground",
    "LATER":     "text-muted-foreground/60",
  };

  return (
    <div className="space-y-3" data-testid="vol-calendar-panel">
      {/* Filter pills */}
      <div className="flex flex-wrap gap-1.5" data-testid="vol-calendar-filters">
        {FILTER_LABELS.map((f) => (
          <button
            key={f.id}
            data-testid={`filter-${f.id}`}
            onClick={() => setFilter(f.id)}
            className={[
              "rounded-full border px-2.5 py-0.5 text-xs font-semibold transition",
              filter === f.id
                ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-300"
                : "border-border/50 text-muted-foreground hover:border-cyan-500/30 hover:text-cyan-200",
            ].join(" ")}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground self-center">
          {filtered.length} events · 90d window
        </span>
      </div>

      {/* Event groups */}
      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
          No events in the next 90 days for this filter.
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.label}>
              <div className={`mb-1 text-[10px] font-bold uppercase tracking-widest ${groupLabel[group.label]}`}>
                {group.label}
              </div>
              <div className={`rounded-lg border ${groupBg[group.label]} overflow-hidden`}>
                {group.events.map((ev, i) => {
                  const icon = TYPE_ICON[ev.type];
                  const color = TYPE_COLOR[ev.type];
                  const dot = IMPORTANCE_DOT[ev.importance];
                  const dow = getDayOfWeek(ev.date);
                  const isLast = i === group.events.length - 1;

                  return (
                    <div
                      key={`${ev.date}-${ev.type}`}
                      data-testid={`vol-event-${ev.type}-${ev.date}`}
                      className={[
                        "flex items-center gap-3 px-3 py-2 text-xs transition hover:bg-white/5",
                        !isLast ? "border-b border-border/20" : "",
                      ].join(" ")}
                    >
                      {/* Importance dot */}
                      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />

                      {/* Type icon */}
                      <span className={`shrink-0 ${color}`}>{icon}</span>

                      {/* Date + DOW */}
                      <div className="w-20 shrink-0">
                        <span className="font-mono font-semibold text-foreground">
                          {ev.date.slice(5)} {/* MM-DD */}
                        </span>
                        <span className="ml-1.5 text-[10px] text-muted-foreground">{dow}</span>
                      </div>

                      {/* Label */}
                      <div className="flex-1 font-medium text-foreground/90">{ev.label}</div>

                      {/* Countdown */}
                      <div className="shrink-0 text-right">
                        {ev.daysAway === 0 ? (
                          <Badge variant="outline" className="border-amber-500/60 text-amber-400 text-[9px]">TODAY</Badge>
                        ) : ev.daysAway === 1 ? (
                          <Badge variant="outline" className="border-amber-500/40 text-amber-300 text-[9px]">TOMORROW</Badge>
                        ) : (
                          <span className="text-muted-foreground text-[10px]">in {ev.daysAway}d</span>
                        )}
                      </div>

                      {/* Importance badge for high events */}
                      {ev.importance === "high" && (
                        <Badge variant="outline" className="shrink-0 border-rose-500/50 text-rose-400 text-[9px]">
                          HIGH
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
