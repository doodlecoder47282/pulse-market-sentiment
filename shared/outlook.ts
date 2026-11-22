// shared/outlook.ts
// THE OUTLOOK: one page for "what sits between here and the next few weeks". It computes nothing new about the
// market. It lines up numbers the terminal already has, on one time axis and one price axis: every mapped
// level with its name and its distance from the price, each option expiry with its share of open interest
// and its max-pain strike, the range the option prices imply to each expiry, and the scheduled events.
// Every row carries where it came from. Nothing here is a forecast: the range is what option prices imply
// (risk-neutral), levels are mapped prices, and no line says what the index does next. Pure.

/** One option contract, as far as the outlook needs it. */
export interface OutlookContract { expiry: string; dte: number; tYears: number; side: "call" | "put"; strike: number; oi: number; iv: number }

export interface ExpiryRow {
  expiry: string;
  dte: number;
  /** Open contracts in this expiry, calls + puts. */
  oi: number;
  callOi: number;
  putOi: number;
  /** This expiry's share of the open interest in the chain that was read (0..1); null when the chain's total is zero. */
  oiShare: number | null;
  /**
   * Max pain: the strike at which the options of this expiry would pay their holders the least in total if
   * the index settled there, from open interest alone. A fact about open interest, not a target. Null when
   * the expiry has no open interest.
   */
  maxPain: number | null;
  /** At-the-money implied volatility (0..1), the mean of the call and put nearest the price; null when neither has one. */
  atmIv: number | null;
  /** One standard deviation of the move option prices imply from now to this expiry, in points; null without an IV. */
  sigmaPts: number | null;
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Strike minimising the total intrinsic value paid to holders at settlement; null without open interest. */
export function maxPainStrike(rows: Array<{ side: "call" | "put"; strike: number; oi: number }>): number | null {
  const live = rows.filter((r) => finite(r.strike) && finite(r.oi) && r.oi > 0);
  if (!live.length) return null;
  const strikes = Array.from(new Set(live.map((r) => r.strike))).sort((a, b) => a - b);
  let best: number | null = null, bestPay = Infinity;
  for (const k of strikes) {
    let pay = 0;
    for (const r of live) pay += r.oi * (r.side === "call" ? Math.max(0, k - r.strike) : Math.max(0, r.strike - k));
    // The lowest payout; on an exact tie the lower strike (the scan order), so the answer does not depend on input order.
    if (pay < bestPay) { bestPay = pay; best = k; }
  }
  return best;
}

/** One row per expiry, nearest first. */
export function expirySummary(contracts: OutlookContract[], spot: number): ExpiryRow[] {
  const by = new Map<string, OutlookContract[]>();
  for (const c of contracts) {
    if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(c.expiry)) continue;
    const g = by.get(c.expiry) ?? [];
    g.push(c);
    by.set(c.expiry, g);
  }
  const total = contracts.reduce((s, c) => s + (finite(c.oi) && c.oi > 0 ? c.oi : 0), 0);
  const out: ExpiryRow[] = [];
  for (const [expiry, g] of by) {
    const oiOf = (side: "call" | "put") => g.reduce((s, c) => s + (c.side === side && finite(c.oi) && c.oi > 0 ? c.oi : 0), 0);
    const callOi = oiOf("call"), putOi = oiOf("put");
    const near = (side: "call" | "put") => g.filter((c) => c.side === side && finite(c.iv) && c.iv > 0 && c.iv < 5).sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
    const ac = near("call"), ap = near("put");
    const atmIv = ac && ap ? (ac.iv + ap.iv) / 2 : ac?.iv ?? ap?.iv ?? null;
    const tYears = g.find((c) => finite(c.tYears) && c.tYears > 0)?.tYears ?? null;
    const sigmaPts = atmIv != null && tYears != null && finite(spot) && spot > 0 ? spot * atmIv * Math.sqrt(tYears) : null;
    out.push({
      expiry, dte: g[0].dte, oi: callOi + putOi, callOi, putOi,
      oiShare: total > 0 ? (callOi + putOi) / total : null,
      maxPain: maxPainStrike(g), atmIv, sigmaPts,
    });
  }
  return out.sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
}

/** A mapped level from any tool, with the tool named. */
export interface OutlookLevelIn { price: number; label: string; source: string }
export interface OutlookLevel extends OutlookLevelIn {
  /** Points from the price: positive above it, negative below. */
  distPts: number;
  distPct: number;
  side: "above" | "below" | "at";
}
/** A level this close to the price reads as "at" it (a tenth of a percent, the level board's own line). */
export const OUTLOOK_AT_PCT = 0.001;
/** Levels within this of each other and from the same source are one line. */
const SAME = 0.0001;

/** Every level in one list, highest first, with its distance from the price. Bad prices are dropped; exact repeats from one source are joined. */
export function rankLevels(levels: OutlookLevelIn[], spot: number | null | undefined): OutlookLevel[] {
  if (!finite(spot) || spot <= 0) return [];
  const seen = new Map<string, OutlookLevelIn>();
  for (const l of levels) {
    if (!l || !finite(l.price) || l.price <= 0 || !l.label) continue;
    const key = `${l.source}|${Math.round(l.price / (spot * SAME))}|${l.label}`;
    if (!seen.has(key)) seen.set(key, l);
  }
  return Array.from(seen.values())
    .map((l) => {
      const distPts = l.price - spot;
      const distPct = distPts / spot;
      const side: OutlookLevel["side"] = Math.abs(distPct) <= OUTLOOK_AT_PCT ? "at" : distPts > 0 ? "above" : "below";
      return { ...l, distPts, distPct, side };
    })
    .sort((a, b) => b.price - a.price || (a.label < b.label ? -1 : 1));
}

export interface OutlookEvent { date: string; label: string; type: string }
export interface OutlookWindow {
  /** First and last date of the window, inclusive. */
  from: string;
  to: string;
  title: string;
  events: OutlookEvent[];
  /** Expiries falling in the window, nearest first. */
  expiries: ExpiryRow[];
  /** The expiry in the window holding the most open interest; null when none has any. */
  largest: ExpiryRow | null;
  /** The range option prices imply to the window's last expiry that has one: price minus and plus one standard deviation. */
  range: { expiry: string; lo: number; hi: number; sigmaPts: number } | null;
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 23" from an ISO date. */
export const shortDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/**
 * The stretch from today to the last expiry read, cut into windows: the rest of this calendar week, then
 * whole weeks (Monday to Sunday) for the next two, then calendar-month pieces. Each window lists what is
 * scheduled in it and which of its expiries holds the most open interest.
 */
export function outlookWindows(today: string, expiries: ExpiryRow[], events: OutlookEvent[], spot: number | null | undefined): OutlookWindow[] {
  const live = expiries.filter((e) => e.expiry >= today);
  if (!live.length) return [];
  const end = live[live.length - 1].expiry;
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 Sunday
  const cuts: Array<[string, string]> = [];
  let from = today;
  let to = addDays(today, dow === 0 ? 0 : 7 - dow); // through Sunday
  for (let i = 0; i < 3 && from <= end; i++) { cuts.push([from, to < end ? to : end]); from = addDays(to, 1); to = addDays(from, 6); }
  while (from <= end) {
    const monthEnd = addDays(`${from.slice(0, 7)}-28`, 4).slice(0, 7) + "-01"; // first of the next month
    const last = addDays(monthEnd, -1);
    cuts.push([from, last < end ? last : end]);
    from = addDays(last, 1);
  }
  return cuts.map(([a, b], i) => {
    const ex = live.filter((e) => e.expiry >= a && e.expiry <= b);
    const withOi = ex.filter((e) => e.oi > 0);
    const largest = withOi.length ? withOi.reduce((m, e) => (e.oi > m.oi ? e : m)) : null;
    const ranged = [...ex].reverse().find((e) => e.sigmaPts != null);
    const range = ranged && finite(spot) && spot > 0 ? { expiry: ranged.expiry, lo: spot - ranged.sigmaPts!, hi: spot + ranged.sigmaPts!, sigmaPts: ranged.sigmaPts! } : null;
    return {
      from: a, to: b,
      title: i === 0 ? `Now to ${shortDate(b)}` : `${shortDate(a)} to ${shortDate(b)}`,
      events: events.filter((e) => e.date >= a && e.date <= b).sort((x, y) => (x.date < y.date ? -1 : 1)),
      expiries: ex, largest, range,
    };
  });
}

/** A share as a percentage; a share that exists but rounds to nothing is "under 1%", never "0%". */
export const sharePct = (f: number) => (f > 0 && f < 0.005 ? "under 1%" : `${(f * 100).toFixed(0)}%`);

/** The window's facts as one or two sentences. Counts, dates and prices only. */
/**
 * One window as short labelled lines, each a fact with its number. A line is left out when it has nothing
 * to say; a window with no line is not shown (see windowHasContent).
 */
export function windowLines(w: OutlookWindow): Array<{ label: string; text: string }> {
  const px = (n: number) => Math.round(n).toLocaleString("en-US");
  const out: Array<{ label: string; text: string }> = [];
  if (w.events.length) out.push({ label: "Events", text: w.events.map((e) => `${e.label} ${shortDate(e.date)}`).join(", ") });
  if (w.expiries.length && w.largest && w.largest.oiShare != null) {
    // A share is never said without its count.
    out.push({ label: "Largest expiry", text: `${shortDate(w.largest.expiry)}, ${sharePct(w.largest.oiShare)} of open interest read (${px(w.largest.oi)} contracts)${w.largest.maxPain != null ? `, max pain ${px(w.largest.maxPain)}` : ""}` });
  } else if (w.expiries.length) out.push({ label: "Expiries", text: `${w.expiries.length}, none with open interest in this read` });
  if (w.range) out.push({ label: `Implied range by ${shortDate(w.range.expiry)}`, text: `${px(w.range.lo)} to ${px(w.range.hi)} (±${px(w.range.sigmaPts)})` });
  return out;
}
/** A window with no event and no expiry says nothing and is not drawn. */
export const windowHasContent = (w: OutlookWindow): boolean => w.events.length > 0 || w.expiries.length > 0;
/** Said once under the windows, not in each. */
export const WINDOW_RANGE_NOTE = "Implied range: one standard deviation from option prices. Priced in, not a forecast.";

/** Expiry rows shown before "show all": the nearest one, and every expiry holding at least this share. */
export const EXPIRY_ROW_MIN_SHARE = 0.02;
export function mainExpiryRows<T extends { oiShare: number | null }>(rows: readonly T[]): T[] {
  // With no open interest in the read there is nothing to rank by: every row stays.
  if (!rows.some((r) => r.oiShare != null)) return [...rows];
  return rows.filter((r, i) => i === 0 || (r.oiShare ?? 0) >= EXPIRY_ROW_MIN_SHARE);
}

/** What the chart draws, as fractions of its box (0..1; y measured from the top). */
export interface OutlookChart {
  from: string; to: string;
  lo: number; hi: number;
  /** The implied range at each expiry that has one: x and the y of price plus and minus one standard deviation. */
  cone: Array<{ expiry: string; x: number; yHi: number; yLo: number; sigmaPts: number }>;
  ySpot: number;
  /** Levels drawn as lines: the nearest few on each side of the price that fall inside the price axis. */
  levels: Array<OutlookLevel & { y: number }>;
  /** Levels that exist but are not drawn (further out, or outside the axis): counted, never silently dropped. */
  levelsNotDrawn: number;
  expiries: Array<{ expiry: string; x: number; share: number | null }>;
  events: Array<OutlookEvent & { x: number }>;
}
export const OUTLOOK_LINES_PER_SIDE = 4;

const dayNumber = (d: string) => Math.round(Date.parse(`${d}T12:00:00Z`) / 86_400_000);

/**
 * The picture's geometry. Time runs from today to the last expiry read; price runs from the widest implied
 * range (plus a margin) around the price, widened to hold the nearest levels. Null when there is no price
 * or no expiry ahead: nothing is drawn rather than drawn around a guess.
 */
export function outlookChart(today: string, spot: number | null | undefined, expiries: ExpiryRow[], levels: OutlookLevel[], events: OutlookEvent[]): OutlookChart | null {
  if (!finite(spot) || spot <= 0) return null;
  const ahead = expiries.filter((e) => e.expiry >= today);
  if (!ahead.length) return null;
  const from = today, to = ahead[ahead.length - 1].expiry;
  const span = Math.max(1, dayNumber(to) - dayNumber(from));
  const x = (d: string) => Math.min(1, Math.max(0, (dayNumber(d) - dayNumber(from)) / span));
  const near = (side: "above" | "below") => levels.filter((l) => l.side === side).sort((a, b) => Math.abs(a.distPts) - Math.abs(b.distPts)).slice(0, OUTLOOK_LINES_PER_SIDE);
  const pick = [...near("above"), ...levels.filter((l) => l.side === "at"), ...near("below")];
  const maxSigma = ahead.reduce((m, e) => Math.max(m, e.sigmaPts ?? 0), 0);
  // The axis holds the widest implied range with a margin; a level is drawn only if it fits within twice that
  // (or, with no range at all, within 5% of the price), so one far-away level cannot flatten the picture.
  const reach = maxSigma > 0 ? maxSigma * 2 : spot * 0.05;
  const drawn = pick.filter((l) => Math.abs(l.distPts) <= reach);
  const far = drawn.reduce((m, l) => Math.max(m, Math.abs(l.distPts)), 0);
  const half = Math.max(maxSigma * 1.15, far * 1.08, spot * 0.01);
  const lo = spot - half, hi = spot + half;
  const y = (p: number) => (hi - p) / (hi - lo);
  return {
    from, to, lo, hi, ySpot: y(spot),
    cone: ahead.filter((e) => e.sigmaPts != null).map((e) => ({ expiry: e.expiry, x: x(e.expiry), yHi: y(spot + e.sigmaPts!), yLo: y(spot - e.sigmaPts!), sigmaPts: e.sigmaPts! })),
    levels: drawn.map((l) => ({ ...l, y: y(l.price) })).sort((a, b) => a.y - b.y),
    levelsNotDrawn: levels.length - drawn.length,
    expiries: ahead.map((e) => ({ expiry: e.expiry, x: x(e.expiry), share: e.oiShare })),
    events: events.filter((e) => e.date >= from && e.date <= to).map((e) => ({ ...e, x: x(e.date) })),
  };
}

/** The collar as the terminal holds it: live strikes, or the reason there are none to show. */
export interface CollarIn { quarter?: string; rollDate?: string; longPut?: number; shortPut?: number; shortCall?: number; verification?: string; expired?: boolean; staleNote?: string | null }
export function collarLevels(c: CollarIn | null | undefined): { levels: OutlookLevelIn[]; note: string | null } {
  if (!c) return { levels: [], note: null };
  // The page's own words: the server's note for other panels ends "shown as historical reference only", and here nothing is shown.
  if (c.expired) return { levels: [], note: `the strikes on file expired at the ${c.rollDate ?? "last"} roll, and the current collar's strikes are not on file (no reputable source was found for them), so no collar level is listed or drawn.` };
  const src = `JPM collar to ${c.rollDate ?? "its roll"}${c.verification && c.verification !== "verified" ? ` (${c.verification})` : ""}`;
  const out: OutlookLevelIn[] = [];
  if (finite(c.shortCall)) out.push({ price: c.shortCall, label: "collar short call", source: src });
  if (finite(c.longPut)) out.push({ price: c.longPut, label: "collar long put", source: src });
  if (finite(c.shortPut)) out.push({ price: c.shortPut, label: "collar short put", source: src });
  return { levels: out, note: null };
}

/** A level as the level board sends it. A merged line's `key` is its members' keys joined by "+". */
export interface BoardLine { key?: string; price: number; label: string; group?: string }
export interface BoardLevelsIn {
  /** The board's full merged list for the ticker: bar levels and option-map landmarks, merged where they sit together. */
  all: BoardLine[] | null | undefined;
  /** The same list merged WITHOUT option landmarks (cases.levelsWithoutOptions); null when the board's cases are for another symbol. */
  withoutOptions: BoardLine[] | null | undefined;
  /** The option map's own state on the board: "ok", "stale" or "unavailable". */
  optionsState?: string | null;
  optionsReason?: string | null;
}
/** Keys of the option-map landmarks on the board (shared/protocols.ts OPTION_LEVEL_KEYS). */
export const LANDMARK_KEYS = ["pin", "wallAbove", "magnetBelow", "flip", "straddleHigh", "straddleLow"];

/**
 * The board's levels for this page, with a true source on each. Bar levels come from the list merged without
 * landmarks, so none is hidden inside a landmark's line. From the full list only lines that HOLD a landmark
 * are taken, told by the line's member keys (not by comparing the two lists: a landmark can regroup the bars
 * around it, so the same bar level sits in differently merged lines in the two lists). Those lines are taken
 * only while the board says its option map is current; otherwise they are left out and the reason is
 * returned to be shown. A line of landmarks only is "option map"; one that also holds bar levels says so.
 */
export function boardOutlookLevels(i: BoardLevelsIn): { levels: OutlookLevelIn[]; optionsNote: string | null } {
  if (i.withoutOptions == null) return { levels: [], optionsNote: "The board sent no level list for this index, so its levels are not listed." };
  const isLandmark = (k: string) => LANDMARK_KEYS.includes(k);
  const keysOf = (l: BoardLine) => (l.key ?? "").split("+").filter(Boolean);
  const out: OutlookLevelIn[] = i.withoutOptions.filter((l) => l && !keysOf(l).some(isLandmark)).map((l) => ({ price: l.price, label: l.label, source: "level board" }));
  const withLandmark = (i.all ?? []).filter((l) => l && keysOf(l).some(isLandmark));
  if (!withLandmark.length) return { levels: out, optionsNote: null };
  if (i.optionsState !== "ok") {
    return { levels: out, optionsNote: `Option-map levels (walls, pin, flip, straddle range) are left out: the board's option map is ${i.optionsState ?? "not current"}${i.optionsReason ? ` (${i.optionsReason})` : ""}.` };
  }
  for (const l of withLandmark) out.push({ price: l.price, label: l.label, source: keysOf(l).every(isLandmark) ? "option map" : "option map, joined with board levels within a few points" });
  return { levels: out, optionsNote: null };
}

/**
 * Label positions pushed apart so text does not print on text. `ys` are fractions of the plot height, in
 * any order; the result is in the same order, each at least `gap` from its neighbours where the box allows,
 * moved as little as possible (a pass down, then a pass up from the bottom edge).
 */
export function spreadLabels(ys: number[], gap: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) if (order[k].y - order[k - 1].y < gap) order[k].y = order[k - 1].y + gap;
  if (order.length && order[order.length - 1].y > 1) {
    order[order.length - 1].y = 1;
    for (let k = order.length - 2; k >= 0; k--) if (order[k + 1].y - order[k].y < gap) order[k].y = order[k + 1].y - gap;
  }
  const out = new Array<number>(ys.length);
  for (const o of order) out[o.i] = Math.max(0, o.y);
  return out;
}
