// server/odteForward.ts
//
// The 0DTE forward computation (per-strike dealer GEX and charm on the
// nearest unsettled expiry, flip, pin, ATM straddle, projection path,
// session anchors, level map, projected candles), moved out of routes.ts so
// the 0DTE map (server/odteMap.ts) and the settle ledger can call it without
// an HTTP round trip. The route is a thin wrapper. Returns { status, body }:
// 503 bodies carry dataState and reason (chain or spot unavailable).

import { schwabNum } from "./schwabChainRows";
import { dollarGexPerPct, flipInputs, FLIP_DIV_YIELD, FLIP_RATE, repricedFlipFromChain } from "./gammaProfile";
import { contractYears, expiryOfKey, ivForClock } from "./chainClock";
import { timeToExpiry } from "./timeToExpiry";
import { etDate, REGULAR_OPEN_MIN, sessionCloseMinutes } from "./exchangeCalendar";
import { gamma as bsGammaOurClock } from "./greeks";
import { charmTiltNorm, contractExposure } from "./greekExposure";

export interface OdteForwardResult { status: number; body: any }

/** Data sources, injectable for tests and the demo harness (default: server/schwab.ts). */
export interface OdteForwardDeps {
  getOptionChain: (symbol: string, dte: number) => Promise<any>;
  getPriceHistory: (symbol: string, periodType: string, period: number, frequencyType: string, frequency: number, extended: boolean) => Promise<any>;
}

export async function buildOdteForward(symbolIn: string, nowMs: number = Date.now(), depsIn?: OdteForwardDeps): Promise<OdteForwardResult> {
  const symbol = String(symbolIn || "$SPX").trim().toUpperCase() || "$SPX";
  // schwab.ts has narrower parameter types than the generic deps shape; the calls below stay inside them.
  const deps: OdteForwardDeps = depsIn ?? ((await import("./schwab")) as unknown as OdteForwardDeps);
  const proj = await import("./odteProjection");
  const [chain, hist] = await Promise.all([
    deps.getOptionChain(symbol, 1),
    deps.getPriceHistory(symbol, "day", 2, "minute", 5, false).catch(() => ({ candles: [] as any[] })),
  ]);
  if ("error" in chain) {
    return { status: 503, body: { dataState: "unavailable", reason: "Option chain unavailable", error: (chain as any).error, message: "Option chain unavailable" } };
  }
  const spot = chain.underlying.last ?? null;
  if (!spot || spot <= 0) return { status: 503, body: { dataState: "no_spot", reason: "no underlying spot in the Schwab $SPX chain", error: "no_spot" } };

  // ── nearest expiry (min DTE) across both maps ──
  const dteOf = (ek: string) => { const n = parseFloat(ek.split(":")[1] || "99"); return isFinite(n) ? n : 99; };
  const allKeys = [...Object.keys(chain.callExpDateMap || {}), ...Object.keys(chain.putExpDateMap || {})];
  if (allKeys.length === 0) return { status: 503, body: { dataState: "unavailable", reason: "the Schwab chain returned no expiries", error: "no_expiries" } };
  // Nearest expiry that has not settled yet (after the close today's key
  // can still be listed; its contracts carry no risk).
  const liveKeys = allKeys.filter((k) => !timeToExpiry(expiryOfKey(k), { nowMs }).expired);
  if (liveKeys.length === 0) return { status: 503, body: { dataState: "unavailable", reason: "the Schwab chain has no unsettled expiry", error: "no_live_expiries" } };
  const nearestKey = liveKeys.sort((a, b) => dteOf(a) - dteOf(b))[0];
  const nearestDte = dteOf(nearestKey);
  const expiryDate = nearestKey.split(":")[0];

  // ── ET session math ──
  const etParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(nowMs));
  const get = (t: string) => etParts.find(p => p.type === t)?.value || "";
  const etHour = parseInt(get("hour"), 10) % 24;
  const etMin = parseInt(get("minute"), 10);
  const nowMin = etHour * 60 + etMin;
  // Session bounds from the exchange calendar: 13:00 close on half days;
  // a holiday/weekend reads as closed (next session = a full one).
  const todayEt = etDate(nowMs);
  const OPEN = REGULAR_OPEN_MIN;
  const todayClose = sessionCloseMinutes(todayEt);
  const CLOSE = todayClose ?? -1;
  const sessionLen = todayClose != null ? todayClose - OPEN : 390;
  let sessionState: "preopen" | "intraday" | "closed";
  let startMin: number; // minutes-from-open where projection starts
  if (todayClose != null && nowMin < OPEN) { sessionState = "preopen"; startMin = 0; }
  else if (todayClose != null && nowMin < CLOSE) { sessionState = "intraday"; startMin = nowMin - OPEN; }
  else { sessionState = "closed"; startMin = 0; }
  const projMinutes = (sessionState === "closed" ? 390 : sessionLen) - startMin; // projection window length
  const minutesToClose = sessionState === "intraday" ? CLOSE - nowMin : projMinutes;

  // ── aggregate 0DTE-only per-strike GEX + charm ──
  const SQRT_2PI = Math.sqrt(2 * Math.PI);
  const phi = (x: number) => Math.exp(-0.5 * x * x) / SQRT_2PI;
  const invN = (p: number): number => {
    const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
    const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
    const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
    const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
    const plow = 0.02425, phigh = 1 - plow;
    const cl = Math.max(1e-6, Math.min(1 - 1e-6, p));
    let q: number, r: number;
    if (cl < plow) { q = Math.sqrt(-2 * Math.log(cl)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (cl > phigh) { q = Math.sqrt(-2 * Math.log(1 - cl)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = cl - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  };

  type Row = { strike: number; gex: number; charm: number; callOI: number; putOI: number; callMid: number; putMid: number; callIV: number; putIV: number; T?: number };
  const agg = new Map<number, Row>();
  const getRow = (k: number): Row => {
    let r = agg.get(k);
    if (!r) { r = { strike: k, gex: 0, charm: 0, callOI: 0, putOI: 0, callMid: 0, putMid: 0, callIV: 0, putIV: 0 }; agg.set(k, r); }
    return r;
  };
  // Greeks: one clock per contract (timeToExpiry via chainClock, calendar
  // minutes to the real settlement instant / 525,600) with sigma solved
  // for that T. The projection cone below stays on odteProjection's
  // trading-minute basis, converted from the same total variance.
  let atmTotalVar: number | null = null; // sigma^2 * T of the ATM contracts (calendar clock)
  const passes: Array<{ side: "C" | "P"; map: any }> = [
    { side: "C", map: chain.callExpDateMap },
    { side: "P", map: chain.putExpDateMap },
  ];
  let totalOI = 0, totalVol = 0, validGammaCount = 0, unpricedGammaCount = 0;
  for (const { side, map } of passes) {
    const strikes = map?.[nearestKey] || {};
    for (const sk of Object.keys(strikes)) {
      const strike = parseFloat(sk);
      if (!isFinite(strike)) continue;
      const row = getRow(strike);
      for (const c of strikes[sk] || []) {
        // schwabNum drops Schwab's -999 sentinels and non-numbers; a missing
        // field is 0 weight here (nothing to hedge), never a negative total.
        const oi = Math.max(0, schwabNum(c.openInterest) ?? 0);
        const vol = Math.max(0, schwabNum(c.totalVolume) ?? 0);
        const bid = schwabNum(c.bid), ask = schwabNum(c.ask), last = schwabNum(c.last);
        // Mid needs a two-sided quote; a no-bid contract is priced at last, not ask/2.
        const mid = bid != null && ask != null && bid > 0 && ask >= bid ? (bid + ask) / 2 : (last ?? 0);
        const rawIV = schwabNum(c.volatility) ?? 0;
        const T = contractYears(nearestKey, c, nowMs);
        if (!(T > 0)) continue; // settled (e.g. AM SPX after the open): not in the totals either
        totalOI += oi; totalVol += vol;
        const sqrtT = Math.sqrt(T);
        const sigmaClock = ivForClock({
          vendorIv: rawIV > 0 && rawIV < 500 ? rawIV / 100 : 0,
          bid: Number(c.bid), ask: Number(c.ask), spot, strike, T, type: side,
        });
        const ivPct = sigmaClock > 0 ? sigmaClock * 100 : 0; // calendar-clock IV, %
        if (side === "C") { row.callOI += oi; row.callMid = mid; row.callIV = ivPct; row.T = T; }
        else { row.putOI += oi; row.putMid = mid; row.putIV = ivPct; row.T = T; }
        const weight = oi + vol * 0.25; // hybrid: 0DTE OI is stale by design, volume carries intraday info
        if (weight <= 0) continue;
        const sigma = sigmaClock;
        const sign = side === "C" ? 1 : -1;
        // GEX in $ per 1% move (gamma x contracts x 100 x S^2 x 0.01) on the
        // same basis as the Killbox, thermal map and gamma flip:
        // Black-Scholes gamma (r = FLIP_RATE, q = FLIP_DIV_YIELD) with our
        // clock T and sigma valid for it. The old line used Schwab's
        // vendor gamma (undocumented clock), so this map's walls and the
        // flip it is drawn against were on different gammas. A contract
        // with no usable sigma is left out and counted, not given a vendor value.
        const gamma = sigma > 0 ? bsGammaOurClock(spot, strike, sigma, T, FLIP_RATE, FLIP_DIV_YIELD) : 0;
        if (gamma > 0 && Number.isFinite(gamma)) { row.gex += sign * dollarGexPerPct(gamma, weight, spot); validGammaCount++; }
        else unpricedGammaCount++;
        if (sigma > 0) {
          // Dealer-signed $ delta-notional change to settlement (same-day
          // expiry: h = T), server/greekExposure.ts. The old line used
          // -phi(d1) d2 / (2 T sigma sqrt T) / 365 x S x 0.01: sign flipped and
          // 1/(sigma sqrt T) too large (~360x with 3 h left), so the tilt sat
          // at its clamp.
          row.charm += sign * contractExposure({ spot, strike, sigma, T, contracts: weight }).charmPerDay;
        }
      }
    }
  }

  const rows = Array.from(agg.values()).filter(r => Math.abs(r.strike - spot) / spot <= 0.03).sort((a, b) => a.strike - b.strike);
  if (rows.length === 0) return { status: 503, body: { dataState: "unavailable", reason: "the Schwab chain has no usable strikes", error: "no_strikes" } };
  const netGex = rows.reduce((s, r) => s + r.gex, 0);
  const netCharm = rows.reduce((s, r) => s + r.charm, 0);
  const totalAbsGex = rows.reduce((s, r) => s + Math.abs(r.gex), 0) || 1;

  // levels — 0DTE-only walls, flip, pin
  let callWall: number | null = null, putWall: number | null = null, maxPos = 0, maxNeg = 0;
  for (const r of rows) {
    if (r.gex > maxPos) { maxPos = r.gex; callWall = r.strike; }
    if (r.gex < maxNeg) { maxNeg = r.gex; putWall = r.strike; }
  }
  // gamma flip: app-wide re-priced definition (gammaProfile.ts) on this
  // expiry, same hybrid weight and the same per-contract clock as above
  // (rowsFromChain defaults to chainClock.contractYears).
  const flipObj = repricedFlipFromChain(chain, spot, {
    r: FLIP_RATE,
    q: FLIP_DIV_YIELD,
    expiryKeys: [nearestKey],
    weight: (c: any) => (Number(c?.openInterest) || 0) + (Number(c?.totalVolume) || 0) * 0.25,
    lowPct: 0.95,
    highPct: 1.05,
    nLevels: 101,
    nowMs,
  });
  const gammaFlip: number | null = flipObj.zeroGamma;
  // pin candidate: largest POSITIVE exposure within ±1.5% of spot (the same
  // definition as the 0DTE map; a short-gamma pocket is not a pin).
  let pin: number | null = null, pinMag = 0;
  for (const r of rows) {
    if (r.gex > 0 && Math.abs(r.strike - spot) / spot <= 0.015 && r.gex > pinMag) { pinMag = r.gex; pin = r.strike; }
  }

  // ── ATM IV + straddle expected move ──
  let atmRow = rows[0];
  for (const r of rows) if (Math.abs(r.strike - spot) < Math.abs(atmRow.strike - spot)) atmRow = r;
  // atmIVPct: calendar-clock IV (comparable with the chain's IV column).
  let atmIVPct = (atmRow.callIV > 0 && atmRow.putIV > 0) ? (atmRow.callIV + atmRow.putIV) / 2 : (atmRow.callIV || atmRow.putIV || 0);
  if (atmIVPct > 0 && atmRow.T != null && atmRow.T > 0) atmTotalVar = (atmIVPct / 100) ** 2 * atmRow.T;
  // Both legs or nothing: one leg's mid is not a straddle.
  const straddle = atmRow.callMid > 0 && atmRow.putMid > 0 ? atmRow.callMid + atmRow.putMid : 0;
  const MIN_PER_YEAR = 252 * 390;
  let atmIVSource: "chain" | "straddle" = "chain";
  if (atmIVPct <= 0 && straddle > 0) {
    // Closed-market fallback: ATM straddle ~= 0.8 * S * sigma * sqrt(T) -> invert for sigma
    const tYears = projMinutes / MIN_PER_YEAR; // session minutes (210 on a half day)
    atmIVPct = (straddle / (0.8 * spot * Math.sqrt(tYears))) * 100;
    atmIVSource = "straddle";
  }
  // The projection (odteProjection) runs on trading minutes / (252 x 390).
  // Convert the calendar-clock total variance sigma^2*T to that basis over
  // the minutes left in the session, so sd to the close = S*sqrt(sigma^2*T)
  // (variance spread over the remaining session; no basis is mixed).
  const atmIV = atmIVSource === "chain" && atmTotalVar != null && projMinutes > 0
    ? Math.sqrt(atmTotalVar / (projMinutes / MIN_PER_YEAR))
    : atmIVPct / 100;
  const emSigma = atmIV > 0 ? spot * atmIV * Math.sqrt(projMinutes / MIN_PER_YEAR) : null;

  // ── path: 27 points (~every 15 min) ──
  const gexValid = validGammaCount >= 10; // need a real greek surface to trust regime/levels
  const regime = !gexValid ? "indeterminate" : netGex >= 0 ? "long_gamma" : "short_gamma";
  const pinPullMax = regime === "long_gamma" && pin != null ? Math.min(0.6, pinMag / totalAbsGex) : 0;
  // Charm tilt: dealer charm flow to the close ($, = -netCharm) over gross
  // $ GEX per 1% (heuristic, clamped +-0.15 of the cone): greekExposure.charmTiltNorm.
  const charmNorm = charmTiltNorm(netCharm, totalAbsGex);
  const coneWiden = regime === "short_gamma" ? 1.15 : 1.0;
  const N = 26;
  const path: any[] = [];
  for (let i = 0; i <= N; i++) {
    const tMin = (projMinutes * i) / N;
    const prog = i / N;
    const sig = atmIV > 0 ? spot * atmIV * Math.sqrt(Math.max(tMin, 0.01) / MIN_PER_YEAR) * coneWiden : 0;
    const pinPull = pin != null ? (pin - spot) * pinPullMax * Math.pow(prog, 0.7) : 0;
    const charmTilt = charmNorm * sig;
    const median = spot + pinPull + charmTilt;
    const absMin = (sessionState === "intraday" ? nowMin : OPEN) + tMin;
    const hh = Math.floor(absMin / 60), mm = Math.floor(absMin % 60);
    path.push({
      minute: Math.round(tMin),
      et: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      median: +median.toFixed(2),
      up1: +(median + sig).toFixed(2), dn1: +(median - sig).toFixed(2),
      up2: +(median + 2 * sig).toFixed(2), dn2: +(median - 2 * sig).toFixed(2),
    });
  }

  // ── session anchors + level map + projected candles ──
  const bars = proj.deriveSessionBars((hist as any)?.candles || [], nowMs);
  const sigmaToClose = emSigma ?? 0;
  const levelObj = gexValid
    ? { callWall, putWall, gammaFlip: gammaFlip != null ? +gammaFlip.toFixed(0) : null, pin }
    : { callWall: null, putWall: null, gammaFlip: null, pin: null };
  const levelMap = proj.buildLevelMap({
    spot, sigmaToClose, levels: levelObj,
    gexPeaks: rows.map(r => ({ strike: r.strike, gex: r.gex })),
    bars, totalAbsGex,
  });
  const candles = proj.projectCandles({
    spot, atmIV, projMinutes,
    startAbsMin: sessionState === "intraday" ? nowMin : OPEN,
    regime, pin: levelObj.pin, gammaFlip: levelObj.gammaFlip,
    callWall: levelObj.callWall, putWall: levelObj.putWall,
    pinPullMax, charmNorm, seed: proj.sessionSeed(),
  });

  // The chain's own provenance travels with the forward so every card shows
  // the data's age, not this computation's time (asOf). A chain re-served from
  // cache after a failed refresh is stale here and on the map.
  const chainAsOfMs: number | null = Number.isFinite(Number((chain as any).asOfMs)) ? Number((chain as any).asOfMs) : null;
  const chainStale = (chain as any).stale === true;
  return { status: 200, body: {
    symbol, asOf: new Date(nowMs).toISOString(), spot, source: (chain as any).source || "schwab",
    chainAsOfMs, chainAgeMs: chainAsOfMs != null ? Math.max(0, nowMs - chainAsOfMs) : null, chainStale,
    chainStaleReason: chainStale ? ((chain as any).staleReason ?? "re-served from cache after a failed refresh") : null,
    servedFromCache: (chain as any).servedFromCache === true, asOfBasis: (chain as any).asOfBasis ?? null,
    expiry: expiryDate, dte: nearestDte,
    bars, levelMap, candles,
    session: { state: sessionState, minutesToClose, projMinutes },
    atmIV: +(atmIVPct).toFixed(2), atmIVSource, gexValid,
    expectedMove: { sigma: emSigma != null ? +emSigma.toFixed(2) : null, straddle: straddle > 0 ? +straddle.toFixed(2) : null },
    netGex: gexValid ? +netGex.toFixed(0) : null, netCharm: gexValid ? +netCharm.toFixed(0) : null, regime,
    // units of the two numbers above (additive fields)
    netGexUnits: "$ per 1% spot move (dealer-signed)", netCharmUnits: "$ dealer delta-notional change to settlement, spot and vol held",
    gexBasis: "Black-Scholes gamma (r 5%, q 1.3%), time to the real settlement instant, sigma solved from the mid inside 3 days; same basis as Killbox and the gamma flip",
    gexContracts: { priced: validGammaCount, unpriced: unpricedGammaCount },
    levels: gexValid ? { callWall, putWall, gammaFlip: gammaFlip != null ? +gammaFlip.toFixed(0) : null, pin } : { callWall: null, putWall: null, gammaFlip: null, pin: null },
    flipInputs: flipInputs({ weight: "oi_plus_quarter_volume", universe: "single-expiry", expiryKeys: [nearestKey] }),
    weightTotals: { oi: totalOI, volume: totalVol },
    path,
    strikes: rows.map(r => ({ strike: r.strike, gex: +r.gex.toFixed(0), callOI: r.callOI, putOI: r.putOI })),
    // Additive (0DTE map): every re-priced zero crossing of this expiry's
    // net gamma within +-5% (the long-gamma band is read off these), the
    // session open from the chain's underlying, and the band of strikes used.
    gammaCrossings: gexValid ? flipObj.zeroCrossings.map((x) => +x.toFixed(2)) : null,
    sessionOpen: Number.isFinite(Number(chain.underlying?.openPrice)) && Number(chain.underlying?.openPrice) > 0 ? Number(chain.underlying.openPrice) : null,
    priorClose: bars.priorClose ?? (Number.isFinite(Number(chain.underlying?.close)) && Number(chain.underlying?.close) > 0 ? Number(chain.underlying.close) : null),
    strikeBandPct: 3,
  } };
}
