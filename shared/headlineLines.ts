// shared/headlineLines.ts
//
// The one-line answers the tab headlines lead with. Pure: the server passes in
// what it read. Every line states what was read and nothing more; a missing
// or stale input is named, never filled in.

export interface MapLike {
  symbol?: string;
  spot: number;
  dataState: "ok" | "no_gex" | "stale_session" | "stale" | string;
  chainStale?: boolean;
  band: { atSpot: "long" | "short" | "indeterminate" | string };
  landmarks: { wallAbove: number | null; magnetBelow: number | null; flip: number | null; pin?: number | null };
}

const lvl = (n: number) => Math.round(n).toLocaleString("en-US");

/** "SPX 6,834 · wall above 6,850 · flip 6,800 · magnet below 6,810 · long gamma at spot" */
export function levelsLine(m: MapLike | null | undefined, label = "SPX"): string | null {
  if (!m || typeof m.spot !== "number" || !Number.isFinite(m.spot) || m.spot <= 0) return null;
  const parts = [`${label} ${lvl(m.spot)}`];
  if (m.dataState === "no_gex") {
    parts.push("dealer levels not formed (no gamma in the chain)");
  } else {
    const L = m.landmarks ?? ({} as MapLike["landmarks"]);
    if (L.wallAbove != null) parts.push(`wall above ${lvl(L.wallAbove)}`);
    if (L.flip != null) parts.push(`flip ${lvl(L.flip)}`);
    if (L.magnetBelow != null) parts.push(`magnet below ${lvl(L.magnetBelow)}`);
    if (L.wallAbove == null && L.flip == null && L.magnetBelow == null) parts.push("no dealer level inside the band");
    const g = m.band?.atSpot;
    parts.push(g === "long" ? "long gamma at spot" : g === "short" ? "short gamma at spot" : "gamma sign not determined");
  }
  if (m.chainStale || m.dataState === "stale" || m.dataState === "stale_session") parts.push("chain stale");
  return parts.join(" · ");
}

/** "3 whales this hour, calls leading 2-1" from whale alerts with type and detectedAt. */
export function whaleLine(alerts: Array<{ type?: string; detectedAt?: number }>, now: number): string {
  const cutoff = now - 60 * 60_000;
  const recent = alerts.filter((w) => typeof w?.detectedAt === "number" && w.detectedAt >= cutoff);
  const calls = recent.filter((w) => w.type === "C").length;
  const puts = recent.filter((w) => w.type === "P").length;
  if (recent.length === 0) return "No whale flow this hour";
  const n = `${recent.length} whale${recent.length === 1 ? "" : "s"} this hour`;
  if (calls > puts * 1.5) return `${n}, calls leading ${calls}-${puts}`;
  if (puts > calls * 1.5) return `${n}, puts leading ${puts}-${calls}`;
  return `${n}, mixed (${calls} calls / ${puts} puts)`;
}
