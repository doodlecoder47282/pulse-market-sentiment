// server/regime.ts
// Regime Rotation Tracker — sector/factor rotation detection across 4 axes:
//   1. Risk-on / Risk-off      (SPY/TLT, HYG/LQD)
//   2. Growth / Value          (IWF/IWD, QQQ/DIA)
//   3. Cyclicals / Defensives  ((XLY+XLF+XLI) vs (XLP+XLU+XLV), Copper/Gold)
//   4. Small / Large           (IWM/SPY)
//
// Scoring: z-score of rolling relative-strength rate-of-change vs 2Y baseline.
//   - Fresh signal  = |z| >= 2.0 newly breached within last 5 trading days
//   - Durable trend = same-sign |z| >= 1.5 persistent for 6+ weeks (30+ td)
// Windows: 4W tactical / 13W quarterly / 52W yearly (all toggleable).
// Stage: early (<=2w consistent) / mid (3-6w) / mature (8w+)

import { storage } from "./storage";

// ----- Universe -----

export const REGIME_UNIVERSE = [
  // broad indices
  "SPY", "QQQ", "IWM", "DIA",
  // fixed income / credit
  "TLT", "HYG", "LQD",
  // FX / commodity anchors
  "DX-Y.NYB", "GLD", "USO",
  // copper via CPER etf (more reliable than HG=F for daily closes)
  "CPER",
  // style
  "IWF", "IWD",
  // sectors
  "XLK", "XLF", "XLE", "XLY", "XLP", "XLI", "XLU", "XLV", "XLB", "XLRE", "XLC",
  // sub-industries / themes
  "SMH", "XRT", "KRE", "ITB", "XBI",
];

// Axis definitions — each axis computes a ratio on the fly. Numerator/denominator
// are groups of ETFs whose equal-weighted avg price is used. Single-symbol
// groups (typical) just use that symbol's close.

export type AxisPair = {
  /** Stable id used in the response & UI */
  id: string;
  /** Short label shown in the UI */
  label: string;
  /** Human copy: when z is positive, we're rotating this way */
  positiveNarrative: string;
  /** Human copy: when z is negative */
  negativeNarrative: string;
  /** Numerator symbols (equal-weighted avg) */
  num: string[];
  /** Denominator symbols (equal-weighted avg) */
  den: string[];
  /** Axis group (for synthesizer) */
  axis: "risk" | "growth" | "cyclical" | "size";
  /** Short descriptor shown as evidence, e.g. "risk appetite" */
  theme: string;
};

// ----- Leaders/Laggards constituent universes -----
// Each axis has a "cohort" of ETFs that share the same thematic driver. We rank
// them by window RoC to find leaders; laggards flagged with RSI<35 + below
// 20DMA are candidates for catch-up trades relative to the axis leader.

export type AxisCohort = {
  axis: AxisPair["axis"];
  label: string;
  /** All ETFs that belong to this cohort */
  symbols: string[];
  /** Display hint — what the cohort represents */
  description: string;
};

export const AXIS_COHORTS: AxisCohort[] = [
  {
    axis: "risk",
    label: "Risk proxies",
    symbols: ["SPY", "QQQ", "IWM", "HYG", "LQD", "TLT", "GLD"],
    description: "Equities, credit, and safe-havens ranked by window return — leader is where the bid is, laggards with oversold RSI are rotation candidates",
  },
  {
    axis: "growth",
    label: "Style / factor ETFs",
    symbols: ["IWF", "IWD", "QQQ", "DIA", "XLK", "XLC", "SMH", "XLF", "XLI", "XLE"],
    description: "Growth vs value style buckets and tech-heavy sectors — leader shows where factor money is parked, laggards are reversion candidates",
  },
  {
    axis: "cyclical",
    label: "Sector cohort",
    symbols: ["XLY", "XLF", "XLI", "XLE", "XLB", "XLRE", "XLP", "XLU", "XLV", "XLC", "XLK"],
    description: "All 11 SPDR sectors — leader is the hot sector, laggards with low RSI and big negative gap are catch-up buy candidates",
  },
  {
    axis: "size",
    label: "Size / sub-industry",
    symbols: ["IWM", "SPY", "DIA", "QQQ", "XRT", "KRE", "ITB", "XBI", "SMH"],
    description: "Size cohorts + breadth-sensitive sub-industries — small-cap-heavy names (KRE, ITB, XRT, XBI) often lead/lag together on breadth swings",
  },
];

export const AXIS_PAIRS: AxisPair[] = [
  // AXIS 1 — Risk
  {
    id: "spy_tlt",
    label: "SPY / TLT",
    positiveNarrative: "stocks outrunning long bonds — pro-risk posture",
    negativeNarrative: "long bonds leading equities — defensive bid",
    num: ["SPY"], den: ["TLT"], axis: "risk", theme: "risk appetite",
  },
  {
    id: "hyg_lqd",
    label: "HYG / LQD",
    positiveNarrative: "high-yield credit outperforming investment grade — spreads tightening",
    negativeNarrative: "IG credit holding up vs junk — credit risk-off",
    num: ["HYG"], den: ["LQD"], axis: "risk", theme: "credit spreads",
  },
  // AXIS 2 — Growth/Value
  {
    id: "iwf_iwd",
    label: "IWF / IWD",
    positiveNarrative: "large-cap growth leading value",
    negativeNarrative: "value rotating ahead of growth",
    num: ["IWF"], den: ["IWD"], axis: "growth", theme: "growth vs value",
  },
  {
    id: "qqq_dia",
    label: "QQQ / DIA",
    positiveNarrative: "Nasdaq leading Dow — growth/tech bid",
    negativeNarrative: "Dow leading Nasdaq — old economy bid",
    num: ["QQQ"], den: ["DIA"], axis: "growth", theme: "tech vs industrials",
  },
  // AXIS 3 — Cyclicals/Defensives
  {
    id: "cyc_def_sectors",
    label: "(XLY+XLF+XLI) / (XLP+XLU+XLV)",
    positiveNarrative: "cyclicals leading defensives — growth expectations rising",
    negativeNarrative: "defensives bid over cyclicals — growth scare posture",
    num: ["XLY", "XLF", "XLI"], den: ["XLP", "XLU", "XLV"],
    axis: "cyclical", theme: "cyclicals vs defensives",
  },
  {
    id: "cper_gld",
    label: "CPER / GLD",
    positiveNarrative: "copper leading gold — reflation / industrial demand",
    negativeNarrative: "gold leading copper — recession / safe-haven bid",
    num: ["CPER"], den: ["GLD"], axis: "cyclical", theme: "Dr Copper vs Gold",
  },
  // AXIS 4 — Size
  {
    id: "iwm_spy",
    label: "IWM / SPY",
    positiveNarrative: "small caps leading — breadth widening, pro-cyclical",
    negativeNarrative: "large caps leading — breadth narrowing to mega-cap",
    num: ["IWM"], den: ["SPY"], axis: "size", theme: "small vs large",
  },
];

// ----- Fetcher -----

type DailyRow = { date: string; close: number; t: number };

const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0)";

function etDateString(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, "0");
  const dd = String(et.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function yFetch(url: string, timeoutMs = 15_000): Promise<any> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    return await r.json();
  } finally { clearTimeout(to); }
}

/**
 * Fetch 2Y of daily closes for one symbol from Yahoo. Returns ALL rows
 * (not merged with cache).
 */
async function fetchSymbol2Y(symbol: string): Promise<DailyRow[]> {
  const enc = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=2y`;
  try {
    const d = await yFetch(url);
    const r = d?.chart?.result?.[0];
    if (!r) return [];
    const ts: number[] = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const ac = r.indicators?.adjclose?.[0]?.adjclose || q.close;
    const rows: DailyRow[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = ac?.[i] ?? q.close?.[i];
      if (c == null || !isFinite(c)) continue;
      rows.push({ date: etDateString(ts[i]), close: c, t: ts[i] });
    }
    // Dedupe by date (Yahoo sometimes emits dupes near current session).
    const seen = new Set<string>();
    const dedup: DailyRow[] = [];
    for (const r of rows) {
      if (seen.has(r.date)) continue;
      seen.add(r.date);
      dedup.push(r);
    }
    return dedup;
  } catch {
    return [];
  }
}

/**
 * Refresh the cache for the full universe in parallel batches. Uses the most
 * recent cached date to skip symbols that already have today's data, minimizing
 * Yahoo calls. Caller should invoke this before computing regime.
 */
export async function ensureUniverseCached(): Promise<{ fetched: string[]; cached: string[]; failed: string[] }> {
  const today = etDateString(Math.floor(Date.now() / 1000));
  const needFetch: string[] = [];
  const stillCached: string[] = [];
  for (const sym of REGIME_UNIVERSE) {
    const latest = storage.getLatestBarDate(sym);
    // If we have today's bar (or at least yesterday's and market hasn't closed),
    // skip. Refresh whenever we're >1 trade day stale.
    if (latest && latest >= today) {
      stillCached.push(sym);
    } else {
      needFetch.push(sym);
    }
  }

  const failed: string[] = [];
  // Batches of 6 parallel fetches to be polite to Yahoo.
  const BATCH = 6;
  for (let i = 0; i < needFetch.length; i += BATCH) {
    const slice = needFetch.slice(i, i + BATCH);
    await Promise.all(slice.map(async (sym) => {
      const rows = await fetchSymbol2Y(sym);
      if (rows.length < 30) { failed.push(sym); return; }
      storage.upsertDailyBars(sym, rows);
    }));
  }
  return { fetched: needFetch.filter((s) => !failed.includes(s)), cached: stillCached, failed };
}

// ----- Ratio + stats -----

/** Equal-weighted composite of symbols by aligning on common dates. */
function composite(rowsBySymbol: Map<string, DailyRow[]>, symbols: string[]): DailyRow[] {
  if (!symbols.length) return [];
  // For each date, require all symbols present.
  const maps = symbols.map((s) => {
    const m = new Map<string, number>();
    const arr = rowsBySymbol.get(s) || [];
    for (const r of arr) m.set(r.date, r.close);
    return m;
  });
  const firstArr = rowsBySymbol.get(symbols[0]) || [];
  const out: DailyRow[] = [];
  for (const r of firstArr) {
    let sum = 0; let ok = true;
    for (const m of maps) {
      const v = m.get(r.date);
      if (v == null) { ok = false; break; }
      sum += v;
    }
    if (!ok) continue;
    out.push({ date: r.date, close: sum / symbols.length, t: r.t });
  }
  return out;
}

function ratioSeries(num: DailyRow[], den: DailyRow[]): DailyRow[] {
  const dm = new Map<string, number>();
  for (const r of den) dm.set(r.date, r.close);
  const out: DailyRow[] = [];
  for (const r of num) {
    const d = dm.get(r.date);
    if (d == null || d === 0) continue;
    out.push({ date: r.date, close: r.close / d, t: r.t });
  }
  return out;
}

/** Rate-of-change (%) looking back N trading days: (today - N) / N */
function rollingRoC(series: DailyRow[], window: number): { date: string; val: number }[] {
  const out: { date: string; val: number }[] = [];
  for (let i = window; i < series.length; i++) {
    const cur = series[i].close;
    const prev = series[i - window].close;
    if (prev === 0) continue;
    out.push({ date: series[i].date, val: ((cur - prev) / prev) * 100 });
  }
  return out;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Simple % return between two prices. */
function pct(now: number, then: number): number {
  if (!then) return 0;
  return ((now - then) / then) * 100;
}

/** Wilder's RSI over N periods using the standard SMMA of gains/losses. */
function rsi14(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses += -diff;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff >= 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

/** Simple moving average of the last N closes. */
function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  let s = 0;
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i];
  return s / period;
}

// ----- Per-axis evaluation -----

export type WindowKey = "w4" | "w13" | "w52";
const WINDOW_DAYS: Record<WindowKey, number> = { w4: 20, w13: 65, w52: 252 };

export type AxisReading = {
  id: string;
  label: string;
  axis: AxisPair["axis"];
  theme: string;
  /** Current rate-of-change in percent for this window */
  roc: number;
  /** z-score of that roc vs trailing 2Y of rolling rocs */
  z: number;
  /** Days the |z| has been > 1.5 in the same direction (persistence) */
  persistenceDays: number;
  /** Stage classification */
  stage: "early" | "mid" | "mature";
  /** True if |z| crossed 2.0 within the last 5 trading days */
  fresh: boolean;
  /** True if direction sign has held with |z|>=1.5 for 30+ trading days */
  durable: boolean;
  /** Direction: +1 numerator outperforming, -1 numerator lagging, 0 flat */
  direction: 1 | -1 | 0;
  /** Evidence sentence with specific numbers */
  evidence: string;
  /** Window for this reading */
  window: WindowKey;
  /** Conviction 0-100: combines |z| + persistence */
  conviction: number;
};

function classifyStage(persistenceDays: number): "early" | "mid" | "mature" {
  if (persistenceDays <= 10) return "early";   // 0-2 weeks
  if (persistenceDays <= 30) return "mid";     // 3-6 weeks
  return "mature";                              // 8 weeks+
}

function evaluateAxis(
  pair: AxisPair,
  rowsBySymbol: Map<string, DailyRow[]>,
  window: WindowKey,
): AxisReading | null {
  const num = composite(rowsBySymbol, pair.num);
  const den = composite(rowsBySymbol, pair.den);
  if (num.length < 300 || den.length < 300) return null; // need meaningful history
  const ratio = ratioSeries(num, den);
  if (ratio.length < WINDOW_DAYS[window] + 60) return null;

  const w = WINDOW_DAYS[window];
  const roc = rollingRoC(ratio, w);
  if (roc.length < 60) return null;

  // Baseline = last 2Y of rolling rocs (i.e. all available).
  const vals = roc.map((r) => r.val);
  const mu = mean(vals);
  const sd = stdev(vals);
  const curRoc = vals[vals.length - 1];
  const z = sd > 0 ? (curRoc - mu) / sd : 0;

  // Direction
  let direction: 1 | -1 | 0 = 0;
  if (z > 0.3) direction = 1;
  else if (z < -0.3) direction = -1;

  // Persistence: walk backwards through z-series in same direction above 1.5
  const zSeries: number[] = [];
  for (const v of vals) zSeries.push(sd > 0 ? (v - mu) / sd : 0);
  const sign = z >= 0 ? 1 : -1;
  let persistence = 0;
  for (let i = zSeries.length - 1; i >= 0; i--) {
    const zi = zSeries[i];
    if ((sign > 0 && zi >= 1.5) || (sign < 0 && zi <= -1.5)) persistence++;
    else break;
  }

  // Fresh: did |z| cross 2.0 (first breach of 2.0 in same direction) in last 5 days?
  let fresh = false;
  if (Math.abs(z) >= 2.0) {
    // Look at the prior 5 days BEFORE the current day: if any of them had |z|<2 with the
    // same sign, the 2.0 breach is fresh.
    const n = zSeries.length;
    const lookback = 5;
    for (let i = Math.max(0, n - 1 - lookback); i < n - 1; i++) {
      const zi = zSeries[i];
      const sameSign = (sign > 0 && zi > 0) || (sign < 0 && zi < 0);
      if (sameSign && Math.abs(zi) < 2.0) { fresh = true; break; }
      // Opposite sign or neutral also counts as fresh-breach
      if (!sameSign) { fresh = true; break; }
    }
    // Also fresh if |z| just turned the corner (prev day was below 2, today is above)
    if (!fresh && n >= 2) {
      if (Math.abs(zSeries[n - 2]) < 2.0) fresh = true;
    }
  }

  const durable = persistence >= 30; // 6+ weeks

  // Build evidence. Show raw component % returns over the same window.
  const nLastIdx = num.length - 1;
  const dLastIdx = den.length - 1;
  if (nLastIdx < w || dLastIdx < w) return null;
  const numPct = pct(num[nLastIdx].close, num[nLastIdx - w].close);
  const denPct = pct(den[dLastIdx].close, den[dLastIdx - w].close);
  const windowLabel = window === "w4" ? "4W" : window === "w13" ? "13W" : "52W";
  const numLabel = pair.num.length === 1 ? pair.num[0] : pair.num.join("+");
  const denLabel = pair.den.length === 1 ? pair.den[0] : pair.den.join("+");
  const evidence = `${numLabel} ${numPct >= 0 ? "+" : ""}${numPct.toFixed(1)}% vs ${denLabel} ${denPct >= 0 ? "+" : ""}${denPct.toFixed(1)}% over ${windowLabel} (ratio RoC ${curRoc >= 0 ? "+" : ""}${curRoc.toFixed(1)}%, z ${z >= 0 ? "+" : ""}${z.toFixed(2)}${persistence > 0 ? `, ${persistence}d persistent` : ""})`;

  // Conviction 0-100: |z| scaled (3.0 = max of 60) + persistence points (up to 40).
  const zPoints = Math.min(60, (Math.abs(z) / 3.0) * 60);
  const persistencePoints = Math.min(40, (persistence / 60) * 40);
  const conviction = Math.round(zPoints + persistencePoints);

  return {
    id: pair.id,
    label: pair.label,
    axis: pair.axis,
    theme: pair.theme,
    roc: curRoc,
    z,
    persistenceDays: persistence,
    stage: classifyStage(persistence),
    fresh,
    durable,
    direction,
    evidence,
    window,
    conviction,
  };
}

// ----- Top-level assembly + narrative -----

export type AxisSummary = {
  axis: AxisPair["axis"];
  label: string;
  /** weighted average z across all pairs on this axis, weighted by conviction  */
  compositeZ: number;
  /** dominant direction */
  direction: 1 | -1 | 0;
  /** overall stage (max persistence) */
  stage: "early" | "mid" | "mature";
  /** conviction 0-100 */
  conviction: number;
  /** narrative copy */
  narrative: string;
  readings: AxisReading[];
};

export type Theme = {
  /** "fresh" for new z2 breaches in last 5d, "durable" for long-standing trends */
  kind: "fresh" | "durable";
  headline: string;
  body: string;
  evidence: string[];
  axis: AxisPair["axis"];
  conviction: number;
};

// ----- Leaders/Laggards engine -----

export type ConstituentRow = {
  symbol: string;
  /** Window rate of return (%) */
  rocPct: number;
  /** Z-score of this RoC vs trailing 1Y of its own rolling RoC */
  rocZ: number;
  /** RSI(14) on daily closes */
  rsi: number | null;
  /** Current close */
  close: number;
  /** % distance from 20-day SMA */
  pctFrom20DMA: number | null;
  /** % distance from trailing 52-week high */
  pctFrom52WHigh: number | null;
  /** Role in cohort */
  role: "leader" | "mid" | "laggard";
  /** Cohort rank (1 = best RoC) */
  rank: number;
  /** Catch-up score 0-100 — higher = better buy-the-dip candidate for laggards.
   * Score combines: oversold RSI, below 20DMA, deep drawdown, large RoC gap to leader. */
  catchupScore: number;
  /** Whether this is flagged as a catch-up BUY candidate. */
  catchupCandidate: boolean;
  /** Evidence sentence describing why */
  note: string;
};

export type LeadersLaggards = {
  axis: AxisPair["axis"];
  cohortLabel: string;
  cohortDescription: string;
  leaders: ConstituentRow[];  // top 3 by RoC
  laggards: ConstituentRow[]; // bottom 3 by RoC
  all: ConstituentRow[];      // full sorted list (best → worst)
  catchupPicks: ConstituentRow[]; // laggards where catchupScore >= 55
};

function buildConstituents(
  cohort: AxisCohort,
  rowsBySymbol: Map<string, DailyRow[]>,
  window: WindowKey,
): ConstituentRow[] {
  const w = WINDOW_DAYS[window];
  const out: ConstituentRow[] = [];
  for (const sym of cohort.symbols) {
    const rows = rowsBySymbol.get(sym);
    if (!rows || rows.length < w + 30) continue;
    const closes = rows.map((r) => r.close);
    const last = closes[closes.length - 1];
    const then = closes[closes.length - 1 - w];
    if (!then) continue;
    const rocPct = pct(last, then);
    const rocSeries = rollingRoC(rows, w).slice(-252); // last ~1Y of rolling RoC
    const vals = rocSeries.map((r) => r.val);
    const mu = mean(vals);
    const sd = stdev(vals);
    const rocZ = sd > 0 ? (rocPct - mu) / sd : 0;
    const rsi = rsi14(closes);
    const s20 = sma(closes, 20);
    const pctFrom20DMA = s20 ? ((last - s20) / s20) * 100 : null;
    // 52-week high over trailing 252 sessions
    const window252 = closes.slice(Math.max(0, closes.length - 252));
    const hi = window252.reduce((a, b) => (b > a ? b : a), -Infinity);
    const pctFrom52WHigh = hi > 0 ? ((last - hi) / hi) * 100 : null;
    out.push({
      symbol: sym,
      rocPct,
      rocZ,
      rsi,
      close: last,
      pctFrom20DMA,
      pctFrom52WHigh,
      role: "mid",
      rank: 0,
      catchupScore: 0,
      catchupCandidate: false,
      note: "",
    });
  }
  // Rank by RoC desc
  out.sort((a, b) => b.rocPct - a.rocPct);
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const r = out[i];
    r.rank = i + 1;
    if (n >= 6 && i < Math.min(3, Math.ceil(n / 3))) r.role = "leader";
    else if (n >= 6 && i >= n - Math.min(3, Math.ceil(n / 3))) r.role = "laggard";
    else r.role = "mid";
  }

  // Catch-up score for laggards. Composite out of 100.
  const leaderRoC = out.length > 0 ? out[0].rocPct : 0;
  for (const r of out) {
    if (r.role !== "laggard") {
      r.note = r.role === "leader"
        ? `Rank #${r.rank} — leadership name. ${r.rocPct >= 0 ? "+" : ""}${r.rocPct.toFixed(1)}% over window, RSI ${r.rsi?.toFixed(0) ?? "—"}.`
        : `Mid-pack. ${r.rocPct >= 0 ? "+" : ""}${r.rocPct.toFixed(1)}% over window.`;
      continue;
    }
    // Oversold (RSI below 35 gets full 30pt; 40-35 partial)
    const rsiPts = r.rsi == null ? 0
      : r.rsi <= 30 ? 30
      : r.rsi <= 35 ? 25
      : r.rsi <= 40 ? 18
      : r.rsi <= 45 ? 10
      : 0;
    // Below 20DMA: -2% or worse = full 20pt
    const dmaPts = r.pctFrom20DMA == null ? 0
      : r.pctFrom20DMA <= -5 ? 20
      : r.pctFrom20DMA <= -2 ? 15
      : r.pctFrom20DMA <= -0.5 ? 8
      : 0;
    // Drawdown from 52W high: -10%+ = full 25pt
    const ddPts = r.pctFrom52WHigh == null ? 0
      : r.pctFrom52WHigh <= -20 ? 25
      : r.pctFrom52WHigh <= -10 ? 20
      : r.pctFrom52WHigh <= -5 ? 12
      : r.pctFrom52WHigh <= -2 ? 5
      : 0;
    // RoC gap to leader. Bigger gap = more room to catch up (up to 25pt).
    const gap = Math.max(0, leaderRoC - r.rocPct);
    const gapPts = gap >= 15 ? 25 : gap >= 10 ? 20 : gap >= 6 ? 15 : gap >= 3 ? 8 : 0;
    const score = Math.round(rsiPts + dmaPts + ddPts + gapPts);
    r.catchupScore = score;
    r.catchupCandidate = score >= 55;
    const bits: string[] = [];
    if (r.rsi != null) bits.push(`RSI ${r.rsi.toFixed(0)}${r.rsi <= 35 ? " (oversold)" : ""}`);
    if (r.pctFrom20DMA != null) bits.push(`${r.pctFrom20DMA >= 0 ? "+" : ""}${r.pctFrom20DMA.toFixed(1)}% vs 20DMA`);
    if (r.pctFrom52WHigh != null) bits.push(`${r.pctFrom52WHigh.toFixed(1)}% from 52W high`);
    bits.push(`gap to leader ${gap.toFixed(1)}pp`);
    r.note = r.catchupCandidate
      ? `Catch-up candidate (${score}/100). ${bits.join(" · ")}.`
      : `Laggard (${score}/100). ${bits.join(" · ")}.`;
  }
  return out;
}

function buildLeadersLaggards(
  rowsBySymbol: Map<string, DailyRow[]>,
  window: WindowKey,
): Record<AxisPair["axis"], LeadersLaggards> {
  const out: any = {};
  for (const cohort of AXIS_COHORTS) {
    const rows = buildConstituents(cohort, rowsBySymbol, window);
    const leaders = rows.filter((r) => r.role === "leader");
    const laggards = rows.filter((r) => r.role === "laggard").sort((a, b) => b.catchupScore - a.catchupScore);
    const catchupPicks = laggards.filter((r) => r.catchupCandidate);
    out[cohort.axis] = {
      axis: cohort.axis,
      cohortLabel: cohort.label,
      cohortDescription: cohort.description,
      leaders,
      laggards,
      all: rows,
      catchupPicks,
    } as LeadersLaggards;
  }
  return out;
}

export type RegimeResponse = {
  capturedAt: number;
  window: WindowKey;
  /** Overall headline summarizing the cross-axis narrative */
  headline: string;
  /** Narrative prose — reads like a research note */
  narrative: string;
  axes: AxisSummary[];
  freshThemes: Theme[];
  durableThemes: Theme[];
  /** Per-axis constituent decomposition with leaders/laggards/catch-up picks */
  leadersLaggards: Record<AxisPair["axis"], LeadersLaggards>;
  warnings: string[];
  // Diagnostics
  universeSize: number;
  missingSymbols: string[];
};

const AXIS_LABELS: Record<AxisPair["axis"], string> = {
  risk: "Risk-on / Risk-off",
  growth: "Growth / Value",
  cyclical: "Cyclicals / Defensives",
  size: "Small / Large",
};

function axisPositiveCopy(axis: AxisPair["axis"]): string {
  switch (axis) {
    case "risk": return "risk-on";
    case "growth": return "growth-led";
    case "cyclical": return "cyclical-led";
    case "size": return "small-cap-led";
  }
}
function axisNegativeCopy(axis: AxisPair["axis"]): string {
  switch (axis) {
    case "risk": return "risk-off";
    case "growth": return "value-led";
    case "cyclical": return "defensive-led";
    case "size": return "large-cap-led";
  }
}

function summarizeAxis(axis: AxisPair["axis"], readings: AxisReading[]): AxisSummary {
  const label = AXIS_LABELS[axis];
  if (!readings.length) {
    return { axis, label, compositeZ: 0, direction: 0, stage: "early", conviction: 0, narrative: "Insufficient data.", readings: [] };
  }
  // Conviction-weighted z
  const wSum = readings.reduce((a, r) => a + (r.conviction + 1), 0);
  const wZ = readings.reduce((a, r) => a + r.z * (r.conviction + 1), 0);
  const compositeZ = wSum > 0 ? wZ / wSum : 0;
  const direction: 1 | -1 | 0 = compositeZ > 0.3 ? 1 : compositeZ < -0.3 ? -1 : 0;
  const maxPersist = Math.max(...readings.map((r) => r.persistenceDays));
  const stage = classifyStage(maxPersist);
  const conviction = Math.round(readings.reduce((a, r) => a + r.conviction, 0) / readings.length);
  // Build narrative: pick most-convicted reading, lead with its narrative copy.
  const lead = [...readings].sort((a, b) => b.conviction - a.conviction)[0];
  const pair = AXIS_PAIRS.find((p) => p.id === lead.id)!;
  const stageCopy = stage === "early" ? "an early-stage" : stage === "mid" ? "a mid-stage" : "a mature";
  const dirCopy = direction === 0
    ? "Balanced — no clear rotation on this axis."
    : direction > 0
      ? `${stageCopy.charAt(0).toUpperCase() + stageCopy.slice(1)} ${axisPositiveCopy(axis)} rotation: ${pair.positiveNarrative}.`
      : `${stageCopy.charAt(0).toUpperCase() + stageCopy.slice(1)} ${axisNegativeCopy(axis)} rotation: ${pair.negativeNarrative}.`;
  return { axis, label, compositeZ, direction, stage, conviction, narrative: dirCopy, readings };
}

function buildThemes(readings: AxisReading[]): { fresh: Theme[]; durable: Theme[] } {
  const fresh: Theme[] = [];
  const durable: Theme[] = [];
  for (const r of readings) {
    const pair = AXIS_PAIRS.find((p) => p.id === r.id)!;
    const copy = r.direction >= 0 ? pair.positiveNarrative : pair.negativeNarrative;
    if (r.fresh) {
      fresh.push({
        kind: "fresh",
        headline: `${pair.label} — ${copy}`,
        body: `Ratio z-score hit ${r.z.toFixed(2)} this week on a ${r.window === "w4" ? "4-week" : r.window === "w13" ? "13-week" : "52-week"} basis, a fresh ±2σ breach. ${pair.axis === "risk" ? "Watch for confirmation in credit spreads." : pair.axis === "growth" ? "Style leadership may be shifting." : pair.axis === "cyclical" ? "Growth expectations are being repriced." : "Breadth dynamics are changing."}`,
        evidence: [r.evidence],
        axis: r.axis,
        conviction: r.conviction,
      });
    }
    if (r.durable) {
      durable.push({
        kind: "durable",
        headline: `${pair.label} — ${copy}`,
        body: `This rotation has run ${r.persistenceDays} consecutive trading days with |z|≥1.5 in the same direction — a ${r.stage === "mature" ? "mature trend" : "persistent regime"}. Trend participants are already in; counter-trend entries increasingly risky.`,
        evidence: [r.evidence],
        axis: r.axis,
        conviction: r.conviction,
      });
    }
  }
  // Dedup by axis+id but prefer higher conviction if both windows trigger
  const dedupeBy = (arr: Theme[]) => {
    const seen = new Map<string, Theme>();
    for (const t of arr) {
      const key = t.headline;
      const existing = seen.get(key);
      if (!existing || t.conviction > existing.conviction) seen.set(key, t);
    }
    return Array.from(seen.values()).sort((a, b) => b.conviction - a.conviction);
  };
  return { fresh: dedupeBy(fresh), durable: dedupeBy(durable) };
}

function buildNarrative(axes: AxisSummary[]): { headline: string; narrative: string } {
  const active = axes.filter((a) => a.direction !== 0 && a.conviction >= 20);
  if (!active.length) {
    return {
      headline: "No dominant rotation",
      narrative: "All four axes are sitting close to their 2-year baselines. Leadership is balanced across risk, style, sector cohort, and size. Wait for a catalyst before assuming a new regime.",
    };
  }
  // Lead with the highest-conviction axis, then weave in the rest.
  const sorted = [...active].sort((a, b) => b.conviction - a.conviction);
  const lead = sorted[0];
  const supporting = sorted.slice(1);

  const leadCopy = lead.direction > 0 ? axisPositiveCopy(lead.axis) : axisNegativeCopy(lead.axis);
  const headline = `${capitalize(leadCopy)} leadership — ${describeStage(lead.stage)}`;

  let narrative = `${lead.narrative}`;

  // Coherence check: do the other axes agree?
  const riskAxis = axes.find((a) => a.axis === "risk");
  const cyclicalAxis = axes.find((a) => a.axis === "cyclical");
  const sizeAxis = axes.find((a) => a.axis === "size");
  const growthAxis = axes.find((a) => a.axis === "growth");

  // Coherent risk-on: risk>0, cyclical>0, small-cap>0 (optional growth tilt)
  if (riskAxis && cyclicalAxis && riskAxis.direction > 0 && cyclicalAxis.direction > 0) {
    narrative += " Corroborating signal across credit and cyclicals — this is not an isolated move.";
  } else if (riskAxis && cyclicalAxis && riskAxis.direction < 0 && cyclicalAxis.direction < 0) {
    narrative += " Defensives are joining the bid — credit and cyclical data align in a risk-off posture.";
  } else if (riskAxis && cyclicalAxis && riskAxis.direction !== 0 && cyclicalAxis.direction !== 0 && riskAxis.direction !== cyclicalAxis.direction) {
    narrative += " Risk appetite and cyclical leadership disagree — likely a sector-specific trade rather than macro regime change.";
  }

  // Growth/Value commentary
  if (growthAxis && growthAxis.direction !== 0 && growthAxis.conviction >= 25) {
    const g = growthAxis.direction > 0 ? "Growth-style leadership" : "Value-style leadership";
    narrative += ` ${g} is layering on top of this${growthAxis.stage === "mature" ? " and has been running for weeks" : ""}.`;
  }

  // Size
  if (sizeAxis && sizeAxis.direction !== 0 && sizeAxis.conviction >= 25) {
    narrative += sizeAxis.direction > 0
      ? " Small-caps catching a bid adds breadth conviction."
      : " Breadth stays narrow — leadership concentrated in mega-cap.";
  }

  // Add supporting narratives
  for (const s of supporting) {
    if (s.conviction < 30) continue;
    narrative += ` ${s.narrative}`;
  }

  return { headline, narrative };
}

function describeStage(stage: "early" | "mid" | "mature"): string {
  if (stage === "early") return "early innings";
  if (stage === "mid") return "mid-cycle";
  return "mature trend, crowded tape";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ----- Public entry point -----

export async function buildRegimeSnapshot(window: WindowKey = "w4"): Promise<RegimeResponse> {
  const warnings: string[] = [];
  const { failed } = await ensureUniverseCached().catch((e) => {
    warnings.push(`Universe refresh error: ${e?.message ?? e}`);
    return { fetched: [], cached: [], failed: REGIME_UNIVERSE };
  });
  if (failed.length) warnings.push(`Symbols with no data: ${failed.join(", ")}`);

  // Load all cached data into memory
  const rowsBySymbol = new Map<string, DailyRow[]>();
  for (const sym of REGIME_UNIVERSE) {
    const rows = storage.getDailyBars(sym, 520);
    if (rows.length > 0) rowsBySymbol.set(sym, rows);
  }

  // Evaluate each axis at the requested window
  const readings: AxisReading[] = [];
  for (const pair of AXIS_PAIRS) {
    const r = evaluateAxis(pair, rowsBySymbol, window);
    if (r) readings.push(r);
  }

  // Also evaluate ALL windows for each pair (for fresh/durable detection),
  // then filter themes by combining readings. Fresh is by definition short-term,
  // Durable tends to appear on 13W/52W. We'll look across windows.
  const allReadings: AxisReading[] = [...readings];
  for (const w of ["w4", "w13", "w52"] as WindowKey[]) {
    if (w === window) continue;
    for (const pair of AXIS_PAIRS) {
      const r = evaluateAxis(pair, rowsBySymbol, w);
      if (r) allReadings.push(r);
    }
  }

  // Group axis summaries from the primary-window readings
  const byAxis = new Map<AxisPair["axis"], AxisReading[]>();
  for (const r of readings) {
    const arr = byAxis.get(r.axis) || [];
    arr.push(r);
    byAxis.set(r.axis, arr);
  }
  const axes: AxisSummary[] = [];
  for (const axis of ["risk", "growth", "cyclical", "size"] as AxisPair["axis"][]) {
    const arr = byAxis.get(axis) || [];
    axes.push(summarizeAxis(axis, arr));
  }

  const { fresh: freshThemes, durable: durableThemes } = buildThemes(allReadings);
  const { headline, narrative } = buildNarrative(axes);
  const leadersLaggards = buildLeadersLaggards(rowsBySymbol, window);

  return {
    capturedAt: Math.floor(Date.now() / 1000),
    window,
    headline,
    narrative,
    axes,
    freshThemes,
    durableThemes,
    leadersLaggards,
    warnings,
    universeSize: REGIME_UNIVERSE.length,
    missingSymbols: REGIME_UNIVERSE.filter((s) => !rowsBySymbol.has(s)),
  };
}
