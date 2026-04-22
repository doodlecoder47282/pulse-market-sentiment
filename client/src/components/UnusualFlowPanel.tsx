// UnusualFlowPanel.tsx
// CBOE-derived unusual options flow for the active chart symbol.
// Mounted as a sub-view of the Chart tab (ViewMode: "flow").
//
// Shows:
//   - Summary cards: flagged count, call/put $, net sentiment, top tag
//   - Contracts table: sorted by notional, flagged when Vol/OI >= 2 and $ >= 25k
//
// When Schwab lands, provider flips from "cboe" to "schwab" transparently — same
// response shape. For now: CBOE delayed chain (~15 min).

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Flame, TrendingUp, TrendingDown, Zap } from "lucide-react";

type FlowTag = "ABOVE_ASK" | "AT_ASK" | "AT_BID" | "BELOW_BID" | "MID";
type FlowSentiment = "BULLISH" | "BEARISH" | "NEUTRAL";

interface UnusualContract {
  occ: string;
  type: "C" | "P";
  strike: number;
  expiration: string;
  dte: number;
  volume: number;
  openInterest: number;
  volOiRatio: number;
  bid: number;
  ask: number;
  last: number;
  mid: number;
  notional: number;
  iv: number;
  tag: FlowTag;
  sentiment: FlowSentiment;
}

interface UnusualResponse {
  provider: "cboe" | "schwab";
  symbol: string;
  spot: number | null;
  contracts: UnusualContract[];
  summary: {
    flaggedCount: number;
    callNotional: number;
    putNotional: number;
    callPutNotionalRatio: number | null;
    aboveAskNotional: number;
    belowBidNotional: number;
    netSentimentNotional: number;
    topTag: FlowTag | null;
  };
  asOf: number;
}

function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${v.toFixed(0)}`;
}

function tagStyle(tag: FlowTag): { text: string; bg: string; border: string; label: string } {
  switch (tag) {
    case "ABOVE_ASK":
      return { text: "text-rose-300", bg: "bg-rose-500/15", border: "border-rose-500/50", label: "ABOVE ASK" };
    case "AT_ASK":
      return { text: "text-amber-300", bg: "bg-amber-500/15", border: "border-amber-500/40", label: "AT ASK" };
    case "AT_BID":
      return { text: "text-cyan-300", bg: "bg-cyan-500/15", border: "border-cyan-500/40", label: "AT BID" };
    case "BELOW_BID":
      return { text: "text-sky-300", bg: "bg-sky-500/15", border: "border-sky-500/50", label: "BELOW BID" };
    default:
      return { text: "text-muted-foreground", bg: "bg-muted/20", border: "border-border/40", label: "MID" };
  }
}

function sentStyle(s: FlowSentiment): string {
  if (s === "BULLISH") return "text-emerald-400";
  if (s === "BEARISH") return "text-rose-400";
  return "text-muted-foreground";
}

function typeStyle(t: "C" | "P"): string {
  return t === "C" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" : "bg-rose-500/15 text-rose-300 border-rose-500/40";
}

interface Props {
  symbol: string;
}

export default function UnusualFlowPanel({ symbol }: Props) {
  const sym = symbol.toUpperCase();
  const { data, isLoading, isError } = useQuery<UnusualResponse>({
    queryKey: ["/api/flow/unusual", sym],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/flow/unusual?symbol=${encodeURIComponent(sym)}`);
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 50_000,
  });

  if (isLoading && !data) {
    return (
      <Card data-testid="unusual-flow-panel-loading">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Flame className="h-4 w-4 text-amber-400" /> Unusual Options Flow — {sym}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Unusual flow unavailable for {sym}. The CBOE chain may not cover this symbol.
        </CardContent>
      </Card>
    );
  }

  const s = data.summary;
  const callPutRatio = s.callPutNotionalRatio;
  const leaning: "CALLS" | "PUTS" | "BALANCED" =
    s.callNotional > s.putNotional * 1.25 ? "CALLS" : s.putNotional > s.callNotional * 1.25 ? "PUTS" : "BALANCED";
  const netBias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    s.netSentimentNotional > 0 ? "BULLISH" : s.netSentimentNotional < 0 ? "BEARISH" : "NEUTRAL";

  return (
    <Card data-testid="unusual-flow-panel">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Flame className="h-4 w-4 text-amber-400" /> Unusual Options Flow — {sym}
            <Badge variant="outline" className="ml-1 border-amber-500/40 text-[9px] text-amber-300">
              {data.provider.toUpperCase()} · {data.provider === "cboe" ? "15m delayed" : "real-time"}
            </Badge>
          </CardTitle>
          <div className="text-[10px] text-muted-foreground">
            {data.spot != null && <>Spot {data.spot.toFixed(2)} · </>}
            {new Date(data.asOf * 1000).toLocaleTimeString()}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary row */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="rounded-md border border-border/40 bg-card/40 p-3">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Flagged contracts</div>
            <div className="mt-0.5 font-mono text-lg font-bold tabular-nums">{s.flaggedCount}</div>
            <div className="text-[9px] text-muted-foreground">Vol/OI ≥ 2 · $ ≥ 25K</div>
          </div>
          <div className={`rounded-md border p-3 ${leaning === "CALLS" ? "border-emerald-500/50 bg-emerald-500/10" : leaning === "PUTS" ? "border-rose-500/50 bg-rose-500/10" : "border-border/40 bg-card/40"}`}>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Call / Put $</div>
            <div className="mt-0.5 flex items-baseline gap-2 font-mono text-sm tabular-nums">
              <span className="text-emerald-300">{fmtMoney(s.callNotional)}</span>
              <span className="text-muted-foreground">/</span>
              <span className="text-rose-300">{fmtMoney(s.putNotional)}</span>
            </div>
            <div className="text-[9px] text-muted-foreground">
              P/C $ ratio {callPutRatio != null ? callPutRatio.toFixed(2) : "—"} · {leaning}
            </div>
          </div>
          <div className={`rounded-md border p-3 ${netBias === "BULLISH" ? "border-emerald-500/50 bg-emerald-500/10" : netBias === "BEARISH" ? "border-rose-500/50 bg-rose-500/10" : "border-border/40 bg-card/40"}`}>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Net sentiment $</div>
            <div className={`mt-0.5 flex items-center gap-1 font-mono text-lg font-bold tabular-nums ${netBias === "BULLISH" ? "text-emerald-300" : netBias === "BEARISH" ? "text-rose-300" : "text-muted-foreground"}`}>
              {netBias === "BULLISH" ? <TrendingUp className="h-4 w-4" /> : netBias === "BEARISH" ? <TrendingDown className="h-4 w-4" /> : null}
              {s.netSentimentNotional >= 0 ? "+" : ""}
              {fmtMoney(s.netSentimentNotional)}
            </div>
            <div className="text-[9px] text-muted-foreground">Tape-side × call/put</div>
          </div>
          <div className="rounded-md border border-border/40 bg-card/40 p-3">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Above ask / Below bid</div>
            <div className="mt-0.5 flex items-baseline gap-2 font-mono text-sm tabular-nums">
              <span className="text-rose-300">{fmtMoney(s.aboveAskNotional)}</span>
              <span className="text-muted-foreground">/</span>
              <span className="text-sky-300">{fmtMoney(s.belowBidNotional)}</span>
            </div>
            <div className="text-[9px] text-muted-foreground">
              Top tag: {s.topTag ? tagStyle(s.topTag).label : "—"}
            </div>
          </div>
        </div>

        {/* Contracts table */}
        {data.contracts.length === 0 ? (
          <div className="rounded-md border border-border/40 bg-muted/10 p-4 text-center text-sm text-muted-foreground">
            No unusual flow detected for {sym} right now. Try again after the open or during high-volatility sessions.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border/40">
            <table className="w-full text-[11px]">
              <thead className="border-b border-border/40 bg-muted/20">
                <tr className="text-left text-[9px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-1.5">Type</th>
                  <th className="px-2 py-1.5">Strike</th>
                  <th className="px-2 py-1.5">Exp</th>
                  <th className="px-2 py-1.5">DTE</th>
                  <th className="px-2 py-1.5 text-right">Vol</th>
                  <th className="px-2 py-1.5 text-right">OI</th>
                  <th className="px-2 py-1.5 text-right">Vol/OI</th>
                  <th className="px-2 py-1.5 text-right">Bid×Ask</th>
                  <th className="px-2 py-1.5 text-right">Last</th>
                  <th className="px-2 py-1.5 text-right">IV</th>
                  <th className="px-2 py-1.5 text-right">Notional</th>
                  <th className="px-2 py-1.5">Tape</th>
                  <th className="px-2 py-1.5">Bias</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {data.contracts.map((c) => {
                  const ts = tagStyle(c.tag);
                  return (
                    <tr
                      key={c.occ}
                      className="border-b border-border/20 last:border-b-0 hover:bg-muted/10"
                      data-testid={`flow-row-${c.occ}`}
                    >
                      <td className="px-2 py-1.5">
                        <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-semibold ${typeStyle(c.type)}`}>
                          {c.type === "C" ? "CALL" : "PUT"}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 font-semibold">{c.strike.toFixed(c.strike >= 100 ? 0 : 2)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{c.expiration.slice(5)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{c.dte}d</td>
                      <td className="px-2 py-1.5 text-right">{fmtNum(c.volume)}</td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground">{fmtNum(c.openInterest)}</td>
                      <td className="px-2 py-1.5 text-right text-amber-300">
                        {c.volOiRatio >= 99 ? "NEW" : c.volOiRatio.toFixed(1) + "×"}
                      </td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground">
                        {c.bid.toFixed(2)}×{c.ask.toFixed(2)}
                      </td>
                      <td className="px-2 py-1.5 text-right">{c.last > 0 ? c.last.toFixed(2) : "—"}</td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground">
                        {c.iv > 0 ? `${(c.iv * 100).toFixed(0)}%` : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold text-foreground">{fmtMoney(c.notional)}</td>
                      <td className="px-2 py-1.5">
                        <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-semibold ${ts.border} ${ts.bg} ${ts.text}`}>
                          {ts.label}
                        </span>
                      </td>
                      <td className={`px-2 py-1.5 font-semibold ${sentStyle(c.sentiment)}`}>
                        {c.sentiment === "BULLISH" ? (
                          <span className="inline-flex items-center gap-1"><Zap className="h-2.5 w-2.5" /> BULL</span>
                        ) : c.sentiment === "BEARISH" ? (
                          <span className="inline-flex items-center gap-1"><Zap className="h-2.5 w-2.5" /> BEAR</span>
                        ) : (
                          "NEUT"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="text-[9px] text-muted-foreground">
          Flagged when volume ≥ 100 AND volume/OI ≥ 2× AND notional ≥ $25K AND DTE ≤ 90. Tape-side inferred from last-trade vs bid/ask.
          {data.provider === "cboe" && " CBOE data is 15-min delayed — Schwab integration will enable true real-time tape."}
        </div>
      </CardContent>
    </Card>
  );
}
