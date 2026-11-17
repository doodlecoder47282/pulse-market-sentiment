// GammaBasisStamp: the two facts every dealer-gamma figure rests on, shown
// the same way on every tab (shared/gammaBasis.ts):
//   - which session's end-of-day open interest the figures use
//   - what gamma is multiplied by on this tab (the tabs differ on purpose)
// Descriptive only; not interactive (the explanation is the title tooltip).
import { OI_BASIS_TOOLTIP, oiStampText, type GammaWeighting, type OiBasis } from "@shared/gammaBasis";

export default function GammaBasisStamp({
  oiBasis, weighting, testId, className = "",
}: {
  oiBasis: OiBasis | null | undefined;
  weighting?: GammaWeighting | null;
  testId: string;
  className?: string;
}) {
  const known = !!oiBasis?.sessionDate;
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-snug text-muted-foreground ${className}`} data-testid={testId}>
      <span
        className={`rounded border px-1.5 py-0.5 font-mono ${known ? "border-border/60" : "border-amber-500/40 text-amber-300"}`}
        title={oiBasis?.note || OI_BASIS_TOOLTIP}
        data-testid={`${testId}-oi`}
      >
        {oiStampText(oiBasis)}
      </span>
      {weighting?.label ? (
        <span className="min-w-0 break-words" data-testid={`${testId}-weighting`} title="The tabs weight gamma differently, so the same strike can read differently from one tab to another.">
          {weighting.label}
        </span>
      ) : null}
    </div>
  );
}
