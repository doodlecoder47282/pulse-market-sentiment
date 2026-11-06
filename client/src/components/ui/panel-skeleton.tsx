// PanelSkeleton.tsx — shared skeleton placeholders for panels while loading
// Variants: card, chart (tall), list, strip
//
// A skeleton is never endless (every query has a 25 s deadline, after which
// the panel shows its error state), but 25 s of grey bars says nothing. After
// SLOW_AFTER_MS the skeleton says what it is waiting on, so a slow Schwab
// read (a chain build can take 10-20 s cold) is a stated state, not a hang.

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

type PanelSkeletonVariant = "card" | "chart" | "list" | "strip";

/** After this long a skeleton states what it is waiting on. */
export const SLOW_AFTER_MS = 6_000;

interface PanelSkeletonProps {
  variant?: PanelSkeletonVariant;
  className?: string;
  /** What the panel is waiting on, e.g. "Schwab chain"; shown after SLOW_AFTER_MS. */
  waitingOn?: string;
}

export function SlowNote({ waitingOn }: { waitingOn?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(id);
  }, []);
  if (!slow) return null;
  return (
    <div className="mt-2 text-[11px] text-muted-foreground" data-testid="skeleton-slow-note" role="status">
      Still loading{waitingOn ? `: waiting on ${waitingOn}` : ""}. A cold read can take up to 25 s; after that the panel says what failed.
    </div>
  );
}

export function PanelSkeleton({ variant = "card", className = "", waitingOn }: PanelSkeletonProps) {
  if (variant === "strip") {
    return (
      <div className={`flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-3 py-2 ${className}`}>
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-24" />
        <div className="ml-auto flex gap-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-8" />
          ))}
        </div>
      </div>
    );
  }

  if (variant === "chart") {
    return (
      <div className={`rounded-xl border border-border/60 bg-card/40 p-4 ${className}`}>
        <div className="mb-3 flex items-center justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="h-[240px] w-full sm:h-[320px]" />
        <div className="mt-3 flex gap-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
        </div>
        <SlowNote waitingOn={waitingOn} />
      </div>
    );
  }

  if (variant === "list") {
    return (
      <div className={`rounded-xl border border-border/60 bg-card/40 p-4 ${className}`}>
        <Skeleton className="mb-3 h-5 w-40" />
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-4 w-4 rounded-full" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
        <SlowNote waitingOn={waitingOn} />
      </div>
    );
  }

  // card (default)
  return (
    <div className={`rounded-xl border border-border/60 bg-card/40 p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-6 w-16 rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border/40 p-3">
            <Skeleton className="mb-2 h-3 w-16" />
            <Skeleton className="h-6 w-20" />
            <Skeleton className="mt-1 h-3 w-12" />
          </div>
        ))}
      </div>
      <SlowNote waitingOn={waitingOn} />
    </div>
  );
}
