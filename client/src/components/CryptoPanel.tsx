// CryptoPanel — the degen desk. Sub-1M meme discovery with honest verdicts.
//
// Design: Gen Z degen energy (neon purple/lime, glow accents, big score rings)
// but every number is real and every risk flag is shown. FOMO meter, narrative
// heat chips, agent health strip with pulsing status dots, graded audit log.
// Tracking mode is displayed loudly until calibration exists (n>=50 graded).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import {
  Flame, Radar, Newspaper, Activity, ShieldAlert, Rocket, Skull,
  Eye, XCircle, Zap, HeartPulse, TrendingUp, Clock,
} from "lucide-react";

// ─── types (mirror server) ──────────────────────────────────────────────

type Verdict = "ENTER" | "WATCH" | "PASS" | null;

interface Candidate {
  chain: string; pairAddress: string; tokenAddress: string;
  symbol: string; name: string; dexId: string;
  pumpfunGraduate: boolean; discoveredVia: string;
  priceUsd: number | null; marketCap: number | null; liquidityUsd: number | null;
  vol5m: number | null; vol1h: number | null; vol24h: number | null;
  buys5m: number | null; sells5m: number | null;
  chg5m: number | null; chg1h: number | null; chg24h: number | null;
  boosted: boolean; ageMinutes: number | null;
  mintAuthorityActive: boolean | null; freezeAuthorityActive: boolean | null;
  top10Pct: number | null; securityCheckedAt: number | null;
  rcRisks: string[]; rcLpLockedPct: number | null;
  bskyMentions1h: number | null; bskyMentions10m: number | null;
  pumpReplies: number | null; pumpReplyPerHr: number | null;
  pumpLive: boolean; socialScore: number | null; socialCheckedAt: number | null;
  volAccel: number | null; netBuyRatio5m: number | null;
  fomoScore: number | null; memeScore: number | null;
  narrativeHits: string[]; rugFlags: string[]; hardKill: boolean;
  score: number | null; verdict: Verdict; verdictReasons: string[];
  risk: {
    maxPositionUsd: number; suggestedStopPct: number; liquidityExitStopPct: number;
    targetMcap: number; targetMultiple: number | null; estSlippagePct: number;
    holdHorizonHours: number; notes: string[];
  } | null;
}

interface FeedResp {
  asOf: number; trackedCount: number; candidates: Candidate[];
  narrativeHeat: Array<{ term: string; hits: number; sources: string[] }>;
  narrativeUpdatedAt: number | null;
}

interface HealthResp {
  engines: Array<{ name: string; status: string; lastOkAt: number | null; runs: number; errors: number; lastError: string | null }>;
  trackedCount: number; asOf: number;
}

interface SignalsResp {
  signals: any[];
  stats: { total: number; open: number; hit5m: number; doubled: number; rugged: number; dead: number; calibrated: boolean };
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

const fmtAge = (min: number | null): string => {
  if (min == null) return "—";
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
};

const pctCls = (v: number | null) =>
  v == null ? "text-muted-foreground" : v >= 0 ? "text-lime-400" : "text-rose-400";

// ─── main panel ─────────────────────────────────────────────────────────

export default function CryptoPanel() {
  const [view, setView] = useState<"feed" | "signals">("feed");
  const [expanded, setExpanded] = useState<string | null>(null);

  const feedQ = useQuery<FeedResp>({ queryKey: ["/api/crypto/feed"], refetchInterval: 45_000 });
  const healthQ = useQuery<HealthResp>({ queryKey: ["/api/crypto/health"], refetchInterval: 30_000 });
  const sigQ = useQuery<SignalsResp>({ queryKey: ["/api/crypto/signals"], refetchInterval: 120_000, enabled: view === "signals" });

  const feed = feedQ.data;
  const enters = feed?.candidates.filter((c) => c.verdict === "ENTER") ?? [];
  const watches = feed?.candidates.filter((c) => c.verdict === "WATCH") ?? [];
  const passes = feed?.candidates.filter((c) => c.verdict === "PASS").slice(0, 20) ?? [];

  return (
    <div className="space-y-4" data-testid="crypto-panel">
      {/* hero strip */}
      <div className="relative overflow-hidden rounded-xl border border-fuchsia-500/25 bg-gradient-to-br from-fuchsia-600/15 via-violet-600/10 to-lime-500/10 p-4">
        <div className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-full bg-fuchsia-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -left-6 bottom-0 h-24 w-24 rounded-full bg-lime-400/15 blur-2xl" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Rocket className="h-5 w-5 text-fuchsia-400" />
              <h2 className="text-base font-bold tracking-tight">degen desk</h2>
              <Badge variant="outline" className="border-lime-400/40 bg-lime-400/10 text-[10px] text-lime-300">
                sub-1M → 5M hunt
              </Badge>
            </div>
            <p className="mt-1 max-w-xl text-xs leading-snug text-muted-foreground">
              solana launches + pump.fun graduations, scored on flow acceleration, catchy-name power,
              narrative confirms, and rug filters. sized off exit liquidity. PASS is the default verdict.
            </p>
          </div>
          <AgentStrip health={healthQ.data} />
        </div>
      </div>

      {/* tracking-mode banner until calibrated */}
      <TrackingBanner sig={sigQ.data} view={view} />

      {/* narrative heat */}
      <div className="flex flex-wrap items-center gap-1.5" data-testid="crypto-narratives">
        <Newspaper className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="mr-1 text-[10px] uppercase tracking-[0.15em] text-muted-foreground">narrative heat</span>
        {(feed?.narrativeHeat ?? []).slice(0, 10).map((n) => (
          <span
            key={n.term}
            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
              n.hits >= 4
                ? "border-orange-400/50 bg-orange-500/15 text-orange-300"
                : n.hits >= 2
                  ? "border-fuchsia-400/40 bg-fuchsia-500/10 text-fuchsia-300"
                  : "border-border/60 text-muted-foreground"
            }`}
            title={`${n.hits} headline hits — ${n.sources.join(", ")}`}
          >
            {n.term} ×{n.hits}
          </span>
        ))}
        {(feed?.narrativeHeat ?? []).length === 0 && (
          <span className="text-[10px] text-muted-foreground">warming up…</span>
        )}
      </div>

      {/* view toggle */}
      <div className="flex items-center gap-2">
        {(["feed", "signals"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            data-testid={`crypto-view-${v}`}
            className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
              view === v
                ? "bg-gradient-to-r from-fuchsia-600/40 to-violet-600/40 text-white shadow-[0_0_14px_rgba(217,70,239,0.25)]"
                : "border border-border/60 text-muted-foreground hover:text-foreground"
            }`}
          >
            {v === "feed" ? "live feed" : "signal log"}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground">
          tracking {feed?.trackedCount ?? 0} pools · refresh 45s
        </span>
      </div>

      {view === "feed" ? (
        <div className="space-y-4">
          {feedQ.isLoading && <FeedSkeleton />}
          {feedQ.isError && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-400">
              feed unavailable — engines may still be warming up. health strip above shows which agent is down.
            </div>
          )}
          {feed && (
            <>
              <Section
                icon={<Zap className="h-4 w-4 text-lime-400" />}
                title="ENTER — flow confirmed, sub-1M"
                empty="nothing clears the bar right now. that's the system working, not broken."
                items={enters} expanded={expanded} setExpanded={setExpanded} accent="enter"
              />
              <Section
                icon={<Eye className="h-4 w-4 text-amber-400" />}
                title="WATCH — forming, waiting on flow"
                empty="no setups forming."
                items={watches} expanded={expanded} setExpanded={setExpanded} accent="watch"
              />
              <Section
                icon={<XCircle className="h-4 w-4 text-muted-foreground" />}
                title="PASS — seen and rejected"
                empty="scanner warming up…"
                items={passes} expanded={expanded} setExpanded={setExpanded} accent="pass" collapsedByDefault
              />
            </>
          )}
        </div>
      ) : (
        <SignalLog sig={sigQ.data} loading={sigQ.isLoading} />
      )}
    </div>
  );
}

// ─── agent health strip ─────────────────────────────────────────────────

function AgentStrip({ health }: { health?: HealthResp }) {
  const dot = (s: string) =>
    s === "ok" ? "bg-lime-400 shadow-[0_0_6px_rgba(163,230,53,0.8)] animate-pulse"
    : s === "late" ? "bg-amber-400"
    : s === "starting" ? "bg-sky-400 animate-pulse"
    : "bg-rose-500";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/50 px-3 py-2 backdrop-blur" data-testid="crypto-agent-strip">
      <HeartPulse className="h-3.5 w-3.5 text-muted-foreground" />
      {(health?.engines ?? []).filter((e) => e.name !== "watchdog").map((e) => (
        <div key={e.name} className="flex items-center gap-1.5" title={`${e.name}: ${e.status} · ${e.runs} runs · ${e.errors} errors${e.lastError ? ` · ${e.lastError}` : ""}`}>
          <span className={`h-2 w-2 rounded-full ${dot(e.status)}`} />
          <span className="text-[10px] font-medium text-muted-foreground">{e.name}</span>
        </div>
      ))}
      {(health?.engines ?? []).length === 0 && (
        <span className="text-[10px] text-muted-foreground">agents booting…</span>
      )}
    </div>
  );
}

// ─── tracking banner ────────────────────────────────────────────────────

function TrackingBanner({ sig, view }: { sig?: SignalsResp; view: string }) {
  const graded = sig ? sig.stats.total - sig.stats.open : null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
      <p className="text-[11px] leading-snug text-amber-200/90">
        <span className="font-semibold">tracking mode.</span> every ENTER/WATCH is logged and graded
        (5M hit / doubled / rugged / dead) but nothing here is stakeable until the audited hit rate exists
        — same n≥50 rule as the 0DTE desk{graded != null ? ` (${graded} graded so far)` : ""}. sub-1M memes
        are a &gt;90% loss-rate arena; the math only works small, cut fast, and letting 4-5x winners pay for everything.
      </p>
    </div>
  );
}

// ─── candidate sections ─────────────────────────────────────────────────

function Section({ icon, title, empty, items, expanded, setExpanded, accent, collapsedByDefault }: {
  icon: React.ReactNode; title: string; empty: string; items: Candidate[];
  expanded: string | null; setExpanded: (k: string | null) => void;
  accent: "enter" | "watch" | "pass"; collapsedByDefault?: boolean;
}) {
  const [open, setOpen] = useState(!collapsedByDefault);
  return (
    <div>
      <button className="flex w-full items-center gap-2" onClick={() => setOpen((v) => !v)} data-testid={`crypto-section-${accent}`}>
        {icon}
        <span className="text-xs font-semibold uppercase tracking-[0.12em]">{title}</span>
        <span className="rounded-full bg-muted/60 px-1.5 text-[10px] text-muted-foreground">{items.length}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
          {items.length === 0 && <p className="text-[11px] text-muted-foreground">{empty}</p>}
          {items.map((c) => (
            <TokenCard key={`${c.chain}:${c.pairAddress}`} c={c} accent={accent}
              isOpen={expanded === `${c.chain}:${c.pairAddress}`}
              toggle={() => setExpanded(expanded === `${c.chain}:${c.pairAddress}` ? null : `${c.chain}:${c.pairAddress}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TokenCard({ c, accent, isOpen, toggle }: { c: Candidate; accent: string; isOpen: boolean; toggle: () => void }) {
  const border =
    accent === "enter" ? "border-lime-400/35 hover:border-lime-400/60"
    : accent === "watch" ? "border-amber-400/30 hover:border-amber-400/55"
    : "border-border/50 hover:border-border";
  const mcapPct = c.marketCap != null ? Math.min(100, (c.marketCap / 1_000_000) * 100) : 0;
  return (
    <button
      onClick={toggle}
      className={`group w-full rounded-xl border ${border} bg-card/60 p-3 text-left transition-all`}
      data-testid={`crypto-card-${c.pairAddress.slice(0, 8)}`}
    >
      <div className="flex items-center gap-2.5">
        {/* score ring */}
        <ScoreRing score={c.score ?? 0} accent={accent} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-sm font-bold">{c.symbol}</span>
            {c.pumpfunGraduate && (
              <span className="rounded bg-emerald-500/15 px-1 py-px text-[9px] font-semibold text-emerald-300" title="graduated the pump.fun bonding curve">
                pump.fun grad
              </span>
            )}
            {c.boosted && (
              <span className="rounded bg-orange-500/15 px-1 py-px text-[9px] font-semibold text-orange-300" title="paid DexScreener boost — manufactured attention">
                paid boost
              </span>
            )}
            {c.narrativeHits.length > 0 && (
              <span className="rounded bg-fuchsia-500/15 px-1 py-px text-[9px] font-semibold text-fuchsia-300">
                news: {c.narrativeHits[0]}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="truncate">{c.name}</span>
            <span className="flex items-center gap-0.5 shrink-0"><Clock className="h-2.5 w-2.5" />{fmtAge(c.ageMinutes)}</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-sm font-bold tabular-nums">{fmtUsd(c.marketCap)}</div>
          <div className={`font-mono text-[10px] tabular-nums ${pctCls(c.chg1h)}`}>
            {c.chg1h != null ? `${c.chg1h >= 0 ? "+" : ""}${c.chg1h.toFixed(0)}% 1h` : "—"}
          </div>
        </div>
      </div>

      {/* mcap runway bar: 0 → 1M with lime fill */}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted/50">
        <div
          className={`h-full rounded-full ${mcapPct >= 95 ? "bg-orange-400" : "bg-gradient-to-r from-fuchsia-500 to-lime-400"}`}
          style={{ width: `${Math.max(3, mcapPct)}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-muted-foreground">
        <span>runway to $1M cap: {mcapPct.toFixed(0)}%</span>
        <span className="flex items-center gap-2">
          {c.pumpLive && <span className="font-semibold text-rose-400">● LIVE</span>}
          <span className="flex items-center gap-1">
            <Flame className={`h-2.5 w-2.5 ${(c.fomoScore ?? 0) >= 60 ? "text-orange-400" : "text-muted-foreground"}`} />
            fomo {Math.round(c.fomoScore ?? 0)}
          </span>
          <span className={`${(c.socialScore ?? 0) >= 40 ? "text-fuchsia-300" : "text-muted-foreground"}`}>
            social {c.socialScore != null ? Math.round(c.socialScore) : "—"}
          </span>
        </span>
      </div>

      {/* stat row */}
      <div className="mt-2 grid grid-cols-4 gap-1.5 font-mono text-[10px] tabular-nums">
        <Stat label="liq" value={fmtUsd(c.liquidityUsd)} />
        <Stat label="vol 1h" value={fmtUsd(c.vol1h, 0)} />
        <Stat label="accel" value={c.volAccel != null ? `${c.volAccel.toFixed(1)}x` : "—"} hot={(c.volAccel ?? 0) >= 2} />
        <Stat label="buys 5m" value={c.netBuyRatio5m != null ? `${Math.round(c.netBuyRatio5m * 100)}%` : "—"} hot={(c.netBuyRatio5m ?? 0) >= 0.65} />
      </div>

      {/* expanded: reasons + risk + rug flags */}
      {isOpen && (
        <div className="mt-3 space-y-2 border-t border-border/40 pt-2.5">
          <div className="text-[11px] leading-snug text-foreground/90">
            {c.verdictReasons.map((r, i) => <p key={i}>· {r}</p>)}
          </div>
          {c.rugFlags.length > 0 && (
            <div className="rounded-md bg-rose-500/8 p-2">
              {c.rugFlags.map((f, i) => (
                <p key={i} className="flex items-start gap-1 text-[10px] leading-snug text-rose-300">
                  <Skull className="mt-px h-2.5 w-2.5 shrink-0" />{f}
                </p>
              ))}
            </div>
          )}
          {c.risk && (
            <div className="grid grid-cols-2 gap-1.5 rounded-md bg-muted/30 p-2 font-mono text-[10px] tabular-nums sm:grid-cols-3">
              <Stat label="max size" value={`$${c.risk.maxPositionUsd}`} />
              <Stat label="stop" value={`${c.risk.suggestedStopPct}%`} />
              <Stat label="liq bail" value={`${c.risk.liquidityExitStopPct}% liq`} />
              <Stat label="target" value={fmtUsd(c.risk.targetMcap, 0)} />
              <Stat label="multiple" value={c.risk.targetMultiple ? `${c.risk.targetMultiple}x` : "—"} />
              <Stat label="slippage" value={`~${c.risk.estSlippagePct}%`} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 text-[9px]">
            {c.securityCheckedAt == null ? (
              <span className="rounded bg-muted/40 px-1.5 py-0.5 text-muted-foreground">on-chain check pending</span>
            ) : (
              <>
                <span className={`rounded px-1.5 py-0.5 font-semibold ${c.mintAuthorityActive ? "bg-rose-500/20 text-rose-300" : "bg-emerald-500/15 text-emerald-300"}`}>
                  mint {c.mintAuthorityActive ? "ACTIVE" : "revoked ✓"}
                </span>
                <span className={`rounded px-1.5 py-0.5 font-semibold ${c.freezeAuthorityActive ? "bg-rose-500/20 text-rose-300" : "bg-emerald-500/15 text-emerald-300"}`}>
                  freeze {c.freezeAuthorityActive ? "ACTIVE" : "none ✓"}
                </span>
                {c.top10Pct != null && (
                  <span className={`rounded px-1.5 py-0.5 font-semibold ${c.top10Pct > 45 ? "bg-rose-500/20 text-rose-300" : c.top10Pct > 30 ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300"}`}>
                    top10 {c.top10Pct}%
                  </span>
                )}
                {c.rcLpLockedPct != null && (
                  <span className={`rounded px-1.5 py-0.5 font-semibold ${c.rcLpLockedPct < 50 ? "bg-rose-500/20 text-rose-300" : "bg-emerald-500/15 text-emerald-300"}`}>
                    LP {c.rcLpLockedPct}% locked
                  </span>
                )}
              </>
            )}
          </div>
          {c.socialCheckedAt != null && (
            <div className="flex flex-wrap items-center gap-1.5 text-[9px] text-muted-foreground">
              <span>social · bsky {c.bskyMentions1h ?? 0} mentions/1h ({c.bskyMentions10m ?? 0} last 10m)</span>
              {c.pumpReplies != null && <span>· pump.fun {c.pumpReplies} replies{c.pumpReplyPerHr != null ? ` (${c.pumpReplyPerHr >= 0 ? "+" : ""}${c.pumpReplyPerHr}/hr)` : ""}</span>}
            </div>
          )}
          <p className="text-[9px] text-muted-foreground">
            {c.dexId} · {c.chain} · via {c.discoveredVia} · pair {c.pairAddress.slice(0, 10)}…
          </p>
        </div>
      )}
    </button>
  );
}

function Stat({ label, value, hot }: { label: string; value: string; hot?: boolean }) {
  return (
    <div className="rounded bg-muted/25 px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-semibold ${hot ? "text-lime-300" : ""}`}>{value}</div>
    </div>
  );
}

function ScoreRing({ score, accent }: { score: number; accent: string }) {
  const r = 16, c2 = 2 * Math.PI * r;
  const color = accent === "enter" ? "#a3e635" : accent === "watch" ? "#fbbf24" : "#71717a";
  return (
    <div className="relative h-11 w-11 shrink-0">
      <svg viewBox="0 0 40 40" className="h-full w-full -rotate-90">
        <circle cx="20" cy="20" r={r} fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="3.5" />
        <circle cx="20" cy="20" r={r} fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c2} ${c2}`} className="transition-all duration-700" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-bold tabular-nums">
        {score}
      </span>
    </div>
  );
}

// ─── signal log ─────────────────────────────────────────────────────────

function SignalLog({ sig, loading }: { sig?: SignalsResp; loading: boolean }) {
  if (loading) return <FeedSkeleton />;
  if (!sig) return <p className="text-xs text-muted-foreground">no signal data yet.</p>;
  const { stats } = sig;
  return (
    <div className="space-y-3" data-testid="crypto-signal-log">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {[
          ["logged", stats.total, "text-foreground"],
          ["open", stats.open, "text-sky-300"],
          ["hit 5M", stats.hit5m, "text-lime-300"],
          ["doubled", stats.doubled, "text-emerald-300"],
          ["rugged", stats.rugged, "text-rose-300"],
          ["dead", stats.dead, "text-muted-foreground"],
        ].map(([label, val, cls]) => (
          <div key={String(label)} className="rounded-lg border border-border/50 bg-card/50 p-2 text-center">
            <div className={`font-mono text-lg font-bold tabular-nums ${cls}`}>{String(val)}</div>
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{String(label)}</div>
          </div>
        ))}
      </div>
      {!stats.calibrated && (
        <p className="text-[10px] text-muted-foreground">
          calibration unlocks at 50 graded outcomes — until then these stats are the whole product: proving or killing the edge.
        </p>
      )}
      <div className="space-y-1.5">
        {sig.signals.length === 0 && (
          <p className="text-xs text-muted-foreground">no signals logged yet — the bar is meant to be high. check back after a session of scanning.</p>
        )}
        {sig.signals.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border/40 bg-card/40 px-2.5 py-2 text-[11px]" data-testid={`crypto-signal-${String(s.id).slice(0, 8)}`}>
            <Badge variant="outline" className={`px-1.5 text-[9px] ${
              s.verdict === "ENTER" ? "border-lime-400/50 text-lime-300" : "border-amber-400/40 text-amber-300"
            }`}>{s.verdict}</Badge>
            <span className="font-mono font-bold">{s.symbol}</span>
            <span className="text-muted-foreground">@{fmtUsd(s.mcap_at_signal)}</span>
            <TrendingUp className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono tabular-nums text-muted-foreground">peak {fmtUsd(s.peak_mcap)}</span>
            <span className={`ml-auto font-semibold ${
              s.outcome === "HIT_5M" ? "text-lime-300" : s.outcome === "DOUBLED" ? "text-emerald-300"
              : s.outcome === "RUGGED" ? "text-rose-300" : s.outcome === "DEAD" ? "text-muted-foreground" : "text-sky-300"
            }`}>{s.outcome}</span>
            <span className="hidden text-[9px] text-muted-foreground sm:block">
              {new Date(Number(s.detected_at)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="h-28 animate-pulse rounded-xl border border-border/40 bg-muted/20" />
      ))}
    </div>
  );
}
