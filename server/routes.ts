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
import { snapshotHorizon, gradeOutcomes, empiricalStats } from "./mmPredictions";
import { buildMag7Snapshot, type Mag7Response } from "./mag7";
import { buildFlowSnapshot, buildIntradayFlowSnapshot, type FlowResponse } from "./flow";
import { buildExposuresSnapshot, type ExposuresResponse } from "./exposures";
import { buildUnusualFlow, type UnusualFlowResponse } from "./unusualFlow";
import { buildNewsSnapshot, type NewsResponse } from "./news";
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
import { masterAlphaRoute } from "./masterAlpha";

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
  const MODELS_CACHE_MS = 5 * 60_000;
  app.get("/api/models", async (req, res) => {
    try {
      const symbol = (String(req.query.symbol ?? "^GSPC").toUpperCase() === "SPY" ? "SPY" : "^GSPC") as "SPY" | "^GSPC";
      // Dealer-map kinds (vanna flip, zomma bridge, charm target, neg-γ
      // entry, upper/lower vomma) are now always on — they're core levels,
      // not experimental. ?experimental=0 can still disable them explicitly.
      const experimental = String(req.query.experimental ?? "1") !== "0";
      const cacheKey = `${symbol}${experimental ? ":exp" : ""}`;
      const cached = modelsCache.get(cacheKey);
      if (cached && Date.now() - cached.at < MODELS_CACHE_MS) {
        return res.json(cached.data);
      }
      // Need VIX context for vol header
      const snap = await getOrBuild(false).catch(() => null);
      const vix = snap?.vol.vix.value ?? null;
      const vixPrev = snap?.vol.vix.prev ?? null;
      const vix3m = snap?.vol.vix3m.value ?? null;

      const data = await buildModelsSnapshot({
        vix, vixPrev, vix3m,
        symbols: [symbol],
        experimental,
      });

      // Persist a snapshot keyed to today's RTH session date. Reads flip to live
      // as soon as the next session starts returning fresh data.
      await writeCache(`models-${symbol}${experimental ? "-exp" : ""}-${rthSessionKey()}`, data);

      modelsCache.set(cacheKey, { at: Date.now(), data });
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

      // Pull cached models build if fresh, otherwise build now
      const cacheKey = `${symbol}:exp`;
      const cached = modelsCache.get(cacheKey);
      let models: ModelsResponse;
      if (cached && Date.now() - cached.at < MODELS_CACHE_MS) {
        models = cached.data;
      } else {
        const snap = await getOrBuild(false).catch(() => null);
        models = await buildModelsSnapshot({
          vix: snap?.vol.vix.value ?? null,
          vixPrev: snap?.vol.vix.prev ?? null,
          vix3m: snap?.vol.vix3m.value ?? null,
          symbols: [symbol],
          experimental: true,
        });
        modelsCache.set(cacheKey, { at: Date.now(), data: models });
      }

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

  // ---- EOD Setup: Claude + GPT parallel brief generation ----
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

      const anthropic = new Anthropic();
      const openai = new OpenAI();

      const [claudeResult, gptResult] = await Promise.allSettled([
        anthropic.messages.create({
          model: "claude_sonnet_4_6",
          max_tokens: 4096,
          system: EOD_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userBrief }],
        }).then((msg) => {
          const block = msg.content.find((b) => b.type === "text");
          return (block as any)?.text ?? "";
        }),
        (openai.responses as any).create({
          model: "gpt_5_1",
          input: `${EOD_SYSTEM_PROMPT}\n\n---\n\n${userBrief}`,
        }).then((r: any) => r.output_text ?? ""),
      ]);

      res.json({
        claude: claudeResult.status === "fulfilled" ? claudeResult.value : null,
        gpt: gptResult.status === "fulfilled" ? gptResult.value : null,
        errors: {
          claude: claudeResult.status === "rejected" ? String(claudeResult.reason) : null,
          gpt: gptResult.status === "rejected" ? String(gptResult.reason) : null,
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

      const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
      const itemLines = (newsItems as Array<{ title: string; source?: string; time?: string; summary?: string; url?: string }>)
        .slice(0, 30)
        .map((n, i) => `${i + 1}. [${n.source ?? "?"}, ${n.time ?? "?"}] ${n.title}${n.summary ? " — " + n.summary : ""}`)
        .join("\n");

      const userBrief = `CURRENT TIME: ${now} ET

EXISTING NEWS FEED (${(newsItems as any[]).length} items):
${itemLines || "(empty)"}

TASK
Sift this feed AND search the web for any critical developments in geopolitics, rates/Fed, insider buys, and sentiment/positioning that the feed is missing or under-weighting. Produce the ALPHA brief.`;

      const anthropicClient = new Anthropic();
      let response: Awaited<ReturnType<typeof anthropicClient.messages.create>>;
      let mode: "with_search" | "knowledge_only" = "with_search";

      try {
        response = await anthropicClient.messages.create({
          model: "claude_opus_4_7",
          max_tokens: 4096,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }] as any,
          system: ALPHA_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userBrief }],
        });
        console.log("[alpha-brief] mode: with_search");
      } catch (toolErr: any) {
        // Fallback if web_search tool not supported by this proxy
        mode = "knowledge_only";
        console.warn("[alpha-brief] web_search unavailable, falling back to knowledge_only:", toolErr?.message);
        response = await anthropicClient.messages.create({
          model: "claude_opus_4_7",
          max_tokens: 4096,
          system: ALPHA_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userBrief + "\n\n(Note: live web search unavailable — use news feed + your knowledge.)" }],
        });
        console.log("[alpha-brief] mode: knowledge_only");
      }

      // Extract text blocks (Opus with tool use returns mixed blocks)
      const brief = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n\n");

      res.json({ brief, mode });
    } catch (err: any) {
      console.error("[alpha-brief]", err?.message);
      res.status(500).json({ error: err?.message ?? "ALPHA brief failed" });
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
      const symbol = String(req.params.symbol).toUpperCase();
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

      // Fetch chain with 2-day DTE window so we always catch 0DTE + next expiry
      let chain = await schwabGetOptionChain(symbol, 2);
      let usedSymbol = symbol;

      if ("error" in chain) {
        const isSPX = symbol.includes("SPX") || symbol === "$SPX" || symbol === "SPXW";
        if (isSPX) {
          const spyChain = await schwabGetOptionChain("SPY", 2);
          if ("error" in spyChain) {
            return res.status(503).json({
              error: "schwab_required",
              message: "Schwab connection required for heatseeker. Please connect Schwab in Settings.",
            });
          }
          chain = spyChain;
          usedSymbol = "SPY";
        } else {
          return res.status(503).json({
            error: "schwab_required",
            message: "Schwab connection required for heatseeker. Please connect Schwab in Settings.",
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

  // ─── Start background token refresh cycle ─────────────────────────────────
  startTokenRefreshCycle();

  return httpServer;
}
