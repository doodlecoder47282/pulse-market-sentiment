import { CRYPTO_RULES } from "./cryptoRules";
// shared/cryptoVerdict.ts
//
// Coded verdict reasons for the crypto scanner and the desk's persistent
// risk state. A verdict's prose explains; its code is what a reader, a
// test, or a later analysis can count. The risk state is one keyless
// number — BTC against its own 24 h VWAP — and it fails closed: unknown
// majors block ENTER exactly as risk-off does.

export type VerdictCode =
  | "enter"
  | "forming"
  | "score_low"
  | "hard_kill"
  | "no_price"
  | "mcap_ceiling"
  | "flow_not_sustained"
  | "security_unread"
  | "price_unconfirmed"
  | "sells_missing"
  | "top10_unread"
  | "risk_off"
  | "risk_unknown"
  | "stale_data";

export const VERDICT_CODE_TEXT: Record<VerdictCode, string> = {
  enter: "every gate met",
  forming: "score over 50, flow not confirmed",
  score_low: "score under 50",
  hard_kill: "rug filter: authority, liquidity floor, honeypot pattern or exit door",
  no_price: "no reliable market cap or price",
  mcap_ceiling: "market cap above the entry ceiling",
  flow_not_sustained: "one hot window, not two of the last three",
  security_unread: "mint and freeze authority not read",
  price_unconfirmed: "pool price not confirmed by a second route",
  sells_missing: "1 h sell count missing, honeypot test not possible",
  top10_unread: "top-10 holder share not read",
  risk_off: "desk risk off: BTC 5% or more under its 24 h VWAP",
  risk_unknown: "desk risk unknown: majors not readable",
  stale_data: "pair data not refreshed recently: held at WATCH",
};

export interface DeskRisk {
  state: "on" | "off" | "unknown";
  reason: string;
  asOf: number | null;
  btcVsVwap24hPct: number | null;
}

/** BTC this far under its 24 h VWAP turns the desk off. */
export const DESK_RISK_OFF_PCT = CRYPTO_RULES.deskRisk.offBelowPct;

interface MajorsLike {
  state: "ok" | "partial" | "unavailable";
  /** Venue `state` is the venue's own read state; a stale or failed venue's mid is not used (stale -> unknown, never on/off). */
  rows: Array<{ asset: string; kraken: { state?: string; mid: number | null; vwap24h: number | null }; coinbase: { state?: string; mid: number | null } }>;
}

const liveMid = (v: { state?: string; mid: number | null } | undefined): number | null =>
  v && (v.state == null || v.state === "ok") && v.mid != null && Number.isFinite(v.mid) ? v.mid : null;

export function deskRiskFromMajors(snap: MajorsLike | null, now: number): DeskRisk {
  if (!snap || snap.state === "unavailable") return { state: "unknown", reason: "majors unavailable", asOf: now, btcVsVwap24hPct: null };
  const btc = snap.rows.find((r) => String(r.asset).toUpperCase() === "BTC");
  const krMid = liveMid(btc?.kraken);
  const cbMid = liveMid(btc?.coinbase);
  const mid = krMid ?? cbMid;
  // The VWAP is Kraken's; it is only as fresh as Kraken's read.
  const vwap = btc && (btc.kraken.state == null || btc.kraken.state === "ok") ? btc.kraken.vwap24h : null;
  if (mid == null || vwap == null || !(vwap > 0)) {
    const why = btc?.kraken.state && btc.kraken.state !== "ok" ? `Kraken BTC read ${btc.kraken.state}` : "BTC mid or 24 h VWAP not read";
    return { state: "unknown", reason: why, asOf: now, btcVsVwap24hPct: null };
  }
  const venue = krMid != null ? "Kraken mid" : "Coinbase mid";
  const pct = Math.round(((mid - vwap) / vwap) * 10000) / 100;
  if (pct <= DESK_RISK_OFF_PCT) return { state: "off", reason: `BTC ${pct.toFixed(2)}% vs its Kraken 24 h VWAP (${venue})`, asOf: now, btcVsVwap24hPct: pct };
  return { state: "on", reason: `BTC ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% vs its Kraken 24 h VWAP (${venue})`, asOf: now, btcVsVwap24hPct: pct };
}

// ---- Freshness and the served verdict (pure) -------------------------------
// A verdict is computed when the pair is refreshed. A pair whose data stopped
// refreshing (DexScreener no longer returns it, or its calls fail) would keep
// its last ENTER until the 48 h eviction; an ENTER is only served, recorded or
// reported while the pair data is younger than freshness.enterMaxAgeMinutes.

export const ENTER_MAX_AGE_MS = CRYPTO_RULES.freshness.enterMaxAgeMinutes * 60_000;

/** Is the pair data too old to stand behind an ENTER? Never refreshed counts as stale (fails closed). */
export function pairDataStale(lastRefreshAt: number | null | undefined, nowMs: number): { stale: boolean; ageMs: number | null } {
  if (lastRefreshAt == null || !Number.isFinite(lastRefreshAt)) return { stale: true, ageMs: null };
  const ageMs = Math.max(0, nowMs - lastRefreshAt);
  return { stale: ageMs > ENTER_MAX_AGE_MS, ageMs };
}

/** "pair data last refreshed 10.1 min ago (limit 10 min)". One decimal so a just-over age never reads as the limit. */
export function staleDataReason(ageMs: number | null): string {
  const lim = CRYPTO_RULES.freshness.enterMaxAgeMinutes;
  return ageMs == null
    ? `pair data not refreshed yet (limit ${lim} min)`
    : `pair data last refreshed ${(Math.floor(ageMs / 6_000) / 10).toFixed(1)} min ago (limit ${lim} min)`;
}

export interface ServableCandidate {
  verdict: "ENTER" | "WATCH" | "PASS";
  verdictCode?: VerdictCode | null;
  verdictReasons: string[];
  lastRefreshAt: number | null;
}

/**
 * The verdict as served now: an ENTER on stale pair data, or with the desk
 * not on, is held at WATCH. Stale is checked first (the ENTER reasons
 * describe data that is no longer current); every hold reason is put FIRST,
 * so a list row showing the first reason shows why it is held.
 */
export function servedVerdict<C extends ServableCandidate>(c: C, risk: Pick<DeskRisk, "state" | "reason">, nowMs: number): C {
  if (c.verdict !== "ENTER") return c;
  const fr = pairDataStale(c.lastRefreshAt, nowMs);
  const holds: string[] = [];
  if (fr.stale) holds.push(`held at WATCH: ${staleDataReason(fr.ageMs)}; the reasons below describe that older read`);
  if (risk.state !== "on") holds.push(`held at WATCH: desk risk ${risk.state} (${risk.reason})`);
  if (!holds.length) return c;
  const code: VerdictCode = fr.stale ? "stale_data" : risk.state === "off" ? "risk_off" : "risk_unknown";
  return { ...c, verdict: "WATCH", verdictCode: code, verdictReasons: [...holds, ...c.verdictReasons] };
}
