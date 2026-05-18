// AlphaNewsOverlay.tsx
//
// Fetches alpha news for the current chart ticker, supplies markers to
// LightweightCandlestick, and renders an inline verdict drawer when a marker
// is clicked. Tier-1/2/sentiment-shift catalysts only — coarse filter happens
// server side. UI keeps the chart center-stage; the panel slides over the
// right ~360px when an event is active.

import { useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { X, ExternalLink, Newspaper, TrendingUp, TrendingDown, Minus, Loader2 } from "lucide-react";
import type { NewsMarker } from "./LightweightCandlestick";

// ---- Types matching server/alphaNews.ts ----

type AlphaTier = "TIER_1" | "TIER_2" | "SENTIMENT_SHIFT";
type AlphaDirection = "BULL" | "BEAR" | "NEUTRAL";

interface AlphaEvent {
  id: string;
  ticker: string;
  tier: AlphaTier;
  category: string;
  title: string;
  source: string;
  url: string;
  published: number;
  summary: string;
  initialBias: AlphaDirection;
  alphaScore: number;
  clusterZ?: number;
  clusterIds?: string[];
}

interface AlphaScenario { thesis: string; prob: number; targetMovePct: number; }
interface HistoricalAnalog { description: string; sampleSize: number; avgMovePct: number; hitRate: number; }

interface AlphaVerdict {
  eventId: string; ticker: string;
  direction: AlphaDirection;
  confidence: number;
  expectedMovePct: number;
  rrRatio: number;
  invalidation: string;
  edgeType: "informational" | "analytical" | "behavioral" | "timing" | "environmental" | "none";
  summary: string;
  bull: AlphaScenario; base: AlphaScenario; bear: AlphaScenario;
  counterargument: string;
  analog: HistoricalAnalog | null;
  provider: "anthropic" | "openai" | "deterministic";
  asOf: number;
}

interface AlphaNewsResponse {
  ticker: string;
  asOf: number;
  events: AlphaEvent[];
  warnings: string[];
}

// ---- Public hook: returns marker list for the chart ----

export function useAlphaNewsMarkers(ticker: string, enabled: boolean) {
  const query = useQuery<AlphaNewsResponse>({
    queryKey: ["/api/alpha-news", ticker],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/alpha-news?ticker=${encodeURIComponent(ticker)}`);
      return (await r.json()) as AlphaNewsResponse;
    },
    enabled: enabled && !!ticker,
    staleTime: 90_000,
    refetchInterval: 120_000,
  });

  const markers: NewsMarker[] = useMemo(() => {
    if (!query.data?.events) return [];
    return query.data.events.map((e) => ({
      id: e.id,
      time: e.published,
      direction: e.initialBias,
      tier: e.tier,
      category: e.category,
      title: e.title,
    }));
  }, [query.data]);

  return {
    events: query.data?.events ?? [],
    markers,
    warnings: query.data?.warnings ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

// ---- The drawer panel ----

function tierLabel(tier: AlphaTier): string {
  if (tier === "TIER_1") return "Tier 1";
  if (tier === "TIER_2") return "Tier 2";
  return "Sentiment Shift";
}

function tierColor(tier: AlphaTier): string {
  if (tier === "TIER_1") return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
  if (tier === "TIER_2") return "bg-violet-500/15 text-violet-300 border-violet-500/30";
  return "bg-amber-500/15 text-amber-300 border-amber-500/30";
}

function dirColor(dir: AlphaDirection): string {
  if (dir === "BULL") return "text-emerald-400";
  if (dir === "BEAR") return "text-rose-400";
  return "text-amber-400";
}

function dirBg(dir: AlphaDirection): string {
  if (dir === "BULL") return "bg-emerald-500/10 border-emerald-500/30";
  if (dir === "BEAR") return "bg-rose-500/10 border-rose-500/30";
  return "bg-amber-500/10 border-amber-500/30";
}

function DirIcon({ dir, size = 14 }: { dir: AlphaDirection; size?: number }) {
  const cls = dirColor(dir);
  if (dir === "BULL") return <TrendingUp size={size} className={cls} />;
  if (dir === "BEAR") return <TrendingDown size={size} className={cls} />;
  return <Minus size={size} className={cls} />;
}

function fmtMove(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function timeAgo(epochSec: number): string {
  const diff = Math.floor(Date.now() / 1000 - epochSec);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function ProbBar({ bull, base, bear }: { bull: number; base: number; bear: number }) {
  const total = Math.max(1, bull + base + bear);
  const b = (bull / total) * 100;
  const m = (base / total) * 100;
  const r = (bear / total) * 100;
  return (
    <div className="space-y-1.5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className="bg-emerald-500" style={{ width: `${b}%` }} title={`Bull ${bull}%`} />
        <div className="bg-amber-500" style={{ width: `${m}%` }} title={`Base ${base}%`} />
        <div className="bg-rose-500" style={{ width: `${r}%` }} title={`Bear ${bear}%`} />
      </div>
      <div className="flex justify-between text-[10px] tabular-nums text-zinc-400">
        <span><span className="text-emerald-400">Bull</span> {bull}%</span>
        <span><span className="text-amber-400">Base</span> {base}%</span>
        <span><span className="text-rose-400">Bear</span> {bear}%</span>
      </div>
    </div>
  );
}

export function AlphaNewsPanel({
  ticker,
  selectedEventId,
  events,
  onClose,
}: {
  ticker: string;
  selectedEventId: string | null;
  events: AlphaEvent[];
  onClose: () => void;
}) {
  const event = useMemo(
    () => events.find((e) => e.id === selectedEventId) ?? null,
    [events, selectedEventId],
  );

  const verdictMutation = useMutation<{ event: AlphaEvent; verdict: AlphaVerdict }, Error, { eventId: string }>({
    mutationFn: async ({ eventId }) => {
      const r = await apiRequest("POST", "/api/alpha-news/verdict", { eventId, ticker });
      return (await r.json()) as { event: AlphaEvent; verdict: AlphaVerdict };
    },
  });

  // Auto-fetch verdict whenever the selected event changes
  useEffect(() => {
    if (event) verdictMutation.mutate({ eventId: event.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id]);

  if (!selectedEventId || !event) return null;

  const verdict = verdictMutation.data?.verdict ?? null;
  const loadingVerdict = verdictMutation.isPending;

  return (
    <div
      data-testid="alpha-news-panel"
      className="absolute right-2 top-2 z-30 w-[360px] max-h-[calc(100%-1rem)] overflow-y-auto rounded-lg border border-border/60 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur-sm"
    >
      <div className="flex items-start justify-between gap-2 border-b border-border/40 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={`text-[9px] uppercase tracking-wider ${tierColor(event.tier)}`}>
              {tierLabel(event.tier)}
            </Badge>
            <Badge variant="outline" className="text-[9px] uppercase tracking-wider">
              {event.category}
            </Badge>
            <span className="text-[10px] text-zinc-500">{timeAgo(event.published)}</span>
          </div>
          <h3 className="mt-1.5 text-[13px] font-semibold leading-tight text-zinc-100" data-testid="text-alpha-headline">
            {event.title}
          </h3>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-400">
            <span>{event.source}</span>
            <a href={event.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-cyan-400 hover:text-cyan-300" data-testid="link-alpha-source">
              source <ExternalLink size={10} />
            </a>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onClose} data-testid="button-close-alpha">
          <X size={14} />
        </Button>
      </div>

      {/* Verdict card */}
      <div className="mt-3">
        {loadingVerdict ? (
          <div className="flex items-center gap-2 rounded-md border border-border/40 bg-black/30 p-3 text-[11px] text-zinc-400">
            <Loader2 size={12} className="animate-spin" /> Generating positioning verdict…
          </div>
        ) : verdict ? (
          <>
            <div className={`rounded-md border p-2.5 ${dirBg(verdict.direction)}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <DirIcon dir={verdict.direction} size={16} />
                  <span className={`text-sm font-bold uppercase tracking-wider ${dirColor(verdict.direction)}`} data-testid="text-alpha-direction">
                    {verdict.direction}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[11px] tabular-nums">
                  <span><span className="text-zinc-500">Conf</span> <span className="font-semibold text-zinc-200">{verdict.confidence}%</span></span>
                  <span><span className="text-zinc-500">R:R</span> <span className="font-semibold text-zinc-200">{verdict.rrRatio.toFixed(1)}</span></span>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 text-[11px]">
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-zinc-500">Exp. move</div>
                  <div className={`font-semibold tabular-nums ${dirColor(verdict.direction)}`}>{fmtMove(verdict.expectedMovePct)}</div>
                </div>
                <div className="flex-1">
                  <div className="text-[9px] uppercase tracking-wider text-zinc-500">Edge</div>
                  <div className="text-zinc-200">{verdict.edgeType}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-zinc-500">Engine</div>
                  <div className="text-[10px] text-zinc-400">
                    {verdict.provider === "deterministic" ? "baseline" : verdict.provider}
                  </div>
                </div>
              </div>
              <p className="mt-2 text-[11px] leading-snug text-zinc-200" data-testid="text-alpha-summary">{verdict.summary}</p>
            </div>

            {/* 3-path scenarios */}
            <div className="mt-3 space-y-2 rounded-md border border-border/40 bg-black/30 p-2.5">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400">Scenarios</div>
              <ProbBar bull={verdict.bull.prob} base={verdict.base.prob} bear={verdict.bear.prob} />
              <div className="mt-2 space-y-1.5 text-[11px] leading-snug">
                <div className="flex gap-2">
                  <span className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                  <div className="flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">Bull · {verdict.bull.prob}%</span>
                      <span className="font-mono text-[10px] text-emerald-400">{fmtMove(verdict.bull.targetMovePct)}</span>
                    </div>
                    <p className="text-zinc-300">{verdict.bull.thesis}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <span className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                  <div className="flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">Base · {verdict.base.prob}%</span>
                      <span className="font-mono text-[10px] text-amber-400">{fmtMove(verdict.base.targetMovePct)}</span>
                    </div>
                    <p className="text-zinc-300">{verdict.base.thesis}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <span className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full bg-rose-500" />
                  <div className="flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-400">Bear · {verdict.bear.prob}%</span>
                      <span className="font-mono text-[10px] text-rose-400">{fmtMove(verdict.bear.targetMovePct)}</span>
                    </div>
                    <p className="text-zinc-300">{verdict.bear.thesis}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Historical analog */}
            {verdict.analog && (
              <div className="mt-3 rounded-md border border-border/40 bg-black/30 p-2.5">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400">Historical Analog</div>
                <p className="mt-1 text-[11px] leading-snug text-zinc-300">{verdict.analog.description}</p>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[10px]">
                  <div className="rounded bg-zinc-900/60 px-1 py-1.5">
                    <div className="text-[9px] uppercase tracking-wider text-zinc-500">N</div>
                    <div className="font-semibold tabular-nums text-zinc-200">{verdict.analog.sampleSize}</div>
                  </div>
                  <div className="rounded bg-zinc-900/60 px-1 py-1.5">
                    <div className="text-[9px] uppercase tracking-wider text-zinc-500">Avg Move</div>
                    <div className={`font-semibold tabular-nums ${verdict.analog.avgMovePct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {fmtMove(verdict.analog.avgMovePct)}
                    </div>
                  </div>
                  <div className="rounded bg-zinc-900/60 px-1 py-1.5">
                    <div className="text-[9px] uppercase tracking-wider text-zinc-500">Hit Rate</div>
                    <div className="font-semibold tabular-nums text-zinc-200">{verdict.analog.hitRate}%</div>
                  </div>
                </div>
              </div>
            )}

            {/* Risk params */}
            <div className="mt-3 space-y-2 rounded-md border border-rose-500/20 bg-rose-500/5 p-2.5 text-[11px]">
              <div>
                <span className="text-[9px] font-semibold uppercase tracking-wider text-rose-300">Invalidation</span>
                <p className="mt-0.5 leading-snug text-zinc-200" data-testid="text-alpha-invalidation">{verdict.invalidation}</p>
              </div>
              <div className="border-t border-border/30 pt-2">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400">Counterargument</span>
                <p className="mt-0.5 leading-snug text-zinc-300">{verdict.counterargument}</p>
              </div>
            </div>

            {event.clusterIds && event.clusterIds.length > 1 && (
              <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-[10px] leading-snug text-amber-200">
                <Newspaper size={10} className="mr-1 inline" />
                {event.clusterIds.length} correlated headlines on this story
                {event.clusterZ != null && <> · z={event.clusterZ.toFixed(2)}σ</>}
              </div>
            )}
          </>
        ) : verdictMutation.isError ? (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-[11px] text-rose-300">
            Failed to generate verdict. {verdictMutation.error?.message}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---- Compact toggle button for the chart header ----

export function AlphaNewsToggle({
  enabled,
  count,
  onToggle,
}: {
  enabled: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <Button
      variant={enabled ? "default" : "outline"}
      size="sm"
      onClick={onToggle}
      className={`h-7 gap-1 px-2 text-[11px] ${enabled ? "bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 border-cyan-500/40" : ""}`}
      data-testid="button-toggle-alpha-news"
      title="Toggle alpha news indicators on the chart"
    >
      <Newspaper size={12} />
      <span>Alpha News</span>
      {enabled && count > 0 && (
        <span className="ml-0.5 rounded-full bg-cyan-500/30 px-1.5 text-[10px] tabular-nums text-cyan-200">
          {count}
        </span>
      )}
    </Button>
  );
}
