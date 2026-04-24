// client/src/components/WefThemePanel.tsx
// WEF Theme → ticker basket mapper. Reads /api/wef-themes and renders one
// card per theme showing: mention count (WEF heat), basket-average RS vs SPY
// (market heat), all basket tickers, and RS-filtered leaders (the stocks
// actually following the narrative).

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle, Flame, ExternalLink, TrendingUp,
  ChevronDown, ChevronUp, Sparkles,
} from "lucide-react";
import type { WefThemeResponse, WefTheme } from "@shared/schema";
import { useTickers } from "./TickerContext";

type SortMode = "mentions" | "rs" | "alpha";

export default function WefThemePanel() {
  const [expanded, setExpanded] = useState(false);
  const [sort, setSort] = useState<SortMode>("mentions");

  const { data, isLoading, isError, error } = useQuery<WefThemeResponse>({
    queryKey: ["/api/wef-themes"],
    queryFn: async () => apiRequest("GET", "/api/wef-themes").then((r) => r.json()),
    refetchInterval: 30 * 60_000,
    staleTime: 15 * 60_000,
  });

  const themesSorted = useMemo(() => {
    if (!data) return [];
    const list = [...data.themes];
    if (sort === "mentions") list.sort((a, b) => b.mentions - a.mentions);
    else if (sort === "rs") list.sort((a, b) => b.basketRs1m - a.basketRs1m);
    else list.sort((a, b) => a.label.localeCompare(b.label));
    return list;
  }, [data, sort]);

  const topThemeByMentions = useMemo(() => {
    if (!data) return null;
    return [...data.themes].sort((a, b) => b.mentions - a.mentions)[0] ?? null;
  }, [data]);

  const topThemeByRs = useMemo(() => {
    if (!data) return null;
    return [...data.themes].sort((a, b) => b.basketRs1m - a.basketRs1m)[0] ?? null;
  }, [data]);

  if (isLoading) return <Skeleton className="h-[120px] w-full" />;
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-2 text-amber-500">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-sm font-medium">WEF theme mapper unavailable</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {(error as Error)?.message ?? "Could not build the WEF theme basket map."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const maxMentions = Math.max(...data.themes.map((t) => t.mentions), 1);

  return (
    <Card className="overflow-hidden" data-testid="wef-narrative-mapper">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Flame className="h-4 w-4 text-orange-400" />
              WEF Narrative → Ticker Basket Mapper
            </CardTitle>
            <div className="mt-1 text-[11px] text-muted-foreground">{data.summary}</div>
          </div>
          <div className="flex items-center gap-2">
            {expanded && (
              <div className="flex items-center gap-1 rounded-md border border-border bg-card/50 p-0.5">
                {([
                  ["mentions", "WEF heat"],
                  ["rs", "1M RS"],
                  ["alpha", "A–Z"],
                ] as [SortMode, string][]).map(([k, label]) => (
                  <Button
                    key={k}
                    variant={sort === k ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setSort(k)}
                    data-testid={`wef-sort-${k}`}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-[11px]"
              onClick={() => setExpanded((e) => !e)}
              data-testid="wef-expand"
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {expanded ? "Collapse" : `Expand all ${data.themes.length} themes`}
            </Button>
          </div>
        </div>

        {/* Top-narrative highlight strip — always visible */}
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          {topThemeByMentions && (
            <div
              className="flex items-center gap-2 rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2"
              data-testid="wef-top-mentions"
            >
              <Flame className="h-3.5 w-3.5 shrink-0 text-orange-300" />
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-orange-300/80">Hottest on WEF</div>
                <div className="truncate text-[12px] font-medium text-foreground">
                  {topThemeByMentions.label}{" "}
                  <span className="font-mono text-[11px] text-orange-200">
                    · {topThemeByMentions.mentions}× mentions
                  </span>
                </div>
              </div>
            </div>
          )}
          {topThemeByRs && (
            <div
              className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2"
              data-testid="wef-top-rs"
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-emerald-300/80">Leading on tape</div>
                <div className="truncate text-[12px] font-medium text-foreground">
                  {topThemeByRs.label}{" "}
                  <span
                    className={`font-mono text-[11px] ${
                      topThemeByRs.basketRs1m >= 0 ? "text-emerald-200" : "text-red-200"
                    }`}
                  >
                    · basket RS {topThemeByRs.basketRs1m >= 0 ? "+" : ""}
                    {topThemeByRs.basketRs1m.toFixed(2)}% (1M)
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </CardHeader>
      {expanded && (
        <CardContent data-testid="wef-grid">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {themesSorted.map((t) => (
              <ThemeCard key={t.id} theme={t} maxMentions={maxMentions} />
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function heatBg(rs: number): string {
  const clamp = Math.max(-3, Math.min(3, rs));
  if (clamp >= 0) {
    const t = clamp / 3;
    const l = 20 - t * 8;
    return `hsla(140, 70%, ${l}%, 0.7)`;
  } else {
    const t = -clamp / 3;
    const l = 22 - t * 8;
    return `hsla(0, 70%, ${l}%, 0.7)`;
  }
}

function ThemeCard({ theme, maxMentions }: { theme: WefTheme; maxMentions: number }) {
  const { focusChart } = useTickers();
  const heatPct = Math.round((theme.mentions / maxMentions) * 100);
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border/50 p-4 transition hover:border-orange-500/40"
      style={{ background: heatBg(theme.basketRs1m) }}
      data-testid={`wef-theme-${theme.id}`}
    >
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="text-[14px] font-semibold">{theme.label}</div>
          <span
            className="rounded-full border border-orange-500/30 bg-orange-500/15 px-2 py-0.5 text-[10px] font-mono text-orange-200"
            title="WEF mention count across scanned sources"
          >
            {theme.mentions}× WEF
          </span>
        </div>
        <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-border/40">
          <div className="h-full rounded bg-gradient-to-r from-orange-500/40 to-amber-400/70" style={{ width: `${heatPct}%` }} />
        </div>
      </div>

      <p className="text-[11.5px] leading-snug text-foreground/75">{theme.blurb}</p>

      {/* Leaders — actually following the narrative */}
      <div>
        <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-emerald-400/80">
          <TrendingUp className="h-3 w-3" />
          RS leaders (1M vs SPY)
        </div>
        {theme.leaders.length === 0 ? (
          <div className="text-[11px] italic text-muted-foreground">No basket members outperforming SPY on 1M</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {theme.leaders.map((l) => (
              <button
                key={l.symbol}
                className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[11px] text-emerald-200 transition hover:border-cyan-400 hover:bg-cyan-500/20 hover:text-cyan-100"
                title={`Chart ${l.symbol} · 1M: ${l.r1m.toFixed(2)}% · RS: ${l.rs1m.toFixed(2)}%`}
                onClick={() => focusChart(l.symbol)}
                data-testid={`wef-leader-${l.symbol}`}
              >
                {l.symbol} <span className="text-[9.5px] opacity-80">+{l.rs1m.toFixed(1)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Full basket — muted */}
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Full basket</div>
        <div className="flex flex-wrap gap-1">
          {theme.basket.map((b) => (
            <button
              key={b}
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] transition hover:border-cyan-400 hover:text-cyan-200 ${
                theme.leaders.find((l) => l.symbol === b)
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300/80"
                  : "border-border/50 bg-muted/20 text-muted-foreground"
              }`}
              title={`Chart ${b}`}
              onClick={() => focusChart(b)}
              data-testid={`wef-basket-${b}`}
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      {/* Sources */}
      {theme.sources.length > 0 && (
        <div className="mt-auto border-t border-border/30 pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">From WEF</div>
          <div className="flex flex-col gap-0.5">
            {theme.sources.map((s) => (
              <a
                key={s.url}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-1 text-[11px] text-foreground/70 hover:text-orange-300"
              >
                <ExternalLink className="mt-0.5 h-2.5 w-2.5 shrink-0" />
                <span className="line-clamp-2">{s.title}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
