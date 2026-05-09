// CFTC Commitments of Traders (COT) — public dataset.
// We fetch the legacy futures-only "Disaggregated" report via the public socrata API
// (no key required, rate-limited but generous). Cache weekly.
//
// Markets we care about: SPX e-mini, Nasdaq e-mini, US 10Y, US 2Y, EUR, JPY, Gold, Crude.

import { sqlite } from "./storage";

interface SocrataRow {
  report_date_as_yyyy_mm_dd?: string;
  market_and_exchange_names?: string;
  open_interest_all?: string;
  noncomm_positions_long_all?: string;
  noncomm_positions_short_all?: string;
  comm_positions_long_all?: string;
  comm_positions_short_all?: string;
  nonrept_positions_long_all?: string;
  nonrept_positions_short_all?: string;
}

// Canonical -> CFTC contract name fragment
export const COT_MARKETS: Record<string, string> = {
  ES: "E-MINI S&P 500",
  NQ: "NASDAQ-100 E-MINI",
  ZN: "10-YEAR U.S. TREASURY",
  ZT: "2-YEAR U.S. TREASURY",
  GC: "GOLD",
  CL: "WTI-PHYSICAL",
  EUR: "EURO FX",
  JPY: "JAPANESE YEN",
  VIX: "VIX FUTURES",
};

const ONE_WEEK_MS = 7 * 86_400_000;

function n(s: string | undefined): number | null {
  if (!s) return null;
  const v = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

async function fetchCotForFragment(fragment: string, limit = 12): Promise<SocrataRow[]> {
  // CFTC legacy futures-only commitments via socrata (jun74-fxsl)
  const upper = fragment.replace(/'/g, "''");
  const where = `upper(market_and_exchange_names) like '%${upper.toUpperCase()}%'`;
  const url = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=${encodeURIComponent(where)}&$order=report_date_as_yyyy_mm_dd DESC&$limit=${limit}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`cot ${resp.status}`);
    const json = await resp.json() as SocrataRow[];
    return Array.isArray(json) ? json : [];
  } finally {
    clearTimeout(t);
  }
}

function persist(market: string, rows: SocrataRow[]): number {
  if (!rows.length) return 0;
  const stmt = sqlite.prepare(`
    INSERT OR REPLACE INTO cot_reports
      (market, report_date, commercial_net, non_commercial_net, small_specs_net, oi, payload)
    VALUES (?,?,?,?,?,?,?)
  `);
  let count = 0;
  const tx = sqlite.transaction((rs: SocrataRow[]) => {
    for (const r of rs) {
      const cl = n(r.comm_positions_long_all) ?? 0;
      const cs = n(r.comm_positions_short_all) ?? 0;
      const ncl = n(r.noncomm_positions_long_all) ?? 0;
      const ncs = n(r.noncomm_positions_short_all) ?? 0;
      const nrl = n(r.nonrept_positions_long_all) ?? 0;
      const nrs = n(r.nonrept_positions_short_all) ?? 0;
      const oi = n(r.open_interest_all) ?? 0;
      stmt.run(
        market,
        r.report_date_as_yyyy_mm_dd ?? "",
        cl - cs,
        ncl - ncs,
        nrl - nrs,
        oi,
        JSON.stringify(r),
      );
      count++;
    }
  });
  tx(rows);
  return count;
}

function isStale(market: string): boolean {
  const row = sqlite.prepare(`SELECT MAX(report_date) as d FROM cot_reports WHERE market = ?`)
    .get(market) as { d: string | null };
  if (!row?.d) return true;
  // Reports published every Friday — refresh if older than a week.
  const last = Date.parse(row.d);
  if (!Number.isFinite(last)) return true;
  return (Date.now() - last) > ONE_WEEK_MS;
}

export async function refreshAllCot(): Promise<Record<string, { ok: boolean; rows: number; error?: string }>> {
  const out: Record<string, { ok: boolean; rows: number; error?: string }> = {};
  for (const [market, fragment] of Object.entries(COT_MARKETS)) {
    if (!isStale(market)) { out[market] = { ok: true, rows: 0 }; continue; }
    try {
      const rows = await fetchCotForFragment(fragment);
      persist(market, rows);
      out[market] = { ok: true, rows: rows.length };
    } catch (e: any) {
      out[market] = { ok: false, rows: 0, error: e?.message ?? String(e) };
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return out;
}

export interface CotSnapshotRow {
  market: string;
  reportDate: string;
  commercialNet: number;
  nonCommercialNet: number;
  smallSpecsNet: number;
  oi: number;
  // Percentile rank of nonCommercialNet over last 156 weeks (3y)
  nonCommercialPctile: number | null;
  weekChangeNonComm: number | null;
  bias: "spec-extreme-long" | "spec-extreme-short" | "neutral" | "tilting-long" | "tilting-short";
}

export function getCotSnapshot(): CotSnapshotRow[] {
  const out: CotSnapshotRow[] = [];
  for (const market of Object.keys(COT_MARKETS)) {
    const hist = sqlite.prepare(
      `SELECT report_date, commercial_net, non_commercial_net, small_specs_net, oi
       FROM cot_reports WHERE market = ? ORDER BY report_date DESC LIMIT 156`
    ).all(market) as { report_date: string; commercial_net: number; non_commercial_net: number; small_specs_net: number; oi: number }[];
    if (!hist.length) continue;
    const latest = hist[0];
    const prev = hist[1];
    const ncSeries = hist.map(r => r.non_commercial_net).filter(Number.isFinite);
    let pct: number | null = null;
    if (ncSeries.length >= 30) {
      const sorted = [...ncSeries].sort((a, b) => a - b);
      const idx = sorted.indexOf(latest.non_commercial_net);
      pct = idx >= 0 ? (idx / (sorted.length - 1)) * 100 : null;
    }
    const wkChg = prev ? latest.non_commercial_net - prev.non_commercial_net : null;
    let bias: CotSnapshotRow["bias"] = "neutral";
    if (pct != null) {
      if (pct >= 90) bias = "spec-extreme-long";
      else if (pct <= 10) bias = "spec-extreme-short";
      else if (pct >= 70) bias = "tilting-long";
      else if (pct <= 30) bias = "tilting-short";
    }
    out.push({
      market,
      reportDate: latest.report_date,
      commercialNet: latest.commercial_net,
      nonCommercialNet: latest.non_commercial_net,
      smallSpecsNet: latest.small_specs_net,
      oi: latest.oi,
      nonCommercialPctile: pct,
      weekChangeNonComm: wkChg,
      bias,
    });
  }
  return out;
}

let cotTimer: NodeJS.Timeout | null = null;
export function startCotRefresher(intervalMs = 24 * 60 * 60 * 1000): void {
  if (cotTimer) return;
  refreshAllCot().catch(() => {});
  cotTimer = setInterval(() => { refreshAllCot().catch(() => {}); }, intervalMs);
}
export function stopCotRefresher(): void {
  if (cotTimer) { clearInterval(cotTimer); cotTimer = null; }
}
