// shared/levelConfluence.ts
//
// Checks a reader's own chart levels against the day's 0DTE map: does a
// level sit on a strike the chain has size at, on a landmark the map named,
// or on nothing at all? Descriptive bookkeeping about open interest, not a
// forecast and not a verdict on the level. Pure: the client feeds it the map
// it already holds (shared/odteMap.ts) and the levels the reader typed.
//
// Tags
//   landmark    within tolerance of a named landmark (pin, wall, magnet,
//               pocket, flip): the map already treats this price as special.
//   chain       within tolerance of a mapped strike carrying at least
//               `strongShare` of the map's gross exposure.
//   weak        within tolerance of a mapped strike under that share.
//   chart_only  no mapped strike within tolerance (strikes outside the map's
//               band or under its share floor are not on the map, so "chart
//               only" means "nothing the map shows", not "no OI exists").
//   unavailable the map has no spot or no strikes: nothing to check against.

export interface ConfluenceMapLike {
  spot: number | null | undefined;
  strikes: Array<{ strike: number; share: number; gexPct: number; label: string | null }>;
  landmarks?: Partial<Record<"pin" | "wallAbove" | "magnetBelow" | "pocketAbove" | "pocketBelow" | "flip", number | null>>;
  range?: { low?: number | null; high?: number | null } | null;
}

export type ConfluenceTag = "landmark" | "chain" | "weak" | "chart_only" | "unavailable";

export interface LevelCheck {
  level: number;
  tag: ConfluenceTag;
  /** Nearest mapped strike inside the tolerance, or null. */
  strike: number | null;
  /** Signed points from the level to that strike (strike - level). */
  distancePts: number | null;
  /** Share of the map's gross exposure at that strike, 0-1. */
  share: number | null;
  /** Dealer-signed $ per 1% at that strike. */
  gexPct: number | null;
  /** Landmark names within tolerance ("pin", "flip", ...), nearest first. */
  landmarks: string[];
  side: "above" | "below" | "at" | "unknown";
  /** Inside the straddle range when the map has one. */
  insideStraddle: boolean | null;
  note: string;
}

export interface ConfluenceOptions {
  /** Tolerance in points; default 0.1% of spot, at least 2 points. */
  tolerancePts?: number;
  /** Share of gross exposure that makes a strike "chain" rather than "weak" (default 0.03). */
  strongShare?: number;
}

const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const LANDMARK_NAMES: Record<string, string> = {
  pin: "pin", wallAbove: "wall above", magnetBelow: "magnet below", pocketAbove: "pocket above", pocketBelow: "pocket below", flip: "gamma flip",
};

export function defaultTolerancePts(spot: number): number {
  return Math.max(2, Math.round(spot * 0.001 * 10) / 10);
}

export function checkLevel(map: ConfluenceMapLike, level: number, opts: ConfluenceOptions = {}): LevelCheck {
  const spot = fin(map.spot);
  const base: LevelCheck = { level, tag: "unavailable", strike: null, distancePts: null, share: null, gexPct: null, landmarks: [], side: "unknown", insideStraddle: null, note: "" };
  if (!Number.isFinite(level) || spot == null || !(spot > 0) || !Array.isArray(map.strikes) || map.strikes.length === 0) {
    return { ...base, note: "no map to check against" };
  }
  const tol = opts.tolerancePts ?? defaultTolerancePts(spot);
  const strong = opts.strongShare ?? 0.03;
  const side: LevelCheck["side"] = Math.abs(level - spot) <= tol / 2 ? "at" : level > spot ? "above" : "below";
  const lo = fin(map.range?.low), hi = fin(map.range?.high);
  const insideStraddle = lo != null && hi != null ? level >= lo && level <= hi : null;

  const near = map.strikes
    .filter((s) => Number.isFinite(s.strike) && Math.abs(s.strike - level) <= tol)
    .sort((a, b) => Math.abs(a.strike - level) - Math.abs(b.strike - level));
  const landmarks = Object.entries(map.landmarks ?? {})
    .filter(([, v]) => fin(v) != null && Math.abs((v as number) - level) <= tol)
    .sort((a, b) => Math.abs((a[1] as number) - level) - Math.abs((b[1] as number) - level))
    .map(([k]) => LANDMARK_NAMES[k] ?? k);

  const best = near[0] ?? null;
  const strike = best?.strike ?? null;
  const distancePts = best ? Math.round((best.strike - level) * 100) / 100 : null;
  const share = best ? fin(best.share) : null;
  const gexPct = best ? fin(best.gexPct) : null;
  const sharePct = share != null ? `${(share * 100).toFixed(1)}% of the map's exposure` : "share unknown";
  const at = best ? (distancePts === 0 ? `on the ${fmt(best.strike)} strike` : `${Math.abs(distancePts!)} pts from ${fmt(best.strike)}`) : "";

  if (landmarks.length) {
    return { ...base, tag: "landmark", strike, distancePts, share, gexPct, landmarks, side, insideStraddle, note: `${landmarks.join(", ")}${best ? ` · ${at}, ${sharePct}` : ""}` };
  }
  if (best && share != null && share >= strong) {
    return { ...base, tag: "chain", strike, distancePts, share, gexPct, landmarks, side, insideStraddle, note: `${at}, ${sharePct}` };
  }
  if (best) {
    return { ...base, tag: "weak", strike, distancePts, share, gexPct, landmarks, side, insideStraddle, note: `${at}, ${sharePct} (under ${(strong * 100).toFixed(0)}%)` };
  }
  return { ...base, tag: "chart_only", side, insideStraddle, note: `no mapped strike within ${tol} pts` };
}

export function checkLevels(map: ConfluenceMapLike, levels: number[], opts: ConfluenceOptions = {}): LevelCheck[] {
  const seen = new Set<number>();
  return levels
    .filter((l) => Number.isFinite(l) && !seen.has(l) && seen.add(l))
    .sort((a, b) => b - a)
    .map((l) => checkLevel(map, l, opts));
}

/** "7686, 7,643 7600" -> [7686, 7643, 7600]: thousands separators folded first, then commas, spaces and semicolons split; junk dropped. */
export function parseLevels(text: string): number[] {
  return String(text ?? "")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .split(/[\s,;]+/)
    .map((t) => Number(t.replace(/[^0-9.\-]/g, "")))
    .filter((n) => Number.isFinite(n) && n >= 10);
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** A level the board computed from price bars, with the name the board gives it. */
export interface NamedLevel { price: number; label: string }
/** How far from the price a board level may sit and still be checked: the 0DTE map carries strikes within about 2%. */
export const BOARD_LEVEL_REACH = 0.02;
export const BOARD_LEVEL_MAX = 12;

/**
 * The board's own bar-based levels for the index (prior day, pivots, week, month, ranges, today's open and
 * opening range), ready to be checked against the chain with no input from the user. Give it the board's
 * list that was merged WITHOUT option landmarks (cases.levelsWithoutOptions): on the full list a merged line
 * takes the group of its highest member, so a group filter both lets "prior-day low + magnet below" through
 * and throws "wall above + prior-day high" away. The group filter here is a second guard only.
 * Levels further than BOARD_LEVEL_REACH from the price are left out (the map has no strikes there, so every
 * one would read "chart only" for a reason that is about the map, not the level); `beyond` counts them.
 * The nearest BOARD_LEVEL_MAX are kept, highest first. Pure.
 */
export function boardChartLevels(levels: Array<{ price: number; label: string; group?: string }> | null | undefined, spot: number | null | undefined): { levels: NamedLevel[]; beyond: number } {
  if (!levels || !(typeof spot === "number" && Number.isFinite(spot) && spot > 0)) return { levels: [], beyond: 0 };
  const seen = new Set<number>();
  const bars = levels.filter((l) => l.group !== "options" && Number.isFinite(l.price) && l.price > 0 && !seen.has(l.price) && seen.add(l.price));
  const near = bars.filter((l) => Math.abs(l.price - spot) / spot <= BOARD_LEVEL_REACH);
  const kept = near.sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot)).slice(0, BOARD_LEVEL_MAX).sort((a, b) => b.price - a.price);
  return { levels: kept.map((l) => ({ price: l.price, label: l.label })), beyond: bars.length - near.length };
}

/** What the card needs from the board payload to say where its automatic levels came from and in what state. */
export interface BoardSourceInput {
  /** The board request failed on its latest attempt (earlier data may still be held). */
  failed: boolean;
  board: {
    forSession?: string; sessionOpen?: boolean;
    cases?: { symbol: string; levelsWithoutOptions?: Array<{ price: number; label: string; group?: string }> } | null;
    tickers?: Array<{ symbol: string; levelsState?: string; levelsReason?: string | null }>;
  } | null | undefined;
  symbol: string;
}
export interface BoardSource {
  /** Levels to check; empty when the board has none that may be used. */
  levels: Array<{ price: number; label: string; group?: string }>;
  /** "ok": levels as the board computed them. "partial"/"stale": usable, with the notice. "unavailable"/"failed"/"reading": nothing to check, and the notice says which. */
  state: "ok" | "partial" | "unavailable" | "failed" | "reading";
  /** Always said when not null, also above a list of rows. */
  notice: string | null;
  forSession: string | null;
}

/**
 * Where the automatic levels come from and what state that source is in. A board that was not read is never
 * reported as a board with no levels, and levels kept from an earlier read are never shown without saying so.
 */
export function boardSource(i: BoardSourceInput): BoardSource {
  const b = i.board;
  if (!b) return { levels: [], state: i.failed ? "failed" : "reading", notice: i.failed ? "The level board could not be read (the request failed), so its levels are not checked." : "Reading the level board.", forSession: null };
  const forSession = b.forSession ?? null;
  const t = b.tickers?.find((x) => x.symbol === i.symbol);
  const list = b.cases && b.cases.symbol === i.symbol ? b.cases.levelsWithoutOptions ?? [] : null;
  const name = i.symbol.replace(/^[$/]/, "");
  if (!t || list == null) return { levels: [], state: "unavailable", notice: `The level board carries no ${name} levels in this read, so none are checked.`, forSession };
  const why = t.levelsReason ? `: ${t.levelsReason}` : "";
  if (t.levelsState === "unavailable" || list.length === 0) return { levels: [], state: "unavailable", notice: `The board's ${name} price levels were not read${why}. This is not a board with no levels.`, forSession };
  const held = i.failed ? "The latest read of the level board failed; these levels are from the read before it. " : "";
  const session = forSession && b.sessionOpen === false ? `These are the board's levels for the ${forSession} session; the option map beside them is the chain's latest. ` : "";
  const part = t.levelsState === "partial" && t.levelsReason ? `The board marks them incomplete: ${t.levelsReason}.` : "";
  const notice = (held + session + part).trim() || null;
  return { levels: list, state: i.failed ? "partial" : t.levelsState === "partial" ? "partial" : "ok", notice, forSession };
}
