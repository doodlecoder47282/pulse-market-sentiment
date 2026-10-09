// server/tradeEnvironment.ts
//
// TRADE ENVIRONMENT — a HEURISTIC composite of market conditions (R2-C 5/8).
//
// The terminal already computes the raw ingredients in separate modules. This
// module adds hand-set points into a 0-100 "convexity index" and a discrete
// state. The points are NOT fitted to outcomes and the index is not a
// forecast; it gives no entry, sizing or "edge" instruction:
//
//   STAND_DOWN  — few drivers active.
//   CHOP        — dealers long gamma, quiet tick volume, calm vol curve.
//   NORMAL      — no unusual combination of drivers.
//   LOADED      — several move-related conditions present at once.
//   STRIKE      — short gamma + expanding range + directional tick volume together.
//
// Scoring components (hand-set points, summed). They are NOT independent:
// short gamma, range expansion and an inverted VIX curve tend to occur
// together, so the sum double-counts shared information.
//   1. Dealer gamma posture   (0-28)  net GEX sign/magnitude, distance to flip
//   2. Vol term structure     (0-22)  VIX9D>VIX inversion, VIX3M<VIX backwardation, VIX level
//   3. Range expansion        (0-15)  last-30m realized range vs time-scaled ATR(20)
//   4. Tick-volume impulse    (0-10)  signed tick volume trend + acceleration (tick rule, SPY 1m)
//   5. Canary stress          (0-12)  cross-asset divergence/alarm composite
//   6. Whale conflux          (0-10)  same-direction $2.5M+ blocks in last 60m
//   7. Wall proximity         (0-8)   spot hugging put/call wall while short gamma
//
// A driver whose input failed is dataState "unavailable" and scores 0 with a
// note saying so (the index is then understated and `degraded` is true);
// it is never shown as a quiet reading.
//
// Calibration pipeline (convexityFit.ts): each 30-minute RTH bucket logs the
// driver points; 30 minutes later the realized SPY range is graded against
// the time-scaled ATR. fitConvexityWeights reports, behind a session-count
// gate, whether the points relate to forward range. The live index keeps the
// hand-set points until a reviewed fit is promoted.
//
// This module touches NO locked engines. It reads public helpers only.

import { getQuote } from "./sources";
import { getPriceHistory } from "./schwab";
import { computeOfiTrend } from "./leeReadyOfi";
import { buildCanarySnapshot } from "./canary";
import { sqlite } from "./storage";
import { postToDiscord } from "./discord";
import { etDate as calEtDate, sessionCloseMinutes as calCloseMin, sessionOpenMs as calOpenMs, isRegularSessionOpen } from "./exchangeCalendar";
import { internalJson } from "./internalApi";
import { ofiTrendWindowComplete, ofiTapeStale } from "./ofiPayload";
import { fitConvexityWeights, forwardRange, type ConvexityFit, type ConvexitySample } from "./convexityFit";

import { classifyEnvState, type TradeEnvState } from "./tradeEnvState";
export type { TradeEnvState };

export interface EnvDriver {
  key: string;
  label: string;
  points: number;       // contribution to the index
  max: number;          // max possible for this component
  note: string;         // plain-language read of what this component sees
  /** "unavailable": the input failed; points are 0 and the index is understated. */
  dataState?: "ok" | "unavailable";
}

export interface TradeEnvironment {
  state: TradeEnvState;
  score: number;              // 0-100 convexity index
  headline: string;           // one-line description of the state (not advice)
  instructions: string[];     // context notes (field name kept for the client); no entry or size instructions
  drivers: EnvDriver[];
  session: "premarket" | "rth" | "afterhours" | "closed";
  asOf: number;
  degraded: boolean;          // true when key inputs were unavailable
  /** Honesty label shown with the index. */
  label: string;
  /** Fit of the driver points to forward realized range, behind a sample gate. */
  calibration?: Pick<ConvexityFit, "status" | "sessions" | "windows" | "minSessions" | "minWindows" | "note" | "oosR2" | "coefficients">;
}

export const TRADE_ENV_LABEL =
  "heuristic composite: hand-set points, not fitted to outcomes, not a forecast; drivers overlap (not independent)";

function sessionET(): TradeEnvironment["session"] {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  // Exchange calendar: holidays closed, half days close at 13:00 ET.
  const close = calCloseMin(calEtDate());
  if (close == null) return "closed";
  const mins = parseInt(p.find(x => x.type === "hour")?.value ?? "0", 10) * 60
    + parseInt(p.find(x => x.type === "minute")?.value ?? "0", 10);
  if (mins < 4 * 60) return "closed";
  if (mins < 9 * 60 + 30) return "premarket";
  if (mins < close) return "rth";
  if (mins < 20 * 60) return "afterhours";
  return "closed";
}

// ── whale conflux from whale_alerts (units-agnostic on detected_at) ──────────
// MISSION FIX #5 — conflux is weighted by the heuristic direction score: a
// heavy contract flagged as a likely spread leg or with volume inside prior OI
// counts fractionally. Rows without a score (legacy) count 0.75. Null when the
// alert table cannot be read (unavailable, not "no clustering").
function whaleConflux60m(): { bull: number; bear: number } | null {
  try {
    const rows = sqlite
      .prepare("SELECT sentiment, detected_at, directional_confidence FROM whale_alerts ORDER BY detected_at DESC LIMIT 300")
      .all() as Array<{ sentiment: string; detected_at: number; directional_confidence: number | null }>;
    const nowMs = Date.now();
    let bull = 0, bear = 0;
    for (const r of rows) {
      const ts = r.detected_at > 1e12 ? r.detected_at : r.detected_at * 1000;
      if (nowMs - ts > 60 * 60_000) continue;
      const w = r.directional_confidence != null && isFinite(r.directional_confidence)
        ? Math.max(0.2, Math.min(1, r.directional_confidence))
        : 0.75;
      const s = (r.sentiment || "").toUpperCase();
      if (s.includes("BULL")) bull += w;
      else if (s.includes("BEAR")) bear += w;
    }
    return { bull, bear };
  } catch {
    return null;
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

  // 1. Dealer gamma posture — from the app's own heatseeker endpoint (its data
  // source is the heatseeker's; an empty chain is "unavailable").
  let gammaPts = 0;
  let shortGamma = false;
  let nearFlip = false;
  let noMaterialGamma = false;
  let spot: number | null = null;
  let putWall: number | null = null;
  let callWall: number | null = null;
  try {
    // In-process /api/heatseeker handler (internalApi.ts): same cache and
    // payload as the route, no local HTTP hop. Non-2xx -> null, as before.
    const hs: any = await internalJson("/api/heatseeker?symbol=$SPX");
    // An empty chain is missing data, not "long gamma": report it as unknown.
    if (hs && Array.isArray(hs.strikes) && hs.strikes.length > 0) {
      spot = hs.spot ?? null;
      putWall = hs.totals?.putWall ?? null;
      callWall = hs.totals?.callWall ?? null;
      // Regime sign and flip come from the same re-priced profile
      // (gammaProfile.ts) so "short gamma" and "near the flip" can't disagree.
      // Older heatseeker payloads without the re-priced field fall back to the
      // per-strike sum.
      const repriced = hs.totals?.gexAtSpotRepriced;
      const netGex = typeof repriced === "number" && Number.isFinite(repriced)
        ? repriced
        : (hs.totals?.netGex ?? 0);
      const zeroGamma = hs.totals?.zeroGamma ?? null;
      // r2-b: gexSignAtSpot null = no material gamma at spot (inside the noise
      // floor): neither short nor long gamma, no sign points.
      const sign = hs.totals?.gexSignAtSpot;
      noMaterialGamma = sign === null;
      shortGamma = sign === -1 || (sign === undefined && netGex < 0);
      if (shortGamma) gammaPts += 20;
      if (spot && zeroGamma) {
        const distPct = Math.abs(spot - zeroGamma) / spot;
        nearFlip = distPct < 0.0025;
        if (nearFlip) gammaPts += 8;             // hugging the flip = spring loaded
        else if (!shortGamma && distPct > 0.008) gammaPts += 0; // deep long gamma = damped
      }
      drivers.push({
        key: "gamma", label: "dealer gamma", points: gammaPts, max: 28,
        note: noMaterialGamma
          ? "no material dealer gamma at spot (inside the noise floor) — neither amplifying nor damping."
          : shortGamma
          ? "dealers are SHORT gamma — their hedging amplifies every move. flushes and squeezes travel."
          : nearFlip
            ? "long gamma but price is hugging the flip line — one push through and the tape changes character."
            : "dealers are long gamma — they fade moves, rallies and dips both get absorbed.",
      });
    } else { degraded = true; }
  } catch { degraded = true; }
  const gammaOk = drivers.length > 0;
  if (!gammaOk) {
    drivers.push({ key: "gamma", label: "dealer gamma", points: 0, max: 28, note: "chain unavailable — gamma posture unknown (not scored, not a long-gamma read).", dataState: "unavailable" });
  }

  // 2. Vol term structure
  let volPts = 0;
  let volOk = false;
  let vixNote = "vol term structure unavailable (not scored).";
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
      volOk = true;
      vixNote = backwardated
        ? "VIX term structure is BACKWARDATED — the market is paying up for protection NOW. crisis posture."
        : inverted9d
          ? "9-day vol above 30-day — near-term event stress is priced. expect bigger swings this week."
          : vix.last >= 20
            ? "VIX elevated but curve normal — energy available, no panic."
            : "vol is cheap and the curve is calm — big sustained moves need a catalyst.";
    } else { degraded = true; }
  } catch { degraded = true; }
  drivers.push({ key: "vol", label: "vol term structure", points: volPts, max: 22, note: vixNote, dataState: volOk ? "ok" : "unavailable" });

  // 3. Range expansion — last 30m realized vs time-scaled ATR(20)
  let rangePts = 0;
  let rangeOk = false;
  let rangeNote = "range data unavailable (not scored).";
  let minuteBars: Array<{ datetime: number; high: number; low: number }> = [];
  let expected30mPts: number | null = null;
  try {
    const [mins, days] = await Promise.all([
      getPriceHistory("SPY", "day", 1, "minute", 1),
      getPriceHistory("SPY", "month", 1, "daily", 1),
    ]);
    minuteBars = (mins.candles ?? []) as any;
    const mBars = mins.candles.slice(-30);
    const dBars = days.candles.slice(-21, -1);
    if (mBars.length >= 10 && dBars.length >= 10) {
      const hi = Math.max(...mBars.map((c: any) => c.high));
      const lo = Math.min(...mBars.map((c: any) => c.low));
      const r30 = hi - lo;
      const atr = dBars.reduce((a: number, c: any) => a + (c.high - c.low), 0) / dBars.length;
      const expected30m = atr * Math.sqrt(30 / 390);
      if (expected30m > 0) expected30mPts = expected30m;
      const ratio = expected30m > 0 ? r30 / expected30m : 0;
      rangeOk = expected30m > 0;
      if (ratio >= 1.6) rangePts = 15;
      else if (ratio >= 1.15) rangePts = 8;
      rangeNote = ratio >= 1.6
        ? `realized range is ${ratio.toFixed(1)}x normal — the tape is MOVING. expansion regime confirmed.`
        : ratio >= 1.15
          ? `range running ${ratio.toFixed(1)}x normal — slightly hot, watch for follow-through.`
          : `range is ${ratio.toFixed(1)}x normal — inside the expected envelope, nothing breaking out.`;
    }
  } catch { degraded = true; }
  if (!rangeOk) degraded = true;
  drivers.push({ key: "range", label: "range expansion", points: rangePts, max: 15, note: rangeNote, dataState: rangeOk ? "ok" : "unavailable" });

  // 4. Signed tick volume (tick rule on SPY 1m bars; not order-flow imbalance)
  let ofiPts = 0;
  let ofiOk = true;
  let ofiNote = "signed tick volume flat.";
  try {
    const ofi = await computeOfiTrend();
    if (ofi.dataState === "unavailable") {
      ofiOk = false;
      ofiNote = "signed tick volume unavailable (no SPY minute bars) — not scored, not a flat read.";
    } else if (ofiTapeStale(ofi.bars, Date.now(), isRegularSessionOpen())) {
      ofiOk = false; // r2-g refusal: stale tape is not a balanced read
      ofiNote = "signed tick volume stale (last SPY minute bar older than 5 min in the session) — not scored.";
    } else if (!ofiTrendWindowComplete(ofi.bars)) {
      // dataState "partial" (or < 15 bars): the 15m slope is an incomplete sum.
      ofiOk = false;
      ofiNote = "signed tick volume incomplete (fewer than 15 bars, or bars missing volume in the 15-bar window) — not scored.";
    } else if (ofi.trend !== "NEUTRAL") {
      ofiPts += 5;
      if (ofi.acceleration === "ACCELERATING") ofiPts += 5;
      ofiNote = `${ofi.trend.toLowerCase()} signed tick volume${ofi.acceleration === "ACCELERATING" ? " and ACCELERATING" : ", steady"} (tick rule on SPY 1m bars, not trade-level aggressor data).`;
    } else {
      ofiNote = "signed tick volume is balanced.";
    }
  } catch { ofiOk = false; ofiNote = "signed tick volume unavailable (error) — not scored."; }
  if (!ofiOk) degraded = true;
  drivers.push({ key: "ofi", label: "tick-volume impulse", points: ofiPts, max: 10, note: ofiNote, dataState: ofiOk ? "ok" : "unavailable" });

  // 5. Canary stress
  let canaryPts = 0;
  let canaryOk = false;
  let canaryNote = "cross-asset canaries quiet.";
  try {
    const c = await buildCanarySnapshot();
    canaryOk = c != null && typeof c.read === "string" && c.read !== "no_data";
    if (c.read === "alarm") { canaryPts = 12; canaryNote = "cross-asset ALARM — credit/FX/commodities are all flashing risk-off while equities lag. the floor is being tested."; }
    else if (c.read === "divergence") { canaryPts = 8; canaryNote = "canary divergence — cross-asset stress the equity tape isn't showing yet. early warning."; }
    else if (c.read === "canaries_chirping") { canaryPts = 4; canaryNote = "some cross-asset pressure building, not confirmed."; }
  } catch { canaryOk = false; }
  if (!canaryOk) { degraded = true; canaryPts = 0; canaryNote = "cross-asset canaries unavailable — not scored, not a quiet read."; }
  drivers.push({ key: "canary", label: "cross-asset canaries", points: canaryPts, max: 12, note: canaryNote, dataState: canaryOk ? "ok" : "unavailable" });

  // 6. Heavy-contract conflux (whale alerts, weighted by the heuristic direction score)
  const wc = whaleConflux60m();
  if (!wc) degraded = true;
  const confluxN = wc ? Math.max(wc.bull, wc.bear) : 0;  // score-weighted sum, not raw count
  const whalePts = confluxN >= 2.5 ? 10 : confluxN >= 1.5 ? 5 : 0;
  drivers.push({
    key: "whales", label: "whale conflux", points: whalePts, max: 10,
    dataState: wc ? "ok" : "unavailable",
    note: !wc
      ? "whale alert history unavailable — not scored, not a quiet read."
      : confluxN >= 2.5
        ? `${confluxN.toFixed(1)} score-weighted same-direction heavy contracts (${wc.bull >= wc.bear ? "call-side" : "put-side"} by last-print side) in the last hour. Heavy day premium can be hedges, spread legs or closing trades; it is not evidence of informed positioning.`
        : confluxN >= 1.5
          ? "some same-direction heavy-contract premium in the last hour."
          : "no meaningful heavy-contract clustering in the last hour.",
  });

  // 7. Wall proximity (only matters when short gamma — that's when breaks travel)
  let wallPts = 0;
  let wallNote = gammaOk ? "not pressing a wall." : "walls unavailable (no chain) — not scored.";
  if (spot && shortGamma) {
    const nearPut = putWall != null && Math.abs(spot - putWall) / spot < 0.003 && spot >= putWall;
    const nearCall = callWall != null && Math.abs(spot - callWall) / spot < 0.003 && spot <= callWall;
    if (nearPut) { wallPts = 8; wallNote = `price is sitting ON the put wall (${putWall}) while short gamma — if it gives, the flush accelerates. floor-break watch.`; }
    else if (nearCall) { wallPts = 8; wallNote = `price is pressing the call wall (${callWall}) while short gamma — a break runs, squeeze watch.`; }
  }
  drivers.push({ key: "wall", label: "wall proximity", points: wallPts, max: 8, note: wallNote, dataState: gammaOk ? "ok" : "unavailable" });

  const score = Math.min(100, Math.round(drivers.reduce((a, d) => a + d.points, 0)));

  // State mapping (tradeEnvState.ts; SF-1: missing drivers never read as quiet)
  const missing = drivers.filter((d) => d.dataState === "unavailable").map((d) => d.key);
  const state: TradeEnvState = classifyEnvState({ score, shortGamma, gammaPts, rangePts, ofiPts, volPts, missing, noMaterialGamma });

  // R2-C 5/8: descriptive only. The old text issued orders ("size up on
  // confirmation", "trade WITH the break", "normal size", "no trade") from
  // hand-set points that have never been fitted to outcomes.
  const headline =
    state === "UNAVAILABLE" ? "dealer gamma, vol term structure and range inputs are all unavailable: no environment read." :
    state === "PARTIAL" ? `partial read: ${missing.join(", ")} unavailable, so the index (${score}) is a lower bound and no quiet state is claimed.` :
    state === "STRIKE" ? "short gamma, expanding range and directional tick volume are present together (heuristic composite)." :
    state === "LOADED" ? "several conditions associated with larger moves are present at once (heuristic composite)." :
    state === "NORMAL" ? "no unusual combination of drivers (heuristic composite)." :
    state === "CHOP" ? "dealers long gamma, quiet tick volume, calm vol curve: range-bound conditions (heuristic composite)." :
    "few drivers active (heuristic composite).";

  const CONTEXT_ONLY = "context only: hand-set points, not a forecast; no entry or size comes from this index";
  const instructions =
    state === "STRIKE" ? [
      "dealer short gamma tends to amplify moves in both directions; realized range is already above normal",
      CONTEXT_ONLY,
    ] : state === "LOADED" ? [
      "the drivers below name the levels involved (flip, walls); check them against your own plan",
      CONTEXT_ONLY,
    ] : state === "CHOP" ? [
      "long-gamma hedging tends to damp moves while it lasts",
      CONTEXT_ONLY,
    ] : [CONTEXT_ONLY];
  if (degraded) instructions.push("some drivers are unavailable and score 0, so the index is understated");

  // Calibration pipeline: log this bucket's driver points, grade older
  // buckets against the realized range that followed, report the gated fit.
  try { logAndGradeConvexity(drivers, session, minuteBars, expected30mPts); } catch { /* never blocks the read */ }

  const data: TradeEnvironment = {
    state, score, headline, instructions, drivers, session,
    asOf: Date.now(), degraded,
    label: TRADE_ENV_LABEL,
    calibration: convexityCalibration(),
  };
  _cache = { at: Date.now(), data };
  return data;
}

// ── convexity calibration log (convexityFit.ts) ─────────────────────────────
try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS trade_env_log (
      bucket TEXT PRIMARY KEY,           -- session date + 30-minute bucket index
      session_date TEXT NOT NULL,
      ts INTEGER NOT NULL,               -- ms of the logged read
      drivers_json TEXT NOT NULL,        -- {key: {points|null, max}}
      expected30m REAL,                  -- ATR20 x sqrt(30/390), SPY points
      fwd_range REAL,                    -- realized SPY high-low over (ts, ts+30m]
      graded_at INTEGER
    );
  `);
} catch (e) {
  console.warn("[tradeEnv] trade_env_log init failed:", (e as Error).message);
}

function logAndGradeConvexity(
  drivers: EnvDriver[],
  session: TradeEnvironment["session"],
  bars: Array<{ datetime: number; high: number; low: number }>,
  expected30m: number | null,
): void {
  const now = Date.now();
  const d = calEtDate(now);
  const open = calOpenMs(d);
  if (session === "rth" && open != null && now >= open) {
    const bucket = `${d}#${Math.floor((now - open) / 1_800_000)}`;
    const dj: Record<string, { points: number | null; max: number }> = {};
    for (const x of drivers) dj[x.key] = { points: x.dataState === "unavailable" ? null : x.points, max: x.max };
    sqlite.prepare(`INSERT OR IGNORE INTO trade_env_log (bucket, session_date, ts, drivers_json, expected30m) VALUES (?, ?, ?, ?, ?)`)
      .run(bucket, d, now, JSON.stringify(dj), expected30m);
  }
  if (!bars.length) return;
  const pending = sqlite.prepare(`SELECT bucket, ts FROM trade_env_log WHERE graded_at IS NULL AND session_date = ? AND ts <= ?`)
    .all(d, now - 35 * 60_000) as Array<{ bucket: string; ts: number }>;
  for (const r of pending) {
    const fr = forwardRange(bars, r.ts);
    // Too few bars: retry for 2 h (late minute bars), then close it out as
    // ungraded (fwd_range NULL, excluded from the fit), never a 0 range.
    if (fr == null && now - r.ts < 2 * 3600_000) continue;
    sqlite.prepare(`UPDATE trade_env_log SET fwd_range = ?, graded_at = ? WHERE bucket = ?`).run(fr, now, r.bucket);
  }
}

let fitCache: { at: number; fit: ConvexityFit } | null = null;
function convexityCalibration(): TradeEnvironment["calibration"] {
  try {
    if (!fitCache || Date.now() - fitCache.at > 10 * 60_000) {
      const rows = sqlite.prepare(`SELECT session_date, ts, drivers_json, expected30m, fwd_range FROM trade_env_log WHERE fwd_range IS NOT NULL`)
        .all() as Array<{ session_date: string; ts: number; drivers_json: string; expected30m: number | null; fwd_range: number }>;
      const samples: ConvexitySample[] = rows.map((r) => {
        const dj = JSON.parse(r.drivers_json) as Record<string, { points: number | null; max: number }>;
        const points: Record<string, number | null> = {};
        const max: Record<string, number> = {};
        for (const [k, v] of Object.entries(dj)) { points[k] = v.points; max[k] = v.max; }
        return { sessionDate: r.session_date, ts: r.ts, points, max, fwdRatio: r.expected30m && r.expected30m > 0 ? r.fwd_range / r.expected30m : null };
      });
      fitCache = { at: Date.now(), fit: fitConvexityWeights(samples) };
    }
    const f = fitCache.fit;
    return { status: f.status, sessions: f.sessions, windows: f.windows, minSessions: f.minSessions, minWindows: f.minWindows, note: f.note, oosR2: f.oosR2, coefficients: f.coefficients };
  } catch {
    return undefined;
  }
}

// ── watch loop: alert on upward state transitions during RTH ────────────────
const RANK: Record<TradeEnvState, number> = { STAND_DOWN: 0, CHOP: 0, NORMAL: 1, LOADED: 2, STRIKE: 3, PARTIAL: -1, UNAVAILABLE: -1 };
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
          content: `**TRADE ENVIRONMENT → ${env.state}** (heuristic convexity index ${env.score}/100, hand-set points)\n${env.headline}\n${top}`,
        }).catch(() => {});
      }
    } catch { /* never crash the loop */ }
  }, 60_000);
  console.log("[tradeEnv] watch started — 60s cadence, alerts on LOADED/STRIKE transitions, 30min refire cap");
}
