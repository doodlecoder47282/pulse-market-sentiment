// server/sdZones.ts
//
// Wire 12 — 1-minute Supply/Demand zone detector for SPX.
//
// Drop-Base-Rally → DEMAND (support)
// Rally-Base-Drop → SUPPLY (resistance)
//
// Volume confirmation: base candle volume < min(prev1.vol, next1.vol) * 0.7
// Freshness: ageMin < 15 → fresh
// Retest tracking: UNTESTED / HELD / BREACHED
// Breached zones are removed from active set.
// 60-second cache to avoid redundant API calls.

import { getPriceHistory } from "./schwab.js";

export type SDZone = {
  type: "DEMAND" | "SUPPLY";
  distal: number;        // outer edge (wick low for demand, wick high for supply)
  proximal: number;      // inner edge (top of base body for demand, bottom for supply)
  baseTimeMs: number;    // when the base formed
  ageMin: number;        // minutes since base formed (computed at access)
  fresh: boolean;        // ageMin < 15
  volumeConfirmed: boolean; // base candle vol < min(prev1.vol, next1.vol) * 0.7
  retests: number;       // count of touches after formation
  status: "UNTESTED" | "HELD" | "BREACHED";
  // HELD = tested ≥1, status still alive (didn't fully breach)
  // BREACHED = price closed beyond distal after at least 1 test
};

const ZONE_CACHE_MS = 60_000; // 60s cache
let cache: { ts: number; zones: SDZone[] } | null = null;

export async function detectSDZones(): Promise<SDZone[]> {
  if (cache && Date.now() - cache.ts < ZONE_CACHE_MS) return cache.zones;

  const history = await getPriceHistory("$SPX.X", "day", 1, "minute", 1);
  if (!history.candles?.length) {
    cache = { ts: Date.now(), zones: [] };
    return [];
  }

  const candles = history.candles; // array of { datetime, open, high, low, close, volume }
  const zones: SDZone[] = [];

  // Detect bases — candle with body < 40% of total range, flanked by impulse bars
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    const prev1 = candles[i - 1];
    const prev2 = candles[i - 2];
    const next1 = candles[i + 1];
    const next2 = candles[i + 2];

    const bodySize = Math.abs(c.close - c.open);
    const totalRange = c.high - c.low;
    if (totalRange === 0) continue;
    const isBase = bodySize < totalRange * 0.4;
    if (!isBase) continue;

    // Volume confirmation: base candle volume must be lower than impulse neighbors
    const minImpulseVol = Math.min(prev1.volume || 0, next1.volume || 0);
    const volumeConfirmed = (c.volume || 0) < minImpulseVol * 0.7 && minImpulseVol > 0;

    // Drop-Base-Rally → DEMAND (support)
    const prevDown = prev1.close < prev1.open && prev2.close < prev2.open;
    const nextUp = next1.close > next1.open && (next2.close > next2.open || next2.close > next1.open);

    if (prevDown && nextUp) {
      const distal = c.low;
      const proximal = Math.max(c.open, c.close);
      // Count retests: subsequent bars whose low pierced into [distal, proximal] zone
      let retests = 0;
      let breached = false;
      for (let j = i + 3; j < candles.length; j++) {
        const cj = candles[j];
        if (cj.low <= proximal && cj.high >= distal) {
          retests++;
          // Breached if close < distal
          if (cj.close < distal) { breached = true; break; }
        }
      }
      const status: SDZone["status"] = breached ? "BREACHED" : (retests > 0 ? "HELD" : "UNTESTED");
      const ageMin = (Date.now() - c.datetime) / 60_000;
      zones.push({
        type: "DEMAND", distal, proximal,
        baseTimeMs: c.datetime, ageMin,
        fresh: ageMin < 15,
        volumeConfirmed, retests, status,
      });
    }

    // Rally-Base-Drop → SUPPLY (resistance)
    const prevUp = prev1.close > prev1.open && prev2.close > prev2.open;
    const nextDown = next1.close < next1.open && (next2.close < next2.open || next2.close < next1.open);

    if (prevUp && nextDown) {
      const distal = c.high;
      const proximal = Math.min(c.open, c.close);
      let retests = 0;
      let breached = false;
      for (let j = i + 3; j < candles.length; j++) {
        const cj = candles[j];
        if (cj.high >= proximal && cj.low <= distal) {
          retests++;
          if (cj.close > distal) { breached = true; break; }
        }
      }
      const status: SDZone["status"] = breached ? "BREACHED" : (retests > 0 ? "HELD" : "UNTESTED");
      const ageMin = (Date.now() - c.datetime) / 60_000;
      zones.push({
        type: "SUPPLY", distal, proximal,
        baseTimeMs: c.datetime, ageMin,
        fresh: ageMin < 15,
        volumeConfirmed, retests, status,
      });
    }
  }

  // Filter out BREACHED zones — dead, no edge
  const live = zones.filter(z => z.status !== "BREACHED");

  // Deduplicate close zones (same type, proximal within 3pt → keep newer)
  const dedup: SDZone[] = [];
  for (const z of live.sort((a, b) => b.baseTimeMs - a.baseTimeMs)) {
    const tooClose = dedup.some(d => d.type === z.type && Math.abs(d.proximal - z.proximal) < 3);
    if (!tooClose) dedup.push(z);
  }

  cache = { ts: Date.now(), zones: dedup };
  console.log(`[sdZones] detectSDZones: ${dedup.length} live zones (${candles.length} candles)`);
  return dedup;
}

export function findNearestZone(zones: SDZone[], spot: number, side: "call" | "put"): SDZone | null {
  // For calls (long bias), nearest DEMAND below spot is supportive
  // For puts (short bias), nearest SUPPLY above spot is supportive
  const candidates = zones.filter(z => {
    if (side === "call") return z.type === "DEMAND" && z.proximal < spot && z.distal < spot;
    return z.type === "SUPPLY" && z.proximal > spot && z.distal > spot;
  });
  if (!candidates.length) return null;
  // Distance threshold: zone must be within 0.3% of spot
  const maxDist = spot * 0.003;
  const inRange = candidates.filter(z => {
    const distance = side === "call" ? spot - z.proximal : z.proximal - spot;
    return distance > 0 && distance <= maxDist;
  });
  if (!inRange.length) return null;
  // Return the closest
  return inRange.sort((a, b) => {
    const distA = side === "call" ? spot - a.proximal : a.proximal - spot;
    const distB = side === "call" ? spot - b.proximal : b.proximal - spot;
    return distA - distB;
  })[0];
}
