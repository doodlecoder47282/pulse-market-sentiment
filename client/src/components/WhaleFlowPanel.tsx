// WhaleFlow panel — fresh whale detections, active tracking, closed positions
// API endpoints: /api/flow/preview, /api/flow/followups?status=ACTIVE|TERMINAL

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, TrendingUp, TrendingDown, Target } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WhaleHit {
  symbol: string;
  occ: string;
  type: "C" | "P";
  strike: number;
  expiration: string;
  dte: number;
  volume: number;
  openInterest: number;
  volOiRatio: number;
  isNewStrike: boolean;
  premium: number; // in dollars
  tag: string;
  sentiment: string;
  delta: number;
  detectedAt: string;
  reason: string;
}

interface PreviewByTicker {
  whales: WhaleHit[];
  rejected: { occ: string; reason: string }[];
}

interface FlowPreview {
  source: string;
  byTicker: Record<string, PreviewByTicker>;
  totalWhales: number;
}

interface FollowLive {
  mark: number;
  pctChange: number;
  peakMark: number;
  peakPctChange: number;
  troughMark: number;
  volume: number;
  volumeSinceEntry: number;
  lastUpdateAt: string;
  fadeStreak: number;
  drawdownStreak: number;
  lastVolumeBumpAt: string;
}

interface FollowEntry {
  mark: number;
  premium: number;
  delta: number;
  volume: number;
  openInterest: number;
  detectedAt: string;
}

interface ClosingPrint {
  mark: number;
  pctChange: number;
  peakPctChange: number;
  closedAt: string;
  reason: string;
}

interface FollowPosition {
  occ: string;
  symbol: string;
  type: string;
  strike: number;
  expiration: string;
  side: "BULLISH" | "BEARISH" | "NEUTRAL";
  entry: FollowEntry;
  live: FollowLive;
  status: string;
  statusAt: string;
  closingPrint?: ClosingPrint;
}

interface FollowupsResponse {
  asOf: string;
  total: number;
  byStatus: Record<string, number>;
  positions: FollowPosition[];
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtPremium(dollars: number): string {
  const m = dollars / 1_000_000;
  return `$${m.toFixed(2)}M`;
}

function fmtDelta(d: number): string {
  return d.toFixed(2);
}

function fmtPct(p: number): string {
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(1)}%`;
}

function sentimentColor(s: string): string {
  const u = s.toUpperCase();
  if (u === "BULLISH") return "text-emerald-400";
  if (u === "BEARISH") return "text-red-400";
  return "text-muted-foreground";
}

function statusBadgeClass(status: string): string {
  if (status === "OPEN") return "border-muted-foreground/40 bg-muted/30 text-muted-foreground";
  if (status === "TRIMMING") return "border-amber-500/50 bg-amber-500/10 text-amber-400";
  if (status === "CLOSING") return "border-orange-500/50 bg-orange-500/10 text-orange-400";
  return "border-muted-foreground/40 bg-muted/30 text-muted-foreground";
}

function pctColor(p: number): string {
  return p >= 0 ? "text-emerald-400" : "text-red-400";
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border/40 pb-2 mb-3">
      <span className="text-amber-500">{icon}</span>
      <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
    </div>
  );
}

function WhaleRow({ ticker, hit }: { ticker: string; hit: WhaleHit }) {
  return (
    <div
      className="rounded-md border border-border/30 bg-card/40 px-3 py-2 text-xs space-y-1"
      data-testid={`whale-row-${hit.occ}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold text-foreground text-sm" data-testid={`whale-ticker-${hit.occ}`}>{ticker}</span>
        <span className="font-mono text-muted-foreground" data-testid={`whale-contract-${hit.occ}`}>
          {hit.strike}{hit.type === "C" ? "C" : "P"} {hit.expiration.slice(5)} {hit.dte}d
        </span>
        <span className={`font-semibold ${sentimentColor(hit.sentiment)}`} data-testid={`whale-sentiment-${hit.occ}`}>
          {hit.sentiment}
        </span>
        {hit.isNewStrike ? (
          <Badge variant="outline" className="border-cyan-500/50 bg-cyan-500/10 text-cyan-400 text-[9px]" data-testid={`whale-newstrike-${hit.occ}`}>
            NEW STRIKE
          </Badge>
        ) : (
          <span className="font-mono text-muted-foreground/70" data-testid={`whale-voioi-${hit.occ}`}>
            vol/OI {hit.volOiRatio.toFixed(1)}x
          </span>
        )}
        <span className="ml-auto font-mono font-semibold text-amber-400" data-testid={`whale-premium-${hit.occ}`}>
          {fmtPremium(hit.premium)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
        <span data-testid={`whale-delta-${hit.occ}`}>delta {fmtDelta(hit.delta)}</span>
        <span className="flex-1 min-w-0 truncate italic" data-testid={`whale-reason-${hit.occ}`}>{hit.reason}</span>
      </div>
    </div>
  );
}

function TrackingRow({ pos }: { pos: FollowPosition }) {
  return (
    <div
      className="rounded-md border border-border/30 bg-card/40 px-3 py-2 text-xs space-y-1"
      data-testid={`tracking-row-${pos.occ}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold text-foreground text-sm" data-testid={`tracking-ticker-${pos.occ}`}>{pos.symbol}</span>
        <span className="font-mono text-muted-foreground" data-testid={`tracking-contract-${pos.occ}`}>
          {pos.strike}{pos.type === "C" ? "C" : "P"} {pos.expiration.slice(5)}
        </span>
        <Badge
          variant="outline"
          className={`text-[9px] ${statusBadgeClass(pos.status)}`}
          data-testid={`tracking-status-${pos.occ}`}
        >
          {pos.status}
        </Badge>
        <span className={`font-semibold ${sentimentColor(pos.side)}`} data-testid={`tracking-side-${pos.occ}`}>
          {pos.side}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 font-mono">
        <span className="text-muted-foreground" data-testid={`tracking-entry-${pos.occ}`}>
          entry ${pos.entry.mark.toFixed(2)}
        </span>
        <span data-testid={`tracking-mark-${pos.occ}`}>
          mark ${pos.live.mark.toFixed(2)}
        </span>
        <span className={pctColor(pos.live.pctChange)} data-testid={`tracking-pct-${pos.occ}`}>
          {fmtPct(pos.live.pctChange)}
        </span>
        <span className="text-emerald-400/70" data-testid={`tracking-peak-${pos.occ}`}>
          peak +{pos.live.peakPctChange.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

function ClosedRow({ pos }: { pos: FollowPosition }) {
  const cp = pos.closingPrint;
  return (
    <div
      className="rounded-md border border-border/20 bg-card/20 px-3 py-2 text-xs space-y-1 opacity-80"
      data-testid={`closed-row-${pos.occ}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold text-foreground" data-testid={`closed-ticker-${pos.occ}`}>{pos.symbol}</span>
        <span className="font-mono text-muted-foreground" data-testid={`closed-contract-${pos.occ}`}>
          {pos.strike}{pos.type === "C" ? "C" : "P"} {pos.expiration.slice(5)}
        </span>
        <span className={`font-semibold ${sentimentColor(pos.side)}`} data-testid={`closed-side-${pos.occ}`}>
          {pos.side}
        </span>
        <Badge variant="outline" className="text-[9px] border-muted-foreground/30 text-muted-foreground" data-testid={`closed-status-${pos.occ}`}>
          {pos.status}
        </Badge>
      </div>
      {cp && (
        <div className="flex flex-wrap items-center gap-3 font-mono text-muted-foreground">
          <span className={pctColor(cp.pctChange)} data-testid={`closed-pct-${pos.occ}`}>{fmtPct(cp.pctChange)}</span>
          <span className="text-emerald-400/70" data-testid={`closed-peak-${pos.occ}`}>peak +{cp.peakPctChange.toFixed(1)}%</span>
          <span className="italic truncate flex-1 min-w-0" data-testid={`closed-reason-${pos.occ}`}>{cp.reason}</span>
        </div>
      )}
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export default function WhaleFlowPanel() {
  const previewQuery = useQuery<FlowPreview>({
    queryKey: ["/api/flow/preview"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/flow/preview");
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const activeQuery = useQuery<FollowupsResponse>({
    queryKey: ["/api/flow/followups", "ACTIVE"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/flow/followups?status=ACTIVE");
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const terminalQuery = useQuery<FollowupsResponse>({
    queryKey: ["/api/flow/followups", "TERMINAL"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/flow/followups?status=TERMINAL");
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // Flatten preview whales: byTicker -> flat list of {ticker, hit}
  const freshWhales: { ticker: string; hit: WhaleHit }[] = [];
  if (previewQuery.data?.byTicker) {
    for (const [ticker, data] of Object.entries(previewQuery.data.byTicker)) {
      for (const hit of data.whales) {
        freshWhales.push({ ticker, hit });
      }
    }
  }
  // Sort by premium desc
  freshWhales.sort((a, b) => b.hit.premium - a.hit.premium);

  const trackingPositions = activeQuery.data?.positions ?? [];
  const closedPositions = terminalQuery.data?.positions ?? [];
  const source = previewQuery.data?.source ?? "schwab";

  return (
    <Card className="border-cyan-500/20 bg-gradient-to-br from-card to-cyan-950/5" data-testid="card-whale-flow">
      {/* Header strip */}
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-cyan-400" data-testid="header-whale-flow">
            <Activity className="h-4 w-4" />
            WHALE FLOW
          </CardTitle>
          <span className="text-muted-foreground text-xs" data-testid="whale-flow-tracking-count">
            {trackingPositions.length} tracking
          </span>
          <span className="text-muted-foreground text-xs" data-testid="whale-flow-closed-count">
            {closedPositions.length} closed today
          </span>
          <Badge variant="outline" className="ml-auto border-cyan-500/40 bg-cyan-500/10 text-cyan-400 text-[9px]" data-testid="whale-flow-source">
            {source}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ── FRESH WHALES ── */}
        <section data-testid="section-fresh-whales">
          <SectionHeader icon={<TrendingUp className="h-3.5 w-3.5" />} label="Fresh Whales" />
          {previewQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : freshWhales.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/30 py-4 text-center text-xs text-muted-foreground" data-testid="fresh-whales-empty">
              no fresh whale detections — scan runs every 30s
            </div>
          ) : (
            <div className="space-y-2" data-testid="fresh-whales-list">
              {freshWhales.map(({ ticker, hit }) => (
                <WhaleRow key={hit.occ} ticker={ticker} hit={hit} />
              ))}
            </div>
          )}
        </section>

        {/* ── TRACKING ── */}
        <section data-testid="section-tracking">
          <SectionHeader icon={<Target className="h-3.5 w-3.5" />} label="Tracking" />
          {activeQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : trackingPositions.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/30 py-4 text-center text-xs text-muted-foreground" data-testid="tracking-empty">
              no active positions tracked
            </div>
          ) : (
            <div className="space-y-2" data-testid="tracking-list">
              {trackingPositions.map((pos) => (
                <TrackingRow key={pos.occ} pos={pos} />
              ))}
            </div>
          )}
        </section>

        {/* ── CLOSED ── */}
        <section data-testid="section-closed">
          <SectionHeader icon={<TrendingDown className="h-3.5 w-3.5" />} label="Closed" />
          {terminalQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : closedPositions.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/30 py-4 text-center text-xs text-muted-foreground" data-testid="closed-empty">
              no closed positions today
            </div>
          ) : (
            <div className="space-y-2" data-testid="closed-list">
              {closedPositions.map((pos) => (
                <ClosedRow key={pos.occ} pos={pos} />
              ))}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
