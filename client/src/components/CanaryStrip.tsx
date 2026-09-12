import EdgeInfo from "@/components/EdgeInfo";
/**
 * CanaryStrip.tsx — commodity / cross-asset canary panel (Regime tab).
 *
 * Divergence detector, not a direction signal: each canary's daily move is
 * z-scored against its own 20d vol and signed into risk-off pressure. The panel
 * highlights canaries signaling risk-off while SPX is flat-to-up — the case the
 * equity tape can't show you. Server alerts to Discord on divergence/alarm.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface CanaryRow {
  id: string; label: string;
  value: number | null; d1Pct: number | null;
  z: number | null; riskOffZ: number | null;
  status: "quiet" | "watch" | "risk_off" | "risk_on" | "no_data";
  diverging: boolean; weight: number; note: string;
}
interface CanarySnapshot {
  asOf: string; marketSession: boolean;
  spy: { d1Pct: number | null; z: number | null };
  composite: number | null;
  read: "confirming_risk_on" | "quiet" | "canaries_chirping" | "divergence" | "alarm" | "no_data";
  headline: string;
  canaries: CanaryRow[];
}

const READ_STYLE: Record<CanarySnapshot["read"], { label: string; cls: string }> = {
  alarm: { label: "ALARM", cls: "border-red-500/60 text-red-400 bg-red-500/10" },
  divergence: { label: "DIVERGENCE", cls: "border-amber-500/50 text-amber-400 bg-amber-500/10" },
  canaries_chirping: { label: "CHIRPING", cls: "border-amber-500/30 text-amber-300" },
  confirming_risk_on: { label: "RISK-ON CONFIRMED", cls: "border-lime-500/40 text-lime-400" },
  quiet: { label: "QUIET", cls: "border-border text-muted-foreground" },
  no_data: { label: "NO DATA", cls: "border-border text-muted-foreground" },
};

const STATUS_DOT: Record<CanaryRow["status"], string> = {
  risk_off: "#ff4d52",
  risk_on: "#7cf04b",
  watch: "#fbbf24",
  quiet: "#475569",
  no_data: "#334155",
};

export default function CanaryStrip() {
  const { data, isLoading, isError } = useQuery<CanarySnapshot>({
    queryKey: ["/api/canary"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/canary");
      return r.json();
    },
    refetchInterval: 120_000,
  });

  if (isLoading) {
    return (
      <div className="rounded border border-border bg-card/40 p-3 animate-pulse" data-testid="canary-loading">
        <div className="h-4 w-48 bg-muted rounded mb-2" />
        <div className="h-24 bg-muted/40 rounded" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded border border-border bg-card/40 p-3 text-xs font-mono text-muted-foreground" data-testid="canary-error">
        CANARY — snapshot unavailable
      </div>
    );
  }

  const rs = READ_STYLE[data.read];

  return (
    <div className="rounded border border-border bg-card/40 p-3" data-testid="canary-panel">
      <div className="flex flex-wrap items-center gap-2 mb-1.5">
        <span className="text-[11px] font-mono font-bold uppercase tracking-widest text-amber-300">Canary</span>
        <EdgeInfo id="canary" className="h-6 w-6" />
        <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">cross-asset divergence · z vs own 20d vol</span>
        <span className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${rs.cls}`} data-testid="canary-read">
          {rs.label}
        </span>
        <span className="ml-auto text-[9px] font-mono text-muted-foreground" data-testid="canary-composite">
          composite {data.composite != null ? (data.composite > 0 ? "+" : "") + data.composite : "—"}σ
          {" · "}SPY {data.spy.d1Pct != null ? (data.spy.d1Pct > 0 ? "+" : "") + data.spy.d1Pct + "%" : "—"}
          {!data.marketSession && " · off-session"}
        </span>
      </div>

      <div className="text-[10px] font-mono text-foreground/90 mb-2" data-testid="canary-headline">
        {data.headline}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1">
        {data.canaries.map((c) => {
          const mag = c.riskOffZ != null ? Math.min(Math.abs(c.riskOffZ) / 2.5, 1) : 0;
          const off = (c.riskOffZ ?? 0) > 0;
          return (
            <div
              key={c.id}
              className={`flex items-center gap-2 text-[9px] font-mono py-1 px-1.5 rounded border ${c.diverging ? "border-amber-500/50 bg-amber-500/5" : "border-transparent"}`}
              title={c.note}
              data-testid={`canary-${c.id}`}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STATUS_DOT[c.status] }} />
              <span className="w-32 shrink-0 truncate text-foreground">{c.label}</span>
              <span className="w-14 shrink-0 tabular-nums text-muted-foreground">{c.value ?? "—"}</span>
              <span className={`w-12 shrink-0 tabular-nums ${c.d1Pct == null ? "text-muted-foreground" : c.d1Pct >= 0 ? "text-lime-400" : "text-red-400"}`}>
                {c.d1Pct != null ? (c.d1Pct > 0 ? "+" : "") + c.d1Pct + "%" : "—"}
              </span>
              {/* risk-off pressure bar: center-anchored, red right = risk-off, green left = risk-on */}
              <span className="flex-1 h-1.5 rounded-sm bg-muted/40 relative overflow-hidden min-w-[40px]">
                <span className="absolute left-1/2 top-0 bottom-0 w-px bg-border" />
                <span
                  className="absolute top-0 bottom-0 rounded-sm"
                  style={off
                    ? { left: "50%", width: `${mag * 50}%`, background: "#ff4d52" }
                    : { right: "50%", width: `${mag * 50}%`, background: "#7cf04b" }}
                />
              </span>
              <span className={`w-12 shrink-0 text-right tabular-nums ${c.diverging ? "text-amber-400 font-bold" : "text-muted-foreground"}`} data-testid={`canary-z-${c.id}`}>
                {c.riskOffZ != null ? (c.riskOffZ > 0 ? "+" : "") + c.riskOffZ + "σ" : "—"}
              </span>
              {c.diverging && <span className="shrink-0 text-[8px] uppercase text-amber-400 font-bold">div</span>}
            </div>
          );
        })}
      </div>

      <div className="mt-1.5 text-[8px] font-mono text-muted-foreground leading-relaxed">
        risk-off σ = today's move / own 20d vol, signed (AUDJPY·Cu/Au·crude·credit down = off, DXY·gold up = off, crude +2σ spike = inflation shock) · div = canary risk-off while SPY flat/up · alerts to Discord on divergence/alarm, 5min cadence RTH, 4h refire cap · confirmation, not entry — ETF proxies, RTH only
      </div>
    </div>
  );
}
