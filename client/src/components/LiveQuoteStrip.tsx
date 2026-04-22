// LiveQuoteStrip.tsx — polls /api/quotes every 5 seconds for SPY + VIX live quotes.
// Shows: SPY last price, SPY change %, VIX last. Rendered in the header area.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { FlashNumber } from "./FlashNumber";
import { Skeleton } from "@/components/ui/skeleton";

type QuotesResponse = {
  spy: { price: number | null; changePct: number | null };
  vix: { price: number | null; changePct: number | null };
  timestamp: number;
};

function fmt2(v: number | null, decimals = 2): string {
  if (v == null) return "—";
  return v.toFixed(decimals);
}

function fmtPct(v: number | null): string {
  if (v == null) return "";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export default function LiveQuoteStrip() {
  const { data, isLoading } = useQuery<QuotesResponse>({
    queryKey: ["/api/quotes"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/quotes");
      return r.json();
    },
    refetchInterval: 5_000,
    staleTime: 4_000,
    refetchOnWindowFocus: true,
  });

  if (isLoading) {
    return (
      <div className="hidden items-center gap-4 sm:flex">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-20" />
      </div>
    );
  }

  if (!data) return null;

  const spyUp = (data.spy.changePct ?? 0) >= 0;
  const vixUp = (data.vix.changePct ?? 0) >= 0;
  const spyChangeClass = spyUp ? "text-emerald-400" : "text-red-400";
  const vixChangeClass = vixUp ? "text-red-400" : "text-emerald-400"; // VIX up = bearish

  return (
    <div className="hidden items-center gap-3 sm:flex" data-testid="live-quote-strip">
      {/* SPY */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">SPY</span>
        <FlashNumber
          value={data.spy.price}
          format={(v) => `$${fmt2(v)}`}
          className="font-mono text-sm font-semibold"
          neutralClassName="text-foreground"
        />
        {data.spy.changePct != null && (
          <span className={`font-mono text-[11px] tabular-nums ${spyChangeClass}`}>
            {fmtPct(data.spy.changePct)}
          </span>
        )}
      </div>

      <span className="text-border">|</span>

      {/* VIX */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">VIX</span>
        <FlashNumber
          value={data.vix.price}
          format={(v) => fmt2(v)}
          className="font-mono text-sm font-semibold"
          neutralClassName={vixUp ? "text-red-400" : "text-emerald-400"}
        />
        {data.vix.changePct != null && (
          <span className={`font-mono text-[11px] tabular-nums ${vixChangeClass}`}>
            {fmtPct(data.vix.changePct)}
          </span>
        )}
      </div>
    </div>
  );
}
