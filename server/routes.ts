import type { Express } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import {
  getAuthUrl, exchangeCodeForTokens, getSchwabStatus, clearTokens,
  getQuotes as schwabGetQuotes, getPriceHistory as schwabGetPriceHistory,
  getOptionChain as schwabGetOptionChain, computeGEXFromChain,
  startTokenRefreshCycle,
} from "./schwab";
import {
  yahooQuote, cboeSpyChain, buildGammaStructure, cnnFearGreed,
  gatherSocial, fetchHeadlines,
} from "./sources";
import { computeComposite } from "./composite";
import { fetchAllVoices, factCheckItem, listVoices, computeVoicesBias } from "./voices";
import { xEnabled } from "./x";
import { fetchIntraday, fetchPrevDayOHLC } from "./quotes";
import { buildPivotBundle } from "./pivots";
import { buildGammaMap, computeSqueezeIndicator, buildDailyPlaybook } from "./playbook";
import { buildRegimeSnapshot, type WindowKey } from "./regime";
import { buildSectorWeb } from "./sector-web";
import { buildWefThemes } from "./wef-themes";
import { buildMacroSnapshot, type MacroResponse } from "./macro";
import { fetchOHLC, type OHLCResponse, type Timeframe, type Interval } from "./ohlc";
import { snapshotHorizon, gradeOutcomes, empiricalStats, masterAlphaStats } from "./mmPredictions";
import { startMmScheduler } from "./mmScheduler";
import { startDiscordScheduler } from "./discordScheduler";
import { fireTestCard, postDailyModelCard } from "./discord";
import { postSelzDailyCard } from "./discordSelzCard";
import { postCalibrationCard } from "./calibrationCard";
import { rollingBrier, settleDay } from "./calibration";
import { buildMag7Snapshot, type Mag7Response } from "./mag7";
import { buildFlowSnapshot, buildIntradayFlowSnapshot, type FlowResponse } from "./flow";
import { buildExposuresSnapshot, type ExposuresResponse } from "./exposures";
import { buildUnusualFlow, type UnusualFlowResponse } from "./unusualFlow";
import { buildNewsSnapshot, type NewsResponse } from "./news";
import { buildEconWeek, type EconWeek } from "./econWeek";
import { buildModelsSnapshot, type ModelsResponse, type Horizon } from "./models";
import type { Snapshot_Public, VolMetric } from "@shared/schema";
import { readCache, writeCache, rthSessionKey } from "./sessionCache";
import { buildSeasonalitySnapshot, fetchBars, computeSeasonality, generateAnalysisText } from "./seasonality";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { buildJPMCollarSnapshot, getCachedSpxCloses } from "./jpmCollar";
import { buildVolCalendar } from "./volCalendar";
import { buildGammaLevelsEnhanced } from "./gammaLevels";
import { runBackfill, getBacktestSummary } from "./backtest";
import { buildChainAudit } from "./chainAudit";
import { buildHeatseeker } from "./heatseeker";
import { getCboeChain } from "./cboeCache";

// ─── CBOE → Schwab chain shape adapter ─────────────────────────────────
// Heatseeker (and other consumers) expect Schwab's callExpDateMap /
// putExpDateMap format. CBOE returns a flat options[] array with OCC
// option symbols (e.g. "SPY260427C00500000"). This adapter parses the
// OCC symbol, infers expiry + strike + side, and rebuilds the Schwab
// shape so a stale CBOE chain can power Heatseeker on weekends/holidays
// when Schwab is not connected.
function cboeChainToSchwab(cboe: any, symbol: string): any {
  const inner = cboe?.data?.data ?? cboe?.data ?? cboe;
  const opts: any[] = inner?.options ?? [];
  const spot = inner?.current_price ?? inner?.close ?? null;
  const callExpDateMap: Record<string, Record<string, any[]>> = {};
  const putExpDateMap: Record<string, Record<string, any[]>> = {};
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (const o of opts) {
    // OCC: ROOT (var) + YYMMDD (6) + C/P (1) + STRIKE*1000 (8)
    const occ: string = String(o.option || "");
    const m = occ.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!m) continue;
    const [, , yymmdd, cp, strikeRaw] = m;
    const yy = parseInt(yymmdd.slice(0, 2), 10);
    const mm = parseInt(yymmdd.slice(2, 4), 10);
    const dd = parseInt(yymmdd.slice(4, 6), 10);
    const expDate = new Date(Date.UTC(2000 + yy, mm - 1, dd));
    const dte = Math.max(0, Math.round((expDate.getTime() - today.getTime()) / 86_400_000));
    const isoDate = `${2000 + yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    const expKey = `${isoDate}:${dte}`;
    const strike = parseInt(strikeRaw, 10) / 1000;
    const strikeKey = strike.toFixed(2).replace(/\.?0+$/, (s) => s.includes(".") ? s : "");
    // Schwab contract shape that buildHeatseeker reads
    const contract = {
      strikePrice: strike,
      openInterest: Number(o.open_interest) || 0,
      totalVolume: Number(o.volume) || 0,
      volatility: (Number(o.iv) || 0) * 100, // CBOE iv is decimal, Schwab is %
      gamma: Number(o.gamma) || 0,
      delta: Number(o.delta) || 0,
      vega: Number(o.vega) || 0,
      theta: Number(o.theta) || 0,
      bid: Number(o.bid) || 0,
      ask: Number(o.ask) || 0,
      last: Number(o.last_trade_price) || 0,
    };
    const target = cp === "C" ? callExpDateMap : putExpDateMap;
    if (!target[expKey]) target[expKey] = {};
    if (!target[expKey][strikeKey]) target[expKey][strikeKey] = [];
    target[expKey][strikeKey].push(contract);
  }
  return {
    symbol,
    underlying: { last: spot, bid: inner?.bid ?? null, ask: inner?.ask ?? null },
    callExpDateMap,
    putExpDateMap,
  };
}
import { masterAlphaRoute } from "./masterAlpha";
import {
  buildCosmosSnapshot,
  fetchNoaaKp,
  taxonomyLiveStates,
  TAXONOMY,
  BOOKS,
  ACADEMIC_PAPERS,
  EDGE_RULES,
  HONEST_EDGE_ASSESSMENT,
  buildWeeklyOutlook,
  buildMonthlyOutlook,
  OUTLOOK_SYSTEM_PROMPT,
} from "./cosmos";
import {
  startOdteTracker, getOdteSnapshot, armPosition, disarmPosition,
  getSparkline, getTracked, getContractChart,
} from "./odteTracker";
import { buildDeterministicAlphaBrief } from "./alphaEngine";
import { getEarnings } from "./earnings";

function vm(symbol: string, name: string, last: number | null, prev: number | null): VolMetric {
  const changePct = last != null && prev ? ((last - prev) / prev) * 100 : null;
  return { symbol, name, value: last, prev, changePct };
}

let inflight: Promise<Snapshot_Public> | null = null;
let lastResult: { at: number; data: Snapshot_Public } | null = null;
const CACHE_MS = 60_000; // refresh at most once per minute

// Shared voices cache (used by both /api/voices and composite)
let voicesCache: { at: number; data: any } | null = null;
const VOICES_CACHE_MS = 15 * 60_000; // 15 min keeps us well under X 10k/mo quota

async function buildSnapshot(): Promise<Snapshot_Public> {
  const warnings: string[] = [];

  const [vix, vvix, vix9d, vix3m, skew, spy, chain, fg, social, headlines] = await Promise.all([
    yahooQuote("^VIX"),
    yahooQuote("^VVIX"),
    yahooQuote("^VIX9D"),
    yahooQuote("^VIX3M"),
    yahooQuote("^SKEW"),
    yahooQuote("SPY"),
    cboeSpyChain().catch((e) => { warnings.push(`CBOE chain: ${e.message}`); return null; }),
    cnnFearGreed(),
    gatherSocial().catch((e) => { warnings.push(`Social: ${e.message}`); return { score: 0, bullish: 0, bearish: 0, neutral: 0, posts: [] }; }),
    fetchHeadlines(),
  ]);

  if (!chain) throw new Error("Options chain unavailable");

  const gamma = buildGammaStructure(chain);
  const term = {
    vix9d: vix9d.last,
    vix: vix.last,
    vix3m: vix3m.last,
    ratio9dOver30d: vix.last && vix9d.last ? vix9d.last / vix.last : null,
    ratio30dOver3m: vix3m.last && vix.last ? vix.last / vix3m.last : null,
  };

  const partial: Omit<Snapshot_Public, "composite"> = {
    capturedAt: Math.floor(Date.now() / 1000),
    spy: {
      price: spy.last ?? gamma.spot,
      prevClose: spy.prev ?? 0,
      changePct: spy.last && spy.prev ? ((spy.last - spy.prev) / spy.prev) * 100 : 0,
    },
    vol: {
      vix:  vm("^VIX",  "VIX (30-day implied vol)", vix.last,  vix.prev),
      vvix: vm("^VVIX", "VVIX (Vol-of-Vol)",        vvix.last, vvix.prev),
      vix9d:vm("^VIX9D","VIX9D (9-day)",            vix9d.last,vix9d.prev),
      vix3m:vm("^VIX3M","VIX3M (3-month)",          vix3m.last,vix3m.prev),
      skew: vm("^SKEW", "CBOE SKEW",                skew.last, skew.prev),
    },
    term,
    gamma,
    social,
    fearGreed: fg,
    aaii: null, // could be wired later via Thursday-released CSV
    headlines,
    warnings,
  };

  // Pull a cheap voicesBias if we have a warm cache. Never force-fetch here
  // — keeping snapshot + voices refreshes independent protects our X quota.
  let voicesBias: { score: number; sampleSize: number } | null = null;
  if (voicesCache?.data?.items) {
    voicesBias = computeVoicesBias(voicesCache.data.items);
  }
  const composite = computeComposite(partial, voicesBias);
  const full: Snapshot_Public = { ...partial, composite };
  await storage.saveSnapshot({
    capturedAt: full.capturedAt,
    payload: JSON.stringify(full),
  });
  return full;
}

async function getOrBuild(force = false): Promise<Snapshot_Public> {
  if (!force && lastResult && Date.now() - lastResult.at < CACHE_MS) return lastResult.data;
  if (inflight) return inflight;
  inflight = buildSnapshot()
    .then((d) => { lastResult = { at: Date.now(), data: d }; inflight = null; return d; })
    .catch(async (e) => {
      inflight = null;
      // Fallback to last stored snapshot
      const last = await storage.getLatestSnapshot();
      if (last) return JSON.parse(last.payload) as Snapshot_Public;
      throw e;
    });
  return inflight;
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.get("/api/snapshot", async (_req, res) => {
    try {
      const data = await getOrBuild(false);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build snapshot" });
    }
  });

  app.post("/api/snapshot/refresh", async (_req, res) => {
    try {
      const data = await getOrBuild(true);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to refresh" });
    }
  });

  // Voices — curated analyst feed with data-relevance ranking + live fact-check
  app.get("/api/voices", async (_req, res) => {
    try {
      if (voicesCache && Date.now() - voicesCache.at < VOICES_CACHE_MS) {
        return res.json(voicesCache.data);
      }
      const [{ voices, items }, snap] = await Promise.all([
        fetchAllVoices(),
        getOrBuild(false),
      ]);
      const liveMetrics = {
        vix: snap.vol.vix.value ?? 0,
        vvix: snap.vol.vvix.value ?? 0,
        spy: snap.spy.price ?? 0,
        skew: snap.vol.skew.value ?? 0,
        pcr: snap.gamma.pcrOi ?? 0,
      };
      for (const it of items) factCheckItem(it, liveMetrics);
      const bias = computeVoicesBias(items);
      const payload = {
        voices, items, liveMetrics,
        xEnabled: xEnabled(),
        voicesBias: bias,
        capturedAt: Math.floor(Date.now() / 1000),
      };
      voicesCache = { at: Date.now(), data: payload };
      res.json(payload);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to fetch voices" });
    }
  });

  app.get("/api/voices/list", (_req, res) => {
    res.json({ voices: listVoices() });
  });

  // Trade Desk — SPX/SPY/VIX intraday + pivots + gamma map + squeeze + playbook
  let tradeCache: { at: number; range: "1d" | "5d"; data: any } | null = null;
  const TRADE_CACHE_MS = 30_000;

  app.get("/api/trade-desk", async (req, res) => {
    try {
      const range = (req.query.range === "5d" ? "5d" : "1d") as "1d" | "5d";
      const interval = range === "5d" ? "5m" : "1m";
      if (tradeCache && tradeCache.range === range && Date.now() - tradeCache.at < TRADE_CACHE_MS) {
        return res.json(tradeCache.data);
      }

      // Fetch the three intraday series + prior-day OHLC for each (for pivots),
      // plus the main snapshot (for gamma, term, vix, composite, voices bias).
      const [spx, spy, vix, spxPrev, spyPrev, vixPrev, snap, voicesData] = await Promise.all([
        fetchIntraday("^GSPC", range, interval).catch((e) => { console.warn("[trade-desk] SPX:", e.message); return null; }),
        fetchIntraday("SPY",   range, interval).catch((e) => { console.warn("[trade-desk] SPY:", e.message); return null; }),
        fetchIntraday("^VIX",  range, interval).catch((e) => { console.warn("[trade-desk] VIX:", e.message); return null; }),
        fetchPrevDayOHLC("^GSPC").catch(() => null),
        fetchPrevDayOHLC("SPY").catch(() => null),
        fetchPrevDayOHLC("^VIX").catch(() => null),
        getOrBuild(false),
        Promise.resolve(voicesCache?.data ?? null),
      ]);

      const spxPivots = spxPrev ? buildPivotBundle("^GSPC", spxPrev) : null;
      const spyPivots = spyPrev ? buildPivotBundle("SPY",   spyPrev) : null;
      const vixPivots = vixPrev ? buildPivotBundle("^VIX",  vixPrev) : null;

      // Gamma map is SPY-based (that's our options-chain source).
      const spyLast = spy?.price ?? snap.spy.price;
      const baseGammaMap = buildGammaMap(snap.gamma, spyLast);
      // Pass through the Perfiliev gamma profile + legacy crossover strike so the
      // Trade Desk UI can render the full curve.
      const gammaMap = {
        ...baseGammaMap,
        gammaProfile: snap.gamma.gammaProfile,
        gexCrossoverStrike: snap.gamma.gexCrossoverStrike,
      };

      const squeeze = computeSqueezeIndicator({
        spot: spyLast,
        gamma: snap.gamma,
        term: snap.term,
        vix: snap.vol.vix,
        vvix: snap.vol.vvix,
        skew: snap.vol.skew,
      });

      // Pull today's catalyst events for news-aware playbook (best-effort)
      let todaysEvents: Array<{ kind: string; label: string; timeLabel?: string }> = [];
      try {
        const { buildNewsSnapshot } = await import("./news");
        const news = await buildNewsSnapshot();
        const todayIso = new Date().toISOString().slice(0, 10);
        todaysEvents = (news.calendar ?? [])
          .filter((e: any) => e.date === todayIso)
          .map((e: any) => ({
            kind: e.kind,
            label: e.label || e.title || "",
            timeLabel: e.timeLabel || "",
          }));
      } catch (e) {
        // non-fatal
      }

      const playbook = buildDailyPlaybook({
        spot: spyLast,
        gamma: snap.gamma,
        pivots: spyPivots,
        term: snap.term,
        vix: snap.vol.vix,
        compositeScore: snap.composite.score,
        compositeLabel: snap.composite.label,
        voicesBiasScore: voicesData?.voicesBias?.score ?? null,
        squeeze,
        todaysEvents,
      });

      const payload = {
        capturedAt: Math.floor(Date.now() / 1000),
        range,
        interval,
        quotes: { spx, spy, vix },
        pivots: { spx: spxPivots, spy: spyPivots, vix: vixPivots },
        gammaMap,
        squeeze,
        playbook,
        composite: { score: snap.composite.score, label: snap.composite.label },
        voicesBias: voicesData?.voicesBias ?? null,
      };
      tradeCache = { at: Date.now(), range, data: payload };
      res.json(payload);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build trade desk" });
    }
  });

  // Regime Rotation Tracker — 4-axis emerging-theme engine with 30-min cache
  let regimeCache: Map<WindowKey, { at: number; data: any }> = new Map();
  const REGIME_CACHE_MS = 30 * 60_000;

  // Macro carousel — cross-asset quotes grouped by category for ticker tape + carousel.
  // 60s cache keeps us safe on Yahoo rate limits (we hit ~25 symbols per refresh).
  let macroCache: { at: number; data: MacroResponse } | null = null;
  const MACRO_CACHE_MS = 10_000; // 10s cache — near-realtime ticker tape
  app.get("/api/macro", async (_req, res) => {
    try {
      if (macroCache && Date.now() - macroCache.at < MACRO_CACHE_MS) {
        return res.json(macroCache.data);
      }
      const data = await buildMacroSnapshot();
      macroCache = { at: Date.now(), data };
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build macro snapshot" });
    }
  });

  // OHLC candlestick endpoint — 30s cache per (symbol, timeframe) pair.
  // Real-time on the client via polling.
  const ohlcCache = new Map<string, { at: number; data: OHLCResponse }>();
  const OHLC_CACHE_MS = 15_000; // 15s cache — keeps candles near-realtime without hammering Yahoo
  app.get("/api/ohlc", async (req, res) => {
    try {
      const symbol = String(req.query.symbol || "").trim().toUpperCase();
      const tf = (String(req.query.tf || "1D").toUpperCase() as Timeframe);
      const rawInterval = String(req.query.interval || "").trim().toLowerCase();
      const validTfs: Timeframe[] = ["1D", "5D", "1M", "3M", "1Y", "5Y"];
      const validIntervals: Interval[] = ["1m", "2m", "5m", "15m", "30m", "60m", "1h", "1d", "1wk", "1mo"];
      if (!symbol) return res.status(400).json({ message: "symbol required" });
      if (!validTfs.includes(tf)) return res.status(400).json({ message: "invalid tf" });
      const interval = (rawInterval && validIntervals.includes(rawInterval as Interval))
        ? (rawInterval as Interval) : undefined;
      const key = `${symbol}::${tf}::${interval ?? "auto"}`;
      const hit = ohlcCache.get(key);
      if (hit && Date.now() - hit.at < OHLC_CACHE_MS) {
        return res.json(hit.data);
      }
      const data = await fetchOHLC(symbol, tf, interval);
      ohlcCache.set(key, { at: Date.now(), data });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to fetch OHLC" });
    }
  });

  // Put/Call flow ratio — index + Mag 7 aggregate, intraday ring buffer.
  let flowCache: { at: number; data: FlowResponse } | null = null;
  const FLOW_CACHE_MS = 10_000;
  app.get("/api/flow", async (_req, res) => {
    try {
      if (flowCache && Date.now() - flowCache.at < FLOW_CACHE_MS) {
        return res.json(flowCache.data);
      }
      const data = await buildFlowSnapshot();
      flowCache = { at: Date.now(), data };
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build flow snapshot" });
    }
  });

  // Intraday call/put volume time-series — rolling sampler per ticker.
  // Resets daily. Returns real data once 2+ samples accumulated, else synthesized.
  let intradayFlowCache: { at: number; data: any } | null = null;
  const INTRADAY_FLOW_CACHE_MS = 60_000; // 1 min cache
  app.get("/api/flow-intraday", async (_req, res) => {
    try {
      if (intradayFlowCache && Date.now() - intradayFlowCache.at < INTRADAY_FLOW_CACHE_MS) {
        return res.json(intradayFlowCache.data);
      }
      const data = await buildIntradayFlowSnapshot();
      intradayFlowCache = { at: Date.now(), data };
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build intraday flow" });
    }
  });

  // Forward-model engine — Daily / Weekly / Monthly projected price paths.
  // Cached 5 minutes in-memory; persisted to disk on every successful build so
  // the app can serve last-close snapshots after hours.
  const modelsCache = new Map<string, { at: number; data: ModelsResponse }>();
  // In-flight build deduplication. When the cache is cold and N concurrent
  // requests arrive, we only run the expensive Schwab chain pull + dealer-map
  // computation ONCE; the rest await the same promise. Prevents cache
  // stampedes that would otherwise rate-limit our upstream feeds.
  const modelsInFlight = new Map<string, Promise<ModelsResponse>>();
  // 30-min refresh cadence — model rebuilds every half hour during RTH so the
  // BULL / BASE / BEAR scenarios stay near-real-time without thrashing the
  // options chain (Schwab/CBOE are rate-limited).
  const MODELS_CACHE_MS = 30 * 60_000;

  async function buildModelsForKey(symbol: "SPY" | "^GSPC", experimental: boolean): Promise<ModelsResponse> {
    const cacheKey = `${symbol}${experimental ? ":exp" : ""}`;
    // Cache hit
    const cached = modelsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MODELS_CACHE_MS) return cached.data;
    // Existing build in flight
    const pending = modelsInFlight.get(cacheKey);
    if (pending) return pending;
    // Start a new build
    const buildPromise = (async () => {
      const snap = await getOrBuild(false).catch(() => null);
      const data = await buildModelsSnapshot({
        vix: snap?.vol.vix.value ?? null,
        vixPrev: snap?.vol.vix.prev ?? null,
        vix3m: snap?.vol.vix3m.value ?? null,
        symbols: [symbol],
        experimental,
      });
      await writeCache(`models-${symbol}${experimental ? "-exp" : ""}-${rthSessionKey()}`, data);
      modelsCache.set(cacheKey, { at: Date.now(), data });
      return data;
    })().finally(() => {
      // Always clear the in-flight slot so the NEXT cold miss can run
      modelsInFlight.delete(cacheKey);
    });
    modelsInFlight.set(cacheKey, buildPromise);
    return buildPromise;
  }
  app.get("/api/models", async (req, res) => {
    try {
      const symbol = (String(req.query.symbol ?? "^GSPC").toUpperCase() === "SPY" ? "SPY" : "^GSPC") as "SPY" | "^GSPC";
      // Dealer-map kinds (vanna flip, zomma bridge, charm target, neg-γ
      // entry, upper/lower vomma) are now always on — they're core levels,
      // not experimental. ?experimental=0 can still disable them explicitly.
      const experimental = String(req.query.experimental ?? "1") !== "0";
      const data = await buildModelsForKey(symbol, experimental);
      res.json(data);
    } catch (e: any) {
      // On failure — serve last persisted session snapshot for today, tagged.
      try {
        const symbol = (String(req.query.symbol ?? "^GSPC").toUpperCase() === "SPY" ? "SPY" : "^GSPC") as "SPY" | "^GSPC";
        const experimental = String(req.query.experimental ?? "") === "1";
        const stale = await readCache<ModelsResponse>(`models-${symbol}${experimental ? "-exp" : ""}-${rthSessionKey()}`);
        if (stale) {
          stale.session = "last-close";
          stale.warnings = [...(stale.warnings ?? []), `Live build failed: ${e?.message ?? e} — serving last RTH close.`];
          return res.json(stale);
        }
      } catch {}
      res.status(503).json({ message: e?.message ?? "Failed to build models" });
    }
  });

  // ───── MM-matrix prediction logger ─────
  // POST /api/mm-snapshot — capture current cell probabilities for each horizon.
  // Reuses the /api/models cache if fresh to avoid rebuilding.
  app.post("/api/mm-snapshot", async (req, res) => {
    try {
      const symbol = (String(req.body?.symbol ?? "^GSPC").toUpperCase() === "SPY" ? "SPY" : "^GSPC") as "SPY" | "^GSPC";
      const requested: string[] = Array.isArray(req.body?.horizons) ? req.body.horizons : ["daily", "weekly"];

      // Reuse the shared cache + in-flight dedup helper
      const models = await buildModelsForKey(symbol, true);

      const snaps: any[] = [];
      for (const h of requested) {
        const horizon = (models.horizons as any)[h];
        if (!horizon) continue;
        const row = await snapshotHorizon(horizon, h);
        if (row) snaps.push(row);
      }
      res.json({ ok: true, snapshots: snaps });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "snapshot failed" });
    }
  });

  // POST /api/mm-grade — fill forward outcomes for any ungraded snapshots whose
  // session has closed. Pulls daily ^GSPC closes from Yahoo via fetchOHLC.
  app.post("/api/mm-grade", async (_req, res) => {
    try {
      const daily = await fetchOHLC("^GSPC", "1Y", "1d");
      const closeByDate = new Map<string, number>();
      for (const bar of daily.candles ?? []) {
        const d = new Date(bar.t * 1000);
        const nyDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year: "numeric", month: "2-digit", day: "2-digit",
        }).format(d);
        closeByDate.set(nyDate, bar.c);
      }
      const result = await gradeOutcomes(async (sessionDate) => closeByDate.get(sessionDate) ?? null);
      res.json({ ok: true, ...result, coveredDates: closeByDate.size });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "grade failed" });
    }
  });

  // GET /api/mm-stats — empirical (regime, zone) stats vs priors
  app.get("/api/mm-stats", async (_req, res) => {
    try {
      const stats = await empiricalStats();
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "stats failed" });
    }
  });

  // GET /api/master-alpha-stats — backtest aggregates of masterAlpha signals vs realized moves
  app.get("/api/master-alpha-stats", async (_req, res) => {
    try {
      const stats = await masterAlphaStats();
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "master-alpha stats failed" });
    }
  });

  // Master Alpha — unified formula r̂ = TW · regimeMult · Σ wᵢ·rᵢ
  // Integrates charm (BLW β·z·sd), vanna amplifier, GEX regime, GTBR, overnight drift.
  // Calibrated per horizon (daily/weekly/monthly/quarterly) against user's pivot bundle.
  app.post("/api/master-alpha", masterAlphaRoute);
  app.get("/api/master-alpha", masterAlphaRoute);

  // Dealer exposure profiles — DEX / GEX / VEX / Charm across ±10% spot band.
  // Per-symbol cache with 5-minute TTL (exposures are structural, not tick-level).
  // On upstream CBOE errors, serve stale data if we have it — keeps the UI useful
  // even when CBOE is rate-limiting.
  const exposuresCache = new Map<string, { at: number; data: ExposuresResponse }>();
  const EXPOSURES_CACHE_MS = 5 * 60_000;
  app.get("/api/exposures", async (req, res) => {
    const symbol = String(req.query.symbol ?? "SPY").toUpperCase();
    const cached = exposuresCache.get(symbol);
    if (cached && Date.now() - cached.at < EXPOSURES_CACHE_MS) {
      return res.json(cached.data);
    }
    try {
      const data = await buildExposuresSnapshot(symbol);
      exposuresCache.set(symbol, { at: Date.now(), data });
      res.json(data);
    } catch (e: any) {
      // Stale-fallback: serve old cached data if we have any, tagged with warning.
      if (cached) {
        const staleMin = Math.round((Date.now() - cached.at) / 60_000);
        const stale = {
          ...cached.data,
          meta: {
            ...cached.data.meta,
            warnings: [...cached.data.meta.warnings, `Upstream CBOE unavailable (${e?.message ?? "error"}); serving ${staleMin} min stale data.`],
          },
        };
        return res.json(stale);
      }
      res.status(503).json({ message: e?.message ?? `Failed to build exposures for ${symbol}` });
    }
  });

  // Unusual options flow — CBOE-derived, Schwab-ready stub.
  const unusualFlowCache = new Map<string, { at: number; data: UnusualFlowResponse }>();
  const UNUSUAL_FLOW_CACHE_MS = 60_000;
  app.get("/api/flow/unusual", async (req, res) => {
    const symbol = String(req.query.symbol ?? "SPY").toUpperCase();
    const cached = unusualFlowCache.get(symbol);
    if (cached && Date.now() - cached.at < UNUSUAL_FLOW_CACHE_MS) {
      return res.json(cached.data);
    }
    try {
      const data = await buildUnusualFlow(symbol);
      unusualFlowCache.set(symbol, { at: Date.now(), data });
      res.json(data);
    } catch (e: any) {
      if (cached) return res.json(cached.data);
      res.status(503).json({ message: e?.message ?? `Failed to build unusual flow for ${symbol}` });
    }
  });

  // News snapshot — RSS headlines + econ calendar merged.
  let newsCache: { at: number; data: NewsResponse } | null = null;
  const NEWS_CACHE_MS = 3 * 60_000;
  app.get("/api/news", async (_req, res) => {
    try {
      if (newsCache && Date.now() - newsCache.at < NEWS_CACHE_MS) {
        return res.json(newsCache.data);
      }
      const data = await buildNewsSnapshot();
      newsCache = { at: Date.now(), data };
      res.json(data);
    } catch (e: any) {
      if (newsCache) return res.json(newsCache.data);
      res.status(503).json({ message: e?.message ?? "Failed to build news snapshot" });
    }
  });

  // Per-week macro + earnings event grid for the Models chart's top event band.
  // Cached 5 min — events don't move often.
  const econWeekCache = new Map<string, { at: number; data: EconWeek }>();
  const ECON_WEEK_CACHE_MS = 5 * 60_000;
  app.get("/api/econ-week", async (req, res) => {
    try {
      const monParam = typeof req.query.from === "string" ? req.query.from : undefined;
      const cacheKey = monParam ?? "auto";
      const cached = econWeekCache.get(cacheKey);
      if (cached && Date.now() - cached.at < ECON_WEEK_CACHE_MS) {
        return res.json(cached.data);
      }
      const data = await buildEconWeek(monParam);
      econWeekCache.set(cacheKey, { at: Date.now(), data });
      res.json(data);
    } catch (e: any) {
      res.status(503).json({ message: e?.message ?? "Failed to build econ week" });
    }
  });

  // Mag 7 indicator — equal-weight basket vs SPY with breadth + 4W return.
  let mag7Cache: { at: number; data: Mag7Response } | null = null;
  const MAG7_CACHE_MS = 15_000;
  app.get("/api/mag7", async (_req, res) => {
    try {
      if (mag7Cache && Date.now() - mag7Cache.at < MAG7_CACHE_MS) {
        return res.json(mag7Cache.data);
      }
      const data = await buildMag7Snapshot();
      mag7Cache = { at: Date.now(), data };
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build Mag7 snapshot" });
    }
  });

  // Gamma levels extractor — pulls from the live SPY snapshot. Returns null levels
  // for non-SPY symbols (options chain only wired for SPY right now).
  app.get("/api/gamma-levels", async (req, res) => {
    try {
      const symbol = String(req.query.symbol || "SPY").trim().toUpperCase();
      if (symbol !== "SPY" && symbol !== "^GSPC" && symbol !== "SPX") {
        return res.json({ symbol, supported: false, levels: null });
      }
      const snap = await getOrBuild(false);
      const g = snap.gamma;
      res.json({
        symbol: "SPY",
        supported: true,
        spot: snap.spy.price ?? g.spot,
        levels: {
          callWall: g.callWall,
          callWallGex: g.callWallGex,
          putWall: g.putWall,
          putWallGex: g.putWallGex,
          zeroGamma: g.zeroGamma,
          flip: g.zeroGamma, // alias: zeroGamma IS the gamma-flip level (Perfiliev)
          maxPain: g.maxPain,
          totalGex: g.totalGex,
          regime: g.totalGex >= 0 ? "positive" : "negative",
          profile: g.profile, // strike-level GEX within ±$60
        },
        asOf: snap.capturedAt,
      });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to fetch gamma levels" });
    }
  });

  app.get("/api/regime", async (req, res) => {
    try {
      const w = (req.query.window === "w13" ? "w13" : req.query.window === "w52" ? "w52" : "w4") as WindowKey;
      const hit = regimeCache.get(w);
      if (hit && Date.now() - hit.at < REGIME_CACHE_MS) {
        return res.json(hit.data);
      }
      const data = await buildRegimeSnapshot(w);
      regimeCache.set(w, { at: Date.now(), data });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build regime snapshot" });
    }
  });

  // Reactive sector web — 11 GICS sectors + leader satellites + correlation edges.
  // Serves both the force-graph and the deep heatmap grid below it. 10-min cache.
  app.get("/api/sector-web", async (_req, res) => {
    try {
      const data = await buildSectorWeb();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build sector web" });
    }
  });

  // WEF theme mapper — scans weforum.org content, maps themes to ticker baskets,
  // filters each basket by 1M relative strength vs SPY to surface "stocks
  // following the narrative." 2-hour cache.
  app.get("/api/wef-themes", async (_req, res) => {
    try {
      const web = await buildSectorWeb();
      // Feed WEF mapper a ticker→r1m map built from the sector web's nodes.
      const r1m = new Map<string, number>();
      for (const n of web.sectors) r1m.set(n.symbol, n.r1m);
      for (const l of web.leaders) r1m.set(l.symbol, l.r1m);
      r1m.set("SPY", web.spy.r1m);
      const data = await buildWefThemes({ r1m, spy1m: web.spy.r1m });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build WEF themes" });
    }
  });

  // Lightweight live quotes endpoint — SPY + VIX, 5s poll-friendly.
  // Reuses lastResult cache so it never triggers a full snapshot rebuild.
  let quotesCache: { at: number; data: { spy: { price: number | null; changePct: number | null }; vix: { price: number | null; changePct: number | null }; timestamp: number } } | null = null;
  const QUOTES_CACHE_MS = 4_000; // 4s so 5s client poll always gets fresh data
  app.get("/api/quotes", async (_req, res) => {
    try {
      if (quotesCache && Date.now() - quotesCache.at < QUOTES_CACHE_MS) {
        return res.json(quotesCache.data);
      }
      // Use parallel Yahoo fetches — fast, ~100ms each
      const [spy, vix] = await Promise.all([
        yahooQuote("SPY"),
        yahooQuote("^VIX"),
      ]);
      const spyChangePct = spy.last && spy.prev ? ((spy.last - spy.prev) / spy.prev) * 100 : null;
      const vixChangePct = vix.last && vix.prev ? ((vix.last - vix.prev) / vix.prev) * 100 : null;
      const data = {
        spy: { price: spy.last, changePct: spyChangePct },
        vix: { price: vix.last, changePct: vixChangePct },
        timestamp: Date.now(),
      };
      quotesCache = { at: Date.now(), data };
      res.json(data);
    } catch (e: any) {
      // Fallback to snapshot cache
      if (lastResult) {
        const s = lastResult.data;
        return res.json({
          spy: { price: s.spy.price, changePct: s.spy.changePct },
          vix: { price: s.vol.vix.value, changePct: s.vol.vix.changePct },
          timestamp: lastResult.at,
        });
      }
      res.status(500).json({ message: e?.message ?? "Failed to fetch quotes" });
    }
  });

  // ---- Seasonality: 20-year monthly + weekly avg return patterns ----
  // 24-hour cache (historical data doesn't change intraday). Heavy fetch.
  app.get("/api/seasonality", async (req, res) => {
    try {
      const lookbackParam = req.query.lookback;
      const lookback = lookbackParam ? Number(lookbackParam) : undefined;
      const validLookback = lookback && [5, 10, 20].includes(lookback) ? lookback : undefined;
      const data = await buildSeasonalitySnapshot(validLookback);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build seasonality" });
    }
  });

  // ---- Seasonality: per-symbol ticker lookup (any Yahoo symbol) ----
  // In-memory cache: symbol -> { at, data }, 24hr TTL.
  const symbolSeasonalityCache = new Map<string, { at: number; data: any }>();
  const SYMBOL_SEASON_TTL = 24 * 60 * 60 * 1000;

  app.get("/api/seasonality/:symbol", async (req, res) => {
    try {
      const rawSymbol = String(req.params.symbol ?? "").toUpperCase().trim();
      // Allow: letters, digits, ^, -, ., =
      if (!rawSymbol || rawSymbol.length > 20 || !/^[A-Z0-9^\-.=]+$/.test(rawSymbol)) {
        return res.status(400).json({ message: "Invalid symbol" });
      }
      const lookbackParam = Number(req.query.lookback ?? 20);
      const lookback = [5, 10, 20].includes(lookbackParam) ? lookbackParam : 20;
      const cacheKey = `${rawSymbol}:${lookback}`;

      // Check cache
      const cached = symbolSeasonalityCache.get(cacheKey);
      if (cached && Date.now() - cached.at < SYMBOL_SEASON_TTL) {
        return res.json(cached.data);
      }

      // Fetch + compute
      const bars = await fetchBars(rawSymbol);
      if (bars.length < 50) {
        return res.status(404).json({ message: `No historical data found for ${rawSymbol}` });
      }

      const computed = computeSeasonality(bars, lookback);
      const yearly = { ...computed.yearly };
      yearly.analysisText = generateAnalysisText(
        rawSymbol,
        yearly.optimalWindow,
        { fullYearAvg: yearly.fullYearAvg, fullYearWinRate: yearly.fullYearWinRate, presidentialCycleYear: yearly.presidentialCycleYear, presidentialCycleAvg: yearly.presidentialCycleAvg, lookbackYears: computed.lookbackYears } as any,
        computed.lookbackYears,
      );

      const ticker = { symbol: rawSymbol, displayName: rawSymbol, ...computed, yearly };
      const response = { tickers: [ticker], asOf: new Date().toISOString() };

      symbolSeasonalityCache.set(cacheKey, { at: Date.now(), data: response });
      res.json(response);
    } catch (e: any) {
      console.error("[seasonality/:symbol]", e?.message);
      res.status(500).json({ message: e?.message ?? "Failed to compute seasonality" });
    }
  });

  // ---- EOD Setup: deterministic brief (always) + optional LLM enhancers ----
  //
  // DESIGN:
  //   1. Deterministic brief is ALWAYS computed from live dealer-gamma inputs
  //      (same data the rest of the app uses). No external API calls, no keys,
  //      no 500s. This is the source of truth — "strongest power of financial
  //      calcs" principle: trust the numbers we already compute.
  //   2. LLM paths (Claude / GPT) are OPTIONAL enhancers. They only run when
  //      their respective env keys are present. Missing keys = null output,
  //      never a 500.
  //   3. Response shape: { deterministic, claude, gpt, errors } so the UI can
  //      show all three side-by-side or fall back to deterministic alone.

  // --- Deterministic brief builder ---
  // Pure function of the inputs — NO network, NO keys, NO randomness.
  // Produces the same markdown structure the LLMs are prompted to emit,
  // so the UI doesn't have to switch layouts based on which engine ran.
  function buildDeterministicEodBrief(input: {
    spx: number; vix: number; iv: number; qscore: number;
    gex: number; callWall: number; putWall: number;
    zeroGamma: number; hvl: number; gammaFlip: number;
    upside: number; downside: number; t2up: number; t2down: number;
    mopex: number; vanna: number; zomma: number; charm: number;
    negGamma: number; upperVomma: number; lowerVomma: number;
    pcRatio: number; opex: boolean;
    regime?: string; notes?: string;
  }): string {
    const {
      spx, vix, iv, qscore, gex, callWall, putWall, zeroGamma, hvl, gammaFlip,
      upside, downside, t2up, t2down, mopex, vanna, zomma, charm,
      negGamma, upperVomma, lowerVomma, pcRatio, opex, notes,
    } = input;

    const qBucket = qscore < 30 ? "PINNED" : qscore < 60 ? "MIXED" : "FRAGILE";
    // 1-day expected move: SPX * IV / sqrt(252). IV is in percent.
    const oneDayEm = spx > 0 && iv > 0 ? (spx * (iv / 100)) / Math.sqrt(252) : 0;
    const emUpper = spx + oneDayEm;
    const emLower = spx - oneDayEm;

    // GEX regime classification
    const gexRegime = gex > 0 ? "POSITIVE (pinned/mean-reverting)" : gex < 0 ? "NEGATIVE (fragile/trending)" : "FLAT";

    // Directional bias from zero-gamma relationship
    const aboveZg = spx > zeroGamma;
    const zgDist = spx - zeroGamma;
    const bias = qBucket === "PINNED"
      ? `mean-reversion toward HVL/${hvl.toFixed(0)}`
      : aboveZg
        ? `long-bias while above zero-\u03b3 ${zeroGamma.toFixed(0)}, momentum accelerates on break below`
        : `short-bias while below zero-\u03b3 ${zeroGamma.toFixed(0)}, covering risk on break above`;

    // Pick the PRIMARY setup from the 4 archetypes using the gamma regime + distances
    const distToCallWall = callWall - spx;
    const distToPutWall = spx - putWall;
    const distToZg = Math.abs(zgDist);

    type Setup = {
      type: string; direction: string; structure: string;
      trigger: string; target: string; stop: string; size: string; horizon: string;
    };

    let primary: Setup;
    const alternates: Setup[] = [];

    // Helper to format a vertical spread string
    const verticalBuy = (long: number, short: number, side: "call" | "put") =>
      `SPX ${long.toFixed(0)}/${short.toFixed(0)} ${side} debit spread`;
    const verticalSell = (short: number, long: number, side: "call" | "put") =>
      `SPX ${short.toFixed(0)}/${long.toFixed(0)} ${side} credit spread`;

    if (qBucket === "PINNED" && distToZg <= Math.max(5, oneDayEm * 0.4)) {
      // GAMMA PIN — price is inside the dealer-pin zone
      primary = {
        type: "GAMMA PIN",
        direction: aboveZg ? "short fade" : "long fade",
        structure: aboveZg
          ? verticalSell(Math.round(spx + 5), Math.round(spx + 15), "call")
          : verticalSell(Math.round(spx - 5), Math.round(spx - 15), "put"),
        trigger: `price rotates away from zero-\u03b3 ${zeroGamma.toFixed(0)} by \u2265 3 pts then stalls`,
        target: `back to HVL ${hvl.toFixed(0)} / zero-\u03b3 ${zeroGamma.toFixed(0)}`,
        stop: aboveZg
          ? `close above ${Math.round(spx + 20)} (invalidates pin)`
          : `close below ${Math.round(spx - 20)} (invalidates pin)`,
        size: opex ? "0.5-1% (OPEX haircut)" : vix > 25 ? "1% (VIX>25 haircut)" : "2% max",
        horizon: "enter 2:30-3:00 ET, close by 3:55 ET",
      };
      alternates.push({
        type: "MEAN REVERSION",
        direction: aboveZg ? "short" : "long",
        structure: `fade to ${hvl.toFixed(0)} via same-side credit spread`,
        trigger: "1D EM extension hit", target: `HVL ${hvl.toFixed(0)}`,
        stop: "break of 1D EM band", size: "1%", horizon: "intraday",
      });
    } else if (distToCallWall > 0 && distToCallWall < Math.max(8, oneDayEm * 0.6) && qBucket !== "FRAGILE") {
      // WALL REJECTION @ call wall — approaching from below
      primary = {
        type: "WALL REJECTION",
        direction: "short",
        structure: verticalSell(Math.round(callWall), Math.round(callWall + 15), "call"),
        trigger: `tag of call wall ${callWall.toFixed(0)} with fail to close above`,
        target: `zero-\u03b3 ${zeroGamma.toFixed(0)} / HVL ${hvl.toFixed(0)}`,
        stop: `close above ${Math.round(callWall + 5)}`,
        size: opex ? "1% (OPEX)" : vix > 25 ? "1% (VIX>25)" : "2%",
        horizon: "enter on rejection wick, exit by 3:55",
      };
      alternates.push({
        type: "FLIP BREAKOUT", direction: "long",
        structure: verticalBuy(Math.round(callWall), Math.round(callWall + 20), "call"),
        trigger: `break + hold above ${callWall.toFixed(0)}`,
        target: `T2 UP ${t2up.toFixed(0)}`, stop: `close back below ${Math.round(callWall - 3)}`,
        size: "1%", horizon: "intraday runner",
      });
    } else if (distToPutWall > 0 && distToPutWall < Math.max(8, oneDayEm * 0.6) && qBucket !== "FRAGILE") {
      // WALL REJECTION @ put wall — approaching from above
      primary = {
        type: "WALL REJECTION",
        direction: "long",
        structure: verticalSell(Math.round(putWall), Math.round(putWall - 15), "put"),
        trigger: `tag of put wall ${putWall.toFixed(0)} with fail to close below`,
        target: `zero-\u03b3 ${zeroGamma.toFixed(0)} / HVL ${hvl.toFixed(0)}`,
        stop: `close below ${Math.round(putWall - 5)}`,
        size: opex ? "1% (OPEX)" : vix > 25 ? "1% (VIX>25)" : "2%",
        horizon: "enter on rejection wick, exit by 3:55",
      };
      alternates.push({
        type: "FLIP BREAKOUT", direction: "short",
        structure: verticalBuy(Math.round(putWall), Math.round(putWall - 20), "put"),
        trigger: `break + hold below ${putWall.toFixed(0)}`,
        target: `T2 DOWN ${t2down.toFixed(0)}`, stop: `close back above ${Math.round(putWall + 3)}`,
        size: "1%", horizon: "intraday runner",
      });
    } else if (qBucket === "FRAGILE" || gex < 0) {
      // FLIP BREAKOUT — negative or fragile gamma = momentum regime
      primary = {
        type: "FLIP BREAKOUT",
        direction: aboveZg ? "long" : "short",
        structure: aboveZg
          ? verticalBuy(Math.round(spx), Math.round(callWall), "call")
          : verticalBuy(Math.round(spx), Math.round(putWall), "put"),
        trigger: aboveZg
          ? `break + hold above gamma-flip ${gammaFlip.toFixed(0)}`
          : `break + hold below gamma-flip ${gammaFlip.toFixed(0)}`,
        target: aboveZg ? `call wall ${callWall.toFixed(0)}` : `put wall ${putWall.toFixed(0)}`,
        stop: `close back through gamma-flip ${gammaFlip.toFixed(0)}`,
        size: opex ? "0.5% (fragile + OPEX)" : vix > 25 ? "1% (fragile + VIX>25)" : "1.5%",
        horizon: "enter 2:00-3:00, hard exit 3:55",
      };
      alternates.push({
        type: "MEAN REVERSION", direction: aboveZg ? "short" : "long",
        structure: `fade any extension past 1D EM (${emLower.toFixed(0)} / ${emUpper.toFixed(0)})`,
        trigger: "EM-band tag + stall", target: `HVL ${hvl.toFixed(0)}`,
        stop: "continuation through EM", size: "0.5%", horizon: "quick scalp",
      });
    } else {
      // MIXED regime default — mean reversion back to HVL
      primary = {
        type: "MEAN REVERSION",
        direction: spx > hvl ? "short fade" : "long fade",
        structure: spx > hvl
          ? verticalSell(Math.round(spx + 5), Math.round(spx + 20), "call")
          : verticalSell(Math.round(spx - 5), Math.round(spx - 20), "put"),
        trigger: `SPX at \u22651D EM extension from HVL ${hvl.toFixed(0)}`,
        target: `HVL ${hvl.toFixed(0)} / zero-\u03b3 ${zeroGamma.toFixed(0)}`,
        stop: spx > hvl ? `close above ${emUpper.toFixed(0)} (1D EM upper)` : `close below ${emLower.toFixed(0)} (1D EM lower)`,
        size: opex ? "1% (OPEX)" : vix > 25 ? "1% (VIX>25)" : "2%",
        horizon: "enter 2:30-3:00 ET, manage into close",
      };
      alternates.push({
        type: "WALL REJECTION",
        direction: distToCallWall < distToPutWall ? "short" : "long",
        structure: distToCallWall < distToPutWall
          ? verticalSell(Math.round(callWall), Math.round(callWall + 15), "call")
          : verticalSell(Math.round(putWall), Math.round(putWall - 15), "put"),
        trigger: "nearest wall tag",
        target: `HVL ${hvl.toFixed(0)}`, stop: "close through the wall",
        size: "1%", horizon: "intraday",
      });
    }

    // Confidence: tighter when regime is clear, looser when mixed or late
    const confidence =
      qBucket === "PINNED" && distToZg <= 5 ? "HIGH" :
      qBucket === "FRAGILE" ? "MEDIUM" :
      qBucket === "MIXED" ? "MEDIUM" :
      "MEDIUM";
    const confidenceReason =
      qBucket === "PINNED" ? `dealer positioning pins spot inside the gamma zone (Q ${qscore})` :
      qBucket === "FRAGILE" ? `fragile regime (Q ${qscore}) \u2014 direction-of-break matters more than level` :
      `mixed regime (Q ${qscore}) \u2014 scale position accordingly`;

    // Build the KEY LEVELS table. Only include weekly targets within ~1.5x EM of spot.
    const bandRange = Math.max(40, oneDayEm * 1.5);
    const weeklyTargets: Array<{ name: string; strike: number; role: string }> = [
      { name: "UPSIDE T1", strike: upside, role: "weekly upper target" },
      { name: "DOWNSIDE T1", strike: downside, role: "weekly lower target" },
      { name: "T2 UP", strike: t2up, role: "secondary upper" },
      { name: "T2 DOWN", strike: t2down, role: "secondary lower" },
      { name: "MOPEX", strike: mopex, role: "monthly OPEX pin" },
      { name: "VANNA", strike: vanna, role: "vanna level" },
      { name: "ZOMMA", strike: zomma, role: "zomma level" },
      { name: "CHARM", strike: charm, role: "charm pin" },
      { name: "NEG \u03b3", strike: negGamma, role: "neg-gamma threshold" },
      { name: "UPPER VOMMA", strike: upperVomma, role: "upper vomma" },
      { name: "LOWER VOMMA", strike: lowerVomma, role: "lower vomma" },
    ].filter((t) => Math.abs(t.strike - spx) <= bandRange)
      .sort((a, b) => Math.abs(a.strike - spx) - Math.abs(b.strike - spx));

    const levelRows: string[] = [
      `| Call Wall | ${callWall.toFixed(0)} | dealer call-side wall | ${(callWall - spx).toFixed(1)} |`,
      `| Put Wall | ${putWall.toFixed(0)} | dealer put-side wall | ${(putWall - spx).toFixed(1)} |`,
      `| Zero Gamma | ${zeroGamma.toFixed(1)} | dealer gamma flip | ${(zeroGamma - spx).toFixed(1)} |`,
      `| HVL | ${hvl.toFixed(0)} | highest gamma-vol strike | ${(hvl - spx).toFixed(1)} |`,
      `| Gamma Flip | ${gammaFlip.toFixed(1)} | sign-change threshold | ${(gammaFlip - spx).toFixed(1)} |`,
      ...weeklyTargets.map((t) => `| ${t.name} | ${t.strike.toFixed(0)} | ${t.role} | ${(t.strike - spx).toFixed(1)} |`),
    ];

    // Compose the markdown brief matching the LLM OUTPUT FORMAT contract.
    const brief = [
      `## REGIME SUMMARY`,
      `SPX ${spx.toFixed(2)} \u00b7 VIX ${vix.toFixed(2)} \u00b7 1D IV ${iv.toFixed(2)}% \u00b7 1D EM \u00b1${oneDayEm.toFixed(1)} (${emLower.toFixed(0)}\u2013${emUpper.toFixed(0)}). Dealer GEX ${gex > 0 ? "+" : ""}${gex.toFixed(2)}B \u2014 ${gexRegime}. Q-Score ${qscore} (${qBucket}). Spot is ${aboveZg ? "above" : "below"} zero-\u03b3 by ${Math.abs(zgDist).toFixed(1)} pts. Bias: ${bias}. Intraday P/C ${pcRatio.toFixed(2)}${opex ? " \u2014 OPEX today, size down 30-50%" : ""}${vix > 25 ? " \u2014 VIX>25, size down 50%" : ""}.`,
      ``,
      `## KEY LEVELS`,
      `| Level | Strike | Role | Distance |`,
      `|---|---|---|---|`,
      ...levelRows,
      ``,
      `## PRIMARY SETUP`,
      `- Type: ${primary.type}`,
      `- Direction: ${primary.direction}`,
      `- Structure: ${primary.structure}`,
      `- Entry trigger: ${primary.trigger}`,
      `- Target: ${primary.target}`,
      `- Stop: ${primary.stop}`,
      `- Size: ${primary.size}`,
      `- Time horizon: ${primary.horizon}`,
      ``,
      `## INVALIDATION`,
      `- Close beyond the stop level above.`,
      `- Hard cutoff 3:45 PM ET \u2014 no new entries, manage only.`,
      `- Regime flip (Q-Score crosses ${qBucket === "PINNED" ? "above 30 into MIXED" : qBucket === "MIXED" ? "below 30 (PINNED) or above 60 (FRAGILE)" : "below 60 into MIXED"}).`,
      gex > 0
        ? `- Total GEX flips negative intraday (positive \u2192 fragile regime).`
        : `- Total GEX flips positive intraday (fragile \u2192 pinned).`,
      `- VIX spike above 25 \u2192 cut size 50%.`,
      ``,
      `## CONFIDENCE`,
      `${confidence} \u2014 ${confidenceReason}.`,
      ``,
      `## ALTERNATE SETUPS`,
      ...alternates.map((a, i) => `${i + 1}. ${a.type} (${a.direction}): ${a.structure}. Trigger: ${a.trigger}. Target: ${a.target}. Stop: ${a.stop}. Size: ${a.size}.`),
      notes && notes.trim() ? `\n_Trader notes: ${notes.trim()}_` : "",
    ].join("\n").trim();

    return brief;
  }

  const EOD_SYSTEM_PROMPT = `You are an institutional 0DTE SPX EOD trading assistant. You build end-of-day setups for SPX 0DTE options between 2:00 PM and 3:55 PM ET with a hard cutoff at 3:45 PM ET for new entries.

CORE FRAMEWORK
- Dealer gamma positioning drives intraday mean-reversion vs trend. Positive GEX = pinned/mean-reverting; Negative GEX = fragile/trending.
- Key levels (in order): Call Wall, Put Wall, Zero Gamma (flip), HVL, Gamma Flip. Levels hold until they don't — watch for rejection or acceptance above/below.
- Q-Score (0-100): 0-30 pinned regime, 30-60 mixed, 60-100 fragile. Use this to bias aggressiveness.
- 1D Expected Move: SPX × IV / sqrt(252). Stay inside 1D EM unless fragile regime with catalyst.

SESSION TIME MODEL (ET)
- 2:00-2:30: Positioning window — read tape, identify dominant level.
- 2:30-3:00: Setup window — best time to enter.
- 3:00-3:45: Last-entry window — only high-conviction setups.
- 3:45 HARD CUTOFF: No new entries. Manage only.
- 3:55-4:00: Exit / let runner go.
- Optional DTT prime roots: 2:09, 3:07, 3:53 PM (you may reference as confluence but not required).

SETUP TYPES (pick ONE primary, note alternates)
1. GAMMA PIN — Price stuck near high-gamma strike, positive GEX. Fade moves back to pin. Lower risk, lower reward.
2. WALL REJECTION — Price tests Call Wall or Put Wall and fails. Fade back toward HVL or Zero Gamma.
3. FLIP BREAKOUT — Price crosses Zero Gamma / Gamma Flip with momentum. Trade in direction of flip, targets next wall.
4. MEAN REVERSION — Price extended from HVL in pinned regime. Fade to HVL.

RISK RULES (non-negotiable)
- Max loss per trade: 2% of account.
- Hard 3:45 PM ET cutoff for new positions.
- If VIX > 25: size down 50%.
- If OPEX today: size down 30-50%.
- No naked short options. Defined-risk only (verticals, condors, flies).

OUTPUT FORMAT (use exactly these sections, markdown headers)

## REGIME SUMMARY
One paragraph: dealer positioning, Q-Score bucket, 1D EM, bias.

## KEY LEVELS
Markdown table with columns: Level | Strike | Role | Distance from spot.
Include Call Wall, Put Wall, Zero Gamma, HVL, Gamma Flip, and user's weekly targets that are in-range.

## PRIMARY SETUP
- Type: [one of the 4 setups]
- Direction: [long/short/neutral]
- Structure: [specific spread, e.g. "SPX 7100/7110 call debit spread"]
- Entry trigger: [price/time condition]
- Target: [level and price]
- Stop: [invalidation price]
- Size: [% of account, respecting risk rules]
- Time horizon: [enter window, exit plan]

## INVALIDATION
Bullet list of conditions that kill the setup.

## CONFIDENCE
HIGH / MEDIUM / LOW with one-sentence reason.

## ALTERNATE SETUPS
Briefly note 1-2 backup ideas if primary invalidates.

Be precise. No hedging language. If inputs are insufficient, say so and stop — do not invent data.`;

  app.post("/api/eod-setup", async (req, res) => {
    try {
      const {
        spx, vix, iv, qscore,
        gex, callWall, putWall, zeroGamma, hvl, gammaFlip,
        upside = 7140, downside = 6950, t2up = 7270, t2down = 6885,
        mopex = 7025, vanna = 7089, zomma = 7070, charm = 7128,
        negGamma = 7100, upperVomma = 7265, lowerVomma = 6960,
        pcRatio, opex = false,
        regime,
        notes = "",
      } = req.body;

      const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
      const qBucket = Number(qscore) < 30 ? "PINNED" : Number(qscore) < 60 ? "MIXED" : "FRAGILE";

      const userBrief = `CURRENT MARKET STATE (${now})

SPX: ${spx}
VIX: ${vix}
1D IV: ${iv}%
Q-Score: ${qscore} (${qBucket})

DEALER POSITIONING
Total GEX: $${gex}B
Call Wall: ${callWall}
Put Wall: ${putWall}
Zero Gamma: ${zeroGamma}
HVL: ${hvl}
Gamma Flip: ${gammaFlip}

USER WEEKLY TARGETS (locked)
UPSIDE ${upside} / DOWNSIDE ${downside}
T2 UP ${t2up} / T2 DOWN ${t2down}
MOPEX ${mopex}
VANNA ${vanna} / ZOMMA ${zomma} / CHARM ${charm}
NEG \u03b3 ${negGamma}
UPPER VOMMA ${upperVomma} / LOWER VOMMA ${lowerVomma}

SESSION
Intraday P/C: ${pcRatio}
OPEX today: ${opex ? "YES \u2014 size down 30-50%" : "no"}

TRADER NOTES
${notes || "(none)"}

Build the EOD setup brief.`;

      // ---- DETERMINISTIC BRIEF (always runs, always returns) ----
      // This is the source of truth. Built from the exact same dealer-gamma
      // inputs the rest of the app uses. No external API, no key, no failure mode.
      const deterministic = buildDeterministicEodBrief({
        spx: Number(spx) || 0,
        vix: Number(vix) || 0,
        iv: Number(iv) || 0,
        qscore: Number(qscore) || 0,
        gex: Number(gex) || 0,
        callWall: Number(callWall) || 0,
        putWall: Number(putWall) || 0,
        zeroGamma: Number(zeroGamma) || 0,
        hvl: Number(hvl) || 0,
        gammaFlip: Number(gammaFlip) || 0,
        upside: Number(upside), downside: Number(downside),
        t2up: Number(t2up), t2down: Number(t2down),
        mopex: Number(mopex), vanna: Number(vanna),
        zomma: Number(zomma), charm: Number(charm),
        negGamma: Number(negGamma),
        upperVomma: Number(upperVomma), lowerVomma: Number(lowerVomma),
        pcRatio: Number(pcRatio) || 0,
        opex: Boolean(opex),
        regime,
        notes,
      });

      // ---- OPTIONAL LLM ENHANCERS ----
      // Only run when keys are present. Never throw — swallow errors into the
      // `errors` field so the client still gets the deterministic brief.
      //
      // To enable these, set OPENAI_API_KEY and/or ANTHROPIC_API_KEY in the
      // server environment. Neither is required for EOD setup to work.
      const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
      const hasOpenAiKey = !!process.env.OPENAI_API_KEY;

      const claudePromise = hasAnthropicKey
        ? (async () => {
            try {
              const anthropic = new Anthropic();
              const msg = await anthropic.messages.create({
                model: "claude_sonnet_4_6",
                max_tokens: 4096,
                system: EOD_SYSTEM_PROMPT,
                messages: [{ role: "user", content: userBrief }],
              });
              const block = msg.content.find((b) => b.type === "text");
              return (block as any)?.text ?? "";
            } catch (e: any) {
              throw new Error(e?.message ?? "claude call failed");
            }
          })()
        : Promise.reject(new Error("ANTHROPIC_API_KEY not configured"));

      const gptPromise = hasOpenAiKey
        ? (async () => {
            try {
              const openai = new OpenAI();
              const r: any = await (openai.responses as any).create({
                model: "gpt_5_1",
                input: `${EOD_SYSTEM_PROMPT}\n\n---\n\n${userBrief}`,
              });
              return r.output_text ?? "";
            } catch (e: any) {
              throw new Error(e?.message ?? "gpt call failed");
            }
          })()
        : Promise.reject(new Error("OPENAI_API_KEY not configured"));

      const [claudeResult, gptResult] = await Promise.allSettled([claudePromise, gptPromise]);

      res.json({
        deterministic,
        claude: claudeResult.status === "fulfilled" ? claudeResult.value : null,
        gpt: gptResult.status === "fulfilled" ? gptResult.value : null,
        errors: {
          claude: claudeResult.status === "rejected" ? String((claudeResult as any).reason?.message ?? claudeResult.reason) : null,
          gpt: gptResult.status === "rejected" ? String((gptResult as any).reason?.message ?? gptResult.reason) : null,
        },
        meta: {
          llmEnhancersEnabled: { claude: hasAnthropicKey, gpt: hasOpenAiKey },
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (e: any) {
      console.error("[eod-setup]", e?.message);
      res.status(500).json({ message: e?.message ?? "EOD setup failed" });
    }
  });

  // ---- JPM Collar: hardcoded quarterly strikes + live SPX distance ----
  // 1-hour in-memory cache (see jpmCollar.ts)
  app.get("/api/jpm-collar", async (_req, res) => {
    try {
      const [collar, spxCloses] = await Promise.all([
        buildJPMCollarSnapshot(),
        getCachedSpxCloses(),
      ]);
      res.json({ ...collar, spxCloses });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build JPM collar" });
    }
  });

  // ---- Vol Event Calendar: OPEX, VIX exp, quad witching, FOMC, CPI, NFP ----
  // Computed per request (pure date math, no external calls).
  app.get("/api/vol-calendar", (_req, res) => {
    try {
      const data = buildVolCalendar();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build vol calendar" });
    }
  });

  // ---- ALPHA: AI market-intelligence agent ----
  // POST /api/alpha-brief — sifts news feed + web search, ranks by market impact.
  // Uses Claude Opus with web_search tool (falls back to knowledge-only if tool unavailable).
  const ALPHA_SYSTEM_PROMPT = `You are ALPHA — an institutional market-intelligence agent for active traders. Your job: sift the day's critical news and rank it by expected market impact.

SCOPE (what matters)
- Geopolitics: war, sanctions, OPEC decisions, trade disputes, major elections, terrorism affecting markets.
- Rates / Fed: FOMC decisions, Fed speeches (esp. Powell, Williams, Waller), CPI/PCE/NFP prints, Treasury auctions, BOJ/ECB moves.
- Insider activity: large Form 4 buys or sells, cluster buys in a single name, executive departures.
- Sentiment / positioning: VIX regime shifts, funding spreads, AAII/NAAIM extremes, put-call extremes.
- Corporate: mega-cap earnings (MAG7), guidance cuts, M&A announcements, major layoffs.

SKIP
- Opinion pieces with no new information.
- Routine earnings from non-index-movers.
- Re-hashed stories from last week.

SCORING (Impact 1-10)
10 = Immediate, broad-based index move (e.g. surprise Fed cut, major war escalation)
8-9 = Strong sector rotation or index-level move within a day
6-7 = Notable for specific names or sectors, may spill to index
4-5 = Worth watching, developing story
1-3 = Background noise

DIRECTION: Bullish / Bearish / Two-sided / Mixed
HORIZON: Intraday / Days / Weeks / Structural

OUTPUT FORMAT (markdown, exactly these sections)

## ALPHA BRIEF — [today's date, ET]

One-paragraph tape summary: the single most important thing a trader needs to know right now.

## RANKED IMPACT

A markdown table with columns exactly:
| Rank | Event | Category | Impact | Direction | Horizon | Tickers |

Sort by Impact desc. Include at least 5 items, up to 12. Tickers = comma-separated (e.g. SPY, XLE, CL=F). Category = one of: GEOPOLITICS, RATES/FED, INSIDER, SENTIMENT, CORPORATE.

## TRADE IMPLICATIONS

3-5 bullets. Concrete. Reference specific levels, setups, or pairs if possible. Tie back to dealer gamma regime when relevant.

## WATCH LIST

- Upcoming catalysts in next 48h (date + event)
- Key levels / prints traders need on the screen

## CAVEATS

1-2 lines on what's unclear or could flip the read.

Be precise. No hedging language. No filler. If news feed is empty or stale, say so and work from live search only.`;

  app.post("/api/alpha-brief", async (req, res) => {
    try {
      const { newsItems = [] } = req.body || {};
      const items = Array.isArray(newsItems) ? newsItems : [];

      // 1) Deterministic brief — ALWAYS runs, always returns content.
      const deterministic = buildDeterministicAlphaBrief(items);

      // 2) LLM enhancers — opt-in based on env keys. Never throw.
      const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
      const hasOpenAiKey = !!process.env.OPENAI_API_KEY;

      const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
      const itemLines = (items as Array<{ title: string; source?: string; time?: string; summary?: string; url?: string }>)
        .slice(0, 30)
        .map((n, i) => `${i + 1}. [${n.source ?? "?"}, ${n.time ?? "?"}] ${n.title}${n.summary ? " — " + n.summary : ""}`)
        .join("\n");

      const userBrief = `CURRENT TIME: ${now} ET

EXISTING NEWS FEED (${items.length} items):
${itemLines || "(empty)"}

DETERMINISTIC BASELINE:
${deterministic}

TASK
Refine the brief above. Search the web for any critical developments the feed is missing — geopolitics, rates/Fed, insider buys, sentiment/positioning. Tighten the tape summary. Re-rank if needed. Return the FULL brief in the same markdown structure. Be concrete, no filler.`;

      const claudePromise = hasAnthropicKey
        ? (async () => {
            try {
              const anthropic = new Anthropic();
              let response: Awaited<ReturnType<typeof anthropic.messages.create>>;
              let mode: "with_search" | "knowledge_only" = "with_search";
              try {
                response = await anthropic.messages.create({
                  model: "claude_opus_4_7",
                  max_tokens: 4096,
                  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }] as any,
                  system: ALPHA_SYSTEM_PROMPT,
                  messages: [{ role: "user", content: userBrief }],
                });
              } catch (toolErr: any) {
                mode = "knowledge_only";
                response = await anthropic.messages.create({
                  model: "claude_opus_4_7",
                  max_tokens: 4096,
                  system: ALPHA_SYSTEM_PROMPT,
                  messages: [{ role: "user", content: userBrief + "\n\n(Note: live web search unavailable — use news feed + knowledge.)" }],
                });
              }
              const text = response.content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("\n\n");
              return { text, mode };
            } catch (e: any) {
              throw new Error(e?.message ?? "claude call failed");
            }
          })()
        : Promise.reject(new Error("ANTHROPIC_API_KEY not configured"));

      const gptPromise = hasOpenAiKey
        ? (async () => {
            try {
              const openai = new OpenAI();
              const r: any = await (openai.responses as any).create({
                model: "gpt_5_1",
                input: `${ALPHA_SYSTEM_PROMPT}\n\n---\n\n${userBrief}`,
              });
              return r.output_text ?? "";
            } catch (e: any) {
              throw new Error(e?.message ?? "gpt call failed");
            }
          })()
        : Promise.reject(new Error("OPENAI_API_KEY not configured"));

      const [claudeResult, gptResult] = await Promise.allSettled([claudePromise, gptPromise]);

      // Legacy shape (brief + mode) preserved for back-compat. The deterministic
      // brief becomes the "brief" field when no LLM is configured; otherwise
      // Claude's version wins (with web_search if available), then GPT, then
      // deterministic fallback.
      let brief = deterministic;
      let mode: "with_search" | "knowledge_only" | "deterministic" = "deterministic";
      if (claudeResult.status === "fulfilled") {
        brief = claudeResult.value.text || deterministic;
        mode = claudeResult.value.mode;
      } else if (gptResult.status === "fulfilled" && gptResult.value) {
        brief = gptResult.value;
        mode = "knowledge_only";
      }

      res.json({
        brief,
        mode,
        deterministic,
        claude: claudeResult.status === "fulfilled" ? claudeResult.value.text : null,
        gpt: gptResult.status === "fulfilled" ? gptResult.value : null,
        llmEnhancersEnabled: hasAnthropicKey || hasOpenAiKey,
        errors: {
          claude: claudeResult.status === "rejected" ? String((claudeResult as any).reason?.message ?? claudeResult.reason) : null,
          gpt: gptResult.status === "rejected" ? String((gptResult as any).reason?.message ?? gptResult.reason) : null,
        },
      });
    } catch (err: any) {
      console.error("[alpha-brief]", err?.message);
      res.status(500).json({ error: err?.message ?? "ALPHA brief failed" });
    }
  });

  // ---- Earnings calendar — weekly + monthly ----
  app.get("/api/earnings", async (req, res) => {
    try {
      const horizon = String(req.query.horizon ?? "weekly").toLowerCase() === "monthly" ? "monthly" : "weekly";
      const out = await getEarnings(horizon);
      res.json(out);
    } catch (err: any) {
      console.error("[earnings]", err?.message);
      res.status(500).json({ error: err?.message ?? "earnings fetch failed" });
    }
  });

  // ---- Enhanced gamma levels: computed + user weekly targets ----
  // Augments the existing /api/gamma-levels with vanna/charm/vomma/zomma user targets.
  app.get("/api/gamma-levels-enhanced", async (req, res) => {
    try {
      const symbol = String(req.query.symbol || "SPY").trim().toUpperCase();
      if (symbol !== "SPY" && symbol !== "^GSPC" && symbol !== "SPX") {
        return res.json({ symbol, supported: false, levels: null });
      }
      const snap = await getOrBuild(false);
      const g = snap.gamma;
      const spxNow = snap.spy.price ?? g.spot; // Use SPY price units to match computed chain levels
      const enhanced = buildGammaLevelsEnhanced(g, spxNow);
      res.json({ symbol: "SPY", supported: true, enhanced, asOf: snap.capturedAt });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build enhanced gamma levels" });
    }
  });

  // Background refresh cadence for voices (X-aware).
  // 10 handles × ~10 tweets per refresh ≈ up to 10 reads/handle + 10 user lookups
  // (cached 14d). With 15-min cache = 4/hr * 24 * 30 = 2880 refreshes/month.
  // But since_id incremental + empty windows keep actual read count well below
  // the 10k/mo limit on Basic. Warm the cache on boot.
  (async () => {
    try {
      const [{ voices, items }, snap] = await Promise.all([
        fetchAllVoices(),
        getOrBuild(false).catch(() => null),
      ]);
      const liveMetrics = snap ? {
        vix: snap.vol.vix.value ?? 0,
        vvix: snap.vol.vvix.value ?? 0,
        spy: snap.spy.price ?? 0,
        skew: snap.vol.skew.value ?? 0,
        pcr: snap.gamma.pcrOi ?? 0,
      } : { vix: 0, vvix: 0, spy: 0, skew: 0, pcr: 0 };
      for (const it of items) factCheckItem(it, liveMetrics);
      voicesCache = {
        at: Date.now(),
        data: {
          voices, items, liveMetrics,
          xEnabled: xEnabled(),
          voicesBias: computeVoicesBias(items),
          capturedAt: Math.floor(Date.now() / 1000),
        },
      };
      console.log(`[voices] warmed cache: ${items.length} items, X ${xEnabled() ? "enabled" : "disabled"}`);
    } catch (e: any) {
      console.warn("[voices] warmup failed:", e?.message || e);
    }
  })();


  // ─── Schwab OAuth endpoints ───────────────────────────────────────────────

  app.get("/api/schwab/auth-url", (_req, res) => {
    try {
      const url = getAuthUrl();
      res.json({ url });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Failed to build auth URL" });
    }
  });

  app.post("/api/schwab/callback", async (req, res) => {
    try {
      const { redirectedUrl } = req.body as { redirectedUrl?: string };
      if (!redirectedUrl) return res.status(400).json({ message: "redirectedUrl required" });
      const url = new URL(redirectedUrl);
      const code = url.searchParams.get("code");
      if (!code) return res.status(400).json({ message: "No code found in URL" });
      const result = await exchangeCodeForTokens(code);
      if (!result.ok) return res.status(400).json({ message: result.error });
      res.json({ ok: true, status: getSchwabStatus() });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Callback failed" });
    }
  });

  app.get("/api/schwab/status", (_req, res) => {
    try {
      res.json(getSchwabStatus());
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Status check failed" });
    }
  });

  app.post("/api/schwab/disconnect", (_req, res) => {
    try {
      clearTokens();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Disconnect failed" });
    }
  });

  // ─── Market data endpoints (Schwab primary, Yahoo fallback) ───────────────

  app.get("/api/market/quotes", async (req, res) => {
    try {
      const symbolsParam = String(req.query.symbols || "SPY,VIX");
      const symbols = symbolsParam.split(",").map((s) => s.trim()).filter(Boolean);
      const quotes = await schwabGetQuotes(symbols);
      const source = quotes.length > 0 ? quotes[0].source : "yahoo";
      res.json({ quotes, source, asOf: Date.now() });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Quotes fetch failed" });
    }
  });

  app.get("/api/market/price-history/:symbol", async (req, res) => {
    try {
      const symbol = String(req.params.symbol).toUpperCase();
      const periodType = (req.query.periodType as any) || "year";
      const period = parseInt(String(req.query.period || "1"));
      const frequencyType = (req.query.frequencyType as any) || "daily";
      const frequency = parseInt(String(req.query.frequency || "1"));
      const data = await schwabGetPriceHistory(symbol, periodType, period, frequencyType, frequency);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Price history failed" });
    }
  });

  app.get("/api/market/option-chain/:symbol", async (req, res) => {
    try {
      const rawParam = String(req.params.symbol).toUpperCase();
      // Schwab expects "$SPX" (not "SPX" or "$SPX.X") for the cash index option chain.
      const symbol =
        rawParam === "SPX" || rawParam === "^GSPC" || rawParam === "$SPX.X"
          ? "$SPX"
          : rawParam;
      const dte = req.query.dte !== undefined ? parseInt(String(req.query.dte)) : undefined;
      const chain = await schwabGetOptionChain(symbol, dte);
      if ("error" in chain) {
        return res.status(503).json(chain);
      }
      // Augment with computed GEX levels
      const gex = computeGEXFromChain(chain);
      res.json({ ...chain, gex });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Option chain fetch failed" });
    }
  });

  // ─── Chain Audit: 10 institutional computations ─────────────────────────────
  // In-memory 30-second cache keyed by "symbol-dte"
  const chainAuditCache = new Map<string, { at: number; data: any }>();
  const CHAIN_AUDIT_CACHE_MS = 30_000;

  app.get("/api/chain-audit", async (req, res) => {
    try {
      const rawSymbol = String(req.query.symbol || "$SPX").trim();
      const dte = req.query.dte !== undefined ? parseInt(String(req.query.dte)) : 60;
      const symbol = rawSymbol.toUpperCase();
      const cacheKey = `${symbol}-${dte}`;

      // Serve from cache if fresh
      const cached = chainAuditCache.get(cacheKey);
      if (cached && Date.now() - cached.at < CHAIN_AUDIT_CACHE_MS) {
        return res.json(cached.data);
      }

      // Fetch chain — Schwab required, no fallback
      let chain = await schwabGetOptionChain(symbol, dte);
      let usedSymbol = symbol;

      if ("error" in chain) {
        // Try SPY fallback if SPX-like symbol fails
        const isSPX = symbol.includes("SPX") || symbol === "$SPX" || symbol === "SPXW";
        if (isSPX) {
          const spyChain = await schwabGetOptionChain("SPY", dte);
          if ("error" in spyChain) {
            return res.status(503).json({
              error: "schwab_required",
              message: "Schwab connection required for chain audit. Please connect Schwab in Settings.",
            });
          }
          chain = spyChain;
          usedSymbol = "SPY";
        } else {
          return res.status(503).json({
            error: "schwab_required",
            message: "Schwab connection required for chain audit. Please connect Schwab in Settings.",
          });
        }
      }

      const spot = chain.underlying.last ??
        (chain.underlying.bid && chain.underlying.ask
          ? (chain.underlying.bid + chain.underlying.ask) / 2
          : null);

      if (!spot || spot <= 0) {
        return res.status(503).json({
          error: "no_spot",
          message: "Unable to determine underlying spot price from chain data.",
        });
      }

      const audit = buildChainAudit(chain, spot);

      const payload = {
        symbol: usedSymbol,
        requestedSymbol: symbol,
        spot,
        asOf: Date.now(),
        audit,
      };

      chainAuditCache.set(cacheKey, { at: Date.now(), data: payload });
      res.json(payload);
    } catch (e: any) {
      console.error("[chain-audit]", e?.message);
      res.status(500).json({ error: "internal", message: e?.message ?? "Chain audit failed" });
    }
  });

  // ─── Heatseeker: 0DTE live Greeks + sticky zones ────────────────────────────
  // 5-second cache — matches frontend polling cadence
  const heatseekerCache = new Map<string, { at: number; data: any }>();
  const HEATSEEKER_CACHE_MS = 5_000;

  app.get("/api/heatseeker", async (req, res) => {
    try {
      const rawSymbol = String(req.query.symbol || "$SPX").trim();
      const symbol = rawSymbol.toUpperCase();
      const cacheKey = symbol;

      const cached = heatseekerCache.get(cacheKey);
      if (cached && Date.now() - cached.at < HEATSEEKER_CACHE_MS) {
        return res.json(cached.data);
      }

      // Fetch chain with 2-day DTE window so we always catch 0DTE + next expiry.
      // Schwab is the live source; CBOE (cached on disk, weekend-tolerant) is
      // the fallback so Heatseeker stays useful when Schwab isn't connected
      // or Schwab API is rate-limiting after hours.
      let chain: any = await schwabGetOptionChain(symbol, 2);
      let usedSymbol = symbol;
      let scaleToSPX = false; // when true, SPY-derived chain rescaled ×10 to SPX values

      const isSPX = symbol.includes("SPX") || symbol === "$SPX" || symbol === "SPXW";

      if ("error" in chain) {
        if (isSPX) {
          const spyChain = await schwabGetOptionChain("SPY", 2);
          if (!("error" in spyChain)) {
            chain = spyChain;
            usedSymbol = "$SPX"; // keep SPX label, rescale below
            scaleToSPX = true;
          } else {
            // Schwab failed for both — try CBOE cached chain
            const cboeRaw = await getCboeChain("SPY").catch(() => null);
            if (cboeRaw) {
              chain = cboeChainToSchwab(cboeRaw, "SPY");
              usedSymbol = "$SPX";
              scaleToSPX = true;
            } else {
              return res.status(503).json({
                error: "data_unavailable",
                message: "No options chain available from Schwab or CBOE. Try again later.",
              });
            }
          }
        } else {
          // Non-SPX symbol: try CBOE for the same ticker
          const cboeRaw = await getCboeChain(symbol).catch(() => null);
          if (cboeRaw) {
            chain = cboeChainToSchwab(cboeRaw, symbol);
          } else {
            return res.status(503).json({
              error: "data_unavailable",
              message: `No options chain available for ${symbol}. Try again later.`,
            });
          }
        }
      }

      // Rescale SPY-derived chain to SPX values (×10 strikes + spot)
      if (scaleToSPX) {
        const scaleStrikeMap = (m: any) => {
          if (!m || typeof m !== "object") return m;
          const out: any = {};
          for (const expKey of Object.keys(m)) {
            const exp = m[expKey];
            const newExp: any = {};
            for (const strikeKey of Object.keys(exp)) {
              const newStrikeKey = String(parseFloat(strikeKey) * 10);
              newExp[newStrikeKey] = exp[strikeKey];
            }
            out[expKey] = newExp;
          }
          return out;
        };
        const u = chain.underlying || {};
        chain = {
          ...chain,
          symbol: "$SPX",
          underlying: {
            ...u,
            symbol: "$SPX",
            last: u.last != null ? u.last * 10 : u.last,
            bid: u.bid != null ? u.bid * 10 : u.bid,
            ask: u.ask != null ? u.ask * 10 : u.ask,
            mark: u.mark != null ? u.mark * 10 : u.mark,
            close: u.close != null ? u.close * 10 : u.close,
          },
          callExpDateMap: scaleStrikeMap(chain.callExpDateMap),
          putExpDateMap: scaleStrikeMap(chain.putExpDateMap),
        };
      }

      const spot = chain.underlying.last ??
        (chain.underlying.bid && chain.underlying.ask
          ? (chain.underlying.bid + chain.underlying.ask) / 2
          : null);

      if (!spot || spot <= 0) {
        return res.status(503).json({
          error: "no_spot",
          message: "Unable to determine underlying spot price.",
        });
      }

      const result = buildHeatseeker(chain, usedSymbol, spot);
      heatseekerCache.set(cacheKey, { at: Date.now(), data: result });
      res.json(result);
    } catch (e: any) {
      console.error("[heatseeker]", e?.message);
      res.status(500).json({ error: "internal", message: e?.message ?? "Heatseeker failed" });
    }
  });

  // ─── Backtest accuracy overlay ────────────────────────────────────────────
  app.get("/api/backtest/levels", async (_req, res) => {
    try {
      const summary = getBacktestSummary();
      res.json(summary);
    } catch (e: any) {
      res.status(500).json({ error: "backtest_read_failed", message: e?.message || String(e) });
    }
  });

  app.post("/api/backtest/rebuild", async (req, res) => {
    try {
      const years = Math.max(1, Math.min(10, Number(req.query.years) || 5));
      const result = await runBackfill(years);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: "backtest_rebuild_failed", message: e?.message || String(e) });
    }
  });

  // Kick off initial backfill in background on boot (non-blocking)
  setTimeout(() => {
    getBacktestSummary().byLevel && Object.keys(getBacktestSummary().byLevel).length === 0 &&
      runBackfill(5).then(r => console.log("[backtest] initial backfill:", r))
                    .catch(e => console.error("[backtest] initial backfill failed:", e?.message || e));
  }, 8_000);

  // ─── 0DTE live tracker ────────────────────────────────────────────────────
  app.get("/api/odte-tracker", (_req, res) => {
    try {
      res.json(getOdteSnapshot());
    } catch (e: any) {
      res.status(500).json({ error: "odte_tracker_failed", message: e?.message });
    }
  });

  app.get("/api/odte-tracker/sparkline", (req, res) => {
    try {
      const key = String(req.query.key || "");
      const size = Math.max(1, Math.min(50, Number(req.query.size) || 5));
      if (!key) return res.status(400).json({ error: "missing_key" });
      res.json({ key, size, bars: getSparkline(key, size) });
    } catch (e: any) {
      res.status(500).json({ error: "spark_failed", message: e?.message });
    }
  });

  app.post("/api/odte-tracker/arm", (req, res) => {
    try {
      const { contractKey, minNotional } = req.body ?? {};
      if (!contractKey) return res.status(400).json({ error: "missing_contractKey" });
      const result = armPosition({
        contractKey: String(contractKey),
        minNotional: typeof minNotional === "number" ? minNotional : undefined,
      });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: "arm_failed", message: e?.message });
    }
  });

  app.post("/api/odte-tracker/disarm", (req, res) => {
    try {
      const { id } = req.body ?? {};
      if (!id) return res.status(400).json({ error: "missing_id" });
      const ok = disarmPosition(String(id));
      res.json({ ok });
    } catch (e: any) {
      res.status(500).json({ error: "disarm_failed", message: e?.message });
    }
  });

  app.get("/api/odte-tracker/tracked", (_req, res) => {
    res.json({ tracked: getTracked() });
  });

  // ToS-style 5-min intraday chart for a single contract (key = contractKey)
  app.get("/api/odte-tracker/chart", (req, res) => {
    try {
      const key = String(req.query.key || "");
      const bucketMs = Math.max(15_000, Math.min(60 * 60_000, Number(req.query.bucketMs) || 5 * 60_000));
      if (!key) return res.status(400).json({ error: "missing_key" });
      res.json(getContractChart(key, bucketMs));
    } catch (e: any) {
      res.status(500).json({ error: "chart_failed", message: e?.message });
    }
  });

  // ─── Cosmos: astrology/astronomy intel brief + live engine ────────────────
  // GET /api/cosmos/outlook — weekly (7d) + monthly (30d) forward astro
  // outlook. Deterministic baseline always returned. If ANTHROPIC_API_KEY /
  // OPENAI_API_KEY are set, LLM-enhanced narrative returned alongside.
  app.get("/api/cosmos/outlook", async (req, res) => {
    try {
      const dateParam = typeof req.query.date === "string" ? new Date(req.query.date) : new Date();
      const date = isNaN(dateParam.getTime()) ? new Date() : dateParam;
      const weekly = buildWeeklyOutlook(date);
      const monthly = buildMonthlyOutlook(date);

      const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
      const hasOpenAiKey = !!process.env.OPENAI_API_KEY;

      async function enhanceWithClaude(markdown: string): Promise<string> {
        if (!hasAnthropicKey) throw new Error("ANTHROPIC_API_KEY not configured");
        const anthropic = new Anthropic();
        const msg = await anthropic.messages.create({
          model: "claude_sonnet_4_6",
          max_tokens: 1800,
          system: OUTLOOK_SYSTEM_PROMPT,
          messages: [{ role: "user", content: markdown }],
        });
        const block = msg.content.find((b) => b.type === "text");
        return (block as any)?.text ?? "";
      }

      async function enhanceWithGpt(markdown: string): Promise<string> {
        if (!hasOpenAiKey) throw new Error("OPENAI_API_KEY not configured");
        const openai = new OpenAI();
        const r: any = await (openai.responses as any).create({
          model: "gpt_5_1",
          input: `${OUTLOOK_SYSTEM_PROMPT}\n\n---\n\n${markdown}`,
        });
        return r.output_text ?? "";
      }

      const [wClaude, wGpt, mClaude, mGpt] = await Promise.allSettled([
        enhanceWithClaude(weekly.markdown),
        enhanceWithGpt(weekly.markdown),
        enhanceWithClaude(monthly.markdown),
        enhanceWithGpt(monthly.markdown),
      ]);

      const pick = (r: PromiseSettledResult<string>): string | null =>
        r.status === "fulfilled" ? r.value : null;
      const err = (r: PromiseSettledResult<string>): string | null =>
        r.status === "rejected" ? String((r as any).reason?.message ?? r.reason) : null;

      res.json({
        weekly: {
          ...weekly,
          claude: pick(wClaude),
          gpt: pick(wGpt),
          errors: { claude: err(wClaude), gpt: err(wGpt) },
        },
        monthly: {
          ...monthly,
          claude: pick(mClaude),
          gpt: pick(mGpt),
          errors: { claude: err(mClaude), gpt: err(mGpt) },
        },
        meta: {
          llmEnhancersEnabled: { claude: hasAnthropicKey, gpt: hasOpenAiKey },
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // GET /api/cosmos — unified snapshot (positions, aspects, phase, natal
  // transits, daily brief) + NOAA Kp live + taxonomy + live-lit taxonomy states
  // + books + academic papers + edge rules. All pure/deterministic except Kp.
  app.get("/api/cosmos", async (req, res) => {
    try {
      const dateParam = typeof req.query.date === "string" ? new Date(req.query.date) : new Date();
      const date = isNaN(dateParam.getTime()) ? new Date() : dateParam;
      const snapshot = buildCosmosSnapshot(date);
      let kp = null as Awaited<ReturnType<typeof fetchNoaaKp>> | null;
      try {
        kp = await fetchNoaaKp();
      } catch (e) {
        kp = null;
      }
      const live = taxonomyLiveStates(snapshot, kp);
      res.json({
        snapshot,
        kp,
        taxonomy: TAXONOMY,
        taxonomyLive: live,
        books: BOOKS,
        papers: ACADEMIC_PAPERS,
        rules: EDGE_RULES,
        honestEdge: HONEST_EDGE_ASSESSMENT,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Kick off tracker poller
  startOdteTracker(4_000);

  // Kick off MM-matrix scheduler (10/13/15:30 ET snapshots, 16:30 grading)
  startMmScheduler();
  startDiscordScheduler();

  // Manual test endpoint for Discord webhook
  app.post("/api/discord/test", async (_req, res) => {
    try {
      const r = await fireTestCard();
      res.json(r);
    } catch (e: any) {
      res.status(500).json({ ok: false, note: e?.message ?? "failed" });
    }
  });

  // Manual fire daily card (used by `curl` while wiring + verifying)
  app.post("/api/discord/daily", async (_req, res) => {
    try {
      const ok = await postDailyModelCard();
      res.json({ ok });
    } catch (e: any) {
      res.status(500).json({ ok: false, note: e?.message ?? "failed" });
    }
  });

  // Manual fire SelzTrades-format card
  app.post("/api/discord/selz", async (_req, res) => {
    try {
      const r = await postSelzDailyCard();
      res.json(r);
    } catch (e: any) {
      res.status(500).json({ ok: false, note: e?.message ?? "failed" });
    }
  });

  // ─── Calibration endpoints (read-only observer of pulse predictions) ─────
  // Manual fire weekly calibration card
  app.post("/api/discord/calibration", async (req, res) => {
    try {
      const days = Number(req.query.days ?? 7);
      const r = await postCalibrationCard(isFinite(days) && days > 0 ? days : 7);
      res.json(r);
    } catch (e: any) {
      res.status(500).json({ ok: false, note: e?.message ?? "failed" });
    }
  });

  // Inspect rolling Brier without posting to Discord
  app.get("/api/calibration/rolling", (req, res) => {
    try {
      const days = Number(req.query.days ?? 30);
      const r = rollingBrier(isFinite(days) && days > 0 ? days : 30);
      res.json(r ?? { n: 0, note: "no settled days yet" });
    } catch (e: any) {
      res.status(500).json({ note: e?.message ?? "failed" });
    }
  });

  // Manual settle (for testing or replay) — idempotent.
  // POST /api/calibration/settle  body { date: "YYYY-MM-DD", close: number }
  app.post("/api/calibration/settle", async (req, res) => {
    try {
      const { date, close } = req.body ?? {};
      if (!date || typeof close !== "number") {
        return res.status(400).json({ ok: false, note: "need {date, close}" });
      }
      const r = settleDay(String(date), Number(close));
      res.json(r ?? { ok: false, note: "no prediction recorded for that date" });
    } catch (e: any) {
      res.status(500).json({ ok: false, note: e?.message ?? "failed" });
    }
  });

  // ─── Start background token refresh cycle ─────────────────────────────────
  startTokenRefreshCycle();

  return httpServer;
}
