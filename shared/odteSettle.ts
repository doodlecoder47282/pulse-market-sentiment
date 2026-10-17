// shared/odteSettle.ts
//
// Settle and lessons for the 0DTE map: given the morning map and the day's
// settle, high and low, say what happened to each level and zone. Pure; the
// server ledger (server/odteMapLedger.ts) stores the result per day and the
// card shows the running tally with its sample size. Counts, not a grade:
// fifty days of "settle inside the straddle range" says how often the market
// stayed inside the market's own expected move, which is not a claim of edge.

import type { OdteMap } from "./odteMap";

export interface SettleInputs {
  settle: number;
  sessionHigh: number;
  sessionLow: number;
}

export interface ZoneOutcome {
  kind: "dip" | "fade" | "no-trade";
  low: number;
  high: number;
  /** Price reached the zone during the session. */
  touched: boolean;
  /** dip: the session low stayed above the invalidation; fade: the session high stayed under the zone top; no-trade: price crossed the zone at some point. */
  heldOrCrossed: boolean | null;
  /** dip: settle above the zone low; fade: settle below the zone low; no-trade: settle inside the zone. */
  settleRelation: boolean;
}

export interface SettleEvaluation {
  settle: number;
  sessionHigh: number;
  sessionLow: number;
  settleInStraddle: boolean | null;
  sessionInStraddle: boolean | null;
  settleInSigma: boolean | null;
  sessionInSigma: boolean | null;
  /** settle - pin, points; null without a pin. */
  pinDistance: number | null;
  nearestLandmark: { name: string; level: number; distance: number } | null;
  /** Session high and low both inside the long-gamma band; null when a side of the band is undefined. */
  bandHeld: boolean | null;
  zones: ZoneOutcome[];
  /** One line with zone outcomes (personal edition). */
  lesson: string;
  /** The same line without the zone outcomes (every edition). */
  lessonLevels: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function evaluateSettle(m: OdteMap, s: SettleInputs): SettleEvaluation {
  const inside = (lo: number | null, hi: number | null, x: number): boolean | null => (lo == null || hi == null ? null : x >= lo && x <= hi);
  const settleInStraddle = inside(m.range.low, m.range.high, s.settle);
  const sessionInStraddle = m.range.low == null || m.range.high == null ? null : s.sessionLow >= m.range.low && s.sessionHigh <= m.range.high;
  const settleInSigma = inside(m.range.sigmaLow, m.range.sigmaHigh, s.settle);
  const sessionInSigma = m.range.sigmaLow == null || m.range.sigmaHigh == null ? null : s.sessionLow >= m.range.sigmaLow && s.sessionHigh <= m.range.sigmaHigh;
  const pinDistance = m.landmarks.pin == null ? null : r2(s.settle - m.landmarks.pin);

  const lm: Array<{ name: string; level: number | null }> = [
    { name: "pin", level: m.landmarks.pin }, { name: "wall above", level: m.landmarks.wallAbove }, { name: "magnet below", level: m.landmarks.magnetBelow },
    { name: "pocket above", level: m.landmarks.pocketAbove }, { name: "pocket below", level: m.landmarks.pocketBelow }, { name: "flip", level: m.landmarks.flip },
  ];
  let nearest: SettleEvaluation["nearestLandmark"] = null;
  for (const x of lm) {
    if (x.level == null) continue;
    const d = Math.abs(s.settle - x.level);
    if (!nearest || d < nearest.distance) nearest = { name: x.name, level: x.level, distance: r2(d) };
  }
  const bandHeld = m.band.low == null || m.band.high == null ? null : s.sessionLow >= m.band.low && s.sessionHigh <= m.band.high;

  const zones: ZoneOutcome[] = (m.zones ?? []).map((z) => {
    const touched = s.sessionLow <= z.high && s.sessionHigh >= z.low;
    if (z.kind === "dip") {
      return { kind: z.kind, low: z.low, high: z.high, touched, heldOrCrossed: z.invalidation == null ? null : s.sessionLow > z.invalidation, settleRelation: s.settle > z.low };
    }
    if (z.kind === "fade") {
      return { kind: z.kind, low: z.low, high: z.high, touched, heldOrCrossed: s.sessionHigh <= z.high, settleRelation: s.settle < z.low };
    }
    // Crossed = price went through the whole pocket (both edges exceeded); a one-sided poke is only touched.
    return { kind: z.kind, low: z.low, high: z.high, touched, heldOrCrossed: s.sessionLow < z.low && s.sessionHigh > z.high, settleRelation: s.settle >= z.low && s.settle <= z.high };
  });

  const parts: string[] = [];
  parts.push(`settle ${Math.round(s.settle)} (${s.sessionLow.toFixed(0)}-${s.sessionHigh.toFixed(0)})`);
  let lessonLevels = "";
  if (settleInStraddle != null) parts.push(`${settleInStraddle ? "inside" : "outside"} the straddle range ${Math.round(m.range.low!)}-${Math.round(m.range.high!)}`);
  if (sessionInStraddle != null) parts.push(sessionInStraddle ? "session stayed inside it" : "session broke it");
  if (pinDistance != null) parts.push(`${Math.abs(pinDistance).toFixed(0)} pts ${pinDistance >= 0 ? "above" : "below"} the pin ${m.landmarks.pin}`);
  if (nearest) parts.push(`nearest level ${nearest.name} ${nearest.level} (${nearest.distance.toFixed(0)} pts)`);
  if (bandHeld != null) parts.push(bandHeld ? "long-gamma band held" : "long-gamma band broken");
  lessonLevels = parts.join("; ");
  for (const z of zones) {
    if (z.kind === "dip") parts.push(`dip zone ${z.touched ? "touched" : "not touched"}${z.heldOrCrossed === false ? ", premise failed" : ""}, settle ${z.settleRelation ? "above" : "at or below"} it`);
    if (z.kind === "fade") parts.push(`fade zone ${z.touched ? "touched" : "not touched"}${z.heldOrCrossed === false ? ", top broken" : ""}, settle ${z.settleRelation ? "below" : "at or above"} it`);
    if (z.kind === "no-trade") parts.push(`no-trade pocket ${z.heldOrCrossed ? "crossed" : z.touched ? "touched" : "not touched"}`);
  }
  return { settle: s.settle, sessionHigh: s.sessionHigh, sessionLow: s.sessionLow, settleInStraddle, sessionInStraddle, settleInSigma, sessionInSigma, pinDistance, nearestLandmark: nearest, bandHeld, zones, lesson: parts.join("; "), lessonLevels };
}

export interface SettleTally {
  days: number;
  settleInStraddle: { yes: number; of: number };
  sessionInStraddle: { yes: number; of: number };
  settleInSigma: { yes: number; of: number };
  bandHeld: { yes: number; of: number };
  medianAbsPinDistance: number | null;
  dipTouchedAndHeld: { yes: number; of: number };
  fadeTouchedAndHeld: { yes: number; of: number };
  note: string;
}

/** Running counts over settled days; sample size is always shown with them. Zone tallies only when `withZones` (personal edition). */
export function tallySettles(evals: SettleEvaluation[], withZones = true): SettleTally {
  const count = (pick: (e: SettleEvaluation) => boolean | null) => {
    let yes = 0, of = 0;
    for (const e of evals) { const v = pick(e); if (v == null) continue; of++; if (v) yes++; }
    return { yes, of };
  };
  const pins = evals.map((e) => e.pinDistance).filter((d): d is number => d != null).map((d) => Math.abs(d)).sort((a, b) => a - b);
  const med = pins.length ? (pins.length % 2 ? pins[(pins.length - 1) / 2] : (pins[pins.length / 2 - 1] + pins[pins.length / 2]) / 2) : null;
  const zoneCount = (kind: "dip" | "fade") => count((e) => { const z = e.zones.find((x) => x.kind === kind); return z ? (z.touched ? z.heldOrCrossed !== false && z.settleRelation : null) : null; });
  return {
    days: evals.length,
    settleInStraddle: count((e) => e.settleInStraddle),
    sessionInStraddle: count((e) => e.sessionInStraddle),
    settleInSigma: count((e) => e.settleInSigma),
    bandHeld: count((e) => e.bandHeld),
    medianAbsPinDistance: med == null ? null : r2(med),
    dipTouchedAndHeld: withZones ? zoneCount("dip") : { yes: 0, of: 0 },
    fadeTouchedAndHeld: withZones ? zoneCount("fade") : { yes: 0, of: 0 },
    note: evals.length < 50
      ? `${evals.length} settled day${evals.length === 1 ? "" : "s"}: counts only, no claim of edge before 50 and a graded no-data share under 20%`
      : `${evals.length} settled days: counts of what happened, still not a calibrated probability`,
  };
}
