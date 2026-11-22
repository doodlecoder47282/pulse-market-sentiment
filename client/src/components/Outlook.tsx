// Outlook.tsx
// One page for "what sits between here and the next few weeks", built from numbers the terminal already has
// (shared/outlook.ts): every mapped level with its name and distance from the price, each option expiry with
// its share of open interest and max pain, the range option prices imply to each expiry, and the scheduled
// events, on one time axis. It reads four existing endpoints and asks for nothing from the user. Nothing on
// it is a forecast, and the page says so where a reader could take it for one.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import DataStateChip from "@/components/DataStateChip";
import {
  rankLevels, outlookWindows, windowLines, windowHasContent, WINDOW_RANGE_NOTE, mainExpiryRows, outlookChart, collarLevels, boardOutlookLevels, spreadLabels, sharePct, shortDate,
  type ExpiryRow, type OutlookEvent, type OutlookLevelIn, type CollarIn, type BoardLine,
} from "@shared/outlook";
import { etDate } from "@shared/exchangeCalendar";

interface AuditResp {
  spot?: number; asOf?: number; stale?: boolean; staleReason?: string;
  chainAsOfMs?: number; chainStale?: boolean; chainLastSession?: boolean;
  audit?: {
    expiries?: ExpiryRow[]; dteRead?: number;
    oiState?: { source?: string; sessionDate?: string | null; note?: string | null } | null;
    chainCoverage?: { belowPct: number; abovePct: number; complete: boolean } | null;
  };
}
interface BoardResp {
  forSession?: string; sessionOpen?: boolean;
  tickers?: Array<{ symbol: string; price: number | null; quoteState: string; quoteReason: string | null; levels?: BoardLine[]; levelsState?: string; levelsReason?: string | null }>;
  cases?: { symbol: string; levelsWithoutOptions?: BoardLine[]; optionsState?: string; optionsReason?: string | null } | null;
}
interface CalResp { events?: Array<{ date: string; type: string; label: string }>; warnings?: string[] }
interface CollarResp { current?: CollarIn }

const SYMBOL = "$SPX";
const px = (n: number) => Math.round(n).toLocaleString("en-US");
const signed = (n: number) => `${n >= 0 ? "+" : "-"}${px(Math.abs(n))}`;
const pct = (f: number) => `${(f * 100).toFixed(f !== 0 && Math.abs(f) < 0.1 ? 1 : 0)}%`;
const SIDE_CLS: Record<string, string> = { above: "text-emerald-300", below: "text-rose-300", at: "text-amber-300" };

export default function Outlook({ active = true }: { active?: boolean }) {
  // The same keys and requests the Chain Audit panel and the level board use, so an open tab shares their reads.
  const audit = useQuery<AuditResp>({
    queryKey: ["/api/chain-audit", SYMBOL],
    queryFn: async () => (await apiRequest("GET", `/api/chain-audit?symbol=${encodeURIComponent(SYMBOL)}&dte=60`)).json(),
    enabled: active, refetchInterval: active ? 60_000 : false, staleTime: 50_000, retry: false,
  });
  const board = useQuery<BoardResp>({
    queryKey: ["/api/desk/board"],
    queryFn: async () => (await apiRequest("GET", "/api/desk/board")).json(),
    enabled: active, refetchInterval: active ? 30_000 : false, staleTime: 15_000, retry: false,
  });
  const cal = useQuery<CalResp>({
    queryKey: ["/api/vol-calendar"],
    queryFn: async () => (await apiRequest("GET", "/api/vol-calendar")).json(),
    enabled: active, staleTime: 60 * 60_000, retry: false,
  });
  const collar = useQuery<CollarResp>({
    queryKey: ["/api/jpm-collar"],
    queryFn: async () => (await apiRequest("GET", "/api/jpm-collar")).json(),
    enabled: active, staleTime: 10 * 60_000, retry: false,
  });

  const today = etDate(Date.now());
  const spx = board.data?.tickers?.find((t) => t.symbol === SYMBOL);
  // The price the distances are measured from: the board's quote, else the chain's own underlying price.
  const spot = spx?.price ?? audit.data?.spot ?? null;
  const spotFrom = spx?.price != null ? "the level board's quote" : audit.data?.spot != null ? "the option chain's underlying price" : null;
  const expiries = audit.data?.audit?.expiries ?? [];
  const events: OutlookEvent[] = useMemo(() => (cal.data?.events ?? []).map((e) => ({ date: e.date, label: e.label, type: e.type })), [cal.data]);
  const col = useMemo(() => collarLevels(collar.data?.current), [collar.data]);

  // Bar levels from the board's list merged without option landmarks; option-map levels only while the board says its map is current.
  const cases = board.data?.cases && board.data.cases.symbol === SYMBOL ? board.data.cases : null;
  const fromBoard = useMemo(
    () => (spx ? boardOutlookLevels({ all: spx.levels, withoutOptions: cases?.levelsWithoutOptions ?? null, optionsState: cases?.optionsState ?? null, optionsReason: cases?.optionsReason ?? null }) : { levels: [], optionsNote: null }),
    [spx, cases],
  );
  const levels = useMemo(() => {
    const ins: OutlookLevelIn[] = [...fromBoard.levels];
    for (const e of expiries.filter((x) => x.expiry >= today && x.maxPain != null && x.oi > 0).slice(0, 3)) ins.push({ price: e.maxPain!, label: `max pain, ${shortDate(e.expiry)} expiry`, source: "open interest" });
    ins.push(...col.levels);
    return rankLevels(ins, spot);
  }, [fromBoard, expiries, col, spot, today]);
  const windows = useMemo(() => outlookWindows(today, expiries, events, spot), [today, expiries, events, spot]);
  const chart = useMemo(() => outlookChart(today, spot, expiries, levels, events), [today, spot, expiries, levels, events]);
  const ahead = expiries.filter((e) => e.expiry >= today);
  const maxShare = ahead.reduce((m, e) => Math.max(m, e.oiShare ?? 0), 0);
  const [allRows, setAllRows] = useState(false);
  const shownRows = allRows ? ahead : mainExpiryRows(ahead);
  const hiddenRows = ahead.length - shownRows.length;
  const noOi = ahead.length > 0 && ahead.every((e) => e.oiShare == null);

  const auditState = audit.isError ? "unavailable" : !audit.data ? "loading" : audit.data.stale || audit.data.chainStale ? "stale" : "ok";
  const oi = audit.data?.audit?.oiState ?? null;
  const dteRead = audit.data?.audit?.dteRead ?? null;
  // Labels pushed apart so one does not print on another (about one line of text in a 300 px plot).
  const labelY = useMemo(() => (chart ? spreadLabels(chart.levels.map((l) => l.y), 0.055) : []), [chart]);
  // The page's one-line answer, and whether the reads behind it have settled (data or a failed request).
  const settled = (!!audit.data || audit.isError) && (!!board.data || board.isError);

  return (
    <div className="space-y-4" data-testid="outlook">
      <div className="rounded-md border border-border/60 bg-card/40 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Outlook · SPX{ahead.length ? ` · now to ${shortDate(ahead[ahead.length - 1].expiry)}` : ""}</h2>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Mapped levels, option expiries, the range option prices imply and scheduled events, from now to the last expiry read. Not a forecast.
            </p>
          </div>
          <DataStateChip state={auditState} reason={audit.data?.staleReason ?? null} asOf={audit.data?.chainAsOfMs ?? audit.data?.asOf ?? null} stale={audit.data?.chainStale ?? null} lastSession={audit.data?.chainLastSession ?? null} source="option chain" testId="outlook-chain-state" />
        </div>
        <div className="mt-2 font-mono text-sm" data-testid="outlook-spot" data-answer-tab="outlook" data-ready={settled ? "1" : "0"}>
          {spot != null ? <>SPX {px(spot)} <span className="text-xs text-muted-foreground">from {spotFrom}{spx && spx.quoteState !== "ok" ? `; ${spx.quoteReason ?? "the quote is not current"}` : ""}</span></> : <span className="text-xs text-amber-300">No SPX price in either read, so no distances or ranges are shown.</span>}
        </div>
      </div>

      {/* ── the picture ── */}
      <div className="rounded-md border border-border/60 bg-card/40 p-4" data-testid="outlook-chart-card">
        <div className="mb-2 text-[11px] font-mono font-bold uppercase tracking-widest text-foreground">Price and time</div>
        {!chart ? (
          <p className="text-xs text-muted-foreground" data-testid="outlook-chart-empty">
            {audit.isError ? "The option chain could not be read (the request failed), so there is no time axis to draw." : !audit.data ? "Reading the option chain." : spot == null ? "No price to draw around." : "The chain that was read has no expiry ahead of today."}
          </p>
        ) : (
          <>
            <div className="relative h-[300px] w-full overflow-hidden rounded border border-border/40 bg-background/40 sm:h-[340px]" data-testid="outlook-chart" role="img"
              aria-label={`SPX ${px(spot!)} with the range option prices imply to each expiry through ${shortDate(chart.to)}, ${chart.levels.length} mapped levels and ${chart.events.length} scheduled events`}>
              <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
                {/* the implied range: from the price today, widening to each expiry */}
                {chart.cone.length > 0 && (
                  <polygon
                    points={[`0,${chart.ySpot * 880}`, ...chart.cone.map((p) => `${p.x * 1000},${p.yHi * 880}`), ...[...chart.cone].reverse().map((p) => `${p.x * 1000},${p.yLo * 880}`)].join(" ")}
                    fill="rgba(56,189,248,0.10)" stroke="rgba(56,189,248,0.45)" strokeWidth="2" vectorEffect="non-scaling-stroke"
                  />
                )}
                {chart.levels.map((l) => (
                  <line key={`${l.source}|${l.label}|${l.price}`} x1="0" x2="1000" y1={l.y * 880} y2={l.y * 880} stroke={l.side === "above" ? "rgba(52,211,153,0.55)" : l.side === "below" ? "rgba(251,113,133,0.55)" : "rgba(251,191,36,0.7)"} strokeWidth="1" strokeDasharray="6 5" vectorEffect="non-scaling-stroke" />
                ))}
                <line x1="0" x2="1000" y1={chart.ySpot * 880} y2={chart.ySpot * 880} stroke="rgba(255,255,255,0.75)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                {chart.events.map((e) => (
                  <line key={`${e.date}|${e.label}`} x1={e.x * 1000} x2={e.x * 1000} y1="0" y2="880" stroke="rgba(167,139,250,0.35)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                ))}
                {/* each expiry's share of open interest, as a bar along the bottom */}
                {chart.expiries.map((e) => {
                  const h = e.share != null && maxShare > 0 ? Math.max(6, (e.share / maxShare) * 110) : 6;
                  return <rect key={e.expiry} x={Math.min(992, e.x * 1000 - 4)} width="8" y={1000 - h} height={h} fill={e.share != null ? "rgba(250,204,21,0.75)" : "rgba(148,163,184,0.5)"} />;
                })}
              </svg>
              {/* labels in ordinary text, so they stay readable at every width */}
              <span className="absolute left-1 -translate-y-1/2 rounded bg-background/80 px-1 font-mono text-[11px] text-foreground" style={{ top: `${chart.ySpot * 88}%` }}>now {px(spot!)}</span>
              {chart.levels.map((l, i) => (
                <span key={`t|${l.source}|${l.label}|${l.price}`} className={`absolute right-1 max-w-[62%] -translate-y-1/2 truncate rounded bg-background/80 px-1 font-mono text-[11px] ${SIDE_CLS[l.side]}`} style={{ top: `${(labelY[i] ?? l.y) * 88}%` }}>
                  {px(l.price)} {l.label}
                </span>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-sky-400/40 align-middle" />range option prices imply (one standard deviation; not a forecast)</span>
              <span><span className="mr-1 inline-block h-2 w-1 bg-yellow-400/80 align-middle" />expiry: taller, more open interest</span>
              <span><span className="mr-1 inline-block h-3 w-px bg-violet-400/70 align-middle" />scheduled event</span>
              <span>time: today to {shortDate(chart.to)} · price axis: {px(chart.lo)} to {px(chart.hi)}</span>
            </div>
            {chart.levelsNotDrawn > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground" data-testid="outlook-not-drawn">{chart.levelsNotDrawn} more level{chart.levelsNotDrawn === 1 ? "" : "s"} in the list below, not drawn.</p>
            )}
            {chart.events.length > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground">Events: {chart.events.map((e) => `${e.label} ${shortDate(e.date)}`).join(" · ")}</p>
            )}
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── every level, ranked ── */}
        <div className="rounded-md border border-border/60 bg-card/40 p-4" data-testid="outlook-levels">
          <div className="mb-2 text-[11px] font-mono font-bold uppercase tracking-widest text-foreground">Every mapped level, highest first</div>
          {board.isError && <p className="mb-2 text-[11px] text-amber-300">The level board could not be read (the request failed); its levels are missing from this list.</p>}
          {spx && spx.levelsState !== "ok" && spx.levelsReason && <p className="mb-2 text-[11px] text-amber-300">The board marks its levels {spx.levelsState}: {spx.levelsReason}</p>}
          {board.data?.sessionOpen === false && board.data.forSession && <p className="mb-2 text-[11px] text-muted-foreground">The board's levels are for the {board.data.forSession} session.</p>}
          {fromBoard.optionsNote && <p className="mb-2 text-[11px] text-amber-300" data-testid="outlook-options-note">{fromBoard.optionsNote}</p>}
          {col.note && <p className="mb-2 text-[11px] text-muted-foreground" data-testid="outlook-collar-note">JPM collar: {col.note}</p>}
          {collar.isError && <p className="mb-2 text-[11px] text-amber-300">The collar could not be read (the request failed).</p>}
          {levels.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="outlook-levels-empty">{spot == null ? "No price to measure from." : !board.data && !board.isError ? "Reading the level board." : "No mapped level in this read."}</p>
          ) : (
            <ul className="space-y-1">
              {levels.map((l, i) => {
                const firstBelow = l.side === "below" && levels[i - 1]?.side !== "below";
                return (
                  <li key={`${l.source}|${l.label}|${l.price}`} className={`grid grid-cols-[62px_minmax(0,1fr)_auto] items-baseline gap-2 text-xs ${firstBelow ? "mt-2 border-t border-border/40 pt-2" : ""}`}>
                    <span className={`font-mono font-semibold tabular-nums ${SIDE_CLS[l.side]}`}>{px(l.price)}</span>
                    <span className="min-w-0 break-words"><span className="text-foreground">{l.label}</span> <span className="text-muted-foreground">· {l.source}</span></span>
                    <span className="whitespace-nowrap font-mono tabular-nums text-muted-foreground">{l.side === "at" ? "at the price" : `${signed(l.distPts)} (${pct(l.distPct)})`}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">Distances are from SPX {spot != null ? px(spot) : "n/a"}. A level is a mapped price, not a target.</p>
        </div>

        {/* ── expiries ── */}
        <div className="rounded-md border border-border/60 bg-card/40 p-4" data-testid="outlook-expiries">
          <div className="mb-2 text-[11px] font-mono font-bold uppercase tracking-widest text-foreground">Option expiries ahead</div>
          {ahead.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="outlook-expiries-empty">{audit.isError ? "The option chain could not be read (the request failed). This is not a list of no expiries." : !audit.data ? "Reading the option chain." : "The chain that was read has no expiry ahead of today."}</p>
          ) : (
            <>
              {noOi && <p className="mb-2 text-[11px] text-amber-300">This read of the chain carries no open interest (Schwab reports none at some hours), so shares and max pain are not shown.</p>}
              {oi?.note && <p className="mb-2 text-[11px] text-amber-300" data-testid="outlook-oi-note">Open interest: {oi.note}</p>}
              {dteRead != null && dteRead < 60 && <p className="mb-2 text-[11px] text-amber-300" data-testid="outlook-dte-note">Only the next {dteRead} days of expiries could be read this time (the longer read failed), so the page ends there and each share is of that shorter chain.</p>}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-xs">
                  <thead>
                    <tr className="text-left text-[11px] text-muted-foreground">
                      <th className="pr-2 font-normal">expiry</th><th className="pr-2 font-normal">days</th><th className="pr-2 font-normal">share of open interest (contracts)</th><th className="pr-2 font-normal">max pain</th><th className="font-normal">implied move</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map((e) => (
                      <tr key={e.expiry} className="border-t border-border/30">
                        <td className="py-1 pr-2 font-mono">{shortDate(e.expiry)}</td>
                        <td className="pr-2 font-mono tabular-nums text-muted-foreground">{e.dte}</td>
                        <td className="pr-2">
                          {e.oiShare == null ? <span className="text-muted-foreground">n/a</span> : (
                            <span className="flex items-center gap-2">
                              <span className="inline-block h-2 rounded-sm bg-yellow-400/70" style={{ width: `${Math.max(2, (e.oiShare / (maxShare || 1)) * 70)}px` }} />
                              <span className="font-mono tabular-nums" title={`${px(e.oi)} open contracts`}>{sharePct(e.oiShare)} <span className="text-muted-foreground">({px(e.oi)})</span></span>
                              {maxShare > 0 && e.oiShare === maxShare && <span className="text-[11px] text-yellow-300">largest</span>}
                            </span>
                          )}
                        </td>
                        <td className="pr-2 font-mono tabular-nums">{e.maxPain != null && e.oi > 0 ? px(e.maxPain) : <span className="text-muted-foreground">n/a</span>}</td>
                        <td className="font-mono tabular-nums">{e.sigmaPts != null ? `±${px(e.sigmaPts)}` : <span className="text-muted-foreground">n/a</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {hiddenRows > 0 && (
                <button type="button" onClick={() => setAllRows(true)} className="mt-2 min-h-[44px] rounded border border-border/60 px-2 text-[11px] text-muted-foreground hover:text-foreground" data-testid="outlook-expiries-all">
                  Show all {ahead.length} expiries ({hiddenRows} more, each 1% or less of the open interest read)
                </button>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Share: of the {px(ahead.reduce((n, e) => n + e.oi, 0))} open contracts in the {ahead.length} expiries read (next {dteRead ?? 60} days), not of all SPX options. Max pain: the strike where that expiry's options pay holders least, from the strikes read{audit.data?.audit?.chainCoverage && !audit.data.audit.chainCoverage.complete ? " (the strike range read is not complete, so it can sit at the edge of what was read)" : ""}; not a target. Implied move: one standard deviation from at-the-money implied volatility; priced in, not a forecast.
              </p>
            </>
          )}
        </div>
      </div>

      {/* ── dated summaries ── */}
      {windows.some(windowHasContent) && (
        <div data-testid="outlook-windows">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {windows.filter(windowHasContent).map((w) => (
              <div key={w.from} className="rounded-md border border-border/60 bg-card/40 p-3">
                <div className="mb-1 text-[11px] font-mono font-bold uppercase tracking-widest text-foreground">{w.title}</div>
                <dl className="space-y-1 text-xs">
                  {windowLines(w).map((ln) => (
                    <div key={ln.label}>
                      <dt className="inline text-muted-foreground">{ln.label}: </dt>
                      <dd className="inline text-foreground">{ln.text}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
          {windows.some((w) => w.range) && <p className="mt-2 text-[11px] text-muted-foreground">{WINDOW_RANGE_NOTE}</p>}
        </div>
      )}
      {cal.isLoading && <p className="text-[11px] text-muted-foreground">Reading the event calendar.</p>}
      {cal.isError && <p className="text-[11px] text-amber-300">The event calendar could not be read (the request failed), so no events are shown. This is not a calendar with nothing on it.</p>}
      {(cal.data?.warnings ?? []).map((wn) => <p key={wn} className="text-[11px] text-amber-300">{wn}</p>)}
    </div>
  );
}
