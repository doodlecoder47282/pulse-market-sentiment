// server/revExtClassifier.ts
//
// Reversion vs Extension classifier for the Exit Brain.
//
// Reads Schwab 1m bars (via mtfStack's cache — same source) and computes:
//   - Session-anchored VWAP (resets at 9:30 ET each day) + std-dev bands ±1σ/±2σ
//   - RSI(2) on 1m and 5m closes (Connors-style fast RSI)
//   - Distance from 5m 21-SMA in σ
//   - Tape state classifier:
//       EXTENDED_HIGH  — price ≥ +2σ above VWAP, RSI(2) ≥ 95, against any long
//       EXTENDED_LOW   — price ≤ -2σ below VWAP, RSI(2) ≤ 5, against any short
//       MEAN_REVERTING — price reverting toward VWAP from outside ±1σ
//       TRENDING_UP    — price > +1σ AND VWAP rising AND RSI(2) > 70
//       TRENDING_DN    — price < -1σ AND VWAP falling AND RSI(2) < 30
//       CHOP           — none of the above
//
// reversionRiskForLong  / reversionRiskForShort: 0..100
//   higher = bigger risk that the next move pulls AGAINST that side.
//
// Read-only, try/catch wrapped, fails silent.

import { getPriceHistory, type PriceHistoryResponse } from "./schwab";

export type Bar = {
  t: number; // epoch ms (Schwab returns ms)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type RevExtSnapshot = {
  symbol: string;
  asOf: number;
  source: "schwab";

  spot: number | null;
  vwap: number | null;
  vwapSlopePct: number | null;     // % change of VWAP over last 15 1-min bars
  sigma1Up: number | null;
  sigma1Dn: number | null;
  sigma2Up: number | null;
  sigma2Dn: number | null;
  zFromVwap: number | null;        // (spot - vwap) / sigma
  zFromSma21_5m: number | null;    // distance from 5m 21-SMA in σ

  rsi2_1m: number | null;
  rsi2_5m: number | null;

  state:
    | "EXTENDED_HIGH"
    | "EXTENDED_LOW"
    | "MEAN_REVERTING_DN"   // price above VWAP, pulling back toward it
    | "MEAN_REVERTING_UP"   // price below VWAP, pulling up toward it
    | "TRENDING_UP"
    | "TRENDING_DN"
    | "CHOP"
    | "INSUFFICIENT";

  reversionRiskForLong: number;    // 0..100
  reversionRiskForShort: number;   // 0..100
  notes: string[];
};

// ─── Math helpers ───────────────────────────────────────────────────────

function rsi2(closes: number[]): number | null {
  // Connors RSI(2) — same Wilder math as RSI but length=2
  const n = 2;
  if (closes.length < n + 1) return null;
  let gains = 0;
  let losses = 0;
  // seed: average of first n bars of changes
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  let avgG = gains / n;
  let avgL = losses / n;
  // Wilder smoothing
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (n - 1) + g) / n;
    avgL = (avgL * (n - 1) + l) / n;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

function smaLast(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}

// ─── Session anchoring (9:30 ET cutover) ────────────────────────────────
//
// Take the most recent 9:30 America/New_York bar as the VWAP anchor.
// If the latest bar is BEFORE 9:30 ET (overnight/pre-market), fall back to
// the prior day's 9:30 anchor.

function etDateTimeKey(ms: number): { dateKey: string; hh: number; mm: number } {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  const hh = parseInt(get("hour"), 10);
  const mm = parseInt(get("minute"), 10);
  return { dateKey, hh, mm };
}

function findSessionAnchor(bars: Bar[]): number {
  // Walk backwards: find first bar at or after 9:30 ET on the same ET day
  // as the LAST bar. Returns the index of that anchor in `bars`.
  if (!bars.length) return 0;
  const last = bars[bars.length - 1];
  const lastKey = etDateTimeKey(last.t);
  // If last bar is before 9:30 ET, anchor on prior trading day's 9:30
  // (rare for our use; we only call during RTH). For safety fallback:
  //   simply return the first bar of the most recent ET day with hh>=9.
  let anchor = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    const k = etDateTimeKey(bars[i].t);
    if (k.dateKey !== lastKey.dateKey) {
      anchor = i + 1;
      break;
    }
    // First bar of the same ET day OR first bar at/after 9:30
    if (k.hh > 9 || (k.hh === 9 && k.mm >= 30)) {
      anchor = i;
    }
  }
  return Math.max(0, anchor);
}

// ─── VWAP + std-dev bands ───────────────────────────────────────────────

function computeVwapAndSigma(bars: Bar[]): {
  vwap: number | null;
  sigma: number | null;
  vwapSlopePct: number | null;
  vwapSeries: number[]; // for slope calc
} {
  if (!bars.length) return { vwap: null, sigma: null, vwapSlopePct: null, vwapSeries: [] };
  const start = findSessionAnchor(bars);
  let cumPV = 0;
  let cumV = 0;
  let cumSqDev = 0;
  const vwapSeries: number[] = [];
  for (let i = start; i < bars.length; i++) {
    const b = bars[i];
    const tp = (b.h + b.l + b.c) / 3; // typical price
    const v = b.v > 0 ? b.v : 1; // safety floor
    cumPV += tp * v;
    cumV += v;
    const vwap = cumPV / cumV;
    vwapSeries.push(vwap);
    cumSqDev += (tp - vwap) * (tp - vwap) * v;
  }
  if (!vwapSeries.length || cumV === 0) {
    return { vwap: null, sigma: null, vwapSlopePct: null, vwapSeries: [] };
  }
  const vwap = vwapSeries[vwapSeries.length - 1];
  const variance = cumSqDev / cumV;
  const sigma = Math.sqrt(Math.max(0, variance));

  // slope: pct change of VWAP over last 15 1m bars
  let vwapSlopePct: number | null = null;
  if (vwapSeries.length >= 16) {
    const prev = vwapSeries[vwapSeries.length - 16];
    const cur = vwap;
    if (prev !== 0) vwapSlopePct = ((cur - prev) / prev) * 100;
  }

  return { vwap, sigma, vwapSlopePct, vwapSeries };
}

// ─── 1m bar fetcher (cached, separate from mtfStack to avoid coupling) ──

type CacheEntry = { at: number; bars: Bar[]; source: "schwab" };
const CACHE_MS = 30_000;
const cache = new Map<string, CacheEntry>();

async function fetch1mBars(symbol: string): Promise<{ bars: Bar[]; source: "schwab" }> {
  const cached = cache.get(symbol);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) {
    return { bars: cached.bars, source: cached.source };
  }
  let resp: PriceHistoryResponse | null = null;
  try {
    resp = await getPriceHistory(symbol, "day", 2, "minute", 1);
  } catch {
    resp = null;
  }
  if (!resp || !resp.candles?.length) {
    return { bars: [], source: "schwab" };
  }
  const bars: Bar[] = resp.candles.map((c: any) => ({
    t: c.datetime,
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume ?? 0,
  })).filter((b) => Number.isFinite(b.c) && b.c > 0);
  cache.set(symbol, { at: now, bars, source: resp.source });
  return { bars, source: resp.source };
}

function aggregateTo5m(bars: Bar[]): Bar[] {
  const bucketMs = 5 * 60_000;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of bars) {
    const bucket = Math.floor(b.t / bucketMs) * bucketMs;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function getRevExtSnapshot(symbol: string): Promise<RevExtSnapshot> {
  const { bars, source } = await fetch1mBars(symbol);
  const closes1m = bars.map((b) => b.c);
  const bars5m = aggregateTo5m(bars);
  const closes5m = bars5m.map((b) => b.c);

  const spot = closes1m.length ? closes1m[closes1m.length - 1] : null;

  const { vwap, sigma, vwapSlopePct } = computeVwapAndSigma(bars);

  let zFromVwap: number | null = null;
  if (spot != null && vwap != null && sigma != null && sigma > 0) {
    zFromVwap = (spot - vwap) / sigma;
  }

  // 5m SMA21 + std on last 21 closes
  let zFromSma21_5m: number | null = null;
  const sma21_5m = smaLast(closes5m, 21);
  if (sma21_5m != null && closes5m.length >= 21) {
    const last21 = closes5m.slice(-21);
    let v = 0;
    for (const c of last21) v += (c - sma21_5m) * (c - sma21_5m);
    const sd = Math.sqrt(v / 21);
    if (sd > 0 && spot != null) zFromSma21_5m = (spot - sma21_5m) / sd;
  }

  const rsi2_1m = rsi2(closes1m.slice(-50));
  const rsi2_5m = rsi2(closes5m.slice(-50));

  // ─── State classifier ───────────────────────────────────────────────
  let state: RevExtSnapshot["state"] = "INSUFFICIENT";
  const notes: string[] = [];
  if (zFromVwap != null && rsi2_1m != null && vwap != null && spot != null) {
    const above1s = zFromVwap >= 1;
    const below1s = zFromVwap <= -1;
    const above2s = zFromVwap >= 2;
    const below2s = zFromVwap <= -2;
    const vwapUp = (vwapSlopePct ?? 0) > 0.02;
    const vwapDn = (vwapSlopePct ?? 0) < -0.02;

    if (above2s && rsi2_1m >= 95) {
      state = "EXTENDED_HIGH";
      notes.push(`spot ${zFromVwap.toFixed(2)}σ above VWAP, RSI(2) ${rsi2_1m.toFixed(0)}`);
    } else if (below2s && rsi2_1m <= 5) {
      state = "EXTENDED_LOW";
      notes.push(`spot ${zFromVwap.toFixed(2)}σ below VWAP, RSI(2) ${rsi2_1m.toFixed(0)}`);
    } else if (above1s && vwapUp && rsi2_1m > 70) {
      state = "TRENDING_UP";
      notes.push(`above VWAP +${zFromVwap.toFixed(2)}σ, VWAP rising, RSI(2) ${rsi2_1m.toFixed(0)}`);
    } else if (below1s && vwapDn && rsi2_1m < 30) {
      state = "TRENDING_DN";
      notes.push(`below VWAP ${zFromVwap.toFixed(2)}σ, VWAP falling, RSI(2) ${rsi2_1m.toFixed(0)}`);
    } else if (above1s && rsi2_1m < 50) {
      state = "MEAN_REVERTING_DN";
      notes.push(`above VWAP, RSI(2) cooling — pullback risk`);
    } else if (below1s && rsi2_1m > 50) {
      state = "MEAN_REVERTING_UP";
      notes.push(`below VWAP, RSI(2) rebounding — bounce risk`);
    } else {
      state = "CHOP";
      notes.push(`zVWAP ${zFromVwap.toFixed(2)}, RSI(2) ${rsi2_1m.toFixed(0)} — chop`);
    }
  }

  // ─── Reversion-risk scoring (per side) ──────────────────────────────
  // For the Exit Brain — high score = next move likely against that side.
  let reversionRiskForLong = 0;
  let reversionRiskForShort = 0;

  if (zFromVwap != null && rsi2_1m != null) {
    // Base from state
    switch (state) {
      case "EXTENDED_HIGH":
        reversionRiskForLong = 90;
        reversionRiskForShort = 10;
        break;
      case "EXTENDED_LOW":
        reversionRiskForShort = 90;
        reversionRiskForLong = 10;
        break;
      case "MEAN_REVERTING_DN":
        reversionRiskForLong = 65;
        reversionRiskForShort = 35;
        break;
      case "MEAN_REVERTING_UP":
        reversionRiskForShort = 65;
        reversionRiskForLong = 35;
        break;
      case "TRENDING_UP":
        reversionRiskForLong = 25;
        reversionRiskForShort = 75;
        break;
      case "TRENDING_DN":
        reversionRiskForShort = 25;
        reversionRiskForLong = 75;
        break;
      default:
        reversionRiskForLong = 40;
        reversionRiskForShort = 40;
    }

    // Boost if RSI(2) is at an extreme that aligns with reversion against side
    if (rsi2_1m >= 95) {
      reversionRiskForLong = Math.min(100, reversionRiskForLong + 8);
    } else if (rsi2_1m <= 5) {
      reversionRiskForShort = Math.min(100, reversionRiskForShort + 8);
    }
    if (rsi2_5m != null) {
      if (rsi2_5m >= 90) reversionRiskForLong = Math.min(100, reversionRiskForLong + 5);
      else if (rsi2_5m <= 10) reversionRiskForShort = Math.min(100, reversionRiskForShort + 5);
    }

    // Distance-from-5m-21SMA boost
    if (zFromSma21_5m != null) {
      if (zFromSma21_5m >= 2) reversionRiskForLong = Math.min(100, reversionRiskForLong + 5);
      else if (zFromSma21_5m <= -2) reversionRiskForShort = Math.min(100, reversionRiskForShort + 5);
    }
  }

  return {
    symbol,
    asOf: Date.now(),
    source,
    spot,
    vwap,
    vwapSlopePct,
    sigma1Up: vwap != null && sigma != null ? vwap + sigma : null,
    sigma1Dn: vwap != null && sigma != null ? vwap - sigma : null,
    sigma2Up: vwap != null && sigma != null ? vwap + 2 * sigma : null,
    sigma2Dn: vwap != null && sigma != null ? vwap - 2 * sigma : null,
    zFromVwap,
    zFromSma21_5m,
    rsi2_1m,
    rsi2_5m,
    state,
    reversionRiskForLong: Math.round(reversionRiskForLong),
    reversionRiskForShort: Math.round(reversionRiskForShort),
    notes,
  };
}

// ─── Exit-brain helper ──────────────────────────────────────────────────

export function isReversionThreat(snap: RevExtSnapshot, side: "long" | "short"): {
  threat: boolean;
  score: number;
  reason: string;
} {
  const score = side === "long" ? snap.reversionRiskForLong : snap.reversionRiskForShort;
  const threat = score >= 70;
  return {
    threat,
    score,
    reason: threat
      ? `${snap.state} · ${snap.notes[0] ?? ""}`.trim()
      : "",
  };
}
