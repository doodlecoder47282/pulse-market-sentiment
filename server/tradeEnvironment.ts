// server/tradeEnvironment.ts
//
// TRADE ENVIRONMENT ENGINE — one fused answer to "should I be trading right now,
// and if so, how aggressively?"
//
// The terminal already computes the raw ingredients in separate modules. This
// engine fuses them into a single 0-100 CONVEXITY INDEX and a discrete state:
//
//   STAND_DOWN  — no edge visible. Quiet tape, no flow, nothing to do. Don't trade.
//   CHOP        — long-gamma pin day. Moves get sold. Scalp band edges small or skip.
//   NORMAL      — standard playbook. Trade the levels, normal size.
//   LOADED      — spring is compressing. Conditions for a big move are stacking.
//                 Get flat-footed: alerts on, size ready, watch the trigger levels.
//   STRIKE      — convexity is LIVE. Short gamma + expanding range + directional
//                 flow = flushes and squeezes travel. This is the window.
//
// Scoring components (independent, transparent, summed):
//   1. Dealer gamma posture   (0-28)  net GEX sign/magnitude, distance to flip
//   2. Vol term structure     (0-22)  VIX9D>VIX inversion, VIX3M<VIX backwardation, VIX level
//   3. Range expansion        (0-15)  last-30m realized range vs time-scaled ATR(20)
//   4. Order-flow impulse     (0-10)  Lee-Ready OFI trend + acceleration
//   5. Canary stress          (0-12)  cross-asset divergence/alarm composite
//   6. Whale conflux          (0-10)  same-direction $2.5M+ blocks in last 60m
//   7. Wall proximity         (0-8)   spot hugging put/call wall while short gamma
//
// This module touches NO locked engines. It reads public helpers only.

import { getQuote } from "./sources";
import { getPriceHistory } from "./schwab";
import { computeOfiTrend } from "./leeReadyOfi";
import { buildCanarySnapshot } from "./canary";
import { sqlite } from "./storage";
import { postToDiscord } from "./discord";

export type TradeEnvState = "STAND_DOWN" | "CHOP" | "NORMAL" | "LOADED" | "STRIKE";

export interface EnvDriver {
  key: string;
  label: string;
  points: number;       // contribution to the index
  max: number;          // max possible for this component
  note: string;         // plain-language read of what this component sees
}

export interface TradeEnvironment {
  state: TradeEnvState;
  score: number;              // 0-100 convexity index
  headline: string;           // one-liner verdict
  instructions: string[];     // 2-4 concrete "what to do" lines
  drivers: EnvDriver[];
  session: "premarket" | "rth" | "afterhours" | "closed";
  asOf: number;
  degraded: boolean;          // true when key inputs were unavailable
}

function sessionET(): TradeEnvironment["session"] {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const wd = p.find(x => x.type === "weekday")?.value ?? "";
  if (wd === "Sat" || wd === "Sun") return "closed";
  const mins = parseInt(p.find(x => x.type === "hour")?.value ?? "0", 10) * 60
    + parseInt(p.find(x => x.type === "minute")?.value ?? "0", 10);
  if (mins < 4 * 60) return "closed";
  if (mins < 9 * 60 + 30) return "premarket";
  if (mins < 16 * 60) return "rth";
  if (mins < 20 * 60) return "afterhours";
  return "closed";
}

// ── whale conflux from whale_alerts (units-agnostic on detected_at) ──────────
function whaleConflux60m(): { bull: number; bear: number } {
  try {
    const rows = sqlite
      .prepare("SELECT sentiment, detected_at FROM whale_alerts ORDER BY detected_at DESC LIMIT 300")
      .all() as Array<{ sentiment: string; detected_at: number }>;
    const nowMs = Date.now();
    let bull = 0, bear = 0;
    for (const r of rows) {
      const ts = r.detected_at > 1e12 ? r.detected_at : r.detected_at * 1000;
      if (nowMs - ts > 60 * 60_000) continue;
      const s = (r.sentiment || "").toUpperCase();
      if (s.includes("BULL")) bull++;
      else if (s.includes("BEAR")) bear++;
    }
    return { bull, bear };
  } catch {
    return { bull: 0, bear: 0 };
  }
}

// ── main build (cached 60s) ──────────────────────────────────────────────────
let _cache: { at: number; data: TradeEnvironment } | null = null;
const CACHE_MS = 60_000;

export async function buildTradeEnvironment(): Promise<TradeEnvironment> {
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache.data;

  const session = sessionET();
  const drivers: EnvDriver[] = [];
  let degraded = false;

  // 1. Dealer gamma posture — from our own heatseeker endpoint (gets Schwab→CBOE
  // fallback + SPY→SPX rescale for free).
  let gammaPts = 0;
  let shortGamma = false;
  let nearFlip = false;
  let spot: number | null = null;
  let putWall: number | null = null;
  let callWall: number | null = null;
  try {
    const port = process.env.PORT || 5000;
    const r = await fetch(`http://127.0.0.1:${port}/api/heatseeker?symbol=$SPX`);
    if (r.ok) {
      const hs: any = await r.json();
      spot = hs.spot ?? null;
      putWall = hs.totals?.putWall ?? null;
      callWall = hs.totals?.callWall ?? null;
      const netGex = hs.totals?.netGex ?? 0;
      const zeroGamma = hs.totals?.zeroGamma ?? null;
      shortGamma = netGex < 0;
      if (shortGamma) gammaPts += 20;
      if (spot && zeroGamma) {
        const distPct = Math.abs(spot - zeroGamma) / spot;
        nearFlip = distPct < 0.0025;
        if (nearFlip) gammaPts += 8;             // hugging the flip = spring loaded
        else if (!shortGamma && distPct > 0.008) gammaPts += 0; // deep long gamma = damped
      }
      drivers.push({
        key: "gamma", label: "dealer gamma", points: gammaPts, max: 28,
        note: shortGamma
          ? "dealers are SHORT gamma — their hedging amplifies every move. flushes and squeezes travel."
          : nearFlip
            ? "long gamma but price is hugging the flip line — one push through and the tape changes character."
            : "dealers are long gamma — they fade moves, rallies and dips both get absorbed.",
      });
    } else { degraded = true; }
  } catch { degraded = true; }
  if (degraded && drivers.length === 0) {
    drivers.push({ key: "gamma", label: "dealer gamma", points: 0, max: 28, note: "chain unavailable — gamma posture unknown." });
  }

  // 2. Vol term structure
  let volPts = 0;
  let vixNote = "vol term structure unavailable.";
  try {
    const [vix, vix9d, vix3m] = await Promise.all([
      getQuote("^VIX"), getQuote("^VIX9D"), getQuote("^VIX3M"),
    ]);
    if (vix.last != null) {
      const inverted9d = vix9d.last != null && vix9d.last > vix.last;
      const backwardated = vix3m.last != null && vix3m.last < vix.last;
      if (inverted9d) volPts += 12;
      if (backwardated) volPts += 10;
      if (vix.last >= 20 && !backwardated) volPts += 4;
      vixNote = backwardated
        ? "VIX term structure is BACKWARDATED — the market is paying up for protection NOW. crisis posture."
        : inverted9d
          ? "9-day vol above 30-day — near-term event stress is priced. expect bigger swings this week."
          : vix.last >= 20
            ? "VIX elevated but curve normal — energy available, no panic."
            : "vol is cheap and the curve is calm — big sustained moves need a catalyst.";
    } else { degraded = true; }
  } catch { degraded = true; }
  drivers.push({ key: "vol", label: "vol term structure", points: volPts, max: 22, note: vixNote });

  // 3. Range expansion — last 30m realized vs time-scaled ATR(20)
  let rangePts = 0;
  let rangeNote = "range data unavailable.";
  try {
    const [mins, days] = await Promise.all([
      getPriceHistory("SPY", "day", 1, "minute", 1),
      getPriceHistory("SPY", "month", 1, "daily", 1),
    ]);
    const mBars = mins.candles.slice(-30);
    const dBars = days.candles.slice(-21, -1);
    if (mBars.length >= 10 && dBars.length >= 10) {
      const hi = Math.max(...mBars.map((c: any) => c.high));
      const lo = Math.min(...mBars.map((c: any) => c.low));
      const r30 = hi - lo;
      const atr = dBars.reduce((a: number, c: any) => a + (c.high - c.low), 0) / dBars.length;
      const expected30m = atr * Math.sqrt(30 / 390);
      const ratio = expected30m > 0 ? r30 / expected30m : 0;
      if (ratio >= 1.6) rangePts = 15;
      else if (ratio >= 1.15) rangePts = 8;
      rangeNote = ratio >= 1.6
        ? `realized range is ${ratio.toFixed(1)}x normal — the tape is MOVING. expansion regime confirmed.`
        : ratio >= 1.15
          ? `range running ${ratio.toFixed(1)}x normal — slightly hot, watch for follow-through.`
          : `range is ${ratio.toFixed(1)}x normal — inside the expected envelope, nothing breaking out.`;
    }
  } catch { /* keep defaults */ }
  drivers.push({ key: "range", label: "range expansion", points: rangePts, max: 15, note: rangeNote });

  // 4. Order-flow impulse
  let ofiPts = 0;
  let ofiNote = "order flow flat.";
  try {
    const ofi = await computeOfiTrend();
    if (ofi.trend !== "NEUTRAL") {
      ofiPts += 5;
      if (ofi.acceleration === "ACCELERATING") ofiPts += 5;
      ofiNote = `${ofi.trend.toLowerCase()} flow${ofi.acceleration === "ACCELERATING" ? " and ACCELERATING — someone is leaning on the tape with size" : ", steady pressure"}.`;
    } else {
      ofiNote = "signed volume is balanced — no one is forcing direction.";
    }
  } catch { /* flat */ }
  drivers.push({ key: "ofi", label: "order-flow impulse", points: ofiPts, max: 10, note: ofiNote });

  // 5. Canary stress
  let canaryPts = 0;
  let canaryNote = "cross-asset canaries quiet.";
  try {
    const c = await buildCanarySnapshot();
    if (c.read === "alarm") { canaryPts = 12; canaryNote = "cross-asset ALARM — credit/FX/commodities are all flashing risk-off while equities lag. the floor is being tested."; }
    else if (c.read === "divergence") { canaryPts = 8; canaryNote = "canary divergence — cross-asset stress the equity tape isn't showing yet. early warning."; }
    else if (c.read === "canaries_chirping") { canaryPts = 4; canaryNote = "some cross-asset pressure building, not confirmed."; }
  } catch { /* quiet */ }
  drivers.push({ key: "canary", label: "cross-asset canaries", points: canaryPts, max: 12, note: canaryNote });

  // 6. Whale conflux
  const wc = whaleConflux60m();
  const confluxN = Math.max(wc.bull, wc.bear);
  const whalePts = confluxN >= 3 ? 10 : confluxN === 2 ? 5 : 0;
  drivers.push({
    key: "whales", label: "whale conflux", points: whalePts, max: 10,
    note: confluxN >= 3
      ? `${confluxN} same-direction whale blocks (${wc.bull >= wc.bear ? "bullish" : "bearish"}) in the last hour — informed money is positioned for a move.`
      : confluxN === 2
        ? "a couple of same-direction whales in the last hour — watch for a third."
        : "no whale clustering in the last hour.",
  });

  // 7. Wall proximity (only matters when short gamma — that's when breaks travel)
  let wallPts = 0;
  let wallNote = "not pressing a wall.";
  if (spot && shortGamma) {
    const nearPut = putWall != null && Math.abs(spot - putWall) / spot < 0.003 && spot >= putWall;
    const nearCall = callWall != null && Math.abs(spot - callWall) / spot < 0.003 && spot <= callWall;
    if (nearPut) { wallPts = 8; wallNote = `price is sitting ON the put wall (${putWall}) while short gamma — if it gives, the flush accelerates. floor-break watch.`; }
    else if (nearCall) { wallPts = 8; wallNote = `price is pressing the call wall (${callWall}) while short gamma — a break runs, squeeze watch.`; }
  }
  drivers.push({ key: "wall", label: "wall proximity", points: wallPts, max: 8, note: wallNote });

  const score = Math.min(100, Math.round(drivers.reduce((a, d) => a + d.points, 0)));

  // State mapping
  let state: TradeEnvState;
  if (score >= 70) state = "STRIKE";
  else if (score >= 45) state = "LOADED";
  else if (score >= 25) state = "NORMAL";
  else state = shortGamma || rangePts > 0 ? "NORMAL" : (gammaPts === 0 && !shortGamma ? "CHOP" : "STAND_DOWN");
  // CHOP refinement: deep long gamma + quiet flow + calm vol = pin day
  if (score < 25 && !shortGamma && ofiPts === 0 && volPts === 0) state = "CHOP";
  else if (score < 25 && state !== "CHOP") state = "STAND_DOWN";

  const headline =
    state === "STRIKE" ? "convexity is LIVE — short gamma, expanding range, directional flow. this is the window to capture the big move." :
    state === "LOADED" ? "the spring is loading — conditions for a big move are stacking. get ready, watch the trigger levels." :
    state === "NORMAL" ? "tradeable tape — standard playbook, normal size, trade the levels." :
    state === "CHOP" ? "pin day — dealers long gamma, quiet flow, calm vol. moves get sold. scalp small or sit out." :
    "no edge visible — quiet tape, no flow, nothing stacked. flat is a position.";

  const instructions =
    state === "STRIKE" ? [
      "trade WITH the break, not against it — short gamma means moves extend",
      "size up on confirmation, but honor stops — accelerant cuts both ways",
      "watch the pivot bands: accelerant bands are go-zones, not fade-zones",
    ] : state === "LOADED" ? [
      "no chasing yet — wait for the trigger (wall break or flip cross on volume)",
      "pre-plan both directions: know your entry, stop, and target before it moves",
      "alerts on — this can go from LOADED to STRIKE inside one 15-min bar",
    ] : state === "NORMAL" ? [
      "trade the levels: fade exhaustion bands, respect accelerant bands",
      "normal size, standard risk — no reason to press",
    ] : state === "CHOP" ? [
      "fade the edges of the expected range, small size, quick targets",
      "or don't trade at all — chop days pay patience, not conviction",
    ] : [
      "no trade. preserve capital and attention for a LOADED/STRIKE day",
      "use the time: review levels, set alerts at the walls and flip",
    ];

  const data: TradeEnvironment = {
    state, score, headline, instructions, drivers, session,
    asOf: Date.now(), degraded,
  };
  _cache = { at: Date.now(), data };
  return data;
}

// ── watch loop: alert on upward state transitions during RTH ────────────────
const RANK: Record<TradeEnvState, number> = { STAND_DOWN: 0, CHOP: 0, NORMAL: 1, LOADED: 2, STRIKE: 3 };
let _lastState: TradeEnvState | null = null;
let _lastAlertAt = 0;
const REFIRE_MS = 30 * 60_000;

export function startTradeEnvironmentWatch(): void {
  setInterval(async () => {
    try {
      const session = sessionET();
      if (session !== "rth" && session !== "premarket") { _lastState = null; return; }
      const env = await buildTradeEnvironment();
      const prev = _lastState;
      _lastState = env.state;
      if (!prev) return;
      const up = RANK[env.state] > RANK[prev];
      const intoHot = env.state === "LOADED" || env.state === "STRIKE";
      if (up && intoHot && Date.now() - _lastAlertAt > REFIRE_MS) {
        _lastAlertAt = Date.now();
        const top = [...env.drivers].sort((a, b) => b.points - a.points).slice(0, 3)
          .map(d => `• ${d.note}`).join("\n");
        await postToDiscord({
          username: "BATCAVE",
          content: `**TRADE ENVIRONMENT → ${env.state}** (convexity ${env.score}/100)\n${env.headline}\n${top}`,
        }).catch(() => {});
      }
    } catch { /* never crash the loop */ }
  }, 60_000);
  console.log("[tradeEnv] watch started — 60s cadence, alerts on LOADED/STRIKE transitions, 30min refire cap");
}
