// server/flowAttribution.ts
//
// What a Schwab option-chain snapshot can and cannot say about flow, and the
// most that can be read from a SEQUENCE of them. Pure: no imports.
//
// Schwab's chain is a snapshot: per contract, the day's cumulative
// totalVolume, the last trade price and its time (tradeTimeInLong), and the
// current NBBO with its time (quoteTimeInLong). There are no trade prints
// (no time and sales), so:
//   - "premium" from one snapshot is volume x a current price: today's
//     contracts marked at the current quote, not the premium that traded;
//   - the side of the LAST print (last vs the current bid/ask) says nothing
//     about the other prints of the day, and is wrong when the quote moved
//     after the print.
// Scanning every ~30 s turns this into something closer to a tape:
//   - a volume increment dV = V_k - V_{k-1} is contracts traded in the
//     interval;
//   - if the last-trade time moved into the interval, the increment is
//     attributed to the side of that print (last vs the bid/ask of the same
//     snapshot), at the printed price; when several prints land in one
//     interval the LAST one labels all of them (stated as an estimate);
//   - if the trade time did not move (volume changed with no new print time,
//     or no times at all), the increment is "unattributed" at the mid.
// The ledger keeps the attributed volume by side, the premium traded at
// the prices seen, a rolling burst window, and the coverage of the
// attribution (how much of the volume since the first scan it could label).
// Volume before the first scan of the day is reported separately
// ("pre-scan", marked at the first mid): it may contain the whale, but no
// side or price can be assigned to it.
//
// Honest labels for the UI: every number here is an estimate from
// snapshots; the Schwab Streamer (LEVELONE_OPTIONS: last, lastSize, trade
// time per tick) would make prints observable for subscribed contracts.

export type FlowSide = "ask" | "bid" | "mid" | "unknown";

export interface FlowObservation {
  /** Observation time, epoch ms (the scan). */
  atMs: number;
  /** Schwab totalVolume: cumulative contracts today. */
  volume: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  /** Schwab tradeTimeInLong / quoteTimeInLong, epoch ms; null when absent or <= 0. */
  tradeTimeMs: number | null;
  quoteTimeMs: number | null;
}

export interface FlowIncrement {
  atMs: number;
  contracts: number;
  price: number;
  side: FlowSide;
  /** The print time that labelled this increment (null when unattributed). */
  tradeTimeMs: number | null;
  /** Quote moved more than QUOTE_STALE_MS after the print: the side is less certain. */
  staleQuote: boolean;
}

export interface FlowLedger {
  occ: string;
  /** Session date key (ET) the ledger belongs to; a new day starts a new ledger. */
  day: string;
  firstSeenAt: number;
  /** Volume already traded when first scanned (no side or price known). */
  preScanVolume: number;
  /** preScanVolume x mid at the first scan: an upper-bound style estimate, labelled as such. */
  preScanPremiumAtMid: number;
  lastObs: FlowObservation;
  askVolume: number;
  bidVolume: number;
  midVolume: number;
  unknownVolume: number;
  /** Sum of contracts x printed price x 100 over increments that carried a print (any side). */
  premiumTraded: number;
  /** Sum over increments without a print x mid x 100. */
  premiumUnattributed: number;
  /** Recent increments, newest last; pruned to BURST_KEEP_MS. */
  recent: FlowIncrement[];
  /** Last print side and its time, from the latest observation. */
  lastPrintSide: FlowSide;
  lastPrintAtMs: number | null;
  /** Schwab reported a volume lower than the previous scan (feed correction); counted, never attributed. */
  volumeDrops: number;
  /** Highest volume seen: after a lower reading, only volume above it counts as new. */
  highWater: number;
  /** Observations folded in (after the first) and how many carried a print inside their interval. */
  intervals: number;
  intervalsWithPrint: number;
  /** Increments whose print side was discarded because the quote moved long after the print. */
  staleQuoteIncrements: number;
  /** Within-day restarts (a reading fell below the day's first reading: prior-session figure replaced). */
  resets: number;
}

export const QUOTE_STALE_MS = 30_000;
export const BURST_KEEP_MS = 30 * 60_000;
export const CONTRACT_MULTIPLIER = 100;

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);

/** Side of a print: last against the bid/ask of the same snapshot. Tolerance one cent. */
export function sideOfPrint(last: number | null, bid: number | null, ask: number | null): FlowSide {
  if (last == null || bid == null || ask == null || ask < bid) return "unknown";
  const tol = 0.01;
  if (last >= ask - tol) return "ask";
  if (last <= bid + tol) return "bid";
  return "mid";
}

/** Mid of a snapshot, the same order as schwabFlow.calcMid: Schwab mark when
 *  inside the spread, else last when inside the spread, else (bid+ask)/2, else last. */
export function midOf(o: Pick<FlowObservation, "bid" | "ask" | "mark" | "last">): number | null {
  const bid = num(o.bid), ask = num(o.ask), mark = num(o.mark), last = num(o.last);
  if (mark != null && bid != null && ask != null && mark >= bid && mark <= ask) return mark;
  const hasSpread = bid != null && ask != null && ask >= bid;
  if (hasSpread && last != null && last >= bid - 0.005 && last <= ask + 0.005) return last;
  if (hasSpread) return (bid + ask) / 2;
  return last;
}

export function newLedger(occ: string, day: string, first: FlowObservation): FlowLedger {
  const mid = midOf(first) ?? 0;
  const vol = Math.max(0, Math.round(first.volume || 0));
  return {
    occ, day, firstSeenAt: first.atMs,
    preScanVolume: vol,
    preScanPremiumAtMid: vol * mid * CONTRACT_MULTIPLIER,
    lastObs: first,
    askVolume: 0, bidVolume: 0, midVolume: 0, unknownVolume: 0,
    premiumTraded: 0, premiumUnattributed: 0,
    recent: [],
    lastPrintSide: sideOfPrint(first.last, first.bid, first.ask),
    lastPrintAtMs: first.tradeTimeMs,
    volumeDrops: 0,
    highWater: vol,
    intervals: 0,
    intervalsWithPrint: 0,
    staleQuoteIncrements: 0,
    resets: 0,
  };
}

/**
 * Folds one observation into the ledger (returns a new object). The volume
 * increment since the previous observation is attributed to the side of the
 * last print only when that print's time is inside the interval; otherwise
 * it is unattributed. A print exactly at the previous scan time is treated
 * as already counted.
 */
export function observe(ledger: FlowLedger, obs: FlowObservation): FlowLedger {
  const prev = ledger.lastObs;
  // Ordering guard: a chain served from cache carries its original time, so a
  // re-served or out-of-order snapshot (older than or equal to the last one)
  // adds nothing and must not rewind the ledger.
  if (!(obs.atMs > prev.atMs)) return ledger;
  const vol = Math.max(0, Math.round(obs.volume || 0));
  // A reading below the first reading of the day is a counter restart (Schwab
  // can still report the prior session's total for a contract until it trades
  // today): the ledger restarts here, so a prior-day figure never feeds the
  // gate as today's premium. Counters carry over so the summary shows it.
  // A lower reading that stays at or above the first reading is a drop, not a
  // restart: the high-water mark below means a dip and recovery adds nothing.
  if (vol < ledger.preScanVolume) {
    const fresh = newLedger(ledger.occ, ledger.day, obs);
    fresh.resets = ledger.resets + 1;
    fresh.volumeDrops = ledger.volumeDrops + 1;
    fresh.intervals = ledger.intervals + 1;
    return fresh;
  }
  const next: FlowLedger = { ...ledger, lastObs: obs, recent: ledger.recent.slice() };
  next.intervals++;
  next.lastPrintSide = sideOfPrint(obs.last, obs.bid, obs.ask);
  next.lastPrintAtMs = obs.tradeTimeMs;
  // Only volume above the high-water mark is new: a lower reading followed by a
  // recovery is a feed correction, not contracts traded twice.
  const base = Math.max(ledger.highWater, Math.max(0, Math.round(prev.volume || 0)));
  if (vol < base) next.volumeDrops++;
  next.highWater = Math.max(ledger.highWater, vol);
  if (vol > base) {
    const dV = vol - base;
    const printedInside = obs.tradeTimeMs != null && obs.tradeTimeMs > prev.atMs && obs.tradeTimeMs > (prev.tradeTimeMs ?? -Infinity);
    const mid = midOf(obs);
    if (printedInside && obs.last != null && obs.last > 0) {
      next.intervalsWithPrint++;
      const staleQuote = obs.quoteTimeMs != null && obs.tradeTimeMs != null && obs.quoteTimeMs - obs.tradeTimeMs > QUOTE_STALE_MS;
      // A quote that moved long after the print cannot place the print on a side.
      const side: FlowSide = staleQuote ? "unknown" : sideOfPrint(obs.last, obs.bid, obs.ask);
      if (staleQuote) next.staleQuoteIncrements++;
      const inc: FlowIncrement = { atMs: obs.atMs, contracts: dV, price: obs.last, side, tradeTimeMs: obs.tradeTimeMs, staleQuote };
      if (side === "ask") next.askVolume += dV;
      else if (side === "bid") next.bidVolume += dV;
      else if (side === "mid") next.midVolume += dV;
      else next.unknownVolume += dV;
      // Printed price is known for every increment that carried a print, whatever its side.
      next.premiumTraded += dV * obs.last * CONTRACT_MULTIPLIER;
      next.recent.push(inc);
    } else {
      next.unknownVolume += dV;
      const px = mid ?? num(obs.last) ?? 0;
      next.premiumUnattributed += dV * px * CONTRACT_MULTIPLIER;
      next.recent.push({ atMs: obs.atMs, contracts: dV, price: px, side: "unknown", tradeTimeMs: null, staleQuote: false });
    }
  }
  const cutoff = obs.atMs - BURST_KEEP_MS;
  while (next.recent.length && next.recent[0].atMs < cutoff) next.recent.shift();
  return next;
}

export interface FlowSummary {
  /** Contracts traded since the first scan (attributed + unattributed). */
  sinceFirstScan: number;
  askVolume: number;
  bidVolume: number;
  midVolume: number;
  unknownVolume: number;
  /** Share of the volume since the first scan that carried a print time (ask+bid+mid over all). */
  attributedCoverage: number | null;
  /** askVolume / (askVolume + bidVolume + midVolume); null when nothing attributed. */
  askShare: number | null;
  bidShare: number | null;
  /** $ at the prices seen: attributed, unattributed (at mid), and before the first scan (at the first mid). */
  premiumTraded: number;
  premiumUnattributed: number;
  preScanPremiumAtMid: number;
  /** premiumTraded + premiumUnattributed: today's traded premium since the first scan, at observed prices. */
  premiumSinceFirstScan: number;
  /** Largest sum of increments inside any window of `windowMs` ending at an observation. */
  burstPremium: number;
  burstContracts: number;
  burstSide: FlowSide | null;
  burstEndAtMs: number | null;
  lastPrintSide: FlowSide;
  lastPrintAgeMs: number | null;
  /** How the side was read: attributed prints (coverage adequate) or the last print only. */
  sideBasis: "attributed-prints" | "last-print-only" | "none";
  /** Scan intervals folded in, and how many carried a print (each print labels its whole interval). */
  intervals: number;
  intervalsWithPrint: number;
  staleQuoteIncrements: number;
  resets: number;
  volumeDrops: number;
}

export const MIN_COVERAGE_FOR_SIDE = 0.25;

export function summarize(ledger: FlowLedger, nowMs: number, windowMs = 5 * 60_000): FlowSummary {
  const attributed = ledger.askVolume + ledger.bidVolume + ledger.midVolume;
  const since = attributed + ledger.unknownVolume;
  const coverage = since > 0 ? attributed / since : null;
  const askShare = attributed > 0 ? ledger.askVolume / attributed : null;
  const bidShare = attributed > 0 ? ledger.bidVolume / attributed : null;
  // Burst: best window over the recent increments (two pointers).
  let burstPremium = 0, burstContracts = 0, burstEndAtMs: number | null = null;
  let burstAsk = 0, burstBid = 0;
  const r = ledger.recent;
  let i = 0, sumP = 0, sumC = 0, sAsk = 0, sBid = 0;
  for (let j = 0; j < r.length; j++) {
    sumP += r[j].contracts * r[j].price * CONTRACT_MULTIPLIER; sumC += r[j].contracts;
    if (r[j].side === "ask") sAsk += r[j].contracts; else if (r[j].side === "bid") sBid += r[j].contracts;
    while (r[i].atMs < r[j].atMs - windowMs) {
      sumP -= r[i].contracts * r[i].price * CONTRACT_MULTIPLIER; sumC -= r[i].contracts;
      if (r[i].side === "ask") sAsk -= r[i].contracts; else if (r[i].side === "bid") sBid -= r[i].contracts;
      i++;
    }
    if (sumP > burstPremium) { burstPremium = sumP; burstContracts = sumC; burstEndAtMs = r[j].atMs; burstAsk = sAsk; burstBid = sBid; }
  }
  const burstSide: FlowSide | null = burstEndAtMs == null ? null : burstAsk > burstBid && burstAsk >= burstContracts * 0.5 ? "ask" : burstBid > burstAsk && burstBid >= burstContracts * 0.5 ? "bid" : burstContracts > 0 ? "mid" : null;
  const sideBasis: FlowSummary["sideBasis"] = coverage != null && coverage >= MIN_COVERAGE_FOR_SIDE && attributed > 0
    ? "attributed-prints"
    : ledger.lastPrintSide !== "unknown" ? "last-print-only" : "none";
  return {
    sinceFirstScan: since,
    askVolume: ledger.askVolume, bidVolume: ledger.bidVolume, midVolume: ledger.midVolume, unknownVolume: ledger.unknownVolume,
    attributedCoverage: coverage,
    askShare, bidShare,
    premiumTraded: ledger.premiumTraded,
    premiumUnattributed: ledger.premiumUnattributed,
    preScanPremiumAtMid: ledger.preScanPremiumAtMid,
    premiumSinceFirstScan: ledger.premiumTraded + ledger.premiumUnattributed,
    burstPremium, burstContracts, burstSide, burstEndAtMs,
    lastPrintSide: ledger.lastPrintSide,
    lastPrintAgeMs: ledger.lastPrintAtMs != null ? Math.max(0, nowMs - ledger.lastPrintAtMs) : null,
    sideBasis,
    intervals: ledger.intervals,
    intervalsWithPrint: ledger.intervalsWithPrint,
    staleQuoteIncrements: ledger.staleQuoteIncrements,
    resets: ledger.resets,
    volumeDrops: ledger.volumeDrops,
  };
}

/**
 * Ask-side read for the whale gate. With adequate attribution coverage the
 * day's attributed prints decide (ask share >= askShareMin); otherwise the
 * last print's side decides, and the basis says so.
 */
export function askSideRead(s: FlowSummary, askShareMin = 0.55): { askSide: boolean; basis: FlowSummary["sideBasis"]; detail: string } {
  if (s.sideBasis === "attributed-prints" && s.askShare != null) {
    const pct = Math.round(s.askShare * 100);
    const n = s.askVolume + s.bidVolume + s.midVolume;
    return {
      askSide: s.askShare >= askShareMin,
      basis: s.sideBasis,
      detail: `${pct}% of ${n} attributed contracts printed at the ask (estimate: each of ${s.intervalsWithPrint} scan intervals labelled by its last print; ${Math.round((s.attributedCoverage ?? 0) * 100)}% of volume since first scan labelled)`,
    };
  }
  if (s.sideBasis === "last-print-only") {
    return { askSide: s.lastPrintSide === "ask", basis: s.sideBasis, detail: `last print only (${s.lastPrintSide}); not enough prints seen to attribute the day` };
  }
  return { askSide: false, basis: "none", detail: "no print side available" };
}

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
function etParts(ms: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of ET_FMT.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** Day key used to reset ledgers (ET calendar date of the observation). Intl, so DST is right. */
export function etDayKey(ms: number): string {
  const p = etParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}


/** In-memory store of ledgers keyed by OCC symbol; a new ET day starts fresh. */
export class FlowLedgerStore {
  private ledgers = new Map<string, FlowLedger>();
  constructor(private readonly cap = 20_000) {}

  record(occ: string, obs: FlowObservation): FlowLedger {
    const day = etDayKey(obs.atMs);
    const cur = this.ledgers.get(occ);
    const next = cur && cur.day === day ? observe(cur, obs) : newLedger(occ, day, obs);
    this.ledgers.set(occ, next);
    if (this.ledgers.size > this.cap) this.prune(obs.atMs);
    return next;
  }

  get(occ: string): FlowLedger | undefined { return this.ledgers.get(occ); }
  size(): number { return this.ledgers.size; }

  /** Drops ledgers from other days and, if still over the cap, the least recently observed. */
  prune(nowMs: number): void {
    const day = etDayKey(nowMs);
    for (const [k, v] of Array.from(this.ledgers.entries())) if (v.day !== day) this.ledgers.delete(k);
    if (this.ledgers.size <= this.cap) return;
    const sorted = Array.from(this.ledgers.entries()).sort((a, b) => a[1].lastObs.atMs - b[1].lastObs.atMs);
    for (let i = 0; i < sorted.length - this.cap; i++) this.ledgers.delete(sorted[i][0]);
  }

  clear(): void { this.ledgers.clear(); }
}
