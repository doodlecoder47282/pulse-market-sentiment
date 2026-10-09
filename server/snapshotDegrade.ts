// server/snapshotDegrade.ts
//
// Pure assembly of the Signals snapshot and the Trade Desk payload from
// already-fetched inputs, with graceful degradation when Schwab cannot answer
// (no session, empty quotes, empty candles, chain error). No DB, no network:
// routes.ts fetches, this module decides what is live, what is partial and
// what is unavailable, so the decision is unit-tested with an
// "unauthenticated Schwab" stub (tests/quant/r3-5.test.ts).
//
// Rules (COMMON2 user rules 1, 2, 5):
//  - Schwab-dependent sections (quotes, gamma structure, composite) are null
//    with dataState "unavailable" and a reason when Schwab cannot answer;
//    they are never filled with zeros, defaults or older data.
//  - Non-Schwab context (StockTwits, CNN Fear & Greed, RSS headlines) is
//    still returned, labelled with its own source and age.
//  - The composite (0..100) blends implied-vol, options-positioning and crowd
//    blocks. Without the Schwab blocks it would be a crowd-only number shown
//    under the same label, so it is unavailable, not recomputed from crowd
//    data alone.
//  - When nothing useful remains the caller answers 503 {dataState, reason}.

import type { GammaStructure, Snapshot_Public, SocialSentiment, VolMetric } from "@shared/schema";
import { UpstreamUnavailableError, unavailableBody, type UnavailableBody } from "@shared/unavailable";

export interface QuoteLike {
  last: number | null;
  prev: number | null;
  stale?: boolean | null;
  ageMs?: number | null;
  prevSource?: string;
}

export type ChainErrorLike = { error: string; reason?: string; dataState?: string };
export type ChainOkLike = { asOfMs: number; ageMs: number; stale: boolean; staleReason?: string | null };
export type ChainRespLike<C extends ChainOkLike = ChainOkLike> = C | ChainErrorLike;

export interface HeadlineFeedLike {
  items: { title: string; url: string; source: string; publishedAt?: string; tier?: string; tierLabel?: string }[];
  status: "ok" | "partial" | "empty" | "unavailable";
  sources: Array<{ name: string; state: "ok" | "empty" | "failed" | "stale"; items: number; newest: string | null; tier?: string }>;
  asOf: number;
  maxAgeHours: number;
  note: string;
}

export type FearGreedLike = { value: number; label: string; source: string; asOf?: string | null; stale?: boolean } | null;

export interface SnapshotInputs<C extends ChainOkLike = ChainOkLike> {
  vix: QuoteLike; vvix: QuoteLike; vix9d: QuoteLike; vix3m: QuoteLike; skew: QuoteLike; spy: QuoteLike;
  chain: ChainRespLike<C>;
  fearGreed: FearGreedLike;
  social: SocialSentiment;
  headlines: HeadlineFeedLike;
  /** Warnings collected while fetching (e.g. social failure). */
  warnings: string[];
  nowMs: number;
}

export type SectionDataState = "ok" | "partial" | "stale" | "unavailable";
export interface SectionState {
  dataState: SectionDataState;
  reason: string | null;
  source: string;
}

/** /api/snapshot body when Schwab cannot supply the chain: same top-level keys
 *  as Snapshot_Public, Schwab sections null, plus dataState and per-section states. */
export interface SnapshotPartial {
  dataState: "partial";
  dataStateReason: string;
  capturedAt: number;
  spy: {
    price: number | null;
    prevClose: number | null;
    changePct: number | null;
    stale: boolean | null;
    ageMs: number | null;
    prevCloseSource?: string;
  };
  vol: Snapshot_Public["vol"];
  term: Snapshot_Public["term"];
  gamma: null;
  composite: null;
  social: SocialSentiment;
  fearGreed: FearGreedLike;
  aaii: null;
  headlines: HeadlineFeedLike["items"];
  headlinesFeed: Omit<HeadlineFeedLike, "items">;
  warnings: string[];
  gammaSource: "schwab";
  gammaAsOf: null;
  gammaStale: null;
  sections: {
    quotes: SectionState;
    gamma: SectionState;
    composite: SectionState;
    social: SectionState;
    fearGreed: SectionState;
    headlines: SectionState;
  };
}

/** VolMetric from a quote; changePct null (not 0) without a usable prior close. */
export function volMetric(symbol: string, name: string, last: number | null, prev: number | null, stale?: boolean | null): VolMetric {
  const changePct = last != null && prev ? ((last - prev) / prev) * 100 : null;
  return { symbol, name, value: last, prev, changePct, stale: stale ?? null };
}

function isChainError(c: unknown): c is ChainErrorLike {
  return !!c && typeof (c as ChainErrorLike).error === "string";
}

/** buildGammaStructure throws these messages when the chain has no
 *  underlying price or no re-priceable gamma on both sides of spot
 *  (server/sources.ts): the chain is unusable upstream data. */
const NO_UNDERLYING_RE = /no underlying price|no re-priceable gamma/i;

function quotesSection(q: SnapshotInputs["vix"][]): SectionState {
  const have = q.filter((x) => x.last != null).length;
  if (have === q.length) {
    const anyStale = q.some((x) => x.stale === true);
    return { dataState: anyStale ? "stale" : "ok", reason: anyStale ? "one or more Schwab quotes are past their max age" : null, source: "Schwab quotes" };
  }
  if (have === 0) return { dataState: "unavailable", reason: "Schwab returned no quotes (SPY, $VIX, $VVIX, $VIX9D, $VIX3M, $SKEW)", source: "Schwab quotes" };
  return { dataState: "partial", reason: `Schwab returned ${have} of ${q.length} quotes; the missing ones are shown as gaps`, source: "Schwab quotes" };
}

function socialSection(s: SocialSentiment): SectionState {
  const st = s.status;
  if (st === "unavailable" || (s.score == null && (s.posts?.length ?? 0) === 0 && st !== "insufficient")) {
    return { dataState: "unavailable", reason: "no social source collected", source: "StockTwits (context only)" };
  }
  if (st === "partial" || st === "insufficient") return { dataState: "partial", reason: st === "insufficient" ? "too few tagged posts to score" : "a social source failed or was stale", source: "StockTwits (context only)" };
  return { dataState: "ok", reason: null, source: "StockTwits (context only)" };
}

function fearGreedSection(fg: FearGreedLike): SectionState {
  if (!fg) return { dataState: "unavailable", reason: "CNN Fear & Greed did not answer", source: "CNN Fear & Greed (context only)" };
  return { dataState: fg.stale ? "stale" : "ok", reason: fg.stale ? "CNN Fear & Greed reading is past its max age" : null, source: `${fg.source} (context only)` };
}

function headlinesSection(h: HeadlineFeedLike): SectionState {
  const map: Record<HeadlineFeedLike["status"], SectionDataState> = { ok: "ok", partial: "partial", empty: "unavailable", unavailable: "unavailable" };
  return { dataState: map[h.status] ?? "unavailable", reason: h.status === "ok" ? null : h.note || `headline feed ${h.status}`, source: "RSS headlines (context only)" };
}

/** True when the partial payload still carries something a trader can read. */
export function partialHasContent(p: SnapshotPartial): boolean {
  return Object.values(p.sections).some((s) => s.dataState !== "unavailable");
}

/** Builds the partial (Schwab-unavailable) snapshot body. */
export function assembleSnapshotPartial(inp: Omit<SnapshotInputs, "chain">, reason: string): SnapshotPartial {
  const { vix, vvix, vix9d, vix3m, skew, spy } = inp;
  const spyChangePct = spy.last != null && spy.prev != null && spy.prev > 0 ? ((spy.last - spy.prev) / spy.prev) * 100 : null;
  const quotes = quotesSection([vix, vvix, vix9d, vix3m, skew, spy]);
  return {
    dataState: "partial",
    dataStateReason: reason,
    capturedAt: Math.floor(inp.nowMs / 1000),
    spy: {
      price: spy.last,
      prevClose: spy.prev ?? null,
      changePct: spyChangePct,
      stale: spy.last != null ? (spy.stale ?? null) : null,
      ageMs: spy.last != null ? (spy.ageMs ?? null) : null,
      prevCloseSource: spy.prevSource,
    },
    vol: {
      vix: volMetric("^VIX", "VIX (30-day implied vol)", vix.last, vix.prev, vix.stale),
      vvix: volMetric("^VVIX", "VVIX (Vol-of-Vol)", vvix.last, vvix.prev, vvix.stale),
      vix9d: volMetric("^VIX9D", "VIX9D (9-day)", vix9d.last, vix9d.prev, vix9d.stale),
      vix3m: volMetric("^VIX3M", "VIX3M (3-month)", vix3m.last, vix3m.prev, vix3m.stale),
      skew: volMetric("^SKEW", "Cboe SKEW index (via Schwab)", skew.last, skew.prev, skew.stale),
    },
    term: {
      vix9d: vix9d.last,
      vix: vix.last,
      vix3m: vix3m.last,
      ratio9dOver30d: vix.last && vix9d.last ? vix9d.last / vix.last : null,
      ratio30dOver3m: vix3m.last && vix.last ? vix.last / vix3m.last : null,
    },
    gamma: null,
    composite: null,
    social: inp.social,
    fearGreed: inp.fearGreed,
    aaii: null,
    headlines: inp.headlines.items,
    headlinesFeed: {
      status: inp.headlines.status,
      sources: inp.headlines.sources,
      asOf: inp.headlines.asOf,
      maxAgeHours: inp.headlines.maxAgeHours,
      note: inp.headlines.note,
    },
    warnings: [...inp.warnings, `Schwab-dependent sections unavailable: ${reason}`],
    gammaSource: "schwab",
    gammaAsOf: null,
    gammaStale: null,
    sections: {
      quotes,
      gamma: { dataState: "unavailable", reason, source: "Schwab SPY option chain" },
      composite: {
        dataState: "unavailable",
        reason: "the composite needs the Schwab implied-vol and options-positioning blocks; a crowd-only score is not shown under its label",
        source: "Batcave composite",
      },
      social: socialSection(inp.social),
      fearGreed: fearGreedSection(inp.fearGreed),
      headlines: headlinesSection(inp.headlines),
    },
  };
}

export type AssembledSnapshot = Omit<Snapshot_Public, "composite">;

/**
 * Assembles the snapshot (without composite) from fetched inputs. When the
 * Schwab chain is missing or unusable it throws UpstreamUnavailableError
 * whose `partial` is the SnapshotPartial body. Any other error from
 * buildGamma (a code bug) is rethrown unchanged.
 */
export function assembleSnapshot<C>(
  inp: Omit<SnapshotInputs, "chain"> & { chain: (C & ChainOkLike) | ChainErrorLike },
  buildGamma: (chain: C) => GammaStructure,
): AssembledSnapshot {
  const warnings = [...inp.warnings];
  const chainResp = inp.chain;
  if (isChainError(chainResp)) {
    const reason = `Schwab SPY options chain unavailable: ${chainResp.reason ?? chainResp.error}`;
    throw new UpstreamUnavailableError(reason, { partial: assembleSnapshotPartial(inp, reason) });
  }
  const chain = chainResp;
  if (chain.stale) warnings.push(`Schwab SPY chain is ${Math.round(chain.ageMs / 1000)} s old (${chain.staleReason ?? "refresh failed"}).`);

  let gamma: GammaStructure;
  try {
    gamma = buildGamma(chain);
  } catch (e: any) {
    if (typeof e?.message === "string" && NO_UNDERLYING_RE.test(e.message)) {
      const reason = `Schwab SPY options chain unusable: ${e.message}`;
      throw new UpstreamUnavailableError(reason, { partial: assembleSnapshotPartial(inp, reason) });
    }
    throw e;
  }
  const { vix, vvix, vix9d, vix3m, skew, spy, headlines } = inp;
  const term = {
    vix9d: vix9d.last,
    vix: vix.last,
    vix3m: vix3m.last,
    ratio9dOver30d: vix.last && vix9d.last ? vix9d.last / vix.last : null,
    ratio30dOver3m: vix3m.last && vix.last ? vix.last / vix3m.last : null,
  };
  // SPY day change: last vs the prior session close, null (not 0) when unknown.
  const spyPrice = spy.last ?? gamma.spot;
  const spyPrev = spy.prev ?? null;
  const spyChangePct = spyPrice != null && spyPrev != null && spyPrev > 0 ? ((spyPrice - spyPrev) / spyPrev) * 100 : null;
  return {
    capturedAt: Math.floor(inp.nowMs / 1000),
    spy: {
      price: spyPrice,
      prevClose: spyPrev,
      changePct: spyChangePct,
      // price from the chain's underlying when the quote is missing: that is the chain's age
      stale: spy.last != null ? (spy.stale ?? null) : chain.stale,
      ageMs: spy.last != null ? (spy.ageMs ?? null) : chain.ageMs,
      prevCloseSource: spy.prevSource,
    },
    vol: {
      vix: volMetric("^VIX", "VIX (30-day implied vol)", vix.last, vix.prev, vix.stale),
      vvix: volMetric("^VVIX", "VVIX (Vol-of-Vol)", vvix.last, vvix.prev, vvix.stale),
      vix9d: volMetric("^VIX9D", "VIX9D (9-day)", vix9d.last, vix9d.prev, vix9d.stale),
      vix3m: volMetric("^VIX3M", "VIX3M (3-month)", vix3m.last, vix3m.prev, vix3m.stale),
      skew: volMetric("^SKEW", "Cboe SKEW index (via Schwab)", skew.last, skew.prev, skew.stale),
    },
    term,
    gamma,
    social: inp.social,
    fearGreed: inp.fearGreed,
    aaii: null, // could be wired later via Thursday-released CSV
    headlines: headlines.items,
    headlinesFeed: { status: headlines.status, sources: headlines.sources, asOf: headlines.asOf, maxAgeHours: headlines.maxAgeHours, note: headlines.note },
    warnings,
    gammaSource: "schwab",
    gammaAsOf: Math.floor(chain.asOfMs / 1000),
    gammaStale: chain.stale,
  } as AssembledSnapshot;
}

/** Response for /api/snapshot after getOrBuild failed with `e`:
 *  200 partial when context remains, else 503 unavailable. null = not an
 *  upstream failure (caller answers 500). */
export function snapshotFailureResponse(e: unknown):
  | { status: 200; body: SnapshotPartial }
  | { status: 503; body: UnavailableBody }
  | null {
  const x = e as UpstreamUnavailableError | null;
  if (!x || x.name !== "UpstreamUnavailableError" || typeof x.reason !== "string") return null;
  const p = x.partial as SnapshotPartial | undefined;
  if (p && p.dataState === "partial" && partialHasContent(p)) return { status: 200, body: p };
  return { status: 503, body: unavailableBody(x.reason, x.upstream ?? "schwab") };
}

// ── Trade Desk ──────────────────────────────────────────────────────────────

type SeriesLike = { price: number | null; bars?: unknown[] | null } | null;

export interface TradeDeskDegradeInput {
  range: "1d" | "5d";
  interval: string;
  quotes: { spx: SeriesLike; spy: SeriesLike; vix: SeriesLike };
  pivots: { spx: unknown | null; spy: unknown | null; vix: unknown | null };
  /** Why the snapshot (gamma, composite, playbook inputs) is unavailable. */
  reason: string;
  /** Voices crowd bias (non-Schwab context), passed through when present. */
  voicesBias?: unknown;
  nowMs: number;
}

function seriesHasData(s: SeriesLike): boolean {
  return !!s && (s.price != null || (Array.isArray(s.bars) && s.bars.length > 0));
}

/**
 * Trade Desk when the snapshot is unavailable. Intraday quotes and pivots
 * are independent Schwab price-history calls: if any came back, the desk is
 * a 200 partial with gammaMap, squeeze, playbook and composite null (each
 * with a reason). If none did, 503 unavailable.
 */
export function tradeDeskDegraded(inp: TradeDeskDegradeInput):
  | { status: 200; body: Record<string, unknown> }
  | { status: 503; body: UnavailableBody } {
  const any = seriesHasData(inp.quotes.spx) || seriesHasData(inp.quotes.spy) || seriesHasData(inp.quotes.vix);
  if (!any) {
    return { status: 503, body: unavailableBody(`Schwab returned no intraday quotes for $SPX, SPY or $VIX, and ${inp.reason}`) };
  }
  const sec = (source: string): SectionState => ({ dataState: "unavailable", reason: inp.reason, source });
  return {
    status: 200,
    body: {
      dataState: "partial",
      dataStateReason: inp.reason,
      capturedAt: Math.floor(inp.nowMs / 1000),
      range: inp.range,
      interval: inp.interval,
      quotes: inp.quotes,
      pivots: inp.pivots,
      gammaMap: null,
      gammaAsOf: null,
      gammaStale: null,
      squeeze: null,
      playbook: null,
      composite: null,
      voicesBias: inp.voicesBias ?? null,
      sections: {
        gammaMap: sec("Schwab SPY option chain"),
        squeeze: sec("Schwab SPY chain + Schwab vol quotes"),
        playbook: sec("Schwab SPY chain + Schwab vol quotes"),
        composite: sec("Batcave composite"),
      },
    },
  };
}

// ── Voices fact-check metrics ───────────────────────────────────────────────

export interface LiveMetrics { vix: number | null; vvix: number | null; spy: number | null; skew: number | null; pcr: number | null }

/** Live metrics for the voices fact-check: null (not 0) when the snapshot or
 *  a field is unavailable. A 0 here used to mark every "VIX 20" claim as a
 *  conflict when Schwab was down. */
export function liveMetricsFromSnapshot(snap: {
  vol: { vix: { value: number | null }; vvix: { value: number | null }; skew: { value: number | null } };
  spy: { price: number | null };
  gamma: { pcrOi: number } | null;
} | null): LiveMetrics {
  const f = (x: number | null | undefined) => (x != null && Number.isFinite(x) ? x : null);
  if (!snap) return { vix: null, vvix: null, spy: null, skew: null, pcr: null };
  return {
    vix: f(snap.vol.vix.value),
    vvix: f(snap.vol.vvix.value),
    spy: f(snap.spy.price),
    skew: f(snap.vol.skew.value),
    pcr: f(snap.gamma?.pcrOi),
  };
}

/** factCheckItem input: a missing metric is NaN, which factCheckItem skips
 *  (Number.isFinite), so the claim is "unverified" rather than "conflict". */
export function factCheckMetrics(m: LiveMetrics): { vix: number; vvix: number; spy: number; skew: number; pcr: number } {
  const n = (x: number | null) => (x == null ? Number.NaN : x);
  return { vix: n(m.vix), vvix: n(m.vvix), spy: n(m.spy), skew: n(m.skew), pcr: n(m.pcr) };
}
