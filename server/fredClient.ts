// FRED — Federal Reserve Economic Data.
// Public/free endpoint via fredgraph.csv (no API key required for CSV download).
// Pulls the macro series we want and caches in fred_series.

import { sqlite } from "./storage";

// Curated set with high signal for trading regime
export const FRED_SERIES = {
  // Liquidity / financial conditions
  WALCL: "Fed Balance Sheet (Wkly)",
  WTREGEN: "Treasury General Account",
  WLODL: "Reverse Repo (RRP)",
  STLFSI4: "St Louis Fed Financial Stress Index",
  ANFCI: "Adjusted National Financial Conditions Index",
  // Rates / curve
  DGS2: "2Y Treasury",
  DGS10: "10Y Treasury",
  T10Y2Y: "10Y-2Y Spread",
  T10Y3M: "10Y-3M Spread",
  // Growth / inflation
  CPIAUCSL: "CPI Headline (m/m base)",
  PCEPI: "PCE Price Index",
  UNRATE: "Unemployment Rate",
  ICSA: "Initial Jobless Claims",
  // Credit / liquidity stress
  BAMLH0A0HYM2: "ICE BofA HY OAS",
  TEDRATE: "TED Spread (legacy)",
  SOFR: "SOFR Overnight",
  // Money supply / dollar
  M2SL: "M2 Money Supply",
  DTWEXBGS: "Trade-Weighted Dollar Index",
} as const;

export type FredSeriesId = keyof typeof FRED_SERIES;

interface FredRow { date: string; value: number | null; }

const ONE_DAY_MS = 86_400_000;

function nyDate(epochMs = Date.now()): string {
  return new Date(epochMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function fetchFredCsv(seriesId: string): Promise<FredRow[]> {
  // FRED graph CSV — public, no key.
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`fred ${seriesId} ${resp.status}`);
    const text = await resp.text();
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    // header: DATE,SERIESID
    const out: FredRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const [date, raw] = lines[i].split(",");
      if (!date) continue;
      const v = raw && raw !== "." ? parseFloat(raw) : null;
      out.push({ date, value: Number.isFinite(v) ? (v as number) : null });
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

function persistRows(seriesId: string, rows: FredRow[]): void {
  if (!rows.length) return;
  const stmt = sqlite.prepare(`
    INSERT OR REPLACE INTO fred_series (series_id, date, value, refreshed_at)
    VALUES (?,?,?,?)
  `);
  const now = Date.now();
  const tx = sqlite.transaction((rs: FredRow[]) => {
    for (const r of rs) stmt.run(seriesId, r.date, r.value, now);
  });
  tx(rows);
}

function isStale(seriesId: string): boolean {
  const row = sqlite.prepare(`SELECT MAX(refreshed_at) as m FROM fred_series WHERE series_id = ?`)
    .get(seriesId) as { m: number | null };
  if (!row?.m) return true;
  return (Date.now() - row.m) > ONE_DAY_MS;
}

export async function refreshFredSeries(seriesId: string): Promise<{ ok: boolean; rows: number; error?: string }> {
  try {
    const rows = await fetchFredCsv(seriesId);
    persistRows(seriesId, rows);
    return { ok: true, rows: rows.length };
  } catch (e: any) {
    return { ok: false, rows: 0, error: e?.message ?? String(e) };
  }
}

export async function refreshAll(): Promise<Record<string, { ok: boolean; rows: number }>> {
  const out: Record<string, { ok: boolean; rows: number }> = {};
  for (const id of Object.keys(FRED_SERIES)) {
    if (!isStale(id)) { out[id] = { ok: true, rows: 0 }; continue; }
    const r = await refreshFredSeries(id);
    out[id] = { ok: r.ok, rows: r.rows };
    // Light pacing
    await new Promise(r => setTimeout(r, 250));
  }
  return out;
}

export interface FredObservation {
  seriesId: string;
  label: string;
  latest: number | null;
  latestDate: string | null;
  prev: number | null;
  prevDate: string | null;
  change: number | null;
  changePct: number | null;
  weekChange: number | null;
  monthChange: number | null;
  history: { date: string; value: number | null }[];
}

export function getFredSnapshot(): FredObservation[] {
  const out: FredObservation[] = [];
  for (const [id, label] of Object.entries(FRED_SERIES)) {
    const rows = sqlite.prepare(
      `SELECT date, value FROM fred_series WHERE series_id = ? ORDER BY date DESC LIMIT 60`
    ).all(id) as { date: string; value: number | null }[];
    if (!rows.length) {
      out.push({
        seriesId: id, label, latest: null, latestDate: null,
        prev: null, prevDate: null, change: null, changePct: null,
        weekChange: null, monthChange: null, history: [],
      });
      continue;
    }
    const latest = rows[0]?.value ?? null;
    const latestDate = rows[0]?.date ?? null;
    const prev = rows[1]?.value ?? null;
    const prevDate = rows[1]?.date ?? null;
    const change = (latest != null && prev != null) ? latest - prev : null;
    const changePct = (latest != null && prev != null && prev !== 0) ? ((latest - prev) / prev) * 100 : null;
    const wkRow = rows.find((_, i) => i >= 5);
    const moRow = rows.find((_, i) => i >= 22);
    const weekChange = (latest != null && wkRow?.value != null) ? latest - wkRow.value : null;
    const monthChange = (latest != null && moRow?.value != null) ? latest - moRow.value : null;
    out.push({
      seriesId: id, label, latest, latestDate, prev, prevDate, change, changePct,
      weekChange, monthChange,
      history: rows.slice(0, 30).reverse(),
    });
  }
  return out;
}

let fredRefreshTimer: NodeJS.Timeout | null = null;
export function startFredRefresher(intervalMs = 6 * 60 * 60 * 1000): void {
  if (fredRefreshTimer) return;
  // Fire once on boot, then every 6h.
  refreshAll().catch(() => {});
  fredRefreshTimer = setInterval(() => { refreshAll().catch(() => {}); }, intervalMs);
}
export function stopFredRefresher(): void {
  if (fredRefreshTimer) { clearInterval(fredRefreshTimer); fredRefreshTimer = null; }
}
