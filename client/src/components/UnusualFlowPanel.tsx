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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDown, ChevronRight, Flame, TrendingUp, TrendingDown, Zap, HelpCircle, X, ArrowDown, ArrowUp, ChevronsUpDown, Clock, Activity, Layers } from "lucide-react";
import TrackButton from "@/components/signals/TrackButton";

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
  /** Optional human-readable note (e.g. "CBOE rate-limited — using Schwab fallback"). */
  note?: string;
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

type SortKey = "notional" | "expiryAsc" | "expiryDesc" | "strikeAsc" | "strikeDesc" | "volume" | "volOiRatio" | "midPct" | "lastDesc" | "ivDesc" | "sideAsc" | "typeAsc";
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
    case "strikeDesc":  return arr.sort((a, b) => b.strike - a.strike);
    case "volume":      return arr.sort((a, b) => b.volume - a.volume);
    case "lastDesc":    return arr.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
    case "ivDesc":      return arr.sort((a, b) => (b.iv ?? 0) - (a.iv ?? 0));
    case "sideAsc":     return arr.sort((a, b) => a.tag.localeCompare(b.tag));
    case "typeAsc":     return arr.sort((a, b) => a.type.localeCompare(b.type) || b.notional - a.notional);
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

// ─── Build view: aggregate by strike + side ──────────────────────────────────
//
// Groups individual prints into a cumulative picture of where size is loading.
// Each row is a unique (strike, type, expiration) bucket showing:
//   - total premium $ across all prints
//   - total volume
//   - number of prints
//   - average fill price
//   - dominant tape side (most frequent tag weighted by premium)
//   - net sentiment (bullish $ − bearish $ within the bucket)
//
// Sorted by total premium descending so the heaviest accumulation floats to top.
// Eye tracking: rows don't jump around — the same 7140C row stays in roughly
// the same place, just with updated numbers.

interface BuildRow {
  key: string;          // `${strike}-${type}-${expiration}`
  strike: number;
  type: "C" | "P";
  expiration: string;
  dte: number;
  totalPremium: number;
  totalVolume: number;
  printCount: number;
  avgPrice: number;
  openInterest: number;
  volOiRatio: number;
  isNewStrike: boolean;
  dominantTag: FlowTag;
  netSentiment: number; // bullish $ − bearish $ in this bucket
}

function aggregateByStrike(contracts: UnusualContract[]): BuildRow[] {
  const map = new Map<string, {
    strike: number; type: "C" | "P"; expiration: string; dte: number;
    premiumSum: number; volumeSum: number; priceWeightSum: number; printCount: number;
    openInterest: number; volOiRatio: number; isNewStrike: boolean;
    tagPremium: Record<FlowTag, number>;
    bullPremium: number; bearPremium: number;
  }>();

  for (const c of contracts) {
    const key = `${c.strike}-${c.type}-${c.expiration}`;
    let b = map.get(key);
    if (!b) {
      b = {
        strike: c.strike, type: c.type, expiration: c.expiration, dte: c.dte,
        premiumSum: 0, volumeSum: 0, priceWeightSum: 0, printCount: 0,
        openInterest: c.openInterest, volOiRatio: c.volOiRatio, isNewStrike: !!c.isNewStrike,
        tagPremium: { ABOVE_ASK: 0, AT_ASK: 0, AT_BID: 0, BELOW_BID: 0, MID: 0 },
        bullPremium: 0, bearPremium: 0,
      };
      map.set(key, b);
    }
    b.premiumSum += c.notional;
    b.volumeSum += c.volume;
    b.priceWeightSum += (c.last > 0 ? c.last : c.mid) * c.volume;
    b.printCount += 1;
    b.tagPremium[c.tag] += c.notional;
    if (c.sentiment === "BULLISH") b.bullPremium += c.notional;
    else if (c.sentiment === "BEARISH") b.bearPremium += c.notional;
    // Prefer the latest OI snapshot (contracts are same-key so usually identical)
    b.openInterest = c.openInterest;
    b.volOiRatio = c.volOiRatio;
    b.isNewStrike = !!c.isNewStrike;
  }

  return Array.from(map.entries()).map(([key, b]) => {
    // Premium-weighted dominant tape side
    let dominantTag: FlowTag = "MID";
    let dominantPremium = 0;
    for (const [tag, prem] of Object.entries(b.tagPremium) as [FlowTag, number][]) {
      if (prem > dominantPremium) { dominantPremium = prem; dominantTag = tag; }
    }
    const avgPrice = b.volumeSum > 0 ? b.priceWeightSum / b.volumeSum : 0;
    return {
      key,
      strike: b.strike,
      type: b.type,
      expiration: b.expiration,
      dte: b.dte,
      totalPremium: b.premiumSum,
      totalVolume: b.volumeSum,
      printCount: b.printCount,
      avgPrice,
      openInterest: b.openInterest,
      volOiRatio: b.volOiRatio,
      isNewStrike: b.isNewStrike,
      dominantTag,
      netSentiment: b.bullPremium - b.bearPremium,
    };
  }).sort((a, b) => b.totalPremium - a.totalPremium);
}

// Map total premium to a bar-width percentage relative to the biggest row.
function premiumBarPct(row: BuildRow, maxPremium: number): number {
  if (maxPremium <= 0) return 0;
  return Math.min(100, (row.totalPremium / maxPremium) * 100);
}

function BuildTable({ rows, onRowClick }: {
  rows: BuildRow[];
  onRowClick: (row: BuildRow) => void;
}) {
  const maxPremium = rows.length > 0 ? rows[0].totalPremium : 0;
  return (
    <div className="overflow-x-auto rounded-md border border-border/40">
      <table className="w-full text-[11px]">
        <thead className="border-b border-border/40 bg-muted/20 sticky top-0 z-10">
          <tr className="text-left text-[9px] uppercase tracking-wider text-muted-foreground">
            <th className="px-2 py-1.5">Type</th>
            <th className="px-2 py-1.5">Strike</th>
            <th className="px-2 py-1.5">Expiry</th>
            <th className="px-2 py-1.5 text-right">
              <MathTip content="Total premium $ built up on this strike-side across all prints in the current window. This is the 'where size is loading' signal.">Built $</MathTip>
            </th>
            <th className="px-2 py-1.5 text-right">Vol</th>
            <th className="px-2 py-1.5 text-right">
              <MathTip content="Number of individual prints that hit this strike-side.">Prints</MathTip>
            </th>
            <th className="px-2 py-1.5 text-right">
              <MathTip content="Volume-weighted average fill price across all prints in this bucket.">Avg fill</MathTip>
            </th>
            <th className="px-2 py-1.5 text-right">OI</th>
            <th className="px-2 py-1.5 text-right">Vol/OI</th>
            <th className="px-2 py-1.5">
              <MathTip content="Dominant tape side weighted by premium — where most of the money crossed.">Dom. side</MathTip>
            </th>
            <th className="px-2 py-1.5">
              <MathTip content="Net bullish minus bearish premium within this bucket. Bullish calls + bearish puts score positive; bearish calls + bullish puts score negative.">Net lean</MathTip>
            </th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {rows.map((row) => {
            const ts = tagStyle(row.dominantTag);
            const barPct = premiumBarPct(row, maxPremium);
            const isCall = row.type === "C";
            const leanPositive = row.netSentiment > 0;
            const leanColor = row.netSentiment === 0
              ? "text-muted-foreground"
              : leanPositive ? "text-emerald-300" : "text-rose-300";
            return (
              <tr
                key={row.key}
                onClick={() => onRowClick(row)}
                className="relative border-b border-border/20 last:border-b-0 hover:bg-muted/30 cursor-pointer"
                data-testid={`build-row-${row.key}`}
              >
                <td className="px-2 py-1.5">
                  <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-semibold ${typeStyle(row.type)}`}>
                    {isCall ? "CALL" : "PUT"}
                  </span>
                </td>
                <td className="px-2 py-1.5 font-semibold">{row.strike.toFixed(2)}</td>
                <td className="px-2 py-1.5">
                  <span className="text-[10px] text-muted-foreground">{fmtExpiryShort(row.expiration)}</span>
                  <span className="ml-1 inline-block rounded bg-muted/40 px-1 py-0.5 text-[9px] text-muted-foreground">{row.dte}d</span>
                </td>
                {/* Built $ cell — premium bar behind the value */}
                <td className="relative px-2 py-1.5 text-right font-semibold">
                  <div
                    className={`absolute inset-y-1 right-0 rounded-sm ${isCall ? "bg-emerald-500/15" : "bg-rose-500/15"}`}
                    style={{ width: `${barPct}%` }}
                    aria-hidden
                  />
                  <span className="relative z-10">{fmtMoney(row.totalPremium)}</span>
                </td>
                <td className="px-2 py-1.5 text-right">{fmtNum(row.totalVolume)}</td>
                <td className="px-2 py-1.5 text-right text-muted-foreground">{row.printCount}</td>
                <td className="px-2 py-1.5 text-right text-muted-foreground">{row.avgPrice > 0 ? row.avgPrice.toFixed(2) : "—"}</td>
                <td className="px-2 py-1.5 text-right text-muted-foreground">{fmtNum(row.openInterest)}</td>
                <td className="px-2 py-1.5 text-right text-amber-300">
                  {row.isNewStrike ? (
                    <span className="inline-block rounded bg-violet-500/20 border border-violet-500/40 px-1.5 py-0.5 text-[9px] text-violet-300 font-semibold">NEW</span>
                  ) : `${row.volOiRatio.toFixed(1)}×`}
                </td>
                <td className="px-2 py-1.5">
                  <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-semibold ${ts.border} ${ts.bg} ${ts.text}`}>{ts.label}</span>
                </td>
                <td className={`px-2 py-1.5 font-semibold ${leanColor}`}>
                  {row.netSentiment === 0 ? "—" : `${leanPositive ? "+" : ""}${fmtMoney(row.netSentiment)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
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

function ContractRow({ c, onClick, symbol, trackedIds }: { c: UnusualContract; onClick?: (c: UnusualContract) => void; symbol: string; trackedIds: Set<string> }) {
  const ts = tagStyle(c.tag);
  // Tracking id matches server signalTracker.makeId format
  const trackId = `unusual-flow:${symbol.toUpperCase()}:${c.type}:${c.strike}:${c.expiration}`;
  const isTracked = trackedIds.has(trackId);
  const sideForTrack: "BULLISH" | "BEARISH" | "NEUTRAL" = c.sentiment;
  return (
    <tr
      key={c.occ}
      onClick={onClick ? () => onClick(c) : undefined}
      className={`border-b border-border/20 last:border-b-0 hover:bg-muted/30 ${onClick ? "cursor-pointer" : ""}`}
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
      {/* Track button — stops row click via onClick stopPropagation inside TrackButton */}
      <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
        <TrackButton
          source="unusual-flow"
          symbol={symbol}
          type={c.type}
          strike={c.strike}
          expiration={c.expiration}
          side={sideForTrack}
          label={`${symbol} ${c.strike}${c.type} ${c.expiration}`}
          entry={{ mark: c.mid, premium: c.notional, iv: c.iv }}
          isTracked={isTracked}
          trackedId={trackId}
          size="xs"
        />
      </td>
    </tr>
  );
}

// ─── Table headers ────────────────────────────────────────────────────────────

// Map a header column to its asc/desc pair so successive clicks toggle.
function cycleSort(current: SortKey, asc: SortKey, desc: SortKey): SortKey {
  if (current === desc) return asc;
  if (current === asc) return desc;
  return desc;
}

function SortIcon({ active, asc }: { active: boolean; asc: boolean }) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-40" />;
  return asc ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" />;
}

interface FlowTableHeadProps {
  sortKey: SortKey;
  onSort: (k: SortKey) => void;
}

function TableHead({ sortKey, onSort }: FlowTableHeadProps) {
  const clickable = (label: React.ReactNode, asc: SortKey, desc: SortKey, align: "left" | "right" = "left", testId?: string) => {
    const active = sortKey === asc || sortKey === desc;
    const isAsc = sortKey === asc;
    const alignCls = align === "right" ? "justify-end" : "justify-start";
    return (
      <button
        type="button"
        onClick={() => onSort(cycleSort(sortKey, asc, desc))}
        className={`inline-flex w-full items-center gap-1 ${alignCls} transition-colors hover:text-foreground ${active ? "text-foreground" : ""} select-none`}
        data-testid={testId}
      >
        <span>{label}</span>
        <SortIcon active={active} asc={isAsc} />
      </button>
    );
  };
  return (
    <thead className="border-b border-border/40 bg-muted/20 sticky top-0 z-10">
      <tr className="text-left text-[9px] uppercase tracking-wider text-muted-foreground">
        <th className="px-2 py-1.5">Time</th>
        <th className="px-2 py-1.5">{clickable("Type", "typeAsc", "typeAsc", "left", "sort-flow-type")}</th>
        <th className="px-2 py-1.5">
          {clickable(<MathTip content="Strike price of the option contract (in $).">Strike</MathTip>, "strikeAsc", "strikeDesc", "left", "sort-flow-strike")}
        </th>
        <th className="px-2 py-1.5">
          {clickable(
            <MathTip content="Expiration date · days-to-expiry chip shows calendar days remaining.">Expiry</MathTip>,
            "expiryAsc", "expiryDesc", "left", "sort-flow-expiry",
          )}
        </th>
        <th className="px-2 py-1.5">{clickable("Side", "sideAsc", "sideAsc", "left", "sort-flow-side")}</th>
        <th className="px-2 py-1.5 text-right">{clickable("Vol", "volume", "volume", "right", "sort-flow-vol")}</th>
        <th className="px-2 py-1.5 text-right">OI</th>
        <th className="px-2 py-1.5 text-right">
          {clickable(
            <MathTip content="Vol/OI ratio: Volume ÷ Open Interest. Ratio ≥ 2× flags unusual positioning (fresh money, not existing OI). 'NEW' = OI is zero — brand-new opening position.">Vol/OI</MathTip>,
            "volOiRatio", "volOiRatio", "right", "sort-flow-voloi",
          )}
        </th>
        <th className="px-2 py-1.5 text-right">
          <MathTip content="Bid × Ask market. Mid price = last if it falls in the spread, else (bid+ask)/2.">Bid×Ask</MathTip>
        </th>
        <th className="px-2 py-1.5 text-right">{clickable("Last", "lastDesc", "lastDesc", "right", "sort-flow-last")}</th>
        <th className="px-2 py-1.5 text-right">{clickable("IV", "ivDesc", "ivDesc", "right", "sort-flow-iv")}</th>
        <th className="px-2 py-1.5 text-right">
          {clickable(
            <MathTip content="Notional = Volume × Mid Price × 100.">Notional</MathTip>,
            "notional", "notional", "right", "sort-flow-notional",
          )}
        </th>
        <th className="px-2 py-1.5">Sentiment</th>
        <th className="px-2 py-1.5">Track</th>
      </tr>
    </thead>
  );
}

// ─── Grouped view ─────────────────────────────────────────────────────────────

function GroupedTable({ groups, sortKey, onSort, onRowClick, symbol, trackedIds }: { groups: ExpiryGroup[]; sortKey: SortKey; onSort: (k: SortKey) => void; onRowClick: (c: UnusualContract) => void; symbol: string; trackedIds: Set<string> }) {
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
        <TableHead sortKey={sortKey} onSort={onSort} />
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
                  <td colSpan={14} className="px-2 py-2">
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
                {isOpen && sorted.map((c) => <ContractRow key={c.occ} c={c} onClick={onRowClick} symbol={symbol} trackedIds={trackedIds} />)}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Flat table view ──────────────────────────────────────────────────────────

function FlatTable({ contracts, sortKey, onSort, onRowClick, symbol, trackedIds }: { contracts: UnusualContract[]; sortKey: SortKey; onSort: (k: SortKey) => void; onRowClick: (c: UnusualContract) => void; symbol: string; trackedIds: Set<string> }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border/40">
      <table className="w-full text-[11px]">
        <TableHead sortKey={sortKey} onSort={onSort} />
        <tbody className="font-mono tabular-nums">
          {contracts.map((c) => <ContractRow key={c.occ} c={c} onClick={onRowClick} symbol={symbol} trackedIds={trackedIds} />)}
        </tbody>
      </table>
    </div>
  );
}

// ─── Unusual flow detail modal ───────────────────────────────────────────────

function UnusualFlowModal({
  clicked, allContracts, asOf, symbol, spot, onClose, onRowClick,
}: {
  clicked: UnusualContract | null;
  allContracts: UnusualContract[];
  asOf: number;
  symbol: string;
  spot: number | null;
  onClose: () => void;
  onRowClick: (c: UnusualContract) => void;
}) {
  const open = clicked !== null;
  // API returns asOf in seconds (CBOE) or ms — detect and normalize
  const asOfMs = asOf < 1e12 ? asOf * 1000 : asOf;
  const tsFmt = new Date(asOfMs).toLocaleString("en-US", { hour12: false, timeZoneName: "short" });

  // Totals across the full visible flow list
  const totalNotional = allContracts.reduce((s, c) => s + c.notional, 0);
  const bullishNotional = allContracts.filter(c => c.sentiment === "BULLISH").reduce((s, c) => s + c.notional, 0);
  const bearishNotional = allContracts.filter(c => c.sentiment === "BEARISH").reduce((s, c) => s + c.notional, 0);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-5xl p-0 overflow-hidden" data-testid="flow-detail-modal">
        <DialogHeader className="px-4 pt-4 pb-2 border-b border-border/40">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Flame className="h-4 w-4 text-amber-400" />
            Unusual Flow · {symbol}
            {clicked && (
              <span className="ml-2 inline-flex items-center gap-1.5 rounded border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-mono tabular-nums">
                clicked: {clicked.type === "C" ? "CALL" : "PUT"} {clicked.strike} · exp {clicked.expiration}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-3 pt-1 text-[11px]">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Clock className="h-3 w-3" />
              {tsFmt}
            </span>
            {spot != null && (
              <span className="text-muted-foreground">Spot <span className="font-mono tabular-nums text-foreground">{spot.toFixed(2)}</span></span>
            )}
            <span className="text-muted-foreground">Total <span className="font-mono tabular-nums text-foreground">{fmtMoney(totalNotional)}</span></span>
            <span className="text-emerald-300">Bull {fmtMoney(bullishNotional)}</span>
            <span className="text-rose-300">Bear {fmtMoney(bearishNotional)}</span>
            <span className="ml-auto text-[10px] text-muted-foreground/80">{allContracts.length} prints in view</span>
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh]">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border/40">
              <tr className="text-left text-[9px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-1.5">Timestamp</th>
                <th className="px-2 py-1.5">Type</th>
                <th className="px-2 py-1.5">Strike</th>
                <th className="px-2 py-1.5">Expiry</th>
                <th className="px-2 py-1.5">Side</th>
                <th className="px-2 py-1.5 text-right">Vol</th>
                <th className="px-2 py-1.5 text-right">Vol/OI</th>
                <th className="px-2 py-1.5 text-right">Last</th>
                <th className="px-2 py-1.5 text-right">Premium $</th>
                <th className="px-2 py-1.5">Sentiment</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {allContracts.map((c) => {
                const ts = tagStyle(c.tag);
                const isClicked = clicked && c.occ === clicked.occ;
                return (
                  <tr
                    key={c.occ}
                    onClick={() => onRowClick(c)}
                    className={`cursor-pointer border-b border-border/20 hover:bg-muted/30 ${isClicked ? "bg-sky-500/15 ring-1 ring-inset ring-sky-500/40" : ""}`}
                    data-testid={`flow-modal-row-${c.occ}`}
                  >
                    <td className="px-3 py-1.5 text-[10px] text-muted-foreground whitespace-nowrap">
                      {new Date(asOfMs).toLocaleTimeString("en-US", { hour12: false })}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-semibold ${typeStyle(c.type)}`}>
                        {c.type === "C" ? "CALL" : "PUT"}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-semibold">{c.strike.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-[10px] text-muted-foreground">
                      {fmtExpiryShort(c.expiration)}
                      <span className="ml-1 inline-block rounded bg-muted/40 px-1 py-0.5 text-[9px]">{c.dte}d</span>
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-semibold ${ts.border} ${ts.bg} ${ts.text}`}>
                        {ts.label}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right">{fmtNum(c.volume)}</td>
                    <td className="px-2 py-1.5 text-right text-amber-300">
                      {c.isNewStrike ? (
                        <span className="inline-block rounded bg-violet-500/20 border border-violet-500/40 px-1.5 py-0.5 text-[9px] text-violet-300 font-semibold">NEW</span>
                      ) : `${c.volOiRatio.toFixed(1)}×`}
                    </td>
                    <td className="px-2 py-1.5 text-right">{c.last > 0 ? c.last.toFixed(2) : "—"}</td>
                    <td className="px-2 py-1.5 text-right font-semibold text-foreground">{fmtMoney(c.notional)}</td>
                    <td className={`px-2 py-1.5 font-semibold ${sentStyle(c.sentiment)}`}>
                      {c.sentiment === "BULLISH" ? "BULL" : c.sentiment === "BEARISH" ? "BEAR" : "NEUT"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollArea>
        <div className="border-t border-border/40 px-4 py-2 text-[10px] text-muted-foreground">
          click any row to inspect that print · premium = volume × mid × 100
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Props & main export ──────────────────────────────────────────────

interface Props {
  symbol: string;
}

export default function UnusualFlowPanel({ symbol }: Props) {
  const sym = symbol.toUpperCase();

  // Controls
  const [sortKey, setSortKey] = useState<SortKey>("notional");
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>("ALL");
  const [groupByExp, setGroupByExp] = useState(false);
  const [openModalFor, setOpenModalFor] = useState<UnusualContract | null>(null);
  // View mode: 'live' = streaming per-print list (tape view), 'build' = cumulative by strike+side
  const [viewMode, setViewMode] = useState<"live" | "build">("live");
  // When user selects 0DTE for the first time, default to Build view (where-size-loads).
  // After that, respect whatever they've picked.
  const [viewModeTouched, setViewModeTouched] = useState(false);

  // Tracked signal ids (so rows can show their current track state)
  const trackedQ = useQuery<any>({
    queryKey: ["/api/signals/tracked"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/signals/tracked");
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
  });
  const trackedIds = useMemo(() => {
    const s = new Set<string>();
    ((trackedQ.data?.groups ?? []) as any[]).forEach((g: any) => {
      (g.items ?? []).forEach((i: any) => {
        if (i?.id && i?.status === "OPEN") s.add(i.id);
      });
    });
    return s;
  }, [trackedQ.data]);

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

  // Build-view rows: aggregate by strike+type+expiration across the filtered set
  const buildRows = useMemo(() => aggregateByStrike(processedContracts), [processedContracts]);

  // Auto-default to Build view the first time the user selects 0DTE.
  // Doesn't override manual toggles afterwards.
  const handleExpiryFilter = useCallback((f: ExpiryFilter) => {
    setExpiryFilter(f);
    if (!viewModeTouched && f === "0DTE") {
      setViewMode("build");
    }
  }, [viewModeTouched]);

  const handleViewModeChange = useCallback((m: "live" | "build") => {
    setViewMode(m);
    setViewModeTouched(true);
  }, []);

  // Clicking a Build row opens the modal filtered to that strike-side-expiration
  const handleBuildRowClick = useCallback((row: BuildRow) => {
    // Find the first matching contract to seed the modal with a representative print
    const match = processedContracts.find((c) =>
      c.strike === row.strike && c.type === row.type && c.expiration === row.expiration,
    );
    if (match) setOpenModalFor(match);
  }, [processedContracts]);

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
      <Card data-testid="unusual-flow-panel-error">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Flame className="h-4 w-4 text-amber-400" /> Unusual Options Flow — {sym}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Chain temporarily unavailable for {sym}. Retrying in the background — the panel will refresh automatically.
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
        {data.note && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300" data-testid="unusual-flow-note">
            {data.note}
          </div>
        )}
        {data.contracts.length === 0 && !data.note && (
          <div className="rounded-md border border-dashed border-border/40 bg-card/20 px-3 py-6 text-center text-xs text-muted-foreground" data-testid="unusual-flow-empty">
            No unusual flow detected for {sym} — chain loaded but no contracts cleared Vol/OI ≥ 2 and $25K notional filters.
          </div>
        )}
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
                      onClick={() => handleExpiryFilter(f.value)}
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

          {/* View-mode toggle: Live (streaming prints) vs Build (cumulative by strike) */}
          <div
            className="flex items-center rounded-md border border-border/40 bg-muted/10 p-0.5"
            role="tablist"
            aria-label="Flow view mode"
            data-testid="view-mode-toggle"
          >
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    role="tab"
                    aria-selected={viewMode === "live"}
                    onClick={() => handleViewModeChange("live")}
                    className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors ${
                      viewMode === "live"
                        ? "bg-primary/20 text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    data-testid="view-mode-live"
                  >
                    <Activity className="h-3 w-3" />
                    Live
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[11px]">
                  Streaming per-print tape — newest prints on top.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    role="tab"
                    aria-selected={viewMode === "build"}
                    onClick={() => handleViewModeChange("build")}
                    className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors ${
                      viewMode === "build"
                        ? "bg-primary/20 text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    data-testid="view-mode-build"
                  >
                    <Layers className="h-3 w-3" />
                    Build
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[11px]">
                  Cumulative by strike + side — where size is loading.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
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

            {/* Group by expiry toggle — only meaningful in Live view */}
            {viewMode === "live" && (
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
            )}
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
        ) : viewMode === "build" ? (
          <>
            <div className="text-[10px] text-muted-foreground">
              Build view: {buildRows.length} unique strike-side bucket{buildRows.length !== 1 ? "s" : ""} · sorted by total premium
            </div>
            <BuildTable rows={buildRows} onRowClick={handleBuildRowClick} />
          </>
        ) : groupByExp ? (
          <GroupedTable groups={expGroups} sortKey={sortKey} onSort={setSortKey} onRowClick={setOpenModalFor} symbol={symbol} trackedIds={trackedIds} />
        ) : (
          <FlatTable contracts={processedContracts} sortKey={sortKey} onSort={setSortKey} onRowClick={setOpenModalFor} symbol={symbol} trackedIds={trackedIds} />
        )}

        <UnusualFlowModal
          clicked={openModalFor}
          allContracts={processedContracts}
          asOf={data.asOf}
          symbol={sym}
          spot={data.spot}
          onClose={() => setOpenModalFor(null)}
          onRowClick={setOpenModalFor}
        />

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
