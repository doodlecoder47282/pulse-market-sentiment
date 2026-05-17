// alphaEmailComposer.ts
// Renders the upgraded alpha-brief response into a mobile-friendly, sectioned email body.
// Tabbed structure: VERDICT \u2192 SCENARIOS \u2192 TRADES \u2192 EVIDENCE.
// Used by the Saturday alpha-brief cron and any future weekday alpha cron.

import type { FusionContext } from "./alphaFusion";

export interface StructuredBrief {
  verdict?: "STRONG_BULL" | "LEAN_BULL" | "MIXED" | "LEAN_BEAR" | "STRONG_BEAR" | string;
  confidence?: number;
  oneLiner?: string;
  narrative?: string;
  scenarios?: {
    bull?: ScenarioPath;
    base?: ScenarioPath;
    bear?: ScenarioPath;
  };
  trades?: TradeIdea[];
  counterarguments?: string[];
  evidence?: {
    news?: string[];
    positioning?: string[];
    crossAsset?: string[];
    analogs?: string[];
  };
}

interface ScenarioPath {
  probability?: number;
  target?: string;
  horizon?: string;
  rr?: string;
  invalidation?: string;
  evidence?: string[];
}

interface TradeIdea {
  structure?: string;
  sizingKelly?: string;
  rr?: string;
  invalidation?: string;
  maxLoss?: string;
  thesis?: string;
}

export interface AlphaBriefPayload {
  brief?: string;            // legacy raw text (markdown OR JSON string)
  deterministic?: string;
  structured?: StructuredBrief | null;
  fusion?: FusionContext | null;
  provider?: string;
  mode?: string;
}

const VERDICT_BADGE: Record<string, string> = {
  STRONG_BULL: "STRONG BULL",
  LEAN_BULL:   "LEAN BULL",
  MIXED:       "MIXED",
  LEAN_BEAR:   "LEAN BEAR",
  STRONG_BEAR: "STRONG BEAR",
};

function badge(verdict: string | undefined): string {
  if (!verdict) return "PENDING";
  return VERDICT_BADGE[verdict] ?? verdict;
}

function bar(label: string): string {
  return `\u2500\u2500\u2500\u2500\u2500 ${label.toUpperCase()} \u2500\u2500\u2500\u2500\u2500`;
}

function formatScenario(name: "BULL" | "BASE" | "BEAR", p?: ScenarioPath): string[] {
  if (!p) return [`${name}: \u2014`];
  const out: string[] = [];
  out.push(`${name} \u00b7 ${p.probability ?? "?"}%   target ${p.target ?? "?"}   horizon ${p.horizon ?? "?"}   R:R ${p.rr ?? "?"}`);
  if (p.invalidation) out.push(`  invalid: ${p.invalidation}`);
  if (p.evidence?.length) p.evidence.forEach(e => out.push(`    \u00b7 ${e}`));
  return out;
}

function formatTrade(t: TradeIdea, idx: number): string[] {
  const lines: string[] = [];
  lines.push(`${idx + 1}. ${t.structure ?? "(no structure)"}`);
  if (t.thesis) lines.push(`   thesis: ${t.thesis}`);
  const parts: string[] = [];
  if (t.sizingKelly) parts.push(`size ${t.sizingKelly}`);
  if (t.rr) parts.push(`R:R ${t.rr}`);
  if (t.maxLoss) parts.push(`max loss ${t.maxLoss}`);
  if (parts.length) lines.push(`   ${parts.join(" \u00b7 ")}`);
  if (t.invalidation) lines.push(`   invalid: ${t.invalidation}`);
  return lines;
}

/**
 * Compose the full email body. Mobile-clean monospaced layout that renders
 * well in both plain-text and HTML-fallback email clients.
 */
export function composeAlphaEmail(payload: AlphaBriefPayload): { subject: string; body: string } {
  const lines: string[] = [];
  const s = payload.structured ?? null;
  const f = payload.fusion ?? null;
  const provider = payload.provider ?? "deterministic";

  // Verdict: LLM structured first, then Edge Lab baseline.
  const baselineVerdict = f?.baseline?.verdict ?? null; // e.g. "mixed / range", "lean bull"
  const baselineConfidence = f?.baseline?.confidence ?? null;
  const baselineOneLiner = f?.baseline?.oneLiner ?? null;
  const effectiveVerdict = s?.verdict ?? (baselineVerdict ? baselineVerdict.toUpperCase() : undefined);
  const verdictLabel = badge(effectiveVerdict);
  const confidence = s?.confidence ?? baselineConfidence;
  const oneLiner = s?.oneLiner ?? baselineOneLiner ?? "";

  // SUBJECT
  const subject = s
    ? `Alpha Brief: ${verdictLabel}${confidence != null ? ` \u00b7 ${confidence}%` : ""}${s.scenarios?.base?.target ? ` \u00b7 base ${s.scenarios.base.target}` : ""}`
    : baselineVerdict
      ? `Alpha Brief: ${verdictLabel}${confidence != null ? ` \u00b7 ${confidence}%` : ""}${f?.levels?.spot ? ` \u00b7 SPY ${f.levels.spot}` : ""} (baseline)`
      : `Alpha Brief: deterministic baseline (no LLM key)`;

  // HEADER
  lines.push(`ALPHA BRIEF \u2014 ${f?.asOfET ?? new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`);
  lines.push(`engine: ${provider}${payload.mode ? ` (${payload.mode})` : ""}`);
  lines.push("");

  // 1. VERDICT
  lines.push(bar("verdict"));
  lines.push(`[ ${verdictLabel} ]  confidence ${confidence != null ? confidence + "%" : "n/a"}`);
  if (oneLiner) lines.push(oneLiner);
  if (s?.narrative) {
    lines.push("");
    lines.push(s.narrative);
  }
  lines.push("");

  // 2. KEY LEVELS (from fusion context)
  if (f?.levels) {
    lines.push(bar("key levels"));
    const l = f.levels;
    const spyLine = `SPY \u00b7 spot ${l.spot ?? "?"} \u00b7 0\u0393 ${l.zeroGamma ?? "?"} \u00b7 callWall ${l.callWall ?? "?"} \u00b7 putWall ${l.putWall ?? "?"}`;
    lines.push(spyLine);
    if (l.upside || l.downside) {
      const spxLine = `SPX \u00b7 upside ${l.upside ?? "?"} \u00b7 downside ${l.downside ?? "?"} \u00b7 vomma ${l.vomma?.up ?? "?"}/${l.vomma?.down ?? "?"} \u00b7 charm ${l.charm ?? "?"}`;
      lines.push(spxLine);
    }
    lines.push("");
  }

  // 3. SCENARIOS — LLM structured first, else fall back to Edge Lab playbook paths.
  if (s?.scenarios) {
    lines.push(bar("3-path scenarios"));
    formatScenario("BULL", s.scenarios.bull).forEach(x => lines.push(x));
    formatScenario("BASE", s.scenarios.base).forEach(x => lines.push(x));
    formatScenario("BEAR", s.scenarios.bear).forEach(x => lines.push(x));
    lines.push("");
  } else if (f?.baseline?.paths) {
    const paths = f.baseline.paths;
    lines.push(bar("3-path scenarios (edge lab baseline)"));
    const renderPath = (tag: string, p: any) => {
      if (!p) return;
      const prob = p.probability != null ? `${(p.probability * 100).toFixed(0)}%` : "?";
      const range = (p.targetLow != null && p.targetHigh != null) ? `${p.targetLow.toFixed(2)}–${p.targetHigh.toFixed(2)}` : "?";
      lines.push(`  [${tag}] ${prob} · ${p.label ?? "?"} · range ${range}`);
      if (p.trigger) lines.push(`        trigger: ${p.trigger}`);
      if (p.oneLiner) lines.push(`        ${p.oneLiner}`);
      if (Array.isArray(p.drivers) && p.drivers.length) {
        lines.push(`        drivers: ${p.drivers.slice(0, 3).join(" · ")}`);
      }
    };
    renderPath("BULL", paths.bull);
    renderPath("BASE", paths.base);
    renderPath("BEAR", paths.bear);
    lines.push("");
  }

  // 4. TRADES
  if (s?.trades && s.trades.length > 0) {
    lines.push(bar("trade ideas"));
    s.trades.forEach((t, i) => formatTrade(t, i).forEach(x => lines.push(x)));
    lines.push("");
  } else if (s?.verdict === "MIXED") {
    lines.push(bar("trade ideas"));
    lines.push("No edge \u2014 pass. Sit on hands until a catalyst breaks the tie.");
    lines.push("");
  }

  // 5. CROSS-ASSET TAPE
  if (f?.crossAsset && f.crossAsset.length > 0) {
    lines.push(bar("cross-asset tape"));
    for (const row of f.crossAsset) {
      const fmt = (n: number | null) => (n == null ? "?" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%");
      lines.push(`  ${row.symbol.padEnd(4)} ${row.last ?? "?"}   d1 ${fmt(row.d1Pct)}   w1 ${fmt(row.w1Pct)}   m1 ${fmt(row.m1Pct)}`);
    }
    if (f.vix?.last != null) {
      const vixCh = f.vix.changePct == null ? "?" : (f.vix.changePct >= 0 ? "+" : "") + f.vix.changePct.toFixed(2) + "%";
      lines.push(`  VIX  ${f.vix.last}   ${vixCh}`);
    }
    lines.push("");
  }

  // 6. POSITIONING SNAPSHOT
  if (f?.positioning) {
    const p = f.positioning;
    const hasAny = p.gex != null || p.dex != null || p.ivRv?.iv30 != null || p.skew?.riskReversal != null;
    if (hasAny) {
      lines.push(bar("positioning"));
      const fmtB = (v: number | null | undefined) => {
        if (v == null || !Number.isFinite(Number(v))) return "?";
        const n = Number(v);
        const sign = n >= 0 ? "+" : "-";
        const abs = Math.abs(n) / 1e9;
        return `${sign}$${abs.toFixed(2)}B`;
      };
      const fmtLvl = (v: number | null | undefined) => (v == null || !Number.isFinite(Number(v))) ? "?" : Number(v).toFixed(2);
      const fmtPct = (v: number | null | undefined) => (v == null || !Number.isFinite(Number(v))) ? "?" : (Number(v) * 100).toFixed(1) + "%";
      const fmtDec = (v: number | null | undefined, d = 4) => (v == null || !Number.isFinite(Number(v))) ? "?" : Number(v).toFixed(d);
      if (p.gex != null || p.dex != null || p.flipLevel != null) {
        lines.push(`  GEX ${fmtB(p.gex)} \u00b7 DEX ${fmtB(p.dex)} \u00b7 flip ${fmtLvl(p.flipLevel)}`);
      }
      if (p.ivRv?.iv30 != null || p.ivRv?.rv30 != null) {
        lines.push(`  IV30 ${fmtPct(p.ivRv.iv30)} \u00b7 RV30 ${fmtPct(p.ivRv.rv30)} \u00b7 spread ${fmtPct(p.ivRv.spread)}`);
      }
      if (p.skew?.riskReversal != null) {
        lines.push(`  skew RR ${fmtDec(p.skew.riskReversal, 4)} \u00b7 put25\u0394 ${fmtDec(p.skew.put25Delta, 4)} \u00b7 call25\u0394 ${fmtDec(p.skew.call25Delta, 4)}`);
      }
      lines.push("");
    }
  }

  // 7. EVIDENCE
  if (s?.evidence) {
    lines.push(bar("evidence stack"));
    if (s.evidence.news?.length) {
      lines.push("news:");
      s.evidence.news.forEach(n => lines.push(`  \u00b7 ${n}`));
    }
    if (s.evidence.positioning?.length) {
      lines.push("positioning:");
      s.evidence.positioning.forEach(n => lines.push(`  \u00b7 ${n}`));
    }
    if (s.evidence.crossAsset?.length) {
      lines.push("cross-asset:");
      s.evidence.crossAsset.forEach(n => lines.push(`  \u00b7 ${n}`));
    }
    if (s.evidence.analogs?.length) {
      lines.push("analogs:");
      s.evidence.analogs.forEach(n => lines.push(`  \u00b7 ${n}`));
    }
    lines.push("");
  }

  // 8. COUNTERARGUMENTS
  if (s?.counterarguments && s.counterarguments.length > 0) {
    lines.push(bar("counterarguments \u2014 what breaks this"));
    s.counterarguments.forEach(c => lines.push(`  \u00b7 ${c}`));
    lines.push("");
  }

  // 9. ML model state (compact, only if present)
  if (f?.mlState?.accuracy30d) {
    const a = f.mlState.accuracy30d;
    lines.push(bar("ml model state"));
    lines.push(`  30d: ${a.graded}/${a.total} graded \u00b7 hit rate ${a.hitRate == null ? "?" : (a.hitRate * 100).toFixed(1) + "%"}`);
    if (f.mlState.recentPredictions.length) {
      const last = f.mlState.recentPredictions[f.mlState.recentPredictions.length - 1];
      const biasNum = Number(last.bias);
      const biasStr = Number.isFinite(biasNum) ? (biasNum >= 0 ? `+${biasNum.toFixed(2)}` : biasNum.toFixed(2)) : String(last.bias);
      const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(Number(v))) ? "?" : (Number(v) * 100).toFixed(0) + "%";
      lines.push(`  last call: bias ${biasStr} \u00b7 action ${last.action} \u00b7 pUp ${pct(last.pUp)} pDown ${pct(last.pDown)} pPin ${pct(last.pPin)}`);
    }
    lines.push("");
  }

  // 10. DATA HEALTH (only if warnings present)
  if (f?.warnings?.length) {
    lines.push(bar("data health"));
    f.warnings.forEach(w => lines.push(`  \u26a0 ${w}`));
    lines.push("");
  }

  // 11. ENGINE FOOTER
  lines.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  if (provider === "none" || !s) {
    lines.push("(LLM scenario engine not yet activated \u2014 add ANTHROPIC_API_KEY,");
    lines.push("OPENAI_API_KEY, or PERPLEXITY_API_KEY to .env.local to enable.)");
    lines.push("");
    lines.push("Deterministic baseline below:");
    lines.push("");
    lines.push(payload.deterministic ?? "(no deterministic baseline)");
  } else {
    lines.push(`engine: ${provider} \u00b7 fusion: ${f ? "live" : "offline"} \u00b7 analogs matched: ${f?.analogs?.length ?? 0}`);
    lines.push(`tags: ${(f?.catalystTags ?? []).join(", ") || "(none)"}`);
  }

  return { subject, body: lines.join("\n") };
}
