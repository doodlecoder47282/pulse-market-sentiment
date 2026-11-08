// client/src/components/AsOfNote.tsx
//
// One small "read HH:MM · N min ago" note for panels whose payload carries an
// asOf the card never showed. Helpers in client/src/lib/asOf.ts (tested).
import { asOfText } from "@/lib/asOf";

export default function AsOfNote({ asOf, label, className = "" }: { asOf: number | string | null | undefined; /** what the time is of, e.g. "chain" (default: the payload) */ label?: string; className?: string }) {
  return (
    <span className={`whitespace-nowrap font-mono text-[11px] text-muted-foreground ${className}`} data-testid="as-of-note" title={label ? `when Schwab produced the ${label}` : "when the server produced this payload"}>
      {label ? `${label} ` : ""}{asOfText(asOf)}
    </span>
  );
}
