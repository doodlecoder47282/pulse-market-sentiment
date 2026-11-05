// MacroCarousel.tsx
// Two pieces exported:
//   1) <MacroTicker /> — thin marquee strip with every ticker flowing across
//   2) <MacroCarousel /> — rotating category showcase (Equities→Bonds→...)
//
// Both pull /api/macro. Quotes auto-refresh every 60s.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useIsDemo } from "@/lib/useEdition";
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
  /** Where the price comes from (server/macroCore.ts). Optional: older servers omit it. */
  basis?: "regular_session_last" | "session_close" | "last_daily_close" | "public_fallback" | "unavailable";
  dataState?: "ok" | "partial" | "unavailable";
  reason?: string | null;
  priceAsOfMs?: number | null;
  priceTimeBasis?: "trade" | "session_close_reference" | "unavailable";
  priceSessionDate?: string | null;
  sessionDateAssumed?: boolean;
  stale?: boolean | null;
};

type MacroResponse = {
  asOf: number;
  sessionOpen?: boolean;
  coverage?: { total: number; ok: number; partial: number; unavailable: number };
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

const BASIS_TEXT: Record<string, string> = {
  regular_session_last: "last regular-session trade",
  session_close: "regular-session close (daily bar)",
  last_daily_close: "older close, substitute",
  public_fallback: "public source",
  unavailable: "unavailable",
};

const etFmt = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";

/** The row's time in words: a trade time, a session-close reference, or "time unavailable". */
function timeText(q: MacroQuote): string {
  if (q.basis === "public_fallback") return "time not provided by the source";
  if (q.priceAsOfMs == null || q.priceTimeBasis === "unavailable") return "time unavailable";
  if (q.priceTimeBasis === "session_close_reference") return `session close ${etFmt(q.priceAsOfMs)} (scheduled close, not a trade time)`;
  return `traded ${etFmt(q.priceAsOfMs)}`;
}

/** Short visible tag for a row that is not fully healthy (text, not colour alone). */
function stateTag(q: MacroQuote): string | null {
  if (q.dataState === "unavailable") return "n/a";
  if (q.basis === "last_daily_close") return "old close";
  if (q.dataState === "partial") return "partial";
  return null;
}

/** Tooltip: what the row's price is and what is missing. */
function rowTitle(q: MacroQuote): string {
  const parts: string[] = [q.symbol];
  if (q.basis) parts.push(BASIS_TEXT[q.basis] ?? q.basis);
  parts.push(timeText(q));
  if (q.stale === true) parts.push("stale");
  if (q.reason) parts.push(q.reason);
  return parts.join(" · ");
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
      className={`flex items-center gap-2 whitespace-nowrap ${compact ? "text-xs" : "text-sm"} ${q.dataState === "unavailable" ? "opacity-60" : ""}`}
      data-testid={`ticker-${q.symbol}`}
      data-basis={q.basis ?? ""}
      title={rowTitle(q)}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden />
      <span className="font-semibold tracking-tight">{q.label}</span>
      <span className="font-mono tabular-nums">{formatPrice(q)}</span>
      {stateTag(q) && <span className="text-[10px] uppercase text-amber-300/90" data-testid={`ticker-state-${q.symbol}`}>{stateTag(q)}</span>}
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
  const isDemo = useIsDemo();
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (isLoading || !data) {
    return (
      <div className="border-y border-border/50 bg-black/20 py-1.5">
        <div className="px-4 text-xs text-muted-foreground">Loading tape…</div>
      </div>
    );
  }

  // Duplicate the list so the CSS marquee animation loops seamlessly.
  const items = [...data.tape, ...data.tape];
  // "Live" only while the regular session is open; otherwise the tape shows
  // the last session's prices and says so. Older servers omit sessionOpen.
  const live = data.sessionOpen !== false;

  const notHealthy = data.tape.filter((q) => q.dataState && q.dataState !== "ok").length;
  return (
    <div>
    <div
      className="relative overflow-hidden border-y border-border/50 bg-gradient-to-r from-black/40 via-black/20 to-black/40 py-2"
      data-testid="macro-ticker-tape"
    >
      {/* Tap-accessible row details (tooltips do not work on phones). */}
      <button
        type="button"
        onClick={() => setDetailsOpen((v) => !v)}
        aria-expanded={detailsOpen}
        aria-controls="macro-tape-details"
        data-testid="macro-tape-details-toggle"
        className="absolute right-2 top-1/2 z-10 flex min-h-[32px] -translate-y-1/2 items-center rounded-full border border-border/60 bg-background/90 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur hover:text-foreground"
      >
        {detailsOpen ? "Hide" : "Details"}{notHealthy > 0 ? ` · ${notHealthy} not ok` : ""}
      </button>
      {/* Live pulse indicator (Sample on the demo: those prices are simulated) */}
      {isDemo ? (
        <div className="pointer-events-none absolute left-3 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-full border border-indigo-400/40 bg-background/80 px-2 py-0.5 backdrop-blur" data-testid="macro-tape-label">
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-indigo-300" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-indigo-200">Sample</span>
        </div>
      ) : !live ? (
        <div className="pointer-events-none absolute left-3 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-full border border-border/60 bg-background/80 px-2 py-0.5 backdrop-blur" data-testid="macro-tape-label" title="Regular stock session closed: stock and ETF rows show their regular-session close; crypto and FX keep updating">
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-muted-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Stocks closed</span>
        </div>
      ) : (
        <div className="pointer-events-none absolute left-3 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-full border border-emerald-500/40 bg-background/80 px-2 py-0.5 backdrop-blur" data-testid="macro-tape-label">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">Live</span>
        </div>
      )}

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
    {detailsOpen && (
      <div id="macro-tape-details" className="max-h-72 overflow-y-auto border-b border-border/50 bg-background/95 px-3 py-2 text-xs" data-testid="macro-tape-details">
        <div className="mb-1 text-[11px] text-muted-foreground">
          Each row: price basis, its own time, session, and anything missing. Commodity rows are ETF share prices. Snapshot built {etFmt(data.asOf * 1000)}.
        </div>
        <ul className="divide-y divide-border/40">
          {data.tape.map((q) => (
            <li key={q.symbol} className="py-1.5" data-testid={`macro-detail-${q.symbol}`}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold">{q.label}</span>
                <span className="font-mono tabular-nums">{formatPrice(q)}</span>
                <span className="font-mono tabular-nums text-muted-foreground">{q.changePct != null ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%` : "change n/a"}</span>
                <span className={q.dataState === "ok" ? "text-emerald-400" : "text-amber-300"}>{q.dataState ?? "state not reported"}</span>
              </div>
              <div className="text-muted-foreground">
                {BASIS_TEXT[q.basis ?? ""] ?? "basis not reported"} · {timeText(q)}
                {q.priceSessionDate ? ` · session ${q.priceSessionDate}${q.sessionDateAssumed ? " (assumed)" : ""}` : ""}
                {q.stale === true ? " · stale" : ""}
              </div>
              {q.reason && <div className="text-amber-300/90">{q.reason}</div>}
            </li>
          ))}
        </ul>
      </div>
    )}
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
        macro quotes offline — Schwab feed down, try again shortly
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur-md"
      data-testid="macro-carousel"
    >
      {/* Category selector — horizontally-scrollable on mobile, wraps on desktop */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="-mx-1 flex flex-1 gap-1.5 hscroll-contain px-1 pb-0.5 md:flex-wrap md:overflow-visible scrollbar-none">
          {groups.map((g, i) => {
            const isActive = i === activeIdx;
            const accent = CATEGORY_ACCENT[g.category];
            return (
              <button
                key={g.category}
                onClick={() => setActiveIdx(i)}
                className={[
                  "inline-flex shrink-0 items-center rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-wider transition",
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
        <div className="hidden shrink-0 text-right text-[11px] uppercase leading-tight tracking-wider text-muted-foreground sm:block">
          Auto-rotating
          <div className="font-mono normal-case tracking-normal" title="When this snapshot was built. Each price carries its own time (hover a row).">
            built {new Date(data.asOf * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
      </div>

      {/* Active category grid — ticker symbol leads, label is secondary */}
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
              className={`group flex flex-col gap-1 rounded-lg border border-border/40 bg-gradient-to-br ${bgTint} px-3 py-2 transition hover:border-border`}
              data-testid={`carousel-quote-${q.symbol}`}
              data-basis={q.basis ?? ""}
              title={rowTitle(q)}
            >
              {/* Row 1: ticker symbol (lead) + % change */}
              <div className="flex items-center justify-between gap-2">
                <div className="truncate font-mono text-[13px] font-bold tracking-tight" title={q.symbol}>{q.label}</div>
                <div className={`shrink-0 font-mono text-xs tabular-nums ${color}`}>
                  {q.changePct != null
                    ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%`
                    : "—"}
                </div>
              </div>
              {/* Row 2: price + sparkline */}
              <div className="flex items-center justify-between gap-2">
                <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatPrice(q)}
                  {q.basis === "last_daily_close" && <span className="ml-1 text-[10px] uppercase">close</span>}
                  {q.dataState === "unavailable" && <span className="ml-1 text-[10px]">unavailable</span>}
                </div>
                <Sparkline data={q.spark} positive={up} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
