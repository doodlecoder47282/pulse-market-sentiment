/**
 * server/odteTracker.ts
 *
 * Live 0DTE SPX contract tracker.
 *
 * Polls Schwab option chain every 4s for $SPX with 0DTE window. Keeps ATM ±20
 * strikes (up to ~40 contracts mixing calls + puts — user-configurable).
 * For each poll, per contract:
 *   · deltaVol        = current.volume − prev.volume  (prints since last poll)
 *   · notional        = deltaVol × last × 100
 *   · classification  = Lee-Ready (last vs midpoint → buyer/seller; midpoint
 *                       trades fall back to tick-rule vs previous last)
 *   · buyFlag         = classification === "buy" && notional ≥ minNotional
 *
 * When a user ARMS a contract, the tracker opens an active position snapshot.
 * Exit inference: volume rate decays below ½ of the post-buy rolling 5-min
 * average AND the contract's OI drops below a baseline (previous close OI +
 * logged buy volume) → emit SELL_INFERRED.
 *
 * Events are kept in a ring buffer for the front-end volume-stick markers.
 */

import { getOptionChain, type OptionChainResponse } from "./schwab";

// ─── Types ─────────────────────────────────────────────────────────────────

export type Side = "call" | "put";
export type Classification = "buy" | "sell" | "neutral";

export interface ContractRow {
  key: string;                  // e.g. "SPXW_7100C_20260423"
  symbol: string;               // "$SPX"
  strike: number;
  side: Side;
  expiry: string;               // ISO date
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  prevLast: number | null;      // previous poll's last (for tick rule)
  volume: number;               // cumulative
  deltaVol: number;             // this-poll delta
  openInterest: number;
  notional: number;             // deltaVol × last × 100 (this poll)
  classification: Classification;
  buyFlag: boolean;             // large notional + buy-classified
  distance: number;             // abs(strike − spot)
}

export interface TickEvent {
  ts: number;
  contractKey: string;
  strike: number;
  side: Side;
  kind: "buy" | "sell_inferred" | "arm";
  price: number | null;
  volume: number;
  notional: number;
}

export interface TrackedPosition {
  id: string;
  contractKey: string;
  strike: number;
  side: Side;
  buyPrice: number;             // entry last at arm
  buyVolume: number;            // cumulative volume at arm
  buyTimestamp: number;
  baselineOI: number;           // OI at arm (for OI-drop check)
  minNotional: number;          // user's threshold when armed
  status: "active" | "exited";
  volWindow: Array<{ ts: number; dv: number }>;  // rolling 5-min Δvol history
  markerBuyTs: number | null;
  markerSellTs: number | null;
  estExitPrice: number | null;
  estExitTs: number | null;
}

export interface TrackerSnapshot {
  asOf: number;
  symbol: string;
  spot: number;
  expiry: string | null;
  dte: number;
  contracts: ContractRow[];
  events: TickEvent[];           // latest 200 events
  tracked: TrackedPosition[];
  connected: boolean;
  note?: string;
}

// ─── In-memory state ───────────────────────────────────────────────────────

let lastSnapshot: TrackerSnapshot = {
  asOf: 0,
  symbol: "$SPX",
  spot: 0,
  expiry: null,
  dte: 0,
  contracts: [],
  events: [],
  tracked: [],
  connected: false,
  note: "initializing",
};

// Map keyed by contractKey — remembers prior poll for deltas + tick rule
const prevByKey = new Map<string, { volume: number; last: number | null }>();

// Rolling 5-min history of Δvol per contract (for decay detection)
const volHistory = new Map<string, Array<{ ts: number; dv: number }>>();

// Per-contract sparkline of recent volume sticks with classification, for UI
const sparkHistory = new Map<string, Array<{ ts: number; dv: number; cls: Classification; last: number | null }>>();

const events: TickEvent[] = [];
const tracked: TrackedPosition[] = [];

let pollTimer: ReturnType<typeof setInterval> | null = null;
let POLL_MS = 4_000;
const STRIKE_RADIUS = 20;         // ATM ±20 strikes
const DEFAULT_MIN_NOTIONAL = 50_000;
const SPARK_WINDOW_MS = 15 * 60_000;    // 15 min intraday sparkline window
const VOL_HISTORY_MS = 5 * 60_000;      // 5 min decay window

// ─── Utilities ─────────────────────────────────────────────────────────────

function pushEvent(e: TickEvent) {
  events.push(e);
  while (events.length > 400) events.shift();
}

function classify(last: number | null, bid: number | null, ask: number | null, prevLast: number | null): Classification {
  if (last == null) return "neutral";
  const mid = bid != null && ask != null && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  if (mid != null) {
    const eps = Math.max(0.005, mid * 0.005); // ½% midpoint tolerance
    if (last > mid + eps) return "buy";
    if (last < mid - eps) return "sell";
  }
  // Midpoint trade (or quotes missing) → tick rule
  if (prevLast != null) {
    if (last > prevLast) return "buy";
    if (last < prevLast) return "sell";
  }
  return "neutral";
}

function rollingAvg(win: Array<{ ts: number; dv: number }>, nowTs: number): number {
  const cutoff = nowTs - VOL_HISTORY_MS;
  const recent = win.filter(w => w.ts >= cutoff);
  if (!recent.length) return 0;
  return recent.reduce((s, w) => s + w.dv, 0) / recent.length;
}

// ─── Main poll loop ────────────────────────────────────────────────────────

async function poll() {
  try {
    const chain: OptionChainResponse = await getOptionChain("$SPX", 0);
    if ("error" in chain) {
      // Try SPY fallback for context if SPX unavailable
      const spy = await getOptionChain("SPY", 0);
      if ("error" in spy) {
        lastSnapshot = {
          ...lastSnapshot,
          asOf: Date.now(),
          connected: false,
          note: "Schwab connection required for 0DTE tracker",
        };
        return;
      }
      processChain(spy, "SPY");
      return;
    }
    processChain(chain, "$SPX");
  } catch (e: any) {
    console.warn("[odteTracker] poll error:", e?.message);
  }
}

function pickExpiry(map: Record<string, Record<string, any[]>>): string | null {
  const keys = Object.keys(map);
  if (!keys.length) return null;
  // Sort by date component at front of key like "2026-04-23:0"
  keys.sort((a, b) => a.localeCompare(b));
  return keys[0];
}

function parseExpiryKey(k: string): string {
  // Schwab returns keys like "2026-04-23:0" — strip the DTE suffix
  const idx = k.indexOf(":");
  return idx > 0 ? k.slice(0, idx) : k;
}

function processChain(chain: Exclude<OptionChainResponse, { error: string }>, symbol: string) {
  const spot = chain.underlying.last
    ?? (chain.underlying.bid && chain.underlying.ask ? (chain.underlying.bid + chain.underlying.ask) / 2 : 0);
  if (!spot || spot <= 0) {
    lastSnapshot = { ...lastSnapshot, asOf: Date.now(), connected: true, note: "no spot" };
    return;
  }

  const callExp = pickExpiry(chain.callExpDateMap);
  const putExp = pickExpiry(chain.putExpDateMap);
  const expiryKey = callExp || putExp;
  if (!expiryKey) {
    lastSnapshot = { ...lastSnapshot, asOf: Date.now(), connected: true, note: "no 0DTE chain" };
    return;
  }
  const expiryISO = parseExpiryKey(expiryKey);
  const dteMatch = expiryKey.match(/:(\d+)$/);
  const dte = dteMatch ? parseInt(dteMatch[1], 10) : 0;

  // Build list of all strikes from chain
  const allStrikes = new Set<number>();
  const callStrikesObj = chain.callExpDateMap[expiryKey] ?? {};
  const putStrikesObj = chain.putExpDateMap[expiryKey] ?? {};
  for (const s of Object.keys(callStrikesObj)) allStrikes.add(parseFloat(s));
  for (const s of Object.keys(putStrikesObj)) allStrikes.add(parseFloat(s));

  // Pick ATM ±STRIKE_RADIUS nearest strikes
  const sortedByDist = Array.from(allStrikes)
    .filter(isFinite)
    .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))
    .slice(0, STRIKE_RADIUS * 2);
  const selectedStrikes = new Set(sortedByDist);

  const nowTs = Date.now();
  const rows: ContractRow[] = [];

  function addRow(strikeStr: string, contracts: any[] | undefined, side: Side) {
    const strike = parseFloat(strikeStr);
    if (!selectedStrikes.has(strike)) return;
    const c = contracts?.[0];
    if (!c) return;
    const key = `${symbol}_${strike.toFixed(0)}${side === "call" ? "C" : "P"}_${expiryISO}`;
    const bid = typeof c.bid === "number" ? c.bid : null;
    const ask = typeof c.ask === "number" ? c.ask : null;
    const last = typeof c.last === "number" ? c.last : (typeof c.mark === "number" ? c.mark : null);
    const volume = typeof c.totalVolume === "number" ? c.totalVolume : 0;
    const oi = typeof c.openInterest === "number" ? c.openInterest : 0;
    const prev = prevByKey.get(key);
    const deltaVol = prev ? Math.max(0, volume - prev.volume) : 0;
    const prevLast = prev?.last ?? null;
    const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
    const cls = deltaVol > 0 ? classify(last, bid, ask, prevLast) : "neutral";
    const notional = deltaVol > 0 && last != null ? deltaVol * last * 100 : 0;
    const buyFlag = cls === "buy" && notional >= DEFAULT_MIN_NOTIONAL;

    rows.push({
      key,
      symbol,
      strike,
      side,
      expiry: expiryISO,
      bid, ask, mid, last,
      prevLast,
      volume,
      deltaVol,
      openInterest: oi,
      notional,
      classification: cls,
      buyFlag,
      distance: Math.abs(strike - spot),
    });

    prevByKey.set(key, { volume, last });

    // Volume history for decay detection
    if (deltaVol > 0) {
      const hist = volHistory.get(key) ?? [];
      hist.push({ ts: nowTs, dv: deltaVol });
      // trim
      const cutoff = nowTs - VOL_HISTORY_MS;
      while (hist.length && hist[0].ts < cutoff) hist.shift();
      volHistory.set(key, hist);
    }

    // Sparkline ring for UI (any poll logged for continuity)
    const spark = sparkHistory.get(key) ?? [];
    spark.push({ ts: nowTs, dv: deltaVol, cls, last });
    const sparkCutoff = nowTs - SPARK_WINDOW_MS;
    while (spark.length && spark[0].ts < sparkCutoff) spark.shift();
    sparkHistory.set(key, spark);

    // Fire a BUY tick event (visual marker) when a large buy print happens
    if (buyFlag) {
      pushEvent({
        ts: nowTs,
        contractKey: key,
        strike,
        side,
        kind: "buy",
        price: last,
        volume: deltaVol,
        notional,
      });
    }
  }

  for (const s of Object.keys(callStrikesObj)) addRow(s, callStrikesObj[s], "call");
  for (const s of Object.keys(putStrikesObj)) addRow(s, putStrikesObj[s], "put");

  // Sort by ascending strike, calls-above-puts-at-same-strike (rendering convention)
  rows.sort((a, b) => a.strike - b.strike || (a.side === "call" ? -1 : 1));

  // ── Update tracked positions (exit inference) ───────────────────────────
  for (const t of tracked) {
    if (t.status !== "active") continue;
    const row = rows.find(r => r.key === t.contractKey);
    if (!row) continue;
    // Update rolling window reference from the volHistory map
    const hist = volHistory.get(t.contractKey) ?? [];
    t.volWindow = hist;
    // Compute post-buy 5-min average Δvol
    const postBuy = hist.filter(w => w.ts >= t.buyTimestamp);
    const avgDv = postBuy.length ? postBuy.reduce((s, w) => s + w.dv, 0) / postBuy.length : 0;
    // Most recent Δvol
    const lastDv = row.deltaVol;
    // Decay: latest Δvol < avg/2 for two consecutive slow polls
    const decayed = avgDv > 0 && lastDv < avgDv / 2;
    // OI drop: current OI below baseline by > 25% of buyVolume logged
    const expectedOI = t.baselineOI + Math.max(0, t.buyVolume * 0.25);
    const oiDropped = row.openInterest < t.baselineOI;

    // Secondary exit hint: classification flipped to sell with notional ≥ minNotional
    const sellClassified = row.classification === "sell" && row.notional >= t.minNotional;

    // Score: need EITHER (decay + oi drop) OR a big sell-classified print
    if ((decayed && oiDropped) || sellClassified) {
      t.status = "exited";
      t.estExitPrice = row.last;
      t.estExitTs = nowTs;
      t.markerSellTs = nowTs;
      pushEvent({
        ts: nowTs,
        contractKey: t.contractKey,
        strike: t.strike,
        side: t.side,
        kind: "sell_inferred",
        price: row.last,
        volume: lastDv,
        notional: row.notional,
      });
    }
  }

  lastSnapshot = {
    asOf: nowTs,
    symbol,
    spot,
    expiry: expiryISO,
    dte,
    contracts: rows,
    events: events.slice(-200),
    tracked: [...tracked],
    connected: true,
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

export function startOdteTracker(intervalMs = 4_000) {
  if (pollTimer) return;
  POLL_MS = intervalMs;
  // Kick off immediately, then on interval
  poll().catch(() => {});
  pollTimer = setInterval(() => { poll().catch(() => {}); }, POLL_MS);
  console.log(`[odteTracker] started, polling every ${POLL_MS}ms for ATM ±${STRIKE_RADIUS} 0DTE $SPX contracts`);
}

export function getOdteSnapshot(): TrackerSnapshot {
  return lastSnapshot;
}

export function getSparkline(contractKey: string, sizeCons: number = 5) {
  const hist = sparkHistory.get(contractKey) ?? [];
  // sizeCons scales the per-bar display threshold on the client — we just return raw
  return hist.map(h => ({ ts: h.ts, dv: h.dv, cls: h.cls, last: h.last, sizeCons }));
}

export function armPosition(args: {
  contractKey: string;
  minNotional?: number;
}): { ok: true; position: TrackedPosition } | { ok: false; error: string } {
  const snap = lastSnapshot;
  const row = snap.contracts.find(c => c.key === args.contractKey);
  if (!row) return { ok: false, error: "contract not found in current snapshot" };
  if (row.last == null) return { ok: false, error: "contract has no last price" };
  const existing = tracked.find(t => t.contractKey === args.contractKey && t.status === "active");
  if (existing) return { ok: true, position: existing };

  const pos: TrackedPosition = {
    id: `trk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    contractKey: args.contractKey,
    strike: row.strike,
    side: row.side,
    buyPrice: row.last,
    buyVolume: row.volume,
    buyTimestamp: Date.now(),
    baselineOI: row.openInterest,
    minNotional: args.minNotional ?? DEFAULT_MIN_NOTIONAL,
    status: "active",
    volWindow: [],
    markerBuyTs: Date.now(),
    markerSellTs: null,
    estExitPrice: null,
    estExitTs: null,
  };
  tracked.push(pos);
  pushEvent({
    ts: pos.buyTimestamp,
    contractKey: pos.contractKey,
    strike: pos.strike,
    side: pos.side,
    kind: "arm",
    price: pos.buyPrice,
    volume: 0,
    notional: 0,
  });
  return { ok: true, position: pos };
}

export function disarmPosition(id: string): boolean {
  const idx = tracked.findIndex(t => t.id === id);
  if (idx === -1) return false;
  tracked.splice(idx, 1);
  return true;
}

export function getTracked(): TrackedPosition[] {
  return tracked.map(t => ({ ...t }));
}
