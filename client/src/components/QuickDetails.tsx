/**
 * QuickDetails.tsx
 *
 * "Answer first, proof one tap away." Wraps the supporting panels of a tab.
 * On phones (under 1024 px) it starts closed, so a tab shows its answer and
 * nothing else until the reader asks for more; on wider screens it starts
 * open. The reader's own choice is remembered per section on this device.
 *
 * Closed sections do not mount their children, so their rendering (and any
 * requests made by the panels themselves) wait until opened. Data the parent
 * page already fetched is not affected.
 */

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

const KEY = (id: string) => `batcave:quick:${id}`;

function initialOpen(id: string): boolean {
  try {
    const saved = window.localStorage.getItem(KEY(id));
    if (saved === "1") return true;
    if (saved === "0") return false;
  } catch { /* storage blocked: fall through to the width default */ }
  return typeof window !== "undefined" && window.innerWidth >= 1024;
}

interface Props {
  id: string;
  /** What is inside, in plain words: "Breadth, sentiment gauges, gamma and term structure". */
  label: string;
  children: ReactNode;
}

export default function QuickDetails({ id, label, children }: Props) {
  const [open, setOpen] = useState(() => initialOpen(id));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { window.localStorage.setItem(KEY(id), next ? "1" : "0"); } catch { /* per-device convenience only */ }
  };
  return (
    <div data-testid={`quick-details-${id}`} data-open={open ? "1" : "0"} className="space-y-6">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`quick-details-body-${id}`}
        data-testid={`quick-details-toggle-${id}`}
        className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-left text-sm text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      >
        <span className="min-w-0 flex-1 break-words">
          <span className="font-medium text-foreground">{open ? "Hide detail" : "More detail"}</span>
          <span className="text-muted-foreground"> · {label}</span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      <div id={`quick-details-body-${id}`} className="space-y-6" hidden={!open}>{open && children}</div>
    </div>
  );
}
