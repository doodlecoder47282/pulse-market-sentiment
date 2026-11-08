// client/src/components/AsOfNote.tsx
//
// One small "read HH:MM · N min ago" note for panels whose payload carries an
// asOf the card never showed. Helpers in client/src/lib/asOf.ts (tested).
import { asOfText } from "@/lib/asOf";

export default function AsOfNote({ asOf, className = "" }: { asOf: number | string | null | undefined; className?: string }) {
  return (
    <span className={`font-mono text-[11px] text-muted-foreground ${className}`} data-testid="as-of-note" title="when the server produced this payload">
      {asOfText(asOf)}
    </span>
  );
}
