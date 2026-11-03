// shared/exitPlan.ts
//
// The desk's exit plan for an ENTER, from the rule book (CRYPTO_RULES.exitPlan
// and sizing), and the bookkeeping that grades it on each coin's sampled path.
// Pure: the server walks OPEN ENTER rows through advancePlan at every price
// sample, the card shows planLevels and sizeFromBankroll, and the record is
// planSummary over closed plans. Nothing here places an order.
//
// Fill rules (stated, conservative):
//   trims and the target   limit sells: filled AT the level when a sample is
//                          at or above it (a spike between samples that never
//                          shows in a sample is not counted);
//   stop / liquidity stop  filled at the SAMPLE that breached it (a gap through
//                          the level is taken at the worse sampled value);
//   time stop              the first sample at or after the hold horizon.
// Several trims crossed in one sample all fill at their own levels. Market-cap
// multiples stand in for price multiples (supply growth overstates the move).

import { CRYPTO_RULES, CRYPTO_RULES_VERSION } from "./cryptoRules";

type Rules = typeof CRYPTO_RULES;

export interface PlanLevel {
  kind: "trim" | "target" | "stop" | "liquidityStop" | "timeStop";
  /** Market-cap multiple of the entry (null for the liquidity and time stops). */
  multiple: number | null;
  /** Market cap at the level (null when multiple is null or entry unknown). */
  mcap: number | null;
  /** Share of the ORIGINAL position sold at this level (stops: whatever is left). */
  sellShare: number | null;
  text: string;
}

const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const usdShort = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K` : `$${n.toFixed(0)}`;

/** The plan's levels for an entry at `entryMcap` (ordered by multiple). */
export function planLevels(entryMcap: number | null, rules: Rules = CRYPTO_RULES): PlanLevel[] {
  const e = fin(entryMcap);
  const target = rules.universe.targetMcapUsd;
  const targetMult = e && e > 0 ? target / e : null;
  const out: PlanLevel[] = [];
  let sold = 0;
  for (const t of rules.exitPlan.trims) {
    if (targetMult != null && t.atMultiple >= targetMult) continue; // folds into the target sell
    sold += t.sellShare;
    const m = e ? e * t.atMultiple : null;
    out.push({ kind: "trim", multiple: t.atMultiple, mcap: m, sellShare: t.sellShare,
      text: `sell ${Math.round(t.sellShare * 100)}% at ${t.atMultiple}x${m ? ` (${usdShort(m)} cap)` : ""}` });
  }
  if (rules.exitPlan.runnerAtTarget) {
    const rest = Math.max(0, 1 - sold);
    out.push({ kind: "target", multiple: targetMult, mcap: target, sellShare: rest,
      text: `sell the rest (${Math.round(rest * 100)}%) at ${usdShort(target)} cap${targetMult ? ` (${targetMult.toFixed(1)}x)` : ""}` });
  }
  const stopMult = 1 + rules.sizing.suggestedStopPct / 100;
  out.push({ kind: "stop", multiple: stopMult, mcap: e ? e * stopMult : null, sellShare: null,
    text: `stop: sell all at ${rules.sizing.suggestedStopPct}%${e ? ` (${usdShort(e * stopMult)} cap)` : ""}${rules.exitPlan.breakevenAfterFirstTrim ? "; after the first trim the stop moves to the entry" : ""}` });
  out.push({ kind: "liquidityStop", multiple: null, mcap: null, sellShare: null,
    text: `liquidity stop: sell all if pool liquidity falls ${Math.abs(rules.sizing.liquidityExitStopPct)}% under the entry's` });
  out.push({ kind: "timeStop", multiple: null, mcap: null, sellShare: null,
    text: `time stop: sell what is left after ${rules.sizing.holdHorizonHours} h` });
  return out;
}

export interface SizeResult {
  sizeUsd: number | null;
  /** What binds: the bankroll risk rule or the pool-based maximum. */
  bound: "risk" | "pool" | null;
  /** Loss at the stop level before costs, USD. */
  riskUsd: number | null;
  text: string;
}

/** Position size from the owner's bankroll: bankroll x risk% / |stop|, capped by the pool-based maximum. */
export function sizeFromBankroll(bankrollUsd: number | null | undefined, poolMaxUsd: number | null | undefined, rules: Rules = CRYPTO_RULES): SizeResult {
  const b = fin(bankrollUsd), cap = fin(poolMaxUsd);
  if (!(b != null && b > 0)) return { sizeUsd: null, bound: null, riskUsd: null, text: "set a bankroll once to size this" };
  const stop = Math.abs(rules.sizing.suggestedStopPct) / 100;
  const byRisk = (b * rules.exitPlan.riskPerTradePct / 100) / stop;
  if (cap == null || !(cap > 0)) return { sizeUsd: null, bound: null, riskUsd: null, text: "pool size unread: no size" };
  const size = Math.floor(Math.min(byRisk, cap));
  const bound = byRisk <= cap ? "risk" : "pool";
  return { sizeUsd: size, bound, riskUsd: Math.round(size * stop * 100) / 100,
    text: `$${size.toLocaleString("en-US")} (${bound === "risk" ? `${rules.exitPlan.riskPerTradePct}% of bankroll at risk to the stop` : "capped by the pool: the exit is the constraint"})` };
}

// ─── path grading ─────────────────────────────────────────────────────────

export interface PlanFill {
  kind: PlanLevel["kind"];
  at: number;
  multiple: number;     // fill market cap / entry market cap
  liquidity: number | null;
  share: number;        // of the original position
}

export interface PlanState {
  v: 1;
  rulesVersion: string;
  entryMcap: number;
  entryLiq: number;
  entryAt: number;
  remaining: number;    // share of the original position still held
  trimsDone: number;
  stopMultiple: number;
  fills: PlanFill[];
  closedAt: number | null;
  lastSampleAt: number | null;
  samples: number;
}

export function newPlanState(entryMcap: number, entryLiq: number, entryAt: number, rulesVersion: string, rules: Rules = CRYPTO_RULES): PlanState | null {
  if (!(entryMcap > 0) || !(entryLiq > 0) || !Number.isFinite(entryAt)) return null;
  return { v: 1, rulesVersion, entryMcap, entryLiq, entryAt, remaining: 1, trimsDone: 0,
    stopMultiple: 1 + rules.sizing.suggestedStopPct / 100, fills: [], closedAt: null, lastSampleAt: null, samples: 0 };
}

/** Walk one price sample through the plan. Returns a new state (input untouched). */
export function advancePlan(prev: PlanState, sample: { at: number; mcap: number | null; liquidity: number | null }, rules: Rules = CRYPTO_RULES): PlanState {
  if (prev.closedAt != null) return prev;
  if (prev.lastSampleAt != null && sample.at <= prev.lastSampleAt) return prev; // out of order or duplicate
  const s: PlanState = { ...prev, fills: [...prev.fills], samples: prev.samples + 1, lastSampleAt: sample.at };
  const mcap = fin(sample.mcap), liq = fin(sample.liquidity);
  const close = (kind: PlanFill["kind"], multiple: number) => {
    if (s.remaining > 1e-9) s.fills.push({ kind, at: sample.at, multiple, liquidity: liq, share: s.remaining });
    s.remaining = 0; s.closedAt = sample.at;
  };
  // A sample without both cap and liquidity is not priced (missing is not zero),
  // except an observed liquidity pull, which closes the plan.
  const pulled = liq != null && liq <= s.entryLiq * (1 + rules.sizing.liquidityExitStopPct / 100);
  if (pulled) {
    // Order inside one sample is unknown: never credit more than the next
    // unfilled limit level (conservative), and nothing when the cap is unread.
    const next = planLevels(s.entryMcap, rules).filter((l) => l.kind === "trim" || l.kind === "target")[s.trimsDone]?.multiple ?? null;
    const raw = mcap != null ? mcap / s.entryMcap : 0;
    close("liquidityStop", next != null ? Math.min(raw, next) : raw);
    return s;
  }
  if (mcap == null || liq == null) return s;
  const m = mcap / s.entryMcap;
  // Limit sells at or under this sample, in order.
  const levels = planLevels(s.entryMcap, rules).filter((l) => l.kind === "trim" || l.kind === "target");
  for (let i = s.trimsDone; i < levels.length && s.remaining > 1e-9; i++) {
    const l = levels[i];
    if (l.multiple == null || m < l.multiple) break;
    const share = Math.min(s.remaining, l.sellShare ?? s.remaining);
    s.fills.push({ kind: l.kind, at: sample.at, multiple: l.multiple, liquidity: liq, share });
    s.remaining = Math.max(0, s.remaining - share);
    s.trimsDone = i + 1;
    if (l.kind === "trim" && rules.exitPlan.breakevenAfterFirstTrim) s.stopMultiple = Math.max(s.stopMultiple, 1);
  }
  if (s.remaining <= 1e-9) { s.remaining = 0; s.closedAt = sample.at; return s; }
  if (m <= s.stopMultiple) { close("stop", m); return s; }
  if (sample.at - s.entryAt >= rules.sizing.holdHorizonHours * 3600_000) { close("timeStop", m); return s; }
  return s;
}

/** Net return of a closed plan on `sizeUsd`, percent, with constant-product legs and the book's fees. */
export function planReturnPct(s: PlanState, sizeUsd: number = CRYPTO_RULES.grading.sizeUsd, rules: Rules = CRYPTO_RULES): number | null {
  if (s.closedAt == null || !(sizeUsd > 0)) return null;
  const feeFrac = Math.min(1, (rules.cost.dexFeePct + rules.cost.platformFeePct) / 100);
  const prio = rules.cost.priorityFeeUsd;
  const x = sizeUsd * (1 - feeFrac) - prio;
  if (!(x > 0)) return -100;
  const Q1 = s.entryLiq / 2;
  const v0 = (Q1 * x) / (Q1 + x);
  let proceeds = 0;
  for (const f of s.fills) {
    const exitLiq = f.liquidity ?? s.entryLiq;
    if (!(exitLiq > 0)) continue;           // pulled pool: that slice returns nothing
    const Q2 = exitLiq / 2;
    const v = v0 * f.share * f.multiple;
    proceeds += Math.max(0, ((Q2 * v) / (Q2 + v)) * (1 - feeFrac) - prio);
  }
  return Math.max(-100, (100 * (proceeds - sizeUsd)) / sizeUsd);
}

export interface PlanSummary {
  closed: number;
  open: number;
  /** Plans whose samples stopped a day past the time stop. */
  noData: number;
  noDataShare: number | null;
  minSample: number;
  ready: boolean;
  medianPct: number | null;
  meanPct: number | null;
  winShare: number | null;
  byExit: Record<string, number>;
  label: string;
}

export function planSummary(states: PlanState[], now: number = Date.now(), rules: Rules = CRYPTO_RULES): PlanSummary {
  const closed = states.filter((s) => s.closedAt != null);
  // Open a day past the time stop: the samples stopped (pair gone, likely a rug). No data, never a win.
  const staleAfter = (rules.sizing.holdHorizonHours + 24) * 3600_000;
  const noData = states.filter((s) => s.closedAt == null && now - s.entryAt > staleAfter).length;
  const rets = closed.map((s) => planReturnPct(s, rules.grading.sizeUsd, rules)).filter((r): r is number => r != null).sort((a, b) => a - b);
  const byExit: Record<string, number> = {};
  for (const s of closed) { const k = s.fills[s.fills.length - 1]?.kind ?? "none"; byExit[k] = (byExit[k] ?? 0) + 1; }
  const n = rets.length, min = rules.grading.minSample;
  const median = n ? (n % 2 ? rets[(n - 1) / 2] : (rets[n / 2 - 1] + rets[n / 2]) / 2) : null;
  const mean = n ? rets.reduce((a, b) => a + b, 0) / n : null;
  const noDataShare = n + noData > 0 ? noData / (n + noData) : null;
  const ready = n >= min && (noDataShare ?? 0) <= rules.grading.maxNoDataShare;
  return { closed: n, open: states.length - closed.length - noData, noData, noDataShare, minSample: min, ready,
    medianPct: median, meanPct: mean, winShare: n ? rets.filter((r) => r > 0).length / n : null, byExit,
    label: ready ? `${n} closed plans` : n >= min ? `INSUFFICIENT DATA: no-data share ${Math.round((noDataShare ?? 0) * 100)}% over ${Math.round(rules.grading.maxNoDataShare * 100)}%` : `INSUFFICIENT DATA: ${n} of ${min} closed plans; counts, not a claim` };
}

// ─── the prompt the owner pastes into their own AI ───────────────────────

export interface PromptCoin {
  symbol: string; name: string; chain: string; tokenAddress: string; pairAddress: string; dexId: string;
  priceUsd: number | null; marketCap: number | null; liquidityUsd: number | null;
  vol5m: number | null; vol1h: number | null; vol24h: number | null;
  buys5m: number | null; sells5m: number | null; chg5m: number | null; chg1h: number | null; chg24h: number | null;
  ageMinutes: number | null; mintAuthorityActive: boolean | null; freezeAuthorityActive: boolean | null;
  top10Pct: number | null; rcLpLockedPct: number | null; rcRisks: string[]; rugFlags: string[];
  boosted: boolean; pumpfunGraduate: boolean; pumpLive: boolean; narrativeHits: string[];
  verdict: string | null; score: number | null; verdictReasons: string[];
  jupState?: string; jupGapPct?: number | null;
  bundleLine?: string | null;
  socialLine?: string | null;
}

const v = (x: number | null | undefined, f: (n: number) => string) => (x == null || !Number.isFinite(x) ? "unread" : f(x));
const usd = (n: number) => `$${n >= 1 ? Math.round(n).toLocaleString("en-US") : n.toPrecision(3)}`;

/** A self-contained prompt with the card's data and the rule-book plan. */
export function buildTradePrompt(c: PromptCoin, sizeText: string, rules: Rules = CRYPTO_RULES, now = Date.now()): string {
  const levels = planLevels(c.marketCap, rules).map((l) => `- ${l.text}`).join("\n");
  const yn = (b: boolean | null) => (b == null ? "unread" : b ? "ACTIVE" : "revoked");
  return [
    `Act as an experienced Solana meme-coin trader. Review this coin with me using ONLY the data below plus anything you can verify live. Tell me plainly: take it, wait, or skip, and why. If you would trade it, walk me through the entry, where you would trim, where you would get out, and what would make you leave early.`,
    ``,
    `COIN: ${c.symbol} (${c.name}) on ${c.chain}, ${c.dexId}${c.pumpfunGraduate ? ", graduated pump.fun" : ""}`,
    `Mint: ${c.tokenAddress}`,
    `Pair: ${c.pairAddress}`,
    `Data as of: ${new Date(now).toISOString()}`,
    ``,
    `MARKET: price ${v(c.priceUsd, usd)}, market cap ${v(c.marketCap, usd)}, liquidity ${v(c.liquidityUsd, usd)}, age ${v(c.ageMinutes, (m) => (m >= 60 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`))}`,
    `Volume: 5m ${v(c.vol5m, usd)}, 1h ${v(c.vol1h, usd)}, 24h ${v(c.vol24h, usd)}. Last 5m: ${c.buys5m ?? "unread"} buys / ${c.sells5m ?? "unread"} sells`,
    `Change: 5m ${v(c.chg5m, (n) => `${n.toFixed(1)}%`)}, 1h ${v(c.chg1h, (n) => `${n.toFixed(1)}%`)}, 24h ${v(c.chg24h, (n) => `${n.toFixed(1)}%`)}`,
    `Jupiter price check: ${c.jupState ?? "unchecked"}${c.jupGapPct != null ? ` (${c.jupGapPct}% gap)` : ""}`,
    ``,
    `SAFETY: mint authority ${yn(c.mintAuthorityActive)}, freeze authority ${yn(c.freezeAuthorityActive)}, top-10 holders ${v(c.top10Pct, (n) => `${n.toFixed(1)}%`)}, LP locked ${v(c.rcLpLockedPct, (n) => `${n}%`)}`,
    `Launch buying: ${c.bundleLine ? c.bundleLine.replace(/^Launch buying:?\s*/i, "") : "unread"}`,
    `Rugcheck risks: ${c.rcRisks.length ? c.rcRisks.join("; ") : "none listed"}. Desk flags: ${c.rugFlags.length ? c.rugFlags.join("; ") : "none"}`,
    `Attention: ${c.boosted ? "paid DexScreener boost; " : ""}${c.pumpLive ? "pump.fun livestream on; " : ""}${c.narrativeHits.length ? `in headlines: ${c.narrativeHits.join(", ")}; ` : ""}${c.socialLine ?? "social unread"}`,
    ``,
    `DESK READ (fixed rules, version ${CRYPTO_RULES_VERSION}): ${c.verdict ?? "unscored"}${c.score != null ? `, score ${Math.round(c.score)}/100` : ""}. ${c.verdictReasons.slice(0, 4).join(" · ")}`,
    ``,
    `RULE-BOOK EXIT PLAN (from entry at the current cap):`,
    levels,
    `Size: ${sizeText}`,
    ``,
    `CHECK LIVE BEFORE ANSWERING:`,
    `1. Search X for the mint address and $${c.symbol}: is there a real community, or only bots and paid callers? Who posted first, and are KOL calls landing now?`,
    `2. Has the dev wallet or any launch-block wallet sold, moved tokens, or funded new wallets since launch? Any cluster of fresh wallets buying together?`,
    `3. Is liquidity being added or pulled? Is the top-10 share rising?`,
    `4. Any news or narrative this rides (a headline, a trend, a celebrity, a listing)? Is that narrative fresh or already fading?`,
    `5. Copycat tokens with the same name or ticker that could split the volume?`,
    ``,
    `Then give me: verdict (take / wait / skip), the one thing that would change your mind, your trim and stop levels compared with the plan above, and what to watch in the next 15 minutes and the next 4 hours.`,
  ].join("\n");
}
