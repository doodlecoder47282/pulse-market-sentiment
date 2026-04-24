/**
 * DepthSkewFlow.tsx — three synchronized real-time views of the 0DTE chain
 *   1. Depth    — call OI vs put OI per strike (bipolar horizontal DOM)
 *   2. Skew     — call IV and put IV curves across strikes (the smirk/smile)
 *   3. Flow     — live buy vs sell notional per strike, classified by tick rule
 *
 * Data sources:
 *   - /api/heatseeker    → strikes with OI / volume / IV (5s poll)
 *   - /api/odte-tracker  → per-contract rows with classification + notional (4s poll)
 *
 * All three panels share the same strike-axis band around spot (±20 strikes)
 * so a trader's eye can trace a single strike across depth → skew → flow.
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Layers, TrendingUpIcon, Waves } from "lucide-react";

// ─── Types (mirror server payloads) ─────────────────────────────────────────
interface HeatseekerStrike {
  strike: number;
  distancePct: number;
  netGex: number;
  netDex: number;
  netVanna: number;
  netCharm: number;
  callOI: number;
  putOI: number;
  totalOI: number;
  callVol: number;
  putVol: number;
  totalVol: number;
  callIV: number | null;
  putIV: number | null;
}

interface HeatseekerPayload {
  symbol: string;
  spot: number;
  expiry: string;
  dte: number;
  asOf: number;
  strikes: HeatseekerStrike[];
}

interface TrackerContract {
  key: string;
  strike: number;
  side: "call" | "put";
  notional: number;
  volume: number;
  classification: "buy" | "sell_inferred" | "neutral";
  last: number | null;
}

interface TrackerSnapshot {
  spot: number;
  asOf: number;
  contracts: TrackerContract[];
}

type Mode = "depth" | "skew" | "flow";

// ─── Helpers ────────────────────────────────────────────────────────────────
function fmtK(n: number): string {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtDollars(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

// ─── Main component ─────────────────────────────────────────────────────────
export default function DepthSkewFlow() {
  const [mode, setMode] = useState<Mode>("depth");

  const heat = useQuery<HeatseekerPayload>({
    queryKey: ["/api/heatseeker"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/heatseeker");
      return r.json();
    },
    refetchInterval: 5_000,
    staleTime: 4_000,
  });

  const tracker = useQuery<TrackerSnapshot>({
    queryKey: ["/api/odte-tracker"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/odte-tracker");
      return r.json();
    },
    refetchInterval: 4_000,
    staleTime: 3_000,
    enabled: mode === "flow",
  });

  const spot = heat.data?.spot ?? null;
  const strikes = heat.data?.strikes ?? [];

  // ─── Depth data: bipolar OI per strike (calls positive, puts negative) ──
  const depthData = useMemo(() => {
    return strikes.map((s) => ({
      strike: s.strike,
      callOI: s.callOI,
      putOINeg: -s.putOI,
      putOI: s.putOI,
      callVol: s.callVol,
      putVolNeg: -s.putVol,
      putVol: s.putVol,
    }));
  }, [strikes]);

  // ─── Skew data: IV curves across strikes, with ATM reference ────────────
  const skewData = useMemo(() => {
    return strikes
      .filter((s) => s.callIV != null || s.putIV != null)
      .map((s) => ({
        strike: s.strike,
        callIV: s.callIV != null ? s.callIV * 100 : null,
        putIV: s.putIV != null ? s.putIV * 100 : null,
        // "smirk" = put IV minus call IV, the classic skew measure
        smirk:
          s.callIV != null && s.putIV != null
            ? (s.putIV - s.callIV) * 100
            : null,
      }));
  }, [strikes]);

  // ─── Flow data: aggregate tracker contracts by strike ──────────────────
  const flowData = useMemo(() => {
    if (!tracker.data?.contracts?.length) return [];
    const byStrike = new Map<
      number,
      { buyNotional: number; sellNotional: number; netNotional: number }
    >();
    for (const c of tracker.data.contracts) {
      const cur = byStrike.get(c.strike) ?? {
        buyNotional: 0,
        sellNotional: 0,
        netNotional: 0,
      };
      if (c.classification === "buy") {
        cur.buyNotional += c.notional;
        cur.netNotional += c.notional;
      } else if (c.classification === "sell_inferred") {
        cur.sellNotional += c.notional;
        cur.netNotional -= c.notional;
      }
      byStrike.set(c.strike, cur);
    }
    return Array.from(byStrike.entries())
      .map(([strike, f]) => ({
        strike,
        buyNotional: f.buyNotional,
        sellNotionalNeg: -f.sellNotional,
        sellNotional: f.sellNotional,
        netNotional: f.netNotional,
      }))
      .sort((a, b) => a.strike - b.strike);
  }, [tracker.data]);

  // ─── Header stat summaries ────────────────────────────────────────────
  const totalCallOI = useMemo(
    () => strikes.reduce((sum, s) => sum + s.callOI, 0),
    [strikes],
  );
  const totalPutOI = useMemo(
    () => strikes.reduce((sum, s) => sum + s.putOI, 0),
    [strikes],
  );
  const pcrOI = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

  const atmStrike = useMemo(() => {
    if (spot == null || !strikes.length) return null;
    return strikes.reduce((best, s) =>
      Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best,
    );
  }, [strikes, spot]);

  const atmSkew =
    atmStrike?.callIV != null && atmStrike?.putIV != null
      ? (atmStrike.putIV - atmStrike.callIV) * 100
      : null;

  const flowNet = useMemo(
    () => flowData.reduce((sum, f) => sum + f.netNotional, 0),
    [flowData],
  );

  if (heat.isLoading) {
    return (
      <Card data-testid="depth-skew-flow-loading">
        <CardHeader>
          <CardTitle className="text-base">Depth · Skew · Flow</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64 animate-pulse rounded-md bg-muted/30" />
        </CardContent>
      </Card>
    );
  }

  const modeMeta: Record<
    Mode,
    { icon: React.ReactNode; label: string; blurb: string }
  > = {
    depth: {
      icon: <Layers className="h-4 w-4" />,
      label: "Depth",
      blurb: "Open interest by strike — where liquidity lives",
    },
    skew: {
      icon: <TrendingUpIcon className="h-4 w-4" />,
      label: "Skew",
      blurb: "IV smirk across strikes — put vs call volatility pricing",
    },
    flow: {
      icon: <Waves className="h-4 w-4" />,
      label: "Flow",
      blurb: "Live buy vs sell notional, tick-rule classified",
    },
  };

  return (
    <Card data-testid="depth-skew-flow">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {modeMeta[mode].icon}
              {modeMeta[mode].label} · {heat.data?.symbol} 0DTE
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {modeMeta[mode].blurb}
            </p>
          </div>

          {/* Mode toggle */}
          <div
            className="inline-flex overflow-hidden rounded-md border border-border/60 bg-muted/20"
            role="tablist"
            data-testid="depth-skew-flow-modes"
          >
            {(["depth", "skew", "flow"] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                data-testid={`mode-${m}`}
                className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  mode === m
                    ? "bg-orange-500/20 text-orange-300"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Stat strip — context depending on mode */}
        <div className="mt-3 flex flex-wrap gap-4 text-[11px]">
          {mode === "depth" && (
            <>
              <Stat label="Call OI" value={fmtK(totalCallOI)} tone="rose" />
              <Stat label="Put OI" value={fmtK(totalPutOI)} tone="emerald" />
              <Stat
                label="PCR (OI)"
                value={pcrOI.toFixed(2)}
                tone={pcrOI > 1.05 ? "emerald" : pcrOI < 0.95 ? "rose" : "muted"}
              />
            </>
          )}
          {mode === "skew" && (
            <>
              <Stat
                label="ATM call IV"
                value={fmtPct(atmStrike?.callIV)}
                tone="rose"
              />
              <Stat
                label="ATM put IV"
                value={fmtPct(atmStrike?.putIV)}
                tone="emerald"
              />
              <Stat
                label="ATM smirk (P−C)"
                value={atmSkew != null ? `${atmSkew.toFixed(2)}pp` : "—"}
                tone={
                  atmSkew == null
                    ? "muted"
                    : atmSkew > 0.5
                      ? "emerald"
                      : atmSkew < -0.5
                        ? "rose"
                        : "muted"
                }
              />
            </>
          )}
          {mode === "flow" && (
            <>
              <Stat
                label="Net flow ($)"
                value={fmtDollars(flowNet)}
                tone={flowNet > 0 ? "emerald" : flowNet < 0 ? "rose" : "muted"}
              />
              <Stat
                label="Active strikes"
                value={flowData.length.toString()}
                tone="muted"
              />
              <Stat
                label="Poll"
                value={tracker.isFetching ? "refreshing…" : "4s"}
                tone="muted"
              />
            </>
          )}
          <div className="ml-auto font-mono text-[10px] text-muted-foreground">
            Spot{" "}
            <span className="text-foreground">
              {spot != null ? spot.toFixed(2) : "—"}
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div className="h-80">
          {mode === "depth" && (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={depthData}
                layout="vertical"
                stackOffset="sign"
                margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="2 4"
                  stroke="hsl(var(--border))"
                  opacity={0.3}
                />
                <XAxis
                  type="number"
                  tickFormatter={(v) => fmtK(Math.abs(v))}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                />
                <YAxis
                  type="category"
                  dataKey="strike"
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                  width={56}
                  reversed
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--background))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(val: number, name: string) => {
                    if (name === "Put OI")
                      return [fmtK(Math.abs(val)), "Put OI"];
                    return [fmtK(val), name];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
                {spot != null && (
                  <ReferenceLine
                    y={
                      depthData.reduce((best, d) =>
                        Math.abs(d.strike - spot) < Math.abs(best.strike - spot)
                          ? d
                          : best,
                      )?.strike
                    }
                    stroke="hsl(var(--primary))"
                    strokeDasharray="3 3"
                    label={{
                      value: "spot",
                      position: "right",
                      fill: "hsl(var(--primary))",
                      fontSize: 10,
                    }}
                  />
                )}
                <Bar
                  dataKey="putOINeg"
                  name="Put OI"
                  fill="hsl(142 76% 45%)"
                  stackId="a"
                />
                <Bar
                  dataKey="callOI"
                  name="Call OI"
                  fill="hsl(350 82% 60%)"
                  stackId="a"
                />
              </BarChart>
            </ResponsiveContainer>
          )}

          {mode === "skew" && (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={skewData}
                margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="2 4"
                  stroke="hsl(var(--border))"
                  opacity={0.3}
                />
                <XAxis
                  dataKey="strike"
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                />
                <YAxis
                  tickFormatter={(v) => `${v.toFixed(0)}%`}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                  width={44}
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--background))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(v: number) => `${v.toFixed(2)}%`}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
                {spot != null && (
                  <ReferenceLine
                    x={
                      skewData.reduce((best, d) =>
                        Math.abs(d.strike - spot) < Math.abs(best.strike - spot)
                          ? d
                          : best,
                      )?.strike
                    }
                    stroke="hsl(var(--primary))"
                    strokeDasharray="3 3"
                    label={{
                      value: "ATM",
                      position: "top",
                      fill: "hsl(var(--primary))",
                      fontSize: 10,
                    }}
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="callIV"
                  name="Call IV"
                  stroke="hsl(350 82% 60%)"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="putIV"
                  name="Put IV"
                  stroke="hsl(142 76% 45%)"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="smirk"
                  name="Smirk (P−C)"
                  stroke="hsl(45 93% 58%)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          )}

          {mode === "flow" &&
            (flowData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <div className="text-center">
                  <Waves className="mx-auto mb-2 h-8 w-8 opacity-40" />
                  <p>
                    Monitoring 0DTE flow — no classified tick prints yet.
                    <br />
                    <span className="text-xs opacity-70">
                      Buys fire near ask, sells near bid; mid prints are
                      excluded from net.
                    </span>
                  </p>
                </div>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={flowData}
                  stackOffset="sign"
                  margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                >
                  <CartesianGrid
                    strokeDasharray="2 4"
                    stroke="hsl(var(--border))"
                    opacity={0.3}
                  />
                  <XAxis
                    dataKey="strike"
                    tick={{
                      fill: "hsl(var(--muted-foreground))",
                      fontSize: 10,
                    }}
                  />
                  <YAxis
                    tickFormatter={(v) => fmtDollars(Math.abs(v))}
                    tick={{
                      fill: "hsl(var(--muted-foreground))",
                      fontSize: 10,
                    }}
                    width={56}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--background))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(val: number, name: string) => {
                      if (name === "Sell notional")
                        return [fmtDollars(Math.abs(val)), "Sell notional"];
                      return [fmtDollars(val), name];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
                  {spot != null && (
                    <ReferenceLine
                      x={
                        flowData.reduce((best, d) =>
                          Math.abs(d.strike - spot) <
                          Math.abs(best.strike - spot)
                            ? d
                            : best,
                        )?.strike
                      }
                      stroke="hsl(var(--primary))"
                      strokeDasharray="3 3"
                      label={{
                        value: "spot",
                        position: "top",
                        fill: "hsl(var(--primary))",
                        fontSize: 10,
                      }}
                    />
                  )}
                  <ReferenceLine y={0} stroke="hsl(var(--border))" />
                  <Bar
                    dataKey="buyNotional"
                    name="Buy notional"
                    fill="hsl(142 76% 45%)"
                    stackId="a"
                    maxBarSize={32}
                  />
                  <Bar
                    dataKey="sellNotionalNeg"
                    name="Sell notional"
                    fill="hsl(350 82% 60%)"
                    stackId="a"
                    maxBarSize={32}
                  />
                </BarChart>
              </ResponsiveContainer>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "emerald" | "rose" | "muted";
}) {
  const cls =
    tone === "emerald"
      ? "text-emerald-400"
      : tone === "rose"
        ? "text-rose-400"
        : "text-foreground";
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={`font-mono text-sm font-semibold tabular-nums ${cls}`}>
        {value}
      </span>
    </div>
  );
}
