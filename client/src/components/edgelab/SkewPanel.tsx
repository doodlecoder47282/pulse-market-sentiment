import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface SkewPoint {
  tenorDays: number;
  expiry: string;
  atmIv: number | null;
  put25dIv: number | null;
  call25dIv: number | null;
  putSkew: number | null;
  callSkew: number | null;
  riskReversal25d: number | null;
}

interface SkewSnapshot {
  symbol: string;
  spot: number | null;
  asOf: number;
  points: SkewPoint[];
  termStructure: {
    front: number | null;
    second: number | null;
    third: number | null;
    slope: "contango" | "backwardation" | "flat" | "n/a";
    slopeNote: string;
  };
  riskReversalNow: number | null;
  riskReversalNote: string;
}

const pct = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(2)}%`;
const pctSigned = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;

const slopeColor = (s: string) => {
  if (s === "contango") return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
  if (s === "backwardation") return "bg-rose-500/15 text-rose-500 border-rose-500/30";
  return "bg-muted text-muted-foreground border-border";
};

export default function SkewPanel() {
  const [symbol, setSymbol] = useState("SPY");
  const [active, setActive] = useState("SPY");

  const q = useQuery<SkewSnapshot | { error: string }>({
    queryKey: ["/api/skew", active],
    queryFn: async () => {
      const res = await fetch(`/api/skew?symbol=${encodeURIComponent(active)}`);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    refetchInterval: 90000,
  });

  const d = q.data;
  const isError = d && "error" in d;
  const data = !isError ? (d as SkewSnapshot | undefined) : undefined;

  return (
    <div className="space-y-3" data-testid="skew-panel">
      <div className="flex gap-2 items-end">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">symbol</label>
          <Input
            data-testid="input-skew-symbol"
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => { if (e.key === "Enter" && symbol) setActive(symbol); }}
            className="h-8 w-28 text-xs"
          />
        </div>
        <Button size="sm" data-testid="button-skew-load" onClick={() => symbol && setActive(symbol)}>load</Button>
      </div>

      {q.isLoading && <div className="text-xs text-muted-foreground">loading skew for {active}…</div>}
      {isError && <div className="text-xs text-rose-500">error: {(d as any).error}</div>}

      {data && (
        <>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">
              {data.symbol} <span className="text-muted-foreground font-normal">spot ${data.spot?.toFixed(2) ?? "—"}</span>
            </div>
            <Badge variant="outline" className={`text-xs ${slopeColor(data.termStructure.slope)}`} data-testid="badge-skew-slope">
              {data.termStructure.slope}
            </Badge>
          </div>

          {/* term structure */}
          <div className="rounded border border-border p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">ATM term structure</div>
            <div className="grid grid-cols-3 gap-2">
              <Tile label="front" value={pct(data.termStructure.front)} />
              <Tile label="second" value={pct(data.termStructure.second)} />
              <Tile label="third" value={pct(data.termStructure.third)} />
            </div>
            <p className="text-[11px] text-muted-foreground mt-2 leading-snug">{data.termStructure.slopeNote}</p>
          </div>

          {/* risk reversal */}
          <div className="rounded border border-border p-3">
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">25Δ risk reversal (~30d)</div>
              <span className={`text-sm font-mono font-semibold tabular-nums ${
                (data.riskReversalNow ?? 0) < 0 ? "text-rose-500" : "text-emerald-500"
              }`} data-testid="text-risk-reversal">
                {pctSigned(data.riskReversalNow)}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">{data.riskReversalNote}</p>
          </div>

          {/* skew points table */}
          <div className="rounded border border-border p-3 overflow-x-auto">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">skew by tenor</div>
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-1 pr-2">DTE</th>
                  <th className="text-left py-1 pr-2">expiry</th>
                  <th className="text-right py-1 pr-2">ATM</th>
                  <th className="text-right py-1 pr-2">25Δ put</th>
                  <th className="text-right py-1 pr-2">25Δ call</th>
                  <th className="text-right py-1 pr-2">put skew</th>
                  <th className="text-right py-1 pr-2">call skew</th>
                  <th className="text-right py-1 pr-2">RR 25Δ</th>
                </tr>
              </thead>
              <tbody>
                {data.points.map(p => (
                  <tr key={p.expiry} className="border-b border-border/40" data-testid={`row-skew-${p.tenorDays}`}>
                    <td className="py-1 pr-2 font-mono">{p.tenorDays}d</td>
                    <td className="py-1 pr-2 text-muted-foreground font-mono">{p.expiry}</td>
                    <td className="py-1 pr-2 text-right font-mono">{pct(p.atmIv)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{pct(p.put25dIv)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{pct(p.call25dIv)}</td>
                    <td className="py-1 pr-2 text-right font-mono text-rose-500">{pctSigned(p.putSkew)}</td>
                    <td className="py-1 pr-2 text-right font-mono text-emerald-500">{pctSigned(p.callSkew)}</td>
                    <td className={`py-1 pr-2 text-right font-mono ${(p.riskReversal25d ?? 0) < 0 ? "text-rose-500" : "text-emerald-500"}`}>
                      {pctSigned(p.riskReversal25d)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-muted-foreground leading-snug">
            negative risk reversal = puts richer than calls (downside fear paid up). contango term = market expects calm now, vol later. backwardation = front-month panic. extremes mean-revert.
          </p>
        </>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/60 bg-muted/20 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}
