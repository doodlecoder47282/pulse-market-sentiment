/**
 * TradeEnvironmentStrip — the fused "should I be trading right now" banner.
 * Renders directly under the regime headline on every tab. Collapsed: state
 * chip + convexity index + one-liner. Tap to expand the seven drivers and
 * context notes. The index is a heuristic composite (hand-set points), not a
 * forecast, and gives no entry or size.
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
  dataState?: "ok" | "unavailable";
};

type TradeEnv = {
  state: "STAND_DOWN" | "CHOP" | "NORMAL" | "LOADED" | "STRIKE" | "PARTIAL" | "UNAVAILABLE";
  score: number;
  headline: string;
  instructions: string[];
  drivers: EnvDriver[];
  session: string;
  asOf: number;
  degraded: boolean;
  label?: string;
  calibration?: { status: string; sessions: number; windows: number; minSessions: number; minWindows: number; note: string };
};

const STATE_STYLE: Record<TradeEnv["state"], { chip: string; bar: string; label: string }> = {
  STAND_DOWN: { chip: "bg-slate-800 text-slate-400 border-slate-700", bar: "bg-slate-600", label: "STAND DOWN" },
  CHOP:       { chip: "bg-amber-950/60 text-amber-400 border-amber-900", bar: "bg-amber-500", label: "CHOP" },
  NORMAL:     { chip: "bg-sky-950/60 text-sky-400 border-sky-900", bar: "bg-sky-500", label: "NORMAL" },
  LOADED:     { chip: "bg-orange-950/60 text-orange-400 border-orange-800", bar: "bg-orange-500", label: "LOADED" },
  STRIKE:     { chip: "bg-rose-950/70 text-rose-300 border-rose-800 animate-pulse", bar: "bg-rose-500", label: "STRIKE" },
  PARTIAL:    { chip: "bg-slate-900 text-amber-300 border-amber-700 border-dashed", bar: "bg-amber-700", label: "PARTIAL" },
  UNAVAILABLE: { chip: "bg-slate-900 text-slate-500 border-slate-700 border-dashed", bar: "bg-slate-700", label: "UNAVAILABLE" },
};

// What each state asserts (server/tradeEnvState.ts). STRIKE needs short
// gamma, expanding range and directional tick volume all observed; a high
// index without them is LOADED.
const STATE_MEANING: Record<TradeEnv["state"], string> = {
  STAND_DOWN: "few drivers active",
  CHOP: "long gamma, quiet tick volume, calm vol curve",
  NORMAL: "no unusual combination of drivers",
  LOADED: "index 45+ (or 70+ without all three STRIKE conditions)",
  STRIKE: "index 70+ AND short gamma, expanding range and directional tick volume all observed",
  PARTIAL: "a core driver is unavailable: index is a lower bound, no quiet state claimed",
  UNAVAILABLE: "gamma, vol term structure and range all unavailable",
};

export default function TradeEnvironmentStrip() {
  const [open, setOpen] = useState(false);
  const { data } = useQuery<TradeEnv>({
    queryKey: ["/api/trade-environment"],
    refetchInterval: 60_000,
  });

  if (!data) return null;
  const st = STATE_STYLE[data.state] ?? STATE_STYLE.UNAVAILABLE;

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
          className={`shrink-0 rounded border px-2 py-0.5 font-mono text-[11px] font-bold tracking-widest ${st.chip}`}
          data-testid="trade-environment-state"
          title={STATE_MEANING[data.state as TradeEnv["state"]] ?? ""}
        >
          {st.label}
        </span>
        <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-800">
            <span className={`block h-full ${st.bar}`} style={{ width: `${data.score}%` }} />
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">{data.score}{data.degraded ? "+" : ""}</span>
        </span>
        {data.degraded && (
          <span
            className="shrink-0 rounded border border-amber-700 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-amber-400"
            title="some drivers are unavailable and score 0: the index is a lower bound"
            data-testid="trade-environment-degraded"
          >
            degraded
          </span>
        )}
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
            <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              heuristic convexity index {data.score}/100
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
                  <span className="font-mono text-[11px] uppercase tracking-wider text-slate-400">{d.label}</span>
                  <span className={`font-mono text-[11px] ${d.dataState === "unavailable" ? "text-amber-500" : d.points > 0 ? "text-orange-400" : "text-slate-400"}`}>
                    {d.dataState === "unavailable" ? "n/a" : `+${d.points}/${d.max}`}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-300">{d.note}</p>
              </div>
            ))}
          </div>
          {data.label && (
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground" data-testid="trade-env-label">
              {data.label}
              {data.calibration ? ` · fit to forward range: ${data.calibration.status} (${data.calibration.sessions}/${data.calibration.minSessions} sessions, ${data.calibration.windows}/${data.calibration.minWindows} windows)` : ""}
            </p>
          )}
          <div className="mt-2 space-y-1">
            {data.instructions.map((line, i) => (
              <p key={i} className="text-[11px] leading-snug text-slate-300">
                <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{i + 1}.</span>
                {line}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
