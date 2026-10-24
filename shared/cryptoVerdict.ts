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
  | "risk_unknown";

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
};

export interface DeskRisk {
  state: "on" | "off" | "unknown";
  reason: string;
  asOf: number | null;
  btcVsVwap24hPct: number | null;
}

/** BTC this far under its 24 h VWAP turns the desk off. */
export const DESK_RISK_OFF_PCT = -5;

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
