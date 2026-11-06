// headline.ts
// Plain-English synthesis of the current market state per tab.
// Reads from existing endpoints/services — does NOT recompute analytics.
// Goal: one human sentence + 2-3 bullets the user can read in 3 seconds.

import { predictTransition } from "./regimePredictor";
import { callInternal } from "./internalApi";
import { getWhaleAlertHistoryOrNull } from "./whalePersistence";
import { levelsLine } from "../shared/headlineLines";
import { coverage, whaleCoverageLine } from "../shared/scanCoverage";

type Tab =
  | "signals"
  | "chart"
  | "models"
  | "heatseeker"
  | "tradedesk"
  | "regime"
  | "cosmos"
  | "news"
  | "voices"
  | "takefive"
  | "global";

export interface HeadlinePayload {
  tab: Tab;
  tone: "bull" | "bear" | "neutral" | "warning";
  topLine: string;
  subLine: string;
  bullets: string[];
  asOf: number;
  /** What this tab/panel is FOR, in one sentence. Helps newcomers. */
  whatThisIs: string;
}

interface BuildArgs {
  tab: Tab;
  port: number;
}



function regimeWord(r: string): string {
  switch (r) {
    case "TREND_STRONG": return "strong trend";
    case "TREND_WEAK": return "weak trend";
    case "NEUTRAL": return "neutral";
    case "CHOP_WEAK": return "light chop";
    case "CHOP_STRONG": return "heavy chop";
    case "GAMMA_UNKNOWN": return "gamma unknown";
    case "UNAVAILABLE": return "unavailable";
    default: return r.toLowerCase();
  }
}

function regimeTone(r: string): "bull" | "bear" | "neutral" | "warning" {
  if (r.startsWith("TREND")) return "bull";
  if (r.startsWith("CHOP")) return "warning";
  return "neutral";
}

export async function buildHeadline(args: BuildArgs): Promise<HeadlinePayload> {
  const { tab, port } = args;
  void port; // kept in BuildArgs for callers; routes are called in-process now
  const base = "";

  // Shared context: the regime predictor, whale alerts across every scanned
  // symbol, and (Chart, Heatseeker) today's dealer levels from the same map
  // the Today card reads.
  const needsMap = tab === "chart" || tab === "heatseeker";
  // The predictor is PEEKED: headlines read the current models build and never
  // start or wait for one; a peek reads the raw cached build, so the regime
  // part of a headline makes no Schwab request (the Chart/Heatseeker level map
  // below still reads its own cached 1-DTE chain).
  const [predictRes, whaleHist, mapRes, flowSnap] = await Promise.all([
    callInternal<any>(`${base}/api/regime/predict?symbol=^GSPC&horizonMinutes=20&peek=1`, { timeoutMs: 2500 }).catch((e: any) => ({ ok: false, status: 0, body: null, error: String(e?.message ?? e) })),
    Promise.resolve(getWhaleAlertHistoryOrNull({ days: 1, limit: 200 })).catch(() => null),
    needsMap ? callInternal<any>(`${base}/api/odte/map?symbol=${encodeURIComponent("$SPX")}`, { timeoutMs: 3000 }).catch((e: any) => ({ ok: false, status: 0, body: null, error: String(e?.message ?? e) })) : Promise.resolve(null),
    import("./flowAlertEngine").then((m) => m.getFlowSnapshot()).catch(() => null),
  ]);
  const models = predictRes && predictRes.ok ? predictRes.body : null;
  const predictWhy = !predictRes || predictRes.ok ? null
    : (predictRes as any).error === "timeout" ? "the predictor did not answer within 2.5 s"
    : String((predictRes.body as any)?.reason ?? (predictRes.body as any)?.message ?? (predictRes as any).error ?? `status ${predictRes.status}`);
  const odteMap = mapRes && mapRes.ok ? mapRes.body : null;
  const mapWhy = !mapRes || mapRes.ok ? null
    : String((mapRes.body as any)?.reason ?? (mapRes.body as any)?.message ?? (mapRes.body as any)?.error ?? (mapRes as any).error ?? `status ${mapRes.status}`);
  const levels = levelsLine(odteMap);
  const levelsMissing = `Dealer levels unavailable${mapWhy ? `: ${mapWhy}` : ": the option-chain map did not answer"}.`;
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

  // Missing predictor output is "UNAVAILABLE", never read as NEUTRAL.
  const currentRegime = String(models?.currentRegime ?? "UNAVAILABLE");
  const headlineRegime = String(models?.headline ?? "");
  const tone = regimeTone(currentRegime);
  // When the regime is unknown, tab copy describes the tab only; it never
  // builds a sentence around "unavailable regime" or implies a neutral read.
  const known = currentRegime !== "UNAVAILABLE" && currentRegime !== "GAMMA_UNKNOWN";
  const withRegime = (base: string) => (known ? `${base} — ${regimeWord(currentRegime)} regime.` : `${base}.`);
  // Two different "unknown" causes, named apart: the predictor did not answer, or it answered without gamma data.
  const regimeMissing = models == null
    ? `Regime reading unavailable: ${predictWhy ?? "the predictor did not answer"}.`
    : "Regime unknown until Schwab gamma and VIX term data arrive.";

  // Whale flow last hour: quick directional count (shared/headlineLines.ts)
  const whaleSummary = whaleCoverageLine(whaleHist as any[] | null, Date.now(), coverage((flowSnap as any)?.scan, (flowSnap as any)?.running ?? null, Date.now()));

  // Per-tab synthesis
  switch (tab) {
    case "signals":
      return {
        tab,
        tone,
        topLine: `${whaleSummary}${known ? ` · ${regimeWord(currentRegime)} regime` : ""}.`,
        subLine: "Whale flow: fresh large option trades, tracked positions and recent closes.",
        bullets: [
          "Whale criteria: $2.5M+ premium on one contract, volume/OI 15x, bought above the ask, 1–3 days to expiry.",
          known
            ? (tone === "bull" ? "Trend regime: one-sided whale flow has tended to line up with the move (descriptive)." :
               tone === "warning" ? "Chop regime: whale flow is noisier; closing-line value is the better yardstick than P&L." :
               "Neutral regime: no dominant dealer-hedging pressure.")
            : regimeMissing,
        ],
        asOf: Date.now(),
        whatThisIs: "Whale flow — heavy contracts ($2.5M+ cumulative day premium on one contract, 1–3DTE; can be many small trades, not block prints) plus a separate UOA scanner with cap-tiered clustering for any-ticker, any-date alerts.",
      };

    case "chart":
      return {
        tab,
        tone,
        topLine: levels ?? levelsMissing,
        subLine: withRegime("SPX cash chart with dealer levels. Levels are estimates from the Schwab option chain"),
        bullets: [
          "Dealer levels: call wall (resistance), put wall (support), gamma flip (pivot).",
          "Vanna and charm zeros add second-order pin pressure near OpEx.",
          "Above gamma flip = positive gamma = mean reversion. Below = negative gamma = momentum.",
        ],
        asOf: Date.now(),
        whatThisIs: "Live SPX chart with the dealer levels that set support, resistance, and pivot.",
      };

    case "models":
      return {
        tab,
        tone,
        topLine: known ? `${cap(regimeWord(currentRegime))} regime. Composite score and forward path follow.` : regimeMissing,
        subLine: "ML Lab (under More detail on phones) shows forward path scenarios (bull q90, base q50, bear q10).",
        bullets: [
          "Composite score blends DFI, gamma zone, IV term, vanna bias, charm pin, flow.",
          "ML Lab projects the next 60-240 minutes with confidence bands.",
          "Model D (morning anchor) blends in 9:45-16:00 ET when opening fingerprint is set.",
        ],
        asOf: Date.now(),
        whatThisIs: "Composite heuristic score (hand-set weights, not a probability) plus the ML forward-path projection (1-4 hours out).",
      };

    case "heatseeker":
      return {
        tab,
        tone,
        topLine: levels ? `0DTE · ${levels}` : `0DTE · ${levelsMissing}`,
        subLine: tone === "warning"
          ? "Heavy chop: price has been pinning around strikes (descriptive, not a trade call)."
          : tone === "bull"
          ? "Trend regime: estimated dealer hedging tends to add to moves (descriptive, no edge claimed)."
          : currentRegime === "NEUTRAL"
          ? "Neutral regime: no dominant estimated hedging pressure."
          : regimeMissing,
        bullets: [
          "Live Greeks across ATM ±20 strikes, refreshed every 4s.",
          "Hot zones = strike clusters with rising volume + Greek velocity.",
          "0DTE alerts fire to Discord 9:45-15:45 ET on level breaks + gamma flips.",
        ],
        asOf: Date.now(),
        whatThisIs: "Live 0DTE option scanner — Greeks, hot strikes, sticky zones, real-time.",
      };

    case "tradedesk":
      return {
        tab,
        tone,
        topLine: known ? `${cap(regimeWord(currentRegime))} regime now; the 20-minute outlook (heuristic, uncalibrated) is on the desk.` : regimeMissing,
        subLine: "Trade Desk: 20-minute regime outlook, edge tracking and position tools. Heuristic weights, not calibrated probabilities.",
        bullets: [
          "Predictor uses DFI slope, gamma flip, vanna, charm, IV term, VIX term, whale pressure.",
          "Heuristic score 70+/100 = strong transition reading, under 40 = weak; uncalibrated.",
          "Warming-up state means <5 samples collected: the reading is not formed yet.",
        ],
        asOf: Date.now(),
        whatThisIs: "Regime outlook for the next 20 minutes, the edge-tracking loop and trade tools.",
      };

    case "regime":
      return {
        tab,
        tone,
        topLine: known ? `${cap(regimeWord(currentRegime))} regime · ${whaleSummary.charAt(0).toLowerCase() + whaleSummary.slice(1)}.` : regimeMissing,
        subLine: "Macro, sector rotation and cross-asset read: sector rotation map, cross-asset canaries and dealer gamma map.",
        bullets: [
          "Sector web shows leadership rotation — risk-on (tech/discretionary) vs risk-off (staples/utilities).",
          "Canary panel compares cross-asset moves against their own 20-day volatility.",
          "WEF themes map narratives to ticker baskets for thematic flow tracking.",
        ],
        asOf: Date.now(),
        whatThisIs: "Macro context — sector rotation, cross-asset canaries, narrative themes.",
      };

    case "cosmos":
      return {
        tab,
        tone: "neutral",
        topLine: "Sky context — for entertainment, not a trading signal.",
        subLine: "No trade instructions, direction calls, sizes or alerts. No engine reads it.",
        bullets: [
          "Lunar, geomagnetic and SAD effects have studies behind them; all are small or disputed.",
          "Retrogrades, Bradley, Gann and natal charts have no peer-reviewed support.",
          "Outside every model, score and alert — view-only.",
        ],
        asOf: Date.now(),
        whatThisIs: "Astronomy facts plus financial-astrology reference, labeled by evidence. Context only.",
      };

    case "news":
      return {
        tab,
        tone: "neutral",
        topLine: "Market-relevant headlines and macro events.",
        subLine: "Filter: SPX-relevant, Fed/Treasury, geopolitics, OpEx/FOMC calendar.",
        bullets: [
          "Official sources first (SEC, Fed, BLS, BEA, Treasury, CFTC), then established newswires; the source line shows which are live.",
          "Reddit and anonymous blogs are filtered out.",
          "Calendar: FOMC, data releases, OpEx and holidays.",
        ],
        asOf: Date.now(),
        whatThisIs: "Market news from tiered, labeled sources, filtered for SPX relevance.",
      };

    case "voices":
      return {
        tab,
        tone: "neutral",
        topLine: "Sharp money commentary — sourced voices on the tape.",
        subLine: "Cross-reference voice consensus with whale flow before acting.",
        bullets: [
          "Voices are curated trader/quant accounts with track records.",
          "Use as confirmation, not primary signal.",
          "When voices and your data disagree, the data is the record.",
        ],
        asOf: Date.now(),
        whatThisIs: "Curated commentary from traders with track records — confirmation, not signal.",
      };

    case "takefive":
      return {
        tab,
        tone: "neutral",
        topLine: "Take Five — a short reset away from the screen.",
        subLine: "Breathing pacer and a few reminders. Nothing here reads market data.",
        bullets: [
          "4-7-8 breathing pacer.",
          "Also opens from the Take 5 button in the header.",
        ],
        asOf: Date.now(),
        whatThisIs: "A personal reset tool: breathing pacer and reminders.",
      };

    case "global":
    default:
      return {
        tab: "global",
        tone,
        topLine: headlineRegime || (known ? `${cap(regimeWord(currentRegime))} regime · ${whaleSummary.charAt(0).toLowerCase() + whaleSummary.slice(1)}.` : `Regime unknown · ${whaleSummary.charAt(0).toLowerCase() + whaleSummary.slice(1)}.`),
        subLine: "",
        bullets: [],
        asOf: Date.now(),
        whatThisIs: "",
      };
  }
}
