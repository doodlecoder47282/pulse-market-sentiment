/**
 * Horizons — weekly + monthly projection models for the Trade Desk.
 *
 * Components:
 *   1. Multi-timeframe pivots    — daily / weekly / monthly × {classic, fib, camarilla}
 *   2. Expected-range vol cones  — IV-based (VIX term structure) and realized-vol (20D/60D HV)
 *   3. Confluence map            — price levels where 3+ systems agree (strong S/R)
 *   4. Historical analogs        — similar setups from snapshot_history → forward returns
 *   5. Horizon playbooks         — bias, expected range, key levels, catalysts per horizon
 */

import type { DailyOHLC, PeriodOHLC } from "./quotes";
import { buildPivotBundle } from "./pivots";
import type { GammaStructure, TermStructure } from "@shared/schema";
import type { SnapshotHistoryRow } from "./storage";

// ------------------------------------------------------------------ Vol cones

export interface VolCone {
  source: "IV" | "RV";                    // implied vol or realized vol
  annualizedVol: number;                  // decimal, e.g. 0.18 for 18%
  horizonDays: number;                    // trading days forward
  spot: number;
  ranges: {
    oneSigmaLow: number; oneSigmaHigh: number;
    twoSigmaLow: number; twoSigmaHigh: number;
  };
}

/**
 * Expected-range cone: S · exp(±z·σ·√T).
 * Lognormal geometric-Brownian-motion projection.
 */
export function buildVolCone(
  source: "IV" | "RV",
  annualizedVol: number,
  horizonTradingDays: number,
  spot: number,
): VolCone {
  const T = horizonTradingDays / 252;
  const sigmaSqrtT = annualizedVol * Math.sqrt(T);
  return {
    source,
    annualizedVol,
    horizonDays: horizonTradingDays,
    spot,
    ranges: {
      oneSigmaLow: spot * Math.exp(-1 * sigmaSqrtT),
      oneSigmaHigh: spot * Math.exp(+1 * sigmaSqrtT),
      twoSigmaLow: spot * Math.exp(-2 * sigmaSqrtT),
      twoSigmaHigh: spot * Math.exp(+2 * sigmaSqrtT),
    },
  };
}

/**
 * Realized volatility from daily closes (close-to-close log returns, annualized).
 * Window is typically 20 (1-month) or 60 (3-month).
 */
export function realizedVol(closes: number[], window = 20): number | null {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(closes.length - window - 1);
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    rets.push(Math.log(slice[i] / slice[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

/**
 * Pick the right IV for a horizon:
 *   - daily/weekly (≤5D):  VIX/100     (30D ATM IV)
 *   - monthly (~21D):      VIX3M/100   (93D ATM IV)
 *   - fallback: VIX if VIX3M missing
 */
export function pickImpliedVol(
  horizonTradingDays: number,
  term: TermStructure,
): number | null {
  if (horizonTradingDays <= 10) return term.vix != null ? term.vix / 100 : null;
  return term.vix3m != null ? term.vix3m / 100 : term.vix != null ? term.vix / 100 : null;
}

// --------------------------------------------------------------- Multi-TF pivots

export interface HorizonPivots {
  timeframe: "daily" | "weekly" | "monthly";
  priorOhlc: { label: string; o: number; h: number; l: number; c: number };
  classic: { pp: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number };
  fibonacci: { pp: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number };
  camarilla: { h1: number; h2: number; h3: number; h4: number; h5: number; h6: number; l1: number; l2: number; l3: number; l4: number; l5: number; l6: number; pp: number };
}

export function buildHorizonPivots(
  symbol: string,
  timeframe: "daily" | "weekly" | "monthly",
  priorOhlc: DailyOHLC | PeriodOHLC,
): HorizonPivots {
  const label = "label" in priorOhlc ? priorOhlc.label : new Date(priorOhlc.t * 1000).toISOString().slice(0, 10);
  const bundle = buildPivotBundle(symbol, {
    t: "start" in priorOhlc ? priorOhlc.start : (priorOhlc as DailyOHLC).t,
    o: priorOhlc.o, h: priorOhlc.h, l: priorOhlc.l, c: priorOhlc.c,
  });
  return {
    timeframe,
    priorOhlc: { label, o: priorOhlc.o, h: priorOhlc.h, l: priorOhlc.l, c: priorOhlc.c },
    classic: bundle.classic,
    fibonacci: bundle.fibonacci,
    camarilla: bundle.camarilla,
  };
}

// ------------------------------------------------------------------ Confluence

export interface ConfluenceLevel {
  price: number;           // rounded to 2 decimals
  sources: string[];       // e.g. ["D-PP", "W-R1", "M-H3"]
  score: number;           // confluence strength (count + weighting)
  direction: "resistance" | "support" | "neutral";
  distancePct: number;     // from current spot
}

/**
 * Walk every pivot across D/W/M × {classic, fib, cam} and bucket by ±0.15% band.
 * Levels with ≥2 systems hitting that band are confluence levels.
 */
export function buildConfluenceMap(
  pivots: { daily?: HorizonPivots; weekly?: HorizonPivots; monthly?: HorizonPivots },
  spot: number,
): ConfluenceLevel[] {
  const entries: { tag: string; price: number; kind: "R" | "S" | "N" }[] = [];
  const add = (tag: string, price: number | undefined, kind: "R" | "S" | "N") => {
    if (price != null && isFinite(price)) entries.push({ tag, price, kind });
  };

  const addAll = (prefix: string, p: HorizonPivots | undefined) => {
    if (!p) return;
    add(`${prefix}-PP`, p.classic.pp, "N");
    add(`${prefix}-R1`, p.classic.r1, "R");
    add(`${prefix}-R2`, p.classic.r2, "R");
    add(`${prefix}-R3`, p.classic.r3, "R");
    add(`${prefix}-S1`, p.classic.s1, "S");
    add(`${prefix}-S2`, p.classic.s2, "S");
    add(`${prefix}-S3`, p.classic.s3, "S");
    add(`${prefix}-fR1`, p.fibonacci.r1, "R");
    add(`${prefix}-fR2`, p.fibonacci.r2, "R");
    add(`${prefix}-fR3`, p.fibonacci.r3, "R");
    add(`${prefix}-fS1`, p.fibonacci.s1, "S");
    add(`${prefix}-fS2`, p.fibonacci.s2, "S");
    add(`${prefix}-fS3`, p.fibonacci.s3, "S");
    add(`${prefix}-H3`, p.camarilla.h3, "R");
    add(`${prefix}-H4`, p.camarilla.h4, "R");
    add(`${prefix}-H5`, p.camarilla.h5, "R");
    add(`${prefix}-L3`, p.camarilla.l3, "S");
    add(`${prefix}-L4`, p.camarilla.l4, "S");
    add(`${prefix}-L5`, p.camarilla.l5, "S");
  };
  addAll("D", pivots.daily);
  addAll("W", pivots.weekly);
  addAll("M", pivots.monthly);

  // Cluster by ±0.15% band.
  const BAND = 0.0015;
  const clusters: ConfluenceLevel[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    if (consumed.has(i)) continue;
    const seed = entries[i];
    const members: { tag: string; price: number; kind: "R" | "S" | "N" }[] = [seed];
    consumed.add(i);
    for (let j = i + 1; j < entries.length; j++) {
      if (consumed.has(j)) continue;
      if (Math.abs(entries[j].price - seed.price) / seed.price < BAND) {
        members.push(entries[j]);
        consumed.add(j);
      }
    }
    if (members.length < 2) continue; // only keep confluence (2+ hits)
    const avg = members.reduce((a, b) => a + b.price, 0) / members.length;
    // Weight: daily = 1, weekly = 1.5, monthly = 2
    let score = 0;
    for (const m of members) {
      if (m.tag.startsWith("D-")) score += 1;
      else if (m.tag.startsWith("W-")) score += 1.5;
      else if (m.tag.startsWith("M-")) score += 2;
    }
    const rCount = members.filter((m) => m.kind === "R").length;
    const sCount = members.filter((m) => m.kind === "S").length;
    const direction: ConfluenceLevel["direction"] =
      avg > spot ? "resistance" : avg < spot ? "support" : rCount > sCount ? "resistance" : "support";
    clusters.push({
      price: Math.round(avg * 100) / 100,
      sources: members.map((m) => m.tag).sort(),
      score: Math.round(score * 10) / 10,
      direction,
      distancePct: ((avg - spot) / spot) * 100,
    });
  }
  // Sort by proximity to spot, keep top 12.
  return clusters.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct)).slice(0, 12);
}

// ----------------------------------------------------------- Historical analogs

export interface AnalogMatch {
  date: string;
  spyClose: number;
  composite: number;
  vix: number;
  gammaRegime: string;
  forward5DReturn: number | null;   // pct
  forward21DReturn: number | null;  // pct
}

export interface AnalogStats {
  sampleSize: number;
  median5D: number | null;
  median21D: number | null;
  winRate5D: number | null;         // % positive
  winRate21D: number | null;
  range5D: { p10: number; p90: number } | null;
  range21D: { p10: number; p90: number } | null;
  matches: AnalogMatch[];           // most recent 5 for display
}

/**
 * Match current setup against the historical snapshot store.
 * Filters: composite ± 10, VIX ± 2, gamma regime EQ.
 * Then compute forward 5D / 21D returns for each match.
 */
export function findHistoricalAnalogs(
  history: SnapshotHistoryRow[],
  current: { composite: number; vix: number; gammaRegime: "positive" | "negative" | "neutral" },
): AnalogStats {
  const COMPOSITE_BAND = 10;
  const VIX_BAND = 2;
  // Sort ascending by date for forward-return calculation.
  const byDate = history.slice().sort((a, b) => a.date.localeCompare(b.date));
  const matches: AnalogMatch[] = [];
  for (let i = 0; i < byDate.length; i++) {
    const h = byDate[i];
    // Avoid matching today / last few days where we don't have 21D forward data.
    if (i >= byDate.length - 21) continue;
    if (h.gammaRegime !== current.gammaRegime) continue;
    if (Math.abs(h.composite - current.composite) > COMPOSITE_BAND) continue;
    if (Math.abs(h.vix - current.vix) > VIX_BAND) continue;
    const fwd5 = byDate[i + 5] ?? null;
    const fwd21 = byDate[i + 21] ?? null;
    matches.push({
      date: h.date,
      spyClose: h.spyClose,
      composite: h.composite,
      vix: h.vix,
      gammaRegime: h.gammaRegime,
      forward5DReturn: fwd5 ? ((fwd5.spyClose - h.spyClose) / h.spyClose) * 100 : null,
      forward21DReturn: fwd21 ? ((fwd21.spyClose - h.spyClose) / h.spyClose) * 100 : null,
    });
  }

  const r5 = matches.map((m) => m.forward5DReturn).filter((x): x is number => x != null);
  const r21 = matches.map((m) => m.forward21DReturn).filter((x): x is number => x != null);
  const pct = (arr: number[], p: number): number => {
    if (!arr.length) return NaN;
    const s = [...arr].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1))));
    return s[idx];
  };

  return {
    sampleSize: matches.length,
    median5D: r5.length ? pct(r5, 50) : null,
    median21D: r21.length ? pct(r21, 50) : null,
    winRate5D: r5.length ? (r5.filter((x) => x > 0).length / r5.length) * 100 : null,
    winRate21D: r21.length ? (r21.filter((x) => x > 0).length / r21.length) * 100 : null,
    range5D: r5.length ? { p10: pct(r5, 10), p90: pct(r5, 90) } : null,
    range21D: r21.length ? { p10: pct(r21, 10), p90: pct(r21, 90) } : null,
    matches: matches.slice(-5).reverse(),  // most recent 5
  };
}

// --------------------------------------------------------------- Horizon playbooks

export interface HorizonPlaybook {
  horizon: "weekly" | "monthly";
  bias: "bullish" | "bearish" | "neutral" | "volatile";
  expectedRange: { low: number; high: number; source: string };
  keyResistance: Array<{ price: number; label: string }>;
  keySupport: Array<{ price: number; label: string }>;
  narrative: string;
  catalysts: string[];
  confidence: "high" | "moderate" | "low";
}

export function buildHorizonPlaybook(input: {
  horizon: "weekly" | "monthly";
  spot: number;
  pivots: HorizonPivots | null;
  ivCone: VolCone | null;
  rvCone: VolCone | null;
  confluence: ConfluenceLevel[];
  gamma: GammaStructure;
  compositeScore: number;
  compositeLabel: string;
  vix: number | null;
  termRatio: number | null;
  analogs: AnalogStats | null;
}): HorizonPlaybook {
  const { horizon, spot, pivots, ivCone, rvCone, confluence, gamma, compositeScore, vix, termRatio, analogs } = input;

  // Bias derivation blends composite, gamma regime, VIX term, analog median.
  let biasScore = 0;            // -100 .. +100
  biasScore += (compositeScore - 50) * 1.2;                       // composite contribution
  if (gamma.totalGex > 0) biasScore += 10;
  else biasScore -= 10;
  if (termRatio != null) {
    // Contango (term < 1) = calm, slight bull
    if (termRatio < 0.95) biasScore += 8;
    else if (termRatio > 1.05) biasScore -= 15;
  }
  if (analogs?.median5D != null && horizon === "weekly") biasScore += analogs.median5D * 8;
  if (analogs?.median21D != null && horizon === "monthly") biasScore += analogs.median21D * 4;
  if (vix != null && vix > 25) biasScore -= 10;

  let bias: HorizonPlaybook["bias"] = "neutral";
  if (biasScore > 20) bias = "bullish";
  else if (biasScore < -20) bias = "bearish";
  else if (vix != null && vix > 25) bias = "volatile";

  // Expected range: prefer IV cone for forward vol, fall back to RV.
  const cone = ivCone ?? rvCone;
  const expectedRange = cone
    ? {
        low: cone.ranges.oneSigmaLow,
        high: cone.ranges.oneSigmaHigh,
        source: cone.source === "IV"
          ? `${horizon === "weekly" ? "VIX" : "VIX3M"} \u2192 ${(cone.annualizedVol * 100).toFixed(1)}% annualized, \u00b11\u03c3 \u00d7 \u221aT`
          : `${cone.horizonDays === 5 ? "20D" : "60D"} realized vol \u2192 ${(cone.annualizedVol * 100).toFixed(1)}%, \u00b11\u03c3 \u00d7 \u221aT`,
      }
    : { low: spot, high: spot, source: "unavailable" };

  // Key levels: prefer confluence above/below spot, fall back to pivot R/S.
  const above = confluence.filter((c) => c.price > spot).slice(0, 4);
  const below = confluence.filter((c) => c.price < spot).slice(0, 4);
  const keyResistance = above.length ? above.map((c) => ({
    price: c.price,
    label: c.sources.length > 2 ? `${c.sources.slice(0, 2).join(", ")} +${c.sources.length - 2}` : c.sources.join(", "),
  })) : (pivots ? [
    { price: pivots.classic.r1, label: "R1" },
    { price: pivots.classic.r2, label: "R2" },
  ] : []);
  const keySupport = below.length ? below.map((c) => ({
    price: c.price,
    label: c.sources.length > 2 ? `${c.sources.slice(0, 2).join(", ")} +${c.sources.length - 2}` : c.sources.join(", "),
  })) : (pivots ? [
    { price: pivots.classic.s1, label: "S1" },
    { price: pivots.classic.s2, label: "S2" },
  ] : []);

  // Confidence: higher when analog sample is solid + gamma is decisive + term agrees.
  let confPts = 0;
  if (analogs && analogs.sampleSize >= 8) confPts += 2;
  else if (analogs && analogs.sampleSize >= 3) confPts += 1;
  if (Math.abs(gamma.totalGex) > 1e9) confPts += 1;
  if (confluence.length >= 4) confPts += 1;
  const confidence: HorizonPlaybook["confidence"] = confPts >= 3 ? "high" : confPts >= 2 ? "moderate" : "low";

  // Narrative assembly.
  const range = expectedRange;
  const horizonLabel = horizon === "weekly" ? "this week" : "this month";
  const tfWin = horizon === "weekly" ? 5 : 21;
  const analogPart = analogs && analogs.sampleSize >= 3
    ? ` In ${analogs.sampleSize} historical analogs (composite \u00b1${10}, VIX \u00b1${2}, same \u03b3 regime), the median forward ${tfWin}D return was ${(horizon === "weekly" ? analogs.median5D : analogs.median21D)?.toFixed(2)}% with ${((horizon === "weekly" ? analogs.winRate5D : analogs.winRate21D) ?? 0).toFixed(0)}% win rate.`
    : " Historical analog sample is too thin to anchor expectations \u2014 rely on pivots and vol cone.";
  const gammaPart = gamma.totalGex >= 0
    ? `Dealers are long ${(gamma.totalGex / 1e9).toFixed(2)}B gamma \u2014 mean-reversion bias into the ${horizonLabel}; pinning likely toward call wall ${gamma.callWall}.`
    : `Dealers are short ${(gamma.totalGex / 1e9).toFixed(2)}B gamma \u2014 amplification regime; expect wider ranges and directional follow-through if zero-\u03b3 flip (${gamma.zeroGamma?.toFixed(2) ?? "n/a"}) breaks.`;
  const rangePart = range.source !== "unavailable"
    ? `Expected ${horizon} range (\u00b11\u03c3): ${range.low.toFixed(2)} \u2192 ${range.high.toFixed(2)}. `
    : "";

  const narrative = `${rangePart}${gammaPart}${analogPart}`;

  // Catalysts: generic for now; can hook into a calendar later.
  const catalysts: string[] = [];
  if (horizon === "weekly") {
    catalysts.push("Weekly OPEX Friday \u2014 check pinning near high-OI strikes");
    catalysts.push("VIX term structure \u2014 watch for contango->backwardation flip");
    if (Math.abs((gamma.zeroGamma ?? spot) - spot) / spot < 0.015) {
      catalysts.push(`Zero-\u03b3 flip at ${gamma.zeroGamma?.toFixed(2)} is within 1.5% \u2014 primary intraweek decision level`);
    }
  } else {
    catalysts.push("Monthly OPEX (3rd Friday) \u2014 often the range's inflection");
    catalysts.push("FOMC / CPI / NFP \u2014 scheduled macro catalysts in window");
    catalysts.push("Quarterly earnings \u2014 breadth of guidance vs. index weights");
  }

  return { horizon, bias, expectedRange, keyResistance, keySupport, narrative, catalysts, confidence };
}
