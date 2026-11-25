// client/src/components/DeskBoard.tsx
//
// The level board at the top of the Trade Desk (server/deskBoard.ts, shared/levelBoard.ts): the bull and bear
// case for the index, then SPX, SPY, QQQ, VIX and the index futures with the nearest level on each side.
// Every ticker shows its own state; a ticker Schwab did not answer for says so. Descriptive: no odds.
import { plainLevelName } from "@shared/plainLevelName";
import { etTimeLabel } from "@shared/etTime";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import UnavailablePanel from "@/components/UnavailablePanel";
import PlainRead from "@/components/PlainRead";
import { Layers } from "lucide-react";
import { boardAnswer, type BoardLevel, type DeskCase, type RelRead, type VixRead } from "@shared/levelBoard";

interface Ticker {
  symbol: string; label: string; kind: string; price: number | null; changePct: number | null; changeBasis?: "session" | "last_session" | "since_close" | "unknown";
  quoteState: "ok" | "stale" | "age_unknown" | "unavailable"; quoteReason: string | null;
  levels: BoardLevel[]; levelsState: "ok" | "partial" | "unavailable"; levelsReason: string | null; priorSession: string | null;
  at: BoardLevel[]; above: BoardLevel | null; below: BoardLevel | null;
}
interface Board {
  asOf: number; forSession: string; sessionOpen: boolean; tickers: Ticker[]; tech: RelRead; vix: VixRead;
  cases: { symbol: string; price: number | null; bull: DeskCase; bear: DeskCase; optionsState: "ok" | "stale" | "unavailable"; optionsReason: string | null; optionsAsOfMs: number | null };
  note: string;
}

const px = (n: number | null | undefined) => (n == null ? "n/a" : n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2));
const pct = (n: number | null | undefined) => (n == null ? "" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
const clock = (ms: number | null | undefined) => (ms == null ? null : etTimeLabel(ms));
const dist = (lv: BoardLevel | null, price: number | null) => (lv && price ? `${lv.price > price ? "+" : "-"}${px(Math.abs(lv.price - price))}` : "");

function CaseBox({ c, tone }: { c: DeskCase; tone: "bull" | "bear" }) {
  const cls = tone === "bull" ? "border-emerald-500/30 bg-emerald-500/5" : "border-rose-500/30 bg-rose-500/5";
  return (
    <div className={`rounded-md border p-3 text-[13px] leading-snug ${cls}`} data-testid={`desk-case-${tone}`}>
      <p className="break-words text-foreground">{plainLevelName(c.text)}</p>
    </div>
  );
}

export default function DeskBoard() {
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery<Board>({
    queryKey: ["/api/desk/board"],
    queryFn: async () => (await apiRequest("GET", "/api/desk/board")).json(),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });
  if (q.isLoading) return <Card data-testid="desk-board"><CardContent className="p-4 text-sm text-muted-foreground">Reading the level board…</CardContent></Card>;
  if (q.isError || !q.data) return <UnavailablePanel title="Level board" error={q.error} testId="desk-board-unavailable" />;
  const b = q.data;
  const spx = b.tickers.find((t) => t.symbol === b.cases.symbol);
  // The tech and VIX sentences say themselves what their change is a change of; this only marks the session as closed.
  const prefix = b.sessionOpen ? "" : "Market closed. ";
  return (
    <Card className="border-cyan-500/20" data-testid="desk-board">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <Layers className="h-4 w-4 text-cyan-400" />
          Level board
          <span className="text-[11px] font-normal text-muted-foreground" data-testid="desk-board-session">levels for {b.forSession}{b.sessionOpen ? "" : " · market closed, last prices"} · read {clock(b.asOf)}{b.cases.optionsAsOfMs != null ? ` · option chain ${clock(b.cases.optionsAsOfMs)}` : ""}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {spx && <PlainRead testId="desk-board-plain" read={{ answer: boardAnswer(spx.label, spx.price, spx), detail: `${prefix}${plainLevelName(b.tech.text)} ${plainLevelName(b.vix.text)} ${plainLevelName(b.note)}` }} />}
        <div className="grid gap-2 md:grid-cols-2">
          <CaseBox c={b.cases.bull} tone="bull" />
          <CaseBox c={b.cases.bear} tone="bear" />
        </div>
        {b.cases.optionsState !== "ok" && (
          <p className="break-words text-[11px] text-muted-foreground" data-testid="desk-board-options-state">
            {b.cases.optionsState === "unavailable"
              ? `Option landmarks not read${b.cases.optionsReason ? ` (${b.cases.optionsReason})` : ""}. The cases use chart levels only.`
              : `Option landmarks are from the last chain read${b.cases.optionsReason ? ` (${b.cases.optionsReason})` : ""} and are included.`}
          </p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          <span data-testid="desk-board-tech">{prefix}{plainLevelName(b.tech.text)}</span>
          <span data-testid="desk-board-vix">{prefix}{plainLevelName(b.vix.text)}</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {b.tickers.map((t) => (
            <div key={t.symbol} className="rounded-md border border-border/60 p-2.5" data-testid={`desk-board-ticker-${plainLevelName(t.label)}`}>
              <button type="button" className="flex min-h-[44px] w-full items-start justify-between gap-2 text-left lg:min-h-0" aria-expanded={open === t.symbol}
                onClick={() => setOpen(open === t.symbol ? null : t.symbol)}>
                <span className="min-w-0">
                  <span className="font-mono text-sm font-semibold text-foreground">{plainLevelName(t.label)}</span>{" "}
                  <span className="font-mono text-sm">{px(t.price)}</span>{" "}
                  <span className={`font-mono text-[12px] ${t.changePct == null ? "" : t.changePct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{pct(t.changePct)}</span>
                  {t.changePct != null && t.changeBasis && t.changeBasis !== "session" && (
                    <span className="ml-1 text-[11px] text-muted-foreground">{t.changeBasis === "last_session" ? "last session" : t.changeBasis === "since_close" ? "since the last close" : "day basis unclear"}</span>
                  )}
                  {t.quoteState !== "ok" && <span className="ml-1 text-[11px] text-amber-400">{t.quoteState === "age_unknown" ? "age unknown" : t.quoteState}</span>}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{open === t.symbol ? "less" : "all levels"}</span>
              </button>
              {t.quoteState === "unavailable" ? (
                <p className="mt-1 break-words text-[11px] text-muted-foreground">{t.quoteReason}{t.levelsReason ? ` · ${t.levelsReason}` : ""}</p>
              ) : t.levelsState === "unavailable" ? (
                <p className="mt-1 break-words text-[11px] text-muted-foreground">No levels: {t.levelsReason}</p>
              ) : (
                <div className="mt-1 space-y-0.5 font-mono text-[12px]">
                  {t.at.map((l) => <div key={l.key} className="text-amber-300">at {px(l.price)} <span className="font-sans text-muted-foreground">{plainLevelName(l.label)}</span></div>)}
                  <div><span className="text-muted-foreground">above</span> {t.above ? <>{px(t.above.price)} <span className="text-muted-foreground">{dist(t.above, t.price)}</span> <span className="font-sans text-muted-foreground">{plainLevelName(t.above.label)}</span></> : <span className="font-sans text-muted-foreground">none mapped</span>}</div>
                  <div><span className="text-muted-foreground">below</span> {t.below ? <>{px(t.below.price)} <span className="text-muted-foreground">{dist(t.below, t.price)}</span> <span className="font-sans text-muted-foreground">{plainLevelName(t.below.label)}</span></> : <span className="font-sans text-muted-foreground">none mapped</span>}</div>
                  {t.quoteReason && <p className="break-words font-sans text-[11px] text-amber-400">{t.quoteReason}</p>}
                  {t.levelsState === "partial" && <p className="break-words font-sans text-[11px] text-amber-400">{t.levelsReason}</p>}
                </div>
              )}
              {open === t.symbol && t.levels.length > 0 && (
                <ul className="mt-2 space-y-0.5 border-t border-border/40 pt-2 font-mono text-[12px]" data-testid={`desk-board-levels-${plainLevelName(t.label)}`}>
                  {t.levels.map((l) => (
                    <li key={l.key} className="flex justify-between gap-2">
                      <span>{px(l.price)}</span>
                      <span className="min-w-0 break-words text-right font-sans text-muted-foreground">{plainLevelName(l.label)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
