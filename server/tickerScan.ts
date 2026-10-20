// server/tickerScan.ts
//
// SCAN ANY TICKER. With Schwab connected, one symbol -> one structured read
// built from calls the app already makes elsewhere: the instrument lookup
// (so an unknown symbol says so instead of returning zeros), the quote, the
// 20-session volume history, the per-name dealer gamma structure, and the
// option chain's most active contracts. Each section carries its own data
// state; a section that could not be read says why and the rest still
// answers. Budget: at most five Schwab calls per scan, cached 60 s per
// symbol, so a reader typing symbols cannot burn the chain budget the flow
// engine depends on.
//
// Volume reads come from shared/volumeRead.ts and say what they measure:
// relative volume, quiet volume, and block-sized Level-1 updates for the
// streamed symbols. Nothing here is called a dark pool, because Schwab's
// feed carries no venue.

import { schwabFetchMeta, getQuotes, getPriceHistory, type NormalizedQuote } from "./schwab";
import { gatherPositioningForTicker, type PositioningSnapshot } from "./tickerAlpha";
import { buildSchwabFlow } from "./schwabFlow";
import { getActiveStreamStore } from "./streamStore";
import { isRegularSessionOpen } from "./exchangeCalendar";
import { etParts } from "./validationMath";
import { editionFromEnv } from "../shared/edition";
import { relativeVolume, quietVolume, blockPrints, type RelativeVolume, type QuietVolume, type BlockPrintRead } from "../shared/volumeRead";

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; data: TickerScan }>();

export interface SectionState { dataState: "ok" | "partial" | "stale" | "unavailable" | "no_data"; reason: string | null }

export interface TickerScan {
  symbol: string;
  asOf: number;
  edition: string;
  session: "open" | "closed";
  instrument: SectionState & { description: string | null; assetType: string | null; exchange: string | null; found: boolean | null };
  quote: SectionState & { last: number | null; changePct: number | null; bid: number | null; ask: number | null; spreadPct: number | null; volume: number | null; feed: string | null; ageMs: number | null };
  volume: SectionState & { relative: RelativeVolume; quiet: QuietVolume; blocks: BlockPrintRead };
  structure: SectionState & { spot: number | null; callWall: number | null; putWall: number | null; gammaFlip: number | null; maxPain: number | null; regime: PositioningSnapshot["regime"]; distToCallWallPct: number | null; distToPutWallPct: number | null; pcrOi: number | null; pcrVol: number | null; atmIv: number | null; ivSkew25d: number | null; warnings: string[] };
  chain: SectionState & { contracts: Array<{ occ: string; type: "C" | "P"; strike: number; expiration: string; dte: number; volume: number; openInterest: number; volOiRatio: number; isNewStrike: boolean; mid: number; notional: number; tag: string; delta: number }>; asOf: number | null; stale: boolean };
  note: string;
}

const state = (dataState: SectionState["dataState"], reason: string | null = null): SectionState => ({ dataState, reason });
const errText = (e: any) => String(e?.message ?? e).slice(0, 120);

function sessionFraction(nowMs: number): number | null {
  if (!isRegularSessionOpen(nowMs)) return null;
  const p = etParts(nowMs);
  const mins = p.h * 60 + p.mi - (9 * 60 + 30);
  return Math.max(0, Math.min(1, mins / 390));
}

export function validScanSymbol(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toUpperCase().replace(/^\$/, "");
  return SYMBOL_RE.test(s) ? s : null;
}

export async function scanTicker(symbolRaw: string): Promise<TickerScan> {
  const symbol = validScanSymbol(symbolRaw);
  if (!symbol) throw new Error("symbol must be 1-10 characters: letters, digits, dot or dash");
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const now = Date.now();
  const edition = editionFromEnv();
  const out: TickerScan = {
    symbol, asOf: now, edition, session: isRegularSessionOpen(now) ? "open" : "closed",
    instrument: { ...state("unavailable"), description: null, assetType: null, exchange: null, found: null },
    quote: { ...state("unavailable"), last: null, changePct: null, bid: null, ask: null, spreadPct: null, volume: null, feed: null, ageMs: null },
    volume: { ...state("unavailable"), relative: relativeVolume(null, [], null, null), quiet: quietVolume(relativeVolume(null, [], null, null), null), blocks: blockPrints([]) },
    structure: { ...state("unavailable"), spot: null, callWall: null, putWall: null, gammaFlip: null, maxPain: null, regime: "unknown", distToCallWallPct: null, distToPutWallPct: null, pcrOi: null, pcrVol: null, atmIv: null, ivSkew25d: null, warnings: [] },
    chain: { ...state("unavailable"), contracts: [], asOf: null, stale: false },
    note: "One symbol, five reads, each with its own state: instrument, quote, volume against its 20-session average (paced to the session), per-name dealer gamma, and the chain's most active contracts. Block-sized prints are read from Level-1 updates for the streamed symbols only and carry no venue. Descriptive only.",
  };

  // 1. Instrument lookup (demo edition has no instruments table: the section says so).
  try {
    const r = await schwabFetchMeta("marketdata/v1/instruments", { symbol, projection: "symbol-search" });
    const list: any[] = Array.isArray(r.data?.instruments) ? r.data.instruments : Array.isArray(r.data) ? r.data : [];
    const inst = list.find((i) => String(i?.symbol ?? "").toUpperCase() === symbol) ?? null;
    if (r.data == null) out.instrument = { ...state("unavailable", r.reason ?? "no instrument data"), description: null, assetType: null, exchange: null, found: null };
    else if (!inst) out.instrument = { ...state("no_data", "no instrument with this symbol at Schwab"), description: null, assetType: null, exchange: null, found: false };
    else out.instrument = { ...state("ok"), description: inst.description ?? null, assetType: inst.assetType ?? null, exchange: inst.exchange ?? null, found: true };
  } catch (e) { out.instrument = { ...state("unavailable", errText(e)), description: null, assetType: null, exchange: null, found: null }; }

  // 2. Quote.
  let q: NormalizedQuote | null = null;
  try {
    q = (await getQuotes([symbol]))[0] ?? null;
    if (!q || q.last == null) out.quote = { ...out.quote, ...state("no_data", "no quote returned") };
    else {
      const bid = q.bid ?? null, ask = q.ask ?? null;
      const spreadPct = bid != null && ask != null && bid > 0 && ask >= bid ? (ask - bid) / ((ask + bid) / 2) : null;
      out.quote = { ...state(q.stale ? "stale" : "ok", q.stale ? "served after a failed refresh" : null), last: q.last, changePct: q.changePercent == null ? null : q.changePercent / 100, bid, ask, spreadPct, volume: q.volume ?? null, feed: q.feed ?? null, ageMs: q.ageMs ?? null };
    }
  } catch (e) { out.quote = { ...out.quote, ...state("unavailable", errText(e)) }; }

  // 3. Volume: 20 sessions of daily bars (one call), today's volume from the quote, blocks from the stream.
  try {
    const ph = await getPriceHistory(symbol, "month", 2, "daily", 1, false);
    const bars = (ph.candles ?? []).map((c) => ({ date: etParts(c.datetime).ymd, t: c.datetime, close: c.close, volume: c.volume }));
    const today = etParts(now).ymd;
    const rel = relativeVolume(out.quote.volume, bars, today, sessionFraction(now));
    const quiet = quietVolume(rel, out.quote.changePct);
    const st = getActiveStreamStore();
    const ticks = st ? st.sessionTicks(symbol).ticks : [];
    const blocks = blockPrints(ticks.map((k) => ({ t: k.t, last: k.last, lastSize: k.lastSize, trade: k.trade })));
    out.volume = { ...state(rel.dataState === "no_data" ? "no_data" : rel.dataState, rel.reason), relative: rel, quiet, blocks };
  } catch (e) { out.volume = { ...out.volume, ...state("unavailable", errText(e)) }; }

  // 4. Structure: per-name dealer gamma (cached 5 min inside).
  try {
    const pos = await gatherPositioningForTicker(symbol);
    const has = pos.spot != null && (pos.callWall != null || pos.putWall != null);
    out.structure = {
      ...state(pos.spot == null ? "no_data" : has ? "ok" : "partial", pos.spot == null ? "no spot" : has ? null : "chain read gave no walls"),
      spot: pos.spot, callWall: pos.callWall, putWall: pos.putWall, gammaFlip: pos.gammaFlip, maxPain: pos.maxPain, regime: pos.regime,
      distToCallWallPct: pos.distToCallWallPct, distToPutWallPct: pos.distToPutWallPct, pcrOi: pos.pcrOi, pcrVol: pos.pcrVol, atmIv: pos.atmIv, ivSkew25d: pos.ivSkew25d, warnings: pos.warnings,
    };
  } catch (e) { out.structure = { ...out.structure, ...state("unavailable", errText(e)) }; }

  // 5. Chain: the most active contracts by volume over open interest (one call, 45 DTE).
  try {
    const f = await buildSchwabFlow(symbol, { minVolOi: 1, minVolume: 50, maxDte: 45, limit: 20 });
    if ("error" in f) out.chain = { ...out.chain, ...state("unavailable", f.error) };
    else {
      out.chain = {
        ...state(f.contracts.length ? (f.stale ? "stale" : "ok") : "no_data", f.contracts.length ? null : "no contract with 50+ volume inside 45 DTE"),
        contracts: f.contracts.map((c) => ({ occ: c.occ, type: c.type, strike: c.strike, expiration: c.expiration, dte: c.dte, volume: c.volume, openInterest: c.openInterest, volOiRatio: c.volOiRatio, isNewStrike: c.isNewStrike, mid: c.mid, notional: c.notional, tag: c.tag, delta: c.delta })),
        asOf: f.asOf, stale: !!f.stale,
      };
    }
  } catch (e) { out.chain = { ...out.chain, ...state("unavailable", errText(e)) }; }

  cache.set(symbol, { at: now, data: out });
  return out;
}
