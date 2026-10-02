import type { TradeBrief } from "@shared/tradeBrief";
import type { EvidenceAcquisition } from "@shared/evidenceAcquisition";

const labels: Record<EvidenceAcquisition["read_provenance"], string> = {
  transport_response: "Source response",
  cache_hit: "Local source cache",
  stale_cache_fallback: "Stale-cache fallback",
  unverified_adapter_return: "Adapter path unverified",
  brief_read_cache: "Brief-service cache",
};
const date = (value: string) => new Date(value).toLocaleString();

/** Disclosure only. No fetch, clock-based promotion, provider inference or model request. */
export function EvidenceTiming({ brief, testId }: {
  brief: Pick<TradeBrief, "evidence" | "created_at">; testId: string;
}) {
  const groups = new Map<string, { source: string; acquisition: EvidenceAcquisition }>();
  for (const evidence of brief.evidence) {
    if (!evidence.acquisition) continue;
    const source = evidence.source_id ?? evidence.source;
    const key = `${source}:${JSON.stringify(evidence.acquisition)}`;
    if (!groups.has(key)) groups.set(key, { source, acquisition: evidence.acquisition });
  }
  const rows = [...groups.values()];
  return <details data-testid={testId} className="min-w-0 rounded-lg border border-border">
    <summary data-testid={`${testId}-toggle`} className="min-h-[44px] cursor-pointer p-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      Receipt &amp; cache timing
    </summary>
    <div className="space-y-3 border-t border-border p-3 text-xs leading-relaxed text-muted-foreground">
      <p>Snapshot assembled {date(brief.created_at)}. Market observation times remain attached to each evidence item; assembly and cache reads do not make data fresh.</p>
      {!rows.length && <p data-testid={`${testId}-unknown`}>Provider receipt times were not recorded for this snapshot. No fresh-fetch claim is made.</p>}
      {rows.slice(0, 12).map(({ source, acquisition: a }, index) => <div data-testid={`${testId}-row-${index}`} key={`${source}:${JSON.stringify(a)}`} className="min-w-0 space-y-1 border-t border-border pt-2">
        <p className="break-words font-medium text-foreground">{source} · {labels[a.read_provenance]}</p>
        <p>Original app receipt: {a.received_at ? date(a.received_at) : "Unknown"}</p>
        <p>Application read: {date(a.read_at)}</p>
        {a.read_provenance === "brief_read_cache" && <p>Retained adapter path: {labels[a.adapter_read_provenance]} · {date(a.adapter_read_at)}</p>}
        {(a.read_provenance === "stale_cache_fallback"
          || (a.read_provenance === "brief_read_cache" && a.adapter_read_provenance === "stale_cache_fallback"))
          && <p className="text-amber-800 dark:text-amber-300">Fallback data, not a new source response. Original freshness gates still apply.</p>}
      </div>)}
      {rows.length > 12 && <p>{rows.length - 12} additional timing groups remain in the stored evidence.</p>}
      <p>First-seen and historical known-at remain unknown. Receipt metadata does not establish source truth, complete coverage or point-in-time-safe forecasts.</p>
    </div>
  </details>;
}
