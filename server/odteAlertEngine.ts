// server/odteAlertEngine.ts
//
// Pulse Batcave 0DTE banger detector. ADDITIVE, observer-only — never modifies
// any existing calc. Watches /api/models (levels, audit, scenarioProbs) and
// /api/odte-tracker (live contract chain) for high-conviction setups.
//
// Fires only when total grade ≥ 70 (B+). Below that → silent.
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
// Letter grades: A+ ≥ 90, A ≥ 85, A− ≥ 80 ← FIRE GATE (banger-only),
//                B+ ≥ 70, B ≥ 65, B− ≥ 60, C ≥ 50, else F
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
  } | null;
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
  };
  reversionFrom: { name: string; price: number };  // level we just bounced off
  t1: { name: string; price: number; estPctGain: number };
  t2?: { name: string; price: number; estPctGain: number };
  stopPct: number;                  // -% on contract
  stopLevel: number;                // SPX-level invalidation
  t2TriggerLevel: number;           // SPX-level that activates T2
  t2TrailingStopLevel: number;      // SPX-level the stop trails to after T1 hits
  greekSignals: string;             // e.g. "SLOPE UP" or "SLOPE UP · VANNA BULL"
  regime: string;                   // e.g. "NEUTRAL" | "DAMPENED γ+" | "VOLATILE γ-"
  grade: { score: number; letter: string };
  reasoning: string[];              // breakdown of where points came from
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

function etDateStr(ts: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ts));
}

export function recordSpot(ts: number, spot: number): void {
  if (!isFinite(spot) || spot <= 0) return;
  spotHistory.push({ ts, spot });
  // GC
  const cutoff = ts - HISTORY_MAX_MS;
  while (spotHistory.length > 0 && spotHistory[0].ts < cutoff) spotHistory.shift();
  while (spotHistory.length > HISTORY_MAX_PTS) spotHistory.shift();
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
function letterGrade(score: number): string {
  if (score >= 90) return "A+";
  if (score >= 85) return "A";
  if (score >= 80) return "A−";
  if (score >= 70) return "B+";
  if (score >= 65) return "B";
  if (score >= 60) return "B−";
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

  return { score: Math.round(score), reasoning };
}

// ─── Main entry: evaluate a snapshot, return alerts that pass the gate ────
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
}

export const FIRE_GATE = 80;  // A− or better — banger-only
export const BANGER_MIN_PCT = 30;  // T1 estimated %-gain floor — user spec: 30%+ only
// Independent BANGERS gate delta floor — kills lottery tickets even if pickContract loosens.
// Range chosen to bracket realistic intraday "big premium" plays:
//   < 0.20 = lotto / OTM tail. Not a banger — too dependent on miracle move.
//   > 0.70 = deep ITM hedge. Not a banger — capital-heavy, no leverage.
export const BANGER_DELTA_MIN = 0.20;
export const BANGER_DELTA_MAX = 0.70;

/**
 * Diagnostic surface — returns ALL candidates pre-filter, with per-candidate
 * pass/reject reasons. Used by /api/odte-alert/preview for visibility.
 * Does NOT consume rate limiter / daily cap / cooldowns.
 */
export function diagnoseOdte(args: EvalArgs): {
  fireable: OdteAlert[];
  rejected: Array<{ alert: OdteAlert; reason: string }>;
  fireGate: number;
  bangerMinPct: number;
} {
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
  const sortedLevels = [...args.levels].sort((a, b) => a.price - b.price);
  const meaningfulKinds = new Set([
    "callWall", "putWall", "mainPivot", "charmFlip", "charmZero",
    "vanna", "vannaPeak", "t1Up", "t1Dn", "downsideTarget", "upsideTarget",
  ]);
  for (const lv of args.levels) {
    if (!meaningfulKinds.has(lv.kind)) continue;
    if (Math.abs(args.spot - lv.price) > 30) continue;
    if (detectFailedBreak(lv.price, "above").detected) {
      const a = buildAlert(args, lv, "FAILED_BREAK", "call", sortedLevels);
      if (a) out.push(a);
    }
    if (detectFailedBreak(lv.price, "below").detected) {
      const a = buildAlert(args, lv, "FAILED_BREAK", "put", sortedLevels);
      if (a) out.push(a);
    }
  }
  const pivot = args.audit.mainPivot;
  if (typeof pivot === "number" && isFinite(pivot)) {
    const lv = args.levels.find((l) => Math.abs(l.price - pivot) < 1) ??
               { name: "MAIN PIVOT", kind: "mainPivot", price: pivot, side: "support" as const };
    if (detectFailedBreak(pivot, "above").detected) {
      const a = buildAlert(args, lv, "PIVOT_RECLAIM", "call", sortedLevels);
      if (a) out.push(a);
    }
    if (detectFailedBreak(pivot, "below").detected) {
      const a = buildAlert(args, lv, "PIVOT_RECLAIM", "put", sortedLevels);
      if (a) out.push(a);
    }
  }
  const callWall = args.levels.find((l) => l.kind === "callWall");
  if (callWall && detectWallReject(callWall.price, "ceiling").detected) {
    const a = buildAlert(args, callWall, "WALL_REJECT", "put", sortedLevels);
    if (a) out.push(a);
  }
  const putWall = args.levels.find((l) => l.kind === "putWall");
  if (putWall && detectWallReject(putWall.price, "floor").detected) {
    const a = buildAlert(args, putWall, "WALL_REJECT", "call", sortedLevels);
    if (a) out.push(a);
  }
  const fireable: OdteAlert[] = [];
  const rejected: Array<{ alert: OdteAlert; reason: string }> = [];
  for (const a of out) {
    if (a.grade.score < FIRE_GATE) {
      rejected.push({ alert: a, reason: `grade ${a.grade.score} < FIRE_GATE ${FIRE_GATE}` });
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

export function evaluateOdte(args: EvalArgs): OdteAlert[] {
  const out: OdteAlert[] = [];
  recordSpot(args.asOf, args.spot);
  if (spotHistory.length < 3) return out;

  // Find candidate levels for each setup type
  const sortedLevels = [...args.levels].sort((a, b) => a.price - b.price);

  // ─── Setup 1: FAILED BREAK (any meaningful level) ────
  // Try each level. Failed break ABOVE = pierced down then reclaimed up = bullish CALL.
  // Failed break BELOW = pierced up then reclaimed down = bearish PUT.
  const meaningfulKinds = new Set([
    "callWall", "putWall", "mainPivot", "charmFlip", "charmZero",
    "vanna", "vannaPeak", "t1Up", "t1Dn", "downsideTarget", "upsideTarget",
  ]);
  for (const lv of args.levels) {
    if (!meaningfulKinds.has(lv.kind)) continue;
    if (Math.abs(args.spot - lv.price) > 30) continue;  // only near levels

    // CALL trade — failed break to the downside (was above, dipped below, came back up)
    const fbCall = detectFailedBreak(lv.price, "above");
    if (fbCall.detected) {
      const alert = buildAlert(args, lv, "FAILED_BREAK", "call", sortedLevels);
      if (alert) out.push(alert);
    }
    const fbPut = detectFailedBreak(lv.price, "below");
    if (fbPut.detected) {
      const alert = buildAlert(args, lv, "FAILED_BREAK", "put", sortedLevels);
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
      const alert = buildAlert(args, lv, "PIVOT_RECLAIM", "call", sortedLevels);
      if (alert) out.push(alert);
    }
    const reclaimDn = detectFailedBreak(pivot, "below");
    if (reclaimDn.detected) {
      const alert = buildAlert(args, lv, "PIVOT_RECLAIM", "put", sortedLevels);
      if (alert) out.push(alert);
    }
  }

  // ─── Setup 3: WALL REJECT ────
  const callWall = args.levels.find((l) => l.kind === "callWall");
  if (callWall) {
    const rej = detectWallReject(callWall.price, "ceiling");
    if (rej.detected) {
      const alert = buildAlert(args, callWall, "WALL_REJECT", "put", sortedLevels);
      if (alert) out.push(alert);
    }
  }
  const putWall = args.levels.find((l) => l.kind === "putWall");
  if (putWall) {
    const rej = detectWallReject(putWall.price, "floor");
    if (rej.detected) {
      const alert = buildAlert(args, putWall, "WALL_REJECT", "call", sortedLevels);
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
    .filter((a) => a.grade.score >= FIRE_GATE)
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
  const c = pickContract(args.contracts, args.spot, side, args.oneDayEM);
  if (!c) return null;

  // T1 = next level in the trade direction
  const above = sortedLevels.filter((l) => l.price > args.spot + 1);
  const below = sortedLevels.filter((l) => l.price < args.spot - 1).reverse();
  const t1Lv = side === "call" ? above[0] : below[0];
  const t2Lv = side === "call" ? above[1] : below[1];
  if (!t1Lv) return null;

  const t1Pts = Math.abs(t1Lv.price - args.spot);
  // Stop = invalidation level on the other side of reversionLevel + 3pt buffer
  const stopLevel = side === "call"
    ? reversionLevel.price - 3
    : reversionLevel.price + 3;
  const stopPts = Math.abs(args.spot - stopLevel);

  const delta = approxDelta(c.strike, args.spot, args.oneDayEM, side);
  const mid = c.mid ?? c.last ?? 0;
  const t1EstPct = estPctGainAtTarget(args.spot, t1Lv.price, mid, delta, side);
  const t2EstPct = t2Lv ? estPctGainAtTarget(args.spot, t2Lv.price, mid, delta, side) : 0;

  // T2 trailing stop = just past T1 in trade direction
  const t2TrailingStopLevel = side === "call" ? t1Lv.price - 3 : t1Lv.price + 3;
  const t2TriggerLevel = t1Lv.price;

  const score = scoreSetup({
    setup, side, spot: args.spot, audit: args.audit, contract: c,
    t1Pts, stopPts, hourET: args.hourET, minuteET: args.minuteET,
    eventDayKind: args.eventDayKind ?? null,
    eventGateActions: args.eventGateActions ?? [],
  });

  // Greek signals string
  const greekParts: string[] = [];
  if (typeof args.audit.slope === "number") {
    greekParts.push(args.audit.slope > 0 ? "SLOPE UP" : args.audit.slope < 0 ? "SLOPE DOWN" : "SLOPE FLAT");
  }
  if (typeof args.audit.vannaBias === "number" && Math.abs(args.audit.vannaBias) > 0.05) {
    greekParts.push(args.audit.vannaBias > 0 ? "VANNA BULL" : "VANNA BEAR");
  }
  const greekSignals = greekParts.length ? greekParts.join(" · ") : "—";

  const regime = args.audit.gammaZone === "y+" ? "DAMPENED γ+"
              : args.audit.gammaZone === "y-" ? "VOLATILE γ−"
              : "NEUTRAL";

  return {
    setup, side, spot: args.spot, asOf: args.asOf,
    contract: {
      strike: c.strike, last: c.last, bid: c.bid, ask: c.ask,
      delta, key: c.key, expiry: c.expiry,
    },
    reversionFrom: { name: reversionLevel.name, price: reversionLevel.price },
    t1: { name: t1Lv.name, price: t1Lv.price, estPctGain: t1EstPct },
    t2: t2Lv ? { name: t2Lv.name, price: t2Lv.price, estPctGain: t2EstPct } : undefined,
    stopPct: 20,                  // standard -20% on contract for 0DTE
    stopLevel,
    t2TriggerLevel,
    t2TrailingStopLevel,
    greekSignals, regime,
    grade: { score: score.score, letter: letterGrade(score.score) },
    reasoning: score.reasoning,
  };
}

// ─── Format the alert as the user's mockup ────────────────────────────────
export function formatOdteAlert(a: OdteAlert): { content: string } {
  const sideUpper = a.side.toUpperCase();
  const setupLabel =
    a.setup === "FAILED_BREAK" ? "FAILED BREAK" :
    a.setup === "PIVOT_RECLAIM" ? "PIVOT RECLAIM" :
    "WALL REJECT";

  const etTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(a.asOf));

  const lines: string[] = [];
  lines.push(`SPX 0DTE TRADE ALERT  |  ${etTime} ET`);
  lines.push("─".repeat(52));
  lines.push(`${sideUpper} ALERT  |  ${setupLabel}  |  CONFIDENCE ${a.grade.letter}  (${a.grade.score}/100)`);
  lines.push("");
  const lastStr = a.contract.last != null ? a.contract.last.toFixed(2) : "—";
  lines.push(`CONTRACT:  SPX ${a.contract.strike} ${sideUpper}  |  SPX @ ${a.spot.toFixed(1)}  (delta ${a.contract.delta?.toFixed(2) ?? "—"})  mid ${lastStr}`);
  lines.push("");
  lines.push(`REVERSION:  ${a.reversionFrom.name} ${Math.round(a.reversionFrom.price)}  →  ${a.t1.name} ${Math.round(a.t1.price)}`);
  const entryDesc = a.setup === "FAILED_BREAK"
    ? `Was ${a.side === "call" ? "below" : "above"} ${Math.round(a.reversionFrom.price)}, broke ${a.side === "call" ? "above" : "below"} — trap confirmed. Trade ${sideUpper} back toward ${Math.round(a.t1.price)}.`
    : a.setup === "PIVOT_RECLAIM"
    ? `${a.side === "call" ? "Reclaimed" : "Lost"} pivot ${Math.round(a.reversionFrom.price)} — momentum trade toward ${Math.round(a.t1.price)}.`
    : `Tagged ${a.reversionFrom.name} ${Math.round(a.reversionFrom.price)} and rejected — fade toward ${Math.round(a.t1.price)}.`;
  lines.push(`ENTRY:  ${entryDesc}`);
  lines.push("");
  lines.push(`STOP:  -${a.stopPct}%  OR  5-min close ${a.side === "call" ? "BELOW" : "ABOVE"} ${Math.round(a.stopLevel)}`);
  lines.push(`T1:  ${Math.round(a.t1.price)}  (${a.t1.name})  +${Math.round(a.t1.estPctGain)}% est`);
  if (a.t2) {
    lines.push(`  IF T1 BREAKS: stop → ${a.side === "call" ? "BELOW" : "ABOVE"} ${Math.round(a.t2TrailingStopLevel)}  |  T2: ${Math.round(a.t2.price)} (${a.t2.name}) +${Math.round(a.t2.estPctGain)}% est`);
    lines.push(`  T2 activates on: 5-min candle close ${a.side === "call" ? "ABOVE" : "BELOW"} ${Math.round(a.t2TriggerLevel)}`);
  }
  lines.push("");
  lines.push(`Greek signals:  ${a.greekSignals}`);
  lines.push(`Regime:  ${a.regime}`);
  lines.push("");
  lines.push(`Built by God. Paid by the Market.`);

  return { content: "```\n" + lines.join("\n") + "\n```" };
}
