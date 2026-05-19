// server/tickerCalendar.ts
//
// Per-ticker catalyst calendar. Crosses earnings calendar + econ-week macro
// events with the active ticker so the Outlook card can headline upcoming
// catalysts (next earnings, macro, OPEX) instead of dumping the firehose.
//
// Output is intentionally trimmed: the SINGLE next earnings event (with days-
// out, EPS estimate, timing, IV expected move if available) + up to 3 closest
// macro events in the next 30 days.

import { getEarnings, type EarningsRow } from "./earnings";

export type TickerCatalystEarnings = {
  date: string;             // YYYY-MM-DD
  daysOut: number;
  timing: string;           // "BMO" / "AMC" / "DMH" / "UNK"
  timingLabel: string;      // "Before Open" / "After Close" / ...
  fiscalQuarter: string;
  epsForecast: number | null;
  lastYearEps: number | null;
  numEstimates: number | null;
  importance: "HIGH" | "MED" | "LOW";
  isMag7: boolean;
};

export type MacroCatalyst = {
  date: string;             // YYYY-MM-DD
  daysOut: number;
  label: string;            // "CPI", "FOMC", "NFP", etc.
  importance: "HIGH" | "MED" | "LOW";
  category: "macro" | "fed" | "opex" | "earnings_macro";
};

export type TickerCalendarResp = {
  ticker: string;
  asOf: string;
  nextEarnings: TickerCatalystEarnings | null;
  macro: MacroCatalyst[];   // closest 3 in next 30d
  warnings: string[];
};

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + "T00:00:00Z").getTime();
  const b = new Date(toIso + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Hard-coded macro calendar — known FOMC / CPI / NFP / OPEX prints for 2026.
// Pull-from-FRED is a future improvement; for now this gives the Outlook card
// real anchors so users see "FOMC in 3 days" instead of nothing.
const MACRO_2026: MacroCatalyst[] = [
  { date: "2026-05-21", daysOut: 0, label: "FOMC Minutes (Apr)",          importance: "MED",  category: "fed" },
  { date: "2026-06-03", daysOut: 0, label: "ISM Services (May)",          importance: "MED",  category: "macro" },
  { date: "2026-06-06", daysOut: 0, label: "NFP (May)",                   importance: "HIGH", category: "macro" },
  { date: "2026-06-11", daysOut: 0, label: "CPI (May)",                   importance: "HIGH", category: "macro" },
  { date: "2026-06-17", daysOut: 0, label: "FOMC Decision (June)",        importance: "HIGH", category: "fed" },
  { date: "2026-06-20", daysOut: 0, label: "Quad OPEX (Jun)",             importance: "HIGH", category: "opex" },
  { date: "2026-06-27", daysOut: 0, label: "Core PCE (May)",              importance: "HIGH", category: "macro" },
  { date: "2026-07-03", daysOut: 0, label: "NFP (Jun)",                   importance: "HIGH", category: "macro" },
  { date: "2026-07-15", daysOut: 0, label: "CPI (Jun)",                   importance: "HIGH", category: "macro" },
  { date: "2026-07-29", daysOut: 0, label: "FOMC Decision (Jul)",         importance: "HIGH", category: "fed" },
];

export async function buildTickerCalendar(ticker: string): Promise<TickerCalendarResp> {
  const t = ticker.trim().toUpperCase();
  const today = todayIsoUtc();
  const warnings: string[] = [];

  // ── Earnings: pull monthly window, find next entry for this ticker ─────
  // HARD TIMEOUT 8s — Nasdaq API can hang. Better to return null than wedge.
  let nextEarnings: TickerCatalystEarnings | null = null;
  try {
    const cal = await Promise.race([
      getEarnings("monthly"),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("earnings timeout 8s")), 8000),
      ),
    ]) as Awaited<ReturnType<typeof getEarnings>>;
    const allRows: EarningsRow[] = [];
    for (const wk of cal.weeks || []) {
      for (const day of wk.days || []) {
        for (const row of day.rows || []) {
          allRows.push(row);
        }
      }
    }
    const matches = allRows
      .filter((r) => r.ticker === t && r.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (matches.length > 0) {
      const e = matches[0];
      nextEarnings = {
        date: e.date,
        daysOut: daysBetween(today, e.date),
        timing: e.timing,
        timingLabel: e.timingLabel,
        fiscalQuarter: e.fiscalQuarter,
        epsForecast: e.epsForecast,
        lastYearEps: e.lastYearEps,
        numEstimates: e.numEstimates,
        importance: e.importance,
        isMag7: e.isMag7,
      };
    }
  } catch (e: any) {
    warnings.push(`earnings lookup failed: ${e?.message ?? "unknown"}`);
  }

  // ── Macro: closest 3 in next 30d ────────────────────────────────────────
  const todayMs = new Date(today + "T00:00:00Z").getTime();
  const cap = todayMs + 30 * 86400000;
  const macro = MACRO_2026.filter((m) => {
    const ms = new Date(m.date + "T00:00:00Z").getTime();
    return ms >= todayMs && ms <= cap;
  })
    .map((m) => ({ ...m, daysOut: daysBetween(today, m.date) }))
    .sort((a, b) => a.daysOut - b.daysOut)
    .slice(0, 3);

  return {
    ticker: t,
    asOf: new Date().toISOString(),
    nextEarnings,
    macro,
    warnings,
  };
}
