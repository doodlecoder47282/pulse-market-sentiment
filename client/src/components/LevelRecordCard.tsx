// client/src/components/LevelRecordCard.tsx
//
// The level record (server/levelRecord.ts, shared/levelRecord.ts): what the index did the first time it
// reached each kind of level over the stored past sessions. Counts only; one sentence, the table on tap.
import { etTimeLabel, etTime } from "@shared/etTime";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import type { LevelRecord, LevelTouch } from "@shared/levelRecord";

interface View { state: "ok" | "unavailable"; reason: string | null; asOfMs: number; answer: string; record: LevelRecord | null; recent: LevelTouch[]; dataNote?: string | null; barsThroughMs?: number | null; limits: string[] }
const dayEt = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const hhmm = (ms: number) => etTime(ms);
const px = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const OUT: Record<string, string> = { held: "closed back first", broke: "closed through first", neither: "neither", ungraded: "not graded" };

export default function LevelRecordCard() {
  const [open, setOpen] = useState(false);
  const q = useQuery<View>({
    queryKey: ["/api/desk/level-record"],
    queryFn: async () => (await apiRequest("GET", "/api/desk/level-record")).json(),
    staleTime: 10 * 60_000,
    retry: false,
  });
  if (q.isLoading) return <Card data-testid="level-record"><CardContent className="p-3 text-[12px] text-muted-foreground">Reading the level record…</CardContent></Card>;
  if (!q.data) return <Card data-testid="level-record-unavailable"><CardContent className="p-3 text-[12px] text-amber-400">Level record not read: the request failed.</CardContent></Card>;
  const v = q.data;
  const r = v.record;
  return (
    <Card data-testid="level-record">
      <CardContent className="p-3">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Level record · SPX · past sessions, counts only</div>
        {v.state !== "ok" || !r ? <p className="break-words text-[12px] text-amber-400">Level record unavailable: {v.reason ?? "no reason given"}</p> : (
          <>
            <p className="break-words text-[13px] leading-snug text-foreground" data-testid="level-record-answer">{v.answer}</p>
            <p className="break-words text-[11px] text-muted-foreground">
              {r.sessions ? `${r.firstSession === r.lastSession ? r.firstSession : `${r.firstSession} to ${r.lastSession}`} · ` : ""}record {r.version}
              {v.barsThroughMs != null ? ` · bars through ${dayEt(v.barsThroughMs)} ${hhmm(v.barsThroughMs)} ET` : ""} · counts of what happened, from sessions next to each other in time; not a statement about the next touch.
            </p>
            {v.dataNote && <p className="break-words text-[11px] text-amber-400">{v.dataNote}</p>}
            <button type="button" className="mt-1 min-h-[44px] text-[11px] text-muted-foreground underline lg:min-h-0" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="level-record-toggle">
              {open ? "hide detail" : "by level, recent touches and limits"}
            </button>
            {open && (
              <div className="mt-1 space-y-2 text-[12px]">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-left font-mono text-[11px]">
                    <thead className="text-muted-foreground">
                      <tr><th className="py-0.5 pr-2 font-normal">level</th><th className="pr-2 font-normal">touches</th><th className="pr-2 font-normal">closed back</th><th className="pr-2 font-normal">closed through</th><th className="pr-2 font-normal">neither</th><th className="font-normal">not graded</th></tr>
                    </thead>
                    <tbody>
                      {r.byLevel.map((l) => (
                        <tr key={l.key} className="border-t border-border/40"><td className="py-0.5 pr-2 font-sans">{l.label}</td><td className="pr-2">{l.touches}</td><td className="pr-2">{l.held}</td><td className="pr-2">{l.broke}</td><td className="pr-2">{l.neither}</td><td>{l.ungraded}</td></tr>
                      ))}
                      <tr className="border-t border-border"><td className="py-0.5 pr-2 font-sans text-muted-foreground">tested from above</td><td className="pr-2">{r.fromAbove.touches}</td><td className="pr-2">{r.fromAbove.held}</td><td className="pr-2">{r.fromAbove.broke}</td><td className="pr-2">{r.fromAbove.neither}</td><td>{r.fromAbove.ungraded}</td></tr>
                      <tr><td className="py-0.5 pr-2 font-sans text-muted-foreground">tested from below</td><td className="pr-2">{r.fromBelow.touches}</td><td className="pr-2">{r.fromBelow.held}</td><td className="pr-2">{r.fromBelow.broke}</td><td className="pr-2">{r.fromBelow.neither}</td><td>{r.fromBelow.ungraded}</td></tr>
                    </tbody>
                  </table>
                </div>
                <p className="break-words text-[11px] text-muted-foreground">
                  Closed back: a 1-minute close {r.rules.awayPts} points back on the side the index came from. Closed through: a 1-minute close {r.rules.throughPts} points beyond the level. Whichever comes first is counted, and the touch bar's own close counts. Both use the same distance and the same measure; a wick alone counts for neither. Window: {r.rules.horizonMin} minutes after the first touch. A price with two names shows on both rows, so the rows add up to more than the totals. {r.startedNear} price{r.startedNear === 1 ? "" : "s"} began a session within {r.rules.awayPts} points of the index and {r.startedNear === 1 ? "was" : "were"} not read as a touch.
                </p>
                {v.recent.length > 0 && (
                  <ul className="space-y-0.5">
                    {v.recent.slice(0, 15).map((t) => (
                      <li key={`${t.date}|${t.key}|${t.touchedAt}`} className="break-words">
                        <span className="font-mono text-muted-foreground">{t.date} {hhmm(t.touchedAt)}</span> {t.label} <span className="font-mono">{px(t.price)}</span> from {t.side === "below" ? "above" : "below"} · <span className="text-foreground">{OUT[t.outcome] ?? t.outcome}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {r.skipped.length > 0 && <p className="break-words text-[11px] text-muted-foreground">Not read: {r.skipped.map((x) => `${x.date} (${x.reason})`).join("; ")}.</p>}
                <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">{v.limits.map((x) => <li key={x} className="break-words">{x}</li>)}</ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
