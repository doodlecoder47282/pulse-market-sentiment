// GammaBasisStamp: the two facts every dealer-gamma figure rests on, shown
// the same way on every tab (shared/gammaBasis.ts):
//   - which session's end-of-day open interest the figures use
//   - what gamma is multiplied by on this tab (the tabs differ on purpose)
// Descriptive only and not interactive. The explanations are visible text
// (phones have no hover); the title repeats them for the desktop.
import { OI_BASIS_SHORT, OI_BASIS_TOOLTIP, WEIGHTING_DIFFERS_TEXT, oiStampText, type GammaWeighting, type OiBasis } from "@shared/gammaBasis";

/** The short visible reason beside the chip. */
function oiReason(oiBasis: OiBasis | null | undefined): string {
  if (!oiBasis) return "this response does not state it";
  if (oiBasis.postingPending) return OI_BASIS_SHORT; // the chip already says the posting may be pending
  const extra = (oiBasis.note ?? "").replace(OI_BASIS_TOOLTIP, "").trim();
  return extra || OI_BASIS_SHORT;
}

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
        className={`min-w-0 break-words rounded border px-1.5 py-0.5 font-mono ${known && !oiBasis?.postingPending ? "border-border/60" : "border-amber-500/40 text-amber-300"}`}
        title={oiBasis?.note || OI_BASIS_TOOLTIP}
        data-testid={`${testId}-oi`}
      >
        {oiStampText(oiBasis)}
      </span>
      <span className="min-w-0 break-words" data-testid={`${testId}-oi-reason`}>{oiReason(oiBasis)}</span>
      {weighting?.label ? (
        <span className="min-w-0 break-words" data-testid={`${testId}-weighting`}>
          {weighting.label} ({WEIGHTING_DIFFERS_TEXT})
        </span>
      ) : null}
      {weighting?.detail ? (
        <span className="min-w-0 basis-full break-words" data-testid={`${testId}-weighting-rule`}>{weighting.detail}</span>
      ) : null}
    </div>
  );
}
