// TickerOutlookCard.tsx
// Bottom-of-chart card for the active ticker. Fuses news + social + positioning
// into a verdict (provider tag — anthropic / openai / deterministic) with R:R,
// Kelly, invalidation, and three-path scenarios. Click triggered: only renders
// when a ticker is selected on the Chart tab.
//
// Locked rules: no localStorage, no emojis, peer-to-peer voice, no "scrape".
// Apparels TanStack v5 object form + array query keys + apiRequest.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

type Direction = "BULL" | "BEAR" | "NEUTRAL";

interface OutlookVerdict {
  direction: Direction;
  confidence: number;
  targetPrice: number | null;
  expectedMovePct: number | null;
  rr: number | null;
  kellyFrac: number;
  invalidation: number | null;
  edgeType: "informational" | "analytical" | "behavioral" | "environmental" | "none";
  counterargument: string;
  thesis: string;
  scenarios: {
    bull: { prob: number; targetPct: number; thesis: string };
    base: { prob: number; targetPct: number; thesis: string };
    bear: { prob: number; targetPct: number; thesis: string };
  };
  triggers: string[];
  provider?: "anthropic" | "openai" | "deterministic";
}

interface PivotLevel {
  label: string;
  source: string;
  price: number;
  confluence: number;
  stackedWith: string[];
  distPct: number;
  side: "above" | "below";
  tier: "major" | "minor";
}

interface AlphaEvent {
  id: string;
  ts: number;
  title: string;
  source: string;
  url: string;
  tier: "TIER_1" | "TIER_2" | "SENTIMENT_SHIFT";
  alphaScore: number;
  initialBias: "BULL" | "BEAR" | "NEUTRAL";
}

interface SocialPost {
  source: "stocktwits" | "reddit" | "x";
  text: string;
  url?: string;
  tone: "bullish" | "bearish" | "neutral";
  ts: number;
}

interface TickerOutlookResponse {
  ticker: string;
  asOf: string;
  spot: number | null;
  verdict: OutlookVerdict;
  alpha: {
    ticker: string;
    asOf: string;
    news: { events: AlphaEvent[]; warnings: string[] };
    social: {
      score: number;
      messageCount: number;
      volumeZ: number;
      bySource: { stocktwits: number; reddit: number; x: number };
      topPosts: SocialPost[];
    };
    positioning: {
      spot: number | null;
      totalGex: number | null;
      regime: "positive" | "negative" | "unknown";
      callWall: number | null;
      putWall: number | null;
      gammaFlip: number | null;
      pcrOi: number | null;
      pcrVol: number | null;
      ivSkew25d: number | null;
      atmIv: number | null;
      distToCallWallPct: number | null;
      distToPutWallPct: number | null;
    };
    rollup: {
      newsBias: number;
      socialBias: number;
      positioningBias: number;
      composite: number;
      edgeType: "informational" | "analytical" | "behavioral" | "environmental" | "none";
    };
  };
  pivots: { spot: number; levels: PivotLevel[] } | null;
  warnings: string[];
}

function dirColor(d: Direction): string {
  if (d === "BULL") return "text-emerald-300 border-emerald-500/40 bg-emerald-500/10";
  if (d === "BEAR") return "text-rose-300 border-rose-500/40 bg-rose-500/10";
  return "text-amber-300 border-amber-500/40 bg-amber-500/10";
}

function tierBadge(tier: AlphaEvent["tier"]): string {
  if (tier === "TIER_1") return "bg-cyan-500/20 text-cyan-300 border-cyan-500/40";
  if (tier === "TIER_2") return "bg-violet-500/20 text-violet-300 border-violet-500/40";
  return "bg-amber-500/20 text-amber-300 border-amber-500/40";
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtMoney(n: number | null | undefined, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtGex(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(0);
}

export default function TickerOutlookCard({ ticker }: { ticker: string }) {
  const [expanded, setExpanded] = useState(true);
  const enabled = !!ticker && ticker.trim().length > 0;
  const q = useQuery<TickerOutlookResponse>({
    queryKey: ["/api/ticker-outlook", ticker],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/ticker-outlook?symbol=${encodeURIComponent(ticker)}`);
      return r.json();
    },
    enabled,
    staleTime: 90_000,
    refetchInterval: 120_000,
  });

  const sortedPivots = useMemo(() => {
    if (!q.data?.pivots) return [];
    return [...q.data.pivots.levels]
      .sort((a, b) => b.confluence - a.confluence || Math.abs(a.distPct) - Math.abs(b.distPct))
      .slice(0, 6);
  }, [q.data]);

  if (!enabled) return null;

  return (
    <div
      className="mt-3 rounded-lg border border-border/40 bg-card/40 p-3"
      data-testid="card-ticker-outlook"
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3"
        data-testid="button-toggle-outlook"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            single-name outlook
          </span>
          <span className="font-mono text-sm font-bold text-foreground">{ticker}</span>
          {q.data?.verdict && (
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${dirColor(
                q.data.verdict.direction,
              )}`}
              data-testid="badge-direction"
            >
              {q.data.verdict.direction} · {q.data.verdict.confidence}%
            </span>
          )}
          {q.data?.verdict?.edgeType && q.data.verdict.edgeType !== "none" && (
            <span
              className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground"
              data-testid="badge-edge-type"
            >
              {q.data.verdict.edgeType}
            </span>
          )}
          {q.data?.verdict?.provider && (
            <span
              className="rounded border border-border/60 bg-muted/20 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground"
              data-testid="badge-provider"
            >
              {q.data.verdict.provider}
            </span>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground">{expanded ? "hide" : "show"}</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {q.isLoading && !q.data && (
            <div className="flex h-16 items-center justify-center text-xs text-muted-foreground">
              building outlook…
            </div>
          )}
          {q.isError && (
            <div className="rounded border border-rose-500/40 bg-rose-500/5 p-2 text-xs text-rose-300">
              Failed to build outlook for {ticker}. {(q.error as any)?.message ?? ""}
            </div>
          )}
          {q.data && (
            <>
              {/* Key levels strip */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <KV label="spot" value={fmtMoney(q.data.spot)} />
                <KV
                  label="target"
                  value={fmtMoney(q.data.verdict.targetPrice)}
                  hint={
                    q.data.verdict.expectedMovePct != null
                      ? `${q.data.verdict.expectedMovePct >= 0 ? "+" : ""}${q.data.verdict.expectedMovePct.toFixed(2)}%`
                      : undefined
                  }
                />
                <KV
                  label="invalidation"
                  value={fmtMoney(q.data.verdict.invalidation)}
                  hint={
                    q.data.verdict.rr != null ? `R:R ${q.data.verdict.rr.toFixed(2)}x` : undefined
                  }
                />
                <KV
                  label="kelly"
                  value={`${(q.data.verdict.kellyFrac * 100).toFixed(1)}%`}
                  hint="quarter-Kelly"
                />
              </div>

              {/* Thesis + counter */}
              <div className="rounded border border-border/40 bg-muted/10 p-2 text-xs">
                <div className="text-foreground" data-testid="text-thesis">
                  {q.data.verdict.thesis}
                </div>
                <div className="mt-1 text-muted-foreground" data-testid="text-counter">
                  <span className="text-[9px] font-semibold uppercase tracking-wider">counter:</span>{" "}
                  {q.data.verdict.counterargument}
                </div>
              </div>

              {/* Scenarios */}
              <div className="grid grid-cols-3 gap-2">
                <ScenarioBar label="bull" color="emerald" s={q.data.verdict.scenarios.bull} />
                <ScenarioBar label="base" color="slate" s={q.data.verdict.scenarios.base} />
                <ScenarioBar label="bear" color="rose" s={q.data.verdict.scenarios.bear} />
              </div>

              {/* Positioning row */}
              <div className="rounded border border-border/40 bg-muted/10 p-2">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  positioning
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-6">
                  <KV
                    label="regime"
                    value={q.data.alpha.positioning.regime}
                    valueClass={
                      q.data.alpha.positioning.regime === "positive"
                        ? "text-emerald-300"
                        : q.data.alpha.positioning.regime === "negative"
                        ? "text-rose-300"
                        : ""
                    }
                  />
                  <KV label="net gex" value={`$${fmtGex(q.data.alpha.positioning.totalGex)}`} />
                  <KV label="call wall" value={fmtMoney(q.data.alpha.positioning.callWall)} />
                  <KV label="put wall" value={fmtMoney(q.data.alpha.positioning.putWall)} />
                  <KV label="gamma flip" value={fmtMoney(q.data.alpha.positioning.gammaFlip)} />
                  <KV
                    label="iv skew"
                    value={
                      q.data.alpha.positioning.ivSkew25d != null
                        ? `${(q.data.alpha.positioning.ivSkew25d * 100).toFixed(1)}pp`
                        : "—"
                    }
                  />
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-2 text-xs">
                  <KV
                    label="pcr oi"
                    value={
                      q.data.alpha.positioning.pcrOi != null
                        ? q.data.alpha.positioning.pcrOi.toFixed(2)
                        : "—"
                    }
                  />
                  <KV
                    label="pcr vol"
                    value={
                      q.data.alpha.positioning.pcrVol != null
                        ? q.data.alpha.positioning.pcrVol.toFixed(2)
                        : "—"
                    }
                  />
                  <KV
                    label="atm iv"
                    value={
                      q.data.alpha.positioning.atmIv != null
                        ? `${(q.data.alpha.positioning.atmIv * 100).toFixed(1)}%`
                        : "—"
                    }
                  />
                </div>
              </div>

              {/* Two-column: news + social */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {/* News */}
                <div className="rounded border border-border/40 bg-muted/10 p-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      alpha news ({q.data.alpha.news.events.length})
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      bias {q.data.alpha.rollup.newsBias > 0 ? "+" : ""}
                      {q.data.alpha.rollup.newsBias}
                    </div>
                  </div>
                  {q.data.alpha.news.events.length === 0 && (
                    <div className="text-xs text-muted-foreground">
                      no tagged events in window
                    </div>
                  )}
                  <ul className="space-y-1.5">
                    {q.data.alpha.news.events.slice(0, 5).map((e) => (
                      <li key={e.id} className="text-xs" data-testid={`news-event-${e.id}`}>
                        <div className="flex items-start gap-1.5">
                          <span
                            className={`mt-0.5 shrink-0 rounded border px-1 py-0 font-mono text-[9px] uppercase tracking-wider ${tierBadge(
                              e.tier,
                            )}`}
                          >
                            {e.tier === "SENTIMENT_SHIFT" ? "shift" : e.tier.replace("TIER_", "T")}
                          </span>
                          <a
                            href={e.url}
                            target="_blank"
                            rel="noreferrer"
                            className="line-clamp-2 flex-1 text-foreground hover:text-cyan-300"
                          >
                            {e.title}
                          </a>
                        </div>
                        <div className="mt-0.5 ml-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span>{e.source}</span>
                          <span>· {ago(e.ts * 1000)} ago</span>
                          <span>· score {e.alphaScore}</span>
                          <span
                            className={
                              e.initialBias === "BULL"
                                ? "text-emerald-300"
                                : e.initialBias === "BEAR"
                                ? "text-rose-300"
                                : ""
                            }
                          >
                            · {e.initialBias.toLowerCase()}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Social */}
                <div className="rounded border border-border/40 bg-muted/10 p-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      social exposure
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                      <span>tone {q.data.alpha.social.score > 0 ? "+" : ""}{q.data.alpha.social.score}</span>
                      <span>· {q.data.alpha.social.messageCount} msgs</span>
                      {q.data.alpha.social.volumeZ >= 1 && (
                        <span className="text-amber-300">
                          · vol z{q.data.alpha.social.volumeZ.toFixed(1)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mb-1.5 grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
                    <KV label="stocktwits" value={String(q.data.alpha.social.bySource.stocktwits ?? 0)} />
                    <KV label="reddit" value={String(q.data.alpha.social.bySource.reddit ?? 0)} />
                    <KV label="x" value={String(q.data.alpha.social.bySource.x ?? 0)} />
                  </div>
                  <ul className="space-y-1">
                    {q.data.alpha.social.topPosts.slice(0, 3).map((p, i) => (
                      <li key={i} className="text-xs" data-testid={`social-post-${i}`}>
                        <div className="flex items-start gap-1.5">
                          <span
                            className={`shrink-0 rounded border border-border/40 px-1 py-0 font-mono text-[9px] uppercase tracking-wider ${
                              p.tone === "bullish"
                                ? "text-emerald-300"
                                : p.tone === "bearish"
                                ? "text-rose-300"
                                : "text-muted-foreground"
                            }`}
                          >
                            {p.source}
                          </span>
                          <span className="line-clamp-2 text-foreground/90">{p.text}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Pivot magnet ladder */}
              {sortedPivots.length > 0 && (
                <div className="rounded border border-border/40 bg-muted/10 p-2">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    pivot magnets · top {sortedPivots.length}
                  </div>
                  <div className="space-y-1">
                    {sortedPivots.map((l, i) => (
                      <div
                        key={`${l.label}-${i}`}
                        className="flex items-center justify-between gap-2 text-xs"
                        data-testid={`pivot-${l.label}`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded border px-1 py-0 font-mono text-[9px] uppercase tracking-wider ${
                              l.tier === "major"
                                ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-300"
                                : "border-border/60 bg-muted/30 text-muted-foreground"
                            }`}
                          >
                            {l.label}
                          </span>
                          {l.confluence > 1 && (
                            <span className="font-mono text-[9px] text-amber-300">
                              x{l.confluence}
                            </span>
                          )}
                          {l.stackedWith.length > 0 && (
                            <span className="text-[10px] text-muted-foreground">
                              + {l.stackedWith.join(", ")}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 font-mono tabular-nums">
                          <span className="text-foreground">{fmtMoney(l.price)}</span>
                          <span
                            className={
                              l.distPct >= 0 ? "text-emerald-300/80" : "text-rose-300/80"
                            }
                          >
                            {l.distPct >= 0 ? "+" : ""}
                            {l.distPct.toFixed(2)}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Triggers */}
              {q.data.verdict.triggers.length > 0 && (
                <div className="rounded border border-border/40 bg-muted/10 p-2">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    triggers
                  </div>
                  <ul className="space-y-0.5 text-xs text-foreground/90">
                    {q.data.verdict.triggers.map((t, i) => (
                      <li key={i} className="flex items-start gap-1.5" data-testid={`trigger-${i}`}>
                        <span className="mt-0.5 text-muted-foreground">›</span>
                        <span>{t}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {q.data.warnings.length > 0 && (
                <div className="text-[10px] text-amber-300/80">
                  warnings: {q.data.warnings.join(" · ")}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function KV({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`font-mono text-sm tabular-nums ${valueClass ?? ""}`}>{value}</div>
      {hint && <div className="text-[9px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function ScenarioBar({
  label,
  color,
  s,
}: {
  label: string;
  color: "emerald" | "slate" | "rose";
  s: { prob: number; targetPct: number; thesis: string };
}) {
  const colorMap = {
    emerald: "bg-emerald-500/20 border-emerald-500/40 text-emerald-300",
    slate: "bg-muted/40 border-border/60 text-foreground",
    rose: "bg-rose-500/20 border-rose-500/40 text-rose-300",
  };
  const fillMap = {
    emerald: "bg-emerald-500/40",
    slate: "bg-muted/60",
    rose: "bg-rose-500/40",
  };
  return (
    <div className={`rounded border p-2 ${colorMap[color]}`} data-testid={`scenario-${label}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider">{label}</span>
        <span className="font-mono text-xs font-bold tabular-nums">{s.prob}%</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/30">
        <div
          className={`h-full ${fillMap[color]}`}
          style={{ width: `${Math.min(100, Math.max(0, s.prob))}%` }}
        />
      </div>
      <div className="mt-1 font-mono text-[11px] tabular-nums">
        {s.targetPct >= 0 ? "+" : ""}
        {s.targetPct.toFixed(2)}%
      </div>
      <div className="mt-1 line-clamp-2 text-[10px] opacity-80">{s.thesis}</div>
    </div>
  );
}
