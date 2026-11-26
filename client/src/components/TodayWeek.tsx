// "This week" on the Signals top card: the same three levels and steps as today's, read for the last expiry
// of the week (/api/odte/map?expiry=week, same rules as the nearest-expiry map).
import { OiOnlyCompare } from "@/components/OiOnlyCompare";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { OdteMap } from "@shared/odteMap";
import { todayPlan, expiryDayLabel } from "@shared/todayPlan";

type WeekResp = OdteMap & { expiryPick?: string; weekEnd?: string | null; sameAsNearest?: boolean };
const lvl = (n: number | null | undefined) => (n == null ? "none" : Math.round(n).toLocaleString("en-US"));

export default function TodayWeek({ symbol, active }: { symbol: string; active: boolean }) {
  const q = useQuery<WeekResp>({
    queryKey: ["/api/odte/map", symbol, "week"],
    queryFn: async () => (await apiRequest("GET", `/api/odte/map?symbol=${encodeURIComponent(symbol)}&expiry=week`)).json(),
    enabled: active,
    refetchInterval: active ? 5 * 60_000 : false,
    staleTime: 2 * 60_000,
    retry: false,
  });
  const m = q.data;
  const title = <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">This week</div>;
  if (q.isLoading) return <div data-testid="today-week">{title}<div className="text-sm text-muted-foreground">Reading the week's last expiry…</div></div>;
  if (q.isError || !m || typeof m.spot !== "number") return <div data-testid="today-week">{title}<div className="text-sm text-muted-foreground">Not read: the week's option data did not come back.</div></div>;
  const day = expiryDayLabel(m.expiry);
  if (m.sameAsNearest) {
    return (
      <div data-testid="today-week">
        {title}
        <div className="text-sm text-muted-foreground">The week's last expiry is {day}, the same one the levels above are read for.</div>
      </div>
    );
  }
  const spot = m.spot;
  const above = m.landmarks.wallAbove ?? (m.landmarks.pin != null && m.landmarks.pin > spot ? m.landmarks.pin : null);
  const below = m.landmarks.magnetBelow ?? (m.landmarks.pin != null && m.landmarks.pin < spot ? m.landmarks.pin : null);
  const plan = todayPlan({
    symbol, spot, sessionState: m.session.state, dataState: m.dataState, atSpot: m.band.atSpot,
    straddle: m.range.straddle, low: m.range.low, high: m.range.high, above, below, flip: m.landmarks.flip,
    weekExpiryLabel: day,
  });
  return (
    <div data-testid="today-week" className="space-y-1.5">
      {title}
      <div className="text-sm leading-snug">{plan.headline}</div>
      {m.dataState !== "no_gex" && (
        <>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm" data-testid="today-week-levels">
            <span><span className="text-muted-foreground">{plan.labels.above}</span> <span className="font-mono font-semibold text-rose-300">{lvl(above)}</span></span>
            <span><span className="text-muted-foreground">{plan.labels.flip}</span> <span className="font-mono font-semibold text-amber-200">{lvl(m.landmarks.flip)}</span></span>
            <span><span className="text-muted-foreground">{plan.labels.below}</span> <span className="font-mono font-semibold text-emerald-300">{lvl(below)}</span></span>
          </div>
          <OiOnlyCompare oiOnly={(m as any).oiOnly} testId="today-week-oi-only" />
          <ol className="list-decimal space-y-1 pl-5 text-sm leading-snug">
            {plan.path.map((line, i) => <li key={i}>{line}</li>)}
          </ol>
          <div className="text-xs text-muted-foreground">Read for the options that expire {day}, with the same rules as the levels above. Options that expire sooner are not counted here.</div>
        </>
      )}
    </div>
  );
}
