// PlainRead — the answer first, in ordinary words (shared/plainReads.ts).
// One short sentence is always visible; tapping it opens the fuller explanation. Used above a panel's
// figures so a reader scrolling the tab gets what the panel says without the vocabulary.
import { useState } from "react";
import type { PlainRead as Read } from "@shared/plainReads";

export default function PlainRead({ read, testId, className = "" }: { read: Read; testId?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const body = (
    <>
      <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">In plain words</span>
      <span className="font-medium text-foreground">{read.answer}</span>
    </>
  );
  const frame = `rounded border-l-2 border-cyan-400/60 bg-cyan-400/5 px-2.5 py-1.5 text-[13px] leading-snug ${className}`;
  if (!read.detail) return <p className={frame} data-testid={testId}>{body}</p>;
  return (
    <div className={frame} data-testid={testId}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid={testId ? `${testId}-toggle` : undefined}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 text-left lg:min-h-0">
        <span className="min-w-0 break-words">{body}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{open ? "less" : "more"}</span>
      </button>
      {open && <p className="mt-1 break-words text-[12px] leading-snug text-muted-foreground" data-testid={testId ? `${testId}-detail` : undefined}>{read.detail}</p>}
    </div>
  );
}
