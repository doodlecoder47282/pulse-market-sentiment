// The one source for ceiling, floor and turning point (docs/OPERATING_FRAMEWORK.md section 7).
//
// The top card on Signals reads the option map for one expiry: "Today" (the nearest expiry) and "This week"
// (the week's last expiry). Seen live 2026-11-25: Outlook's turning point (from this map) read 7,092 while
// Models, working the same levels out its own way across several expiries, read 7,176. A reader cannot use
// two turning points. Models now takes these three levels from the same map, composed and held exactly as
// /api/odte/map serves them, and says so on screen.

import { buildOdteForward } from "./odteForward";
import { holdWhileUnchanged } from "./odteMapHold";
import { composeOdteMap } from "../shared/odteMap";
import { editionFromEnv } from "../shared/edition";

export type SharedView = "today" | "week";

export interface SharedLevels {
  view: SharedView;
  /** The expiry the levels are read from. */
  expiry: string | null;
  ceiling: number | null;
  floor: number | null;
  turningPoint: number | null;
  /** Which side of the turning point the price is on, from the same map. */
  atSpot: "long" | "short" | "indeterminate";
  /** When the option data behind the map was read (epoch ms). */
  readAtMs: number | null;
}

export interface SharedLevelsDeps {
  forward?: (symbol: string, nowMs: number, pick: "nearest" | "week") => Promise<{ status: number; body: any }>;
}

/** Null when the map cannot be read or has no dealer-gamma levels: the caller then keeps its own and says so. */
export async function sharedLevels(symbol: string, view: SharedView, nowMs: number = Date.now(), deps: SharedLevelsDeps = {}): Promise<SharedLevels | null> {
  const pick = view === "week" ? "week" : "nearest";
  const forward = deps.forward ?? ((s, n, p) => buildOdteForward(s, n, undefined, p));
  let fwd: { status: number; body: any };
  try { fwd = await forward(symbol, nowMs, pick); } catch { return null; }
  if (fwd.status !== 200 || !fwd.body) return null;
  const map = composeOdteMap(fwd.body, { edition: editionFromEnv() });
  // The same slot names as the route, so a held map is the one the top card is showing.
  const held = holdWhileUnchanged(`${symbol}|${pick}`, fwd.body, map, nowMs).body;
  if (held.dataState === "no_gex") return null;
  const lm = held.landmarks;
  return { view, expiry: held.expiry ?? null, ceiling: lm.wallAbove ?? null, floor: lm.magnetBelow ?? null, turningPoint: lm.flip ?? null, atSpot: held.band?.atSpot ?? "indeterminate", readAtMs: held.chainAsOfMs ?? (Date.parse(held.asOf) || null) };
}

/** Which of the three a model took from the shared map, for the line under the Models header. */
export interface LevelSource {
  view: SharedView;
  expiry: string | null;
  shared: Array<"ceiling" | "floor" | "turning point">;
  /** Levels the shared map does not read right now, where the model's own value is kept. */
  own: Array<"ceiling" | "floor" | "turning point">;
  readAtMs: number | null;
}

export function levelSourceOf(s: SharedLevels): LevelSource {
  const shared: LevelSource["shared"] = [], own: LevelSource["own"] = [];
  (s.ceiling != null ? shared : own).push("ceiling");
  (s.floor != null ? shared : own).push("floor");
  (s.turningPoint != null ? shared : own).push("turning point");
  return { view: s.view, expiry: s.expiry, shared, own, readAtMs: s.readAtMs };
}

/**
 * The strike a wall sits on: the shared level when there is one, else the model's own pick. The bucket
 * returned carries the exposures at that strike (the nearest bucket's when the exact strike is not in the band).
 */
export function wallBucket<T extends { strike: number }>(band: T[], own: T | undefined, sharedStrike: number | null | undefined): T | undefined {
  if (sharedStrike == null || !Number.isFinite(sharedStrike)) return own;
  if (!band.length) return own;
  const exact = band.find((b) => b.strike === sharedStrike);
  if (exact) return exact;
  const nearest = band.reduce((a, b) => (Math.abs(b.strike - sharedStrike) < Math.abs(a.strike - sharedStrike) ? b : a));
  return { ...nearest, strike: sharedStrike };
}
