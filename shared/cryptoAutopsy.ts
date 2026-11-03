// shared/cryptoAutopsy.ts
//
// Contract autopsy: paste a Solana token address, get every desk rule applied
// to one fresh snapshot, rule by rule, with the value read and its state; plus a
// holder-dump stress test. Pure functions, no I/O. Thresholds come only from the
// versioned rule book (shared/cryptoRules.ts); this module owns none.
//
// What an autopsy is not: it is not a signal, is never logged, and is not graded.
// One snapshot cannot show sustained flow (the desk needs the accel floor on 2 of
// its last 3 refreshes), so an autopsy can never reach ENTER and says so.
//
// Gate states:
//   pass    the rule is met on the value read
//   fail    the rule is breached (for a "kill" gate this is a desk hard kill)
//   unread  the value could not be read or one snapshot cannot decide it; never a pass

import { CRYPTO_RULES, type CryptoRules } from "./cryptoRules";

// ─── Address parsing ─────────────────────────────────────────────────────

const BASE58 = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

export type MintParse = { ok: true; mint: string } | { ok: false; reason: string };

/**
 * Pulls exactly one base58 string of 32-44 characters out of the pasted text.
 * More than one distinct candidate is rejected rather than guessed. A pair
 * address and a wallet address look identical to a mint, so the lookup reports
 * "not found" with that hint instead of pretending to know.
 */
export function parseMintInput(raw: unknown): MintParse {
  if (typeof raw !== "string") return { ok: false, reason: "no address given" };
  const text = raw.trim();
  if (!text) return { ok: false, reason: "no address given" };
  if (text.length > 300) return { ok: false, reason: "input too long" };
  const found = Array.from(new Set(text.match(BASE58) ?? []));
  if (found.length === 0) {
    if (/https?:\/\//i.test(text)) return { ok: false, reason: "that looks like a link; paste the token's contract address itself" };
    return { ok: false, reason: "no Solana address found (a whole 32-44 character base58 address; longer or shorter strings are rejected, not trimmed)" };
  }
  if (found.length > 1) return { ok: false, reason: "more than one address found; paste only the token's contract address" };
  return { ok: true, mint: found[0] };
}

// ─── Gate table ──────────────────────────────────────────────────────────

export interface AutopsyFacts {
  liquidityUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  priceUsd: number | null;
  buys1h: number | null;
  sells1h: number | null;
  chg1h: number | null;
  vol24h: number | null;
  ageMinutes: number | null;
  mintAuthorityActive: boolean | null;
  freezeAuthorityActive: boolean | null;
  top10Pct: number | null;
  top10Method: string | null;
  rcLpLockedPct: number | null;
  jupState: string;
  jupGapPct: number | null;
  volAccel: number | null;
  netBuyRatio5m: number | null;
  score: number | null;
}

export type GateState = "pass" | "fail" | "unread";
export type GateSeverity = "kill" | "flag" | "entry";

export interface Gate {
  id: string;
  severity: GateSeverity;
  label: string;
  /** the rule in words, from the rule book */
  rule: string;
  /** what was read, in words */
  value: string;
  state: GateState;
  detail: string | null;
}

const usd = (n: number): string => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`);
const pct = (n: number, dp = 1): string => `${n.toFixed(dp)}%`;

export function autopsyGates(f: AutopsyFacts, rules: CryptoRules = CRYPTO_RULES): Gate[] {
  const g: Gate[] = [];
  const add = (x: Gate) => g.push(x);
  const mcap = f.marketCap ?? f.fdv ?? 0;
  const liq = f.liquidityUsd;

  // ── hard kills ──
  const floor = rules.universe.liquidityFloorUsd;
  add({
    id: "liquidity", severity: "kill", label: "Exit liquidity", rule: `at least ${usd(floor)} in the pool`,
    ...(liq == null ? { value: "not reported", state: "fail" as const, detail: "the desk treats missing liquidity as a kill: an exit cannot be verified" }
      : liq === 0 ? { value: "$0 observed", state: "fail" as const, detail: "pool drained or liquidity pulled" }
      : liq < floor ? { value: usd(liq), state: "fail" as const, detail: null }
      : { value: usd(liq), state: "pass" as const, detail: null }),
  });
  const door = rules.hardKills.exitDoorMinLiqToMcap;
  add({
    id: "exit_door", severity: "kill", label: "Exit door", rule: `liquidity at least ${pct(door * 100, 0)} of market cap`,
    ...(mcap > 0 && liq != null && liq > 0
      ? (liq / mcap < door ? { value: pct((100 * liq) / mcap), state: "fail" as const, detail: "a position this size cannot leave without moving the price" }
        : { value: pct((100 * liq) / mcap), state: "pass" as const, detail: null })
      : { value: mcap > 0 ? "liquidity unreadable" : "market cap unreadable", state: "unread" as const, detail: null }),
  });
  const hpMin = rules.hardKills.honeypotMinBuys1h;
  add({
    id: "honeypot", severity: "kill", label: "Sells observed", rule: `not ${hpMin}+ buys with zero sells in the last hour`,
    ...(f.sells1h == null ? { value: "sell count not reported", state: "unread" as const, detail: "the honeypot check cannot run; the desk holds ENTER at WATCH" }
      : (f.buys1h ?? 0) >= hpMin && f.sells1h === 0 ? { value: `${f.buys1h} buys, 0 sells`, state: "fail" as const, detail: "the honeypot pattern" }
      : { value: `${f.buys1h == null ? "buys not reported" : `${f.buys1h} buys`}, ${f.sells1h} sells`, state: "pass" as const, detail: null }),
  });
  const rug = rules.hardKills.midRugChg1hPct;
  add({
    id: "mid_rug", severity: "kill", label: "Last-hour move", rule: `price change above ${rug}% over 1 h`,
    ...(f.chg1h == null ? { value: "not reported", state: "unread" as const, detail: null }
      : f.chg1h <= rug ? { value: `${f.chg1h.toFixed(0)}%`, state: "fail" as const, detail: "mid-rug or post-dump" }
      : { value: `${f.chg1h >= 0 ? "+" : ""}${f.chg1h.toFixed(0)}%`, state: "pass" as const, detail: null }),
  });
  add({
    id: "mint_authority", severity: "kill", label: "Mint authority", rule: "revoked",
    ...(f.mintAuthorityActive == null ? { value: "not read", state: "unread" as const, detail: null }
      : f.mintAuthorityActive ? { value: "ACTIVE", state: "fail" as const, detail: "the creator can print supply into the bid" }
      : { value: "revoked", state: "pass" as const, detail: null }),
  });
  add({
    id: "freeze_authority", severity: "kill", label: "Freeze authority", rule: "revoked",
    ...(f.freezeAuthorityActive == null ? { value: "not read", state: "unread" as const, detail: null }
      : f.freezeAuthorityActive ? { value: "ACTIVE", state: "fail" as const, detail: "the creator can lock holders' tokens" }
      : { value: "revoked", state: "pass" as const, detail: null }),
  });

  // ── flags (move the structure score; none is a kill on its own) ──
  const sniper = rules.flags.sniperZoneMinutes;
  add({
    id: "sniper_zone", severity: "flag", label: "Pool age", rule: `older than ${sniper} min`,
    ...(f.ageMinutes == null ? { value: "pool creation time not reported", state: "unread" as const, detail: null }
      : f.ageMinutes < sniper ? { value: `${f.ageMinutes.toFixed(0)} min`, state: "fail" as const, detail: "sniper zone: spreads are widest" }
      : { value: f.ageMinutes < 120 ? `${f.ageMinutes.toFixed(0)} min` : `${(f.ageMinutes / 60).toFixed(1)} h`, state: "pass" as const, detail: null }),
  });
  add({
    id: "dead_pool", severity: "flag", label: "24 h volume",
    rule: `at least ${usd(rules.flags.deadPoolMinVolume24hUsd)} once older than ${Math.round(rules.flags.deadPoolMinAgeMinutes / 60)} h`,
    ...(f.vol24h == null ? { value: "not reported", state: "unread" as const, detail: null }
      : f.vol24h < rules.flags.deadPoolMinVolume24hUsd && (f.ageMinutes ?? 0) > rules.flags.deadPoolMinAgeMinutes ? { value: usd(f.vol24h), state: "fail" as const, detail: "aged pool with no volume" }
      : { value: usd(f.vol24h), state: "pass" as const, detail: null }),
  });
  const t10 = rules.flags.top10MaxPct;
  add({
    id: "top10", severity: "flag", label: "Top-10 holders", rule: `at most ${t10}% of supply`,
    ...(f.top10Pct == null ? { value: "not read", state: "unread" as const, detail: f.top10Method ?? "the holder read did not complete" }
      : f.top10Pct > t10 ? { value: pct(f.top10Pct), state: "fail" as const, detail: f.top10Method ?? null }
      : { value: pct(f.top10Pct), state: "pass" as const, detail: f.top10Method ?? null }),
  });
  const lp = rules.flags.lpLockMinPct;
  add({
    id: "lp_lock", severity: "flag", label: "LP locked (rugcheck)", rule: `at least ${lp}% locked`,
    ...(f.rcLpLockedPct == null ? { value: "not reported", state: "unread" as const, detail: "a cached third-party report; absence is not a verdict" }
      : f.rcLpLockedPct < lp ? { value: pct(f.rcLpLockedPct), state: "fail" as const, detail: "pull risk" }
      : { value: pct(f.rcLpLockedPct), state: "pass" as const, detail: null }),
  });
  const lm = rules.flags.liqOverMcapMultiple;
  add({
    id: "liq_over_mcap", severity: "flag", label: "Liquidity vs market cap", rule: `liquidity at most ${lm}x market cap`,
    ...(mcap > 0 && liq != null
      ? (liq > mcap * lm ? { value: `${(liq / mcap).toFixed(1)}x`, state: "fail" as const, detail: "an unusual pool; the market-cap figure may be mispriced" }
        : { value: `${(liq / mcap).toFixed(2)}x`, state: "pass" as const, detail: null })
      : { value: "unreadable", state: "unread" as const, detail: null }),
  });
  add({
    id: "jupiter", severity: "flag", label: "Price confirmed by Jupiter", rule: "gap under the divergence limit",
    ...(f.jupState === "agree" || f.jupState === "watch"
      ? { value: `${f.jupState}${f.jupGapPct != null ? ` (${f.jupGapPct}% gap)` : ""}`, state: "pass" as const, detail: null }
      : f.jupState === "diverge" ? { value: `${f.jupGapPct ?? "?"}% off`, state: "fail" as const, detail: "the pool price is not confirmed" }
      : { value: f.jupState, state: "unread" as const, detail: "no confirmation: the desk does not enter on an unconfirmed price" }),
  });

  // ── entry context ──
  const ceil = rules.universe.enterMcapMaxUsd;
  add({
    id: "mcap_ceiling", severity: "entry", label: "Market cap", rule: `at most ${usd(ceil)} for an ENTER`,
    ...(mcap <= 0 ? { value: "unreadable", state: "unread" as const, detail: null }
      : mcap > ceil ? { value: usd(mcap), state: "fail" as const, detail: "above the entry ceiling: the desk only watches for a retrace" }
      : { value: usd(mcap), state: "pass" as const, detail: null }),
  });
  add({
    id: "flow_accel", severity: "entry", label: "Volume acceleration", rule: `at least ${rules.enter.minVolAccel}x (5 min pace vs 1 h pace)`,
    ...(f.volAccel == null ? { value: "not reported", state: "unread" as const, detail: null }
      : f.volAccel < rules.enter.minVolAccel ? { value: `${f.volAccel.toFixed(1)}x`, state: "fail" as const, detail: null }
      : { value: `${f.volAccel.toFixed(1)}x`, state: "pass" as const, detail: null }),
  });
  add({
    id: "flow_buys", severity: "entry", label: "Buy share, last 5 min", rule: `at least ${pct(rules.enter.minNetBuyRatio5m * 100, 0)} of trades`,
    ...(f.netBuyRatio5m == null ? { value: "no trades in the window", state: "unread" as const, detail: null }
      : f.netBuyRatio5m < rules.enter.minNetBuyRatio5m ? { value: pct(f.netBuyRatio5m * 100, 0), state: "fail" as const, detail: null }
      : { value: pct(f.netBuyRatio5m * 100, 0), state: "pass" as const, detail: null }),
  });
  const { need, window: win } = rules.enter.sustainedPolls;
  add({
    id: "flow_sustained", severity: "entry", label: "Sustained flow", rule: `accel floor on ${need} of the last ${win} refreshes`,
    value: "one snapshot", state: "unread", detail: "an autopsy is a single read, so this can only be judged by tracking the coin over several refreshes",
  });
  add({
    id: "score", severity: "entry", label: "Desk score", rule: `at least ${rules.enter.minScore} for an ENTER`,
    ...(f.score == null ? { value: "not computed", state: "unread" as const, detail: null }
      : f.score < rules.enter.minScore ? { value: `${f.score}`, state: "fail" as const, detail: "a heuristic score, not a probability" }
      : { value: `${f.score}`, state: "pass" as const, detail: "a heuristic score, not a probability" }),
  });
  return g;
}

export interface GateSummary { pass: number; fail: number; unread: number; killFails: number; flagFails: number; killed: boolean }

export function summarizeGates(gates: Gate[]): GateSummary {
  const s: GateSummary = { pass: 0, fail: 0, unread: 0, killFails: 0, flagFails: 0, killed: false };
  for (const x of gates) {
    s[x.state]++;
    if (x.state === "fail" && x.severity === "kill") s.killFails++;
    if (x.state === "fail" && x.severity === "flag") s.flagFails++;
  }
  s.killed = s.killFails > 0;
  return s;
}

// ─── Holder-dump stress test ─────────────────────────────────────────────

export interface StressScenario {
  /** share of the top-10 holders' combined position assumed sold, as a fraction */
  soldFraction: number;
  soldValueUsd: number;
  /** sold value as a multiple of the pool's quote-side reserve */
  soldVsQuoteReserve: number;
  /** how far the pool's quote falls, in percent */
  priceImpactPct: number;
  /** what the sellers receive, before fees */
  proceedsUsd: number;
  /** proceeds as a share of the sold value at the starting quote */
  proceedsPctOfValue: number;
}

export interface HolderStress {
  dataState: "ok" | "unavailable";
  reason: string | null;
  basis: "fdv" | "marketCap" | null;
  top10Pct: number | null;
  top10ValueUsd: number | null;
  quoteReserveUsd: number | null;
  scenarios: StressScenario[];
  caveats: string[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
export const STRESS_FRACTIONS = [0.25, 0.5, 1] as const;

/**
 * If the top-10 holders sold part of their position into the pool.
 *
 * Same convention as shared/memeStructure.ts tradeCost: a constant-product pool
 * with quote reserve Q = liquidity / 2. Tokens worth v at the current quote,
 * sold into the pool, return Q·v/(Q+v) and leave the quote at
 * p0 / (1 + v/Q)^2, so the price falls by 1 − 1/(1 + v/Q)^2. Position value is
 * share of supply × FDV (price × total supply), else share × market cap, which
 * understates it when part of the supply is not circulating.
 *
 * A stress test, not a forecast: it assumes one pool, no other sellers or buyers
 * and no fee, and that every top-10 wallet is an ordinary holder, when some may
 * be unidentified pool or exchange accounts (the holder read says how it
 * identified pool vaults).
 */
export function holderDumpStress(input: {
  top10Pct: number | null; top10Method?: string | null; fdv: number | null; marketCap: number | null; liquidityUsd: number | null;
}): HolderStress {
  const none = (reason: string): HolderStress => ({ dataState: "unavailable", reason, basis: null, top10Pct: input.top10Pct, top10ValueUsd: null, quoteReserveUsd: null, scenarios: [], caveats: [] });
  const s = input.top10Pct;
  if (s == null || !Number.isFinite(s)) return none("top-10 holder share not read");
  if (!(s >= 0 && s <= 100)) return none("top-10 holder share out of range");
  const liq = input.liquidityUsd;
  if (liq == null || !Number.isFinite(liq)) return none("pool liquidity not reported");
  if (!(liq > 0)) return none("pool liquidity is $0");
  const fdvOk = input.fdv != null && Number.isFinite(input.fdv) && input.fdv > 0;
  const mcOk = input.marketCap != null && Number.isFinite(input.marketCap) && input.marketCap > 0;
  if (!fdvOk && !mcOk) return none("neither FDV nor market cap reported");
  const basis: "fdv" | "marketCap" = fdvOk ? "fdv" : "marketCap";
  const base = (fdvOk ? input.fdv : input.marketCap) as number;
  const value = (s / 100) * base;
  const Q = liq / 2;
  const scenarios: StressScenario[] = STRESS_FRACTIONS.map((fr) => {
    const v = value * fr;
    const ratio = v / Q;
    const drop = 1 - 1 / Math.pow(1 + ratio, 2);
    const proceeds = (Q * v) / (Q + v);
    return {
      soldFraction: fr, soldValueUsd: r2(v), soldVsQuoteReserve: r2(ratio), priceImpactPct: r2(100 * drop),
      proceedsUsd: r2(proceeds), proceedsPctOfValue: v > 0 ? r2((100 * proceeds) / v) : 100,
    };
  });
  const caveats = [
    "a stress test, not a forecast: one pool, no other sellers or buyers, no fees",
    "constant-product pool; quote reserve = liquidity / 2 (the cost module's convention)",
    basis === "marketCap" ? "FDV not reported: the position is valued at market cap, which understates it if part of the supply is not circulating" : "position valued at share of supply x FDV",
  ];
  if (input.top10Method && /INCLUDING/i.test(input.top10Method)) caveats.push("the pool vault was not identified, so the top-10 share may include the pool itself and overstate the sell side");
  return { dataState: "ok", reason: null, basis, top10Pct: s, top10ValueUsd: r2(value), quoteReserveUsd: r2(Q), scenarios, caveats };
}
