// server/odteAlertEngine.ts
//
// Pulse Batcave 0DTE banger detector. ADDITIVE, observer-only — never modifies
// any existing calc. Watches /api/models (levels, audit, scenarioProbs) and
// /api/odte-tracker (live contract chain) for high-conviction setups.
//
// Wire 15: pre-gate filters (env veto, contract picker, projected return, IV richness,
//           Greek slope confirmation).
// Wire 16: useless-alert killers (score floor B-(72), projection floor +30%, projection
//           tiers, GEX magnitude gate, anti-chase rule, bid-ask spread gate,
//           spread-aware projection).
//
// Fires only when total grade ≥ 72 (B-). Below that → silent.
//
// Three setup patterns supported (highest-conviction only — "dime setups"):
//   1. FAILED BREAK   — spot pierced a level, closed back through → trade reversion
//   2. PIVOT RECLAIM  — spot lost then recaptured main pivot → trade momentum
//   3. WALL REJECT    — spot tagged call/put wall, rejected sharply → fade
//
// Grade composition (100 pts):
//   pattern                20  (binary, gates everything)
//   γ-zone alignment       15
//   DFI alignment          15
//   slope alignment        10
//   vanna bias alignment   10
//   risk:reward (T1/stop)  15
//   liquidity              10
//   time-of-day             5
//
// Letter grades: A+ ≥ 90, A ≥ 85, A− ≥ 80,
//                B+ ≥ 75, B ≥ 72 (B-), C ≥ 50, else F
// Wire 16 score floor: MIN_FIRE_SCORE = 72 (was 75/B+)
//
// HARD CAPS to keep this rare:
//   - Max 3 alerts per ET trading day
//   - Max 1 alert per 60-min window (across all setups/sides)
//   - Per (setup, side) cooldown: 45 min
//   - Requires ≥2 of 3 momentum signals (DFI, slope, vanna) aligned with trade direction
//
// State is in-memory (lost on restart, by design). The engine is a pure
// function of current snapshots — restart-safe because it only fires on
// fresh transitions detected via in-memory history.

export type OdteSetupKind = "FAILED_BREAK" | "PIVOT_RECLAIM" | "WALL_REJECT";
export type Side = "call" | "put";

export interface LevelLite {
  name: string;
  kind: string;
  price: number;
  side: "resistance" | "support" | string;
  status?: string;
  tag?: string;
}

export interface Audit {
  slope?: number | null;            // negative = bear, positive = bull
  dfi?: number | null;              // positive = bull, negative = bear
  gammaZone?: string | null;        // "y+" (dampened) | "y-" (volatile)
  vannaBias?: number | null;
  vannaM?: number | null;           // vanna $M magnitude (upgrade 2)
  vommaPockets?: number[] | null;   // strike prices of volga/vomma pockets (upgrade 2)
  mainPivot?: number | null;
  charmZero?: number | null;
  realizedSigma20d?: number | null; // 20-day realized vol (upgrade 1 VRP gate)
  intradayPivot?: number | null;    // session-aware pivot (Wire 6)
  gex?: number | null;            // net GEX in $M (negative = dealers short gamma)
  sessionOpen?: number | null;    // SPX print at 09:30 ET open (for GTBR distance)
  atmIV?: number | null;          // closest-to-spot contract IV at score time (for GTBR formula)
  coldBootOverride?: boolean;     // A- override: fired despite spotHistory.length < 5
  // ─── Wire 15 fields ──────────────────────────────────────────────────────
  // Gate 1 (ENV veto)
  envVetoReason?: string | null;          // "ENV_VETO_<reason>" or null if passed
  vix?: number | null;                    // VIX at gate eval time (context only — no cap)
  // Gate 2 (Contract picker)
  contractStrike?: number | null;
  contractDelta?: number | null;          // abs value
  contractMidPrice?: number | null;
  contractGamma?: number | null;
  contractTheta?: number | null;
  contractVega?: number | null;
  contractIv?: number | null;
  // Gate 3 (Projected return)
  projReturnPctT1?: number | null;        // decimal (e.g. 0.80 = 80%)
  projReturnPctT2?: number | null;
  projMinutesToClose?: number | null;
  // Gate 4 (IV richness)
  rv5d?: number | null;                   // 5-day realized vol (annualized, decimal)
  ivRichRatio?: number | null;            // atmIV / rv5d
  ivRichDegrade?: boolean;                // true when ratio > 1.5 (degraded by 0.7x)
  // Gate 5 (Greek slope confirmation)
  gammaSlope5m?: number | null;           // (currentDealerGex - dealerGexFiveMinAgo) / 5
  // Overall gate rejection reason (null = all gates passed)
  gateRejectReason?: string | null;
  // ─── Wire 16 fields ──────────────────────────────────────────────────────
  // Contract spread gate + spread-aware projection (Gate 2b)
  contractBid?: number | null;
  contractAsk?: number | null;
  contractEntryPrice?: number | null;     // midPrice + halfSpread (honest fill)
  contractSpreadPct?: number | null;      // (ask - bid) / midPrice
  // GEX magnitude gate (Gate 4 Wire 16)
  absGex?: number | null;                 // abs(dealerGex) in dollars
  gexTier?: "THIN" | "LIGHT" | "SOFT" | "FULL" | null;
  gexLightDegrade?: boolean;              // true when SOFT tier degrades projection by 0.85x
  gexLightOverride?: boolean;             // true when A-(85) lets LIGHT tier through
  // Anti-chase rule (Gate 5 Wire 16)
  realized15mMove?: number | null;        // abs(spot_now - spot_15min_ago)
  distanceToT1?: number | null;           // abs(t1Level - spot_now)
  chaseRatio?: number | null;             // realized15mMove / distanceToT1
  chaseOverride?: boolean;                // true when A-(85) overrides anti-chase rejection
  // Projection tier
  projTier?: "STANDARD" | "BANGER" | "MOONSHOT" | null;
  // Cold-boot projection override (renamed from Wire 15 coldBootOverride; scoped to +30% gate)
  coldBootProjOverride?: boolean;
  wickZones?: {
    pivot: number;
    upperEntry: number;
    upperExit: number;
    lowerEntry: number;
    lowerExit: number;
    halfWidth: number;
    source: string;
    asOfMin: number;
  } | null;
  vwapProfile?: {
    vwap: number;
    poc: number;
    vah: number;
    val: number;
    spotVsVwap: number;
    inValueArea: boolean;
    aboveVwap: boolean;
    pocDist: number;
    vwapStretchZ?: number | null;  // Wire 8 — Paper E re-engineered
  } | null;
  wire8VwapExhaustionPenalty?: number;  // Wire 8 audit: -3 when exhaustion fired
  wire8VwapStretchZ?: number;           // Wire 8 audit: z-score that triggered penalty
  // Wire 9 — Paper M re-engineered: jump regime
  jumpRegime?: boolean | null;          // true when 3+ of 4 jump features triggered
  jumpScore?: number | null;            // 0-4 count of triggered features
  jumpFeatures?: {
    overnightGapPct: number | null;
    preMktRangePct: number | null;
    gexSignFlip: boolean | null;
    vix1dChangePct: number | null;
  } | null;
  wire9JumpBoost?: number;              // +3 for PIVOT_RECLAIM in jump regime
  wire9JumpPenalty?: number;            // -2 for WALL_REJECT / FAILED_BREAK in jump regime
  // Wire 10 — Paper C re-engineered: chop regime
  chopRegime?: boolean;                  // true when failedBreakCount60min >= 3
  chopFailedBreakCount?: number;         // count of FAILED_BREAK detections in last 60min
  chopPivotReclaimCount?: number;        // count of PIVOT_RECLAIM detections in last 60min
  wire10ChopMomentumPenalty?: number;    // -4 for PIVOT_RECLAIM in chop regime
  wire10ChopMeanRevBoost?: number;       // +3 for WALL_REJECT/FAILED_BREAK in chop regime
  // Wire 11 — Paper L re-engineered: VIX/SPX correlation breakdown
  vixPctChange5m?: number | null;        // VIX % change over last 5 min
  spxPctChange5m?: number | null;        // SPX % change over last 5 min
  correlationBreakdown?: boolean;        // true when VIX and SPX move same direction (breakdown)
  correlationBreakdownDirection?: 'TOP_SIGNAL' | 'BOTTOM_SIGNAL' | null; // TOP: both up (rally fading); BOTTOM: both down (panic exhausting)
  wire11CorrelationBreakdownPenalty?: number;  // -4 when breakdown penalizes trade side
  wire11CorrelationBreakdownBoost?: number;    // +4 when breakdown boosts trade side
  // Wire 12 — 1-min S/D zones with volume confirm + retest tracking
  sdZones?: Array<{
    type: "DEMAND" | "SUPPLY";
    distal: number;
    proximal: number;
    baseTimeMs: number;
    ageMin: number;
    fresh: boolean;
    volumeConfirmed: boolean;
    retests: number;
    status: "UNTESTED" | "HELD" | "BREACHED";
  }>;
  wire12SdZoneBoost?: number;
  wire12SdZoneInfo?: { type: string; status: string; volumeConfirmed: boolean; distance: number };
  // Wire 13 — Lee-Ready OFI session-cumulative trend
  ofiTrend?: {
    cumulative: number;
    slope15m: number;
    slope5m: number;
    trend: "BULLISH" | "BEARISH" | "NEUTRAL";
    acceleration: "ACCELERATING" | "DECELERATING" | "FLAT";
  } | null;
  wire13OfiBoost?: number;
  wire13OfiPenalty?: number;
  // Wire 14 — T_high/T_low timing inference (Bloomberg OHLC paper, OHLC-derived)
  wickTiming?: {
    last3Inference: "BULLISH" | "BEARISH" | "MIXED" | "INDETERMINATE";
    strongCount15m: number;
    strongDirection15m: "BULLISH" | "BEARISH" | "BALANCED";
    latestBar: {
      inference: "BULLISH" | "BEARISH" | "INDETERMINATE";
      confluence: "STRONG_BULLISH" | "STRONG_BEARISH" | "WEAK_BULLISH" | "WEAK_BEARISH" | "NEUTRAL";
      highTiming: "EARLY" | "LATE" | "INDETERMINATE";
      lowTiming: "EARLY" | "LATE" | "INDETERMINATE";
    } | null;
  } | null;
  wire14WickTimingBoost?: number;
  wire14WickTimingPenalty?: number;
}

export interface ContractRow {
  key: string;
  strike: number;
  side: Side;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  volume: number;
  openInterest: number;
  expiry: string;
  iv?: number | null;               // implied vol (annualized, e.g. 0.18 = 18%) for VRP gate
}

export interface OdteAlert {
  setup: OdteSetupKind;
  side: Side;                       // CALL or PUT trade
  spot: number;
  asOf: number;
  contract: {
    strike: number;
    last: number | null;
    bid: number | null;
    ask: number | null;
    delta: number | null;           // approximate from distance/EM
    key: string;
    expiry: string;
    // Wire 15 fields from contract picker
    gamma?: number | null;
    theta?: number | null;
    vega?: number | null;
    iv?: number | null;
    midPrice?: number | null;
  };
  reversionFrom: { name: string; price: number };  // level we just bounced off
  t1: { name: string; price: number; estPctGain: number };
  t2?: { name: string; price: number; estPctGain: number };
  stopPct: number;                  // -% on contract
  stopLevel: number;                // SPX-level invalidation
  t2TriggerLevel: number;           // SPX-level that activates T2
  t2TrailingStopLevel: number;      // SPX-level the stop trails to after T1 hits
  greekSignals: string;             // e.g. "SLOPE UP" or "SLOPE UP · VANNA BULL"
  regime: string;                   // e.g. "NEUTRAL" | "DAMPENED \u03b3+" | "VOLATILE \u03b3-"
  grade: { score: number; letter: string; coldBootOverride?: boolean; reasoning: string[] };
  reasoning: string[];              // breakdown of where points came from
  // Wire 15 gate audit fields
  wire15?: {
    projReturnPctT1: number | null;  // decimal (0.80 = 80%)
    projReturnPctT2: number | null;
    rv5d: number | null;
    ivRichRatio: number | null;
    ivRichDegrade: boolean;
    gammaSlope5m: number | null;
    envVetoReason: string | null;
    gateRejectReason: string | null;
    contractStrike: number | null;
    contractDelta: number | null;
    // Wire 16 additions (surfaced in diagnose alongside wire15 fields)
    contractMidPrice: number | null;
    contractBid: number | null;
    contractAsk: number | null;
    contractEntryPrice: number | null;
    contractSpreadPct: number | null;
    absGex: number | null;
    gexTier: "THIN" | "LIGHT" | "SOFT" | "FULL" | null;
    gexLightDegrade: boolean;
    gexLightOverride: boolean;
    realized15mMove: number | null;
    distanceToT1: number | null;
    chaseRatio: number | null;
    chaseOverride: boolean;
    projTier: "STANDARD" | "BANGER" | "MOONSHOT" | null;
    coldBootProjOverride: boolean;
    wire15Present: boolean;
    wire16Present: boolean;
  };
}

// ─── Wire 10: detection history ring buffer (60-min GC) ─────────────────
type DetectionEvent = { ts: number; type: 'FAILED_BREAK' | 'PIVOT_RECLAIM' | 'WALL_REJECT' };
const detectionHistory: DetectionEvent[] = [];
const DETECTION_HISTORY_MAX_MS = 60 * 60 * 1000; // 60 min

export function recordDetection(ts: number, type: DetectionEvent['type']): void {
  detectionHistory.push({ ts, type });
  // GC older than 60min
  const cutoff = Date.now() - DETECTION_HISTORY_MAX_MS;
  while (detectionHistory.length && detectionHistory[0].ts < cutoff) {
    detectionHistory.shift();
  }
}

export function getChopRegime(): { isChop: boolean; failedBreakCount60min: number; pivotReclaimCount60min: number } {
  const cutoff = Date.now() - DETECTION_HISTORY_MAX_MS;
  const recent = detectionHistory.filter(e => e.ts >= cutoff);
  const failedBreakCount60min = recent.filter(e => e.type === 'FAILED_BREAK').length;
  const pivotReclaimCount60min = recent.filter(e => e.type === 'PIVOT_RECLAIM').length;
  return {
    isChop: failedBreakCount60min >= 3,
    failedBreakCount60min,
    pivotReclaimCount60min,
  };
}

// ─── In-memory state for transition detection ────────────────────────────
type SpotPoint = { ts: number; spot: number };
const spotHistory: SpotPoint[] = [];
const HISTORY_MAX_MS = 15 * 60_000;
const HISTORY_MAX_PTS = 200;

const lastFireAt: Record<string, number> = {};   // setup-kind|side -> ts
const SUPPRESS_MS = 45 * 60_000;                 // 45-min per-setup cooldown
const lastFireGrade: Record<string, number> = {}; // for letter-jump override

// Global rate limits (banger-only philosophy)
const HOURLY_GAP_MS = 60 * 60_000;               // ≥1 hour between any two alerts
const DAILY_CAP = 3;                             // max alerts per ET day
let lastAnyFireAt = 0;
const dailyFireCount: Record<string, number> = {}; // YYYY-MM-DD -> count

// ─── Upgrade 3: 10:00 AM regime snapshot (Vilkov) ───────────────────────────
// discordScheduler calls setTenAmRegime() at 10:00 ET each day.
interface TenAmRegimeSnapshot {
  date: string;        // ET date "YYYY-MM-DD" — ensures we only apply for today
  dfi: number;
  gammaZone: string;
  vannaBias: string;
  spot: number;
  mainPivot: number;
}
let tenAmRegime: TenAmRegimeSnapshot | null = null;

export function setTenAmRegime(snapshot: TenAmRegimeSnapshot): void {
  tenAmRegime = snapshot;
}

/**
 * Returns the spot price closest to targetTs within toleranceMs.
 * Used by Wire 11 to look up SPX 5-min ago from the spotHistory ring buffer.
 */
export function getSpotPriceAtTs(targetTs: number, toleranceMs: number = 60_000): number | null {
  if (spotHistory.length === 0) return null;
  let bestDist = Infinity;
  let bestPrice: number | null = null;
  for (const p of spotHistory) {
    const dist = Math.abs(p.ts - targetTs);
    if (dist < bestDist) {
      bestDist = dist;
      bestPrice = p.spot;
    }
  }
  return bestDist <= toleranceMs ? bestPrice : null;
}

/** Returns current spotHistory length and first/last timestamps for diagnostics. */
export function getSpotHistoryInfo(): { length: number; oldestTs: number | null; newestTs: number | null } {
  const length = spotHistory.length;
  const oldestTs = length > 0 ? spotHistory[0].ts : null;
  const newestTs = length > 0 ? spotHistory[length - 1].ts : null;
  return { length, oldestTs, newestTs };
}

function etDateStr(ts: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ts));
}

// ─── Wire 15: Dealer GEX 5-min history for gamma slope ─────────────────────────
// Ring buffer of (ts, gex) snapshots. Capped at 20 entries (covers >1 hour of
// 5-min polling). Used by Gate 5 to compute gammaSlope5m.
interface GexPoint { ts: number; gex: number; }
const dealerGexHistory: GexPoint[] = [];
const GEX_HISTORY_MAX = 20;
const GEX_HISTORY_MAX_MS = 70 * 60_000; // 70 min

/**
 * Called by the 0DTE alert loop each tick with the current net GEX value.
 * Maintains a capped ring buffer of GEX snapshots.
 */
export function recordDealerGex(ts: number, gex: number): void {
  if (!isFinite(gex)) return;
  dealerGexHistory.push({ ts, gex });
  const cutoff = ts - GEX_HISTORY_MAX_MS;
  while (dealerGexHistory.length > 0 && dealerGexHistory[0].ts < cutoff) {
    dealerGexHistory.shift();
  }
  while (dealerGexHistory.length > GEX_HISTORY_MAX) dealerGexHistory.shift();
}

/**
 * Compute gammaSlope5m = (currentGex - gexFiveMinAgo) / 5.
 * Returns null if no data available from ~5 min ago (within ±90s tolerance).
 */
export function computeGammaSlope5m(currentGex: number): number | null {
  if (!isFinite(currentGex) || dealerGexHistory.length < 2) return null;
  const now = dealerGexHistory[dealerGexHistory.length - 1].ts;
  const target = now - 5 * 60_000;
  const tol = 90_000; // ±90s
  let bestDist = Infinity;
  let bestGex: number | null = null;
  for (const p of dealerGexHistory) {
    const dist = Math.abs(p.ts - target);
    if (dist < bestDist && dist <= tol) {
      bestDist = dist;
      bestGex = p.gex;
    }
  }
  if (bestGex === null) return null;
  return (currentGex - bestGex) / 5;
}

export function recordSpot(ts: number, spot: number): void {
  if (!isFinite(spot) || spot <= 0) return;
  spotHistory.push({ ts, spot });
  // GC
  const cutoff = ts - HISTORY_MAX_MS;
  while (spotHistory.length > 0 && spotHistory[0].ts < cutoff) spotHistory.shift();
  while (spotHistory.length > HISTORY_MAX_PTS) spotHistory.shift();
}

/**
 * seedSpotHistory — backfill spotHistory from Schwab 1-min SPX bars at startup.
 *
 * Uses Schwab getPriceHistory("$SPX", "day", 1, "minute", 1) and maps
 * candles (datetime ms, close) into recordSpot calls.
 * Filters to last 30 minutes. Idempotent: if spotHistory already has >= 5
 * entries, skips seeding entirely.
 *
 * Returns { seeded, oldestTs, newestTs } for startup logging.
 */
export async function seedSpotHistory(): Promise<{
  seeded: number;
  oldestTs: number | null;
  newestTs: number | null;
}> {
  if (spotHistory.length >= 5) {
    console.log(`[seedSpotHistory] spotHistory already warm (length=${spotHistory.length}), skipping seed`);
    return { seeded: 0, oldestTs: null, newestTs: null };
  }

  let bars: Array<{ t: number; c: number }> = [];

  // Schwab 1-min bars for $SPX.X
  try {
    const { getPriceHistory } = await import("./schwab");
    const resp = await getPriceHistory("$SPX", "day", 1, "minute", 1);
    if (resp.candles.length >= 3) {
      // Filter to last 30 minutes; Schwab datetime is in milliseconds
      const now = Date.now();
      const cutoff30m = now - 30 * 60_000;
      const recent = resp.candles.filter((c) => c.datetime >= cutoff30m && c.close > 0);
      bars = recent.map((c) => ({ t: Math.floor(c.datetime / 1000), c: c.close }));
      console.log(`[seedSpotHistory] Schwab returned ${resp.candles.length} candles, ${recent.length} in last 30m`);
    }
  } catch (e: any) {
    console.warn(`[seedSpotHistory] Schwab 1-min fetch failed: ${e?.message ?? e}`);
  }

  if (bars.length === 0) {
    console.warn(`[seedSpotHistory] no bars available from Schwab, spotHistory not seeded`);
    return { seeded: 0, oldestTs: null, newestTs: null };
  }

  let seeded = 0;
  for (const bar of bars) {
    // bar.t is epoch seconds; recordSpot expects ms
    recordSpot(bar.t * 1000, bar.c);
    seeded++;
  }

  const oldest = spotHistory.length > 0 ? spotHistory[0].ts : null;
  const newest = spotHistory.length > 0 ? spotHistory[spotHistory.length - 1].ts : null;
  console.log(`[seedSpotHistory] seeded ${seeded} bars into spotHistory via Schwab (length=${spotHistory.length}), oldest=${oldest}, newest=${newest}`);
  return { seeded, oldestTs: oldest, newestTs: newest };
}

// Has spot crossed `level` from `fromSide` to the other side at any point in
// the last `windowMs`, AND has it since returned back to `fromSide`?
// That defines a FAILED BREAK from `fromSide`.
function detectFailedBreak(
  level: number,
  fromSide: "above" | "below",
  windowMs = 10 * 60_000,
): { detected: boolean; pierceTs: number | null; reclaimTs: number | null } {
  if (spotHistory.length < 3) return { detected: false, pierceTs: null, reclaimTs: null };
  const now = spotHistory[spotHistory.length - 1].ts;
  const cutoff = now - windowMs;

  let pierceTs: number | null = null;
  let reclaimTs: number | null = null;

  for (const p of spotHistory) {
    if (p.ts < cutoff) continue;
    const onOther = fromSide === "above" ? p.spot < level : p.spot > level;
    const onOriginal = fromSide === "above" ? p.spot > level : p.spot < level;
    if (onOther && pierceTs === null) pierceTs = p.ts;
    if (onOriginal && pierceTs !== null && reclaimTs === null) reclaimTs = p.ts;
  }
  // Confirm current spot is back on original side
  const last = spotHistory[spotHistory.length - 1].spot;
  const backOnOriginal = fromSide === "above" ? last > level : last < level;
  return {
    detected: pierceTs !== null && reclaimTs !== null && backOnOriginal,
    pierceTs, reclaimTs,
  };
}

// PIVOT RECLAIM = same shape as failed break but from "below" → "above" through main pivot
// (handled via detectFailedBreak with appropriate fromSide).

// WALL REJECT = spot tagged a wall (within 0.05%) within last 5min and is now > 3pts away
function detectWallReject(
  wallPrice: number,
  side: "ceiling" | "floor",
  windowMs = 5 * 60_000,
): { detected: boolean; tagTs: number | null } {
  if (spotHistory.length < 3) return { detected: false, tagTs: null };
  const now = spotHistory[spotHistory.length - 1].ts;
  const cutoff = now - windowMs;
  const tol = wallPrice * 0.0005;   // ±5 bps
  let tagTs: number | null = null;
  for (const p of spotHistory) {
    if (p.ts < cutoff) continue;
    if (Math.abs(p.spot - wallPrice) <= tol) tagTs = p.ts;
  }
  const last = spotHistory[spotHistory.length - 1].spot;
  const moved = side === "ceiling" ? last < wallPrice - 3 : last > wallPrice + 3;
  return { detected: tagTs !== null && moved, tagTs };
}

// Rough delta approximation from |strike − spot| and the daily expected move.
// Not a real BS delta — just a heuristic so the alert reads sensibly.
function approxDelta(strike: number, spot: number, oneDayEM: number, side: Side): number {
  if (!isFinite(oneDayEM) || oneDayEM <= 0) {
    // Fallback: ITM=0.7, ATM=0.5, OTM=0.3 buckets
    if (side === "call") {
      if (strike < spot - 5) return 0.7;
      if (strike > spot + 5) return 0.3;
      return 0.5;
    } else {
      if (strike > spot + 5) return 0.7;
      if (strike < spot - 5) return 0.3;
      return 0.5;
    }
  }
  // Standard 1σ ≈ EM. Rough cumulative-normal-style mapping.
  const z = side === "call" ? (spot - strike) / oneDayEM : (strike - spot) / oneDayEM;
  // Clamp to [0.05, 0.95]
  const cdf = 0.5 + 0.5 * Math.tanh(z);
  return Math.max(0.05, Math.min(0.95, cdf));
}

// Pick the best 0DTE contract for a given side + entry price. Prefers ATM/slightly
// ITM (delta 0.40-0.55), tight spread, OI > 200.
function pickContract(
  contracts: ContractRow[],
  spot: number,
  side: Side,
  oneDayEM: number,
): ContractRow | null {
  const candidates = contracts.filter((c) => c.side === side && c.last !== null && c.bid !== null && c.ask !== null);
  if (candidates.length === 0) return null;
  let best: ContractRow | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const delta = approxDelta(c.strike, spot, oneDayEM, side);
    if (delta < 0.30 || delta > 0.65) continue;
    const spread = (c.ask ?? 0) - (c.bid ?? 0);
    const mid = c.mid ?? c.last ?? 0;
    if (mid <= 0) continue;
    const spreadPct = spread / mid;
    const oiOk = c.openInterest >= 200 ? 1 : 0;
    const volOk = c.volume >= 100 ? 1 : 0;
    // Score: prefer delta near 0.45, low spread, OI/vol present
    const deltaProx = 1 - Math.abs(delta - 0.45) * 2;
    const score = deltaProx * 10 + (1 - Math.min(1, spreadPct * 20)) * 5 + oiOk * 3 + volOk * 2;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

// Estimate % gain on a contract if SPX moves to `targetSpot`. Uses delta as a
// linear first-order approximation — good enough for a heuristic display.
function estPctGainAtTarget(
  currentSpot: number, targetSpot: number,
  contractMid: number, delta: number, side: Side,
): number {
  const moveDir = side === "call" ? 1 : -1;
  const spxMove = (targetSpot - currentSpot) * moveDir;
  if (spxMove <= 0) return 0;
  const dollarGainPerShare = spxMove * delta;     // each $1 SPX = delta dollars on contract
  if (contractMid <= 0) return 0;
  return (dollarGainPerShare / contractMid) * 100;
}

// ─── Scoring ──────────────────────────────────────────────────────────────
// Wire 16: MIN_FIRE_SCORE = 72 (B-). Was 75 (B+) in Wire 15.
// Letter mapping: 72-74 -> B-, 75-79 -> B+, 80-84 -> A-, 85-89 -> A, 90+ -> A+
export const MIN_FIRE_SCORE = 72;  // Wire 16: lowered from 75 (B+) to 72 (B-)

function letterGrade(score: number): string {
  if (score >= 90) return "A+";
  if (score >= 85) return "A";
  if (score >= 80) return "A−";
  if (score >= 75) return "B+";
  if (score >= 72) return "B−";   // Wire 16: B- fire band
  if (score >= 50) return "C";
  return "F";
}

function scoreSetup(args: {
  setup: OdteSetupKind;
  side: Side;
  spot: number;
  audit: Audit;
  contract: ContractRow;
  t1Pts: number;          // distance to T1 in SPX points
  stopPts: number;        // distance to stop in SPX points
  hourET: number;         // 0-23 ET
  minuteET: number;
  eventDayKind?: string | null;
  eventGateActions?: string[];
}): { score: number; reasoning: string[] } {
  const reasoning: string[] = [];
  let score = 0;

  // 1. Pattern present (binary)
  score += 20;
  reasoning.push(`pattern ${args.setup}: +20`);

  // 2. Regime (γ-zone) alignment
  // Reversion setups (FAILED_BREAK, WALL_REJECT) prefer γ+ (dampened).
  // Momentum setups (PIVOT_RECLAIM) prefer γ− (volatile).
  const isReversion = args.setup === "FAILED_BREAK" || args.setup === "WALL_REJECT";
  const gz = args.audit.gammaZone;
  if (gz) {
    if ((isReversion && gz === "y+") || (!isReversion && gz === "y-")) {
      score += 15;
      reasoning.push(`γ-zone ${gz} aligned: +15`);
    } else if (!isReversion && gz === "y+") {
      score -= 5;
      reasoning.push(`γ-zone y+ dampening headwind for ${args.setup} (Adams 2025: MM counter-directional hedging): -5`);
    } else if (gz) {
      score += 5;
      reasoning.push(`γ-zone ${gz} mixed: +5`);
    }
  }

  // 3-5. Momentum signals (DFI, slope, vanna). REQUIRE ≥2 of 3 aligned
  // with trade direction — otherwise zero out the whole bundle and add a
  // big negative reasoning entry that effectively kills the grade.
  const wantSign = args.side === "call" ? 1 : -1;
  let momAligned = 0;
  let momScore = 0;
  const momReasons: string[] = [];

  const dfi = args.audit.dfi;
  if (typeof dfi === "number" && isFinite(dfi)) {
    if (Math.sign(dfi) === wantSign) {
      const mag = Math.min(15, Math.abs(dfi) / 30);
      momScore += mag; momAligned += 1;
      momReasons.push(`DFI ${dfi.toFixed(0)} aligned: +${mag.toFixed(1)}`);
    } else {
      momReasons.push(`DFI ${dfi.toFixed(0)} opposed/flat: +0`);
    }
  }

  const slope = args.audit.slope;
  if (typeof slope === "number" && isFinite(slope) && slope !== 0) {
    if (Math.sign(slope) === wantSign) {
      momScore += 10; momAligned += 1;
      momReasons.push(`slope aligned: +10`);
    } else {
      momReasons.push(`slope opposed: +0`);
    }
  }

  // Upgrade 2: Vanna magnitude (log-scaled, replaces binary +10)
  try {
    const vb = args.audit.vannaBias;
    const vannaM = args.audit.vannaM;
    if (typeof vb === "number" && isFinite(vb) && Math.abs(vb) > 0.05) {
      const vannaAligned = Math.sign(vb) === wantSign;
      let vannaBonus: number;
      if (typeof vannaM === "number" && isFinite(vannaM) && vannaM !== 0) {
        // Log-scaled magnitude: sign(aligned) * min(8, log(1+|vannaM|)*2)
        const raw = Math.min(8, Math.log(1 + Math.abs(vannaM)) * 2);
        vannaBonus = vannaAligned ? raw : -raw;
      } else {
        // Fallback to flat ±8 if no magnitude data
        vannaBonus = vannaAligned ? 8 : -8;
      }
      // Bound to ±10
      vannaBonus = Math.max(-10, Math.min(10, vannaBonus));
      if (vannaAligned) {
        momScore += vannaBonus; momAligned += 1;
        momReasons.push(`vanna bias aligned (mag ${vannaM != null ? Math.abs(vannaM).toFixed(1) : "?"} $M): +${vannaBonus.toFixed(1)}`);
      } else {
        momReasons.push(`vanna bias opposed: ${vannaBonus.toFixed(1)}`);
      }
    }
  } catch (_) {
    reasoning.push("vannaM unavailable, skipped");
  }

  if (momAligned >= 2) {
    score += momScore;
    reasoning.push(...momReasons);
    reasoning.push(`momentum confluence: ${momAligned}/3 aligned (gate passed)`);
  } else {
    // Hard kill — banger gate failed. Drop ~30 pts so this can't slip through.
    reasoning.push(...momReasons);
    reasoning.push(`momentum confluence: ${momAligned}/3 aligned (BANGER GATE FAILED — −2 of 3 required)`);
    score -= 30;
  }

  // Upgrade 2 (cont): Volga-pocket adjacency bonus
  try {
    const pockets = args.audit.vommaPockets;
    if (Array.isArray(pockets) && pockets.length > 0) {
      const nearPocket = pockets.some((p) => Math.abs(args.contract.strike - p) <= 5);
      if (nearPocket) {
        const volgaDelta = Math.max(-10, Math.min(10, 4));
        score += volgaDelta;
        reasoning.push(`volga pocket adjacency at strike ${args.contract.strike}: +${volgaDelta}`);
      }
    }
  } catch (_) {
    reasoning.push("vommaPockets unavailable, skipped");
  }

  // 6. Risk:reward
  if (args.t1Pts > 0 && args.stopPts > 0) {
    const rr = args.t1Pts / args.stopPts;
    if (rr >= 3) { score += 15; reasoning.push(`R:R ${rr.toFixed(1)}:1 elite: +15`); }
    else if (rr >= 2) { score += 10; reasoning.push(`R:R ${rr.toFixed(1)}:1 strong: +10`); }
    else if (rr >= 1.5) { score += 5; reasoning.push(`R:R ${rr.toFixed(1)}:1 ok: +5`); }
    else { reasoning.push(`R:R ${rr.toFixed(1)}:1 weak: +0`); }
  }

  // 7. Liquidity
  const c = args.contract;
  const spread = (c.ask ?? 0) - (c.bid ?? 0);
  const mid = c.mid ?? c.last ?? 0;
  const spreadPct = mid > 0 ? spread / mid : 1;
  let liq = 0;
  if (spreadPct < 0.05) liq += 5;
  else if (spreadPct < 0.10) liq += 3;
  if (c.openInterest >= 1000) liq += 3;
  else if (c.openInterest >= 500) liq += 2;
  if (c.volume >= 500) liq += 2;
  else if (c.volume >= 200) liq += 1;
  score += liq;
  reasoning.push(`liquidity (spread ${(spreadPct * 100).toFixed(1)}% · OI ${c.openInterest} · vol ${c.volume}): +${liq}`);

  // 8. Time of day — reward 9:45–11:30 ET and 13:30–15:30 ET
  const tod = args.hourET * 60 + args.minuteET;
  const morningOk = tod >= 9 * 60 + 45 && tod <= 11 * 60 + 30;
  const afternoonOk = tod >= 13 * 60 + 30 && tod <= 15 * 60 + 30;
  if (morningOk || afternoonOk) {
    score += 5;
    reasoning.push(`time-of-day prime: +5`);
  } else if (tod >= 15 * 60 + 31 && tod <= 15 * 60 + 59) {
    reasoning.push(`time-of-day late chop: +0`);
  }

  // ─── UPGRADE 1: VRP gate (vol risk premium) ───────────────────────────────────
  try {
    const suppressVRP = !!args.eventDayKind &&
      (args.eventGateActions ?? []).includes("SUPPRESS_VRP_GATE");
    if (suppressVRP) {
      reasoning.push(`VRP gate: SUPPRESSED — ${args.eventDayKind} event day (Wright 2020). IV inflated by risk premium.`);
      // skip VRP scoring entirely; do NOT add/subtract anything
    } else {
      const realizedSigma = args.audit.realizedSigma20d;
      const impliedIV = args.contract.iv;
      if (
        typeof realizedSigma === "number" && isFinite(realizedSigma) && realizedSigma > 0 &&
        typeof impliedIV === "number" && isFinite(impliedIV) && impliedIV > 0
      ) {
        // Both are already annualized fractions (e.g. 0.18 = 18%); convert to pp
        const vrp = (impliedIV - realizedSigma) * 100;
        let vrpDelta = 0;
        let vrpDesc = "neutral";
        if (args.setup === "WALL_REJECT") {
          // Fades favored when IV rich
          if (vrp > 5)       { vrpDelta = +6; vrpDesc = "IV rich, fades favored"; }
          else if (vrp < -2) { vrpDelta = -6; vrpDesc = "RV rich, walls likely to break"; }
        } else {
          // FAILED_BREAK / PIVOT_RECLAIM: momentum flips
          if (vrp > 5)       { vrpDelta = -6; vrpDesc = "IV rich, momentum headwind"; }
          else if (vrp < -2) { vrpDelta = +6; vrpDesc = "RV rich, momentum favored"; }
        }
        // Bound ±10
        vrpDelta = Math.max(-10, Math.min(10, vrpDelta));
        if (vrpDelta !== 0) score += vrpDelta;
        reasoning.push(
          `VRP gate: IV-RV=${vrp.toFixed(1)}pp, ${vrpDesc} for ${args.setup}` +
          (vrpDelta !== 0 ? ` (${vrpDelta > 0 ? "+" : ""}${vrpDelta})` : " (neutral, no tilt)"),
        );
      } else {
        reasoning.push("VRP gate: realizedSigma or IV unavailable, skipped");
      }
    }
  } catch (_) {
    reasoning.push("VRP gate: error computing VRP, skipped");
  }

  // ─── UPGRADE 3: 10:00 AM regime tilt (Vilkov) ────────────────────────────
  try {
    const todMin = args.hourET * 60 + args.minuteET;
    const expireVilkov = !!args.eventDayKind &&
      (args.eventGateActions ?? []).includes("EXPIRE_VILKOV_AT_1330");
    const vilkovExpired = expireVilkov && todMin >= 13 * 60 + 30;
    if (vilkovExpired) {
      reasoning.push(`10AM Vilkov tilt: EXPIRED — FOMC at 14:00 invalidates morning regime read.`);
      // skip Vilkov tilt scoring
    } else {
      const inVilkovWindow = todMin >= 10 * 60 && todMin <= 11 * 60 + 30; // 10:00–11:30 ET
      if (tenAmRegime !== null && inVilkovWindow) {
        // Derive regime direction: DFI positive = bullish; spot above mainPivot = bullish
        const regimeBullByDfi  = typeof tenAmRegime.dfi === "number" && tenAmRegime.dfi > 0;
        const regimeBullByPivot = typeof tenAmRegime.spot === "number" &&
                                  typeof tenAmRegime.mainPivot === "number" &&
                                  tenAmRegime.spot > tenAmRegime.mainPivot;
        // Require both signals to agree to apply a tilt (single disagreement = neutral)
        const regimeBull  = regimeBullByDfi && regimeBullByPivot;
        const regimeBear  = !regimeBullByDfi && !regimeBullByPivot;
        if (regimeBull || regimeBear) {
          const regimeWantSign = regimeBull ? 1 : -1;
          const alertSign      = args.side === "call" ? 1 : -1;
          const aligned        = regimeWantSign === alertSign;
          const regimeDelta    = aligned ? +5 : -7;
          // Bound ±10
          const clampedRegimeDelta = Math.max(-10, Math.min(10, regimeDelta));
          score += clampedRegimeDelta;
          reasoning.push(
            `10AM regime tilt: ${aligned ? "aligned" : "fighting"} 10AM snapshot ` +
            `(DFI ${tenAmRegime.dfi.toFixed(0)}, spot ${tenAmRegime.spot.toFixed(1)} vs pivot ${tenAmRegime.mainPivot.toFixed(1)}): ` +
            `${clampedRegimeDelta > 0 ? "+" : ""}${clampedRegimeDelta}`,
          );
        } else {
          reasoning.push("10AM regime tilt: regime signals mixed, no tilt applied");
        }
      } else if (tenAmRegime === null) {
        reasoning.push("10AM regime tilt: no 10AM snapshot yet, skipped");
      }
      // Outside 10:00–11:30 window — silent (no bullet cluttering late-day alerts)
    }
  } catch (_) {
    reasoning.push("10AM regime tilt: error applying regime tilt, skipped");
  }

  // ─── UPGRADE 4: Jump-zone window adjustment (Bozovic) ────────────────────────
  try {
    const todMin = args.hourET * 60 + args.minuteET;
    // Open jump zone:   9:45–10:30 (585–630)
    const inOpenJump   = todMin >= 585 && todMin <= 630;
    // Close jump zone: 15:00–15:45 (900–945)
    const inCloseJump  = todMin >= 900 && todMin <= 945;
    // Diffusion window: 11:30–14:00 (690–840)
    const inDiffusion  = todMin >= 690 && todMin <= 840;

    if (inOpenJump || inCloseJump) {
      const zone = inOpenJump ? "open jump zone" : "close jump zone";
      if (args.setup === "WALL_REJECT") {
        const jzDelta = Math.max(-10, Math.min(10, -3));
        score += jzDelta;
        reasoning.push(`jump-zone window: ${zone} disfavors WALL_REJECT (${jzDelta})`);
      } else {
        const jzDelta = Math.max(-10, Math.min(10, +5));
        score += jzDelta;
        reasoning.push(`jump-zone window: ${zone} favors ${args.setup} (+${jzDelta})`);
      }
    } else if (inDiffusion) {
      if (args.setup === "WALL_REJECT") {
        const jzDelta = Math.max(-10, Math.min(10, +5));
        score += jzDelta;
        reasoning.push(`jump-zone window: diffusion window favors WALL_REJECT fades (+${jzDelta})`);
      } else {
        const jzDelta = Math.max(-10, Math.min(10, -3));
        score += jzDelta;
        reasoning.push(`jump-zone window: diffusion window disfavors ${args.setup} (${jzDelta})`);
      }
    }
    // Outside all zones — no bullet (quiet)
  } catch (_) {
    reasoning.push("jump-zone window: error computing window tilt, skipped");
  }

  // ─── UPGRADE 6: Wick-zone proximity (intraday session pivot) ────────────────
  // Spot inside wick band → reversion setups get a boost (FAILED_BREAK,
  // WALL_REJECT). Spot outside band → momentum setups (PIVOT_RECLAIM) get a
  // boost. Within ±halfWidth/2 of pivot exactly = neutral chop, neutral.
  try {
    const wz = args.audit.wickZones;
    if (wz && typeof wz.pivot === "number" && typeof wz.halfWidth === "number" && wz.halfWidth > 0) {
      const dist = Math.abs(args.spot - wz.pivot);
      const inBand = dist <= wz.halfWidth;
      const inDeepInner = dist <= wz.halfWidth * 0.45; // dead-center chop
      const isReversionSetup = args.setup === "FAILED_BREAK" || args.setup === "WALL_REJECT";

      if (inDeepInner) {
        // Right at pivot — neutral, slight penalty for reversion (no edge to fade)
        if (isReversionSetup) {
          const wickDelta = -2;
          score += wickDelta;
          reasoning.push(`wick-zone deep inner (Δ${dist.toFixed(1)}pt from pivot ${wz.pivot}): no fade edge, ${wickDelta}`);
        }
      } else if (inBand) {
        // In the wick band but off center → prime reversion territory
        if (isReversionSetup) {
          const wickDelta = Math.max(-10, Math.min(10, +6));
          score += wickDelta;
          reasoning.push(`wick-zone hit (${wz.source}, Δ${dist.toFixed(1)}pt of ${wz.halfWidth}pt half-width): +${wickDelta}`);
        } else {
          // Momentum setup inside band = fighting the magnet
          const wickDelta = -3;
          score += wickDelta;
          reasoning.push(`wick-zone trap (momentum inside ${wz.source} band): ${wickDelta}`);
        }
      } else {
        // Outside band → favor momentum (PIVOT_RECLAIM)
        if (!isReversionSetup) {
          const wickDelta = +4;
          score += wickDelta;
          reasoning.push(`outside wick-band (${dist.toFixed(1)}pt from ${wz.source} pivot ${wz.pivot}): +${wickDelta}`);
        }
      }
    }
  } catch (_) {
    reasoning.push("wick-zone proximity: error computing, skipped");
  }

  // ─── UPGRADE 7: EOD-GEX gate (Baltussen JFE 2021) ─────────────────────────────────────
  try {
    const todMin = args.hourET * 60 + args.minuteET;
    const eodWindow = todMin >= 15 * 60 + 30 && todMin <= 15 * 60 + 55;
    const gex = args.audit.gex;
    if (eodWindow && typeof gex === "number" && isFinite(gex)) {
      const gexNeg = gex < 0;
      if (gexNeg) {
        if (!isReversion) { score += 7; reasoning.push(`EOD GEX ${gex.toFixed(0)}M < 0: dealer short-γ momentum window — ${args.setup} +7`); }
        else { score -= 5; reasoning.push(`EOD GEX ${gex.toFixed(0)}M < 0 favors momentum, not reversion ${args.setup}: -5`); }
      } else {
        if (isReversion) { score += 7; reasoning.push(`EOD GEX ${gex.toFixed(0)}M ≥ 0: dealer long-γ reversion window — ${args.setup} +7`); }
        else { score -= 5; reasoning.push(`EOD GEX ${gex.toFixed(0)}M ≥ 0 favors dampening, not momentum ${args.setup}: -5`); }
      }
    }
  } catch (_) { reasoning.push("EOD-GEX gate: skipped"); }

  // ─── UPGRADE 8: GTBR state gate (Park & Zhao UTDallas 2025) ─────────────────────
  try {
    const gex = args.audit.gex;
    const sessionOpen = args.audit.sessionOpen;
    const atmIV = args.audit.atmIV;
    if (typeof gex === "number" && isFinite(gex) &&
        typeof sessionOpen === "number" && isFinite(sessionOpen) && sessionOpen > 0 &&
        typeof atmIV === "number" && isFinite(atmIV) && atmIV > 0) {
      const todMin = args.hourET * 60 + args.minuteET;
      const minutesElapsed = Math.max(1, todMin - (9 * 60 + 30));
      const sessionFraction = Math.min(0.99, minutesElapsed / 390);
      const gtbrBase = args.spot * atmIV * Math.sqrt(1 / 252);
      const gtbrAdj = gtbrBase * Math.sqrt(1 - sessionFraction);
      const sessionMove = Math.abs(args.spot - sessionOpen);
      const outsideGTBR = sessionMove >= gtbrAdj;
      const shortGamma = gex < 0;
      if (shortGamma && outsideGTBR) {
        if (!isReversion) { score += 8; reasoning.push(`GTBR breached (move ${sessionMove.toFixed(1)} ≥ ${gtbrAdj.toFixed(1)}pt) + short-γ: forced-hedge momentum +8`); }
        else { score -= 6; reasoning.push(`GTBR breached + short-γ: reversion ${args.setup} fighting forced-hedge momentum -6`); }
      } else if (shortGamma && !outsideGTBR) {
        if (!isReversion) { score -= 5; reasoning.push(`GTBR inside (move ${sessionMove.toFixed(1)} < ${gtbrAdj.toFixed(1)}pt): theta covers γ losses, momentum dormant -5`); }
      } else if (!shortGamma && outsideGTBR) {
        if (isReversion) { score += 7; reasoning.push(`GTBR breached + long-γ: reversion confirmed +7`); }
        else { score -= 5; reasoning.push(`GTBR breached + long-γ: momentum disfavored -5`); }
      }
    }
  } catch (_) { reasoning.push("GTBR gate: skipped"); }

  // ─── WIRE 7: VWAP/POC Confluence (Maróy 2025 + arxiv 2406.17198) ─────────────────────
  // Paper F: VWAP as trailing-stop discipline; fighting VWAP = -8 (skewness flip)
  // Paper O: Volume profile POC/VAH/VAL as confluence anchors
  try {
    const vp = args.audit.vwapProfile;
    if (vp && typeof vp.vwap === "number" && isFinite(vp.vwap) && vp.vwap > 0) {
      const isMomentum = args.setup === "PIVOT_RECLAIM";
      const wantSign = args.side === "call" ? 1 : -1;
      const aboveAligned = wantSign === 1 ? vp.aboveVwap : !vp.aboveVwap;
      const atVwap = Math.abs(vp.spotVsVwap) < 0.0005;          // <0.05% from VWAP
      const extremeDeviation = Math.abs(vp.spotVsVwap) > 0.003;  // >0.3%
      const pocProximity = vp.pocDist <= 1.0;                    // within 1 pt
      let vpDelta = 0;
      const vpReasons: string[] = [];

      if (atVwap || pocProximity) {
        vpReasons.push(`VWAP/POC neutral zone (Δ ${(vp.spotVsVwap * 100).toFixed(2)}%, POC dist ${vp.pocDist.toFixed(1)}): 0`);
      } else if (isMomentum) {
        if (aboveAligned) {
          vpDelta = +5;
          vpReasons.push(`VWAP momentum aligned (spot ${vp.aboveVwap ? "above" : "below"} VWAP ${vp.vwap.toFixed(1)}): +5`);
        } else if (vp.inValueArea) {
          // Paper F asymmetric penalty: fighting VWAP inside value area = worst case
          vpDelta = -8;
          vpReasons.push(`VWAP trap (Maróy): ${args.side.toUpperCase()} fighting VWAP ${vp.vwap.toFixed(1)} inside value area: -8`);
        } else {
          vpDelta = -4;
          vpReasons.push(`VWAP fighting outside value area (Δ ${(vp.spotVsVwap * 100).toFixed(2)}%): -4`);
        }
      } else { // reversion (FAILED_BREAK or WALL_REJECT)
        if (vp.inValueArea) {
          vpDelta = +4;
          vpReasons.push(`reversion to POC ${vp.poc.toFixed(1)} inside value area [${vp.val.toFixed(1)}-${vp.vah.toFixed(1)}]: +4`);
        } else if (extremeDeviation) {
          vpDelta = +2;
          vpReasons.push(`extreme VWAP deviation (${(vp.spotVsVwap * 100).toFixed(2)}%) — mean reversion: +2`);
        } else {
          vpDelta = -2;
          vpReasons.push(`reversion outside value area, modest deviation (${(vp.spotVsVwap * 100).toFixed(2)}%): -2`);
        }
      }
      vpDelta = Math.max(-8, Math.min(6, vpDelta));   // cap matches per VERDICT.md
      score += vpDelta;
      reasoning.push(...vpReasons);
    } else {
      reasoning.push("VWAP/POC wire: vwapProfile unavailable, skipped");
    }
  } catch (_) {
    reasoning.push("VWAP/POC wire: error, skipped");
  }

  // ─── WIRE 8: Paper E re-engineered — VWAP exhaustion entry penalty ──────────────────────
  // Zarattini (2024) originally used VWAP stretch as an exit discipline.
  // Re-engineered as entry filter: spot stretched ≥2σ from VWAP in entry direction
  // = chasing exhaustion territory. Penalise momentum setups (PIVOT_RECLAIM) only.
  try {
    const vp = args.audit.vwapProfile;
    if (vp && vp.vwapStretchZ != null && Math.abs(vp.vwapStretchZ) >= 2) {
      const isMomentumSetup = args.setup === "PIVOT_RECLAIM";
      if (isMomentumSetup) {
        // call = long entry; put = short entry
        const stretchedAbove = vp.vwapStretchZ >= 2;   // spot high above VWAP
        const stretchedBelow = vp.vwapStretchZ <= -2;  // spot deep below VWAP
        const isCallEntry = args.side === "call";
        const isPutEntry  = args.side === "put";
        if ((isCallEntry && stretchedAbove) || (isPutEntry && stretchedBelow)) {
          score -= 3;
          args.audit.wire8VwapExhaustionPenalty = -3;
          args.audit.wire8VwapStretchZ = vp.vwapStretchZ;
          reasoning.push(
            `Wire 8 VWAP exhaustion (Paper E): ${args.side.toUpperCase()} entry ` +
            `stretched ${vp.vwapStretchZ.toFixed(2)}σ ${stretchedAbove ? "above" : "below"} VWAP — chasing exhaustion: -3`,
          );
        }
      }
    }
  } catch (_) {
    reasoning.push("Wire 8 VWAP exhaustion: error, skipped");
  }

  // ─── WIRE 9 — Paper M re-engineered: jump regime momentum boost ─────────────────────────
  // When 3+ jump features trigger, momentum setups outperform mean-reversion
  try {
    if (args.audit.jumpRegime === true) {
      if (args.setup === "PIVOT_RECLAIM") {
        score += 3;
        args.audit.wire9JumpBoost = 3;
        reasoning.push(
          `Wire 9 jump regime (Paper M): PIVOT_RECLAIM (momentum) in jump regime ` +
          `(score ${args.audit.jumpScore ?? "?"}/4): +3`,
        );
      } else if (args.setup === "WALL_REJECT" || args.setup === "FAILED_BREAK") {
        score -= 2;
        args.audit.wire9JumpPenalty = -2;
        reasoning.push(
          `Wire 9 jump regime (Paper M): ${args.setup} (mean-reversion) underperforms ` +
          `in jump regime (score ${args.audit.jumpScore ?? "?"}/4): -2`,
        );
      }
    }
  } catch (_) {
    reasoning.push("Wire 9 jump regime: error, skipped");
  }

  // ─── WIRE 10 — Paper C re-engineered: chop regime regime-flip ─────────────────────
  // 3+ failed breaks in 60min = chop regime → mean-reversion outperforms
  try {
    if (args.audit.chopRegime === true) {
      if (args.setup === 'PIVOT_RECLAIM') {
        score -= 4;  // momentum gets crushed in chop
        args.audit.wire10ChopMomentumPenalty = -4;
        reasoning.push(
          `Wire 10 chop regime (Paper C): PIVOT_RECLAIM (momentum) crushed in chop ` +
          `(failed breaks 60m=${args.audit.chopFailedBreakCount ?? '?'}): -4`,
        );
      } else if (args.setup === 'WALL_REJECT' || args.setup === 'FAILED_BREAK') {
        score += 3;  // mean-reversion flourishes
        args.audit.wire10ChopMeanRevBoost = 3;
        reasoning.push(
          `Wire 10 chop regime (Paper C): ${args.setup} (mean-reversion) flourishes in chop ` +
          `(failed breaks 60m=${args.audit.chopFailedBreakCount ?? '?'}): +3`,
        );
      }
    }
  } catch (_) {
    reasoning.push("Wire 10 chop regime: error, skipped");
  }

  // ─── WIRE 11 — Paper L re-engineered: VIX/SPX correlation breakdown ────────
  // VIX up + SPX up = institutions hedging into rally (TOP_SIGNAL: rally about to fail)
  // VIX down + SPX down = panic exhausting (BOTTOM_SIGNAL: selloff losing fear)
  try {
    if (args.audit.correlationBreakdown === true) {
      const isCallSide = args.side === 'call';
      if (args.audit.correlationBreakdownDirection === 'TOP_SIGNAL') {
        // Long entries are chasing a rally smart money is fading
        if (isCallSide) {
          score -= 4;
          args.audit.wire11CorrelationBreakdownPenalty = -4;
          reasoning.push(
            `Wire 11 corr-breakdown (Paper L): TOP_SIGNAL — VIX+SPX both up, smart money hedging rally. ` +
            `Call side chasing rally smart money fades: -4 ` +
            `(vix5m=${args.audit.vixPctChange5m?.toFixed(2) ?? '?'}% spx5m=${args.audit.spxPctChange5m?.toFixed(2) ?? '?'}%)`,
          );
        } else {
          score += 4;
          args.audit.wire11CorrelationBreakdownBoost = 4;
          reasoning.push(
            `Wire 11 corr-breakdown (Paper L): TOP_SIGNAL — VIX+SPX both up, institutions hedging into rally. ` +
            `Put side aligned with smart money fade: +4 ` +
            `(vix5m=${args.audit.vixPctChange5m?.toFixed(2) ?? '?'}% spx5m=${args.audit.spxPctChange5m?.toFixed(2) ?? '?'}%)`,
          );
        }
      } else if (args.audit.correlationBreakdownDirection === 'BOTTOM_SIGNAL') {
        // Short entries chasing a selloff that is losing fear
        if (!isCallSide) {
          score -= 4;
          args.audit.wire11CorrelationBreakdownPenalty = -4;
          reasoning.push(
            `Wire 11 corr-breakdown (Paper L): BOTTOM_SIGNAL — VIX+SPX both down, panic exhausting. ` +
            `Put side chasing selloff that is losing fear: -4 ` +
            `(vix5m=${args.audit.vixPctChange5m?.toFixed(2) ?? '?'}% spx5m=${args.audit.spxPctChange5m?.toFixed(2) ?? '?'}%)`,
          );
        } else {
          score += 4;
          args.audit.wire11CorrelationBreakdownBoost = 4;
          reasoning.push(
            `Wire 11 corr-breakdown (Paper L): BOTTOM_SIGNAL — VIX+SPX both down, capitulation exhausting. ` +
            `Call side aligned with bottom signal: +4 ` +
            `(vix5m=${args.audit.vixPctChange5m?.toFixed(2) ?? '?'}% spx5m=${args.audit.spxPctChange5m?.toFixed(2) ?? '?'}%)`,
          );
        }
      }
    }
  } catch (_) {
    reasoning.push("Wire 11 correlation breakdown: error, skipped");
  }

  // ─── WIRE 12 — S/D zones with volume + freshness gating ──────────────────────────────────
  // Drop-base-rally / rally-base-drop pattern on 1-min Schwab bars.
  // Scoring per nearest zone (per-candidate based on args.side):
  //   UNTESTED + vol confirmed + fresh (<15min) → +3
  //   UNTESTED + vol confirmed                 → +2
  //   HELD once + vol confirmed                → +2
  //   HELD once (no vol)                       → +1
  //   HELD 2+ or no nearby zone                →  0
  try {
    if (args.audit.sdZones && args.audit.sdZones.length > 0) {
      const zones = args.audit.sdZones as any[];
      const isCall = args.side === "call";
      const candidates = zones.filter(z => {
        if (isCall) return z.type === "DEMAND" && z.proximal < args.spot && z.distal < args.spot;
        return z.type === "SUPPLY" && z.proximal > args.spot && z.distal > args.spot;
      });
      const maxDist = args.spot * 0.003;
      const inRange = candidates.filter(z => {
        const distance = isCall ? args.spot - z.proximal : z.proximal - args.spot;
        return distance > 0 && distance <= maxDist;
      });
      if (inRange.length) {
        const nearest = inRange.sort((a: any, b: any) => {
          const dA = isCall ? args.spot - a.proximal : a.proximal - args.spot;
          const dB = isCall ? args.spot - b.proximal : b.proximal - args.spot;
          return dA - dB;
        })[0];

        let boost = 0;
        if (nearest.status === "UNTESTED" && nearest.volumeConfirmed && nearest.fresh) {
          boost = 3;
        } else if (nearest.status === "UNTESTED" && nearest.volumeConfirmed) {
          boost = 2;
        } else if (nearest.status === "HELD" && nearest.volumeConfirmed && nearest.retests === 1) {
          boost = 2;
        } else if (nearest.status === "HELD" && nearest.retests === 1) {
          boost = 1;
        } else {
          boost = 0;
        }

        if (boost > 0) {
          score += boost;
          args.audit.wire12SdZoneBoost = boost;
          args.audit.wire12SdZoneInfo = {
            type: nearest.type,
            status: nearest.status,
            volumeConfirmed: nearest.volumeConfirmed,
            distance: isCall ? args.spot - nearest.proximal : nearest.proximal - args.spot,
          };
          const volTag = nearest.volumeConfirmed ? "+VOL" : "";
          reasoning.push(
            `Wire 12 S/D zone (${nearest.type} ${nearest.status}${volTag} fresh=${nearest.fresh} ` +
            `dist=${isCall ? args.spot - nearest.proximal : nearest.proximal - args.spot}pt): +${boost}`,
          );
        } else {
          reasoning.push(
            `Wire 12 S/D zone: nearest ${nearest.type} ${nearest.status} (retests=${nearest.retests}, volConf=${nearest.volumeConfirmed}) → no boost`,
          );
        }
      } else {
        reasoning.push("Wire 12 S/D zone: no zone within 0.3% of spot");
      }
    } else {
      reasoning.push("Wire 12 S/D zone: sdZones empty or unavailable, skipped");
    }
  } catch (_) {
    reasoning.push("Wire 12 S/D zone: error, skipped");
  }

  // ─── WIRE 13 — Lee-Ready OFI session-cumulative trend confluence ───────────────────────
  // Bar-level tick rule (zero-tick = persist last sign). Scoring per candidate:
  //   Aligned + accelerating  → +3
  //   Aligned                 → +2
  //   Opposed                 → -3
  //   Opposed + accelerating  → -4
  //   Neutral trend           →  0
  try {
    if (args.audit.ofiTrend) {
      const ofi = args.audit.ofiTrend;
      const isCall = args.side === "call";

      // Aligned: call + bullish trend, or put + bearish trend
      const aligned = (isCall && ofi.trend === "BULLISH") || (!isCall && ofi.trend === "BEARISH");
      // Opposed: call + bearish trend, or put + bullish trend
      const opposed = (isCall && ofi.trend === "BEARISH") || (!isCall && ofi.trend === "BULLISH");

      if (aligned) {
        // Base aligned boost = +2, bumped to +3 if accelerating
        const boost = ofi.acceleration === "ACCELERATING" ? 3 : 2;
        score += boost;
        args.audit.wire13OfiBoost = boost;
        reasoning.push(
          `Wire 13 OFI trend (Lee-Ready): ${ofi.trend} ${ofi.acceleration} aligned with ${args.side} ` +
          `(cum=${(ofi.cumulative / 1000).toFixed(1)}k 15m=${(ofi.slope15m / 1000).toFixed(1)}k ` +
          `5m=${(ofi.slope5m / 1000).toFixed(1)}k): +${boost}`,
        );
      } else if (opposed) {
        // Base opposed penalty = -3, bumped to -4 if accelerating against us
        const penalty = ofi.acceleration === "ACCELERATING" ? -4 : -3;
        score += penalty;
        args.audit.wire13OfiPenalty = penalty;
        reasoning.push(
          `Wire 13 OFI trend (Lee-Ready): ${ofi.trend} ${ofi.acceleration} opposed to ${args.side} ` +
          `(cum=${(ofi.cumulative / 1000).toFixed(1)}k 15m=${(ofi.slope15m / 1000).toFixed(1)}k ` +
          `5m=${(ofi.slope5m / 1000).toFixed(1)}k): ${penalty}`,
        );
      }
      // NEUTRAL trend: no signal, no score change
    }
  } catch (_) {
    reasoning.push("Wire 13 OFI trend: error, skipped");
  }

  // ─── WIRE 14 — T_high/T_low timing inference (Bloomberg OHLC paper, OHLC-derived) ────────
  // Infer high/low formation order from open/close as bar endpoints.
  // Scoring per candidate:
  //   strong15m aligned + last3 confirms + 3+ strong bars → +3
  //   strong15m aligned + 3+ strong bars                  → +2
  //   last3 aligned                                       → +1
  //   Symmetric penalties for opposed.
  //   BALANCED / MIXED / INDETERMINATE → no signal
  try {
    if (args.audit.wickTiming) {
      const wt = args.audit.wickTiming;
      const isCall = args.side === "call";

      // Three confluence signals at descending strength:
      // 1. strongDirection15m (last-15-min STRONG bars majority)
      // 2. last3Inference (3-bar consensus)
      // 3. latestBar.confluence (single most-recent bar)

      const strongAligned15 = (isCall && wt.strongDirection15m === "BULLISH") ||
                              (!isCall && wt.strongDirection15m === "BEARISH");
      const strongOpposed15 = (isCall && wt.strongDirection15m === "BEARISH") ||
                              (!isCall && wt.strongDirection15m === "BULLISH");

      const last3Aligned = (isCall && wt.last3Inference === "BULLISH") ||
                           (!isCall && wt.last3Inference === "BEARISH");
      const last3Opposed = (isCall && wt.last3Inference === "BEARISH") ||
                           (!isCall && wt.last3Inference === "BULLISH");

      if (strongAligned15 && last3Aligned && wt.strongCount15m >= 3) {
        const boost = 3;
        score += boost;
        args.audit.wire14WickTimingBoost = boost;
        reasoning.push(
          `Wire 14 wick timing: strong15m=${wt.strongDirection15m} last3=${wt.last3Inference} ` +
          `strongCount=${wt.strongCount15m} aligned with ${args.side}: +${boost}`,
        );
      } else if (strongAligned15 && wt.strongCount15m >= 3) {
        const boost = 2;
        score += boost;
        args.audit.wire14WickTimingBoost = boost;
        reasoning.push(
          `Wire 14 wick timing: strong15m=${wt.strongDirection15m} strongCount=${wt.strongCount15m} ` +
          `aligned with ${args.side}: +${boost}`,
        );
      } else if (last3Aligned) {
        const boost = 1;
        score += boost;
        args.audit.wire14WickTimingBoost = boost;
        reasoning.push(
          `Wire 14 wick timing: last3=${wt.last3Inference} aligned with ${args.side}: +${boost}`,
        );
      } else if (strongOpposed15 && last3Opposed && wt.strongCount15m >= 3) {
        const penalty = -3;
        score += penalty;
        args.audit.wire14WickTimingPenalty = penalty;
        reasoning.push(
          `Wire 14 wick timing: strong15m=${wt.strongDirection15m} last3=${wt.last3Inference} ` +
          `strongCount=${wt.strongCount15m} opposed to ${args.side}: ${penalty}`,
        );
      } else if (strongOpposed15 && wt.strongCount15m >= 3) {
        const penalty = -2;
        score += penalty;
        args.audit.wire14WickTimingPenalty = penalty;
        reasoning.push(
          `Wire 14 wick timing: strong15m=${wt.strongDirection15m} strongCount=${wt.strongCount15m} ` +
          `opposed to ${args.side}: ${penalty}`,
        );
      } else if (last3Opposed) {
        const penalty = -1;
        score += penalty;
        args.audit.wire14WickTimingPenalty = penalty;
        reasoning.push(
          `Wire 14 wick timing: last3=${wt.last3Inference} opposed to ${args.side}: ${penalty}`,
        );
      } else {
        // BALANCED / MIXED / INDETERMINATE → no signal
        reasoning.push(
          `Wire 14 wick timing: ${wt.strongDirection15m}/${wt.last3Inference} → no signal`,
        );
      }
    }
  } catch (_) {
    reasoning.push("Wire 14 wick timing: error, skipped");
  }

  return { score: Math.round(score), reasoning };
}

// ─── Main entry: evaluate a snapshot, return alerts that pass the gate ────

/**
 * Wire 15: pre-fetched async gate data passed into the sync buildAlert loop.
 * Populated by evaluateOdte / diagnoseOdte before the per-setup loop.
 */
export interface Wire15GateContext {
  // Gate 1: ENV veto pre-check (time-based, computed synchronously in evaluateOdte)
  // (passed in directly via args.hourET/minuteET/eventDayKind — no stored field needed)

  // Gate 2: Schwab 0DTE chain (fetched once, used per-side per-alert)
  schwabChain: any | null;              // raw Schwab OptionChainResponse or null
  todayExpKey: string | null;          // key into callExpDateMap / putExpDateMap

  // Gate 4: 5-day realized vol for IV richness gate
  rv5d: number | null;                 // annualized decimal (e.g. 0.18 = 18%)

  // Gate 5: computed gammaSlope5m (requires gex ring buffer)
  gammaSlope5m: number | null;

  // Gate 1d: vanna/charm pin levels (from args.levels filtered by kind)
  pinLevels: Array<{ price: number; kind: string }>;  // pre-filtered from args.levels
}

export interface EvalArgs {
  spot: number;
  asOf: number;            // ms timestamp
  hourET: number;
  minuteET: number;
  audit: Audit;
  levels: LevelLite[];
  contracts: ContractRow[];
  oneDayEM: number;
  expiry: string | null;
  eventDayKind?: string | null;          // "FOMC" | "NFP" | "CPI" | null
  eventGateActions?: string[];           // copy of EventGateAction strings
  wire15?: Wire15GateContext | null;     // Wire 15 pre-fetched gate data
}

export const FIRE_GATE = 80;  // A− or better — original gate score (not the fire floor)
export const MIN_FIRE_SCORE_ALIAS = MIN_FIRE_SCORE;  // Wire 16: 72 (B-) is the real fire floor
export const BANGER_MIN_PCT = 30;  // T1 projected return floor — Wire 16: 30% (was 50%)
// Independent BANGERS gate delta floor — kills lottery tickets even if pickContract loosens.
// Range chosen to bracket realistic intraday "big premium" plays:
//   < 0.20 = lotto / OTM tail. Not a banger — too dependent on miracle move.
//   > 0.70 = deep ITM hedge. Not a banger — capital-heavy, no leverage.
export const BANGER_DELTA_MIN = 0.20;
export const BANGER_DELTA_MAX = 0.70;

/**
 * Wire 15: Pre-fetch the async gate data needed by buildAlert.
 * Called once per evaluateOdte / diagnoseOdte invocation, before the setup loop.
 */
async function buildWire15Context(args: EvalArgs): Promise<Wire15GateContext> {
  // Pin levels from args.levels
  const pinKinds = new Set(["vanna", "vannaPeak", "charmTarget", "charmFlip", "charmZero"]);
  const pinLevels = args.levels
    .filter((l) => pinKinds.has(l.kind))
    .map((l) => ({ price: l.price, kind: l.kind }));

  // Gate 4: compute rv5d from Schwab daily SPX bars
  let rv5d: number | null = null;
  try {
    const { computeRv5d } = await import("./contractPicker");
    rv5d = await computeRv5d();
  } catch { /* leave null */ }

  // Gate 2 + Gate 1d: fetch Schwab 0DTE chain once
  let schwabChain: any | null = null;
  let todayExpKey: string | null = null;
  try {
    const { getOptionChain } = await import("./schwab");
    const chain = await getOptionChain("$SPX", 0);
    if (chain && !("error" in chain)) {
      schwabChain = chain;
      // Find the 0DTE expiry key (same logic as contractPicker.ts)
      const etNow = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(args.asOf));
      const [etM, etD, etY] = etNow.split("/");
      const todayEt = `${etY}-${etM}-${etD}`;
      // Find min-DTE key that starts with today's date
      const expMap = chain.callExpDateMap ?? {};
      const expKeys = Object.keys(expMap);
      let minDte = Infinity;
      for (const k of expKeys) {
        const parts = k.split(":");
        const dte = parseInt(parts[1] ?? "999", 10);
        if (parts[0] === todayEt && dte < minDte) {
          todayExpKey = k;
          minDte = dte;
        }
      }
      // Fallback: any min-DTE key
      if (!todayExpKey) {
        for (const k of expKeys) {
          const parts = k.split(":");
          const dte = parseInt(parts[1] ?? "999", 10);
          if (dte < minDte) {
            todayExpKey = k;
            minDte = dte;
          }
        }
      }
    }
  } catch { /* leave null */ }

  // Gate 5: gammaSlope5m from ring buffer
  const currentGex = args.audit.gex;
  const gammaSlope5m = (typeof currentGex === "number" && isFinite(currentGex))
    ? computeGammaSlope5m(currentGex)
    : null;
  // Also record this tick
  if (typeof currentGex === "number" && isFinite(currentGex)) {
    recordDealerGex(args.asOf, currentGex);
  }

  return { schwabChain, todayExpKey, rv5d, gammaSlope5m, pinLevels };
}

/**
 * Diagnostic surface — returns ALL candidates pre-filter, with per-candidate
 * pass/reject reasons. Used by /api/odte-alert/preview for visibility.
 * Does NOT consume rate limiter / daily cap / cooldowns.
 */
export async function diagnoseOdte(args: EvalArgs): Promise<{
  fireable: OdteAlert[];
  rejected: Array<{ alert: OdteAlert; reason: string }>;
  fireGate: number;
  bangerMinPct: number;
}> {
  // We reuse the same buildAlert pipeline by calling evaluateOdte but
  // rely on the alerts it produces (which already include grade.reasoning
  // appended by the BANGER filter when rejected). Then we re-bucket from
  // the raw `out` set by reading internal state via a side-channel.
  //
  // Simplest path: duplicate the orchestration here, mirroring evaluateOdte
  // but stopping before the cooldown/cap stage.
  const out: OdteAlert[] = [];
  recordSpot(args.asOf, args.spot);
  if (spotHistory.length < 3) {
    return { fireable: [], rejected: [], fireGate: FIRE_GATE, bangerMinPct: BANGER_MIN_PCT };
  }
  // Wire 15: pre-fetch async gate data
  const w15 = args.wire15 ?? await buildWire15Context(args);
  const argsWithW15: EvalArgs = { ...args, wire15: w15 };
  const sortedLevels = [...args.levels].sort((a, b) => a.price - b.price);
  const meaningfulKinds = new Set([
    "callWall", "putWall", "mainPivot", "charmFlip", "charmZero",
    "vanna", "vannaPeak", "t1Up", "t1Dn", "downsideTarget", "upsideTarget",
  ]);
  // Scaled proximity window — mirror evaluateOdte (max 30pt floor, 0.55% of spot)
  const DIAG_PROXIMITY_PCT = 0.0055;
  const diagProximityWindow = Math.max(30, args.spot * DIAG_PROXIMITY_PCT);
  for (const lv of args.levels) {
    if (!meaningfulKinds.has(lv.kind)) continue;
    if (Math.abs(args.spot - lv.price) > diagProximityWindow) continue;
    if (detectFailedBreak(lv.price, "above").detected) {
      recordDetection(args.asOf, "FAILED_BREAK");
      const a = buildAlert(argsWithW15, lv, "FAILED_BREAK", "call", sortedLevels);
      if (a) out.push(a);
    }
    if (detectFailedBreak(lv.price, "below").detected) {
      recordDetection(args.asOf, "FAILED_BREAK");
      const a = buildAlert(argsWithW15, lv, "FAILED_BREAK", "put", sortedLevels);
      if (a) out.push(a);
    }
  }
  const pivot = args.audit.mainPivot;
  if (typeof pivot === "number" && isFinite(pivot)) {
    const lv = args.levels.find((l) => Math.abs(l.price - pivot) < 1) ??
               { name: "MAIN PIVOT", kind: "mainPivot", price: pivot, side: "support" as const };
    if (detectFailedBreak(pivot, "above").detected) {
      recordDetection(args.asOf, "PIVOT_RECLAIM");
      const a = buildAlert(argsWithW15, lv, "PIVOT_RECLAIM", "call", sortedLevels);
      if (a) out.push(a);
    }
    if (detectFailedBreak(pivot, "below").detected) {
      recordDetection(args.asOf, "PIVOT_RECLAIM");
      const a = buildAlert(argsWithW15, lv, "PIVOT_RECLAIM", "put", sortedLevels);
      if (a) out.push(a);
    }
  }
  const callWall = args.levels.find((l) => l.kind === "callWall");
  if (callWall && detectWallReject(callWall.price, "ceiling").detected) {
    recordDetection(args.asOf, "WALL_REJECT");
    const a = buildAlert(argsWithW15, callWall, "WALL_REJECT", "put", sortedLevels);
    if (a) out.push(a);
  }
  const putWall = args.levels.find((l) => l.kind === "putWall");
  if (putWall && detectWallReject(putWall.price, "floor").detected) {
    recordDetection(args.asOf, "WALL_REJECT");
    const a = buildAlert(argsWithW15, putWall, "WALL_REJECT", "call", sortedLevels);
    if (a) out.push(a);
  }
  const fireable: OdteAlert[] = [];
  const rejected: Array<{ alert: OdteAlert; reason: string }> = [];
  for (const a of out) {
    // Maturity gate (cold-boot lookback check)
    if (spotHistory.length < 5 && a.grade.score < 85) {
      rejected.push({
        alert: a,
        reason: `INSUFFICIENT_LOOKBACK_NEEDS_A_MINUS: spotHistory.length=${spotHistory.length} < 5 AND score ${a.grade.score} < 85`,
      });
      continue;
    }
    if (spotHistory.length < 5 && a.grade.score >= 85) {
      a.grade.coldBootOverride = true;
      a.grade.reasoning.push(
        `MATURITY GATE: cold-boot override — spotHistory.length=${spotHistory.length} but score ${a.grade.score} >= 85`,
      );
    }
    if (a.grade.score < MIN_FIRE_SCORE) {
      rejected.push({ alert: a, reason: `grade ${a.grade.score} < MIN_FIRE_SCORE ${MIN_FIRE_SCORE}` });
      continue;
    }
    // BANGERS delta floor — kills lottos and deep-ITM hedges
    const d = a.contract.delta;
    if (d != null && (d < BANGER_DELTA_MIN || d > BANGER_DELTA_MAX)) {
      rejected.push({
        alert: a,
        reason: `BANGER DELTA GATE: Δ ${d.toFixed(2)} outside [${BANGER_DELTA_MIN}, ${BANGER_DELTA_MAX}] — ${d < BANGER_DELTA_MIN ? "lotto" : "deep-ITM hedge"}`,
      });
      continue;
    }
    const t1Gain = a.t1?.estPctGain ?? 0;
    if (t1Gain < BANGER_MIN_PCT) {
      rejected.push({ alert: a, reason: `BANGER FILTER: T1 +${t1Gain.toFixed(0)}% < ${BANGER_MIN_PCT}% floor` });
      continue;
    }
    fireable.push(a);
  }
  fireable.sort((a, b) => b.grade.score - a.grade.score);
  return { fireable, rejected, fireGate: FIRE_GATE, bangerMinPct: BANGER_MIN_PCT };
}

export async function evaluateOdte(args: EvalArgs): Promise<OdteAlert[]> {
  const out: OdteAlert[] = [];
  recordSpot(args.asOf, args.spot);
  if (spotHistory.length < 3) return out;

  // Wire 15: pre-fetch async gate data (chain, rv5d, gammaSlope5m)
  const w15 = args.wire15 ?? await buildWire15Context(args);
  const argsWithW15: EvalArgs = { ...args, wire15: w15 };

  // Find candidate levels for each setup type
  const sortedLevels = [...args.levels].sort((a, b) => a.price - b.price);

  // ─── Setup 1: FAILED BREAK (any meaningful level) ────
  // Try each level. Failed break ABOVE = pierced down then reclaimed up = bullish CALL.
  // Failed break BELOW = pierced up then reclaimed down = bearish PUT.
  const meaningfulKinds = new Set([
    "callWall", "putWall", "mainPivot", "charmFlip", "charmZero",
    "vanna", "vannaPeak", "t1Up", "t1Dn", "downsideTarget", "upsideTarget",
  ]);
  // Level-proximity window: was hard-coded 30pt (calibrated for ~5500 SPX = ~0.55%).
  // At 7400 SPX, 30pt is 0.4% — too tight; intraday rarely touches a wall before
  // something else fires. Scale to max(30pt, 0.55% of spot) so the relative
  // proximity stays roughly constant across regimes. Floor at 30pt so we never
  // narrow the window when spot drops below ~5500.
  const PROXIMITY_PCT = 0.0055;
  const proximityWindow = Math.max(30, args.spot * PROXIMITY_PCT);
  for (const lv of args.levels) {
    if (!meaningfulKinds.has(lv.kind)) continue;
    if (Math.abs(args.spot - lv.price) > proximityWindow) continue;  // only near levels

    // CALL trade — failed break to the downside (was above, dipped below, came back up)
    const fbCall = detectFailedBreak(lv.price, "above");
    if (fbCall.detected) {
      recordDetection(args.asOf, "FAILED_BREAK");
      const alert = buildAlert(argsWithW15, lv, "FAILED_BREAK", "call", sortedLevels);
      if (alert) out.push(alert);
    }
    const fbPut = detectFailedBreak(lv.price, "below");
    if (fbPut.detected) {
      recordDetection(args.asOf, "FAILED_BREAK");
      const alert = buildAlert(argsWithW15, lv, "FAILED_BREAK", "put", sortedLevels);
      if (alert) out.push(alert);
    }
  }

  // ─── Setup 2: PIVOT RECLAIM (main pivot or charm zero) ────
  const pivot = args.audit.mainPivot;
  if (typeof pivot === "number" && isFinite(pivot)) {
    const lv = args.levels.find((l) => Math.abs(l.price - pivot) < 1) ??
               { name: "MAIN PIVOT", kind: "mainPivot", price: pivot, side: "support" as const };
    const reclaimUp = detectFailedBreak(pivot, "above"); // identical pattern, semantics differ
    if (reclaimUp.detected) {
      recordDetection(args.asOf, "PIVOT_RECLAIM");
      const alert = buildAlert(argsWithW15, lv, "PIVOT_RECLAIM", "call", sortedLevels);
      if (alert) out.push(alert);
    }
    const reclaimDn = detectFailedBreak(pivot, "below");
    if (reclaimDn.detected) {
      recordDetection(args.asOf, "PIVOT_RECLAIM");
      const alert = buildAlert(argsWithW15, lv, "PIVOT_RECLAIM", "put", sortedLevels);
      if (alert) out.push(alert);
    }
  }

  // ─── Setup 3: WALL REJECT ────
  const callWall = args.levels.find((l) => l.kind === "callWall");
  if (callWall) {
    const rej = detectWallReject(callWall.price, "ceiling");
    if (rej.detected) {
      recordDetection(args.asOf, "WALL_REJECT");
      const alert = buildAlert(argsWithW15, callWall, "WALL_REJECT", "put", sortedLevels);
      if (alert) out.push(alert);
    }
  }
  const putWall = args.levels.find((l) => l.kind === "putWall");
  if (putWall) {
    const rej = detectWallReject(putWall.price, "floor");
    if (rej.detected) {
      recordDetection(args.asOf, "WALL_REJECT");
      const alert = buildAlert(argsWithW15, putWall, "WALL_REJECT", "call", sortedLevels);
      if (alert) out.push(alert);
    }
  }

  // ─── Filter: gate + BANGERS ONLY + per-setup cooldown + global hourly + daily cap ───
  // Sort highest-grade first so if multiple setups qualify the same tick,
  // the strongest wins the rate-limit slot.
  //
  // BANGERS ONLY (user spec):
  //   "we need to target 30% or more trades nothing less 50-100% is ideal"
  // We require T1's estimated %-gain to be ≥ BANGER_MIN_PCT (30%). T2 already
  // earns more, so we additionally bonus alerts whose T2 ≥ 50% by leaving them
  // through; the floor is enforced on T1 to guarantee the *minimum* take.
  const passed = out
    // ─── Maturity gate: cold-boot lookback check ─────────────────────────────
    // spotHistory.length < 5 = cold boot. Score < 85 (below A) → reject with
    // INSUFFICIENT_LOOKBACK_NEEDS_A_MINUS. Score >= 85 → fire with
    // coldBootOverride = true so downstream knows.
    .filter((a) => {
      if (spotHistory.length < 5) {
        if (a.grade.score < 85) {
          a.grade.reasoning.push(
            `MATURITY GATE: spotHistory.length=${spotHistory.length} < 5 AND score ${a.grade.score} < 85 — INSUFFICIENT_LOOKBACK_NEEDS_A_MINUS`,
          );
          return false; // reject — cold-boot, sub-A grade
        }
        // A- override: score >= 85, flag and let through
        console.log(`[odteAlertEngine] A- override fired with spotHistory.length=${spotHistory.length} score=${a.grade.score}`);
        a.grade.coldBootOverride = true;
        a.grade.reasoning.push(
          `MATURITY GATE: cold-boot override — spotHistory.length=${spotHistory.length} but score ${a.grade.score} >= 85 (A or better)`,
        );
      }
      return true;
    })
    .filter((a) => a.grade.score >= MIN_FIRE_SCORE)  // Wire 16: 72 (B-) floor
    .filter((a) => {
      // BANGERS delta floor — kills lottos (Δ<0.20) and deep-ITM hedges (Δ>0.70)
      const d = a.contract.delta;
      if (d != null && (d < BANGER_DELTA_MIN || d > BANGER_DELTA_MAX)) {
        a.grade.reasoning.push(
          `BANGER DELTA GATE: Δ ${d.toFixed(2)} outside [${BANGER_DELTA_MIN}, ${BANGER_DELTA_MAX}] — rejected`,
        );
        return false;
      }
      return true;
    })
    .filter((a) => {
      const t1Gain = a.t1?.estPctGain ?? 0;
      if (t1Gain < BANGER_MIN_PCT) {
        a.grade.reasoning.push(`BANGER FILTER: T1 +${t1Gain.toFixed(0)}% < ${BANGER_MIN_PCT}% floor — rejected`);
        return false;
      }
      return true;
    })
    .sort((a, b) => b.grade.score - a.grade.score);

  const fireable: OdteAlert[] = [];
  const today = etDateStr(args.asOf);
  let countToday = dailyFireCount[today] ?? 0;

  for (const a of passed) {
    if (countToday >= DAILY_CAP) {
      // Daily cap reached — stop firing for the rest of the day
      break;
    }
    if ((args.asOf - lastAnyFireAt) < HOURLY_GAP_MS) {
      // Global hourly gap not satisfied — must wait
      continue;
    }
    const key = `${a.setup}|${a.side}`;
    const last = lastFireAt[key] ?? 0;
    const lastG = lastFireGrade[key] ?? 0;
    const cooldownActive = (args.asOf - last) < SUPPRESS_MS;
    // Bypass per-setup cooldown only if grade jumped ≥10 points
    if (cooldownActive && a.grade.score < lastG + 10) continue;

    lastFireAt[key] = args.asOf;
    lastFireGrade[key] = a.grade.score;
    lastAnyFireAt = args.asOf;
    countToday += 1;
    dailyFireCount[today] = countToday;
    fireable.push(a);

    // Only fire ONE alert per evaluation tick (banger philosophy — even if
    // the engine spotted multiple A− setups simultaneously, we cherry-pick
    // the highest-graded one and let the cooldown handle the rest).
    break;
  }
  return fireable;
}

function buildAlert(
  args: EvalArgs,
  reversionLevel: LevelLite,
  setup: OdteSetupKind,
  side: Side,
  sortedLevels: LevelLite[],
): OdteAlert | null {
  // ─── Wire 15: GATE 1 — Environmental veto ─────────────────────────────────────────
  // (binary skip — returns null with reason logged to audit)
  const todMinET = args.hourET * 60 + args.minuteET;
  let envVetoReason: string | null = null;

  // Gate 1a: FOMC / CPI / NFP event day — skip until 30min after release.
  // We detect "event day" when eventDayKind is set (magnitude >= 45bps from Londono & Samadi 2025).
  // "30min after release" heuristic: FOMC at 14:00 ET = skip before 14:30; CPI/NFP at 08:30 ET
  // are pre-market so RTH is fine after 09:30. We use a simple rule: skip all day if event
  // hasn't "cleared" yet (FOMC at 14:00 = skip before 14:30; CPI/NFP at 08:30 = always clear by RTH open).
  if (!envVetoReason && args.eventDayKind) {
    const ek = args.eventDayKind.toUpperCase();
    if (ek === "FOMC" && todMinET < 14 * 60 + 30) {
      // FOMC release at 14:00 ET. Block until 14:30.
      envVetoReason = "ENV_VETO_EVENT_DAY";
    } else if ((ek === "CPI" || ek === "NFP") && todMinET < 9 * 60 + 35) {
      // Pre-market release: block only first 5 min of RTH if we somehow fire before 9:35
      envVetoReason = "ENV_VETO_EVENT_DAY";
    } else if (ek !== "FOMC" && ek !== "CPI" && ek !== "NFP") {
      // Unknown high-impact event: be conservative, skip
      envVetoReason = "ENV_VETO_EVENT_DAY";
    }
  }

  // Gate 1b: Last 90 min of session (after 14:30 ET), unless PIVOT_RECLAIM
  if (!envVetoReason && todMinET >= 14 * 60 + 30 && setup !== "PIVOT_RECLAIM") {
    envVetoReason = "ENV_VETO_END_OF_DAY";
  }

  // Gate 1c: First 5 min of session (9:30:00 – 9:34:59 ET)
  if (!envVetoReason && todMinET < 9 * 60 + 35) {
    envVetoReason = "ENV_VETO_OPEN_AUCTION";
  }

  // Gate 1d: Spot pinned within 3 SPX pts of a vanna/charm pin with >70% delta concentration
  if (!envVetoReason && args.wire15) {
    for (const pl of args.wire15.pinLevels) {
      if (Math.abs(args.spot - pl.price) <= 3) {
        // Check 0DTE delta concentration at that strike in the chain
        let deltaConc = 0;
        if (args.wire15.schwabChain && args.wire15.todayExpKey) {
          const chainSide = side === "call" ? args.wire15.schwabChain.callExpDateMap : args.wire15.schwabChain.putExpDateMap;
          const strikesObj = chainSide?.[args.wire15.todayExpKey] ?? {};
          let totalOI = 0;
          let pinOI = 0;
          for (const [strikeStr, contracts] of Object.entries(strikesObj as Record<string, any[]>)) {
            const sk = parseFloat(strikeStr);
            const oi = (contracts as any[])[0]?.openInterest ?? 0;
            totalOI += oi;
            if (Math.abs(sk - pl.price) <= 2.5) pinOI += oi;
          }
          if (totalOI > 0) deltaConc = pinOI / totalOI;
        }
        if (deltaConc > 0.70) {
          envVetoReason = "ENV_VETO_PIN";
          break;
        }
      }
    }
  }

  if (envVetoReason) {
    // Return a "rejected" alert (null return) — gate reason surfaced in audit
    // We store the veto reason but since buildAlert must return OdteAlert | null,
    // we return null. The reason is logged in the gate context.
    console.log(`[wire15:gate1] ${setup}/${side} rejected: ${envVetoReason} (tod=${args.hourET}:${String(args.minuteET).padStart(2,'0')} eventDay=${args.eventDayKind ?? 'none'})`);
    return null;
  }

  // ─── Wire 15: GATE 2 — Contract picker (delta 0.35–0.50 band) ─────────────────────
  // T1/T2 levels needed first for strike preference.
  const above = sortedLevels.filter((l) => l.price > args.spot + 1);
  const below = sortedLevels.filter((l) => l.price < args.spot - 1).reverse();
  const t1Lv = side === "call" ? above[0] : below[0];
  const t2Lv = side === "call" ? above[1] : below[1];
  if (!t1Lv) return null;

  // ─── Wire 16: GEX MAGNITUDE GATE (4-tier) ─────────────────────────────────────────
  // audit.gex is in $M (e.g. 500 = $500M). Thresholds in spec are raw dollars:
  //   THIN  < $300M   → hard reject (no A-(85) override)
  //   LIGHT < $750M   → reject unless score >= 85 (checked post-scoring)
  //   SOFT  < $1.5B   → pass with 0.85x projection degrade
  //   FULL  >= $1.5B  → clean pass
  let w16GexTier: "THIN" | "LIGHT" | "SOFT" | "FULL" | null = null;
  let w16AbsGex: number | null = null;
  let w16GexLightDegrade = false;
  let w16GexLightOverride = false;
  let w16GexLightPending = false; // LIGHT tier: final check happens post-scoring

  {
    const rawGexM = typeof args.audit.gex === "number" && isFinite(args.audit.gex) ? args.audit.gex : null;
    if (rawGexM !== null) {
      // Convert $M to raw dollars
      const absGexDollars = Math.abs(rawGexM) * 1_000_000;
      w16AbsGex = absGexDollars;
      if (absGexDollars < 300_000_000) {
        w16GexTier = "THIN";
      } else if (absGexDollars < 750_000_000) {
        w16GexTier = "LIGHT";
        w16GexLightPending = true;
      } else if (absGexDollars < 1_500_000_000) {
        w16GexTier = "SOFT";
      } else {
        w16GexTier = "FULL";
      }
    } else {
      // No GEX data available: treat as FULL (no block)
      w16GexTier = "FULL";
    }
  }

  // THIN: hard reject, NO override for any score
  if (w16GexTier === "THIN") {
    console.log(`[wire16:gex_thin] ${setup}/${side} hard rejected: GEX_TOO_THIN_LT_300M absGex=${w16AbsGex}`);
    return null;
  }

  // ─── Wire 16: ANTI-CHASE RULE ─────────────────────────────────────────────────────
  // Reject if 15-min realized move >= 60% of T1 distance AND move direction matches side.
  // A-(85) override allowed (checked post-scoring).
  let w16Realized15mMove: number | null = null;
  let w16DistanceToT1: number | null = null;
  let w16ChaseRatio: number | null = null;
  let w16ChaseOverride = false;
  let w16ChasePending = false; // pending A-(85) override check

  {
    const spot15mAgo = getSpotPriceAtTs(args.asOf - 15 * 60_000, 90_000);
    if (spot15mAgo !== null) {
      const realized15m = Math.abs(args.spot - spot15mAgo);
      const distToT1 = Math.abs(t1Lv.price - args.spot);
      w16Realized15mMove = realized15m;
      w16DistanceToT1 = distToT1;
      if (distToT1 >= 1) {
        const chaseRatio = realized15m / distToT1;
        w16ChaseRatio = chaseRatio;
        if (chaseRatio >= 0.60) {
          const moveUp = args.spot > spot15mAgo;
          const moveMatchesSide = (side === "call" && moveUp) || (side === "put" && !moveUp);
          if (moveMatchesSide) {
            w16ChasePending = true; // will reject unless score >= 85
          }
        }
      }
    }
  }


  // Try picking from Schwab chain via wire15 context
  let pickedContract: {
    strike: number; delta: number; gamma: number; theta: number; vega: number;
    midPrice: number; iv: number; bid: number | null; ask: number | null;
    key: string; expiry: string; openInterest: number; volume: number;
  } | null = null;

  if (args.wire15?.schwabChain && args.wire15.todayExpKey) {
    const expMap = (side === "call"
      ? args.wire15.schwabChain.callExpDateMap
      : args.wire15.schwabChain.putExpDateMap) ?? {};
    const strikesObj = expMap[args.wire15.todayExpKey] ?? {};
    const bandCandidates: typeof pickedContract[] = [];
    for (const [strikeStr, contracts] of Object.entries(strikesObj as Record<string, any[]>)) {
      const sk = parseFloat(strikeStr);
      if (!isFinite(sk)) continue;
      const c0 = (contracts as any[])[0];
      if (!c0) continue;
      const delta: number = typeof c0.delta === "number" ? c0.delta : 0;
      const absDelta = Math.abs(delta);
      if (absDelta < 0.35 || absDelta > 0.50) continue;
      const bid: number | null = typeof c0.bid === "number" ? c0.bid : null;
      const ask: number | null = typeof c0.ask === "number" ? c0.ask : null;
      const last: number | null = typeof c0.last === "number" ? c0.last
                                : typeof c0.lastPrice === "number" ? c0.lastPrice : null;
      const mid = bid != null && ask != null ? (bid + ask) / 2 : last ?? 0;
      if (mid <= 0) continue;
      const iv: number = typeof c0.volatility === "number" ? c0.volatility / 100
                       : typeof c0.iv === "number" ? c0.iv : 0;
      const key = c0.symbol ?? `SPX_${sk}_${side.toUpperCase()[0]}_${args.wire15.todayExpKey.split(':')[0]}`;
      const expiry = args.wire15.todayExpKey.split(':')[0] ?? "";
      bandCandidates.push({
        strike: sk, delta, gamma: c0.gamma ?? 0, theta: c0.theta ?? 0, vega: c0.vega ?? 0,
        midPrice: mid, iv, bid, ask, key, expiry,
        openInterest: c0.openInterest ?? 0, volume: c0.totalVolume ?? c0.volume ?? 0,
      });
    }
    if (bandCandidates.length === 0) {
      console.log(`[wire15:gate2] ${setup}/${side} rejected: CONTRACT_NO_STRIKE_IN_DELTA_BAND`);
      return null; // Gate 2 reject
    }
    // Prefer between spot and T1
    const lo = Math.min(args.spot, t1Lv.price);
    const hi = Math.max(args.spot, t1Lv.price);
    const betweenCands = bandCandidates.filter((c) => c !== null && c!.strike > lo && c!.strike < hi);
    const pool = betweenCands.length > 0 ? betweenCands : bandCandidates;
    pickedContract = (pool as NonNullable<typeof pickedContract>[]).reduce((a, b) =>
      Math.abs(a.strike - args.spot) <= Math.abs(b.strike - args.spot) ? a : b,
    );
  }

  // Fallback: use legacy pickContract if no chain available
  let legacyContract: ReturnType<typeof pickContract> | null = null;
  let effectiveDelta: number;
  let effectiveMid: number;
  let contractForScoring: ContractRow;

  if (pickedContract) {
    // Build a ContractRow compatible shape for scoreSetup
    contractForScoring = {
      key: pickedContract.key,
      strike: pickedContract.strike,
      side: side as "call" | "put",
      bid: pickedContract.bid,
      ask: pickedContract.ask,
      mid: pickedContract.midPrice,
      last: null,
      volume: pickedContract.volume,
      openInterest: pickedContract.openInterest,
      expiry: pickedContract.expiry,
      iv: pickedContract.iv,
    };
    effectiveDelta = Math.abs(pickedContract.delta);
    effectiveMid = pickedContract.midPrice;
  } else {
    legacyContract = pickContract(args.contracts, args.spot, side, args.oneDayEM);
    if (!legacyContract) return null;
    contractForScoring = legacyContract;
    effectiveDelta = approxDelta(legacyContract.strike, args.spot, args.oneDayEM, side);
    effectiveMid = legacyContract.mid ?? legacyContract.last ?? 0;
  }

  // ─── Wire 15: GATE 3 — Projected return >= +30% to T1 (Wire 16: was 50%) ──────────
  let projReturnPctT1: number | null = null;
  let projReturnPctT2: number | null = null;
  let ivRichDegrade = false;
  let ivRichRatio: number | null = null;
  const rv5d: number | null = args.wire15?.rv5d ?? null;
  // Wire 16: spread-aware entry price fields (from picked contract)
  let w16ContractBid: number | null = null;
  let w16ContractAsk: number | null = null;
  let w16ContractMidPrice: number | null = null;
  let w16ContractEntryPrice: number | null = null;
  let w16ContractSpreadPct: number | null = null;

  if (pickedContract) {
    const minutesToClose = computeMinutesToCloseSync(args.asOf, args.hourET, args.minuteET);
    const gamma = pickedContract.gamma;
    const theta = pickedContract.theta; // per-day, negative
    const absDelta = Math.abs(pickedContract.delta);
    const mid = pickedContract.midPrice;

    // Wire 16: spread-aware entry price (paying near ask = honest fill)
    w16ContractBid = pickedContract.bid;
    w16ContractAsk = pickedContract.ask;
    w16ContractMidPrice = mid;
    const halfSpread = (pickedContract.bid != null && pickedContract.ask != null)
      ? (pickedContract.ask - pickedContract.bid) / 2
      : 0;
    const entryPrice = mid + halfSpread;
    w16ContractEntryPrice = entryPrice;
    w16ContractSpreadPct = (pickedContract.bid != null && pickedContract.ask != null && mid > 0)
      ? (pickedContract.ask - pickedContract.bid) / mid
      : 0;

    // Wire 16: bid-ask spread gate (>5% spread → reject)
    if (w16ContractSpreadPct > 0.05) {
      console.log(`[wire16:spread] ${setup}/${side} rejected: CONTRACT_SPREAD_TOO_WIDE_GT_5_PCT spreadPct=${(w16ContractSpreadPct*100).toFixed(1)}%`);
      return null;
    }

    // Wire 16: use entryPrice (mid + halfSpread) as denominator for honest fill projection
    function bsProj(targetPrice: number): number {
      const move = side === "call" ? targetPrice - args.spot : args.spot - targetPrice;
      const projDeltaPnl = absDelta * move;
      const projGammaBoost = 0.5 * gamma * move * move;
      const projThetaCost = (theta / 390) * minutesToClose; // theta is negative, so this is negative
      const projPnl = projDeltaPnl + projGammaBoost + projThetaCost;
      // Wire 16: use entryPrice (honest fill) as denominator
      const denom = entryPrice > 0 ? entryPrice : mid;
      return denom > 0 ? projPnl / denom : 0;
    }

    projReturnPctT1 = bsProj(t1Lv.price);
    projReturnPctT2 = t2Lv ? bsProj(t2Lv.price) : bsProj(t1Lv.price + (side === "call" ? 5 : -5));

    // ─── Wire 15: GATE 4 — IV richness ──────────────────────────────────────────────
    // atmIV: use the picked contract's IV; rv5d from wire15 context
    const atmIV = pickedContract.iv > 0 ? pickedContract.iv : (args.audit.atmIV ?? null);
    if (atmIV && rv5d && rv5d > 0) {
      ivRichRatio = atmIV / rv5d;
      if (ivRichRatio > 2.0) {
        console.log(`[wire15:gate4] ${setup}/${side} rejected: IV_RICH_RATIO_GT_2 ratio=${ivRichRatio.toFixed(2)}`);
        return null; // Gate 4 hard reject
      }
      if (ivRichRatio > 1.5) {
        // Degrade projected return by 0.7x BEFORE the 30% gate
        ivRichDegrade = true;
        projReturnPctT1 = projReturnPctT1 * 0.7;
        if (projReturnPctT2 !== null) projReturnPctT2 = projReturnPctT2 * 0.7;
      }
    }

    // Wire 16 SOFT GEX: apply 0.85x degrade BEFORE the 30% gate
    if (w16GexTier === "SOFT") {
      w16GexLightDegrade = true;
      if (projReturnPctT1 !== null) projReturnPctT1 = projReturnPctT1 * 0.85;
      if (projReturnPctT2 !== null) projReturnPctT2 = projReturnPctT2 * 0.85;
    }
    // Note: 30% floor enforcement happens post-scoring (allows A-(85) cold-boot override)
  }

  // ─── Wire 15: GATE 5 — Greek slope confirmation ───────────────────────────────────
  const gammaSlope5m: number | null = args.wire15?.gammaSlope5m ?? null;
  let gate5RejectReason: string | null = null;

  // 5a: OFI trend gate
  if (args.audit.ofiTrend) {
    const ofi = args.audit.ofiTrend;
    const ofiTrend = ofi.trend; // "BULLISH" | "BEARISH" | "NEUTRAL"
    // For CALL: OFI must be BULLISH (BUY) or NEUTRAL. Reject if BEARISH (SELL).
    // For PUT: OFI must be BEARISH (SELL) or NEUTRAL. Reject if BULLISH (BUY).
    if (side === "call" && ofiTrend === "BEARISH") {
      gate5RejectReason = "OFI_CONTRADICTS_SIDE";
    } else if (side === "put" && ofiTrend === "BULLISH") {
      gate5RejectReason = "OFI_CONTRADICTS_SIDE";
    }
  }

  // 5b: Wick timing gate (only if OFI didn't already reject)
  if (!gate5RejectReason && args.audit.wickTiming) {
    const wt = args.audit.wickTiming;
    const last3 = wt.last3Inference;
    // CALL: must NOT be CLOSED_DOWN_FROM_HIGH; PUT: must NOT be CLOSED_UP_FROM_LOW.
    // The actual values from wickTiming are: "BULLISH" | "BEARISH" | "MIXED" | "INDETERMINATE".
    // The spec says: for CALL reject CLOSED_DOWN_FROM_HIGH; for PUT reject CLOSED_UP_FROM_LOW.
    // Map: BEARISH on last3 for CALL is analogous to CLOSED_DOWN_FROM_HIGH.
    //       BULLISH on last3 for PUT is analogous to CLOSED_UP_FROM_LOW.
    // INDETERMINATE passes always.
    if (side === "call" && last3 === "BEARISH") {
      gate5RejectReason = "WICK_TIMING_CONTRADICTS";
    } else if (side === "put" && last3 === "BULLISH") {
      gate5RejectReason = "WICK_TIMING_CONTRADICTS";
    }
  }

  if (gate5RejectReason) {
    console.log(`[wire15:gate5] ${setup}/${side} rejected: ${gate5RejectReason}`);
    return null;
  }

  // ─── Existing scoring path ───────────────────────────────────────────────────────────
  const t1Pts = Math.abs(t1Lv.price - args.spot);
  const stopLevel = side === "call"
    ? reversionLevel.price - 3
    : reversionLevel.price + 3;
  const stopPts = Math.abs(args.spot - stopLevel);

  const scoreResult = scoreSetup({
    setup, side, spot: args.spot, audit: args.audit, contract: contractForScoring,
    t1Pts, stopPts, hourET: args.hourET, minuteET: args.minuteET,
    eventDayKind: args.eventDayKind ?? null,
    eventGateActions: args.eventGateActions ?? [],
  });

  // ─── Wire 16: Score floor (>= 72 = B-) — enforce AFTER scoring ───────────────────
  if (scoreResult.score < MIN_FIRE_SCORE) {
    console.log(`[wire16:score] ${setup}/${side} rejected: SCORE_BELOW_B_MINUS score=${scoreResult.score} < ${MIN_FIRE_SCORE}`);
    return null;
  }

  // ─── Wire 16: GEX LIGHT band post-score check ──────────────────────────────────────
  // LIGHT tier (300M-750M): reject unless score >= 85
  if (w16GexTier === "LIGHT") {
    if (scoreResult.score >= 85) {
      w16GexLightOverride = true;
      scoreResult.reasoning.push(`Wire 16 GEX LIGHT override: score ${scoreResult.score} >= 85 (A-), passes through GEX_LIGHT_NEEDS_A_MINUS`);
    } else {
      console.log(`[wire16:gex_light] ${setup}/${side} rejected: GEX_LIGHT_NEEDS_A_MINUS score=${scoreResult.score} < 85 absGex=${w16AbsGex}`);
      return null;
    }
  }

  // ─── Wire 16: Anti-chase post-score check ──────────────────────────────────────────
  // Pending chase rejection: reject unless score >= 85 (A-) override
  if (w16ChasePending) {
    if (scoreResult.score >= 85) {
      w16ChaseOverride = true;
      scoreResult.reasoning.push(`Wire 16 anti-chase override: score ${scoreResult.score} >= 85 (A-), passes through CHASE_PRIOR_15M_COVERED_60_PCT (chaseRatio=${w16ChaseRatio?.toFixed(2)})`);
    } else {
      console.log(`[wire16:chase] ${setup}/${side} rejected: CHASE_PRIOR_15M_COVERED_60_PCT chaseRatio=${w16ChaseRatio} score=${scoreResult.score}`);
      return null;
    }
  }

  // ─── Gate 3 post-score: enforce +30% return UNLESS score >= 85 (A- cold-boot override) ─
  let coldBootProjOverride = false;
  if (projReturnPctT1 !== null && projReturnPctT1 < 0.30) {
    const isColdBootOverride = scoreResult.score >= 85;
    if (!isColdBootOverride) {
      console.log(`[wire16:gate3] ${setup}/${side} rejected: PROJ_RETURN_BELOW_30_PCT projT1=${(projReturnPctT1*100).toFixed(0)}%`);
      return null;
    }
    // Score >= 85 (A-): cold-boot projection override
    coldBootProjOverride = true;
    scoreResult.reasoning.push(`Wire 16 Gate 3: PROJ_RETURN_BELOW_30_PCT overridden by A-(85): projT1=${(projReturnPctT1*100).toFixed(0)}%`);
  }

  // ─── Wire 16: Projection tier tagging ──────────────────────────────────────────────
  const projT1ForTier = projReturnPctT1 ?? 0;
  let w16ProjTier: "STANDARD" | "BANGER" | "MOONSHOT" | null = null;
  if (projT1ForTier >= 1.00) {
    w16ProjTier = "MOONSHOT";
  } else if (projT1ForTier >= 0.50) {
    w16ProjTier = "BANGER";
  } else if (projT1ForTier >= 0.30) {
    w16ProjTier = "STANDARD";
  }
  // Below 0.30 won't reach here unless coldBootProjOverride (score >= 85)

  const t1EstPct = pickedContract
    ? Math.round((projReturnPctT1 ?? 0) * 100)  // use BS projection (spread-aware)
    : estPctGainAtTarget(args.spot, t1Lv.price, effectiveMid, effectiveDelta, side);
  const t2EstPct = pickedContract
    ? Math.round((projReturnPctT2 ?? 0) * 100)
    : (t2Lv ? estPctGainAtTarget(args.spot, t2Lv.price, effectiveMid, effectiveDelta, side) : 0);

  const t2TrailingStopLevel = side === "call" ? t1Lv.price - 3 : t1Lv.price + 3;
  const t2TriggerLevel = t1Lv.price;

  // OFI label for card
  const ofiTrendVal = args.audit.ofiTrend?.trend ?? null;
  const ofiLabel = ofiTrendVal === "BULLISH" ? "SLOPE UP"
                 : ofiTrendVal === "BEARISH" ? "SLOPE DOWN"
                 : "FLAT";

  // gammaSlope label for card
  const gammaSlopeLabel = gammaSlope5m === null || gammaSlope5m === 0 ? "FLAT"
                        : gammaSlope5m > 0 ? "UP" : "DOWN";

  // Greek signals line: OFI primary + gamma slope secondary
  const greekSignals = `OFI ${ofiLabel}  ·  γ-slope ${gammaSlopeLabel}`;

  // Regime tag: compose gamma-zone + chop/jump/corr flags
  const gzLabel = args.audit.gammaZone === "y+" ? "\u03b3+ DAMPENED"
                : args.audit.gammaZone === "y-" ? "\u03b3\u2212 VOLATILE"
                : "NEUTRAL";
  const regimeParts = [gzLabel];
  if (args.audit.chopRegime) regimeParts.push("CHOP");
  if (args.audit.jumpRegime) regimeParts.push("JUMP");
  if (args.audit.correlationBreakdown) regimeParts.push("CORR-BREAK");
  const regime = regimeParts.join(" · ");

  const wire15Audit = {
    projReturnPctT1,
    projReturnPctT2,
    rv5d,
    ivRichRatio,
    ivRichDegrade,
    gammaSlope5m,
    envVetoReason,
    gateRejectReason: null as string | null,
    contractStrike: pickedContract?.strike ?? null,
    contractDelta: pickedContract ? Math.abs(pickedContract.delta) : null,
    // Wire 16 fields
    contractMidPrice: w16ContractMidPrice,
    contractBid: w16ContractBid,
    contractAsk: w16ContractAsk,
    contractEntryPrice: w16ContractEntryPrice,
    contractSpreadPct: w16ContractSpreadPct,
    absGex: w16AbsGex,
    gexTier: w16GexTier,
    gexLightDegrade: w16GexLightDegrade,
    gexLightOverride: w16GexLightOverride,
    realized15mMove: w16Realized15mMove,
    distanceToT1: w16DistanceToT1,
    chaseRatio: w16ChaseRatio,
    chaseOverride: w16ChaseOverride,
    projTier: w16ProjTier,
    coldBootProjOverride,
    wire15Present: true,
    wire16Present: true,
  };

  const contractOut = pickedContract ? {
    strike: pickedContract.strike,
    last: null as number | null,
    bid: pickedContract.bid,
    ask: pickedContract.ask,
    delta: Math.abs(pickedContract.delta),
    key: pickedContract.key,
    expiry: pickedContract.expiry,
    gamma: pickedContract.gamma,
    theta: pickedContract.theta,
    vega: pickedContract.vega,
    iv: pickedContract.iv,
    midPrice: pickedContract.midPrice,
  } : {
    strike: legacyContract!.strike,
    last: legacyContract!.last,
    bid: legacyContract!.bid,
    ask: legacyContract!.ask,
    delta: effectiveDelta,
    key: legacyContract!.key,
    expiry: legacyContract!.expiry,
  };

  return {
    setup, side, spot: args.spot, asOf: args.asOf,
    contract: contractOut,
    reversionFrom: { name: reversionLevel.name, price: reversionLevel.price },
    t1: { name: t1Lv.name, price: t1Lv.price, estPctGain: t1EstPct },
    t2: t2Lv ? { name: t2Lv.name, price: t2Lv.price, estPctGain: t2EstPct } : undefined,
    stopPct: 20,
    stopLevel,
    t2TriggerLevel,
    t2TrailingStopLevel,
    greekSignals, regime,
    grade: { score: scoreResult.score, letter: letterGrade(scoreResult.score), reasoning: [] },
    reasoning: scoreResult.reasoning,
    wire15: wire15Audit,
  };
}

/**
 * Synchronous helper: compute minutesToClose from known hourET/minuteET.
 * Used in buildAlert (which must remain sync).
 */
function computeMinutesToCloseSync(nowMs: number, hourET: number, minuteET: number): number {
  const todMinET = hourET * 60 + minuteET;
  const closeMinET = 16 * 60; // 16:00 ET
  return Math.max(1, closeMinET - todMinET);
}

// ─── Format the alert as the user's mockup ────────────────────────────────
export function formatOdteAlert(a: OdteAlert): { content: string } {
  const sideUpper = a.side.toUpperCase();
  const contractType = a.side === "call" ? "C" : "P";
  const setupLabel =
    a.setup === "FAILED_BREAK" ? "FAILED BREAK" :
    a.setup === "PIVOT_RECLAIM" ? "PIVOT RECLAIM" :
    "WALL REJECT";

  const etTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(a.asOf));

  // delta: abs value, 2dp
  const deltaStr = a.contract.delta != null
    ? Math.abs(a.contract.delta).toFixed(2)
    : "—";

  // projected returns from Wire 15 (decimal → percent, rounded)
  const projT1Pct = a.wire15?.projReturnPctT1 != null
    ? Math.round(a.wire15.projReturnPctT1 * 100)
    : Math.round(a.t1.estPctGain);
  const projT2Pct = a.wire15?.projReturnPctT2 != null
    ? Math.round(a.wire15.projReturnPctT2 * 100)
    : (a.t2 ? Math.round(a.t2.estPctGain) : null);

  // NEW_STOP per spec: CALL = T1-3, PUT = T1+3
  const newStop = a.side === "call"
    ? Math.round(a.t1.price) - 3
    : Math.round(a.t1.price) + 3;

  const lines: string[] = [];
  lines.push(`SPX 0DTE TRADE ALERT  |  ${etTime} ET`);
  lines.push("─".repeat(40));
  lines.push(`${sideUpper} ALERT  |  ${setupLabel}  |  CONFIDENCE ${a.grade.letter}  (${a.grade.score}/100)`);
  lines.push("");
  lines.push(`CONTRACT:  SPX ${a.contract.strike} ${contractType}  |  SPX @ ${a.spot.toFixed(1)}  (delta ${deltaStr})`);
  lines.push("");
  const reversionLine = `${a.reversionFrom.name} ${Math.round(a.reversionFrom.price)}  →  ${a.t1.name} ${Math.round(a.t1.price)}`;
  const entryDesc = a.setup === "FAILED_BREAK"
    ? `Was ${a.side === "call" ? "below" : "above"} ${Math.round(a.reversionFrom.price)}, broke ${a.side === "call" ? "above" : "below"} — trap confirmed. Trade ${sideUpper} back toward ${Math.round(a.t1.price)}.`
    : a.setup === "PIVOT_RECLAIM"
    ? `${a.side === "call" ? "Reclaimed" : "Lost"} pivot ${Math.round(a.reversionFrom.price)} — momentum trade toward ${Math.round(a.t1.price)}.`
    : `Tagged ${a.reversionFrom.name} ${Math.round(a.reversionFrom.price)} and rejected — fade toward ${Math.round(a.t1.price)}.`;
  lines.push(`REVERSION:  ${reversionLine}`);
  lines.push(`ENTRY:  ${entryDesc}`);
  lines.push("");
  lines.push(`STOP:  -20%  OR  5-min close ${a.side === "call" ? "BELOW" : "ABOVE"} ${Math.round(a.stopLevel)}`);
  // Wire 16: projection tier tag
  const projTier = a.wire15?.projTier ?? null;
  const tierTag = projTier ? `  [${projTier}]` : "";
  lines.push(`T1:  ${Math.round(a.t1.price)}  (${a.t1.name})  +${projT1Pct}% est${tierTag}`);
  if (a.t2) {
    const t2ProjStr = projT2Pct != null ? `+${projT2Pct}% est` : "+—% est";
    lines.push(`  IF T1 BREAKS: stop -> ${a.side === "call" ? "BELOW" : "ABOVE"} ${newStop}  |  T2: ${Math.round(a.t2.price)} (${a.t2.name}) ${t2ProjStr}`);
    lines.push(`  T2 activates on: 5-min candle close ${a.side === "call" ? "ABOVE" : "BELOW"} ${Math.round(a.t1.price)}`);
  }
  lines.push("");
  lines.push(`Greek signals:  ${a.greekSignals}`);
  lines.push(`Regime:  ${a.regime}`);
  lines.push("");
  lines.push(`Built by God. Paid by the Market.`);

  return { content: "```\n" + lines.join("\n") + "\n```" };
}
