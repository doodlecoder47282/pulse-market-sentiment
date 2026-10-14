// client/src/components/OdteMapCard.tsx
//
// The 0DTE map on the Trade Desk: gap, straddle range, the strikes that
// matter in $ per 1% or per point, the long-gamma band, ladders, zones
// (personal edition only, decided by the server) and the settle ledger's
// running counts. The text block is the same plan as a paste-able note.
// Composition is shared/odteMap.ts, served by /api/odte/map.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import UnavailablePanel from "@/components/UnavailablePanel";
import { Map as MapIcon, Copy, Check, AlertTriangle } from "lucide-react";
import { renderOdteMapText, fmtMoney, type OdteMap, type MapStrike } from "@shared/odteMap";
import type { SettleTally } from "@shared/odteSettle";

type MapResp = OdteMap & { ledger: { kept: boolean; why: string }; forwardAsOf: string; source: string };
interface LedgerResp {
  symbol: string;
  tally: SettleTally;
  recent: Array<{ dateEt: string; settle: number; lesson: string; pin: number | null; range: [number | null, number | null] | null }>;
  edition: string;
  note: string;
}

const lvl = (n: number | null | undefined) => (n == null ? "n/a" : Math.round(n).toLocaleString("en-US"));
const LABEL_CLS: Record<string, string> = {
  pin: "bg-emerald-500/20 text-emerald-300",
  "wall above": "bg-emerald-500/15 text-emerald-300",
  "magnet below": "bg-emerald-500/15 text-emerald-300",
  shelf: "bg-emerald-500/10 text-emerald-200/80",
  "pocket above": "bg-rose-500/20 text-rose-300",
  "pocket below": "bg-rose-500/20 text-rose-300",
  pocket: "bg-rose-500/10 text-rose-200/80",
};

export default function OdteMapCard({ symbol = "$SPX" }: { symbol?: string }) {
  const [units, setUnits] = useState<"pct" | "pt">("pct");
  const [copied, setCopied] = useState(false);
  const q = useQuery<MapResp>({
    queryKey: ["/api/odte/map", symbol],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/odte/map?symbol=${encodeURIComponent(symbol)}`);
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  const ledger = useQuery<LedgerResp>({
    queryKey: ["/api/odte/map/ledger", symbol],
    queryFn: async () => (await apiRequest("GET", `/api/odte/map/ledger?symbol=${encodeURIComponent(symbol)}`)).json(),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: false,
  });
  const m = q.data;
  const text = useMemo(() => (m ? renderOdteMapText(m, units) : ""), [m, units]);
  const shown = useMemo(() => {
    if (!m) return [] as MapStrike[];
    const keep = new Set<number>(m.strikes.filter((r) => r.label).map((r) => r.strike));
    for (const r of [...m.strikes].sort((a, b) => b.share - a.share)) { if (keep.size >= 14) break; keep.add(r.strike); }
    return m.strikes.filter((r) => keep.has(r.strike));
  }, [m]);
  const maxAbs = useMemo(() => shown.reduce((a, r) => Math.max(a, Math.abs(units === "pct" ? r.gexPct : r.gexPt)), 0), [shown, units]);

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable: the block below is selectable */ }
  }

  return (
    <Card data-testid="odte-map-card">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <MapIcon className="h-4 w-4 text-amber-400" />
            <CardTitle className="text-sm font-semibold tracking-tight">0DTE map</CardTitle>
            {m && <span className="font-mono text-[11px] text-muted-foreground">{m.symbol.replace(/^\$/, "")} · {m.expiry} · spot {lvl(m.spot)} · {m.session.state}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {(["pct", "pt"] as const).map((u) => (
              <button key={u} onClick={() => setUnits(u)} data-testid={`odte-map-units-${u}`}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider ${units === u ? "border-amber-500/40 bg-amber-500/20 text-amber-300" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                title={u === "pct" ? "$ change in dealer delta notional per 1% move" : "$ per 1 index point = per 1% / (S / 100)"}>
                {u === "pct" ? "$ / 1%" : "$ / pt"}
              </button>
            ))}
            <button onClick={copy} disabled={!m} className="ml-1 flex items-center gap-1 rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50" data-testid="odte-map-copy" title="copy the plan as text">
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? "copied" : "copy"}
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading && <p className="text-[11px] text-muted-foreground">composing the map…</p>}
        {q.isError && (
          <UnavailablePanel title="0DTE map" error={q.error} testId="odte-map-unavailable" compact />
        )}
        {m && (
          <>
            {m.dataState !== "ok" && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300" data-testid="odte-map-state">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {m.reason}
              </div>
            )}
            <div className="grid grid-cols-1 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-3">
              <div><span className="text-muted-foreground">gap </span>{m.gap.points != null ? `${m.gap.read} ${m.gap.points >= 0 ? "+" : ""}${m.gap.points.toFixed(1)} (open ${lvl(m.gap.open)} vs ${lvl(m.gap.priorClose)})` : "open or prior close not available"}</div>
              <div><span className="text-muted-foreground">straddle </span>{m.range.straddle != null ? `${m.range.straddle.toFixed(1)} → ${lvl(m.range.low)}–${lvl(m.range.high)}` : "n/a"}{m.range.sigma != null ? <span className="text-muted-foreground"> · 1σ {lvl(m.range.sigmaLow)}–{lvl(m.range.sigmaHigh)}</span> : null}</div>
              <div><span className="text-muted-foreground">gamma at spot </span><span className={m.band.atSpot === "long" ? "text-emerald-300" : m.band.atSpot === "short" ? "text-rose-300" : ""}>{m.band.atSpot}</span>{(m.band.low != null || m.band.high != null) ? ` · band ${m.band.low == null ? "<-5%" : lvl(m.band.low)}–${m.band.high == null ? ">+5%" : lvl(m.band.high)}` : ""}{m.landmarks.flip != null ? ` · flip ${lvl(m.landmarks.flip)}` : ""}</div>
            </div>

            {shown.length > 0 && (
              <div className="space-y-0.5" data-testid="odte-map-strikes">
                {shown.map((r) => {
                  const v = units === "pct" ? r.gexPct : r.gexPt;
                  const w = maxAbs > 0 ? Math.max(2, (Math.abs(v) / maxAbs) * 100) : 0;
                  return (
                    <div key={r.strike} className="grid grid-cols-[56px_1fr_80px_90px] items-center gap-2 font-mono text-[11px]" data-testid={`odte-map-row-${r.strike}`}>
                      <span className={`tabular-nums ${r.side === "at" ? "text-amber-300" : ""}`}>{lvl(r.strike)}</span>
                      <div className="h-2.5 rounded-sm bg-muted/30">
                        <div className={`h-full rounded-sm ${v >= 0 ? "bg-emerald-500/60" : "bg-rose-500/60"}`} style={{ width: `${w}%` }} />
                      </div>
                      <span className={`text-right tabular-nums ${v >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{fmtMoney(v)}</span>
                      <span>{r.label ? <span className={`rounded px-1 py-px text-[11px] ${LABEL_CLS[r.label] ?? ""}`}>{r.label}</span> : null}</span>
                    </div>
                  );
                })}
                <div className="text-[11px] text-muted-foreground">{units === "pct" ? "$ per 1% move" : "$ per index point"}, dealer-signed, OI + ¼ today's volume · {m.strikes.length} strikes within 2% in the data, labelled and largest shown</div>
              </div>
            )}

            {(m.ladders.above.length > 0 || m.ladders.below.length > 0) && (
              <div className="grid grid-cols-1 gap-2 text-[11px] md:grid-cols-2" data-testid="odte-map-ladders">
                {(["above", "below"] as const).map((side) => (
                  <div key={side}><span className="text-muted-foreground">{side}: </span>{m.ladders[side].map((x, i) => {
                    const g = units === "pct" ? x.gexPct : x.gexPt;
                    return <span key={i}><span className="font-mono">{lvl(x.level)}</span> <span className="text-muted-foreground">{x.what}{g != null ? ` ${fmtMoney(g)}` : ""}</span>{i < m.ladders[side].length - 1 ? " → " : ""}</span>;
                  })}</div>
                ))}
              </div>
            )}

            {m.zones && m.zones.length > 0 ? (
              <div className="space-y-1 rounded-md border border-border/40 bg-muted/20 p-2 text-[11px]" data-testid="odte-map-zones">
                {m.zones.map((z) => (
                  <div key={z.kind} className="flex flex-wrap items-baseline gap-x-2">
                    <span className={`font-mono font-semibold uppercase ${z.kind === "dip" ? "text-emerald-300" : z.kind === "fade" ? "text-rose-300" : "text-amber-300"}`}>{z.kind}</span>
                    <span className="font-mono">{lvl(z.low)}–{lvl(z.high)}{z.invalidation != null ? ` · premise fails under ${lvl(z.invalidation)}` : ""}</span>
                    <span className="text-muted-foreground">{z.basis}</span>
                  </div>
                ))}
                <div className="text-muted-foreground">{m.zonesNote}</div>
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground" data-testid="odte-map-zones-note">{m.zonesNote}</div>
            )}

            {ledger.data && (
              <div className="rounded-md border border-border/40 p-2 text-[11px]" data-testid="odte-map-ledger">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold uppercase tracking-wider text-muted-foreground">settle ledger</span>
                  <span>settle inside straddle range <span className="font-mono">{ledger.data.tally.settleInStraddle.yes}/{ledger.data.tally.settleInStraddle.of}</span></span>
                  <span>session inside <span className="font-mono">{ledger.data.tally.sessionInStraddle.yes}/{ledger.data.tally.sessionInStraddle.of}</span></span>
                  <span>band held <span className="font-mono">{ledger.data.tally.bandHeld.yes}/{ledger.data.tally.bandHeld.of}</span></span>
                  <span>median |settle − pin| <span className="font-mono">{ledger.data.tally.medianAbsPinDistance != null ? `${ledger.data.tally.medianAbsPinDistance.toFixed(0)} pts` : "n/a"}</span></span>
                  {ledger.data.tally.dipTouchedAndHeld.of > 0 && <span>dip zone touched and held <span className="font-mono">{ledger.data.tally.dipTouchedAndHeld.yes}/{ledger.data.tally.dipTouchedAndHeld.of}</span></span>}
                </div>
                <div className="mt-1 text-muted-foreground">{ledger.data.tally.note}. {ledger.data.note}.</div>
                {ledger.data.recent.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {ledger.data.recent.slice(0, 5).map((r) => <li key={r.dateEt} className="text-muted-foreground"><span className="font-mono text-foreground">{r.dateEt}</span> · {r.lesson}</li>)}
                  </ul>
                )}
              </div>
            )}

            <details className="text-[11px]">
              <summary className="cursor-pointer text-muted-foreground">plan as text</summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre rounded-md bg-muted/30 p-2 font-mono text-[11px] leading-snug" data-testid="odte-map-text">{text}</pre>
            </details>
            <details className="text-[11px]">
              <summary className="cursor-pointer text-muted-foreground">method</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">{m.method.map((x, i) => <li key={i}>{x}</li>)}</ul>
              <div className="mt-1 text-muted-foreground">ledger: {m.ledger.why} · source {m.source}</div>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}
