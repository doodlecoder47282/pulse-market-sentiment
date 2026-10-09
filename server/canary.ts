// Commodity / cross-asset CANARY module.
//
// Premise: commodities and risk-FX don't predict SPX — they confirm or DIVERGE
// from the equity regime. The edge is divergence detection: copper bleeding 2σ
// while SPX grinds higher into a long-gamma pin is information the equity tape
// doesn't show. Each canary's daily move is z-scored against its own 20d realized
// vol, signed into "risk-off pressure", and rolled into a composite. Divergence
// fires only when a canary signals risk-off while SPY itself is flat-to-up.
//
// Data: Schwab quotes (intraday changePercent) + daily_bars (20d vol). Ratio
// canaries (AUDJPY via FXA/FXY, copper/gold via CPER/GLD, credit via HYG/TLT)
// are computed from both legs. ETF proxies only — guaranteed on the equity feed.
//
// This module never touches the locked engines (signals/regime/dfi/models/composite).

import { sqlite } from "./storage";
import { etClock, isRegularSessionOpen, REGULAR_OPEN_MIN, sessionMinutes } from "./exchangeCalendar";
import { getQuotes, type NormalizedQuote } from "./schwab";
import { postToDiscord } from "./discord";
import { ledoitWolfConstantCorrelation, toCorrelation, standardizedComposite, compositeHistorySubset, empiricalQuantile } from "./macroStats";

// Partial-session variance scaling: intraday returns are compared against a
// FULL-day σ, which understates |z| ~3.6× at 10:00 ET. Scale σ by the elapsed
// fraction of daily variance (~25% overnight + 75% pro-rata through RTH).
function elapsedVarianceFrac(): number {
  const c = etClock();
  const len = sessionMinutes(c.date) || 390; // 210 on a half day
  const elapsedMin = Math.min(len, Math.max(0, c.minutes - REGULAR_OPEN_MIN)); // since 9:30
  return Math.max(0.15, 0.25 + 0.75 * (elapsedMin / len));
}

// ── config ──────────────────────────────────────────────────────────────────

interface CanaryDef {
  id: string;
  label: string;
  /** single symbol, or [numerator, denominator] ratio */
  legs: [string] | [string, string];
  /** +1 if UP in this series = risk-off (UUP, GLD); -1 if DOWN = risk-off */
  riskOffSign: 1 | -1;
  weight: number;
  note: string;
}

const CANARIES: CanaryDef[] = [
  { id: "audjpy", label: "AUDJPY (FXA/FXY)", legs: ["FXA", "FXY"], riskOffSign: -1, weight: 1.0, note: "the classic risk proxy — carry unwind shows here before equities" },
  { id: "cugold", label: "Copper/Gold (CPER/GLD)", legs: ["CPER", "GLD"], riskOffSign: -1, weight: 1.0, note: "growth vs fear — the cleanest macro canary" },
  { id: "crude", label: "Crude (USO)", legs: ["USO"], riskOffSign: -1, weight: 0.8, note: "demand read; a 2σ+ SPIKE is an inflation shock, also risk-off" },
  { id: "dxy", label: "Dollar (UUP)", legs: ["UUP"], riskOffSign: 1, weight: 0.9, note: "dollar squeeze = global risk-off transmission" },
  { id: "credit", label: "Credit (HYG/TLT)", legs: ["HYG", "TLT"], riskOffSign: -1, weight: 1.1, note: "credit leads equity — the adult in the room" },
  { id: "gold", label: "Gold (GLD)", legs: ["GLD"], riskOffSign: 1, weight: 0.5, note: "fear bid; slow but honest" },
];

export const CANARY_SYMBOLS = ["FXA", "FXY", "CPER", "GLD", "USO", "UUP", "HYG", "TLT", "SPY"];

const Z_WATCH = 1.0;
const Z_SIGNAL = 1.5;
const SPY_FLAT_FLOOR = -0.3;   // SPY z above this = "flat-to-up", divergence eligible
// The composite is a standardized score (finding 5.6): sum(w z) / sqrt(w' R w).
// It is N(0,1) only if the canary z's are Gaussian with 20-day vol as the
// true sd, which daily returns are not (fat tails, vol clustering). So the
// watch / alarm lines are the composite's OWN empirical one-sided 95th /
// 97.5th percentiles (and 5th for risk-on), from its close-to-close history
// over the same daily bars R is estimated on; the normal lines 1.645 / 1.96
// are reported beside them and used only when the history is too short.
const COMPOSITE_WATCH_Z = 1.645;
const COMPOSITE_ALARM_Z = 1.96;
const THRESH_MIN_HISTORY = 60;
// Correlation history for R: ~6 months of daily closes.
const CORR_LOOKBACK_DAYS = 126;
const CORR_MIN_DAYS = 60;

// ── daily-bars helpers ──────────────────────────────────────────────────────

interface DailyBar { date: string; close: number }

function loadBars(symbol: string, n: number): DailyBar[] {
  try {
    const rows = sqlite.prepare(
      `SELECT date, close FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT ?`,
    ).all(symbol, n) as DailyBar[];
    return rows.reverse();
  } catch { return []; }
}

/** aligned ratio series numerator/denominator by date */
function ratioSeries(a: DailyBar[], b: DailyBar[]): number[] {
  const bm = new Map(b.map(x => [x.date, x.close]));
  const out: number[] = [];
  for (const x of a) {
    const d = bm.get(x.date);
    if (d && d > 0 && x.close > 0) out.push(x.close / d);
  }
  return out;
}

function dailyVol(series: number[]): number | null {
  if (series.length < 12) return null;
  const r: number[] = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] > 0 && series[i] > 0) r.push(Math.log(series[i] / series[i - 1]));
  }
  if (r.length < 10) return null;
  const m = r.reduce((x, y) => x + y, 0) / r.length;
  const v = r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1);
  const sd = Math.sqrt(v);
  return sd > 0 ? sd : null;
}

/** date -> close for a canary (single symbol, or numerator/denominator ratio). */
function canaryCloseByDate(c: CanaryDef, n: number): Map<string, number> {
  const out = new Map<string, number>();
  if (c.legs.length === 1) {
    for (const b of loadBars(c.legs[0], n)) if (b.close > 0) out.set(b.date, b.close);
  } else {
    const bm = new Map(loadBars(c.legs[1], n).map((x) => [x.date, x.close]));
    for (const a of loadBars(c.legs[0], n)) {
      const d = bm.get(a.date);
      if (d && d > 0 && a.close > 0) out.set(a.date, a.close / d);
    }
  }
  return out;
}

export interface CanaryCorrelation {
  ids: string[];
  /** Ledoit-Wolf shrunk correlation of daily risk-off-signed returns */
  R: number[][];
  days: number;
  shrinkage: number;
  /** risk-off-signed daily log returns, oldest first (vol warm-up + R window) */
  X: number[][];
}

/**
 * Correlation of the canaries' daily risk-off-signed log returns over the
 * last ~6 months, on dates where every canary has a return, shrunk with
 * Ledoit-Wolf toward the constant-correlation target (keeps the average
 * correlation, so the composite's sd is not understated), then rescaled to
 * a correlation matrix.
 * The crude "spike is also risk-off" rule is non-linear and is not in R
 * (R uses the linear signed return); this is disclosed in the method label.
 */
function canaryCorrelation(): CanaryCorrelation | null {
  // R window plus 20 extra days so the composite history has a 20-day vol warm-up.
  const series = CANARIES.map((c) => canaryCloseByDate(c, CORR_LOOKBACK_DAYS + 21));
  const dateSets = series.map((m) => Array.from(m.keys()).sort());
  if (dateSets.some((d) => d.length < CORR_MIN_DAYS + 1)) return null;
  const common = dateSets[0].filter((d) => series.every((m) => m.has(d)));
  if (common.length < CORR_MIN_DAYS + 1) return null;
  const Xall: number[][] = [];
  for (let i = 1; i < common.length; i++) {
    Xall.push(CANARIES.map((c, j) => c.riskOffSign * Math.log(series[j].get(common[i])! / series[j].get(common[i - 1])!)));
  }
  const X = Xall.slice(-CORR_LOOKBACK_DAYS);
  const p = CANARIES.length;
  const sds = Array.from({ length: p }, (_, j) => {
    const col = X.map((r) => r[j]);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    return Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / (col.length - 1));
  });
  if (sds.some((v) => !(v > 0))) return null;
  const lw = ledoitWolfConstantCorrelation(X.map((r) => r.map((v, j) => v / sds[j])));
  if (!lw) return null;
  return { ids: CANARIES.map((c) => c.id), R: toCorrelation(lw.cov), days: X.length, shrinkage: lw.shrinkage, X: Xall };
}

// ── snapshot ────────────────────────────────────────────────────────────────

export interface CanaryRow {
  id: string;
  label: string;
  value: number | null;        // live price or ratio
  d1Pct: number | null;        // today's % move of the series
  z: number | null;            // d1 return / 20d daily vol
  riskOffZ: number | null;     // signed: positive = risk-off pressure
  status: "quiet" | "watch" | "risk_off" | "risk_on" | "no_data";
  diverging: boolean;          // risk-off signal while SPY flat-to-up
  weight: number;
  note: string;
}

export interface CanarySnapshot {
  asOf: string;
  marketSession: boolean;      // ETFs trade RTH only — z's are live only in-session
  spy: { d1Pct: number | null; z: number | null };
  composite: number | null;    // risk-off pressure as a z-score: sum(w z) / sqrt(w' R w)
  compositeMethod: string;
  compositeWeightedMean: number | null; // the old weighted mean, for reference (not a z)
  compositeEffectiveN: number | null;   // (sum w)^2 / (w' R w): independent canaries' worth
  correlation: { days: number; shrinkage: number } | null;
  /** watch / alarm / risk-on lines actually used, with the normal lines beside them */
  thresholds: {
    method: "empirical" | "normal";
    watch: number; alarm: number; riskOn: number;
    normalWatch: number; normalAlarm: number;
    historyDays: number;
    /** sd of the composite's daily history (1 if it were a true z) */
    realizedSd: number | null;
    note: string;
  };
  read: "confirming_risk_on" | "quiet" | "canaries_chirping" | "divergence" | "alarm" | "no_data";
  headline: string;
  canaries: CanaryRow[];
}

// Regular session per the exchange calendar (holidays, 13:00 half days).
function isRTH(): boolean {
  return isRegularSessionOpen();
}

let snapCache: { at: number; data: CanarySnapshot } | null = null;
const SNAP_TTL_MS = 60_000;

export async function buildCanarySnapshot(): Promise<CanarySnapshot> {
  if (snapCache && Date.now() - snapCache.at < SNAP_TTL_MS) return snapCache.data;

  const quotes = await getQuotes(CANARY_SYMBOLS);
  const qm = new Map<string, NormalizedQuote>(quotes.map(q => [q.symbol.toUpperCase(), q]));

  const liveRet = (sym: string): number | null => {
    const q = qm.get(sym);
    return q?.changePercent != null && Number.isFinite(q.changePercent) ? q.changePercent / 100 : null;
  };
  const livePx = (sym: string): number | null => {
    const q = qm.get(sym);
    return q?.last != null && q.last > 0 ? q.last : null;
  };

  const spyRet = liveRet("SPY");
  const spyBars = loadBars("SPY", 26);
  const spyVol = dailyVol(spyBars.map(b => b.close));
  const volScale = Math.sqrt(elapsedVarianceFrac());
  const spyZ = spyRet != null && spyVol ? spyRet / (spyVol * volScale) : null;

  const rows: CanaryRow[] = [];
  for (const c of CANARIES) {
    let value: number | null = null;
    let ret: number | null = null;
    let vol: number | null = null;

    if (c.legs.length === 1) {
      const s = c.legs[0];
      value = livePx(s);
      ret = liveRet(s);
      vol = dailyVol(loadBars(s, 26).map(b => b.close));
    } else {
      const [a, b] = c.legs;
      const pa = livePx(a), pb = livePx(b);
      value = pa != null && pb != null && pb > 0 ? pa / pb : null;
      const ra = liveRet(a), rb = liveRet(b);
      ret = ra != null && rb != null ? (1 + ra) / (1 + rb) - 1 : null;
      vol = dailyVol(ratioSeries(loadBars(a, 26), loadBars(b, 26)));
    }

    const z = ret != null && vol ? ret / (vol * volScale) : null;
    const riskOffZ = z != null ? z * c.riskOffSign : null;
    // crude special case: a big SPIKE is an inflation shock — also risk-off
    const effRiskOff = c.id === "crude" && z != null && z >= 2 ? Math.abs(z) : riskOffZ;

    let status: CanaryRow["status"] = "no_data";
    if (effRiskOff != null) {
      status = effRiskOff >= Z_SIGNAL ? "risk_off"
        : effRiskOff <= -Z_SIGNAL ? "risk_on"
        : Math.abs(effRiskOff) >= Z_WATCH ? "watch"
        : "quiet";
    }
    const diverging = status === "risk_off" && spyZ != null && spyZ >= SPY_FLAT_FLOOR;

    rows.push({
      id: c.id, label: c.label,
      value: value != null ? +value.toFixed(4) : null,
      d1Pct: ret != null ? +(ret * 100).toFixed(2) : null,
      z: z != null ? +z.toFixed(2) : null,
      riskOffZ: effRiskOff != null ? +effRiskOff.toFixed(2) : null,
      status, diverging, weight: c.weight, note: c.note,
    });
  }

  const valid = rows.filter(r => r.riskOffZ != null);
  let composite: number | null = null;
  let compositeWeightedMean: number | null = null;
  let compositeEffectiveN: number | null = null;
  let compositeMethod = "insufficient canaries (need 3 with data)";
  const corr = canaryCorrelation();
  // Empirical thresholds from the composite's own close-to-close history.
  let thresholds: CanarySnapshot["thresholds"] = {
    method: "normal", watch: COMPOSITE_WATCH_Z, alarm: COMPOSITE_ALARM_Z, riskOn: -COMPOSITE_WATCH_Z,
    normalWatch: COMPOSITE_WATCH_Z, normalAlarm: COMPOSITE_ALARM_Z, historyDays: 0, realizedSd: null,
    note: "composite history unavailable: normal one-sided lines used",
  };
  // Thresholds come from the history of the SAME composite as the live one:
  // the canaries with a live z today (when 3+ do), with their weights and
  // correlation block. A composite of 4 canaries has a different spread from
  // one of 6, so mixing the two mis-states how rare today's reading is.
  const liveCols = valid.map((r) => CANARIES.findIndex((c) => c.id === r.id)).filter((i) => i >= 0);
  const threshCols = liveCols.length >= 3 ? liveCols : CANARIES.map((_, i) => i);
  const threshSet = threshCols.length === CANARIES.length ? "all canaries" : `the ${threshCols.length} canaries live today (${threshCols.map((i) => CANARIES[i].id).join(", ")})`;
  if (corr) {
    const crudeIdx = CANARIES.findIndex((c) => c.id === "crude");
    const hist = compositeHistorySubset(corr.X, CANARIES.map((c) => c.weight), corr.R, threshCols, 20,
      // crude: a raw +2 sigma spike (risk-off signed z <= -2) is also risk-off, as live
      (j, z) => (j === crudeIdx && -z >= 2 ? Math.abs(z) : z));
    const m = hist.reduce((a, b) => a + b, 0) / Math.max(1, hist.length);
    const sd = hist.length > 1 ? Math.sqrt(hist.reduce((a, b) => a + (b - m) ** 2, 0) / (hist.length - 1)) : null;
    if (hist.length >= THRESH_MIN_HISTORY) {
      thresholds = {
        method: "empirical", watch: +empiricalQuantile(hist, 0.95).toFixed(2), alarm: +empiricalQuantile(hist, 0.975).toFixed(2),
        riskOn: +empiricalQuantile(hist, 0.05).toFixed(2), normalWatch: COMPOSITE_WATCH_Z, normalAlarm: COMPOSITE_ALARM_Z,
        historyDays: hist.length, realizedSd: sd != null ? +sd.toFixed(2) : null,
        note: `empirical 95th / 97.5th / 5th percentiles of ${hist.length} daily close-to-close composites of ${threshSet}, the same set as the live score (in-sample: R from the same window); normal lines ${COMPOSITE_WATCH_Z} / ${COMPOSITE_ALARM_Z} for reference`,
      };
    } else {
      thresholds = { ...thresholds, historyDays: hist.length, realizedSd: sd != null ? +sd.toFixed(2) : null,
        note: `only ${hist.length} days of composite history (need ${THRESH_MIN_HISTORY}): normal one-sided lines used` };
    }
  }
  if (valid.length >= 3) {
    const idx = valid.map(r => CANARIES.findIndex(c => c.id === r.id));
    // With no usable history, assume perfect correlation (R = 1 1'): the
    // composite then equals the weighted mean, whose sd is never above the
    // true one, so alarms are not inflated. Labelled as such.
    const R = corr
      ? idx.map(i => idx.map(j => corr.R[i][j]))
      : idx.map(() => idx.map(() => 1));
    const res = standardizedComposite(valid.map(r => r.weight), valid.map(r => r.riskOffZ as number), R);
    if (res) {
      composite = +res.z.toFixed(2);
      compositeWeightedMean = +res.weightedMean.toFixed(2);
      compositeEffectiveN = +res.effectiveN.toFixed(2);
      compositeMethod = corr
        ? `standardized score: sum(w z) / sqrt(w' R w) (thresholds from its own history, not a normal table), R = Ledoit-Wolf (constant-correlation target) shrunk correlation of ${corr.days} days of risk-off-signed daily returns (shrinkage ${corr.shrinkage.toFixed(2)}); crude spike rule not in R`
        : "weighted mean (correlation history unavailable: R assumed all ones, conservative), not a calibrated z";
    }
  }

  const divergers = rows.filter(r => r.diverging);
  const offs = rows.filter(r => r.status === "risk_off");

  let read: CanarySnapshot["read"] = "no_data";
  let headline = "insufficient data — canary bars still accumulating";
  if (composite != null) {
    if (composite >= thresholds.alarm && offs.length >= 2 && spyZ != null && spyZ >= SPY_FLAT_FLOOR) {
      read = "alarm";
      headline = `ALARM — ${offs.length} canaries risk-off (${offs.map(r => r.id).join(", ")}) while SPX holds. Equity tape is the last to know.`;
    } else if (divergers.length >= 1) {
      read = "divergence";
      headline = `divergence — ${divergers.map(r => r.label).join(" + ")} signaling risk-off against a flat/up SPX. Watch, don't chase.`;
    } else if (offs.length >= 1 || composite >= thresholds.watch) {
      read = "canaries_chirping";
      headline = `chirping — risk-off pressure building (composite z ${composite}) but SPX confirming lower too. Aligned, not divergent.`;
    } else if (composite <= thresholds.riskOn) {
      read = "confirming_risk_on";
      headline = `risk-on confirmed — canaries tailwind (composite z ${composite}). Cross-asset agrees with the equity tape.`;
    } else {
      read = "quiet";
      headline = `quiet — composite ${composite}, inside its ${thresholds.method} 5% lines (${thresholds.riskOn} / +${thresholds.watch}). No cross-asset edge today.`;
    }
  }

  const data: CanarySnapshot = {
    asOf: new Date().toISOString(),
    marketSession: isRTH(),
    spy: { d1Pct: spyRet != null ? +(spyRet * 100).toFixed(2) : null, z: spyZ != null ? +spyZ.toFixed(2) : null },
    composite, compositeMethod, compositeWeightedMean, compositeEffectiveN,
    correlation: corr ? { days: corr.days, shrinkage: +corr.shrinkage.toFixed(3) } : null,
    thresholds,
    read, headline, canaries: rows,
  };
  snapCache = { at: Date.now(), data };
  return data;
}

// ── alert loop ──────────────────────────────────────────────────────────────

const fired = new Map<string, number>(); // key -> epoch ms
const REFIRE_MS = 4 * 60 * 60 * 1000;    // same alert at most every 4h

function dedupKey(kind: string, ids: string[]): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  return `${day}:${kind}:${ids.sort().join(",")}`;
}

async function evaluateAlerts(): Promise<void> {
  if (!isRTH()) return;
  try {
    const snap = await buildCanarySnapshot();
    if (snap.read !== "divergence" && snap.read !== "alarm") return;

    const divergers = snap.canaries.filter(r => r.diverging);
    const key = dedupKey(snap.read, divergers.map(r => r.id));
    const last = fired.get(key);
    if (last && Date.now() - last < REFIRE_MS) return;

    const color = snap.read === "alarm" ? 0xff4d52 : 0xfbbf24;
    const lines = divergers.map(r =>
      `**${r.label}** ${r.d1Pct != null ? (r.d1Pct > 0 ? "+" : "") + r.d1Pct + "%" : "—"} (${r.riskOffZ}σ risk-off) — ${r.note}`,
    );
    const ok = await postToDiscord({
      embeds: [{
        title: snap.read === "alarm" ? "CANARY ALARM — cross-asset risk-off, SPX not confirming" : "CANARY DIVERGENCE",
        description: `${lines.join("\n")}\n\nSPY ${snap.spy.d1Pct != null ? (snap.spy.d1Pct > 0 ? "+" : "") + snap.spy.d1Pct + "%" : "—"} (${snap.spy.z}σ) · composite risk-off ${snap.composite}\n\n${snap.headline}`,
        color,
        footer: { text: "Batcave canary module — divergence, not direction. Confirmation still required." },
        timestamp: new Date().toISOString(),
      }],
    });
    if (ok) {
      fired.set(key, Date.now());
      console.log(`[canary] ${snap.read} alert fired: ${divergers.map(r => r.id).join(",")}`);
    }
  } catch (e: any) {
    console.warn(`[canary] evaluate failed: ${e?.message ?? e}`);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startCanaryWatch(): void {
  if (timer) return;
  timer = setInterval(evaluateAlerts, 5 * 60_000);
  setTimeout(evaluateAlerts, 20_000);
  console.log("[canary] watch started — 5min cadence RTH, divergence/alarm to Discord, 4h refire cap");
}
