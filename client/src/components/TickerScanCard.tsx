/**
 * TickerScanCard.tsx: scan any ticker (server/tickerScan.ts).
 *
 * Type a symbol; get five reads, each with its own state: the instrument,
 * the quote, volume against its 20-session average (paced to the session,
 * with the quiet-volume and block-print reads named by what they measure),
 * per-name dealer gamma, and the chain's most active contracts. The last
 * symbol is remembered per viewer. Descriptive only.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import DataStateChip from "@/components/DataStateChip";
import { Search } from "lucide-react";

interface Section { dataState: string; reason: string | null }
interface Scan {
  symbol: string; asOf: number; edition: string; session: "open" | "closed";
  instrument: Section & { description: string | null; assetType: string | null; exchange: string | null; found: boolean | null };
  quote: Section & { last: number | null; changePct: number | null; bid: number | null; ask: number | null; spreadPct: number | null; volume: number | null; feed: string | null; ageMs: number | null };
  volume: Section & {
    relative: { todayVolume: number | null; avg20: number | null; rel: number | null; relPaced: number | null; sessionFraction: number | null; sessions: number; dataState: string; reason: string | null };
    quiet: { flag: boolean | null; note: string };
    blocks: { available: boolean; prints: number; shareOfVolume: number | null; threshold: number | null; largest: { size: number; price: number | null; t: number } | null; note: string };
  };
  structure: Section & { spot: number | null; callWall: number | null; putWall: number | null; gammaFlip: number | null; maxPain: number | null; regime: string; distToCallWallPct: number | null; distToPutWallPct: number | null; pcrOi: number | null; pcrVol: number | null; atmIv: number | null; ivSkew25d: number | null; warnings: string[] };
  chain: Section & { contracts: Array<{ occ: string; type: "C" | "P"; strike: number; expiration: string; dte: number; volume: number; openInterest: number; volOiRatio: number; isNewStrike: boolean; mid: number; notional: number; tag: string; delta: number }>; asOf: number | null; stale: boolean };
  note: string;
}

const KEY = "batcave.scan.symbol";
const px = (n: number | null | undefined, d = 2) => (n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: d }));
const pct = (f: number | null | undefined, d = 2) => (f == null ? "—" : `${f > 0 ? "+" : ""}${(f * 100).toFixed(d)}%`);
const big = (n: number | null | undefined) => (n == null ? "—" : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const x = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(1)}x`);

function Stat({ label, value, title, cls, sub }: { label: string; value: string; title?: string; cls?: string; sub?: string }) {
  return (
    <div className="rounded border border-border/40 bg-muted/10 px-2 py-1.5" title={title}>
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`break-words font-mono text-sm font-semibold tabular-nums ${cls ?? ""}`}>{value}</div>
      {sub && <div className="font-mono text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function SectionHead({ label, s, testId }: { label: string; s: Section; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <DataStateChip state={s.dataState} reason={s.reason} testId={testId} />
    </div>
  );
}

export default function TickerScanCard() {
  const [draft, setDraft] = useState("");
  const [symbol, setSymbol] = useState<string>(() => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } });
  useEffect(() => { try { if (symbol) localStorage.setItem(KEY, symbol); } catch { /* per-viewer convenience */ } }, [symbol]);

  const q = useQuery<Scan>({
    queryKey: ["/api/scan", symbol],
    queryFn: async () => (await apiRequest("GET", `/api/scan?symbol=${encodeURIComponent(symbol)}`)).json(),
    enabled: !!symbol,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  const d = q.data;
  const submit = () => { const s = draft.trim().toUpperCase().replace(/^\$/, ""); if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) { setSymbol(s); setDraft(""); } };

  return (
    <Card data-testid="ticker-scan-card">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-amber-400" />
            <CardTitle className="text-sm font-semibold tracking-tight">Scan any ticker</CardTitle>
            {d && <span className="font-mono text-[11px] text-muted-foreground">{d.symbol}{d.instrument.description ? ` · ${d.instrument.description}` : ""} · session {d.session}</span>}
          </div>
          <form className="flex w-full items-center gap-2 sm:w-auto" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={symbol || "NVDA"} aria-label="symbol to scan" autoCapitalize="characters"
              className="min-h-[44px] w-full min-w-0 flex-1 rounded-md border border-border/60 bg-background px-3 font-mono text-sm uppercase sm:min-h-[36px] sm:w-28 sm:flex-none" data-testid="ticker-scan-input" />
            <button type="submit" className="min-h-[44px] rounded-md border border-amber-500/40 bg-amber-500/10 px-4 text-xs font-semibold text-amber-300 sm:min-h-[36px] sm:px-3" data-testid="ticker-scan-go">scan</button>
          </form>
        </div>
      </CardHeader>
      <CardContent className="min-h-[120px] space-y-4">
        {!symbol && <p className="text-[11px] text-muted-foreground" data-testid="ticker-scan-empty">Type a symbol Schwab serves. Five reads come back, each with its own state: instrument, quote, volume against its 20-session pace, per-name dealer gamma, and the chain's most active contracts.</p>}
        {symbol && q.isLoading && <p className="text-[11px] text-muted-foreground">scanning {symbol}…</p>}
        {symbol && q.isError && <p className="text-[11px] text-rose-300" data-testid="ticker-scan-error">scan unavailable: {String((q.error as any)?.message ?? "error").slice(0, 120)}</p>}
        {d && (
          <>
            {d.instrument.found === false && <p className="text-[11px] text-amber-300" data-testid="ticker-scan-notfound">Schwab lists no instrument called {d.symbol}; the reads below are for whatever the quote service returned, if anything.</p>}

            <div className="space-y-1.5" data-testid="ticker-scan-quote">
              <SectionHead label="quote" s={d.quote} testId="ticker-scan-quote-state" />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="last" value={px(d.quote.last)} cls={d.quote.changePct == null ? "" : d.quote.changePct >= 0 ? "text-emerald-300" : "text-rose-300"} />
                <Stat label="change" value={pct(d.quote.changePct)} />
                <Stat label="bid / ask" value={`${px(d.quote.bid)} / ${px(d.quote.ask)}`} />
                <Stat label="spread" value={pct(d.quote.spreadPct, 3)} title="round-trip cost model for the underlying" />
                <Stat label="volume" value={big(d.quote.volume)} />
                <Stat label="feed" value={`${d.quote.feed ?? "—"}${d.quote.ageMs != null ? ` · ${Math.round(d.quote.ageMs / 1000)}s` : ""}`} />
              </div>
            </div>

            <div className="space-y-1.5" data-testid="ticker-scan-volume">
              <SectionHead label="volume read" s={d.volume} testId="ticker-scan-volume-state" />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="20d avg" value={big(d.volume.relative.avg20)} title={`${d.volume.relative.sessions} sessions`} />
                <Stat label="rel. volume" value={x(d.volume.relative.rel)} title="today / 20-session average, raw" />
                <Stat label="paced" value={x(d.volume.relative.relPaced)} title="today / (average x share of the session elapsed)" cls={d.volume.relative.relPaced != null && d.volume.relative.relPaced >= 1.8 ? "text-amber-300" : ""} />
                <Stat label="quiet volume" value={d.volume.quiet.flag == null ? "—" : d.volume.quiet.flag ? "yes" : "no"} title={d.volume.quiet.note} cls={d.volume.quiet.flag ? "text-amber-300" : ""} />
                <Stat label="block prints" value={d.volume.blocks.available ? String(d.volume.blocks.prints) : "n/a"} title={d.volume.blocks.note} />
                <Stat label="block share" value={d.volume.blocks.shareOfVolume == null ? "—" : `${(d.volume.blocks.shareOfVolume * 100).toFixed(1)}%`} title={d.volume.blocks.note} />
              </div>
              <p className="text-[11px] text-muted-foreground">{d.volume.quiet.note} {d.volume.blocks.available ? d.volume.blocks.note : d.volume.blocks.note}</p>
            </div>

            <div className="space-y-1.5" data-testid="ticker-scan-structure">
              <SectionHead label="dealer gamma (45 DTE chain)" s={d.structure} testId="ticker-scan-structure-state" />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="call wall" value={px(d.structure.callWall)} sub={d.structure.distToCallWallPct != null ? `${d.structure.distToCallWallPct.toFixed(2)}% from spot` : undefined} cls="text-rose-300" />
                <Stat label="gamma flip" value={px(d.structure.gammaFlip)} cls="text-amber-200" />
                <Stat label="put wall" value={px(d.structure.putWall)} sub={d.structure.distToPutWallPct != null ? `${d.structure.distToPutWallPct.toFixed(2)}% from spot` : undefined} cls="text-emerald-300" />
                <Stat label="regime" value={d.structure.regime === "positive" ? "long γ" : d.structure.regime === "negative" ? "short γ" : "unknown"} title="positive = dealer hedging dampens moves; negative = dealer hedging adds to moves" />
                <Stat label="P/C OI · vol" value={`${px(d.structure.pcrOi)} · ${px(d.structure.pcrVol)}`} />
                <Stat label="ATM IV · skew" value={`${d.structure.atmIv == null ? "—" : (d.structure.atmIv * 100).toFixed(0) + "%"} · ${d.structure.ivSkew25d == null ? "—" : (d.structure.ivSkew25d * 100).toFixed(1) + "pp"}`} title="nearest-strike IV (4 samples, 0-45 DTE); 8% OTM put IV minus 8% OTM call IV, all expiries" />
              </div>
              <p className="text-[11px] text-muted-foreground/80" data-testid="ticker-scan-structure-note">ATM IV = nearest-strike IV (4 samples, 0-45 DTE). Skew = 8% OTM put IV minus 8% OTM call IV, all expiries, in pp (percentage points).</p>
              {d.structure.warnings.length > 0 && <p className="text-[11px] text-amber-300/90">{d.structure.warnings.join("; ")}</p>}
            </div>

            <div className="space-y-1.5" data-testid="ticker-scan-chain">
              <SectionHead label="most active contracts (volume / OI, 45 DTE)" s={d.chain} testId="ticker-scan-chain-state" />
              {d.chain.contracts.length > 0 && (
                <div className="hscroll-contain">
                  <div className="sticky left-0 pb-1 text-[11px] text-muted-foreground sm:hidden" data-testid="ticker-scan-swipe-hint">swipe sideways for more columns</div>
                  <table className="w-full min-w-[560px] text-[11px]">
                    <thead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr><th className="text-left">contract</th><th className="text-right">vol</th><th className="text-right">OI</th><th className="text-right">vol/OI</th><th className="text-right">mid</th><th className="text-right">premium</th><th className="text-right">Δ</th><th className="text-right">tag</th></tr>
                    </thead>
                    <tbody className="font-mono tabular-nums">
                      {d.chain.contracts.slice(0, 12).map((c) => (
                        <tr key={c.occ} className="border-t border-border/30">
                          <td className="py-0.5">{d.symbol} {px(c.strike, 2)}{c.type} {c.expiration} <span className="text-muted-foreground">{c.dte}d</span></td>
                          <td className="text-right">{big(c.volume)}</td>
                          <td className="text-right">{big(c.openInterest)}</td>
                          <td className="text-right">{c.isNewStrike ? "new" : c.volOiRatio.toFixed(1)}</td>
                          <td className="text-right">{px(c.mid)}</td>
                          <td className="text-right">${big(c.notional)}</td>
                          <td className="text-right">{c.delta.toFixed(2)}</td>
                          <td className="text-right text-muted-foreground">{c.tag.toLowerCase().replace("_", " ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="text-[11px] text-muted-foreground/80">{d.note}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
