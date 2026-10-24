/**
 * ChartLevelsCard.tsx: the reader's own chart levels checked against the
 * day's 0DTE map (shared/levelConfluence.ts).
 *
 * The reader types the levels they drew on their charts; each one is tagged
 * landmark / chain / weak / chart only from the map the Trade Desk already
 * holds (same react-query key as OdteMapCard, so no second fetch). Levels
 * are kept per symbol in localStorage (a per-viewer convenience; a blocked
 * store just means they are retyped). Descriptive only: a tag says what open
 * interest sits near a price, never what to do at it.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import DataStateChip from "@/components/DataStateChip";
import { Layers, X } from "lucide-react";
import type { OdteMap } from "@shared/odteMap";
import { checkLevels, parseLevels, defaultTolerancePts, type ConfluenceTag, type LevelCheck } from "@shared/levelConfluence";

type MapResp = OdteMap & { forwardAsOf: string; source: string };

const TAG: Record<ConfluenceTag, { text: string; cls: string; title: string }> = {
  landmark: { text: "landmark", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", title: "within tolerance of a level the map named (pin, wall, magnet, pocket, flip)" },
  chain: { text: "OI confluence", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", title: "within tolerance of a mapped strike carrying at least 3% of the map's gross exposure" },
  weak: { text: "weak", cls: "border-amber-500/40 bg-amber-500/10 text-amber-300", title: "within tolerance of a mapped strike under 3% of the map's exposure" },
  chart_only: { text: "chart only", cls: "border-border/60 bg-muted/20 text-muted-foreground", title: "no mapped strike within tolerance: the map shows nothing here (strikes outside its band or under its share floor are not on it)" },
  unavailable: { text: "unavailable", cls: "border-rose-500/40 bg-rose-500/10 text-rose-300", title: "no map to check against" },
};

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const storageKey = (symbol: string) => `batcave.chartLevels.${symbol}`;

function loadLevels(symbol: string): number[] {
  try {
    const raw = localStorage.getItem(storageKey(symbol));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(Number).filter((n) => Number.isFinite(n) && n >= 10) : [];
  } catch { return []; }
}
function saveLevels(symbol: string, levels: number[]): void {
  try { localStorage.setItem(storageKey(symbol), JSON.stringify(levels)); } catch { /* per-viewer convenience only */ }
}

export default function ChartLevelsCard({ symbol = "$SPX" }: { symbol?: string }) {
  const [levels, setLevels] = useState<number[]>(() => loadLevels(symbol));
  const [draft, setDraft] = useState("");
  useEffect(() => { setLevels(loadLevels(symbol)); }, [symbol]);
  useEffect(() => { saveLevels(symbol, levels); }, [symbol, levels]);

  const q = useQuery<MapResp>({
    queryKey: ["/api/odte/map", symbol],
    queryFn: async () => (await apiRequest("GET", `/api/odte/map?symbol=${encodeURIComponent(symbol)}`)).json(),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  const m = q.data;
  const checks: LevelCheck[] = useMemo(
    () => checkLevels(m ? { spot: m.spot, strikes: m.strikes, landmarks: m.landmarks, range: m.range } : { spot: null, strikes: [] }, levels),
    [m, levels],
  );
  const tol = m?.spot ? defaultTolerancePts(m.spot) : null;
  const mapState = q.isError ? "unavailable" : !m ? "loading" : m.dataState === "no_gex" ? "no_data" : m.dataState === "stale_session" || m.dataState === "stale" ? "stale" : "ok";

  const add = () => {
    const parsed = parseLevels(draft);
    if (!parsed.length) return;
    setLevels((prev) => Array.from(new Set([...prev, ...parsed])).sort((a, b) => b - a));
    setDraft("");
  };
  const remove = (level: number) => setLevels((prev) => prev.filter((l) => l !== level));

  return (
    <Card data-testid="chart-levels-card">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Layers className="h-4 w-4 text-amber-400" />
            <CardTitle className="text-sm font-semibold tracking-tight">Your chart levels</CardTitle>
            <span className="font-mono text-[11px] text-muted-foreground">{symbol.replace(/^\$/, "")} · against the 0DTE map{tol != null ? ` · ±${tol} pts` : ""}</span>
          </div>
          <DataStateChip state={mapState} reason={m?.reason ?? null} asOf={m?.chainAsOfMs ?? m?.asOf ?? null} stale={m?.chainStale ?? null} source="0DTE map" testId="chart-levels-state" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[11px] text-muted-foreground">
          Levels you drew from the daily, 4-hour and hourly charts, checked against what the chain shows. A tag is a fact about mapped open interest near a price, not a forecast.
        </p>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
            add levels (comma or space separated)
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="7686, 7643, 7600" inputMode="decimal"
              className="min-h-[40px] w-full rounded-md border border-border/60 bg-background px-2 font-mono text-sm" data-testid="chart-levels-input" />
          </label>
          <button type="submit" disabled={!parseLevels(draft).length}
            className="min-h-[40px] rounded-md border border-amber-500/40 bg-amber-500/10 px-3 text-xs font-semibold text-amber-300 disabled:opacity-50" data-testid="chart-levels-add">
            check against chain
          </button>
        </form>
        {levels.length === 0 ? (
          <div className="min-h-[44px] text-[11px] text-muted-foreground" data-testid="chart-levels-empty">no levels yet: add the prices from your charts and each one is tagged from the map above.</div>
        ) : (
          <ul className="space-y-1.5" data-testid="chart-levels-list">
            {checks.map((c) => {
              const t = TAG[c.tag];
              return (
                <li key={c.level} className="grid grid-cols-[64px_minmax(0,1fr)_auto_28px] items-center gap-2 rounded-md bg-muted/10 px-2 py-1.5" data-testid={`chart-level-${c.level}`}>
                  <span className="font-mono text-sm font-semibold tabular-nums">{fmt(c.level)}</span>
                  <span className="truncate text-[11px] text-muted-foreground" title={c.note}>
                    {c.side !== "unknown" && <span className="mr-1 font-mono uppercase">{c.side === "at" ? "ATM" : c.side}</span>}
                    {c.note}{c.insideStraddle === false ? " · outside the straddle range" : ""}
                  </span>
                  <span className={`whitespace-nowrap rounded border px-1.5 py-px font-mono text-[10px] ${t.cls}`} title={t.title} data-testid={`chart-level-tag-${c.level}`}>{t.text}</span>
                  <button type="button" onClick={() => remove(c.level)} aria-label={`remove ${fmt(c.level)}`} className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-rose-300">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
