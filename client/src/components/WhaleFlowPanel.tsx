// WhaleFlowPanel — surgical whale prints + UOA clusters, all collapsible.
// Ticker rows roll up by default; click to expand for full contract context.
// Backend gate is the source of truth — NO adjusters in this panel.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, TrendingUp, TrendingDown, Target, ChevronDown, ChevronRight, Zap } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

// CONFLUX context: keys present in BOTH whale list AND UOA list at the same time.
// Format: `${symbol}-${type}-${strike}-${expiration}`.
// The convergence is the highest-conviction setup the system can produce.
import { createContext, useContext } from "react";
const ConfluxContext = createContext<Set<string>>(new Set());
const confluxKey = (s: string, t: string, k: number, e: string) => `${s}-${t}-${k}-${e}`;

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
  premium: number;
  tag: string;
  sentiment: string;
  delta: number;
  detectedAt: string;
  reason: string;
  // extended
  bid?: number;
  ask?: number;
  mid?: number;
  spreadPct?: number;
  iv?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  spot?: number | null;
  distFromSpotPct?: number;
  breakeven?: number;
  breakevenPct?: number;
}

interface PreviewByTicker {
  whales: WhaleHit[];
  rejected: { occ: string; reason: string }[];
}

interface FlowPreview {
  source: string;
  byTicker: Record<string, PreviewByTicker>;
  totalWhales: number;
  config: {
    premiumFloor: number;
    volOiRatio: number;
    minDte: number;
    maxDte: number;
    requiredTag: string;
  };
}

interface UoaCluster {
  key: string;
  symbol: string;
  type: "C" | "P";
  strike: number;
  expiration: string;
  dte: number;
  bucket: "MEGA" | "LARGE" | "MID" | "SMALL" | "MICRO";
  hitCount: number;
  totalPremium: number;
  totalVolume: number;
  avgVolOiRatio: number;
  avgDelta: number;
  avgIv: number;
  bid: number;
  ask: number;
  mid: number;
  spreadPct: number;
  spot: number | null;
  distFromSpotPct?: number;
  breakeven: number;
  breakevenPct?: number;
  sentiment: string;
  fired: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  firedAt?: number;
  reason: string;
}

interface UoaSnapshot {
  asOf: number;
  totalClusters: number;
  firedClusters: number;
  byTicker: Record<string, UoaCluster[]>;
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

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtPrem(d: number): string {
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(2)}M`;
  return `$${(d / 1_000).toFixed(0)}K`;
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
function pctColor(p: number): string {
  return p >= 0 ? "text-emerald-400" : "text-red-400";
}
function statusBadgeClass(status: string): string {
  if (status === "OPEN") return "border-muted-foreground/40 bg-muted/30 text-muted-foreground";
  if (status === "TRIMMING") return "border-amber-500/50 bg-amber-500/10 text-amber-400";
  if (status === "CLOSING") return "border-orange-500/50 bg-orange-500/10 text-orange-400";
  return "border-muted-foreground/40 bg-muted/30 text-muted-foreground";
}
function bucketBadge(b: string): string {
  if (b === "MEGA")  return "border-violet-500/50 bg-violet-500/10 text-violet-300";
  if (b === "LARGE") return "border-cyan-500/50 bg-cyan-500/10 text-cyan-300";
  if (b === "MID")   return "border-amber-500/50 bg-amber-500/10 text-amber-300";
  if (b === "SMALL") return "border-orange-500/50 bg-orange-500/10 text-orange-300";
  return "border-muted-foreground/40 bg-muted/30 text-muted-foreground";
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SectionHeader({ icon, label, count }: { icon: React.ReactNode; label: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 border-b border-border/40 pb-2 mb-3">
      <span className="text-amber-500">{icon}</span>
      <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      {count !== undefined && (
        <Badge variant="outline" className="ml-auto text-[9px] border-muted-foreground/40 text-muted-foreground" data-testid={`section-count-${label.toLowerCase().replace(/\s+/g, "-")}`}>
          {count}
        </Badge>
      )}
    </div>
  );
}

// Whale row — compact summary line + expandable detail
function WhaleRow({ hit }: { hit: WhaleHit }) {
  const [open, setOpen] = useState(false);
  const conflux = useContext(ConfluxContext);
  const isConflux = conflux.has(confluxKey(hit.symbol, hit.type, hit.strike, hit.expiration));
  return (
    <div
      className={`rounded-md border text-xs ${isConflux ? "border-fuchsia-500/60 bg-fuchsia-500/10 ring-1 ring-fuchsia-500/30" : "border-border/30 bg-card/40"}`}
      data-testid={`whale-row-${hit.occ}`}
      data-conflux={isConflux ? "true" : "false"}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 transition-colors"
        data-testid={`whale-toggle-${hit.occ}`}
      >
        {open ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
        <span className="font-bold text-foreground text-sm" data-testid={`whale-ticker-${hit.occ}`}>{hit.symbol}</span>
        <span className="font-mono text-muted-foreground" data-testid={`whale-contract-${hit.occ}`}>
          {hit.strike}{hit.type} {hit.expiration.slice(5)} • {hit.dte}DTE
        </span>
        <span className={`font-semibold ${sentimentColor(hit.sentiment)}`} data-testid={`whale-sentiment-${hit.occ}`}>
          {hit.sentiment}
        </span>
        {isConflux && (
          <Badge variant="outline" className="border-fuchsia-500/60 bg-fuchsia-500/15 text-fuchsia-300 text-[9px] font-bold" data-testid={`whale-conflux-${hit.occ}`}>
            CONFLUX
          </Badge>
        )}
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
          {fmtPrem(hit.premium)}
        </span>
      </button>

      {open && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 border-t border-border/30 px-3 py-2 font-mono text-[11px] text-muted-foreground" data-testid={`whale-detail-${hit.occ}`}>
          <div><span className="text-muted-foreground/70">vol/OI</span> <span className="text-foreground">{hit.volume.toLocaleString()}/{hit.openInterest.toLocaleString()}</span></div>
          <div><span className="text-muted-foreground/70">bid/ask</span> <span className="text-foreground">{hit.bid?.toFixed(2) ?? "—"}/{hit.ask?.toFixed(2) ?? "—"}</span></div>
          <div><span className="text-muted-foreground/70">mid</span> <span className="text-foreground">${hit.mid?.toFixed(2) ?? "—"}</span></div>
          <div><span className="text-muted-foreground/70">spread</span> <span className="text-foreground">{hit.spreadPct?.toFixed(1) ?? "—"}%</span></div>
          <div><span className="text-muted-foreground/70">IV</span> <span className="text-foreground">{hit.iv !== undefined ? `${hit.iv.toFixed(1)}%` : "—"}</span></div>
          <div><span className="text-muted-foreground/70">spot</span> <span className="text-foreground">{hit.spot ? hit.spot.toFixed(2) : "—"}</span></div>
          <div><span className="text-muted-foreground/70">Δ</span> <span className="text-foreground">{hit.delta.toFixed(2)}</span></div>
          <div><span className="text-muted-foreground/70">γ</span> <span className="text-foreground">{hit.gamma !== undefined ? hit.gamma.toFixed(4) : "—"}</span></div>
          <div><span className="text-muted-foreground/70">θ</span> <span className="text-foreground">{hit.theta !== undefined ? hit.theta.toFixed(2) : "—"}</span></div>
          <div><span className="text-muted-foreground/70">vega</span> <span className="text-foreground">{hit.vega !== undefined ? hit.vega.toFixed(2) : "—"}</span></div>
          <div><span className="text-muted-foreground/70">strike vs spot</span> <span className={hit.distFromSpotPct !== undefined ? pctColor(hit.distFromSpotPct) : ""}>{hit.distFromSpotPct !== undefined ? fmtPct(hit.distFromSpotPct) : "—"}</span></div>
          <div><span className="text-muted-foreground/70">breakeven</span> <span className="text-foreground">{hit.breakeven?.toFixed(2) ?? "—"}{hit.breakevenPct !== undefined ? ` (${fmtPct(hit.breakevenPct)})` : ""}</span></div>
          <div className="col-span-2 sm:col-span-3 italic text-muted-foreground/80" data-testid={`whale-reason-${hit.occ}`}>{hit.reason}</div>
        </div>
      )}
    </div>
  );
}

// Per-ticker collapsible dropdown — top-level shows ticker + count + total premium
function TickerGroup({ ticker, whales, defaultOpen }: { ticker: string; whales: WhaleHit[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const totalPrem = whales.reduce((s, w) => s + w.premium, 0);
  const bullCount = whales.filter(w => w.sentiment === "BULLISH").length;
  const bearCount = whales.filter(w => w.sentiment === "BEARISH").length;
  const dominant = bullCount > bearCount ? "BULLISH" : bearCount > bullCount ? "BEARISH" : "MIXED";

  return (
    <div className="rounded-md border border-border/40 bg-card/30" data-testid={`ticker-group-${ticker}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/20 transition-colors rounded-t-md"
        data-testid={`ticker-toggle-${ticker}`}
      >
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
        <span className="font-bold text-base text-foreground" data-testid={`ticker-name-${ticker}`}>{ticker}</span>
        <Badge variant="outline" className="text-[9px] border-amber-500/40 bg-amber-500/10 text-amber-400" data-testid={`ticker-count-${ticker}`}>
          {whales.length} {whales.length === 1 ? "whale" : "whales"}
        </Badge>
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${sentimentColor(dominant)}`}>
          {dominant}
        </span>
        <span className="ml-auto font-mono font-semibold text-amber-400 text-sm" data-testid={`ticker-total-${ticker}`}>
          {fmtPrem(totalPrem)}
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2 pt-1" data-testid={`ticker-list-${ticker}`}>
          {whales.map((hit) => <WhaleRow key={hit.occ} hit={hit} />)}
        </div>
      )}
    </div>
  );
}

// ─── Freshness / staleness classification ──────────────────────────────────
// Three tiers driven entirely by `lastVolumeBumpAt`, `fadeStreak`, and entry-vs-now
// premium delta. No backend changes required.
//   HOT   — last volume tick within 30 min, still being printed → fresh smart money
//   WARM  — bump within last 2 hours
//   STALE — no fresh prints for >2h
//   SOLD  — high conviction at entry, now bleeding: fadeStreak ≥3 AND down >25% from peak
// Lets you eyeball which sold-off plays are dead weight vs which are fresh accumulation.
type FreshnessTier = "HOT" | "WARM" | "STALE" | "SOLD";
function freshnessTier(pos: FollowPosition): FreshnessTier {
  const peakPct = pos.live.peakPctChange ?? 0;
  const pct = pos.live.pctChange ?? 0;
  const fadedFromPeak = peakPct > 30 && pct < peakPct - 25;
  if (pos.live.fadeStreak >= 3 && fadedFromPeak) return "SOLD";
  const bumpMs = new Date(pos.live.lastVolumeBumpAt).getTime();
  if (!isFinite(bumpMs) || bumpMs <= 0) return "STALE";
  const ageMin = (Date.now() - bumpMs) / 60_000;
  if (ageMin <= 30) return "HOT";
  if (ageMin <= 120) return "WARM";
  return "STALE";
}
function freshnessBadgeClass(t: FreshnessTier): string {
  if (t === "HOT") return "border-cyan-500/50 bg-cyan-500/15 text-cyan-300";
  if (t === "WARM") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  if (t === "SOLD") return "border-rose-500/50 bg-rose-500/15 text-rose-300";
  return "border-muted-foreground/30 bg-muted/20 text-muted-foreground";
}
function freshnessLabel(t: FreshnessTier, pos: FollowPosition): string {
  if (t === "SOLD") return `SOLD · fade×${pos.live.fadeStreak}`;
  const bumpMs = new Date(pos.live.lastVolumeBumpAt).getTime();
  if (!isFinite(bumpMs) || bumpMs <= 0) return t.toLowerCase();
  const ageMin = (Date.now() - bumpMs) / 60_000;
  if (ageMin < 60) return `${t} · ${Math.max(1, Math.round(ageMin))}m`;
  return `${t} · ${(ageMin / 60).toFixed(1)}h`;
}

function TrackingRow({ pos }: { pos: FollowPosition }) {
  const fresh = freshnessTier(pos);
  return (
    <div className="rounded-md border border-border/30 bg-card/40 px-3 py-2 text-xs space-y-1" data-testid={`tracking-row-${pos.occ}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-muted-foreground" data-testid={`tracking-contract-${pos.occ}`}>
          {pos.strike}{pos.type === "C" ? "C" : "P"} {pos.expiration.slice(5)}
        </span>
        <Badge variant="outline" className={`text-[9px] ${statusBadgeClass(pos.status)}`} data-testid={`tracking-status-${pos.occ}`}>
          {pos.status}
        </Badge>
        <span className={`font-semibold ${sentimentColor(pos.side)}`} data-testid={`tracking-side-${pos.occ}`}>
          {pos.side}
        </span>
        <Badge variant="outline" className={`text-[9px] uppercase tracking-wider ${freshnessBadgeClass(fresh)}`} data-testid={`tracking-fresh-${pos.occ}`}>
          {freshnessLabel(fresh, pos)}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-3 font-mono">
        <span className="text-muted-foreground" data-testid={`tracking-entry-${pos.occ}`}>entry ${pos.entry.mark.toFixed(2)}</span>
        <span data-testid={`tracking-mark-${pos.occ}`}>mark ${pos.live.mark.toFixed(2)}</span>
        <span className={pctColor(pos.live.pctChange)} data-testid={`tracking-pct-${pos.occ}`}>{fmtPct(pos.live.pctChange)}</span>
        <span className="text-emerald-400/70" data-testid={`tracking-peak-${pos.occ}`}>peak +{pos.live.peakPctChange.toFixed(1)}%</span>
        <span className="text-muted-foreground/70" data-testid={`tracking-volse-${pos.occ}`}>volSE {pos.live.volumeSinceEntry.toLocaleString()}</span>
      </div>
    </div>
  );
}

function ClosedRowGrouped({ pos }: { pos: FollowPosition }) {
  return <ClosedRow pos={pos} />;
}

// Per-ticker group of tracked positions. Collapsible. Header shows roll-up:
// position count, total combined %, hot count, sold count, dominant sentiment.
function TrackedTickerGroup({
  ticker,
  positions,
  defaultOpen,
}: {
  ticker: string;
  positions: FollowPosition[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hotCount = positions.filter((p) => freshnessTier(p) === "HOT").length;
  const soldCount = positions.filter((p) => freshnessTier(p) === "SOLD").length;
  const bull = positions.filter((p) => p.side === "BULLISH").length;
  const bear = positions.filter((p) => p.side === "BEARISH").length;
  const dominant = bull > bear ? "BULLISH" : bear > bull ? "BEARISH" : "MIXED";
  const avgPct = positions.length
    ? positions.reduce((a, p) => a + (p.live.pctChange ?? 0), 0) / positions.length
    : 0;
  return (
    <div className="rounded-md border border-border/40 bg-card/30" data-testid={`tracked-group-${ticker}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left rounded-t-md hover:bg-muted/20 transition-colors"
        data-testid={`tracked-toggle-${ticker}`}
      >
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
        <span className="font-bold text-base text-foreground">{ticker}</span>
        <Badge variant="outline" className="text-[9px] border-amber-500/40 bg-amber-500/10 text-amber-400">
          {positions.length} {positions.length === 1 ? "pos" : "posns"}
        </Badge>
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${sentimentColor(dominant)}`}>
          {dominant}
        </span>
        {hotCount > 0 && (
          <Badge variant="outline" className="text-[9px] border-cyan-500/50 bg-cyan-500/15 text-cyan-300" data-testid={`tracked-hot-${ticker}`}>
            {hotCount} hot
          </Badge>
        )}
        {soldCount > 0 && (
          <Badge variant="outline" className="text-[9px] border-rose-500/50 bg-rose-500/15 text-rose-300" data-testid={`tracked-sold-${ticker}`}>
            {soldCount} sold
          </Badge>
        )}
        <span className={`ml-auto font-mono text-sm ${pctColor(avgPct)}`}>{fmtPct(avgPct)} avg</span>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2 pt-1">
          {positions.map((p) => <TrackingRow key={p.occ} pos={p} />)}
        </div>
      )}
    </div>
  );
}

// Per-ticker group for closed positions — simpler, no freshness (closed already).
function ClosedTickerGroup({
  ticker,
  positions,
  defaultOpen,
}: {
  ticker: string;
  positions: FollowPosition[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const wins = positions.filter((p) => (p.closingPrint?.pctChange ?? 0) > 0).length;
  const losses = positions.length - wins;
  const avgPct = positions.length
    ? positions.reduce((a, p) => a + (p.closingPrint?.pctChange ?? 0), 0) / positions.length
    : 0;
  return (
    <div className="rounded-md border border-border/30 bg-card/20" data-testid={`closed-group-${ticker}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left rounded-t-md hover:bg-muted/20 transition-colors opacity-90"
        data-testid={`closed-toggle-${ticker}`}
      >
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
        <span className="font-bold text-sm text-foreground">{ticker}</span>
        <Badge variant="outline" className="text-[9px] border-muted-foreground/30 text-muted-foreground">
          {positions.length} closed
        </Badge>
        {wins > 0 && (
          <span className="text-[10px] text-emerald-400/80">{wins}W</span>
        )}
        {losses > 0 && (
          <span className="text-[10px] text-rose-400/80">{losses}L</span>
        )}
        <span className={`ml-auto font-mono text-xs ${pctColor(avgPct)}`}>{fmtPct(avgPct)} avg</span>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2 pt-1">
          {positions.map((p) => <ClosedRowGrouped key={p.occ} pos={p} />)}
        </div>
      )}
    </div>
  );
}

// Group an array of FollowPositions by symbol. Sort groups by SOLD desc, HOT desc,
// then position count desc — so the most-actionable stuff floats to top.
function groupPositionsByTicker(
  positions: FollowPosition[],
  scoreForSort: "tracking" | "closed",
): Array<{ ticker: string; positions: FollowPosition[] }> {
  const map = new Map<string, FollowPosition[]>();
  for (const p of positions) {
    const arr = map.get(p.symbol) ?? [];
    arr.push(p);
    map.set(p.symbol, arr);
  }
  // Sort items within each group by freshness (HOT/WARM first, SOLD last) then by entry recency desc
  const order: Record<FreshnessTier, number> = { HOT: 0, WARM: 1, STALE: 2, SOLD: 3 };
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      const ta = freshnessTier(a);
      const tb = freshnessTier(b);
      if (ta !== tb) return order[ta] - order[tb];
      const da = new Date(a.entry.detectedAt).getTime();
      const db = new Date(b.entry.detectedAt).getTime();
      return db - da;
    });
  }
  const groups = Array.from(map.entries()).map(([ticker, positions]) => ({ ticker, positions }));
  if (scoreForSort === "tracking") {
    groups.sort((a, b) => {
      const aHot = a.positions.filter((p) => freshnessTier(p) === "HOT").length;
      const bHot = b.positions.filter((p) => freshnessTier(p) === "HOT").length;
      if (aHot !== bHot) return bHot - aHot;
      return b.positions.length - a.positions.length;
    });
  } else {
    groups.sort((a, b) => b.positions.length - a.positions.length);
  }
  return groups;
}

function ClosedRow({ pos }: { pos: FollowPosition }) {
  const cp = pos.closingPrint;
  return (
    <div className="rounded-md border border-border/20 bg-card/20 px-3 py-2 text-xs space-y-1 opacity-80" data-testid={`closed-row-${pos.occ}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold text-foreground" data-testid={`closed-ticker-${pos.occ}`}>{pos.symbol}</span>
        <span className="font-mono text-muted-foreground" data-testid={`closed-contract-${pos.occ}`}>
          {pos.strike}{pos.type === "C" ? "C" : "P"} {pos.expiration.slice(5)}
        </span>
        <span className={`font-semibold ${sentimentColor(pos.side)}`} data-testid={`closed-side-${pos.occ}`}>{pos.side}</span>
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

// UOA cluster row (similar shape, hit-count instead of single-print)
function UoaRow({ cl }: { cl: UoaCluster }) {
  const [open, setOpen] = useState(false);
  const conflux = useContext(ConfluxContext);
  const isConflux = conflux.has(confluxKey(cl.symbol, cl.type, cl.strike, cl.expiration));
  return (
    <div
      className={`rounded-md border text-xs ${isConflux ? "border-fuchsia-500/60 bg-fuchsia-500/10 ring-1 ring-fuchsia-500/30" : "border-border/30 bg-card/40"}`}
      data-testid={`uoa-row-${cl.key}`}
      data-conflux={isConflux ? "true" : "false"}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 transition-colors"
        data-testid={`uoa-toggle-${cl.key}`}
      >
        {open ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
        <span className="font-bold text-foreground text-sm" data-testid={`uoa-ticker-${cl.key}`}>{cl.symbol}</span>
        <span className="font-mono text-muted-foreground" data-testid={`uoa-contract-${cl.key}`}>
          {cl.strike}{cl.type} {cl.expiration.slice(5)} • {cl.dte}DTE
        </span>
        <Badge variant="outline" className={`text-[9px] ${bucketBadge(cl.bucket)}`} data-testid={`uoa-bucket-${cl.key}`}>
          {cl.bucket}
        </Badge>
        <span className={`font-semibold ${sentimentColor(cl.sentiment)}`} data-testid={`uoa-sentiment-${cl.key}`}>
          {cl.sentiment}
        </span>
        <span className="font-mono text-muted-foreground/80" data-testid={`uoa-hits-${cl.key}`}>
          {cl.hitCount} hits
        </span>
        {cl.fired && (
          <Badge variant="outline" className="border-emerald-500/50 bg-emerald-500/10 text-emerald-400 text-[9px]" data-testid={`uoa-fired-${cl.key}`}>
            FIRED
          </Badge>
        )}
        <span className="ml-auto font-mono font-semibold text-amber-400" data-testid={`uoa-totalprem-${cl.key}`}>
          {fmtPrem(cl.totalPremium)}
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 border-t border-border/30 px-3 py-2 font-mono text-[11px] text-muted-foreground" data-testid={`uoa-detail-${cl.key}`}>
          <div><span className="text-muted-foreground/70">total vol</span> <span className="text-foreground">{cl.totalVolume.toLocaleString()}</span></div>
          <div><span className="text-muted-foreground/70">avg vol/OI</span> <span className="text-foreground">{cl.avgVolOiRatio.toFixed(1)}x</span></div>
          <div><span className="text-muted-foreground/70">avg Δ</span> <span className="text-foreground">{cl.avgDelta.toFixed(2)}</span></div>
          <div><span className="text-muted-foreground/70">avg IV</span> <span className="text-foreground">{cl.avgIv.toFixed(1)}%</span></div>
          <div><span className="text-muted-foreground/70">bid/ask</span> <span className="text-foreground">{cl.bid.toFixed(2)}/{cl.ask.toFixed(2)}</span></div>
          <div><span className="text-muted-foreground/70">spread</span> <span className="text-foreground">{cl.spreadPct.toFixed(1)}%</span></div>
          <div><span className="text-muted-foreground/70">spot</span> <span className="text-foreground">{cl.spot ? cl.spot.toFixed(2) : "—"}</span></div>
          <div><span className="text-muted-foreground/70">strike vs spot</span> <span className={cl.distFromSpotPct !== undefined ? pctColor(cl.distFromSpotPct) : ""}>{cl.distFromSpotPct !== undefined ? fmtPct(cl.distFromSpotPct) : "—"}</span></div>
          <div><span className="text-muted-foreground/70">breakeven</span> <span className="text-foreground">{cl.breakeven.toFixed(2)}{cl.breakevenPct !== undefined ? ` (${fmtPct(cl.breakevenPct)})` : ""}</span></div>
          <div className="col-span-2 sm:col-span-3 italic text-muted-foreground/80" data-testid={`uoa-reason-${cl.key}`}>{cl.reason}</div>
        </div>
      )}
    </div>
  );
}

function UoaTickerGroup({ ticker, clusters }: { ticker: string; clusters: UoaCluster[] }) {
  const [open, setOpen] = useState(false);
  const total = clusters.reduce((s, c) => s + c.totalPremium, 0);
  const fired = clusters.filter(c => c.fired).length;
  return (
    <div className="rounded-md border border-border/40 bg-card/30" data-testid={`uoa-ticker-group-${ticker}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/20 transition-colors rounded-t-md"
        data-testid={`uoa-ticker-toggle-${ticker}`}
      >
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
        <span className="font-bold text-base text-foreground" data-testid={`uoa-ticker-name-${ticker}`}>{ticker}</span>
        <Badge variant="outline" className="text-[9px] border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300">
          {clusters.length} {clusters.length === 1 ? "cluster" : "clusters"}
        </Badge>
        {fired > 0 && (
          <Badge variant="outline" className="text-[9px] border-emerald-500/50 bg-emerald-500/10 text-emerald-400">
            {fired} FIRED
          </Badge>
        )}
        <span className="ml-auto font-mono font-semibold text-amber-400 text-sm">{fmtPrem(total)}</span>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2 pt-1">
          {clusters.map((cl) => <UoaRow key={cl.key} cl={cl} />)}
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

export default function WhaleFlowPanel() {
  const previewQuery = useQuery<FlowPreview>({
    queryKey: ["/api/flow/preview"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/flow/preview"); return r.json(); },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const activeQuery = useQuery<FollowupsResponse>({
    queryKey: ["/api/flow/followups", "ACTIVE"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/flow/followups?status=ACTIVE"); return r.json(); },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const terminalQuery = useQuery<FollowupsResponse>({
    queryKey: ["/api/flow/followups", "TERMINAL"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/flow/followups?status=TERMINAL"); return r.json(); },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const uoaQuery = useQuery<UoaSnapshot>({
    queryKey: ["/api/uoa/preview"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/uoa/preview"); return r.json(); },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // Build per-ticker whale groups, sorted by ticker total premium DESC
  const whaleGroups: Array<{ ticker: string; whales: WhaleHit[]; total: number }> = [];
  if (previewQuery.data?.byTicker) {
    for (const [ticker, data] of Object.entries(previewQuery.data.byTicker)) {
      if (!data.whales || data.whales.length === 0) continue;
      // Sort within ticker by premium DESC, then volume DESC
      const sorted = [...data.whales].sort((a, b) => (b.premium - a.premium) || (b.volume - a.volume));
      whaleGroups.push({ ticker, whales: sorted, total: sorted.reduce((s, w) => s + w.premium, 0) });
    }
    whaleGroups.sort((a, b) => b.total - a.total);
  }
  const totalWhales = whaleGroups.reduce((s, g) => s + g.whales.length, 0);

  // UOA groups
  const uoaGroups: Array<{ ticker: string; clusters: UoaCluster[]; total: number }> = [];
  if (uoaQuery.data?.byTicker) {
    for (const [ticker, list] of Object.entries(uoaQuery.data.byTicker)) {
      if (!list || list.length === 0) continue;
      uoaGroups.push({ ticker, clusters: list, total: list.reduce((s, c) => s + c.totalPremium, 0) });
    }
    uoaGroups.sort((a, b) => b.total - a.total);
  }

  const trackingPositions = activeQuery.data?.positions ?? [];
  const closedPositions = terminalQuery.data?.positions ?? [];
  const cfg = previewQuery.data?.config;

  // Compute CONFLUX set: contracts present in BOTH active whale fires AND active UOA clusters.
  // This is the highest-conviction signal the platform can surface.
  const confluxSet = (() => {
    const whaleKeys = new Set<string>();
    for (const g of whaleGroups) {
      for (const w of g.whales) whaleKeys.add(confluxKey(w.symbol, w.type, w.strike, w.expiration));
    }
    const intersection = new Set<string>();
    for (const g of uoaGroups) {
      for (const c of g.clusters) {
        const k = confluxKey(c.symbol, c.type, c.strike, c.expiration);
        if (whaleKeys.has(k)) intersection.add(k);
      }
    }
    return intersection;
  })();

  return (
    <ConfluxContext.Provider value={confluxSet}>
    <Card className="border-cyan-500/20 bg-gradient-to-br from-card to-cyan-950/5" data-testid="card-whale-flow">
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
          {cfg && (
            <span className="text-muted-foreground text-[10px] font-mono ml-auto" data-testid="whale-flow-gate">
              gate: ${(cfg.premiumFloor / 1_000_000).toFixed(1)}M • {cfg.volOiRatio}x • {cfg.minDte}-{cfg.maxDte}DTE • {cfg.requiredTag}
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ── FRESH WHALES ── */}
        <section data-testid="section-fresh-whales">
          <SectionHeader icon={<TrendingUp className="h-3.5 w-3.5" />} label="Fresh Whales" count={totalWhales} />
          {previewQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : whaleGroups.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/30 py-4 text-center text-xs text-muted-foreground" data-testid="fresh-whales-empty">
              no whales pass the surgical gate right now — scan runs every 30s
            </div>
          ) : (
            <div className="space-y-2" data-testid="fresh-whales-list">
              {whaleGroups.map(({ ticker, whales }, idx) => (
                <TickerGroup key={ticker} ticker={ticker} whales={whales} defaultOpen={idx === 0} />
              ))}
            </div>
          )}
        </section>

        {/* ── UOA CLUSTERS ── */}
        <section data-testid="section-uoa">
          <SectionHeader icon={<Zap className="h-3.5 w-3.5" />} label="UOA Clusters · any ticker · cap-tiered" count={uoaQuery.data?.totalClusters ?? 0} />
          {uoaQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : uoaGroups.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/30 py-4 text-center text-xs text-muted-foreground" data-testid="uoa-empty">
              no UOA clusters near fire threshold — needs N hits + cumulative $ floor per cap tier
            </div>
          ) : (
            <div className="space-y-2" data-testid="uoa-list">
              {uoaGroups.map(({ ticker, clusters }) => (
                <UoaTickerGroup key={ticker} ticker={ticker} clusters={clusters} />
              ))}
            </div>
          )}
        </section>

        {/* ── TRACKING ── */}
        <section data-testid="section-tracking">
          <SectionHeader icon={<Target className="h-3.5 w-3.5" />} label="Tracking" count={trackingPositions.length} />
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
              {groupPositionsByTicker(trackingPositions, "tracking").map((g, idx) => (
                <TrackedTickerGroup
                  key={g.ticker}
                  ticker={g.ticker}
                  positions={g.positions}
                  defaultOpen={idx === 0}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── CLOSED ── */}
        <section data-testid="section-closed">
          <SectionHeader icon={<TrendingDown className="h-3.5 w-3.5" />} label="Closed" count={closedPositions.length} />
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
              {groupPositionsByTicker(closedPositions, "closed").map((g, idx) => (
                <ClosedTickerGroup
                  key={g.ticker}
                  ticker={g.ticker}
                  positions={g.positions}
                  defaultOpen={idx === 0}
                />
              ))}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
    </ConfluxContext.Provider>
  );
}
