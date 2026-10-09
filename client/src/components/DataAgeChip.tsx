/**
 * DataAgeChip.tsx: thin wrapper over DataStateChip, kept so existing callers
 * (<DataAgeChip asOfMs stale maxAgeMs label />) keep working. One chip, one
 * state vocabulary (shared/dataState.ts): a missing asOf renders
 * "unavailable", the server stale flag or an age past maxAgeMs renders
 * "stale", otherwise "ok" with the Schwab age.
 */
import DataStateChip from "./DataStateChip";

export interface DataAgeChipProps {
  /** When Schwab produced the data, epoch ms (seconds are accepted and converted). */
  asOfMs: number | null | undefined;
  /** Server stale flag. */
  stale?: boolean | null;
  /** Max age (ms) the server allows for this data right now; past it the chip reads "stale". */
  maxAgeMs?: number | null;
  /** Short label, e.g. "chain" (shown as the source before the age). */
  label?: string;
  className?: string;
}

export default function DataAgeChip({ asOfMs, stale, maxAgeMs, label = "Schwab", className }: DataAgeChipProps) {
  const has = asOfMs != null && Number.isFinite(asOfMs);
  return (
    <DataStateChip
      state={has ? "ok" : "unavailable"}
      asOf={has ? asOfMs : null}
      stale={stale}
      maxAgeMs={maxAgeMs}
      source={label}
      showAge
      className={className}
      testId="data-age-chip"
    />
  );
}
