// shared/gammaBasis.ts
//
// What a dealer-gamma figure rests on, stated the same way on every tab:
//
//   oiBasis    the trading date whose END-of-day open interest the figure
//              uses. OCC posts open interest once a day, before the open
//              (server/oiHold.ts), and Schwab's chain openInterest does not
//              change during the session. So a chain read on trading day D
//              carries the figures posted on D, which count positions as of
//              the close of the trading day before D. On a weekend or holiday
//              the chain still carries the last posting (oiHold.postedSession).
//   weighting  what each tab multiplies gamma by. The tabs differ on purpose
//              (gammaProfile.ts, FlipInputs); this only says which is which.
//
// Pure: imports only the exchange calendar, so the client and the tests can
// use it. Nothing here changes a number.

import { etDate, isCovered, isTradingDay, prevTradingDay, sessionOpenMs } from "./exchangeCalendar";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface OiBasis {
  /** Trading date ("YYYY-MM-DD", ET) whose end-of-day open interest the figures use; null when unknown. */
  sessionDate: string | null;
  note: string;
  /** true = read on a trading day before its regular open: that day's posting is not assumed, so sessionDate is the earlier session. */
  postingPending?: boolean;
}

export const OI_BASIS_TOOLTIP = "Open interest is posted once a day. Today's trading is not in these figures.";
/** Short visible form of the tooltip (phones have no hover). */
export const OI_BASIS_SHORT = "today's trading is not in these figures";
export const OI_POSTING_PENDING_TEXT = "today's posting may not be in yet";

/** The trading day whose posting a chain read on `readDate` carries (same rule as oiHold.postedSession). */
export function oiPostingDate(readDate: string): string {
  return isTradingDay(readDate) ? readDate : prevTradingDay(readDate);
}

/** Every date is inside the exchange calendar's verified years (outside them holidays are unknown). */
function covered(...dates: string[]): boolean {
  return dates.every((d) => isCovered(d));
}

/**
 * Trading date whose closing open interest a chain carries, by date alone
 * (the posting of the read day is taken as made; buildOiBasis applies the
 * pre-open rule).
 *   readDate           ET calendar date the chain was read from Schwab
 *   heldPostingDate    when the open interest was filled from the saved
 *                      store (oiState.source "held"), the posting day of the
 *                      saved figures (oiState.sessionDate)
 * null when no usable date is given or the exchange calendar does not cover it.
 */
export function oiSessionDate(readDate: string | null | undefined, heldPostingDate?: string | null): string | null {
  const held = typeof heldPostingDate === "string" && ISO.test(heldPostingDate) ? heldPostingDate : null;
  const from = held ?? (typeof readDate === "string" && ISO.test(readDate) ? readDate : null);
  if (from == null) return null;
  const posting = oiPostingDate(from);
  const session = prevTradingDay(posting);
  return covered(from, posting, session) ? session : null;
}

/**
 * Instant a chain was read from Schwab (epoch ms): the receive time when the
 * response carries one, else its data time. null when it carries neither.
 */
export function chainReadMs(chain: { receivedAtMs?: number | null; asOfMs?: number | null } | null | undefined): number | null {
  for (const ms of [chain?.receivedAtMs, chain?.asOfMs]) {
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

/** ET calendar date of chainReadMs. */
export function chainReadDate(chain: { receivedAtMs?: number | null; asOfMs?: number | null } | null | undefined): string | null {
  const ms = chainReadMs(chain);
  return ms == null ? null : etDate(ms);
}

export type OiStateLike = { source?: "live" | "held" | "none" | string; sessionDate?: string | null } | null | undefined;

/**
 * The uniform payload object. `readMs` is the instant the chain was read
 * (chainReadMs), or null when unknown.
 *
 * Pre-open rule: Schwab's chain does not say when the day's open interest
 * posted. A chain with Schwab's own open interest read on a trading day
 * before that day's regular open (sessionOpenMs) is therefore not assumed to
 * carry the new posting: sessionDate is the EARLIER session (the one the
 * previous posting counted) and postingPending is true. From the open onward
 * the day's posting is taken as made. Held open interest names its own
 * posting day and is unaffected.
 */
export function buildOiBasis(readMs: number | null | undefined, oiState?: OiStateLike): OiBasis {
  if (oiState?.source === "none") {
    return { sessionDate: null, note: "No open interest was available for this chain, so its date is unknown." };
  }
  const held = oiState?.source === "held" && typeof oiState.sessionDate === "string" && ISO.test(oiState.sessionDate) ? oiState.sessionDate : null;
  const ms = typeof readMs === "number" && Number.isFinite(readMs) && readMs > 0 ? readMs : null;
  const readDate = ms == null ? null : etDate(ms);
  if (held == null && readDate == null) {
    return { sessionDate: null, note: `${OI_BASIS_TOOLTIP} The chain's date is unknown, so the open-interest date is not stated.` };
  }
  const uncovered: OiBasis = { sessionDate: null, note: `${OI_BASIS_TOOLTIP} The date is outside the exchange calendar's verified years, so the open-interest date is not stated.` };
  if (held != null) {
    const sessionDate = oiSessionDate(null, held);
    if (sessionDate == null) return uncovered;
    return { sessionDate, note: `${OI_BASIS_TOOLTIP} New open interest had not posted when this chain was read; the last posted figures are used.` };
  }
  const date = readDate as string;
  const openMs = isCovered(date) && isTradingDay(date) ? sessionOpenMs(date) : null;
  if (openMs != null && (ms as number) < openMs) {
    // Before the open: the previous trading day's posting is the latest that is certain.
    const sessionDate = oiSessionDate(prevTradingDay(date));
    if (sessionDate == null) return uncovered;
    return {
      sessionDate,
      postingPending: true,
      note: `${OI_BASIS_TOOLTIP} This chain was read before the regular open, so today's posting may not be in yet; the date shown is the session the previous posting counted.`,
    };
  }
  const sessionDate = oiSessionDate(date);
  if (sessionDate == null) return uncovered;
  return { sessionDate, note: OI_BASIS_TOOLTIP };
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-16" -> "Mon 16 Nov"; null for anything that is not a calendar date. */
export function formatSessionDate(date: string | null | undefined): string | null {
  if (typeof date !== "string" || !ISO.test(date)) return null;
  const d = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** The stamp text every gamma panel shows. */
export function oiStampText(basis: Pick<OiBasis, "sessionDate" | "postingPending"> | null | undefined): string {
  const f = formatSessionDate(basis?.sessionDate ?? null);
  if (!f) return "OI date unknown";
  return basis?.postingPending ? `OI as of the close of ${f}; ${OI_POSTING_PENDING_TEXT}` : `OI as of the close of ${f}`;
}

// ─── Weighting ────────────────────────────────────────────────────────────
// The constants the code itself multiplies and compares with
// (server/odteForward.ts, the /api/killbox/forward route in server/routes.ts).

/** Share of today's volume added to open interest in the hybrid weight. */
export const HYBRID_VOLUME_WEIGHT = 0.25;
/** Killbox: hybrid weight when chain volume exceeds this multiple of chain open interest. */
export const KILLBOX_HYBRID_VOLUME_TO_OI = 5;
/** Killbox: volume alone when chain open interest is under this many contracts ... */
export const KILLBOX_VOLUME_ONLY_MAX_OI = 1000;
/** ... and chain volume is over this many. */
export const KILLBOX_VOLUME_ONLY_MIN_VOLUME = 1000;

export type KillboxWeightMode = "oi" | "volume" | "hybrid";

/** The Killbox rule, unchanged: which weight a chain's totals select. */
export function killboxWeightMode(totalOI: number, totalVolume: number): KillboxWeightMode {
  const useVolume = totalOI < KILLBOX_VOLUME_ONLY_MAX_OI && totalVolume > KILLBOX_VOLUME_ONLY_MIN_VOLUME;
  return useVolume ? "volume" : (totalOI > 0 && totalVolume > totalOI * KILLBOX_HYBRID_VOLUME_TO_OI ? "hybrid" : "oi");
}

export type GammaWeightingKind = "oi" | "oi_plus_quarter_volume" | "killbox_adaptive";

export interface GammaWeighting {
  kind: GammaWeightingKind;
  /** One line for the screen. */
  label: string;
  /** Killbox only: the full switching rule, one short line. */
  detail?: string;
  /** Killbox only: the weight this response actually used. */
  active?: KillboxWeightMode;
}

const n = (x: number) => x.toLocaleString("en-US");

export const GAMMA_WEIGHTING_LABELS: Readonly<Record<GammaWeightingKind, string>> = Object.freeze({
  oi: "weight: open interest",
  oi_plus_quarter_volume: `weight: open interest + ${HYBRID_VOLUME_WEIGHT} x today's volume`,
  killbox_adaptive: "weight: open interest, volume or both",
});

/** The Killbox rule in one short line, from the constants. */
export const KILLBOX_WEIGHTING_RULE =
  `rule: OI + ${HYBRID_VOLUME_WEIGHT} x volume when volume exceeds ${KILLBOX_HYBRID_VOLUME_TO_OI} x OI; ` +
  `volume alone when OI is under ${n(KILLBOX_VOLUME_ONLY_MAX_OI)} and volume over ${n(KILLBOX_VOLUME_ONLY_MIN_VOLUME)}; otherwise OI`;

/** Visible reminder that the tabs differ on purpose. */
export const WEIGHTING_DIFFERS_TEXT = "differs by tab";

const ACTIVE_LABEL: Record<KillboxWeightMode, string> = {
  oi: "open interest",
  volume: "volume alone",
  hybrid: `open interest + ${HYBRID_VOLUME_WEIGHT} x volume`,
};

export function gammaWeighting(kind: GammaWeightingKind, active?: KillboxWeightMode): GammaWeighting {
  if (kind === "killbox_adaptive") {
    return active
      ? { kind, label: `weight this read: ${ACTIVE_LABEL[active]}`, detail: KILLBOX_WEIGHTING_RULE, active }
      : { kind, label: GAMMA_WEIGHTING_LABELS[kind], detail: KILLBOX_WEIGHTING_RULE };
  }
  return { kind, label: GAMMA_WEIGHTING_LABELS[kind] };
}

// ─── DTE split (Signals) ──────────────────────────────────────────────────

export interface GexDteBucket {
  label: string;
  dteMin: number;
  dteMax: number;
  /** Net GEX of the bucket, $ per 1% move, same sign convention as the total; null when the bucket holds no priced contract. */
  netGex: number | null;
  /** Option contract rows (strike, side, expiry) with open interest priced into the bucket. */
  contracts: number;
}

/** Signals split: expiring on the chain's trade date, the next week, the rest of the 0-45 DTE window. */
export const GEX_DTE_BUCKETS: ReadonlyArray<{ label: string; dteMin: number; dteMax: number }> = Object.freeze([
  { label: "0DTE", dteMin: 0, dteMax: 0 },
  { label: "1-7D", dteMin: 1, dteMax: 7 },
  { label: "8-45D", dteMin: 8, dteMax: 45 },
]);

/**
 * Sum per-contract GEX terms into the buckets. `terms` are the very terms the
 * total is summed from (signed: calls +, puts -) with the calendar days to
 * expiry the chain reports (or per-day sums of them, with their contract
 * count). A bucket with no term is null, not 0.
 */
export function bucketGexByDte(
  terms: ReadonlyArray<{ dte: number; gex: number; contracts?: number }>,
  buckets: ReadonlyArray<{ label: string; dteMin: number; dteMax: number }> = GEX_DTE_BUCKETS,
): GexDteBucket[] {
  const out = buckets.map((b) => ({ ...b, netGex: null as number | null, contracts: 0 }));
  for (const t of terms) {
    if (!Number.isFinite(t.dte) || !Number.isFinite(t.gex)) continue;
    // Whole calendar days; a fractional value belongs to the bucket of its ceiling.
    const d = Math.ceil(t.dte);
    const b = out.find((x) => d >= x.dteMin && d <= x.dteMax);
    if (!b) continue;
    b.netGex = (b.netGex ?? 0) + t.gex;
    b.contracts += t.contracts ?? 1;
  }
  return out;
}

/** Visible one-line explanation of the Signals DTE split. */
export const GEX_DTE_SPLIT_TEXT = "the three add up to Net GEX; % = share of their combined absolute size";

/** Each bucket's share of the buckets' combined absolute size (0-1); null when the bucket is empty or nothing is priced. */
export function gexDteShares(buckets: ReadonlyArray<Pick<GexDteBucket, "netGex">>): Array<number | null> {
  const gross = buckets.reduce((a, b) => a + (b.netGex != null && Number.isFinite(b.netGex) ? Math.abs(b.netGex) : 0), 0);
  return buckets.map((b) => (b.netGex == null || !Number.isFinite(b.netGex) || !(gross > 0) ? null : Math.abs(b.netGex) / gross));
}
