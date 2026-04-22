// PanelSkeleton.tsx — shared skeleton placeholders for panels while loading
// Variants: card, chart (tall), list, strip

import { Skeleton } from "@/components/ui/skeleton";

type PanelSkeletonVariant = "card" | "chart" | "list" | "strip";

interface PanelSkeletonProps {
  variant?: PanelSkeletonVariant;
  className?: string;
}

export function PanelSkeleton({ variant = "card", className = "" }: PanelSkeletonProps) {
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
        <Skeleton className="h-[320px] w-full" />
        <div className="mt-3 flex gap-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
        </div>
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
    </div>
  );
}
