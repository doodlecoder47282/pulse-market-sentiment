/**
 * TabHeadline.tsx
 *
 * Plain-English summary banner for each tab. Top line answers "what's happening
 * RIGHT NOW", sub line gives the next read, bullets give context. Designed so a
 * 15-year-old can understand the tab without reading any tooltips.
 *
 * Drops in at the top of each <TabsContent /> as <TabHeadline tab="signals" />.
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Info } from "lucide-react";

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

  if (isLoading || !data) {
    return (
      <div className="rounded-md border border-border/30 bg-muted/10 px-4 py-3 animate-pulse">
        <div className="h-4 w-2/3 bg-muted/30 rounded mb-2" />
        <div className="h-3 w-1/3 bg-muted/20 rounded" />
      </div>
    );
  }

  const { Icon, border, bg, fg } = TONE_STYLES[data.tone];

  return (
    <div
      className={`rounded-lg border ${border} ${bg} px-4 py-3 space-y-2`}
      data-testid={`headline-${tab}`}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${fg}`} />
        <div className="space-y-1 min-w-0 flex-1">
          <div className={`text-[14px] font-semibold leading-snug ${fg}`}>
            {data.topLine}
          </div>
          <div className="text-[12px] text-muted-foreground leading-snug">
            {data.subLine}
          </div>
        </div>
      </div>

      {data.bullets && data.bullets.length > 0 && (
        <ul className="space-y-0.5 pl-6 text-[11px] text-muted-foreground/90 leading-snug">
          {data.bullets.slice(0, 3).map((b, i) => (
            <li key={i} className="list-disc list-outside marker:text-muted-foreground/40">{b}</li>
          ))}
        </ul>
      )}

      {showExplainer && data.whatThisIs && (
        <div className="flex items-start gap-1.5 pt-1 border-t border-border/20 text-[10px] text-muted-foreground/70">
          <Info className="h-3 w-3 mt-0.5 shrink-0" />
          <span>{data.whatThisIs}</span>
        </div>
      )}
    </div>
  );
}
