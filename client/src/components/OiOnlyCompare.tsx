// Before-and-after for one gamma weighting (master list X15). The served levels count open interest plus a
// quarter of today's volume; this line shows the same three levels on open interest alone, the standard
// notional-gamma measure, so the size of the change is visible before the served levels switch to it.

export interface OiOnlyLevels { ceiling: number | null; floor: number | null; turningPoint: number | null; atSpot?: string | null }

const n = (v: number | null | undefined) => (v == null ? "none" : Math.round(v).toLocaleString("en-US"));

export function OiOnlyCompare({ oiOnly, testId }: { oiOnly: OiOnlyLevels | null | undefined; testId: string }) {
  if (!oiOnly) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid={testId}>
      Counting open interest alone (no part of today's volume added): ceiling {n(oiOnly.ceiling)} · turning point {n(oiOnly.turningPoint)} · floor {n(oiOnly.floor)}.
      The levels above also count a quarter of today's volume; they are moving to open interest alone.
    </p>
  );
}
