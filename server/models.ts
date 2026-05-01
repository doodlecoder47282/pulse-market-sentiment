// server/models.ts
//
// Forward-model engine — Daily / Weekly / Monthly price paths for SPX & SPY,
// anchored to the same dealer-exposure math the Trade Desk already uses.
//
// For each horizon:
//   1. Build a dealer exposure profile out to the horizon's DTE window
//      (Daily ≤2 DTE, Weekly ≤7 DTE, Monthly ≤45 DTE).
//   2. From the GEX curve + OI distribution, derive structural anchors:
//        callWall  → upside magnet / resistance
//        putWall   → downside support
//        zeroGamma → regime pivot (positive vs negative gamma)
//        extremeVac → largest negative-GEX strike band (vacuum / tail risk)
//        dominantMag → largest positive-GEX strike (primary magnet)
//        strongMag → 2nd-largest positive-GEX strike
//        mopexMaxPain → classic max-pain (min total $ value of OI)
//        upsidePivot / downsidePivot → call wall + vanna flip / put wall + charm flip
//        vommaPockets → zones where ∂Vega/∂σ spikes (tail IV churn)
//   3. Produce three price paths to end of horizon:
//        BASE path → spot → zeroGamma → dominantMag (gravity)
//        BULL path → spot → dominantMag → callWall → upsidePivot
//        BEAR path → spot → zeroGamma → putWall → downsidePivot
//      Each path is a small number of ordered waypoints with % probability.
//   4. Compute the AUDIT block: near/above/below exposures, slope, OPEX gravity,
//      total GEX, DEX, charm. This matches the screenshot's top-left audit panel.
//
// Scope: SPX ("^GSPC") and SPY only for v1 (options chain is SPY-driven; SPX is
// shown at SPX price scale using SPY's chain rescaled by the ratio — a common
// approach since SPX·0.1 ≈ SPY to a few bps).

import type { ExposureProfile, ExposureRow } from "./exposureProfile";
import { buildExposureProfile } from "./exposureProfile";
import { chainToRows } from "./exposures";
import { getCboeChain } from "./cboeCache";
import { computeGreeks } from "./greeks";
import { storage } from "./storage";
import { getQuotes as schwabGetQuotes } from "./schwab";
import { fetchOHLC } from "./ohlc";
import { buildMMMatrix } from "./mmMatrix";

// Resolve real SPX spot from Schwab `$SPX`, falling back to Yahoo `^GSPC`.
// Never derive from SPY×10 — SPY price drifts vs SPX due to accumulated dividends.
async function resolveRealSpxSpot(): Promise<number | null> {
  // 1) Schwab $SPX quote
  try {
    const qs = await schwabGetQuotes(["$SPX"]);
    const p = qs?.[0]?.last;
    if (p != null && Number.isFinite(p) && p > 1000) return p;
  } catch { /* fall through */ }
  // 2) Yahoo ^GSPC (same source /api/ohlc uses)
  try {
    const ohlc = await fetchOHLC("^GSPC", "1D");
    const p = ohlc?.price ?? ohlc?.candles?.[ohlc.candles.length - 1]?.c ?? null;
    if (p != null && Number.isFinite(p) && p > 1000) return p;
  } catch { /* fall through */ }
  return null;
}

// America/New_York trade date YYYY-MM-DD
function etTradeDate(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const da = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${da}`;
}

export type Horizon = "daily" | "weekly" | "monthly" | "quarterly";

export interface ModelLevel {
  label: string;
  name: string;                            // short name (e.g. "UPSIDE PIVOT")
  price: number;
  kind:
    | "callWall"
    | "putWall"
    | "zeroGamma"
    | "dominantMag"
    | "strongMag"
    | "extremeVac"
    | "mopexMaxPain"
    | "upsidePivot"
    | "downsidePivot"
    | "spot"
    | "vommaPocket"
    | "t1Up" | "t2Up"
    | "t1Down" | "t2Down"
    // experimental dealer-map kinds (behind ?experimental=1)
    | "vannaFlip"
    | "zommaBridge"
    | "charmTarget"
    | "negGammaEntry"
    | "upperVomma"
    | "lowerVomma";
  gex?: number;                            // $ per 1% (signed)
  tag?: string;                            // "FLOOR" / "CEILING" / "VAC" / "FADES" etc.
  note?: string;
  // Live status vs current spot — server-computed so alert engines and UI
  // share one source of truth instead of each reimplementing the comparator.
  status?: "held" | "approaching" | "broken";
  // Side: "resistance" if level is above spot, "support" if below, "at" if within 0.05%.
  side?: "resistance" | "support" | "at";
  // Distance from current spot in basis points (signed: + means above spot).
  distBps?: number;
}

export interface ModelPathWaypoint {
  label: string;                           // e.g. "MON", "TUE", "WED 7,030"
  t: number;                               // fractional x position 0..1 across horizon
  price: number;
}

export interface ModelPath {
  kind: "base" | "bull" | "bear";
  name: string;
  probability: number;                     // 0..1
  target: number;                          // end-of-horizon price
  waypoints: ModelPathWaypoint[];
  color: "base" | "bull" | "bear";
}

export interface ModelAudit {
  asOf: number;
  spot: number;
  spotChange: string;                      // e.g. "-40.6 in 14 min" — stubbed to intraday delta
  slope: string;                           // "DN" / "UP" with degrees
  path: string;                            // "liquid path down" / "range-bound"
  opexGravity: string;                     // text describing pull direction
  gexTotal: number;                        // absolute $ per 1%
  dex: number;                             // $B signed
  charmPerDay: number;                     // $B/day signed
  netCTrue: number;                        // Σ charm_strike × OI_strike × 100 (dealer-signed, Perfiliev Table VIII)
  vexPerVolPct: number;                    // $B / 1% vol (signed)
  vannaBias: "positive" | "negative";
  vannaM: number;                          // vanna exposure in $M
  gammaZone: "y+" | "y-";                  // positive = dampening, negative = amplifying
  gammaZoneLabel: string;                  // "DAMPENING" / "AMPLIFYING"
  gammaAtSpot: number;                     // raw gamma × OI at current spot (for DFI)
  dfi: number;                             // Delta Flow Indicator — normalised DEX slope (signed, float)
  dfiLabel: string;                        // "BULLISH" / "BEARISH" / "NEUTRAL"
  dfiFlipped: boolean;                     // true if dfi sign changed vs prior reading
  contractCount: number;                   // rows in the chain for this horizon
  mainPivot: number | null;                // dominant magnet / zero-gamma — the primary intraday pivot
  charmZero: number | null;               // zero-charm spot (drift target — primary)
  charmZeros: number[];                   // Selz #1 — full charm-zero CLUSTER (within ±3% of spot)
  charmTightening: {                      // Selz #2 — 2nd-derivative / slope based chop flag
    rate: number;                         // |charmSlope| normalised (unitless, >0)
    label: "DECEL" | "STEADY" | "EXPANDING";
    chopFlag: boolean;                    // true when tightening crosses threshold
    note: string;                         // human-readable: "DECEL above 1.5 — chop risk"
  };
  doubleZeroLow: number | null;           // lower bound of double-zero zone
  doubleZeroHigh: number | null;          // upper bound of double-zero zone
  scenarioProb: { bull: number; base: number; bear: number };  // percentages summing to 100
  closeTargets: {                         // Selz #5 — discrete BULL / BASE / BEAR close targets (chart right edge)
    bull:  { price: number; prob: number } | null;
    base:  { price: number; prob: number } | null;
    bear:  { price: number; prob: number } | null;
  };
  lastRecal: {                            // Selz #3 — intraday recal snapshots
    at: number;                           // epoch seconds
    dfi: number;                          // DFI at recal time
    dfiDeltaSinceOpen: number | null;     // change vs first snapshot of the day
  } | null;
  termStructureDoD: {                     // Selz #4 — term structure day-over-day
    iv1d: number | null;                  // today's 1D IV %
    iv1dPrev: number | null;               // yesterday's 1D IV %
    iv1dDelta: number | null;             // iv1d - iv1dPrev
    charmNow: number;                     // current $B
    charmPrev: number | null;              // yesterday's $B
    label: string;                        // e.g. "Vol Bid Up" / "Vol Offered" / "Flat"
  };
  nearby: {
    price: number;
    note: string;
    dir: "up" | "down";
  }[];
}

export interface ModelHorizon {
  horizon: Horizon;
  label: string;                           // "SPX DAILY MODEL" etc.
  symbol: string;                          // "^GSPC" | "SPY"
  displaySymbol: string;                   // "SPX" | "SPY"
  spot: number;
  spotAnchorDate: string;                  // "TUE 4/21"
  targetDate: string;                      // "FRI 4/24" (daily = same day; weekly = Fri; monthly = 3rd Friday of next month)
  targetDateLong: string;                  // "Wed Apr 22, 2026"
  priceRange: [number, number];            // y-axis suggested bounds
  // Compression band the market is currently sitting in — derived from the
  // nearest support and resistance to spot. Used by alerts and the daily
  // brief to surface explicit breakout / breakdown trigger prices.
  rangeBox: {
    low: number;
    high: number;
    width: number;                         // high - low
    widthPct: number;                      // (high - low) / spot * 100
    breakoutTrigger: number;               // price that flips bias bullish if exceeded (== high)
    breakdownTrigger: number;              // price that flips bias bearish if broken (== low)
    status: "contained" | "breakout" | "breakdown";  // where spot sits vs the band
    anchorHigh: { name: string; kind: ModelLevel["kind"] } | null;  // which level seeds the high
    anchorLow:  { name: string; kind: ModelLevel["kind"] } | null;  // which level seeds the low
  } | null;
  levels: ModelLevel[];
  paths: ModelPath[];
  audit: ModelAudit;
  vol: {
    vix: number | null;
    vixChangePct: number | null;
    termRatio: number | null;              // vix3m / vix
    termLabel: string;                     // "contango" / "backwardation"
  };
  vomma: "elevated" | "normal";
  confidence: "HIGH" | "MODERATE" | "LOW";
  mmMatrix?: import("./mmMatrix").MMMatrix;
}

export interface ModelsResponse {
  asOf: number;
  session: "live" | "last-close";          // persisted session vs. live
  horizons: Record<Horizon, ModelHorizon | null>;
  warnings: string[];
  experimental?: boolean;                  // true when ?experimental=1 — client can surface extra dealer-map kinds
}

// ──────────────────────────────────────────────────────────────────────────
// Horizon DTE windows
// ──────────────────────────────────────────────────────────────────────────

const DTE_MAX: Record<Horizon, number> = {
  daily: 2,      // 0DTE + next-day
  weekly: 7,     // current week + front-week
  monthly: 45,   // Include monthly OPEX
  quarterly: 100, // 3-month OPEX window (captures next 3 monthly OPEX)
};

// ──────────────────────────────────────────────────────────────────────────
// Per-strike aggregation — groups chain rows by strike, separates call/put
// GEX, computes "dollars of OI" for max pain.
// ──────────────────────────────────────────────────────────────────────────

interface StrikeBucket {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
  callOi: number;
  putOi: number;
  gamma: number;      // avg gamma (at current spot) across rows in bucket
}

function bucketByStrike(rows: ExposureRow[], spot: number, r: number, q: number): StrikeBucket[] {
  const byStrike = new Map<number, StrikeBucket>();

  for (const row of rows) {
    const tradingDays = Math.max(1, Math.round(row.dte * (262 / 365)));
    const T = tradingDays / 262;
    const g = computeGreeks(spot, row.strike, row.iv, T, r, q, row.type);
    const oiMult = row.oi * 100;
    const gex = g.gamma * oiMult * spot * spot * 0.01; // positive magnitude

    let b = byStrike.get(row.strike);
    if (!b) {
      b = { strike: row.strike, callGex: 0, putGex: 0, netGex: 0, callOi: 0, putOi: 0, gamma: 0 };
      byStrike.set(row.strike, b);
    }
    if (row.type === "C") {
      b.callGex += gex;          // calls contribute positive to net GEX
      b.callOi  += row.oi;
    } else {
      b.putGex  += gex;
      b.putOi   += row.oi;
      // puts contribute negative to net GEX under the dealer-short convention
    }
    b.netGex = b.callGex - b.putGex;
    b.gamma = Math.max(b.gamma, g.gamma);
  }

  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

// Max-pain = strike where total intrinsic $ value across all OI is minimized.
function maxPain(rows: ExposureRow[]): number | null {
  const strikes = Array.from(new Set(rows.map(r => r.strike))).sort((a,b)=>a-b);
  if (!strikes.length) return null;
  let best = strikes[0], bestVal = Infinity;
  for (const K of strikes) {
    let total = 0;
    for (const r of rows) {
      if (r.type === "C") total += Math.max(0, K - r.strike) * r.oi * 100;
      else                total += Math.max(0, r.strike - K) * r.oi * 100;
    }
    if (total < bestVal) { bestVal = total; best = K; }
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────
// Level extraction — finds the key magnets, walls, vacuum, pivots.
// ──────────────────────────────────────────────────────────────────────────

// sigmaBand — expected one-sigma move from VIX and horizon.
// vix is in annualized %; returns a price delta.
function sigmaBand(spot: number, vix: number | null, horizon: Horizon): number {
  const vol = Math.max(8, Math.min(80, vix ?? 18)) / 100;  // clamp for sanity
  const days =
    horizon === "daily" ? 1
      : horizon === "weekly" ? 5
      : horizon === "monthly" ? 21
      : 63; // quarterly = 63 trading days
  return spot * vol * Math.sqrt(days / 252);
}

function extractLevels(
  buckets: StrikeBucket[],
  profile: ExposureProfile,
  spot: number,
  rows: ExposureRow[],
  horizon: Horizon,
  vix: number | null,
  experimental: boolean,
): ModelLevel[] {
  const out: ModelLevel[] = [];

  // ±2σ search window (constrains DOWNSIDE PIVOT + EXTREME VAC so they
  // don't wander to far-OTM tail strikes with almost no OI).
  const sigma = sigmaBand(spot, vix, horizon);
  const twoSigmaUp = spot + 2 * sigma;
  const twoSigmaDown = spot - 2 * sigma;

  // Call wall — highest positive call GEX within reasonable band (±15%)
  const band = buckets.filter((b) => Math.abs(b.strike - spot) / spot < 0.15);
  // Tight band for vacuum / pivot searches — prevents wandering
  const tight = buckets.filter((b) => b.strike >= twoSigmaDown && b.strike <= twoSigmaUp);
  const callWall = band
    .filter((b) => b.strike >= spot)
    .sort((a, b) => b.callGex - a.callGex)[0];
  if (callWall) {
    out.push({
      label: `CALL WALL ${fmtK(callWall.strike)}`,
      name: "CALL WALL",
      price: callWall.strike,
      kind: "callWall",
      gex: callWall.callGex,
      tag: "CEILING",
    });
  }

  // Put wall — highest put GEX below spot
  const putWall = band
    .filter((b) => b.strike <= spot)
    .sort((a, b) => b.putGex - a.putGex)[0];
  if (putWall) {
    out.push({
      label: `PUT WALL ${fmtK(putWall.strike)}`,
      name: "PUT WALL",
      price: putWall.strike,
      kind: "putWall",
      gex: -putWall.putGex,
      tag: "FLOOR",
    });
  }

  // Zero gamma from profile curve
  if (profile.zeroGammaSpot) {
    out.push({
      label: `ZERO-Γ FLIP ${fmtK(profile.zeroGammaSpot)}`,
      name: "ZERO-Γ FLIP",
      price: profile.zeroGammaSpot,
      kind: "zeroGamma",
      tag: "FLIP",
    });
  }

  // Dominant magnet — largest NET positive GEX near spot
  const positive = band.filter((b) => b.netGex > 0).sort((a, b) => b.netGex - a.netGex);
  if (positive[0]) {
    out.push({
      label: `DOMINANT MAG ${fmtK(positive[0].strike)}`,
      name: "DOMINANT MAG",
      price: positive[0].strike,
      kind: "dominantMag",
      gex: positive[0].netGex,
      tag: "MAG",
    });
  }
  if (positive[1]) {
    out.push({
      label: `STRONG MAG ${fmtK(positive[1].strike)}`,
      name: "STRONG MAG",
      price: positive[1].strike,
      kind: "strongMag",
      gex: positive[1].netGex,
      tag: "MAG",
    });
  }

  // Extreme vacuum — largest net NEGATIVE GEX band (zone of least hedging flow)
  // Constrained to ±2σ so it stops snapping to far-OTM strikes.
  const negative = tight.filter((b) => b.netGex < 0).sort((a, b) => a.netGex - b.netGex);
  if (negative[0]) {
    out.push({
      label: `EXTREME VAC ${fmtK(negative[0].strike)}`,
      name: "EXTREME VAC",
      price: negative[0].strike,
      kind: "extremeVac",
      gex: negative[0].netGex,
      tag: "VAC",
      note: "Liquidity vacuum — moves extend here",
    });
  }

  // MOPEX max pain (monthly exp bias)
  const mp = maxPain(rows);
  if (mp) {
    out.push({
      label: `MOPEX MAX PAIN ${fmtK(mp)}`,
      name: "MOPEX MAX PAIN",
      price: mp,
      kind: "mopexMaxPain",
      tag: "PIN",
    });
  }

  // Upside pivot — just above call wall, where vanna flip sits if present
  const upPivot = profile.zeroVannaSpot && callWall
    ? (profile.zeroVannaSpot > callWall.strike ? profile.zeroVannaSpot : callWall.strike * 1.008)
    : callWall ? callWall.strike * 1.005 : null;
  if (upPivot) {
    out.push({
      label: `UPSIDE PIVOT ${fmtK(upPivot)}`,
      name: "UPSIDE PIVOT",
      price: upPivot,
      kind: "upsidePivot",
      tag: "VOMMA",
    });
  }

  // Downside pivot — where charm flip sits, or just below put wall.
  // Clamp to ±2σ window — without this, the charm zero-crossing often
  // lands at a far-OTM strike (e.g. 6629) with no economic meaning.
  let downPivotRaw = profile.zeroCharmSpot && putWall
    ? (profile.zeroCharmSpot < putWall.strike ? profile.zeroCharmSpot : putWall.strike * 0.992)
    : putWall ? putWall.strike * 0.995 : null;
  if (downPivotRaw != null) {
    const downPivot = Math.max(downPivotRaw, twoSigmaDown);
    out.push({
      label: `DOWNSIDE PIVOT ${fmtK(downPivot)}`,
      name: "DOWNSIDE PIVOT",
      price: downPivot,
      kind: "downsidePivot",
      tag: "VOMMA",
    });
  }

  // ─── Experimental dealer-map levels (behind ?experimental=1) ───
  // These replicate the @OptionsDepth / Green-Room output: vanna flip,
  // zomma bridge, charm target, negative-gamma entry, upper/lower vomma.
  if (experimental) {
    // VANNA FLIP — the profile's zero-vanna spot, constrained to within 1σ
    // of spot (otherwise it's not the "nearest-to-spot flip" traders watch).
    if (profile.zeroVannaSpot && Math.abs(profile.zeroVannaSpot - spot) <= sigma * 1.5) {
      out.push({
        label: `VANNA FLIP ${fmtK(profile.zeroVannaSpot)}`,
        name: "VANNA FLIP",
        price: profile.zeroVannaSpot,
        kind: "vannaFlip",
        tag: "VANNA",
        note: "Sign change in ∂Δ/∂σ — hedge direction flips here",
      });
    }

    // ZOMMA BRIDGE — ∂Vega/∂σ peak at or below spot. We approximate this
    // from the curve: find spot where gex slope (d gex / d spot) is most
    // negative below current spot, i.e. the "shoulder" where γ compresses
    // fastest when vol rises. Serves as a support shelf when dealers long γ.
    const curveBelow = profile.curve.filter((p) => p.spot <= spot);
    if (curveBelow.length >= 3) {
      let bestIdx = -1, bestSlope = 0;
      for (let i = 1; i < curveBelow.length; i++) {
        const dGex = curveBelow[i].gex - curveBelow[i - 1].gex;
        const dS = curveBelow[i].spot - curveBelow[i - 1].spot;
        const slope = dS !== 0 ? dGex / dS : 0;
        if (slope > bestSlope) { bestSlope = slope; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        const zStrike = curveBelow[bestIdx].spot;
        if (zStrike >= twoSigmaDown) {
          out.push({
            label: `ZOMMA BRIDGE ${fmtK(zStrike)}`,
            name: "ZOMMA BRIDGE",
            price: zStrike,
            kind: "zommaBridge",
            tag: "SHELF",
            note: "∂Vega/∂σ shelf — vol-expansion support",
          });
        }
      }
    }

    // CHARM TARGET — where accumulated charm wants price to drift by expiry.
    // Take the callWall-side charm magnet: if dealers are short-γ and
    // long-charm above spot, charm decay pulls spot upward toward the strike
    // with highest |charm × OI|. We approximate with the highest netGex
    // strike above spot within 1σ.
    const charmBand = buckets.filter((b) => b.strike > spot && b.strike <= spot + sigma * 1.5);
    const charmTarget = charmBand.sort((a, b) => b.netGex - a.netGex)[0];
    if (charmTarget) {
      out.push({
        label: `CHARM TGT ${fmtK(charmTarget.strike)}`,
        name: "CHARM TARGET",
        price: charmTarget.strike,
        kind: "charmTarget",
        gex: charmTarget.netGex,
        tag: "DECAY",
        note: "Charm-decay magnet — dealers re-hedge toward here into close",
      });
    }

    // NEG γ ENTRY — first strike above spot where cumulative net-GEX flips
    // negative. This is the price level where dealer hedging starts amplifying
    // moves (the ignition point). Walk up from spot.
    const above = buckets.filter((b) => b.strike >= spot).sort((a, b) => a.strike - b.strike);
    let cum = 0;
    let negEntry: number | null = null;
    for (const b of above) {
      cum += b.netGex;
      if (cum < 0) { negEntry = b.strike; break; }
    }
    if (negEntry != null && negEntry <= twoSigmaUp) {
      out.push({
        label: `NEG γ ENTRY ${fmtK(negEntry)}`,
        name: "NEG γ ENTRY",
        price: negEntry,
        kind: "negGammaEntry",
        tag: "IGNITION",
        note: "Cumulative γ turns negative — trend-extension zone starts here",
      });
    }

    // UPPER VOMMA / LOWER VOMMA — far-OTM vomma peaks. Proxy: highest |netGex|
    // strike in the 1σ→2.5σ zone on each side (tails where ∂Vega/∂σ spikes).
    const upperBand = buckets.filter(
      (b) => b.strike > spot + sigma && b.strike <= spot + sigma * 2.5,
    );
    const upperVomma = upperBand.sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))[0];
    if (upperVomma) {
      out.push({
        label: `UPPER VOMMA ${fmtK(upperVomma.strike)}`,
        name: "UPPER VOMMA",
        price: upperVomma.strike,
        kind: "upperVomma",
        gex: upperVomma.netGex,
        tag: "TAIL",
        note: "Upside vomma pocket — IV-churn zone",
      });
    }

    const lowerBand = buckets.filter(
      (b) => b.strike < spot - sigma && b.strike >= spot - sigma * 2.5,
    );
    const lowerVomma = lowerBand.sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))[0];
    if (lowerVomma) {
      out.push({
        label: `LOWER VOMMA ${fmtK(lowerVomma.strike)}`,
        name: "LOWER VOMMA",
        price: lowerVomma.strike,
        kind: "lowerVomma",
        gex: lowerVomma.netGex,
        tag: "TAIL",
        note: "Downside vomma pocket — IV-churn zone",
      });
    }
  }

  // T1/T2 up/down — simple ATR-ish targets from GEX profile range
  const rng = profile.ranges.gex.max - profile.ranges.gex.min;
  const spread = Math.abs(callWall && putWall ? callWall.strike - putWall.strike : spot * 0.02);
  const t1Up = spot + spread * 0.8;
  const t2Up = spot + spread * 1.6;
  const t1Down = spot - spread * 0.8;
  const t2Down = spot - spread * 1.6;
  out.push({ label: `T1 UP ${fmtK(t1Up)}`, name: "T1 UP", price: t1Up, kind: "t1Up" });
  out.push({ label: `T2 UP ${fmtK(t2Up)}`, name: "T2 UP", price: t2Up, kind: "t2Up" });
  out.push({ label: `T1 DOWN ${fmtK(t1Down)}`, name: "T1 DOWN", price: t1Down, kind: "t1Down" });
  out.push({ label: `T2 DOWN ${fmtK(t2Down)}`, name: "T2 DOWN", price: t2Down, kind: "t2Down" });

  return out.sort((a, b) => b.price - a.price);
}

// ──────────────────────────────────────────────────────────────────────────
// Path generation — BASE / BULL / BEAR waypoints across the horizon.
// ──────────────────────────────────────────────────────────────────────────

function generatePaths(
  levels: ModelLevel[],
  spot: number,
  profile: ExposureProfile,
  horizon: Horizon,
  waypointDates: string[],
): ModelPath[] {
  const byKind = (k: string) => levels.find((l) => l.kind === k);
  const callWall = byKind("callWall");
  const putWall = byKind("putWall");
  const dominantMag = byKind("dominantMag");
  const strongMag = byKind("strongMag");
  const zeroGamma = byKind("zeroGamma");
  const upsidePivot = byKind("upsidePivot");
  const downsidePivot = byKind("downsidePivot");
  const t1Up = byKind("t1Up")!;
  const t1Down = byKind("t1Down")!;

  const totalGex = profile.current.gex;
  const regime: "positive" | "negative" = totalGex > 0 ? "positive" : "negative";

  // Probability split reflects regime:
  //   positive GEX → dampening → BASE gets highest weight (range-bound drift to magnet)
  //   negative GEX → amplifying → BULL / BEAR more likely (trends extend)
  const probs = regime === "positive"
    ? { base: 0.45, bull: 0.30, bear: 0.25 }
    : { base: 0.30, bull: 0.30, bear: 0.40 };

  const nWay = waypointDates.length;

  function path(
    kind: "base" | "bull" | "bear",
    endPrice: number,
    waypoints: number[],          // price at each intermediate date
  ): ModelPath {
    const wps: ModelPathWaypoint[] = waypointDates.map((d, i) => ({
      label: i === nWay - 1 ? `${d} ${fmtK(endPrice)}` : d,
      t: i / Math.max(1, nWay - 1),
      price: waypoints[i] ?? endPrice,
    }));
    // Force first waypoint to spot, last to endPrice
    wps[0].price = spot;
    wps[nWay - 1].price = endPrice;
    return {
      kind,
      name: kind === "base" ? "BASE" : kind === "bull" ? "BULL" : "BEAR",
      probability: probs[kind],
      target: endPrice,
      waypoints: wps,
      color: kind,
    };
  }

  // BASE = gravitate toward dominant magnet (or zero-γ if no magnet)
  const baseTarget = dominantMag?.price ?? zeroGamma?.price ?? spot;
  const basePath = path(
    "base",
    baseTarget,
    lerpPath(spot, baseTarget, nWay, 0.6),
  );

  // BULL = push through zero-γ → strong mag → call wall (capped at upside pivot).
  // Via waypoint must sit ABOVE spot AND BELOW the bull target — otherwise
  // midPath would send the bull path through a pivot on the wrong side
  // (e.g. a magnet that sits under spot) before arcing up to the target,
  // which produces a non-monotonic curve that dips below spot first.
  const bullTarget = upsidePivot?.price ?? callWall?.price ?? spot * 1.01;
  const bullViaRaw = strongMag?.price ?? zeroGamma?.price ?? spot * 1.003;
  const bullVia = bullViaRaw > spot && bullViaRaw < bullTarget ? bullViaRaw : null;
  const bullPath = path(
    "bull",
    bullTarget,
    bullVia ? [spot, ...midPath(spot, bullVia, bullTarget, nWay - 1)] : lerpPath(spot, bullTarget, nWay, 1.0),
  );

  // BEAR = break below put wall → downside pivot. Cap distance to avoid nonsense
  // multi-percent drops on weekly/monthly when the put wall sits right under spot.
  let bearTarget = downsidePivot?.price ?? putWall?.price ?? spot * 0.99;
  // Sanity clamp: bear target shouldn't exceed ~3% below spot for daily, ~5%
  // for weekly, ~7% for monthly — otherwise the curve dominates the chart.
  const maxDropPct =
    horizon === "daily" ? 0.03
      : horizon === "weekly" ? 0.05
      : horizon === "monthly" ? 0.07
      : 0.12;  // quarterly allows wider drawdown range
  if (bearTarget < spot * (1 - maxDropPct)) bearTarget = spot * (1 - maxDropPct);
  // Via waypoint must sit BELOW spot AND ABOVE the bear target. Without this
  // check, if zero-gamma is above spot (common in positive gamma regimes),
  // the bear curve is forced UP through it before collapsing — so the 12:00
  // bear waypoint ends up higher than the bull waypoint. Hard fallback to
  // a monotone linear path when no valid downside pivot is available.
  const bearViaRaw = zeroGamma?.price ?? t1Down.price;
  const bearVia = bearViaRaw && bearViaRaw < spot && bearViaRaw > bearTarget ? bearViaRaw : null;
  const bearPath = path(
    "bear",
    bearTarget,
    bearVia ? [spot, ...midPath(spot, bearVia, bearTarget, nWay - 1)] : lerpPath(spot, bearTarget, nWay, 1.0),
  );

  return [basePath, bullPath, bearPath];
}

function lerpPath(from: number, to: number, n: number, curve: number): number[] {
  // curve 0→1 controls how fast the move happens. curve=1 → linear, curve<1 →
  // front-loaded (fast move then drift), curve>1 → back-loaded.
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    const eased = Math.pow(t, curve);
    xs.push(from + (to - from) * eased);
  }
  return xs;
}

// 3-leg path: spot → via at midpoint → end
function midPath(spot: number, via: number, end: number, nAfter: number): number[] {
  if (nAfter < 2) return [end];
  const half = Math.max(1, Math.floor(nAfter / 2));
  const leg1 = lerpPath(spot, via, half + 1, 1.0).slice(1);
  const leg2 = lerpPath(via, end, nAfter - half + 1, 1.0).slice(1);
  return [...leg1, ...leg2];
}

// ──────────────────────────────────────────────────────────────────────────
// Audit block — right-sized summary matching the screenshot's top-left panel
// ──────────────────────────────────────────────────────────────────────────

// ─── Scenario probabilities ──────────────────────────────────────────────────
// Derived from gamma regime, DFI direction, distance to gamma zero,
// VIX term structure, and proximity to call/put walls.
//
// heuristic:
//   baseProb starts at 0.37 — positive GEX (dampening) boosts it, negative cuts it.
//   dfi > 0 (bullish flow) adds a bull boost via tanh ramp.
//   dfi < 0 (bearish flow) adds a bear boost.
//   #5: VIX term ratio < 1 (backwardation/inversion) = stress → bear weight up,
//   base weight cut. Term ratio >> 1 (steep contango) = calm → base weight up.
//   #5: spot within 50bps of call wall caps bull (gamma resistance overhead);
//   spot within 50bps of put wall caps bear (gamma support below). Within 15bps
//   the cap is harder still — scenarios collapse toward base.
//   Normalise to sum = 100, clamp each to minimum 10%.
function computeScenarioProb(
  gammaZone: "y+" | "y-",
  dfi: number,
  ctx?: {
    vixTermRatio: number | null;
    callWallDistBps: number | null;   // signed: + means wall above spot
    putWallDistBps: number | null;    // signed: - means wall below spot
  },
): { bull: number; base: number; bear: number } {
  const rawBase = 0.37 + (gammaZone === "y+" ? 0.08 : -0.08);
  const bullBoost = dfi > 0 ? 0.10 * Math.tanh(dfi / 3) : 0;
  const bearBoost = dfi < 0 ? 0.10 * Math.tanh(-dfi / 3) : 0;

  // #5a: VIX term structure tilt
  // term < 1 = backwardation (front-month richer than 3m) = stress
  // term > 1 = contango (calm)
  // map to a [-0.06, +0.04] tilt range; 1.0 = neutral
  let termBearTilt = 0;
  let termBaseTilt = 0;
  const term = ctx?.vixTermRatio ?? null;
  if (term != null) {
    if (term < 1) {
      // stress regime: punish base, reward bear
      const stress = Math.min(1, (1 - term) / 0.10); // 0..1 ramp; full at 0.90
      termBearTilt = 0.06 * stress;
      termBaseTilt = -0.04 * stress;
    } else {
      // calm regime: reward base modestly
      const calm = Math.min(1, (term - 1) / 0.15); // full at 1.15
      termBaseTilt = 0.04 * calm;
    }
  }

  let bull = 0.20 + bullBoost - (bearBoost * 0.5);
  let bear = 0.25 + bearBoost - (bullBoost * 0.5) + termBearTilt;
  let base = rawBase + termBaseTilt;

  // #5b: γ-wall distance caps. When spot is right under a call wall, upside
  // gets blocked by gamma resistance — shrink bull. When right above put wall,
  // downside is cushioned — shrink bear. The closer, the harder the cap.
  const callDist = ctx?.callWallDistBps ?? null;
  const putDist = ctx?.putWallDistBps ?? null;
  // Only matters when wall is on the relevant side of spot (call above, put below)
  if (callDist != null && callDist > 0 && callDist < 50) {
    // 0bps = full damp, 50bps = none
    const damp = (50 - callDist) / 50;            // 0..1
    const shrink = 0.40 * damp;                   // up to 40% bull haircut
    const moved = bull * shrink;
    bull -= moved;
    base += moved;
  }
  if (putDist != null && putDist < 0 && Math.abs(putDist) < 50) {
    const damp = (50 - Math.abs(putDist)) / 50;
    const shrink = 0.40 * damp;
    const moved = bear * shrink;
    bear -= moved;
    base += moved;
  }

  // Normalise
  const total = bull + bear + base;
  bull /= total; bear /= total; base /= total;

  // Clamp to minimum 10% each
  const clamp = (v: number) => Math.max(0.10, Math.min(0.80, v));
  bull = clamp(bull); base = clamp(base); bear = clamp(bear);

  // Re-normalise after clamping
  const total2 = bull + bear + base;
  bull /= total2; bear /= total2; base /= total2;

  return {
    bull: Math.round(bull * 100),
    base: Math.round(base * 100),
    bear: Math.round(bear * 100),
  };
}

function buildAudit(
  profile: ExposureProfile,
  levels: ModelLevel[],
  spot: number,
  intradayDelta: { change: number | null; windowMin: number | null },
  extras: {
    paths: ModelPath[];
    scenarioProbIn?: { bull: number; base: number; bear: number };
    iv1d: number | null;
    iv1dPrev: number | null;
    charmPrev: number | null;
    lastRecal: { at: number; dfi: number; dfiDeltaSinceOpen: number | null } | null;
    vixTermRatio?: number | null;
  },
): ModelAudit {
  const cur = profile.current;
  const byKind = (k: string) => levels.find((l) => l.kind === k);

  const slopeDir = cur.charm > 0 ? "UP" : "DN";
  const slopeDeg = Math.min(2.0, Math.abs(cur.charm) / 1e9 * 0.5).toFixed(2);
  const gammaZone = cur.gex >= 0 ? "y+" : "y-";
  const gammaZoneLabel = cur.gex >= 0 ? "DAMPENING" : "AMPLIFYING";

  // Path classification from GEX regime + charm direction
  let path = "range-bound";
  if (cur.gex < 0 && cur.charm < 0) path = "liquid path down";
  else if (cur.gex < 0 && cur.charm > 0) path = "liquid path up";
  else if (cur.gex > 0 && cur.charm < 0) path = "grind down into pin";
  else if (cur.gex > 0 && cur.charm > 0) path = "grind up into pin";

  // OPEX gravity — direction to nearest mopex max pain * distance in bps
  const mp = byKind("mopexMaxPain")?.price;
  let opexGravity = "—";
  if (mp) {
    const bps = Math.round((mp - spot) / spot * 10000);
    const arrow = bps > 0 ? "↑" : bps < 0 ? "↓" : "→";
    opexGravity = `${Math.abs(bps)}pt ${bps >= 0 ? "above" : "below"} ${fmtK(mp)} ${arrow} ${Math.abs(bps / 100).toFixed(1)}%`;
  }

  const nearby: ModelAudit["nearby"] = levels
    .filter((l) => l.kind !== "t1Up" && l.kind !== "t2Up" && l.kind !== "t1Down" && l.kind !== "t2Down" && l.kind !== "vommaPocket")
    .slice(0, 6)
    .map((l) => ({
      price: l.price,
      note: `${Math.round((l.price - spot) / spot * 10000)}bp · ${l.name}`,
      dir: l.price >= spot ? "up" : "down",
    }));

  const vannaBias: "positive" | "negative" = cur.vex >= 0 ? "positive" : "negative";
  // Vanna in $M (cur.vex is already $B * 0.01 per vol%, so scale: vex/$B * 100 = $M per 1% vol)
  const vannaM = parseFloat((cur.vex / 1e6).toFixed(1));

  const spotChange = (intradayDelta.change != null && intradayDelta.windowMin != null)
    ? `${intradayDelta.change >= 0 ? "+" : ""}${intradayDelta.change.toFixed(1)} in ${intradayDelta.windowMin} min`
    : "";

  // DFI — Delta Flow Indicator.
  // We derive it from the normalised DEX slope across the curve:
  // dDEX/dS evaluated at current spot, normalised to the GEX scale.
  // Positive DFI = bullish delta accumulation. Negative = bearish.
  // Range is roughly -5 to +5 in normal conditions.
  let dfi = 0;
  const curveLen = profile.curve.length;
  if (curveLen >= 3) {
    // Find index closest to spot in the curve
    const idx = profile.curve.reduce((best, p, i) =>
      Math.abs(p.spot - spot) < Math.abs(profile.curve[best].spot - spot) ? i : best, 0);
    const lo = profile.curve[Math.max(0, idx - 1)];
    const hi = profile.curve[Math.min(curveLen - 1, idx + 1)];
    const dDex = hi.dex - lo.dex;
    const dS = hi.spot - lo.spot;
    // Normalise: divide by the absolute GEX to get a unit-less ratio
    const gexAbs = Math.abs(cur.gex) || 1e6;
    dfi = dS !== 0 ? (dDex / dS) / gexAbs * 1e9 : 0;
    // Clamp to ±5
    dfi = Math.max(-5, Math.min(5, dfi));
    // Round to 2 decimals
    dfi = parseFloat(dfi.toFixed(2));
  }
  const dfiLabel = dfi > 0.1 ? "BULLISH" : dfi < -0.1 ? "BEARISH" : "NEUTRAL";
  // dfiFlipped: for real-time use — here we mark true when we're near the charm zero crossover
  const charmZero = profile.zeroCharmSpot;
  const dfiFlipped = charmZero != null && Math.abs(charmZero - spot) / spot < 0.003;

  // Main pivot: zero-gamma if present, otherwise dominant magnet
  const mainPivot = byKind("zeroGamma")?.price ?? byKind("dominantMag")?.price ?? null;

  // Double Zero Zone: the band between zero-gamma and zero-charm (where both flip sign)
  const zg = profile.zeroGammaSpot;
  const zc = profile.zeroCharmSpot;
  let doubleZeroLow: number | null = null;
  let doubleZeroHigh: number | null = null;
  if (zg != null && zc != null) {
    doubleZeroLow = Math.min(zg, zc);
    doubleZeroHigh = Math.max(zg, zc);
  }

  // Gamma at spot (signed GEX, for display)
  const gammaAtSpot = parseFloat((cur.gex / 1e6).toFixed(0)); // $M

  // #5: γ-wall distances (signed bps from spot) for scenario weighting
  const callWallPrice = byKind("callWall")?.price ?? null;
  const putWallPrice = byKind("putWall")?.price ?? null;
  const callWallDistBps = callWallPrice != null
    ? Math.round(((callWallPrice - spot) / spot) * 10_000)
    : null;
  const putWallDistBps = putWallPrice != null
    ? Math.round(((putWallPrice - spot) / spot) * 10_000)
    : null;
  const scenarioProb = extras.scenarioProbIn ?? computeScenarioProb(gammaZone, dfi, {
    vixTermRatio: extras.vixTermRatio ?? null,
    callWallDistBps,
    putWallDistBps,
  });

  // Selz #1 — charm-zero CLUSTER filtered to ±3% of spot
  const charmZeros = profile.zeroCharmSpots.filter((x) => Math.abs(x - spot) / spot <= 0.03);

  // Selz #2 — charm tightening: normalise |dCharm/dS| against the curve's own
  // charm range and spot range, giving a unitless "tightening index".
  // rate ≈ 1 means charm traverses its full range over the full spot window.
  // rate >> 1 means the slope at spot is much steeper than the avg slope —
  // charm is tightening fast around current spot (chop risk).
  const charmRange = Math.max(1, profile.ranges.charm.max - profile.ranges.charm.min);
  const spotRange = Math.max(1, spot * 0.1); // ±5% spot window baseline
  const avgSlope = charmRange / spotRange;
  const rawRate = avgSlope > 0 ? Math.abs(profile.charmSlope) / avgSlope : 0;
  const rate = parseFloat(rawRate.toFixed(2));
  // Thresholds tuned for this index: >3 = meaningful tightening near spot,
  // <0.8 = slope shallower than average (charm expanding), middle = steady.
  const CHOP_THRESHOLD = 3;
  let tightenLabel: "DECEL" | "STEADY" | "EXPANDING" = "STEADY";
  if (rate > CHOP_THRESHOLD) tightenLabel = "DECEL";
  else if (rate < 0.8) tightenLabel = "EXPANDING";
  const charmTightening = {
    rate,
    label: tightenLabel,
    chopFlag: tightenLabel === "DECEL",
    note: tightenLabel === "DECEL"
      ? `DECEL above ${CHOP_THRESHOLD} — charm tightening fast, chop risk into close`
      : tightenLabel === "EXPANDING"
        ? "Charm slope slackening — directional path easier"
        : "Charm slope steady — range-bound drift",
  };

  // Selz #5 — discrete BULL / BASE / BEAR close targets pulled straight from paths
  const bullPath = extras.paths.find((p) => p.kind === "bull");
  const basePath = extras.paths.find((p) => p.kind === "base");
  const bearPath = extras.paths.find((p) => p.kind === "bear");
  const closeTargets = {
    bull: bullPath ? { price: bullPath.target, prob: scenarioProb.bull } : null,
    base: basePath ? { price: basePath.target, prob: scenarioProb.base } : null,
    bear: bearPath ? { price: bearPath.target, prob: scenarioProb.bear } : null,
  };

  // Selz #4 — term structure DoD
  const iv1dNow = extras.iv1d;
  const iv1dDelta = (iv1dNow != null && extras.iv1dPrev != null) ? iv1dNow - extras.iv1dPrev : null;
  const charmNow = cur.charm / 1e9;
  const charmDelta = extras.charmPrev != null ? charmNow - extras.charmPrev : null;
  let dodLabel = "Flat";
  if (iv1dDelta != null && Math.abs(iv1dDelta) >= 0.25) {
    dodLabel = iv1dDelta > 0 ? "Vol Bid Up" : "Vol Offered";
  } else if (charmDelta != null && Math.abs(charmDelta) >= 0.5) {
    dodLabel = charmDelta > 0 ? "Charm Lifting" : "Charm Pressing";
  }
  const termStructureDoD = {
    iv1d: iv1dNow,
    iv1dPrev: extras.iv1dPrev,
    iv1dDelta,
    charmNow: parseFloat(charmNow.toFixed(2)),
    charmPrev: extras.charmPrev,
    label: dodLabel,
  };

  return {
    asOf: Math.floor(Date.now() / 1000),
    spot,
    spotChange,
    slope: `${slopeDir} ${slopeDeg}° → ${cur.charm >= 0 ? "+" : ""}${(cur.charm / 1e9).toFixed(2)}`,
    path,
    opexGravity,
    gexTotal: cur.gex,
    dex: cur.dex / 1e9,
    charmPerDay: cur.charm / 1e9,
    netCTrue: profile.netCTrue,
    vexPerVolPct: cur.vex / 1e9,
    vannaBias,
    vannaM,
    gammaZone,
    gammaZoneLabel,
    gammaAtSpot,
    dfi,
    dfiLabel,
    dfiFlipped,
    contractCount: profile.contractCount,
    mainPivot,
    charmZero,
    doubleZeroLow,
    doubleZeroHigh,
    scenarioProb,
    closeTargets,
    lastRecal: extras.lastRecal,
    termStructureDoD,
    charmZeros,
    charmTightening,
    nearby,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Public entry: build a ModelHorizon for a single (symbol, horizon)
// ──────────────────────────────────────────────────────────────────────────

export interface ModelBuildInput {
  horizon: Horizon;
  symbol: "^GSPC" | "SPY";
  chainSymbol: "SPY" | "SPX";              // CBOE source — SPY is always available
  vix: number | null;
  vixPrev: number | null;
  vix3m: number | null;
  intradayChange?: { change: number | null; windowMin: number | null };
  experimental?: boolean;
}

// SPX is priced at ~10× SPY; we use SPY's chain rescaled for strike labels if
// the user asks for SPX view. This is a shortcut — proper SPX chain is separate.
const SPX_OVER_SPY_HINT = 10.0;   // recomputed from actual spot each call

async function buildHorizon(input: ModelBuildInput): Promise<ModelHorizon> {
  const { horizon, symbol, chainSymbol, vix, vixPrev, vix3m, intradayChange } = input;

  // Fetch SPY chain — used regardless of whether we're building SPY or SPX model
  const chain = await getCboeChain(chainSymbol);
  const { rows: allRows, spot: spySpot } = chainToRows(chain, DTE_MAX[horizon]);
  if (!spySpot) throw new Error(`No spot in chain for ${chainSymbol}`);

  // Resolve real SPX spot from Schwab/Yahoo (NOT SPY×10 — SPY drifts vs SPX).
  // Compute true scale = realSpx / spySpot each call so strike rescaling stays honest.
  let displaySpot = spySpot;
  let scale = 1;
  if (symbol === "^GSPC") {
    const realSpx = await resolveRealSpxSpot();
    if (realSpx != null && realSpx > 0 && spySpot > 0) {
      displaySpot = realSpx;
      scale = realSpx / spySpot;
    } else {
      // Fallback only if both Schwab + Yahoo failed
      displaySpot = spySpot * SPX_OVER_SPY_HINT;
      scale = SPX_OVER_SPY_HINT;
    }
  }

  // Build exposure profile at SPY spot (real math), we'll rescale strikes for display
  const profile = buildExposureProfile(chainSymbol, allRows, spySpot, { r: 0.05, q: 0.013 });

  // Rescale buckets + levels to display spot
  const spyBuckets = bucketByStrike(allRows, spySpot, 0.05, 0.013);
  const displayBuckets: StrikeBucket[] = spyBuckets.map((b) => ({ ...b, strike: b.strike * scale }));
  const displayRows: ExposureRow[] = allRows.map((r) => ({ ...r, strike: r.strike * scale }));

  // Build scaled profile-lite with just what extractLevels needs
  const scaledProfile: ExposureProfile = {
    ...profile,
    currentSpot: displaySpot,
    curve: profile.curve.map((p) => ({ ...p, spot: p.spot * scale })),
    current: { ...profile.current, spot: displaySpot },
    zeroGammaSpot: profile.zeroGammaSpot != null ? profile.zeroGammaSpot * scale : null,
    zeroCharmSpot: profile.zeroCharmSpot != null ? profile.zeroCharmSpot * scale : null,
    zeroCharmSpots: profile.zeroCharmSpots.map((x) => x * scale),
    zeroVannaSpot: profile.zeroVannaSpot != null ? profile.zeroVannaSpot * scale : null,
    charmSlope: profile.charmSlope,
  };

  const levels = extractLevels(
    displayBuckets,
    scaledProfile,
    displaySpot,
    displayRows,
    horizon,
    vix,
    input.experimental ?? false,
  );
  const { spotAnchorDate, targetDate, targetDateLong, waypointLabels } = buildHorizonDates(horizon);
  const paths = generatePaths(levels, displaySpot, scaledProfile, horizon, waypointLabels);

  // ---- Selz #3/#4: intraday recal + DoD lookups ----
  const tradeDate = etTradeDate(new Date());
  const iv1dNow = vix != null ? vix / Math.sqrt(252) : null;
  const prevDay = storage.getPrevTradeDayRecal(symbol, horizon, tradeDate);
  const lastRecalRow = storage.getLatestRecal(symbol, horizon);
  const openRecal = storage.getTodayOpenRecal(symbol, horizon, tradeDate);

  // Compute DFI FIRST (duplicates logic from buildAudit — we need it for snapshot storage)
  let dfiForSnap = 0;
  const curveLen = scaledProfile.curve.length;
  if (curveLen >= 3) {
    let idx = 0;
    for (let i = 1; i < curveLen; i++) {
      if (Math.abs(scaledProfile.curve[i].spot - displaySpot) < Math.abs(scaledProfile.curve[idx].spot - displaySpot)) idx = i;
    }
    const lo = scaledProfile.curve[Math.max(0, idx - 1)];
    const hi = scaledProfile.curve[Math.min(curveLen - 1, idx + 1)];
    const dDex = hi.dex - lo.dex;
    const dS = hi.spot - lo.spot;
    const gexAbs = Math.abs(scaledProfile.current.gex) || 1e6;
    dfiForSnap = dS !== 0 ? Math.max(-5, Math.min(5, (dDex / dS) / gexAbs * 1e9)) : 0;
    dfiForSnap = parseFloat(dfiForSnap.toFixed(2));
  }

  // Record the recal — throttle to at most one write per 30 minutes per (symbol, horizon)
  const nowS = Math.floor(Date.now() / 1000);
  const MIN_RECAL_GAP = 30 * 60;
  if (!lastRecalRow || nowS - lastRecalRow.capturedAt >= MIN_RECAL_GAP) {
    try {
      storage.insertModelRecal({
        symbol, horizon, capturedAt: nowS, tradeDate,
        spot: displaySpot, dfi: dfiForSnap,
        charmPerDay: scaledProfile.current.charm / 1e9,
        iv1d: iv1dNow,
        charmZero: scaledProfile.zeroCharmSpot,
        zeroGamma: scaledProfile.zeroGammaSpot,
      });
    } catch { /* table may not exist in legacy DB — swallow */ }
  }

  const latestForDisplay = storage.getLatestRecal(symbol, horizon);
  const lastRecalOut = latestForDisplay
    ? {
        at: latestForDisplay.capturedAt,
        dfi: latestForDisplay.dfi,
        dfiDeltaSinceOpen: openRecal ? parseFloat((latestForDisplay.dfi - openRecal.dfi).toFixed(2)) : null,
      }
    : null;

  // #5: VIX term ratio fed into scenario weighting
  const vixTermRatioForAudit = vix && vix3m ? vix3m / vix : null;

  const audit = buildAudit(scaledProfile, levels, displaySpot, intradayChange ?? { change: null, windowMin: null }, {
    paths,
    iv1d: iv1dNow,
    iv1dPrev: prevDay?.iv1d ?? null,
    charmPrev: prevDay?.charmPerDay ?? null,
    lastRecal: lastRecalOut,
    vixTermRatio: vixTermRatioForAudit,
  });

  // Price range: widest of call wall → put wall vs. ±2% of spot, padded
  const cw = levels.find((l) => l.kind === "callWall")?.price ?? displaySpot * 1.02;
  const pw = levels.find((l) => l.kind === "putWall")?.price ?? displaySpot * 0.98;
  const t2Up = levels.find((l) => l.kind === "t2Up")?.price ?? displaySpot * 1.03;
  const t2Dn = levels.find((l) => l.kind === "t2Down")?.price ?? displaySpot * 0.97;
  const yMax = Math.max(cw, t2Up, displaySpot * 1.015);
  const yMin = Math.min(pw, t2Dn, displaySpot * 0.985);

  const termRatio = vix && vix3m ? vix3m / vix : null;
  const termLabel = termRatio && termRatio > 1 ? "contango (calm front-end)" : "backwardation (stress front-end)";
  const vixChangePct = vix && vixPrev ? ((vix - vixPrev) / vixPrev) * 100 : null;
  const vomma: "elevated" | "normal" = (vix ?? 0) > 20 ? "elevated" : "normal";
  const confidence: "HIGH" | "MODERATE" | "LOW" =
    Math.abs(scaledProfile.current.gex) > 5e9 ? "HIGH" : Math.abs(scaledProfile.current.gex) > 1e9 ? "MODERATE" : "LOW";

  const horizonDays = horizon === "daily" ? 1 : horizon === "weekly" ? 5 : horizon === "monthly" ? 21 : 63;

  // ── #4: per-level live status vs spot (held / approaching / broken) ────
  // "approaching" threshold is 15bps (0.15%) which corresponds to ~SPX 11pt
  // or ~SPY 1.05 — tight enough to catch real tags, loose enough not to
  // flicker on quote noise. Sides: levels above spot are resistance, below
  // are support. Status flips based on whether the most recent traded spot
  // has crossed (broken) or merely touched (approaching) the level.
  const APPROACH_BPS = 15;
  const enrichedLevels: ModelLevel[] = levels.map((lv) => {
    const distBps = ((lv.price - displaySpot) / displaySpot) * 10_000;
    const absBps = Math.abs(distBps);
    let side: ModelLevel["side"] = distBps > 5 ? "resistance" : distBps < -5 ? "support" : "at";
    let status: ModelLevel["status"];
    if (side === "resistance") {
      // Above spot — still HELD as ceiling; BROKEN if spot crossed it (won't usually fire here since side=='resistance' means level > spot)
      status = absBps <= APPROACH_BPS ? "approaching" : "held";
    } else if (side === "support") {
      // Below spot — HELD as floor; APPROACHING if within threshold
      status = absBps <= APPROACH_BPS ? "approaching" : "held";
    } else {
      // At spot — currently being tested
      status = "approaching";
    }
    return { ...lv, distBps: Math.round(distBps), side, status };
  });

  // ── #3: derive rangeBox from nearest resistance + nearest support ──────
  // Prefers structural levels (charm-zero, vanna flip, dominant magnet,
  // pivots, walls) over T1/T2 targets so the band reflects DEALER mechanics,
  // not just ATR projections. Skips kinds that are themselves price targets
  // rather than supply/demand structure.
  const STRUCTURAL_KINDS = new Set<ModelLevel["kind"]>([
    "callWall", "putWall", "zeroGamma", "dominantMag", "strongMag",
    "upsidePivot", "downsidePivot", "charmTarget", "vannaFlip",
    "negGammaEntry", "upperVomma", "lowerVomma",
  ]);
  const structural = enrichedLevels.filter((lv) => STRUCTURAL_KINDS.has(lv.kind));
  const aboveSpot = structural
    .filter((lv) => lv.price > displaySpot)
    .sort((a, b) => a.price - b.price);
  const belowSpot = structural
    .filter((lv) => lv.price < displaySpot)
    .sort((a, b) => b.price - a.price);
  const nearestUp = aboveSpot[0] ?? null;
  const nearestDn = belowSpot[0] ?? null;

  let rangeBox: ModelHorizon["rangeBox"] = null;
  if (nearestUp && nearestDn) {
    const high = nearestUp.price;
    const low = nearestDn.price;
    const width = high - low;
    const widthPct = (width / displaySpot) * 100;
    let status: "contained" | "breakout" | "breakdown" = "contained";
    if (displaySpot > high) status = "breakout";
    else if (displaySpot < low) status = "breakdown";
    rangeBox = {
      low, high, width, widthPct,
      breakoutTrigger: high,
      breakdownTrigger: low,
      status,
      anchorHigh: { name: nearestUp.name, kind: nearestUp.kind },
      anchorLow:  { name: nearestDn.name, kind: nearestDn.kind },
    };
  }

  const horizonOut: ModelHorizon = {
    horizon,
    label: `${symbol === "^GSPC" ? "SPX" : "SPY"} ${horizon.toUpperCase()} MODEL`,
    symbol,
    displaySymbol: symbol === "^GSPC" ? "SPX" : "SPY",
    spot: displaySpot,
    spotAnchorDate,
    targetDate,
    targetDateLong,
    priceRange: [yMin, yMax],
    rangeBox,
    levels: enrichedLevels,
    paths,
    audit,
    vol: {
      vix, vixChangePct,
      termRatio,
      termLabel,
    },
    vomma,
    confidence,
  };

  // MM probability matrix — 5×5 regime × zone grid with conditional probs + action tags
  try {
    horizonOut.mmMatrix = buildMMMatrix(horizonOut, horizonDays);
  } catch (e) {
    // Non-fatal — matrix is supplementary
  }

  return horizonOut;
}

export async function buildModelsSnapshot(input: {
  vix: number | null;
  vixPrev: number | null;
  vix3m: number | null;
  spxIntraday?: { change: number | null; windowMin: number | null };
  spyIntraday?: { change: number | null; windowMin: number | null };
  symbols?: Array<"^GSPC" | "SPY">;
  horizons?: Horizon[];
  experimental?: boolean;
}): Promise<ModelsResponse> {
  const warnings: string[] = [];
  const symbols = input.symbols ?? ["^GSPC", "SPY"];
  const horizons = input.horizons ?? (["daily", "weekly", "monthly", "quarterly"] as Horizon[]);

  const out: ModelsResponse = {
    asOf: Math.floor(Date.now() / 1000),
    session: "live",
    horizons: { daily: null, weekly: null, monthly: null, quarterly: null },
    warnings,
    experimental: input.experimental ?? false,
  };

  // We build once per (symbol, horizon) but the UI currently picks one symbol at
  // a time — so we return a horizons map, with each entry defaulting to the
  // first requested symbol. The client can re-request with ?symbol= later.
  const primarySymbol = symbols[0];

  await Promise.all(
    horizons.map(async (h) => {
      try {
        const mh = await buildHorizon({
          horizon: h,
          symbol: primarySymbol,
          chainSymbol: "SPY",
          vix: input.vix,
          vixPrev: input.vixPrev,
          vix3m: input.vix3m,
          intradayChange: primarySymbol === "^GSPC" ? input.spxIntraday : input.spyIntraday,
          experimental: input.experimental ?? false,
        });
        out.horizons[h] = mh;
      } catch (e: any) {
        warnings.push(`${h} model failed: ${e?.message ?? e}`);
      }
    }),
  );

  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n >= 1000) return Math.round(n).toLocaleString();
  return n.toFixed(2);
}

function buildHorizonDates(h: Horizon): {
  spotAnchorDate: string;
  targetDate: string;
  targetDateLong: string;
  waypointLabels: string[];
} {
  const now = new Date();
  const dayNames = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mm = (d: Date) => d.getMonth() + 1;
  const dd = (d: Date) => d.getDate();
  const fmt = (d: Date) => `${dayNames[d.getDay()]} ${mm(d)}/${dd(d)}`;
  const fmtLong = (d: Date) => `${dayNames[d.getDay()].toUpperCase()} ${monthNames[d.getMonth()].toUpperCase()} ${dd(d)}, ${d.getFullYear()}`;

  const spotAnchorDate = fmt(now);

  if (h === "daily") {
    const labels = ["OPEN", "10:30", "12:00", "14:00", "CLOSE"];
    return { spotAnchorDate, targetDate: `${spotAnchorDate} CLOSE`, targetDateLong: fmtLong(now), waypointLabels: labels };
  }

  if (h === "weekly") {
    // Find the Monday of the target week. If today is Sat/Sun, that's the upcoming
    // Monday. If we're already mid-week (Mon–Fri), use the current week's Monday so
    // historical+forward path stays anchored to the same trading week.
    const dow = now.getDay(); // 0=Sun..6=Sat
    const mon = new Date(now);
    if (dow === 0) mon.setDate(now.getDate() + 1);          // Sun → next Mon
    else if (dow === 6) mon.setDate(now.getDate() + 2);     // Sat → next Mon
    else mon.setDate(now.getDate() - (dow - 1));            // Mon..Fri → this Mon
    // Build full Mon–Fri label set (5 trading days)
    const labels: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      labels.push(fmt(d));
    }
    const fri = new Date(mon);
    fri.setDate(mon.getDate() + 4);
    return { spotAnchorDate, targetDate: fmt(fri), targetDateLong: fmtLong(fri), waypointLabels: labels };
  }

  if (h === "monthly") {
    // monthly — target 3rd Friday of this month (or next if passed)
    const third = thirdFridayOf(now);
    const target = now > third ? thirdFridayOf(new Date(now.getFullYear(), now.getMonth() + 1, 1)) : third;
    const weeks = Math.max(1, Math.ceil((target.getTime() - now.getTime()) / (7 * 86400000)));
    const labels: string[] = [];
    for (let i = 0; i <= weeks; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + i * 7);
      if (d > target) break;
      labels.push(fmt(d));
    }
    if (labels.length < 2) labels.push(fmt(target));
    return { spotAnchorDate, targetDate: fmt(target), targetDateLong: fmtLong(target), waypointLabels: labels };
  }

  // quarterly — target 3rd Friday three months out
  const m3 = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  const target = thirdFridayOf(m3);
  // Waypoints: each monthly OPEX along the path (this month, +1mo, +2mo, +3mo)
  const labels: string[] = [spotAnchorDate];
  for (let i = 1; i <= 3; i++) {
    const midMonth = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const opex = thirdFridayOf(midMonth);
    labels.push(fmt(opex));
  }
  return { spotAnchorDate, targetDate: fmt(target), targetDateLong: fmtLong(target), waypointLabels: labels };
}

function thirdFridayOf(ref: Date): Date {
  const d = new Date(ref.getFullYear(), ref.getMonth(), 1);
  let fridays = 0;
  while (d.getMonth() === ref.getMonth()) {
    if (d.getDay() === 5) {
      fridays += 1;
      if (fridays === 3) return new Date(d);
    }
    d.setDate(d.getDate() + 1);
  }
  // Fallback — last day of month
  return new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
}
