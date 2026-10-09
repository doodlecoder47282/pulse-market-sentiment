/**
 * edgeBriefing.ts
 *
 * Aggregates regime + cross-asset + playbook + econ-week + news + models + heatseeker levels
 * into ONE structured briefing payload. The Edge Lab tab consumes this to render a daily-to-weekly
 * preview with key levels, drivers, and a fused verdict.
 *
 * Strategy: call existing internal /api/* endpoints over loopback in parallel — no
 * duplication of business logic, no edits to locked modules (signals/regime/dfi/models/composite).
 */

import type express from "express";
import { internalJson, isInternalRoute } from "./internalApi";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BriefingLevels {
  callWall: number | null;
  putWall: number | null;
  zeroGamma: number | null;
  vomma: { up: number | null; down: number | null };
  charm: number | null;
  upside: number | null;
  downside: number | null;
  spot: number | null;
  /** Where upside/downside/vomma/charm came from: the user's weekly SPX targets
   *  (Heatseeker levels store). Null values mean not shown, with the reason. */
  targets: { source: string; symbolScale: "SPX"; updatedAt: number | null; shown: boolean; note: string };
}

export interface BriefingRegime {
  headline: string;
  narrative: string;
  riskAxisLabel: string | null;
  riskAxisDirection: string | null;
  notes: string[];
}

export interface BriefingCrossAsset {
  rows: { symbol: string; last: number | null; d1Pct: number | null; w1Pct: number | null; m1Pct: number | null; corr20d: number | null; corrRegime: string }[];
  vix: number | null;
  vixChangePct: number | null;
}

export interface BriefingPlaybook {
  marketSession: string;
  paths: {
    bull: { label: string; probability: number; trigger: string; targetLow: number; targetHigh: number; oneLiner: string; drivers: string[] };
    base: { label: string; probability: number; trigger: string; targetLow: number; targetHigh: number; oneLiner: string; drivers: string[] };
    bear: { label: string; probability: number; trigger: string; targetLow: number; targetHigh: number; oneLiner: string; drivers: string[] };
  };
  levels: { support: number | null; resistance: number | null };
}

export interface BriefingEvent {
  iso: string;
  label: string;
  events: { title: string; importance: string; timeLabel: string; note?: string }[];
}

export interface BriefingNewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: number;
}

export interface BriefingModelHorizon {
  label: string;
  symbol: string;
  spot: number;
  targetDate: string;
  priceLow: number | null;
  priceHigh: number | null;
  bias: string | null;
  confidence: number | null;
}

export interface BriefingPayload {
  asOf: number;
  symbol: string;
  spot: number | null;
  // Fused verdict
  verdict: "strong bull" | "lean bull" | "mixed / range" | "lean bear" | "strong bear" | "no edge — pass" | "insufficient data";
  verdictColor: "emerald" | "rose" | "amber" | "neutral";
  confidence: number | null; // heuristic 0-100; null when there is not enough data for any read
  oneLiner: string;
  // Sections
  regime: BriefingRegime | null;
  crossAsset: BriefingCrossAsset | null;
  playbook: BriefingPlaybook | null;
  weekAhead: BriefingEvent[];
  news: BriefingNewsItem[];
  models: { daily: BriefingModelHorizon | null; weekly: BriefingModelHorizon | null };
  levels: BriefingLevels;
  // Internal accounting
  panelHealth: { name: string; ok: boolean; note?: string }[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_PORT = Number(process.env.PORT ?? 5000);
const BASE = `http://127.0.0.1:${DEFAULT_PORT}`;

async function safeFetch<T = any>(path: string, timeoutMs = 4500): Promise<T | null> {
  // /api/models, /api/quotes run in-process with the same timeout (internalApi.ts).
  if (isInternalRoute(path)) return internalJson<T>(path, { timeoutMs });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function safe(n: any): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// ─── Section builders ─────────────────────────────────────────────────────────

const SPX_SCALE = new Set(["SPX", "$SPX", "$SPX.X", "^GSPC", "SPXW"]);
const TARGETS_MAX_AGE_MS = 7 * 86_400_000;

/** The weekly targets are typed in by the user on the SPX scale. They are shown
 *  only for an SPX-scale symbol and only when set within the last 7 days; never
 *  relabelled as another symbol's levels and never shown from the seed file. */
export function weeklyTargetsGate(symbol: string, updatedAt: number | null | undefined, now = Date.now()):
  { shown: boolean; note: string } {
  const sym = symbol.toUpperCase();
  if (!SPX_SCALE.has(sym)) {
    return { shown: false, note: `Weekly targets are SPX levels; not shown for ${sym}.` };
  }
  if (!updatedAt || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return { shown: false, note: "Weekly targets not set this week. Enter them in Heatseeker." };
  }
  if (now - updatedAt > TARGETS_MAX_AGE_MS) {
    const d = new Date(updatedAt).toISOString().slice(0, 10);
    return { shown: false, note: `Weekly targets last set ${d}; update them in Heatseeker.` };
  }
  return { shown: true, note: "Your weekly SPX targets (Heatseeker)." };
}

export function buildLevels(symbol: string, heatseeker: any, playbook: any, gammaCurve: any, now = Date.now()): BriefingLevels {
  const lv = (heatseeker?.levels ?? []) as any[];
  const updatedAt = safe(heatseeker?.updatedAt);
  const gate = weeklyTargetsGate(symbol, updatedAt, now);
  const find = (id: string) => (gate.shown ? safe(lv.find((l) => l.id === id)?.value) : null);
  return {
    // Walls and flip come from this symbol's own chain-derived routes only.
    callWall: safe(playbook?.paths?.bull?.trigger?.level),
    putWall: safe(playbook?.paths?.bear?.trigger?.level),
    zeroGamma: safe(gammaCurve?.zeroGamma),
    vomma: { up: find("upper-vomma"), down: find("lower-vomma") },
    charm: find("charm"),
    upside: find("upside"),
    downside: find("downside"),
    spot: safe(playbook?.spot) ?? safe(gammaCurve?.spot),
    targets: { source: "Heatseeker weekly targets", symbolScale: "SPX", updatedAt: updatedAt && updatedAt > 0 ? updatedAt : null, shown: gate.shown, note: gate.note },
  };
}

function buildRegime(regime: any): BriefingRegime | null {
  if (!regime) return null;
  // A risk axis with no readings is missing data, not "neutral".
  const riskFound = (regime.axes ?? []).find((a: any) => a.axis === "risk");
  const riskAxis = riskFound && Array.isArray(riskFound.readings) && riskFound.readings.length > 0 ? riskFound : null;
  return {
    headline: String(regime.headline ?? "regime read pending"),
    narrative: String(regime.narrative ?? ""),
    riskAxisLabel: riskAxis?.label ?? null,
    // riskAxis.direction is numeric (1 = risk-on, -1 = risk-off, 0 = neutral).
    // Coerce to a label string for downstream synthesizeVerdict() text matching.
    riskAxisDirection:
      typeof riskAxis?.direction === "number"
        ? riskAxis.direction > 0
          ? "risk-on"
          : riskAxis.direction < 0
            ? "risk-off"
            : "neutral"
        : (riskAxis?.direction != null ? String(riskAxis.direction) : null),
    notes: Array.isArray(regime.notes) ? regime.notes : [],
  };
}

function buildCrossAsset(cross: any, quotes: any): BriefingCrossAsset | null {
  if (!cross?.rows) return null;
  return {
    rows: (cross.rows as any[]).slice(0, 8).map((r) => ({
      symbol: String(r.symbol),
      // Missing stays missing (null), never 0. A last of 0 is a failed quote.
      last: safe(r.last) != null && r.last > 0 ? r.last : null,
      d1Pct: safe(r.last) != null && r.last > 0 ? safe(r.d1Pct) : null,
      w1Pct: safe(r.last) != null && r.last > 0 ? safe(r.w1Pct) : null,
      m1Pct: safe(r.last) != null && r.last > 0 ? safe(r.m1Pct) : null,
      corr20d: safe(r.corr20d),
      corrRegime: String(r.corrRegime ?? "n/a"),
    })),
    vix: safe(quotes?.vix?.price),
    vixChangePct: safe(quotes?.vix?.changePct),
  };
}

function buildPlaybook(p: any): BriefingPlaybook | null {
  if (!p?.paths) return null;
  const path = (k: string) => {
    const x = p.paths?.[k];
    if (!x) return { label: "—", probability: 0, trigger: "—", targetLow: 0, targetHigh: 0, oneLiner: "", drivers: [] };
    return {
      label: String(x.label ?? "—"),
      probability: Number(x.probability ?? 0),
      trigger: String(x.trigger?.condition ?? `level ${x.trigger?.level ?? "—"}`),
      targetLow: Number(x.target?.low ?? 0),
      targetHigh: Number(x.target?.high ?? 0),
      oneLiner: String(x.oneLiner ?? ""),
      drivers: Array.isArray(x.drivers) ? x.drivers.slice(0, 4) : [],
    };
  };
  return {
    marketSession: String(p.marketSession ?? "closed"),
    paths: { bull: path("bull"), base: path("base"), bear: path("bear") },
    levels: { support: safe(p.paths?.base?.invalidation), resistance: safe(p.paths?.bull?.trigger?.level) },
  };
}

function buildWeekAhead(econ: any): BriefingEvent[] {
  const days = (econ?.days ?? []) as any[];
  return days.map((d) => ({
    iso: String(d.iso ?? ""),
    label: String(d.label ?? ""),
    events: (d.events ?? []).slice(0, 3).map((e: any) => ({
      title: String(e.title ?? ""),
      importance: String(e.importance ?? "LOW"),
      timeLabel: String(e.timeLabel ?? ""),
      note: e.note,
    })),
  }));
}

function buildNews(news: any): BriefingNewsItem[] {
  const items = (news?.headlines ?? []) as any[];
  return items.slice(0, 8).map((n) => ({
    title: String(n.title ?? ""),
    url: String(n.url ?? ""),
    source: String(n.source ?? ""),
    publishedAt: Number(n.publishedAt ?? n.pubTime ?? 0),
  }));
}

function buildModels(models: any): { daily: BriefingModelHorizon | null; weekly: BriefingModelHorizon | null } {
  const horizon = (h: any): BriefingModelHorizon | null => {
    if (!h) return null;
    return {
      label: String(h.label ?? ""),
      symbol: String(h.displaySymbol ?? h.symbol ?? ""),
      spot: Number(h.spot ?? 0),
      targetDate: String(h.targetDateLong ?? h.targetDate ?? ""),
      priceLow: safe(h.priceRange?.[0]),
      priceHigh: safe(h.priceRange?.[1]),
      bias: h.bias ?? null,
      confidence: safe(h.confidence),
    };
  };
  return { daily: horizon(models?.horizons?.daily), weekly: horizon(models?.horizons?.weekly) };
}

// ─── Verdict synthesis ────────────────────────────────────────────────────────

export function synthesizeVerdict(b: Omit<BriefingPayload, "verdict" | "verdictColor" | "confidence" | "oneLiner" | "asOf" | "panelHealth" | "symbol" | "spot">): {
  verdict: BriefingPayload["verdict"];
  verdictColor: BriefingPayload["verdictColor"];
  confidence: number | null;
  oneLiner: string;
} {
  let bull = 0;
  let bear = 0;
  let signals = 0;

  // Regime
  if (b.regime?.riskAxisDirection) {
    signals++;
    const d = String(b.regime.riskAxisDirection).toLowerCase();
    if (/risk-on|growth|expansion|bull/.test(d)) bull++;
    else if (/risk-off|contraction|defensive|bear/.test(d)) bear++;
  }

  // Cross-asset SPY w1
  const spyRow = b.crossAsset?.rows.find((r) => r.symbol === "SPY");
  const spy = spyRow && spyRow.w1Pct != null && Number.isFinite(spyRow.w1Pct) ? { ...spyRow, w1Pct: spyRow.w1Pct } : null;
  if (spy) {
    signals++;
    if (spy.w1Pct > 1) bull++;
    else if (spy.w1Pct < -1) bear++;
  }

  // VIX level
  if (b.crossAsset?.vix != null) {
    signals++;
    if (b.crossAsset.vix < 16) bull++;
    else if (b.crossAsset.vix > 22) bear++;
  }

  // Playbook probabilities
  const pbUsable = !!b.playbook && [b.playbook.paths.bull, b.playbook.paths.base, b.playbook.paths.bear]
    .every((p) => Number.isFinite(p.probability)) &&
    (b.playbook.paths.bull.probability + b.playbook.paths.base.probability + b.playbook.paths.bear.probability) > 0;
  if (b.playbook && pbUsable) {
    signals++;
    const bullP = b.playbook.paths.bull.probability;
    const bearP = b.playbook.paths.bear.probability;
    if (bullP - bearP > 0.1) bull++;
    else if (bearP - bullP > 0.1) bear++;
  }

  // Models bias
  if (b.models.daily?.bias) {
    signals++;
    const bias = String(b.models.daily.bias).toLowerCase();
    if (/bull|long|up/.test(bias)) bull++;
    else if (/bear|short|down/.test(bias)) bear++;
  }

  const net = bull - bear;
  let verdict: BriefingPayload["verdict"];
  let verdictColor: BriefingPayload["verdictColor"];
  let confidence: number | null = 50;

  if (signals < 2) {
    // Fewer than two real inputs: no read at all, and no score.
    verdict = "insufficient data";
    verdictColor = "neutral";
    confidence = null;
  } else if (net >= 3) {
    verdict = "strong bull";
    verdictColor = "emerald";
    confidence = 75;
  } else if (net >= 1) {
    verdict = "lean bull";
    verdictColor = "emerald";
    confidence = 60;
  } else if (net <= -3) {
    verdict = "strong bear";
    verdictColor = "rose";
    confidence = 75;
  } else if (net <= -1) {
    verdict = "lean bear";
    verdictColor = "rose";
    confidence = 60;
  } else {
    verdict = "mixed / range";
    verdictColor = "amber";
    confidence = 45;
  }

  const drivers: string[] = [];
  if (b.regime?.headline) drivers.push(b.regime.headline.toLowerCase());
  if (b.crossAsset?.vix != null) drivers.push(`vix ${b.crossAsset.vix.toFixed(1)}`);
  if (spy) drivers.push(`spy w1 ${spy.w1Pct >= 0 ? "+" : ""}${spy.w1Pct.toFixed(2)}%`);
  if (b.playbook && pbUsable) {
    const dom = b.playbook.paths.base.probability >= b.playbook.paths.bull.probability && b.playbook.paths.base.probability >= b.playbook.paths.bear.probability
      ? "base"
      : b.playbook.paths.bull.probability > b.playbook.paths.bear.probability ? "bull" : "bear";
    drivers.push(`playbook leans ${dom}`);
  }

  const oneLiner = signals < 2
    ? `insufficient data · ${signals} of 5 inputs available · no read until Schwab data arrives`
    : `${verdict} · ${signals} of 5 inputs · ${drivers.slice(0, 3).join(" · ")}`;
  return { verdict, verdictColor, confidence, oneLiner };
}

// ─── Main builder ────────────────────────────────────────────────────────────

export async function buildBriefing(symbol: string): Promise<BriefingPayload> {
  const sym = symbol.toUpperCase();

  const [regime, crossAsset, playbook, econ, news, models, heatseeker, gammaCurve, quotes] = await Promise.all([
    safeFetch<any>(`/api/regime`),
    safeFetch<any>(`/api/cross-asset`),
    safeFetch<any>(`/api/playbook/daily?symbol=${encodeURIComponent(sym)}`),
    safeFetch<any>(`/api/econ-week`),
    safeFetch<any>(`/api/news`),
    safeFetch<any>(`/api/models`),
    safeFetch<any>(`/api/heatseeker/levels?symbol=${encodeURIComponent(sym)}`),
    safeFetch<any>(`/api/gamma-curve?symbol=${encodeURIComponent(sym)}`),
    safeFetch<any>(`/api/quotes`),
  ]);

  const partial = {
    regime: buildRegime(regime),
    crossAsset: buildCrossAsset(crossAsset, quotes),
    playbook: buildPlaybook(playbook),
    weekAhead: buildWeekAhead(econ),
    news: buildNews(news),
    models: buildModels(models),
    levels: buildLevels(sym, heatseeker, playbook, gammaCurve),
  };

  const synth = synthesizeVerdict(partial);

  const panelHealth = [
    { name: "regime", ok: !!regime },
    { name: "cross-asset", ok: !!crossAsset },
    { name: "playbook", ok: !!playbook },
    { name: "econ-week", ok: !!econ },
    { name: "news", ok: !!news },
    { name: "models", ok: !!models },
    { name: "heatseeker-levels", ok: !!heatseeker },
    { name: "gamma-curve", ok: !!gammaCurve },
    { name: "quotes", ok: !!quotes },
  ];

  return {
    asOf: Date.now(),
    symbol: sym,
    spot: partial.levels.spot,
    ...synth,
    ...partial,
    panelHealth,
  };
}
