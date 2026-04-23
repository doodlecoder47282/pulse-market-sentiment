import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Minimize2, Maximize2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useTheme } from "./ThemeContext";

type Size = "full" | "compact" | "collapsed";

interface Props {
  id: string;
  title: ReactNode;
  children: ReactNode;
  className?: string;
  defaultSize?: Size;
  rightSlot?: ReactNode;
}

/**
 * Wrapper that gives any card three states:
 *   full       – normal render
 *   compact    – max-h 180px, overflow-hidden with fade (sized-down preview)
 *   collapsed  – header only
 *
 * Controls sit inline with the title. State is local to the card
 * (no storage — sandboxed iframe blocks localStorage).
 *
 * Global "compact mode" (from ThemeContext) forces all cards to compact
 * unless individually expanded.
 */
export function CollapsibleCard({
  id,
  title,
  children,
  className,
  defaultSize = "full",
  rightSlot,
}: Props) {
  const { compact: globalCompact } = useTheme();
  const [override, setOverride] = useState<Size | null>(null);

  // Effective size: explicit override wins; otherwise global compact flag collapses to "compact".
  const size: Size = override ?? (globalCompact ? "compact" : defaultSize);

  const cycleSize = () => {
    const next: Size = size === "full" ? "compact" : size === "compact" ? "collapsed" : "full";
    setOverride(next);
  };
  const toggleCollapse = () => {
    setOverride(size === "collapsed" ? "full" : "collapsed");
  };

  return (
    <Card className={cn("transition-all", className)} data-card-id={id} data-size={size}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          {title}
        </CardTitle>
        <div className="flex items-center gap-1">
          {rightSlot}
          <button
            type="button"
            onClick={cycleSize}
            title={size === "full" ? "Size down" : size === "compact" ? "Collapse" : "Expand"}
            aria-label="Resize card"
            data-testid={`button-card-size-${id}`}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-muted hover:text-foreground"
          >
            {size === "full" ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : size === "compact" ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={toggleCollapse}
            title={size === "collapsed" ? "Open" : "Close"}
            aria-label={size === "collapsed" ? "Expand card" : "Collapse card"}
            data-testid={`button-card-toggle-${id}`}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-muted hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                size === "collapsed" ? "-rotate-90" : "rotate-0"
              )}
            />
          </button>
        </div>
      </CardHeader>
      {size !== "collapsed" && (
        <CardContent
          className={cn(
            "relative transition-[max-height,opacity] duration-200",
            size === "compact" && "max-h-[180px] overflow-hidden"
          )}
        >
          {children}
          {size === "compact" && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent"
              aria-hidden
            />
          )}
        </CardContent>
      )}
    </Card>
  );
}
