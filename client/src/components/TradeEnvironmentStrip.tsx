/**
 * TradeEnvironmentStrip — the fused "should I be trading right now" banner.
 * Renders directly under the regime headline on every tab. Collapsed: state
 * chip + convexity index + one-liner. Tap to expand the seven drivers and
 * concrete instructions.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp } from "lucide-react";
import EdgeInfo from "@/components/EdgeInfo";

type EnvDriver = {
  key: string;
  label: string;
  points: number;
  max: number;
  note: string;
};

type TradeEnv = {
  state: "STAND_DOWN" | "CHOP" | "NORMAL" | "LOADED" | "STRIKE";
  score: number;
  headline: string;
  instructions: string[];
  drivers: EnvDriver[];
  session: string;
  asOf: number;
  degraded: boolean;
};

const STATE_STYLE: Record<TradeEnv["state"], { chip: string; bar: string; label: string }> = {
  STAND_DOWN: { chip: "bg-slate-800 text-slate-400 border-slate-700", bar: "bg-slate-600", label: "STAND DOWN" },
  CHOP:       { chip: "bg-amber-950/60 text-amber-400 border-amber-900", bar: "bg-amber-500", label: "CHOP" },
  NORMAL:     { chip: "bg-sky-950/60 text-sky-400 border-sky-900", bar: "bg-sky-500", label: "NORMAL" },
  LOADED:     { chip: "bg-orange-950/60 text-orange-400 border-orange-800", bar: "bg-orange-500", label: "LOADED" },
  STRIKE:     { chip: "bg-rose-950/70 text-rose-300 border-rose-800 animate-pulse", bar: "bg-rose-500", label: "STRIKE" },
};

export default function TradeEnvironmentStrip() {
  const [open, setOpen] = useState(false);
  const { data } = useQuery<TradeEnv>({
    queryKey: ["/api/trade-environment"],
    refetchInterval: 60_000,
  });

  if (!data) return null;
  const st = STATE_STYLE[data.state] ?? STATE_STYLE.NORMAL;

  return (
    <div
      className="border-b border-border/60 bg-background/60"
      data-testid="trade-environment-strip"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="trade-environment-toggle"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left sm:gap-3 sm:px-4"
      >
        <span
          className={`shrink-0 rounded border px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest ${st.chip}`}
          data-testid="trade-environment-state"
        >
          {st.label}
        </span>
        <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-800">
            <span className={`block h-full ${st.bar}`} style={{ width: `${data.score}%` }} />
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">{data.score}</span>
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground sm:text-xs">
          {data.headline}
        </span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="border-t border-border/40 px-3 pb-3 pt-2 sm:px-4" data-testid="trade-environment-detail">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              convexity index {data.score}/100
            </span>
            <EdgeInfo id="trade-environment" />
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {data.drivers.map((d) => (
              <div
                key={d.key}
                className="rounded-md border border-border/50 bg-card/50 px-2.5 py-1.5"
                data-testid={`trade-env-driver-${d.key}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">{d.label}</span>
                  <span className={`font-mono text-[10px] ${d.points > 0 ? "text-orange-400" : "text-slate-600"}`}>
                    +{d.points}/{d.max}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-300">{d.note}</p>
              </div>
            ))}
          </div>
          <div className="mt-2 space-y-1">
            {data.instructions.map((line, i) => (
              <p key={i} className="text-[11px] leading-snug text-slate-300">
                <span className="mr-1.5 font-mono text-[10px] text-muted-foreground">{i + 1}.</span>
                {line}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
