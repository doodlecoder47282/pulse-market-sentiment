/**
 * LiveOdteTracker.tsx
 *
 * Renders the "Live 0DTE Tracker" card inside the Heatseeker view.
 *
 * Features:
 *  · Table of 40 SPX 0DTE contracts (ATM ±20 strikes, calls + puts)
 *  · Live bid / ask / last / volume / Δvol / OI / classification per row
 *  · Inline volume sparkline colored by Lee-Ready classification
 *  · Size-selector slider (how many contracts of size to trip a "buy" alert)
 *  · "Arm" button per row to track a position (buy → exit inference)
 *  · Tracked positions panel with live P&L vs buy price + SELL_INFERRED marker
 *
 * Backed by /api/odte-tracker — polls every 3s.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Radio, Crosshair, DollarSign, Flame, ArrowUp, ArrowDown, Activity, ChevronDown, ChevronUp, Minimize2, Maximize2 } from "lucide-react";
import OdteContractChart from "./OdteContractChart";
import { SortableTh, sortRows, type SortState } from "./SortableTh";

type OdteSortKey = "strike" | "side" | "bid" | "ask" | "last" | "volume" | "deltaVol" | "openInterest" | "notional";

type Side = "call" | "put";
type Classification = "buy" | "sell" | "neutral";

interface ContractRow {
  key: string;
  symbol: string;
  strike: number;
  side: Side;
  expiry: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  prevLast: number | null;
  volume: number;
  deltaVol: number;
  openInterest: number;
  notional: number;
  classification: Classification;
  buyFlag: boolean;
  distance: number;
}

interface TrackedPosition {
  id: string;
  contractKey: string;
  strike: number;
  side: Side;
  buyPrice: number;
  buyVolume: number;
  buyTimestamp: number;
  baselineOI: number;
  minNotional: number;
  status: "active" | "exited";
  markerBuyTs: number | null;
  markerSellTs: number | null;
  estExitPrice: number | null;
  estExitTs: number | null;
}

interface TickEvent {
  ts: number;
  contractKey: string;
  strike: number;
  side: Side;
  kind: "buy" | "sell_inferred" | "arm";
  price: number | null;
  volume: number;
  notional: number;
}

interface TrackerSnapshot {
  asOf: number;
  symbol: string;
  spot: number;
  expiry: string | null;
  dte: number;
  contracts: ContractRow[];
  events: TickEvent[];
  tracked: TrackedPosition[];
  connected: boolean;
  note?: string;
}

const fmtMoney = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};

function clsBadge(c: Classification, dv: number) {
  if (dv === 0) return null;
  if (c === "buy") {
    return (
      <Badge className="h-5 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-400 hover:bg-emerald-500/20">
        <ArrowUp className="mr-0.5 h-2.5 w-2.5" />BUY
      </Badge>
    );
  }
  if (c === "sell") {
    return (
      <Badge className="h-5 border-rose-500/40 bg-rose-500/10 text-[10px] text-rose-400 hover:bg-rose-500/20">
        <ArrowDown className="mr-0.5 h-2.5 w-2.5" />SELL
      </Badge>
    );
  }
  return <Badge variant="outline" className="h-5 text-[10px] opacity-60">flat</Badge>;
}

/** Inline sparkline of recent volume deltas from the contract's event history */
function VolSpark({ contractKey, events, snapAt }: {
  contractKey: string;
  events: TickEvent[];
  snapAt: number;
}) {
  // Pull events for this contract within the last 15 minutes
  const cutoff = snapAt - 15 * 60_000;
  const ev = events.filter(e => e.contractKey === contractKey && e.ts >= cutoff);
  if (ev.length === 0) {
    return <div className="h-6 w-20 rounded bg-muted/30" />;
  }
  const maxV = Math.max(...ev.map(e => e.volume || 1), 1);
  return (
    <div className="flex h-6 w-20 items-end gap-[1px] rounded bg-muted/20 px-[2px] py-[2px]">
      {ev.slice(-24).map((e, i) => {
        const h = Math.max(2, (e.volume / maxV) * 20);
        const color =
          e.kind === "buy" ? "bg-emerald-500"
            : e.kind === "sell_inferred" ? "bg-rose-500"
              : "bg-muted-foreground/40";
        return <div key={i} className={`w-[2px] ${color}`} style={{ height: `${h}px` }} title={`${new Date(e.ts).toLocaleTimeString()} · ${e.kind}`} />;
      })}
    </div>
  );
}

export default function LiveOdteTracker() {
  const [sizeMultiple, setSizeMultiple] = useState<number>(5);
  const [sideFilter, setSideFilter] = useState<"all" | "call" | "put">("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const { toast } = useToast();

  const { data, isLoading, error } = useQuery<TrackerSnapshot>({
    queryKey: ["/api/odte-tracker"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/odte-tracker");
      return r.json();
    },
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
    staleTime: 2_500,
  });

  const armMut = useMutation({
    mutationFn: async (args: { contractKey: string; minNotional: number }) => {
      const r = await apiRequest("POST", "/api/odte-tracker/arm", args);
      return r.json();
    },
    onSuccess: (res: any) => {
      if (res?.ok) {
        toast({ title: "Position armed", description: `Tracking ${res.position?.strike}${res.position?.side === "call" ? "C" : "P"} from $${res.position?.buyPrice?.toFixed(2)}` });
        queryClient.invalidateQueries({ queryKey: ["/api/odte-tracker"] });
      } else {
        toast({ title: "Arm failed", description: res?.error ?? "unknown", variant: "destructive" });
      }
    },
  });

  const disarmMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await apiRequest("POST", "/api/odte-tracker/disarm", { id });
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/odte-tracker"] }),
  });

  if (isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (error || !data) {
    return (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="pt-6 text-sm text-amber-400">
          Unable to load 0DTE tracker.
        </CardContent>
      </Card>
    );
  }

  if (!data.connected) {
    return (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="h-4 w-4 text-amber-500" />Live 0DTE Tracker
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {data.note ?? "Connect Schwab to stream live 0DTE contracts."}
        </CardContent>
      </Card>
    );
  }

  if (collapsed) {
    return <CollapsedTracker data={data} onExpand={() => setCollapsed(false)} />;
  }

  return <LiveTrackerView
    data={data}
    sizeMultiple={sizeMultiple}
    setSizeMultiple={setSizeMultiple}
    sideFilter={sideFilter}
    setSideFilter={setSideFilter}
    selectedKey={selectedKey}
    setSelectedKey={setSelectedKey}
    onArm={(key, minNotional) => armMut.mutate({ contractKey: key, minNotional })}
    onDisarm={(id) => disarmMut.mutate(id)}
    armPending={armMut.isPending}
    onCollapse={() => setCollapsed(true)}
  />;
}

// ─── Collapsed mini card ──────────────────────────────────────────────────────
function CollapsedTracker({ data, onExpand }: { data: TrackerSnapshot; onExpand: () => void }) {
  // Quick stats for the mini view
  const activeCount = data.tracked.filter(t => t.status === "active").length;
  const buyFlags = data.contracts.filter(c => c.buyFlag).length;
  const totalBuyNotional = data.contracts
    .filter(c => c.classification === "buy")
    .reduce((s, c) => s + c.notional, 0);
  const totalSellNotional = data.contracts
    .filter(c => c.classification === "sell")
    .reduce((s, c) => s + c.notional, 0);
  const netFlow = totalBuyNotional - totalSellNotional;
  const tickTime = new Date(data.asOf).toLocaleTimeString("en-US", { hour12: false });

  return (
    <Card
      className="cursor-pointer border-orange-500/20 transition-colors hover:border-orange-500/40 hover:bg-orange-500/5"
      onClick={onExpand}
      data-testid="card-odte-collapsed"
    >
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="flex items-center gap-3">
          <Radio className="h-4 w-4 animate-pulse text-orange-500" />
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-orange-400">
              0DTE · {data.symbol}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {data.dte}DTE · exp {data.expiry ?? "—"} · tick {tickTime}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <div className="flex flex-col items-end">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Spot</span>
            <span className="font-mono text-sm font-bold tabular-nums">{data.spot.toFixed(2)}</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Net flow</span>
            <span className={`font-mono text-sm font-bold tabular-nums ${netFlow >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {netFlow >= 0 ? "+" : ""}{fmtMoney(netFlow)}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Buy flags</span>
            <span className="font-mono text-sm font-bold tabular-nums text-orange-400">{buyFlags}</span>
          </div>
          {activeCount > 0 && (
            <Badge className="bg-emerald-500/20 text-emerald-400">
              <Crosshair className="mr-1 h-3 w-3" />{activeCount} armed
            </Badge>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-[11px]"
            onClick={(e) => { e.stopPropagation(); onExpand(); }}
            data-testid="button-expand-odte"
          >
            <Maximize2 className="h-3 w-3" /> expand
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LiveTrackerView({
  data, sizeMultiple, setSizeMultiple, sideFilter, setSideFilter,
  selectedKey, setSelectedKey,
  onArm, onDisarm, armPending, onCollapse,
}: {
  data: TrackerSnapshot;
  sizeMultiple: number;
  setSizeMultiple: (n: number) => void;
  sideFilter: "all" | "call" | "put";
  setSideFilter: (s: "all" | "call" | "put") => void;
  selectedKey: string | null;
  setSelectedKey: (k: string | null) => void;
  onArm: (key: string, minNotional: number) => void;
  onDisarm: (id: string) => void;
  armPending: boolean;
  onCollapse: () => void;
}) {
  // Implied "buy threshold" = sizeMultiple × typical contract price × 100
  // We approximate typical 0DTE premium as average last across visible rows
  const avgLast = useMemo(() => {
    const xs = data.contracts.map(c => c.last ?? 0).filter(x => x > 0);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 1;
  }, [data.contracts]);
  const minNotional = Math.max(5_000, Math.round(sizeMultiple * avgLast * 100));

  const [sort, setSort] = useState<SortState<OdteSortKey>>({ key: null, dir: "desc" });

  // Filter + sort
  const shown = useMemo(() => {
    let rows = data.contracts;
    if (sideFilter !== "all") rows = rows.filter(r => r.side === sideFilter);
    if (sort.key == null) {
      return [...rows].sort((a, b) => a.distance - b.distance || (a.side === "call" ? -1 : 1));
    }
    return sortRows(rows, sort, (r, k) => r[k as keyof ContractRow]);
  }, [data.contracts, sideFilter, sort]);

  const selectedRow = useMemo(
    () => selectedKey ? data.contracts.find(c => c.key === selectedKey) ?? null : null,
    [selectedKey, data.contracts],
  );

  const activeTracked = data.tracked.filter(t => t.status === "active");
  const exitedTracked = data.tracked.filter(t => t.status === "exited").slice(-5);

  const tickTime = new Date(data.asOf).toLocaleTimeString("en-US", { hour12: false });

  return (
    <Card className="border-orange-500/20">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Radio className="h-4 w-4 animate-pulse text-orange-500" />
              Live 0DTE Tracker · {data.symbol}
              <Badge variant="outline" className="ml-2 font-mono text-[10px]">
                {data.dte}DTE · exp {data.expiry ?? "—"}
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px]">tick {tickTime}</Badge>
            </CardTitle>
            <div className="mt-1 text-xs text-muted-foreground">
              ATM ±20 strikes · Lee-Ready classifier (last vs midpoint, tick-rule fallback) ·
              BUY when notional ≥ <span className="font-mono text-orange-400">{fmtMoney(minNotional)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Spot</span>
            <span className="font-mono text-lg font-bold tabular-nums">{data.spot.toFixed(2)}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-[11px]"
              onClick={onCollapse}
              data-testid="button-collapse-odte"
            >
              <Minimize2 className="h-3 w-3" /> minimize
            </Button>
          </div>
        </div>

        {/* Controls row */}
        <div className="mt-3 flex flex-wrap items-center gap-4 rounded-md border bg-muted/20 p-3 text-xs">
          <div className="flex items-center gap-2">
            <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Size of buy to flag</span>
            <div className="w-36">
              <Slider
                value={[sizeMultiple]}
                min={1} max={50} step={1}
                onValueChange={(v) => setSizeMultiple(v[0] ?? 5)}
                data-testid="slider-odte-size"
              />
            </div>
            <span className="font-mono tabular-nums text-orange-400">{sizeMultiple} cons</span>
            <span className="text-muted-foreground">≈ {fmtMoney(minNotional)} notional</span>
          </div>
          <div className="flex items-center gap-1">
            {(["all", "call", "put"] as const).map(s => (
              <Button
                key={s}
                size="sm"
                variant={sideFilter === s ? "default" : "outline"}
                className="h-7 px-2 text-[11px]"
                onClick={() => setSideFilter(s)}
                data-testid={`button-side-filter-${s}`}
              >
                {s.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {/* Tracked positions panel */}
        {(activeTracked.length > 0 || exitedTracked.length > 0) && (
          <div className="mb-4 rounded-md border border-orange-500/30 bg-orange-500/5 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-orange-400">
              <Crosshair className="h-3.5 w-3.5" /> Tracked positions
            </div>
            <div className="grid gap-2">
              {activeTracked.map(t => {
                const live = data.contracts.find(c => c.key === t.contractKey);
                const livePx = live?.last ?? null;
                const pnl = livePx != null ? (livePx - t.buyPrice) * 100 : null;
                return (
                  <div
                    key={t.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background/50 p-2 text-xs"
                    data-testid={`tracked-${t.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <Badge className="bg-emerald-500/20 text-emerald-400">LIVE</Badge>
                      <span className="font-mono font-semibold">
                        {t.strike.toFixed(0)}{t.side === "call" ? "C" : "P"}
                      </span>
                      <span className="text-muted-foreground">
                        entry ${t.buyPrice.toFixed(2)} · {new Date(t.buyTimestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground">
                        last {livePx != null ? `$${livePx.toFixed(2)}` : "—"}
                      </span>
                      {pnl != null && (
                        <span className={`font-mono font-semibold tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}/con
                        </span>
                      )}
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]"
                        onClick={() => onDisarm(t.id)}
                        data-testid={`button-disarm-${t.id}`}
                      >
                        disarm
                      </Button>
                    </div>
                  </div>
                );
              })}
              {exitedTracked.map(t => (
                <div
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-rose-500/30 bg-rose-500/5 p-2 text-xs"
                  data-testid={`tracked-exited-${t.id}`}
                >
                  <div className="flex items-center gap-2">
                    <Badge className="bg-rose-500/20 text-rose-400">SELL INFERRED</Badge>
                    <span className="font-mono font-semibold">
                      {t.strike.toFixed(0)}{t.side === "call" ? "C" : "P"}
                    </span>
                    <span className="text-muted-foreground">
                      entry ${t.buyPrice.toFixed(2)} → exit ~${t.estExitPrice?.toFixed(2) ?? "—"}
                    </span>
                  </div>
                  <div className="text-muted-foreground">
                    {t.estExitTs ? new Date(t.estExitTs).toLocaleTimeString() : ""}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Contract table */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-[11px]">
            <thead>
              <tr className="border-b text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                <SortableTh sortKey="strike" label="Strike" state={sort} onSort={setSort} defaultDir="asc" className="py-1 pr-2" align="left" testId="sort-odte-strike" />
                <SortableTh sortKey="side" label="Side" state={sort} onSort={setSort} defaultDir="asc" className="py-1 pr-2" align="left" testId="sort-odte-side" />
                <SortableTh sortKey="bid" label="Bid" state={sort} onSort={setSort} className="py-1 pr-2" align="right" testId="sort-odte-bid" />
                <SortableTh sortKey="ask" label="Ask" state={sort} onSort={setSort} className="py-1 pr-2" align="right" testId="sort-odte-ask" />
                <SortableTh sortKey="last" label="Last" state={sort} onSort={setSort} className="py-1 pr-2" align="right" testId="sort-odte-last" />
                <SortableTh sortKey="volume" label="Vol" state={sort} onSort={setSort} className="py-1 pr-2" align="right" testId="sort-odte-vol" />
                <SortableTh sortKey="deltaVol" label="Δvol" state={sort} onSort={setSort} className="py-1 pr-2" align="right" testId="sort-odte-dvol" />
                <SortableTh sortKey="openInterest" label="OI" state={sort} onSort={setSort} className="py-1 pr-2" align="right" testId="sort-odte-oi" />
                <SortableTh sortKey="notional" label="Notional" state={sort} onSort={setSort} className="py-1 pr-2" align="right" testId="sort-odte-notional" />
                <th className="py-1 pr-2 text-center">Flow</th>
                <th className="py-1 pr-2 text-center">Spark</th>
                <th className="py-1 pr-2 text-center">Arm</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => {
                const isBuy = r.classification === "buy" && r.notional >= minNotional;
                const isAlreadyTracked = data.tracked.some(t => t.contractKey === r.key && t.status === "active");
                const isSelected = r.key === selectedKey;
                return (
                  <tr
                    key={r.key}
                    onClick={() => setSelectedKey(isSelected ? null : r.key)}
                    className={`cursor-pointer border-b border-muted/20 font-mono hover:bg-muted/30 ${
                      isSelected ? "bg-sky-500/15 ring-1 ring-sky-500/40" :
                      isBuy ? "bg-emerald-500/5" : r.classification === "sell" && r.deltaVol > 0 ? "bg-rose-500/5" : ""
                    }`}
                    data-testid={`row-odte-${r.key}`}
                  >
                    <td className="py-1 pr-2 font-semibold tabular-nums">{r.strike.toFixed(0)}</td>
                    <td className="py-1 pr-2">
                      <span className={r.side === "call" ? "text-emerald-400" : "text-rose-400"}>
                        {r.side === "call" ? "C" : "P"}
                      </span>
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.bid?.toFixed(2) ?? "—"}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.ask?.toFixed(2) ?? "—"}</td>
                    <td className="py-1 pr-2 text-right tabular-nums font-semibold">{r.last?.toFixed(2) ?? "—"}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{r.volume.toLocaleString()}</td>
                    <td className={`py-1 pr-2 text-right tabular-nums ${r.deltaVol > 0 ? "text-foreground" : "text-muted-foreground"}`}>
                      {r.deltaVol > 0 ? `+${r.deltaVol}` : "—"}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{r.openInterest.toLocaleString()}</td>
                    <td className={`py-1 pr-2 text-right tabular-nums ${r.notional >= minNotional ? "text-orange-400 font-semibold" : ""}`}>
                      {r.notional > 0 ? fmtMoney(r.notional) : "—"}
                    </td>
                    <td className="py-1 pr-2 text-center">{clsBadge(r.classification, r.deltaVol)}</td>
                    <td className="py-1 pr-2">
                      <div className="flex justify-center">
                        <VolSpark contractKey={r.key} events={data.events} snapAt={data.asOf} />
                      </div>
                    </td>
                    <td className="py-1 pr-2 text-center">
                      <Button
                        size="sm"
                        variant={isAlreadyTracked ? "outline" : isBuy ? "default" : "ghost"}
                        disabled={isAlreadyTracked || armPending || r.last == null}
                        className="h-6 px-2 text-[10px]"
                        onClick={(e) => { e.stopPropagation(); onArm(r.key, minNotional); }}
                        data-testid={`button-arm-${r.key}`}
                      >
                        {isAlreadyTracked ? "tracked" : isBuy ? <><Flame className="mr-1 h-3 w-3" />arm</> : "arm"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {shown.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Activity className="h-4 w-4" /> waiting for first tick…
          </div>
        )}

        {/* ▼ Selected-contract live chart (ToS-style 5-min, swipe for details) */}
        {selectedRow && (
          <div className="mt-3">
            <OdteContractChart
              meta={{
                key: selectedRow.key,
                label: `${selectedRow.strike.toFixed(0)}${selectedRow.side === "call" ? "C" : "P"} · ${selectedRow.symbol}`,
                strike: selectedRow.strike,
                side: selectedRow.side,
                expiry: selectedRow.expiry,
                last: selectedRow.last,
                spot: data.spot,
                bid: selectedRow.bid,
                ask: selectedRow.ask,
                mid: selectedRow.mid,
                volume: selectedRow.volume,
                openInterest: selectedRow.openInterest,
                deltaVol: selectedRow.deltaVol,
                notional: selectedRow.notional,
                classification: selectedRow.classification,
                distance: selectedRow.distance,
              }}
              onClose={() => setSelectedKey(null)}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
