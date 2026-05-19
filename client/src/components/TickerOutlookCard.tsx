// TickerOutlookCard.tsx
//
// HERO single-name outlook card — appears at the bottom of the Chart tab when
// a ticker is selected. Restructured for the overnight build:
//
//   1. AI HEADLINE: huge verdict (BULL/BEAR/NEUTRAL) + confidence + edge type +
//      a single plain-English thesis sentence (15-year-old reading level).
//   2. CATALYSTS ROW: next earnings (date, days-out, EPS est, IV expected move
//      if available), closest macro events (FOMC/CPI/NFP/OPEX). This is the
//      first thing under the headline so users see what's coming.
//   3. KEY LEVELS: target / invalidation / R:R / Kelly.
//   4. 60-DAY FORWARD PROJECTION: realized-vol cone chart (q10/q25/q50/q75/q90)
//      with spot, target, and invalidation overlaid. Honest — not an ML model.
//   5. SCENARIOS: bull/base/bear with probability bars.
//   6. POSITIONING: gamma walls, GEX, IV skew, max pain.
//   7. NEWS + SOCIAL: stacked side-by-side on desktop, stacked vertically on
//      mobile. Tier badges. Click-through to source.
//   8. PIVOT MAGNETS + TRIGGERS.
//
// Locked rules: no localStorage, no emojis, peer-to-peer voice, no "scrape".
// TanStack v5 object form + array query keys + apiRequest.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from "recharts";

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
  source: "stocktwits" | "reddit" | "x" | string;
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
      bySource?: { stocktwits: number; reddit: number; x: number };
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
      edgeType: OutlookVerdict["edgeType"];
    };
  };
  pivots: { spot: number; levels: PivotLevel[] } | null;
  warnings: string[];
}

interface TickerCalendarResponse {
  ticker: string;
  asOf: string;
  nextEarnings: {
    date: string;
    daysOut: number;
    timing: string;
    timingLabel: string;
    fiscalQuarter: string;
    epsForecast: number | null;
    lastYearEps: number | null;
    numEstimates: number | null;
    importance: "HIGH" | "MED" | "LOW";
    isMag7: boolean;
  } | null;
  macro: Array<{
    date: string;
    daysOut: number;
    label: string;
    importance: "HIGH" | "MED" | "LOW";
    category: "macro" | "fed" | "opex" | "earnings_macro";
  }>;
  warnings: string[];
}

interface TickerProjectionResponse {
  symbol: string;
  spot: number;
  sessionsForward: number;
  sigmaDaily: number;
  sigmaAnnualizedPct: number;
  driftDaily: number;
  volBlowupFactor: number;
  bands: Array<{
    day: number;
    date: string;
    q10: number;
    q25: number;
    q50: number;
    q75: number;
    q90: number;
  }>;
  honestyNote: string;
}

interface EarningsIvResponse {
  ticker: string;
  expectedMoveAbs?: number;
  expectedMovePct?: number;
  expiry?: string;
  warnings?: string[];
}

// ────────────────────── helpers ──────────────────────

function dirGradient(d: Direction): string {
  if (d === "BULL") return "from-emerald-500/30 via-emerald-500/10 to-transparent";
  if (d === "BEAR") return "from-rose-500/30 via-rose-500/10 to-transparent";
  return "from-amber-500/30 via-amber-500/10 to-transparent";
}

function dirText(d: Direction): string {
  if (d === "BULL") return "text-emerald-300";
  if (d === "BEAR") return "text-rose-300";
  return "text-amber-300";
}

function dirBorder(d: Direction): string {
  if (d === "BULL") return "border-emerald-500/50";
  if (d === "BEAR") return "border-rose-500/50";
  return "border-amber-500/50";
}

function tierBadge(tier: AlphaEvent["tier"]): string {
  if (tier === "TIER_1") return "bg-cyan-500/20 text-cyan-300 border-cyan-500/40";
  if (tier === "TIER_2") return "bg-violet-500/20 text-violet-300 border-violet-500/40";
  return "bg-amber-500/20 text-amber-300 border-amber-500/40";
}

function importanceColor(i: "HIGH" | "MED" | "LOW"): string {
  if (i === "HIGH") return "border-rose-500/50 bg-rose-500/15 text-rose-200";
  if (i === "MED") return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  return "border-border/60 bg-muted/30 text-muted-foreground";
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

function plainEnglishThesis(v: OutlookVerdict, ticker: string, calendar: TickerCalendarResponse | undefined): string {
  // 15-year-old reading level summary. Always one sentence, blunt.
  const dirWord = v.direction === "BULL" ? "going up" : v.direction === "BEAR" ? "going down" : "stuck sideways";
  const conf =
    v.confidence >= 70 ? "high-confidence" :
    v.confidence >= 55 ? "lean" :
    v.confidence >= 45 ? "low-conviction" : "no edge";
  const ern = calendar?.nextEarnings;
  const ernNote = ern && ern.daysOut <= 7
    ? ` Earnings in ${ern.daysOut}d — sizing should respect that.`
    : "";
  const target = v.targetPrice != null ? ` toward ${fmtMoney(v.targetPrice)}` : "";
  const stop = v.invalidation != null ? `, kill thesis below ${fmtMoney(v.invalidation)}` : "";
  return `${ticker} is a ${conf} ${dirWord} call${target}${stop}.${ernNote}`;
}

// ────────────────────── component ──────────────────────

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

  const cal = useQuery<TickerCalendarResponse>({
    queryKey: ["/api/ticker-calendar", ticker],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/ticker-calendar?symbol=${encodeURIComponent(ticker)}`);
      return r.json();
    },
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });

  const proj = useQuery<TickerProjectionResponse>({
    queryKey: ["/api/ticker-projection", ticker, 60],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/ticker-projection?symbol=${encodeURIComponent(ticker)}&days=60`);
      return r.json();
    },
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
  });

  // IV expected move — lazy, only fires if there's an upcoming earnings
  const hasEarnings = !!cal.data?.nextEarnings;
  const ivMove = useQuery<EarningsIvResponse>({
    queryKey: ["/api/earnings-iv", ticker],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/earnings-iv?ticker=${encodeURIComponent(ticker)}`);
      return r.json();
    },
    enabled: enabled && hasEarnings,
    staleTime: 10 * 60_000,
  });

  const sortedPivots = useMemo(() => {
    if (!q.data?.pivots) return [];
    return [...q.data.pivots.levels]
      .sort((a, b) => b.confluence - a.confluence || Math.abs(a.distPct) - Math.abs(b.distPct))
      .slice(0, 6);
  }, [q.data]);

  // Build chart data — anchor with current spot at day 0
  const chartData = useMemo(() => {
    if (!proj.data?.bands?.length) return [];
    const spot = proj.data.spot;
    const rows: Array<{
      day: number;
      date: string;
      q10: number;
      q25: number;
      q50: number;
      q75: number;
      q90: number;
      band_lo: number;   // q10 absolute
      band_hi_inner: number; // q25 - q10 stack
      band_mid_inner: number; // q75 - q25 stack (the inner box)
      band_hi_outer: number;  // q90 - q75 stack
    }>[] = [] as any;
    const out: any[] = [];
    out.push({
      day: 0,
      date: "now",
      q10: spot, q25: spot, q50: spot, q75: spot, q90: spot,
    });
    for (const b of proj.data.bands) {
      out.push({
        day: b.day,
        date: b.date,
        q10: b.q10,
        q25: b.q25,
        q50: b.q50,
        q75: b.q75,
        q90: b.q90,
      });
    }
    return out;
  }, [proj.data]);

  if (!enabled) return null;

  const v = q.data?.verdict;
  const dir: Direction = v?.direction ?? "NEUTRAL";

  return (
    <div
      className="mt-3 overflow-hidden rounded-xl border border-border/60 bg-card/60 shadow-lg"
      data-testid="card-ticker-outlook"
    >
      {/* ────── HERO HEADLINE ────── */}
      <button
        onClick={() => setExpanded((x) => !x)}
        className={`relative w-full bg-gradient-to-br ${dirGradient(dir)} p-4 text-left transition-colors hover:bg-opacity-90`}
        data-testid="button-toggle-outlook"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                ai outlook
              </span>
              <span className="font-mono text-base font-bold text-foreground">{ticker}</span>
              {q.data?.spot != null && (
                <span className="font-mono text-xs text-muted-foreground">
                  ${fmtMoney(q.data.spot)}
                </span>
              )}
              {v?.provider && (
                <span className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  {v.provider}
                </span>
              )}
            </div>

            {v && (
              <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span
                  className={`font-mono text-3xl font-black tracking-tight sm:text-4xl ${dirText(dir)}`}
                  data-testid="text-headline-direction"
                >
                  {v.direction}
                </span>
                <span className="font-mono text-2xl font-bold text-foreground">
                  {v.confidence}%
                </span>
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  confidence
                </span>
                {v.edgeType && v.edgeType !== "none" && (
                  <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${dirBorder(dir)} ${dirText(dir)}`}>
                    {v.edgeType} edge
                  </span>
                )}
              </div>
            )}

            {v && (
              <p
                className="mt-2 max-w-3xl text-sm font-medium leading-snug text-foreground/90"
                data-testid="text-plain-thesis"
              >
                {plainEnglishThesis(v, ticker, cal.data)}
              </p>
            )}
          </div>

          <span className="shrink-0 rounded border border-border/60 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {expanded ? "hide" : "show"}
          </span>
        </div>

        {/* CATALYSTS — earnings + macro in the hero */}
        {(cal.data?.nextEarnings || (cal.data?.macro?.length ?? 0) > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {cal.data?.nextEarnings && (
              <div
                className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px] ${importanceColor(cal.data.nextEarnings.importance)}`}
                data-testid="catalyst-earnings"
              >
                <span className="font-mono font-bold uppercase tracking-wider">earnings</span>
                <span className="text-foreground">
                  {cal.data.nextEarnings.date} · {cal.data.nextEarnings.timingLabel}
                </span>
                <span className="font-mono">
                  {cal.data.nextEarnings.daysOut}d out
                </span>
                {cal.data.nextEarnings.epsForecast != null && (
                  <span className="font-mono text-foreground/70">
                    EPS est ${cal.data.nextEarnings.epsForecast.toFixed(2)}
                  </span>
                )}
                {ivMove.data?.expectedMovePct != null && (
                  <span className="font-mono text-foreground/70">
                    · IV ±{ivMove.data.expectedMovePct.toFixed(1)}%
                  </span>
                )}
              </div>
            )}
            {cal.data?.macro?.map((m) => (
              <div
                key={m.date + m.label}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${importanceColor(m.importance)}`}
                data-testid={`catalyst-macro-${m.label}`}
              >
                <span className="font-mono uppercase tracking-wider">{m.label}</span>
                <span className="font-mono opacity-80">{m.daysOut}d</span>
              </div>
            ))}
          </div>
        )}
      </button>

      {expanded && (
        <div className="space-y-3 p-3 sm:p-4">
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

          {q.data && v && (
            <>
              {/* Key levels strip */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <KV label="spot" value={fmtMoney(q.data.spot)} />
                <KV
                  label="target"
                  value={fmtMoney(v.targetPrice)}
                  hint={
                    v.expectedMovePct != null
                      ? `${v.expectedMovePct >= 0 ? "+" : ""}${v.expectedMovePct.toFixed(2)}%`
                      : undefined
                  }
                />
                <KV
                  label="invalidation"
                  value={fmtMoney(v.invalidation)}
                  hint={v.rr != null ? `R:R ${v.rr.toFixed(2)}x` : undefined}
                />
                <KV
                  label="kelly"
                  value={`${(v.kellyFrac * 100).toFixed(1)}%`}
                  hint="quarter-Kelly"
                />
              </div>

              {/* 60-day forward projection cone */}
              <div className="rounded-lg border border-border/40 bg-muted/10 p-2 sm:p-3">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      60-session forward cone
                    </span>
                    {proj.data && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        σ {proj.data.sigmaAnnualizedPct.toFixed(1)}% ann · vol×{proj.data.volBlowupFactor.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                    realized vol · not ML
                  </span>
                </div>
                {proj.isLoading && (
                  <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
                    building cone…
                  </div>
                )}
                {proj.isError && (
                  <div className="text-[11px] text-amber-300/80">
                    cone unavailable: {(proj.error as any)?.message ?? "unknown"}
                  </div>
                )}
                {proj.data && chartData.length > 0 && (
                  <div className="h-44 sm:h-56" data-testid="chart-projection">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                        <CartesianGrid stroke="rgba(255,255,255,0.04)" strokeDasharray="3 3" />
                        <XAxis
                          dataKey="day"
                          stroke="rgba(255,255,255,0.4)"
                          fontSize={9}
                          tickLine={false}
                          ticks={[0, 10, 20, 30, 40, 50, 60]}
                          tickFormatter={(d: number) => d === 0 ? "now" : `+${d}d`}
                        />
                        <YAxis
                          stroke="rgba(255,255,255,0.4)"
                          fontSize={9}
                          tickLine={false}
                          width={40}
                          domain={[(min: number) => min * 0.96, (max: number) => max * 1.04]}
                          tickFormatter={(n: number) => n.toFixed(0)}
                        />
                        <Tooltip
                          contentStyle={{ background: "rgba(15,15,20,0.95)", border: "1px solid rgba(255,255,255,0.15)", fontSize: 11 }}
                          labelStyle={{ color: "rgba(255,255,255,0.7)" }}
                          formatter={(val: any, name: string) => [`$${Number(val).toFixed(2)}`, name]}
                          labelFormatter={(d: number) => d === 0 ? "today" : `+${d} sessions`}
                        />
                        {/* 80% band: q10-q90 outer */}
                        <Area dataKey="q90" stroke="none" fill={dir === "BULL" ? "#10b98140" : dir === "BEAR" ? "#f43f5e40" : "#f59e0b40"} fillOpacity={0.18} isAnimationActive={false} />
                        <Area dataKey="q10" stroke="none" fill="#0a0a0a" fillOpacity={1} isAnimationActive={false} />
                        {/* 50% band: q25-q75 inner */}
                        <Area dataKey="q75" stroke="none" fill={dir === "BULL" ? "#10b98180" : dir === "BEAR" ? "#f43f5e80" : "#f59e0b80"} fillOpacity={0.30} isAnimationActive={false} />
                        <Area dataKey="q25" stroke="none" fill="#0a0a0a" fillOpacity={1} isAnimationActive={false} />
                        {/* drift median */}
                        <Line type="monotone" dataKey="q50" stroke={dir === "BULL" ? "#10b981" : dir === "BEAR" ? "#f43f5e" : "#f59e0b"} strokeWidth={2} dot={false} isAnimationActive={false} />
                        {/* target / invalidation */}
                        {v.targetPrice != null && (
                          <ReferenceLine
                            y={v.targetPrice}
                            stroke="#22d3ee"
                            strokeDasharray="3 3"
                            label={{ value: `target ${fmtMoney(v.targetPrice)}`, position: "right", fill: "#22d3ee", fontSize: 9 }}
                          />
                        )}
                        {v.invalidation != null && (
                          <ReferenceLine
                            y={v.invalidation}
                            stroke="#f59e0b"
                            strokeDasharray="3 3"
                            label={{ value: `stop ${fmtMoney(v.invalidation)}`, position: "right", fill: "#f59e0b", fontSize: 9 }}
                          />
                        )}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {proj.data && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className={`inline-block h-2 w-3 rounded-sm ${dir === "BULL" ? "bg-emerald-500/60" : dir === "BEAR" ? "bg-rose-500/60" : "bg-amber-500/60"}`} />
                      50% band (q25–q75)
                    </span>
                    <span className="flex items-center gap-1">
                      <span className={`inline-block h-2 w-3 rounded-sm ${dir === "BULL" ? "bg-emerald-500/25" : dir === "BEAR" ? "bg-rose-500/25" : "bg-amber-500/25"}`} />
                      80% band (q10–q90)
                    </span>
                    <span className="opacity-70">drift dampened 0.5x</span>
                  </div>
                )}
              </div>

              {/* Thesis + counter (detailed) */}
              <div className="rounded border border-border/40 bg-muted/10 p-2 text-xs">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  detailed thesis
                </div>
                <div className="mt-0.5 text-foreground" data-testid="text-thesis">
                  {v.thesis}
                </div>
                <div className="mt-1.5 text-muted-foreground" data-testid="text-counter">
                  <span className="text-[9px] font-semibold uppercase tracking-wider">counter:</span>{" "}
                  {v.counterargument}
                </div>
              </div>

              {/* Scenarios */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <ScenarioBar label="bull" color="emerald" s={v.scenarios.bull} />
                <ScenarioBar label="base" color="slate" s={v.scenarios.base} />
                <ScenarioBar label="bear" color="rose" s={v.scenarios.bear} />
              </div>

              {/* Positioning row */}
              <div className="rounded border border-border/40 bg-muted/10 p-2">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  positioning
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 md:grid-cols-6">
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
                <div className="mt-1.5 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                  <KV
                    label="pcr oi"
                    value={q.data.alpha.positioning.pcrOi != null ? q.data.alpha.positioning.pcrOi.toFixed(2) : "—"}
                  />
                  <KV
                    label="pcr vol"
                    value={q.data.alpha.positioning.pcrVol != null ? q.data.alpha.positioning.pcrVol.toFixed(2) : "—"}
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

              {/* News + Social */}
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
                            className={`mt-0.5 shrink-0 rounded border px-1 py-0 font-mono text-[9px] uppercase tracking-wider ${tierBadge(e.tier)}`}
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
                    <KV label="stocktwits" value={String(q.data.alpha.social.bySource?.stocktwits ?? 0)} />
                    <KV label="reddit" value={String(q.data.alpha.social.bySource?.reddit ?? 0)} />
                    <KV label="x" value={String(q.data.alpha.social.bySource?.x ?? 0)} />
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
              {v.triggers.length > 0 && (
                <div className="rounded border border-border/40 bg-muted/10 p-2">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    triggers
                  </div>
                  <ul className="space-y-0.5 text-xs text-foreground/90">
                    {v.triggers.map((t, i) => (
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
