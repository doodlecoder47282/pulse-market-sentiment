import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";

interface CrossAssetTickerRow {
  symbol: string;
  last: number | null;
  d1Pct: number | null;
  w1Pct: number | null;
  m1Pct: number | null;
  corr20d: number | null;
  corr60dRolling: number | null;
  corrRegime: "tight" | "loose" | "broken" | "n/a";
}

interface CrossAssetMatrix {
  asOf: number;
  rows: CrossAssetTickerRow[];
  regimeVerdict: {
    label: string;
    confidence: "high" | "medium" | "low";
    notes: string[];
    risk: "on" | "off" | "mixed";
  };
}

const pct = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const corr = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : n.toFixed(2);

const cellColor = (n: number | null | undefined) => {
  if (n == null) return "";
  if (n > 0.3) return "text-emerald-500";
  if (n < -0.3) return "text-rose-500";
  return "text-muted-foreground";
};

const riskColor = (r: string) => {
  if (r === "on") return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
  if (r === "off") return "bg-rose-500/15 text-rose-500 border-rose-500/30";
  return "bg-amber-500/15 text-amber-500 border-amber-500/30";
};

const regimeColor = (r: string) => {
  if (r === "tight") return "text-emerald-500";
  if (r === "loose") return "text-amber-500";
  if (r === "broken") return "text-rose-500";
  return "text-muted-foreground";
};

export default function CrossAssetPanel() {
  const q = useQuery<CrossAssetMatrix>({
    queryKey: ["/api/cross-asset"],
    refetchInterval: 60000,
  });

  const d = q.data;

  return (
    <div className="space-y-3" data-testid="cross-asset-panel">
      {q.isLoading && <div className="text-xs text-muted-foreground">loading cross-asset matrix…</div>}
      {q.isError && <div className="text-xs text-rose-500">error: {(q.error as any)?.message}</div>}

      {d && (
        <>
          {/* regime verdict */}
          <div className="rounded border border-border p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">regime verdict</div>
              <div className="flex gap-1">
                <Badge variant="outline" className={`text-xs ${riskColor(d.regimeVerdict.risk)}`} data-testid="badge-regime-risk">
                  risk {d.regimeVerdict.risk}
                </Badge>
                <Badge variant="outline" className="text-xs">{d.regimeVerdict.confidence} conf</Badge>
              </div>
            </div>
            <div className="text-sm font-semibold mb-1" data-testid="text-regime-label">{d.regimeVerdict.label}</div>
            <ul className="text-xs text-muted-foreground space-y-0.5 leading-snug">
              {d.regimeVerdict.notes.map((n, i) => <li key={i}>· {n}</li>)}
            </ul>
          </div>

          {/* table */}
          <div className="rounded border border-border p-3 overflow-x-auto">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">cross-asset matrix</div>
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-1 pr-2">ticker</th>
                  <th className="text-right py-1 pr-2">last</th>
                  <th className="text-right py-1 pr-2">1d</th>
                  <th className="text-right py-1 pr-2">1w</th>
                  <th className="text-right py-1 pr-2">1m</th>
                  <th className="text-right py-1 pr-2">corr 20d</th>
                  <th className="text-right py-1 pr-2">corr 60d</th>
                  <th className="text-left py-1 pl-2">regime</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map(r => (
                  <tr key={r.symbol} className="border-b border-border/40" data-testid={`row-cross-${r.symbol}`}>
                    <td className="py-1 pr-2 font-mono font-semibold">{r.symbol}</td>
                    <td className="py-1 pr-2 text-right font-mono">{r.last?.toFixed(2) ?? "—"}</td>
                    <td className={`py-1 pr-2 text-right font-mono ${cellColor(r.d1Pct)}`}>{pct(r.d1Pct)}</td>
                    <td className={`py-1 pr-2 text-right font-mono ${cellColor(r.w1Pct)}`}>{pct(r.w1Pct)}</td>
                    <td className={`py-1 pr-2 text-right font-mono ${cellColor(r.m1Pct)}`}>{pct(r.m1Pct)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{corr(r.corr20d)}</td>
                    <td className="py-1 pr-2 text-right font-mono text-muted-foreground">{corr(r.corr60dRolling)}</td>
                    <td className={`py-1 pl-2 ${regimeColor(r.corrRegime)}`}>{r.corrRegime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-muted-foreground leading-snug">
            correlations are vs SPY (SPY itself shows 1.00). tight = correlation behaves as expected, loose = drifting, broken = regime change in motion. clean risk-on means everything risk-correlated rallies together; mixed/suspicious = decorrelation, watch your size.
          </p>
        </>
      )}
    </div>
  );
}
