// client/src/components/MemeStructure.tsx
//
// Structure cards for the Crypto tab: community watch (range position,
// survival counts, execution cost for settled tokens), the cost-of-trading
// calculator (constant-product impact + fees, zero-edge compounding) and the
// hold-vs-rotate arithmetic with its timing assumption on a slider. All math
// is shared/memeStructure.ts, the same code the server runs. Descriptive
// only: no verdicts, targets or sizes.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Layers, Scale, RefreshCw, Plus, X } from "lucide-react";
import {
  tradeCost, zeroEdgeBalance, maxSizeAtImpact, rotationIllustration, ROTATION_EXAMPLE,
  type MemeClass, type LinePosition, type RangeStats, type TradeCost, type RotationEvent,
} from "@shared/memeStructure";

// ─── types (mirror server/cryptoCommunityCore.ts) ───────────────────────

interface CommunityEntry {
  tokenAddress: string; label: string | null; addedAt: number;
  symbol: string | null; name: string | null; pairAddress: string | null; dexId: string | null;
  ageDays: number | null; priceUsd: number | null; marketCap: number | null; liquidityUsd: number | null;
  vol24h: number | null; chg24h: number | null; buys24h: number | null; sells24h: number | null;
  quoteState: "pending" | "ok" | "not_found" | "unavailable"; quoteAt: number | null; quoteError: string | null;
  range: RangeStats | null; historyState: "pending" | "ok" | "partial" | "no_data" | "unavailable"; historyAt: number | null; historyError: string | null;
  cost1k: TradeCost | null; maxSizeAt1Pct: number | null; structure: MemeClass | null; line: LinePosition;
}

interface CommunityWatch {
  entries: CommunityEntry[]; asOf: number; source: string; edition: "personal" | "investor" | "demo"; writable: boolean;
  limits: { maxTokens: number; historyRefreshMs: number; quoteRefreshMs: number }; note: string;
}

// ─── helpers ────────────────────────────────────────────────────────────

const fmtUsd = (n: number | null | undefined, digits = 1): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(digits)}K`;
  return `$${n.toFixed(a < 1 ? 4 : 0)}`;
};
const fmtPct = (n: number | null | undefined, digits = 1): string => (n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}%`);
const fmtDays = (d: number | null): string => (d == null ? "—" : d < 1 ? `${Math.round(d * 24)}h` : d < 60 ? `${Math.floor(d)}d` : `${Math.floor(d / 30)}mo`);

export const CATEGORY_STYLE: Record<MemeClass["category"], { label: string; cls: string; title: string }> = {
  "new-launch": { label: "new launch", cls: "bg-rose-500/15 text-rose-300", title: "under 7 days old: launch-order supply still in place" },
  speculative: { label: "speculative", cls: "bg-orange-500/15 text-orange-300", title: "bought on a news trigger; attention tied to a news cycle" },
  meta: { label: "meta", cls: "bg-amber-500/15 text-amber-300", title: "a copy of a template that just worked (name pattern)" },
  maturing: { label: "maturing", cls: "bg-sky-500/15 text-sky-300", title: "7-30 days old; not yet settled" },
  community: { label: "community", cls: "bg-emerald-500/15 text-emerald-300", title: "30+ days, deep liquidity, supply spread (where read)" },
  unclassified: { label: "unclassified", cls: "bg-muted/40 text-muted-foreground", title: "the inputs to decide are missing or fail the depth / supply test" },
};

const COST_STATE: Record<TradeCost["dataState"], string> = { ok: "", unavailable: "not reported", observed_zero: "$0 pool", below_fees: "under fees", invalid: "—" };

export function CategoryChip({ k }: { k: MemeClass | null | undefined }) {
  if (!k) return null;
  const s = CATEGORY_STYLE[k.category];
  return (
    <span className={`whitespace-nowrap rounded px-1 py-px text-[11px] font-semibold ${s.cls}`} title={`${s.title}. ${k.reasons.join("; ")}${k.missing.length ? `. not read: ${k.missing.join(", ")}` : ""}`}
      data-testid="meme-category">
      {s.label}{k.confidence === "tentative" ? "?" : ""}
    </span>
  );
}

export function LineChip({ line }: { line: LinePosition | null | undefined }) {
  if (!line || line.phase === "unknown") return null;
  const label = line.phase === "first-hour" ? "5th in line" : line.phase === "first-day" ? "launch day" : line.phase === "first-week" ? "launch week" : "settled";
  const cls = line.phase === "first-hour" || line.phase === "first-day" ? "bg-rose-500/15 text-rose-300" : line.phase === "first-week" ? "bg-amber-500/15 text-amber-300" : "bg-muted/40 text-muted-foreground";
  return (
    <span className={`whitespace-nowrap rounded px-1 py-px text-[11px] font-semibold ${cls}`} title={`${line.note}${line.ahead.length ? `. ahead: ${line.ahead.join("; ")}` : ""}`} data-testid="meme-line">
      {label}
    </span>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-xs tabular-nums text-foreground">{value}</div>
    </div>
  );
}

// ─── Section wrapper ────────────────────────────────────────────────────

export default function MemeStructureSection() {
  const [open, setOpen] = useState(true);
  const watchQ = useQuery<CommunityWatch>({ queryKey: ["/api/crypto/community"], refetchInterval: open ? 60_000 : false });
  const [picked, setPicked] = useState<string | null>(null);
  const entries = watchQ.data?.entries ?? [];
  const pickedEntry = entries.find((e) => e.tokenAddress === picked) ?? entries.find((e) => e.liquidityUsd != null) ?? null;

  return (
    <div data-testid="meme-structure">
      <button className="flex w-full items-center gap-2" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="crypto-section-structure">
        <Layers className="h-4 w-4 text-emerald-400" />
        <span className="text-xs font-semibold uppercase tracking-[0.12em]">Structure — cost, line position, range</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          <p className="text-[11px] leading-snug text-muted-foreground">
            Three structural facts the launch scanner above cannot show: what a round trip costs against a pool's depth, who is ahead of a public buyer at a given pool age, and where a settled token sits in its own range. Arithmetic, not forecasts.
          </p>
          <CommunityWatchCard watch={watchQ.data} loading={watchQ.isLoading} error={watchQ.isError} picked={pickedEntry?.tokenAddress ?? null} onPick={setPicked} />
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {/* keyed by token so a typed depth or cost does not carry over to another pool */}
            <CostCard key={`cost-${pickedEntry?.tokenAddress ?? "none"}`} entry={pickedEntry} />
            <RotationCard key={`rot-${pickedEntry?.tokenAddress ?? "none"}`} entry={pickedEntry} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Community watch ────────────────────────────────────────────────────

function RangeBar({ r }: { r: RangeStats | null }) {
  if (!r || r.rangePosition == null) return <div className="h-1.5 rounded-full bg-muted/40" />;
  const pct = Math.round(r.rangePosition * 100);
  return (
    <div className="relative h-1.5 rounded-full bg-gradient-to-r from-emerald-500/30 via-amber-400/30 to-rose-500/30" title={`${pct}% of the ${r.windowDays}-day close range (0 = window low, 100 = window high)`}>
      <div className="absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded-sm bg-foreground" style={{ left: `calc(${pct}% - 2px)` }} />
    </div>
  );
}

function CommunityWatchCard({ watch, loading, error, picked, onPick }: {
  watch?: CommunityWatch; loading: boolean; error: boolean; picked: string | null; onPick: (addr: string) => void;
}) {
  const [addr, setAddr] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/crypto/community", { tokenAddress: addr.trim(), label: label.trim() || null });
      return r.json();
    },
    onSuccess: () => { setAddr(""); setLabel(""); setMsg(null); void queryClient.invalidateQueries({ queryKey: ["/api/crypto/community"] }); },
    onError: (e: any) => setMsg(String(e?.message ?? e).replace(/^\d+:\s*/, "").slice(0, 160)),
  });
  const remove = useMutation({
    mutationFn: async (a: string) => (await apiRequest("DELETE", `/api/crypto/community/${encodeURIComponent(a)}`)).json(),
    onSuccess: () => { setMsg(null); void queryClient.invalidateQueries({ queryKey: ["/api/crypto/community"] }); },
    onError: (e: any) => setMsg(`remove failed: ${String(e?.message ?? e).replace(/^\d+:\s*/, "").slice(0, 120)}`),
  });
  const entries = watch?.entries ?? [];

  return (
    <div className="rounded-xl border border-border/50 bg-card/60 p-3" data-testid="community-watch">
      <div className="flex flex-wrap items-center gap-2">
        <Scale className="h-4 w-4 text-emerald-400" />
        <span className="text-xs font-semibold">Community watch</span>
        <span className="text-[11px] text-muted-foreground">settled tokens · 90-day close range · {watch?.edition === "demo" ? "Sample" : "DexScreener + GeckoTerminal"}</span>
        {watch && <span className="ml-auto text-[11px] text-muted-foreground">{entries.length}/{watch.limits.maxTokens}</span>}
      </div>
      {loading && <p className="mt-2 text-[11px] text-muted-foreground">loading…</p>}
      {error && <p className="mt-2 text-[11px] text-rose-300">watch unavailable (request failed)</p>}
      {watch && entries.length === 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {watch.writable ? "no tokens yet: add a Solana mint address below." : "the owner has not listed any tokens."}
        </p>
      )}
      <div className="mt-2 space-y-2">
        {entries.map((e) => {
          const r = e.range;
          const sel = e.tokenAddress === picked;
          return (
            <div key={e.tokenAddress} className={`rounded-lg border p-2 ${sel ? "border-emerald-400/50 bg-emerald-500/5" : "border-border/40"}`} data-testid={`community-row-${e.tokenAddress.slice(0, 8)}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <button className="font-mono text-sm font-bold" onClick={() => onPick(e.tokenAddress)} title="use this pool's depth in the calculators below" data-testid={`community-pick-${e.tokenAddress.slice(0, 8)}`}>
                  {e.symbol ?? e.label ?? `${e.tokenAddress.slice(0, 6)}…`}
                </button>
                <span className="truncate text-[11px] text-muted-foreground">{e.name ?? ""}</span>
                <CategoryChip k={e.structure} />
                <LineChip line={e.line} />
                {e.quoteState !== "ok" && (
                  <span className="rounded bg-amber-500/15 px-1 py-px text-[11px] font-semibold text-amber-300" title={e.quoteError ?? undefined}>
                    quote {e.quoteState.replace("_", " ")}
                  </span>
                )}
                {e.historyState !== "ok" && (
                  <span className="rounded bg-muted/40 px-1 py-px text-[11px] text-muted-foreground" title={e.historyError ?? undefined}>
                    history {e.historyState.replace("_", " ")}{e.historyState === "partial" && r ? ` (${r.bars} bars)` : ""}
                  </span>
                )}
                <span className="ml-auto font-mono text-xs tabular-nums">{fmtUsd(e.marketCap)}</span>
                {watch?.writable && (
                  <button className="rounded p-1 text-muted-foreground hover:text-rose-300" onClick={() => remove.mutate(e.tokenAddress)} title="remove from the watch" aria-label={`remove ${e.symbol ?? e.tokenAddress}`} data-testid={`community-remove-${e.tokenAddress.slice(0, 8)}`}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="mt-1.5"><RangeBar r={r} /></div>
              <div className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1 sm:grid-cols-6">
                <Stat label="range" value={r?.rangePosition != null ? `${Math.round(r.rangePosition * 100)}%` : "—"} title="position in the 90-day close range: 0% at the low, 100% at the high" />
                <Stat label="from high" value={r?.drawdownFromHighPct != null ? `-${fmtPct(r.drawdownFromHighPct, 0)}` : "—"} title={r?.daysSinceHigh != null ? `${r.daysSinceHigh} days since the window high` : undefined} />
                <Stat label="70% dips" value={r && r.dataState !== "no_data" ? `${r.deepDipsReclaimed}${r.deepDipOpen ? " +1 open" : ""}` : "—"} title="dips of 70% or more from a running high that later closed at or above that high (count reclaimed; +1 open = a deep dip not yet reclaimed)" />
                <Stat label="liq" value={fmtUsd(e.liquidityUsd)} title="pool liquidity, both sides (DexScreener)" />
                <Stat label="$1k trip" value={e.cost1k?.roundTripPct != null ? fmtPct(e.cost1k.roundTripPct) : e.cost1k ? COST_STATE[e.cost1k.dataState] || "—" : "—"} title="cost of a $1,000 buy and zero-edge sell at this depth: pool fee 0.25% and app fee 1% per swap, constant-product impact" />
                <Stat label="age" value={fmtDays(e.ageDays)} title={e.structure?.reasons.join("; ")} />
              </div>
            </div>
          );
        })}
      </div>
      {watch?.writable && (
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(ev) => { ev.preventDefault(); if (addr.trim()) add.mutate(); }}>
          <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Solana mint address" aria-label="token mint address"
            className="min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-xs" data-testid="community-add-address" />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (optional)" aria-label="label"
            className="w-32 rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs" data-testid="community-add-label" />
          <button type="submit" disabled={add.isPending || !addr.trim()} className="flex items-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 disabled:opacity-50" data-testid="community-add">
            {add.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} add
          </button>
          {msg && <span className="w-full text-[11px] text-rose-300">{msg}</span>}
        </form>
      )}
      {msg && !watch?.writable && <p className="mt-2 text-[11px] text-rose-300">{msg}</p>}
      {watch && <p className="mt-2 text-[11px] text-muted-foreground">{watch.note} Source: {watch.source}.</p>}
    </div>
  );
}

// ─── Cost of trading ────────────────────────────────────────────────────

const COST_PRESETS: Array<{ k: string; label: string; dex: number; app: number; prio: number }> = [
  { k: "app", label: "trading app (0.25% pool + 1% app)", dex: 0.25, app: 1, prio: 0.25 },
  { k: "dex", label: "bare DEX swap (0.25% pool)", dex: 0.25, app: 0, prio: 0.25 },
  { k: "bot", label: "sniper bot (0.25% pool + 1% + priority)", dex: 0.25, app: 1, prio: 2 },
];

function CostCard({ entry }: { entry: CommunityEntry | null }) {
  // Raw strings for the typed fields so clearing a box does not snap to a clamp mid-keystroke.
  const [sizeRaw, setSizeRaw] = useState("1000");
  const [liqRaw, setLiqRaw] = useState<string | null>(null);
  const [preset, setPreset] = useState("app");
  const [tradesRaw, setTradesRaw] = useState("100");
  const size = Number(sizeRaw) || 0;
  const manualLiq = liqRaw == null || liqRaw === "" ? null : Math.max(0, Number(liqRaw) || 0);
  const trades = Math.min(1000, Math.max(1, Math.floor(Number(tradesRaw) || 0)));
  const liq = manualLiq ?? entry?.liquidityUsd ?? null;
  const p = COST_PRESETS.find((x) => x.k === preset) ?? COST_PRESETS[0];
  const cost = useMemo(() => tradeCost({ liquidityUsd: liq, sizeUsd: size, dexFeePct: p.dex, platformFeePct: p.app, priorityFeeUsd: p.prio }), [liq, size, p]);
  const rt = cost.roundTripPct;
  const rows = [10, 25, 50, trades].filter((n, i, a) => a.indexOf(n) === i && n > 0).sort((a, b) => a - b);

  return (
    <div className="rounded-xl border border-border/50 bg-card/60 p-3" data-testid="cost-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">Cost of a round trip</span>
        <span className="text-[11px] text-muted-foreground">{entry ? `${entry.symbol ?? "token"} pool` : "enter a pool depth"} · constant-product impact + fees</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="text-[11px] text-muted-foreground">size $
          <input type="number" min={0} step="any" inputMode="decimal" value={sizeRaw} onChange={(e) => setSizeRaw(e.target.value)}
            className="mt-0.5 w-full rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-xs text-foreground" data-testid="cost-size" />
        </label>
        <label className="text-[11px] text-muted-foreground">pool liquidity $
          <input type="number" min={0} step="any" inputMode="decimal" value={liqRaw ?? (entry?.liquidityUsd != null ? String(entry.liquidityUsd) : "")} placeholder="not reported" onChange={(e) => setLiqRaw(e.target.value)}
            className="mt-0.5 w-full rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-xs text-foreground" data-testid="cost-liq" />
        </label>
        <label className="col-span-2 text-[11px] text-muted-foreground">fees
          <select value={preset} onChange={(e) => setPreset(e.target.value)} className="mt-0.5 w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs text-foreground" data-testid="cost-preset">
            {COST_PRESETS.map((x) => <option key={x.k} value={x.k}>{x.label}</option>)}
          </select>
        </label>
      </div>
      {cost.dataState !== "ok" ? (
        <p className="mt-2 text-[11px] text-amber-300" data-testid="cost-state">
          {cost.dataState === "unavailable" ? "pool liquidity not reported: no cost can be computed (not zero)."
            : cost.dataState === "observed_zero" ? (manualLiq != null ? "entered liquidity is $0: nothing to trade against." : "the pool reports $0 liquidity: there is no exit.")
            : cost.dataState === "below_fees" ? "the size does not cover the fees and priority."
            : "enter a positive size and liquidity."}
        </p>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 sm:grid-cols-6">
            <Stat label="buy impact" value={fmtPct(cost.impactBuyPct, 2)} title="share of the amount reaching the pool lost against the quote, x/(Q+x)" />
            <Stat label="price after" value={`+${fmtPct(cost.priceMoveAfterBuyPct, 2)}`} title="where the pool's price sits after the buy" />
            <Stat label="sell impact" value={fmtPct(cost.impactSellPct, 2)} title="impact of the sell when the quote is back at the entry" />
            <Stat label="fees" value={fmtPct(cost.feesRoundTripPct, 2)} title="pool + app fee on both swaps" />
            <Stat label="round trip" value={fmtPct(rt, 2)} title="all-in cost of a buy and a zero-edge sell, percent of size" />
            <Stat label="break-even" value={cost.breakEvenMovePct == null ? "none" : `+${fmtPct(cost.breakEvenMovePct, 2)}`} title={cost.breakEvenMovePct == null ? "no move returns the size spent: the pool's depth caps the sell's proceeds under it" : "price move the quote must make for the sell to return the size spent"} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>largest buy at 1% impact: <span className="font-mono text-foreground">{fmtUsd(maxSizeAtImpact(liq, 1), 0)}</span></span>
            <span>at 2%: <span className="font-mono text-foreground">{fmtUsd(maxSizeAtImpact(liq, 2), 0)}</span></span>
            <span>quote side assumed: <span className="font-mono text-foreground">{fmtUsd(cost.quoteReserveUsd, 0)}</span></span>
          </div>
          <div className="mt-2 rounded-md bg-muted/30 p-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>zero edge (exit at the entry quote), ${size.toLocaleString()} start, {fmtPct(rt, 2)} per trip:</span>
              <label className="ml-auto flex items-center gap-1">trades
                <input type="number" min={1} max={1000} step="any" inputMode="numeric" value={tradesRaw} onChange={(e) => setTradesRaw(e.target.value)}
                  className="w-16 rounded-md border border-border/60 bg-background px-1.5 py-1 font-mono text-xs text-foreground" data-testid="cost-trades" />
              </label>
            </div>
            <div className="mt-1 grid grid-cols-4 gap-2 font-mono text-xs tabular-nums" data-testid="cost-zero-edge">
              {rows.map((n) => (
                <div key={n}><span className="text-muted-foreground">{n}: </span>{fmtUsd(zeroEdgeBalance(size, rt ?? 0, n), 0)}</div>
              ))}
            </div>
          </div>
        </>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">{cost.assumptions.join(". ")}. Concentrated-liquidity pools differ.</p>
    </div>
  );
}

// ─── Hold vs rotate ─────────────────────────────────────────────────────

function RotationCard({ entry }: { entry: CommunityEntry | null }) {
  const [events, setEvents] = useState<RotationEvent[]>(ROTATION_EXAMPLE);
  const [capture, setCapture] = useState(50);
  const [costRaw, setCostRaw] = useState<string | null>(null);
  const start = 10_000;
  const rtDefault = entry?.cost1k?.roundTripPct ?? 2;
  const rt = costRaw == null || costRaw === "" ? rtDefault : Math.min(100, Math.max(0, Number(costRaw) || 0));
  const r = useMemo(() => rotationIllustration(start, events, rt, capture / 100), [events, rt, capture]);
  const perfect = useMemo(() => rotationIllustration(start, events, 0, 1), [events]);
  const setEv = (i: number, patch: Partial<Record<"mult" | "dip" | "otherUp", number>>) =>
    setEvents((prev) => prev.map((ev, j) => (j !== i ? ev : ev.kind === "up" ? { ...ev, mult: patch.mult ?? ev.mult } : { ...ev, dip: patch.dip ?? ev.dip, otherUp: patch.otherUp ?? ev.otherUp })));

  return (
    <div className="rounded-xl border border-border/50 bg-card/60 p-3" data-testid="rotation-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">Hold vs rotate arithmetic</span>
        <span className="text-[11px] text-muted-foreground">the published example, with timing on a slider</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {events.map((ev, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="w-14 shrink-0">step {i + 1}</span>
            {ev.kind === "up" ? (
              <label className="flex items-center gap-1">both ride a
                <input type="number" min={0} step="any" inputMode="decimal" value={ev.mult} onChange={(e) => setEv(i, { mult: Number(e.target.value) || 0 })}
                  className="w-16 rounded-md border border-border/60 bg-background px-1.5 py-1 font-mono text-xs text-foreground" aria-label={`step ${i + 1} multiple`} />x
              </label>
            ) : (
              <>
                <label className="flex items-center gap-1">held coin gives back
                  <input type="number" min={0} max={100} step="any" inputMode="decimal" value={Math.round(ev.dip * 100)} onChange={(e) => setEv(i, { dip: Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)) })}
                    className="w-16 rounded-md border border-border/60 bg-background px-1.5 py-1 font-mono text-xs text-foreground" aria-label={`step ${i + 1} dip percent`} />%
                </label>
                <label className="flex items-center gap-1">while the other coin does
                  <input type="number" min={0} step="any" inputMode="decimal" value={ev.otherUp} onChange={(e) => setEv(i, { otherUp: Number(e.target.value) || 0 })}
                    className="w-16 rounded-md border border-border/60 bg-background px-1.5 py-1 font-mono text-xs text-foreground" aria-label={`step ${i + 1} other coin multiple`} />x
                </label>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-muted-foreground">timing caught: <span className="font-mono text-foreground">{capture}%</span> of each top and bottom
          <input type="range" min={0} max={100} step={5} value={capture} onChange={(e) => setCapture(Number(e.target.value))} className="mt-0.5 h-11 w-full lg:h-6" data-testid="rotation-capture" aria-label="timing capture percent" />
        </label>
        <label className="text-[11px] text-muted-foreground">cost per rotation %
          <input type="number" min={0} max={100} step="any" inputMode="decimal" value={costRaw ?? String(rtDefault)} onChange={(e) => setCostRaw(e.target.value)}
            className="mt-0.5 w-full rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-xs text-foreground" data-testid="rotation-cost" />
          <span className="block text-[11px] text-muted-foreground">{costRaw != null && costRaw !== "" ? "entered" : entry?.cost1k?.roundTripPct != null ? `default: $1k round trip in the ${entry.symbol ?? ""} pool` : "default 2% (deep pool)"}</span>
        </label>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-4" data-testid="rotation-result">
        <Stat label="holder" value={fmtUsd(r.holderUsd, 1)} title="rides every up-leg and sits through every dip of one coin" />
        <Stat label="rotator" value={fmtUsd(r.rotatorUsd, 1)} title={`out at ${capture}% of each top, back in at ${capture}% of each bottom, ${r.rotations} swaps paid`} />
        <Stat label="ratio" value={`${r.ratio}x`} title="rotator / holder" />
        <Stat label="costs paid" value={fmtUsd(r.costsPaidUsd, 1)} />
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        With perfect timing and no costs this example gives {fmtUsd(perfect.rotatorUsd, 0)} against {fmtUsd(perfect.holderUsd, 0)} ({perfect.ratio}x), the published figure. {r.assumptions.join(". ")}.
      </p>
    </div>
  );
}
