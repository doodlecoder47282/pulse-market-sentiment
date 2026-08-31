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
import { getQuotes, type NormalizedQuote } from "./schwab";
import { postToDiscord } from "./discord";

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
const COMPOSITE_ALARM = 1.25;  // weighted composite risk-off pressure

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
  composite: number | null;    // weighted risk-off pressure
  read: "confirming_risk_on" | "quiet" | "canaries_chirping" | "divergence" | "alarm" | "no_data";
  headline: string;
  canaries: CanaryRow[];
}

function isRTH(): boolean {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date());
  const wd = p.find(x => x.type === "weekday")?.value || "";
  if (wd === "Sat" || wd === "Sun") return false;
  const h = parseInt(p.find(x => x.type === "hour")?.value || "0", 10) % 24;
  const m = parseInt(p.find(x => x.type === "minute")?.value || "0", 10);
  const mins = h * 60 + m;
  return mins >= 570 && mins < 960;
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
  const spyZ = spyRet != null && spyVol ? spyRet / spyVol : null;

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
      vol = dailyVol(ratioSeries(loadBars(a, 30), loadBars(b, 30)));
    }

    const z = ret != null && vol ? ret / vol : null;
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
  if (valid.length >= 3) {
    const wsum = valid.reduce((s, r) => s + r.weight, 0);
    composite = +(valid.reduce((s, r) => s + (r.riskOffZ as number) * r.weight, 0) / wsum).toFixed(2);
  }

  const divergers = rows.filter(r => r.diverging);
  const offs = rows.filter(r => r.status === "risk_off");

  let read: CanarySnapshot["read"] = "no_data";
  let headline = "insufficient data — canary bars still accumulating";
  if (composite != null) {
    if (composite >= COMPOSITE_ALARM && offs.length >= 2 && spyZ != null && spyZ >= SPY_FLAT_FLOOR) {
      read = "alarm";
      headline = `ALARM — ${offs.length} canaries risk-off (${offs.map(r => r.id).join(", ")}) while SPX holds. Equity tape is the last to know.`;
    } else if (divergers.length >= 1) {
      read = "divergence";
      headline = `divergence — ${divergers.map(r => r.label).join(" + ")} signaling risk-off against a flat/up SPX. Watch, don't chase.`;
    } else if (offs.length >= 1 || composite >= Z_WATCH) {
      read = "canaries_chirping";
      headline = `chirping — risk-off pressure building (composite ${composite}) but SPX confirming lower too. Aligned, not divergent.`;
    } else if (composite <= -Z_WATCH) {
      read = "confirming_risk_on";
      headline = `risk-on confirmed — canaries tailwind (composite ${composite}). Cross-asset agrees with the equity tape.`;
    } else {
      read = "quiet";
      headline = `quiet — composite ${composite}, nothing above ±1σ that matters. No cross-asset edge today.`;
    }
  }

  const data: CanarySnapshot = {
    asOf: new Date().toISOString(),
    marketSession: isRTH(),
    spy: { d1Pct: spyRet != null ? +(spyRet * 100).toFixed(2) : null, z: spyZ != null ? +spyZ.toFixed(2) : null },
    composite, read, headline, canaries: rows,
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
