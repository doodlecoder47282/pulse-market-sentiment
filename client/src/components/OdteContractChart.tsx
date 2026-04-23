/**
 * OdteContractChart.tsx
 *
 * ToS-style intraday chart of a single 0DTE contract.
 *   · Top pane: price (OHLC close line + high/low envelope shaded, bid/ask band)
 *   · Bottom pane: volume bars split by Lee-Ready classification
 *                  (emerald = buy-classified, rose = sell-classified, muted = other)
 *
 * Data from GET /api/odte-tracker/chart?key=<contractKey>&bucketMs=<ms>
 * Polls every 5 s.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ComposedChart,
  Line,
  Area,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { TrendingUp, X, CandlestickChart, ChevronLeft, ChevronRight } from "lucide-react";

interface ChartBar {
  ts: number;
  timeLabel: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  buyVol: number;
  sellVol: number;
  totalVol: number;
  bidLow: number | null;
  askHigh: number | null;
}

interface ChartResponse {
  key: string;
  bucketMs: number;
  bars: ChartBar[];
  firstTs: number | null;
  lastTs: number | null;
}

interface SelectedMeta {
  key: string;
  label: string;       // "7100C · SPX"
  strike: number;
  side: "call" | "put";
  expiry: string | null;
  last: number | null;
  spot: number;
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  volume?: number;
  openInterest?: number;
  deltaVol?: number;
  notional?: number;
  classification?: "buy" | "sell" | "neutral";
  distance?: number;
}

const BUCKETS: Array<{ label: string; ms: number }> = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 5 * 60_000 },
  { label: "15m", ms: 15 * 60_000 },
];

export default function OdteContractChart({
  meta,
  onClose,
}: {
  meta: SelectedMeta;
  onClose: () => void;
}) {
  const [bucketMs, setBucketMs] = useState<number>(5 * 60_000);
  const [pane, setPane] = useState<"chart" | "details">("chart");
  // Simple swipe detector using a window-scoped scratch var
  const onTouchStart = (e: React.TouchEvent) => {
    (window as any).__odteSwipeX = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = (window as any).__odteSwipeX as number | null;
    const end = e.changedTouches[0]?.clientX ?? null;
    if (start == null || end == null) return;
    const dx = end - start;
    if (Math.abs(dx) < 40) return;
    if (dx < 0) setPane("details"); else setPane("chart");
  };

  const { data, isLoading } = useQuery<ChartResponse>({
    queryKey: ["/api/odte-tracker/chart", meta.key, bucketMs],
    queryFn: async () => {
      const r = await apiRequest(
        "GET",
        `/api/odte-tracker/chart?key=${encodeURIComponent(meta.key)}&bucketMs=${bucketMs}`,
      );
      return r.json();
    },
    refetchInterval: 5_000,
    staleTime: 4_500,
  });

  // Recharts rows: keep only fully-formed bars, pre-compute envelope + signed vol
  const rows = useMemo(() => {
    const bars = data?.bars ?? [];
    return bars
      .filter(b => b.close != null)
      .map(b => ({
        ts: b.ts,
        time: b.timeLabel,
        close: b.close,
        high: b.high,
        low: b.low,
        hl: b.high != null && b.low != null ? [b.low, b.high] : undefined,
        bidLow: b.bidLow,
        askHigh: b.askHigh,
        ask: b.bidLow != null && b.askHigh != null ? [b.bidLow, b.askHigh] : undefined,
        buyVol: b.buyVol,
        sellVol: b.sellVol,
        otherVol: Math.max(0, b.totalVol - b.buyVol - b.sellVol),
        // signed sell (plotted as a negative bar in volume pane — classic ToS)
        sellVolNeg: -b.sellVol,
      }));
  }, [data]);

  const stats = useMemo(() => {
    if (rows.length === 0) return null;
    const closes = rows.map(r => r.close!).filter(x => x != null) as number[];
    if (closes.length === 0) return null;
    const first = closes[0];
    const last = closes[closes.length - 1];
    const high = Math.max(...closes);
    const low = Math.min(...closes);
    const change = last - first;
    const changePct = first !== 0 ? (change / first) * 100 : 0;
    const totalBuy = rows.reduce((s, r) => s + r.buyVol, 0);
    const totalSell = rows.reduce((s, r) => s + r.sellVol, 0);
    const dominance = totalBuy + totalSell > 0
      ? ((totalBuy - totalSell) / (totalBuy + totalSell)) * 100
      : 0;
    return { first, last, high, low, change, changePct, totalBuy, totalSell, dominance };
  }, [rows]);

  const badgeTone = meta.side === "call" ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                                          : "border-rose-500/40 text-rose-400 bg-rose-500/10";

  return (
    <Card className="border-sky-500/30 bg-gradient-to-br from-background to-sky-500/5">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CandlestickChart className="h-3.5 w-3.5 text-sky-400" />
            <span className="text-foreground/80">Contract</span>
            <Badge variant="outline" className={`h-5 font-mono text-[11px] ${badgeTone}`}>
              {meta.strike.toFixed(0)}{meta.side === "call" ? "C" : "P"}
            </Badge>
            <Badge variant="outline" className="h-5 font-mono text-[10px]">
              exp {meta.expiry ?? "—"}
            </Badge>
            {meta.last != null && (
              <span className="font-mono text-sm font-bold tabular-nums">
                ${meta.last.toFixed(2)}
              </span>
            )}
            {stats && (
              <span className={`font-mono text-xs tabular-nums ${stats.change >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {stats.change >= 0 ? "+" : ""}{stats.change.toFixed(2)} ({stats.changePct >= 0 ? "+" : ""}{stats.changePct.toFixed(1)}%)
              </span>
            )}
          </CardTitle>

          <div className="flex items-center gap-1">
            {/* Pane toggle */}
            <div className="flex overflow-hidden rounded-md border">
              <Button
                size="sm"
                variant={pane === "chart" ? "default" : "ghost"}
                className="h-6 rounded-none px-2 text-[10px]"
                onClick={() => setPane("chart")}
                data-testid="button-pane-chart"
              >
                chart
              </Button>
              <Button
                size="sm"
                variant={pane === "details" ? "default" : "ghost"}
                className="h-6 rounded-none px-2 text-[10px]"
                onClick={() => setPane("details")}
                data-testid="button-pane-details"
              >
                details
              </Button>
            </div>
            {/* Bucket toggle */}
            <div className="flex overflow-hidden rounded-md border">
              {BUCKETS.map(b => (
                <Button
                  key={b.ms}
                  size="sm"
                  variant={bucketMs === b.ms ? "default" : "ghost"}
                  className="h-6 rounded-none px-1.5 text-[10px]"
                  onClick={() => setBucketMs(b.ms)}
                  data-testid={`button-bucket-${b.label}`}
                >
                  {b.label}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={onClose}
              data-testid="button-close-chart"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {/* Swipeable viewport: chart pane | details pane */}
        <div
          className="relative overflow-hidden"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <div
            className="flex w-full transition-transform duration-300 ease-out"
            style={{ transform: pane === "chart" ? "translateX(0%)" : "translateX(-100%)" }}
          >
          {/* ▶ Pane A: compact chart */}
          <div className="w-full shrink-0">
        {isLoading && rows.length === 0 ? (
          <Skeleton className="h-[220px] w-full" />
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <TrendingUp className="h-5 w-5 opacity-60" />
            Waiting for tick history on {meta.strike.toFixed(0)}{meta.side === "call" ? "C" : "P"}…
          </div>
        ) : (
          <div className="space-y-1">
            {/* Price pane — compact */}
            <div className="h-[150px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.12} />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    domain={["auto", "auto"]}
                    tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
                    width={56}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--background))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                      fontSize: 11,
                    }}
                    formatter={(v: any, name: string) => {
                      if (name === "close") return [`$${Number(v).toFixed(2)}`, "close"];
                      if (name === "hl") {
                        const [lo, hi] = v as [number, number];
                        return [`$${lo.toFixed(2)} - $${hi.toFixed(2)}`, "range"];
                      }
                      if (name === "ask") {
                        const [lo, hi] = v as [number, number];
                        return [`$${lo.toFixed(2)} - $${hi.toFixed(2)}`, "bid/ask"];
                      }
                      return [v, name];
                    }}
                  />
                  {/* Bid/ask envelope */}
                  <Area
                    type="linear"
                    dataKey="ask"
                    stroke="none"
                    fill="#38bdf8"
                    fillOpacity={0.08}
                    isAnimationActive={false}
                    name="ask"
                  />
                  {/* High-low envelope */}
                  <Area
                    type="monotone"
                    dataKey="hl"
                    stroke="none"
                    fill="#38bdf8"
                    fillOpacity={0.16}
                    isAnimationActive={false}
                    name="hl"
                  />
                  {/* Close line */}
                  <Line
                    type="monotone"
                    dataKey="close"
                    stroke="#38bdf8"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                    name="close"
                  />
                  {/* Horizontal last-price reference */}
                  {meta.last != null && (
                    <ReferenceLine
                      y={meta.last}
                      stroke="#38bdf8"
                      strokeDasharray="3 3"
                      opacity={0.5}
                      label={{
                        value: `$${meta.last.toFixed(2)}`,
                        position: "right",
                        fill: "#38bdf8",
                        fontSize: 10,
                      }}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Volume pane (split buy/sell, ToS style) — compact */}
            <div className="h-[70px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 2, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                    tickFormatter={(v) => Math.abs(Number(v)).toLocaleString()}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--background))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                      fontSize: 11,
                    }}
                    formatter={(v: any, name: string) => {
                      const n = Math.abs(Number(v)).toLocaleString();
                      if (name === "buyVol") return [n, "buy vol"];
                      if (name === "sellVolNeg") return [n, "sell vol"];
                      if (name === "otherVol") return [n, "other"];
                      return [v, name];
                    }}
                  />
                  <ReferenceLine y={0} stroke="hsl(var(--border))" />
                  <Bar dataKey="buyVol" fill="#10b981" stackId="a" isAnimationActive={false} name="buyVol" />
                  <Bar dataKey="otherVol" fill="hsl(var(--muted-foreground))" fillOpacity={0.35} stackId="a" isAnimationActive={false} name="otherVol" />
                  <Bar dataKey="sellVolNeg" fill="#ef4444" stackId="b" isAnimationActive={false} name="sellVolNeg" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="flex items-center justify-between gap-2 pt-0.5 text-[9px] text-muted-foreground">
              <div className="flex items-center gap-2">
                <LegendDot color="#38bdf8" label="close" />
                <LegendDot color="#10b981" label="buy" />
                <LegendDot color="#ef4444" label="sell" />
              </div>
              <button
                type="button"
                onClick={() => setPane("details")}
                className="flex items-center gap-0.5 font-mono hover:text-foreground"
                data-testid="button-swipe-to-details"
              >
                swipe for details <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}
          </div>

          {/* ▶ Pane B: full details */}
          <div className="w-full shrink-0 pl-1">
            <DetailsPane meta={meta} stats={stats} barsCount={rows.length} bucketMs={bucketMs} onBack={() => setPane("chart")} />
          </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DetailsPane({
  meta,
  stats,
  barsCount,
  bucketMs,
  onBack,
}: {
  meta: SelectedMeta;
  stats: { first: number; last: number; high: number; low: number; change: number; changePct: number; totalBuy: number; totalSell: number; dominance: number } | null;
  barsCount: number;
  bucketMs: number;
  onBack: () => void;
}) {
  const spread = meta.bid != null && meta.ask != null ? meta.ask - meta.bid : null;
  const spreadPct = spread != null && meta.mid ? (spread / meta.mid) * 100 : null;
  const moneyness = meta.side === "call"
    ? (meta.spot - meta.strike)
    : (meta.strike - meta.spot);
  const itm = moneyness > 0;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground"
        data-testid="button-swipe-to-chart"
      >
        <ChevronLeft className="h-3 w-3" /> back to chart
      </button>

      <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3">
        <DetailRow label="Strike" value={meta.strike.toFixed(0)} />
        <DetailRow label="Side" value={meta.side.toUpperCase()} tone={meta.side === "call" ? "up" : "down"} />
        <DetailRow label="Expiry" value={meta.expiry ?? "—"} />
        <DetailRow label="Spot" value={`$${meta.spot.toFixed(2)}`} />
        <DetailRow
          label="Moneyness"
          value={`${itm ? "ITM" : "OTM"} ${Math.abs(moneyness).toFixed(1)}`}
          tone={itm ? "up" : "down"}
        />
        <DetailRow label="Dist ATM" value={meta.distance != null ? meta.distance.toFixed(1) : "—"} />

        <DetailRow label="Bid" value={meta.bid != null ? `$${meta.bid.toFixed(2)}` : "—"} />
        <DetailRow label="Ask" value={meta.ask != null ? `$${meta.ask.toFixed(2)}` : "—"} />
        <DetailRow label="Mid" value={meta.mid != null ? `$${meta.mid.toFixed(2)}` : "—"} />
        <DetailRow label="Last" value={meta.last != null ? `$${meta.last.toFixed(2)}` : "—"} />
        <DetailRow
          label="Spread"
          value={spread != null ? `$${spread.toFixed(2)}${spreadPct != null ? ` (${spreadPct.toFixed(1)}%)` : ""}` : "—"}
        />
        <DetailRow
          label="Classif"
          value={(meta.classification ?? "—").toUpperCase()}
          tone={meta.classification === "buy" ? "up" : meta.classification === "sell" ? "down" : undefined}
        />

        <DetailRow label="Volume" value={meta.volume != null ? meta.volume.toLocaleString() : "—"} />
        <DetailRow
          label="Δ Volume"
          value={meta.deltaVol != null && meta.deltaVol > 0 ? `+${meta.deltaVol}` : "—"}
          tone={meta.deltaVol && meta.deltaVol > 0 ? "up" : undefined}
        />
        <DetailRow label="OI" value={meta.openInterest != null ? meta.openInterest.toLocaleString() : "—"} />
        <DetailRow
          label="Notional"
          value={meta.notional != null ? fmtMoney(meta.notional) : "—"}
        />

        {stats && (
          <>
            <DetailRow label="Session High" value={`$${stats.high.toFixed(2)}`} tone="up" />
            <DetailRow label="Session Low" value={`$${stats.low.toFixed(2)}`} tone="down" />
            <DetailRow
              label="Session Δ"
              value={`${stats.change >= 0 ? "+" : ""}${stats.change.toFixed(2)} (${stats.changePct >= 0 ? "+" : ""}${stats.changePct.toFixed(1)}%)`}
              tone={stats.change >= 0 ? "up" : "down"}
            />
            <DetailRow label="Buy vol" value={stats.totalBuy.toLocaleString()} tone="up" />
            <DetailRow label="Sell vol" value={stats.totalSell.toLocaleString()} tone="down" />
            <DetailRow
              label="Flow bias"
              value={`${stats.dominance >= 0 ? "+" : ""}${stats.dominance.toFixed(0)}% ${stats.dominance >= 0 ? "BUY" : "SELL"}`}
              tone={stats.dominance >= 0 ? "up" : "down"}
            />
          </>
        )}
      </div>

      <div className="pt-1 text-[9px] font-mono text-muted-foreground">
        {barsCount} bars · {(bucketMs / 60_000).toFixed(0)}m buckets · key {meta.key}
      </div>
    </div>
  );
}

function DetailRow({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-foreground";
  return (
    <div className="flex items-center justify-between rounded border bg-muted/10 px-2 py-1">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`font-mono text-[11px] tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

function fmtMoney(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function _DeprecatedStat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-foreground";
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`font-mono text-sm font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      <span>{label}</span>
    </span>
  );
}
