// NewsPanel.tsx
// News tab: merged headline flow + economic/earnings calendar + macro topic filter.
// Data: GET /api/news (3-min cache, free RSS + Nasdaq econ calendar).

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Newspaper, CalendarDays, ExternalLink, AlertTriangle, Search, Flame, Sparkles, Copy, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type NewsTopic = "FED" | "INFLATION" | "JOBS" | "GROWTH" | "GEO" | "EARNINGS" | "RATES" | "OIL" | "OTHER";

interface Headline {
  id: string;
  title: string;
  source: string;
  url: string;
  published: number;
  summary: string;
  topics: NewsTopic[];
  tickers: string[];
}

type CalendarKind = "ECON" | "FED" | "EARNINGS" | "TREASURY" | "OPEX" | "VIX_EXP" | "WITCH";

interface CalendarEvent {
  id: string;
  kind: CalendarKind;
  title: string;
  when: number;
  whenLabel: string;
  importance: "HIGH" | "MED" | "LOW";
  previous?: string;
  forecast?: string;
  actual?: string;
  source: string;
  ticker?: string;
  notes?: string;
}

interface NewsResponse {
  asOf: number;
  headlines: Headline[];
  calendar: CalendarEvent[];
  topics: { topic: NewsTopic; count: number }[];
  warnings: string[];
}

const TOPIC_COLOR: Record<NewsTopic, string> = {
  FED: "border-violet-500/50 bg-violet-500/10 text-violet-300",
  INFLATION: "border-rose-500/50 bg-rose-500/10 text-rose-300",
  JOBS: "border-cyan-500/50 bg-cyan-500/10 text-cyan-300",
  GROWTH: "border-emerald-500/50 bg-emerald-500/10 text-emerald-300",
  GEO: "border-amber-500/50 bg-amber-500/10 text-amber-300",
  EARNINGS: "border-sky-500/50 bg-sky-500/10 text-sky-300",
  RATES: "border-indigo-500/50 bg-indigo-500/10 text-indigo-300",
  OIL: "border-orange-500/50 bg-orange-500/10 text-orange-300",
  OTHER: "border-border/40 bg-muted/20 text-muted-foreground",
};

const IMPORTANCE_COLOR: Record<CalendarEvent["importance"], string> = {
  HIGH: "border-rose-500/50 bg-rose-500/10 text-rose-300",
  MED: "border-amber-500/50 bg-amber-500/10 text-amber-300",
  LOW: "border-border/40 bg-muted/20 text-muted-foreground",
};

const KIND_COLOR: Record<CalendarKind, string> = {
  ECON: "border-sky-500/50 bg-sky-500/10 text-sky-300",
  FED: "border-violet-500/50 bg-violet-500/10 text-violet-300",
  EARNINGS: "border-emerald-500/50 bg-emerald-500/10 text-emerald-300",
  TREASURY: "border-indigo-500/50 bg-indigo-500/10 text-indigo-300",
  OPEX: "border-amber-500/50 bg-amber-500/10 text-amber-300",
  VIX_EXP: "border-orange-500/50 bg-orange-500/10 text-orange-300",
  WITCH: "border-rose-500/60 bg-rose-500/15 text-rose-200",
};

const KIND_LABEL: Record<CalendarKind, string> = {
  ECON: "ECON",
  FED: "FED",
  EARNINGS: "EARNINGS",
  TREASURY: "TREASURY",
  OPEX: "OPEX",
  VIX_EXP: "VIX EXP",
  WITCH: "TRIPLE WITCH",
};

// ──────────────────────────────────────────────────────────────────────────
// Event link resolver + impact bios
// Each event gets a clickable source link (official calendar / data page)
// and a "how this moves the market" brief tailored to the event kind/title.
// ──────────────────────────────────────────────────────────────────────────

function resolveEventUrl(e: CalendarEvent): string {
  const t = e.title.toLowerCase();
  // Earnings → company investor relations search on Yahoo Finance
  if (e.kind === "EARNINGS" && e.ticker) {
    return `https://finance.yahoo.com/quote/${encodeURIComponent(e.ticker)}/`;
  }
  // Fed / FOMC
  if (e.kind === "FED") {
    if (/minute/.test(t)) return "https://www.federalreserve.gov/monetarypolicy/fomcminutes.htm";
    if (/speech|speaks|remarks/.test(t)) return "https://www.federalreserve.gov/newsevents/speeches.htm";
    return "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
  }
  // Treasury auctions
  if (e.kind === "TREASURY") {
    return "https://www.treasurydirect.gov/auctions/upcoming/";
  }
  // OPEX / monthly expiry → Cboe expiration calendar
  if (e.kind === "OPEX") {
    return "https://www.cboe.com/us/options/market_statistics/expirations/";
  }
  // VIX expirations
  if (e.kind === "VIX_EXP") {
    return "https://www.cboe.com/tradable_products/vix/vix_options/specifications/";
  }
  // Triple witching
  if (e.kind === "WITCH") {
    return "https://www.cboe.com/us/options/market_statistics/expirations/";
  }
  // Economic data — route major releases to their publisher; fall through to Nasdaq calendar.
  if (e.kind === "ECON") {
    if (/\bcpi\b|consumer price/.test(t)) return "https://www.bls.gov/cpi/";
    if (/\bppi\b|producer price/.test(t)) return "https://www.bls.gov/ppi/";
    if (/\bpce\b|personal consumption|personal income/.test(t)) return "https://www.bea.gov/data/personal-consumption-expenditures-price-index";
    if (/\bgdp\b/.test(t)) return "https://www.bea.gov/data/gdp/gross-domestic-product";
    if (/nonfarm|payroll|\bnfp\b/.test(t)) return "https://www.bls.gov/news.release/empsit.toc.htm";
    if (/unemployment|jobless|initial claims|continuing claims/.test(t)) return "https://www.dol.gov/ui/data.pdf";
    if (/\bjolts\b/.test(t)) return "https://www.bls.gov/jlt/";
    if (/\bism\b|manufacturing|services pmi/.test(t)) return "https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/";
    if (/retail sales/.test(t)) return "https://www.census.gov/retail/";
    if (/housing|nahb|starts|permits|new home/.test(t)) return "https://www.census.gov/construction/nrc/";
    if (/consumer confidence/.test(t)) return "https://www.conference-board.org/topics/consumer-confidence";
    if (/michigan|umich|sentiment/.test(t)) return "http://www.sca.isr.umich.edu/";
    if (/durable goods/.test(t)) return "https://www.census.gov/manufacturing/m3/";
    if (/empire|philly|philadelphia|richmond|kansas/.test(t)) return "https://www.federalreserve.gov/releases/";
    return "https://www.nasdaq.com/market-activity/economic-calendar";
  }
  return "https://www.nasdaq.com/market-activity/economic-calendar";
}

// Impact bio per event — returns a short "how it affects markets under X
// conditions" paragraph. Keyed first by recognizable title patterns, then by
// a kind-level fallback so every card gets a bio.
function resolveEventBio(e: CalendarEvent): string {
  const t = e.title.toLowerCase();

  // -- High-signal specific releases --
  if (/\bcpi\b|consumer price/.test(t)) {
    return "Inflation print. Hot vs. est → rate-cut odds fade, USD + yields up, duration + growth/tech sell, dealer γ compresses moves post-print. Cool print → risk-on pop, breadth expands, vol crush into close.";
  }
  if (/\bppi\b|producer price/.test(t)) {
    return "Leading indicator for CPI and margins. Hot → supports sticky-inflation narrative, pressures financials + consumer discretionary. Cool → tailwind for rate-sensitive sectors (housing, small-caps).";
  }
  if (/\bpce\b|personal consumption/.test(t)) {
    return "Fed's preferred inflation gauge. A hot core PCE re-prices the dot plot; a cool one green-lights risk-on. Expect outsized reaction in 2y yields and gold.";
  }
  if (/nonfarm|payroll|\bnfp\b/.test(t)) {
    return "Jobs Friday. Strong headline + low unemployment = hawkish repricing, yields and USD up, small-caps can still rally on growth. Weak print → softens Fed path, helps duration + tech but can ignite recession fears if too weak.";
  }
  if (/unemployment|jobless|initial claims|continuing claims/.test(t)) {
    return "Weekly labor pulse. Claims drifting higher above ~250k → recession watch, supports bonds + defensives. Benign prints extend the Goldilocks bid.";
  }
  if (/\bjolts\b/.test(t)) {
    return "Job openings + quits rate. Falling openings = labor cooling, bond-friendly. Sticky openings keep Fed on hold and cap rate-cut hopes.";
  }
  if (/\bism\b|manufacturing pmi|services pmi|\bpmi\b/.test(t)) {
    return "Diffusion index around 50 = expansion/contraction threshold. Above 50 with rising new orders = cyclicals / industrials / energy bid. Below 50 rotates into defensives and duration.";
  }
  if (/retail sales/.test(t)) {
    return "Consumer pulse. Upside surprise supports discretionary, banks (credit demand), and the reflation trade. Miss → defensive rotation, staples and utilities outperform.";
  }
  if (/\bgdp\b/.test(t)) {
    return "Growth snapshot, backward-looking but market-moving on surprises. Strong growth + cooling inflation = soft-landing dream, everything rips. Stagflation prints (high growth / high inflation) crush multiples.";
  }
  if (/housing|starts|permits|new home|existing home/.test(t)) {
    return "Rate-sensitive sector gauge. Higher starts / permits on falling rates = homebuilders, materials, regional banks rally. Weakness bleeds into consumer discretionary.";
  }
  if (/consumer confidence|michigan|umich|sentiment/.test(t)) {
    return "Soft data, but inflation-expectations sub-index matters to the Fed. A jump in 5y expectations can re-price the long end even if hard data is quiet.";
  }
  if (/empire|philly|philadelphia|richmond|kansas|regional/.test(t)) {
    return "Regional Fed survey — early read on national ISM. Prices-paid component is the tell: rising prices-paid = inflation sticky, hawkish bias.";
  }
  if (/durable goods/.test(t)) {
    return "Capex proxy via non-defense ex-aircraft. Strong print = industrials + semis bid, signals business investment. Weakness flags late-cycle slowdown.";
  }

  // -- Fed events --
  if (e.kind === "FED") {
    if (/decision|rate|fomc statement|fomc meeting/.test(t)) {
      return "FOMC decision day. The move lives in the SEP dots + Powell presser, not the statement. Hawkish surprise → yields up, duration + mega-cap tech get hit, dollar rips. Dovish → everything-rally, especially small-caps and junk credit.";
    }
    if (/minute/.test(t)) {
      return "FOMC minutes — hunt for the distribution of views (how many hawks, how many doves). Reveals internal split and quietly resets rate-path odds.";
    }
    if (/speech|speaks|remarks/.test(t)) {
      return "Fed-speak window. Watch for tone shift vs. the last statement — voters move markets more than non-voters. Expect intraday vol around the headline crossing.";
    }
    return "Fed event. Drives front-end rates, dollar, and the dealer-γ regime. Dovish tape = wider 1σ ranges; hawkish tape = compressed-but-violent pin behavior.";
  }

  // -- Treasury auctions --
  if (e.kind === "TREASURY") {
    if (/30.?y|30[- ]?year/.test(t)) {
      return "Long-bond auction. Weak bid-to-cover or tail → long end sells off, breaks duration trades, pressures utilities / REITs / mega-cap multiples. Strong stop-through → bid for duration, tech catches a bid.";
    }
    if (/10.?y|10[- ]?year/.test(t)) {
      return "Benchmark supply. Tail vs. WI matters more than headline. A sloppy 10y reprices the curve, hits growth stocks, lifts USD. A screaming auction = risk-on.";
    }
    if (/7.?y|5.?y|3.?y|2.?y|belly/.test(t)) {
      return "Belly of the curve. Indirect bidder share (foreign demand) is the tell. Weak demand = yields creep higher, pressure on risk through the session.";
    }
    if (/bill|4w|8w|13w|26w|52w/.test(t)) {
      return "T-bill auction. Watches money-market demand and RRP drain. Less market-moving than coupons but can flag cash-management stress at month/quarter-end.";
    }
    return "Treasury auction. Demand metrics (bid-to-cover, indirects, tail) drive the curve for the rest of the session and bleed into equity dealer flows.";
  }

  // -- Structural expirations --
  if (e.kind === "OPEX") {
    return "Monthly SPX / equity options expiration. Dealer γ rolls off — the gravitational pin around the biggest OI strike weakens post-close, often releasing pent-up directional moves into the following week. Watch for vol-of-vol expansion Mon/Tue.";
  }
  if (e.kind === "VIX_EXP") {
    return "VIX expiration (Wed AM settlement). VIX cash can dislocate from futures into the settle; post-settle, vega gets repriced. Vol-control / CTA rebalances often key off this anchor.";
  }
  if (e.kind === "WITCH") {
    return "Triple Witching — quarterly expiry of index options, index futures, and single-stock options/futures stacked on the same day. Massive dealer hedging + passive rebalancing = headline volume spike, pin behavior into PM, regime reset the following Monday.";
  }

  // -- Earnings generic --
  if (e.kind === "EARNINGS") {
    return "Single-name earnings. Beats-and-raise with strong guide → stock gaps up, pulls sector; weak guide crushes multiple regardless of beat. Mega-caps (AAPL/MSFT/NVDA/GOOGL/META/AMZN/TSLA) drag the index via passive flows; watch IV crush on the open.";
  }

  // Fallback (rare)
  return "Scheduled market event. Check the release details for forecast vs. prior — surprises on either side typically produce the intraday vol.";
}

// ──────────────────────────────────────────────────────────────────────────
// ALPHA Agent — helper components
// ──────────────────────────────────────────────────────────────────────────

function AlphaCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="button-alpha-copy"
      className="h-6 gap-1 px-2 text-[10px] text-amber-300/70 hover:text-amber-300"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function AlphaSkeleton() {
  return (
    <div className="space-y-2" data-testid="alpha-skeleton">
      <div className="text-[10px] font-mono tracking-wider text-amber-400/60 animate-pulse">
        ALPHA is analyzing the tape...
      </div>
      <Skeleton className="h-4 w-full bg-amber-500/10" />
      <Skeleton className="h-4 w-5/6 bg-amber-500/10" />
      <Skeleton className="h-4 w-4/5 bg-amber-500/10" />
      <Skeleton className="h-8 w-full bg-amber-500/10" />
      <Skeleton className="h-4 w-full bg-amber-500/10" />
      <Skeleton className="h-4 w-3/4 bg-amber-500/10" />
      <Skeleton className="h-4 w-full bg-amber-500/10" />
    </div>
  );
}

interface AlphaBriefResult {
  brief: string;
  mode: "with_search" | "knowledge_only";
  error?: string;
}

function AlphaCard({ headlines }: { headlines: Headline[] }) {
  const mutation = useMutation({
    mutationFn: async (): Promise<AlphaBriefResult> => {
      const newsItems = headlines.slice(0, 30).map((h) => ({
        title: h.title,
        source: h.source,
        time: new Date(h.published * 1000).toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
        }),
        summary: h.summary || undefined,
        url: h.url || undefined,
      }));
      const res = await apiRequest("POST", "/api/alpha-brief", { newsItems });
      return res.json() as Promise<AlphaBriefResult>;
    },
  });

  return (
    <Card
      className="border-amber-500/30 bg-gradient-to-br from-amber-950/20 to-background"
      data-testid="alpha-card"
    >
      <CardHeader className="flex flex-row items-start justify-between pb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-amber-400 flex-shrink-0" />
            <h3 className="font-mono tracking-wider text-amber-300 text-sm font-semibold">ALPHA</h3>
            <Badge
              variant="outline"
              className="border-amber-500/40 text-amber-300/80 text-[10px]"
            >
              Claude Opus
            </Badge>
            {mutation.data?.mode === "with_search" && (
              <Badge
                variant="outline"
                className="border-emerald-500/40 text-emerald-300/80 text-[9px]"
              >
                + web search
              </Badge>
            )}
            {mutation.data?.mode === "knowledge_only" && (
              <Badge
                variant="outline"
                className="border-amber-500/30 text-amber-400/60 text-[9px]"
              >
                knowledge only
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            AI agent sifts geopolitics, rates, insider, sentiment. Ranks by market impact.
          </p>
        </div>
        <Button
          data-testid="button-alpha-generate"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="ml-3 flex-shrink-0 bg-amber-500 text-black hover:bg-amber-400 font-mono tracking-wider text-xs"
        >
          {mutation.isPending ? "ANALYZING..." : "RUN ALPHA"}
        </Button>
      </CardHeader>

      {(mutation.isPending || mutation.data || mutation.isError) && (
        <CardContent className="pt-0">
          {mutation.isPending && <AlphaSkeleton />}

          {mutation.isError && (
            <div className="rounded border border-rose-500/30 bg-rose-500/5 p-3 text-[11px] text-rose-400">
              ALPHA failed: {(mutation.error as Error)?.message ?? "Unknown error"}
            </div>
          )}

          {mutation.data?.error && (
            <div className="rounded border border-rose-500/30 bg-rose-500/5 p-3 text-[11px] text-rose-400">
              ALPHA failed: {mutation.data.error}
            </div>
          )}

          {mutation.data?.brief && !mutation.isPending && (
            <div className="space-y-2">
              {mutation.data.mode === "knowledge_only" && (
                <div className="text-xs text-amber-400/70 border border-amber-500/20 rounded px-2 py-1">
                  Live web search unavailable — brief based on news feed + model knowledge.
                </div>
              )}
              <div
                className="prose prose-invert prose-sm max-w-none rounded border border-amber-500/10 bg-card/30 p-3
                  prose-headings:font-mono prose-headings:tracking-wider prose-headings:text-amber-300
                  prose-headings:text-sm prose-headings:font-semibold
                  prose-p:text-[11px] prose-p:leading-relaxed prose-p:text-foreground/90
                  prose-li:text-[11px] prose-li:leading-relaxed prose-li:text-foreground/90
                  prose-table:text-[10px] prose-td:py-1 prose-th:py-1
                  prose-th:font-mono prose-th:tracking-wider prose-th:text-amber-300/80
                  prose-strong:text-foreground"
                data-testid="alpha-brief-output"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{mutation.data.brief}</ReactMarkdown>
              </div>
              <div className="flex justify-end">
                <AlphaCopyButton text={mutation.data.brief} />
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// Week bucketing: ISO week-year string (e.g. "Week of Mon 4/21")
function weekStart(epoch: number): number {
  const d = new Date(epoch * 1000);
  // Snap to Monday in local/UTC terms. Use ET by computing in UTC then pulling back.
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const offset = day === 0 ? -6 : 1 - day; // shift to Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offset));
  return Math.floor(monday.getTime() / 1000);
}

function weekLabel(epoch: number): string {
  const d = new Date(epoch * 1000);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "numeric",
    day: "numeric",
  }).format(d);
}

function timeAgo(epoch: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function timeUntil(epoch: number): string {
  const s = Math.floor(epoch - Date.now() / 1000);
  if (s < 0) return `(past)`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}

export default function NewsPanel() {
  const { data, isLoading, isError } = useQuery<NewsResponse>({
    queryKey: ["/api/news"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/news");
      return r.json();
    },
    refetchInterval: 120_000,
    staleTime: 90_000,
  });

  const [topicFilter, setTopicFilter] = useState<NewsTopic | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!data) return [] as Headline[];
    let list = data.headlines;
    if (topicFilter) list = list.filter((h) => h.topics.includes(topicFilter));
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (h) =>
          h.title.toLowerCase().includes(q) ||
          h.summary.toLowerCase().includes(q) ||
          h.tickers.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [data, topicFilter, query]);

  if (isLoading && !data) {
    return (
      <Card data-testid="news-panel-loading">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Newspaper className="h-4 w-4 text-cyan-400" /> News & Calendar
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-96 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          News feed unavailable. Try again in a moment.
        </CardContent>
      </Card>
    );
  }

  return (
    <Tabs defaultValue="feed" className="w-full" data-testid="news-panel">
      <TabsList className="mb-3">
        <TabsTrigger value="feed" className="gap-1.5" data-testid="news-tab-feed">
          <Newspaper className="h-3.5 w-3.5" /> Feed
        </TabsTrigger>
        <TabsTrigger value="calendar" className="gap-1.5" data-testid="news-tab-calendar">
          <CalendarDays className="h-3.5 w-3.5" /> Calendar
          <Badge variant="outline" className="ml-1 border-amber-500/40 px-1 py-0 text-[8.5px] text-amber-300">
            {data.calendar.length}
          </Badge>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="feed" className="mt-0">
      <div className="mb-4">
        <AlphaCard headlines={data.headlines} />
      </div>
    <div className="grid gap-4 md:grid-cols-[1fr_360px]">
      {/* Left: headline feed */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Newspaper className="h-4 w-4 text-cyan-400" /> Headlines
              <Badge variant="outline" className="ml-1 border-cyan-500/40 text-[9px] text-cyan-300">
                {data.headlines.length} stories · refresh 2m
              </Badge>
            </CardTitle>
            <div className="text-[10px] text-muted-foreground">
              {new Date(data.asOf * 1000).toLocaleTimeString()}
            </div>
          </div>

          {/* Filters */}
          <div className="mt-2 flex flex-col gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-7 pl-7 text-xs"
                placeholder="Filter by ticker or keyword…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="news-search"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => setTopicFilter(null)}
                className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition ${topicFilter === null ? "border-foreground/60 bg-foreground/10 text-foreground" : "border-border/40 text-muted-foreground hover:text-foreground"}`}
                data-testid="topic-all"
              >
                ALL
              </button>
              {data.topics.map(({ topic, count }) => (
                <button
                  key={topic}
                  onClick={() => setTopicFilter(topicFilter === topic ? null : topic)}
                  className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition ${topicFilter === topic ? TOPIC_COLOR[topic] : "border-border/40 text-muted-foreground hover:text-foreground"}`}
                  data-testid={`topic-${topic}`}
                >
                  {topic} · {count}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {filtered.length === 0 ? (
            <div className="rounded-md border border-border/40 bg-muted/10 p-4 text-center text-sm text-muted-foreground">
              No stories match your filter.
            </div>
          ) : (
            filtered.map((h) => (
              <a
                key={h.id}
                href={h.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-md border border-border/40 bg-card/40 p-3 transition hover:border-cyan-500/40 hover:bg-card/80"
                data-testid={`headline-${h.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <div className="text-sm font-semibold leading-snug">{h.title}</div>
                    {h.summary && (
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{h.summary}</div>
                    )}
                  </div>
                  <ExternalLink className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground" />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[9px]">
                  <span className="font-semibold uppercase tracking-wider text-cyan-300">{h.source}</span>
                  <span className="text-muted-foreground">· {timeAgo(h.published)}</span>
                  {h.topics.map((t) => (
                    <span key={t} className={`rounded border px-1 py-0.5 font-semibold uppercase tracking-wider ${TOPIC_COLOR[t]}`}>
                      {t}
                    </span>
                  ))}
                  {h.tickers.slice(0, 4).map((t) => (
                    <span key={t} className="rounded border border-border/40 bg-muted/40 px-1 py-0.5 font-mono font-semibold tracking-wider text-foreground">
                      ${t}
                    </span>
                  ))}
                </div>
              </a>
            ))
          )}
        </CardContent>
      </Card>

      {/* Right: calendar */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CalendarDays className="h-4 w-4 text-amber-400" /> Calendar
              <Badge variant="outline" className="ml-1 border-amber-500/40 text-[9px] text-amber-300">
                {data.calendar.length} events
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {data.calendar.length === 0 ? (
              <div className="text-xs text-muted-foreground">No upcoming events.</div>
            ) : (
              data.calendar.map((e) => (
                <div
                  key={e.id}
                  className={`rounded-md border p-2 ${IMPORTANCE_COLOR[e.importance]}`}
                  data-testid={`cal-event-${e.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="text-xs font-semibold text-foreground">{e.title}</div>
                      <div className="text-[9px] text-muted-foreground">
                        {e.whenLabel} · {timeUntil(e.when)}
                      </div>
                    </div>
                    <Badge variant="outline" className={`text-[8px] ${IMPORTANCE_COLOR[e.importance]}`}>
                      {e.importance}
                    </Badge>
                  </div>
                  {(e.forecast || e.previous || e.actual) && (
                    <div className="mt-1 flex gap-2 text-[9px] text-muted-foreground">
                      {e.previous && <span>Prev: <span className="font-mono text-foreground">{e.previous}</span></span>}
                      {e.forecast && <span>Est: <span className="font-mono text-foreground">{e.forecast}</span></span>}
                      {e.actual && <span>Act: <span className="font-mono text-foreground">{e.actual}</span></span>}
                    </div>
                  )}
                  <div className="mt-0.5 text-[9px] text-muted-foreground">{e.source}</div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {data.warnings.length > 0 && (
          <Card>
            <CardContent className="flex items-start gap-2 p-3 text-[10px] text-amber-400/80">
              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
              <div>
                <div className="font-semibold">Feed warnings</div>
                {data.warnings.map((w, i) => (
                  <div key={i}>· {w}</div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
      </TabsContent>

      <TabsContent value="calendar" className="mt-0">
        <FullCalendar events={data.calendar} asOf={data.asOf} />
      </TabsContent>
    </Tabs>
  );
}

// ---- Full Calendar sub-tab ----
// Groups events by week, with kind filter chips (ECON / FED / OPEX / VIX EXP / TRIPLE WITCH / TREASURY / EARNINGS).
// Rich per-event card with importance coloring + forecast/prev/actual where present.

function FullCalendar({ events, asOf }: { events: CalendarEvent[]; asOf: number }) {
  const [kindFilter, setKindFilter] = useState<CalendarKind | null>(null);
  const [importanceFilter, setImportanceFilter] = useState<"HIGH" | "MED" | "ALL">("ALL");

  // Counts by kind for chip badges
  const kindCounts = useMemo(() => {
    const m = new Map<CalendarKind, number>();
    for (const e of events) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
    return m;
  }, [events]);

  // Filter + group by week
  const weeks = useMemo(() => {
    const filtered = events.filter((e) => {
      if (kindFilter && e.kind !== kindFilter) return false;
      if (importanceFilter === "HIGH" && e.importance !== "HIGH") return false;
      if (importanceFilter === "MED" && e.importance === "LOW") return false;
      return true;
    });
    const buckets = new Map<number, CalendarEvent[]>();
    for (const e of filtered) {
      const wk = weekStart(e.when);
      if (!buckets.has(wk)) buckets.set(wk, []);
      buckets.get(wk)!.push(e);
    }
    return Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([wk, list]) => ({
        week: wk,
        label: weekLabel(wk),
        events: list.sort((a, b) => a.when - b.when),
      }));
  }, [events, kindFilter, importanceFilter]);

  const kindsWithCounts: CalendarKind[] = ["ECON", "FED", "OPEX", "VIX_EXP", "WITCH", "TREASURY", "EARNINGS"];
  // vault aesthetic: override hover/default chip colors to gold trim
  // (KIND_COLOR uses slate defaults, we keep it so selected chips stay themed).
  void kindsWithCounts;

  return (
    <div className="vault-shell" data-testid="vault-calendar">
      <div className="vault-content p-4 md:p-6">
      <div className="mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CalendarDays className="h-5 w-5 text-[#d4af37]" />
            <div>
              <div
                className="vault-title text-2xl leading-none"
                data-testid="vault-title"
              >
                THE VAULT
              </div>
              <div className="mt-0.5 text-[10px] uppercase tracking-[0.25em] text-[#e6d388]/70">
                Full Market Calendar · {events.length} events · next 6 months
              </div>
            </div>
          </div>
          <div className="text-[10px] text-[#e6d388]/60">
            {new Date(asOf * 1000).toLocaleTimeString()}
          </div>
        </div>

        {/* Filters */}
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[9px] font-semibold uppercase tracking-wider text-[#e6d388]/70">
              Kind
            </span>
            <button
              onClick={() => setKindFilter(null)}
              className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition ${
                kindFilter === null
                  ? "border-foreground/60 bg-foreground/10 text-foreground"
                  : "border-border/40 text-muted-foreground hover:text-foreground"
              }`}
              data-testid="kind-all"
            >
              ALL · {events.length}
            </button>
            {kindsWithCounts.map((k) => {
              const n = kindCounts.get(k) ?? 0;
              if (n === 0) return null;
              return (
                <button
                  key={k}
                  onClick={() => setKindFilter(kindFilter === k ? null : k)}
                  className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition ${
                    kindFilter === k ? KIND_COLOR[k] : "border-border/40 text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid={`kind-${k}`}
                >
                  {KIND_LABEL[k]} · {n}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Importance
            </span>
            {(["ALL", "MED", "HIGH"] as const).map((imp) => (
              <button
                key={imp}
                onClick={() => setImportanceFilter(imp)}
                className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition ${
                  importanceFilter === imp
                    ? imp === "HIGH"
                      ? "border-rose-500/60 bg-rose-500/10 text-rose-300"
                      : imp === "MED"
                      ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
                      : "border-foreground/60 bg-foreground/10 text-foreground"
                    : "border-border/40 text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`imp-${imp}`}
              >
                {imp === "ALL" ? "ALL" : imp === "MED" ? "MED+" : "HIGH ONLY"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-5">
        {weeks.length === 0 ? (
          <div className="rounded-md border border-[#d4af37]/25 bg-black/30 p-6 text-center text-sm text-[#e6d388]/70">
            No events match your filters.
          </div>
        ) : (
          weeks.map(({ week, label, events: wkEvents }) => (
            <div key={week} data-testid={`week-${week}`}>
              <div className="mb-2 flex items-center gap-2 border-b border-[#d4af37]/25 pb-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#d4af37]">
                  Week of {label}
                </div>
                <div className="text-[9px] text-[#e6d388]/60">
                  {wkEvents.length} event{wkEvents.length !== 1 ? "s" : ""}
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {wkEvents.map((e) => {
                  const url = resolveEventUrl(e);
                  const bio = resolveEventBio(e);
                  return (
                    <a
                      key={e.id}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`vault-card group block rounded-md p-2.5 ${
                        e.importance === "HIGH" ? "!border-rose-500/50" : ""
                      }`}
                      data-testid={`cal-full-${e.id}`}
                      title={`Open source → ${url}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-1.5 text-[8.5px]">
                            <span className={`rounded border px-1 py-0.5 font-semibold uppercase tracking-wider ${KIND_COLOR[e.kind]}`}>
                              {KIND_LABEL[e.kind]}
                            </span>
                            {e.kind === "WITCH" && <Flame className="h-3 w-3 text-rose-400" />}
                            <ExternalLink className="ml-auto h-3 w-3 text-[#9eff2e]/60 transition group-hover:text-[#d4ff00]" />
                          </div>
                          <div className="mt-1 text-[12px] font-semibold leading-snug text-[#f2ffcc] group-hover:text-[#d4ff00]">
                            {e.title}
                          </div>
                          <div className="mt-0.5 text-[9.5px] text-[#adff2f]/70">
                            {e.whenLabel} · {timeUntil(e.when)}
                          </div>
                        </div>
                        <Badge variant="outline" className={`text-[8px] ${IMPORTANCE_COLOR[e.importance]}`}>
                          {e.importance}
                        </Badge>
                      </div>
                      {(e.forecast || e.previous || e.actual) && (
                        <div className="mt-1.5 flex flex-wrap gap-2 text-[9px] text-[#d4ff66]/80">
                          {e.previous && (
                            <span>
                              Prev: <span className="font-mono text-[#f2ffcc]">{e.previous}</span>
                            </span>
                          )}
                          {e.forecast && (
                            <span>
                              Est: <span className="font-mono text-[#f2ffcc]">{e.forecast}</span>
                            </span>
                          )}
                          {e.actual && (
                            <span>
                              Act: <span className="font-mono text-[#f2ffcc]">{e.actual}</span>
                            </span>
                          )}
                        </div>
                      )}
                      {e.notes && (
                        <div className="mt-1.5 text-[9.5px] italic text-[#adff2f]/60">
                          {e.notes}
                        </div>
                      )}
                      {/* Impact bio — how this event moves markets */}
                      <div
                        className="vault-bio mt-2 pt-1.5 text-[9.5px] leading-snug text-[#eaff66]/85"
                        data-testid={`cal-bio-${e.id}`}
                      >
                        <span className="mr-1 text-[8px] font-semibold uppercase tracking-[0.18em] text-[#39ff14]">
                          Market Impact
                        </span>
                        {bio}
                      </div>
                      <div className="mt-1.5 text-[8.5px] text-[#9eff2e]/55">
                        {e.source} · tap to open
                      </div>
                    </a>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
      </div>
    </div>
  );
}
