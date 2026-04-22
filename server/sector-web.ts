// server/sector-web.ts
// Reactive sector web — pulls 11 GICS sector ETFs + their top 5-8 leader components,
// computes returns + relative strength vs SPY across 1D/1W/1M, and pairwise
// correlation between sectors (on daily returns, 60-day window). The shape is
// designed to feed both a D3 force-graph (nodes + edges) and a deep heatmap
// grid (sector header rows + leader cells).
//
// Why its own file: the existing regime.ts focuses on ETF rotation axes — we
// don't want to bloat that with 80+ single-name tickers. This module runs on
// its own schedule (10-min cache) and its own Yahoo batch fetcher.

import type { SectorWebResponse, SectorNode, LeaderNode, SectorEdge, SectorGridRow } from "@shared/schema";

const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0)";

// ----- Universe -----
// 11 GICS sectors (SPDR ETFs) + 5-8 top components each. Chosen by 2025 weight
// in each sector ETF — the "leaders everyone watches."

export interface SectorDef {
  /** SPDR sector ETF */
  etf: string;
  /** Human label */
  name: string;
  /** Tailwind-friendly HSL hue for the sector (used for node color + halo) */
  hue: number;
  /** Short identifier for CSS class names */
  id: string;
  /** Top components by weight — the "leaders" satellites around the sector node */
  leaders: string[];
}

export const SECTORS: SectorDef[] = [
  { id: "tech",   etf: "XLK",  name: "Technology",             hue: 210, leaders: ["AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "ADBE"] },
  { id: "comm",   etf: "XLC",  name: "Communication Services", hue: 270, leaders: ["META", "GOOGL", "NFLX", "TMUS", "DIS",  "CMCSA"] },
  { id: "disc",   etf: "XLY",  name: "Consumer Discretionary", hue: 330, leaders: ["AMZN", "TSLA", "HD",   "MCD",  "LOW",  "NKE",  "SBUX"] },
  { id: "stap",   etf: "XLP",  name: "Consumer Staples",       hue: 140, leaders: ["COST", "WMT",  "PG",   "KO",   "PEP",  "PM",   "MDLZ"] },
  { id: "fin",    etf: "XLF",  name: "Financials",             hue: 200, leaders: ["JPM",  "BRK-B","V",    "MA",   "BAC",  "WFC",  "GS"] },
  { id: "hlth",   etf: "XLV",  name: "Health Care",            hue: 160, leaders: ["LLY",  "UNH",  "JNJ",  "ABBV", "MRK",  "TMO",  "ABT"] },
  { id: "ind",    etf: "XLI",  name: "Industrials",            hue: 30,  leaders: ["GE",   "CAT",  "RTX",  "HON",  "UBER", "UNP",  "ETN"] },
  { id: "enrg",   etf: "XLE",  name: "Energy",                 hue: 15,  leaders: ["XOM",  "CVX",  "COP",  "SLB",  "EOG",  "PSX"] },
  { id: "util",   etf: "XLU",  name: "Utilities",              hue: 55,  leaders: ["NEE",  "SO",   "DUK",  "CEG",  "VST",  "AEP"] },
  { id: "mat",    etf: "XLB",  name: "Materials",              hue: 85,  leaders: ["LIN",  "SHW",  "APD",  "ECL",  "FCX",  "NEM"] },
  { id: "reit",   etf: "XLRE", name: "Real Estate",            hue: 300, leaders: ["PLD",  "AMT",  "EQIX", "WELL", "SPG",  "O"] },
];

/** Flat list of every ticker we need to fetch (ETFs + leaders + SPY benchmark). */
export function allSectorTickers(): string[] {
  const set = new Set<string>(["SPY"]);
  for (const s of SECTORS) {
    set.add(s.etf);
    for (const t of s.leaders) set.add(t);
  }
  return Array.from(set);
}

// ----- Yahoo batch fetcher -----

type DailyBar = { t: number; close: number };

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

/** Pull ~90 days of daily closes for one symbol (enough for 1M returns + 60d corr). */
async function fetchDaily(symbol: string): Promise<DailyBar[]> {
  const enc = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=3mo`;
  try {
    const d = await yFetch(url);
    const r = d?.chart?.result?.[0];
    if (!r) return [];
    const ts: number[] = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const ac = r.indicators?.adjclose?.[0]?.adjclose || q.close;
    const rows: DailyBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = ac?.[i] ?? q.close?.[i];
      if (c == null || !isFinite(c)) continue;
      rows.push({ t: ts[i], close: c });
    }
    return rows;
  } catch {
    return [];
  }
}

/** Fetch everything in parallel batches of 8. */
async function fetchAllDaily(symbols: string[]): Promise<Map<string, DailyBar[]>> {
  const out = new Map<string, DailyBar[]>();
  const BATCH = 8;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const slice = symbols.slice(i, i + BATCH);
    await Promise.all(slice.map(async (s) => {
      const bars = await fetchDaily(s);
      if (bars.length) out.set(s, bars);
    }));
  }
  return out;
}

// ----- Math helpers -----

function pct(a: number, b: number): number {
  if (!b || !isFinite(b)) return 0;
  return ((a - b) / b) * 100;
}

/** Returns {r1d, r1w, r1m} from the daily bars array. */
function computeReturns(bars: DailyBar[]): { r1d: number; r1w: number; r1m: number; last: number; prev: number } {
  if (bars.length < 2) return { r1d: 0, r1w: 0, r1m: 0, last: 0, prev: 0 };
  const last = bars[bars.length - 1].close;
  const prev = bars[bars.length - 2].close;
  const wIdx = Math.max(0, bars.length - 6);   // 5 trading days back
  const mIdx = Math.max(0, bars.length - 22);  // ~21 trading days back
  return {
    r1d: pct(last, prev),
    r1w: pct(last, bars[wIdx].close),
    r1m: pct(last, bars[mIdx].close),
    last, prev,
  };
}

/** Daily log returns over last N bars for correlation. */
function logReturns(bars: DailyBar[], n: number): number[] {
  const slice = bars.slice(-n - 1);
  const out: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1].close <= 0) continue;
    out.push(Math.log(slice[i].close / slice[i - 1].close));
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  const aa = a.slice(-n), bb = b.slice(-n);
  let sA = 0, sB = 0;
  for (let i = 0; i < n; i++) { sA += aa[i]; sB += bb[i]; }
  const mA = sA / n, mB = sB / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = aa[i] - mA, db = bb[i] - mB;
    num += da * db; dA += da * da; dB += db * db;
  }
  const denom = Math.sqrt(dA * dB);
  return denom ? num / denom : 0;
}

// ----- Public builder -----

let _cache: { t: number; data: SectorWebResponse } | null = null;
const TTL_MS = 10 * 60_000; // 10 minutes

export async function buildSectorWeb(): Promise<SectorWebResponse> {
  if (_cache && Date.now() - _cache.t < TTL_MS) return _cache.data;

  const tickers = allSectorTickers();
  const daily = await fetchAllDaily(tickers);

  const spyBars = daily.get("SPY") || [];
  const spy = computeReturns(spyBars);
  const spyLog = logReturns(spyBars, 60);

  // Build sector + leader nodes
  const sectorNodes: SectorNode[] = [];
  const leaderNodes: LeaderNode[] = [];
  const grid: SectorGridRow[] = [];
  const sectorLogReturns = new Map<string, number[]>();

  for (const sec of SECTORS) {
    const etfBars = daily.get(sec.etf) || [];
    const etfRet = computeReturns(etfBars);
    sectorLogReturns.set(sec.id, logReturns(etfBars, 60));

    // RS = sector ETF return minus SPY return over each window
    const rs1d = etfRet.r1d - spy.r1d;
    const rs1w = etfRet.r1w - spy.r1w;
    const rs1m = etfRet.r1m - spy.r1m;
    // Simple "heat" = weighted blend emphasizing recent
    const heat = 0.5 * rs1d + 0.3 * rs1w + 0.2 * rs1m;

    sectorNodes.push({
      id: sec.id,
      kind: "sector",
      symbol: sec.etf,
      name: sec.name,
      hue: sec.hue,
      r1d: etfRet.r1d,
      r1w: etfRet.r1w,
      r1m: etfRet.r1m,
      rs1d, rs1w, rs1m,
      heat,
      last: etfRet.last,
    });

    // Leader satellites + grid row
    const leaders: LeaderNode[] = [];
    for (const t of sec.leaders) {
      const bars = daily.get(t);
      if (!bars || bars.length < 10) continue;
      const r = computeReturns(bars);
      const ln: LeaderNode = {
        id: t,
        kind: "leader",
        symbol: t,
        sectorId: sec.id,
        name: t,
        hue: sec.hue,
        r1d: r.r1d,
        r1w: r.r1w,
        r1m: r.r1m,
        rs1d: r.r1d - spy.r1d,
        rs1w: r.r1w - spy.r1w,
        rs1m: r.r1m - spy.r1m,
        last: r.last,
      };
      leaders.push(ln);
      leaderNodes.push(ln);
    }
    grid.push({
      sectorId: sec.id,
      sectorName: sec.name,
      etf: sec.etf,
      hue: sec.hue,
      r1d: etfRet.r1d, r1w: etfRet.r1w, r1m: etfRet.r1m,
      rs1d, rs1w, rs1m,
      heat,
      leaders: leaders.sort((a, b) => b.rs1w - a.rs1w),
    });
  }

  // Sector ↔ sector correlation edges (only emit strong ones > 0.35 or < -0.15)
  const edges: SectorEdge[] = [];
  for (let i = 0; i < SECTORS.length; i++) {
    for (let j = i + 1; j < SECTORS.length; j++) {
      const a = sectorLogReturns.get(SECTORS[i].id) || [];
      const b = sectorLogReturns.get(SECTORS[j].id) || [];
      const c = pearson(a, b);
      if (!isFinite(c)) continue;
      // We emit edges for any |c| >= 0.3 — strong positive link (tight) or
      // negative (divergent). Width scales with |c|.
      if (Math.abs(c) >= 0.3) {
        edges.push({ source: SECTORS[i].id, target: SECTORS[j].id, corr: c });
      }
    }
  }
  // Also SPY ↔ each sector (for pull toward center)
  for (const sec of SECTORS) {
    const c = pearson(spyLog, sectorLogReturns.get(sec.id) || []);
    if (isFinite(c) && Math.abs(c) >= 0.3) {
      edges.push({ source: "spy", target: sec.id, corr: c });
    }
  }

  // Central SPY "market" node
  const spyNode: SectorNode = {
    id: "spy",
    kind: "market",
    symbol: "SPY",
    name: "S&P 500",
    hue: 0,
    r1d: spy.r1d, r1w: spy.r1w, r1m: spy.r1m,
    rs1d: 0, rs1w: 0, rs1m: 0,
    heat: 0,
    last: spy.last,
  };

  // Regime pulse: recent breadth — count sectors above SPY over 1W
  const breadth1w = sectorNodes.filter((n) => n.rs1w > 0).length;
  const breadth1m = sectorNodes.filter((n) => n.rs1m > 0).length;

  const out: SectorWebResponse = {
    asOf: new Date().toISOString(),
    spy: spyNode,
    sectors: sectorNodes,
    leaders: leaderNodes,
    edges,
    grid,
    breadth: {
      w1: breadth1w,
      m1: breadth1m,
      total: sectorNodes.length,
    },
  };
  _cache = { t: Date.now(), data: out };
  return out;
}
