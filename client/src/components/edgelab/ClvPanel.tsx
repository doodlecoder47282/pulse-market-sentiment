import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import EdgeBrief from "./EdgeBrief";

interface TradeRow {
  id: string;
  capturedAt: number;
  symbol: string;
  side: "BUY" | "SELL";
  instrument: "EQUITY" | "OPTION";
  qty: number;
  entryPrice: number;
  midAtEntry: number | null;
  signalSource: string | null;
  graded: number;
  closingMid: number | null;
  clvBps: number | null;
  clvDollars: number | null;
}

interface ClvSummary {
  count: number;
  gradedCount: number;
  meanBps: number;
  medianBps: number;
  positivePct: number;
  totalDollars: number;
  rolling20Bps: number;
  rolling50Bps: number;
  bySignal: { signal: string; count: number; meanBps: number; positivePct: number }[];
  bySymbol: { symbol: string; count: number; meanBps: number }[];
  recent: TradeRow[];
}

const fmtBps = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)} bps`;
const fmtUsd = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default function ClvPanel() {
  const { toast } = useToast();
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [instrument, setInstrument] = useState<"EQUITY" | "OPTION">("EQUITY");
  const [qty, setQty] = useState("1");
  const [entryPrice, setEntryPrice] = useState("");
  const [signalSource, setSignalSource] = useState("");
  const [occ, setOcc] = useState("");

  const summaryQuery = useQuery<ClvSummary>({
    queryKey: ["/api/clv/summary"],
    refetchInterval: 30000,
  });

  const logMutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        symbol: symbol.toUpperCase(),
        side,
        instrument,
        qty: Number(qty),
        entryPrice: Number(entryPrice),
        signalSource: signalSource || null,
      };
      if (instrument === "OPTION" && occ) body.occ = occ;
      const res = await apiRequest("POST", "/api/clv/trades", body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "trade logged", description: `${symbol.toUpperCase()} ${side} ${qty} @ ${entryPrice}` });
      setSymbol(""); setEntryPrice(""); setSignalSource(""); setOcc("");
      queryClient.invalidateQueries({ queryKey: ["/api/clv/summary"] });
    },
    onError: (e: any) => toast({ title: "log failed", description: e?.message ?? "error", variant: "destructive" }),
  });

  const gradeAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/clv/grade-all", {});
      return res.json();
    },
    onSuccess: (d: any) => {
      toast({ title: "graded", description: `${d?.graded ?? 0} trades graded` });
      queryClient.invalidateQueries({ queryKey: ["/api/clv/summary"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/clv/trades/${id}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/clv/summary"] }),
  });

  const s = summaryQuery.data;

  return (
    <div className="space-y-3" data-testid="clv-panel">
      <EdgeBrief panel="clv" />

      {/* Edge KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Kpi label="trades" value={s ? `${s.gradedCount}/${s.count}` : "—"} hint="graded/total" />
        <Kpi label="mean CLV" value={fmtBps(s?.meanBps)} positive={s?.meanBps} />
        <Kpi label="positive %" value={s ? `${s.positivePct.toFixed(0)}%` : "—"} />
        <Kpi label="rolling 20" value={fmtBps(s?.rolling20Bps)} positive={s?.rolling20Bps} />
      </div>

      {/* Log new trade */}
      <div className="rounded border border-border p-3 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">log a trade</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">symbol</Label>
            <Input data-testid="input-clv-symbol" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="SPY" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">side</Label>
            <Select value={side} onValueChange={(v: any) => setSide(v)}>
              <SelectTrigger data-testid="select-clv-side" className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="BUY">BUY</SelectItem>
                <SelectItem value="SELL">SELL</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">instrument</Label>
            <Select value={instrument} onValueChange={(v: any) => setInstrument(v)}>
              <SelectTrigger data-testid="select-clv-instrument" className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="EQUITY">EQUITY</SelectItem>
                <SelectItem value="OPTION">OPTION</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">qty</Label>
            <Input data-testid="input-clv-qty" type="number" value={qty} onChange={e => setQty(e.target.value)} className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">entry price</Label>
            <Input data-testid="input-clv-entry" type="number" step="0.01" value={entryPrice} onChange={e => setEntryPrice(e.target.value)} placeholder="450.50" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">signal source</Label>
            <Input data-testid="input-clv-signal" value={signalSource} onChange={e => setSignalSource(e.target.value)} placeholder="composite-bull" className="h-8 text-xs" />
          </div>
          {instrument === "OPTION" && (
            <div className="space-y-1 md:col-span-2">
              <Label className="text-xs">OCC symbol (optional)</Label>
              <Input data-testid="input-clv-occ" value={occ} onChange={e => setOcc(e.target.value)} placeholder="SPY  240621C00450000" className="h-8 text-xs" />
            </div>
          )}
        </div>
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            data-testid="button-clv-log"
            disabled={!symbol || !entryPrice || logMutation.isPending}
            onClick={() => logMutation.mutate()}
          >
            log trade
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-clv-grade-all"
            disabled={gradeAllMutation.isPending}
            onClick={() => gradeAllMutation.mutate()}
          >
            grade pending
          </Button>
        </div>
      </div>

      {/* By signal source */}
      {s && s.bySignal.length > 0 && (
        <div className="rounded border border-border p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">edge by signal source</div>
          <div className="space-y-1">
            {s.bySignal.slice(0, 8).map(row => (
              <div key={row.signal} className="flex items-center justify-between text-xs">
                <span className="font-mono">{row.signal}</span>
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">n={row.count}</span>
                  <span className="text-muted-foreground">{row.positivePct.toFixed(0)}% pos</span>
                  <span className={row.meanBps >= 0 ? "text-emerald-500 font-medium" : "text-rose-500 font-medium"}>
                    {fmtBps(row.meanBps)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent trades */}
      <div className="rounded border border-border p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">recent trades</div>
        {!s || s.recent.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4 text-center">no trades logged yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-1 pr-2">time</th>
                  <th className="text-left py-1 pr-2">sym</th>
                  <th className="text-left py-1 pr-2">side</th>
                  <th className="text-right py-1 pr-2">qty</th>
                  <th className="text-right py-1 pr-2">entry</th>
                  <th className="text-right py-1 pr-2">close mid</th>
                  <th className="text-right py-1 pr-2">CLV</th>
                  <th className="text-right py-1 pr-2">$</th>
                  <th className="text-left py-1 pr-2">source</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {s.recent.slice(0, 25).map(t => (
                  <tr key={t.id} className="border-b border-border/40" data-testid={`row-trade-${t.id}`}>
                    <td className="py-1 pr-2 text-muted-foreground">{fmtTime(t.capturedAt)}</td>
                    <td className="py-1 pr-2 font-mono">{t.symbol}</td>
                    <td className="py-1 pr-2">
                      <span className={t.side === "BUY" ? "text-emerald-500" : "text-rose-500"}>{t.side}</span>
                    </td>
                    <td className="py-1 pr-2 text-right">{t.qty}</td>
                    <td className="py-1 pr-2 text-right font-mono">{t.entryPrice.toFixed(2)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{t.closingMid?.toFixed(2) ?? "—"}</td>
                    <td className="py-1 pr-2 text-right">
                      {t.graded ? (
                        <span className={(t.clvBps ?? 0) >= 0 ? "text-emerald-500 font-medium" : "text-rose-500 font-medium"}>
                          {fmtBps(t.clvBps)}
                        </span>
                      ) : (
                        <Badge variant="outline" className="text-[10px] py-0 px-1 h-4">pending</Badge>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-right text-muted-foreground">{fmtUsd(t.clvDollars)}</td>
                    <td className="py-1 pr-2 font-mono text-muted-foreground">{t.signalSource ?? "—"}</td>
                    <td className="py-1 text-right">
                      <button
                        data-testid={`button-delete-${t.id}`}
                        className="text-muted-foreground hover:text-rose-500"
                        onClick={() => deleteMutation.mutate(t.id)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground leading-snug">
        CLV grades each trade against the closing mid. positive CLV = you got better fills than the close. that's the edge metric, not P&L.
      </p>
    </div>
  );
}

function Kpi({ label, value, hint, positive }: { label: string; value: string; hint?: string; positive?: number | null }) {
  const color = positive == null ? "" : positive > 0 ? "text-emerald-500" : positive < 0 ? "text-rose-500" : "";
  return (
    <div className="rounded border border-border p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
