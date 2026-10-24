// server/setupEngine.ts
//
// SETUP EVENT LOG. Every minute of the regular session, for each symbol the
// flow engine scans, read the structure (per-name dealer gamma:
// tickerAlpha.gatherPositioningForTicker, cached 5 min), the quote (spread =
// the modelled round-trip cost), the pending whale prints, the session clock
// and the macro calendar, and run the pure detector (shared/setupDetect.ts)
// against the versioned rule book (shared/setupRules.ts). A setup that fires
// is logged with every feature that produced it and the rule version; the
// kinds that did not fire keep their blockers in memory so the Method panel
// can say why not now.
//
// A grader replays regular-session minute bars after each open row's horizon
// and applies the achievable-exit test. Results are summarised per rule
// version and kind with a Wilson interval, and no grade letter exists
// anywhere: below SETUP_GRADE_MIN_SAMPLE the summary is counts only.
//
// Phase 1 scope: log and grade. Nothing here changes what a reader sees
// except the log card and the Method panel. Demo edition stores nothing.

import { sqlite } from "./storage";
import { editionFromEnv } from "../shared/edition";
import { getQuotes, getPriceHistory } from "./schwab";
import { gatherPositioningForTicker } from "./tickerAlpha";
import { getFlowSnapshot } from "./flowAlertEngine";
import { getWhaleAlertHistory } from "./whalePersistence";
import { getFlowConfig } from "./flowConfig";
import { isRegularSessionOpen, sessionCloseMinutes, REGULAR_OPEN_MIN } from "./exchangeCalendar";
import { etParts, etWallToUtcMs } from "./validationMath";
import { DEFAULT_SETUP_RULES, SETUP_GRADE_MIN_SAMPLE, describeRules, type SetupRules } from "../shared/setupRules";
import { detectSetups, gradeSetup, summarizeOutcomes, rankSetups, marginScore, type SetupCandidate, type Blocked, type FlowInput, type MinuteBar, type SetupMargins } from "../shared/setupDetect";
import { sectorOf } from "../shared/sectors";
import { minutesToNextTier1, MACRO_CALENDAR_VALID_THROUGH } from "../shared/macroCalendar";

const TICK_MS = 60_000;
const GRADE_MS = 5 * 60_000;
const UNGRADED_AFTER_MS = 2 * 86_400_000; // no bars two days after detection: give up, say so

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS setup_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_version TEXT NOT NULL,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,
    direction TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    spot REAL NOT NULL,
    target REAL NOT NULL,
    invalidation REAL NOT NULL,
    horizon_min INTEGER NOT NULL,
    cost_pct REAL NOT NULL,
    target_pct REAL NOT NULL,
    features_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    exit_price REAL,
    exit_at INTEGER,
    move_pct REAL,
    net_pct REAL,
    mfe_pct REAL,
    mae_pct REAL,
    bars_used INTEGER,
    grade_reason TEXT,
    graded_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_setup_events_status ON setup_events(status, detected_at);
  CREATE INDEX IF NOT EXISTS idx_setup_events_sym ON setup_events(symbol, kind, detected_at);
`);

let rules: SetupRules = DEFAULT_SETUP_RULES;
export function setSetupRules(r: SetupRules): void { rules = r; }
export function getSetupRules(): SetupRules { return rules; }

let timer: NodeJS.Timeout | null = null;
let graderTimer: NodeJS.Timeout | null = null;
let ticking = false;
let lastTickAt = 0;
let lastTickError: string | null = null;
const lastBlocked = new Map<string, { at: number; spot: number | null; blocked: Blocked[]; structureState: string }>();

/** Minutes since the open and to the close, from the exchange calendar (half days close at 13:00). */
function sessionClock(nowMs: number): { minutesSinceOpen: number; minutesToClose: number } {
  const p = etParts(nowMs);
  const mins = p.h * 60 + p.mi + p.s / 60;
  const close = sessionCloseMinutes(p.ymd as any) ?? 16 * 60;
  return { minutesSinceOpen: mins - REGULAR_OPEN_MIN, minutesToClose: close - mins };
}

/**
 * Confirming prints: the flow engine's current pending hits plus the
 * persisted whale alerts of the last maxAgeMin minutes, so a print that
 * landed before spot reached the wall still counts for as long as the rule
 * says (pending hits are flushed 60 s after they fire).
 */
function toFlowInputs(sym: string, nowMs: number): FlowInput[] {
  const pending = getFlowSnapshot().pendingByTicker[sym] ?? [];
  const cutoff = nowMs - rules.flow.maxAgeMin * 60_000;
  const seen = new Set<string>();
  const out: FlowInput[] = [];
  const push = (h: { occ: string; type: "C" | "P"; strike: number; dte: number; premium: number; volOiRatio: number; isNewStrike: boolean; tag: string; detectedAt: number }) => {
    const k = `${h.occ}:${h.detectedAt}`;
    if (h.detectedAt < cutoff || seen.has(k)) return;
    seen.add(k);
    out.push({ type: h.type, strike: h.strike, dte: h.dte, premium: h.premium, volOiRatio: h.volOiRatio, isNewStrike: h.isNewStrike, tag: h.tag, detectedAt: h.detectedAt });
  };
  for (const h of pending) push(h);
  try { for (const h of getWhaleAlertHistory({ days: 1, symbol: sym, limit: 200 })) push(h); } catch { /* persisted history optional */ }
  return out;
}

/** Index symbols carry no bid/ask; their cost is modelled from the ETF that trades them, and the features say so. */
const COST_PROXY: Record<string, string> = { SPX: "SPY", $SPX: "SPY", NDX: "QQQ", $NDX: "QQQ", RUT: "IWM", $RUT: "IWM" };

function hasOpenOrRecent(sym: string, kind: string, nowMs: number): boolean {
  const row = sqlite.prepare(`SELECT 1 FROM setup_events WHERE symbol = ? AND kind = ? AND (status = 'open' OR detected_at > ?) LIMIT 1`)
    .get(sym, kind, nowMs - rules.outcome.horizonMin * 60_000) as any;
  return !!row;
}

function insert(sym: string, c: SetupCandidate, nowMs: number): void {
  sqlite.prepare(`INSERT INTO setup_events (rule_version, symbol, kind, direction, detected_at, spot, target, invalidation, horizon_min, cost_pct, target_pct, features_json)
    VALUES (@v, @s, @k, @d, @t, @spot, @target, @inv, @h, @cost, @tp, @f)`).run({
    v: c.ruleVersion, s: sym, k: c.kind, d: c.direction, t: nowMs, spot: c.spot, target: c.target, inv: c.invalidation,
    h: c.horizonMin, cost: c.costPct, tp: c.targetPct, f: JSON.stringify({ ...c.features, rMultiple: c.rMultiple, margins: c.margins }),
  });
}

async function tick(): Promise<void> {
  if (ticking) return;
  const now = Date.now();
  if (!isRegularSessionOpen(now)) return;
  ticking = true;
  try {
    const cfg = getFlowConfig();
    const universe = Array.from(new Set([...cfg.priority, ...cfg.watchlist]));
    const clock = sessionClock(now);
    const cal = minutesToNextTier1(now, etWallToUtcMs);
    // One quote call for the universe plus the index cost proxies, not one per symbol.
    const quoteSyms = Array.from(new Set([...universe, ...universe.map((s) => COST_PROXY[s]).filter(Boolean)]));
    const spreads = new Map<string, number>();
    // Fresh spot per symbol from this tick's quote. The positioning snapshot
    // is cached for five minutes, so its spot is not the entry reference; a
    // stale or missing quote leaves spot null and the detector blocks.
    const lasts = new Map<string, number>();
    try {
      for (const q of await getQuotes(quoteSyms)) {
        const key = q?.symbol ? q.symbol.replace(/^\$/, "") : null;
        if (!key) continue;
        const bid = q?.bid ?? null, ask = q?.ask ?? null;
        if (bid != null && ask != null && bid > 0 && ask >= bid) spreads.set(key, (ask - bid) / ((ask + bid) / 2));
        if (q.last != null && Number.isFinite(q.last) && q.last > 0 && q.stale !== true) lasts.set(key, q.last);
      }
    } catch { /* cost and spot stay unknown: the detector blocks on them */ }
    for (const sym of universe) {
      try {
        const pos = await gatherPositioningForTicker(sym);
        const proxy = COST_PROXY[sym];
        const spreadPct = spreads.get(sym.replace(/^\$/, "")) ?? (proxy ? spreads.get(proxy) ?? null : null);
        const gross = pos.profile.reduce((a, p) => a + Math.abs(p.gex), 0);
        const share = (g: number | null) => (g != null && gross > 0 ? Math.abs(g) / gross : null);
        const spot = lasts.get(sym.replace(/^\$/, "")) ?? null;
        const structureState = spot == null ? "no_fresh_spot" : pos.callWall == null && pos.putWall == null ? "no_walls" : "ok";
        const res = detectSetups(
          { spot, callWall: pos.callWall, putWall: pos.putWall, gammaFlip: pos.gammaFlip, regime: pos.regime, callWallShare: share(pos.callWallGex), putWallShare: share(pos.putWallGex), atmIv: pos.atmIv },
          toFlowInputs(sym, now),
          { nowMs: now, ...clock, minutesToTier1: cal.minutes, minutesSinceTier1: cal.minutesSinceLast, calendarKnown: cal.known, spreadPct },
          rules,
        );
        lastBlocked.set(sym, { at: now, spot, blocked: res.blocked, structureState });
        for (const c of res.fired) {
          if (hasOpenOrRecent(sym, c.kind, now)) continue;
          if (proxy) (c.features as any).costSource = `${proxy} spread (index proxy)`;
          insert(sym, c, now);
          console.log(`[setups] ${sym} ${c.kind} at ${c.spot} target ${c.target} inval ${c.invalidation} (${c.ruleVersion})`);
        }
      } catch (e: any) {
        lastBlocked.set(sym, { at: now, spot: null, blocked: [], structureState: `error: ${String(e?.message ?? e).slice(0, 80)}` });
      }
    }
    lastTickAt = now;
    lastTickError = null;
  } catch (e: any) {
    lastTickError = String(e?.message ?? e).slice(0, 120);
  } finally {
    ticking = false;
  }
}

let grading = false;
async function gradeTick(): Promise<void> {
  if (grading) return;
  grading = true;
  const now = Date.now();
  try {
    const due = sqlite.prepare(`SELECT * FROM setup_events WHERE status = 'open' AND detected_at + horizon_min * 60000 <= ? ORDER BY detected_at ASC LIMIT 40`).all(now) as any[];
    const barsBySymbol = new Map<string, MinuteBar[]>();
    for (const r of due) {
      try {
        let bars = barsBySymbol.get(r.symbol);
        if (!bars) {
          // Regular-session minute bars; Schwab serves the last session when closed. Two sessions if the horizon crossed a close.
          // A stale or unavailable payload is not evidence: skip the symbol this tick rather than expire a row on partial bars.
          const ph = await getPriceHistory(r.symbol, "day", 2, "minute", 1, false);
          if (ph.dataState !== "ok" || ph.stale) {
            if (now - r.detected_at > UNGRADED_AFTER_MS) sqlite.prepare(`UPDATE setup_events SET status = 'ungraded', grade_reason = ?, graded_at = ? WHERE id = ?`).run(`minute bars ${ph.dataState}${ph.stale ? " (stale)" : ""}: ${ph.reason ?? "no reason given"}`, now, r.id);
            barsBySymbol.set(r.symbol, []);
            continue;
          }
          bars = (ph.candles ?? []).map((c) => ({ t: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close }));
          barsBySymbol.set(r.symbol, bars);
        }
        if (!bars.length) continue;
        const out = gradeSetup({ direction: r.direction, spot: r.spot, target: r.target, invalidation: r.invalidation, horizonMin: r.horizon_min, costPct: r.cost_pct }, r.detected_at, bars, now);
        if (out.status === "ungraded") {
          if (now - r.detected_at > UNGRADED_AFTER_MS) {
            sqlite.prepare(`UPDATE setup_events SET status = 'ungraded', grade_reason = ?, graded_at = ? WHERE id = ?`).run(out.reason ?? "no bars", now, r.id);
          }
          continue;
        }
        sqlite.prepare(`UPDATE setup_events SET status = @st, exit_price = @ep, exit_at = @ea, move_pct = @mv, net_pct = @np, mfe_pct = @mfe, mae_pct = @mae, bars_used = @b, grade_reason = @why, graded_at = @g WHERE id = @id`)
          .run({ st: out.status, ep: out.exitPrice, ea: out.exitAt, mv: out.movePct, np: out.netPct, mfe: out.mfePct, mae: out.maePct, b: out.barsUsed, why: out.reason, g: now, id: r.id });
      } catch (e: any) {
        console.warn(`[setups] grade ${r.symbol}#${r.id} failed: ${e?.message ?? e}`);
      }
    }
  } finally {
    grading = false;
  }
}

export function startSetupEngine(): void {
  if (timer) return;
  if (editionFromEnv() === "demo") return; // the demo stores nothing; the route serves the rule book only
  timer = setInterval(() => { void tick(); }, TICK_MS);
  graderTimer = setInterval(() => { void gradeTick(); }, GRADE_MS);
  (timer as any).unref?.(); (graderTimer as any).unref?.();
  setTimeout(() => { void tick(); void gradeTick(); }, 20_000);
}

export function stopSetupEngine(): void {
  if (timer) clearInterval(timer);
  if (graderTimer) clearInterval(graderTimer);
  timer = null; graderTimer = null;
}

export interface SetupLog {
  dataState: "ok" | "no_data" | "unavailable" | "loading";
  edition: string;
  running: boolean;
  lastTickAt: number | null;
  lastTickError: string | null;
  rules: { version: string; minSample: number; items: ReturnType<typeof describeRules> };
  calendar: { validThrough: string; known: boolean; minutesToNext: number | null; next: string | null };
  counts: { open: number; hit: number; invalidated: number; expired: number; ungraded: number; total: number };
  /** Per rule version and kind: counts only until the sample clears the gate; the interval is shown either way, labelled. */
  summary: Array<{ ruleVersion: string; kind: string; n: number; positive: number; lo: number | null; hi: number | null; meanNetPct: number | null; sampleReady: boolean }>;
  recent: Array<{ id: number; symbol: string; kind: string; direction: string; detectedAt: number; spot: number; target: number; invalidation: number; status: string; netPct: number | null; exitPrice: number | null; ruleVersion: string; features: any }>;
  /** Open setups inside their horizon, ranked by margin over the rules (never by predicted edge), capped per sector. Margins shown so the order is auditable. */
  ranked: Array<{ id: number; symbol: string; sector: string | null; kind: string; direction: string; detectedAt: number; spot: number; target: number; invalidation: number; rMultiple: number | null; score: number; margins: Array<{ name: string; margin: number }> }>;
  whyNotNow: Array<{ symbol: string; at: number; spot: number | null; structureState: string; blocked: Blocked[] }>;
  note: string;
}

export function getSetupLog(): SetupLog {
  const edition = editionFromEnv();
  const now = Date.now();
  const cal = minutesToNextTier1(now, etWallToUtcMs);
  const counts = sqlite.prepare(`SELECT status, COUNT(*) AS n FROM setup_events GROUP BY status`).all() as Array<{ status: string; n: number }>;
  const c = { open: 0, hit: 0, invalidated: 0, expired: 0, ungraded: 0, total: 0 };
  for (const r of counts) { (c as any)[r.status] = r.n; c.total += r.n; }
  const graded = sqlite.prepare(`SELECT rule_version, kind, net_pct FROM setup_events WHERE status IN ('hit','invalidated','expired') AND net_pct IS NOT NULL`).all() as Array<{ rule_version: string; kind: string; net_pct: number }>;
  const groups = new Map<string, number[]>();
  for (const g of graded) { const k = `${g.rule_version}|${g.kind}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(g.net_pct); }
  const summary = Array.from(groups.entries()).map(([k, nets]) => { const [ruleVersion, kind] = k.split("|"); return { ruleVersion, kind, ...summarizeOutcomes(nets, SETUP_GRADE_MIN_SAMPLE) }; });
  const recent = (sqlite.prepare(`SELECT * FROM setup_events ORDER BY detected_at DESC LIMIT 20`).all() as any[]).map((r) => ({
    id: r.id, symbol: r.symbol, kind: r.kind, direction: r.direction, detectedAt: r.detected_at, spot: r.spot, target: r.target, invalidation: r.invalidation,
    status: r.status, netPct: r.net_pct, exitPrice: r.exit_price, ruleVersion: r.rule_version, features: safeParse(r.features_json),
  }));
  const whyNotNow = Array.from(lastBlocked.entries()).map(([symbol, v]) => ({ symbol, ...v }));
  const openRows = (sqlite.prepare(`SELECT * FROM setup_events WHERE status = 'open' AND detected_at + horizon_min * 60000 > ? ORDER BY detected_at DESC LIMIT 200`).all(now) as any[])
    .map((r) => { const f = safeParse(r.features_json) ?? {}; return { row: r, margins: (f.margins ?? null) as SetupMargins | null, rMultiple: (f.rMultiple ?? null) as number | null }; })
    .filter((x) => x.margins != null)
    .map((x) => ({ symbol: x.row.symbol as string, sector: sectorOf(x.row.symbol), margins: x.margins!, row: x.row, rMultiple: x.rMultiple }));
  const ranked = rankSetups(openRows, rules.rank.topN, rules.rank.maxPerSector).map((x) => ({
    id: x.row.id, symbol: x.symbol, sector: x.sector, kind: x.row.kind, direction: x.row.direction, detectedAt: x.row.detected_at, spot: x.row.spot, target: x.row.target, invalidation: x.row.invalidation,
    rMultiple: x.rMultiple, score: x.score, margins: marginScore(x.margins).parts,
  }));
  const running = timer != null;
  const latest = Array.from(lastBlocked.values());
  const structureDown = latest.length > 0 && latest.every((v) => v.structureState === "no_spot" || v.structureState === "no_fresh_spot" || v.structureState.startsWith("error"));
  return {
    dataState: edition === "demo" ? "no_data" : lastTickError || structureDown ? "unavailable" : running && lastTickAt === 0 ? "loading" : c.total === 0 ? "no_data" : "ok",
    lastTickError: lastTickError ?? (structureDown ? "no symbol has a structure read (Schwab chain unavailable)" : null),
    edition, running, lastTickAt: lastTickAt || null,
    rules: { version: rules.version, minSample: SETUP_GRADE_MIN_SAMPLE, items: describeRules(rules) },
    calendar: { validThrough: MACRO_CALENDAR_VALID_THROUGH, known: cal.known, minutesToNext: cal.minutes, next: cal.next ? `${cal.next.name} ${cal.next.date} ${cal.next.time} ET` : null },
    counts: c, summary, recent, ranked, whyNotNow,
    note: edition === "demo"
      ? "Sample edition: the log is not kept; the rule book is shown as it would run."
      : `A setup is a stated condition met at an instant, logged with the rule version that fired; the outcome is the achievable-exit test replayed on minute bars. Below ${SETUP_GRADE_MIN_SAMPLE} graded setups per rule version the summary is counts only: no claim of edge, no grade.`,
  };
}

function safeParse(s: any): any { try { return s ? JSON.parse(s) : null; } catch { return null; } }
