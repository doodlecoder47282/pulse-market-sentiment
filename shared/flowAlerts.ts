/**
 * flowAlerts.ts: pure helpers for the client-side Flow Alerts panel.
 *
 * Alert ids are deterministic (type, symbol, strike, side), so the same
 * condition is the same alert on every poll: WALL (open interest is fixed all
 * day), HEAVY STRIKE (cumulative day volume) and UNUSUAL_VOL used to get a
 * random id each 30-second poll and were re-added as "new" events, filling
 * the list with copies of three facts and inflating the high-severity count.
 */
export type FlowAlertType = "UNUSUAL_VOL" | "BLOCK" | "MAGNET" | "PC_SHIFT" | "WALL";
export type AlertSeverity = "low" | "med" | "high";

export interface FlowAlert {
  id: string;
  ts: number;
  type: FlowAlertType;
  symbol: string;
  strike?: number;
  expiry?: string;
  side?: "C" | "P";
  message: string;
  severity: AlertSeverity;
}

export function alertKey(type: string, symbol: string, strike: number | undefined, side: string | undefined): string {
  return `${type}:${symbol}:${strike ?? "x"}:${side ?? "x"}`;
}

/** Merge a poll's alerts into the list: a known key is updated in place
 *  (message, severity; ts kept from its first appearance unless the severity
 *  rose), a new key is prepended. */
export function mergeAlerts(prev: FlowAlert[], incoming: FlowAlert[], cap = 30): FlowAlert[] {
  const rank = { low: 0, med: 1, high: 2 } as const;
  const byId = new Map(prev.map((a) => [a.id, a] as const));
  const fresh: FlowAlert[] = [];
  for (const a of incoming) {
    const old = byId.get(a.id);
    if (!old) { fresh.push(a); continue; }
    byId.set(a.id, { ...old, message: a.message, severity: a.severity, ts: rank[a.severity] > rank[old.severity] ? a.ts : old.ts });
  }
  return [...fresh, ...prev.map((a) => byId.get(a.id) ?? a)].slice(0, cap);
}

/**
 * Which of a poll's alerts to show given what the user dismissed (id -> severity at dismissal).
 * A dismissed standing condition (WALL, HEAVY STRIKE, UNUSUAL_VOL, BLOCK: fixed or cumulative all day) stays
 * hidden, because its id is the same on every poll; it returns only if its severity has risen since.
 * A PC_SHIFT is an event between two polls with one id per symbol, so a dismissal never hides a later one.
 */
export function afterDismissal(incoming: FlowAlert[], dismissed: Map<string, AlertSeverity>): FlowAlert[] {
  const rank = { low: 0, med: 1, high: 2 } as const;
  return incoming.filter((a) => {
    if (a.type === "PC_SHIFT") return true;
    const was = dismissed.get(a.id);
    if (was == null) return true;
    if (rank[a.severity] > rank[was]) { dismissed.delete(a.id); return true; }
    return false;
  });
}
