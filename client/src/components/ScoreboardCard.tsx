// client/src/components/ScoreboardCard.tsx
//
// The scoreboard (server/scoreboard.ts, shared/scoreboard.ts): every graded record the desk keeps in one list,
// with its own counts and its own floor. Collapsed to one sentence; the rows open on tap.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { SCORE_STATE_LABEL, type ScoreRow } from "@shared/scoreboard";

interface View { asOfMs: number; answer: string; rows: ScoreRow[]; unread: Array<{ record: string; reason: string }>; note: string }

// Tone marks only whether a row could be read: reaching a floor is not good news and is not coloured as such.
const TONE: Record<string, string> = { enough: "text-foreground", too_few: "text-muted-foreground", none: "text-muted-foreground", no_floor: "text-muted-foreground", never: "text-muted-foreground", off: "text-muted-foreground", unavailable: "text-amber-400" };

export default function ScoreboardCard() {
  const [open, setOpen] = useState(false);
  const q = useQuery<View>({
    queryKey: ["/api/scoreboard"],
    queryFn: async () => (await apiRequest("GET", "/api/scoreboard")).json(),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: false,
  });
  if (q.isLoading) return <Card data-testid="scoreboard"><CardContent className="p-3 text-[12px] text-muted-foreground">Reading the scoreboard…</CardContent></Card>;
  if (!q.data) return <Card data-testid="scoreboard-unavailable"><CardContent className="p-3 text-[12px] text-amber-400">Scoreboard not read: the request failed.</CardContent></Card>;
  const v = q.data;
  return (
    <Card className="border-border/60" data-testid="scoreboard">
      <CardContent className="p-3">
        <button type="button" className="flex min-h-[44px] w-full items-center justify-between gap-3 text-left lg:min-h-0" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="scoreboard-toggle">
          <span className="min-w-0 break-words text-[13px] leading-snug">
            <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">Scoreboard</span>
            <span className="font-medium text-foreground" data-testid="scoreboard-answer">{v.answer}</span>
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{open ? "less" : "records"}</span>
        </button>
        {open && (
          <div className="mt-2 space-y-2">
            <ul className="space-y-1.5">
              {v.rows.map((r) => (
                <li key={r.id} className="break-words border-t border-border/40 pt-1.5 text-[12px] leading-snug" data-testid={`score-${r.id}`}>
                  <span className="font-semibold text-foreground">{r.what}</span>
                  <span className="block text-foreground">{r.result}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    <span className={TONE[r.state]}>{SCORE_STATE_LABEL[r.state]}</span>
                    {r.n != null && r.floor != null ? ` · ${r.n} of ${r.floor} graded` : r.n != null ? ` · ${r.n} graded` : ""}
                    {` · graded as: ${r.graded} · full record on ${r.where}`}
                  </span>
                </li>
              ))}
            </ul>
            {v.unread.length > 0 && <p className="break-words text-[11px] text-amber-400">Not read: {v.unread.map((u) => `${u.record} (${u.reason})`).join("; ")}.</p>}
            {q.isError && <p className="break-words text-[11px] text-amber-400">The latest refresh failed; this is the last read, from {new Date(v.asOfMs).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} ET.</p>}
            <p className="break-words text-[11px] text-muted-foreground">{v.note}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
