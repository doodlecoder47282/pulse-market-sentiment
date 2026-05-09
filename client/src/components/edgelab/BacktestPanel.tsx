import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import EdgeBrief from "./EdgeBrief";

const SIGNAL_KINDS: { v: string; label: string; p1: string; p2: string }[] = [
  { v: "price_above_sma", label: "price above SMA", p1: "SMA window", p2: "—" },
  { v: "price_below_sma", label: "price below SMA", p1: "SMA window", p2: "—" },
  { v: "rsi_below", label: "RSI below threshold", p1: "RSI window", p2: "threshold" },
  { v: "rsi_above", label: "RSI above threshold", p1: "RSI window", p2: "threshold" },
  { v: "bbands_breakout_up", label: "Bollinger breakout up", p1: "BB window", p2: "stdev" },
  { v: "bbands_breakout_down", label: "Bollinger breakout down", p1: "BB window", p2: "stdev" },
  { v: "ret_zscore_below", label: "return z-score below", p1: "lookback", p2: "z threshold" },
  { v: "ret_zscore_above", label: "return z-score above", p1: "lookback", p2: "z threshold" },
];

interface BacktestResult {
  trades: { entryDate: string; exitDate: string; side: string; entry: number; exit: number; retPct: number; retBpsAfterCosts: number }[];
  trades_count: number;
  win_rate: number;
  mean_ret_bps: number;
  median_ret_bps: number;
  total_ret_pct: number;
  max_dd_pct: number;
  sharpe: number;
  sortino: number;
  best_trade_bps: number;
  worst_trade_bps: number;
  notes: string;
  costsBps: number;
}

export default function BacktestPanel() {
  const [kind, setKind] = useState("price_above_sma");
  const [symbol, setSymbol] = useState("SPY");
  const [param1, setParam1] = useState("50");
  const [param2, setParam2] = useState("");
  const [holdDays, setHoldDays] = useState("5");
  const [side, setSide] = useState<"long" | "short" | "both">("long");
  const [costBps, setCostBps] = useState("6");

  const symbolsQ = useQuery<{ symbols: string[] }>({
    queryKey: ["/api/backtest/symbols"],
  });

  const runMutation = useMutation<BacktestResult>({
    mutationFn: async () => {
      const spec: any = {
        kind,
        symbol: symbol.toUpperCase(),
        holdDays: Number(holdDays) || 1,
        side,
      };
      if (param1) spec.param1 = Number(param1);
      if (param2) spec.param2 = Number(param2);
      const res = await apiRequest("POST", "/api/backtest/run", { spec, costBps: Number(costBps) || undefined });
      return res.json();
    },
  });

  const cur = SIGNAL_KINDS.find(s => s.v === kind) ?? SIGNAL_KINDS[0];
  const r = runMutation.data;
  const symbols = symbolsQ.data?.symbols ?? [];

  return (
    <div className="space-y-3" data-testid="backtest-panel">
      {r && (
        <EdgeBrief
          panel="backtest"
          manual
          extra={{ lastRun: { kind, symbol: symbol.toUpperCase(), holdDays: Number(holdDays), side, costBps: r.costsBps, win_rate: r.win_rate, mean_ret_bps: r.mean_ret_bps, sharpe: r.sharpe, sortino: r.sortino, trades_count: r.trades_count, max_dd_pct: r.max_dd_pct, total_ret_pct: r.total_ret_pct } }}
        />
      )}

      {/* Signal builder */}
      <div className="rounded border border-border p-3 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">signal builder</div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">signal kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger data-testid="select-bt-kind" className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SIGNAL_KINDS.map(s => <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">symbol</Label>
            <Input
              data-testid="input-bt-symbol"
              value={symbol}
              onChange={e => setSymbol(e.target.value.toUpperCase())}
              placeholder="SPY"
              className="h-8 text-xs"
              list="bt-symbol-list"
            />
            <datalist id="bt-symbol-list">
              {symbols.map(s => <option key={s} value={s} />)}
            </datalist>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">side</Label>
            <Select value={side} onValueChange={(v: any) => setSide(v)}>
              <SelectTrigger data-testid="select-bt-side" className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="long">long</SelectItem>
                <SelectItem value="short">short</SelectItem>
                <SelectItem value="both">both</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">{cur.p1}</Label>
            <Input
              data-testid="input-bt-param1"
              type="number"
              value={param1}
              onChange={e => setParam1(e.target.value)}
              className="h-8 text-xs"
              disabled={cur.p1 === "—"}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{cur.p2}</Label>
            <Input
              data-testid="input-bt-param2"
              type="number"
              step="0.1"
              value={param2}
              onChange={e => setParam2(e.target.value)}
              className="h-8 text-xs"
              disabled={cur.p2 === "—"}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">hold days</Label>
            <Input data-testid="input-bt-hold" type="number" value={holdDays} onChange={e => setHoldDays(e.target.value)} className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">round-trip cost (bps)</Label>
            <Input data-testid="input-bt-cost" type="number" value={costBps} onChange={e => setCostBps(e.target.value)} className="h-8 text-xs" />
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <Button size="sm" data-testid="button-bt-run" onClick={() => runMutation.mutate()} disabled={runMutation.isPending || !symbol}>
            {runMutation.isPending ? "running…" : "run backtest"}
          </Button>
          {symbols.length > 0 && (
            <span className="text-[10px] text-muted-foreground self-center">{symbols.length} symbols available</span>
          )}
        </div>
      </div>

      {runMutation.isError && (
        <div className="text-xs text-rose-500">error: {(runMutation.error as any)?.message}</div>
      )}

      {r && (
        <>
          {/* Stat tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="trades" value={String(r.trades_count)} />
            <Stat label="win rate" value={`${r.win_rate.toFixed(1)}%`} positive={r.win_rate - 50} />
            <Stat label="mean bps" value={r.mean_ret_bps.toFixed(1)} positive={r.mean_ret_bps} />
            <Stat label="median bps" value={r.median_ret_bps.toFixed(1)} positive={r.median_ret_bps} />
            <Stat label="total ret" value={`${r.total_ret_pct.toFixed(2)}%`} positive={r.total_ret_pct} />
            <Stat label="max DD" value={`${r.max_dd_pct.toFixed(2)}%`} positive={r.max_dd_pct} />
            <Stat label="Sharpe" value={r.sharpe.toFixed(2)} positive={r.sharpe} />
            <Stat label="Sortino" value={r.sortino.toFixed(2)} positive={r.sortino} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Stat label="best trade" value={`${r.best_trade_bps.toFixed(0)} bps`} positive={r.best_trade_bps} />
            <Stat label="worst trade" value={`${r.worst_trade_bps.toFixed(0)} bps`} positive={r.worst_trade_bps} />
          </div>

          {r.notes && <p className="text-[11px] text-muted-foreground">{r.notes} (cost: {r.costsBps} bps round-trip)</p>}

          {/* Trades */}
          {r.trades.length > 0 && (
            <div className="rounded border border-border p-3 overflow-x-auto">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">last 25 trades</div>
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="text-left py-1">entry</th>
                    <th className="text-left py-1">exit</th>
                    <th className="text-left py-1">side</th>
                    <th className="text-right py-1">entry $</th>
                    <th className="text-right py-1">exit $</th>
                    <th className="text-right py-1">ret %</th>
                    <th className="text-right py-1">net bps</th>
                  </tr>
                </thead>
                <tbody>
                  {r.trades.slice(-25).reverse().map((t, i) => (
                    <tr key={i} className="border-b border-border/40">
                      <td className="py-1 font-mono text-muted-foreground">{t.entryDate}</td>
                      <td className="py-1 font-mono text-muted-foreground">{t.exitDate}</td>
                      <td className={`py-1 ${t.side === "long" ? "text-emerald-500" : "text-rose-500"}`}>{t.side}</td>
                      <td className="py-1 text-right font-mono">{t.entry.toFixed(2)}</td>
                      <td className="py-1 text-right font-mono">{t.exit.toFixed(2)}</td>
                      <td className={`py-1 text-right font-mono ${t.retPct >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                        {t.retPct >= 0 ? "+" : ""}{t.retPct.toFixed(2)}%
                      </td>
                      <td className={`py-1 text-right font-mono ${t.retBpsAfterCosts >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                        {t.retBpsAfterCosts >= 0 ? "+" : ""}{t.retBpsAfterCosts.toFixed(0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <p className="text-[10px] text-muted-foreground leading-snug">
        vectorized signal runner with realistic costs (default 6 bps round-trip). Sharpe = annualized risk-adjusted return; Sortino punishes only downside vol. anything below 1.0 with a small sample = noise.
      </p>
    </div>
  );
}

function Stat({ label, value, positive }: { label: string; value: string; positive?: number | null }) {
  const color = positive == null ? "" : positive > 0 ? "text-emerald-500" : positive < 0 ? "text-rose-500" : "";
  return (
    <div className="rounded border border-border/60 bg-muted/20 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
