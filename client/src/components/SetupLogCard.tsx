/**
 * SetupLogCard.tsx: the setup event log and its rule book (server/setupEngine.ts).
 *
 * Shows what the engine is doing, not what to do: the rule version, why no
 * setup fires right now per symbol, the recent log with outcomes, and the
 * per-version summary, which stays counts-only until a version clears the
 * sample gate. The Method disclosure lists every rule with its value and
 * meaning, so what the reader sees is what the engine ran.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import DataStateChip from "@/components/DataStateChip";
import { ClipboardList, ChevronRight } from "lucide-react";

interface Blocked { kind: string; blockers: string[] }
interface SetupLog {
  dataState: "ok" | "no_data" | "unavailable" | "loading";
  edition: string;
  running: boolean;
  lastTickAt: number | null;
  lastTickError: string | null;
  rules: { version: string; minSample: number; items: Array<{ path: string; value: string | number | boolean; meaning: string }> };
  calendar: { validThrough: string; known: boolean; minutesToNext: number | null; next: string | null };
  counts: { open: number; hit: number; invalidated: number; expired: number; ungraded: number; total: number };
  summary: Array<{ ruleVersion: string; kind: string; n: number; positive: number; lo: number | null; hi: number | null; meanNetPct: number | null; sampleReady: boolean }>;
  recent: Array<{ id: number; symbol: string; kind: string; direction: string; detectedAt: number; spot: number; target: number; invalidation: number; status: string; netPct: number | null; exitPrice: number | null; ruleVersion: string }>;
  ranked: Array<{ id: number; symbol: string; sector: string | null; kind: string; direction: string; detectedAt: number; spot: number; target: number; invalidation: number; rMultiple: number | null; score: number; margins: Array<{ name: string; margin: number }> }>;
  whyNotNow: Array<{ symbol: string; at: number; spot: number | null; structureState: string; blocked: Blocked[] }>;
  note: string;
}
const MARGIN_TEXT: Record<string, string> = {
  premium: "premium vs floor", volOi: "vol/OI vs floor", wallShare: "wall share vs floor", costMultiple: "target/cost vs rule", rMultiple: "R vs rule", calendarQuiet: "calendar quiet vs rule", impliedMoveRoom: "implied-move room",
};

const KIND_TEXT: Record<string, string> = {
  fade_call_wall: "fade at the call wall", fade_put_wall: "fade at the put wall", breakout_above: "breakout above the call wall", breakout_below: "breakout below the put wall",
};
const STATUS_CLS: Record<string, string> = {
  open: "text-sky-300", hit: "text-emerald-300", invalidated: "text-rose-300", expired: "text-muted-foreground", ungraded: "text-amber-300",
};
const fmtPx = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const fmtPct = (f: number | null) => (f == null ? "—" : `${f > 0 ? "+" : ""}${(f * 100).toFixed(2)}%`);
const fmtTime = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function SetupLogCard() {
  const q = useQuery<SetupLog>({
    queryKey: ["/api/setups"],
    queryFn: async () => (await apiRequest("GET", "/api/setups")).json(),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  const d = q.data;
  const state = q.isError ? "unavailable" : !d ? "loading" : d.dataState;

  return (
    <Card data-testid="setup-log-card">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <ClipboardList className="h-4 w-4 text-amber-400" />
            <CardTitle className="text-sm font-semibold tracking-tight">Setup log</CardTitle>
            {d && <span className="font-mono text-[11px] text-muted-foreground">rules {d.rules.version} · {d.counts.total} logged · {d.running ? "scanning in session" : "not running"}</span>}
          </div>
          <DataStateChip state={state} reason={d?.lastTickError ?? null} asOf={d?.lastTickAt ?? null} source="Schwab" testId="setup-log-state" />
        </div>
      </CardHeader>
      <CardContent className="min-h-[180px] space-y-3">
        {!d && !q.isError && <div className="text-[11px] text-muted-foreground">reading the log…</div>}
        {q.isError && <div className="text-[11px] text-rose-300">setup log unavailable</div>}
        {d && (
          <>
            <p className="text-[11px] text-muted-foreground">{d.note}</p>

            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid="setup-log-counts">
              {(["open", "hit", "invalidated", "expired", "ungraded", "total"] as const).map((k) => (
                <div key={k} className="rounded border border-border/40 bg-muted/10 px-2 py-1.5">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{k}</div>
                  <div className={`font-mono text-sm font-semibold tabular-nums ${STATUS_CLS[k] ?? "text-foreground"}`}>{d.counts[k]}</div>
                </div>
              ))}
            </div>

            <div className="space-y-1" data-testid="setup-log-ranked">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">open setups, ranked by margin over the rules (not by predicted edge) · top {d.rules.items.find((i) => i.path === "rank.topN")?.value ?? 10}, sector cap {d.rules.items.find((i) => i.path === "rank.maxPerSector")?.value ?? 3}</div>
              {d.ranked.length === 0 ? (
                <div className="text-[11px] text-muted-foreground" data-testid="setup-log-ranked-empty">no open setup inside its horizon right now</div>
              ) : d.ranked.map((r, i) => (
                <div key={r.id} className="rounded bg-muted/10 px-2 py-1.5 text-[11px]" data-testid={`setup-ranked-${r.symbol}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span><span className="font-mono text-muted-foreground">#{i + 1}</span> <span className="font-mono font-semibold">{r.symbol}</span> <span className="text-muted-foreground">{r.sector ?? "sector unknown"} · {KIND_TEXT[r.kind] ?? r.kind} · {fmtTime(r.detectedAt)}</span></span>
                    <span className="font-mono tabular-nums">at {fmtPx(r.spot)} → {fmtPx(r.target)} · inval {fmtPx(r.invalidation)} · R {r.rMultiple == null ? "—" : r.rMultiple.toFixed(2)} · score {r.score.toFixed(2)}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-muted-foreground">
                    {r.margins.map((m) => <span key={m.name} title={MARGIN_TEXT[m.name] ?? m.name}>{MARGIN_TEXT[m.name] ?? m.name} {m.margin.toFixed(1)}x</span>)}
                  </div>
                </div>
              ))}
            </div>

            {d.summary.length > 0 && (
              <div className="space-y-1" data-testid="setup-log-summary">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">graded, per rule version and kind</div>
                {d.summary.map((s) => (
                  <div key={`${s.ruleVersion}|${s.kind}`} className="flex flex-wrap items-center justify-between gap-2 rounded bg-muted/10 px-2 py-1 text-[11px]">
                    <span>{KIND_TEXT[s.kind] ?? s.kind} <span className="font-mono text-muted-foreground">{s.ruleVersion}</span></span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {s.positive}/{s.n} positive{s.lo != null ? ` (${(s.lo * 100).toFixed(0)}–${(s.hi! * 100).toFixed(0)}%)` : ""} · mean net {fmtPct(s.meanNetPct)}
                      {!s.sampleReady && <span className="ml-1 text-amber-300">· {s.n} of {d.rules.minSample}: counts only</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <details className="text-[11px]">
              <summary className="flex min-h-[44px] cursor-pointer select-none list-none items-center gap-1.5 text-muted-foreground lg:min-h-0"><ChevronRight className="h-3 w-3" /> why nothing fires right now ({d.whyNotNow.length} symbols)</summary>
              <div className="mt-1 space-y-1" data-testid="setup-log-why">
                {d.whyNotNow.length === 0 && <div className="text-muted-foreground">no scan yet this session</div>}
                {d.whyNotNow.map((w) => {
                  const top = w.blocked.slice().sort((a, b) => a.blockers.length - b.blockers.length)[0];
                  return (
                    <div key={w.symbol} className="rounded bg-muted/10 px-2 py-1">
                      <span className="font-mono font-semibold">{w.symbol}</span> <span className="font-mono text-muted-foreground">{fmtPx(w.spot)} · structure {w.structureState}</span>
                      {top && <div className="text-muted-foreground">closest: {KIND_TEXT[top.kind] ?? top.kind} — {top.blockers.join("; ")}</div>}
                    </div>
                  );
                })}
              </div>
            </details>

            {d.recent.length > 0 && (
              <div className="space-y-1" data-testid="setup-log-recent">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">recent</div>
                {d.recent.map((r) => (
                  <div key={r.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded bg-muted/10 px-2 py-1 text-[11px]">
                    <span className="font-mono font-semibold">{r.symbol}</span>
                    <span className="truncate text-muted-foreground">{KIND_TEXT[r.kind] ?? r.kind} at {fmtPx(r.spot)} · target {fmtPx(r.target)} · invalidation {fmtPx(r.invalidation)} · {fmtTime(r.detectedAt)}</span>
                    <span className={`font-mono tabular-nums ${STATUS_CLS[r.status] ?? ""}`}>{r.status}{r.netPct != null ? ` ${fmtPct(r.netPct)}` : ""}</span>
                  </div>
                ))}
              </div>
            )}

            <details className="text-[11px]">
              <summary className="flex min-h-[44px] cursor-pointer select-none list-none items-center gap-1.5 text-muted-foreground lg:min-h-0"><ChevronRight className="h-3 w-3" /> method: the rule book ({d.rules.items.length} rules, version {d.rules.version})</summary>
              <div className="mt-1 space-y-0.5" data-testid="setup-log-method">
                <div className="text-muted-foreground">calendar: {d.calendar.known ? `next tier-1 ${d.calendar.next ?? "none listed"}${d.calendar.minutesToNext != null ? ` (${d.calendar.minutesToNext} min)` : ""}` : `unknown past ${d.calendar.validThrough}: the tier-1 gate cannot be checked, so setups are blocked until the calendar is extended`}</div>
                {d.rules.items.map((it) => (
                  <div key={it.path} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <span className="text-muted-foreground"><span className="font-mono text-foreground">{it.path}</span> — {it.meaning}</span>
                    <span className="font-mono tabular-nums">{String(it.value)}</span>
                  </div>
                ))}
              </div>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}
