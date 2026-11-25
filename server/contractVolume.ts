// Five-minute volume per option contract, kept from every fresh option chain the terminal reads.
//
// No extra requests: schwab.ts hands each fresh chain to the observer registered here. The pure logic is
// shared/contractBuild.ts; this file keeps the day's running volumes in memory and the steps in SQLite.
// Fail-soft: a storage error is logged and the chain read is unaffected.

import { sqlite } from "./storage";
import { etDate, isTradingDay, sessionCloseMs, sessionOpenMs } from "./exchangeCalendar";
import { flattenSchwabChain } from "./schwabChainRows";
import { applyRead, burstOf, describeBuild, isUnusual, stepStart, UNUSUAL_MIN_VOLUME, type BuildRead, type Burst, type BuildStep } from "../shared/contractBuild";
import { etTime } from "../shared/etTime";

/** Reads are recorded until this long after the close. */
export const AFTER_CLOSE_MS = 30 * 60_000;
// When each symbol's chain was last recorded (this process).
const lastReadMs = new Map<string, number>();
/** Sessions of history kept. */
export const KEEP_DAYS = 10;

let ready = false;
try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS contract_vol_5m (
      day TEXT NOT NULL,          -- New York session date
      occ TEXT NOT NULL,          -- one contract
      step INTEGER NOT NULL,      -- start of the five-minute step, epoch ms
      symbol TEXT NOT NULL,       -- underlying as requested from Schwab
      expiry TEXT NOT NULL,
      strike REAL NOT NULL,
      side TEXT NOT NULL,
      vol INTEGER NOT NULL,       -- contracts added in this step
      cum INTEGER NOT NULL,       -- running day volume at the last read in this step
      baseline INTEGER NOT NULL,  -- volume already traded when first read today (timing unknown)
      oi INTEGER,
      last REAL,
      prem REAL NOT NULL,         -- sum of (contracts added x last price x 100) in this step
      PRIMARY KEY (day, occ, step)
    );
    CREATE INDEX IF NOT EXISTS idx_contract_vol_day_symbol ON contract_vol_5m(day, symbol);
  `);
  ready = true;
} catch (e) {
  console.warn("[contractVolume] init failed:", (e as Error).message);
}

// Running day volume per contract, for the current session only.
let seenDay = "";
const seen = new Map<string, number>();
let lastPruneDay = "";

/** Load the day's last running volumes after a restart, so a redeploy does not re-base every contract. */
function restoreSeen(day: string): void {
  seen.clear();
  try {
    const rows = sqlite.prepare(`SELECT occ, MAX(cum) AS cum FROM contract_vol_5m WHERE day = ? GROUP BY occ`).all(day) as Array<{ occ: string; cum: number }>;
    for (const r of rows) seen.set(r.occ, r.cum);
  } catch { /* an empty map re-bases, which is safe */ }
}

/**
 * Record one fresh chain. `asOfMs` is when Schwab produced it. Only during or after a regular session on a
 * trading day: before the open the chain's day volume still belongs to the prior session.
 */
export function recordChainVolumes(symbol: string, chain: unknown, asOfMs: number): number {
  if (!ready || !Number.isFinite(asOfMs)) return 0;
  const day = etDate(asOfMs);
  if (!isTradingDay(day)) return 0;
  const open = sessionOpenMs(day), close = sessionCloseMs(day);
  // Regular session plus half an hour for the final totals. Later reads are not recorded: for an index with
  // an overnight session the chain's volume may already belong to the next trade date (not verified).
  if (open == null || close == null || asOfMs < open || asOfMs > close + AFTER_CLOSE_MS) return 0;
  lastReadMs.set(symbol, asOfMs);
  if (day !== seenDay) { seenDay = day; restoreSeen(day); }
  let steps;
  try {
    const rows = flattenSchwabChain(chain as any).map((c) => ({ occ: c.occ, side: c.side, expiry: c.expiry, strike: c.strike, volume: c.volume, 
      // Open interest of 0 is "not posted" or truly none: either way there is nothing to compare volume with.
      openInterest: c.openInterest != null && c.openInterest > 0 ? c.openInterest : null, last: c.last }));
    steps = applyRead(seen, rows, asOfMs);
  } catch (e) {
    console.warn("[contractVolume] read failed:", (e as Error).message);
    return 0;
  }
  if (!steps.length) return 0;
  try {
    const stmt = sqlite.prepare(
      `INSERT INTO contract_vol_5m (day, occ, step, symbol, expiry, strike, side, vol, cum, baseline, oi, last, prem)
       VALUES (@day, @occ, @step, @symbol, @expiry, @strike, @side, @vol, @cum, @baseline, @oi, @last, @prem)
       ON CONFLICT(day, occ, step) DO UPDATE SET
         vol = vol + excluded.vol, cum = excluded.cum, oi = COALESCE(excluded.oi, oi),
         last = COALESCE(excluded.last, last), prem = prem + excluded.prem`,
    );
    const tx = sqlite.transaction(() => {
      for (const s of steps) {
        stmt.run({ day, occ: s.occ, step: s.step, symbol, expiry: s.expiry, strike: s.strike, side: s.side, vol: s.volume, cum: s.cum,
          baseline: s.baseline, oi: s.openInterest, last: s.last, prem: s.last != null ? s.volume * s.last * 100 : 0 });
      }
    });
    tx();
    if (lastPruneDay !== day) {
      lastPruneDay = day;
      const cutoff = new Date(Date.parse(`${day}T12:00:00Z`) - KEEP_DAYS * 2 * 86_400_000).toISOString().slice(0, 10);
      sqlite.prepare(`DELETE FROM contract_vol_5m WHERE day < ?`).run(cutoff);
    }
  } catch (e) {
    console.warn("[contractVolume] store failed:", (e as Error).message);
    return 0;
  }
  return steps.length;
}

export interface ContractAlert {
  occ: string; symbol: string; expiry: string; strike: number; side: "C" | "P";
  volume: number; openInterest: number | null; multiple: number | null;
  /** Dollars: contracts added since the first read x the last price at each read x 100. Excludes the baseline. */
  premium: number;
  steps: BuildStep[];
  build: BuildRead;
  /** Expires on the session day: volume against open interest is not a signal for it. */
  sameDay: boolean;
  /** Same-day contracts only: the one five-minute step that stood far above the contract's usual step. */
  burst: Burst | null;
}

export interface ContractAlertsResponse {
  symbol: string; day: string;
  /** The last chain read recorded for this symbol (this process), else the newest step with a change. */
  asOfMs: number | null;
  /** Contracts with 500 or more traded whose open interest is not known, so the rule could not be applied. */
  oiUnknown: number;
  /** When the terminal first recorded this symbol's chain today: the build cannot start earlier. */
  watchingSinceMs: number | null;
  rule: string;
  alerts: ContractAlert[];
  /** Contracts that expire today, busiest first by dollars: activity, not a claim that anything is unusual. */
  todayMostActive: ContractAlert[];
  todayRule: string;
  note: string;
}

/** Today's contracts on `symbol` that meet the unusual-volume rule on their own numbers, with their build. */
export function contractAlerts(symbol: string, nowMs: number = Date.now(), limit = 40): ContractAlertsResponse {
  const day = etDate(nowMs);
  const rule = "a contract that expires after today has traded at least 3 times its own open interest and at least 500 contracts; a contract that expires today is listed only for a burst: one five-minute step at least 5 times its usual step and at least 1,000 contracts";
  const todayRule = "expires today, busiest first by dollars since the first read. Heavy trading in a same-day contract is normal, so this is a list of where the activity is, not of anything unusual";
  const note = "Built from the terminal's own chain reads: a step is as fine as the gap between two reads, volume before the first read has no timing, and a chain total does not say which trades were buys.";
  const empty: ContractAlertsResponse = { symbol, day, asOfMs: null, oiUnknown: 0, watchingSinceMs: null, rule, alerts: [], todayMostActive: [], todayRule, note };
  if (!ready) return empty;
  let rows: Array<{ occ: string; step: number; expiry: string; strike: number; side: "C" | "P"; vol: number; cum: number; baseline: number; oi: number | null; last: number | null; prem: number }>;
  try {
    rows = sqlite.prepare(
      `SELECT occ, step, expiry, strike, side, vol, cum, baseline, oi, last, prem FROM contract_vol_5m WHERE day = ? AND symbol = ? ORDER BY occ, step`,
    ).all(day, symbol) as typeof rows;
  } catch { return empty; }
  if (!rows.length) return empty;
  const byOcc = new Map<string, typeof rows>();
  let asOf = 0, since = Infinity;
  for (const r of rows) {
    const a = byOcc.get(r.occ) ?? [];
    a.push(r); byOcc.set(r.occ, a);
    if (r.step > asOf) asOf = r.step;
    if (r.step < since) since = r.step;
  }
  const alerts: ContractAlert[] = [];
  const today: ContractAlert[] = [];
  const openMs = sessionOpenMs(day);
  const openStep = openMs != null ? stepStart(openMs) : null;
  let oiUnknown = 0;
  for (const [occ, rs] of byOcc) {
    const lastRow = rs[rs.length - 1];
    const volume = lastRow.cum;
    const oi = rs.reduce<number | null>((v, r) => (r.oi != null ? r.oi : v), null);
    const sameDay = lastRow.expiry === day;
    if (!sameDay && oi == null && volume >= UNUSUAL_MIN_VOLUME) oiUnknown++;
    const baseline = rs.reduce((n, r) => n + r.baseline, 0);
    const steps = rs.filter((r) => r.vol > 0).map((r) => ({ step: r.step, volume: r.vol }));
    const burst = sameDay ? burstOf(steps, openStep) : null;
    const unusual = sameDay ? burst != null : isUnusual(volume, oi);
    if (!unusual && !(sameDay && volume >= UNUSUAL_MIN_VOLUME)) continue;
    (unusual ? alerts : today).push({
      sameDay, burst,
      occ, symbol, expiry: lastRow.expiry, strike: lastRow.strike, side: lastRow.side,
      volume, openInterest: oi, multiple: oi != null && oi > 0 ? volume / oi : null,
      premium: rs.reduce((n, r) => n + r.prem, 0),
      steps, build: describeBuild(steps, baseline, Math.max(nowMs, asOf), (ms) => etTime(ms)),
    });
  }
  alerts.sort((a, b) => b.premium - a.premium || b.volume - a.volume);
  today.sort((a, b) => b.premium - a.premium || b.volume - a.volume);
  const readMs = lastReadMs.get(symbol);
  return { symbol, day, asOfMs: readMs != null && etDate(readMs) === day ? readMs : asOf || null, oiUnknown, watchingSinceMs: Number.isFinite(since) ? stepStart(since) : null, rule, alerts: alerts.slice(0, limit), todayMostActive: today.slice(0, 8), todayRule, note };
}
