/**
 * liveVerify.ts: the live verification pass (GET /api/verify/live).
 *
 * Once Schwab is connected, one run reads every Schwab-fed data point the
 * terminal shows and does two things:
 *
 *  1. Reach: calls each panel's route the way the UI does and records the
 *     state it answered with (ok, stale, partial, unavailable, rate-limited).
 *  2. Arithmetic: takes the raw inputs (quotes, the chain, daily bars) and
 *     the served outputs (0DTE forward and map, flow, put/call, term
 *     structure, scan) and recomputes the key numbers a second time by the
 *     stated formula (shared/liveVerify.ts), comparing within a stated
 *     tolerance.
 *
 * What a pass means: the plumbing delivered live data and the numbers shown
 * are the stated arithmetic on that data. What it does not mean: that any
 * level or signal has predictive value. Each check is reported with what was
 * observed; a stale, unavailable or skipped check is never counted as a pass.
 *
 * The run is single-flight and its result is kept for 60 s, so a second tap
 * does not double the load on Schwab. Demo edition: blocked, nothing is read.
 */
import { getSchwabStatus, getQuotes, getOptionChain, getPriceHistory } from "./schwab";
import { buildOdteForward } from "./odteForward";
import { composeOdteMap } from "../shared/odteMap";
import { buildSchwabFlow } from "./schwabFlow";
import { buildFlowSnapshot } from "./flow";
import { scanTicker } from "./tickerScan";
import { getSetupLog } from "./setupEngine";
import { flattenSchwabChain } from "./schwabChainRows";
import { isRegularSessionOpen } from "./exchangeCalendar";
import { etParts } from "./validationMath";
import { editionFromEnv } from "../shared/edition";
import { dailyBarEtDate } from "../shared/macroCalendar";
import { getCryptoFeed, getCryptoSignals } from "./cryptoEngine";
import { candidateChecks, deskRiskCheck, expectancyChecks } from "../shared/cryptoVerify";
import {
  type Check, type VerifySummary, quoteCheck, spotAgreement, spreadCheck, forwardLevelsChecks, mapLandmarkChecks,
  flowContractChecks, pcrChecks, termChecks, relativeVolumeCheck, chainSanityChecks, summarize, unavailable, skipped, classifyReach,
} from "../shared/liveVerify";

export interface LiveVerifyReport {
  version: 1;
  dataState: "ok" | "blocked" | "not_connected";
  connected: boolean;
  session: "open" | "closed";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  cached: boolean;
  summary: VerifySummary;
  /** One row per panel route the UI calls: did it answer, and in what state. */
  reach: Check[];
  /** The recomputations. */
  checks: Check[];
  scope: string;
  note: string | null;
}

const SCOPE = "Reach and arithmetic of the live run: every Schwab-fed route and the keyless crypto desk answered, and the displayed numbers equal their stated formulas on the raw inputs and the rule book. Not a calibration, execution or prediction-accuracy certificate.";
const CACHE_MS = 60_000;
const ROUTE_TIMEOUT_MS = 20_000;
const PORT = process.env.PORT || "5000";

/** Panel routes the UI calls; each one is reached the way the UI reaches it. */
export const REACH_ROUTES: Array<{ id: string; panel: string; path: string }> = [
  { id: "route.snapshot", panel: "Dashboard", path: "/api/snapshot" },
  { id: "route.quotes", panel: "Quote strip", path: "/api/quotes" },
  { id: "route.tradeDesk", panel: "Trade Desk", path: "/api/trade-desk?range=1d" },
  { id: "route.ohlc", panel: "Chart", path: "/api/ohlc?symbol=SPY&tf=1D&interval=1m" },
  { id: "route.gammaLevels", panel: "Chart", path: "/api/gamma-levels?symbol=SPY" },
  { id: "route.odteForward", panel: "Trade Desk", path: "/api/odte/forward?symbol=$SPX" },
  { id: "route.odteMap", panel: "Signals", path: "/api/odte/map?symbol=$SPX" },
  { id: "route.heatseeker", panel: "Heatseeker", path: "/api/heatseeker?symbol=$SPX" },
  { id: "route.killbox", panel: "Killbox", path: "/api/killbox/forward?symbol=$SPX&dte=30" },
  { id: "route.thermal", panel: "Heatseeker", path: "/api/heatmap/thermal?symbol=$SPX&dte=60&greek=gex" },
  { id: "route.chainAudit", panel: "Trade Desk", path: "/api/chain-audit?symbol=$SPX&dte=60" },
  { id: "route.exposures", panel: "Exposure", path: "/api/exposures?symbol=SPY" },
  { id: "route.regimeHeadline", panel: "Regime", path: "/api/regime/headline" },
  { id: "route.regime", panel: "Regime", path: "/api/regime" },
  { id: "route.flow", panel: "Flow", path: "/api/flow" },
  { id: "route.flowUnusual", panel: "Flow", path: "/api/flow/unusual?symbol=SPY" },
  { id: "route.flowPreview", panel: "Whale flow", path: "/api/flow/preview" },
  { id: "route.models", panel: "Models", path: "/api/models" },
  { id: "route.mag7", panel: "Mag 7", path: "/api/mag7" },
  { id: "route.breadth", panel: "Breadth", path: "/api/breadth" },
  { id: "route.canary", panel: "Canaries", path: "/api/canary" },
  { id: "route.setups", panel: "Setup log", path: "/api/setups" },
  { id: "route.scan", panel: "Scan", path: "/api/scan?symbol=SPY" },
  { id: "route.researchEvents", panel: "Event replay", path: "/api/research/events?symbol=$SPX" },
  // Crypto desk (public keyless feeds; reached whether or not Schwab is connected).
  { id: "route.cryptoFeed", panel: "Crypto", path: "/api/crypto/feed" },
  { id: "route.cryptoSignals", panel: "Crypto", path: "/api/crypto/signals" },
  { id: "route.cryptoCommunity", panel: "Crypto", path: "/api/crypto/community" },
  { id: "route.cryptoHealth", panel: "Crypto", path: "/api/crypto/health" },
];

async function reachOne(r: { id: string; panel: string; path: string }): Promise<Check> {
  const name = r.path.replace(/^\/api\//, "").replace(/\?.*$/, "");
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${r.path}`, { signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS), headers: { Accept: "application/json" } });
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    const c = classifyReach(res.status, body);
    return { id: r.id, panel: r.panel, name, state: c.state, observed: c.observed, expected: "200 ok", detail: c.detail };
  } catch (e: any) {
    const timeout = e?.name === "TimeoutError";
    return { id: r.id, panel: r.panel, name, state: "unavailable", observed: timeout ? `no answer in ${ROUTE_TIMEOUT_MS / 1000}s` : "unreachable", expected: "200 ok", detail: timeout ? "the route did not answer in time" : String(e?.message ?? e).slice(0, 120) };
  }
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<Check>): Promise<Check[]> {
  const out: Check[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const sym = (s: string) => s.replace(/^\$/, "");

async function arithmeticChecks(now: number, sessionOpen: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  const swallow = async <T,>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };

  // Quotes: the inputs everything else is compared against.
  const quotes = (await swallow(() => getQuotes(["SPY", "$SPX", "$VIX", "$VIX9D", "$VIX3M", "QQQ"]))) ?? [];
  const q = (s: string) => quotes.find((x) => x.symbol === s || x.symbol === sym(s) || x.symbol === `$${sym(s)}`) ?? null;
  for (const s of ["SPY", "$SPX", "$VIX", "$VIX9D", "$VIX3M"]) checks.push(quoteCheck("Quotes", s, q(s), sessionOpen));

  // Raw SPX chain, as the engines read it.
  const chain = await swallow(() => getOptionChain("$SPX", 7));
  if (chain && !("error" in chain)) {
    const rows = flattenSchwabChain(chain as any);
    checks.push(...chainSanityChecks("Trade Desk", "$SPX", rows, { asOfMs: (chain as any).asOfMs, stale: (chain as any).stale }, now));
  } else checks.push(unavailable("chain.SPX", "Trade Desk", "$SPX chain", (chain as any)?.reason ?? "chain unavailable"));

  // 0DTE forward and the Today map composed from it.
  const fwd = await swallow(() => buildOdteForward("$SPX", now));
  if (fwd && fwd.status === 200) {
    checks.push(spotAgreement("forward.spot", "Trade Desk", "0DTE spot vs $SPX quote", fwd.body.spot, q("$SPX")?.last));
    checks.push(...forwardLevelsChecks("Trade Desk", fwd.body));
    const map = composeOdteMap(fwd.body, { edition: editionFromEnv() as any });
    checks.push(...mapLandmarkChecks("Signals", map));
  } else {
    checks.push(unavailable("forward.levels", "Trade Desk", "0DTE levels", fwd?.body?.reason ?? "forward unavailable"));
    checks.push(unavailable("map.landmarks", "Signals", "Today landmarks", "forward unavailable"));
  }

  // Unusual flow for SPY: premium and volume/OI arithmetic on every flagged contract.
  const flow = await swallow(() => buildSchwabFlow("SPY", { limit: 200 }));
  if (flow && !("error" in flow)) checks.push(...flowContractChecks("Flow", flow.contracts as any));
  else checks.push(unavailable("flow.contracts", "Flow", "unusual flow", (flow as any)?.error ?? "flow unavailable"));

  // Put/call per ticker and the index aggregate.
  const pcr = await swallow(() => buildFlowSnapshot());
  if (pcr) checks.push(...pcrChecks("Flow", [...pcr.indexGroup, ...pcr.mag7Group].map((t) => ({ ...t, symbol: (t as any).symbol })), pcr.aggregate.indexPcr));
  else checks.push(unavailable("pcr.tickers", "Flow", "put/call ratios", "flow snapshot unavailable"));

  // Term structure from the snapshot, against the quotes read above.
  const snap = await swallow(async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/snapshot`, { signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS), headers: { Accept: "application/json" } });
    return res.ok ? await res.json() : null;
  });
  checks.push(...termChecks("Regime", snap?.term ?? null, { vix9d: q("$VIX9D")?.last ?? null, vix: q("$VIX")?.last ?? null, vix3m: q("$VIX3M")?.last ?? null }));

  // Scan: spread and relative volume for SPY against the same bars.
  const scan = await swallow(() => scanTicker("SPY"));
  if (scan) {
    if (scan.quote.dataState === "ok" || scan.quote.dataState === "stale") checks.push(spreadCheck("Scan", "SPY", scan.quote));
    else checks.push(unavailable("spread.SPY", "Scan", "SPY spread", scan.quote.reason ?? scan.quote.dataState));
    const ph = await swallow(() => getPriceHistory("SPY", "month", 2, "daily", 1, false));
    const bars = (ph?.candles ?? []).map((c: any) => ({ date: dailyBarEtDate(c.datetime, (ms: number) => etParts(ms).ymd), volume: c.volume }));
    checks.push(relativeVolumeCheck("Scan", "SPY", scan.volume.dataState === "unavailable" ? null : scan.volume.relative, bars, etParts(now).ymd));
  } else {
    checks.push(unavailable("spread.SPY", "Scan", "SPY spread", "scan unavailable"));
    checks.push(unavailable("relvol.SPY", "Scan", "SPY relative volume", "scan unavailable"));
  }

  // Setup engine: running and its last tick clean.
  const log = getSetupLog();
  checks.push(log.dataState === "unavailable"
    ? unavailable("setups.engine", "Setup log", "setup engine", log.lastTickError ?? "engine reports unavailable")
    : log.dataState === "loading" ? skipped("setups.engine", "Setup log", "setup engine", "first tick not yet run")
    : { id: "setups.engine", panel: "Setup log", name: "setup engine", state: log.lastTickError ? "fail" : "pass", observed: `${log.dataState}, ${log.counts.total} logged, last tick ${log.lastTickAt ? `${Math.round((now - log.lastTickAt) / 1000)}s ago` : "never"}`, expected: "ok, no tick error", detail: log.lastTickError });

  return checks;
}

/** Crypto desk: the served feed and signals recomputed against the rule book (shared/cryptoVerify.ts). */
function cryptoChecks(now: number): Check[] {
  const out: Check[] = [];
  let feed: ReturnType<typeof getCryptoFeed> | null = null;
  let sig: ReturnType<typeof getCryptoSignals> | null = null;
  try { feed = getCryptoFeed(); } catch (e: any) { out.push({ id: "crypto.feed", panel: "Crypto", name: "feed", state: "unavailable", observed: "threw", expected: null, detail: String(e?.message ?? e).slice(0, 120) }); }
  try { sig = getCryptoSignals(); } catch (e: any) { out.push({ id: "crypto.signals", panel: "Crypto", name: "signals", state: "unavailable", observed: "threw", expected: null, detail: String(e?.message ?? e).slice(0, 120) }); }
  const desk = sig?.desk ?? null;
  out.push(...candidateChecks(feed ? (feed.candidates as any) : null, desk));
  out.push(deskRiskCheck(desk, feed?.majors ? (feed.majors as any) : null, now));
  out.push(...expectancyChecks(sig ? (sig.expectancy as any) : null));
  if (sig) out.push({ id: "crypto.rules", panel: "Crypto", name: "rule book version", state: sig.rules?.version ? "pass" : "fail", observed: sig.rules?.version ?? "missing", expected: "present on the payload", detail: null });
  return out;
}

let last: { at: number; report: LiveVerifyReport } | null = null;
let inflight: Promise<LiveVerifyReport> | null = null;

export async function runLiveVerify(now: number = Date.now()): Promise<LiveVerifyReport> {
  if (last && now - last.at < CACHE_MS) return { ...last.report, cached: true };
  if (inflight) return inflight;
  inflight = (async () => {
    const sessionOpen = isRegularSessionOpen(now);
    const base = { version: 1 as const, session: sessionOpen ? "open" as const : "closed" as const, startedAt: now, cached: false, scope: SCOPE };
    if (editionFromEnv() === "demo") {
      const report: LiveVerifyReport = { ...base, dataState: "blocked", connected: false, finishedAt: Date.now(), durationMs: 0, summary: summarize([], false), reach: [], checks: [], note: "The public preview runs on simulated sample data; nothing here can be verified against Schwab. Connect a personal server." };
      return report;
    }
    const status = getSchwabStatus();
    if (!status.connected) {
      // Schwab-fed checks need the connection; the crypto desk is keyless and is verified anyway.
      const cryptoReach = await pool(REACH_ROUTES.filter((r) => r.panel === "Crypto"), 2, reachOne);
      const crypto = cryptoChecks(Date.now());
      const finishedAt = Date.now();
      // The verdict is scoped to what ran (the crypto desk); `connected: false` carries the Schwab fact.
      const report: LiveVerifyReport = { ...base, dataState: "not_connected", connected: false, finishedAt, durationMs: finishedAt - now, summary: summarize([...cryptoReach, ...crypto], true), reach: cryptoReach, checks: crypto, note: "Schwab is not connected: only the crypto desk was verified. Sign in from Settings to verify the Schwab-fed panels." };
      return report;
    }
    const [reach, checks] = await Promise.all([pool(REACH_ROUTES, 3, reachOne), arithmeticChecks(now, sessionOpen)]);
    checks.push(...cryptoChecks(Date.now())); // the desk's clock, not the run's start
    const finishedAt = Date.now();
    const report: LiveVerifyReport = {
      ...base, dataState: "ok", connected: true, finishedAt, durationMs: finishedAt - now,
      summary: summarize([...reach, ...checks], true), reach, checks,
      note: sessionOpen ? null : "Regular session closed: quotes and chains are the last session's and are not marked stale; the arithmetic checks still apply.",
    };
    last = { at: finishedAt, report };
    return report;
  })().finally(() => { inflight = null; });
  return inflight;
}
