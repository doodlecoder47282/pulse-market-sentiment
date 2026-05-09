/**
 * Reusable AI brief card for Edge Lab sub-panels.
 * Hits /api/edgelab/brief?panel=<name>[&symbol=X], renders a peer-trader brief.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sparkles, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";

export interface EdgeBriefData {
  verdict: string;
  verdictColor: "emerald" | "rose" | "amber" | "neutral";
  edgeType: "informational" | "analytical" | "behavioral" | "timing" | "environmental" | "none";
  confidence: number;
  summary: string;
  baseCase: { thesis: string; prob: number };
  bullCase: { thesis: string; prob: number };
  bearCase: { thesis: string; prob: number };
  actionable: string;
  invalidation: string;
  counterargument: string;
  bullets: string[];
  panel: string;
  asOf: number;
  source: "claude" | "openai" | "deterministic";
}

interface Props {
  panel: "clv" | "iv-rv" | "gamma-curve" | "cross-asset" | "skew" | "macro-flow" | "anomaly" | "backtest" | "edge-synthesis";
  symbol?: string;
  /** when true, brief is fetched on demand only (button click). useful for backtest. */
  manual?: boolean;
  /** extra payload for POST (used by backtest with last run results) */
  extra?: any;
  /** human-readable label for header. defaults to "what this means" */
  title?: string;
}

const verdictClass = (c: string) => {
  switch (c) {
    case "emerald": return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "rose": return "bg-rose-500/15 text-rose-400 border-rose-500/30";
    case "amber": return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    default: return "bg-muted text-muted-foreground border-border";
  }
};

const edgeBadgeClass = (t: string) => {
  switch (t) {
    case "informational": return "bg-cyan-500/15 text-cyan-400 border-cyan-500/30";
    case "analytical": return "bg-indigo-500/15 text-indigo-400 border-indigo-500/30";
    case "behavioral": return "bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/30";
    case "timing": return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "environmental": return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    default: return "bg-muted text-muted-foreground border-border";
  }
};

export default function EdgeBrief({ panel, symbol, manual = false, extra, title = "what this means" }: Props) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(!manual);

  const q = useQuery<EdgeBriefData>({
    queryKey: ["/api/edgelab/brief", panel, symbol ?? "_", JSON.stringify(extra ?? null)],
    queryFn: async () => {
      const useBody = !!extra;
      const res = useBody
        ? await apiRequest("POST", "/api/edgelab/brief", { panel, symbol, extra })
        : await apiRequest("GET", `/api/edgelab/brief?panel=${panel}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ""}`);
      return res.json();
    },
    enabled,
    staleTime: 60_000 * 3,
    refetchInterval: false,
  });

  const d = q.data;

  return (
    <div
      className="rounded-lg border border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 via-transparent to-cyan-500/5 p-3"
      data-testid={`edge-brief-${panel}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
          <span className="text-xs font-semibold uppercase tracking-wide text-emerald-300/90">{title}</span>
          {d && (
            <>
              <Badge variant="outline" className={`text-[10px] py-0 px-1.5 h-4 ${verdictClass(d.verdictColor)}`} data-testid={`badge-verdict-${panel}`}>
                {d.verdict}
              </Badge>
              <Badge variant="outline" className={`text-[10px] py-0 px-1.5 h-4 ${edgeBadgeClass(d.edgeType)}`}>
                {d.edgeType}
              </Badge>
              <span className="text-[10px] text-muted-foreground">{d.confidence}% conf</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!enabled && manual && (
            <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => setEnabled(true)}>
              generate brief
            </Button>
          )}
          {enabled && (
            <button
              onClick={() => q.refetch()}
              disabled={q.isFetching}
              className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
              title="regenerate"
              data-testid={`button-brief-refresh-${panel}`}
            >
              <RefreshCw className={`h-3 w-3 ${q.isFetching ? "animate-spin" : ""}`} />
            </button>
          )}
          <button
            onClick={() => setOpen(o => !o)}
            className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
            title={open ? "collapse" : "expand"}
            data-testid={`button-brief-toggle-${panel}`}
          >
            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          {!enabled && manual && (
            <p className="text-xs text-muted-foreground">click "generate brief" to get an AI read on the last backtest run.</p>
          )}
          {enabled && q.isLoading && (
            <p className="text-xs text-muted-foreground italic">reading the data…</p>
          )}
          {enabled && q.isError && (
            <p className="text-xs text-rose-400">brief unavailable: {(q.error as any)?.message ?? "unknown"}</p>
          )}
          {d && (
            <>
              <p className="text-xs leading-relaxed text-foreground/95" data-testid={`text-brief-summary-${panel}`}>
                {d.summary}
              </p>

              <div className="rounded border border-border/40 bg-background/40 p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">actionable</div>
                <p className="text-xs leading-snug">{d.actionable}</p>
              </div>

              {d.bullets.length > 0 && (
                <ul className="text-xs space-y-0.5">
                  {d.bullets.map((b, i) => (
                    <li key={i} className="flex gap-1.5 leading-snug">
                      <span className="text-emerald-500/70 mt-0.5">·</span>
                      <span className="text-foreground/90">{b}</span>
                    </li>
                  ))}
                </ul>
              )}

              <button
                onClick={() => setExpanded(e => !e)}
                className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                data-testid={`button-brief-expand-${panel}`}
              >
                {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {expanded ? "hide breakdown" : "base / bull / bear breakdown"}
              </button>

              {expanded && (
                <div className="space-y-2 pt-1 border-t border-border/40">
                  <CaseRow label="base" tone="amber" thesis={d.baseCase.thesis} prob={d.baseCase.prob} />
                  <CaseRow label="bull" tone="emerald" thesis={d.bullCase.thesis} prob={d.bullCase.prob} />
                  <CaseRow label="bear" tone="rose" thesis={d.bearCase.thesis} prob={d.bearCase.prob} />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
                    <div className="rounded border border-border/40 bg-background/40 p-2">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">invalidation</div>
                      <p className="text-xs leading-snug">{d.invalidation}</p>
                    </div>
                    <div className="rounded border border-border/40 bg-background/40 p-2">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">counterargument</div>
                      <p className="text-xs leading-snug">{d.counterargument}</p>
                    </div>
                  </div>

                  <div className="text-[10px] text-muted-foreground/70 pt-1">
                    source: {d.source} · {new Date(d.asOf).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CaseRow({ label, tone, thesis, prob }: { label: string; tone: "emerald" | "rose" | "amber"; thesis: string; prob: number }) {
  const color = tone === "emerald" ? "text-emerald-400 border-emerald-500/30" : tone === "rose" ? "text-rose-400 border-rose-500/30" : "text-amber-400 border-amber-500/30";
  const barColor = tone === "emerald" ? "bg-emerald-500/40" : tone === "rose" ? "bg-rose-500/40" : "bg-amber-500/40";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className={`font-mono uppercase font-semibold ${color}`}>{label}</span>
        <span className="font-mono text-muted-foreground">{prob}%</span>
      </div>
      <div className="h-1 rounded bg-muted/30 overflow-hidden">
        <div className={`h-full ${barColor}`} style={{ width: `${Math.max(0, Math.min(100, prob))}%` }} />
      </div>
      <p className="text-xs leading-snug text-foreground/90">{thesis}</p>
    </div>
  );
}
