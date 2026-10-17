// server/cryptoCommunityCore.ts
//
// Pure half of the community watch (no I/O, no SQLite): entry shape, the
// DexScreener pool pick, the GeckoTerminal candle parse and the derived
// structure fields from shared/memeStructure.ts. Unit-tested on plain Node;
// cryptoCommunity.ts does the fetching, storage and scheduling.

import {
  classifyMeme, linePosition, rangeStats, tradeCost, maxSizeAtImpact,
  type DailyBar, type LinePosition, type MemeClass, type RangeStats, type TradeCost,
} from "../shared/memeStructure";

export const COST_SIZE_USD = 1_000;

// ─── Types ──────────────────────────────────────────────────────────────

export type QuoteState = "pending" | "ok" | "not_found" | "unavailable";
export type HistoryState = "pending" | "ok" | "partial" | "no_data" | "unavailable";

export interface CommunityEntry {
  tokenAddress: string;
  label: string | null;
  addedAt: number;
  chain: "solana";
  symbol: string | null;
  name: string | null;
  pairAddress: string | null;
  dexId: string | null;
  pairCreatedAt: number | null;
  ageDays: number | null;
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  vol24h: number | null;
  chg24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  quoteState: QuoteState;
  quoteAt: number | null;
  quoteError: string | null;
  range: RangeStats | null;
  historyState: HistoryState;
  historyAt: number | null;
  historyError: string | null;
  /** Round trip of $1,000 against the pool's depth at the default fee assumptions. */
  cost1k: TradeCost | null;
  /** Largest buy at 1% price impact. */
  maxSizeAt1Pct: number | null;
  structure: MemeClass | null;
  line: LinePosition;
}

export interface CommunityWatch {
  entries: CommunityEntry[];
  asOf: number;
  source: string;
  edition: "personal" | "investor" | "demo";
  writable: boolean;
  limits: { maxTokens: number; historyRefreshMs: number; quoteRefreshMs: number };
  note: string;
}

export function blankEntry(tokenAddress: string, label: string | null, addedAt: number): CommunityEntry {
  return {
    tokenAddress, label, addedAt, chain: "solana",
    symbol: null, name: null, pairAddress: null, dexId: null, pairCreatedAt: null, ageDays: null,
    priceUsd: null, marketCap: null, fdv: null, liquidityUsd: null, vol24h: null, chg24h: null, buys24h: null, sells24h: null,
    quoteState: "pending", quoteAt: null, quoteError: null,
    range: null, historyState: "pending", historyAt: null, historyError: null,
    cost1k: null, maxSizeAt1Pct: null, structure: null,
    line: linePosition(null, false),
  };
}

export const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

// ─── Derived fields (pure; also used by the demo sample) ────────────────

export function deriveEntry(e: CommunityEntry, now = Date.now()): void {
  e.ageDays = e.pairCreatedAt ? Math.max(0, (now - e.pairCreatedAt) / 86_400_000) : null;
  e.line = linePosition(e.ageDays == null ? null : e.ageDays * 1440, false);
  e.cost1k = tradeCost({ liquidityUsd: e.liquidityUsd, sizeUsd: COST_SIZE_USD });
  e.maxSizeAt1Pct = maxSizeAtImpact(e.liquidityUsd, 1);
  e.structure = classifyMeme({
    name: e.name ?? "", symbol: e.symbol ?? "", ageDays: e.ageDays, liquidityUsd: e.liquidityUsd,
    // Holder concentration and mint authority are not read for watch tokens yet;
    // the classifier reports them as missing, so the read stays tentative.
    top10Pct: null, mintAuthorityActive: null,
    narrativeHits: [], history: e.range,
  });
}

/** Pick the deepest Solana pool of a token from a DexScreener token response. */
export function pickPool(pairs: any[], tokenAddress: string): any | null {
  let best: any = null;
  for (const p of pairs || []) {
    if (String(p?.chainId ?? "") !== "solana") continue;
    if (String(p?.baseToken?.address ?? "") !== tokenAddress) continue;
    const liq = num(p?.liquidity?.usd) ?? -1;
    if (!best || liq > (num(best?.liquidity?.usd) ?? -1)) best = p;
  }
  return best;
}

export function applyPool(e: CommunityEntry, p: any | null, now = Date.now()): void {
  if (!p) {
    e.quoteState = "not_found";
    e.quoteError = "no Solana pool with this base token on DexScreener";
    e.quoteAt = now;
    deriveEntry(e, now);
    return;
  }
  e.symbol = String(p?.baseToken?.symbol ?? e.symbol ?? "");
  e.name = String(p?.baseToken?.name ?? e.name ?? "");
  e.pairAddress = String(p?.pairAddress ?? "") || null;
  e.dexId = String(p?.dexId ?? "") || null;
  e.pairCreatedAt = num(p?.pairCreatedAt);
  e.priceUsd = num(p?.priceUsd);
  e.marketCap = num(p?.marketCap);
  e.fdv = num(p?.fdv);
  e.liquidityUsd = num(p?.liquidity?.usd);
  e.vol24h = num(p?.volume?.h24);
  e.chg24h = num(p?.priceChange?.h24);
  e.buys24h = num(p?.txns?.h24?.buys);
  e.sells24h = num(p?.txns?.h24?.sells);
  e.quoteState = "ok";
  e.quoteError = null;
  e.quoteAt = now;
  deriveEntry(e, now);
}

/** GeckoTerminal ohlcv_list rows ([unix seconds, o, h, l, c, v], newest first) to ascending DailyBar[]. */
export function parseOhlcv(payload: any): DailyBar[] {
  const list: any[] = payload?.data?.attributes?.ohlcv_list ?? [];
  const out: DailyBar[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const t = num(row[0]), o = num(row[1]), h = num(row[2]), l = num(row[3]), c = num(row[4]), v = num(row[5]);
    if (t == null || c == null) continue;
    out.push({ t: t * 1000, o: o ?? c, h: h ?? c, l: l ?? c, c, v: v ?? 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function applyHistory(e: CommunityEntry, bars: DailyBar[], now = Date.now()): void {
  e.range = rangeStats(bars, 90);
  e.historyState = e.range.dataState;
  e.historyAt = now;
  e.historyError = null;
  deriveEntry(e, now);
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/** A deterministic daily series with one deep dip that is reclaimed, for the demo. */
export function sampleBars(seed: string, days: number, startPx: number, endMs: number): DailyBar[] {
  const out: DailyBar[] = [];
  let px = startPx;
  for (let i = 0; i < days; i++) {
    const t = endMs - (days - 1 - i) * 86_400_000;
    const u = hash01(`${seed}:${i}`) - 0.5;
    // Shape: climb to a high around day 35, a ~75% dip to day 55, a reclaim to a new high by day 85, then a 25% pullback.
    const phase = i < 35 ? 0.035 : i < 55 ? -0.072 : i < 85 ? 0.06 : -0.012;
    px = Math.max(1e-6, px * Math.exp(phase + u * 0.06));
    const h = px * (1 + Math.abs(u) * 0.05), l = px * (1 - Math.abs(u) * 0.05);
    out.push({ t, o: px * (1 - u * 0.02), h, l, c: px, v: Math.round(2_000_000 * (0.6 + hash01(`${seed}:v:${i}`))) });
  }
  return out;
}

