// Unusual volume, one row per contract, with how the volume built in five-minute steps.
// Replaces the per-strike rows that added every expiry together (so "48,000 vs 623 open interest" could
// be several contracts). Data: /api/flow/contract-alerts (server/contractVolume.ts).
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { etTime } from "@shared/etTime";
import { STEP_MS } from "@shared/contractBuild";

interface Step { step: number; volume: number }
interface Alert {
  occ: string; expiry: string; strike: number; side: "C" | "P";
  volume: number; openInterest: number | null; multiple: number | null; premium: number;
  steps: Step[];
  build: { line: string; baseline: number; timed: number; shape: string };
}
interface Resp { symbol: string; day: string; asOfMs: number | null; watchingSinceMs: number | null; rule: string; alerts: Alert[]; note: string }

const num = (v: number) => Math.round(v).toLocaleString("en-US");
const money = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${Math.round(v)}`);
const expLabel = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1]} ${Number(m[3])}` : iso;
};

/** The steps as bars on a shared five-minute grid from the first step to the last, empty steps included. */
function BuildBars({ steps, side }: { steps: Step[]; side: "C" | "P" }) {
  if (!steps.length) return null;
  const first = steps[0].step, last = steps[steps.length - 1].step;
  const count = Math.min(78, Math.round((last - first) / STEP_MS) + 1);
  const byStep = new Map(steps.map((s) => [s.step, s.volume]));
  const start = last - (count - 1) * STEP_MS;
  const cells = Array.from({ length: count }, (_, i) => ({ step: start + i * STEP_MS, volume: byStep.get(start + i * STEP_MS) ?? 0 }));
  const max = Math.max(...cells.map((c) => c.volume), 1);
  return (
    <div className="mt-1.5">
      <div className="flex h-10 items-end gap-px" role="img" aria-label={`Volume per five minutes from ${etTime(start)} to ${etTime(last)} Eastern`}>
        {cells.map((c) => (
          <div key={c.step} className="flex-1 min-w-[3px] max-w-[14px]" title={`${etTime(c.step)}: ${num(c.volume)} contracts`}>
            <div className={side === "C" ? "bg-emerald-500/80" : "bg-rose-500/80"} style={{ height: `${c.volume > 0 ? Math.max(6, (c.volume / max) * 100) : 0}%`, minHeight: c.volume > 0 ? 2 : 0 }} />
            {c.volume === 0 && <div className="h-px bg-border" />}
          </div>
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-xs text-muted-foreground">
        <span>{etTime(start)}</span>
        <span>each bar is five minutes · tallest {num(max)}</span>
        <span>{etTime(last)}</span>
      </div>
    </div>
  );
}

export default function ContractBuildList({ symbol, enabled }: { symbol: string; enabled: boolean }) {
  const q = useQuery<Resp>({
    queryKey: ["/api/flow/contract-alerts", symbol],
    queryFn: async () => (await apiRequest("GET", `/api/flow/contract-alerts?symbol=${encodeURIComponent(symbol)}`)).json(),
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 30_000,
    enabled,
  });
  const d = q.data;
  return (
    <div className="rounded-md border border-border/50 p-3" data-testid="contract-build-list">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <div className="text-sm font-semibold">Unusual volume, contract by contract</div>
        {d?.asOfMs != null && <div className="text-xs text-muted-foreground">read {etTime(d.asOfMs)} ET</div>}
      </div>
      <div className="text-xs text-muted-foreground">
        A contract is listed when {d?.rule ?? "its day volume is at least 3 times its own open interest and at least 500 contracts"}. Largest dollar amount first.
      </div>
      {q.isLoading && <div className="mt-2 text-sm text-muted-foreground">Reading…</div>}
      {q.isError && <div className="mt-2 text-sm text-rose-400">Not read: the request failed.</div>}
      {d && d.alerts.length === 0 && (
        <div className="mt-2 text-sm text-muted-foreground">
          {d.watchingSinceMs == null
            ? "Nothing recorded for this symbol today yet. Recording starts with the first option chain read after the open."
            : `No contract meets the rule so far today (recording since ${etTime(d.watchingSinceMs)} ET).`}
        </div>
      )}
      {d && d.alerts.length > 0 && (
        <ul className="mt-2 space-y-3">
          {d.alerts.map((a) => (
            <li key={a.occ} className="border-t border-border/40 pt-2 first:border-t-0 first:pt-0" data-testid={`contract-build-${a.occ}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className={`text-sm font-semibold ${a.side === "C" ? "text-emerald-400" : "text-rose-400"}`}>
                  {a.strike.toLocaleString("en-US")} {a.side === "C" ? "call" : "put"} · expires {expLabel(a.expiry)}
                </span>
                <span className="text-sm">
                  {num(a.volume)} traded today vs {a.openInterest != null ? num(a.openInterest) : "unknown"} open before today
                  {a.multiple != null ? ` (${a.multiple >= 10 ? a.multiple.toFixed(0) : a.multiple.toFixed(1)} times)` : ""}
                </span>
                {a.premium > 0 && <span className="text-sm text-muted-foreground" title="Contracts added since the first read, times the last price at each read, times 100. Excludes volume from before the first read.">about {money(a.premium)} since first read</span>}
              </div>
              <div className="text-sm text-muted-foreground">{a.build.line}</div>
              <BuildBars steps={a.steps} side={a.side} />
            </li>
          ))}
        </ul>
      )}
      {d && <div className="mt-2 text-xs text-muted-foreground">{d.note}</div>}
    </div>
  );
}
