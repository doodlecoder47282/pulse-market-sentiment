// Independent review of the whale gate's reading of Schwab option-chain
// snapshots (server/schwabFlow.ts -> flowAttribution.ts -> flowAlertEngine.ts).
//
// Facts the code is held to (Schwab chain = snapshot): totalVolume is the
// day's cumulative contracts; last / tradeTimeInLong is the last print only;
// bid / ask / quoteTimeInLong is the current NBBO; there are no individual
// prints; several prints can land between two ~30 s scans and only the last
// one is visible; open interest is the prior close's figure.
//
// Expectations derived from those facts are encoded here; the ones that
// fail against the current code are left failing on purpose (review
// findings), each marked REVIEW FINDING in its test name.
//
// flowAlertEngine.ts cannot be imported without npm ci (whalePersistence ->
// drizzle-orm), so gateInputs() and isWhale() are loaded from its SOURCE TEXT
// into a temporary module with their two runtime dependencies (flowConfig,
// flowAttribution). The gate code under test is therefore the real code.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { demoChain } from "../../server/demoMarket";
import { addDays, etWallToEpochMs } from "../../server/exchangeCalendar";
import {
  FlowLedgerStore, askSideRead, etDayKey, midOf, newLedger, observe, sideOfPrint, summarize,
  type FlowLedger, type FlowObservation, type FlowSummary,
} from "../../server/flowAttribution";
import { getFlowConfig, resetFlowConfig, setFlowConfig } from "../../server/flowConfig";
import { dedupKeysFor } from "../../server/flowDedup";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// ── schwabFlow.ts row construction, same formulas (lines 41-77, 101-190) ────────
type Tag = "ABOVE_ASK" | "AT_ASK" | "BELOW_BID" | "AT_BID" | "MID";
interface Row {
  occ: string; type: "C" | "P"; strike: number; expiration: string; dte: number;
  volume: number; openInterest: number; volOiRatio: number; isNewStrike: boolean;
  bid: number; ask: number; last: number; mid: number; notional: number; iv: number;
  tag: Tag; sentiment: string; delta: number; gamma: number; theta: number; vega: number; mark: number;
  tradeTimeMs: number | null; quoteTimeMs: number | null;
}
function inRange(last: number, bid: number, ask: number): boolean {
  if (!last || last <= 0 || !bid || !ask || ask < bid) return false;
  const tol = 0.005;
  return last >= bid - tol && last <= ask + tol;
}
function calcMid(last: number, bid: number, ask: number, mark: number): number {
  if (mark > 0 && bid > 0 && ask > 0 && mark >= bid && mark <= ask) return mark;
  const hasSpread = bid > 0 && ask > 0 && ask >= bid;
  if (hasSpread && inRange(last, bid, ask)) return last;
  if (hasSpread) return (bid + ask) / 2;
  if (last > 0) return last;
  return 0;
}
function deriveTag(last: number, bid: number, ask: number): Tag {
  if (!last || !bid || !ask) return "MID";
  const tol = 0.01;
  if (last > ask + tol) return "ABOVE_ASK";
  if (Math.abs(last - ask) <= tol) return "AT_ASK";
  if (last < bid - tol) return "BELOW_BID";
  if (Math.abs(last - bid) <= tol) return "AT_BID";
  return "MID";
}
function deriveSentiment(type: "C" | "P", tag: Tag): string {
  if (type === "C") {
    if (tag === "ABOVE_ASK" || tag === "AT_ASK") return "BULLISH";
    if (tag === "BELOW_BID" || tag === "AT_BID") return "BEARISH";
  } else {
    if (tag === "ABOVE_ASK" || tag === "AT_ASK") return "BEARISH";
    if (tag === "BELOW_BID" || tag === "AT_BID") return "BULLISH";
  }
  return "NEUTRAL";
}
/** buildSchwabFlow() body without the Schwab call. `zeroOi` forces openInterest 0 on those OCCs (new-strike path). */
function buildRows(chain: any, opts: { minVolOi: number; minVolume: number; maxDte: number; limit: number }, zeroOi = new Set<string>()): Row[] {
  const rows: Row[] = [];
  const side = (map: Record<string, Record<string, any[]>>, type: "C" | "P") => {
    for (const expKey of Object.keys(map)) {
      const expDate = expKey.split(":")[0];
      for (const strikeStr of Object.keys(map[expKey])) {
        for (const c of map[expKey][strikeStr]) {
          const strike = Number(c.strikePrice ?? strikeStr);
          const dte = Number(c.daysToExpiration ?? 0);
          if (dte < 0 || dte > opts.maxDte) continue;
          const volume = Number(c.totalVolume ?? 0);
          if (volume < opts.minVolume) continue;
          const openInterest = zeroOi.has(String(c.symbol)) ? 0 : Number(c.openInterest ?? 0);
          const isNewStrike = openInterest === 0;
          const volOiRatio = isNewStrike ? Number.POSITIVE_INFINITY : volume / openInterest;
          if (!isNewStrike && volOiRatio < opts.minVolOi) continue;
          const bid = Number(c.bid ?? 0), ask = Number(c.ask ?? 0), last = Number(c.last ?? 0), mark = Number(c.mark ?? 0);
          const mid = calcMid(last, bid, ask, mark);
          if (mid <= 0) continue;
          let delta = Number(c.delta ?? 0);
          if (!isFinite(delta) || Math.abs(delta) > 1.5) delta = 0;
          let iv = Number(c.volatility ?? 0);
          if (!isFinite(iv) || iv < 0) iv = 0;
          const tag = deriveTag(last, bid, ask);
          rows.push({
            occ: String(c.symbol), type, strike, expiration: expDate, dte, volume, openInterest,
            volOiRatio: isNewStrike ? 999 : volOiRatio, isNewStrike, bid, ask, last, mid, notional: volume * mid * 100, iv,
            tag, sentiment: deriveSentiment(type, tag), delta, gamma: Number(c.gamma ?? 0), theta: Number(c.theta ?? 0), vega: Number(c.vega ?? 0), mark,
            tradeTimeMs: typeof c.tradeTimeInLong === "number" && c.tradeTimeInLong > 0 ? c.tradeTimeInLong : null,
            quoteTimeMs: typeof c.quoteTimeInLong === "number" && c.quoteTimeInLong > 0 ? c.quoteTimeInLong : null,
          });
        }
      }
    }
  };
  side(chain.callExpDateMap ?? {}, "C");
  side(chain.putExpDateMap ?? {}, "P");
  rows.sort((a, b) => b.notional - a.notional);
  return rows.slice(0, opts.limit);
}
/** scanTicker()'s observation for a row (flowAlertEngine.ts lines 376-379). */
const obsOf = (c: Row, atMs: number): FlowObservation => ({
  atMs, volume: c.volume, last: c.last, bid: c.bid, ask: c.ask, mark: c.mark, tradeTimeMs: c.tradeTimeMs, quoteTimeMs: c.quoteTimeMs,
});
const O = (o: Partial<FlowObservation> & { atMs: number; volume: number }): FlowObservation => ({
  last: null, bid: null, ask: null, mark: null, tradeTimeMs: null, quoteTimeMs: null, ...o,
});

// ── The real gate code, loaded from flowAlertEngine.ts source ───────────────────
type Gate = {
  gateInputs: (c: Row, s: FlowSummary | null) => { premium: number; premiumBasis: string; askSide: boolean; sideBasis: string; sideDetail: string };
  isWhale: (c: Row, s?: FlowSummary | null) => { whale: boolean; reason: string };
};
let gate: Gate;
let tmpDir: string;
before(async () => {
  const engine = src("server/flowAlertEngine.ts");
  const start = engine.indexOf("export function gateInputs(");
  const end = engine.indexOf("// ─── Per-ticker scan");
  assert.ok(start > 0 && end > start, "gateInputs()/isWhale() not found where expected in flowAlertEngine.ts");
  const body = engine.slice(start, end);
  assert.match(body, /export function isWhale\(/);
  const mod = [
    `import { getFlowConfig } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "server/flowConfig.ts")).href)};`,
    `import { askSideRead } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "server/flowAttribution.ts")).href)};`,
    "type SchwabFlowContract = any; type FlowSummary = any;",
    body,
  ].join("\n");
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "flow-gate-review-"));
  const file = path.join(tmpDir, "gate.ts");
  writeFileSync(file, mod);
  gate = (await import(pathToFileURL(file).href)) as Gate;
  assert.equal(typeof gate.isWhale, "function");
});
after(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

// ── Fixture: SPY demo chain at 2026-10-13 11:00 ET and 60 s later ─────────────
const DAY = "2026-10-13";
const T1 = etWallToEpochMs(DAY, 11 * 60);
const T2 = T1 + 60_000;
const PARAMS = { symbol: "SPY", contractType: "ALL", strikeCount: 200, includeUnderlyingQuote: "true", fromDate: DAY, toDate: addDays(DAY, 90) };
// The engine filters minVolume 100 / minVolOi 2 / maxDte 90 / top 200. The demo
// market never reaches vol/OI 2 (BATCAVE_STATE: "whale flow is always empty on
// the demo"; simulated vol/OI peaks at 0.74 for 0DTE and 0.07 beyond), so the
// fixture relaxes minVolOi to 0.05 to get rows into the ledger and zeroes the OI
// of three non-0DTE rows (new-strike path) so the full gate is exercised (only
// one 1-3 DTE row reaches the demo's top 200, so the DTE band is widened in the
// gate test; the live 1-3 DTE band is a config fact, not what the fixture tests).
const ENGINE_OPTS = { minVolOi: 0.05, minVolume: 100, maxDte: 90, limit: 200 };
function fixture() {
  const chain1 = demoChain(PARAMS, T1);
  const chain2 = demoChain(PARAMS, T2);
  assert.equal(chain1.status, "SUCCESS");
  const probe = buildRows(chain1, ENGINE_OPTS);
  const zero = new Set(probe.slice(0, 150).filter((r) => r.dte >= 1 && Math.abs(r.delta) >= 0.2 && Math.abs(r.delta) <= 0.8).slice(0, 3).map((r) => r.occ));
  assert.equal(zero.size, 3, "fixture needs three non-0DTE rows inside the delta band");
  const rows1 = buildRows(chain1, ENGINE_OPTS, zero);
  const rows2 = buildRows(chain2, ENGINE_OPTS, zero);
  return { chain1, chain2, rows1, rows2, zero };
}
const finiteOrNull = (x: unknown) => x == null || (typeof x === "number" && Number.isFinite(x)) || typeof x === "string" || typeof x === "boolean";

test("G. fixture: two SPY snapshots 60 s apart through record + summarize: non-negative increments, conservation, no NaN", () => {
  const { rows1, rows2 } = fixture();
  assert.ok(rows1.length >= 50 && rows2.length >= 50, `fixture rows ${rows1.length}/${rows2.length}`);
  const store = new FlowLedgerStore();
  for (const c of rows1) store.record(c.occ, obsOf(c, T1));
  for (const c of rows2) store.record(c.occ, obsOf(c, T2));
  const v1 = new Map(rows1.map((r) => [r.occ, r.volume]));
  let rose = 0, fell = 0, attributedAll = 0;
  for (const c of rows2) {
    const led = store.get(c.occ)!;
    const s = summarize(led, T2);
    for (const k of Object.keys(s)) assert.ok(finiteOrNull((s as any)[k]), `${c.occ} summary.${k} = ${(s as any)[k]}`);
    for (const inc of led.recent) {
      assert.ok(inc.contracts >= 0 && Number.isFinite(inc.contracts), `${c.occ} increment ${inc.contracts}`);
      assert.ok(inc.price >= 0 && Number.isFinite(inc.price), `${c.occ} increment price ${inc.price}`);
    }
    assert.equal(s.askVolume + s.bidVolume + s.midVolume + s.unknownVolume, s.sinceFirstScan);
    const prev = v1.get(c.occ);
    if (prev == null) {
      assert.equal(led.firstSeenAt, T2);
      assert.equal(s.sinceFirstScan, 0);
      assert.equal(led.preScanVolume, c.volume);
      continue;
    }
    if (c.volume >= prev) {
      assert.equal(s.sinceFirstScan, c.volume - prev, `${c.occ}: attributed + unattributed must equal the volume change`);
      assert.equal(led.volumeDrops, 0);
      if (c.volume > prev) {
        rose++;
        // Demo prints land in the last 50 s of the snapshot, i.e. after T1: every increment carries a print time.
        assert.equal(s.attributedCoverage == null || s.attributedCoverage === 1 || s.unknownVolume === s.sinceFirstScan, true);
        if (s.attributedCoverage === 1) attributedAll++;
      }
    } else {
      // Simulated totalVolume is not monotone within the session (a demo-market flaw);
      // the ledger must read it as a drop, not as negative flow.
      fell++;
      assert.equal(led.volumeDrops, 1, `${c.occ}: lower reading is a drop`);
      assert.equal(s.sinceFirstScan, 0);
      assert.ok(s.premiumSinceFirstScan === 0);
    }
    assert.ok(led.preScanVolume === prev, "pre-scan volume is the first reading");
    assert.ok(Number.isFinite(s.preScanPremiumAtMid) && s.preScanPremiumAtMid >= 0);
  }
  assert.ok(rose > 0, "fixture must contain rising volume");
  assert.ok(attributedAll > 0, "some increments must be attributed to a print inside the interval");
});

test("G. gate on the second snapshot: every reason names the premium basis, every fired reason names the side basis", () => {
  const { rows1, rows2, zero } = fixture();
  const store = new FlowLedgerStore();
  for (const c of rows1) store.record(c.occ, obsOf(c, T1));
  for (const c of rows2) store.record(c.occ, obsOf(c, T2));
  // Pass 1: ask side required. Demo last prints sit inside the spread, so the
  // forced rows must be rejected on side with a reason that names the basis.
  const r = setFlowConfig({ premiumFloor: 100_000, volOiRatio: 1, minDte: 0, maxDte: 90, requiredTag: "AT_ASK", deltaMin: 0.05, deltaMax: 0.95 });
  assert.equal(r.ok, true, r.error);
  try {
    let premiumRejects = 0, sideRejects = 0, forcedSeen = 0;
    for (const c of rows2) {
      const led = store.get(c.occ)!;
      const s = summarize(led, T2);
      const { whale, reason } = gate.isWhale(c, s);
      const g = gate.gateInputs(c, s);
      assert.ok(Number.isFinite(g.premium) && g.premium >= 0, `${c.occ} gate premium ${g.premium}`);
      assert.equal(g.premium, s.preScanPremiumAtMid + s.premiumSinceFirstScan, "gate premium = pre-scan at first mid + increments at observed prices");
      assert.equal(whale, false, `demo prints are inside the spread; nothing is ask side: ${reason}`);
      if (/^premium /.test(reason)) {
        premiumRejects++;
        assert.match(reason, /\((observed-prices|volume-x-mid)\)$/, `premium reject must name the basis: ${reason}`);
      } else if (/^not ask-side: /.test(reason)) {
        sideRejects++;
        assert.match(reason, /(attributed contracts printed at the ask|last print only \((ask|bid|mid)\)|no print side available)/, reason);
        if (zero.has(c.occ)) forcedSeen++;
      }
    }
    assert.equal(forcedSeen, 3, "the three forced rows reach the side gate");
    assert.ok(premiumRejects + sideRejects > 0);
    // Pass 2: side not required: the forced rows fire, and the fired reason names both bases.
    assert.equal(setFlowConfig({ requiredTag: "ANY" }).ok, true);
    let fired = 0;
    for (const c of rows2) {
      const s = summarize(store.get(c.occ)!, T2);
      const { whale, reason } = gate.isWhale(c, s);
      const g = gate.gateInputs(c, s);
      if (!whale) continue;
      fired++;
      assert.ok(zero.has(c.occ), `only the forced new-strike rows can pass vol/OI >= 1 on the demo: ${c.occ}`);
      assert.match(reason, /\$\d+\.\d\dM premium \((at observed prices|volume x mid, first scan)\)/, `fired reason must name the premium basis: ${reason}`);
      assert.match(reason, /NEW STRIKE \(OI=0\)/);
      if (g.sideBasis === "attributed-prints") assert.match(reason, /ask side: \d+% of \d+ attributed contracts/, reason);
      else assert.match(reason, / (ABOVE_ASK|AT_ASK|BELOW_BID|AT_BID|MID) last print /, reason);
      // Second scan: the premium is pre-scan + one observed increment, and the label says so.
      assert.equal(g.premiumBasis, "observed-prices");
      assert.match(reason, /at observed prices/);
    }
    assert.equal(fired, 3, "the three forced new-strike rows fire once the side gate is off");
  } finally {
    resetFlowConfig();
  }
});

test("E. gate premium is monotone non-decreasing across the two snapshots, so the log2 tier never falls while the ledger lives", () => {
  const { rows1, rows2 } = fixture();
  const store = new FlowLedgerStore();
  const p1 = new Map<string, number>();
  for (const c of rows1) p1.set(c.occ, gate.gateInputs(c, summarize(store.record(c.occ, obsOf(c, T1)), T1)).premium);
  const floor = getFlowConfig().premiumFloor;
  for (const c of rows2) {
    const prev = p1.get(c.occ);
    if (prev == null) continue;
    const now = gate.gateInputs(c, summarize(store.record(c.occ, obsOf(c, T2)), T2)).premium;
    assert.ok(now >= prev - 1e-6, `${c.occ}: ${prev} -> ${now}`);
    const tier = (p: number) => Math.floor(Math.log2(Math.max(1, p / floor)));
    assert.ok(tier(now) >= tier(prev));
  }
});

// ── C. Time handling ──────────────────────────────────────────────────────────
test("C. a chain re-served from cache (same asOf, same volume, same times) is a no-op for the ledger", () => {
  const first = O({ atMs: T1, volume: 500, last: 1.5, bid: 1.4, ask: 1.5, mark: 1.45, tradeTimeMs: T1 - 2_000, quoteTimeMs: T1 });
  let L = newLedger("X", etDayKey(T1), first);
  const moved = O({ atMs: T1 + 30_000, volume: 700, last: 1.5, bid: 1.4, ask: 1.5, mark: 1.45, tradeTimeMs: T1 + 10_000, quoteTimeMs: T1 + 30_000 });
  L = observe(L, moved);
  const snap = JSON.stringify(L);
  // 60 s chain TTL vs 30 s scan cadence: every other scan sees the identical payload.
  L = observe(L, moved);
  assert.equal(JSON.stringify(L), snap, "identical re-observation must change nothing");
  assert.equal(L.volumeDrops, 0);
  assert.equal(L.askVolume, 200);
});

test("REVIEW FINDING C. an observation older than the previous one (older cache entry served) must be ignored, not read as a drop that rewinds the ledger", () => {
  // Scan 1 fresh at T1 (vol 500); scan 2 fresh at T1+30 s (vol 700, print inside: +200 at the ask);
  // scan 3 serves an older cached chain (asOf T1, vol 500) because the strikeCount cache key flipped back;
  // scan 4 fresh at T1+90 s (vol 800).
  const store = new FlowLedgerStore();
  const mk = (atMs: number, volume: number, tradeTimeMs: number) => O({ atMs, volume, last: 1.5, bid: 1.4, ask: 1.5, mark: 1.45, tradeTimeMs, quoteTimeMs: atMs });
  store.record("X", mk(T1, 500, T1 - 2_000));
  const l2 = store.record("X", mk(T1 + 30_000, 700, T1 + 10_000));
  assert.equal(l2.askVolume, 200);
  const l3 = store.record("X", mk(T1, 500, T1 - 2_000));
  assert.equal(l3.volumeDrops, 0, "an out-of-order snapshot is not a volume drop");
  assert.equal(l3.lastObs.atMs, T1 + 30_000, "the ledger must keep the newer observation");
  const l4 = store.record("X", mk(T1 + 90_000, 800, T1 + 80_000));
  // Only 100 contracts traded after scan 2; with the rewind the ledger counts 700 -> 800 as 300 (double count).
  assert.equal(summarize(l4, T1 + 90_000).sinceFirstScan, 300);
  assert.equal(l4.preScanVolume + summarize(l4, T1 + 90_000).sinceFirstScan, 800, "pre-scan + since-first-scan must equal the day's volume");
});

// ── A. Premium ────────────────────────────────────────────────────────────────
test("REVIEW FINDING A. a transient lower reading followed by recovery must not be counted as new volume (premium above what traded)", () => {
  // 500 -> 300 (glitch) -> 500: nothing new traded, yet the ledger adds 200 contracts of "traded" premium
  // on top of the 500 already in pre-scan: 700 contracts of premium for a 500-contract day.
  let L = newLedger("X", "d", O({ atMs: T1, volume: 500, last: 1, bid: 0.9, ask: 1, tradeTimeMs: T1 - 1 }));
  L = observe(L, O({ atMs: T1 + 30_000, volume: 300, last: 1, bid: 0.9, ask: 1, tradeTimeMs: T1 + 10_000 }));
  L = observe(L, O({ atMs: T1 + 60_000, volume: 500, last: 1, bid: 0.9, ask: 1, tradeTimeMs: T1 + 50_000 }));
  const s = summarize(L, T1 + 60_000);
  assert.ok(L.preScanVolume + s.sinceFirstScan <= 500, `pre-scan ${L.preScanVolume} + since ${s.sinceFirstScan} exceeds the 500 contracts that traded`);
  assert.ok(s.preScanPremiumAtMid + s.premiumSinceFirstScan <= 500 * 1 * 100 + 1e-9);
});

test("REVIEW FINDING A. first scan: nothing has been observed, so the premium basis must say volume x mid, not observed prices", () => {
  const { rows1 } = fixture();
  const store = new FlowLedgerStore();
  const c = rows1[0];
  const s = summarize(store.record(c.occ, obsOf(c, T1)), T1);
  assert.equal(s.sinceFirstScan, 0);
  const g = gate.gateInputs(c, s);
  // scanTicker() always records before isWhale(), so `s` is never null on the first
  // scan; the "volume-x-mid" label in gateInputs() is unreachable there and the hit's
  // reason reads "(at observed prices)" for a premium that is 100% pre-scan at the first mid.
  assert.equal(g.premiumBasis, "volume-x-mid", `first-scan premium is ${g.premium} = pre-scan ${s.preScanPremiumAtMid} at the first mid; nothing was observed`);
});

test("A. pre-scan premium at the first mid vs schwabFlow notional: same number when mark is inside the spread", () => {
  const { rows1 } = fixture();
  let same = 0, differ: string[] = [];
  for (const c of rows1) {
    const L = newLedger(c.occ, "d", obsOf(c, T1));
    if (Math.abs(L.preScanPremiumAtMid - c.notional) < 1e-6) same++; else differ.push(`${c.occ} ledger ${L.preScanPremiumAtMid} vs notional ${c.notional}`);
  }
  assert.ok(same > 0);
  // Known divergence: schwabFlow.calcMid prefers `last` inside the spread when mark is
  // outside it; flowAttribution.midOf goes to (bid+ask)/2. Report rather than fail.
  if (differ.length) console.log(`[review] pre-scan mid differs from notional for ${differ.length} rows, e.g. ${differ[0]}`);
});

test("A. a contract that leaves the top-200 and returns is not double counted: the increment is measured from its last recorded observation", () => {
  const store = new FlowLedgerStore();
  const mk = (atMs: number, volume: number, tradeTimeMs: number) => O({ atMs, volume, last: 2, bid: 1.9, ask: 2, mark: 1.95, tradeTimeMs, quoteTimeMs: atMs });
  store.record("X", mk(T1, 500, T1 - 1));
  // Absent from scans at T1+30 s and T1+60 s (not in the top 200); back at T1+90 s.
  const L = store.record("X", mk(T1 + 90_000, 900, T1 + 85_000));
  const s = summarize(L, T1 + 90_000);
  assert.equal(s.sinceFirstScan, 400);
  assert.equal(L.preScanVolume + s.sinceFirstScan, 900);
  assert.equal(s.askVolume, 400, "the whole gap is labelled by the one print that is visible");
});

// ── B. Side ───────────────────────────────────────────────────────────────────
test("B. AT_ASK and ABOVE_ASK are both ask side in the fallback and in the ledger path", () => {
  const base: Row = { occ: "X", type: "C", strike: 100, expiration: DAY, dte: 2, volume: 30_000, openInterest: 0, volOiRatio: 999, isNewStrike: true,
    bid: 1.40, ask: 1.50, last: 1.50, mid: 1.45, notional: 30_000 * 1.45 * 100, iv: 0.3, tag: "AT_ASK", sentiment: "BULLISH", delta: 0.5, gamma: 0, theta: 0, vega: 0, mark: 1.45, tradeTimeMs: T1 - 1, quoteTimeMs: T1 };
  assert.equal(gate.gateInputs(base, null).askSide, true);
  assert.equal(gate.gateInputs({ ...base, tag: "ABOVE_ASK", last: 1.60 }, null).askSide, true);
  assert.equal(gate.gateInputs({ ...base, tag: "AT_BID", last: 1.40 }, null).askSide, false);
  assert.equal(sideOfPrint(1.50, 1.40, 1.50), "ask");
  assert.equal(sideOfPrint(1.60, 1.40, 1.50), "ask");
  assert.equal(sideOfPrint(1.49, 1.40, 1.50), "ask");   // the 1-cent tolerance matches deriveTag's AT_ASK
  assert.equal(sideOfPrint(1.40, 1.40, 1.50), "bid");
  // Fallback (last-print-only) agrees with the tag on the same snapshot.
  const s = summarize(newLedger("X", "d", obsOf(base, T1)), T1);
  assert.equal(s.sideBasis, "last-print-only");
  assert.equal(askSideRead(s).askSide, true);
  assert.equal(gate.isWhale(base, s).whale, true);
  assert.match(gate.isWhale(base, s).reason, /AT_ASK last print/);
  // Crossed quote: the old tag path called it AT_ASK; the ledger path says unknown -> none -> no fire (stricter).
  const crossed = { ...base, bid: 1.60, ask: 1.50, last: 1.50 };
  assert.equal(deriveTag(crossed.last, crossed.bid, crossed.ask), "AT_ASK");
  assert.equal(summarize(newLedger("X", "d", obsOf(crossed, T1)), T1).sideBasis, "none");
});

test("B. with attributed prints the day's ask share decides and the last print's tag no longer gates", () => {
  const row: Row = { occ: "X", type: "C", strike: 100, expiration: DAY, dte: 2, volume: 2_000, openInterest: 0, volOiRatio: 999, isNewStrike: true,
    bid: 1.40, ask: 1.50, last: 1.40, mid: 1.45, notional: 0, iv: 0.3, tag: "AT_BID", sentiment: "BEARISH", delta: 0.5, gamma: 0, theta: 0, vega: 0, mark: 1.45, tradeTimeMs: T1 + 55_000, quoteTimeMs: T1 + 60_000 };
  let L = newLedger("X", "d", O({ atMs: T1, volume: 100, last: 1.5, bid: 1.4, ask: 1.5, mark: 1.45, tradeTimeMs: T1 - 1 }));
  L = observe(L, O({ atMs: T1 + 30_000, volume: 1_900, last: 1.5, bid: 1.4, ask: 1.5, mark: 1.45, tradeTimeMs: T1 + 20_000 }));  // 1800 at the ask
  L = observe(L, obsOf(row, T1 + 60_000));                                                                                           // 100 at the bid
  const s = summarize(L, T1 + 60_000);
  assert.equal(s.sideBasis, "attributed-prints");
  assert.ok(s.askShare! > 0.9);
  const r = setFlowConfig({ premiumFloor: 100_000, minDte: 0, maxDte: 90 });
  assert.equal(r.ok, true);
  try {
    const out = gate.isWhale(row, s);
    assert.equal(out.whale, true, out.reason);
    assert.match(out.reason, /ask side: 9\d% of 1900 attributed contracts/);
    // The reverse: last print at the ask, the day's prints at the bid -> no fire, and the reason says why.
    let M = newLedger("Y", "d", O({ atMs: T1, volume: 100, last: 1.4, bid: 1.4, ask: 1.5, mark: 1.45, tradeTimeMs: T1 - 1 }));
    M = observe(M, O({ atMs: T1 + 30_000, volume: 1_900, last: 1.4, bid: 1.4, ask: 1.5, mark: 1.45, tradeTimeMs: T1 + 20_000 }));
    M = observe(M, O({ atMs: T1 + 60_000, volume: 2_000, last: 1.5, bid: 1.4, ask: 1.5, mark: 1.45, tradeTimeMs: T1 + 55_000 }));
    const rev = gate.isWhale({ ...row, occ: "Y", tag: "AT_ASK", last: 1.5 }, summarize(M, T1 + 60_000));
    assert.equal(rev.whale, false);
    assert.match(rev.reason, /^not ask-side: \d+% of 1900 attributed contracts printed at the ask/);
  } finally {
    resetFlowConfig();
  }
});

test("REVIEW FINDING B. an interval's whole increment is labelled by its last print; the user-facing detail must say it is an estimate", () => {
  // 1000 contracts trade in one 30 s interval, 900 at the bid then 100 at the ask: the ledger labels all 1000 "ask".
  let L = newLedger("X", "d", O({ atMs: T1, volume: 0, last: 1.5, bid: 1.4, ask: 1.5, mark: 1.45, tradeTimeMs: T1 - 1 }));
  L = observe(L, O({ atMs: T1 + 30_000, volume: 1_000, last: 1.5, bid: 1.4, ask: 1.5, mark: 1.45, tradeTimeMs: T1 + 29_000, quoteTimeMs: T1 + 30_000 }));
  const s = summarize(L, T1 + 30_000);
  assert.equal(s.askVolume, 1_000, "documented behaviour: the last print labels the whole interval");
  const read = askSideRead(s);
  // "100% of 1000 attributed contracts printed at the ask" states a fact the snapshot cannot support.
  assert.match(read.detail, /(estimate|labelled by|last print of each|per interval)/i, `detail claims prints it never saw: "${read.detail}"`);
});

test("B. a print's side read against a quote that moved after it is flagged on the increment, but nothing downstream reads the flag", () => {
  let L = newLedger("X", "d", O({ atMs: T1, volume: 0, last: 1, bid: 0.9, ask: 1 }));
  // Print 1 s into the interval, quote refreshed 40 s later (> QUOTE_STALE_MS): the "ask" read is against a quote the print never saw.
  L = observe(L, O({ atMs: T1 + 45_000, volume: 1_000, last: 1.0, bid: 0.9, ask: 1.0, tradeTimeMs: T1 + 1_000, quoteTimeMs: T1 + 41_000 }));
  assert.equal(L.recent[0].staleQuote, true);
  const s = summarize(L, T1 + 45_000);
  assert.equal((s as any).staleQuoteShare, undefined, "summary carries no stale-quote measure (report item)");
  assert.equal(askSideRead(s).askSide, true);
});

// ── D. Day rollover ───────────────────────────────────────────────────────────
test("D. first scan after midnight ET starts a new ledger: no drop, no negative premium, pre-scan = today's first reading", () => {
  const store = new FlowLedgerStore();
  const d1 = etWallToEpochMs("2026-10-13", 15 * 60 + 59);
  store.record("X", O({ atMs: d1, volume: 40_000, last: 2, bid: 1.9, ask: 2, mark: 1.95, tradeTimeMs: d1 - 1 }));
  const d2 = etWallToEpochMs("2026-10-14", 9 * 60 + 30);
  const L = store.record("X", O({ atMs: d2, volume: 12, last: 2.2, bid: 2.1, ask: 2.2, mark: 2.15, tradeTimeMs: d2 - 1 }));
  assert.equal(L.day, "2026-10-14");
  assert.equal(L.volumeDrops, 0);
  assert.equal(L.preScanVolume, 12);
  assert.equal(L.preScanPremiumAtMid, 12 * 2.15 * 100);
  const s = summarize(L, d2);
  assert.equal(s.premiumSinceFirstScan, 0);
  assert.ok(s.preScanPremiumAtMid >= 0);
});

test("REVIEW FINDING D. yesterday's volume still reported at the open: after the reset the pre-scan premium keeps feeding the gate all day", () => {
  // 09:30:05: Schwab still shows yesterday's 40,000 contracts; 09:30:35: today's 12.
  const store = new FlowLedgerStore();
  const d2 = etWallToEpochMs("2026-10-14", 9 * 60 + 30) + 5_000;
  store.record("X", O({ atMs: d2, volume: 40_000, last: 2.2, bid: 2.1, ask: 2.2, mark: 2.15, tradeTimeMs: d2 - 20 * 3600_000 }));
  const L = store.record("X", O({ atMs: d2 + 30_000, volume: 12, last: 2.2, bid: 2.1, ask: 2.2, mark: 2.15, tradeTimeMs: d2 + 20_000 }));
  assert.equal(L.volumeDrops, 1);
  const s = summarize(L, d2 + 30_000);
  // The gate premium is preScanPremiumAtMid + premiumSinceFirstScan = 40,000 x 2.15 x 100 = $8.6M for a 12-contract day.
  assert.ok(s.preScanPremiumAtMid + s.premiumSinceFirstScan <= 12 * 2.2 * 100 + 1e-9,
    `gate premium ${s.preScanPremiumAtMid + s.premiumSinceFirstScan} after a reset to 12 contracts`);
});

// ── E. Dedup ──────────────────────────────────────────────────────────────────
test("E. dedup keys: one definition (flowDedup.ts) for the live engine and restart hydration; both keys carry the doubling tier", () => {
  const engine = src("server/flowAlertEngine.ts");
  const persist = src("server/whalePersistence.ts");
  assert.ok(/from "\.\/flowDedup"/.test(engine), "engine must take its keys from flowDedup.ts");
  assert.ok(/from "\.\/flowDedup"/.test(persist), "hydration must take its keys from flowDedup.ts");
  assert.ok(!/Math\.ceil\(r\.premium \/ 1_000_000\)/.test(persist), "old ceil(premium/1e6) tier must be gone from hydration");
  assert.ok(!/Math\.log2/.test(engine) && !/Math\.log2/.test(persist), "no second tier formula outside flowDedup.ts");
  const row = { occ: "SPXW_101526C6800", symbol: "SPX", type: "C", strike: 6800, expiration: "2026-10-15", premium: 11_000_000, premiumFloor: 2_500_000 };
  const k = dedupKeysFor(row);
  // 11M / 2.5M = 4.4 -> floor(log2) = 2: two doublings over the floor.
  assert.equal(k.tier, 2);
  assert.equal(k.fine, "SPXW_101526C6800|t2");
  assert.equal(k.coarse, "coarse|SPX|C|6800|2026-10-15|t2");
  // A whale that has not doubled keeps its keys; a doubling moves both keys, so neither blocks the re-fire.
  assert.deepEqual(dedupKeysFor({ ...row, premium: 19_000_000 }).tier, 2);
  const d = dedupKeysFor({ ...row, premium: 20_000_000 });
  assert.equal(d.tier, 3);
  assert.notEqual(d.fine, k.fine);
  assert.notEqual(d.coarse, k.coarse);
  // Below the floor the tier is 0, never negative.
  assert.equal(dedupKeysFor({ ...row, premium: 10 }).tier, 0);
});

test("E. the coarse key is tiered, so a doubling within 18 h is not blocked by the OCC-drift fallback", () => {
  const engine = src("server/flowAlertEngine.ts");
  assert.ok(/if \(coarseLast && now - coarseLast < DEDUP_COARSE_WINDOW_MS\) continue;/.test(engine));
  assert.ok(/recentlySeen\.set\(coarseKey, now\);/.test(engine));
  assert.ok(!/only whale DOUBLINGS re-fire/.test(engine), "stale comment removed");
  const a = dedupKeysFor({ occ: "A", symbol: "S", type: "P", strike: 1, expiration: "e", premium: 3_000_000, premiumFloor: 2_500_000 });
  const b = dedupKeysFor({ occ: "A", symbol: "S", type: "P", strike: 1, expiration: "e", premium: 6_000_000, premiumFloor: 2_500_000 });
  assert.notEqual(a.coarse, b.coarse);
});

// ── Labels downstream ─────────────────────────────────────────────────────────
test("labels: the Discord card prints the side basis the gate used and the premium basis, not a bare last-print tag", () => {
  const card = src("server/discordFlowCard.ts");
  assert.ok(!/`last print \$\{h\.tag\}`,\n/.test(card), "bare `last print <tag>` line must not stand alone");
  assert.ok(/h\.sideDetail/.test(card) && /h\.premiumBasis/.test(card), "card must print sideDetail and premiumBasis");
  assert.ok(/snapshot estimates/.test(card), "footer must say these are snapshot estimates");
});

// ── F. Thresholds (report only) ───────────────────────────────────────────────
test("F. gate thresholds: compiled defaults, env overrides, no empirical basis stated", () => {
  const cfg = resetFlowConfig();
  assert.deepEqual(
    { premiumFloor: cfg.premiumFloor, volOiRatio: cfg.volOiRatio, minDte: cfg.minDte, maxDte: cfg.maxDte, requiredTag: cfg.requiredTag, deltaMin: cfg.deltaMin, deltaMax: cfg.deltaMax },
    { premiumFloor: 2_500_000, volOiRatio: 15, minDte: 1, maxDte: 3, requiredTag: "AT_ASK", deltaMin: 0.2, deltaMax: 0.8 },
  );
  const fc = src("server/flowConfig.ts");
  for (const v of ["FLOW_PREMIUM_FLOOR", "FLOW_VOL_OI_RATIO", "FLOW_MIN_DTE", "FLOW_MAX_DTE", "FLOW_REQUIRED_TAG", "FLOW_DELTA_MIN", "FLOW_DELTA_MAX"]) assert.ok(fc.includes(v), v);
  // The attribution constants are hand-set too.
  const fa = src("server/flowAttribution.ts");
  assert.ok(/MIN_COVERAGE_FOR_SIDE = 0\.25/.test(fa));
  assert.ok(/askShareMin = 0\.55/.test(fa));
  assert.ok(/QUOTE_STALE_MS = 30_000/.test(fa));
});

// ── Clamps from schwabFlow.ts on off-session values ───────────────────────────
test("schwabFlow clamps: -999 greeks become 0 (delta gate then skipped), 0 times become null (increments unattributed)", () => {
  let delta = -999;
  if (!isFinite(delta) || Math.abs(delta) > 1.5) delta = 0;
  assert.equal(delta, 0);
  const row: Row = { occ: "X", type: "C", strike: 100, expiration: DAY, dte: 2, volume: 30_000, openInterest: 0, volOiRatio: 999, isNewStrike: true,
    bid: 1.4, ask: 1.5, last: 1.5, mid: 1.45, notional: 30_000 * 1.45 * 100, iv: 0, tag: "AT_ASK", sentiment: "BULLISH", delta, gamma: 0, theta: 0, vega: 0, mark: 1.45, tradeTimeMs: null, quoteTimeMs: null };
  const out = gate.isWhale(row, null);
  assert.equal(out.whale, true, out.reason);
  assert.doesNotMatch(out.reason, /Δ/, "a clamped delta is not shown, and the delta band did not apply");
  let L = newLedger("X", "d", obsOf(row, T1));
  L = observe(L, obsOf({ ...row, volume: 30_500 }, T1 + 30_000));
  assert.equal(L.unknownVolume, 500);
  assert.equal(midOf(obsOf(row, T1)), 1.45);
});
