import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import EdgeBrief from "./EdgeBrief";

interface IvRvSnapshot {
  symbol: string;
  asOf: string;
  rv: { rv5: number | null; rv10: number | null; rv20: number | null; rv30: number | null; rv60: number | null };
  iv: { iv30: number | null; iv60: number | null; iv90: number | null };
  ratio: { iv30_rv20: number | null; iv30_rv30: number | null; iv60_rv60: number | null };
  verdict: "rich" | "fair" | "cheap" | "insufficient";
  notes: string;
  rvCones: { window: number; current: number | null; p10: number | null; p50: number | null; p90: number | null }[];
  spot: number | null;
  source: string;
}

const pct = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(1)}%`;
const ratio = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : n.toFixed(2);

const verdictColor = (v: string) => {
  if (v === "rich") return "bg-rose-500/15 text-rose-500 border-rose-500/30";
  if (v === "cheap") return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
  if (v === "fair") return "bg-amber-500/15 text-amber-500 border-amber-500/30";
  return "bg-muted text-muted-foreground border-border";
};

export default function IvRvPanel() {
  const [symbol, setSymbol] = useState("SPY");
  const [active, setActive] = useState("SPY");

  const q = useQuery<IvRvSnapshot>({
    queryKey: ["/api/iv-rv", active],
    queryFn: async () => {
      const res = await fetch(`/api/iv-rv?symbol=${encodeURIComponent(active)}`);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    refetchInterval: 60000,
  });

  const data = q.data;

  return (
    <div className="space-y-3" data-testid="ivrv-panel">
      <EdgeBrief panel="iv-rv" symbol={active} />

      <div className="flex gap-2 items-end">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">symbol</label>
          <Input
            data-testid="input-ivrv-symbol"
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => { if (e.key === "Enter" && symbol) setActive(symbol); }}
            className="h-8 w-28 text-xs"
          />
        </div>
        <Button size="sm" data-testid="button-ivrv-load" onClick={() => symbol && setActive(symbol)}>load</Button>
      </div>

      {q.isLoading && <div className="text-xs text-muted-foreground">loading {active}…</div>}
      {q.isError && <div className="text-xs text-rose-500">error: {(q.error as any)?.message}</div>}

      {data && (
        <>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">
              {data.symbol} <span className="text-muted-foreground font-normal">spot ${data.spot?.toFixed(2) ?? "—"}</span>
            </div>
            <Badge variant="outline" className={`text-xs ${verdictColor(data.verdict)}`} data-testid="badge-ivrv-verdict">
              {data.verdict}
            </Badge>
          </div>

          {/* IV row */}
          <div className="rounded border border-border p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">ATM implied vol</div>
            <div className="grid grid-cols-3 gap-2">
              <Tile label="IV30" value={pct(data.iv.iv30)} />
              <Tile label="IV60" value={pct(data.iv.iv60)} />
              <Tile label="IV90" value={pct(data.iv.iv90)} />
            </div>
          </div>

          {/* RV cones */}
          <div className="rounded border border-border p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">realized vol cones</div>
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-1">window</th>
                  <th className="text-right py-1">current</th>
                  <th className="text-right py-1">p10</th>
                  <th className="text-right py-1">median</th>
                  <th className="text-right py-1">p90</th>
                  <th className="text-left py-1 pl-3">position</th>
                </tr>
              </thead>
              <tbody>
                {data.rvCones.map(c => {
                  const cur = c.current;
                  const pos = cur == null || c.p10 == null || c.p90 == null
                    ? null
                    : cur >= c.p90 ? "elevated" : cur <= c.p10 ? "compressed" : "in-range";
                  return (
                    <tr key={c.window} className="border-b border-border/40">
                      <td className="py-1">{c.window}d</td>
                      <td className="py-1 text-right font-mono font-medium">{pct(cur)}</td>
                      <td className="py-1 text-right text-muted-foreground font-mono">{pct(c.p10)}</td>
                      <td className="py-1 text-right text-muted-foreground font-mono">{pct(c.p50)}</td>
                      <td className="py-1 text-right text-muted-foreground font-mono">{pct(c.p90)}</td>
                      <td className="py-1 pl-3">
                        {pos === "elevated" && <span className="text-rose-500">elevated</span>}
                        {pos === "compressed" && <span className="text-emerald-500">compressed</span>}
                        {pos === "in-range" && <span className="text-muted-foreground">in-range</span>}
                        {pos == null && <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Ratios */}
          <div className="rounded border border-border p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">IV / RV ratios</div>
            <div className="grid grid-cols-3 gap-2">
              <Tile label="IV30 / RV20" value={ratio(data.ratio.iv30_rv20)} />
              <Tile label="IV30 / RV30" value={ratio(data.ratio.iv30_rv30)} />
              <Tile label="IV60 / RV60" value={ratio(data.ratio.iv60_rv60)} />
            </div>
            <div className="text-[11px] text-muted-foreground mt-2 leading-snug">
              ratio &gt; 1.25 = options rich (sell premium edge). ratio &lt; 0.95 = options cheap (buy premium edge). between = fair.
            </div>
          </div>

          {data.notes && <p className="text-[11px] text-muted-foreground">{data.notes}</p>}
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
