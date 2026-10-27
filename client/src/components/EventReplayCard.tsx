/**
 * EventReplayCard.tsx: tier-1 releases against the record (server/researchStore.ts).
 *
 * What the index did on each CPI / NFP / PCE / FOMC session this year, from
 * daily bars: close over the prior close, the opening gap, the session range,
 * the next session. Per-release summary beside the rows, and the research
 * store's snapshot count so the reader can see the desk's own history
 * accumulating. Reads the record; does not forecast.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import DataStateChip from "@/components/DataStateChip";
import { CalendarClock, ChevronRight } from "lucide-react";

interface Row { date: string; name: string; time: string; note: string | null; priorClose: number | null; close: number | null; closeMovePct: number | null; gapPct: number | null; rangePct: number | null; nextDayPct: number | null; state: "ok" | "partial" | "no_bar" | "future" }
interface Replay {
  symbol: string; asOf: number; dataState: "ok" | "partial" | "unavailable" | "no_data"; reason: string | null; bars: number; earliestBar: string | null;
  coverage: Record<string, string>; validThrough: string; rows: Row[];
  summary: Array<{ name: string; n: number; up: number; medianAbsClosePct: number | null; medianRangePct: number | null; largestClosePct: { date: string; pct: number } | null }>;
  note: string;
}
interface Snapshots { dataState: "ok" | "no_data"; edition: string; days: number; symbols: number; contracts: number; bytes: number; latest: string | null; earliest: string | null; lastRunAt: number | null; lastError: string | null; note: string }

const pct = (f: number | null, d = 2) => (f == null ? "—" : `${f > 0 ? "+" : ""}${(f * 100).toFixed(d)}%`);
const cls = (f: number | null) => (f == null ? "text-muted-foreground" : f > 0 ? "text-emerald-300" : f < 0 ? "text-rose-300" : "text-foreground");

export default function EventReplayCard({ symbol = "$SPX" }: { symbol?: string }) {
  const q = useQuery<Replay>({
    queryKey: ["/api/research/events", symbol],
    queryFn: async () => (await apiRequest("GET", `/api/research/events?symbol=${encodeURIComponent(symbol)}`)).json(),
    refetchInterval: 6 * 3600_000, staleTime: 3600_000, retry: false,
  });
  const snaps = useQuery<Snapshots>({
    queryKey: ["/api/research/snapshots"],
    queryFn: async () => (await apiRequest("GET", "/api/research/snapshots")).json(),
    refetchInterval: 3600_000, staleTime: 600_000, retry: false,
  });
  const d = q.data;
  const past = d?.rows.filter((r) => r.state !== "future") ?? [];
  const future = d?.rows.filter((r) => r.state === "future").slice().reverse() ?? [];

  return (
    <Card data-testid="event-replay-card">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <CalendarClock className="h-4 w-4 text-amber-400" />
            <CardTitle className="text-sm font-semibold tracking-tight">Releases against the record</CardTitle>
            {d && <span className="font-mono text-[11px] text-muted-foreground">{d.symbol.replace(/^\$/, "")} · {d.bars} daily bars{d.earliestBar ? ` from ${d.earliestBar}` : ""}</span>}
          </div>
          <DataStateChip state={q.isError ? "unavailable" : !d ? "loading" : d.dataState} reason={d?.reason ?? null} asOf={d?.asOf ?? null} source="Schwab" testId="event-replay-state" />
        </div>
      </CardHeader>
      <CardContent className="min-h-[160px] space-y-3">
        {d && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="event-replay-summary">
              {d.summary.map((s) => (
                <div key={s.name} className="rounded border border-border/40 bg-muted/10 px-2 py-1.5">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{s.name} · {s.n} priced</div>
                  <div className="font-mono text-sm tabular-nums">median |close| {pct(s.medianAbsClosePct)}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{s.up}/{s.n} up · range {pct(s.medianRangePct)}{s.largestClosePct ? ` · largest ${pct(s.largestClosePct.pct)} (${s.largestClosePct.date})` : ""}</div>
                </div>
              ))}
              {d.summary.length === 0 && <div className="col-span-full text-[11px] text-muted-foreground">no priced release session yet in the loaded history</div>}
            </div>

            <div className="hscroll-contain hscroll-hint" data-testid="event-replay-rows">
              <table className="w-full min-w-[560px] text-[11px]">
                <thead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr><th className="text-left">session</th><th className="text-left">release</th><th className="text-right">gap</th><th className="text-right">close</th><th className="text-right">range</th><th className="text-right">next day</th><th className="text-right">state</th></tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {past.slice(0, 14).map((r) => (
                    <tr key={`${r.date}-${r.name}`} className="border-t border-border/30" data-testid={`event-row-${r.date}`}>
                      <td className="py-0.5">{r.date}</td>
                      <td>{r.name} <span className="text-muted-foreground">{r.time}{r.note ? ` · ${r.note}` : ""}</span></td>
                      <td className={`text-right ${cls(r.gapPct)}`}>{pct(r.gapPct)}</td>
                      <td className={`text-right ${cls(r.closeMovePct)}`}>{pct(r.closeMovePct)}</td>
                      <td className="text-right">{pct(r.rangePct)}</td>
                      <td className={`text-right ${cls(r.nextDayPct)}`}>{pct(r.nextDayPct)}</td>
                      <td className="text-right text-muted-foreground">{r.state === "ok" ? "" : r.state.replace("_", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <details className="text-[11px]">
              <summary className="flex min-h-[44px] cursor-pointer select-none list-none items-center gap-1.5 text-muted-foreground lg:min-h-0"><ChevronRight className="h-3 w-3" /> coming up ({future.length}) · coverage</summary>
              <div className="mt-1 space-y-0.5 text-muted-foreground" data-testid="event-replay-coverage">
                {future.slice(0, 8).map((r) => <div key={`${r.date}-${r.name}`} className="font-mono">{r.date} {r.time} ET · {r.name}{r.note ? ` · ${r.note}` : ""}</div>)}
                {Object.entries(d.coverage).map(([k, v]) => <div key={k}><span className="font-mono text-foreground">{k}</span>: {v}</div>)}
                <div>calendar valid through {d.validThrough}; unknown after that.</div>
              </div>
            </details>
            <p className="text-[11px] text-muted-foreground">{d.note}</p>
          </>
        )}
        {q.isError && <p className="text-[11px] text-rose-300">event replay unavailable</p>}
        {snaps.data && (
          <p className="text-[11px] text-muted-foreground" data-testid="research-snapshots">
            <span className="font-mono uppercase tracking-wider">chain store</span> · {snaps.data.days} session{snaps.data.days === 1 ? "" : "s"}, {snaps.data.symbols} names, {snaps.data.contracts.toLocaleString("en-US")} contracts{snaps.data.latest ? `, latest ${snaps.data.latest}` : ""}. {snaps.data.note}{snaps.data.lastError ? ` Last error: ${snaps.data.lastError}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
