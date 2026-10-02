import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { withRequestDeadline } from "@/lib/requestDeadline";
import { LedgerReadResponseSchema } from "@shared/evidenceLedger";
import { ArchivedTradeBriefSchema, type TradeBrief } from "@shared/tradeBrief";

const button = "min-h-[44px] rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:cursor-not-allowed";
const date = (value: string) => new Date(value).toLocaleString();

/** Historical view stays separate from the live brief and cannot call the AI curator. */
export function EvidenceHistory({ brief, offline }: { brief: TradeBrief; offline: boolean }) {
  const receipt = brief.archive;
  const native = import.meta.env.VITE_NATIVE_BUILD === "true";
  const [open, setOpen] = useState(false);
  const result = useQuery({
    queryKey: ["evidence-history", receipt?.status === "saved" ? receipt.record_id : brief.snapshot_id],
    enabled: false, retry: false, staleTime: Infinity, gcTime: 0,
    queryFn: ({ signal }) => withRequestDeadline(async requestSignal => {
      if (receipt?.status !== "saved") throw new Error("not_saved");
      const response = await apiRequest("POST", "/api/trade-brief/history/read",
        { record_id: receipt.record_id, read_token: receipt.read_token }, requestSignal);
      const record = LedgerReadResponseSchema.parse(await response.json());
      const snapshot = ArchivedTradeBriefSchema.parse(record.snapshot);
      if (record.record_id !== receipt.record_id || record.payload_hash !== receipt.payload_hash
        || snapshot.snapshot_id !== brief.snapshot_id || snapshot.instrument_id !== brief.instrument_id
        || snapshot.horizon !== brief.horizon) throw new Error("archive_identity_mismatch");
      return { record, snapshot };
    }, signal),
  });
  if (!receipt) return null;
  return <section data-testid="evidence-history" className="mt-4 min-w-0 rounded-lg border border-border p-4 text-sm leading-relaxed">
    <h4 className="font-semibold">Evidence history</h4>
    {receipt.status === "unavailable" ? <p data-testid="evidence-history-unsaved" role="status" className="mt-2 text-amber-800 dark:text-amber-300">
      Not confirmed saved. This brief remains usable within its normal expiry, but no durable capture is promised.
    </p> : <>
      <p data-testid="evidence-history-saved" className="mt-1 text-muted-foreground">Saved locally at {date(receipt.stored_at)}.</p>
      <p className="mt-1 text-xs text-muted-foreground">Available for up to 30 days, subject to size limits. Survives process restart on this disk; not an off-device backup. Receipt stays in this tab; earlier records require the local owner tool after the tab closes.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button data-testid="evidence-history-review" type="button" className={button} disabled={offline || native || result.isFetching}
          onClick={() => { setOpen(true); if (!result.data) void result.refetch(); }}>
          {result.isFetching ? "Verifying stored record…" : result.error ? "Retry saved-record review" : "Review saved evidence"}
        </button>
        {open && <button data-testid="evidence-history-close" type="button" className={button} onClick={() => setOpen(false)}>Close history</button>}
      </div>
      {native && <p className="mt-2 text-xs text-muted-foreground">Archive viewing is not enabled in the paused iPhone build.</p>}
      {offline && <p className="mt-2 text-xs text-muted-foreground">Offline. Stored-record verification requires the archive server.</p>}
      {result.error && <p data-testid="evidence-history-error" role="alert" className="mt-3 text-sm text-destructive">The stored record could not be verified. It may be outside retention, unavailable for this receipt, or have failed an integrity check. No substitute record was displayed.</p>}
      {open && result.data && <div data-testid="evidence-history-record" className="mt-4 min-w-0 space-y-3 border-t border-border pt-4">
        <p className="font-semibold text-amber-800 dark:text-amber-300">Historical record · Not live · No trading action</p>
        <p className="text-xs text-muted-foreground">Captured {date(result.data.snapshot.created_at)}. Original expiry {date(result.data.snapshot.expires_at)}. This view does not refresh either timestamp.</p>
        <div className="rounded-md bg-muted/30 p-3">
          <p data-testid="evidence-history-integrity" className="font-medium">Stored-content checksum verified</p>
          <p data-testid="evidence-history-replay" className="mt-1 text-sm">Numerical replay: {result.data.record.replay.status.replaceAll("_", " ")} · {result.data.record.replay.checked_count} {result.data.record.replay.checked_count === 1 ? "calculation" : "calculations"} checked.</p>
          <p className="mt-1 text-xs text-muted-foreground">{result.data.record.replay.detail}</p>
          {result.data.record.replay.status === "mismatch" && <p role="alert" className="mt-2 text-destructive">Stored calculations did not reproduce. Do not rely on this record.</p>}
        </div>
        <p className="text-sm">Captured verdict: {result.data.snapshot.verdict}. {result.data.snapshot.thesis}</p>
        <details className="rounded-md border border-border">
          <summary data-testid="evidence-history-data-toggle" className="min-h-[44px] cursor-pointer p-3 text-sm font-medium">Stored numerical evidence and versions</summary>
          <div className="space-y-3 border-t border-border p-3 text-xs">
            <p>Calculation: {result.data.snapshot.calculation_version}<br />Calendar: {result.data.snapshot.session.schedule?.version ?? "Not recorded"}<br />Evidence policy: {result.data.snapshot.evidence_review?.version ?? "Not recorded"}</p>
            {result.data.snapshot.evidence.map(e => <div key={e.id} className="min-w-0 border-t border-border pt-2">
              <p className="font-medium">{e.label}</p>
              <p className="break-words tabular-nums">{e.value.toLocaleString(undefined, { maximumFractionDigits: 6 })} {e.unit} · Historical {e.status}</p>
              <p className="break-words text-muted-foreground">{e.observed_at} · {e.source_id ?? e.source}</p>
            </div>)}
            {!result.data.snapshot.evidence.length && <p>No numeric evidence was captured in this record.</p>}
          </div>
        </details>
        <details className="rounded-md border border-border">
          <summary data-testid="evidence-history-audit-toggle" className="min-h-[44px] cursor-pointer p-3 text-sm font-medium">Changes, continuity and limits</summary>
          <div className="space-y-2 border-t border-border p-3 text-xs text-muted-foreground">
            <p>{result.data.record.predecessor_record_id ? `${result.data.record.changes.changed_ids.length} evidence IDs changed since an earlier retained capture.` : "First retained capture for this listing and horizon."} These are new captures, not certified provider corrections.</p>
            <p>{result.data.record.changes.same_observation_changed_ids.length} items changed while retaining the same observation timestamp and source.</p>
            <p>Writer session opened {date(result.data.record.writer_session.opened_at)}. {result.data.record.writer_session.previous_activity_at
              ? `Prior ledger activity: ${date(result.data.record.writer_session.previous_activity_at)}. Continuity between writer sessions is unverified.`
              : "No prior ledger activity was recorded."}</p>
            {result.data.record.limitations.map(text => <p key={text}>{text}</p>)}
            <p className="break-all">Record: {result.data.record.record_id}<br />SHA-256: {result.data.record.payload_hash}</p>
          </div>
        </details>
      </div>}
    </>}
  </section>;
}
