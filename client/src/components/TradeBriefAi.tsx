import { useEffect, useRef, useState } from "react";
import { transportRequest } from "@/lib/queryClient";
import { AiBriefResponseSchema, type AiBriefResponse } from "@shared/tradeBriefAi";
import { tradeBriefExpired, type TradeBrief } from "@shared/tradeBrief";

export function TradeBriefAi({ brief, expired, offline }: { brief: TradeBrief; expired: boolean; offline: boolean }) {
  const [result, setResult] = useState<AiBriefResponse | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const native = import.meta.env.VITE_NATIVE_BUILD === "true";
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => { if (expired || offline) controller.current?.abort(); }, [expired, offline]);
  async function curate() {
    if (attempted || busy || expired || offline || native || brief.verdict === "INSUFFICIENT DATA" || tradeBriefExpired(brief)) return;
    setAttempted(true); setBusy(true); setError("");
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 13_000);
    try {
      const response = await transportRequest("POST", "/api/trade-brief/curate", { snapshot_id: brief.snapshot_id }, abort.signal);
      if (!response.ok) throw new Error(response.status === 409 ? "Snapshot expired. Refresh the brief manually."
        : response.status === 429 ? "AI request budget reached. Deterministic research remains available."
        : "AI curation unavailable. Deterministic research remains available.");
      const parsed = AiBriefResponseSchema.parse(await response.json());
      if (parsed.snapshot_id !== brief.snapshot_id || parsed.expires_at !== brief.expires_at || parsed.verdict !== brief.verdict) throw new Error("AI snapshot mismatch; output withheld.");
      if (!mounted.current || abort.signal.aborted || tradeBriefExpired(brief)) return;
      setResult(parsed);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error && e.name !== "ZodError" && e.name !== "AbortError"
        ? e.message : "AI response unavailable or rejected. No retry or generated substitute was used.");
    } finally { clearTimeout(timer); if (mounted.current) setBusy(false); }
  }
  const showResult = !expired && !offline && result?.status === "curated";
  return <section data-testid="trade-brief-ai" className="mt-4 rounded-lg border border-primary/25 bg-primary/5 p-4 text-sm leading-relaxed">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h4 className="font-semibold">Prioritize this research</h4>
        <p className="mt-1 text-xs text-muted-foreground">Uses verified findings only. It cannot fill missing data.</p>
      </div>
      <button data-testid="trade-brief-curate" type="button" onClick={() => void curate()}
        disabled={attempted || busy || expired || offline || native || brief.verdict === "INSUFFICIENT DATA" || !brief.claims.length}
        className="min-h-[44px] rounded-lg border border-primary/40 bg-background px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? "Curating…" : attempted ? "Snapshot attempted" : "Curate with AI"}
      </button>
    </div>
    <div role="status" aria-live="polite" data-testid="trade-brief-ai-status" className="mt-3 text-xs text-muted-foreground">
      {expired ? "Snapshot expired. AI output withdrawn."
        : brief.verdict === "INSUFFICIENT DATA" ? "Not enough usable evidence for AI prioritization. No credits are spent on this data gap."
        : offline ? "Offline. AI output is not current."
        : native ? "AI curation is not enabled in the paused iPhone build."
        : busy ? "One bounded model request. The research verdict cannot be upgraded."
        : error || result?.detail || "Deterministic brief is ready without AI. One attempt per snapshot; shared limits of 6/hour and 30/day. No background model calls."}
    </div>
    {showResult && <div data-testid="trade-brief-ai-output" className="mt-4 space-y-4">
      <div><h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Priority finding</h5>
        <p className="mt-1">{result.lead?.text}</p>
        <p className="mt-1 break-words text-xs text-muted-foreground">Evidence: {result.lead?.evidence_ids.join(", ")}</p>
      </div>
      {!!result.supporting.length && <ul className="list-disc space-y-2 pl-4">{result.supporting.map(row => <li key={row.id}>{row.text}<span className="mt-1 block break-words text-xs text-muted-foreground">Evidence: {row.evidence_ids.join(", ")}</span></li>)}</ul>}
      <div><h5 className="font-semibold">Risk and missing confirmation</h5><ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">{result.cautions.map(row => <li key={row.id}>{row.text}</li>)}</ul></div>
      <div><h5 className="font-semibold">Next research checks</h5><ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">{result.checks.map(row => <li key={row.id}>{row.text}</li>)}</ul></div>
      <p className="text-xs text-muted-foreground">{result.model} · {result.verdict} unchanged · Not a trade recommendation.</p>
    </div>}
  </section>;
}
