// shared/memeStructure.ts
//
// Structural arithmetic for the Crypto tab: what it costs to trade a pool of a
// given depth, where a coin sits in the launch food chain, which of three
// structural categories it falls in, where its price sits in its own range,
// and the hold-vs-rotate arithmetic with the timing assumption made explicit.
//
// Pure functions, no I/O, shared by server (candidate enrichment, API) and
// client (calculator card), unit-tested on plain Node.
//
// Everything here is descriptive. Nothing in this file decides whether to buy
// or sell; it states costs, positions and counts, with the assumptions each
// number rests on, and reports missing inputs as missing (never as zero).
//
// Sources for the assumptions, in docs/MEME_STRUCTURE.md: constant-product
// AMM math (Uniswap v2 whitepaper), DexScreener pair fields (liquidity.usd is
// both sides of the pool), Raydium / PumpSwap fee schedules.

// ─── Execution cost ─────────────────────────────────────────────────────

import { CRYPTO_RULES } from "./cryptoRules";
export interface TradeCostInput {
  /** DexScreener liquidity.usd: both sides of the pool, in USD. null = not reported. */
  liquidityUsd: number | null;
  /** Quote currency spent on the buy, USD. */
  sizeUsd: number;
  /** Pool (LP) fee per swap, percent. Default 0.25 (Raydium AMM v4 / PumpSwap LP fee). */
  dexFeePct?: number;
  /** App / router / bot fee per swap, percent. Default 1.0 (typical trading app). 0 for a bare DEX swap. */
  platformFeePct?: number;
  /** Network priority fee per swap, USD. Default 0.25. */
  priorityFeeUsd?: number;
}

export interface TradeCost {
  /** ok | unavailable (liquidity not reported) | observed_zero (pool reports $0) | invalid (liquidity or size not usable) | below_fees (size does not cover fees and priority). */
  dataState: "ok" | "unavailable" | "observed_zero" | "invalid" | "below_fees";
  sizeUsd: number;
  /** USD assumed on the quote side of the pool (liquidity / 2, balanced-pool assumption). */
  quoteReserveUsd: number | null;
  /** Price impact of the buy, percent: share of the amount reaching the pool lost against the quote (x / (Q + x)). */
  impactBuyPct: number | null;
  /** Where the pool's price sits after the buy, percent above the quote ((1 + x/Q)^2 - 1). */
  priceMoveAfterBuyPct: number | null;
  /** Price impact of the zero-edge sell, percent of the tokens' entry value (v0 / (Q + v0)). */
  impactSellPct: number | null;
  /** Fees on both swaps, percent of size (dex + platform, twice). */
  feesRoundTripPct: number;
  /** Priority fees on both swaps, USD. */
  priorityRoundTripUsd: number;
  /** All-in cost of a buy and a zero-edge sell, percent of size: 100 x (size - net proceeds) / size. */
  roundTripPct: number | null;
  /** Price move, percent, the quote must make between the buy and the sell for the sell to return the size spent; null when no move can (the pool's depth caps the proceeds under the size). */
  breakEvenMovePct: number | null;
  assumptions: string[];
}

export const DEFAULT_DEX_FEE_PCT = CRYPTO_RULES.cost.dexFeePct;
export const DEFAULT_PLATFORM_FEE_PCT = CRYPTO_RULES.cost.platformFeePct;
export const DEFAULT_PRIORITY_USD = CRYPTO_RULES.cost.priorityFeeUsd;

function finite(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Cost of a buy and a sell against one constant-product pool.
 *
 * Model: reserves Q (quote, USD) and B (base) with Q·B = k and quoted price
 * p0 = Q/B. A buy that puts x USD into the pool receives B·x/(Q+x) tokens,
 * worth v0 = Q·x/(Q+x) at the quote: the buy's price impact is x/(Q+x) of x.
 * The pool's price after the buy is p0·(1 + x/Q)^2. Selling the same tokens
 * straight back into the untouched pool returns x exactly (the path is
 * reversible); the impact becomes a cost when the quote has come back to the
 * entry and the sell pays its own impact again, which is the "zero edge"
 * round trip used here: proceeds Q·v0/(Q+v0) = Q·x/(Q+2x) before fees. The
 * break-even move is the quote at which the sell, after its own impact at
 * that depth, fees and priority, returns the size spent; the proceeds are
 * capped by the depth, so for a size above that cap there is no break-even.
 *
 * Q is taken as liquidityUsd / 2 (DexScreener reports both sides). Concentrated
 * liquidity pools (CLMM, DLMM) have less impact inside the active range and
 * more outside it; this is the constant-product figure, labelled as such.
 */
export function tradeCost(input: TradeCostInput): TradeCost {
  const dexFee = Math.max(0, finite(input.dexFeePct) ?? DEFAULT_DEX_FEE_PCT);
  const platFee = Math.max(0, finite(input.platformFeePct) ?? DEFAULT_PLATFORM_FEE_PCT);
  const prio = Math.max(0, finite(input.priorityFeeUsd) ?? DEFAULT_PRIORITY_USD);
  const size = finite(input.sizeUsd) ?? 0;
  const feesRoundTripPct = 2 * (dexFee + platFee);
  const assumptions = [
    "constant-product pool (x*y=k); quote reserve = liquidity / 2",
    `pool fee ${dexFee}% and app fee ${platFee}% per swap, priority $${prio} per swap (assumed, not read from the pool)`,
    "round trip = buy at the quote, sell when the quote is back at the entry (the zero-edge case); an immediate sell into an untouched pool returns the size less fees",
  ];
  const base: TradeCost = {
    dataState: "ok", sizeUsd: size, quoteReserveUsd: null, impactBuyPct: null, priceMoveAfterBuyPct: null, impactSellPct: null,
    feesRoundTripPct: r2(feesRoundTripPct), priorityRoundTripUsd: r2(2 * prio), roundTripPct: null, breakEvenMovePct: null, assumptions,
  };
  const liq = finite(input.liquidityUsd);
  if (liq == null) return { ...base, dataState: "unavailable" };
  if (liq < 0) return { ...base, dataState: "invalid" };
  if (liq === 0) return { ...base, dataState: "observed_zero", quoteReserveUsd: 0 };
  if (!(size > 0)) return { ...base, dataState: "invalid", quoteReserveUsd: r2(liq / 2) };

  const Q = liq / 2;
  // Fees come off before the pool sees the order.
  const feeFrac = Math.min(1, (dexFee + platFee) / 100);
  const x = size * (1 - feeFrac) - prio;
  if (!(x > 0)) return { ...base, dataState: "below_fees", quoteReserveUsd: r2(Q) };
  const impactBuy = x / (Q + x);
  const priceAfterBuy = Math.pow(1 + x / Q, 2);   // pool price / p0 after the buy
  const v0 = (Q * x) / (Q + x);                   // tokens' value at the entry quote
  // Zero-edge sell at the entry quote, same depth.
  const gross0 = (Q * v0) / (Q + v0);
  const impactSell = v0 / (Q + v0);
  const net0 = gross0 * (1 - feeFrac) - prio;
  const roundTripPct = (100 * (size - net0)) / size;

  // Break-even: net(m) = Q·v/(Q+v)·(1-fee) - prio with v = v0·(1+m) rises
  // monotonically toward Q·(1-fee) - prio; bracket and bisect, null if the
  // size is never reached.
  const netAt = (m: number) => { const v = v0 * (1 + m); return ((Q * v) / (Q + v)) * (1 - feeFrac) - prio; };
  let breakEven: number | null = null;
  if (net0 >= size) breakEven = 0;
  else if (Q * (1 - feeFrac) - prio > size) {
    let lo = 0, hi = 1;
    while (netAt(hi) < size && hi < 1e9) hi *= 2;
    if (netAt(hi) >= size) {
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (netAt(mid) >= size) hi = mid; else lo = mid;
        if (hi - lo < 1e-12 * Math.max(1, hi)) break;
      }
      breakEven = hi;
    }
  }
  return {
    ...base,
    quoteReserveUsd: r2(Q),
    impactBuyPct: r2(100 * impactBuy),
    priceMoveAfterBuyPct: r2(100 * (priceAfterBuy - 1)),
    impactSellPct: r2(100 * impactSell),
    roundTripPct: r2(roundTripPct),
    breakEvenMovePct: breakEven == null ? null : r2(100 * breakEven),
  };
}

/** Balance left after `trades` round trips at zero edge (exit at the entry price), each costing `roundTripPct`. */
export function zeroEdgeBalance(startUsd: number, roundTripPct: number, trades: number): number {
  // A NaN cost or start is not a balance: NaN propagates rather than reading as $0 or as no cost.
  if (!Number.isFinite(roundTripPct) || !Number.isFinite(startUsd)) return Number.NaN;
  const n = Math.max(0, Math.floor(finite(trades) ?? 0));
  const cost = Math.min(100, Math.max(0, roundTripPct));
  return Math.max(0, startUsd) * Math.pow(1 - cost / 100, n);
}

/** Largest buy, USD, whose price impact (x / (Q + x)) stays at or under `impactPct` (constant product, Q = liquidity / 2). */
export function maxSizeAtImpact(liquidityUsd: number | null, impactPct: number): number | null {
  const liq = finite(liquidityUsd);
  const i = finite(impactPct);
  if (liq == null || liq <= 0 || i == null || !(i > 0) || i >= 100) return null;
  const f = i / 100;
  return Math.floor((liq / 2) * (f / (1 - f)));
}

// ─── Launch food chain ──────────────────────────────────────────────────

export interface LinePosition {
  /** Groups structurally ahead of a public buyer at this age, in order. */
  ahead: string[];
  /** Phase label for the chip. */
  phase: "first-hour" | "first-day" | "first-week" | "settled" | "unknown";
  note: string;
}

/**
 * Who got in before a public buyer, by pool age. Devs own the supply at
 * launch; insiders buy before the announcement; snipers and bots fill the first
 * blocks; popular traders buy, get copied, and sell into the copies. Public
 * data cannot show who has exited; the top-10 holder share is the measurable
 * residue of this ordering.
 */
export function linePosition(ageMinutes: number | null, pumpfunGraduate: boolean): LinePosition {
  const age = finite(ageMinutes);
  if (age == null) return { ahead: [], phase: "unknown", note: "pool age not reported; the launch order cannot be placed" };
  const chain = ["devs (own the supply)", "insiders (bought before the announcement)", "snipers and bots (first blocks)", "popular traders (buy, get copied, sell into the copies)"];
  if (age < 60) return { ahead: chain, phase: "first-hour", note: `${pumpfunGraduate ? "bonding-curve graduate, " : ""}all four groups are ahead and still holding size; a public buyer is fifth in line` };
  if (age < 24 * 60) return { ahead: chain, phase: "first-day", note: "launch-day holders are ahead; their exits show up as the top-10 share falling and sells outrunning buys" };
  if (age < 7 * 24 * 60) return { ahead: chain.slice(0, 3), phase: "first-week", note: "dev, insider and sniper supply may still be sitting; the top-10 share says how much" };
  return { ahead: [], phase: "settled", note: "launch-order supply has had time to distribute; the top-10 share and liquidity depth are the measurable residue" };
}

// ─── Three structural categories ────────────────────────────────────────

export type MemeCategory = "new-launch" | "speculative" | "meta" | "maturing" | "community" | "unclassified";

export interface MemeClassInput {
  name: string;
  symbol: string;
  ageDays: number | null;
  liquidityUsd: number | null;
  top10Pct: number | null;
  mintAuthorityActive: boolean | null;
  /** Narrative (news) keyword hits from the narratives engine. */
  narrativeHits: string[];
  /** Range statistics from daily history, when available. */
  history: RangeStats | null;
}

export interface MemeClass {
  category: MemeCategory;
  /** firm: every input the rule needs was present; tentative: a needed input was missing. */
  confidence: "firm" | "tentative";
  reasons: string[];
  missing: string[];
}

export const COMMUNITY_MIN_AGE_DAYS = 30;
export const COMMUNITY_MIN_LIQUIDITY_USD = 100_000;
export const COMMUNITY_MAX_TOP10_PCT = 30;

/** Name patterns of copy-the-template launches (forks, "2.0", chain ports, template metas). */
export const META_PATTERNS: Array<{ re: RegExp; tag: string }> = [
  { re: /(?:^|[^0-9.])(2\.0|3\.0)(?![0-9])|\b(v2|v3)\b/i, tag: "sequel" },
  { re: /\b(baby|mini|lil|little)\b/i, tag: "derivative" },
  { re: /\b(on (base|sol|solana|eth|bsc|ton)|wrapped|bridged)\b/i, tag: "chain port" },
  { re: /\b(fork|clone|copy)\b/i, tag: "fork" },
  { re: /\b(fee ?share|creator ?reward|revshare|buyback)\b/i, tag: "fee-share meta" },
  { re: /\b(launchpad|launcher)\b/i, tag: "launchpad meta" },
  { re: /\b(ponzi|pyramid|scheme)\b/i, tag: "pyramid mechanics" },
  { re: /\b(agent|gpt|llm)\b/i, tag: "ai-agent meta" },
];

/**
 * Speculative = bought on a news trigger (a narrative hit on a young pool).
 * Meta = a copy of a template that just worked (name pattern on a young pool).
 * Community = settled: 30+ days old, $100k+ liquidity, top-10 share at or
 * under 30% where read, mint authority not active; firm when history shows
 * at least one deep dip that was reclaimed. New-launch / maturing = too young
 * to be any of the three. Unclassified = the inputs to decide are missing.
 */
export function classifyMeme(f: MemeClassInput): MemeClass {
  const missing: string[] = [];
  const reasons: string[] = [];
  const age = finite(f.ageDays);
  const top10 = finite(f.top10Pct);
  if (age == null) {
    return { category: "unclassified", confidence: "tentative", reasons: ["pool age not reported"], missing: ["ageDays"] };
  }
  const text = `${f.name} ${f.symbol}`;
  const metaTags = META_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.tag);
  const newsHits = (f.narrativeHits || []).filter(Boolean);
  // An active mint authority (the issuer can still print supply) is named
  // whatever the age; it only decides the category in the community test.
  if (f.mintAuthorityActive === true) reasons.push("mint authority active");

  if (age < COMMUNITY_MIN_AGE_DAYS) {
    if (newsHits.length) {
      reasons.push(`news trigger: ${newsHits.slice(0, 3).join(", ")}`, `${age < 1 ? "under a day" : `${Math.floor(age)}d`} old: attention tied to a news cycle, not to the coin`);
      return { category: "speculative", confidence: "firm", reasons, missing };
    }
    if (metaTags.length) {
      reasons.push(`template name (${metaTags.join(", ")}): follower of a meta, not its originator`);
      return { category: "meta", confidence: "firm", reasons, missing };
    }
    if (age < 7) {
      reasons.push(`${age < 1 ? "under a day" : `${Math.floor(age)}d`} old: launch-order supply still in place`);
      return { category: "new-launch", confidence: "firm", reasons, missing };
    }
    reasons.push(`${Math.floor(age)}d old: past the launch week, short of ${COMMUNITY_MIN_AGE_DAYS}d`);
    return { category: "maturing", confidence: "firm", reasons, missing };
  }

  // 30+ days: community test on depth, concentration and authority.
  const liq = finite(f.liquidityUsd);
  if (liq == null) missing.push("liquidityUsd");
  if (top10 == null) missing.push("top10Pct");
  if (f.mintAuthorityActive == null) missing.push("mintAuthority");
  const deepEnough = liq != null && liq >= COMMUNITY_MIN_LIQUIDITY_USD;
  const spread = top10 == null || top10 <= COMMUNITY_MAX_TOP10_PCT;
  const mintOk = f.mintAuthorityActive !== true;
  reasons.push(`${Math.floor(age)}d old`);
  if (liq != null) reasons.push(`liquidity $${Math.round(liq).toLocaleString("en-US")}${deepEnough ? "" : ` (under $${COMMUNITY_MIN_LIQUIDITY_USD.toLocaleString("en-US")})`}`);
  if (top10 != null) reasons.push(`top-10 holders ${top10}%${spread ? "" : ` (over ${COMMUNITY_MAX_TOP10_PCT}%)`}`);
  // Confidence: firm only when every input the rule needs was present.
  const conf = (): MemeClass["confidence"] => (missing.length ? "tentative" : "firm");
  if (!deepEnough || !spread || !mintOk) {
    reasons.push(liq == null ? "liquidity not reported" : "aged but fails the community depth / supply test");
    return { category: "unclassified", confidence: conf(), reasons, missing };
  }
  const h = f.history;
  if (h && (h.dataState === "ok" || h.dataState === "partial")) {
    const span = `${h.bars} days of history${h.dataState === "partial" ? " (partial, under 30 bars)" : ""}`;
    if (h.deepDipsReclaimed > 0) {
      reasons.push(`${h.deepDipsReclaimed} dip${h.deepDipsReclaimed === 1 ? "" : "s"} of ${Math.round(h.deepDipPct)}%+ reclaimed to a new high in ${span}`);
      return { category: "community", confidence: conf(), reasons, missing };
    }
    reasons.push(`no ${Math.round(h.deepDipPct)}%+ dip reclaimed yet in ${span}`);
    return { category: "community", confidence: "tentative", reasons, missing };
  }
  missing.push("history");
  reasons.push("daily history unavailable: survival through a deep dip not yet observed");
  return { category: "community", confidence: "tentative", reasons, missing };
}

// ─── Range statistics from daily candles ────────────────────────────────

export interface DailyBar {
  /** Bar open time, ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface RangeStats {
  dataState: "ok" | "partial" | "no_data";
  bars: number;
  windowDays: number;
  last: number | null;
  windowHigh: number | null;
  windowLow: number | null;
  /** 0 at the window low, 1 at the window high (close basis). */
  rangePosition: number | null;
  /** Percent below the window high, 0 at the high. */
  drawdownFromHighPct: number | null;
  /** Calendar days from the latest bar at the window high to the last bar. */
  daysSinceHigh: number | null;
  /** Threshold used for "deep dip", percent. */
  deepDipPct: number;
  /** Dips of deepDipPct or more from a running high that were later reclaimed (a close at or above that high). */
  deepDipsReclaimed: number;
  /** A deep dip that has not been reclaimed as of the last bar. */
  deepDipOpen: boolean;
  /** Largest peak-to-trough drawdown in the window, percent. */
  maxDrawdownPct: number | null;
  /** Annualized standard deviation of daily log returns over the last 30 bars, percent. */
  realizedVol30Pct: number | null;
  /** Median daily dollar volume over the window. */
  medianDailyVolumeUsd: number | null;
}

export const DEEP_DIP_PCT = 70;

/**
 * Range position and survival counts from daily bars (ascending time).
 * Close-to-close throughout so one bad wick does not make a dip. A reclaim is
 * a later close at or above the running high the dip was measured from; the
 * running high then moves on. Fewer than 7 bars is no data; fewer than 30 is
 * partial.
 */
export function rangeStats(barsIn: DailyBar[], windowDays = 90, deepDipPct = DEEP_DIP_PCT): RangeStats {
  const byT = new Map<number, DailyBar>();
  for (const b of barsIn || []) {
    if (!b || !Number.isFinite(b.c) || !(b.c > 0) || !Number.isFinite(b.t)) continue;
    byT.set(b.t, b); // duplicate timestamps: the last one wins
  }
  const all = Array.from(byT.values()).sort((a, b) => a.t - b.t);
  const DAY = 86_400_000;
  const w = Math.max(1, Math.floor(windowDays));
  // Calendar window from the last bar, so sources that omit empty days still span `windowDays`.
  const bars = all.length ? all.filter((b) => b.t >= all[all.length - 1].t - (w - 1) * DAY) : all;
  const n = bars.length;
  const empty: RangeStats = {
    dataState: "no_data", bars: n, windowDays, last: null, windowHigh: null, windowLow: null, rangePosition: null,
    drawdownFromHighPct: null, daysSinceHigh: null, deepDipPct, deepDipsReclaimed: 0, deepDipOpen: false,
    maxDrawdownPct: null, realizedVol30Pct: null, medianDailyVolumeUsd: null,
  };
  if (n < 7) return empty;
  const closes = bars.map((b) => b.c);
  const last = closes[n - 1];
  let hi = -Infinity, hiIdx = 0, lo = Infinity;
  for (let i = 0; i < n; i++) {
    if (closes[i] >= hi) { hi = closes[i]; hiIdx = i; } // the latest bar at the high
    if (closes[i] < lo) lo = closes[i];
  }
  const rangePosition = hi > lo ? (last - lo) / (hi - lo) : 0.5;

  // Running-high drawdowns, deep dips and reclaims.
  let runHigh = closes[0];
  let inDeep = false;
  let reclaimed = 0;
  let maxDd = 0;
  let trough = closes[0];
  for (let i = 1; i < n; i++) {
    const c = closes[i];
    if (c >= runHigh) {
      if (inDeep) { reclaimed++; inDeep = false; }
      runHigh = c;
      trough = c;
    } else {
      if (c < trough) trough = c;
      const dd = 1 - c / runHigh;
      if (dd > maxDd) maxDd = dd;
      if (!inDeep && dd >= deepDipPct / 100) inDeep = true;
    }
  }

  let vol: number | null = null;
  if (n >= 8) {
    const tail = closes.slice(-31);
    const rets: number[] = [];
    for (let i = 1; i < tail.length; i++) rets.push(Math.log(tail[i] / tail[i - 1]));
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const varr = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / Math.max(1, rets.length - 1);
    vol = 100 * Math.sqrt(varr) * Math.sqrt(365);
  }
  const vols = bars.map((b) => b.v).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const medVol = !vols.length ? null : vols.length % 2 ? vols[(vols.length - 1) / 2] : (vols[vols.length / 2 - 1] + vols[vols.length / 2]) / 2;

  return {
    dataState: n >= 30 ? "ok" : "partial",
    bars: n,
    windowDays,
    last,
    windowHigh: hi,
    windowLow: lo,
    rangePosition: Math.round(rangePosition * 1000) / 1000,
    drawdownFromHighPct: r2(100 * (1 - last / hi)),
    daysSinceHigh: Math.round((bars[n - 1].t - bars[hiIdx].t) / DAY),
    deepDipPct,
    deepDipsReclaimed: reclaimed,
    deepDipOpen: inDeep,
    maxDrawdownPct: r2(100 * maxDd),
    realizedVol30Pct: vol == null ? null : r2(vol),
    medianDailyVolumeUsd: medVol == null ? null : Math.round(medVol),
  };
}

// ─── Hold vs rotate arithmetic ──────────────────────────────────────────

/** One step of the illustration: a shared up-leg, or a dip in the held coin while another coin rises. */
export type RotationEvent =
  | { kind: "up"; mult: number }
  | { kind: "dip"; dip: number; otherUp: number };

export interface RotationIllustration {
  startUsd: number;
  events: number;
  /** Fraction of each top and bottom the rotator actually catches (1 = perfect, 0 = no better than holding). */
  timingCapture: number;
  roundTripCostPct: number;
  holderUsd: number;
  rotatorUsd: number;
  /** rotator / holder, with the holder floored at $1 so a wiped-out holder still gives a finite, positive figure. */
  ratio: number;
  /** Rotation costs paid, USD. */
  costsPaidUsd: number;
  rotations: number;
  assumptions: string[];
}

/** The thread's own example: A 3x, A -70% while B 3x, A 3x. */
export const ROTATION_EXAMPLE: RotationEvent[] = [
  { kind: "up", mult: 3 },
  { kind: "dip", dip: 0.7, otherUp: 3 },
  { kind: "up", mult: 3 },
];

/**
 * The published arithmetic with its hidden assumption surfaced. On an "up"
 * event both accounts ride the move. On a "dip" event the holder sits through
 * the held coin's dip; the rotator sells at a fraction `timingCapture` of the
 * top, pays a round trip, buys the other coin at that fraction of its bottom
 * and rides that fraction of its rise, then pays a round trip to come back.
 * At capture 1 it collects every up-leg and no dip (the published figure); at
 * capture 0 it is a holder paying two round trips per rotation. No coin
 * repeats the same move on schedule; this shows how much of the published gap
 * is timing rather than structure.
 */
export function rotationIllustration(startUsd: number, events: RotationEvent[], roundTripCostPct: number, timingCapture = 1): RotationIllustration {
  const cap = Math.min(1, Math.max(0, finite(timingCapture) ?? 1));
  const cost = Math.min(100, Math.max(0, finite(roundTripCostPct) ?? 0)) / 100;
  let holder = Math.max(0, finite(startUsd) ?? 0);
  let rotator = holder;
  let costs = 0;
  let rotations = 0;
  for (const ev of events) {
    if (ev.kind === "up") {
      const mult = Math.max(0, finite(ev.mult) ?? 1);
      holder *= mult;
      rotator *= mult;
      continue;
    }
    const dip = Math.min(1, Math.max(0, finite(ev.dip) ?? 0));
    const otherUp = Math.max(0, finite(ev.otherUp) ?? 1);
    holder *= 1 - dip;
    // Sell at `cap` of the top: the rotator keeps cap of what the holder loses.
    rotator *= 1 - dip * (1 - cap);
    let fee = rotator * cost; costs += fee; rotator -= fee;        // out of A, into B
    rotator *= 1 + cap * (otherUp - 1);                            // cap of B's rise
    fee = rotator * cost; costs += fee; rotator -= fee;            // out of B, back into A
    rotations += 2;
  }
  return {
    startUsd, events: events.length, timingCapture: cap, roundTripCostPct: r2(100 * cost),
    holderUsd: Math.round(holder), rotatorUsd: Math.round(rotator),
    ratio: Math.round((rotator / Math.max(1, holder)) * 100) / 100,
    costsPaidUsd: Math.round(costs),
    rotations,
    assumptions: [
      "every coin makes exactly the moves entered, in order",
      `the rotator catches ${Math.round(cap * 100)}% of each top and bottom`,
      `each rotation costs ${r2(100 * cost)}% (one sell, one buy)`,
      "an arithmetic illustration, not a forecast or a record of any coin",
    ],
  };
}
