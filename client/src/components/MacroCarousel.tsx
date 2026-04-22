// MacroCarousel.tsx
// Two pieces exported:
//   1) <MacroTicker /> — thin marquee strip with every ticker flowing across
//   2) <MacroCarousel /> — rotating category showcase (Equities→Bonds→...)
//
// Both pull /api/macro. Quotes auto-refresh every 60s.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

type MacroCategory = "equities" | "bonds" | "credit" | "commods" | "fx" | "crypto";

type MacroQuote = {
  category: MacroCategory;
  symbol: string;
  display: string;
  label: string;
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  spark: number[];
};

type MacroResponse = {
  asOf: number;
  groups: { category: MacroCategory; label: string; quotes: MacroQuote[] }[];
  tape: MacroQuote[];
};

const CATEGORY_ACCENT: Record<MacroCategory, string> = {
  equities: "text-cyan-400 border-cyan-500/30",
  bonds: "text-blue-400 border-blue-500/30",
  credit: "text-violet-400 border-violet-500/30",
  commods: "text-amber-400 border-amber-500/30",
  fx: "text-emerald-400 border-emerald-500/30",
  crypto: "text-fuchsia-400 border-fuchsia-500/30",
};

const CATEGORY_DOT: Record<MacroCategory, string> = {
  equities: "bg-cyan-400",
  bonds: "bg-blue-400",
  credit: "bg-violet-400",
  commods: "bg-amber-400",
  fx: "bg-emerald-400",
  crypto: "bg-fuchsia-400",
};

function formatPrice(q: MacroQuote): string {
  if (q.price == null) return "—";
  // FX needs 4 decimals, crypto needs comma formatting, everything else 2.
  if (q.category === "fx") return q.price.toFixed(4);
  if (q.category === "crypto" && q.price >= 100) {
    return q.price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  if (q.price >= 1000) {
    return q.price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return q.price.toFixed(2);
}

function useMacroQuery() {
  return useQuery<MacroResponse>({
    queryKey: ["/api/macro"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/macro");
      return r.json();
    },
    refetchInterval: 10_000,   // real-time — matches server cache
    staleTime: 8_000,
    refetchOnWindowFocus: true,
  });
}

// -------- Sparkline (pure SVG, no recharts to keep the carousel fast) --------

function Sparkline({ data, positive }: { data: number[]; positive: boolean | null }) {
  if (!data || data.length < 2) {
    return <div className="h-6 w-16 opacity-30">—</div>;
  }
  const w = 64;
  const h = 20;
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

// -------- Quote pill --------

function QuotePill({ q, compact = false }: { q: MacroQuote; compact?: boolean }) {
  const up = q.changePct != null ? q.changePct > 0 : null;
  const down = q.changePct != null ? q.changePct < 0 : null;
  const color = up ? "text-emerald-400" : down ? "text-rose-400" : "text-muted-foreground";
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  const dotColor = CATEGORY_DOT[q.category];

  return (
    <div
      className={`flex items-center gap-2 whitespace-nowrap ${compact ? "text-xs" : "text-sm"}`}
      data-testid={`ticker-${q.symbol}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden />
      <span className="font-semibold tracking-tight">{q.label}</span>
      <span className="font-mono tabular-nums">{formatPrice(q)}</span>
      <span className={`flex items-center gap-0.5 font-mono tabular-nums ${color}`}>
        <Icon className="h-3 w-3" />
        {q.changePct != null ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%` : "—"}
      </span>
    </div>
  );
}

// -------- Ticker tape (marquee) --------

export function MacroTicker() {
  const { data, isLoading } = useMacroQuery();

  if (isLoading || !data) {
    return (
      <div className="border-y border-border/50 bg-black/20 py-1.5">
        <div className="px-4 text-xs text-muted-foreground">Loading tape…</div>
      </div>
    );
  }

  // Duplicate the list so the CSS marquee animation loops seamlessly.
  const items = [...data.tape, ...data.tape];

  return (
    <div
      className="relative overflow-hidden border-y border-border/50 bg-gradient-to-r from-black/40 via-black/20 to-black/40 py-2"
      data-testid="macro-ticker-tape"
    >
      {/* Live pulse indicator */}
      <div className="pointer-events-none absolute left-3 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-full border border-emerald-500/40 bg-background/80 px-2 py-0.5 backdrop-blur">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        <span className="text-[9px] font-semibold uppercase tracking-wider text-emerald-400">Live</span>
      </div>

      <div
        className="flex gap-6 pl-20 animate-[marquee_80s_linear_infinite] will-change-transform"
        style={{ width: "max-content" }}
      >
        {items.map((q, i) => (
          <div key={`${q.symbol}-${i}`} className="shrink-0">
            <QuotePill q={q} compact />
          </div>
        ))}
      </div>
      <style>{`
        @keyframes marquee {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}

// -------- Rotating Carousel (per-category) --------

export function MacroCarousel() {
  const { data, isLoading, isError } = useMacroQuery();
  const [activeIdx, setActiveIdx] = useState(0);

  const groups = data?.groups ?? [];

  // Auto-rotate category every 6s
  useEffect(() => {
    if (groups.length === 0) return;
    const t = setInterval(() => {
      setActiveIdx((i) => (i + 1) % groups.length);
    }, 6000);
    return () => clearInterval(t);
  }, [groups.length]);

  const active = groups[activeIdx];

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/50 p-4 backdrop-blur">
        <div className="h-20 animate-pulse rounded bg-muted/30" />
      </div>
    );
  }

  if (isError || !data || !active) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/50 p-4 text-sm text-muted-foreground">
        Macro feed unavailable
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur-md"
      data-testid="macro-carousel"
    >
      {/* Category selector */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex flex-wrap gap-1.5">
          {groups.map((g, i) => {
            const isActive = i === activeIdx;
            const accent = CATEGORY_ACCENT[g.category];
            return (
              <button
                key={g.category}
                onClick={() => setActiveIdx(i)}
                className={[
                  "rounded-full border px-2.5 py-0.5 text-[11px] uppercase tracking-wider transition",
                  isActive
                    ? `${accent} bg-background/80 font-semibold`
                    : "border-border/40 text-muted-foreground hover:text-foreground",
                ].join(" ")}
                data-testid={`carousel-tab-${g.category}`}
              >
                {g.label}
              </button>
            );
          })}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Auto-rotating · {new Date(data.asOf * 1000).toLocaleTimeString()}
        </div>
      </div>

      {/* Active category grid */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
        {active.quotes.map((q) => {
          const up = q.changePct != null ? q.changePct > 0 : null;
          const down = q.changePct != null ? q.changePct < 0 : null;
          const bgTint = up
            ? "from-emerald-500/5 to-transparent"
            : down
            ? "from-rose-500/5 to-transparent"
            : "from-muted/10 to-transparent";
          const color = up ? "text-emerald-400" : down ? "text-rose-400" : "text-muted-foreground";
          return (
            <div
              key={q.symbol}
              className={`group flex items-center justify-between rounded-lg border border-border/40 bg-gradient-to-br ${bgTint} px-3 py-2 transition hover:border-border`}
              data-testid={`carousel-quote-${q.symbol}`}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold tracking-tight">{q.label}</div>
                <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatPrice(q)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Sparkline data={q.spark} positive={up} />
                <div className={`font-mono text-xs tabular-nums ${color}`}>
                  {q.changePct != null
                    ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%`
                    : "—"}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
