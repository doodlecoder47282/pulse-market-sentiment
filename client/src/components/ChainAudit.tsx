/**
 * ChainAudit.tsx
 * Live 10-computation SPX option chain audit panel.
 * Renders all 10 institutional metrics from /api/chain-audit.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RefreshCw, AlertTriangle, WifiOff, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

// ─── Types (mirror server/chainAudit.ts) ─────────────────────────────────────

interface DEXResult {
  profile: { strike: number; callDex: number; putDex: number; netDex: number }[];
  maxPositive: { strike: number; value: number } | null;
  maxNegative: { strike: number; value: number } | null;
  flipStrike: number | null;
  totalCallDex: number;
  totalPutDex: number;
  totalNetDex: number;
}

interface VannaResult {
  profile: { strike: number; vannaExposure: number }[];
  peakVannaStrike: number | null;
  totalVannaDollarPerVolPct: number;
}

interface CharmResult {
  profile: { strike: number; charmExposure: number }[];
  peakCharmStrike: number | null;
  totalCharmPerDay: number;
}

interface SkewEntry {
  expiry: string;
  dte: number;
  put25IV: number | null;
  call25IV: number | null;
  atmIV: number | null;
  skew: number | null;
  elevatedFear: boolean;
}

interface TermStructureEntry { expiry: string; dte: number; atmIV: number | null }
interface TermStructureResult {
  term: TermStructureEntry[];
  contango: boolean | null;
  steepness: number | null;
}

interface UnusualContract {
  symbol: string;
  strike: number;
  side: "call" | "put";
  expiry: string;
  dte: number;
  volume: number;
  oi: number;
  volOiRatio: number;
  lastPrice: number;
  dollarVolume: number;
  deltaNotional: number;
}

interface DealerScoreResult {
  score: number;
  rawLong: number;
  rawShort: number;
  regime: "long_gamma" | "short_gamma" | "neutral";
}

interface GEXBucket {
  callWall: number | null;
  putWall: number | null;
  zeroGamma: number | null;
  totalGex: number;
  contractCount: number;
}

interface GEXDecayResult {
  zerodte: GEXBucket;
  short: GEXBucket;
  weekly: GEXBucket;
  monthly: GEXBucket;
  combined: GEXBucket;
}

interface PinStrike { strike: number; prob: number; distance: number }

interface VRPEntry {
  expiry: string;
  dte: number;
  marketIV: number | null;
  theoreticalIV: number | null;
  vrp: number | null;
  signal: "sell_vol" | "buy_vol" | "neutral" | "n/a";
}

interface ChainAuditResult {
  dex: DEXResult;
  vanna: VannaResult;
  charm: CharmResult;
  skew: SkewEntry[];
  termStructure: TermStructureResult;
  unusualVolume: UnusualContract[];
  dealerScore: DealerScoreResult;
  gexDecay: GEXDecayResult;
  pinning: PinStrike[];
  vrp: VRPEntry[];
  contractsProcessed: number;
  expiriesFound: number;
  dataQuality: "full" | "partial" | "minimal";
}

interface ChainAuditResponse {
  symbol: string;
  requestedSymbol: string;
  spot: number;
  asOf: number;
  audit: ChainAuditResult;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const fmtStrike = (n: number | null) => n != null ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "N/A";
const fmtIV = (n: number | null) => n != null && isFinite(n) ? `${(n * 100).toFixed(1)}%` : "N/A";
const fmtDollar = (n: number) => {
  if (!isFinite(n)) return "N/A";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};
const fmtGex = (n: number) => {
  if (!isFinite(n)) return "N/A";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "+";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
};
const fmtVolume = (n: number) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString();
};
const fmtDelta = (n: number) => n.toFixed(2);
const fmtRatio = (n: number) => n.toFixed(1) + "x";

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ago`;
}

// ─── Color helpers ────────────────────────────────────────────────────────────

const CALL_COLOR = "#22c55e";
const PUT_COLOR  = "#ef4444";
const NET_COLOR  = "#06b6d4";
const VANNA_COLOR = "#a78bfa";
const CHARM_COLOR = "#f97316";

// ─── Row KPI card ─────────────────────────────────────────────────────────────

function KPICard({
  label, value, sub, color, testId,
}: {
  label: string; value: string; sub?: string; color?: string; testId?: string;
}) {
  return (
    <Card className="bg-card/60 border-border/40" data-testid={testId}>
      <CardContent className="py-3 px-4">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono mb-1">{label}</div>
        <div className="font-mono font-bold text-sm" style={{ color: color ?? "var(--foreground)" }}>{value}</div>
        {sub && <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

// ─── GEX Bucket cell ──────────────────────────────────────────────────────────

function GEXBucketCard({ label, bucket, testId }: { label: string; bucket: GEXBucket; testId?: string }) {
  return (
    <Card className="bg-card/60 border-border/40" data-testid={testId}>
      <CardHeader className="py-2 px-3">
        <CardTitle className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="px-3 py-1 space-y-0.5">
        <div className="flex justify-between font-mono text-[11px]">
          <span className="text-muted-foreground">Call Wall</span>
          <span className="text-green-400">{fmtStrike(bucket.callWall)}</span>
        </div>
        <div className="flex justify-between font-mono text-[11px]">
          <span className="text-muted-foreground">Put Wall</span>
          <span className="text-red-400">{fmtStrike(bucket.putWall)}</span>
        </div>
        <div className="flex justify-between font-mono text-[11px]">
          <span className="text-muted-foreground">Zero Gamma</span>
          <span className="text-amber-400">{fmtStrike(bucket.zeroGamma)}</span>
        </div>
        <div className="flex justify-between font-mono text-[11px] border-t border-border/30 pt-1 mt-1">
          <span className="text-muted-foreground">Net GEX</span>
          <span className={bucket.totalGex >= 0 ? "text-green-400" : "text-red-400"}>
            {fmtGex(bucket.totalGex)}
          </span>
        </div>
        <div className="font-mono text-[10px] text-muted-foreground/60">
          {bucket.contractCount} contracts
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Dealer Score Gauge ───────────────────────────────────────────────────────

function DealerGauge({ score, regime }: { score: number; regime: string }) {
  const pct = ((score + 100) / 200) * 100; // map -100..+100 to 0..100%
  const color = score > 10 ? "#22c55e" : score < -10 ? "#ef4444" : "#f59e0b";
  const regimeLabel = regime === "long_gamma" ? "Long Gamma" : regime === "short_gamma" ? "Short Gamma" : "Neutral";
  return (
    <div className="flex flex-col gap-1" data-testid="dealer-gauge">
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>Short (-100)</span>
        <span style={{ color }} className="font-bold text-sm">{score > 0 ? "+" : ""}{score.toFixed(1)}</span>
        <span>Long (+100)</span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted/30 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(2, Math.min(98, pct))}%`, background: color }}
        />
      </div>
      <div className="text-center font-mono text-[10px]" style={{ color }}>
        {regimeLabel}
      </div>
    </div>
  );
}

// ─── VRP signal badge ────────────────────────────────────────────────────────

function VRPSignalBadge({ signal }: { signal: VRPEntry["signal"] }) {
  if (signal === "sell_vol") return <Badge className="bg-red-500/20 text-red-400 border-red-500/40 font-mono text-[10px]">Sell Vol</Badge>;
  if (signal === "buy_vol") return <Badge className="bg-green-500/20 text-green-400 border-green-500/40 font-mono text-[10px]">Buy Vol</Badge>;
  if (signal === "neutral") return <Badge className="bg-muted/30 text-muted-foreground border-border/40 font-mono text-[10px]">Neutral</Badge>;
  return <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground/60">N/A</Badge>;
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 border-b border-border/30 pb-1">
        {title}
      </div>
      {children}
    </div>
  );
}

// ─── Error / Auth state ───────────────────────────────────────────────────────

function AuditError({ message, isSchwabRequired }: { message: string; isSchwabRequired?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border/40 bg-card/40 py-10 text-center">
      {isSchwabRequired
        ? <WifiOff className="h-8 w-8 text-amber-400" />
        : <AlertTriangle className="h-8 w-8 text-red-400" />}
      <div className="font-mono text-[11px] text-muted-foreground max-w-sm leading-relaxed">{message}</div>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function AuditSkeleton() {
  return (
    <div className="space-y-4" data-testid="chain-audit-skeleton">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-16 bg-muted/20" />)}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-24 bg-muted/20" />)}
      </div>
      <Skeleton className="h-48 bg-muted/20" />
      <Skeleton className="h-40 bg-muted/20" />
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ChainAudit() {
  const [symbol, setSymbol] = useState("$SPX");

  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useQuery<ChainAuditResponse>({
    queryKey: ["/api/chain-audit", symbol],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/chain-audit?symbol=${encodeURIComponent(symbol)}&dte=60`);
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: 1,
  });

  const audit = data?.audit;
  const isSchwabError = (error as any)?.status === 503
    || (data as any)?.error === "schwab_required"
    || (isError && String((error as any)?.message ?? "").includes("schwab"));

  return (
    <div className="space-y-4" data-testid="chain-audit-panel">
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/40 bg-card/40 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-cyan-400">Live Chain Audit</span>
        <span className="text-border/60">·</span>

        {/* Symbol toggle */}
        <div className="flex gap-1 rounded border border-border/60 bg-black/30 p-0.5">
          {(["$SPX", "SPY"] as const).map(s => (
            <Button
              key={s}
              variant={symbol === s ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2.5 text-[10px] font-mono"
              onClick={() => setSymbol(s)}
              data-testid={`btn-chain-symbol-${s}`}
            >
              {s}
            </Button>
          ))}
        </div>

        {data && (
          <Badge variant="outline" className="border-cyan-500/40 font-mono text-[9px] text-cyan-400">
            {data.symbol} · {data.audit.contractsProcessed.toLocaleString()} contracts · {data.audit.expiriesFound} expiries
          </Badge>
        )}
        {data?.audit?.dataQuality === "partial" && (
          <Badge variant="outline" className="border-amber-500/40 font-mono text-[9px] text-amber-400">
            Partial Data
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-2">
          {dataUpdatedAt > 0 && (
            <span className="font-mono text-[9px] text-muted-foreground/60" data-testid="chain-audit-timestamp">
              Updated {timeAgo(dataUpdatedAt)}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-6 gap-1 font-mono text-[10px]"
            data-testid="btn-chain-audit-refresh"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* States */}
      {isLoading && <AuditSkeleton />}

      {isError && !isLoading && (
        <AuditError
          isSchwabRequired={isSchwabError}
          message={
            isSchwabError
              ? "Schwab connection required for chain audit. Connect Schwab in Settings to enable live option chain data."
              : `Chain audit unavailable: ${(error as any)?.message ?? "unknown error"}`
          }
        />
      )}

      {!isLoading && !isError && !audit && (
        <AuditError message="No chain data returned. The market may be closed or the symbol unsupported." />
      )}

      {/* ── Main content ── */}
      {audit && data && (
        <div className="space-y-6">
          {/* Row 1: 4 KPI cards */}
          <Section title="Key Levels" testId="section-kpi">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <KPICard
                label="DEX Flip Strike"
                value={fmtStrike(audit.dex.flipStrike)}
                sub={audit.dex.flipStrike ? `${(audit.dex.flipStrike - data.spot).toFixed(0)} pts from spot` : undefined}
                color="#06b6d4"
                testId="kpi-dex-flip"
              />
              <KPICard
                label="Peak Vanna Strike"
                value={fmtStrike(audit.vanna.peakVannaStrike)}
                sub={`${fmtDollar(audit.vanna.totalVannaDollarPerVolPct)} / 1% vol`}
                color="#a78bfa"
                testId="kpi-vanna-peak"
              />
              <KPICard
                label="Peak Charm Strike"
                value={fmtStrike(audit.charm.peakCharmStrike)}
                sub={`${fmtDollar(audit.charm.totalCharmPerDay)} / day`}
                color="#f97316"
                testId="kpi-charm-peak"
              />
              <Card className="bg-card/60 border-border/40" data-testid="kpi-dealer-score">
                <CardContent className="py-3 px-4">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono mb-2">
                    Dealer Score
                  </div>
                  <DealerGauge score={audit.dealerScore.score} regime={audit.dealerScore.regime} />
                </CardContent>
              </Card>
            </div>
          </Section>

          {/* Row 2: GEX Decay Ladder */}
          <Section title="GEX Decay Ladder — by DTE Bucket" testId="section-gex-decay">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <GEXBucketCard label="0DTE" bucket={audit.gexDecay.zerodte} testId="gex-bucket-0dte" />
              <GEXBucketCard label="1–2 DTE" bucket={audit.gexDecay.short} testId="gex-bucket-short" />
              <GEXBucketCard label="Weekly (3–7)" bucket={audit.gexDecay.weekly} testId="gex-bucket-weekly" />
              <GEXBucketCard label="Monthly (8+)" bucket={audit.gexDecay.monthly} testId="gex-bucket-monthly" />
            </div>
          </Section>

          {/* Row 3: Term Structure + IV Skew */}
          <Section title="Vol Surface" testId="section-vol-surface">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {/* Term Structure Chart */}
              <Card className="bg-card/60 border-border/40">
                <CardHeader className="py-2 px-3">
                  <CardTitle className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    Term Structure
                    {audit.termStructure.contango != null && (
                      <Badge variant="outline" className={`text-[9px] font-mono ${audit.termStructure.contango ? "border-green-500/40 text-green-400" : "border-red-500/40 text-red-400"}`}>
                        {audit.termStructure.contango ? "Contango" : "Backwardation"}
                        {audit.termStructure.steepness != null && ` ${(audit.termStructure.steepness * 100).toFixed(1)}pp`}
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  {audit.termStructure.term.filter(e => e.atmIV != null).length < 2 ? (
                    <div className="font-mono text-[11px] text-muted-foreground text-center py-8">Insufficient term structure data</div>
                  ) : (
                    <div className="h-40" data-testid="chart-term-structure">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={audit.termStructure.term.filter(e => e.atmIV != null).map(e => ({
                            dte: e.dte,
                            label: `${e.dte}d`,
                            iv: +(e.atmIV! * 100).toFixed(2),
                          }))}
                          margin={{ top: 4, right: 12, left: 0, bottom: 4 }}
                        >
                          <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#64748b" }} tickLine={false} axisLine={false} />
                          <YAxis
                            tick={{ fontSize: 9, fill: "#64748b" }}
                            tickFormatter={v => `${v}%`}
                            width={36}
                            tickLine={false}
                            axisLine={false}
                          />
                          <Tooltip
                            contentStyle={{ background: "#0a0a0f", border: "1px solid #1e293b", fontSize: 10, fontFamily: "var(--font-mono)" }}
                            formatter={(v: number) => [`${v.toFixed(2)}%`, "ATM IV"]}
                          />
                          <Line
                            type="monotone"
                            dataKey="iv"
                            stroke={NET_COLOR}
                            strokeWidth={2}
                            dot={{ r: 3, fill: NET_COLOR }}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* IV Skew table */}
              <Card className="bg-card/60 border-border/40">
                <CardHeader className="py-2 px-3">
                  <CardTitle className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    IV Skew (25-Delta)
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-0 pb-2">
                  <div className="max-h-44 overflow-y-auto" data-testid="table-iv-skew">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-border/30">
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-1 px-3">Expiry</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-1 text-right">DTE</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-1 text-right">ATM IV</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-1 text-right">25P IV</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-1 text-right">25C IV</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-1 text-right">Skew</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {audit.skew.slice(0, 12).map((row, i) => (
                          <TableRow
                            key={row.expiry}
                            className={`border-border/20 ${row.elevatedFear ? "bg-red-500/5" : ""}`}
                            data-testid={`row-skew-${i}`}
                          >
                            <TableCell className="font-mono text-[10px] py-1 px-3 text-muted-foreground">{row.expiry}</TableCell>
                            <TableCell className="font-mono text-[10px] py-1 text-right">{row.dte}</TableCell>
                            <TableCell className="font-mono text-[10px] py-1 text-right">{fmtIV(row.atmIV)}</TableCell>
                            <TableCell className="font-mono text-[10px] py-1 text-right text-red-400">{fmtIV(row.put25IV)}</TableCell>
                            <TableCell className="font-mono text-[10px] py-1 text-right text-green-400">{fmtIV(row.call25IV)}</TableCell>
                            <TableCell className="font-mono text-[10px] py-1 text-right">
                              {row.skew != null ? (
                                <span className={row.elevatedFear ? "text-red-400 font-semibold" : ""}>
                                  {(row.skew * 100).toFixed(1)}pp
                                  {row.elevatedFear && " !"}
                                </span>
                              ) : "N/A"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </div>
          </Section>

          {/* Row 4: DEX Profile chart */}
          <Section title="DEX — Delta Exposure Profile" testId="section-dex">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Card className="bg-card/60 border-border/40">
                  <CardContent className="px-2 pt-3 pb-2">
                    {audit.dex.profile.length === 0 ? (
                      <div className="font-mono text-[11px] text-muted-foreground text-center py-8">No DEX data</div>
                    ) : (
                      <div className="h-44" data-testid="chart-dex">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart
                            data={audit.dex.profile.slice(
                              Math.max(0, audit.dex.profile.findIndex(p => p.strike >= data.spot) - 15),
                              audit.dex.profile.findIndex(p => p.strike >= data.spot) + 15
                            ).map(p => ({
                              strike: p.strike,
                              callDex: p.callDex,
                              putDex: p.putDex,
                              netDex: p.netDex,
                            }))}
                            margin={{ top: 4, right: 4, left: 0, bottom: 4 }}
                            barSize={6}
                          >
                            <XAxis
                              dataKey="strike"
                              tick={{ fontSize: 8, fill: "#64748b" }}
                              tickLine={false}
                              axisLine={false}
                              tickFormatter={v => v.toLocaleString()}
                            />
                            <YAxis
                              tick={{ fontSize: 9, fill: "#64748b" }}
                              tickFormatter={v => {
                                const abs = Math.abs(v);
                                if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
                                if (abs >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
                                return v.toFixed(0);
                              }}
                              width={44}
                              tickLine={false}
                              axisLine={false}
                            />
                            <Tooltip
                              contentStyle={{ background: "#0a0a0f", border: "1px solid #1e293b", fontSize: 10, fontFamily: "var(--font-mono)" }}
                              formatter={(v: number, name: string) => [fmtDollar(v), name.toUpperCase()]}
                            />
                            <ReferenceLine y={0} stroke="#475569" strokeDasharray="2 2" />
                            <ReferenceLine x={data.spot} stroke="#f59e0b" strokeDasharray="3 3" />
                            <Bar dataKey="callDex" fill={CALL_COLOR} opacity={0.7} />
                            <Bar dataKey="putDex" fill={PUT_COLOR} opacity={0.7} />
                            <Bar dataKey="netDex" fill={NET_COLOR} opacity={0.9} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
              <div className="space-y-2">
                <KPICard
                  label="Net DEX"
                  value={fmtDollar(audit.dex.totalNetDex)}
                  sub={`Calls: ${fmtDollar(audit.dex.totalCallDex)}`}
                  color={audit.dex.totalNetDex >= 0 ? CALL_COLOR : PUT_COLOR}
                  testId="kpi-net-dex"
                />
                {audit.dex.maxPositive && (
                  <KPICard
                    label="Max Positive DEX"
                    value={fmtStrike(audit.dex.maxPositive.strike)}
                    sub={fmtDollar(audit.dex.maxPositive.value)}
                    color={CALL_COLOR}
                    testId="kpi-max-pos-dex"
                  />
                )}
                {audit.dex.maxNegative && (
                  <KPICard
                    label="Max Negative DEX"
                    value={fmtStrike(audit.dex.maxNegative.strike)}
                    sub={fmtDollar(audit.dex.maxNegative.value)}
                    color={PUT_COLOR}
                    testId="kpi-max-neg-dex"
                  />
                )}
              </div>
            </div>
          </Section>

          {/* Row 5: Pinning Probability */}
          <Section title="Pinning Probability — Nearest Expiry" testId="section-pinning">
            {audit.pinning.length === 0 ? (
              <div className="font-mono text-[11px] text-muted-foreground text-center py-4">No pinning data available</div>
            ) : (
              <Card className="bg-card/60 border-border/40">
                <CardContent className="px-2 pt-3 pb-2">
                  <div className="h-32" data-testid="chart-pinning">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={audit.pinning.map(p => ({
                          label: fmtStrike(p.strike),
                          prob: +p.prob.toFixed(2),
                          fill: Math.abs(p.distance) < 5 ? "#f59e0b" : "#06b6d4",
                        }))}
                        margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                        barSize={32}
                      >
                        <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} axisLine={false} />
                        <YAxis
                          tick={{ fontSize: 9, fill: "#64748b" }}
                          tickFormatter={v => `${v.toFixed(0)}%`}
                          width={32}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip
                          contentStyle={{ background: "#0a0a0f", border: "1px solid #1e293b", fontSize: 10, fontFamily: "var(--font-mono)" }}
                          formatter={(v: number) => [`${v.toFixed(2)}%`, "Pin Probability"]}
                        />
                        <Bar dataKey="prob" isAnimationActive={false}>
                          {audit.pinning.map((p, i) => (
                            <Cell key={i} fill={Math.abs(p.distance) < 10 ? "#f59e0b" : "#06b6d4"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex flex-wrap gap-3 mt-2 justify-center">
                    {audit.pinning.map((p, i) => (
                      <div key={i} className="font-mono text-[10px] text-center" data-testid={`pin-strike-${i}`}>
                        <div className="font-semibold" style={{ color: Math.abs(p.distance) < 10 ? "#f59e0b" : "#06b6d4" }}>
                          {fmtStrike(p.strike)}
                        </div>
                        <div className="text-muted-foreground">{p.prob.toFixed(1)}%</div>
                        <div className="text-muted-foreground/60">{p.distance > 0 ? "+" : ""}{p.distance.toFixed(0)}pt</div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </Section>

          {/* Row 6: Unusual Volume Table */}
          <Section title="Unusual Volume — Vol/OI Ratio > 2x" testId="section-unusual-vol">
            {audit.unusualVolume.length === 0 ? (
              <div className="font-mono text-[11px] text-muted-foreground text-center py-4">No unusual volume detected</div>
            ) : (
              <Card className="bg-card/60 border-border/40">
                <CardContent className="px-0 pb-2 pt-0">
                  <div className="overflow-x-auto" data-testid="table-unusual-volume">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-border/30">
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 px-3">Strike</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2">Side</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2">Expiry</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 text-right">DTE</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 text-right">Vol</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 text-right">OI</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 text-right">Ratio</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 text-right">$ Vol</TableHead>
                          <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 text-right">Price</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {audit.unusualVolume.map((row, i) => (
                          <TableRow
                            key={i}
                            className={`border-border/20 ${row.volOiRatio > 5 ? "bg-amber-500/5" : ""}`}
                            data-testid={`row-unusual-vol-${i}`}
                          >
                            <TableCell className="font-mono text-[10px] py-1.5 px-3 font-semibold">
                              {fmtStrike(row.strike)}
                            </TableCell>
                            <TableCell className="font-mono text-[10px] py-1.5">
                              <Badge
                                className={`text-[9px] font-mono ${row.side === "call"
                                  ? "bg-green-500/20 text-green-400 border-green-500/40"
                                  : "bg-red-500/20 text-red-400 border-red-500/40"}`}
                              >
                                {row.side.toUpperCase()}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-[10px] py-1.5 text-muted-foreground">{row.expiry}</TableCell>
                            <TableCell className="font-mono text-[10px] py-1.5 text-right">{row.dte}</TableCell>
                            <TableCell className="font-mono text-[10px] py-1.5 text-right">{fmtVolume(row.volume)}</TableCell>
                            <TableCell className="font-mono text-[10px] py-1.5 text-right text-muted-foreground">{fmtVolume(row.oi)}</TableCell>
                            <TableCell className="font-mono text-[10px] py-1.5 text-right">
                              <span className={row.volOiRatio > 5 ? "text-amber-400 font-semibold" : "text-foreground"}>
                                {fmtRatio(row.volOiRatio)}
                              </span>
                            </TableCell>
                            <TableCell className="font-mono text-[10px] py-1.5 text-right">{fmtDollar(row.dollarVolume)}</TableCell>
                            <TableCell className="font-mono text-[10px] py-1.5 text-right">${row.lastPrice.toFixed(2)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}
          </Section>

          {/* Row 7: VRP Table */}
          <Section title="Vol Risk Premium (VRP) — Theoretical vs Market IV" testId="section-vrp">
            <Card className="bg-card/60 border-border/40">
              <CardContent className="px-0 pb-2 pt-0">
                <div className="overflow-x-auto" data-testid="table-vrp">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border/30">
                        <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 px-3">Expiry</TableHead>
                        <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 text-right">DTE</TableHead>
                        <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 text-right">Market IV</TableHead>
                        <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 text-right">Theoretical IV</TableHead>
                        <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 text-right">VRP</TableHead>
                        <TableHead className="font-mono text-[9px] uppercase text-muted-foreground/70 py-2 text-right">Signal</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {audit.vrp.map((row, i) => (
                        <TableRow key={row.expiry} className="border-border/20" data-testid={`row-vrp-${i}`}>
                          <TableCell className="font-mono text-[10px] py-1.5 px-3 text-muted-foreground">{row.expiry}</TableCell>
                          <TableCell className="font-mono text-[10px] py-1.5 text-right">{row.dte}</TableCell>
                          <TableCell className="font-mono text-[10px] py-1.5 text-right">{fmtIV(row.marketIV)}</TableCell>
                          <TableCell className="font-mono text-[10px] py-1.5 text-right text-muted-foreground">
                            {row.theoreticalIV != null ? fmtIV(row.theoreticalIV) : <span className="text-muted-foreground/40">N/A</span>}
                          </TableCell>
                          <TableCell className="font-mono text-[10px] py-1.5 text-right">
                            {row.vrp != null ? (
                              <span className={row.vrp < -0.01 ? "text-red-400" : row.vrp > 0.01 ? "text-green-400" : "text-muted-foreground"}>
                                {row.vrp >= 0 ? "+" : ""}{(row.vrp * 100).toFixed(1)}pp
                              </span>
                            ) : <span className="text-muted-foreground/40">N/A</span>}
                          </TableCell>
                          <TableCell className="py-1.5 text-right">
                            <VRPSignalBadge signal={row.signal} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {audit.vrp.every(r => r.vrp == null) && (
                  <div className="font-mono text-[10px] text-muted-foreground/60 text-center py-3">
                    Theoretical IV not available in chain data — Schwab may not provide theoreticalVolatility for this symbol.
                  </div>
                )}
              </CardContent>
            </Card>
          </Section>

          {/* Row 8: Vanna + Charm exposure charts */}
          <Section title="Second-Order Greek Exposures" testId="section-greeks2">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {/* Vanna */}
              <Card className="bg-card/60 border-border/40">
                <CardHeader className="py-2 px-3">
                  <CardTitle className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Vanna Exposure — $ per 1% Vol Move
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  {audit.vanna.profile.length === 0 ? (
                    <div className="font-mono text-[11px] text-muted-foreground text-center py-8">No vanna data</div>
                  ) : (
                    <div className="h-36" data-testid="chart-vanna">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={audit.vanna.profile
                            .slice(
                              Math.max(0, audit.vanna.profile.findIndex(p => p.strike >= data.spot) - 12),
                              audit.vanna.profile.findIndex(p => p.strike >= data.spot) + 12
                            )
                            .map(p => ({ strike: p.strike, vanna: p.vannaExposure }))}
                          margin={{ top: 4, right: 4, left: 0, bottom: 4 }}
                          barSize={6}
                        >
                          <XAxis dataKey="strike" tick={{ fontSize: 8, fill: "#64748b" }} tickLine={false} axisLine={false} tickFormatter={v => v.toLocaleString()} />
                          <YAxis
                            tick={{ fontSize: 9, fill: "#64748b" }}
                            tickFormatter={v => {
                              const abs = Math.abs(v);
                              if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
                              if (abs >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
                              return v.toFixed(0);
                            }}
                            width={40}
                            tickLine={false}
                            axisLine={false}
                          />
                          <Tooltip
                            contentStyle={{ background: "#0a0a0f", border: "1px solid #1e293b", fontSize: 10, fontFamily: "var(--font-mono)" }}
                            formatter={(v: number) => [fmtDollar(v), "Vanna Exp"]}
                          />
                          <ReferenceLine y={0} stroke="#475569" strokeDasharray="2 2" />
                          <ReferenceLine x={data.spot} stroke="#f59e0b" strokeDasharray="3 3" />
                          <Bar dataKey="vanna" isAnimationActive={false}>
                            {audit.vanna.profile.slice(
                              Math.max(0, audit.vanna.profile.findIndex(p => p.strike >= data.spot) - 12),
                              audit.vanna.profile.findIndex(p => p.strike >= data.spot) + 12
                            ).map((p, i) => (
                              <Cell key={i} fill={p.vannaExposure >= 0 ? VANNA_COLOR : "#64748b"} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Charm */}
              <Card className="bg-card/60 border-border/40">
                <CardHeader className="py-2 px-3">
                  <CardTitle className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Charm Exposure — $ per Day
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  {audit.charm.profile.length === 0 ? (
                    <div className="font-mono text-[11px] text-muted-foreground text-center py-8">No charm data</div>
                  ) : (
                    <div className="h-36" data-testid="chart-charm">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={audit.charm.profile
                            .slice(
                              Math.max(0, audit.charm.profile.findIndex(p => p.strike >= data.spot) - 12),
                              audit.charm.profile.findIndex(p => p.strike >= data.spot) + 12
                            )
                            .map(p => ({ strike: p.strike, charm: p.charmExposure }))}
                          margin={{ top: 4, right: 4, left: 0, bottom: 4 }}
                          barSize={6}
                        >
                          <XAxis dataKey="strike" tick={{ fontSize: 8, fill: "#64748b" }} tickLine={false} axisLine={false} tickFormatter={v => v.toLocaleString()} />
                          <YAxis
                            tick={{ fontSize: 9, fill: "#64748b" }}
                            tickFormatter={v => {
                              const abs = Math.abs(v);
                              if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
                              if (abs >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
                              return v.toFixed(0);
                            }}
                            width={40}
                            tickLine={false}
                            axisLine={false}
                          />
                          <Tooltip
                            contentStyle={{ background: "#0a0a0f", border: "1px solid #1e293b", fontSize: 10, fontFamily: "var(--font-mono)" }}
                            formatter={(v: number) => [fmtDollar(v), "Charm Exp"]}
                          />
                          <ReferenceLine y={0} stroke="#475569" strokeDasharray="2 2" />
                          <ReferenceLine x={data.spot} stroke="#f59e0b" strokeDasharray="3 3" />
                          <Bar dataKey="charm" isAnimationActive={false}>
                            {audit.charm.profile.slice(
                              Math.max(0, audit.charm.profile.findIndex(p => p.strike >= data.spot) - 12),
                              audit.charm.profile.findIndex(p => p.strike >= data.spot) + 12
                            ).map((p, i) => (
                              <Cell key={i} fill={p.charmExposure >= 0 ? CHARM_COLOR : "#64748b"} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </Section>

          {/* Footer: data quality + spot */}
          <div className="flex flex-wrap items-center gap-3 border-t border-border/30 pt-3 font-mono text-[9px] text-muted-foreground/50">
            <span>Spot: <span className="text-foreground/80">{data.spot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></span>
            <span>·</span>
            <span>Data quality: <span className={
              audit.dataQuality === "full" ? "text-green-400" :
              audit.dataQuality === "partial" ? "text-amber-400" : "text-red-400"
            }>{audit.dataQuality}</span></span>
            <span>·</span>
            <span>Contracts: {audit.contractsProcessed.toLocaleString()}</span>
            <span>·</span>
            <span>Expiries: {audit.expiriesFound}</span>
            <span>·</span>
            <span>Source: Schwab · {data.symbol}</span>
            {data.requestedSymbol !== data.symbol && (
              <><span>·</span><span className="text-amber-400">Fallback from {data.requestedSymbol}</span></>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
