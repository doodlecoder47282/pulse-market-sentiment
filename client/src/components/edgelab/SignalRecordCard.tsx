// Signal record: one row per signal source, each on its own basis.
// GET /api/record/signals (server/signalRecord.ts, shared/signalRecord.ts).
//
// What this card must not do: pool sources into one figure, print a win share
// without its interval and n, or show an unread store as zero. Rows stack
// (no table) so nothing overflows sideways on a 360 px phone.

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import DataStateChip from "@/components/DataStateChip";
import {
  countText, meanNetText, resultText, SIGNAL_RECORD_NOTE,
  type SignalRecord, type SignalRecordSource,
} from "@shared/signalRecord";

// "insufficient" is a sample-size state, not a data-feed state, so it gets its own plain chip
// instead of borrowing a data-state word such as "partial".
const CHIP_STATE: Record<Exclude<SignalRecordSource["state"], "insufficient">, string> = {
  ok: "ok",
  unavailable: "unavailable",
};

function Count({ label, value, testId }: { label: string; value: number | null; testId: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums" data-testid={testId}>{countText(value)}</span>
    </span>
  );
}

function SourceRow({ s }: { s: SignalRecordSource }) {
  const mean = meanNetText(s);
  const since = s.since != null ? new Date(s.since).toISOString().slice(0, 10) : null;
  return (
    <div className="border-b border-border/40 py-2 last:border-b-0 min-w-0" data-testid={`row-record-${s.id}`} data-state={s.state}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs font-semibold break-words min-w-0">{s.name}</p>
        {s.state === "insufficient" ? (
          <span
            className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300 px-1.5 py-0.5 text-[11px] font-mono uppercase tracking-wider"
            title={s.reason ?? undefined}
            data-testid={`chip-record-${s.id}`}
            data-state="insufficient"
          >
            counts only
          </span>
        ) : (
          <DataStateChip state={CHIP_STATE[s.state]} reason={s.reason} testId={`chip-record-${s.id}`} />
        )}
      </div>
      <p className="text-xs text-muted-foreground leading-snug break-words mt-1" data-testid={`text-record-basis-${s.id}`}>
        <span className="text-foreground/80">in:</span> {s.basis.entry}. <span className="text-foreground/80">out:</span> {s.basis.exit}. <span className="text-foreground/80">costs:</span> {s.basis.costs}.
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs mt-1">
        <Count label="emitted" value={s.n.emitted} testId={`text-record-emitted-${s.id}`} />
        <Count label="graded" value={s.n.graded} testId={`text-record-graded-${s.id}`} />
        <Count label="open" value={s.n.open} testId={`text-record-open-${s.id}`} />
        <Count label="excluded" value={s.n.excluded} testId={`text-record-excluded-${s.id}`} />
        {since && <span className="text-muted-foreground whitespace-nowrap">since {since}</span>}
      </div>
      <p className={`text-xs font-mono leading-snug break-words mt-1 ${s.state === "ok" ? "" : s.state === "unavailable" ? "text-rose-400" : "text-amber-400"}`} data-testid={`text-record-result-${s.id}`}>
        {resultText(s)}
      </p>
      {mean && (
        <p className="text-xs font-mono leading-snug break-words" data-testid={`text-record-mean-${s.id}`}>{mean}</p>
      )}
      {s.state === "ok" && s.reason && (
        <p className="text-xs text-muted-foreground leading-snug break-words">{s.reason}</p>
      )}
      {s.notes.length > 0 && (
        <details className="mt-1">
          <summary className="text-xs text-muted-foreground cursor-pointer min-h-6 py-1 select-none" data-testid={`button-record-notes-${s.id}`}>
            notes ({s.notes.length}); minimum sample {s.minSample} graded{s.minSampleFrom === "default" ? " (hand-set default)" : " (this source's own gate)"}
          </summary>
          <ul className="text-xs text-muted-foreground leading-snug list-disc pl-4 space-y-0.5 break-words">
            {s.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function SignalRecordCard() {
  const q = useQuery<SignalRecord>({ queryKey: ["/api/record/signals"], refetchInterval: 5 * 60_000 });
  const r = q.data;
  return (
    <Card data-testid="card-signal-record">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold tracking-tight">Signal record</CardTitle>
          {q.isLoading && <DataStateChip state="loading" testId="chip-record-loading" />}
          {q.isError && <DataStateChip state="failed" reason={(q.error as any)?.message ?? null} testId="chip-record-failed" />}
          {r && !q.isError && <DataStateChip state="ok" asOf={r.asOf} testId="chip-record-asof" />}
        </div>
        <p className="text-xs text-muted-foreground leading-snug">
          what each signal source has logged and how it was graded, each on its own entry basis, exit rule and costs. below a source's minimum sample only counts are shown.
        </p>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {q.isLoading && <p className="text-xs text-muted-foreground">loading…</p>}
        {q.isError && (
          <p className="text-xs text-rose-400" data-testid="text-record-failed">
            signal record request failed: {(q.error as any)?.message ?? "unknown error"}. nothing is shown in its place.
          </p>
        )}
        {r && !q.isError && (
          <>
            <div data-testid="list-signal-record">
              {r.sources.map((s) => <SourceRow key={s.id} s={s} />)}
            </div>
            <p className="text-xs text-muted-foreground leading-snug break-words" data-testid="text-record-footer">
              {r.note ?? SIGNAL_RECORD_NOTE} "excluded" rows were logged but could not be graded on the source's basis; they are counted, not scored. a dash means the store could not be read, which is different from zero.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
