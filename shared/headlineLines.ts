// shared/headlineLines.ts
//
// The one-line answers the tab headlines lead with. Pure: the server passes in
// what it read. Every line states what was read and nothing more; a missing
// or stale input is named, never filled in.

export interface MapLike {
  symbol?: string;
  reason?: string | null;
  spot: number;
  dataState: "ok" | "no_gex" | "stale_session" | "stale" | string;
  chainStale?: boolean;
  band: { atSpot: "long" | "short" | "indeterminate" | string };
  landmarks: { wallAbove: number | null; magnetBelow: number | null; flip: number | null; pin?: number | null };
}

const lvl = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * "SPX 6,834 · wall above 6,850 · flip 6,800 · magnet below 6,810 · long gamma at spot".
 * Mirrors the Today card: a missing wall or magnet falls back to the pin (labelled
 * as the pin), and each level still missing is named, never silently dropped.
 */
export function levelsLine(m: MapLike | null | undefined, label = "SPX"): string | null {
  if (!m || typeof m.spot !== "number" || !Number.isFinite(m.spot) || m.spot <= 0) return null;
  const parts = [`${label} ${lvl(m.spot)}`];
  if (m.dataState === "no_gex") {
    parts.push(`dealer levels not formed${m.reason ? ` (${m.reason})` : ""}`);
  } else {
    const L = m.landmarks ?? ({} as MapLike["landmarks"]);
    const pin = L.pin ?? null;
    if (L.wallAbove != null) parts.push(`wall above ${lvl(L.wallAbove)}`);
    else if (pin != null && pin > m.spot) parts.push(`pin above ${lvl(pin)}`);
    else parts.push("no wall above in band");
    parts.push(L.flip != null ? `flip ${lvl(L.flip)}` : "no flip in band");
    if (L.magnetBelow != null) parts.push(`magnet below ${lvl(L.magnetBelow)}`);
    else if (pin != null && pin < m.spot) parts.push(`pin below ${lvl(pin)}`);
    else parts.push("no magnet below in band");
    const g = m.band?.atSpot;
    parts.push(g === "long" ? "long gamma at spot" : g === "short" ? "short gamma at spot" : "gamma sign not determined");
  }
  if (m.dataState === "stale_session") parts.push("session closed, last map of the day");
  else if (m.chainStale || m.dataState === "stale") parts.push("chain stale");
  return parts.join(" · ");
}

export type ScanState = "fresh" | "stale" | "not_running" | "unknown";

/** The whale scanner's state from its snapshot: running and evaluated within maxAgeMs counts as fresh. */
export function scanState(snap: { running?: boolean; lastEvalAt?: number | null } | null | undefined, now: number, maxAgeMs = 3 * 60_000): ScanState {
  if (!snap) return "unknown";
  if (!snap.running) return "not_running";
  if (typeof snap.lastEvalAt !== "number" || now - snap.lastEvalAt > maxAgeMs) return "stale";
  return "fresh";
}

/**
 * "3 whales this hour, calls leading 2-1" over every scanned symbol. A count of
 * zero is only stated when the scan is fresh; otherwise the line says the scan
 * is not running or stale, so a stopped scanner never reads as a quiet tape.
 */
export function whaleLine(alerts: Array<{ type?: string; detectedAt?: number }>, now: number, scan: ScanState): string {
  const cutoff = now - 60 * 60_000;
  const recent = alerts.filter((w) => typeof w?.detectedAt === "number" && w.detectedAt >= cutoff);
  const calls = recent.filter((w) => w.type === "C").length;
  const puts = recent.filter((w) => w.type === "P").length;
  const tail = scan === "fresh" ? "" : scan === "stale" ? " (whale scan stale)" : scan === "not_running" ? " (whale scan not running)" : " (whale scan state unknown)";
  if (recent.length === 0) {
    if (scan === "not_running") return "Whale scan not running: no flow read this hour";
    if (scan === "stale") return "Whale scan stale: no fresh flow read this hour";
    if (scan === "unknown") return "Whale scan state unknown: no flow read this hour";
    return "No whale flow this hour";
  }
  const n = `${recent.length} whale${recent.length === 1 ? "" : "s"} this hour`;
  if (calls > puts * 1.5) return `${n}, calls leading ${calls}-${puts}${tail}`;
  if (puts > calls * 1.5) return `${n}, puts leading ${puts}-${calls}${tail}`;
  return `${n}, mixed (${calls} calls / ${puts} puts)${tail}`;
}
