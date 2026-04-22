import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ExternalLink, CheckCircle2, AlertTriangle, HelpCircle, ArrowUpRight, ArrowDownRight,
  Minus, Users, Heart, Repeat2, MessageCircle, Eye,
} from "lucide-react";

type VoiceMeta = {
  handle: string; name: string; weight: number; tags: string[]; bio: string; xUrl: string;
  lastTweetedAt?: string;
};

type FactCheck = { verdict: "consistent" | "conflicting" | "unverified"; note: string };

type VoiceItem = {
  voice: string;
  handle: string;
  weight: number;
  title: string;
  summary: string;
  source: string;
  url: string;
  published: string;
  dataScore: number;
  sentiment: "bull" | "bear" | "neutral";
  topics: string[];
  claims: string[];
  factCheck?: FactCheck;
  native?: "x";
  tweet?: {
    id: string;
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    impressions: number;
  };
};

type VoicesResponse = {
  voices: VoiceMeta[];
  items: VoiceItem[];
  liveMetrics: { vix: number; vvix: number; spy: number; skew: number; pcr: number };
  xEnabled?: boolean;
  voicesBias?: { score: number; sampleSize: number };
  capturedAt: number;
};

type SortMode = "data" | "recent" | "score";
type FilterMode = "all" | "bull" | "bear" | "data-rich" | "checked" | "tweets";

function formatCount(n: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "K";
  if (n < 1_000_000) return Math.round(n / 1000) + "K";
  return (n / 1_000_000).toFixed(1) + "M";
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.max(1, Math.floor(diff / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function SentimentChip({ s }: { s: "bull" | "bear" | "neutral" }) {
  if (s === "bull") return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400" data-testid={`chip-sentiment-${s}`}>
      <ArrowUpRight className="h-3 w-3" /> bullish
    </span>
  );
  if (s === "bear") return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400" data-testid={`chip-sentiment-${s}`}>
      <ArrowDownRight className="h-3 w-3" /> bearish
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground" data-testid={`chip-sentiment-${s}`}>
      <Minus className="h-3 w-3" /> neutral
    </span>
  );
}

function FactCheckBadge({ fc }: { fc?: FactCheck }) {
  if (!fc) return null;
  if (fc.verdict === "consistent") return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400" title={fc.note} data-testid="fact-consistent">
      <CheckCircle2 className="h-3 w-3" /> live-consistent
    </span>
  );
  if (fc.verdict === "conflicting") return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400" title={fc.note} data-testid="fact-conflicting">
      <AlertTriangle className="h-3 w-3" /> conflicts with live data
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground" title={fc.note} data-testid="fact-unverified">
      <HelpCircle className="h-3 w-3" /> unverified
    </span>
  );
}

function DataScoreBar({ score }: { score: number }) {
  const color = score >= 50 ? "bg-emerald-500" : score >= 25 ? "bg-amber-500" : "bg-muted-foreground/40";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, score)}%` }} />
      </div>
      <span className="font-mono text-[10px] text-muted-foreground">{score}</span>
    </div>
  );
}

export default function VoicesPanel() {
  const { data, isLoading, isError, error } = useQuery<VoicesResponse>({
    queryKey: ["/api/voices"],
    refetchInterval: 5 * 60_000, // 5 min
    staleTime: 2 * 60_000,
  });

  const [sortMode, setSortMode] = useState<SortMode>("data");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);

  const items = useMemo(() => {
    if (!data) return [];
    let rows = data.items.slice();
    if (selectedVoice) rows = rows.filter(i => i.handle === selectedVoice);
    if (filter === "bull") rows = rows.filter(i => i.sentiment === "bull");
    else if (filter === "bear") rows = rows.filter(i => i.sentiment === "bear");
    else if (filter === "data-rich") rows = rows.filter(i => i.dataScore >= 25);
    else if (filter === "checked") rows = rows.filter(i => i.factCheck && i.factCheck.verdict !== "unverified");
    else if (filter === "tweets") rows = rows.filter(i => i.native === "x");

    if (sortMode === "data") {
      rows.sort((a, b) => (b.dataScore - a.dataScore) || (new Date(b.published).getTime() - new Date(a.published).getTime()));
    } else if (sortMode === "recent") {
      rows.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());
    } else if (sortMode === "score") {
      rows.sort((a, b) => (b.dataScore * b.weight) - (a.dataScore * a.weight));
    }
    return rows;
  }, [data, sortMode, filter, selectedVoice]);

  // Aggregate sentiment
  const aggregate = useMemo(() => {
    if (!data) return null;
    let bull = 0, bear = 0, neu = 0, weighted = 0, totalW = 0;
    for (const it of data.items) {
      if (it.sentiment === "bull") { bull++; weighted += it.weight * it.dataScore; }
      else if (it.sentiment === "bear") { bear++; weighted -= it.weight * it.dataScore; }
      else neu++;
      totalW += it.weight * Math.max(1, it.dataScore);
    }
    const total = bull + bear + neu;
    // Normalize weighted to -100..+100
    const net = totalW > 0 ? Math.max(-100, Math.min(100, (weighted / totalW) * 100)) : 0;
    return { bull, bear, neu, total, net };
  }, [data]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          Couldn't load voices. {(error as Error)?.message}
        </CardContent>
      </Card>
    );
  }

  const netLabel = aggregate ? (aggregate.net > 10 ? "Net Bullish" : aggregate.net < -10 ? "Net Bearish" : "Mixed") : "—";
  const netColor = aggregate && aggregate.net > 10 ? "text-emerald-400" : aggregate && aggregate.net < -10 ? "text-red-400" : "text-muted-foreground";

  return (
    <div className="space-y-6">
      {/* Aggregate header */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-4" data-testid="card-voice-aggregate">
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> Curated Analyst Consensus
            </div>
            <div className={`mt-2 text-3xl font-semibold ${netColor}`} data-testid="text-voice-consensus">{netLabel}</div>
            {aggregate && (
              <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-md bg-emerald-500/10 p-2">
                  <div className="font-mono text-lg text-emerald-400">{aggregate.bull}</div>
                  <div className="text-[10px] uppercase text-muted-foreground">bullish</div>
                </div>
                <div className="rounded-md bg-muted p-2">
                  <div className="font-mono text-lg">{aggregate.neu}</div>
                  <div className="text-[10px] uppercase text-muted-foreground">neutral</div>
                </div>
                <div className="rounded-md bg-red-500/10 p-2">
                  <div className="font-mono text-lg text-red-400">{aggregate.bear}</div>
                  <div className="text-[10px] uppercase text-muted-foreground">bearish</div>
                </div>
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Weighted by analyst credibility × post data-density. {data.items.length} items scanned; fact-checked against live VIX {data.liveMetrics.vix?.toFixed(2)}, SPY ${data.liveMetrics.spy?.toFixed(2)}.
              {data.xEnabled && <span className="ml-1 rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary" data-testid="badge-x-live">X live</span>}
            </p>
          </CardContent>
        </Card>

        {/* Voice roster */}
        <Card className="lg:col-span-8" data-testid="card-voice-roster">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Tracked Voices</div>
              {selectedVoice && (
                <Button variant="ghost" size="sm" onClick={() => setSelectedVoice(null)} data-testid="button-clear-voice">
                  Clear filter
                </Button>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
              {data.voices.map(v => {
                const itemsByV = data.items.filter(i => i.handle === v.handle);
                const top = itemsByV[0];
                const active = selectedVoice === v.handle;
                return (
                  <button
                    key={v.handle}
                    onClick={() => setSelectedVoice(active ? null : v.handle)}
                    className={`rounded-md border p-2 text-left transition hover-elevate active-elevate-2 ${active ? "border-primary bg-primary/5" : "border-border"}`}
                    data-testid={`chip-voice-${v.handle}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="truncate text-xs font-semibold">{v.name}</div>
                      <span className="font-mono text-[9px] text-muted-foreground">{Math.round(v.weight * 100)}%</span>
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">@{v.handle}</div>
                    <div className="mt-1 flex items-center justify-between gap-1">
                      {top ? <SentimentChip s={top.sentiment} /> : <span className="text-[9px] text-muted-foreground">—</span>}
                      {v.lastTweetedAt && (
                        <span className="font-mono text-[9px] text-muted-foreground" title={`Last tweet ${new Date(v.lastTweetedAt).toLocaleString()}`}>{timeAgo(v.lastTweetedAt)}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sort/Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-border p-1">
          <span className="px-2 text-[10px] uppercase text-muted-foreground">Sort</span>
          {(["data", "recent", "score"] as SortMode[]).map(m => (
            <Button
              key={m}
              variant={sortMode === m ? "default" : "ghost"}
              size="sm"
              onClick={() => setSortMode(m)}
              data-testid={`button-sort-${m}`}
              className="h-7 px-2 text-xs"
            >
              {m === "data" ? "Data-richness" : m === "recent" ? "Most recent" : "Weighted score"}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-1">
          <span className="px-2 text-[10px] uppercase text-muted-foreground">Filter</span>
          {(["all", "tweets", "bull", "bear", "data-rich", "checked"] as FilterMode[]).map(f => (
            <Button
              key={f}
              variant={filter === f ? "default" : "ghost"}
              size="sm"
              onClick={() => setFilter(f)}
              data-testid={`button-filter-${f}`}
              className="h-7 px-2 text-xs"
            >
              {f === "all" ? "All" : f === "tweets" ? "X posts" : f === "bull" ? "Bullish" : f === "bear" ? "Bearish" : f === "data-rich" ? "Data-rich" : "Fact-checkable"}
            </Button>
          ))}
        </div>
        <div className="text-xs text-muted-foreground">{items.length} items</div>
      </div>

      {/* Items list */}
      <div className="space-y-3" data-testid="list-voice-items">
        {items.length === 0 && (
          <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">No items match the current filter.</CardContent></Card>
        )}
        {items.map((it, idx) => {
          const isTweet = it.native === "x";
          return (
            <Card
              key={`${it.url}-${idx}`}
              className={`hover-elevate ${isTweet ? "border-l-2 border-l-primary/60" : ""}`}
              data-testid={`item-voice-${idx}`}
            >
              <CardContent className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-semibold text-foreground">{it.voice}</span>
                      <span>@{it.handle}</span>
                      {isTweet && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary" data-testid={`chip-native-x-${idx}`}>
                          native post
                        </span>
                      )}
                      <SentimentChip s={it.sentiment} />
                      <FactCheckBadge fc={it.factCheck} />
                      <span>·</span>
                      <span>{timeAgo(it.published)}</span>
                      <span>·</span>
                      <span className="truncate">{it.source}</span>
                    </div>
                    {isTweet && it.tweet ? (
                      <a
                        href={it.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 block rounded-md border border-border/60 bg-muted/20 p-3 text-[13px] leading-relaxed hover:bg-muted/40"
                        data-testid={`link-voice-${idx}`}
                      >
                        <p className="whitespace-pre-wrap text-foreground">{it.summary}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                          <span className="inline-flex items-center gap-1"><Heart className="h-3 w-3" /> {formatCount(it.tweet.likes)}</span>
                          <span className="inline-flex items-center gap-1"><Repeat2 className="h-3 w-3" /> {formatCount(it.tweet.retweets)}</span>
                          <span className="inline-flex items-center gap-1"><MessageCircle className="h-3 w-3" /> {formatCount(it.tweet.replies)}</span>
                          {it.tweet.impressions > 0 && (
                            <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" /> {formatCount(it.tweet.impressions)}</span>
                          )}
                        </div>
                      </a>
                    ) : (
                      <>
                        <a
                          href={it.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 block font-medium hover:underline"
                          data-testid={`link-voice-${idx}`}
                        >
                          {it.title}
                        </a>
                        {it.summary && (
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{it.summary}</p>
                        )}
                      </>
                    )}
                    {(it.claims.length > 0 || it.topics.length > 0) && (
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {it.topics.slice(0, 5).map(t => (
                          <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                        ))}
                        {it.claims.slice(0, 3).map(c => (
                          <span key={c} className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{c}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <DataScoreBar score={it.dataScore} />
                    <a href={it.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-center text-[11px] text-muted-foreground">
        Feeds aggregated from Google News, Substack, podcast RSS{data.xEnabled ? ", and native X posts via the X API v2" : " — X timelines require API auth"}.
        Data-richness = tickers + numeric claims + market keywords{data.xEnabled ? " + engagement" : ""}. Fact-check compares numeric claims to live VIX/VVIX/SPY/SKEW/PCR.
      </p>
    </div>
  );
}
