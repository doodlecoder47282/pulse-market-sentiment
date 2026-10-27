// shared/odteMap.ts
//
// The 0DTE map: the day's dealer-gamma terrain for one expiry, composed from
// the 0DTE forward payload (server/odteForward.ts) into the form a trader
// reads before the open: gap, straddle range, the strikes that matter with
// their dollar exposure, the long-gamma band, ladders above and below, and
// (personal edition only) the rule-derived zones. Pure, shared by the server
// (route, settle ledger) and the client (unit switch), unit-tested on Node.
//
// Everything is derived from the same numbers the Heatseeker shows: GEX in
// $ per 1% move on the OI + quarter-volume weight, Black-Scholes on one
// clock. Nothing here is tuned to any published map; the comparison helper
// at the bottom only reports agreement, it never adjusts.

export interface ForwardStrike { strike: number; gex: number; callOI: number; putOI: number }

/** The fields of the /api/odte/forward payload the composer reads. */
export interface ForwardLike {
  symbol: string;
  asOf: string;
  spot: number;
  expiry: string;
  dte: number;
  gexValid: boolean;
  regime: "long_gamma" | "short_gamma" | "indeterminate";
  netGex: number | null;
  levels: { callWall: number | null; putWall: number | null; gammaFlip: number | null; pin: number | null };
  expectedMove: { sigma: number | null; straddle: number | null };
  session: { state: "preopen" | "intraday" | "closed"; minutesToClose: number; projMinutes: number };
  bars: { priorClose: number | null; sessionHigh: number | null; sessionLow: number | null; orbHigh: number | null; orbLow: number | null; vwap: number | null };
  strikes: ForwardStrike[];
  gammaCrossings?: number[] | null;
  sessionOpen?: number | null;
  priorClose?: number | null;
  gexContracts?: { priced: number; unpriced: number };
  flipInputs?: { label: string };
  source?: string;
  /** Chain provenance (server/odteForward.ts): when Schwab produced the chain and whether it was re-served after a failed refresh. */
  chainAsOfMs?: number | null;
  chainStale?: boolean;
  chainStaleReason?: string | null;
}

export type MapLabel = "pin" | "wall above" | "magnet below" | "pocket above" | "pocket below" | "shelf" | "pocket";

export interface MapStrike {
  strike: number;
  /** $ per 1% move, dealer-signed (the forward's number). */
  gexPct: number;
  /** $ per 1 index point: gexPct / (spot / 100). */
  gexPt: number;
  /** Share of the map's gross exposure, 0-1. */
  share: number;
  side: "above" | "below" | "at";
  label: MapLabel | null;
}

export interface GammaBand {
  /** null = no crossing on that side inside the forward's +-5% grid. */
  low: number | null;
  high: number | null;
  /** Sign of net gamma at spot per the forward's regime. */
  atSpot: "long" | "short" | "indeterminate";
  basis: string;
}

export interface MapZone {
  kind: "dip" | "fade" | "no-trade";
  low: number;
  high: number;
  /** For the dip zone: the level under which the zone's premise fails. */
  invalidation: number | null;
  basis: string;
}

export interface LadderStep {
  level: number;
  what: string;
  /** Dollar exposure behind a strike step, per 1% and per point; null for non-strike levels. */
  gexPct?: number | null;
  gexPt?: number | null;
}

export interface OdteMap {
  symbol: string;
  asOf: string;
  dateEt: string;
  spot: number;
  expiry: string;
  session: ForwardLike["session"];
  gap: { open: number | null; priorClose: number | null; points: number | null; pct: number | null; read: "up" | "down" | "flat" | "unknown" };
  range: {
    straddle: number | null;
    /** spot +- the ATM straddle mid (the straddle-range convention). */
    low: number | null;
    high: number | null;
    sigma: number | null;
    /** spot +- one sigma to the close (the forward's convention). */
    sigmaLow: number | null;
    sigmaHigh: number | null;
  };
  band: GammaBand;
  strikes: MapStrike[];
  landmarks: {
    pin: number | null;
    wallAbove: number | null;
    magnetBelow: number | null;
    pocketAbove: number | null;
    pocketBelow: number | null;
    flip: number | null;
  };
  ladders: { above: LadderStep[]; below: LadderStep[] };
  /** Personal edition only; null with the reason otherwise. */
  zones: MapZone[] | null;
  zonesNote: string;
  dataState: "ok" | "no_gex" | "stale_session" | "stale";
  reason: string | null;
  method: string[];
  /** When Schwab produced the chain behind this map (epoch ms); null when the forward did not say. The cards show this age, not asOf (compute time). */
  chainAsOfMs: number | null;
  chainStale: boolean;
}

export interface ComposeOptions {
  edition: "personal" | "investor" | "demo";
  /** Strikes farther than this from spot are left off the map (default 2%). */
  bandPct?: number;
  /** Rows under this share of the gross exposure are left off (default 1%). */
  minShare?: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const fin = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

/** ET calendar date of an ISO timestamp. */
export function etDateOf(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export function composeOdteMap(f: ForwardLike, opts: ComposeOptions): OdteMap {
  const spot = f.spot;
  const bandPct = opts.bandPct ?? 0.02;
  const minShare = opts.minShare ?? 0.01;
  const method = [
    "GEX = Black-Scholes gamma x (open interest + 0.25 x today's volume) x 100 x S^2 x 0.01, dealer long calls / short puts, one clock to the settlement instant",
    "per point = per 1% / (S / 100)",
    "straddle range = spot +- the ATM straddle mid; sigma range = spot +- one standard deviation to the close from the same straddle",
    "long-gamma band = between the re-priced zero crossings of this expiry's net gamma nearest spot (+-5% grid)",
    "labels: pin = largest positive strike within 1.5%; wall above / magnet below = largest positive on each side; pocket above / below = largest negative on each side; shelves (up to 4) = other positives over 35% of the pin; pockets (up to 4) = other negatives over 30% of it",
  ];

  // Gap
  const open = fin(f.sessionOpen) ?? null;
  const prior = fin(f.priorClose) ?? fin(f.bars?.priorClose) ?? null;
  const gapPts = open != null && prior != null ? open - prior : null;
  const gapPct = gapPts != null && prior ? (gapPts / prior) * 100 : null;
  const gapRead: OdteMap["gap"]["read"] = gapPct == null ? "unknown" : Math.abs(gapPct) < 0.15 ? "flat" : gapPct > 0 ? "up" : "down";

  // Range
  const straddle = fin(f.expectedMove?.straddle);
  const sigma = fin(f.expectedMove?.sigma);

  // Strikes
  const all = (f.strikes || []).filter((s) => Number.isFinite(s.strike) && Number.isFinite(s.gex));
  const gross = all.reduce((a, s) => a + Math.abs(s.gex), 0);
  const inBand = all.filter((s) => Math.abs(s.strike - spot) / spot <= bandPct);
  const rows: MapStrike[] = inBand
    .map((s) => ({
      strike: s.strike,
      gexPct: Math.round(s.gex),
      gexPt: Math.round(s.gex / (spot / 100)),
      share: gross > 0 ? Math.abs(s.gex) / gross : 0,
      // Within 0.03% of spot a strike is "at" spot: neither side's wall or pocket, but it can be the pin.
      side: (Math.abs(s.strike - spot) < spot * 0.0003 ? "at" : s.strike > spot ? "above" : "below") as MapStrike["side"],
      label: null as MapLabel | null,
    }))
    .filter((s) => s.share >= minShare)
    .sort((a, b) => b.strike - a.strike);

  const gexOk = f.gexValid && rows.length > 0;
  const pick = (pred: (r: MapStrike) => boolean, best: (a: MapStrike, b: MapStrike) => boolean): MapStrike | null => {
    let out: MapStrike | null = null;
    for (const r of rows) if (pred(r) && (!out || best(r, out))) out = r;
    return out;
  };
  const pinRow = gexOk ? pick((r) => r.gexPct > 0 && Math.abs(r.strike - spot) / spot <= 0.015, (a, b) => a.gexPct > b.gexPct) : null;
  const wallAbove = gexOk ? pick((r) => r.gexPct > 0 && r.side === "above", (a, b) => a.gexPct > b.gexPct) : null;
  const magnetBelow = gexOk ? pick((r) => r.gexPct > 0 && r.side === "below", (a, b) => a.gexPct > b.gexPct) : null;
  const pocketAbove = gexOk ? pick((r) => r.gexPct < 0 && r.side === "above", (a, b) => a.gexPct < b.gexPct) : null;
  const pocketBelow = gexOk ? pick((r) => r.gexPct < 0 && r.side === "below", (a, b) => a.gexPct < b.gexPct) : null;
  const pinMag = pinRow ? pinRow.gexPct : 0;
  for (const r of rows) {
    if (pinRow && r.strike === pinRow.strike) r.label = "pin";
    else if (wallAbove && r.strike === wallAbove.strike) r.label = "wall above";
    else if (magnetBelow && r.strike === magnetBelow.strike) r.label = "magnet below";
    else if (pocketAbove && r.strike === pocketAbove.strike) r.label = "pocket above";
    else if (pocketBelow && r.strike === pocketBelow.strike) r.label = "pocket below";
    else if (r.gexPct < 0 && pinMag > 0 && Math.abs(r.gexPct) >= 0.3 * pinMag) r.label = "pocket";
    else if (r.gexPct > 0 && pinMag > 0 && r.gexPct >= 0.35 * pinMag) r.label = "shelf";
  }
  // At most four shelves and four pockets, the largest, so the map stays readable.
  for (const kind of ["shelf", "pocket"] as const) {
    const ks = rows.filter((r) => r.label === kind).sort((a, b) => Math.abs(b.gexPct) - Math.abs(a.gexPct));
    for (const r of ks.slice(4)) r.label = null;
  }

  // Band from crossings
  const xs = (f.gammaCrossings || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const below = xs.filter((x) => x < spot);
  const above = xs.filter((x) => x > spot);
  const atSpot: GammaBand["atSpot"] = f.regime === "long_gamma" ? "long" : f.regime === "short_gamma" ? "short" : "indeterminate";
  const band: GammaBand = {
    low: below.length ? r2(below[below.length - 1]) : null,
    high: above.length ? r2(above[0]) : null,
    atSpot,
    basis: atSpot === "long"
      ? "net dealer gamma on this expiry is positive at spot; the band is where it stays positive"
      : atSpot === "short"
        ? "net dealer gamma on this expiry is negative at spot; the crossings mark where it turns positive"
        : "not enough priced contracts to sign the gamma at spot",
  };

  // Ladders: nearest first on each side, descriptive. Every level goes to the
  // side it is actually on (a session high under spot belongs below).
  const above_: LadderStep[] = [];
  const below_: LadderStep[] = [];
  const push = (level: number | null, what: string, gex?: { pct: number; pt: number }) => {
    if (level == null || !Number.isFinite(level) || level === spot) return;
    (level > spot ? above_ : below_).push({ level: r2(level), what, gexPct: gex?.pct ?? null, gexPt: gex?.pt ?? null });
  };
  if (straddle != null) { push(spot + straddle, "straddle range top"); push(spot - straddle, "straddle range bottom"); }
  if (sigma != null) { push(spot + sigma, "+1 sigma to the close"); push(spot - sigma, "-1 sigma to the close"); }
  for (const r of rows) if (r.label && r.side !== "at") push(r.strike, r.label, { pct: r.gexPct, pt: r.gexPt });
  const flip = fin(f.levels?.gammaFlip);
  push(flip, "gamma flip");
  // The crossings read differently by regime: with long gamma at spot they
  // bound the band; with short gamma at spot they are where gamma turns positive.
  const bandWhat = atSpot === "long" ? "long-gamma band" : "gamma turns positive";
  push(band.high, atSpot === "long" ? `${bandWhat} top` : bandWhat); push(band.low, atSpot === "long" ? `${bandWhat} bottom` : bandWhat);
  push(f.bars?.sessionHigh ?? null, "session high"); push(f.bars?.sessionLow ?? null, "session low");
  push(prior, "prior close");
  const merge = (arr: LadderStep[], nearestFirst: (a: { level: number }, b: { level: number }) => number) => {
    arr.sort(nearestFirst);
    const out: LadderStep[] = [];
    for (const x of arr) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.level - x.level) <= 0.5) { last.what = `${last.what} / ${x.what}`; last.gexPct = last.gexPct ?? x.gexPct; last.gexPt = last.gexPt ?? x.gexPt; }
      else out.push({ ...x });
    }
    return out.slice(0, 8);
  };
  const aboveL = merge(above_, (a, b) => a.level - b.level);
  const belowL = merge(below_, (a, b) => b.level - a.level);

  // Zones: personal edition only, rule-derived, heuristic.
  let zones: MapZone[] | null = null;
  let zonesNote = "";
  if (opts.edition !== "personal") {
    zonesNote = "zones are not shown in this edition (descriptive levels only)";
  } else if (!gexOk) {
    zonesNote = "no zones: the gamma map is not priced";
  } else {
    zones = [];
    // Strike spacing from the whole chain, not from the rows that survived the share filter.
    const spacing = strikeSpacing(all.map((r) => r.strike)) ?? spot * 0.0007;
    let dip: MapZone | null = null;
    if (magnetBelow) {
      const under = rows.filter((r) => r.gexPct > 0 && r.side === "below" && r.strike < magnetBelow.strike).sort((a, b) => b.strike - a.strike)[0] ?? null;
      dip = {
        kind: "dip", low: magnetBelow.strike, high: r2(magnetBelow.strike + spot * 0.0006),
        invalidation: under ? r2(under.strike - 1) : r2(magnetBelow.strike - spot * 0.003),
        basis: `largest positive strike below spot (${fmtMoney(magnetBelow.gexPct)} per 1%); premise fails ${under ? `under the next positive strike below it (${under.strike})` : "0.3% under it (no positive strike below it on the map)"}`,
      };
      zones.push(dip);
    }
    const fadeTop = pocketAbove ?? wallAbove;
    if (fadeTop && straddle != null && fadeTop.strike >= spot + straddle * 0.5) {
      // The zone spans the two levels it names: the straddle range top and the level above spot.
      const top = r2(spot + straddle);
      zones.push({
        kind: "fade", low: Math.min(top, fadeTop.strike), high: Math.max(top, fadeTop.strike), invalidation: null,
        basis: `${fadeTop.label ?? "level"} at ${fadeTop.strike} (${fmtMoney(fadeTop.gexPct)} per 1%) with the straddle range top at ${top}`,
      });
    }
    // The nearest short-gamma pocket within 1% of spot that is at least a fifth of
    // the pin: the one price crosses first. No pin, no reference, no zone.
    const pocketNear = pinMag > 0
      ? rows
        .filter((r) => r.gexPct < 0 && Math.abs(r.strike - spot) / spot <= 0.01 && Math.abs(r.gexPct) >= 0.2 * pinMag)
        .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0] ?? null
      : null;
    if (pocketNear) {
      const nt: MapZone = {
        kind: "no-trade", low: r2(pocketNear.strike - spacing / 2), high: r2(pocketNear.strike + spacing / 2), invalidation: null,
        basis: `short-gamma pocket at ${pocketNear.strike} (${fmtMoney(pocketNear.gexPct)} per 1%): hedging amplifies moves through it`,
      };
      // Two zones on the same prices would contradict each other: the pocket wins and the dip is dropped.
      if (dip && nt.low <= dip.high && nt.high >= dip.low) zones = zones.filter((z) => z.kind !== "dip");
      zones.push(nt);
    }
    zonesNote = "personal edition, rule-derived from the map above; a heuristic, not a forecast";
  }

  const chainStale = f.chainStale === true;
  const dataState: OdteMap["dataState"] = !gexOk ? "no_gex" : chainStale ? "stale" : f.session?.state === "closed" ? "stale_session" : "ok";
  return {
    symbol: f.symbol, asOf: f.asOf, dateEt: etDateOf(f.asOf), spot, expiry: f.expiry, session: f.session,
    gap: { open, priorClose: prior, points: gapPts == null ? null : r2(gapPts), pct: gapPct == null ? null : r2(gapPct), read: gapRead },
    range: {
      straddle, low: straddle == null ? null : r2(spot - straddle), high: straddle == null ? null : r2(spot + straddle),
      sigma, sigmaLow: sigma == null ? null : r2(spot - sigma), sigmaHigh: sigma == null ? null : r2(spot + sigma),
    },
    band, strikes: rows,
    landmarks: {
      pin: pinRow?.strike ?? null, wallAbove: wallAbove?.strike ?? null, magnetBelow: magnetBelow?.strike ?? null,
      pocketAbove: pocketAbove?.strike ?? null, pocketBelow: pocketBelow?.strike ?? null, flip,
    },
    ladders: { above: aboveL, below: belowL },
    zones, zonesNote, dataState,
    reason: !gexOk ? "the 0DTE gamma map is not priced (closed market or no implied vols)"
      : chainStale ? `chain re-served after a failed refresh${f.chainStaleReason ? `: ${f.chainStaleReason}` : ""}`
      : f.session?.state === "closed" ? "session closed: this is the last map of the day" : null,
    method,
    chainAsOfMs: Number.isFinite(Number(f.chainAsOfMs)) ? Number(f.chainAsOfMs) : null,
    chainStale,
  };
}

/** Most common gap between consecutive strikes. */
export function strikeSpacing(strikes: number[]): number | null {
  const s = Array.from(new Set(strikes)).sort((a, b) => a - b);
  if (s.length < 2) return null;
  const counts = new Map<number, number>();
  for (let i = 1; i < s.length; i++) { const d = r2(s[i] - s[i - 1]); counts.set(d, (counts.get(d) ?? 0) + 1); }
  let best: number | null = null, bestN = 0;
  counts.forEach((n, d) => { if (n > bestN) { bestN = n; best = d; } });
  return best;
}

export function fmtMoney(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "+";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

const fmtLvl = (n: number | null | undefined): string => (n == null ? "n/a" : Math.round(n).toLocaleString("en-US"));

/** The plan as text: one block a trader can read or paste. Units: "pct" ($ per 1%) or "pt" ($ per point). */
export function renderOdteMapText(m: OdteMap, units: "pct" | "pt" = "pct"): string {
  const u = units === "pct" ? "per 1%" : "per pt";
  const val = (r: MapStrike) => fmtMoney(units === "pct" ? r.gexPct : r.gexPt);
  const lines: string[] = [];
  const day = m.dateEt ? new Date(`${m.dateEt}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
  lines.push(`${m.symbol.replace(/^\$/, "")} 0DTE MAP · ${day} · ${m.expiry} · spot ${fmtLvl(m.spot)} · ${m.session.state}`);
  lines.push(m.gap.points != null
    ? `gap ${m.gap.read}: open ${fmtLvl(m.gap.open)} vs prior close ${fmtLvl(m.gap.priorClose)} (${m.gap.points >= 0 ? "+" : ""}${m.gap.points.toFixed(1)}, ${m.gap.pct! >= 0 ? "+" : ""}${m.gap.pct!.toFixed(2)}%)`
    : "gap: open or prior close not available");
  lines.push(m.range.straddle != null
    ? `range: straddle ${m.range.straddle.toFixed(1)} -> ${fmtLvl(m.range.low)}-${fmtLvl(m.range.high)}${m.range.sigma != null ? ` · 1 sigma to close ${m.range.sigma.toFixed(1)} -> ${fmtLvl(m.range.sigmaLow)}-${fmtLvl(m.range.sigmaHigh)}` : ""}`
    : "range: ATM straddle not available");
  const bandTxt = m.band.low == null && m.band.high == null ? ""
    : m.band.atSpot === "long"
      ? ` · long-gamma band ${m.band.low == null ? "below -5%" : fmtLvl(m.band.low)}-${m.band.high == null ? "above +5%" : fmtLvl(m.band.high)}`
      : ` · gamma turns positive ${[m.band.low != null ? `below ${fmtLvl(m.band.low)}` : null, m.band.high != null ? `above ${fmtLvl(m.band.high)}` : null].filter(Boolean).join(" and ")}`;
  lines.push(`gamma at spot: ${m.band.atSpot}${bandTxt}${m.landmarks.flip != null ? ` · flip ${fmtLvl(m.landmarks.flip)}` : ""}`);
  if (m.dataState === "no_gex") {
    lines.push(`map: ${m.reason}`);
  } else {
    lines.push(`map (${u}, dealer-signed, OI + 1/4 volume; labelled strikes and the largest, ${m.strikes.length} within 2% in the data):`);
    const shown = new Set<number>(m.strikes.filter((r) => r.label).map((r) => r.strike));
    for (const r of [...m.strikes].sort((a, b) => b.share - a.share)) { if (shown.size >= 14) break; shown.add(r.strike); }
    for (const r of m.strikes) if (shown.has(r.strike)) lines.push(`  ${fmtLvl(r.strike).padStart(7)}  ${val(r).padStart(9)}  ${r.label ?? ""}`.replace(/\s+$/, ""));
    const lad = (arr: OdteMap["ladders"]["above"]) => arr.map((x) => {
      const g = units === "pct" ? x.gexPct : x.gexPt;
      return `${fmtLvl(x.level)} ${x.what}${g != null ? ` ${fmtMoney(g)} ${u}` : ""}`;
    }).join(" -> ");
    if (m.ladders.above.length) lines.push(`above: ${lad(m.ladders.above)}`);
    if (m.ladders.below.length) lines.push(`below: ${lad(m.ladders.below)}`);
  }
  if (m.zones && m.zones.length) {
    for (const z of m.zones) {
      lines.push(`${z.kind.toUpperCase()} ${fmtLvl(z.low)}-${fmtLvl(z.high)}${z.invalidation != null ? ` · premise fails under ${fmtLvl(z.invalidation)}` : ""} · ${z.basis}`);
    }
  }
  lines.push(m.zonesNote);
  lines.push("levels are dealer-positioning estimates under a stated convention; not a forecast or advice.");
  return lines.join("\n");
}

// ─── Comparison with another map (report only) ──────────────────────────

export interface MapComparison {
  theirs: number;
  matched: number;
  signAgree: number;
  /** Their levels with our nearest strike within the tolerance and both signs. */
  rows: Array<{ theirLevel: number; theirValue: number; ourStrike: number | null; ourValue: number | null; signAgree: boolean | null }>;
  /** Spearman rank correlation of |value| over matched rows; null under 3 rows. */
  rankCorr: number | null;
  note: string;
}

/**
 * How another map's levels line up with ours: nearest strike within `tolPts`,
 * sign agreement, and the rank correlation of magnitudes (their units are
 * not assumed to be ours). A report, never an input to the map.
 */
export function compareMaps(ours: Array<{ strike: number; value: number }>, theirs: Array<{ level: number; value: number }>, tolPts = 5): MapComparison {
  const rows: MapComparison["rows"] = [];
  for (const t of theirs) {
    let best: { strike: number; value: number } | null = null;
    for (const o of ours) if (Math.abs(o.strike - t.level) <= tolPts && (!best || Math.abs(o.strike - t.level) < Math.abs(best.strike - t.level))) best = o;
    rows.push({ theirLevel: t.level, theirValue: t.value, ourStrike: best?.strike ?? null, ourValue: best?.value ?? null, signAgree: best ? Math.sign(best.value) === Math.sign(t.value) : null });
  }
  const matched = rows.filter((r) => r.ourStrike != null);
  const signAgree = matched.filter((r) => r.signAgree).length;
  let rankCorr: number | null = null;
  if (matched.length >= 3) {
    // Average ranks for ties, so the result does not depend on row order.
    const rank = (xs: number[]) => {
      const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
      const r = new Array<number>(xs.length);
      let k = 0;
      while (k < idx.length) {
        let j = k;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[k][0]) j++;
        const avg = (k + j) / 2;
        for (let q = k; q <= j; q++) r[idx[q][1]] = avg;
        k = j + 1;
      }
      return r;
    };
    const ra = rank(matched.map((r) => Math.abs(r.theirValue)));
    const rb = rank(matched.map((r) => Math.abs(r.ourValue as number)));
    const n = matched.length;
    const d2 = ra.reduce((s, v, i) => s + (v - rb[i]) ** 2, 0);
    rankCorr = r2(1 - (6 * d2) / (n * (n * n - 1)));
  }
  return {
    theirs: theirs.length, matched: matched.length, signAgree, rows, rankCorr,
    note: `tolerance ${tolPts} points; their units are not assumed; agreement is reported, the map is not adjusted to it`,
  };
}
