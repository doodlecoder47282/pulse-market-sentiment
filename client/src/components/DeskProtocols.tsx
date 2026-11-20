// client/src/components/DeskProtocols.tsx
//
// The protocol book on the Trade Desk (server/protocolEngine.ts, shared/protocols.ts): each if-then rule with
// its trigger, the outcome its author states, what cancels it, a structure type, which conditions are met right
// now, and a counts-only record. Below it, the log of board levels each ticker crossed today.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import UnavailablePanel from "@/components/UnavailablePanel";
import PlainRead from "@/components/PlainRead";
import { ListChecks } from "lucide-react";

interface Cond { name: string; met: boolean | null; detail: string }
interface Proto {
  id: string; name: string; trigger: string; expected: string; cancel: string; structure: string; graded: boolean;
  armedNow: boolean; conditions: Cond[]; entry: number | null; expectPrice: number | null; cancelPrice: number | null;
  record: { armed: number; graded: number; tested: boolean; text: string };
}
interface Log {
  bookVersion: string; minGraded: number; running: boolean; sessionOpen: boolean; evaluatedAt: number | null; lastTickError: string | null;
  protocols: Proto[];
  recent: Array<{ id: number; bookVersion: string; protocol: string; armedAt: number; entry: number | null; levelLabel: string | null; levelPrice: number | null; expectPrice: number | null; cancelPrice: number | null; status: string; reason: string | null }>;
  contextLog?: { rows: number; sessions: number; mapCurrent: number; withWall: number; firstSession: string | null; error: string | null };
  hits: Array<{ at: number; firstAt?: number; count?: number; fromBefore?: boolean; symbol: string; label: string; levelPrice: number; direction: string; price: number; watchedBy: string[] }>;
  note: string;
}

interface Replay {
  state: "ok" | "unavailable"; reason: string | null; asOfMs: number; refreshNote: string | null; answer: string; limits: string[];
  replay: null | {
    sessionsReplayed: number; firstSession: string | null; lastSession: string | null;
    skipped: Array<{ date: string; reason: string }>;
    events: Array<{ date: string; armedAt: number; levelLabel: string; levelPrice: number; entry: number; expectPrice: number; cancelPrice: number; status: string; reason: string | null }>;
    record: { graded: number; tested: boolean; text: string };
  };
}

const px = (n: number | null | undefined) => (n == null ? "n/a" : n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2));
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const STATUS: Record<string, string> = { expected: "reached the rule's outcome price", cancelled: "cancelled", neither: "neither", open: "open", ungraded: "could not be graded", not_graded: "not graded" };

function answer(l: Log): string {
  const armed = l.protocols.filter((p) => p.armedNow).map((p) => p.name);
  if (!l.sessionOpen) return "The market is closed, so no protocol can arm. The rules and their record are below.";
  if (armed.length) return `Armed now: ${armed.join("; ")}. That is a rule's conditions being met, not a forecast.`;
  return "No protocol is armed right now. Each one lists which of its conditions are met.";
}

export default function DeskProtocols() {
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery<Log>({
    queryKey: ["/api/desk/protocols"],
    queryFn: async () => (await apiRequest("GET", "/api/desk/protocols")).json(),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });
  const [showReplay, setShowReplay] = useState(false);
  const rq = useQuery<Replay>({
    queryKey: ["/api/desk/protocols/replay"],
    queryFn: async () => (await apiRequest("GET", "/api/desk/protocols/replay")).json(),
    staleTime: 10 * 60_000,
    retry: false,
  });
  if (q.isLoading) return <Card data-testid="desk-protocols"><CardContent className="p-4 text-sm text-muted-foreground">Reading the protocol book…</CardContent></Card>;
  if (q.isError || !q.data) return <UnavailablePanel title="Protocols" error={q.error} testId="desk-protocols-unavailable" />;
  const l = q.data;
  const nameOf = (id: string) => l.protocols.find((p) => p.id === id)?.name ?? id;
  return (
    <Card className="border-violet-500/20" data-testid="desk-protocols">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <ListChecks className="h-4 w-4 text-violet-400" />
          Protocols
          <span className="text-[11px] font-normal text-muted-foreground" data-testid="desk-protocols-asof">book {l.bookVersion} · hand-set rules{l.evaluatedAt != null ? ` · conditions as of ${hhmm(l.evaluatedAt)} ET` : ""}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <PlainRead testId="desk-protocols-plain" read={{ answer: answer(l), detail: l.note }} />
        {l.lastTickError && <p className="text-[11px] text-amber-400" data-testid="desk-protocols-error">Last check failed: {l.lastTickError}</p>}
        <div className="space-y-2">
          {l.protocols.map((p) => {
            const met = p.conditions.filter((c) => c.met === true).length;
            return (
              <div key={p.id} className={`rounded-md border p-2.5 ${p.armedNow ? "border-amber-500/50 bg-amber-500/5" : "border-border/60"}`} data-testid={`protocol-${p.id}`}>
                <button type="button" className="flex min-h-[44px] w-full items-start justify-between gap-2 text-left lg:min-h-0" aria-expanded={open === p.id}
                  onClick={() => setOpen(open === p.id ? null : p.id)}>
                  <span className="min-w-0">
                    <span className="text-[13px] font-semibold text-foreground">{p.name}</span>{" "}
                    <span className={`text-[11px] ${p.armedNow ? "text-amber-300" : "text-muted-foreground"}`} data-testid={`protocol-state-${p.id}`}>{p.armedNow ? "armed" : `${met} of ${p.conditions.length} conditions met`}</span>
                    <span className="block break-words text-[11px] text-muted-foreground" data-testid={`protocol-record-${p.id}`}>Record: {p.record.text}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{open === p.id ? "less" : "rule"}</span>
                </button>
                {p.armedNow && p.entry != null && (
                  <p className="mt-1 break-words font-mono text-[12px] text-amber-200">armed at {px(p.entry)} · rule's outcome price {px(p.expectPrice)} · cancel price {px(p.cancelPrice)}</p>
                )}
                {open === p.id && (
                  <div className="mt-2 space-y-1.5 border-t border-border/40 pt-2 text-[12px] leading-snug">
                    <p className="break-words"><span className="text-muted-foreground">If:</span> {p.trigger}</p>
                    <p className="break-words"><span className="text-muted-foreground">Rule author's stated outcome (untested):</span> {p.expected}</p>
                    <p className="break-words"><span className="text-muted-foreground">Cancelled when:</span> {p.cancel}</p>
                    <p className="break-words"><span className="text-muted-foreground">Structure type named by the rule's author:</span> {p.structure}. A category only: not a suggestion to trade; no contract, size or order.</p>
                    <ul className="space-y-0.5">
                      {p.conditions.map((c) => (
                        <li key={c.name} className="flex gap-2 break-words">
                          <span className={`shrink-0 font-mono ${c.met === true ? "text-emerald-400" : c.met === false ? "text-rose-400" : "text-amber-400"}`}>{c.met === true ? "met" : c.met === false ? "not met" : "not read"}</span>
                          <span className="min-w-0"><span className="text-foreground">{c.name}</span> <span className="text-muted-foreground">({c.detail})</span></span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="rounded-md border border-border/60 p-2.5" data-testid="desk-protocols-replay">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Replay on past sessions · not the live record</div>
          {rq.isLoading ? <p className="text-[12px] text-muted-foreground">Replaying past sessions…</p>
            : rq.isError || !rq.data ? <p className="text-[12px] text-amber-400">Replay not read: the request failed.</p>
            : rq.data.state !== "ok" || !rq.data.replay ? <p className="break-words text-[12px] text-amber-400">Replay unavailable: {rq.data.reason ?? "no reason given"}</p>
            : (
              <>
                <p className="break-words text-[12px] leading-snug text-foreground" data-testid="desk-protocols-replay-answer">{rq.data.answer}</p>
                <p className="break-words text-[11px] text-muted-foreground">Sweep under a level and reclaim, replay record: {rq.data.replay.record.text} Computed {day(rq.data.asOfMs)} {hhmm(rq.data.asOfMs)} ET.</p>
                {rq.data.refreshNote && <p className="break-words text-[11px] text-amber-400">{rq.data.refreshNote}</p>}
                <button type="button" className="mt-1 min-h-[44px] text-[11px] text-muted-foreground underline lg:min-h-0" aria-expanded={showReplay} onClick={() => setShowReplay(!showReplay)}>
                  {showReplay ? "hide detail" : "each replayed arm, skipped sessions and limits"}
                </button>
                {showReplay && (
                  <div className="mt-1 space-y-1.5 text-[12px]">
                    <ul className="space-y-0.5">
                      {rq.data.replay.events.map((e) => (
                        <li key={e.armedAt} className="break-words">
                          <span className="font-mono text-muted-foreground">{e.date} {hhmm(e.armedAt)}</span> at <span className="font-mono">{px(e.entry)}</span> after a sweep of {px(e.levelPrice)} <span className="text-muted-foreground">({e.levelLabel})</span>
                          {" · "}<span className="text-foreground">{STATUS[e.status] ?? e.status}</span>{e.reason ? <span className="text-muted-foreground"> ({e.reason})</span> : null}
                        </li>
                      ))}
                    </ul>
                    {rq.data.replay.skipped.length > 0 && (
                      <p className="break-words text-[11px] text-muted-foreground">Not replayed: {rq.data.replay.skipped.map((x) => `${x.date} (${x.reason})`).join("; ")}.</p>
                    )}
                    <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                      {rq.data.limits.map((x) => <li key={x} className="break-words">{x}</li>)}
                    </ul>
                  </div>
                )}
              </>
            )}
        </div>
        {l.contextLog && l.running && (
          <p className="break-words text-[11px] text-muted-foreground" data-testid="desk-protocols-context-log">
            The wall rule cannot be replayed from bars: it reads the option wall, tech and VIX as they were. Each time the rules are checked in session, the desk now writes down what they were given.{" "}
            {l.contextLog.rows > 0
              ? `So far: ${l.contextLog.rows} checks over ${l.contextLog.sessions} session${l.contextLog.sessions === 1 ? "" : "s"} since ${l.contextLog.firstSession}; the option map was current at ${l.contextLog.mapCurrent} of them and a wall above was on the board at ${l.contextLog.withWall}. Nothing is replayed from this yet.`
              : "Nothing is written yet; the first rows come with the next session check."}
            {l.contextLog.error ? <span className="text-amber-400"> The last write failed: {l.contextLog.error}</span> : null}
          </p>
        )}
        {l.recent.length > 0 && (
          <div data-testid="desk-protocols-recent">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Protocol log</div>
            <ul className="space-y-0.5 text-[12px]">
              {l.recent.map((r) => (
                <li key={r.id} className="break-words">
                  <span className="font-mono text-muted-foreground">{day(r.armedAt)} {hhmm(r.armedAt)}</span> {nameOf(r.protocol)}
                  {r.entry != null ? <> at <span className="font-mono">{px(r.entry)}</span></> : null}
                  {" · "}<span className="text-foreground">{STATUS[r.status] ?? r.status}</span>{r.reason ? <span className="text-muted-foreground"> ({r.reason})</span> : null}{r.bookVersion !== l.bookVersion ? <span className="text-muted-foreground"> · book {r.bookVersion}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div data-testid="desk-level-hits">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Levels crossed</div>
          {l.hits.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">{l.running ? "No board level has been crossed since the desk started watching this session." : "The level watch is not running on this edition."}</p>
          ) : (
            <ul className="space-y-0.5 text-[12px]">
              {l.hits.map((h, i) => (
                <li key={`${h.at}-${h.symbol}-${i}`} className="break-words">
                  <span className="font-mono text-muted-foreground">{day(h.at)} {hhmm(h.at)}</span>{" "}
                  <span className="font-semibold">{h.symbol.replace(/^[$/]/, "")}</span>{" "}
                  {(h.count ?? 1) > 1 && h.firstAt != null
                    ? <>crossed <span className="font-mono">{px(h.levelPrice)}</span> <span className="text-muted-foreground">({h.label})</span> {h.fromBefore ? `at least ${h.count} times, from before ${hhmm(h.firstAt)}` : `${h.count} times from ${hhmm(h.firstAt)}`}, last {h.direction}</>
                    : <>{h.fromBefore ? "crossed (earlier crossings may precede the log) " : "crossed "}{h.direction} through <span className="font-mono">{px(h.levelPrice)}</span> <span className="text-muted-foreground">({h.label})</span></>}
                  {h.watchedBy.length > 0 && <span className="text-violet-300"> · watched by: {h.watchedBy.join("; ")}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
