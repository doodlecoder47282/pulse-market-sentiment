/**
 * TrackedSignalsPanel — shows all manually-tracked signals, grouped by ticker.
 *
 * Toggleable filters: source (flow-alert / unusual-flow / whale / manual / all)
 * and status (open / closed / all). Each row shows entry/live mark, %change,
 * peak, and a stop-tracking button.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import TrackButton from "./TrackButton";

interface TrackedSignal {
  id: string;
  source: "flow-alert" | "unusual-flow" | "whale" | "manual";
  symbol: string;
  type?: "C" | "P";
  strike?: number;
  expiration?: string;
  side?: "BULLISH" | "BEARISH" | "NEUTRAL";
  label?: string;
  entry: { at: number; mark?: number | null; premium?: number | null; spot?: number | null; note?: string };
  live?: { mark?: number | null; pctChange?: number | null; peakMark?: number | null; peakPctChange?: number | null; asOf: number };
  status: "OPEN" | "CLOSED" | "EXPIRED";
  statusAt: number;
  meta?: Record<string, any>;
}

interface TrackedGroup {
  symbol: string;
  count: number;
  open: number;
  closed: number;
  items: TrackedSignal[];
}

interface TrackedResponse {
  asOf: number;
  groups: TrackedGroup[];
  total: number;
  open: number;
  closed: number;
}

const SOURCE_LABELS: Record<string, string> = {
  "flow-alert": "Flow Alert",
  "unusual-flow": "UOA",
  whale: "Whale",
  manual: "Manual",
};

const SOURCE_COLOR: Record<string, string> = {
  "flow-alert": "border-violet-500/40 bg-violet-500/10 text-violet-400",
  "unusual-flow": "border-amber-500/40 bg-amber-500/10 text-amber-400",
  whale: "border-cyan-500/40 bg-cyan-500/10 text-cyan-400",
  manual: "border-muted-foreground/40 bg-muted/30 text-muted-foreground",
};

function fmtPct(p?: number | null): string {
  if (p == null || !isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

function pctColor(p?: number | null): string {
  if (p == null) return "text-muted-foreground";
  if (p > 0) return "text-emerald-400";
  if (p < 0) return "text-rose-400";
  return "text-muted-foreground";
}

function statusBadgeClass(status: string): string {
  if (status === "OPEN") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-400";
  if (status === "CLOSED") return "border-muted-foreground/40 bg-muted/30 text-muted-foreground";
  if (status === "EXPIRED") return "border-rose-500/40 bg-rose-500/10 text-rose-400";
  return "border-muted-foreground/40 bg-muted/30 text-muted-foreground";
}

function TrackedRow({ sig }: { sig: TrackedSignal }) {
  const liveMark = sig.live?.mark ?? null;
  const entryMark = sig.entry?.mark ?? null;
  const pct = sig.live?.pctChange ?? null;
  const peakPct = sig.live?.peakPctChange ?? null;
  const isOpen = sig.status === "OPEN";

  return (
    <div className="rounded-md border border-border/30 bg-card/40 px-3 py-2 text-xs space-y-1" data-testid={`tracked-row-${sig.id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className={`text-[9px] py-0 px-1.5 h-4 ${SOURCE_COLOR[sig.source]}`}>
          {SOURCE_LABELS[sig.source]}
        </Badge>
        {sig.type && sig.strike != null && (
          <span className="font-mono text-muted-foreground">
            ${sig.strike.toFixed(0)} {sig.type === "C" ? "Call" : "Put"} · {sig.expiration ?? "—"}
          </span>
        )}
        {sig.side && (
          <span className={`font-semibold text-[10px] uppercase tracking-wider ${
            sig.side === "BULLISH" ? "text-emerald-400" : sig.side === "BEARISH" ? "text-rose-400" : "text-muted-foreground"
          }`}>
            {sig.side}
          </span>
        )}
        <Badge variant="outline" className={`text-[9px] py-0 px-1.5 h-4 ml-auto ${statusBadgeClass(sig.status)}`}>
          {sig.status}
        </Badge>
        {isOpen && (
          <TrackButton
            source={sig.source}
            symbol={sig.symbol}
            type={sig.type}
            strike={sig.strike}
            expiration={sig.expiration}
            isTracked={true}
            trackedId={sig.id}
            size="sm"
          />
        )}
      </div>
      <div className="flex items-center gap-3 text-[11px] flex-wrap">
        {entryMark != null && (
          <span className="text-muted-foreground">entry ${entryMark.toFixed(2)}</span>
        )}
        {liveMark != null && (
          <span className="font-mono">mark ${liveMark.toFixed(2)}</span>
        )}
        {pct != null && (
          <span className={pctColor(pct)}>{fmtPct(pct)}</span>
        )}
        {peakPct != null && peakPct > 0 && (
          <span className="text-emerald-400/70">peak +{(peakPct * 100).toFixed(1)}%</span>
        )}
        {sig.entry?.note && (
          <span className="text-muted-foreground italic">· {sig.entry.note}</span>
        )}
      </div>
    </div>
  );
}

function GroupCard({ group, defaultOpen }: { group: TrackedGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border border-border/40 bg-card/30" data-testid={`tracked-group-${group.symbol}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-card/50"
        data-testid={`tracked-toggle-${group.symbol}`}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className="font-bold text-base text-foreground">{group.symbol}</span>
        <Badge variant="outline" className="text-[9px] border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
          {group.open} open
        </Badge>
        {group.closed > 0 && (
          <Badge variant="outline" className="text-[9px] border-muted-foreground/40 bg-muted/30 text-muted-foreground">
            {group.closed} closed
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">{group.count} total</span>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2 pt-1">
          {group.items.map((s) => <TrackedRow key={s.id} sig={s} />)}
        </div>
      )}
    </div>
  );
}

export default function TrackedSignalsPanel() {
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("OPEN");

  const params = new URLSearchParams();
  if (sourceFilter !== "all") params.set("source", sourceFilter);
  if (statusFilter !== "all") params.set("status", statusFilter);
  const qs = params.toString();
  const url = `/api/signals/tracked${qs ? "?" + qs : ""}`;

  const q = useQuery<TrackedResponse>({
    queryKey: ["/api/signals/tracked", sourceFilter, statusFilter],
    queryFn: async () => {
      const r = await apiRequest("GET", url);
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const data = q.data;
  const groups = data?.groups ?? [];

  return (
    <Card data-testid="tracked-signals-panel">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold tracking-tight">Tracked Signals · grouped per ticker</CardTitle>
          <Badge variant="outline" className="text-[10px]">
            {data?.open ?? 0} open · {data?.closed ?? 0} closed
          </Badge>
        </div>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">source</span>
          {(["all", "flow-alert", "unusual-flow", "whale", "manual"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSourceFilter(s)}
              className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
                sourceFilter === s
                  ? "border-foreground/60 bg-foreground/10 text-foreground"
                  : "border-border bg-transparent text-muted-foreground hover:bg-card/50"
              }`}
              data-testid={`tracked-filter-source-${s}`}
            >
              {s === "all" ? "all" : SOURCE_LABELS[s]}
            </button>
          ))}
          <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">status</span>
          {(["OPEN", "CLOSED", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
                statusFilter === s
                  ? "border-foreground/60 bg-foreground/10 text-foreground"
                  : "border-border bg-transparent text-muted-foreground hover:bg-card/50"
              }`}
              data-testid={`tracked-filter-status-${s}`}
            >
              {s === "all" ? "all" : s.toLowerCase()}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {q.isLoading && <div className="text-xs text-muted-foreground">loading…</div>}
        {!q.isLoading && groups.length === 0 && (
          <div className="rounded-md border border-dashed border-border/40 p-4 text-center text-xs text-muted-foreground">
            no tracked signals yet. hit the <span className="text-emerald-400 font-mono">track</span> button on any flow alert, unusual activity, or whale hit to start tracking.
          </div>
        )}
        {groups.map((g, i) => <GroupCard key={g.symbol} group={g} defaultOpen={i < 3} />)}
      </CardContent>
    </Card>
  );
}
