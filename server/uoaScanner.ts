// ─────────────────────────────────────────────────────────────────────────────
// uoaScanner.ts — Unusual Options Activity scanner (separate from whale engine)
//
// Purpose:
//   - Whale engine = surgical 1–3DTE / $2.5M+ / 15x / ABOVE_ASK only, watchlist
//   - UOA scanner  = any-ticker / any-DTE / market-cap-tiered thresholds,
//                    requires CLUSTERING (N hits on same contract surface)
//                    before firing. Catches sustained accumulation that the
//                    single-print whale gate would miss.
//
// Spec (locked 2026-05-08):
//   - Universe: priority + watchlist + auto-discovery from incoming chain pulls
//     (read-through cache; no extra Schwab calls — reuses what whale already pulled)
//   - Market-cap tier thresholds (premiumFloor / volOiRatio / minHits):
//       MEGA   ($500B+):  $5.0M / 12x / 2 hits
//       LARGE  ($50B+):   $2.0M / 12x / 2 hits
//       MID    ($5B+):    $750K / 15x / 3 hits
//       SMALL  ($500M+):  $250K / 20x / 3 hits
//       MICRO  (<$500M):  $100K / 25x / 4 hits   (informational only — Discord OFF)
//   - Aggressor: ABOVE_ASK or AT_ASK accepted (UOA is broader than whale)
//   - DTE: 1–60 (no 0DTE — handled by BANGERS engine)
//   - Delta: |Δ| in [0.15, 0.85]
//   - Clustering: hits keyed by (symbol|type|strike|expiration). Accumulator
//     persists 4h. UOA fires when count >= minHits AND total premium >= floor.
//   - Cadence: piggybacks on whale eval cycle — no separate timer.
// ─────────────────────────────────────────────────────────────────────────────

import type { SchwabFlowContract } from "./schwabFlow";

// ─── Market-cap registry (USD) — covers liquid options names ─────────────────
// MEGA / LARGE / MID / SMALL / MICRO buckets derived at lookup time.
// Unknown symbols fall through to MID-cap defaults (conservative).
const MARKET_CAP: Record<string, number> = {
  // Mega cap (>$500B)
  AAPL: 3_400e9, MSFT: 3_100e9, NVDA: 3_300e9, GOOGL: 2_200e9, AMZN: 2_000e9,
  META: 1_500e9, BRK_B: 950e9, TSLA: 850e9, LLY: 720e9, AVGO: 700e9,
  WMT: 650e9, JPM: 620e9, V: 580e9,
  // Large cap ($50B–$500B)
  XOM: 480e9, MA: 450e9, UNH: 480e9, JNJ: 380e9, PG: 380e9, HD: 380e9,
  COST: 380e9, ORCL: 480e9, ABBV: 320e9, CVX: 290e9, BAC: 280e9, KO: 270e9,
  AMD: 240e9, NFLX: 290e9, ADBE: 230e9, CRM: 290e9, MRK: 250e9, PEP: 220e9,
  TMO: 200e9, ACN: 220e9, LIN: 220e9, CSCO: 240e9, MCD: 200e9, WFC: 220e9,
  ABT: 200e9, IBM: 200e9, DIS: 200e9, GE: 200e9, NOW: 180e9, INTC: 130e9,
  GS: 160e9, MS: 150e9, AXP: 200e9, BLK: 160e9, T: 170e9, CAT: 180e9,
  SBUX: 100e9, NKE: 110e9, BA: 120e9, MMM: 70e9, F: 50e9,
  COIN: 80e9, MSTR: 90e9, PLTR: 130e9, SHOP: 120e9, UBER: 170e9, SNOW: 50e9,
  // Mid cap ($5B–$50B)
  AAL: 12e9, DAL: 30e9, UAL: 18e9, RIVN: 12e9, LCID: 8e9, ROKU: 10e9,
  CHWY: 10e9, DASH: 50e9, ABNB: 90e9, RBLX: 30e9, CRWD: 80e9, NET: 40e9,
  ZM: 20e9, DOCU: 12e9, SNAP: 20e9, PINS: 25e9, HOOD: 30e9, SOFI: 15e9,
  AFRM: 15e9, RKT: 30e9, MARA: 8e9, RIOT: 4e9, CLSK: 4e9, IONQ: 5e9,
  RGTI: 3e9, QBTS: 2e9, LAES: 100e6, SEALSQ: 200e6,
  // Index proxies — treat as MEGA (no per-name mcap)
  SPX: 1e15, SPY: 1e15, QQQ: 1e15, IWM: 1e15, NDX: 1e15, RUT: 1e15,
  DIA: 1e15, VIX: 1e15,
};

export type McapBucket = "MEGA" | "LARGE" | "MID" | "SMALL" | "MICRO";

export function getMcap(symbol: string): number | null {
  const s = symbol.toUpperCase().replace(/[.]/g, "_");
  return MARKET_CAP[s] ?? null;
}

export function getMcapBucket(symbol: string): McapBucket {
  const m = getMcap(symbol);
  if (m === null) return "MID"; // unknown → conservative MID default
  if (m >= 500e9) return "MEGA";
  if (m >= 50e9)  return "LARGE";
  if (m >= 5e9)   return "MID";
  if (m >= 500e6) return "SMALL";
  return "MICRO";
}

// ─── Tier thresholds ─────────────────────────────────────────────────────────
export interface UoaTier {
  premiumFloor: number;   // $ notional minimum (per contract)
  volOiRatio: number;
  minHits: number;        // distinct prints needed to fire
  totalPremiumFloor: number; // cumulative $ across all hits
  discordEnabled: boolean;
}

export const UOA_TIERS: Record<McapBucket, UoaTier> = {
  MEGA:  { premiumFloor:  500_000, volOiRatio: 12, minHits: 2, totalPremiumFloor:  5_000_000, discordEnabled: true  },
  LARGE: { premiumFloor:  300_000, volOiRatio: 12, minHits: 2, totalPremiumFloor:  2_000_000, discordEnabled: true  },
  MID:   { premiumFloor:  150_000, volOiRatio: 15, minHits: 3, totalPremiumFloor:    750_000, discordEnabled: true  },
  SMALL: { premiumFloor:   50_000, volOiRatio: 20, minHits: 3, totalPremiumFloor:    250_000, discordEnabled: true  },
  MICRO: { premiumFloor:   25_000, volOiRatio: 25, minHits: 4, totalPremiumFloor:    100_000, discordEnabled: false },
};

// ─── Common gates ────────────────────────────────────────────────────────────
const UOA_MIN_DTE = 1;
const UOA_MAX_DTE = 60;
const UOA_DELTA_MIN = 0.15;
const UOA_DELTA_MAX = 0.85;
const UOA_ALLOWED_TAGS = new Set(["ABOVE_ASK", "AT_ASK"]);

// ─── Cluster accumulator ─────────────────────────────────────────────────────
// Keyed by (symbol|type|strike|expiration) — same contract surface across the
// trading day, regardless of OCC variant. Hits expire after 4h.
interface ClusterEntry {
  symbol: string;
  type: "C" | "P";
  strike: number;
  expiration: string;
  dte: number;
  bucket: McapBucket;
  hits: Array<{
    occ: string;
    notional: number;
    volume: number;
    volOiRatio: number;
    isNewStrike: boolean;
    delta: number;
    iv: number;
    bid: number;
    ask: number;
    mid: number;
    tag: string;
    sentiment: string;
    detectedAt: number;
  }>;
  firstSeenAt: number;
  lastSeenAt: number;
  fired: boolean;
  firedAt?: number;
}

const CLUSTER_TTL_MS = 4 * 60 * 60 * 1000;  // 4h
const clusters = new Map<string, ClusterEntry>();

// Dedup per OCC — same exact print won't double-count in same cluster
const seenOcc = new Map<string, number>();
const SEEN_OCC_TTL_MS = 30 * 60 * 1000;     // 30min — each print contributes once

function clusterKey(c: SchwabFlowContract, symbol: string): string {
  return `${symbol}|${c.type}|${c.strike}|${c.expiration}`;
}

function pruneStale(now: number): void {
  for (const [k, v] of clusters) {
    if (now - v.lastSeenAt > CLUSTER_TTL_MS) clusters.delete(k);
  }
  for (const [k, t] of seenOcc) {
    if (now - t > SEEN_OCC_TTL_MS) seenOcc.delete(k);
  }
}

// ─── Single-contract qualifier — applies tier + common gates ────────────────
export function qualifiesForUoa(c: SchwabFlowContract, symbol: string): { ok: boolean; reason: string; bucket: McapBucket; tier: UoaTier } {
  const bucket = getMcapBucket(symbol);
  const tier = UOA_TIERS[bucket];

  // Tag — ABOVE_ASK / AT_ASK only (UOA is broader than whale's strict ABOVE_ASK)
  if (!UOA_ALLOWED_TAGS.has(c.tag)) return { ok: false, reason: `tag=${c.tag}`, bucket, tier };
  // DTE
  if (c.dte < UOA_MIN_DTE) return { ok: false, reason: `dte=${c.dte}<${UOA_MIN_DTE}`, bucket, tier };
  if (c.dte > UOA_MAX_DTE) return { ok: false, reason: `dte=${c.dte}>${UOA_MAX_DTE}`, bucket, tier };
  // Delta
  const ad = Math.abs(c.delta ?? 0);
  if (ad > 0 && (ad < UOA_DELTA_MIN || ad > UOA_DELTA_MAX)) {
    return { ok: false, reason: `|Δ|=${ad.toFixed(2)} outside [${UOA_DELTA_MIN},${UOA_DELTA_MAX}]`, bucket, tier };
  }
  // Premium floor (per-print)
  if (c.notional < tier.premiumFloor) {
    return { ok: false, reason: `prem $${(c.notional / 1000).toFixed(0)}K < $${(tier.premiumFloor / 1000).toFixed(0)}K [${bucket}]`, bucket, tier };
  }
  // Vol/OI OR new strike
  const ratioOk = c.volOiRatio >= tier.volOiRatio;
  const newStrikeOk = c.isNewStrike && c.openInterest === 0;
  if (!ratioOk && !newStrikeOk) {
    return { ok: false, reason: `vol/OI=${c.volOiRatio.toFixed(1)}x < ${tier.volOiRatio}x [${bucket}]`, bucket, tier };
  }
  return { ok: true, reason: "qualifies", bucket, tier };
}

// ─── Ingest — call once per contract from the whale scan loop ────────────────
// Returns true if this contract caused the cluster to FIRE (first time it
// crossed both the hit-count and cumulative-premium thresholds).
export function ingestContract(c: SchwabFlowContract, symbol: string, spot: number | null): { fired: boolean; cluster: ClusterEntry | null } {
  try {
    const now = Date.now();
    pruneStale(now);

    const q = qualifiesForUoa(c, symbol);
    if (!q.ok) return { fired: false, cluster: null };

    // Per-OCC dedup so the same print doesn't accumulate twice
    if (seenOcc.has(c.occ)) return { fired: false, cluster: null };
    seenOcc.set(c.occ, now);

    const key = clusterKey(c, symbol);
    let cl = clusters.get(key);
    if (!cl) {
      cl = {
        symbol,
        type: c.type,
        strike: c.strike,
        expiration: c.expiration,
        dte: c.dte,
        bucket: q.bucket,
        hits: [],
        firstSeenAt: now,
        lastSeenAt: now,
        fired: false,
      };
      clusters.set(key, cl);
    }

    const mid = (c as any).mid > 0 ? (c as any).mid : ((c.bid + c.ask) / 2);
    cl.hits.push({
      occ: c.occ,
      notional: c.notional,
      volume: c.volume,
      volOiRatio: c.volOiRatio,
      isNewStrike: c.isNewStrike,
      delta: c.delta,
      iv: c.iv,
      bid: c.bid,
      ask: c.ask,
      mid,
      tag: c.tag,
      sentiment: c.sentiment,
      detectedAt: now,
    });
    cl.lastSeenAt = now;

    // Fire test
    const totalPrem = cl.hits.reduce((s, h) => s + h.notional, 0);
    const eligible = cl.hits.length >= q.tier.minHits && totalPrem >= q.tier.totalPremiumFloor;
    let fired = false;
    if (eligible && !cl.fired) {
      cl.fired = true;
      cl.firedAt = now;
      fired = true;
    }
    return { fired, cluster: cl };
  } catch {
    return { fired: false, cluster: null };
  }
}

// ─── Public read API for UI ──────────────────────────────────────────────────
export interface UoaCluster {
  key: string;
  symbol: string;
  type: "C" | "P";
  strike: number;
  expiration: string;
  dte: number;
  bucket: McapBucket;
  hitCount: number;
  totalPremium: number;
  totalVolume: number;
  avgVolOiRatio: number;
  avgDelta: number;
  avgIv: number;
  bid: number;
  ask: number;
  mid: number;
  spreadPct: number;
  spot: number | null;
  distFromSpotPct?: number;
  breakeven: number;
  breakevenPct?: number;
  sentiment: string;
  fired: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  firedAt?: number;
  reason: string;     // human-readable why-this-cluster
  tier: UoaTier;
}

function clusterToPublic(cl: ClusterEntry, spotByTicker: Map<string, number | null>): UoaCluster {
  const totalPremium = cl.hits.reduce((s, h) => s + h.notional, 0);
  const totalVolume = cl.hits.reduce((s, h) => s + h.volume, 0);
  const avgVolOi = cl.hits.reduce((s, h) => s + (isFinite(h.volOiRatio) ? h.volOiRatio : 0), 0) / Math.max(1, cl.hits.length);
  const avgDelta = cl.hits.reduce((s, h) => s + (h.delta || 0), 0) / Math.max(1, cl.hits.length);
  const avgIv = cl.hits.reduce((s, h) => s + (h.iv || 0), 0) / Math.max(1, cl.hits.length);
  // Use most-recent hit for live bid/ask/mid
  const last = cl.hits[cl.hits.length - 1];
  const spreadPct = last.mid > 0 && last.ask > 0 && last.bid > 0 ? ((last.ask - last.bid) / last.mid) * 100 : 0;
  const breakeven = cl.type === "C" ? cl.strike + last.mid : cl.strike - last.mid;
  const spot = spotByTicker.get(cl.symbol) ?? null;
  const distFromSpotPct = spot && spot > 0 ? ((cl.strike - spot) / spot) * 100 : undefined;
  const breakevenPct = spot && spot > 0 ? ((breakeven - spot) / spot) * 100 : undefined;

  // Dominant sentiment from hits
  const bull = cl.hits.filter(h => h.sentiment === "BULLISH").length;
  const bear = cl.hits.filter(h => h.sentiment === "BEARISH").length;
  const sentiment = bull > bear ? "BULLISH" : bear > bull ? "BEARISH" : "NEUTRAL";

  const tier = UOA_TIERS[cl.bucket];
  const reason = `${cl.hits.length} hits • $${(totalPremium / 1_000_000).toFixed(2)}M total • ${cl.bucket} tier • avg vol/OI ${avgVolOi.toFixed(1)}x`;

  return {
    key: clusterKey({ type: cl.type, strike: cl.strike, expiration: cl.expiration } as any, cl.symbol),
    symbol: cl.symbol,
    type: cl.type,
    strike: cl.strike,
    expiration: cl.expiration,
    dte: cl.dte,
    bucket: cl.bucket,
    hitCount: cl.hits.length,
    totalPremium,
    totalVolume,
    avgVolOiRatio: avgVolOi,
    avgDelta,
    avgIv,
    bid: last.bid,
    ask: last.ask,
    mid: last.mid,
    spreadPct,
    spot,
    distFromSpotPct,
    breakeven,
    breakevenPct,
    sentiment,
    fired: cl.fired,
    firstSeenAt: cl.firstSeenAt,
    lastSeenAt: cl.lastSeenAt,
    firedAt: cl.firedAt,
    reason,
    tier,
  };
}

export interface UoaSnapshot {
  asOf: number;
  totalClusters: number;
  firedClusters: number;
  byTicker: Record<string, UoaCluster[]>;
  config: {
    tiers: Record<McapBucket, UoaTier>;
    minDte: number;
    maxDte: number;
    deltaMin: number;
    deltaMax: number;
    allowedTags: string[];
    clusterTtlMinutes: number;
  };
}

export function getUoaSnapshot(spotByTicker?: Map<string, number | null>): UoaSnapshot {
  const now = Date.now();
  pruneStale(now);
  const map = spotByTicker ?? new Map<string, number | null>();
  const byTicker: Record<string, UoaCluster[]> = {};
  let total = 0, fired = 0;
  for (const cl of clusters.values()) {
    // UI only shows FIRED clusters or ones at >=50% of fire threshold
    const tier = UOA_TIERS[cl.bucket];
    const totalPrem = cl.hits.reduce((s, h) => s + h.notional, 0);
    const progress = Math.min(cl.hits.length / tier.minHits, totalPrem / tier.totalPremiumFloor);
    if (!cl.fired && progress < 0.5) continue;

    const pub = clusterToPublic(cl, map);
    (byTicker[cl.symbol] ??= []).push(pub);
    total++;
    if (cl.fired) fired++;
  }
  // Sort each ticker's clusters: fired first, then by total premium DESC, then volume DESC
  for (const sym of Object.keys(byTicker)) {
    byTicker[sym].sort((a, b) => {
      if (a.fired !== b.fired) return a.fired ? -1 : 1;
      if (b.totalPremium !== a.totalPremium) return b.totalPremium - a.totalPremium;
      return b.totalVolume - a.totalVolume;
    });
  }
  return {
    asOf: now,
    totalClusters: total,
    firedClusters: fired,
    byTicker,
    config: {
      tiers: UOA_TIERS,
      minDte: UOA_MIN_DTE,
      maxDte: UOA_MAX_DTE,
      deltaMin: UOA_DELTA_MIN,
      deltaMax: UOA_DELTA_MAX,
      allowedTags: Array.from(UOA_ALLOWED_TAGS),
      clusterTtlMinutes: CLUSTER_TTL_MS / 60_000,
    },
  };
}

// Reset hook (tests)
export function _resetUoaState(): void {
  clusters.clear();
  seenOcc.clear();
}
