// earnings.ts
// Earnings calendar — weekly + monthly upcoming reports, Earnings Whispers style.
// Source: Nasdaq public API (api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD).
// Free, no key required. Cached ~30 minutes to be kind.
//
// Fields captured per report: ticker, company, market cap (USD), fiscal quarter,
// EPS consensus forecast, last-year EPS, # estimates, timing (BMO / AMC / DMH),
// and last year's report date. Grouped by week and bucketed by day.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type EarningsTiming = "BMO" | "AMC" | "DMH" | "UNK";

export interface EarningsRow {
  date: string;            // YYYY-MM-DD (ET trading day)
  ticker: string;
  company: string;
  marketCap: number | null; // USD
  marketCapBucket: "MEGA" | "LARGE" | "MID" | "SMALL" | null;
  fiscalQuarter: string;   // e.g. "Mar/2026"
  epsForecast: number | null;
  lastYearEps: number | null;
  numEstimates: number | null;
  timing: EarningsTiming;
  timingLabel: string;     // "Before Open" | "After Close" | "During Hours" | "—"
  lastYearReportDate: string | null; // ISO YYYY-MM-DD
  // Importance: derived from market cap + S&P / MAG7 membership.
  importance: "HIGH" | "MED" | "LOW";
  isMag7: boolean;
}

export interface EarningsDay {
  date: string;      // YYYY-MM-DD
  label: string;     // "Mon, Apr 27"
  count: number;
  highImpact: number;
  rows: EarningsRow[];
}

export interface EarningsWeek {
  weekStart: string; // YYYY-MM-DD (Monday)
  label: string;     // "Week of Mon, Apr 27"
  count: number;
  highImpact: number;
  megaCapCount: number;
  days: EarningsDay[];
}

export interface EarningsResponse {
  asOf: number;              // unix seconds
  range: { from: string; to: string }; // inclusive (YYYY-MM-DD, ET)
  totalReports: number;
  highImpactCount: number;
  megaCapCount: number;
  mag7Reports: EarningsRow[]; // highlight reel — any MAG7 in window
  weeks: EarningsWeek[];      // rolled up by ISO Monday
  warnings: string[];
}

const MAG7 = new Set(["AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "META", "AMZN", "TSLA"]);

// Parse USD strings from Nasdaq: "$1,234,567,890" → number, "" → null
function parseMarketCap(raw: any): number | null {
  if (!raw) return null;
  const s = String(raw).replace(/[$,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Parse EPS strings from Nasdaq: "$1.22" or "($0.24)" (negative) or "N/A"
function parseEps(raw: any): number | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || /n\/a|--/i.test(s)) return null;
  const neg = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[$,()\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function bucketCap(cap: number | null): EarningsRow["marketCapBucket"] {
  if (cap == null) return null;
  if (cap >= 200_000_000_000) return "MEGA";
  if (cap >= 10_000_000_000) return "LARGE";
  if (cap >= 2_000_000_000) return "MID";
  return "SMALL";
}

function parseTiming(raw: any): { t: EarningsTiming; label: string } {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("pre-market") || s.includes("pre market") || s.includes("bmo") || s.includes("before")) {
    return { t: "BMO", label: "Before Open" };
  }
  if (s.includes("after-hours") || s.includes("after hours") || s.includes("amc") || s.includes("after")) {
    return { t: "AMC", label: "After Close" };
  }
  if (s.includes("during")) {
    return { t: "DMH", label: "During Hours" };
  }
  return { t: "UNK", label: "—" };
}

// "4/22/2025" → "2025-04-22"
function parseUsDate(raw: any): string | null {
  if (!raw) return null;
  const m = String(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function rankImportance(cap: number | null, ticker: string): "HIGH" | "MED" | "LOW" {
  if (MAG7.has(ticker)) return "HIGH";
  if (cap != null && cap >= 50_000_000_000) return "HIGH";
  if (cap != null && cap >= 10_000_000_000) return "MED";
  return "LOW";
}

async function fetchNasdaqEarnings(date: string): Promise<EarningsRow[]> {
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${date}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: "https://www.nasdaq.com/",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Nasdaq earnings ${date}: HTTP ${r.status}`);
  const j: any = await r.json();
  const rows: any[] = j?.data?.rows ?? [];
  const out: EarningsRow[] = [];
  for (const row of rows) {
    const ticker = String(row.symbol ?? "").trim().toUpperCase();
    if (!ticker) continue;
    const cap = parseMarketCap(row.marketCap);
    const { t: timing, label: timingLabel } = parseTiming(row.time);
    const isMag7 = MAG7.has(ticker);
    out.push({
      date,
      ticker,
      company: String(row.name ?? ticker),
      marketCap: cap,
      marketCapBucket: bucketCap(cap),
      fiscalQuarter: String(row.fiscalQuarterEnding ?? ""),
      epsForecast: parseEps(row.epsForecast),
      lastYearEps: parseEps(row.lastYearEPS),
      numEstimates: row.noOfEsts ? Number(row.noOfEsts) || null : null,
      timing,
      timingLabel,
      lastYearReportDate: parseUsDate(row.lastYearRptDt),
      importance: rankImportance(cap, ticker),
      isMag7,
    });
  }
  return out;
}

// Map YYYY-MM-DD → ISO Monday YYYY-MM-DD
function isoMonday(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const offset = dow === 0 ? -6 : 1 - dow; // Mon = 1
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function formatLabel(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  return `${wd}, ${mo} ${d.getUTCDate()}`;
}

function addDaysIso(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────────────────────
// Cache — 30 minutes
// ──────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: EarningsResponse;
  at: number;
}
const CACHE_MS = 30 * 60 * 1000;
let weeklyCache: CacheEntry | null = null;
let monthlyCache: CacheEntry | null = null;

export async function getEarnings(horizon: "weekly" | "monthly" = "weekly"): Promise<EarningsResponse> {
  const cache = horizon === "weekly" ? weeklyCache : monthlyCache;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const days = horizon === "weekly" ? 7 : 30;

  const dates: string[] = [];
  for (let i = 0; i < days; i++) dates.push(addDaysIso(todayIso, i));

  const warnings: string[] = [];
  const dayResults = await Promise.allSettled(dates.map((d) => fetchNasdaqEarnings(d)));

  const allRows: EarningsRow[] = [];
  for (let i = 0; i < dayResults.length; i++) {
    const r = dayResults[i];
    if (r.status === "fulfilled") {
      allRows.push(...r.value);
    } else {
      warnings.push(`${dates[i]}: ${(r.reason as Error)?.message ?? "failed"}`);
    }
  }

  // Deduplicate by ticker+date (sometimes Nasdaq repeats)
  const seen = new Set<string>();
  const deduped: EarningsRow[] = [];
  for (const row of allRows) {
    const key = `${row.date}::${row.ticker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  // Sort: by date asc, then importance, then market cap desc
  deduped.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const impOrder = { HIGH: 0, MED: 1, LOW: 2 } as const;
    const ai = impOrder[a.importance];
    const bi = impOrder[b.importance];
    if (ai !== bi) return ai - bi;
    return (b.marketCap ?? 0) - (a.marketCap ?? 0);
  });

  // Group by date → day → week
  const byDate = new Map<string, EarningsRow[]>();
  for (const r of deduped) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push(r);
  }

  const weekMap = new Map<string, EarningsDay[]>();
  for (const [date, rows] of byDate.entries()) {
    const wk = isoMonday(date);
    if (!weekMap.has(wk)) weekMap.set(wk, []);
    weekMap.get(wk)!.push({
      date,
      label: formatLabel(date),
      count: rows.length,
      highImpact: rows.filter((r) => r.importance === "HIGH").length,
      rows,
    });
  }

  const weeks: EarningsWeek[] = Array.from(weekMap.entries())
    .map(([weekStart, days]) => {
      days.sort((a, b) => (a.date < b.date ? -1 : 1));
      const count = days.reduce((a, d) => a + d.count, 0);
      const highImpact = days.reduce((a, d) => a + d.highImpact, 0);
      const megaCapCount = days.reduce(
        (a, d) => a + d.rows.filter((r) => r.marketCapBucket === "MEGA").length,
        0,
      );
      return {
        weekStart,
        label: `Week of ${formatLabel(weekStart)}`,
        count,
        highImpact,
        megaCapCount,
        days,
      };
    })
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));

  const mag7Reports = deduped.filter((r) => r.isMag7);
  const highImpactCount = deduped.filter((r) => r.importance === "HIGH").length;
  const megaCapCount = deduped.filter((r) => r.marketCapBucket === "MEGA").length;

  const out: EarningsResponse = {
    asOf: Math.floor(Date.now() / 1000),
    range: { from: todayIso, to: addDaysIso(todayIso, days - 1) },
    totalReports: deduped.length,
    highImpactCount,
    megaCapCount,
    mag7Reports,
    weeks,
    warnings,
  };

  const entry = { value: out, at: Date.now() };
  if (horizon === "weekly") weeklyCache = entry;
  else monthlyCache = entry;

  return out;
}
