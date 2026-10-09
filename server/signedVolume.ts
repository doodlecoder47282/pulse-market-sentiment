// server/signedVolume.ts
//
// Pure bar-level volume signing used by the Wire 13 "signed tick volume"
// read (server/leeReadyOfi.ts). No network, no DB.
//
// 1) Tick rule on bars (what the panel uses): each bar's whole volume takes
//    the sign of close[i] - close[i-1]; a zero change keeps the last non-zero
//    sign (zero-tick rule). Behavior is unchanged from the original inline
//    code in leeReadyOfi.ts; it was only moved here so it can be tested.
//
// 2) Bulk volume classification (BVC), Easley, Lopez de Prado & O'Hara
//    (2012), "Flow Toxicity and Liquidity in a High-frequency World", RFS
//    25(5), eq. (7): buy volume of bar i = V_i * Z(dP_i / sigma_dP), with Z
//    the standard normal CDF and sigma_dP the standard deviation of bar-to-bar
//    price changes. Computed alongside as a diagnostic only.
//    No look-ahead: sigma for bar i uses only the price changes BEFORE bar i
//    (expanding window over the bars passed in, at least BVC_MIN_PAST_CHANGES
//    of them); earlier bars are left unclassified. A bar with missing volume
//    is unclassified (its price change still feeds later sigmas); it is never
//    counted as zero volume.
//
// Why the panel uses the bar-level tick rule: continuity with the original
// Wire 13 read, not evidence. Published comparisons (e.g. Chakrabarty,
// Pascual & Shkilko 2015, J. Financial Markets) rank BVC against the
// TRADE-level tick rule and Lee-Ready, which need individual trade prints this
// app does not have; they do not show that a tick rule on 1-minute bars beats
// BVC. Neither read here is trade-level aggressor data.

export interface MinuteCandleLike {
  datetime: number;
  close: number;
  volume?: number | null;
}

export interface SignedTickBar {
  ts: number;
  close: number;
  volume: number;
  direction: 1 | -1 | 0;
  signedVolume: number;
  cumulative: number;
  /** True when the candle had no volume: the bar adds nothing and is not a 0-volume print. */
  volumeMissing?: boolean;
}

/** Tick rule on bars. Returns one bar per candle after the first. */
export function signedTickVolumeBars(candles: MinuteCandleLike[]): SignedTickBar[] {
  const bars: SignedTickBar[] = [];
  let lastDirection: 1 | -1 | 0 = 0;
  let cumulative = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    let direction: 1 | -1 | 0;
    if (c.close > prev.close) direction = 1;
    else if (c.close < prev.close) direction = -1;
    else direction = lastDirection; // zero-tick rule: persist last sign
    const volumeMissing = c.volume == null || !Number.isFinite(c.volume);
    const volume = volumeMissing ? 0 : (c.volume as number);
    const signedVolume = volume * direction;
    cumulative += signedVolume;
    bars.push({ ts: c.datetime, close: c.close, volume, direction, signedVolume, cumulative, ...(volumeMissing ? { volumeMissing: true } : {}) });
    if (direction !== 0) lastDirection = direction;
  }
  return bars;
}

/**
 * Standard normal CDF via erf, Abramowitz & Stegun 7.1.26
 * (|error| < 1.5e-7, ample for volume splitting).
 */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Minimum number of past price changes before a bar can be classified. */
export const BVC_MIN_PAST_CHANGES = 10;

export interface BvcResult {
  /**
   * Per bar from the second candle: buy fraction Z(dP / sigma_past), or null
   * when the bar is unclassified (too few past changes, sigma 0, or missing
   * volume).
   */
  buyFraction: (number | null)[];
  /** Sum over classified bars of V * (2 * buyFraction - 1); null when no bar was classified. */
  cumulativeSigned: number | null;
  /** sigma used for the LAST bar (past changes only); 0 when not yet estimable. */
  sigma: number;
  barsClassified: number;
  barsMissingVolume: number;
}

function finiteVolume(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Bulk volume classification over a session of bars (ELO 2012, eq. 7), no look-ahead. */
export function bulkVolumeClassify(candles: MinuteCandleLike[]): BvcResult {
  const buyFraction: (number | null)[] = [];
  let cumulativeSigned = 0;
  let barsClassified = 0;
  let barsMissingVolume = 0;
  // Running sums of past price changes (Welford's method for the variance).
  let n = 0;
  let mean = 0;
  let m2 = 0;
  let sigma = 0;
  for (let i = 1; i < candles.length; i++) {
    const dP = candles[i].close - candles[i - 1].close;
    sigma = n >= 2 ? Math.sqrt(m2 / (n - 1)) : 0;
    const vol = finiteVolume(candles[i].volume);
    if (vol == null) barsMissingVolume++;
    if (n >= BVC_MIN_PAST_CHANGES && sigma > 0 && vol != null && Number.isFinite(dP)) {
      const f = normalCdf(dP / sigma);
      buyFraction.push(f);
      cumulativeSigned += vol * (2 * f - 1);
      barsClassified++;
    } else {
      buyFraction.push(null);
    }
    // Only now add this bar's change, so it informs later bars only.
    if (Number.isFinite(dP)) {
      n++;
      const d = dP - mean;
      mean += d / n;
      m2 += d * (dP - mean);
    }
  }
  return {
    buyFraction,
    cumulativeSigned: barsClassified > 0 ? cumulativeSigned : null,
    sigma,
    barsClassified,
    barsMissingVolume,
  };
}

// ─── Trade-level signing on Schwab LEVELONE updates ─────────────────────────
//
// When the Schwab Streamer is live, every LEVELONE_EQUITIES update for SPY is
// kept (server/streamStore.ts). A trade is inferred when the session
// cumulative volume rises between two updates; its size is the volume delta
// and its price the update's last price. LEVELONE is conflated, so one
// "trade block" can be several prints at different prices: this is closer to
// trade level than 1-minute bars but still not a time-and-sales tape (Schwab
// documents none).
//
// Each block is signed by the Lee-Ready algorithm:
//   Lee & Ready (1991), "Inferring Trade Direction from Intraday Data",
//   Journal of Finance 46(2), 733-746,
//   https://doi.org/10.1111/j.1540-6261.1991.tb02683.x
//   quote rule: price > prevailing midquote -> buy, < mid -> sell;
//   at the mid: tick rule (vs the previous trade price; zero tick keeps the
//   last non-zero sign).
// Prevailing quote = the bid/ask held BEFORE the update that carried the
// trade (the update's own bid/ask may already be post-trade). Lee-Ready's
// 5-second quote lag was for 1980s reporting delays; with millisecond
// timestamps no lag is used (Holden & Jacobsen 2014, "Liquidity Measurement
// Problems in Fast, Competitive Markets", Journal of Finance 69(4),
// https://doi.org/10.1111/jofi.12127; Bessembinder 2003, J. Financial Markets 6(3)).

export interface L1Update {
  /** Schwab time, epoch ms. */
  t: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  /** Session cumulative volume after the update. */
  cumVolume: number | null;
}

export interface L1TradeBlock {
  t: number;
  price: number;
  size: number;
  sign: 1 | -1 | 0;
  rule: "quote" | "tick" | "none";
}

export interface L1Classification {
  trades: L1TradeBlock[];
  quoteRule: number;
  tickRule: number;
  /** Blocks with no usable quote and no prior trade: sign 0, volume still counted as unsigned. */
  unsigned: number;
  /** Times the cumulative volume fell (new session or correction): baseline reset, no trade inferred. */
  volumeResets: number;
}

const validQuote = (bid: number | null, ask: number | null): boolean =>
  bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid;

/**
 * One Lee-Ready step: quote rule against the prevailing (prior) quote, tick
 * rule at the mid (zero tick keeps the last non-zero sign), "none" when
 * neither applies.
 */
export function leeReadySign(
  price: number,
  prevBid: number | null,
  prevAsk: number | null,
  lastTradePrice: number | null,
  lastTickSign: 1 | -1 | 0,
): { sign: 1 | -1 | 0; rule: L1TradeBlock["rule"] } {
  let sign: 1 | -1 | 0 = 0;
  let rule: L1TradeBlock["rule"] = "none";
  if (validQuote(prevBid, prevAsk)) {
    const mid = ((prevBid as number) + (prevAsk as number)) / 2;
    // Binary floating point: (100.01 + 100.03) / 2 is not exactly 100.02,
    // so "at the mid" is decided within a relative 1e-9.
    const eps = 1e-9 * Math.max(1, Math.abs(mid));
    if (price > mid + eps) { sign = 1; rule = "quote"; }
    else if (price < mid - eps) { sign = -1; rule = "quote"; }
  }
  if (rule === "none" && lastTradePrice != null) {
    if (price > lastTradePrice) sign = 1;
    else if (price < lastTradePrice) sign = -1;
    else sign = lastTickSign;
    rule = sign === 0 ? "none" : "tick";
  }
  return { sign, rule };
}

/** Lee-Ready classification of LEVELONE trade blocks (pure, ordered input). */
export function classifyL1Trades(updates: L1Update[]): L1Classification {
  const trades: L1TradeBlock[] = [];
  let quoteRule = 0, tickRule = 0, unsigned = 0, volumeResets = 0;
  let prevBid: number | null = null;
  let prevAsk: number | null = null;
  let prevVol: number | null = null;
  let lastTradePrice: number | null = null;
  let lastTickSign: 1 | -1 | 0 = 0;
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    const vol = u.cumVolume != null && Number.isFinite(u.cumVolume) ? u.cumVolume : null;
    if (i > 0 && vol != null && prevVol != null) {
      if (vol < prevVol) {
        volumeResets++;
      } else if (vol > prevVol && u.last != null && Number.isFinite(u.last) && u.last > 0) {
        const price = u.last;
        const size = vol - prevVol;
        const { sign, rule } = leeReadySign(price, prevBid, prevAsk, lastTradePrice, lastTickSign);
        if (rule === "quote") quoteRule++;
        else if (rule === "tick") tickRule++;
        else unsigned++;
        if (lastTradePrice != null && price !== lastTradePrice) lastTickSign = price > lastTradePrice ? 1 : -1;
        lastTradePrice = price;
        trades.push({ t: u.t, price, size, sign, rule });
      }
    }
    if (vol != null) prevVol = vol;
    if (u.bid != null) prevBid = u.bid;
    if (u.ask != null) prevAsk = u.ask;
  }
  return { trades, quoteRule, tickRule, unsigned, volumeResets };
}

/**
 * Signed volume per complete minute from classified trade blocks, for minutes
 * starting at or after fromMs (rounded up to a minute) and ending at or before
 * toMs. A minute with no trade block is volumeMissing (the stream cannot tell
 * a quiet minute from a stalled symbol), never a 0-volume print.
 */
export function signedVolumeBarsFromTrades(trades: L1TradeBlock[], fromMs: number, toMs: number): SignedTickBar[] {
  const start = Math.ceil(fromMs / 60_000) * 60_000;
  const end = Math.floor(toMs / 60_000) * 60_000; // first minute NOT complete
  const bars: SignedTickBar[] = [];
  if (end <= start) return bars;
  const byMin = new Map<number, { vol: number; signed: number; close: number }>();
  for (const k of trades) {
    const m = Math.floor(k.t / 60_000) * 60_000;
    if (m < start || m >= end) continue;
    const b = byMin.get(m) ?? { vol: 0, signed: 0, close: k.price };
    b.vol += k.size;
    b.signed += k.sign * k.size;
    b.close = k.price;
    byMin.set(m, b);
  }
  let cumulative = 0;
  let lastClose: number | null = null;
  for (const k of trades) {
    if (k.t < start) lastClose = k.price;
  }
  for (let m = start; m < end; m += 60_000) {
    const b = byMin.get(m);
    if (!b) {
      if (lastClose != null) bars.push({ ts: m, close: lastClose, volume: 0, direction: 0, signedVolume: 0, cumulative, volumeMissing: true });
      continue;
    }
    cumulative += b.signed;
    lastClose = b.close;
    const direction: 1 | -1 | 0 = b.signed > 0 ? 1 : b.signed < 0 ? -1 : 0;
    bars.push({ ts: m, close: b.close, volume: b.vol, direction, signedVolume: b.signed, cumulative });
  }
  return bars;
}

/** Bar-level tick-rule bars before `switchMs`, trade-level bars from it; cumulative recomputed across the join. */
export function mergeSignedBars(barRule: SignedTickBar[], tradeLevel: SignedTickBar[], switchMs: number): SignedTickBar[] {
  const out: SignedTickBar[] = [];
  let cumulative = 0;
  for (const b of barRule) {
    if (b.ts >= switchMs) break;
    cumulative += b.signedVolume;
    out.push({ ...b, cumulative });
  }
  for (const b of tradeLevel) {
    if (b.ts < switchMs) continue;
    cumulative += b.signedVolume;
    out.push({ ...b, cumulative });
  }
  return out;
}

// ─── Streamed option trade blocks: per-contract side book (R3-2 item 4) ────
//
// The chain snapshot only supports a last-print side (each contract's whole
// day volume tagged by its latest print vs the current quote). For contracts
// streamed on Schwab LEVELONE_OPTIONS (the 0DTE tracker and whale follow-up
// subscriptions), each update that raises TOTAL_VOLUME is a trade block: size
// = the volume delta, price = the update's last, signed by Lee-Ready against
// the quote held BEFORE that update (leeReadySign, same rule as the SPY
// equity read above). Totals are per contract, per ET session date, from the
// first update the stream delivered (coverage starts at subscription; volume
// traded before it, or during a disconnect, is not classified and is
// reported as uncovered, never as zero or as a side).
// Option premium = size x price x 100 (standard equity/index option
// multiplier; Cboe SPX / SPY contract specifications).

export interface OptionSideTotals {
  /** ET session date the totals belong to. */
  day: string;
  buyVol: number;
  sellVol: number;
  unsignedVol: number;
  buyPrem: number;
  sellPrem: number;
  quoteRule: number;
  tickRule: number;
  unsigned: number;
  /** Schwab time of the first / last classified block. */
  firstMs: number | null;
  lastMs: number | null;
  /** Stream sessions (reconnects) whose baseline was reset; volume across a gap is not classified. */
  baselineResets: number;
}

interface OptionSideState {
  epoch: number;
  prevBid: number | null;
  prevAsk: number | null;
  prevVol: number | null;
  lastTradePrice: number | null;
  lastTickSign: 1 | -1 | 0;
  totals: OptionSideTotals;
}

const etDayOf = (() => {
  let memoMin = NaN;
  let memoDay = "";
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return (t: number): string => {
    const m = Math.floor(t / 60_000);
    if (m !== memoMin) { memoMin = m; memoDay = fmt.format(new Date(t)); }
    return memoDay;
  };
})();

const emptyTotals = (day: string): OptionSideTotals => ({
  day, buyVol: 0, sellVol: 0, unsignedVol: 0, buyPrem: 0, sellPrem: 0,
  quoteRule: 0, tickRule: 0, unsigned: 0, firstMs: null, lastMs: null, baselineResets: 0,
});

/** Normalized option key: Schwab streamer symbols are space-padded, chain OCC keys are not. */
export const optionKey = (symbol: string): string => symbol.replace(/\s+/g, "");

export class OptionTradeSideBook {
  private st = new Map<string, OptionSideState>();

  /**
   * Apply one merged LEVELONE_OPTIONS update (post-update bid/ask/last and
   * session cumulative volume). `epoch` is the stream session: a new one
   * resets the baseline so the first update after a reconnect is not read
   * as one giant block.
   */
  update(symbol: string, u: L1Update, epoch: number): void {
    const key = optionKey(symbol);
    const day = etDayOf(u.t);
    let s = this.st.get(key);
    if (!s || s.totals.day !== day) {
      s = { epoch, prevBid: null, prevAsk: null, prevVol: null, lastTradePrice: null, lastTickSign: 0, totals: emptyTotals(day) };
      this.st.set(key, s);
    } else if (s.epoch !== epoch) {
      s.epoch = epoch;
      s.prevVol = null; s.prevBid = null; s.prevAsk = null;
      s.totals.baselineResets++;
    }
    const vol = u.cumVolume != null && Number.isFinite(u.cumVolume) ? u.cumVolume : null;
    if (vol != null && s.prevVol != null && vol > s.prevVol && u.last != null && Number.isFinite(u.last) && u.last > 0) {
      const size = vol - s.prevVol;
      const { sign, rule } = leeReadySign(u.last, s.prevBid, s.prevAsk, s.lastTradePrice, s.lastTickSign);
      const prem = size * u.last * 100;
      const T = s.totals;
      if (sign > 0) { T.buyVol += size; T.buyPrem += prem; }
      else if (sign < 0) { T.sellVol += size; T.sellPrem += prem; }
      else T.unsignedVol += size;
      if (rule === "quote") T.quoteRule++; else if (rule === "tick") T.tickRule++; else T.unsigned++;
      if (T.firstMs == null) T.firstMs = u.t;
      T.lastMs = u.t;
      if (s.lastTradePrice != null && u.last !== s.lastTradePrice) s.lastTickSign = u.last > s.lastTradePrice ? 1 : -1;
      s.lastTradePrice = u.last;
    }
    if (vol != null) s.prevVol = vol;
    if (u.bid != null) s.prevBid = u.bid;
    if (u.ask != null) s.prevAsk = u.ask;
  }

  /** Totals for a contract on an ET date (default: the date of `nowMs`), or null when never streamed that day. */
  get(symbol: string, nowMs: number = Date.now()): OptionSideTotals | null {
    const s = this.st.get(optionKey(symbol));
    if (!s || s.totals.day !== etDayOf(nowMs)) return null;
    return { ...s.totals };
  }

  get size(): number { return this.st.size; }
}

export interface StreamSideContract {
  occ: string;
  side: "C" | "P";
  /** Chain day volume of the contract (Schwab), null when omitted. */
  dayVolume: number | null;
}

export interface StreamSideSummary {
  method: string;
  /** Chain contracts with at least one streamed, classified block today. */
  contracts: number;
  boughtCallVol: number; soldCallVol: number; unsignedCallVol: number;
  boughtPutVol: number; soldPutVol: number; unsignedPutVol: number;
  boughtCallPrem: number; soldCallPrem: number; boughtPutPrem: number; soldPutPrem: number;
  /** Volume in streamed blocks (signed + unsigned). */
  streamedVol: number;
  /** Day volume of the whole chain window; share covered = streamedVol / chainDayVol. */
  chainDayVol: number;
  coveragePct: number | null;
  /** Of the streamed blocks: share signed by the quote rule / tick rule. */
  quoteRulePct: number | null;
  tickRulePct: number | null;
  firstMs: number | null;
  lastMs: number | null;
}

export const STREAM_SIDE_METHOD =
  "Lee-Ready on Schwab LEVELONE_OPTIONS trade blocks (volume delta between streamed updates, signed vs the prior quote; tick rule at the mid), only for streamed contracts and only since their subscription; the rest of the chain volume is not classified here.";

/** Aggregate the side book over the chain's contracts. Pure given the book. */
export function summarizeStreamSide(
  contracts: ReadonlyArray<StreamSideContract>,
  lookup: (occ: string) => OptionSideTotals | null,
): StreamSideSummary {
  const out: StreamSideSummary = {
    method: STREAM_SIDE_METHOD, contracts: 0,
    boughtCallVol: 0, soldCallVol: 0, unsignedCallVol: 0, boughtPutVol: 0, soldPutVol: 0, unsignedPutVol: 0,
    boughtCallPrem: 0, soldCallPrem: 0, boughtPutPrem: 0, soldPutPrem: 0,
    streamedVol: 0, chainDayVol: 0, coveragePct: null, quoteRulePct: null, tickRulePct: null, firstMs: null, lastMs: null,
  };
  let quote = 0, tick = 0, blocks = 0;
  for (const c of contracts) {
    if (c.dayVolume != null && Number.isFinite(c.dayVolume)) out.chainDayVol += c.dayVolume;
    const t = lookup(c.occ);
    if (!t) continue;
    const v = t.buyVol + t.sellVol + t.unsignedVol;
    if (v <= 0) continue;
    out.contracts++;
    out.streamedVol += v;
    if (c.side === "C") {
      out.boughtCallVol += t.buyVol; out.soldCallVol += t.sellVol; out.unsignedCallVol += t.unsignedVol;
      out.boughtCallPrem += t.buyPrem; out.soldCallPrem += t.sellPrem;
    } else {
      out.boughtPutVol += t.buyVol; out.soldPutVol += t.sellVol; out.unsignedPutVol += t.unsignedVol;
      out.boughtPutPrem += t.buyPrem; out.soldPutPrem += t.sellPrem;
    }
    quote += t.quoteRule; tick += t.tickRule; blocks += t.quoteRule + t.tickRule + t.unsigned;
    if (t.firstMs != null) out.firstMs = out.firstMs == null ? t.firstMs : Math.min(out.firstMs, t.firstMs);
    if (t.lastMs != null) out.lastMs = out.lastMs == null ? t.lastMs : Math.max(out.lastMs, t.lastMs);
  }
  out.coveragePct = out.chainDayVol > 0 ? (out.streamedVol / out.chainDayVol) * 100 : null;
  out.quoteRulePct = blocks > 0 ? (quote / blocks) * 100 : null;
  out.tickRulePct = blocks > 0 ? (tick / blocks) * 100 : null;
  return out;
}
