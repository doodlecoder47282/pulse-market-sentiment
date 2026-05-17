// alphaFusion.ts
// Gathers all the inputs the LLM scenario engine needs in ONE shot, in parallel.
// Pulls Batcave internal state + cross-asset tape + options positioning + ML state + historical analogs.
// Returns a single JSON blob the prompt builder serializes. NEVER throws — graceful nulls on any failure.

import fs from "node:fs/promises";
import path from "node:path";
import type { AlphaNewsItem } from "./alphaEngine";

export interface FusionContext {
  asOf: string; // ISO UTC
  asOfET: string; // human-readable ET
  // 1. Batcave internal state
  regime: {
    label?: string;
    gammaPosture?: "long" | "short" | "neutral" | null;
    vixTermStructure?: string | null;
    riskAxis?: "on" | "off" | "mixed" | null;
    summary?: string | null;
  };
  levels: {
    spot?: number;
    zeroGamma?: number;
    callWall?: number;
    putWall?: number;
    upside?: number;
    downside?: number;
    vomma?: { up?: number; down?: number };
    charm?: number;
    note?: string | null;
  };
  // 2. Cross-asset tape
  crossAsset: Array<{ symbol: string; last: number | null; d1Pct: number | null; w1Pct: number | null; m1Pct: number | null }>;
  vix: { last: number | null; changePct: number | null };
  // 3. Options positioning
  positioning: {
    gex?: number | null;
    dex?: number | null;
    ivRv?: { iv30: number | null; rv30: number | null; spread: number | null };
    skew?: { put25Delta: number | null; call25Delta: number | null; riskReversal: number | null };
    flipLevel?: number | null;
  };
  // 4. ML model state
  mlState: {
    recentPredictions: Array<{ ts: string; horizon: string; pUp: number; pDown: number; pPin: number; bias: string; action: string; spot: number }>;
    accuracy30d?: { graded: number; total: number; hitRate: number | null } | null;
  };
  // 5. Historical analogs (matched against catalysts)
  analogs: Array<{
    id: string;
    date: string | null;
    catalyst: string;
    matchScore: number; // 0..1, jaccard of tag overlap
    matchedTags: string[];
    spy1d: number | null;
    spy5d: number | null;
    spy20d: number | null;
    vixDelta5d: number | null;
    lesson: string;
  }>;
  // 6. Catalyst tags extracted from news (drives analog matching)
  catalystTags: string[];
  // 7. Panel health (which data sources are live)
  panelHealth: Array<{ name: string; ok: boolean }>;
  // 8. Edge Lab baseline (deterministic verdict — used as fallback when no LLM key configured)
  baseline: {
    verdict?: string | null;
    confidence?: number | null;
    oneLiner?: string | null;
    paths?: any | null; // { bull, base, bear } from edgelab playbook
  };
  warnings: string[];
}

interface AnalogRow {
  id: string;
  date: string | null;
  catalyst: string;
  tags: string[];
  regime?: string;
  spy1d: number | null;
  spy5d: number | null;
  spy20d: number | null;
  vixDelta5d: number | null;
  lesson: string;
  [k: string]: any;
}

let _analogsCache: AnalogRow[] | null = null;
async function loadAnalogs(): Promise<AnalogRow[]> {
  if (_analogsCache) return _analogsCache;
  try {
    const p = path.join(process.cwd(), "data", "analogs", "macro-analogs.json");
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw);
    _analogsCache = (parsed?.analogs ?? []) as AnalogRow[];
    return _analogsCache;
  } catch {
    return [];
  }
}

// Catalyst tag dictionary — maps news keywords to analog tags.
const CATALYST_LEXICON: Array<{ re: RegExp; tags: string[] }> = [
  { re: /\b(iran|israel|gaza|hezbollah|houthi|red sea)\b/i, tags: ["geopolitics", "iran", "israel", "middle-east", "war-risk"] },
  { re: /\b(russia|ukraine|putin)\b/i, tags: ["geopolitics", "russia", "ukraine", "war-risk"] },
  { re: /\b(china|taiwan|xi|beijing)\b/i, tags: ["geopolitics", "china", "taiwan"] },
  { re: /\b(opec|saudi|uae)\b/i, tags: ["geopolitics", "opec", "oil", "energy"] },
  { re: /\b(tariff|trade war|sanction)\b/i, tags: ["geopolitics", "tariffs", "trade-war"] },
  { re: /\b(oil|crude|brent|wti)\b.*\b(spike|surge|plunge|inflation)\b/i, tags: ["energy", "oil", "supply-shock"] },
  { re: /\b(fed|fomc|powell|warsh|kashkari|williams|waller)\b/i, tags: ["rates", "fed"] },
  { re: /\brate cut\b/i, tags: ["rates", "rate-cut", "dovish-pivot"] },
  { re: /\brate hike\b|\bhawkish\b/i, tags: ["rates", "hawkish-hold"] },
  { re: /\bcpi|inflation\b/i, tags: ["rates", "cpi", "inflation"] },
  { re: /\b(nfp|payrolls|jobs report)\b/i, tags: ["rates", "nfp", "jobs"] },
  { re: /\b(nvda|nvidia|cerebras|amd|semiconductor|chip)\b/i, tags: ["corporate", "semiconductors", "ai", "tech"] },
  { re: /\b(ipo|listing|debut)\b/i, tags: ["corporate", "ipo"] },
  { re: /\b(13f|stake|ackman|buffett|burry)\b/i, tags: ["corporate", "13f", "smart-money"] },
  { re: /\b(earnings|beat|miss|guidance)\b/i, tags: ["corporate", "earnings"] },
  { re: /\b(dxy|dollar|fx)\b/i, tags: ["fx", "dxy"] },
  { re: /\b(vix|volatility|vol)\b/i, tags: ["vol"] },
  { re: /\b(credit|hyg|lqd|spread)\b/i, tags: ["credit", "spread-widening"] },
  { re: /\b(0dte|opex|gamma)\b/i, tags: ["options", "gamma"] },
];

function extractCatalystTags(items: AlphaNewsItem[]): string[] {
  const all = new Set<string>();
  const haystack = items.map(i => `${i.title} ${i.summary ?? ""}`).join(" \n ");
  for (const rule of CATALYST_LEXICON) {
    if (rule.re.test(haystack)) {
      rule.tags.forEach(t => all.add(t));
    }
  }
  return Array.from(all);
}

function jaccard(a: string[], b: string[]): { score: number; intersection: string[] } {
  const A = new Set(a);
  const B = new Set(b);
  const intersection: string[] = [];
  for (const x of A) if (B.has(x)) intersection.push(x);
  const unionSize = A.size + B.size - intersection.length;
  return { score: unionSize === 0 ? 0 : intersection.length / unionSize, intersection };
}

async function matchAnalogs(catalystTags: string[], topN = 5): Promise<FusionContext["analogs"]> {
  if (catalystTags.length === 0) return [];
  const analogs = await loadAnalogs();
  const scored = analogs
    .map(a => {
      const { score, intersection } = jaccard(catalystTags, a.tags ?? []);
      return {
        id: a.id,
        date: a.date,
        catalyst: a.catalyst,
        matchScore: score,
        matchedTags: intersection,
        spy1d: a.spy1d,
        spy5d: a.spy5d,
        spy20d: a.spy20d,
        vixDelta5d: a.vixDelta5d,
        lesson: a.lesson,
      };
    })
    .filter(x => x.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, topN);
  return scored;
}

// Local fetch helper — never throws, returns null on failure.
async function localFetch(url: string, timeoutMs = 12000): Promise<any | null> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function gatherCrossAsset(base: string, warnings: string[]): Promise<{ rows: FusionContext["crossAsset"]; vix: FusionContext["vix"] }> {
  const symbols = ["SPY", "QQQ", "IWM", "TLT", "HYG", "GLD", "USO", "UUP", "VIX"];
  const results = await Promise.all(symbols.map(sym => localFetch(`${base}/api/ohlc?symbol=${encodeURIComponent(sym)}&tf=1D&interval=1d`)));
  const rows: FusionContext["crossAsset"] = [];
  let vixLast: number | null = null;
  let vixChangePct: number | null = null;
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const data = results[i];
    if (!data?.candles?.length) {
      if (sym !== "VIX") rows.push({ symbol: sym, last: null, d1Pct: null, w1Pct: null, m1Pct: null });
      continue;
    }
    const candles = data.candles;
    const last = candles[candles.length - 1]?.c ?? null;
    const prev = candles[candles.length - 2]?.c ?? null;
    const week = candles[Math.max(0, candles.length - 6)]?.c ?? null;
    const month = candles[Math.max(0, candles.length - 22)]?.c ?? null;
    const pct = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : ((a - b) / b) * 100);
    if (sym === "VIX") {
      vixLast = last;
      vixChangePct = pct(last, prev);
    } else {
      rows.push({ symbol: sym, last, d1Pct: pct(last, prev), w1Pct: pct(last, week), m1Pct: pct(last, month) });
    }
  }
  if (rows.length === 0) warnings.push("cross-asset tape unavailable");
  return { rows, vix: { last: vixLast, changePct: vixChangePct } };
}

export async function buildFusionContext(items: AlphaNewsItem[]): Promise<FusionContext> {
  const warnings: string[] = [];
  const PORT = process.env.PORT ?? "5000";
  const base = `http://127.0.0.1:${PORT}`;
  const now = new Date();

  // All parallel — never let one slow source block the others.
  const [briefing, regime, exposures, ivRv, skew, mlStats, predictionsFile] = await Promise.all([
    localFetch(`${base}/api/edgelab/briefing?symbol=SPY`),
    localFetch(`${base}/api/regime`),
    localFetch(`${base}/api/exposures?symbol=SPY`),
    localFetch(`${base}/api/iv-rv?symbol=SPY`),
    localFetch(`${base}/api/skew?symbol=SPY`),
    localFetch(`${base}/api/mm-stats`),
    fs.readFile(path.join(process.cwd(), "data", "mm-predictions", "predictions.jsonl"), "utf-8").catch(() => ""),
  ]);

  const catalystTags = extractCatalystTags(items);
  const [analogs, crossAssetData] = await Promise.all([
    matchAnalogs(catalystTags, 5),
    gatherCrossAsset(base, warnings),
  ]);

  // Parse predictions file — last 5 entries with full schema.
  // pUp/pDown/pPin in this log are stored as integers 0..100 (probabilities scaled to percent).
  // Normalize to 0..1 floats so downstream code can multiply by 100 once and only once.
  const recentPredictions: FusionContext["mlState"]["recentPredictions"] = [];
  if (predictionsFile) {
    const lines = predictionsFile.split("\n").filter(Boolean).slice(-20);
    for (const ln of lines) {
      try {
        const p = JSON.parse(ln);
        if (p.pUp != null && p.spot != null) {
          const norm = (v: any) => {
            if (v == null) return null;
            const n = Number(v);
            if (!isFinite(n)) return null;
            return n > 1 ? n / 100 : n; // already 0..1 if ≤ 1
          };
          recentPredictions.push({
            ts: p.ts ?? p.sessionDate ?? "",
            horizon: p.horizon ?? "daily",
            pUp: norm(p.pUp) ?? 0,
            pDown: norm(p.pDown) ?? 0,
            pPin: norm(p.pPin) ?? 0,
            bias: String(p.bias ?? ""),
            action: p.action ?? "",
            spot: p.spot,
          });
        }
      } catch { /* skip malformed */ }
    }
  }
  const recent5 = recentPredictions.slice(-5);

  // Compute directional hit rate from the mm-stats cells.
  // Each cell has empUp/empDown/empPin (empirical %) and a count n. Use the dominant
  // empirical bin per cell as the realized direction, then check if that matches the
  // bias the prior would have called. For simplicity here, surface the cell
  // empirical agreement — "how often did the dominant empirical direction line up
  // with prior expectations". Falls back to raw graded/total ratio if no cells.
  let hitRate: number | null = null;
  if (mlStats?.cells?.length) {
    let nMatch = 0;
    let nTotal = 0;
    for (const c of mlStats.cells) {
      if (!c?.n) continue;
      // dominant prior
      const priorMax = Math.max(c.priorUp ?? 0, c.priorDown ?? 0, c.priorPin ?? 0);
      const empMax = Math.max(c.empUp ?? 0, c.empDown ?? 0, c.empPin ?? 0);
      const priorDir =
        priorMax === (c.priorUp ?? 0) ? "up" : priorMax === (c.priorDown ?? 0) ? "down" : "pin";
      const empDir =
        empMax === (c.empUp ?? 0) ? "up" : empMax === (c.empDown ?? 0) ? "down" : "pin";
      nTotal += c.n;
      if (priorDir === empDir) nMatch += c.n;
    }
    hitRate = nTotal > 0 ? nMatch / nTotal : null;
  }
  const accuracy30d = mlStats
    ? {
        graded: mlStats.gradedPredictions ?? mlStats.graded ?? 0,
        total: mlStats.totalPredictions ?? mlStats.total ?? 0,
        hitRate: mlStats.directionalHitRate ?? hitRate,
      }
    : null;

  // Compose regime block — prefer /api/regime, fall back to briefing.regime.
  const regimeBlock: FusionContext["regime"] = {
    label: regime?.label ?? briefing?.regime?.headline ?? null,
    gammaPosture: regime?.gammaPosture ?? (briefing?.regime?.gamma ?? null),
    vixTermStructure: regime?.vixTermStructure ?? null,
    riskAxis: briefing?.regime?.riskAxis ?? regime?.riskAxis ?? null,
    summary: briefing?.regime?.headline ?? regime?.summary ?? null,
  };

  // Levels — prefer briefing's 8-chip set.
  const levels: FusionContext["levels"] = {
    spot: briefing?.levels?.spot ?? briefing?.spot ?? null,
    zeroGamma: briefing?.levels?.zeroGamma ?? null,
    callWall: briefing?.levels?.callWall ?? null,
    putWall: briefing?.levels?.putWall ?? null,
    upside: briefing?.levels?.upside ?? null,
    downside: briefing?.levels?.downside ?? null,
    vomma: briefing?.levels?.vomma ?? null,
    charm: briefing?.levels?.charm ?? null,
    note: briefing?.levels ? "spot/zeroGamma/callWall/putWall are SPY-scaled; upside/downside/vomma/charm are SPX-scaled" : null,
  };

  // Positioning — unwrap actual response shapes from /api/iv-rv, /api/exposures, /api/skew.
  // iv-rv: { iv: { iv30, iv60, iv90 }, rv: { rv5, rv10, rv20, rv30, rv60 }, ratio: { iv30_rv30 } }
  // exposures: { profile: { curve: [{ spot, dex, gex, vex, charm }, ...], currentSpot } }
  // skew: { points: [{ tenorDays, atmIv, put25dIv, call25dIv, riskReversal25d }, ...] }
  let gexAtSpot: number | null = null;
  let dexAtSpot: number | null = null;
  let flipLevel: number | null = null;
  if (exposures?.profile?.curve?.length) {
    const curve = exposures.profile.curve;
    const spotPx = exposures.profile.currentSpot ?? null;
    if (spotPx != null) {
      // Nearest curve point to current spot
      let best = curve[0];
      let bestDist = Math.abs((best.spot ?? Infinity) - spotPx);
      for (const pt of curve) {
        const d = Math.abs((pt.spot ?? Infinity) - spotPx);
        if (d < bestDist) { best = pt; bestDist = d; }
      }
      gexAtSpot = best?.gex ?? null;
      dexAtSpot = best?.dex ?? null;
    }
    // Flip level = first curve point where gex changes sign (zero-gamma crossing)
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1]?.gex;
      const b = curve[i]?.gex;
      if (a != null && b != null && Math.sign(a) !== Math.sign(b) && Math.sign(a) !== 0) {
        // Linear interp between the two spots for zero-cross
        const sA = curve[i - 1].spot;
        const sB = curve[i].spot;
        if (sA != null && sB != null) {
          flipLevel = sA + (sB - sA) * Math.abs(a) / (Math.abs(a) + Math.abs(b));
          break;
        }
      }
    }
  }
  // Pick nearest tenor skew (≤ 30d preferred)
  let skewPoint: any = null;
  if (skew?.points?.length) {
    const pts = skew.points;
    skewPoint = pts.find((p: any) => p.tenorDays <= 30) ?? pts[0];
  }
  const iv30 = ivRv?.iv?.iv30 ?? null;
  const rv30 = ivRv?.rv?.rv30 ?? null;
  const ivRvSpread = iv30 != null && rv30 != null ? iv30 - rv30 : null;

  const positioning: FusionContext["positioning"] = {
    gex: gexAtSpot,
    dex: dexAtSpot,
    ivRv: { iv30, rv30, spread: ivRvSpread },
    skew: {
      put25Delta: skewPoint?.put25dIv ?? null,
      call25Delta: skewPoint?.call25dIv ?? null,
      riskReversal: skewPoint?.riskReversal25d ?? null,
    },
    flipLevel: flipLevel ?? briefing?.levels?.zeroGamma ?? null,
  };

  if (!briefing) warnings.push("/api/edgelab/briefing offline");
  if (!regime) warnings.push("/api/regime offline");
  if (!exposures) warnings.push("/api/exposures offline");
  if (!ivRv) warnings.push("/api/iv-rv offline");
  if (analogs.length === 0 && catalystTags.length > 0) warnings.push("no historical analogs matched catalyst tags");

  return {
    asOf: now.toISOString(),
    asOfET: now.toLocaleString("en-US", { timeZone: "America/New_York" }),
    regime: regimeBlock,
    levels,
    crossAsset: crossAssetData.rows,
    vix: crossAssetData.vix,
    positioning,
    mlState: { recentPredictions: recent5, accuracy30d },
    analogs,
    catalystTags,
    panelHealth: briefing?.panelHealth ?? [],
    baseline: {
      verdict: briefing?.verdict ?? null,
      confidence: briefing?.confidence ?? null,
      oneLiner: briefing?.oneLiner ?? null,
      paths: briefing?.playbook?.paths ?? null,
    },
    warnings,
  };
}

// Pretty-print fusion context as compact prompt input.
export function fusionContextToPromptBlock(ctx: FusionContext): string {
  const lines: string[] = [];
  lines.push(`AS OF: ${ctx.asOfET} (ET)`);
  lines.push("");
  lines.push("=== BATCAVE REGIME ===");
  lines.push(`Label: ${ctx.regime.label ?? "n/a"} | Gamma: ${ctx.regime.gammaPosture ?? "n/a"} | Risk axis: ${ctx.regime.riskAxis ?? "n/a"} | VIX term: ${ctx.regime.vixTermStructure ?? "n/a"}`);
  if (ctx.regime.summary) lines.push(`Summary: ${ctx.regime.summary}`);
  lines.push("");
  lines.push("=== KEY LEVELS (SPY-scaled unless noted) ===");
  const l = ctx.levels;
  lines.push(`spot=${l.spot ?? "?"} · zeroGamma=${l.zeroGamma ?? "?"} · callWall=${l.callWall ?? "?"} · putWall=${l.putWall ?? "?"}`);
  if (l.upside || l.downside) lines.push(`SPX-scaled: upside=${l.upside ?? "?"} · downside=${l.downside ?? "?"} · vomma=${JSON.stringify(l.vomma)} · charm=${l.charm ?? "?"}`);
  lines.push("");
  lines.push("=== CROSS-ASSET TAPE ===");
  for (const row of ctx.crossAsset) {
    const fmt = (n: number | null) => (n == null ? "?" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%");
    lines.push(`  ${row.symbol.padEnd(4)} last=${row.last ?? "?"} d1=${fmt(row.d1Pct)} w1=${fmt(row.w1Pct)} m1=${fmt(row.m1Pct)}`);
  }
  if (ctx.vix.last != null) lines.push(`  VIX  last=${ctx.vix.last} change=${ctx.vix.changePct == null ? "?" : ctx.vix.changePct.toFixed(2)}%`);
  lines.push("");
  lines.push("=== OPTIONS POSITIONING ===");
  const p = ctx.positioning;
  lines.push(`GEX=${p.gex ?? "?"} | DEX=${p.dex ?? "?"} | flipLevel=${p.flipLevel ?? "?"}`);
  if (p.ivRv) lines.push(`IV30=${p.ivRv.iv30 ?? "?"} | RV30=${p.ivRv.rv30 ?? "?"} | spread=${p.ivRv.spread ?? "?"}`);
  if (p.skew) lines.push(`Skew: put25Δ=${p.skew.put25Delta ?? "?"} call25Δ=${p.skew.call25Delta ?? "?"} RR=${p.skew.riskReversal ?? "?"}`);
  lines.push("");
  lines.push("=== ML MODEL STATE ===");
  if (ctx.mlState.accuracy30d) {
    lines.push(`30d accuracy: ${ctx.mlState.accuracy30d.graded}/${ctx.mlState.accuracy30d.total} graded, hit rate ${ctx.mlState.accuracy30d.hitRate == null ? "?" : (ctx.mlState.accuracy30d.hitRate * 100).toFixed(1) + "%"}`);
  }
  for (const pr of ctx.mlState.recentPredictions) {
    lines.push(`  ${pr.ts} | ${pr.horizon} | pUp=${(pr.pUp * 100).toFixed(0)}% bias=${pr.bias} action=${pr.action} spot=${pr.spot}`);
  }
  lines.push("");
  lines.push(`=== CATALYST TAGS (from news) ===`);
  lines.push(ctx.catalystTags.length ? ctx.catalystTags.join(", ") : "(none extracted)");
  lines.push("");
  lines.push(`=== HISTORICAL ANALOGS (top ${ctx.analogs.length}) ===`);
  for (const a of ctx.analogs) {
    const tags = a.matchedTags.join(",");
    const ret1d = a.spy1d == null ? "?" : (a.spy1d >= 0 ? "+" : "") + a.spy1d.toFixed(1) + "%";
    const ret5d = a.spy5d == null ? "?" : (a.spy5d >= 0 ? "+" : "") + a.spy5d.toFixed(1) + "%";
    const ret20d = a.spy20d == null ? "?" : (a.spy20d >= 0 ? "+" : "") + a.spy20d.toFixed(1) + "%";
    const vix5d = a.vixDelta5d == null ? "?" : (a.vixDelta5d >= 0 ? "+" : "") + a.vixDelta5d.toFixed(1);
    lines.push(`  ${a.date ?? "(pattern)"} score=${a.matchScore.toFixed(2)} [${tags}]`);
    lines.push(`    "${a.catalyst}"`);
    lines.push(`    SPY 1d/5d/20d: ${ret1d} / ${ret5d} / ${ret20d} | VIXΔ5d: ${vix5d}`);
    lines.push(`    LESSON: ${a.lesson}`);
  }
  lines.push("");
  if (ctx.warnings.length) {
    lines.push("=== DATA HEALTH WARNINGS ===");
    ctx.warnings.forEach(w => lines.push(`  - ${w}`));
  }
  return lines.join("\n");
}
