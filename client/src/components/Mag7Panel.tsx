// Mag7Panel.tsx
// Magnificent 7 indicator panel. Two variants exported:
//   - <Mag7Panel />         full card with 7 member tiles + aggregate header
//   - <Mag7Strip compact />  single-line breadth + alpha-vs-SPY indicator
// Clicking a member selects it in the chart (via TickerContext).

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useTickers } from "./TickerContext";
import { TrendingUp, TrendingDown, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type Mag7Member = {
  symbol: string;
  name: string;
  price: number | null;
  prevClose: number | null;
  changePct: number | null;
  return4w: number | null;
  spark: number[];
  rsi14: number | null;
};

type Mag7Response = {
  asOf: number;
  members: Mag7Member[];
  eqWtChange: number | null;
  spyChange: number | null;
  alphaVsSpy: number | null;
  breadth: number;
  eqWt4w: number | null;
};

function useMag7() {
  return useQuery<Mag7Response>({
    queryKey: ["/api/mag7"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/mag7");
      return r.json();
    },
    refetchInterval: 15_000,
    staleTime: 12_000,
    refetchOnWindowFocus: true,
  });
}

function Spark({ data, positive }: { data: number[]; positive: boolean | null }) {
  if (!data || data.length < 2) return null;
  const w = 72, h = 22;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(" ");
  const color = positive == null ? "#94a3b8" : positive ? "#22c55e" : "#ef4444";
  return (
    <svg width={w} height={h} className="shrink-0">
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  );
}

function formatPrice(p: number | null): string {
  if (p == null) return "—";
  if (p >= 1000) return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return p.toFixed(2);
}

function formatPct(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function rsiTag(rsi: number | null) {
  if (rsi == null) return null;
  if (rsi >= 70) return { label: "OB", color: "text-rose-400 border-rose-500/40" };
  if (rsi <= 30) return { label: "OS", color: "text-emerald-400 border-emerald-500/40" };
  return null;
}

// -------- Breadth bar (shared) --------
function BreadthBar({ breadth, count }: { breadth: number; count: number }) {
  const up = Math.round(breadth * count);
  const down = count - up;
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-muted/20">
        <div className="bg-emerald-500" style={{ width: `${breadth * 100}%` }} />
        <div className="bg-rose-500" style={{ width: `${(1 - breadth) * 100}%` }} />
      </div>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {up}↑ / {down}↓
      </span>
    </div>
  );
}

// -------- Full Panel (Chart tab) --------
export default function Mag7Panel() {
  const { data, isLoading, isError } = useMag7();
  const { setActiveChart, addTicker, watchlist } = useTickers();

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/40 p-4 backdrop-blur">
        <div className="h-24 animate-pulse rounded bg-muted/20" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/40 p-4 text-sm text-muted-foreground">
        Mag 7 feed unavailable
      </div>
    );
  }

  const eqWtUp = (data.eqWtChange ?? 0) > 0;
  const alphaUp = (data.alphaVsSpy ?? 0) > 0;
  const handleClick = (sym: string) => {
    if (!watchlist.find((w) => w.symbol === sym)) addTicker(sym, sym);
    else setActiveChart(sym);
  };

  return (
    <div
      className="rounded-xl border border-border/60 bg-gradient-to-br from-card/70 to-card/40 p-4 backdrop-blur-md"
      data-testid="mag7-panel"
    >
      {/* Header row */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-cyan-400" />
          <div className="text-sm font-semibold uppercase tracking-wider">Mag 7</div>
          <Badge variant="outline" className="border-cyan-500/40 text-[10px] text-cyan-300">
            Equal-weight basket
          </Badge>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-baseline gap-1">
            <span className="text-[10px] uppercase text-muted-foreground">Day</span>
            <span className={`font-mono text-sm font-semibold tabular-nums ${eqWtUp ? "text-emerald-400" : "text-rose-400"}`}>
              {formatPct(data.eqWtChange)}
            </span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-[10px] uppercase text-muted-foreground">vs SPY</span>
            <span className={`flex items-center gap-0.5 font-mono text-sm font-semibold tabular-nums ${alphaUp ? "text-emerald-400" : "text-rose-400"}`}>
              {alphaUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {formatPct(data.alphaVsSpy)}
            </span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-[10px] uppercase text-muted-foreground">4W</span>
            <span className={`font-mono text-sm tabular-nums ${(data.eqWt4w ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {formatPct(data.eqWt4w)}
            </span>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Breadth</span>
          <BreadthBar breadth={data.breadth} count={data.members.length} />
        </div>
      </div>

      {/* Member tiles */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7">
        {data.members.map((m) => {
          const up = (m.changePct ?? 0) > 0;
          const down = (m.changePct ?? 0) < 0;
          const accent = up
            ? "border-emerald-500/30 bg-emerald-500/5"
            : down
            ? "border-rose-500/30 bg-rose-500/5"
            : "border-border/40 bg-muted/5";
          const color = up ? "text-emerald-400" : down ? "text-rose-400" : "text-muted-foreground";
          const rsi = rsiTag(m.rsi14);
          return (
            <button
              key={m.symbol}
              onClick={() => handleClick(m.symbol)}
              className={`group rounded-lg border ${accent} p-2 text-left transition hover:border-cyan-500/50 hover:bg-cyan-500/5`}
              data-testid={`mag7-${m.symbol}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-semibold tracking-tight">{m.symbol}</span>
                {rsi && (
                  <span className={`rounded border px-1 text-[8px] font-semibold ${rsi.color}`}>
                    {rsi.label}
                  </span>
                )}
              </div>
              <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {formatPrice(m.price)}
              </div>
              <div className="mt-1 flex items-center justify-between gap-1">
                <Spark data={m.spark} positive={up} />
                <span className={`font-mono text-[11px] font-semibold tabular-nums ${color}`}>
                  {formatPct(m.changePct)}
                </span>
              </div>
              {m.return4w != null && (
                <div className="mt-0.5 text-[9px] text-muted-foreground">
                  4W <span className={m.return4w >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    {formatPct(m.return4w)}
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// -------- Compact strip (Signals tab) --------
export function Mag7Strip() {
  const { data, isLoading } = useMag7();
  if (isLoading) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-3 py-2">
        <div className="h-3.5 w-16 animate-pulse rounded bg-muted/50" />
        <div className="h-3.5 w-12 animate-pulse rounded bg-muted/50" />
        <div className="h-3.5 w-24 animate-pulse rounded bg-muted/50" />
        <div className="ml-auto flex gap-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-3.5 w-8 animate-pulse rounded bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }
  if (!data) return null;
  const eqWtUp = (data.eqWtChange ?? 0) > 0;
  const alphaUp = (data.alphaVsSpy ?? 0) > 0;

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-3 py-2 text-xs backdrop-blur"
      data-testid="mag7-strip"
    >
      <div className="flex items-center gap-1.5">
        <Users className="h-3.5 w-3.5 text-cyan-400" />
        <span className="font-semibold uppercase tracking-wider">Mag 7</span>
      </div>
      <span className={`font-mono tabular-nums ${eqWtUp ? "text-emerald-400" : "text-rose-400"}`}>
        {formatPct(data.eqWtChange)}
      </span>
      <span className="text-muted-foreground">vs SPY</span>
      <span className={`font-mono tabular-nums ${alphaUp ? "text-emerald-400" : "text-rose-400"}`}>
        {formatPct(data.alphaVsSpy)}
      </span>
      <BreadthBar breadth={data.breadth} count={data.members.length} />
      <div className="ml-auto flex items-center gap-1.5">
        {data.members.map((m) => {
          const up = (m.changePct ?? 0) > 0;
          return (
            <span
              key={m.symbol}
              className={`font-mono text-[10px] tabular-nums ${up ? "text-emerald-400" : "text-rose-400"}`}
              title={`${m.symbol} ${formatPct(m.changePct)}`}
            >
              {m.symbol}
            </span>
          );
        })}
      </div>
    </div>
  );
}
