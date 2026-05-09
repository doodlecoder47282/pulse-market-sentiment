import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface GammaCurveResult {
  symbol: string;
  spot: number;
  asOf: number;
  walls: { strike: number; netGex: number; callGex: number; putGex: number; distancePct: number; rank: number; type: "call_wall" | "put_wall" | "magnet" }[];
  vacuums: { loStrike: number; hiStrike: number; midStrike: number; width: number; totalAbsGex: number; distancePct: number }[];
  asymmetry: {
    netAbove: number;
    netBelow: number;
    asymmetryRatio: number;
    bias: "compression-up" | "compression-down" | "balanced" | "vacuum-up" | "vacuum-down";
    biasNote: string;
  };
  zeroGamma: number | null;
  source: string;
}

const fmtGex = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(0);
};

const biasColor = (b: string) => {
  if (b === "compression-up") return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
  if (b === "compression-down") return "bg-rose-500/15 text-rose-500 border-rose-500/30";
  if (b === "vacuum-up") return "bg-cyan-500/15 text-cyan-500 border-cyan-500/30";
  if (b === "vacuum-down") return "bg-orange-500/15 text-orange-500 border-orange-500/30";
  return "bg-muted text-muted-foreground border-border";
};

const wallColor = (t: string) => {
  if (t === "call_wall") return "text-emerald-500";
  if (t === "put_wall") return "text-rose-500";
  return "text-amber-500";
};

export default function GammaCurvePanel() {
  const [symbol, setSymbol] = useState("SPY");
  const [active, setActive] = useState("SPY");

  const q = useQuery<GammaCurveResult | { error: string }>({
    queryKey: ["/api/gamma-curve", active],
    queryFn: async () => {
      const res = await fetch(`/api/gamma-curve?symbol=${encodeURIComponent(active)}`);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    refetchInterval: 60000,
  });

  const d = q.data;
  const isError = d && "error" in d;
  const data = !isError ? (d as GammaCurveResult | undefined) : undefined;

  return (
    <div className="space-y-3" data-testid="gamma-curve-panel">
      <div className="flex gap-2 items-end">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">symbol</label>
          <Input
            data-testid="input-gamma-symbol"
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => { if (e.key === "Enter" && symbol) setActive(symbol); }}
            className="h-8 w-28 text-xs"
          />
        </div>
        <Button size="sm" data-testid="button-gamma-load" onClick={() => symbol && setActive(symbol)}>load</Button>
      </div>

      {q.isLoading && <div className="text-xs text-muted-foreground">loading gamma curve for {active}…</div>}
      {isError && <div className="text-xs text-rose-500">error: {(d as any).error}</div>}

      {data && (
        <>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">
              {data.symbol} <span className="text-muted-foreground font-normal">spot ${data.spot.toFixed(2)}</span>
              {data.zeroGamma != null && (
                <span className="text-muted-foreground font-normal ml-2">zero-γ ${data.zeroGamma.toFixed(2)}</span>
              )}
            </div>
            <Badge variant="outline" className={`text-xs ${biasColor(data.asymmetry.bias)}`} data-testid="badge-gamma-bias">
              {data.asymmetry.bias}
            </Badge>
          </div>

          {/* asymmetry verdict */}
          <div className="rounded border border-border p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">asymmetry verdict</div>
            <p className="text-xs leading-relaxed">{data.asymmetry.biasNote}</p>
            <div className="grid grid-cols-3 gap-2 mt-2">
              <Tile label="net γ above" value={fmtGex(data.asymmetry.netAbove)} />
              <Tile label="net γ below" value={fmtGex(data.asymmetry.netBelow)} />
              <Tile label="asym ratio" value={data.asymmetry.asymmetryRatio.toFixed(2)} />
            </div>
          </div>

          {/* walls */}
          <div className="rounded border border-border p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">gamma walls (top 6 by |GEX|)</div>
            {data.walls.length === 0 ? (
              <div className="text-xs text-muted-foreground">no walls detected</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="text-left py-1">rank</th>
                    <th className="text-right py-1">strike</th>
                    <th className="text-right py-1">% from spot</th>
                    <th className="text-right py-1">net GEX</th>
                    <th className="text-left py-1 pl-3">type</th>
                  </tr>
                </thead>
                <tbody>
                  {data.walls.map(w => (
                    <tr key={`${w.strike}-${w.rank}`} className="border-b border-border/40">
                      <td className="py-1">#{w.rank}</td>
                      <td className="py-1 text-right font-mono font-medium">{w.strike.toFixed(2)}</td>
                      <td className={`py-1 text-right font-mono ${w.distancePct >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                        {w.distancePct >= 0 ? "+" : ""}{w.distancePct.toFixed(2)}%
                      </td>
                      <td className={`py-1 text-right font-mono ${w.netGex >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                        {fmtGex(w.netGex)}
                      </td>
                      <td className={`py-1 pl-3 ${wallColor(w.type)}`}>{w.type.replace("_", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* vacuum zones */}
          <div className="rounded border border-border p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">vacuum zones (low-density gaps)</div>
            {data.vacuums.length === 0 ? (
              <div className="text-xs text-muted-foreground">no clear vacuums detected</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="text-left py-1">range</th>
                    <th className="text-right py-1">mid</th>
                    <th className="text-right py-1">% from spot</th>
                    <th className="text-right py-1">total |GEX|</th>
                  </tr>
                </thead>
                <tbody>
                  {data.vacuums.map(v => (
                    <tr key={v.midStrike} className="border-b border-border/40">
                      <td className="py-1 font-mono">{v.loStrike.toFixed(2)}–{v.hiStrike.toFixed(2)}</td>
                      <td className="py-1 text-right font-mono">{v.midStrike.toFixed(2)}</td>
                      <td className={`py-1 text-right font-mono ${v.distancePct >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                        {v.distancePct >= 0 ? "+" : ""}{v.distancePct.toFixed(2)}%
                      </td>
                      <td className="py-1 text-right font-mono text-muted-foreground">{fmtGex(v.totalAbsGex)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p className="text-[10px] text-muted-foreground leading-snug">
            walls = strikes where dealers have the most gamma (price magnets / pinning levels). vacuums = thin pockets where price moves fast with little resistance. positive net γ above + negative below = compression bias upward.
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
