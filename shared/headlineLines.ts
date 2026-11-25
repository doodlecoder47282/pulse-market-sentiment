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
    // The same names the Today card uses (shared/todayPlan.ts TODAY_LABELS).
    const up = L.wallAbove ?? (pin != null && pin > m.spot ? pin : null);
    const down = L.magnetBelow ?? (pin != null && pin < m.spot ? pin : null);
    parts.push(up != null ? `ceiling ${lvl(up)}` : "no ceiling within 2%");
    parts.push(L.flip != null ? `turning point ${lvl(L.flip)}` : "no turning point in range");
    parts.push(down != null ? `floor ${lvl(down)}` : "no floor within 2%");
    const g = m.band?.atSpot;
    parts.push(g === "long" ? "calmer side (smaller swings in the model)" : g === "short" ? "bigger-swing side (in the model)" : "side not read");
  }
  if (m.dataState === "stale_session") parts.push("session closed, last map of the day");
  else if (m.chainStale || m.dataState === "stale") parts.push("chain stale");
  return parts.join(" · ");
}

// The whale count line moved to shared/scanCoverage.ts (whaleCoverageLine), which
// reads what the scanner actually covered, not only when it last ran.
