/**
 * UnavailablePanel.tsx: what a panel shows in place of its numbers when the
 * server says the data is unavailable (503 {dataState, reason}) or a section
 * of a partial payload is null. Uses the shared DataStateChip so the state
 * reads the same everywhere; never a blank panel, never zeros.
 *
 *   <UnavailablePanel title="Dealer gamma" state="unavailable"
 *                     reason="Schwab SPY options chain unavailable: Schwab not connected" />
 *
 * `error` (a react-query error) may be passed instead of state/reason; it is
 * parsed with shared/unavailable.ts (503 with dataState -> "unavailable",
 * anything else -> "failed").
 */
import DataStateChip from "./DataStateChip";
import { parseUnavailableError } from "@shared/unavailable";

export interface UnavailablePanelProps {
  title?: string;
  state?: string | null;
  reason?: string | null;
  error?: unknown;
  source?: string;
  className?: string;
  testId?: string;
  compact?: boolean;
}

export function unavailableFrom(error: unknown, fallbackReason = "no data from the server"): { state: string; reason: string } {
  const p = parseUnavailableError(error);
  return p ? { state: p.dataState, reason: p.reason } : { state: "unavailable", reason: fallbackReason };
}

export default function UnavailablePanel({
  title, state, reason, error, source = "Schwab", className, testId, compact,
}: UnavailablePanelProps) {
  const parsed = error != null ? unavailableFrom(error) : null;
  const st = state ?? parsed?.state ?? "unavailable";
  const why = reason ?? parsed?.reason ?? null;
  return (
    <div
      className={`rounded-md border border-dashed border-rose-500/30 bg-rose-500/5 ${compact ? "p-2" : "p-4"} text-xs ${className ?? ""}`}
      data-testid={testId ?? "unavailable-panel"}
      data-state={st}
    >
      <div className="flex flex-wrap items-center gap-2">
        {title ? <span className="font-medium text-foreground">{title}</span> : null}
        <DataStateChip state={st} reason={why} source={source} />
      </div>
      {why ? <div className="mt-1 break-words text-muted-foreground">{why}</div> : null}
      {!compact ? (
        <div className="mt-1 text-[10px] text-muted-foreground/70">
          Nothing is shown in place of this data. It returns when {source} answers again.
        </div>
      ) : null}
    </div>
  );
}
