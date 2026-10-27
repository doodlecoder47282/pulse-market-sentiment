// server/sources/cryptoDerivs.ts
//
// Network adapter for shared/cryptoFunding.ts: Bybit and OKX public
// perpetual-futures endpoints (keyless). One read per asset per venue every
// two minutes (9 requests). A venue that refuses (some exchanges block whole
// regions) or returns an unexpected shape is reported as unavailable with
// the reason; it is never shown as zero funding. Open-interest history lives
// in memory (about 3 hours), so the one-hour change reads "building" for the
// first hour after a restart.

import {
  PERP_ASSETS, PERP_VENUES, bybitSymbol, okxInstId, parseBybitTicker, parseOkx, buildDerivsSnapshot,
  type DerivsSnapshot, type OiSample, type PerpAsset, type PerpVenue, type VenueResult,
} from "../../shared/cryptoFunding";

const UA = "Batcave/1.0 (personal market terminal)";
const HISTORY_MS = 3 * 60 * 60_000;

async function getJson(url: string, timeoutMs = 8000): Promise<any> {
  // Errors carry the status only, never the URL.
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const history: Record<PerpVenue, Record<PerpAsset, OiSample[]>> = {
  bybit: { BTC: [], ETH: [], SOL: [] },
  okx: { BTC: [], ETH: [], SOL: [] },
};

function remember(venue: PerpVenue, asset: PerpAsset, t: number, v: number | null): void {
  if (v == null) return;
  const h = history[venue][asset];
  h.push({ t, v });
  const cutoff = t - HISTORY_MS;
  while (h.length && h[0].t < cutoff) h.shift();
}

async function readOne(venue: PerpVenue, asset: PerpAsset, now: number): Promise<VenueResult> {
  try {
    if (venue === "bybit") {
      const j = await getJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${bybitSymbol(asset)}`);
      return { parsed: parseBybitTicker(j, asset, now), error: null };
    }
    const id = okxInstId(asset);
    const [f, o] = await Promise.all([
      getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`),
      getJson(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${id}`).catch(() => null),
    ]);
    return { parsed: parseOkx(f, o, asset, now), error: null };
  } catch (e: any) {
    return { parsed: null, error: String(e?.message ?? e).slice(0, 100) };
  }
}

// The last venue results are kept, not the last snapshot: row states (ok / stale)
// are derived from age against the clock every time they are served, so a tick
// that stops can never leave rows labelled ok.
let lastResults: Record<PerpVenue, Record<PerpAsset, VenueResult>> | null = null;

export async function readDerivs(now = Date.now()): Promise<DerivsSnapshot> {
  const results = { bybit: {}, okx: {} } as Record<PerpVenue, Record<PerpAsset, VenueResult>>;
  await Promise.all(PERP_VENUES.flatMap((v) => PERP_ASSETS.map(async (a) => {
    const res = await readOne(v, a, now);
    results[v][a] = res;
    remember(v, a, now, res.parsed?.read?.oi ?? null);
  })));
  lastResults = results;
  return buildDerivsSnapshot(results, history, now);
}

export function lastDerivs(now = Date.now()): DerivsSnapshot | null {
  return lastResults ? buildDerivsSnapshot(lastResults, history, now) : null;
}
