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

// Canonical -> EXACT CFTC market_and_exchange_names (verified against the
// live Socrata dataset, Sep 2026). The old LIKE-fragment matching collapsed
// full-size and MICRO contracts onto one key (GC/ES coin-flip), returned
// zero rows for NQ (CFTC name is "NASDAQ MINI"), and left ZN/ZT frozen on
// 2022 rows after CFTC renamed them to "UST 10Y/2Y NOTE".
export const COT_MARKETS: Record<string, string> = {
  ES: "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE",
  NQ: "NASDAQ MINI - CHICAGO MERCANTILE EXCHANGE",
  ZN: "UST 10Y NOTE - CHICAGO BOARD OF TRADE",
  ZT: "UST 2Y NOTE - CHICAGO BOARD OF TRADE",
  GC: "GOLD - COMMODITY EXCHANGE INC.",
  CL: "WTI-PHYSICAL - NEW YORK MERCANTILE EXCHANGE",
  EUR: "EURO FX - CHICAGO MERCANTILE EXCHANGE",
  JPY: "JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE",
  VIX: "VIX FUTURES - CBOE FUTURES EXCHANGE",
};

const ONE_WEEK_MS = 7 * 86_400_000;

function n(s: string | undefined): number | null {
  if (!s) return null;
  const v = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

async function fetchCotForFragment(fragment: string, limit = 12): Promise<SocrataRow[]> {
  // CFTC legacy futures-only commitments via socrata (6dca-aqww).
  // Exact-name equality: LIKE fragments mixed micro/full-size contracts.
  const upper = fragment.replace(/'/g, "''");
  const where = `upper(market_and_exchange_names) = '${upper.toUpperCase()}'`;
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
      // A missing CFTC field is stored as NULL, not 0: a missing leg is not a
      // flat position, and a net built from one missing leg would be wrong.
      const net = (l: number | null, s: number | null) => (l != null && s != null ? l - s : null);
      const oi = n(r.open_interest_all);
      stmt.run(
        market,
        r.report_date_as_yyyy_mm_dd ?? "",
        net(n(r.comm_positions_long_all), n(r.comm_positions_short_all)),
        net(n(r.noncomm_positions_long_all), n(r.noncomm_positions_short_all)),
        net(n(r.nonrept_positions_long_all), n(r.nonrept_positions_short_all)),
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
    // Always refresh (9 tiny Socrata calls per 24h cycle). The old isStale()
    // skip could keep polluted rows forever: a "fresh" MICRO GOLD row made GC
    // look current, so the exact-name fix would never get a chance to
    // overwrite it. Correct rows land via INSERT OR REPLACE on the same keys.
    void isStale;
    try {
      const rows = await fetchCotForFragment(fragment);
      persist(market, rows);
      out[market] = { ok: true, rows: rows.length };
    } catch (e: any) {
      out[market] = { ok: false, rows: 0, error: e?.message ?? String(e) };
      console.warn(`[cot] refresh failed for ${market}: ${e?.message ?? e}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return out;
}

export interface CotSnapshotRow {
  market: string;
  reportDate: string;
  /** Non-price context source (rule 2): labelled, dated, never a price/options/sizing input. */
  source: "CFTC Commitments of Traders";
  /** Calendar days since the report's as-of date (positions are as of Tuesday, released Friday). */
  ageDays: number | null;
  commercialNet: number | null;
  nonCommercialNet: number | null;
  smallSpecsNet: number | null;
  oi: number | null;
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
    ).all(market) as { report_date: string; commercial_net: number | null; non_commercial_net: number | null; small_specs_net: number | null; oi: number | null }[];
    if (!hist.length) continue;
    const latest = hist[0];
    const prev = hist[1];
    const ncSeries = hist.map(r => r.non_commercial_net).filter((v): v is number => v != null && Number.isFinite(v));
    const latestNc = latest.non_commercial_net;
    let pct: number | null = null;
    if (ncSeries.length >= 30 && latestNc != null) {
      const sorted = [...ncSeries].sort((a, b) => a - b);
      const idx = sorted.indexOf(latestNc);
      pct = idx >= 0 ? (idx / (sorted.length - 1)) * 100 : null;
    }
    const prevNc = prev?.non_commercial_net ?? null;
    const wkChg = latestNc != null && prevNc != null ? latestNc - prevNc : null;
    let bias: CotSnapshotRow["bias"] = "neutral";
    if (pct != null) {
      if (pct >= 90) bias = "spec-extreme-long";
      else if (pct <= 10) bias = "spec-extreme-short";
      else if (pct >= 70) bias = "tilting-long";
      else if (pct <= 30) bias = "tilting-short";
    }
    const t = Date.parse(`${String(latest.report_date).slice(0, 10)}T00:00:00Z`);
    out.push({
      market,
      reportDate: latest.report_date,
      source: "CFTC Commitments of Traders",
      ageDays: Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86_400_000)) : null,
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
  refreshAllCot().catch((e) => console.warn(`[cot] boot refresh failed: ${e?.message ?? e}`));
  cotTimer = setInterval(() => {
    refreshAllCot().catch((e) => console.warn(`[cot] refresh failed: ${e?.message ?? e}`));
  }, intervalMs);
}
export function stopCotRefresher(): void {
  if (cotTimer) { clearInterval(cotTimer); cotTimer = null; }
}
