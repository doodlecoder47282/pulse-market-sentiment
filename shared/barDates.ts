// Wording for the date daily-bar figures are as of. Shared by the server (briefing text) and the screens.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-23" -> "Nov 23". Anything else is returned unchanged. */
export function shortDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "");
  const mon = MONTHS[Number(m[2]) - 1];
  return mon ? `${mon} ${Number(m[3])}` : String(iso);
}

export interface DatedRow { symbol: string; barDate?: string | null; stale?: boolean }

/**
 * One line saying which close a table of daily figures is as of, and which rows are older.
 * `expected` is the last completed session.
 */
export function closesThroughLine(expected: string | null | undefined, rows: DatedRow[]): string {
  if (!expected) return "";
  const old = rows.filter((r) => r.stale && r.barDate);
  const none = rows.filter((r) => !r.barDate);
  const parts = [`Closes through ${shortDate(expected)}, the last completed session.`];
  if (old.length) parts.push(`Older: ${old.map((r) => `${r.symbol} stops at ${shortDate(r.barDate)}`).join(", ")}.`);
  if (none.length) parts.push(`No bars: ${none.map((r) => r.symbol).join(", ")}.`);
  return parts.join(" ");
}
