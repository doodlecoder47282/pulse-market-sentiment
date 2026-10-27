// shared/cryptoFunding.ts
//
// Perpetual-futures funding and open interest for BTC, ETH and SOL: a
// RECORDED, DESCRIPTIVE regime readout for the crypto desk. It is not a gate
// and carries no threshold. Per docs/CRYPTO_DESK.md (calibration policy) a
// rule changes only from graded evidence over a version, so this input is
// first shown and stored on every signal row; the replay can bucket it later
// and a gate would be a new, pinned rule version.
//
// Sources (keyless public REST):
//   Bybit V5  GET /v5/market/tickers?category=linear&symbol=BTCUSDT
//     result.list[]: symbol, fundingRate, nextFundingTime (ms),
//     fundingIntervalHour, openInterest, openInterestValue (both sides).
//     The docs page gives no unit for the open-interest fields, so no
//     absolute open interest is ever shown: only the change between this
//     module's own successive reads of the same field, which is unit-free.
//     https://bybit-exchange.github.io/docs/v5/market/tickers
//   OKX v5  GET /api/v5/public/funding-rate?instId=BTC-USDT-SWAP
//           GET /api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP
//     fundingRate, fundingTime, nextFundingTime; oi, oiCcy, oiUsd, ts.
//     Response shape follows the exchange's public docs; this build could not
//     reach OKX from its sandbox, so a missing or mistyped field makes that
//     venue "unavailable", never zero. Settings -> Verify live data reaches
//     the feed on the owner's server.
//
// Funding is a decimal fraction per funding interval (Bybit example
// 0.0001 = 0.01%). Positive: longs pay shorts; negative: shorts pay longs.
// Normalised to a per-8-hour figure only when the venue states its interval.

export type PerpAsset = "BTC" | "ETH" | "SOL";
export const PERP_ASSETS: PerpAsset[] = ["BTC", "ETH", "SOL"];
export type PerpVenue = "bybit" | "okx";
export const PERP_VENUES: PerpVenue[] = ["bybit", "okx"];

/** How far back the open-interest change looks (a measurement definition, not a decision threshold). */
export const OI_WINDOW_MS = 60 * 60_000;
/** An older sample within this distance of the window edge still counts. */
export const OI_WINDOW_TOL_MS = 15 * 60_000;
/** A read older than this is stale (the tick runs every 2 minutes). */
export const DERIVS_STALE_MS = 6 * 60_000;

export interface PerpRead {
  venue: PerpVenue;
  asset: PerpAsset;
  /** decimal fraction per funding interval */
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  nextFundingMs: number | null;
  /** the venue's own open-interest figure, used only as a ratio between two reads of the same field */
  oi: number | null;
  fetchedAtMs: number;
}

export interface Parsed { read: PerpRead | null; reason: string | null }

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export const bybitSymbol = (a: PerpAsset): string => `${a}USDT`;
export const okxInstId = (a: PerpAsset): string => `${a}-USDT-SWAP`;

export function parseBybitTicker(j: any, asset: PerpAsset, nowMs: number): Parsed {
  if (j?.retCode !== 0) return { read: null, reason: `retCode ${String(j?.retCode ?? "missing")}` };
  const t = Array.isArray(j?.result?.list) ? j.result.list.find((x: any) => x?.symbol === bybitSymbol(asset)) : null;
  if (!t) return { read: null, reason: `${bybitSymbol(asset)} not in response` };
  const rate = num(t.fundingRate);
  const hours = num(t.fundingIntervalHour);
  const oiValue = num(t.openInterestValue);
  if (rate == null) return { read: null, reason: "fundingRate missing" };
  return {
    read: {
      venue: "bybit", asset, fundingRate: rate,
      fundingIntervalHours: hours != null && hours > 0 ? hours : null,
      nextFundingMs: num(t.nextFundingTime),
      oi: oiValue != null && oiValue > 0 ? oiValue : null,
      fetchedAtMs: nowMs,
    },
    reason: null,
  };
}

export function parseOkx(fundingJson: any, oiJson: any, asset: PerpAsset, nowMs: number): Parsed {
  if (String(fundingJson?.code) !== "0") return { read: null, reason: `funding code ${String(fundingJson?.code ?? "missing")}` };
  const f = Array.isArray(fundingJson?.data) ? fundingJson.data.find((x: any) => x?.instId === okxInstId(asset)) : null;
  if (!f) return { read: null, reason: `${okxInstId(asset)} not in funding response` };
  const rate = num(f.fundingRate);
  if (rate == null) return { read: null, reason: "fundingRate missing" };
  const t0 = num(f.fundingTime);
  const t1 = num(f.nextFundingTime);
  const hours = t0 != null && t1 != null && t1 > t0 ? (t1 - t0) / 3_600_000 : null;
  let oi: number | null = null;
  if (String(oiJson?.code) === "0" && Array.isArray(oiJson?.data)) {
    const o = oiJson.data.find((x: any) => x?.instId === okxInstId(asset));
    const v = num(o?.oiUsd);
    oi = v != null && v > 0 ? v : null;
  }
  return { read: { venue: "okx", asset, fundingRate: rate, fundingIntervalHours: hours, nextFundingMs: t1, oi, fetchedAtMs: nowMs }, reason: null };
}

export interface OiSample { t: number; v: number }

/** Percent change of the latest open-interest sample against the sample nearest one hour earlier, or null while that history has not built. */
export function oiChangePct(history: OiSample[], nowMs: number, windowMs = OI_WINDOW_MS, tolMs = OI_WINDOW_TOL_MS): number | null {
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  if (nowMs - last.t > DERIVS_STALE_MS) return null;
  let best: OiSample | null = null;
  for (const s of history) {
    const gap = Math.abs(last.t - s.t - windowMs);
    if (gap <= tolMs && (best == null || gap < Math.abs(last.t - best.t - windowMs))) best = s;
  }
  if (!best || !(best.v > 0) || !(last.v > 0)) return null;
  return Math.round(((last.v - best.v) / best.v) * 10000) / 100;
}

export type FundingDirection = "longs pay shorts" | "shorts pay longs" | "flat";
export const fundingDirection = (rate: number): FundingDirection => (rate > 0 ? "longs pay shorts" : rate < 0 ? "shorts pay longs" : "flat");

export interface DerivsRow {
  asset: PerpAsset;
  venue: PerpVenue;
  state: "ok" | "stale" | "unavailable";
  reason: string | null;
  /** percent per funding interval, as the venue states it */
  fundingPct: number | null;
  fundingIntervalHours: number | null;
  /** percent per 8 hours; null unless the venue states its interval */
  funding8hPct: number | null;
  direction: FundingDirection | null;
  /** percent change of open interest over about one hour; null while building */
  oi1hChangePct: number | null;
  oiState: "ok" | "building" | "unavailable";
  nextFundingMs: number | null;
  asOf: number | null;
}

export interface DerivsSnapshot {
  asOf: number;
  state: "ok" | "partial" | "unavailable";
  rows: DerivsRow[];
  note: string;
}

export interface VenueResult { parsed: Parsed | null; error: string | null }

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export function buildDerivsSnapshot(
  results: Record<PerpVenue, Record<PerpAsset, VenueResult>>,
  history: Record<PerpVenue, Record<PerpAsset, OiSample[]>>,
  nowMs: number,
): DerivsSnapshot {
  const rows: DerivsRow[] = [];
  for (const venue of PERP_VENUES) {
    for (const asset of PERP_ASSETS) {
      const res = results[venue]?.[asset];
      const read = res?.parsed?.read ?? null;
      if (!read) {
        rows.push({ asset, venue, state: "unavailable", reason: res?.error ?? res?.parsed?.reason ?? "no read", fundingPct: null, fundingIntervalHours: null, funding8hPct: null, direction: null, oi1hChangePct: null, oiState: "unavailable", nextFundingMs: null, asOf: null });
        continue;
      }
      const stale = nowMs - read.fetchedAtMs > DERIVS_STALE_MS;
      const rate = read.fundingRate;
      const h = read.fundingIntervalHours;
      const chg = read.oi == null ? null : oiChangePct(history[venue]?.[asset] ?? [], nowMs);
      rows.push({
        asset, venue,
        state: stale ? "stale" : "ok",
        reason: stale ? `last read ${Math.round((nowMs - read.fetchedAtMs) / 60_000)} min ago` : null,
        fundingPct: rate == null ? null : r6(rate * 100),
        fundingIntervalHours: h,
        funding8hPct: rate != null && h != null ? r6(rate * (8 / h) * 100) : null,
        direction: rate == null ? null : fundingDirection(rate),
        oi1hChangePct: stale ? null : chg,
        oiState: read.oi == null ? "unavailable" : chg == null ? "building" : "ok",
        nextFundingMs: read.nextFundingMs,
        asOf: read.fetchedAtMs,
      });
    }
  }
  const okAssets = PERP_ASSETS.filter((a) => rows.some((r) => r.asset === a && r.state === "ok")).length;
  // "ok" only when every venue answered for every asset: a dark venue is "partial", not hidden behind the other one.
  const state: DerivsSnapshot["state"] = okAssets === 0 ? "unavailable" : rows.every((r) => r.state === "ok") ? "ok" : "partial";
  return {
    asOf: nowMs, state, rows,
    note: "perpetual funding and open-interest change from public exchange feeds; descriptive context, not a rule input",
  };
}

/** The compact record stored on a signal row so the replay can test it later. Null while nothing was read fresh. */
export interface DerivsRecord {
  asOf: number;
  assets: Partial<Record<PerpAsset, { venue: PerpVenue; funding8hPct: number | null; fundingPct: number | null; oi1hChangePct: number | null }>>;
}

export function derivsRecord(snap: DerivsSnapshot | null): DerivsRecord | null {
  if (!snap || snap.state === "unavailable") return null;
  const assets: DerivsRecord["assets"] = {};
  for (const asset of PERP_ASSETS) {
    const row = snap.rows.find((r) => r.asset === asset && r.state === "ok");
    if (row) assets[asset] = { venue: row.venue, funding8hPct: row.funding8hPct, fundingPct: row.fundingPct, oi1hChangePct: row.oi1hChangePct };
  }
  // asOf is the oldest read behind the record, not the serve time.
  const reads = snap.rows.filter((r) => r.state === "ok" && r.asOf != null).map((r) => r.asOf as number);
  return Object.keys(assets).length && reads.length ? { asOf: Math.min(...reads), assets } : null;
}
