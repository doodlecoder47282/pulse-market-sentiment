// server/mmMatrix.ts
//
// Market-Maker Probability Matrix — a 5×5 grid where rows = dealer regime and
// columns = price zones relative to structure. Each cell carries conditional
// probabilities of up / down / pin, expected move magnitude, and a dealer
// action tag. Consumes the model horizon's audit + levels + vol context.
//
// Rows (dealer regime):
//   LONG_GAMMA      positive GEX, shallow charm                     → pin/fade
//   NEUTRAL         near 0-Γ flip, charm tightening                 → hedge reactively
//   SHORT_GAMMA     negative GEX, steep charm                       → chase/amplify
//   VANNA_DRIVEN    VIX DoD dominates                               → vol-flow led
//   CHARM_DRIVEN    OPEX proximity + strong charm                   → time-decay squeeze
//
// Columns (price zone relative to structure):
//   ABOVE_CALL      above Call Wall                                 → breakout
//   CW_TO_0G        between 0-Γ and Call Wall                       → upper positive gamma
//   AT_0G           within ±0.25% of 0-Γ flip                       → max confusion
//   0G_TO_PW        between Put Wall and 0-Γ                        → lower negative gamma
//   BELOW_PW        below Put Wall                                  → vacuum / tail
//
// Cell output:
//   pUp / pDown / pPin    probabilities (sum to 100)
//   magnitude             expected absolute move over horizon ($ points)
//   action                dealer action tag: defend | accelerate | fade | pin | capitulate
//   bias                  net directional bias (−1 .. +1)

import type { ModelHorizon, ModelLevel } from "./models";

export type MMRegime =
  | "LONG_GAMMA"
  | "NEUTRAL"
  | "SHORT_GAMMA"
  | "VANNA_DRIVEN"
  | "CHARM_DRIVEN";

export type MMZone =
  | "ABOVE_CALL"
  | "CW_TO_0G"
  | "AT_0G"
  | "0G_TO_PW"
  | "BELOW_PW";

export type DealerAction = "defend" | "accelerate" | "fade" | "pin" | "capitulate";

export interface MMCell {
  regime: MMRegime;
  zone: MMZone;
  pUp: number;         // 0..100
  pDown: number;       // 0..100
  pPin: number;        // 0..100
  magnitude: number;   // expected absolute $ move
  action: DealerAction;
  bias: number;        // -1..+1
  intensity: number;   // 0..1 — how strong the dealer bias is (drives color weight)
}

export interface MMMatrix {
  asOf: number;
  currentRegime: MMRegime;
  currentZone: MMZone;
  regimes: MMRegime[];  // row order
  zones: MMZone[];      // column order
  cells: MMCell[];      // 25 cells (regimes × zones)
  notes: {
    regime: string;     // human explanation of current regime pick
    zone: string;       // human explanation of current zone pick
    summary: string;    // 1-line takeaway for the current (regime, zone) cell
  };
}

const REGIMES: MMRegime[] = ["LONG_GAMMA", "NEUTRAL", "SHORT_GAMMA", "VANNA_DRIVEN", "CHARM_DRIVEN"];
const ZONES: MMZone[] = ["ABOVE_CALL", "CW_TO_0G", "AT_0G", "0G_TO_PW", "BELOW_PW"];

// ──────────────────────────────────────────────────────────────────────────
// Classify current regime from audit
// ──────────────────────────────────────────────────────────────────────────

interface RegimeInputs {
  gexTotal: number;           // signed $ / 1%
  gammaZone: "y+" | "y-";
  charmTighteningRate: number;
  charmChopFlag: boolean;
  vixDelta: number | null;    // DoD change
  dteToOpex: number;          // days to nearest Friday
  vannaM: number;             // signed $M (positive = IV↓ pulls spot up)
  vannaBias: "positive" | "negative";
  charmZero: number | null;   // primary charm-zero spot
  dfi: number;                // delta flow indicator, signed
}

function classifyRegime(inp: RegimeInputs): { regime: MMRegime; note: string } {
  const absGex = Math.abs(inp.gexTotal);
  const gexB = absGex / 1e9;

  // CHARM_DRIVEN wins if OPEX imminent AND charm is meaningful
  if (inp.dteToOpex <= 1 && inp.charmChopFlag) {
    return {
      regime: "CHARM_DRIVEN",
      note: `OPEX proximity (${inp.dteToOpex}D) + charm tightening — delta rebalance pressure into close`,
    };
  }

  // VANNA_DRIVEN if VIX moved >1pt DoD and vanna exposure is material
  if (inp.vixDelta != null && Math.abs(inp.vixDelta) >= 1.0 && Math.abs(inp.vannaM) > 100) {
    return {
      regime: "VANNA_DRIVEN",
      note: `VIX ${inp.vixDelta > 0 ? "+" : ""}${inp.vixDelta.toFixed(2)} DoD · vanna ${inp.vannaM > 0 ? "+" : ""}${(inp.vannaM/1000).toFixed(1)}B — IV-flow is steering spot`,
    };
  }

  // NEUTRAL if gamma is thin (< 1B) — dealers aren't anchored either way
  if (gexB < 1.0) {
    return {
      regime: "NEUTRAL",
      note: `Low GEX (${gexB.toFixed(2)}B) — dealers transitioning, hedge reactively`,
    };
  }

  if (inp.gammaZone === "y+") {
    return {
      regime: "LONG_GAMMA",
      note: `Positive GEX (${gexB.toFixed(1)}B) — dealers dampen moves, sell rips / buy dips`,
    };
  }
  return {
    regime: "SHORT_GAMMA",
    note: `Negative GEX (${gexB.toFixed(1)}B) — dealers amplify moves, chase direction`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Classify current zone from spot vs levels
// ──────────────────────────────────────────────────────────────────────────

// Zone position — how deep inside the zone spot sits.
// 0 = at lower boundary (closer to PW side), 1 = at upper boundary (closer to CW side).
interface ZoneClassification {
  zone: MMZone;
  note: string;
  positionInZone: number;     // 0..1 — where spot sits within its zone
  distToNearestPct: number;   // % distance to nearest structural level
}

function classifyZone(spot: number, levels: ModelLevel[]): ZoneClassification {
  const cw = levels.find(l => l.kind === "callWall")?.price ?? null;
  const pw = levels.find(l => l.kind === "putWall")?.price ?? null;
  const zg = levels.find(l => l.kind === "zeroGamma")?.price ?? null;

  const nearest = [cw, pw, zg].filter((x): x is number => x != null)
    .reduce((best, x) => Math.abs(x - spot) < Math.abs(best - spot) ? x : best, Infinity);
  const distToNearestPct = Number.isFinite(nearest) ? Math.abs((nearest - spot) / spot) * 100 : 0;

  if (cw != null && spot > cw) {
    const overrun = (spot - cw) / spot;
    return {
      zone: "ABOVE_CALL",
      note: `Spot ${overrun > 0.005 ? "well " : ""}above Call Wall (${cw.toFixed(0)}) — breakout, dealers short calls`,
      positionInZone: Math.min(1, overrun / 0.01),
      distToNearestPct,
    };
  }
  if (pw != null && spot < pw) {
    const underrun = (pw - spot) / spot;
    return {
      zone: "BELOW_PW",
      note: `Spot ${underrun > 0.005 ? "well " : ""}below Put Wall (${pw.toFixed(0)}) — vacuum, no dealer support`,
      positionInZone: 1 - Math.min(1, underrun / 0.01),
      distToNearestPct,
    };
  }
  if (zg != null && Math.abs(spot - zg) / spot < 0.0025) {
    return {
      zone: "AT_0G",
      note: `Spot at 0-Γ flip (${zg.toFixed(0)}, ${((spot-zg)/spot*100).toFixed(2)}%) — max dealer confusion, vol node`,
      positionInZone: 0.5 + ((spot - zg) / spot) * 100, // -0.25..0.25 → skew above/below 0.5
      distToNearestPct,
    };
  }
  if (zg != null && spot > zg && cw != null) {
    const pos = (spot - zg) / (cw - zg);
    return {
      zone: "CW_TO_0G",
      note: `Between 0-Γ (${zg.toFixed(0)}) and Call Wall (${cw.toFixed(0)}) — ${pos > 0.7 ? "hugging CW" : pos < 0.3 ? "drifting to 0-Γ" : "mid-range"} positive gamma`,
      positionInZone: Math.max(0, Math.min(1, pos)),
      distToNearestPct,
    };
  }
  if (zg != null && spot < zg && pw != null) {
    const pos = (spot - pw) / (zg - pw);
    return {
      zone: "0G_TO_PW",
      note: `Between Put Wall (${pw.toFixed(0)}) and 0-Γ (${zg.toFixed(0)}) — ${pos < 0.3 ? "hugging PW" : pos > 0.7 ? "drifting to 0-Γ" : "mid-range"} negative gamma`,
      positionInZone: Math.max(0, Math.min(1, pos)),
      distToNearestPct,
    };
  }
  if (zg != null) {
    return spot > zg
      ? { zone: "CW_TO_0G", note: `Above 0-Γ — positive gamma regime`, positionInZone: 0.5, distToNearestPct }
      : { zone: "0G_TO_PW", note: `Below 0-Γ — negative gamma regime`, positionInZone: 0.5, distToNearestPct };
  }
  return { zone: "AT_0G", note: `Structure unclear — treating as flip zone`, positionInZone: 0.5, distToNearestPct };
}

// ──────────────────────────────────────────────────────────────────────────
// Base probability table (pUp, pDown, pPin, action, intensity) per (regime, zone)
// These are calibrated priors. Live context then tilts them.
// ──────────────────────────────────────────────────────────────────────────

type BaseCell = { pUp: number; pDown: number; pPin: number; action: DealerAction; intensity: number };

const BASE_TABLE: Record<MMRegime, Record<MMZone, BaseCell>> = {
  LONG_GAMMA: {
    ABOVE_CALL: { pUp: 20, pDown: 55, pPin: 25, action: "fade",        intensity: 0.75 },
    CW_TO_0G:   { pUp: 25, pDown: 25, pPin: 50, action: "pin",         intensity: 0.85 },
    AT_0G:      { pUp: 35, pDown: 35, pPin: 30, action: "pin",         intensity: 0.45 },
    "0G_TO_PW": { pUp: 35, pDown: 25, pPin: 40, action: "defend",      intensity: 0.6  },
    BELOW_PW:   { pUp: 55, pDown: 20, pPin: 25, action: "defend",      intensity: 0.75 },
  },
  NEUTRAL: {
    ABOVE_CALL: { pUp: 35, pDown: 45, pPin: 20, action: "fade",        intensity: 0.45 },
    CW_TO_0G:   { pUp: 35, pDown: 35, pPin: 30, action: "pin",         intensity: 0.4  },
    AT_0G:      { pUp: 40, pDown: 40, pPin: 20, action: "fade",        intensity: 0.3  },
    "0G_TO_PW": { pUp: 35, pDown: 40, pPin: 25, action: "accelerate",  intensity: 0.4  },
    BELOW_PW:   { pUp: 40, pDown: 45, pPin: 15, action: "capitulate",  intensity: 0.55 },
  },
  SHORT_GAMMA: {
    ABOVE_CALL: { pUp: 60, pDown: 25, pPin: 15, action: "accelerate",  intensity: 0.85 },
    CW_TO_0G:   { pUp: 50, pDown: 30, pPin: 20, action: "accelerate",  intensity: 0.65 },
    AT_0G:      { pUp: 40, pDown: 45, pPin: 15, action: "accelerate",  intensity: 0.7  },
    "0G_TO_PW": { pUp: 25, pDown: 55, pPin: 20, action: "accelerate",  intensity: 0.8  },
    BELOW_PW:   { pUp: 15, pDown: 70, pPin: 15, action: "capitulate",  intensity: 0.95 },
  },
  VANNA_DRIVEN: {
    // Sign of vixDelta adjusts pUp/pDown downstream. Base assumes vol-up scenario.
    ABOVE_CALL: { pUp: 30, pDown: 55, pPin: 15, action: "fade",        intensity: 0.65 },
    CW_TO_0G:   { pUp: 35, pDown: 45, pPin: 20, action: "fade",        intensity: 0.55 },
    AT_0G:      { pUp: 35, pDown: 40, pPin: 25, action: "fade",        intensity: 0.4  },
    "0G_TO_PW": { pUp: 30, pDown: 50, pPin: 20, action: "accelerate",  intensity: 0.7  },
    BELOW_PW:   { pUp: 25, pDown: 60, pPin: 15, action: "capitulate",  intensity: 0.85 },
  },
  CHARM_DRIVEN: {
    // Charm pulls toward 0-Γ / max pain into close
    ABOVE_CALL: { pUp: 25, pDown: 55, pPin: 20, action: "fade",        intensity: 0.7  },
    CW_TO_0G:   { pUp: 20, pDown: 40, pPin: 40, action: "pin",         intensity: 0.65 },
    AT_0G:      { pUp: 25, pDown: 25, pPin: 50, action: "pin",         intensity: 0.9  },
    "0G_TO_PW": { pUp: 40, pDown: 20, pPin: 40, action: "pin",         intensity: 0.65 },
    BELOW_PW:   { pUp: 55, pDown: 25, pPin: 20, action: "defend",      intensity: 0.7  },
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Tilt base probabilities with live context
// ──────────────────────────────────────────────────────────────────────────

function tilt(
  base: BaseCell,
  regime: MMRegime,
  zone: MMZone,
  inp: RegimeInputs,
  isCurrentCell: boolean,
  positionInZone: number,
  spot: number,
): BaseCell {
  let pUp = base.pUp;
  let pDown = base.pDown;
  let pPin = base.pPin;

  // VANNA tilt — use both VIX delta AND live vanna sign at spot
  if (regime === "VANNA_DRIVEN") {
    // Sign of vanna exposure at spot tells us which direction IV moves pull spot
    if (inp.vannaBias === "positive" && inp.vixDelta != null && inp.vixDelta < 0) {
      const shift = Math.min(14, Math.abs(inp.vixDelta) * 5);
      pUp += shift; pDown -= shift;
    } else if (inp.vannaBias === "negative" && inp.vixDelta != null && inp.vixDelta > 0) {
      const shift = Math.min(14, inp.vixDelta * 5);
      pDown += shift; pUp -= shift;
    } else if (inp.vixDelta != null) {
      // Countervailing vanna sign — smaller shift
      const shift = Math.min(6, Math.abs(inp.vixDelta) * 2);
      if (inp.vixDelta < 0) { pUp += shift; pDown -= shift; }
      else { pDown += shift; pUp -= shift; }
    }
  }

  // CHARM tilt — spot vs charmZero tells us drift direction
  if (regime === "CHARM_DRIVEN" && inp.charmZero != null) {
    const drift = (inp.charmZero - spot) / spot;
    if (Math.abs(drift) > 0.001) {
      // Charm pulls spot toward charmZero into close
      const shift = Math.min(10, Math.abs(drift) * 800);
      if (drift > 0) { pUp += shift; pDown -= shift; }
      else { pDown += shift; pUp -= shift; }
    }
    // Charm tightening — deepens the pin
    if (inp.charmChopFlag) {
      const pinBoost = Math.min(10, inp.charmTighteningRate * 3);
      pPin += pinBoost;
      pUp -= pinBoost / 2; pDown -= pinBoost / 2;
    }
  }

  // DFI tilt — live delta flow direction nudges up/down across all regimes
  if (Math.abs(inp.dfi) > 0.1) {
    const shift = Math.min(6, Math.abs(inp.dfi) * 5);
    if (inp.dfi > 0) { pUp += shift; pDown -= shift; }
    else { pDown += shift; pUp -= shift; }
  }

  // Charm tightening across non-CHARM regimes — smaller pin boost
  if (regime !== "CHARM_DRIVEN" && inp.charmChopFlag) {
    const shift = Math.min(6, inp.charmTighteningRate * 2);
    pPin += shift;
    const half = shift / 2;
    pUp -= half; pDown -= half;
  }

  // CURRENT CELL — apply position-in-zone tilt
  // Higher positionInZone = closer to upper level → reduces pUp, raises pDown (ceiling nearby)
  // Lower positionInZone = closer to lower level → raises pUp, reduces pDown (floor nearby)
  if (isCurrentCell) {
    const zonePull = positionInZone - 0.5; // -0.5..+0.5
    // In negative gamma zones, position-pull is amplified (dealers accelerate toward boundary)
    const amplify = (zone === "0G_TO_PW" || zone === "BELOW_PW" || zone === "ABOVE_CALL") ? 14 : 8;
    const posShift = zonePull * amplify;
    // Near upper boundary (>0.7): headwind to upside
    if (positionInZone > 0.65) { pDown += Math.abs(posShift); pUp -= Math.abs(posShift); }
    else if (positionInZone < 0.35) { pUp += Math.abs(posShift); pDown -= Math.abs(posShift); }
  }

  // Clamp + renormalize
  pUp = Math.max(5, Math.min(90, pUp));
  pDown = Math.max(5, Math.min(90, pDown));
  pPin = Math.max(5, Math.min(80, pPin));
  const sum = pUp + pDown + pPin;
  pUp = Math.round((pUp / sum) * 100);
  pDown = Math.round((pDown / sum) * 100);
  pPin = 100 - pUp - pDown;

  return { ...base, pUp, pDown, pPin };
}

// ──────────────────────────────────────────────────────────────────────────
// Expected move magnitude ($) — uses 1σ × regime multiplier
// ──────────────────────────────────────────────────────────────────────────

function magnitudeFor(
  spot: number,
  vix: number | null,
  regime: MMRegime,
  zone: MMZone,
  horizonDays: number,
): number {
  if (!vix) return 0;
  const iv = vix / 100;
  const sigma1 = spot * iv * Math.sqrt(Math.max(1, horizonDays) / 252);

  const regimeMult: Record<MMRegime, number> = {
    LONG_GAMMA:   0.55,
    NEUTRAL:      0.85,
    SHORT_GAMMA:  1.35,
    VANNA_DRIVEN: 1.10,
    CHARM_DRIVEN: 0.70,
  };
  const zoneMult: Record<MMZone, number> = {
    ABOVE_CALL: 1.20,
    CW_TO_0G:   0.80,
    AT_0G:      1.00,
    "0G_TO_PW": 1.10,
    BELOW_PW:   1.40,
  };

  return Math.round(sigma1 * regimeMult[regime] * zoneMult[zone]);
}

// ──────────────────────────────────────────────────────────────────────────
// Days-to-OPEX helper (nearest Friday for weekly)
// ──────────────────────────────────────────────────────────────────────────

function daysToFriday(asOf: number): number {
  const d = new Date(asOf * 1000);
  // Convert to America/New_York date
  const nyStr = d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
  const dayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  const day = dayMap[nyStr.slice(0, 3)] ?? 5;
  return (5 - day + 7) % 7; // 0 on Fri, 1 on Thu, etc.
}

// ──────────────────────────────────────────────────────────────────────────
// Public: build MM matrix from a ModelHorizon
// ──────────────────────────────────────────────────────────────────────────

export function buildMMMatrix(horizon: ModelHorizon, horizonDays: number): MMMatrix {
  const a = horizon.audit;
  const inp: RegimeInputs = {
    gexTotal: a.gammaZone === "y+" ? a.gexTotal : -a.gexTotal,
    gammaZone: a.gammaZone,
    charmTighteningRate: a.charmTightening?.rate ?? 0,
    charmChopFlag: a.charmTightening?.chopFlag ?? false,
    vixDelta: a.termStructureDoD?.iv1dDelta ?? null,
    dteToOpex: daysToFriday(a.asOf),
    vannaM: a.vannaM,
    vannaBias: a.vannaBias,
    charmZero: a.charmZero,
    dfi: a.dfi,
  };

  const { regime: currentRegime, note: regimeNote } = classifyRegime(inp);
  const { zone: currentZone, note: zoneNote, positionInZone } = classifyZone(a.spot, horizon.levels);

  const cells: MMCell[] = [];
  for (const regime of REGIMES) {
    for (const zone of ZONES) {
      const isCurrent = regime === currentRegime && zone === currentZone;
      const tilted = tilt(BASE_TABLE[regime][zone], regime, zone, inp, isCurrent, positionInZone, a.spot);
      const bias = (tilted.pUp - tilted.pDown) / 100;
      const magnitude = magnitudeFor(a.spot, horizon.vol?.vix ?? null, regime, zone, horizonDays);
      cells.push({
        regime,
        zone,
        pUp: tilted.pUp,
        pDown: tilted.pDown,
        pPin: tilted.pPin,
        magnitude,
        action: tilted.action,
        bias,
        intensity: tilted.intensity,
      });
    }
  }

  const currentCell = cells.find(c => c.regime === currentRegime && c.zone === currentZone)!;
  const summary = buildSummary(currentCell);

  return {
    asOf: a.asOf,
    currentRegime,
    currentZone,
    regimes: REGIMES,
    zones: ZONES,
    cells,
    notes: { regime: regimeNote, zone: zoneNote, summary },
  };
}

function buildSummary(c: MMCell): string {
  const dominant = c.pUp > c.pDown && c.pUp > c.pPin ? "up"
                 : c.pDown > c.pUp && c.pDown > c.pPin ? "down"
                 : "pin";
  const actionVerb: Record<DealerAction, string> = {
    defend:     "defend level",
    accelerate: "chase direction",
    fade:       "fade the move",
    pin:        "pin spot",
    capitulate: "step aside",
  };
  const tilt = dominant === "up"
    ? `${c.pUp}% up`
    : dominant === "down" ? `${c.pDown}% down`
    : `${c.pPin}% pinned`;
  return `Dealers likely ${actionVerb[c.action]} — ${tilt}, ~${c.magnitude}pt move`;
}
