import { z } from "zod";

/** Deliberately incompatible with the synthetic/SPX legacy model feature names. */
export const SPY_FEATURE_VERSION = "spy-real-1m-2026-09-30.1";
const MINUTE = 60_000;
export const SpyMinuteSchema = z.object({
  start: z.number().int().positive(), open: z.number().finite().positive(),
  high: z.number().finite().positive(), low: z.number().finite().positive(),
  close: z.number().finite().positive(), volume: z.number().finite().nonnegative().nullable(),
}).strict().refine(b => b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close) && b.high >= b.low);
export type SpyMinute = z.infer<typeof SpyMinuteSchema>;
export const SpySessionInputSchema = z.object({
  version: z.literal(SPY_FEATURE_VERSION), symbol: z.literal("SPY"), currency: z.literal("USD"),
  source: z.literal("Schwab"), synthetic: z.literal(false),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: z.number().int().positive(), close: z.number().int().positive(),
  receivedAt: z.number().int().positive(), asOf: z.number().int().positive(),
  priorClose: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), price: z.number().finite().positive(),
    sessionClose: z.number().int().positive(), source: z.literal("Schwab daily OHLC"),
  }).strict().nullable(),
  bars: z.array(SpyMinuteSchema).max(390),
}).strict();
export type SpySessionInput = z.infer<typeof SpySessionInputSchema>;
export const SPY_FEATURE_DEFINITIONS = [
  ["spy_close_usd", "SPY bar close", "USD/share", "Latest completed 1m bar"],
  ["prior_session_close_usd", "Prior-session close", "USD/share", "Dated daily OHLC; preceding provider-open session"],
  ["session_gap_fraction", "Opening gap", "fraction", "Session open / prior-session close - 1"],
  ["elapsed_session_minutes", "Completed session minutes", "minutes", "Feature cutoff minus verified regular open"],
  ["log_return_5m", "Five-minute log return", "log fraction", "ln(Ct / Ct-5); six consecutive closes"],
  ["log_return_30m", "Thirty-minute log return", "log fraction", "ln(Ct / Ct-30); 31 consecutive closes"],
  ["realized_vol_5m", "Five-minute realized volatility", "log fraction", "sqrt(sum of five squared 1m close-to-close log returns)); not annualized"],
  ["realized_vol_30m", "Thirty-minute realized volatility", "log fraction", "sqrt(sum of thirty squared 1m close-to-close log returns)); not annualized"],
  ["atr14_1m_usd", "14-bar one-minute ATR", "USD/share", "Arithmetic mean of 14 true ranges; 15 completed 1m bars; not Wilder/daily ATR"],
  ["session_hlc3_vwap_usd", "Bar-weighted VWAP proxy", "USD/share", "sum(HLC3 * volume) / sum(volume); all completed session bars; not trade VWAP"],
  ["morning_high_usd", "Opening 15m high", "USD/share", "Frozen first 15 completed 1m bars"],
  ["morning_low_usd", "Opening 15m low", "USD/share", "Frozen first 15 completed 1m bars"],
  ["morning_anchor_close_usd", "09:45 anchor close", "USD/share", "Close of the 09:44 bar; requires full first 15m"],
  ["morning_range_atr14", "Opening range / anchor ATR", "ratio", "First 15m range / ATR14 of first 15m; frozen denominator"],
  ["morning_drive_atr14", "Opening drive / anchor ATR", "ratio", "(09:45 anchor close - session open) / frozen anchor ATR14"],
  ["minutes_since_anchor", "Minutes since anchor", "minutes", "Completed cutoff minus open+15m; not five-minute bar count"],
  ["close_vs_anchor_atr14", "Close versus morning anchor", "ratio", "(Latest completed close - anchor close) / frozen anchor ATR14"],
] as const;
export type SpyFeatureKey = typeof SPY_FEATURE_DEFINITIONS[number][0];
const FeatureSchema = z.object({
  id: z.enum(SPY_FEATURE_DEFINITIONS.map(d => d[0]) as [SpyFeatureKey, ...SpyFeatureKey[]]),
  label: z.string(), unit: z.string(), definition: z.string(),
  value: z.number().finite().nullable(), reason: z.string().nullable(),
}).strict();
export const SpyFeaturesSchema = z.object({
  version: z.literal(SPY_FEATURE_VERSION), status: z.enum(["READY", "PARTIAL", "BLOCKED"]),
  asOf: z.number().int().positive().nullable(), sessionDate: z.string().nullable(),
  completedMinutes: z.number().int().nonnegative(), source: z.literal("Schwab"),
  inputHash: z.string().nullable(), archived: z.boolean(), archiveReason: z.string(),
  sessionVerified: z.boolean(), priorCloseDate: z.string().nullable(),
  values: z.array(FeatureSchema).max(SPY_FEATURE_DEFINITIONS.length), issues: z.array(z.string()),
  modelCompatibility: z.literal("NO_APPROVED_MODEL"),
}).strict().superRefine((f, ctx) => {
  if (f.status === "BLOCKED") {
    if (f.values.length || f.asOf !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Blocked features cannot carry values" });
    return;
  }
  const ids = new Set(f.values.map(v => v.id));
  if (ids.size !== SPY_FEATURE_DEFINITIONS.length || !f.sessionVerified || !f.asOf || !f.sessionDate)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Accepted feature set requires the complete versioned contract and session provenance" });
  if (f.status === "READY" && f.values.some(v => v.value === null))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "READY cannot contain missing features" });
});
export type SpyFeatures = z.infer<typeof SpyFeaturesSchema>;
export function blockedSpyFeatures(reason: string): SpyFeatures {
  return { version: SPY_FEATURE_VERSION, status: "BLOCKED", asOf: null, sessionDate: null,
    completedMinutes: 0, source: "Schwab", inputHash: null, archived: false,
    archiveReason: "No accepted feature input to archive", sessionVerified: false,
    priorCloseDate: null, values: [], issues: [reason], modelCompatibility: "NO_APPROVED_MODEL" };
}
export function spyNyDate(ms: number): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms);
  return ["year", "month", "day"].map(k => p.find(v => v.type === k)!.value).join("-");
}
export function shiftSpyDate(date: string, delta: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
}
function isRegularOpen(ms: number): boolean {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hour12: false }).format(ms) === "09:30:00";
}
const object = (x: any) => x && typeof x === "object" && !Array.isArray(x) ? x : {};
type Hours = { date: string; isOpen: boolean; open: number | null; close: number | null };
/** Exact provider-date/session contract; never infer a holiday from a missing response. */
export function parseSpyHours(raw: unknown, date: string): Hours | null {
  const r = object(object(object(raw).equity).EQ);
  if (r.date !== date || r.marketType !== "EQUITY" || r.product !== "EQ" || typeof r.isOpen !== "boolean") return null;
  const regular = object(r.sessionHours).regularMarket;
  if (!r.isOpen) return regular == null || Array.isArray(regular) && regular.length === 0
    ? { date, isOpen: false, open: null, close: null } : null;
  if (!Array.isArray(regular) || regular.length !== 1) return null;
  const { start, end } = object(regular[0]);
  if (![start, end].every(t => typeof t === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(t))) return null;
  const open = Date.parse(start), close = Date.parse(end);
  if (![open, close].every(Number.isFinite) || spyNyDate(open) !== date || spyNyDate(close - 1) !== date
    || !isRegularOpen(open) || close <= open || (close - open) % MINUTE !== 0 || close - open > 390 * MINUTE) return null;
  return { date, isOpen: true, open, close };
}
export interface SpyRawInputs {
  quote: unknown; minuteHistory: unknown; dailyHistory: unknown;
  hours: Record<string, unknown>; receivedAt: number;
}
export interface SpyNormalization {
  input: SpySessionInput | null; issues: string[];
  quote: { price: number; time: number } | null;
  outsideSession: boolean;
}
/** Pure normalization shared by runtime and fixture/replay checks. */
export function normalizeSpyInputs(raw: SpyRawInputs, now: number): SpyNormalization {
  const fail = (reason: string, outsideSession = false): SpyNormalization =>
    ({ input: null, quote: null, issues: [reason], outsideSession });
  const date = spyNyDate(now), session = parseSpyHours(raw.hours[date], date);
  if (!session) return fail("Provider session hours are missing, ambiguous or invalid for today's date.");
  if (!session.isOpen || now < session.open! || now >= session.close!) return fail("Outside the provider-declared regular session; no current feature snapshot.", true);
  if (!Number.isFinite(raw.receivedAt) || raw.receivedAt > now || now - raw.receivedAt > 60000)
    return fail("Input receipt is stale or in the future; it cannot refresh provider observation times.");
  const open = session.open!, close = session.close!;
  const quote = object(object(raw.quote).SPY), q = object(quote.quote), ref = object(quote.reference);
  if (quote.symbol !== "SPY" || !["EQUITY", "ETF"].includes(quote.assetMainType) ||
      quote.synthetic === true || q.synthetic === true || quote.realtime !== true ||
      (ref.currency !== undefined && ref.currency !== "USD") || (quote.currency !== undefined && quote.currency !== "USD") ||
      typeof q.lastPrice !== "number" || !Number.isFinite(q.lastPrice) || q.lastPrice <= 0 ||
      typeof q.tradeTime !== "number" || !Number.isFinite(q.tradeTime) || q.tradeTime > now ||
      q.tradeTime < open || now - q.tradeTime >= 60000)
    return fail("Exact SPY real-time quote with a positive price and last-trade age under 60 seconds is required.");
  const history = object(raw.minuteHistory);
  if (history.symbol !== "SPY" || history.synthetic === true || !Array.isArray(history.candles) || history.candles.length > 5000)
    return fail("Exact SPY one-minute OHLC is missing or exceeds the bounded history window.");
  const bars: SpyMinute[] = []; const seen = new Set<number>();
  const asOf = open + Math.floor((now - open) / MINUTE) * MINUTE;
  for (const item of history.candles) {
    const b = object(item);
    if (b.synthetic === true || typeof b.datetime !== "number" || !Number.isSafeInteger(b.datetime) || b.datetime > now)
      return fail("Synthetic, future or malformed minute-bar timestamp.");
    // Ignore prior/extended sessions, never transform them into today's input.
    if (b.datetime < open || b.datetime >= close) continue;
    if ((b.datetime - open) % MINUTE || seen.has(b.datetime)) return fail("Off-grid or duplicate SPY minute bar.");
    seen.add(b.datetime);
    const parsed = SpyMinuteSchema.safeParse({ start: b.datetime, open: b.open, high: b.high,
      low: b.low, close: b.close, volume: b.volume ?? null });
    if (!parsed.success) return fail("Invalid one-minute OHLC or volume; no zero imputation is permitted.");
    if (b.datetime + MINUTE <= asOf) bars.push(parsed.data); // forming candle excluded
  }
  bars.sort((a, b) => a.start - b.start);
  if (!bars.length) return fail("Warmup: no completed one-minute bar yet.");
  if (bars.length !== (asOf - open) / MINUTE || bars.some((b, i) => b.start !== open + i * MINUTE))
    return fail("Missing completed one-minute interval. No interpolation, forward fill or stale-bar restamping.");
  const issues: string[] = [];
  let prior: Hours | null = null;
  for (let back = 1; back <= 10; back++) {
    const d = shiftSpyDate(date, -back), h = parseSpyHours(raw.hours[d], d);
    if (!h) { issues.push(`Previous-session calendar cannot be established: ${d} is unverified.`); break; }
    if (h.isOpen) { prior = h; break; }
  }
  if (!prior && !issues.length) issues.push("No verified previous open session within ten calendar days.");
  let priorClose: SpySessionInput["priorClose"] = null;
  const daily = object(raw.dailyHistory);
  if (prior && daily.symbol === "SPY" && daily.synthetic !== true && Array.isArray(daily.candles) && daily.candles.length <= 100) {
    const matches = daily.candles.filter((x: any) => typeof x?.datetime === "number" && Number.isFinite(x.datetime) && spyNyDate(x.datetime) === prior!.date);
    if (matches.length === 1) {
      const b = matches[0], parsed = SpyMinuteSchema.safeParse({ start: b.datetime,
        open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? null });
      if (parsed.success && b.synthetic !== true && prior.close! < open && b.datetime <= prior.close!)
        priorClose = { date: prior.date, price: b.close, sessionClose: prior.close!, source: "Schwab daily OHLC" };
    }
  }
  if (!priorClose) issues.push("A validated daily close for the exact previous open session is unavailable. Gap remains null.");
  return { input: SpySessionInputSchema.parse({ version: SPY_FEATURE_VERSION, symbol: "SPY", currency: "USD",
    source: "Schwab", synthetic: false, date, open, close, receivedAt: raw.receivedAt, asOf, priorClose, bars }),
    quote: { price: q.lastPrice, time: q.tradeTime }, issues, outsideSession: false };
}

function atr14(bars: SpyMinute[]): number | null {
  if (bars.length < 15) return null;
  const w = bars.slice(-15);
  return w.slice(1).reduce((sum, b, i) => sum + Math.max(b.high - b.low,
    Math.abs(b.high - w[i].close), Math.abs(b.low - w[i].close)), 0) / 14;
}
/** Single numerical implementation for both live and replay. No wall clock, network or model. */
export function calculateSpyFeatures(raw: SpySessionInput, cutoff = raw.asOf): SpyFeatures {
  const check = SpySessionInputSchema.safeParse(raw);
  if (!check.success) return blockedSpyFeatures("Invalid or legacy feature-input contract.");
  const x = check.data;
  if (!Number.isSafeInteger(cutoff) || cutoff > x.asOf || cutoff > x.receivedAt || cutoff > x.close ||
    cutoff <= x.open || (cutoff - x.open) % MINUTE || spyNyDate(x.open) !== x.date || !isRegularOpen(x.open) ||
    spyNyDate(x.close - 1) !== x.date || x.close - x.open > 390 * MINUTE ||
    x.bars.some((b, i) => b.start !== x.open + i * MINUTE || b.start + MINUTE > x.asOf) ||
    x.bars.length !== (x.asOf - x.open) / MINUTE)
    return blockedSpyFeatures("Feature cutoff or complete-session bar alignment failed.");
  if (x.priorClose && (x.priorClose.date >= x.date || x.priorClose.sessionClose >= x.open ||
      spyNyDate(x.priorClose.sessionClose - 1) !== x.priorClose.date))
    return blockedSpyFeatures("Prior close must belong to a completed earlier provider session.");
  const bars = x.bars.filter(b => b.start + MINUTE <= cutoff), last = bars.at(-1)!;
  const returns = bars.slice(1).map((b, i) => Math.log(b.close / bars[i].close));
  const values = Object.fromEntries(SPY_FEATURE_DEFINITIONS.map(d => [d[0], null])) as Record<SpyFeatureKey, number | null>;
  values.spy_close_usd = last.close;
  values.prior_session_close_usd = x.priorClose?.price ?? null;
  values.session_gap_fraction = x.priorClose ? bars[0].open / x.priorClose.price - 1 : null;
  values.elapsed_session_minutes = bars.length;
  for (const n of [5, 30] as const) {
    if (returns.length >= n) {
      const r = returns.slice(-n);
      values[`log_return_${n}m`] = r.reduce((a, b) => a + b, 0);
      values[`realized_vol_${n}m`] = Math.sqrt(r.reduce((a, b) => a + b * b, 0));
    }
  }
  values.atr14_1m_usd = atr14(bars);
  if (bars.every(b => b.volume !== null)) {
    const volume = bars.reduce((s, b) => s + b.volume!, 0);
    if (volume > 0) values.session_hlc3_vwap_usd = bars.reduce((s, b) => s + (b.high + b.low + b.close) / 3 * b.volume!, 0) / volume;
  }
  if (bars.length >= 15) {
    const morning = bars.slice(0, 15), anchor = morning[14].close, denom = atr14(morning)!;
    values.morning_high_usd = Math.max(...morning.map(b => b.high));
    values.morning_low_usd = Math.min(...morning.map(b => b.low));
    values.morning_anchor_close_usd = anchor;
    values.minutes_since_anchor = bars.length - 15;
    if (denom > 0) {
      values.morning_range_atr14 = (values.morning_high_usd - values.morning_low_usd) / denom;
      values.morning_drive_atr14 = (anchor - morning[0].open) / denom;
      values.close_vs_anchor_atr14 = (last.close - anchor) / denom;
    }
  }
  const rows = SPY_FEATURE_DEFINITIONS.map(([id, label, unit, definition]) => ({
    id, label, unit, definition, value: values[id] != null && Number.isFinite(values[id]) ? values[id] : null,
    reason: values[id] != null && Number.isFinite(values[id]) ? null :
      id.includes("prior_session") || id === "session_gap_fraction" ? "Exact prior-session daily close is missing."
      : id.includes("vwap") ? "All bar volumes and a positive aggregate volume are required."
      : "Insufficient completed window or a zero normalization denominator; never imputed.",
  }));
  return { version: SPY_FEATURE_VERSION, status: rows.every(v => v.value !== null) ? "READY" : "PARTIAL",
    asOf: cutoff, sessionDate: x.date, completedMinutes: bars.length, source: "Schwab",
    inputHash: null, archived: false, archiveReason: "Pure calculation; not yet archived",
    sessionVerified: true, priorCloseDate: x.priorClose?.date ?? null, values: rows,
    issues: [], modelCompatibility: "NO_APPROVED_MODEL" };
}
/** Training/replay export uses the same core and cannot use bars beyond each row's cutoff. */
export function replaySpyFeatureRows(input: SpySessionInput): SpyFeatures[] {
  const check = calculateSpyFeatures(input);
  if (check.status === "BLOCKED") return [check];
  return input.bars.map(b => calculateSpyFeatures(input, b.start + MINUTE));
}
