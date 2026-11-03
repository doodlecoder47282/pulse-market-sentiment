import type { RefObject } from "react";
import type { TradeBrief } from "@shared/tradeBrief";
import { summarizeTradeBrief } from "@shared/tradeBriefPresentation";

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const when = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date(s).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
export function TradeBriefSummary({ brief, expired, resultRef }: {
  brief: TradeBrief; expired: boolean; resultRef: RefObject<HTMLHeadingElement>;
}) {
  const s = summarizeTradeBrief(brief, expired);
  return <div data-testid="trade-brief-summary" className="brief-summary">
    <div className="brief-summary-heading">
      <div>
        <p className="brief-eyebrow">{brief.horizon === "swing" ? "Swing" : "Intraday"} research</p>
        <h3 ref={resultRef} tabIndex={-1} className="text-lg font-semibold focus-visible:ring-2 focus-visible:ring-primary">{brief.instrument.symbol}
          <span className="ml-2 text-sm font-normal text-muted-foreground">{brief.instrument.name}</span>
        </h3>
      </div>
      <span data-testid="trade-brief-verdict" className="brief-state">{brief.verdict === "WATCH" ? "WATCH ONLY" : "WAIT · DATA GAP"}</span>
    </div>
    <div className="brief-price-row">
      <div>
        <p className="brief-eyebrow">{s.live ? "Verified last trade" : "Last observed trade · not live"}</p>
        <p data-testid="trade-brief-price" className="brief-price">{s.price ? money(s.price.value) : "Not available"}</p>
        <p data-testid="trade-brief-price-time" className="text-xs text-muted-foreground">{s.price
          ? `${s.price.source} · ${when(s.price.observed_at)}` : "No valid, timestamped observation returned."}</p>
      </div>
      <div className="brief-session-note"><span>{s.title}</span><p>{s.takeaway}</p></div>
    </div>
    {s.close && <div data-testid="trade-brief-session-context" className="brief-session-context">
      <p className="brief-eyebrow">Completed-session context · {s.close.observed_at} · Schwab history</p>
      <dl className="brief-history-grid">
        <div><dt>Close</dt><dd>{money(s.close.value)}</dd></div>
        <div><dt>Session range</dt><dd>{s.low && s.high ? `${money(s.low.value)} – ${money(s.high.value)}` : "Not available"}</dd></div>
        <div><dt>Volume</dt><dd>{s.volume ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(s.volume.value) : "Not available"}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">Historical observations, not entry levels. Corporate-action adjustment is unverified.</p>
    </div>}
    {!expired && brief.levels.length > 0 && <div className="brief-history-grid" data-testid="trade-brief-reference-levels">
      {brief.levels.map(l => <div key={l.kind}><p className="brief-eyebrow">{l.label}</p><p className="text-base font-semibold">{money(l.value)}</p></div>)}
      <p className="col-span-full text-xs text-muted-foreground">{brief.levels[0].period}. References only, not orders.</p>
    </div>}
    {s.findings.length > 0 && <div className="brief-key-findings" data-testid="trade-brief-key-findings">
      <h4 className="text-sm font-semibold">What matters</h4>
      {s.findings.map(item => <div key={item.id} className="brief-finding">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="brief-eyebrow">{item.category === "earnings" ? "Reported earnings" : item.category}</span>
          <a href={item.url} target="_blank" rel="noopener noreferrer" data-testid={`brief-finding-${item.id}`}
            className="inline-flex min-h-[44px] items-center text-xs underline underline-offset-2">{item.source}</a>
        </div>
        <p>{item.text.split(/(?<=[.!?])\s+/)[0]}</p>
        <span className="text-xs text-muted-foreground">{when(item.observed_at)} · {item.category === "earnings"
          ? "Calendar-reported; issuer date and timing unverified."
          : item.category === "macro" ? "Dated macro context, not ticker direction."
          : item.id === "factor-atr" ? "Historical volatility, not a forecast or stop."
          : "Snapshot context; inspect sources before acting."}</span>
      </div>)}
    </div>}
    <div className="brief-next-action" data-testid="trade-brief-next">
      <h4 className="text-sm font-semibold">Next step</h4>
      <p>{s.next}</p>
      <p className="text-xs text-muted-foreground">Entry, stop, target and sizing are not approved. Research summary; no automatic AI call.</p>
    </div>
    <div className="brief-coverage-strip" data-testid="brief-coverage-strip">
      {brief.source_statuses.filter(x => ["quote", "news", "options", "earnings"].includes(x.category)).map(x =>
        <span key={x.category}><span className="capitalize">{x.category}</span>: {x.status === "available" ? "current"
          : x.status === "partial" ? "partial" : x.status === "not_applicable" ? "not applicable" : "not verified"}</span>)}
    </div>
  </div>;
}
