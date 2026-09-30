import type { Request, Response } from "express";
import { etEpochMs } from "./etTime";
import {
  SPY_PROJECTION_GUARD_VERSION, SpyProjectionResponseSchema,
  type SpyProjectionResponse, type VerifiedSpyCandle,
} from "../shared/spyProjection";

const MINUTE = 60_000, BAR = 5 * MINUTE, TTL = 30_000;
const asObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const iso = (t: number) => new Date(t).toISOString();
const time = (v: unknown, now: number): v is number => finite(v) && v > 946684800000 && v <= now;
function nyDate(now: number): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(k => p.find(v => v.type === k)!.value).join("-");
}
function emptyTape(status: SpyProjectionResponse["tape"]["status"], reason: string): SpyProjectionResponse["tape"] {
  return { status, reason, source: "Schwab", observedAt: null, lastTradeAt: null,
    lastTrade: null, candles: [], sessionCalendarVerified: false };
}

/** Read only exact SPY provider fields. Nothing uses snapshot spot, SPX/10, GBM, or inferred prior close. */
export function assessSpyTape(rawQuote: unknown, rawHistory: unknown, now: number): SpyProjectionResponse["tape"] {
  const date = nyDate(now), day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const open = etEpochMs(date, 9, 30), close = etEpochMs(date, 16, 0);
  if ([0, 6].includes(day) || now < open || now >= close) {
    return emptyTape("outside_session", "Outside the weekday regular-hours clock window. Holidays, early closes and halt status remain unverified.");
  }
  const row = asObject(asObject(rawQuote).SPY), q = asObject(row.quote), ref = asObject(row.reference);
  if (row.symbol !== "SPY" || !["EQUITY", "ETF"].includes(String(row.assetMainType))
    || (ref.currency !== undefined && ref.currency !== "USD") || (row.currency !== undefined && row.currency !== "USD")
    || row.synthetic === true || row.realtime !== true || !positive(q.lastPrice) || !time(q.tradeTime, now)) {
    return emptyTape("missing", "An exact SPY real-time USD quote with a valid last-trade timestamp is required. Unknown/delayed entitlement is not live data.");
  }
  if (now - q.tradeTime >= MINUTE) return emptyTape("stale", "SPY last trade is older than the one-minute quote freshness limit.");
  const raw = asObject(rawHistory);
  if (raw.synthetic === true || raw.symbol !== "SPY" || !Array.isArray(raw.candles) || raw.candles.length > 400) {
    return emptyTape("missing", "Exact-symbol SPY five-minute history is missing. No synthetic candles or snapshot fallback are permitted.");
  }
  const candles: VerifiedSpyCandle[] = [];
  const seen = new Set<number>();
  for (const value of raw.candles) {
    const c = asObject(value);
    if (c.synthetic === true || !time(c.datetime, now) || !positive(c.open) || !positive(c.high)
      || !positive(c.low) || !positive(c.close) || c.high < Math.max(c.open, c.close)
      || c.low > Math.min(c.open, c.close) || c.high < c.low
      || (c.volume !== null && c.volume !== undefined && (!finite(c.volume) || c.volume < 0))) {
      return emptyTape("invalid", "History failed non-synthetic, finite-price, timestamp or OHLC/volume validation. The whole tape is withheld.");
    }
    // Prior dates / extended hours never masquerade as today's regular session.
    if (c.datetime < open || c.datetime >= close) continue;
    if ((c.datetime - open) % BAR !== 0 || seen.has(c.datetime)) {
      return emptyTape("invalid", "Duplicate or off-grid five-minute bar timestamp; tape alignment is not safe.");
    }
    seen.add(c.datetime);
    if (c.datetime + BAR > now) continue; // do not anchor on a currently forming candle
    candles.push({ t: c.datetime / 1000, o: c.open, h: c.high, l: c.low, c: c.close,
      v: finite(c.volume) ? c.volume : null });
  }
  candles.sort((a, b) => a.t - b.t);
  if (candles.length < 3) return emptyTape("missing", "Need at least three real, completed five-minute SPY bars from today's session; no forecast is generated during warmup.");
  const expectedLastOpen = open + (Math.floor((now - open) / BAR) - 1) * BAR;
  if (candles[candles.length - 1].t * 1000 !== expectedLastOpen) {
    return emptyTape("stale", "Latest completed SPY five-minute interval is missing or stale. Provider fetch time cannot refresh old bars.");
  }
  if (candles[0].t * 1000 !== open || candles.some((c, i) => i > 0 && (c.t - candles[i - 1].t) * 1000 !== BAR)) {
    return emptyTape("invalid", "Today's regular-session tape contains missing intervals. Do not interpolate missing candles or blend misaligned features.");
  }
  return {
    status: "available", reason: "Real same-day completed SPY bars and a recent explicitly real-time quote passed the bounded checks. Observations only, not a forecast; exchange calendar and halt status are unverified.",
    source: "Schwab", observedAt: iso(expectedLastOpen + BAR), lastTradeAt: iso(q.tradeTime),
    lastTrade: q.lastPrice, candles, sessionCalendarVerified: false,
  };
}

export function buildSpyProjectionResponse(quote: unknown, history: unknown, now: number, failed = false): SpyProjectionResponse {
  const tape = failed ? emptyTape("unavailable", "Bounded provider read unavailable or timed out. No substitute tape, price, levels or directional verdict.")
    : assessSpyTape(quote, history, now);
  return SpyProjectionResponseSchema.parse({
    ok: true, version: SPY_PROJECTION_GUARD_VERSION, symbol: "SPY", currency: "USD", synthetic: false,
    asOf: iso(now), expiresAt: iso(tape.lastTradeAt ? Math.min(now + TTL, Date.parse(tape.lastTradeAt) + MINUTE) : now + TTL),
    status: "UNAVAILABLE", projection: { status: "UNAVAILABLE", bands: null }, levels: null, tape,
    blockers: [
      "Forecast disabled: the existing path combines SPX feature inputs with SPY candles and SPY morning features without a verified instrument/unit contract.",
      "Existing quantile training includes simulated intraday paths and synthetic dealer levels. TRAINED status and a narrow band do not establish predictive accuracy or confidence on real SPY.",
      "Dealer levels withheld: the old path divides mixed computed/user-target levels by a fixed factor without verified native-SPY chain provenance, event scope or observation age.",
    ],
    requirements: [
      "Real, correctly aligned SPY bars, quote timestamps, verified exchange session and a true prior-session close.",
      "A versioned SPY-compatible feature contract with training/inference unit and time-window parity, including volatility, ATR and morning-bar counts.",
      "Native-SPY fresh options/level inputs with chain timestamps, expiry and source provenance; do not infer SPY levels from fixed SPX scaling.",
      "Forward/out-of-sample evaluation on real observations, quantile coverage and baseline comparisons before restoring a directional path or confidence language.",
    ],
    predictionValidation: "not_established",
  });
}

export interface SpyProjectionDependencies {
  read: () => Promise<{ quote: unknown; history: unknown }>;
  now?: () => number;
  timeoutMs?: number;
}
const defaults: SpyProjectionDependencies = {
  async read() {
    const { schwabFetch } = await import("./schwab");
    const [quote, history] = await Promise.all([
      schwabFetch("marketdata/v1/quotes", { symbols: "SPY", fields: "quote,reference" }),
      schwabFetch("marketdata/v1/pricehistory", { symbol: "SPY", periodType: "day", period: 1,
        frequencyType: "minute", frequency: 5, needExtendedHoursData: "false",
        endDate: Math.floor(Date.now() / 20_000) * 20_000 }),
    ]);
    return { quote, history };
  },
};

export function createSpyProjectionService(deps: SpyProjectionDependencies = defaults) {
  const now = deps.now ?? Date.now;
  let cached: SpyProjectionResponse | null = null;
  let pending: Promise<SpyProjectionResponse> | null = null;
  let readPending: Promise<{ quote: unknown; history: unknown } | null> | null = null;
  async function get(): Promise<SpyProjectionResponse> {
    if (cached && now() < Date.parse(cached.expiresAt)) return cached;
    if (pending) return pending;
    if (!readPending) {
      const read = Promise.resolve().then(deps.read).catch(() => null);
      readPending = read;
      // Hold the provider slot after deadline; existing helper cannot be canceled.
      void read.then(() => { if (readPending === read) readPending = null; });
    }
    const read = readPending;
    pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([read, new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), Math.min(8_000, Math.max(1, deps.timeoutMs ?? 8_000)));
        })]);
        cached = buildSpyProjectionResponse(result?.quote, result?.history, now(), result === null);
        return cached;
      } finally { if (timer) clearTimeout(timer); }
    })();
    try { return await pending; } finally { pending = null; }
  }
  return { get };
}
const service = createSpyProjectionService();

/** Parent replaces the old inline /api/ml/projection-spy handler with this handler. */
export async function spyProjectionRoute(req: Request, res: Response): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (Object.keys(req.query).length) {
    res.status(400).json({ error: "spy_projection_accepts_no_query_parameters" });
    return;
  }
  try { res.json(await service.get()); }
  catch { res.status(503).json({ error: "spy_projection_unavailable" }); }
}
