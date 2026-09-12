/**
 * widgetLayouts.ts — server-side persistence for the customizable widget stacks.
 * localStorage is blocked in the hosted iframe, so layout lives in SQLite.
 */
import { sqlite } from "./storage";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS widget_layouts (
    tab TEXT PRIMARY KEY,
    order_json TEXT NOT NULL,
    hidden_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export type WidgetLayout = { order: string[]; hidden: string[] };

export function getWidgetLayout(tab: string): WidgetLayout | null {
  const row = sqlite
    .prepare("SELECT order_json, hidden_json FROM widget_layouts WHERE tab = ?")
    .get(tab) as { order_json: string; hidden_json: string } | undefined;
  if (!row) return null;
  try {
    return { order: JSON.parse(row.order_json), hidden: JSON.parse(row.hidden_json) };
  } catch {
    return null;
  }
}

export function saveWidgetLayout(tab: string, layout: WidgetLayout): void {
  sqlite
    .prepare(
      `INSERT INTO widget_layouts (tab, order_json, hidden_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tab) DO UPDATE SET
         order_json = excluded.order_json,
         hidden_json = excluded.hidden_json,
         updated_at = excluded.updated_at`,
    )
    .run(tab, JSON.stringify(layout.order), JSON.stringify(layout.hidden), Date.now());
}

export function resetWidgetLayout(tab: string): void {
  sqlite.prepare("DELETE FROM widget_layouts WHERE tab = ?").run(tab);
}
