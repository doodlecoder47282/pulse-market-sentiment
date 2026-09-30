// SPY projection safety surface. Real observations are separate from prediction availability.
// No synthetic tape, default FLAT verdict, fixed SPX scaling, gamma-snap or unsupported extrapolation.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Activity } from "lucide-react";
import { SpyProjectionResponseSchema } from "@shared/spyProjection";

function observedTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
    timeZone: "America/New_York", timeZoneName: "short",
  });
}
function money(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function MLProjectionPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["/api/ml/projection-spy", "real-features-v1"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/ml/projection-spy");
      const parsed = SpyProjectionResponseSchema.safeParse(await response.json());
      // Old backend payloads (including the formerly labeled synthetic mode) are never drawn.
      if (!parsed.success) throw new Error("unguarded_projection_response");
      return parsed.data;
    },
    retry: false, refetchInterval: false, refetchOnWindowFocus: false, staleTime: 30_000,
  });
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!data) { setExpired(false); return; }
    const check = () => setExpired(Date.now() >= Date.parse(data.expiresAt));
    check();
    const timer = setTimeout(check, Math.max(0, Date.parse(data.expiresAt) - Date.now()) + 25);
    document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", check); };
  }, [data]);
  const showTape = !!data && !error && !expired && !isFetching && data.tape.status === "available";

  return <Card data-testid="panel-ml-projection" className="min-w-0 border-border/60">
    <CardHeader>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex items-center gap-2 text-lg"><Activity className="h-4 w-4 shrink-0" aria-hidden="true" />SPY · Real-data pipeline</CardTitle>
          <p className="text-sm text-muted-foreground">Verified inputs and replayable calculations · Forecast remains disabled</p>
        </div>
        <Button variant="outline" className="min-h-[44px]" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-ml-projection">
          <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />{isFetching ? "Checking…" : "Check data"}
        </Button>
      </div>
    </CardHeader>
    <CardContent className="min-w-0 space-y-4">
      <div role="status" aria-live="polite" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {isLoading ? "CHECKING DATA" : "UNAVAILABLE — forecast withheld"}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {isLoading ? "Checking real SPY source observations. No simulated chart will be generated."
            : error ? "The safe SPY response is unavailable or the backend still uses the legacy contract. No candles, levels or directional verdict have been accepted."
            : "The SPY-only feature pipeline is separate from the legacy models. Data readiness is not predictive validation, and missing forecasts are not FLAT forecasts."}
        </p>
      </div>

      {data && !error && <>
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <div className="min-w-0 rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold">Real tape status · {expired ? "Snapshot expired" : data.tape.status.replace("_", " ")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{expired ? "The input freshness window has expired. Recheck manually before reading any price observation." : data.tape.reason}</p>
            {showTape && <dl className="mt-3 space-y-2 text-sm">
              <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Last observed SPY trade</dt><dd className="font-medium tabular-nums">{money(data.tape.lastTrade!)}</dd></div>
              <div><dt className="text-muted-foreground">Trade timestamp · Schwab</dt><dd>{observedTime(data.tape.lastTradeAt!)}</dd></div>
              <div><dt className="text-muted-foreground">Latest completed bar end</dt><dd>{observedTime(data.tape.observedAt!)}</dd></div>
            </dl>}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Checked {observedTime(data.asOf)} · Expires {observedTime(data.expiresAt)}.<br />
              USD/share. {data.tape.sessionCalendarVerified ? "Provider session hours checked, including declared early close." : "Provider session hours not established."} Halt status remains unverified. No background polling.
            </p>
          </div>
          <div className="min-w-0 rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold">Dealer levels &amp; model</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Levels are withheld until native-SPY source, expiry, units and timestamps are verified. A fixed SPX divisor is not a verified ETF mapping.</p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">No projected close, bull/base/bear path, trade trigger or confidence score is available. Predictive usefulness is not established by training status or band width.</p>
          </div>
        </div>
        <section className="min-w-0 rounded-lg border border-border p-4" data-testid="spy-feature-panel">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Real-data feature contract</h3>
              <p className="mt-1 text-sm text-muted-foreground">One-minute SPY bars only. Same numerical function for live calculation and offline replay.</p>
            </div>
            <span className="rounded-md border border-border px-2 py-1 text-xs font-semibold" data-testid="spy-feature-status">
              {expired ? "EXPIRED" : isFetching ? "CHECKING" : data.features.status} · no approved model
            </span>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Contract <span className="break-all font-mono">{data.features.version}</span><br />
            {data.features.asOf ? `Cutoff ${observedTime(new Date(data.features.asOf).toISOString())}` : "Cutoff unavailable"} · {data.features.completedMinutes} completed minutes<br />
            Prior-session close date: {data.features.priorCloseDate ?? "unverified"} · {data.features.archiveReason}
          </p>
          {data.features.issues.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {data.features.issues.map(x => <li key={x}>{x}</li>)}
          </ul>}
          {!expired && !isFetching && data.features.status !== "BLOCKED" && <details className="mt-3 rounded-md border border-border">
            <summary className="min-h-[44px] cursor-pointer p-3 text-sm font-medium" data-testid="spy-feature-details">Inspect feature values, units &amp; definitions</summary>
            <div className="grid min-w-0 gap-3 border-t border-border p-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.features.values.map(f => <div className="min-w-0 rounded-md bg-muted/30 p-3" key={f.id} data-testid={`spy-feature-${f.id}`}>
                <h4 className="text-sm font-medium">{f.label}</h4>
                <p className="mt-1 break-words font-mono text-sm tabular-nums">{f.value === null ? "Unavailable" : f.value.toLocaleString("en-US", { maximumFractionDigits: 8 })} <span className="font-sans text-xs text-muted-foreground">{f.unit}</span></p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{f.reason ?? f.definition}</p>
              </div>)}
            </div>
          </details>}
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Volatility is not annualized. ATR uses one-minute true ranges; the morning anchor uses a frozen denominator. VWAP is an HLC3 bar-weighted proxy, not trade-level VWAP. Corporate-action adjustments and halt detection remain unverified.</p>
        </section>
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <div><h3 className="text-sm font-semibold">Why it is blocked</h3><ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">
            {data.blockers.map(text => <li key={text}>{text}</li>)}
          </ul></div>
          <div><h3 className="text-sm font-semibold">What is needed to restore it</h3><ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">
            {data.requirements.map(text => <li key={text}>{text}</li>)}
          </ol></div>
        </div>
        {showTape && <details className="rounded-lg border border-border">
          <summary className="min-h-[44px] cursor-pointer px-4 py-3 text-sm font-medium">Inspect recent verified bars — observations, not a projection</summary>
          <div className="grid min-w-0 gap-2 border-t border-border p-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.tape.candles.slice(-6).map(c => <div key={c.t} className="min-w-0 rounded-md bg-muted/30 p-3 text-xs leading-relaxed">
              <p className="font-medium">{observedTime(new Date(c.t * 1000).toISOString())} · bar open</p>
              <p className="mt-1 break-words tabular-nums">O {money(c.o)} · H {money(c.h)}<br />L {money(c.l)} · C {money(c.c)}</p>
              <p className="mt-1 text-muted-foreground">Volume {c.v === null ? "missing" : c.v.toLocaleString("en-US")} {c.v !== null && "shares"}</p>
            </div>)}
          </div>
        </details>}
      </>}
      {error && <p className="text-sm leading-relaxed text-muted-foreground">
        Needed: guarded backend response, real timestamped SPY data, native-SPY level provenance and forward validation on real observations. Do not use the former simulated chart to make decisions.
      </p>}
    </CardContent>
  </Card>;
}
