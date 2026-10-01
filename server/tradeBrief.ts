import { createHash } from "node:crypto";
import type { Express, Request, Response } from "express";
import { classicPivots } from "./pivots";
import { etEpochMs } from "./etTime";
import { enrichStockBrief, type BriefBar } from "./tradeBriefEnrichment";
import {
  BriefRequestSchema, SearchRequestSchema, TRADE_BRIEF_CATEGORIES, TRADE_BRIEF_INSTRUMENTS,
  TRADE_BRIEF_VERSION, TradeBriefSchema, searchTradeBriefInstruments,
  type CoverageStatus, type TradeBrief, type TradeBriefCategory, type TradeBriefEvidence,
  type TradeBriefHorizon, type TradeBriefInstrument, type TradeBriefLevel, type TradeBriefSourceStatus,
} from "../shared/tradeBrief";

const SECOND = 1_000;
const DAY = 86_400_000;
const SNAPSHOT_TTL = 45 * SECOND;
const SCHWAB_URL = "https://developer.schwab.com/products/trader-api--individual";
const MAX_IN_FLIGHT = 4;
type LoadResult = { state: "ok"; value: unknown } | { state: "unavailable" | "timeout" | "busy"; value: null };
export interface TradeBriefDependencies {
  quote: (symbol: string) => Promise<unknown>;
  history: (symbol: string) => Promise<unknown>;
  macro: () => Promise<unknown>;
  /** Optional raw Schwab-only chain; no getOptionChain delayed fallback. */
  options?: (symbol: string) => Promise<unknown>;
  /** Local cache-only readers: never start aggregate RSS/calendar builds. */
  news?: () => Promise<unknown>;
  earnings?: () => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
}
type RecordValue = Record<string, unknown>;
const object = (v: unknown): RecordValue => v !== null && typeof v === "object" && !Array.isArray(v)
  ? v as RecordValue : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const iso = (ms: number) => new Date(ms).toISOString();
const validTime = (v: unknown, now: number): v is number =>
  finite(v) && v > 946684800000 && v <= now; // never silently replace a missing/provider-future time

function etDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(ms);
  return ["year", "month", "day"].map(k => parts.find(p => p.type === k)!.value).join("-");
}
function shiftDate(date: string, days: number): string {
  return iso(Date.parse(`${date}T12:00:00Z`) + days * DAY).slice(0, 10);
}
function weekday(date: string) { return new Date(`${date}T12:00:00Z`).getUTCDay(); }
function clockSession(now: number): string {
  const date = etDate(now), day = weekday(date);
  if (day === 0 || day === 6) return "Weekend clock window — exchange calendar and halt status unverified";
  if (now < etEpochMs(date, 9, 30)) return "Pre-open clock window — exchange calendar and halt status unverified";
  if (now >= etEpochMs(date, 16, 0)) return "After-close clock window — early closes and halt status unverified";
  return "Regular-hours clock window — holidays, early closes and halt status unverified";
}
const REGISTRY: Record<TradeBriefCategory, { source: string; dependencies: string[]; age: number | null }> = {
  quote: { source: "Schwab quote", dependencies: ["exact listing", "trade timestamp", "real-time entitlement"], age: 300 },
  levels: { source: "Schwab daily OHLC + existing classicPivots", dependencies: ["usable quote", "complete prior period", "USD prices"], age: null },
  news: { source: "Existing news.ts (excluded)", dependencies: ["ticker-specific attribution", "per-feed health"], age: null },
  options: { source: "Existing options adapters (excluded)", dependencies: ["fresh chain", "OI timestamp", "reviewed Greek units"], age: null },
  volume: { source: "Schwab cumulative quote volume", dependencies: ["quote timestamp"], age: 300 },
  earnings: { source: "Existing earnings.ts (excluded)", dependencies: ["verified issuer date", "timing", "row provenance"], age: null },
  macro: { source: "Existing cached FRED observations", dependencies: ["observation date"], age: 7 * 86400 },
  seasonality: { source: "No validated asset-specific adapter", dependencies: ["reproducible history", "sample/window disclosure"], age: null },
};

function moduleStatus(category: TradeBriefCategory, now: number): TradeBriefSourceStatus {
  const r = REGISTRY[category];
  return { category, applicability: "applicable", status: "unsupported", contributed: false,
    source: r.source, reason: "", observed_at: null, checked_at: iso(now),
    max_age_seconds: r.age, evidence_ids: [], dependencies: [...r.dependencies] };
}
function evidence(id: string, category: TradeBriefCategory, label: string, value: number, unit: string,
  observed: string, status: CoverageStatus, source = "Schwab", url = SCHWAB_URL,
  precision: TradeBriefEvidence["time_precision"] = "instant"): TradeBriefEvidence {
  return { id, category, label, value, unit, observed_at: observed, status, source, url, time_precision: precision };
}
function errorReason(result: LoadResult): string {
  return result.state === "timeout" ? "Source exceeded the bounded response deadline; no substitute values used."
    : result.state === "busy" ? "Source read budget is busy; retry manually later."
    : "Source unavailable or not authorized. No substitute values used.";
}

/** Canonical, timestamp-preserving adapter; getQuotes() drops provider timestamps. */
function readQuote(raw: unknown, instrument: TradeBriefInstrument, now: number) {
  const row = object(object(raw)[instrument.symbol]), q = object(row.quote), ref = object(row.reference);
  const identityOK = row.symbol === instrument.symbol
    && row.synthetic !== true && q.synthetic !== true
    && (row.assetMainType === "EQUITY" || row.assetMainType === "ETF")
    && (ref.currency === undefined || ref.currency === "USD")
    && (row.currency === undefined || row.currency === "USD");
  return {
    valid: identityOK && positive(q.lastPrice) && validTime(q.tradeTime, now),
    price: positive(q.lastPrice) ? q.lastPrice : null,
    tradeTime: validTime(q.tradeTime, now) ? q.tradeTime : null,
    quoteTime: validTime(q.quoteTime, now) ? q.quoteTime : null,
    realtime: row.realtime === true,
    volume: identityOK && finite(q.totalVolume) && q.totalVolume >= 0 ? q.totalVolume : null,
    identityOK,
  };
}

type Candle = BriefBar;
function readHistory(raw: unknown, symbol: string, now: number): { bars: Candle[]; invalid: boolean } {
  const r = object(raw);
  if (r.synthetic === true || r.symbol !== symbol || !Array.isArray(r.candles) || r.candles.length > 100) return { bars: [], invalid: true };
  const bars: Candle[] = [];
  const seen = new Set<string>();
  for (const value of r.candles) {
    const b = object(value);
    if (b.synthetic === true || !validTime(b.datetime, now) || !positive(b.open) || !positive(b.high)
      || !positive(b.low) || !positive(b.close) || b.high < b.low
      || b.open < b.low || b.open > b.high || b.close < b.low || b.close > b.high) {
      return { bars: [], invalid: true };
    }
    const date = etDate(b.datetime);
    if (seen.has(date)) return { bars: [], invalid: true };
    seen.add(date);
    bars.push({ datetime: b.datetime, open: b.open, high: b.high, low: b.low, close: b.close, date,
      volume: finite(b.volume) && b.volume >= 0 ? b.volume : null });
  }
  return { bars: bars.sort((a, b) => a.datetime - b.datetime), invalid: false };
}

/** Conservative calendar policy: never infer holiday sessions or treat an incomplete week as complete. */
function requiredDates(horizon: TradeBriefHorizon, today: string): string[] {
  if (horizon === "intraday") {
    let prior = shiftDate(today, -1);
    while ([0, 6].includes(weekday(prior))) prior = shiftDate(prior, -1);
    return [prior];
  }
  const monday = shiftDate(today, -((weekday(today) + 6) % 7) - 7);
  return Array.from({ length: 5 }, (_, i) => shiftDate(monday, i));
}

/** Pure builder: all output numbers come from validated observations or the existing pivot calculator. */
export function buildStockTradeBrief(
  instrument: TradeBriefInstrument, horizon: TradeBriefHorizon,
  inputs: { quote: LoadResult; history: LoadResult; macro: LoadResult; options?: LoadResult;
    news?: unknown; earnings?: unknown }, now: number,
): TradeBrief {
  const statuses = Object.fromEntries(TRADE_BRIEF_CATEGORIES.map(c => [c, moduleStatus(c, now)])) as Record<TradeBriefCategory, TradeBriefSourceStatus>;
  const observations: TradeBriefEvidence[] = [];
  const levels: TradeBriefLevel[] = [];
  // A resolved null is provider unavailability, not a healthy missing-field payload.
  inputs = { ...inputs,
    quote: inputs.quote.state === "ok" && inputs.quote.value == null ? { state: "unavailable", value: null } : inputs.quote,
    history: inputs.history.state === "ok" && inputs.history.value == null ? { state: "unavailable", value: null } : inputs.history,
    macro: inputs.macro.state === "ok" && inputs.macro.value == null ? { state: "unavailable", value: null } : inputs.macro };
  const q = readQuote(inputs.quote.value, instrument, now);
  const quoteAge = horizon === "intraday" ? 60 : 300;
  statuses.quote.max_age_seconds = quoteAge;
  statuses.volume.max_age_seconds = quoteAge;
  let usableQuote = false;
  if (inputs.quote.state !== "ok") {
    statuses.quote.status = "unavailable";
    statuses.quote.reason = errorReason(inputs.quote);
  } else if (!q.valid) {
    statuses.quote.status = "missing";
    statuses.quote.reason = "Exact listing, USD price, real trade timestamp or valid price is missing; retrieval time is not a market observation.";
  } else {
    const stale = now - q.tradeTime! >= quoteAge * SECOND;
    statuses.quote.status = stale ? "stale" : q.realtime ? "available" : "delayed";
    statuses.quote.reason = stale ? "Last trade exceeds this horizon's age limit; current price and dependent levels are withheld."
      : q.realtime ? "Provider explicitly marks the quote real time; freshness uses last-trade time, not fetch time."
      : "Real-time entitlement is false or unknown; delayed/unknown-lag observation is not a live quote.";
    statuses.quote.observed_at = iso(q.tradeTime!);
    statuses.quote.evidence_ids = ["quote-last"];
    usableQuote = statuses.quote.status === "available";
    statuses.quote.contributed = usableQuote;
    observations.push(evidence("quote-last", "quote", "Last observed trade", q.price!, "USD/share",
      iso(q.tradeTime!), statuses.quote.status));
  }
  if (q.identityOK && q.volume !== null && q.quoteTime !== null) {
    const stale = now - q.quoteTime >= quoteAge * SECOND;
    const state = stale ? "stale" : q.realtime ? "partial" : "delayed";
    statuses.volume.status = state;
    statuses.volume.reason = "Cumulative provider volume only; zero is preserved when observed. No time-of-day-normalized relative volume, auction or buyer/seller inference.";
    statuses.volume.observed_at = iso(q.quoteTime);
    statuses.volume.evidence_ids = ["quote-volume"];
    statuses.volume.contributed = state === "partial";
    observations.push(evidence("quote-volume", "volume", "Cumulative reported volume", q.volume, "shares",
      iso(q.quoteTime), state));
  } else {
    statuses.volume.status = inputs.quote.state === "ok" ? "missing" : "unavailable";
    statuses.volume.reason = "No timestamped cumulative volume observation. Missing collection is not zero activity.";
  }

  const history = readHistory(inputs.history.value, instrument.symbol, now);
  const dates = requiredDates(horizon, etDate(now));
  const period = horizon === "intraday" ? `Prior weekday ${dates[0]}` : `Prior week ${dates[0]} through ${dates[4]}`;
  const bars = dates.map(d => history.bars.find(b => b.date === d));
  if (inputs.history.state !== "ok") {
    statuses.levels.status = "unavailable";
    statuses.levels.reason = errorReason(inputs.history);
  } else if (history.invalid || history.bars.length === 0) {
    statuses.levels.status = "missing";
    statuses.levels.reason = "Daily OHLC is missing or fails listing, timestamp, duplicate-session or price-order validation.";
  } else if (bars.some(b => !b)) {
    statuses.levels.status = "stale";
    statuses.levels.reason = `${period} is incomplete. No holiday calendar is verified; older sessions and incomplete weeks are not silently substituted.`;
  } else if (!usableQuote) {
    statuses.levels.status = "unavailable";
    statuses.levels.reason = "Current usable quote is a mandatory dependency; stale/delayed price cannot produce current structural context.";
  } else {
    const complete = bars as Candle[];
    const ohlc = {
      t: Math.floor(complete[complete.length - 1].datetime / SECOND), o: complete[0].open,
      h: Math.max(...complete.map(b => b.high)), l: Math.min(...complete.map(b => b.low)),
      c: complete[complete.length - 1].close,
    };
    const p = classicPivots(ohlc);
    if (ohlc.h <= ohlc.l || ![p.s1, p.pp, p.r1].every(positive) || !(p.s1 < p.pp && p.pp < p.r1)) {
      statuses.levels.status = "missing";
      statuses.levels.reason = "Degenerate or non-finite structural range; no levels or risk distances can be used.";
    } else {
      const observed = dates[dates.length - 1];
      for (const [field, label] of [["h", "Period high"], ["l", "Period low"], ["c", "Period close"]] as const) {
        observations.push(evidence(`period-${field}`, "levels", `${label} · ${period}`, ohlc[field],
          "USD/share", observed, "partial", "Schwab daily history", SCHWAB_URL, "period"));
      }
      for (const [kind, label, value, formula] of [
        ["support", "Classic S1", p.s1, "S1=2*PP-H"],
        ["pivot", "Classic pivot", p.pp, "PP=(H+L+C)/3"],
        ["resistance", "Classic R1", p.r1, "R1=2*PP-L"],
      ] as const) levels.push({
        kind, label, value, unit: "USD/share", formula_id: `${TRADE_BRIEF_VERSION}:classic:${formula}`,
        evidence_ids: ["period-h", "period-l", "period-c"], period, purpose: "structure_reference_only",
      });
      statuses.levels.status = "partial";
      statuses.levels.contributed = true;
      statuses.levels.reason = "Classical reference structure only, not an entry, stop or target. Corporate-action adjustment, exchange holiday coverage, intraday VWAP and executable costs are unverified.";
      statuses.levels.observed_at = observed;
      statuses.levels.evidence_ids = ["period-h", "period-l", "period-c"];
    }
  }

  statuses.news.reason = "Excluded: the existing aggregate mixes general-market headlines with inferred ticker mentions and has no verified per-ticker source-health contract. No news is not a claim of no catalysts.";
  statuses.options.reason = "Excluded: existing chains may be delayed, and OI age, bid/ask quality and reviewed Greek units are not verified in this slice. Options activity is not directional intent.";
  if (instrument.asset_class === "ETF") {
    statuses.earnings.applicability = "not_applicable";
    statuses.earnings.status = "not_applicable";
    statuses.earnings.reason = "Corporate earnings do not apply to the fund itself. Holdings' earnings, fund distributions and rebalancing events are unverified; no company earnings date is assigned.";
  } else {
    statuses.earnings.status = "unavailable";
    statuses.earnings.reason = "Next earnings date and timing are unverified. Existing calendar can inject synthetic dates without per-row provenance, so none are reused.";
  }
  statuses.seasonality.reason = "No validated asset-specific seasonal sample/window is available here. Index history and unreviewed probabilities are not transferred to this listing.";

  const macroDefinitions = [
    ["DGS2", "Treasury yield", "percent"], ["DGS10", "Treasury yield", "percent"],
    ["BAMLH0A0HYM2", "High-yield option-adjusted spread", "percentage points"],
    ["DTWEXBGS", "Trade-weighted dollar", "index"],
  ] as const;
  const macroRows = Array.isArray(inputs.macro.value) ? inputs.macro.value.slice(0, 30) : [];
  for (const [id, label, unit] of macroDefinitions) {
    const row = object(macroRows.find(r => object(r).seriesId === id));
    const date = row.latestDate;
    if (!finite(row.latest) || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || timestamp > now || iso(timestamp).slice(0, 10) !== date) continue;
    const state = now - timestamp >= 7 * DAY ? "stale" : "partial";
    observations.push(evidence(`macro-${id}`, "macro", `${id} · ${label}`, row.latest, unit, date,
      state, "FRED cached daily observation", `https://fred.stlouisfed.org/series/${id}`, "date"));
  }
  const macroEvidence = observations.filter(e => e.category === "macro");
  statuses.macro.evidence_ids = macroEvidence.map(e => e.id);
  statuses.macro.observed_at = macroEvidence.map(e => e.observed_at).sort()[0] ?? null;
  statuses.macro.contributed = macroEvidence.some(e => e.status === "partial");
  statuses.macro.status = inputs.macro.state !== "ok" ? "unavailable"
    : macroEvidence.length === 0 ? "missing" : statuses.macro.contributed ? "partial" : "stale";
  statuses.macro.reason = "Cached daily rates, credit and dollar context only, with individual observation dates; not live macro or a ticker signal. Real yields, sector breadth and a verified economic calendar are not covered. No refresh job is started.";

  const enrichment = enrichStockBrief({
    instrument, now, today: etDate(now), quoteAge, usableQuote, price: q.price, priceTime: q.tradeTime,
    quoteTime: q.quoteTime, volume: q.volume, bars: history.bars,
    requiredPriorDate: requiredDates("intraday", etDate(now))[0],
    news: inputs.news, earnings: inputs.earnings, options: inputs.options?.value,
    optionsState: inputs.options?.state, statuses, observations, levels,
  });
  const pivot = levels.find(l => l.kind === "pivot");
  const relation = usableQuote && pivot ? (q.price! > pivot.value ? "above" : q.price! < pivot.value ? "below" : "at") : null;
  const structuralThesis = relation
    ? `The last verified trade is ${relation} the ${horizon === "swing" ? "prior-week" : "prior-session"} classic pivot. That is structural context, not a validated trading edge.`
    : usableQuote ? "A recent price observation is available, but compatible structural history is not sufficient for a conditional plan."
    : "A usable, explicitly real-time price is missing for this horizon. Wait for verified data rather than substitute a stale or delayed observation.";
  const thesis = structuralThesis + (enrichment.claims.length ? ` ${enrichment.claims.map(c => c.text).join(" ")}` : "");
  const earningsContext = enrichment.contexts.find(c => c.category === "earnings");
  const eventRisk = instrument.asset_class === "STOCK"
    ? earningsContext ? `${earningsContext.text} An event gap can overwhelm reference structure; do not infer a safe event window.`
      : "Earnings date and timing are unknown; an event gap can overwhelm a technically attractive level."
    : "Fund distributions, rebalances and underlying holdings' event exposure are unknown; ETF classification does not remove event risk.";
  const statusesArray = TRADE_BRIEF_CATEGORIES.map(c => statuses[c]);
  const prerequisites = [
    ...(!usableQuote ? ["Obtain an exact-listing real-time quote within this horizon's age limit."] : []),
    ...(!levels.length ? ["Obtain complete, validated daily history for the selected horizon."] : []),
    "Verify issuer/fund events, corporate actions, exchange session and halt status.",
    "Review a horizon-compatible entry/invalidation rule and actual execution costs before calculating risk.",
  ];
  // The snapshot expires at the earliest consumed instant-data threshold, never at a restamped fetch time.
  const deadlines = [now + SNAPSHOT_TTL, ...enrichment.deadlines];
  if (usableQuote) deadlines.push(q.tradeTime! + quoteAge * SECOND);
  if (statuses.volume.contributed) deadlines.push(q.quoteTime! + quoteAge * SECOND);
  for (const e of macroEvidence) {
    if (e.status === "partial") deadlines.push(Date.parse(e.observed_at) + 7 * DAY);
  }
  // A source-period change must not reuse yesterday's / last week's computed context.
  deadlines.push(etEpochMs(shiftDate(etDate(now), 1), 0, 0));
  const observedTimes = [...observations, ...enrichment.contexts].map(e => Date.parse(e.observed_at)).filter(Number.isFinite);
  const result = {
    instrument_id: instrument.id, instrument, horizon, mode: "research_only" as const,
    created_at: iso(now), expires_at: iso(Math.min(...deadlines)),
    observed_at_range: {
      oldest: observedTimes.length ? iso(Math.min(...observedTimes)) : null,
      newest: observedTimes.length ? iso(Math.max(...observedTimes)) : null,
    },
    session: { label: clockSession(now), calendar_verified: false as const },
    coverage: usableQuote ? "partial" as const : "insufficient" as const, source_statuses: statusesArray,
    coverage_gaps: statusesArray.filter(s => s.status !== "available").map(s => `${s.category}: ${s.reason}`),
    verdict: usableQuote ? "WATCH" as const : "INSUFFICIENT DATA" as const,
    thesis, counterevidence: [eventRisk,
      "Cumulative/full-day volume comparison is not time-of-day RVOL, directional flow or a validated trading edge.",
      statuses.news.contributed ? "Collected attributed headlines are non-exhaustive and do not prove materiality." : "Ticker-specific news collection is missing or unverified; absence of collected items is not absence of catalysts.",
      statuses.options.contributed ? "Sampled options quotes/volume do not establish dealer positioning, buyer intent or execution quality." : "Fresh reviewed options evidence is unavailable.",
      "Corporate-action adjustments, exchange sessions/halts and executable costs remain unverified."],
    prerequisites,
    quote: usableQuote ? { value: q.price!, unit: "USD/share" as const, observed_at: iso(q.tradeTime!),
      evidence_id: "quote-last", source: "Schwab" as const } : null,
    levels,
    risk: { basis: "withheld" as const, planned_loss: null, scenario_reward_risk: null,
      assumptions: ["USD-listed cash stock/ETF research only; no paper budget or account equity assumed."],
      limitations: ["No reviewed entry/stop/target or round-trip costs, so per-unit planned loss and net scenario reward/risk are withheld.",
        "A stop is not a guaranteed fill or maximum loss; gaps, halts and illiquidity can exceed it. No options P&L, short/borrow assumption or sizing."] },
    trigger: levels.length
      ? "Wait for a fresh price comparison at the displayed structure, then verify event, liquidity and execution prerequisites. Crossing a reference alone is not an entry."
      : "Wait for usable quote and compatible completed-period history. No entry trigger, stop or target is available.",
    events: [{ text: eventRisk, evidence_ids: earningsContext ? [earningsContext.id] : [] }],
    management_rules: [
      "Remain in research/WATCH mode. Do not treat reference support or resistance as orders.",
      "Re-analyze manually after new information or a material price change; there is no background market monitoring.",
      "No trim/exit schedule is proposed without a validated position-independent plan.",
    ],
    invalidation_rules: [
      "Expiry or required-source staleness invalidates this snapshot; previous levels must not be paired with a new quote.",
      "Changing instrument or horizon supersedes the previous brief.",
      "A corporate action, material event or crossing of reference structure requires a new review; this brief does not monitor crossings.",
    ],
    claims: [{ text: structuralThesis, evidence_ids: relation ? ["quote-last", ...pivot!.evidence_ids] : usableQuote ? ["quote-last"] : [] },
      ...enrichment.claims],
    evidence: observations,
    context_items: enrichment.contexts,
    methodology: [
      "Intraday: prior weekday's completed daily OHLC. Swing: aggregate every weekday of the previous Monday–Friday week (high=max highs; low=min lows; close=Friday close). Missing weekdays suppress structure, including holiday weeks.",
      "Reuse server/pivots.ts classicPivots: PP=(H+L+C)/3; S1=2*PP-H; R1=2*PP-L. Retain full calculation precision; display rounded prices only.",
      "Intraday last-trade/volume maximum age is one minute; swing is five minutes. Quotes without explicit real-time entitlement never become current price. No CBOE fallback is used until its true cache-age contract is verified.",
      "FRED observations use their published date at daily precision, not a fabricated release time. Daily macro context expires after seven calendar days and never supplies trade levels.",
      "Exchange holidays, early closes, adjusted-price provenance and halt status are unverified. Clock windows are not assertions that the exchange is open.",
      ...enrichment.methodology,
      "Enrichment uses only validated, observed prior daily bars; ATR and volume baselines are conservatively suppressed when a weekday is absent because exchange holiday completeness is unverified.",
      "Options uses only raw Schwab chains with exact identity, explicit non-delayed status, fresh underlying/contract times and valid standard bid/ask. Sampled counts/volume are descriptive; no OI timestamp, GEX, walls or intent is invented.",
      "News and earnings reuse existing local snapshots only; no per-Analyze aggregate RSS/calendar fanout. Explicit text attribution is not issuer-confirmed materiality.",
    ],
    explanation: { status: "deterministic" as const, detail: "Calculated from validated evidence and coverage rules without a model call. Optional AI curation is a separate, explicit request; it can only prioritize approved findings and cannot generate numbers or upgrade the verdict." },
    model_version: "none" as const, calculation_version: TRADE_BRIEF_VERSION,
  };
  const hash = createHash("sha256").update(JSON.stringify(result)).digest("hex").slice(0, 24);
  return TradeBriefSchema.parse({ ...result, brief_id: `brief-${hash}`, snapshot_id: `snapshot-${hash}` });
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

/**
 * Lazy imports avoid initializing DB/providers during schema tests.
 * No accounts, token values, exception messages, arbitrary URLs, or raw provider payloads are returned.
 */
const defaultDependencies: TradeBriefDependencies = {
  async quote(symbol) {
    const { schwabFetch } = await import("./schwab");
    return schwabFetch("marketdata/v1/quotes", { symbols: symbol, fields: "quote,reference" });
  },
  async history(symbol) {
    const { schwabFetch } = await import("./schwab");
    return schwabFetch("marketdata/v1/pricehistory", {
      symbol, periodType: "month", period: 3, frequencyType: "daily", frequency: 1,
      needExtendedHoursData: "false",
    });
  },
  async macro() {
    const { getFredSnapshot } = await import("./fredClient");
    return getFredSnapshot();
  },
  async options(symbol) {
    const { schwabFetch } = await import("./schwab");
    const today = new Date(), to = new Date(today.getTime() + 45 * DAY);
    return schwabFetch("marketdata/v1/chains", {
      symbol, contractType: "ALL", strikeCount: 20, includeUnderlyingQuote: "true",
      fromDate: today.toISOString().slice(0, 10), toDate: to.toISOString().slice(0, 10),
    });
  },
  async news() {
    const { getCachedNewsSnapshot } = await import("./news");
    return getCachedNewsSnapshot();
  },
  async earnings() {
    const { getCachedEarningsSnapshot } = await import("./earnings");
    return getCachedEarningsSnapshot();
  },
};

export function createTradeBriefService(deps: TradeBriefDependencies = defaultDependencies) {
  const now = deps.now ?? Date.now;
  const timeoutMs = Math.min(8_000, Math.max(1, deps.timeoutMs ?? 8_000));
  // Bounded by the finite registry (two horizons each); no user-controlled arbitrary cache keys.
  const cache = new Map<string, TradeBrief>();
  const pending = new Map<string, Promise<TradeBrief>>();
  const reads = new Map<string, Promise<LoadResult>>();
  const recentReads = new Map<string, { expires: number; result: LoadResult }>();
  let activeReads = 0;

  async function load(key: string, read: () => Promise<unknown>): Promise<LoadResult> {
    const recent = recentReads.get(key);
    if (recent && now() < recent.expires) return recent.result;
    let underlying = reads.get(key);
    if (!underlying) {
      if (activeReads >= MAX_IN_FLIGHT) return { state: "busy", value: null };
      activeReads++;
      underlying = Promise.resolve().then(read)
        .then(value => value == null ? { state: "unavailable", value: null } as LoadResult : { state: "ok", value } as LoadResult)
        .catch(() => ({ state: "unavailable", value: null } as LoadResult));
      reads.set(key, underlying);
      // Keep the slot until the existing provider helper actually settles, even after a response timeout.
      // schwabFetch does not accept AbortSignal; do NOT spawn replacements on repeated timeouts.
      void underlying.then(result => {
        recentReads.set(key, { expires: now() + SNAPSHOT_TTL, result });
        reads.delete(key);
        activeReads--;
      });
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ state: "timeout", value: null }), timeoutMs);
      void underlying!.then(value => { clearTimeout(timer); resolve(value); });
    });
  }

  async function analyze(instrumentId: string, horizon: TradeBriefHorizon): Promise<TradeBrief> {
    const instrument = TRADE_BRIEF_INSTRUMENTS.find(i => i.id === instrumentId);
    if (!instrument || !["swing", "intraday"].includes(horizon)) throw new Error("unsupported_instrument_or_horizon");
    const key = `${instrumentId}|${horizon}|${TRADE_BRIEF_VERSION}`;
    const hit = cache.get(key);
    if (hit && now() < Date.parse(hit.expires_at)) return hit;
    const work = pending.get(key);
    if (work) return work;
    const promise = (async () => {
      // Cache-only readers are normally synchronous. Bound even injected readers so they
      // cannot extend the endpoint deadline or trigger retry/replacement loops.
      const cached = (read?: () => Promise<unknown>) => !read ? Promise.resolve(null)
        : new Promise<unknown>(resolve => {
          const timer = setTimeout(() => resolve(null), timeoutMs);
          void Promise.resolve().then(read).catch(() => null).then(value => {
            clearTimeout(timer); resolve(value);
          });
        });
      const [quote, history, macro, options, news, earnings] = await Promise.all([
        load(`quote:${instrument.symbol}`, () => deps.quote(instrument.symbol)),
        load(`history:${instrument.symbol}`, () => deps.history(instrument.symbol)),
        load("macro", deps.macro),
        deps.options ? load(`options:${instrument.symbol}`, () => deps.options!(instrument.symbol))
          : Promise.resolve({ state: "unavailable", value: null } as LoadResult),
        cached(deps.news), cached(deps.earnings),
      ]);
      const brief = freezeDeep(buildStockTradeBrief(instrument, horizon, { quote, history, macro, options, news, earnings }, now()));
      cache.set(key, brief);
      return brief;
    })();
    pending.set(key, promise);
    try { return await promise; } finally { pending.delete(key); }
  }
  /** Existing immutable snapshots only: no reads, refresh, retries or provider spending. */
  function getSnapshot(snapshotId: string): TradeBrief | null {
    for (const snapshot of cache.values()) {
      if (snapshot.snapshot_id === snapshotId && now() < Date.parse(snapshot.expires_at)) return snapshot;
    }
    return null;
  }
  return { analyze, getSnapshot };
}
export type TradeBriefService = ReturnType<typeof createTradeBriefService>;

/** Register inside the existing restricted web API boundary; this is not new authentication. */
export function registerTradeBriefRoutes(app: Express, service: Pick<TradeBriefService, "analyze"> = createTradeBriefService()): void {
  let windowAt = Date.now(), searchCount = 0, briefCount = 0;
  function budget(kind: "search" | "brief", res: Response) {
    const now = Date.now();
    if (now - windowAt >= 60_000) { windowAt = now; searchCount = 0; briefCount = 0; }
    const count = kind === "search" ? ++searchCount : ++briefCount;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (count <= (kind === "search" ? 120 : 30)) return true;
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((60_000 - (now - windowAt)) / 1_000))));
    res.status(429).json({ error: "trade_brief_rate_limited", message: "Research request budget reached. Retry manually later." });
    return false;
  }
  app.get("/api/trade-brief/search", (req: Request, res: Response) => {
    if (!budget("search", res)) return;
    const request = SearchRequestSchema.safeParse(req.query);
    if (!request.success) { res.status(400).json({ error: "invalid_search" }); return; }
    res.json(searchTradeBriefInstruments(request.data.q));
  });
  app.get("/api/trade-brief", async (req: Request, res: Response) => {
    if (!budget("brief", res)) return;
    const request = BriefRequestSchema.safeParse(req.query);
    if (!request.success) { res.status(400).json({ error: "invalid_brief_request" }); return; }
    if (!TRADE_BRIEF_INSTRUMENTS.some(i => i.id === request.data.instrument_id)) {
      res.status(404).json({ error: "unsupported_instrument", message: "Select an exact instrument from the curated lookup." }); return;
    }
    try {
      res.json(await service.analyze(request.data.instrument_id, request.data.horizon));
    } catch {
      res.status(503).json({ error: "trade_brief_unavailable", message: "Brief unavailable. No substitute values generated." });
    }
  });
}
