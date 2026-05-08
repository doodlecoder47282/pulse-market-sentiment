/**
 * cboeChainAdapter.ts — fallback option chain source when Schwab returns 403.
 *
 * Converts CBOE delayed_quotes JSON into Schwab's callExpDateMap/putExpDateMap shape
 * so all downstream consumers (gamma walls, GEX, exposures, whale detection) work
 * without modification.
 *
 * Trade-offs vs Schwab:
 *   - ~15 min lag (CBOE delayed feed) vs Schwab real-time
 *   - per-contract Greeks (delta/gamma/vega/theta/iv) all present, but quality varies
 *   - bid/ask present but no NBBO timestamp
 *   - DOES include OI + volume — required for whale detection
 *
 * Source flag: chains tagged `source: "cboe"` (vs `"schwab"`) so panels can show
 * staleness indicator.
 */
import { getCboeChain } from "./cboeCache";

// Match the OptionChainResponse shape from schwab.ts but with extended source tag
export type CboeChainResponse = {
  underlying: { last: number | null; bid: number | null; ask: number | null };
  callExpDateMap: Record<string, Record<string, any[]>>;
  putExpDateMap: Record<string, Record<string, any[]>>;
  source: "cboe";
  lagSeconds: number;
};

/** OCC option symbol pattern: UNDERLYING + YYMMDD + C/P + STRIKE(8 digits, 1/1000) */
const OCC_PAT = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/;

/**
 * Convert one CBOE contract to Schwab-style contract object.
 * Schwab uses these fields downstream: strike, bid, ask, last, mark, totalVolume,
 * openInterest, delta, gamma, theta, vega, volatility (iv), expirationDate.
 */
function toSchwabContract(c: any, strike: number, expiryISO: string, dte: number) {
  const bid = Number(c.bid) || 0;
  const ask = Number(c.ask) || 0;
  const mark = bid > 0 && ask > 0 ? (bid + ask) / 2 : (Number(c.last_trade_price) || Number(c.theo) || 0);
  return {
    putCall: undefined as string | undefined, // filled by caller
    symbol: c.option,
    description: `${c.option}`,
    bid,
    ask,
    last: Number(c.last_trade_price) || mark,
    mark,
    bidSize: Number(c.bid_size) || 0,
    askSize: Number(c.ask_size) || 0,
    totalVolume: Number(c.volume) || 0,
    openInterest: Number(c.open_interest) || 0,
    volatility: (Number(c.iv) || 0) * 100, // CBOE iv is decimal, Schwab uses percent
    delta: Number(c.delta) || 0,
    gamma: Number(c.gamma) || 0,
    theta: Number(c.theta) || 0,
    vega: Number(c.vega) || 0,
    rho: Number(c.rho) || 0,
    strikePrice: strike,
    expirationDate: expiryISO,
    daysToExpiration: dte,
    intrinsicValue: 0,
    inTheMoney: false,
    netChange: Number(c.change) || 0,
    percentChange: Number(c.percent_change) || 0,
    closePrice: Number(c.prev_day_close) || 0,
  };
}

/**
 * Build CBOE-sourced option chain in Schwab's response shape.
 * @param symbol — underlying ticker (SPY, SPX, NVDA, etc.). For SPX use "SPX" not "$SPX".
 * @param maxDte — optional filter; only include expirations with dte ≤ maxDte
 */
export async function getCboeOptionChain(
  symbol: string,
  maxDte?: number,
): Promise<CboeChainResponse | { error: "cboe_unavailable"; source: null }> {
  try {
    // Strip $ prefix and .X suffix for CBOE (uses plain ticker like "SPX", "VIX")
    const cboeSymbol = symbol.replace(/^\$/, "").replace(/\.X$/, "");

    // Use shared cboeCache (handles fresh/stale/disk fallback + 429 backoff)
    const raw = await getCboeChain(cboeSymbol);
    if (!raw) return { error: "cboe_unavailable", source: null };

    // CBOE response wraps payload as { data: { options, current_price, ... } }
    const data = raw?.data ?? raw;
    if (!data || !Array.isArray(data.options)) {
      return { error: "cboe_unavailable", source: null };
    }

    // CBOE delayed feed runs ~15min behind. Without a timestamp in the payload
    // we use a conservative 15min lag estimate.
    const at = Date.now() - 15 * 60_000;

    const lagSeconds = Math.round((Date.now() - at) / 1000);
    const last = Number(data.current_price) || null;
    const bidU = Number(data.bid) || null;
    const askU = Number(data.ask) || null;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const callExpDateMap: Record<string, Record<string, any[]>> = {};
    const putExpDateMap: Record<string, Record<string, any[]>> = {};

    for (const opt of data.options) {
      const m = OCC_PAT.exec(opt.option || "");
      if (!m) {
        // SPX uses SPXW prefix for weeklys — handle 7-char prefix
        const m2 = /^(SPXW|SPX|VIX|NDX|RUT)(\d{6})([CP])(\d{8})$/.exec(opt.option || "");
        if (!m2) continue;
        var [, , ymd, cp, strikeStr] = m2;
      } else {
        var [, , ymd, cp, strikeStr] = m;
      }

      const year = 2000 + parseInt(ymd.slice(0, 2));
      const month = parseInt(ymd.slice(2, 4)) - 1;
      const day = parseInt(ymd.slice(4, 6));
      const exp = new Date(Date.UTC(year, month, day));
      const dte = Math.round((exp.getTime() - today.getTime()) / 86400000);
      if (dte < 0) continue;
      if (maxDte !== undefined && dte > maxDte) continue;

      const strike = parseInt(strikeStr) / 1000;
      const expiryISO = exp.toISOString();
      // Schwab uses key format "YYYY-MM-DD:dte"
      const expKey = `${exp.toISOString().slice(0, 10)}:${dte}`;
      const strikeKey = strike.toFixed(2);

      const contract = toSchwabContract(opt, strike, expiryISO, dte);
      contract.putCall = cp === "C" ? "CALL" : "PUT";

      const targetMap = cp === "C" ? callExpDateMap : putExpDateMap;
      if (!targetMap[expKey]) targetMap[expKey] = {};
      if (!targetMap[expKey][strikeKey]) targetMap[expKey][strikeKey] = [];
      targetMap[expKey][strikeKey].push(contract);
    }

    return {
      underlying: { last, bid: bidU, ask: askU },
      callExpDateMap,
      putExpDateMap,
      source: "cboe",
      lagSeconds,
    };
  } catch (e: any) {
    console.warn("[cboeChainAdapter] error:", e?.message);
    return { error: "cboe_unavailable", source: null };
  }
}
