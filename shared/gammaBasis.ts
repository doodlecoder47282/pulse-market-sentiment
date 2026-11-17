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

import { etDate, isTradingDay, prevTradingDay } from "./exchangeCalendar";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface OiBasis {
  /** Trading date ("YYYY-MM-DD", ET) whose end-of-day open interest the figures use; null when unknown. */
  sessionDate: string | null;
  note: string;
}

export const OI_BASIS_TOOLTIP = "Open interest is posted once a day. Today's trading is not in these figures.";

/** The trading day whose posting a chain read on `readDate` carries (same rule as oiHold.postedSession). */
export function oiPostingDate(readDate: string): string {
  return isTradingDay(readDate) ? readDate : prevTradingDay(readDate);
}

/**
 * Trading date whose closing open interest a chain carries.
 *   readDate           ET calendar date the chain was read from Schwab
 *   heldPostingDate    when the open interest was filled from the saved
 *                      store (oiState.source "held"), the posting day of the
 *                      saved figures (oiState.sessionDate)
 * null when no usable date is given.
 */
export function oiSessionDate(readDate: string | null | undefined, heldPostingDate?: string | null): string | null {
  const held = typeof heldPostingDate === "string" && ISO.test(heldPostingDate) ? heldPostingDate : null;
  if (held) return prevTradingDay(oiPostingDate(held));
  if (typeof readDate !== "string" || !ISO.test(readDate)) return null;
  return prevTradingDay(oiPostingDate(readDate));
}

/**
 * ET calendar date a chain was read from Schwab: the receive time when the
 * response carries one, else its data time. null when it carries neither.
 */
export function chainReadDate(chain: { receivedAtMs?: number | null; asOfMs?: number | null } | null | undefined): string | null {
  for (const ms of [chain?.receivedAtMs, chain?.asOfMs]) {
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return etDate(ms);
  }
  return null;
}

export type OiStateLike = { source?: "live" | "held" | "none" | string; sessionDate?: string | null } | null | undefined;

/** The uniform payload object. `readDate` is the chain's ET read date, or null when unknown. */
export function buildOiBasis(readDate: string | null | undefined, oiState?: OiStateLike): OiBasis {
  if (oiState?.source === "none") {
    return { sessionDate: null, note: "No open interest was available for this chain, so its date is unknown." };
  }
  const held = oiState?.source === "held" ? oiState.sessionDate ?? null : null;
  const sessionDate = oiSessionDate(readDate, held);
  if (sessionDate == null) return { sessionDate: null, note: `${OI_BASIS_TOOLTIP} The chain's date is unknown, so the open-interest date is not stated.` };
  return {
    sessionDate,
    note: held
      ? `${OI_BASIS_TOOLTIP} New open interest had not posted when this chain was read; the last posted figures are used.`
      : OI_BASIS_TOOLTIP,
  };
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
export function oiStampText(basis: Pick<OiBasis, "sessionDate"> | null | undefined): string {
  const f = formatSessionDate(basis?.sessionDate ?? null);
  return f ? `OI as of the close of ${f}` : "OI date unknown";
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
  /** Killbox only: the weight this response actually used. */
  active?: KillboxWeightMode;
}

const n = (x: number) => x.toLocaleString("en-US");

export const GAMMA_WEIGHTING_LABELS: Readonly<Record<GammaWeightingKind, string>> = Object.freeze({
  oi: "weight: open interest",
  oi_plus_quarter_volume: `weight: open interest + ${HYBRID_VOLUME_WEIGHT} x today's volume`,
  killbox_adaptive:
    `weight: open interest, volume or both (open interest + ${HYBRID_VOLUME_WEIGHT} x volume when volume exceeds ${KILLBOX_HYBRID_VOLUME_TO_OI} x OI; ` +
    `volume alone when OI is under ${n(KILLBOX_VOLUME_ONLY_MAX_OI)} contracts and volume is over ${n(KILLBOX_VOLUME_ONLY_MIN_VOLUME)})`,
});

const ACTIVE_LABEL: Record<KillboxWeightMode, string> = {
  oi: "open interest",
  volume: "volume alone",
  hybrid: `open interest + ${HYBRID_VOLUME_WEIGHT} x volume`,
};

export function gammaWeighting(kind: GammaWeightingKind, active?: KillboxWeightMode): GammaWeighting {
  if (kind === "killbox_adaptive" && active) {
    return { kind, label: `${GAMMA_WEIGHTING_LABELS[kind]}; this read: ${ACTIVE_LABEL[active]}`, active };
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

/** Each bucket's share of the buckets' combined absolute size (0-1); null when the bucket is empty or nothing is priced. */
export function gexDteShares(buckets: ReadonlyArray<Pick<GexDteBucket, "netGex">>): Array<number | null> {
  const gross = buckets.reduce((a, b) => a + (b.netGex != null && Number.isFinite(b.netGex) ? Math.abs(b.netGex) : 0), 0);
  return buckets.map((b) => (b.netGex == null || !Number.isFinite(b.netGex) || !(gross > 0) ? null : Math.abs(b.netGex) / gross));
}
