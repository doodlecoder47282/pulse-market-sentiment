// headline.ts
// Plain-English synthesis of the current market state per tab.
// Reads from existing endpoints/services — does NOT recompute analytics.
// Goal: one human sentence + 2-3 bullets the user can read in 3 seconds.

import { predictTransition } from "./regimePredictor";
import { getWhaleAlertHistory } from "./whalePersistence";

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

async function safeFetch<T = any>(url: string, ms = 1500): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(url, { signal: ctrl.signal as any });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function regimeWord(r: string): string {
  switch (r) {
    case "TREND_STRONG": return "strong trend";
    case "TREND_WEAK": return "weak trend";
    case "NEUTRAL": return "neutral";
    case "CHOP_WEAK": return "light chop";
    case "CHOP_STRONG": return "heavy chop";
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
  const base = `http://127.0.0.1:${port}`;

  // Always-on shared context: current regime + transition prediction
  const [regime, models, whaleHist] = await Promise.all([
    safeFetch<any>(`${base}/api/regime`),
    safeFetch<any>(`${base}/api/regime/predict?symbol=^GSPC&horizonMinutes=20`, 2500),
    Promise.resolve(getWhaleAlertHistory({ days: 1, symbol: "SPY", limit: 50 })).catch(() => []),
  ]);

  const currentRegime = String(models?.currentRegime ?? "NEUTRAL");
  const headlineRegime = String(models?.headline ?? "");
  const tone = regimeTone(currentRegime);

  // Whale flow last hour — quick directional read
  const cutoff = Date.now() - 60 * 60_000;
  const recent = (whaleHist as any[]).filter((w) => w?.detectedAt >= cutoff);
  const calls = recent.filter((w) => w.type === "C").length;
  const puts = recent.filter((w) => w.type === "P").length;
  const whaleSummary = recent.length === 0
    ? "no whale flow this hour"
    : calls > puts * 1.5
    ? `${recent.length} whales, calls leading ${calls}-${puts}`
    : puts > calls * 1.5
    ? `${recent.length} whales, puts leading ${puts}-${calls}`
    : `${recent.length} whales, mixed (${calls}C / ${puts}P)`;

  // Per-tab synthesis
  switch (tab) {
    case "signals":
      return {
        tab,
        tone,
        topLine: headlineRegime || `${regimeWord(currentRegime)} regime — read whale flow against it.`,
        subLine: whaleSummary,
        bullets: [
          "Signals tab shows fresh whale detections, tracked positions, and recently-closed plays.",
          "Whale criteria: $1M+ premium, vol/OI 10x or new strike, ABOVE_ASK, dte≥1.",
          tone === "bull" ? "Trend regime — call-heavy whale herding reinforces direction." :
          tone === "warning" ? "Chop regime — whale flow is noisier, weight CLV not P&L." :
          "Neutral regime — only act on highest-conviction whales.",
        ],
        asOf: Date.now(),
        whatThisIs: "Whale flow — $1M+ option blocks that hit unusual size, with tracking and outcomes.",
      };

    case "chart":
      return {
        tab,
        tone,
        topLine: `SPX cash chart with dealer levels — ${regimeWord(currentRegime)} regime.`,
        subLine: tone === "bull" ? "Direction set, ride pullbacks to mainPivot." :
                 tone === "warning" ? "Range-bound, fade into call/put walls." :
                 "Watch DFI for transition before committing.",
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
        topLine: `${regimeWord(currentRegime)} regime — composite model output.`,
        subLine: "ML Lab below shows forward path scenarios (bull q90, base q50, bear q10).",
        bullets: [
          "Composite score blends DFI, gamma zone, IV term, vanna bias, charm pin, flow.",
          "ML Lab projects the next 60-240 minutes with confidence bands.",
          "Model D (morning anchor) blends in 9:45-16:00 ET when opening fingerprint is set.",
        ],
        asOf: Date.now(),
        whatThisIs: "Composite probability score plus the ML forward-path projection (1-4 hours out).",
      };

    case "heatseeker":
      return {
        tab,
        tone,
        topLine: "0DTE SPX live Greek scanner — $1M+ premium, hot strikes, sticky zones.",
        subLine: tone === "warning"
          ? "Heavy chop — pin behavior favors deep OTM premium decay, not directional 0DTE."
          : tone === "bull"
          ? "Trend regime — ATM/slightly-OTM 0DTE in the trend direction has best edge."
          : "Neutral regime — only chase 0DTE on confirmed dealer level breaks.",
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
        topLine: `${regimeWord(currentRegime)} regime — what's the next 20-min likely look like?`,
        subLine: "What's Next panel below scores transition probability across regime buckets.",
        bullets: [
          "Predictor uses DFI slope, gamma flip, vanna, charm, IV term, VIX term, whale pressure.",
          "Confidence ≥70% = transition signal worth acting on. <40% = stand aside.",
          "Warming-up state means <5 samples collected — wait, don't trade on it.",
        ],
        asOf: Date.now(),
        whatThisIs: "Forward-looking regime forecast — what the next 20 minutes likely look like.",
      };

    case "regime":
      return {
        tab,
        tone,
        topLine: `Macro + sector + correlation read — ${regimeWord(currentRegime)} micro-regime.`,
        subLine: "Sector rotation map and JPM collar levels frame the macro context.",
        bullets: [
          "JPM Collar Q2 2026: ceiling 6865, floor 6180, lower put 5210. Reset 2026-06-30.",
          "Sector web shows leadership rotation — risk-on (tech/discretionary) vs risk-off (staples/utilities).",
          "WEF themes map narratives to ticker baskets for thematic flow tracking.",
        ],
        asOf: Date.now(),
        whatThisIs: "Macro context — sector rotation, dealer collar levels, narrative themes.",
      };

    case "cosmos":
      return {
        tab,
        tone: "neutral",
        topLine: "Astrology + sky engine — exotic regime context.",
        subLine: "Treat as background coloring, not signal. CLV beats narrative.",
        bullets: [
          "Lunar phase, planetary aspects, transits — historical correlations are weak but present.",
          "Useful as a tiebreaker when DFI + flow are split, not as primary signal.",
          "Outside model ensemble — view-only.",
        ],
        asOf: Date.now(),
        whatThisIs: "Cosmic / astrological backdrop — color, not conviction.",
      };

    case "news":
      return {
        tab,
        tone: "neutral",
        topLine: "Market-relevant headlines and macro events.",
        subLine: "Filter: SPX-relevant, Fed/Treasury, geopolitics, OpEx/FOMC calendar.",
        bullets: [
          "Headlines update continuously from Reuters, Bloomberg, SEC.",
          "Reddit and anonymous blogs are filtered out — primary sources only.",
          "Calendar effects (FOMC, OpEx, holidays) reshape regime — check before trading.",
        ],
        asOf: Date.now(),
        whatThisIs: "High-quality news — primary sources only, filtered for SPX relevance.",
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
          "Disagreement between voices and your data = reduce size, don't override.",
        ],
        asOf: Date.now(),
        whatThisIs: "Curated commentary from traders with track records — confirmation, not signal.",
      };

    case "takefive":
      return {
        tab,
        tone: "neutral",
        topLine: "Daily 5-bullet wrap — the things that mattered.",
        subLine: "Read at the close, plan tomorrow.",
        bullets: [
          "Auto-built from regime, flow, news, calendar.",
          "Review at 4:05 PM ET, adjust thesis for tomorrow.",
          "If 4 of 5 bullets disagree with your bias — flag the bias.",
        ],
        asOf: Date.now(),
        whatThisIs: "End-of-day 5-bullet recap — the day's regime, flow, and what shifts tomorrow.",
      };

    case "global":
    default:
      return {
        tab: "global",
        tone,
        topLine: headlineRegime || `${regimeWord(currentRegime)} regime — ${whaleSummary}.`,
        subLine: "",
        bullets: [],
        asOf: Date.now(),
        whatThisIs: "",
      };
  }
}
