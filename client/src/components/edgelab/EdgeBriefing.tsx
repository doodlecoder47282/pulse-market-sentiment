/**
 * EdgeBriefing.tsx
 *
 * Daily-to-weekly fused brief for the active symbol — combines regime, cross-asset,
 * playbook, week-ahead econ, news, model targets, and levels into one read.
 *
 * Hits /api/edgelab/briefing?symbol=SPY (server-side aggregator).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, ChevronUp, RefreshCw, ExternalLink, AlertCircle } from "lucide-react";

type VerdictColor = "emerald" | "rose" | "amber" | "neutral";

interface Briefing {
  asOf: number;
  symbol: string;
  spot: number | null;
  verdict: string;
  verdictColor: VerdictColor;
  confidence: number;
  oneLiner: string;
  regime: {
    headline: string;
    narrative: string;
    riskAxisLabel: string | null;
    riskAxisDirection: string | null;
    notes: string[];
  } | null;
  crossAsset: {
    rows: { symbol: string; last: number; d1Pct: number; w1Pct: number; m1Pct: number; corr20d: number | null; corrRegime: string }[];
    vix: number | null;
    vixChangePct: number | null;
  } | null;
  playbook: {
    marketSession: string;
    paths: {
      bull: { label: string; probability: number; trigger: string; targetLow: number; targetHigh: number; oneLiner: string; drivers: string[] };
      base: { label: string; probability: number; trigger: string; targetLow: number; targetHigh: number; oneLiner: string; drivers: string[] };
      bear: { label: string; probability: number; trigger: string; targetLow: number; targetHigh: number; oneLiner: string; drivers: string[] };
    };
    levels: { support: number | null; resistance: number | null };
  } | null;
  weekAhead: { iso: string; label: string; events: { title: string; importance: string; timeLabel: string; note?: string }[] }[];
  news: { title: string; url: string; source: string; publishedAt: number }[];
  models: {
    daily: { label: string; symbol: string; spot: number; targetDate: string; priceLow: number | null; priceHigh: number | null; bias: string | null; confidence: number | null } | null;
    weekly: { label: string; symbol: string; spot: number; targetDate: string; priceLow: number | null; priceHigh: number | null; bias: string | null; confidence: number | null } | null;
  };
  levels: {
    callWall: number | null;
    putWall: number | null;
    zeroGamma: number | null;
    vomma: { up: number | null; down: number | null };
    charm: number | null;
    upside: number | null;
    downside: number | null;
    spot: number | null;
  };
  panelHealth: { name: string; ok: boolean }[];
}

const verdictPill = (c: VerdictColor) => {
  switch (c) {
    case "emerald": return "bg-emerald-500/15 text-emerald-400 border-emerald-500/40";
    case "rose": return "bg-rose-500/15 text-rose-400 border-rose-500/40";
    case "amber": return "bg-amber-500/15 text-amber-400 border-amber-500/40";
    default: return "bg-muted text-muted-foreground border-border";
  }
};

const fmtPct = (n: number, signed = true) =>
  `${signed && n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const fmtMoney = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`;

const fmtProb = (p: number) => `${Math.round(p * 100)}%`;

const importanceColor = (imp: string) => {
  if (imp === "HIGH") return "border-rose-500/40 bg-rose-500/10 text-rose-400";
  if (imp === "MED") return "border-amber-500/40 bg-amber-500/10 text-amber-400";
  return "border-muted-foreground/30 bg-muted/30 text-muted-foreground";
};

function LevelChip({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-card/40 px-2 py-1.5 min-w-[90px]" title={hint}>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-semibold">{value != null ? value.toFixed(2) : "—"}</div>
    </div>
  );
}

function PathCard({ kind, p }: { kind: "bull" | "base" | "bear"; p: { label: string; probability: number; trigger: string; targetLow: number; targetHigh: number; oneLiner: string; drivers: string[] } }) {
  const color = kind === "bull" ? "border-emerald-500/30 bg-emerald-500/5" : kind === "bear" ? "border-rose-500/30 bg-rose-500/5" : "border-amber-500/30 bg-amber-500/5";
  const accent = kind === "bull" ? "text-emerald-400" : kind === "bear" ? "text-rose-400" : "text-amber-400";
  return (
    <div className={`rounded-md border ${color} p-3 space-y-2`}>
      <div className="flex items-center justify-between">
        <span className={`text-[10px] uppercase tracking-wider font-bold ${accent}`}>{kind} · {p.label}</span>
        <span className="font-mono font-bold">{fmtProb(p.probability)}</span>
      </div>
      <div className="text-[11px] text-muted-foreground leading-snug">{p.oneLiner}</div>
      <div className="text-[10px]">
        <span className="text-muted-foreground">trigger:</span> <span className="font-mono">{p.trigger}</span>
      </div>
      <div className="text-[10px]">
        <span className="text-muted-foreground">target:</span> <span className="font-mono">{p.targetLow.toFixed(2)} – {p.targetHigh.toFixed(2)}</span>
      </div>
      {p.drivers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {p.drivers.map((d, i) => (
            <span key={i} className="rounded border border-border/40 bg-muted/30 px-1.5 py-0.5 text-[9px] text-muted-foreground">{d}</span>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  defaultSymbol?: string;
}

export default function EdgeBriefing({ defaultSymbol = "SPY" }: Props) {
  const [symbolInput, setSymbolInput] = useState(defaultSymbol);
  const [active, setActive] = useState(defaultSymbol);
  const [showHealth, setShowHealth] = useState(false);

  const q = useQuery<Briefing>({
    queryKey: ["/api/edgelab/briefing", active],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/edgelab/briefing?symbol=${encodeURIComponent(active)}`);
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const d = q.data;

  return (
    <Card data-testid="edge-briefing-panel">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <CardTitle className="text-sm font-semibold tracking-tight">Daily / Weekly Briefing</CardTitle>
            {d && (
              <>
                <Badge variant="outline" className={`text-[10px] uppercase tracking-wider font-bold ${verdictPill(d.verdictColor)}`}>
                  {d.verdict}
                </Badge>
                <Badge variant="outline" className="text-[10px]">conf {d.confidence}%</Badge>
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Input
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter") setActive(symbolInput); }}
              className="h-7 w-20 text-xs font-mono"
              data-testid="briefing-symbol-input"
            />
            <Button size="sm" variant="outline" onClick={() => setActive(symbolInput)} className="h-7 text-xs" data-testid="briefing-go">
              go
            </Button>
            <Button size="sm" variant="ghost" onClick={() => q.refetch()} className="h-7 w-7 p-0" data-testid="briefing-refresh">
              <RefreshCw className={`h-3 w-3 ${q.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
        {d && (
          <p className="text-xs text-muted-foreground leading-snug pt-1">{d.oneLiner}</p>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {q.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {q.isError && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-400 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> briefing failed — check server logs
          </div>
        )}

        {d && (
          <>
            {/* Levels strip */}
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">key levels · {d.symbol}{d.spot != null ? ` · spot ${d.spot.toFixed(2)}` : ""}</div>
              <div className="flex flex-wrap gap-1.5">
                <LevelChip label="call wall" value={d.levels.callWall} hint="dealer call wall — ceiling above" />
                <LevelChip label="put wall" value={d.levels.putWall} hint="dealer put wall — floor below" />
                <LevelChip label="zero γ" value={d.levels.zeroGamma} hint="gamma flip level" />
                <LevelChip label="upside" value={d.levels.upside} hint="upside target" />
                <LevelChip label="downside" value={d.levels.downside} hint="downside target" />
                <LevelChip label="vomma↑" value={d.levels.vomma.up} hint="upper vomma" />
                <LevelChip label="vomma↓" value={d.levels.vomma.down} hint="lower vomma" />
                <LevelChip label="charm" value={d.levels.charm} hint="charm pin" />
              </div>
            </div>

            {/* Regime + Cross-asset side by side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Regime */}
              {d.regime && (
                <div className="rounded-md border border-border/40 bg-card/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">regime</span>
                    {d.regime.riskAxisDirection && (
                      <Badge variant="outline" className="text-[9px]">{d.regime.riskAxisDirection}</Badge>
                    )}
                  </div>
                  <div className="text-sm font-semibold">{d.regime.headline}</div>
                  <div className="text-[11px] text-muted-foreground leading-snug">{d.regime.narrative}</div>
                </div>
              )}

              {/* Cross-asset */}
              {d.crossAsset && (
                <div className="rounded-md border border-border/40 bg-card/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">cross-asset</span>
                    {d.crossAsset.vix != null && (
                      <span className="text-[10px] font-mono">vix {d.crossAsset.vix.toFixed(2)}</span>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="text-left text-[9px] uppercase tracking-wider text-muted-foreground border-b border-border/30">
                          <th className="pb-1 pr-2">sym</th>
                          <th className="pb-1 pr-2 text-right">last</th>
                          <th className="pb-1 pr-2 text-right">1d</th>
                          <th className="pb-1 pr-2 text-right">1w</th>
                          <th className="pb-1 text-right">1m</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono tabular-nums">
                        {d.crossAsset.rows.map((r) => (
                          <tr key={r.symbol} className="border-b border-border/10 last:border-b-0">
                            <td className="py-1 pr-2 font-semibold">{r.symbol}</td>
                            <td className="py-1 pr-2 text-right">{r.last.toFixed(2)}</td>
                            <td className={`py-1 pr-2 text-right ${r.d1Pct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(r.d1Pct)}</td>
                            <td className={`py-1 pr-2 text-right ${r.w1Pct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(r.w1Pct)}</td>
                            <td className={`py-1 text-right ${r.m1Pct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(r.m1Pct)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Playbook paths */}
            {d.playbook && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">playbook · 3 paths · {d.playbook.marketSession}</div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <PathCard kind="bull" p={d.playbook.paths.bull} />
                  <PathCard kind="base" p={d.playbook.paths.base} />
                  <PathCard kind="bear" p={d.playbook.paths.bear} />
                </div>
              </div>
            )}

            {/* Models */}
            {(d.models.daily || d.models.weekly) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {d.models.daily && (
                  <div className="rounded-md border border-border/40 bg-card/40 p-2.5 space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{d.models.daily.label}</div>
                    <div className="text-sm font-semibold font-mono">
                      {d.models.daily.priceLow != null && d.models.daily.priceHigh != null
                        ? `${d.models.daily.priceLow.toFixed(2)} – ${d.models.daily.priceHigh.toFixed(2)}`
                        : "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">target {d.models.daily.targetDate}</div>
                  </div>
                )}
                {d.models.weekly && (
                  <div className="rounded-md border border-border/40 bg-card/40 p-2.5 space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{d.models.weekly.label}</div>
                    <div className="text-sm font-semibold font-mono">
                      {d.models.weekly.priceLow != null && d.models.weekly.priceHigh != null
                        ? `${d.models.weekly.priceLow.toFixed(2)} – ${d.models.weekly.priceHigh.toFixed(2)}`
                        : "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">target {d.models.weekly.targetDate}</div>
                  </div>
                )}
              </div>
            )}

            {/* Week ahead */}
            {d.weekAhead.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">week ahead</div>
                <div className="grid grid-cols-1 sm:grid-cols-5 gap-1.5">
                  {d.weekAhead.map((day) => (
                    <div key={day.iso} className="rounded-md border border-border/30 bg-card/30 p-2 space-y-1">
                      <div className="text-[10px] font-bold uppercase tracking-wider">{day.label}</div>
                      {day.events.length === 0 ? (
                        <div className="text-[10px] text-muted-foreground/60 italic">no scheduled events</div>
                      ) : (
                        day.events.map((ev, i) => (
                          <div key={i} className="space-y-0.5">
                            <Badge variant="outline" className={`text-[8px] py-0 px-1 h-3.5 ${importanceColor(ev.importance)}`}>{ev.importance}</Badge>
                            <div className="text-[10px] leading-tight font-medium">{ev.title}</div>
                            <div className="text-[9px] text-muted-foreground">{ev.timeLabel}</div>
                          </div>
                        ))
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* News */}
            {d.news.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">headlines</div>
                <div className="space-y-1">
                  {d.news.slice(0, 6).map((n, i) => (
                    <a
                      key={i}
                      href={n.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-start gap-2 rounded-md border border-border/30 bg-card/30 px-2 py-1.5 text-[11px] hover:bg-card/50"
                      data-testid={`briefing-news-${i}`}
                    >
                      <ExternalLink className="h-3 w-3 mt-0.5 flex-shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="leading-snug">{n.title}</div>
                        <div className="text-[9px] text-muted-foreground/70">{n.source}</div>
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Health footer */}
            <div className="border-t border-border/30 pt-2">
              <button
                type="button"
                onClick={() => setShowHealth(!showHealth)}
                className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                {showHealth ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
                data sources · {d.panelHealth.filter((p) => p.ok).length}/{d.panelHealth.length} live
              </button>
              {showHealth && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {d.panelHealth.map((p) => (
                    <span
                      key={p.name}
                      className={`text-[9px] rounded border px-1.5 py-0.5 ${p.ok ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400" : "border-rose-500/30 bg-rose-500/5 text-rose-400"}`}
                    >
                      {p.name} {p.ok ? "✓" : "✗"}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
