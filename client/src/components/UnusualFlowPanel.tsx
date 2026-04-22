// UnusualFlowPanel.tsx
// CBOE-derived unusual options flow for the active chart symbol.
// Mounted as a sub-view of the Chart tab (ViewMode: "flow").
//
// Features:
//   - Summary cards: flagged count, call/put $, net sentiment, top tag
//   - Expiry filter pills: ALL / 0DTE / THIS WEEK / NEXT WEEK / MONTHLY / QUARTERLY / LEAPS
//   - Sort controls: Notional / Expiry asc / Expiry desc / Strike asc / Volume / Vol/OI / %chg-mark
//   - Group by expiry toggle: collapsible sections per expiry date with subtotals
//   - Math transparency tooltips on column headers
//   - "NEW" badge for zero-OI opening positions (isNewStrike flag from server)
//   - Days-to-expiry chip next to expiry date

import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ChevronDown, ChevronRight, Flame, TrendingUp, TrendingDown, Zap, HelpCircle } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

type FlowTag = "ABOVE_ASK" | "AT_ASK" | "AT_BID" | "BELOW_BID" | "MID";
type FlowSentiment = "BULLISH" | "BEARISH" | "NEUTRAL";

interface UnusualContract {
  occ: string;
  type: "C" | "P";
  strike: number;
  expiration: string;
  dte: number;
  volume: number;
  openInterest: number;
  volOiRatio: number;
  isNewStrike?: boolean;
  bid: number;
  ask: number;
  last: number;
  mid: number;
  notional: number;
  iv: number;
  tag: FlowTag;
  sentiment: FlowSentiment;
}

interface UnusualResponse {
  provider: "cboe" | "schwab";
  symbol: string;
  spot: number | null;
  contracts: UnusualContract[];
  summary: {
    flaggedCount: number;
    callNotional: number;
    putNotional: number;
    callPutNotionalRatio: number | null;
    aboveAskNotional: number;
    belowBidNotional: number;
    netSentimentNotional: number;
    topTag: FlowTag | null;
  };
  asOf: number;
}

// ─── Sort & Filter types ─────────────────────────────────────────────────────

type SortKey = "notional" | "expiryAsc" | "expiryDesc" | "strikeAsc" | "volume" | "volOiRatio" | "midPct";
type ExpiryFilter = "ALL" | "0DTE" | "THIS_WEEK" | "NEXT_WEEK" | "MONTHLY" | "QUARTERLY" | "LEAPS";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "notional",   label: "Notional (default)" },
  { value: "expiryAsc",  label: "Expiry ↑ nearest first" },
  { value: "expiryDesc", label: "Expiry ↓ farthest first" },
  { value: "strikeAsc",  label: "Strike ascending" },
  { value: "volume",     label: "Volume" },
  { value: "volOiRatio", label: "Vol/OI ratio" },
  { value: "midPct",     label: "% chg / mark" },
];

const EXPIRY_FILTERS: { value: ExpiryFilter; label: string; desc: string }[] = [
  { value: "ALL",        label: "ALL",      desc: "All expirations" },
  { value: "0DTE",       label: "0DTE",     desc: "Expires today" },
  { value: "THIS_WEEK",  label: "THIS WK",  desc: "Within 5 business days" },
  { value: "NEXT_WEEK",  label: "NEXT WK",  desc: "6–10 business days" },
  { value: "MONTHLY",    label: "MONTHLY",  desc: "11–45 days (front-month)" },
  { value: "QUARTERLY",  label: "QTLY",     desc: "46–180 days" },
  { value: "LEAPS",      label: "LEAPS",    desc: ">180 days" },
];

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${v.toFixed(0)}`;
}

// Format expiry for group header: "May 16, 2026"
function fmtExpiryLong(expiration: string): string {
  const [y, mo, d] = expiration.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// Format expiry for table: "05/16"
function fmtExpiryShort(expiration: string): string {
  return expiration.slice(5);
}

// ─── Style helpers ────────────────────────────────────────────────────────────

function tagStyle(tag: FlowTag): { text: string; bg: string; border: string; label: string } {
  switch (tag) {
    case "ABOVE_ASK":
      return { text: "text-rose-300", bg: "bg-rose-500/15", border: "border-rose-500/50", label: "ABOVE ASK" };
    case "AT_ASK":
      return { text: "text-amber-300", bg: "bg-amber-500/15", border: "border-amber-500/40", label: "AT ASK" };
    case "AT_BID":
      return { text: "text-cyan-300", bg: "bg-cyan-500/15", border: "border-cyan-500/40", label: "AT BID" };
    case "BELOW_BID":
      return { text: "text-sky-300", bg: "bg-sky-500/15", border: "border-sky-500/50", label: "BELOW BID" };
    default:
      return { text: "text-muted-foreground", bg: "bg-muted/20", border: "border-border/40", label: "MID" };
  }
}

function sentStyle(s: FlowSentiment): string {
  if (s === "BULLISH") return "text-emerald-400";
  if (s === "BEARISH") return "text-rose-400";
  return "text-muted-foreground";
}

function typeStyle(t: "C" | "P"): string {
  return t === "C"
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    : "bg-rose-500/15 text-rose-300 border-rose-500/40";
}

// ─── Filtering ────────────────────────────────────────────────────────────────

/**
 * Business-day approximation: each calendar day after weekday = 1 bday.
 * For a simple DTE-based filter this is accurate enough.
 */
function dteToBdays(dte: number): number {
  // Rough: 5/7 of calendar days are business days
  return Math.round(dte * (5 / 7));
}

function filterByExpiry(contracts: UnusualContract[], filter: ExpiryFilter): UnusualContract[] {
  if (filter === "ALL") return contracts;
  return contracts.filter((c) => {
    const bdays = dteToBdays(c.dte);
    switch (filter) {
      case "0DTE":       return c.dte === 0;
      case "THIS_WEEK":  return bdays >= 1 && bdays <= 5;
      case "NEXT_WEEK":  return bdays >= 6 && bdays <= 10;
      case "MONTHLY":    return c.dte >= 11 && c.dte <= 45;
      case "QUARTERLY":  return c.dte >= 46 && c.dte <= 180;
      case "LEAPS":      return c.dte > 180;
      default:           return true;
    }
  });
}

// ─── Sorting ──────────────────────────────────────────────────────────────────

function sortContracts(contracts: UnusualContract[], key: SortKey): UnusualContract[] {
  const arr = [...contracts];
  switch (key) {
    case "notional":    return arr.sort((a, b) => b.notional - a.notional);
    case "expiryAsc":   return arr.sort((a, b) => a.expiration.localeCompare(b.expiration) || a.strike - b.strike);
    case "expiryDesc":  return arr.sort((a, b) => b.expiration.localeCompare(a.expiration) || a.strike - b.strike);
    case "strikeAsc":   return arr.sort((a, b) => a.strike - b.strike);
    case "volume":      return arr.sort((a, b) => b.volume - a.volume);
    case "volOiRatio":  return arr.sort((a, b) => {
      // isNewStrike (OI=0) sorts highest — they are definitively high ratio
      const aNew = a.isNewStrike ? 1 : 0;
      const bNew = b.isNewStrike ? 1 : 0;
      if (bNew !== aNew) return bNew - aNew;
      return b.volOiRatio - a.volOiRatio;
    });
    case "midPct":      return arr.sort((a, b) => {
      // % above/below theoretical mid as proxy for "aggressiveness"
      const pctA = a.bid > 0 ? (a.last - a.mid) / a.mid : 0;
      const pctB = b.bid > 0 ? (b.last - b.mid) / b.mid : 0;
      return Math.abs(pctB) - Math.abs(pctA);
    });
    default:            return arr;
  }
}

// ─── Group by expiry ──────────────────────────────────────────────────────────

interface ExpiryGroup {
  expiration: string;
  dte: number;
  contracts: UnusualContract[];
  totalNotional: number;
  callNotional: number;
  putNotional: number;
}

function groupByExpiry(contracts: UnusualContract[]): ExpiryGroup[] {
  const map = new Map<string, ExpiryGroup>();
  for (const c of contracts) {
    let g = map.get(c.expiration);
    if (!g) {
      g = { expiration: c.expiration, dte: c.dte, contracts: [], totalNotional: 0, callNotional: 0, putNotional: 0 };
      map.set(c.expiration, g);
    }
    g.contracts.push(c);
    g.totalNotional += c.notional;
    if (c.type === "C") g.callNotional += c.notional;
    else g.putNotional += c.notional;
  }
  // Sort groups chronologically
  return Array.from(map.values()).sort((a, b) => a.expiration.localeCompare(b.expiration));
}

// ─── Math tooltip helper ──────────────────────────────────────────────────────

function MathTip({ content, children }: { content: string; children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-help items-center gap-0.5">
            {children}
            <HelpCircle className="h-2.5 w-2.5 text-muted-foreground/60" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-[11px] leading-relaxed">
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ─── Contract row (shared) ────────────────────────────────────────────────────

function ContractRow({ c }: { c: UnusualContract }) {
  const ts = tagStyle(c.tag);
  return (
    <tr
      key={c.occ}
      className="border-b border-border/20 last:border-b-0 hover:bg-muted/10"
      data-testid={`flow-row-${c.occ}`}
    >
      {/* Time stub — CBOE chain doesn't carry per-contract time; show expiry short */}
      <td className="px-2 py-1.5 text-[10px] text-muted-foreground font-mono">
        {fmtExpiryShort(c.expiration)}
      </td>
      <td className="px-2 py-1.5">
        <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-semibold ${typeStyle(c.type)}`}>
          {c.type === "C" ? "CALL" : "PUT"}
        </span>
      </td>
      <td className="px-2 py-1.5 font-semibold font-mono tabular-nums">
        {c.strike >= 100 ? c.strike.toFixed(2) : c.strike.toFixed(2)}
      </td>
      <td className="px-2 py-1.5">
        <span className="text-[10px] text-muted-foreground font-mono">
          {fmtExpiryShort(c.expiration)}
        </span>
        <span className="ml-1 inline-block rounded bg-muted/40 px-1 py-0.5 text-[9px] text-muted-foreground">
          {c.dte}d
        </span>
      </td>
      {/* Side */}
      <td className="px-2 py-1.5">
        <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-semibold ${ts.border} ${ts.bg} ${ts.text}`}>
          {ts.label}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtNum(c.volume)}</td>
      <td className="px-2 py-1.5 text-right text-muted-foreground font-mono tabular-nums">{fmtNum(c.openInterest)}</td>
      <td className="px-2 py-1.5 text-right text-amber-300 font-mono tabular-nums">
        {c.isNewStrike ? (
          <span className="inline-block rounded bg-violet-500/20 border border-violet-500/40 px-1.5 py-0.5 text-[9px] text-violet-300 font-semibold">
            NEW
          </span>
        ) : (
          `${c.volOiRatio.toFixed(1)}×`
        )}
      </td>
      <td className="px-2 py-1.5 text-right text-muted-foreground font-mono tabular-nums text-[10px]">
        {c.bid.toFixed(2)}×{c.ask.toFixed(2)}
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{c.last > 0 ? c.last.toFixed(2) : "—"}</td>
      <td className="px-2 py-1.5 text-right text-muted-foreground font-mono tabular-nums">
        {c.iv > 0 ? `${(c.iv * 100).toFixed(0)}%` : "—"}
      </td>
      <td className="px-2 py-1.5 text-right font-semibold text-foreground font-mono tabular-nums">
        {fmtMoney(c.notional)}
      </td>
      <td className={`px-2 py-1.5 font-semibold ${sentStyle(c.sentiment)}`}>
        {c.sentiment === "BULLISH" ? (
          <span className="inline-flex items-center gap-1">
            <Zap className="h-2.5 w-2.5" /> BULL
          </span>
        ) : c.sentiment === "BEARISH" ? (
          <span className="inline-flex items-center gap-1">
            <Zap className="h-2.5 w-2.5" /> BEAR
          </span>
        ) : (
          "NEUT"
        )}
      </td>
    </tr>
  );
}

// ─── Table headers ────────────────────────────────────────────────────────────

function TableHead() {
  return (
    <thead className="border-b border-border/40 bg-muted/20 sticky top-0 z-10">
      <tr className="text-left text-[9px] uppercase tracking-wider text-muted-foreground">
        <th className="px-2 py-1.5">Time</th>
        <th className="px-2 py-1.5">Type</th>
        <th className="px-2 py-1.5">
          <MathTip content="Strike price of the option contract (in $).">Strike</MathTip>
        </th>
        <th className="px-2 py-1.5">
          <MathTip content="Expiration date · days-to-expiry chip shows calendar days remaining.">
            Expiry
          </MathTip>
        </th>
        <th className="px-2 py-1.5">Side</th>
        <th className="px-2 py-1.5 text-right">Vol</th>
        <th className="px-2 py-1.5 text-right">OI</th>
        <th className="px-2 py-1.5 text-right">
          <MathTip content="Vol/OI ratio: Volume ÷ Open Interest. Ratio ≥ 2× flags unusual positioning (fresh money, not existing OI). 'NEW' = OI is zero — brand-new opening position.">
            Vol/OI
          </MathTip>
        </th>
        <th className="px-2 py-1.5 text-right">
          <MathTip content="Bid × Ask market. Mid price = last if it falls in the spread, else (bid+ask)/2.">
            Bid×Ask
          </MathTip>
        </th>
        <th className="px-2 py-1.5 text-right">Last</th>
        <th className="px-2 py-1.5 text-right">IV</th>
        <th className="px-2 py-1.5 text-right">
          <MathTip content="Notional = Volume × Mid Price × 100. The ×100 is the OCC standard contract multiplier (1 equity option = 100 shares). Mid price uses last-trade if it falls inside the spread, otherwise (bid+ask)/2.">
            Notional
          </MathTip>
        </th>
        <th className="px-2 py-1.5">Sentiment</th>
      </tr>
    </thead>
  );
}

// ─── Grouped view ─────────────────────────────────────────────────────────────

function GroupedTable({ groups, sortKey }: { groups: ExpiryGroup[]; sortKey: SortKey }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = useCallback((exp: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(exp)) next.delete(exp);
      else next.add(exp);
      return next;
    });
  }, []);

  return (
    <div className="overflow-x-auto rounded-md border border-border/40">
      <table className="w-full text-[11px]">
        <TableHead />
        <tbody className="font-mono tabular-nums">
          {groups.map((g) => {
            const isOpen = !collapsed.has(g.expiration);
            const sorted = sortContracts(g.contracts, sortKey);
            return (
              <>
                {/* Group header row */}
                <tr
                  key={`grp-${g.expiration}`}
                  className="cursor-pointer border-b border-border/40 bg-muted/30 hover:bg-muted/50"
                  onClick={() => toggle(g.expiration)}
                  data-testid={`expiry-group-${g.expiration}`}
                >
                  <td colSpan={13} className="px-2 py-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {isOpen ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        )}
                        <span className="font-semibold text-foreground text-[11px]">
                          {fmtExpiryLong(g.expiration)}
                        </span>
                        <span className="inline-block rounded bg-muted/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                          {g.dte}d
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {g.contracts.length} contract{g.contracts.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-[10px]">
                        <span className="text-muted-foreground">
                          Total <span className="font-semibold text-foreground">{fmtMoney(g.totalNotional)}</span>
                        </span>
                        <span className="text-emerald-300">C {fmtMoney(g.callNotional)}</span>
                        <span className="text-rose-300">P {fmtMoney(g.putNotional)}</span>
                      </div>
                    </div>
                  </td>
                </tr>
                {/* Contract rows */}
                {isOpen && sorted.map((c) => <ContractRow key={c.occ} c={c} />)}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Flat table view ──────────────────────────────────────────────────────────

function FlatTable({ contracts }: { contracts: UnusualContract[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border/40">
      <table className="w-full text-[11px]">
        <TableHead />
        <tbody className="font-mono tabular-nums">
          {contracts.map((c) => <ContractRow key={c.occ} c={c} />)}
        </tbody>
      </table>
    </div>
  );
}

// ─── Props & main export ──────────────────────────────────────────────────────

interface Props {
  symbol: string;
}

export default function UnusualFlowPanel({ symbol }: Props) {
  const sym = symbol.toUpperCase();

  // Controls
  const [sortKey, setSortKey] = useState<SortKey>("notional");
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>("ALL");
  const [groupByExp, setGroupByExp] = useState(false);

  const { data, isLoading, isError } = useQuery<UnusualResponse>({
    queryKey: ["/api/flow/unusual", sym],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/flow/unusual?symbol=${encodeURIComponent(sym)}`);
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 50_000,
  });

  // Filtered + sorted contracts
  const processedContracts = useMemo(() => {
    if (!data?.contracts) return [];
    const filtered = filterByExpiry(data.contracts, expiryFilter);
    return sortContracts(filtered, sortKey);
  }, [data, expiryFilter, sortKey]);

  const expGroups = useMemo(() => groupByExpiry(processedContracts), [processedContracts]);

  if (isLoading && !data) {
    return (
      <Card data-testid="unusual-flow-panel-loading">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Flame className="h-4 w-4 text-amber-400" /> Unusual Options Flow — {sym}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Unusual flow unavailable for {sym}. The CBOE chain may not cover this symbol.
        </CardContent>
      </Card>
    );
  }

  const s = data.summary;
  const callPutRatio = s.callPutNotionalRatio;
  const leaning: "CALLS" | "PUTS" | "BALANCED" =
    s.callNotional > s.putNotional * 1.25 ? "CALLS" : s.putNotional > s.callNotional * 1.25 ? "PUTS" : "BALANCED";
  const netBias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    s.netSentimentNotional > 0 ? "BULLISH" : s.netSentimentNotional < 0 ? "BEARISH" : "NEUTRAL";

  return (
    <Card data-testid="unusual-flow-panel">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Flame className="h-4 w-4 text-amber-400" /> Unusual Options Flow — {sym}
            <Badge variant="outline" className="ml-1 border-amber-500/40 text-[9px] text-amber-300">
              {data.provider.toUpperCase()} · {data.provider === "cboe" ? "15m delayed" : "real-time"}
            </Badge>
          </CardTitle>
          <div className="text-[10px] text-muted-foreground">
            {data.spot != null && <>Spot {data.spot.toFixed(2)} · </>}
            {new Date(data.asOf * 1000).toLocaleTimeString()}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary row */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="rounded-md border border-border/40 bg-card/40 p-3">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Flagged contracts</div>
            <div className="mt-0.5 font-mono text-lg font-bold tabular-nums">{s.flaggedCount}</div>
            <div className="text-[9px] text-muted-foreground">Vol/OI ≥ 2 · $ ≥ 25K</div>
          </div>
          <div className={`rounded-md border p-3 ${leaning === "CALLS" ? "border-emerald-500/50 bg-emerald-500/10" : leaning === "PUTS" ? "border-rose-500/50 bg-rose-500/10" : "border-border/40 bg-card/40"}`}>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Call / Put $</div>
            <div className="mt-0.5 flex items-baseline gap-2 font-mono text-sm tabular-nums">
              <span className="text-emerald-300">{fmtMoney(s.callNotional)}</span>
              <span className="text-muted-foreground">/</span>
              <span className="text-rose-300">{fmtMoney(s.putNotional)}</span>
            </div>
            <div className="text-[9px] text-muted-foreground">
              P/C $ ratio {callPutRatio != null ? callPutRatio.toFixed(2) : "—"} · {leaning}
            </div>
          </div>
          <div className={`rounded-md border p-3 ${netBias === "BULLISH" ? "border-emerald-500/50 bg-emerald-500/10" : netBias === "BEARISH" ? "border-rose-500/50 bg-rose-500/10" : "border-border/40 bg-card/40"}`}>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Net sentiment $</div>
            <div className={`mt-0.5 flex items-center gap-1 font-mono text-lg font-bold tabular-nums ${netBias === "BULLISH" ? "text-emerald-300" : netBias === "BEARISH" ? "text-rose-300" : "text-muted-foreground"}`}>
              {netBias === "BULLISH" ? <TrendingUp className="h-4 w-4" /> : netBias === "BEARISH" ? <TrendingDown className="h-4 w-4" /> : null}
              {s.netSentimentNotional >= 0 ? "+" : ""}
              {fmtMoney(s.netSentimentNotional)}
            </div>
            <div className="text-[9px] text-muted-foreground">Tape-side × call/put</div>
          </div>
          <div className="rounded-md border border-border/40 bg-card/40 p-3">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Above ask / Below bid</div>
            <div className="mt-0.5 flex items-baseline gap-2 font-mono text-sm tabular-nums">
              <span className="text-rose-300">{fmtMoney(s.aboveAskNotional)}</span>
              <span className="text-muted-foreground">/</span>
              <span className="text-sky-300">{fmtMoney(s.belowBidNotional)}</span>
            </div>
            <div className="text-[9px] text-muted-foreground">
              Top tag: {s.topTag ? tagStyle(s.topTag).label : "—"}
            </div>
          </div>
        </div>

        {/* ── Controls row ───────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Expiry filter pills */}
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label="Filter by expiry bucket"
            data-testid="expiry-filter-pills"
          >
            {EXPIRY_FILTERS.map((f) => (
              <TooltipProvider key={f.value}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-colors ${
                        expiryFilter === f.value
                          ? "border-primary bg-primary/20 text-primary"
                          : "border-border/40 bg-muted/10 text-muted-foreground hover:border-border hover:text-foreground"
                      }`}
                      onClick={() => setExpiryFilter(f.value)}
                      data-testid={`pill-expiry-${f.value}`}
                      aria-pressed={expiryFilter === f.value}
                    >
                      {f.label}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-[11px]">
                    {f.desc}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ))}
          </div>

          {/* Sort dropdown — collapses cleanly on mobile */}
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-[10px] text-muted-foreground hidden sm:inline">Sort</span>
            <Select
              value={sortKey}
              onValueChange={(v) => setSortKey(v as SortKey)}
            >
              <SelectTrigger
                className="h-7 w-44 text-[11px]"
                data-testid="sort-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-[11px]">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Group by expiry toggle */}
            <div className="flex items-center gap-1.5 rounded-md border border-border/40 bg-muted/10 px-2.5 py-1">
              <Checkbox
                id="group-by-exp"
                checked={groupByExp}
                onCheckedChange={(v) => setGroupByExp(!!v)}
                className="h-3.5 w-3.5"
                data-testid="checkbox-group-by-expiry"
              />
              <Label htmlFor="group-by-exp" className="cursor-pointer text-[10px] text-muted-foreground">
                Group by expiry
              </Label>
            </div>
          </div>
        </div>

        {/* Filtered count note */}
        {expiryFilter !== "ALL" && (
          <div className="text-[10px] text-muted-foreground">
            Showing {processedContracts.length} of {data.contracts.length} contracts ·{" "}
            {EXPIRY_FILTERS.find((f) => f.value === expiryFilter)?.desc}
          </div>
        )}

        {/* Contracts table */}
        {processedContracts.length === 0 ? (
          <div className="rounded-md border border-border/40 bg-muted/10 p-4 text-center text-sm text-muted-foreground">
            No unusual flow matching <strong>{EXPIRY_FILTERS.find((f) => f.value === expiryFilter)?.label}</strong>{" "}
            filter for {sym}. Try "ALL" or another expiry bucket.
          </div>
        ) : groupByExp ? (
          <GroupedTable groups={expGroups} sortKey={sortKey} />
        ) : (
          <FlatTable contracts={processedContracts} />
        )}

        <div className="text-[9px] text-muted-foreground space-y-0.5">
          <div>
            Flagged when volume ≥ 100 AND (volume/OI ≥ 2× OR OI=0 new-strike) AND notional ≥ $25K AND DTE ≤ 90.
            Tape-side inferred from last-trade vs bid/ask. "NEW" = zero open interest (brand-new positioning).
          </div>
          <div>
            Mid price = last-trade if it falls inside the bid-ask spread, else (bid+ask)/2.
            Notional = volume × mid × 100 (OCC contract multiplier).
          </div>
          {data.provider === "cboe" && (
            <div>CBOE data is 15-min delayed — Schwab integration will enable true real-time tape.</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
