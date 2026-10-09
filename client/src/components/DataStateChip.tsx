/**
 * DataStateChip.tsx: one chip for "what state is this data in, and how old".
 *
 * Shared by every panel that shows server numbers carrying a dataState
 * (ok / partial / stale / unavailable / no_data / no_spot) and/or an as-of
 * time. Logic lives in shared/dataState.ts (unit-tested); this file is only
 * the rendering.
 *
 *   <DataStateChip state={d.dataState} reason={d.dataStateReason}
 *                  asOf={d.asOfMs} maxAgeMs={60_000} source="Schwab" />
 *
 * - state: any string; unknown strings render as "unknown state" in the
 *   unavailable style (fail closed, never "ok").
 * - asOf: epoch ms, epoch seconds or ISO string. With maxAgeMs, an ok/partial
 *   payload older than the max renders as "stale". Without asOf the age part
 *   reads "age unknown" when showAge is set, never "0s".
 * - stale: server stale flag; DataAgeChip is now a thin wrapper over this chip.
 * - hideWhenOk: render nothing for a fresh "ok" (keeps quiet panels quiet).
 */
import { useEffect, useState } from "react";
import {
  ageFromAsOf,
  describeDataState,
  effectiveDataState,
  formatAge,
  type DataStateTone,
} from "@shared/dataState";

const TONE_CLASS: Record<DataStateTone, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  bad: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  neutral: "border-border/60 bg-muted/20 text-muted-foreground",
};

/** Re-renders every `ms` so a displayed age keeps growing between refetches. */
function useNow(ms: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
  return now;
}

export interface DataStateChipProps {
  state?: string | null;
  reason?: string | null;
  asOf?: number | string | null;
  maxAgeMs?: number | null;
  /** Server stale flag (payload re-served after a failed refresh, within its max age). Downgrades ok/partial to stale. */
  stale?: boolean | null;
  /** Data source name shown in the tooltip and before the age, e.g. "Schwab". */
  source?: string | null;
  /** Show the age even when asOf is missing ("age unknown"). Default: only when asOf given. */
  showAge?: boolean;
  hideWhenOk?: boolean;
  className?: string;
  testId?: string;
}

export default function DataStateChip({
  state,
  reason,
  asOf,
  maxAgeMs,
  stale,
  source,
  showAge,
  hideWhenOk = false,
  className,
  testId,
}: DataStateChipProps) {
  const hasAsOf = asOf != null && asOf !== "";
  const now = useNow(15_000, hasAsOf);
  const ageMs = hasAsOf ? ageFromAsOf(asOf ?? null, now) : null;
  const eff = effectiveDataState(state, ageMs, maxAgeMs);
  // The server stale flag downgrades an ok/partial payload, never upgrades a bad one.
  const flagged = stale === true && (eff === "ok" || eff === "partial");
  // Keep the caller's original string for "unknown state" labelling unless
  // age (or the stale flag) downgraded it to stale.
  const view = describeDataState(eff === "stale" || flagged ? "stale" : state, reason);
  if (hideWhenOk && view.state === "ok") return null;

  const ageText = hasAsOf || showAge ? formatAge(ageMs) : null;
  const title = [
    source ? `Source: ${source}.` : null,
    view.title,
    ageText ? `Age: ${ageText}${maxAgeMs ? ` (max ${formatAge(maxAgeMs)})` : ""}.` : null,
  ].filter(Boolean).join(" ");

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${TONE_CLASS[view.tone]} ${className ?? ""}`}
      title={title}
      data-testid={testId ?? "data-state-chip"}
      data-state={view.state}
    >
      {view.label}
      {ageText ? <span className="normal-case opacity-80">· {source ? `${source} ` : ""}{ageText}</span> : null}
    </span>
  );
}
