// CryptoPanel — digital assets: exchange-direct majors plus a small-cap launch scanner with honest verdicts.
//
// Design: Gen Z degen energy (neon purple/lime, glow accents, big score rings)
// but every number is real and every risk flag is shown. FOMO meter, narrative
// heat chips, agent health strip with pulsing status dots, graded audit log.
// Tracking mode is displayed loudly until calibration exists (n>=50 graded).
// Sources (server/sources/registry.ts): BTC/ETH/SOL exchange-direct from
// Coinbase Exchange + Kraken (cross-checked); DEX data from DexScreener with
// a Jupiter price check; Bluesky and pump.fun (unofficial API) are labeled
// low-grade attention proxies and are not in the score or verdict.

import type { DerivsSnapshot, DerivsRow } from "@shared/cryptoFunding";
import type { Gate, GateSummary, HolderStress } from "@shared/cryptoAutopsy";
import { apiJson } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import {
  Flame, Radar, Newspaper, Activity, ShieldAlert, Skull,
  Eye, XCircle, Zap, HeartPulse, TrendingUp, Clock,
} from "lucide-react";
import MemeStructureSection, { CategoryChip, LineChip } from "@/components/MemeStructure";
import { VERDICT_CODE_TEXT } from "@shared/cryptoVerdict";
import type { CryptoReplay } from "@shared/cryptoReplay";
import type { LinePosition, MemeClass, TradeCost } from "@shared/memeStructure";

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
  top10Pct: number | null; top10Method?: string | null; securityCheckedAt: number | null;
  rcRisks: string[]; rcLpLockedPct: number | null;
  bskyMentions1h: number | null; bskyMentions10m: number | null;
  bskyMentionsByAddress1h?: number | null; bskyCapped?: boolean;
  pumpReplies: number | null; pumpReplyPerHr: number | null; pumpCheckedAt?: number | null;
  socialSources?: { bsky: "ok" | "failed" | "skipped"; pump: "ok" | "failed" | "skipped" } | null;
  socialCoverage?: string | null;
  pumpLive: boolean; socialScore: number | null; socialCheckedAt: number | null;
  // collection state: a failed/stale collection is NOT zero attention
  socialStatus?: "ok" | "partial" | "failed" | "stale" | "unavailable" | null;
  volAccel: number | null; netBuyRatio5m: number | null;
  fomoScore: number | null; memeScore: number | null;
  narrativeHits: string[]; rugFlags: string[]; hardKill: boolean;
  jupPriceUsd?: number | null; jupGapPct?: number | null; jupCheckedAt?: number | null;
  jupState?: "agree" | "watch" | "diverge" | "no-reliable-price" | "failed" | "unchecked";
  score: number | null; verdict: Verdict; verdictCode?: string | null; verdictReasons: string[];
  risk: {
    maxPositionUsd: number; suggestedStopPct: number; liquidityExitStopPct: number;
    targetMcap: number; targetMultiple: number | null; estSlippagePct: number;
    holdHorizonHours: number; notes: string[];
  } | null;
  structure?: { line: LinePosition; category: MemeClass; cost: TradeCost } | null;
}

interface TradeFlow {
  count: number; takerBuyShare: number | null; vwap: number | null; notionalUsd: number;
  largestUsd: number | null; coveredSec: number; lastTradeMs: number | null;
}
interface VenueCell {
  state: "ok" | "stale" | "failed"; mid: number | null; spreadBps: number | null; last: number | null;
  lastTradeUtc: string | null; volume24h: number | null; flow: TradeFlow | null; error: string | null;
}
interface MajorRow {
  asset: "BTC" | "ETH" | "SOL";
  coinbase: VenueCell;
  kraken: VenueCell & { vwap24h: number | null };
  cross: { state: "agree" | "watch" | "diverge" | "single-source" | "unavailable"; divergenceBps: number | null; reference: number | null; note: string };
  coingecko: { price: number | null; deviationBps: number | null; asOfUtc: string | null; label: string };
}
interface MajorsSnapshot {
  asOf: number; state: "ok" | "partial" | "unavailable"; rows: MajorRow[]; note: string;
  sources: Array<{ id: string; name: string; tier: string; state: "ok" | "partial" | "failed" | "not_configured"; fetchedAtUtc: string | null; error: string | null }>;
}
interface SourceLabel { id: string; name: string; tier: string; tierLabel: string; weakReason: string | null; feeds: string }

interface FeedResp {
  asOf: number; trackedCount: number; candidates: Candidate[];
  narrativeHeat: Array<{ term: string; hits: number; sources: string[] }>;
  narrativeUpdatedAt: number | null;
  narrativeSources?: Array<{ name: string; state: "ok" | "empty" | "failed"; titles: number; undated: number }>;
  majors?: MajorsSnapshot | null;
  derivs?: DerivsSnapshot | null;
  sourceLabels?: SourceLabel[];
}

interface HealthResp {
  engines: Array<{ name: string; status: string; lastOkAt: number | null; runs: number; errors: number; lastError: string | null }>;
  trackedCount: number; asOf: number;
}

interface SignalCounts {
  total: number; open: number; hit5m: number; doubled: number; rugged: number; dead: number;
  graded: number; sampleReady: boolean; minGradedForSample: number;
  noData?: number; // past the 72h horizon but unpriceable: missing, not dead
}

interface Survivorship {
  noDataShare: number | null;
  ruggedRateObserved: number | null;
  ruggedRateWorstCase: number | null;
  winRateWorstCase: number | null;
}

interface SignalsResp {
  signals: any[];
  // top-level counts = DISTINCT COINS (first signal per coin); sampleReady =
  // graded coins ≥ 50 (a sample-size flag, not calibration). rows = every
  // logged WATCH/ENTER row; enterCoins = first ENTER per coin.
  stats: SignalCounts & {
    basis?: string;
    noDataShare?: number | null;
    rows?: SignalCounts;
    enterCoins?: SignalCounts;
    // round 3: sampleReady is decided on first-ENTER coins and needs a
    // readable no-data share; survivorship bounds count NO_DATA as RUGGED.
    survivorship?: { coins: Survivorship; enterCoins: Survivorship };
    sampleBasis?: string;
    sampleReason?: string;
    peakSampling?: string;
  };
  // Net return of a $100 position per first-ENTER coin under a stated exit
  // rule (shared/cryptoExpectancy.ts): bookkeeping on what happened, not a forecast.
  expectancy?: { graded: Expectancy; hold: Expectancy; peak: Expectancy; basis: string; versions?: Record<string, number>; currentVersion?: string };
  /** Persistent desk risk state from the majors read; off or unknown holds every candidate at WATCH. */
  desk?: { state: "on" | "off" | "unknown"; reason: string; asOf: number | null; btcVsVwap24hPct: number | null };
  /** The versioned rule book every verdict and grade on this tab comes from (shared/cryptoRules.ts). */
  rules?: { version: string; items: Array<{ path: string; value: string; text: string }> };
}

interface Expectancy {
  rule: "graded" | "hold" | "peak";
  sizeUsd: number;
  n: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  medianNetPct: number | null;
  meanNetPct: number | null;
  positiveShare: { yes: number; of: number; lo: number | null; hi: number | null };
  worstNetPct: number | null;
  bestNetPct: number | null;
  sampleReady: boolean;
  minSample: number;
  validation: "PASSES PREDEFINED TESTS" | "MIXED RESULTS" | "NO DEMONSTRATED EDGE" | "INSUFFICIENT DATA";
  note: string;
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

// ─── contract autopsy ───────────────────────────────────────────────────

interface AutopsyResp {
  dataState: "ok" | "invalid_input" | "not_found" | "rate_limited" | "source_failed";
  reason: string | null; retryAfterSec: number | null; asOf: number; cached: boolean; mint: string | null;
  pair: { pairAddress: string; dexId: string; poolsFound: number; selectedBy: string; ageMinutes: number | null } | null;
  snapshot: { symbol: string; name: string; priceUsd: number | null; marketCap: number | null; fdv: number | null; liquidityUsd: number | null; vol24h: number | null; chg1h: number | null } | null;
  gates: Gate[]; summary: GateSummary | null;
  desk: { verdict: Verdict; verdictCode: string | null; verdictText: string | null; score: number | null; hardKill: boolean; reasons: string[]; flags: string[] } | null;
  parity: { agrees: boolean; detail: string | null } | null;
  tracked: { verdict: Verdict; verdictCode: string | null; firstSeenAt: number } | null;
  stress: HolderStress | null;
  sourceNotes: string[]; notes: string[];
}

const GATE_WORD: Record<Gate["severity"], Record<Gate["state"], string>> = {
  kill: { pass: "pass", fail: "KILL", unread: "unread" },
  flag: { pass: "pass", fail: "flagged", unread: "unread" },
  entry: { pass: "met", fail: "not met", unread: "unread" },
};
const GATE_CLS: Record<Gate["state"], string> = { pass: "text-emerald-300", fail: "text-red-300", unread: "text-amber-300" };
const GATE_GROUPS: Array<{ sev: Gate["severity"]; title: string; note: string }> = [
  { sev: "kill", title: "Hard kills", note: "any one of these and the desk rejects the coin whatever its score" },
  { sev: "flag", title: "Flags", note: "they lower the structure score; none is a kill on its own" },
  { sev: "entry", title: "Entry conditions", note: "what an ENTER needs on top of a clean read" },
];

function AutopsyCard() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AutopsyResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    if (busy || !text.trim()) return;
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await apiJson<AutopsyResp>("GET", `/api/crypto/autopsy?mint=${encodeURIComponent(text.trim())}`)); }
    catch { setErr("No result. The server may be unavailable or running an older build."); }
    finally { setBusy(false); }
  };
  const ok = res?.dataState === "ok" ? res : null;
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3 space-y-2" data-testid="crypto-autopsy">
      <div className="text-sm font-semibold text-foreground">Contract autopsy</div>
      <p className="text-[11px] text-muted-foreground">Paste a Solana token's contract address. The desk reads it once, from the same sources it uses for its own list, and shows each rule with the value read and whether it was read at all. A single read: not a signal, not logged, not graded.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void run(); }} placeholder="token contract address" className="min-h-[44px] flex-1 font-mono text-xs" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-testid="crypto-autopsy-input" />
        <Button size="sm" variant="outline" className="min-h-[44px] sm:min-w-[120px]" onClick={run} disabled={busy || !text.trim()} data-testid="crypto-autopsy-run">{busy ? "Reading…" : "Run autopsy"}</Button>
      </div>
      {err && <div role="status" className="text-[11px] text-amber-300" data-testid="crypto-autopsy-error">{err}</div>}
      {res && !ok && (
        <div role="status" className="text-[11px] text-amber-300" data-testid="crypto-autopsy-state">
          {res.dataState === "rate_limited" ? `Wait about ${res.retryAfterSec ?? 6} s and run it again. ` : ""}{res.reason}
        </div>
      )}
      {ok && ok.snapshot && ok.summary && ok.desk && (
        <div className="space-y-3 text-[11px]" data-testid="crypto-autopsy-body">
          <div className="rounded border border-border/40 p-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="min-w-0 break-words text-sm font-semibold text-foreground">{ok.snapshot.symbol || "?"} <span className="font-normal text-muted-foreground">{ok.snapshot.name}</span></span>
              <span className="font-mono text-muted-foreground">{ok.cached ? "recent read" : "read"} {new Date(ok.asOf).toLocaleTimeString()}</span>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono tabular-nums text-muted-foreground sm:grid-cols-4">
              <span>cap <span className="text-foreground">{ok.snapshot.marketCap != null ? fmtUsd(ok.snapshot.marketCap) : "n/a"}</span></span>
              <span>liquidity <span className="text-foreground">{ok.snapshot.liquidityUsd != null ? fmtUsd(ok.snapshot.liquidityUsd) : "n/a"}</span></span>
              <span>24h vol <span className="text-foreground">{ok.snapshot.vol24h != null ? fmtUsd(ok.snapshot.vol24h) : "n/a"}</span></span>
              <span>1h <span className="text-foreground">{ok.snapshot.chg1h != null ? `${ok.snapshot.chg1h >= 0 ? "+" : ""}${ok.snapshot.chg1h.toFixed(0)}%` : "n/a"}</span></span>
            </div>
            <div className="mt-1 text-muted-foreground">
              On this one read the desk's rules say <span className="font-semibold text-foreground" data-testid="crypto-autopsy-verdict">{ok.desk.verdict ?? "none"}</span>
              {ok.desk.verdictText ? `: ${ok.desk.verdictText}` : ""}{ok.desk.score != null ? ` · heuristic score ${ok.desk.score}` : ""}.
              {(ok.gates ?? []).some((g) => g.severity === "kill" && g.state === "unread") ? (
                <span className="text-amber-600 dark:text-amber-400" data-testid="crypto-autopsy-notfinal"> {(ok.gates ?? []).filter((g) => g.severity === "kill" && g.state === "unread").length} kill check(s) unread; this verdict is not final.</span>
              ) : null}
              {ok.tracked ? ` The desk has also been tracking it since ${new Date(ok.tracked.firstSeenAt).toLocaleString()} (currently ${ok.tracked.verdict ?? "unscored"}).` : ""}
            </div>
            <div className="mt-1 font-mono text-muted-foreground" data-testid="crypto-autopsy-counts">
              {ok.summary.pass} pass · {ok.summary.fail} not met ({ok.summary.killFails} kill, {ok.summary.flagFails} flag) · {ok.summary.unread} unread
            </div>
          </div>
          {ok.parity && !ok.parity.agrees && <div role="status" className="text-red-300" data-testid="crypto-autopsy-parity">The gate table and the desk's own hard-kill result disagree: {ok.parity.detail}. This is a defect; report it.</div>}
          {GATE_GROUPS.map((grp) => {
            const rows = ok.gates.filter((g) => g.severity === grp.sev);
            return (
              <section key={grp.sev} data-testid={`crypto-autopsy-${grp.sev}`}>
                <div className="text-[11px] font-medium text-muted-foreground">{grp.title} · {grp.note}</div>
                <ul className="mt-1 space-y-1">
                  {rows.map((g) => (
                    <li key={g.id} className="min-w-0 rounded border border-border/40 p-2 leading-snug" data-testid={`crypto-autopsy-gate-${g.id}`}>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                        <span className="font-medium text-foreground">{g.label} <span className="font-normal text-muted-foreground">· rule: {g.rule}</span></span>
                        <span className={`font-semibold uppercase ${GATE_CLS[g.state]}`}>{GATE_WORD[g.severity][g.state]}</span>
                      </div>
                      <div className="break-words font-mono text-muted-foreground">read: {g.value}</div>
                      {g.detail && <div className="break-words text-muted-foreground">{g.detail}</div>}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {ok.stress && (
            <section data-testid="crypto-autopsy-stress">
              <div className="text-[11px] font-medium text-muted-foreground">Holder-dump stress test · if the top-10 holders sold part of their position into the pool</div>
              {ok.stress.dataState !== "ok" ? (
                <div className="mt-1 text-amber-300">unavailable: {ok.stress.reason}</div>
              ) : (
                <>
                  <div className="mt-1 font-mono tabular-nums text-muted-foreground">top-10 hold {ok.stress.top10Pct}% of supply, about {fmtUsd(ok.stress.top10ValueUsd ?? 0)} at the current price ({ok.stress.basis === "fdv" ? "FDV basis" : "market-cap basis"}); pool quote side about {fmtUsd(ok.stress.quoteReserveUsd ?? 0)}</div>
                  <div className="mt-1 overflow-x-auto">
                    <table className="w-full min-w-[420px] font-mono tabular-nums">
                      <thead><tr className="text-muted-foreground"><th className="text-left">sold</th><th className="text-right">value</th><th className="text-right">x pool quote</th><th className="text-right">price falls</th><th className="text-right">sellers receive</th></tr></thead>
                      <tbody>
                        {ok.stress.scenarios.map((sc) => (
                          <tr key={sc.soldFraction} className="border-t border-border/30">
                            <td>{Math.round(sc.soldFraction * 100)}% of their holding</td><td className="text-right">{fmtUsd(sc.soldValueUsd)}</td><td className="text-right">{sc.soldVsQuoteReserve.toFixed(2)}x</td>
                            <td className="text-right text-foreground">-{sc.priceImpactPct.toFixed(1)}%</td><td className="text-right">{fmtUsd(sc.proceedsUsd)} ({sc.proceedsPctOfValue.toFixed(0)}%)</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">{ok.stress.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
                </>
              )}
            </section>
          )}
          {ok.sourceNotes.length > 0 && <div className="text-amber-300" data-testid="crypto-autopsy-sources">Not read on this pass: {ok.sourceNotes.join("; ")}.</div>}
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">{ok.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ─── perpetual funding and open interest strip ──────────────────────────
const fmtSigned = (v: number | null, dp: number, suffix = ""): string => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(dp)}${suffix}`);

function DerivsStrip({ derivs, loaded }: { derivs: DerivsSnapshot | null; loaded: boolean }) {
  if (!derivs) {
    return <div className="rounded-lg border border-border/50 p-2 text-[11px] text-muted-foreground" data-testid="crypto-derivs">{loaded ? "funding and open interest: no exchange read yet" : "funding and open interest: loading"}</div>;
  }
  const tiles = (["BTC", "ETH", "SOL"] as const).map((a) => ({ a, row: derivs.rows.find((r) => r.asset === a && r.state === "ok") as DerivsRow | undefined }));
  const down = derivs.rows.filter((r) => r.state !== "ok");
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-2.5" data-testid="crypto-derivs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className="font-semibold">funding and open interest · perpetuals</span>
        <span className={derivs.state === "ok" ? "text-emerald-300" : derivs.state === "partial" ? "text-amber-300" : "text-rose-300"}>{derivs.state}</span>
      </div>
      <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        {tiles.map(({ a, row }) => (
          <div key={a} className="rounded border border-border/40 p-2 text-xs" data-testid={`derivs-${a}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground">{a}</span>
              <span className="text-[10px] uppercase text-muted-foreground">{row ? row.venue : "no read"}</span>
            </div>
            {row ? (
              <div className="mt-1 space-y-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                <div>funding {fmtSigned(row.fundingPct, 4, "%")}{row.fundingIntervalHours != null ? ` / ${row.fundingIntervalHours}h` : " / interval not stated"}</div>
                <div>{row.direction ?? "n/a"}{row.funding8hPct != null && row.fundingIntervalHours !== 8 ? ` · ${fmtSigned(row.funding8hPct, 4, "%")} per 8h` : ""}</div>
                <div>open interest 1h {row.oiState === "ok" ? fmtSigned(row.oi1hChangePct, 2, "%") : row.oiState === "building" ? "building (first hour after a restart)" : "not reported"}</div>
              </div>
            ) : <div className="mt-1 text-[11px] text-muted-foreground">unavailable</div>}
          </div>
        ))}
      </div>
      {down.length > 0 && (
        <div className="mt-1 text-[11px] text-muted-foreground" data-testid="derivs-down">
          not reading: {down.map((r) => `${r.venue} ${r.asset} (${r.reason ?? r.state})`).join("; ")}
        </div>
      )}
      <div className="mt-1 text-[11px] text-muted-foreground">{derivs.note}. Stored on each signal so the replay can test it; the desk applies no rule to it yet.</div>
    </div>
  );
}

// ─── majors strip ───────────────────────────────────────────────────────

const fmtPx = (v: number | null) =>
  v == null ? "—" : v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toLocaleString("en-US", { maximumFractionDigits: 2 });

const CROSS_COLOR: Record<MajorRow["cross"]["state"], string> = {
  agree: "text-emerald-300", watch: "text-amber-300", diverge: "text-rose-300", "single-source": "text-amber-300", unavailable: "text-rose-300",
};

function VenueLine({ name, v }: { name: string; v: VenueCell }) {
  const f = v.flow;
  return (
    <div className="text-[11px] text-muted-foreground" title={v.error ?? undefined}>
      <span className="font-semibold text-foreground/80">{name}</span>{" "}
      {v.state === "failed" ? <span className="text-rose-300">failed</span>
        : <>
            <span className={v.state === "stale" ? "text-amber-300" : undefined}>{v.state === "stale" ? "stale · " : ""}mid {fmtPx(v.mid)}</span>
            {v.spreadBps != null && <> · spr {v.spreadBps.toFixed(1)} bps</>}
            {f && (f.count > 0
              ? <> · taker buy {Math.round((f.takerBuyShare ?? 0) * 100)}% of {f.count} trades / {Math.round(f.coveredSec / 60)}m</>
              : <> · 0 trades in window (observed)</>)}
            {v.lastTradeUtc && <> · last {new Date(v.lastTradeUtc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</>}
          </>}
    </div>
  );
}

function MajorsStrip({ majors, loaded }: { majors: MajorsSnapshot | null; loaded: boolean }) {
  if (!loaded) return null;
  if (!majors) {
    return <div className="rounded-lg border border-border/50 p-2 text-[11px] text-muted-foreground">majors: first exchange read pending</div>;
  }
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-2.5" data-testid="crypto-majors">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <TrendingUp className="h-3.5 w-3.5 text-lime-400" />
        <span className="font-semibold">majors · exchange-direct</span>
        <span className={majors.state === "ok" ? "text-emerald-300" : majors.state === "partial" ? "text-amber-300" : "text-rose-300"}>{majors.state}</span>
        {majors.sources.map((x) => (
          <span key={x.id} className="text-muted-foreground" title={x.error ?? undefined}>
            · {x.name} ({x.tier}) <span className={x.state === "ok" ? "text-emerald-300" : x.state === "not_configured" ? undefined : x.state === "partial" ? "text-amber-300" : "text-rose-300"}>{x.state === "not_configured" ? "not configured" : x.state}</span>
          </span>
        ))}
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {majors.rows.map((r) => (
          <div key={r.asset} className="rounded border border-border/40 p-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-sm font-bold">{r.asset}</span>
              <span className="font-mono text-sm tabular-nums">{r.cross.reference != null ? `$${fmtPx(r.cross.reference)}` : "no reference"}</span>
            </div>
            <div className={`text-[11px] ${CROSS_COLOR[r.cross.state]}`}>
              {r.cross.state}{r.cross.divergenceBps != null ? ` · ${r.cross.divergenceBps.toFixed(1)} bps` : ""} · {r.cross.note}
            </div>
            <VenueLine name="Coinbase" v={r.coinbase} />
            <VenueLine name="Kraken" v={r.kraken} />
            {r.coingecko.price != null && (
              <div className="text-[11px] text-muted-foreground" title={r.coingecko.label}>
                CoinGecko ref ${fmtPx(r.coingecko.price)}{r.coingecko.deviationBps != null ? ` (${r.coingecko.deviationBps >= 0 ? "+" : ""}${r.coingecko.deviationBps.toFixed(0)} bps)` : ""} · reference only
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{majors.note}. Taker flow from public trade prints; context, not a signal.</div>
    </div>
  );
}

// ─── desk brief: the one-glance read for someone with no time ────────────

function DeskBrief({ feed, health, sig, enters, watches, onPick }: {
  feed?: FeedResp; health?: HealthResp; sig?: SignalsResp;
  enters: Candidate[]; watches: Candidate[]; onPick: (c: Candidate) => void;
}) {
  const engines = (health?.engines ?? []).filter((e) => e.name !== "watchdog");
  const notOk = engines.filter((e) => e.status !== "ok");
  const picks = [...enters, ...[...watches].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))].slice(0, 3);
  const rec = sig?.stats.enterCoins;
  const headline = !feed ? "Reading the desk…"
    : enters.length > 0 ? `${enters.length} coin${enters.length === 1 ? "" : "s"} clear${enters.length === 1 ? "s" : ""} every ENTER rule right now`
    : watches.length > 0 ? `Nothing clears every ENTER rule. ${watches.length} forming`
    : "Nothing clears the bar right now";
  return (
    <div className="min-h-[15rem] rounded-xl border border-border/60 bg-card/60 p-4 sm:min-h-[11rem]" data-testid="crypto-brief">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">Digital assets · new Solana launches, scored by fixed rules</div>
          <h2 className="mt-0.5 break-words text-lg font-semibold tracking-tight" data-testid="crypto-brief-headline">{headline}</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {feed ? `${feed.trackedCount} pools tracked · updated ${new Date(feed.asOf ?? Date.now()).toLocaleTimeString()}` : "warming up"}
            {notOk.length > 0 ? ` · ${notOk.map((e) => `${e.name} ${e.status}`).join(", ")}` : engines.length > 0 ? " · all agents running" : ""}
          </p>
        </div>
        <AgentStrip health={health} />
      </div>
      {picks.length > 0 && (
        <ul className="mt-3 grid gap-2 sm:grid-cols-3" data-testid="crypto-brief-picks">
          {picks.map((c) => (
            <li key={`${c.chain}:${c.pairAddress}`} className="min-w-0">
              <button type="button" onClick={() => onPick(c)} className="min-h-[44px] w-full rounded-lg border border-border/60 p-2 text-left transition hover:border-foreground/30">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-sm font-bold">{c.symbol}</span>
                  <span className={`text-[11px] font-semibold ${c.verdict === "ENTER" ? "text-lime-300" : "text-amber-300"}`}>{c.verdict === "ENTER" ? "Enter" : "Watch"}{c.score != null ? ` · ${c.score}` : ""}</span>
                </div>
                <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  cap {c.marketCap != null ? fmtUsd(c.marketCap) : "n/a"} · liq {c.liquidityUsd != null ? fmtUsd(c.liquidityUsd) : "n/a"}
                </div>
                {c.verdictReasons[0] && <div className="mt-0.5 line-clamp-2 break-words text-[11px] text-muted-foreground">{c.verdictReasons[0]}</div>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 border-t border-border/40 pt-2 text-[11px] text-muted-foreground" data-testid="crypto-brief-record">
        {rec
          ? `Record so far: ${rec.graded} of ${rec.minGradedForSample} graded first-ENTER coins needed${rec.sampleReady ? " (sample reached)" : ""}; ${rec.hit5m} hit the 5-minute target, ${rec.doubled} doubled, ${rec.rugged} rugged, ${rec.dead} dead. Heuristic scores, not calibrated odds. The desk never places orders.`
          : "Record so far: loading. Heuristic scores, not calibrated odds. The desk never places orders."}
      </div>
    </div>
  );
}

// ─── main panel ─────────────────────────────────────────────────────────

export default function CryptoPanel() {
  const [view, setView] = useState<"feed" | "signals">("feed");
  const [expanded, setExpanded] = useState<string | null>(null);

  const feedQ = useQuery<FeedResp>({ queryKey: ["/api/crypto/feed"], refetchInterval: 45_000 });
  const healthQ = useQuery<HealthResp>({ queryKey: ["/api/crypto/health"], refetchInterval: 30_000 });
  const sigQ = useQuery<SignalsResp>({ queryKey: ["/api/crypto/signals"], refetchInterval: 120_000 });

  const feed = feedQ.data;
  const enters = feed?.candidates.filter((c) => c.verdict === "ENTER") ?? [];
  const watches = feed?.candidates.filter((c) => c.verdict === "WATCH") ?? [];
  const passes = feed?.candidates.filter((c) => c.verdict === "PASS").slice(0, 20) ?? [];

  return (
    <div className="space-y-4" data-testid="crypto-panel">
      <DeskBrief feed={feed} health={healthQ.data} sig={sigQ.data} enters={enters} watches={watches}
        onPick={(c) => { setView("feed"); setExpanded(`${c.chain}:${c.pairAddress}`); }} />

      {/* paste any Solana token address: every desk rule, gate by gate, plus a holder-dump stress test */}
      <AutopsyCard />

      {/* tracking-mode banner until the graded sample is large enough */}
      <TrackingBanner sig={sigQ.data} view={view} />

      {/* BTC / ETH / SOL exchange-direct, cross-checked */}
      <MajorsStrip majors={feed?.majors ?? null} loaded={!!feed} />

      {/* perpetual funding + open interest: recorded context, not a rule input */}
      <DerivsStrip derivs={feed?.derivs ?? null} loaded={!!feed} />

      {/* narrative heat */}
      <div className="flex flex-wrap items-center gap-1.5" data-testid="crypto-narratives">
        <Newspaper className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="mr-1 text-[11px] font-medium text-muted-foreground">narrative heat</span>
        {(feed?.narrativeHeat ?? []).slice(0, 10).map((n) => (
          <span
            key={n.term}
            className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${
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
          <span className="text-[11px] text-muted-foreground">
            {feed?.narrativeUpdatedAt == null ? "warming up…" : "no tracked terms in the last 24 h (observed)"}
          </span>
        )}
        {(feed?.narrativeSources ?? []).map((x) => (
          <span key={x.name} className={`text-[11px] ${x.state === "failed" ? "text-rose-300" : "text-muted-foreground"}`}
            title={`${x.name} RSS (publisher): ${x.titles} titles in 24 h${x.undated ? `, ${x.undated} undated ignored` : ""}`}>
            · {x.name} {x.state === "ok" ? "ok" : x.state === "empty" ? "0 recent" : "failed"}
          </span>
        ))}
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
        <span className="ml-auto text-[11px] text-muted-foreground">
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
                title="Enter · flow confirmed, under $1M"
                empty="nothing clears the bar right now. that's the system working, not broken."
                items={enters} expanded={expanded} setExpanded={setExpanded} accent="enter"
              />
              <Section
                icon={<Eye className="h-4 w-4 text-amber-400" />}
                title="Watch · forming, waiting on flow"
                empty="no setups forming."
                items={watches} expanded={expanded} setExpanded={setExpanded} accent="watch"
              />
              <Section
                icon={<XCircle className="h-4 w-4 text-muted-foreground" />}
                title="Pass · seen and rejected"
                empty="scanner warming up…"
                items={passes} expanded={expanded} setExpanded={setExpanded} accent="pass" collapsedByDefault
              />
            </>
          )}
          <MemeStructureSection />
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
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/50 bg-background/50 px-3 py-2 backdrop-blur" data-testid="crypto-agent-strip">
      <HeartPulse className="h-3.5 w-3.5 text-muted-foreground" />
      {(health?.engines ?? []).filter((e) => e.name !== "watchdog").map((e) => (
        <div key={e.name} className="flex items-center gap-1.5" title={`${e.name}: ${e.status} · ${e.runs} runs · ${e.errors} errors${e.lastError ? ` · ${e.lastError}` : ""}`}>
          <span className={`h-2 w-2 rounded-full ${dot(e.status)}`} />
          <span className="text-[11px] font-medium text-muted-foreground">{e.name}</span>
        </div>
      ))}
      {(health?.engines ?? []).length === 0 && (
        <span className="text-[11px] text-muted-foreground">agents booting…</span>
      )}
    </div>
  );
}

// ─── tracking banner ────────────────────────────────────────────────────

function TrackingBanner({ sig, view }: { sig?: SignalsResp; view: string }) {
  // Round 3: the gate a trader cares about is on first-ENTER coins.
  const enter = sig?.stats.enterCoins;
  const graded = enter ? enter.graded : sig ? sig.stats.graded : null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
      <p className="text-[11px] leading-snug text-amber-200/90">
        <span className="font-semibold">Tracking mode.</span> Every ENTER and WATCH is logged and graded, but nothing here is stakeable until the audited hit rate exists (n≥50 distinct first-ENTER coins, no-data share 20% or less{graded != null ? `; ${graded} graded so far${sig?.stats.sampleReady ? ", sample-ready" : ""}` : ""}). Sub-$1M memes are a &gt;90% loss-rate arena.
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
        <span className="text-sm font-semibold">{title}</span>
        <span className="rounded-full bg-muted/60 px-1.5 text-[11px] text-muted-foreground">{items.length}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{open ? "hide" : "show"}</span>
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
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-sm font-bold">{c.symbol}</span>
            {c.pumpfunGraduate && (
              <span className="rounded bg-emerald-500/15 px-1 py-px text-[11px] font-semibold text-emerald-300" title="graduated the pump.fun bonding curve">
                pump.fun grad
              </span>
            )}
            {c.boosted && (
              <span className="rounded bg-orange-500/15 px-1 py-px text-[11px] font-semibold text-orange-300" title="paid DexScreener boost — manufactured attention">
                paid boost
              </span>
            )}
            {c.narrativeHits.length > 0 && (
              <span className="rounded bg-fuchsia-500/15 px-1 py-px text-[11px] font-semibold text-fuchsia-300">
                news: {c.narrativeHits[0]}
              </span>
            )}
            <LineChip line={c.structure?.line} />
            <CategoryChip k={c.structure?.category} />
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{c.name}</span>
            <span className="flex items-center gap-0.5 shrink-0"><Clock className="h-2.5 w-2.5" />{fmtAge(c.ageMinutes)}</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-sm font-bold tabular-nums">{fmtUsd(c.marketCap)}</div>
          <div className={`font-mono text-[11px] tabular-nums ${pctCls(c.chg1h)}`}>
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
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>runway to $1M cap: {mcapPct.toFixed(0)}%</span>
        <span className="flex items-center gap-2">
          {c.pumpLive && <span className="font-semibold text-rose-400">● LIVE</span>}
          <span className="flex items-center gap-1">
            <Flame className={`h-2.5 w-2.5 ${(c.fomoScore ?? 0) >= 60 ? "text-orange-400" : "text-muted-foreground"}`} />
            fomo {Math.round(c.fomoScore ?? 0)}
          </span>
          <span
            className={`${(c.socialScore ?? 0) >= 40 ? "text-fuchsia-300" : "text-muted-foreground"}`}
            title="social attention proxy (Bluesky, pump.fun unofficial API): low grade, shown only, not in the score or verdict"
          >
            social (low-grade) {c.socialScore != null ? Math.round(c.socialScore) : "—"}
            {c.socialStatus && c.socialStatus !== "ok" && (
              <span className="ml-0.5 text-[11px] text-amber-300/80" title="social collection state — not zero attention">
                {c.socialStatus}
              </span>
            )}
          </span>
        </span>
      </div>

      {/* stat row */}
      <div className="mt-2 grid grid-cols-2 gap-1.5 font-mono text-[11px] tabular-nums xs:grid-cols-4">
        <Stat label="liq" value={fmtUsd(c.liquidityUsd)} />
        <Stat label="vol 1h" value={fmtUsd(c.vol1h, 0)} />
        <Stat label="accel" value={c.volAccel != null ? `${c.volAccel.toFixed(1)}x` : "—"} hot={(c.volAccel ?? 0) >= 2} />
        <Stat label="buys 5m" value={c.netBuyRatio5m != null ? `${Math.round(c.netBuyRatio5m * 100)}%` : "—"} hot={(c.netBuyRatio5m ?? 0) >= 0.65} />
      </div>

      {/* expanded: reasons + risk + rug flags */}
      {isOpen && (
        <div className="mt-3 space-y-2 border-t border-border/40 pt-2.5">
          <div className="text-[11px] leading-snug text-foreground/90">
            {c.verdictCode && <p className="font-mono text-[11px] font-medium text-muted-foreground" data-testid={`crypto-verdict-code-${c.verdictCode}`}>code {c.verdictCode}: {VERDICT_CODE_TEXT[c.verdictCode as keyof typeof VERDICT_CODE_TEXT] ?? "—"}</p>}
            {c.verdictReasons.map((r, i) => <p key={i}>· {r}</p>)}
          </div>
          {c.rugFlags.length > 0 && (
            <div className="rounded-md bg-rose-500/8 p-2">
              {c.rugFlags.map((f, i) => (
                <p key={i} className="flex items-start gap-1 text-[11px] leading-snug text-rose-300">
                  <Skull className="mt-px h-2.5 w-2.5 shrink-0" />{f}
                </p>
              ))}
            </div>
          )}
          {c.risk && (
            <div className="grid grid-cols-2 gap-1.5 rounded-md bg-muted/30 p-2 font-mono text-[11px] tabular-nums sm:grid-cols-3">
              <Stat label="max size" value={`$${c.risk.maxPositionUsd}`} />
              <Stat label="stop" value={`${c.risk.suggestedStopPct}%`} />
              <Stat label="liq bail" value={`${c.risk.liquidityExitStopPct}% liq`} />
              <Stat label="target" value={fmtUsd(c.risk.targetMcap, 0)} />
              <Stat label="multiple" value={c.risk.targetMultiple ? `${c.risk.targetMultiple}x` : "—"} />
              <Stat label="round trip" value={c.structure?.cost.roundTripPct != null ? `${c.structure.cost.roundTripPct}%` : "not reported"} />
            </div>
          )}
          {c.structure && (
            <p className="text-[11px] leading-snug text-muted-foreground" data-testid={`crypto-structure-${c.pairAddress.slice(0, 8)}`}>
              structure · {c.structure.line.note}
              {c.structure.cost.roundTripPct != null
                ? ` · a ${c.structure.cost.sizeUsd >= 1000 ? `$${(c.structure.cost.sizeUsd / 1000).toFixed(1)}k` : `$${Math.round(c.structure.cost.sizeUsd)}`} round trip here costs ${c.structure.cost.roundTripPct}% (fees ${c.structure.cost.feesRoundTripPct}% + impact ${c.structure.cost.impactBuyPct}% / ${c.structure.cost.impactSellPct}%)${c.structure.cost.breakEvenMovePct != null ? `, break-even +${c.structure.cost.breakEvenMovePct}%` : ""}`
                : c.structure.cost.dataState === "unavailable" ? " · round-trip cost unknown: pool liquidity not reported" : ""}
              {" · "}{c.structure.category.reasons.join("; ")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
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
                {c.top10Pct == null && c.top10Method?.startsWith("unavailable") && (
                  <span title={c.top10Method} className="rounded px-1.5 py-0.5 font-semibold bg-amber-500/15 text-amber-300">
                    top10 unavailable
                  </span>
                )}
                {c.top10Pct != null && (
                  <span title={c.top10Method ?? undefined} className={`rounded px-1.5 py-0.5 font-semibold ${c.top10Pct > 45 ? "bg-rose-500/20 text-rose-300" : c.top10Pct > 30 ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300"}`}>
                    top10 {c.top10Pct}%{c.top10Method?.includes("INCLUDING") ? " (incl. pool?)" : ""}
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
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>
                social · bsky{" "}
                {c.bskyMentions1h != null
                  ? `${c.bskyCapped ? "≥" : ""}${c.bskyMentions1h} mentions/1h (${c.bskyCapped ? "≥" : ""}${c.bskyMentions10m ?? 0} last 10m${c.bskyMentionsByAddress1h != null ? `, ${c.bskyMentionsByAddress1h} by contract address` : ""})${c.bskyCapped ? " · search capped, lower bound" : ""}`
                  : "unavailable (fetch failed or not searched)"}
              </span>
              {c.pumpReplies != null && (() => {
                // pump.fun values are kept from the last successful read; mark
                // them stale when the latest attempt failed or they are old.
                const stale = c.socialSources?.pump === "failed" || (c.pumpCheckedAt != null && Date.now() - c.pumpCheckedAt > 15 * 60_000);
                const at = c.pumpCheckedAt != null ? new Date(c.pumpCheckedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
                return (
                  <span className={stale ? "text-amber-300/80" : undefined} title={stale ? "last successful pump.fun read; the latest attempt failed or is old" : undefined}>
                    · pump.fun {c.pumpReplies} replies{c.pumpReplyPerHr != null ? ` (${c.pumpReplyPerHr >= 0 ? "+" : ""}${c.pumpReplyPerHr}/hr)` : ""}
                    {stale ? ` · STALE${at ? ` (as of ${at})` : ""}` : ""}
                  </span>
                );
              })()}
              {c.socialCoverage && <span>· score over {c.socialCoverage}</span>}
              <span className="text-amber-300/70">· attention proxy only (social media; pump.fun is an unofficial API), not in the score or verdict</span>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            price check · Jupiter{" "}
            <span className={c.jupState === "diverge" || c.jupState === "no-reliable-price" ? "text-rose-300" : c.jupState === "agree" ? "text-emerald-300" : c.jupState === "watch" ? "text-amber-300" : undefined}>
              {c.jupState === "agree" || c.jupState === "watch" || c.jupState === "diverge"
                ? `${c.jupState} (${c.jupGapPct}% vs DexScreener)`
                : c.jupState === "no-reliable-price" ? "has no reliable price for this mint"
                : c.jupState === "failed" ? "request failed (not cross-checked; ENTER held at WATCH)"
                : "not checked yet (ENTER held at WATCH until checked)"}
            </span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            {c.dexId} · {c.chain} · via {c.discoveredVia} · pair {c.pairAddress.slice(0, 10)}… · data: DexScreener (aggregator API), Solana RPC, rugcheck
          </p>
        </div>
      )}
    </button>
  );
}

function Stat({ label, value, hot }: { label: string; value: string; hot?: boolean }) {
  return (
    <div className="rounded bg-muted/25 px-1.5 py-1">
      <div className="text-[11px] text-muted-foreground">{label}</div>
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

const pctOrDash = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);

function SignalLog({ sig, loading }: { sig?: SignalsResp; loading: boolean }) {
  if (loading) return <FeedSkeleton />;
  if (!sig) return <p className="text-xs text-muted-foreground">no signal data yet.</p>;
  const { stats } = sig;
  return (
    <div className="space-y-3" data-testid="crypto-signal-log">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {[
          ["coins", stats.total, "text-foreground"],
          ["open", stats.open, "text-sky-300"],
          ["hit 5M", stats.hit5m, "text-lime-300"],
          ["doubled", stats.doubled, "text-emerald-300"],
          ["rugged", stats.rugged, "text-rose-300"],
          ["dead", stats.dead, "text-muted-foreground"],
          ["no data", stats.noData ?? 0, "text-amber-300/80"],
        ].map(([label, val, cls]) => (
          <div key={String(label)} className="rounded-lg border border-border/50 bg-card/50 p-2 text-center">
            <div className={`font-mono text-lg font-bold tabular-nums ${cls}`}>{String(val)}</div>
            <div className="text-[11px] text-muted-foreground">{String(label)}</div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="crypto-stats-basis">
        counts are distinct coins (first signal per coin){stats.rows ? `; ${stats.rows.total} logged rows` : ""}
        {stats.enterCoins ? ` · first-ENTER coins: ${stats.enterCoins.total} (${stats.enterCoins.graded} graded, ${stats.enterCoins.hit5m + stats.enterCoins.doubled} hit 5M or doubled)` : ""}
        {stats.noDataShare != null ? ` · no-data share ${Math.round(stats.noDataShare * 100)}% of resolved coins (missing outcomes, not losses)` : ""}
      </p>
      {stats.survivorship && (
        <p className="text-[11px] text-muted-foreground" data-testid="crypto-survivorship">
          rug rate, first-ENTER coins: observed {pctOrDash(stats.survivorship.enterCoins.ruggedRateObserved)}, worst case {pctOrDash(stats.survivorship.enterCoins.ruggedRateWorstCase)} (every no-data pair counted as rugged: delisted pairs are often rugs)
          {" "}· all coins: observed {pctOrDash(stats.survivorship.coins.ruggedRateObserved)}, worst case {pctOrDash(stats.survivorship.coins.ruggedRateWorstCase)}
        </p>
      )}
      {stats.peakSampling && (
        <p className="text-[11px] text-muted-foreground" data-testid="crypto-peak-sampling">{stats.peakSampling}</p>
      )}
      {sig.desk && (
        <p className={`text-[11px] ${sig.desk.state === "on" ? "text-muted-foreground" : "text-amber-300"}`} data-testid="crypto-desk-risk">
          desk risk {sig.desk.state}: {sig.desk.reason}. {sig.desk.state === "on" ? "ENTER is possible when every gate is met." : "Every candidate is held at WATCH; the scanner keeps logging."}
        </p>
      )}
      {sig.expectancy && <ExpectancyCard x={sig.expectancy} />}
      {sig.rules && <RuleBookCard r={sig.rules} />}
      <ReplayCard />
      {!stats.sampleReady && (
        <p className="text-[11px] text-muted-foreground">
          not sample-ready{stats.sampleReason ? ` (${stats.sampleReason})` : ` at ${stats.minGradedForSample ?? 50} graded coins (${stats.graded ?? 0} so far)`} — a minimum sample, not a calibration. Until then these stats are the whole product: the record, net of cost, not a claim.
        </p>
      )}
      <div className="space-y-1.5">
        {sig.signals.length === 0 && (
          <p className="text-xs text-muted-foreground">no signals logged yet — the bar is meant to be high. check back after a session of scanning.</p>
        )}
        {sig.signals.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border/40 bg-card/40 px-2.5 py-2 text-[11px]" data-testid={`crypto-signal-${String(s.id).slice(0, 8)}`}>
            <Badge variant="outline" className={`px-1.5 text-[11px] ${
              s.verdict === "ENTER" ? "border-lime-400/50 text-lime-300" : "border-amber-400/40 text-amber-300"
            }`}>{s.verdict}</Badge>
            <span className="font-mono font-bold">{s.symbol}</span>
            <span className="text-muted-foreground">@{fmtUsd(s.mcap_at_signal)}</span>
            <TrendingUp className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono tabular-nums text-muted-foreground">peak {fmtUsd(s.peak_mcap)}</span>
            {s.netGraded?.netPct != null && (
              <span className={`font-mono tabular-nums ${s.netGraded.netPct > 0 ? "text-emerald-300" : "text-rose-300"}`} title={`net return of a $100 position opened at this ENTER row and sold when the row was graded (${s.outcome === "HIT_5M" ? "at the first sample at or above the target" : s.outcome === "RUGGED" ? "at rug detection" : "at the horizon"}), after both legs' fees and impact`} data-testid="crypto-signal-net">
                {s.netGraded.netPct > 0 ? "+" : ""}{s.netGraded.netPct.toFixed(0)}% net
              </span>
            )}
            <span className={`ml-auto font-semibold ${
              s.outcome === "HIT_5M" ? "text-lime-300" : s.outcome === "DOUBLED" ? "text-emerald-300"
              : s.outcome === "RUGGED" ? "text-rose-300" : s.outcome === "DEAD" ? "text-muted-foreground"
              : s.outcome === "NO_DATA" ? "text-amber-300/80" : "text-sky-300"
            }`}>{s.outcome}</span>
            <span className="hidden text-[11px] text-muted-foreground sm:block">
              {new Date(Number(s.detected_at)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const fmtNet = (v: number | null | undefined): string => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);

/**
 * Net expectancy of the desk's first ENTER signals: what a $100 position
 * returned under the graded rule (buy at the signal, sell when the grader
 * closed the row: target sample, rug detection, or the horizon), net of both
 * legs, with the sampled peak as the ceiling it is measured against. Counts
 * until the sample minimum (no colour until then); never a forecast.
 */
function ExpectancyCard({ x }: { x: NonNullable<SignalsResp["expectancy"]> }) {
  const h = x.graded, p = x.peak, hold = x.hold;
  const share = h.positiveShare;
  const VAL_CLS: Record<string, string> = { "PASSES PREDEFINED TESTS": "text-emerald-300", "MIXED RESULTS": "text-amber-300", "NO DEMONSTRATED EDGE": "text-rose-300", "INSUFFICIENT DATA": "text-muted-foreground" };
  const tone = (v: number | null) => (!h.sampleReady || v == null ? "text-muted-foreground" : v > 0 ? "text-emerald-300" : "text-rose-300");
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3 space-y-2" data-testid="crypto-expectancy">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">net expectancy · ${h.sizeUsd} per first-ENTER coin, sold when graded</span>
        <span className={`text-[11px] ${h.sampleReady ? "text-muted-foreground" : "text-amber-300/90"}`} data-testid="crypto-expectancy-gate">
          {h.sampleReady ? `${h.n} graded signals` : `${h.n} of ${h.minSample} needed: counts only`} · <span className={`font-mono ${VAL_CLS[h.validation] ?? ""}`} data-testid="crypto-expectancy-validation">{h.validation}</span>
        </span>
      </div>
      {h.n === 0 ? (
        <p className="text-xs text-muted-foreground">no graded first-ENTER signal has a computable return yet{h.skipped ? ` (${h.skipped} skipped: ${Object.entries(h.skippedReasons).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            ["median net", fmtNet(h.medianNetPct), tone(h.medianNetPct)],
            ["mean net", fmtNet(h.meanNetPct), tone(h.meanNetPct)],
            ["positive", `${share.yes}/${share.of}${share.lo != null ? ` (${share.lo.toFixed(0)}–${share.hi!.toFixed(0)}%)` : ""}`, h.sampleReady ? "text-foreground" : "text-muted-foreground"],
            ["worst / best", `${fmtNet(h.worstNetPct)} / ${fmtNet(h.bestNetPct)}`, "text-muted-foreground"],
          ] as const).map(([k, v, cls]) => (
            <div key={k} className="rounded border border-border/40 bg-background/40 px-2 py-1.5">
              <div className="text-[11px] text-muted-foreground">{k}</div>
              <div className={`font-mono text-sm font-semibold tabular-nums ${cls}`}>{v}</div>
            </div>
          ))}
        </div>
      )}
      {hold.n > 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="crypto-expectancy-hold">
          hold to the 72 h horizon (the replicable rule): median {fmtNet(hold.medianNetPct)}, mean {fmtNet(hold.meanNetPct)}, {hold.positiveShare.yes}/{hold.positiveShare.of} positive · {hold.validation}{hold.skipped ? ` · ${hold.skipped} without a horizon mark` : ""}
        </p>
      )}
      {p.n > 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="crypto-expectancy-peak">
          ceiling, selling at the sampled peak (not achievable: the peak is known only afterwards): median {fmtNet(p.medianNetPct)}, mean {fmtNet(p.meanNetPct)}, {p.positiveShare.yes}/{p.positiveShare.of} positive. The gap between the two rows is what timing the top would have been worth.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">{h.note}{h.skipped ? ` · ${h.skipped} graded without a computable return (${Object.entries(h.skippedReasons).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}</p>
      <p className="text-[11px] text-muted-foreground/80">{x.basis}</p>
    </div>
  );
}

/** The rule book, in words, with its version: what every verdict and grade on this tab was produced by. */
function RuleBookCard({ r }: { r: NonNullable<SignalsResp["rules"]> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3 space-y-2" data-testid="crypto-rules">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-h-[44px] w-full items-center justify-between gap-2 text-left sm:min-h-0" data-testid="crypto-rules-toggle">
        <span className="text-sm font-semibold text-foreground">Rule book <span className="font-mono text-[11px] text-muted-foreground">v{r.version}</span></span>
        <span className="text-[11px] text-muted-foreground">{open ? "hide" : `${r.items.length} rules`}</span>
      </button>
      <p className="text-[11px] text-muted-foreground">Every verdict and grade on this tab comes from these rules. A changed number is a new version; each signal row stores the version it was produced under (rows before 2026-10-27 are unversioned and the expectancy card says how many). The desk reads and grades; it places no orders.</p>
      {open && (
        <ul className="space-y-1" data-testid="crypto-rules-list">
          {r.items.map((it) => (
            <li key={it.path} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-border/30 pt-1 text-[11px]">
              <span className="text-muted-foreground"><span className="font-mono text-foreground">{it.path}</span> · {it.text}</span>
              <span className="font-mono text-foreground">{it.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const pct = (n: number | null | undefined, dp = 1) => (n == null ? "—" : `${n.toFixed(dp)}%`);
const num = (n: number | null | undefined, dp = 1) => (n == null ? "—" : n.toFixed(dp));

/** The logged record re-read under the current rule book: timing, cap bands, features vs outcome, in/out-of-sample. Descriptive. */
function ReplayCard() {
  const [open, setOpen] = useState(false);
  const q = useQuery<CryptoReplay>({ queryKey: ["/api/crypto/replay"], refetchInterval: 5 * 60_000, enabled: open });
  const r = q.data;
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3 space-y-2" data-testid="crypto-replay">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-h-[44px] w-full items-center justify-between gap-2 text-left sm:min-h-0" data-testid="crypto-replay-toggle">
        <span className="text-sm font-semibold text-foreground">Replay: what the record says</span>
        <span className="text-[11px] text-muted-foreground">{open ? "hide" : "show"}</span>
      </button>
      <p className="text-[11px] text-muted-foreground">Every logged signal re-read under the current rule book: when the peak came relative to the signal, outcomes by cap at entry, which signal-time features sat with winners, and the current rules' pass set split older/newer half, net of cost. Bookkeeping on one desk's record, not a forecast.</p>
      {open && q.isLoading && <div className="text-[11px] text-muted-foreground">reading the record…</div>}
      {open && q.isError && <div className="text-[11px] text-amber-300" data-testid="crypto-replay-error">replay unavailable: {String((q.error as any)?.message ?? "server error")}</div>}
      {open && r && (
        <div className="space-y-3 text-[11px]" data-testid="crypto-replay-body">
          <div className="font-mono text-muted-foreground">rules v{r.rulesVersion} · {r.rows.firstSignals} first signals ({r.rows.graded} graded) of {r.rows.total} rows · versions {Object.entries(r.rows.versions).map(([v, n]) => `${v}: ${n}`).join(", ") || "none"}</div>

          <section data-testid="crypto-replay-timing">
            <div className="text-[11px] font-medium text-muted-foreground">1 · When did the peak come?</div>
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono tabular-nums sm:grid-cols-5">
              <span>at/before signal <span className="text-foreground">{r.timing.peakAtOrBeforeSignal}</span></span>
              <span>≤ 15 min <span className="text-foreground">{r.timing.within15min}</span></span>
              <span>≤ 60 min <span className="text-foreground">{r.timing.within60min}</span></span>
              <span>later <span className="text-foreground">{r.timing.later}</span></span>
              <span>no peak <span className="text-foreground">{r.timing.noPeak}</span></span>
            </div>
            <div className="mt-0.5 text-muted-foreground">median {num(r.timing.medianMinutesToPeak, 0)} min to the sampled peak over {r.timing.n} graded · {r.timing.note}</div>
          </section>

          <section data-testid="crypto-replay-bands">
            <div className="text-[11px] font-medium text-muted-foreground">2 · Outcomes by cap at the signal</div>
            <div className="mt-1 overflow-x-auto">
              <table className="w-full min-w-[520px] font-mono tabular-nums">
                <thead><tr className="text-muted-foreground"><th className="text-left">band</th><th className="text-right">n</th><th className="text-right">hit</th><th className="text-right">2x</th><th className="text-right">dead</th><th className="text-right">rug</th><th className="text-right">no data</th><th className="text-right">win %</th><th className="text-right">95% CI</th><th className="text-right">median net</th></tr></thead>
                <tbody>
                  {r.bands.map((b) => (
                    <tr key={b.band} className="border-t border-border/30">
                      <td>{b.band}</td><td className="text-right">{b.n}</td><td className="text-right">{b.hit}</td><td className="text-right">{b.doubled}</td><td className="text-right">{b.dead}</td><td className="text-right">{b.rugged}</td><td className="text-right">{b.noData}</td>
                      <td className="text-right text-foreground">{pct(b.winShare)}</td><td className="text-right">{b.winLo == null ? "—" : `${b.winLo}–${b.winHi}`}</td><td className="text-right">{pct(b.medianNetGradedPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-0.5 text-muted-foreground sm:hidden">swipe for more columns</div>
          </section>

          <section data-testid="crypto-replay-features">
            <div className="text-[11px] font-medium text-muted-foreground">3 · Signal-time features: winners vs losers (medians) and win % in the top vs bottom third</div>
            <div className="mt-1 overflow-x-auto">
              <table className="w-full min-w-[520px] font-mono tabular-nums">
                <thead><tr className="text-muted-foreground"><th className="text-left">feature</th><th className="text-right">n win / loss</th><th className="text-right">median win</th><th className="text-right">median loss</th><th className="text-right">top ⅓ win %</th><th className="text-right">bottom ⅓ win %</th></tr></thead>
                <tbody>
                  {r.features.map((f) => (
                    <tr key={f.feature} className="border-t border-border/30">
                      <td>{f.feature}</td><td className="text-right">{f.nWin} / {f.nLoss}</td><td className="text-right">{num(f.medianWin, 2)}</td><td className="text-right">{num(f.medianLoss, 2)}</td>
                      <td className="text-right text-foreground">{f.topThirdWinShare == null ? "—" : `${f.topThirdWinShare}% (n ${f.thirdN})`}</td><td className="text-right">{f.bottomThirdWinShare == null ? "—" : `${f.bottomThirdWinShare}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-0.5 text-muted-foreground">descriptive only; thirds need at least 3 rows each. A feature that separates here is a candidate for the next rule version, to be tested out of sample, not a rule.</div>
          </section>

          <section data-testid="crypto-replay-reeval">
            <div className="text-[11px] font-medium text-muted-foreground">4 · Current rules over the record (first signal per coin)</div>
            <div className="mt-1 font-mono tabular-nums text-muted-foreground">pass the current rules <span className="text-foreground">{r.reeval.wouldEnter}</span> of {r.reeval.consideredFirstSignals} · originally ENTER {r.reeval.originallyEnter} · agree {r.reeval.agreeEnter} · blockers: {Object.entries(r.reeval.blockerCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}</div>
            <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-3">
              {[r.reeval.inSample, r.reeval.outOfSample, r.reeval.all].map((s) => (
                <div key={s.label} className="rounded border border-border/40 p-2 font-mono tabular-nums">
                  <div className="text-foreground">{s.label}</div>
                  <div>n {s.n} · wins {s.wins} ({pct(s.winShare)}{s.winLo != null ? `, CI ${s.winLo}–${s.winHi}` : ""})</div>
                  <div>mean net {pct(s.meanNetGradedPct)} · median {pct(s.medianNetGradedPct)}</div>
                  <div>max drawdown {pct(s.maxDrawdownPct)} of $100-per-signal equity</div>
                </div>
              ))}
            </div>
            <div className="mt-0.5 text-muted-foreground">{r.reeval.gateEvidence ? `Decision-time gate evidence recorded on ${r.reeval.gateEvidence.recorded} of ${r.reeval.gateEvidence.of} first signals. ` : ""}{r.reeval.unchecked.length ? `Still unchecked on older rows: ${r.reeval.unchecked.join("; ")}. ` : r.reeval.gateEvidence.of > 0 ? "The four recorded gates (sustained flow, Jupiter, 1 h sells, desk risk) were re-checked on every first signal; other rule differences are not covered. " : "No first signals yet. "}{r.reeval.lookAhead}</div>
          </section>

          <p className="text-muted-foreground">{r.samplingLimit}</p>
          <p className="text-muted-foreground/80">{r.scope}</p>
        </div>
      )}
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
