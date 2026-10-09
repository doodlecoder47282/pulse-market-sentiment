/**
 * TabHeadline.tsx
 *
 * Plain-English summary banner for each tab. Top line answers "what's happening
 * RIGHT NOW", sub line gives the next read, bullets give context. Designed so a
 * 15-year-old can understand the tab without reading any tooltips.
 *
 * Drops in at the top of each <TabsContent /> as <TabHeadline tab="signals" />.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Info, ChevronDown } from "lucide-react";

type Tab =
  | "signals" | "chart" | "models" | "heatseeker" | "tradedesk"
  | "regime" | "cosmos" | "news" | "voices" | "takefive" | "global";

interface HeadlinePayload {
  tab: Tab;
  tone: "bull" | "bear" | "neutral" | "warning";
  topLine: string;
  subLine: string;
  bullets: string[];
  asOf: number;
  whatThisIs: string;
}

const TONE_STYLES = {
  bull:    { border: "border-emerald-500/40", bg: "bg-emerald-500/5",  fg: "text-emerald-300", Icon: TrendingUp },
  bear:    { border: "border-red-500/40",     bg: "bg-red-500/5",      fg: "text-red-300",     Icon: TrendingDown },
  neutral: { border: "border-border/40",      bg: "bg-muted/10",       fg: "text-foreground",  Icon: Minus },
  warning: { border: "border-amber-500/40",   bg: "bg-amber-500/5",    fg: "text-amber-300",   Icon: AlertTriangle },
};

interface Props {
  tab: Tab;
  /** Show the "what this is" explainer line. Default true on first render. */
  showExplainer?: boolean;
}

export default function TabHeadline({ tab, showExplainer = true }: Props) {
  const { data, isLoading } = useQuery<HeadlinePayload>({
    queryKey: ["/api/headline", tab],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/headline?tab=${tab}`);
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Collapsed to one line by default so tab content starts near the top;
  // the bullets and explainer open on tap.
  const [open, setOpen] = useState(false);

  if (isLoading || !data) {
    return <div className="h-11 rounded-md border border-border/30 bg-muted/10 animate-pulse" />;
  }

  const { Icon, border, bg, fg } = TONE_STYLES[data.tone];
  const hasMore = (data.bullets?.length ?? 0) > 0 || (showExplainer && !!data.whatThisIs) || !!data.subLine;

  return (
    <div className={`rounded-lg border ${border} ${bg}`} data-testid={`headline-${tab}`}>
      <button
        type="button"
        onClick={() => hasMore && setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center gap-2.5 px-4 py-2 text-left"
        data-testid={`headline-toggle-${tab}`}
      >
        <Icon className={`h-4 w-4 shrink-0 ${fg}`} />
        <span className={`min-w-0 flex-1 text-sm font-semibold leading-snug ${fg}`}>{data.topLine}</span>
        {hasMore && (
          <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} aria-label={open ? "Hide details" : "Show details"} />
        )}
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-3 pl-10">
          {data.subLine && <div className="text-sm text-muted-foreground leading-snug">{data.subLine}</div>}
          {data.bullets && data.bullets.length > 0 && (
            <ul className="space-y-0.5 pl-4 text-xs text-muted-foreground leading-snug">
              {data.bullets.slice(0, 3).map((b, i) => (
                <li key={i} className="list-disc list-outside">{b}</li>
              ))}
            </ul>
          )}
          {showExplainer && data.whatThisIs && (
            <div className="flex items-start gap-1.5 border-t border-border/20 pt-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{data.whatThisIs}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
