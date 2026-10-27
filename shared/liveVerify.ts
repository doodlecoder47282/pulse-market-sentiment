/**
 * liveVerify.ts: pure cross-checks for the live verification pass.
 *
 * Once Schwab is connected, server/liveVerify.ts reads every Schwab-fed data
 * point the terminal shows and hands the raw inputs and the served outputs to
 * these functions, which recompute the key numbers a second time, by the
 * stated formula, and compare. A check passes when the served number equals
 * the recomputation (within a stated tolerance), fails when it does not, is
 * "stale" when the input is older than its window, "unavailable" when the
 * source did not answer, and "skipped" when the check had nothing to work on
 * (a closed session, an empty chain). These are consistency checks on the
 * live run: they prove the plumbing and the arithmetic, not predictive edge.
 */

export type CheckState = "pass" | "fail" | "stale" | "unavailable" | "skipped";

export interface Check {
  /** Stable id, e.g. "quote.SPY", "map.wallAbove". */
  id: string;
  /** Which tab or card the number appears on. */
  panel: string;
  name: string;
  state: CheckState;
  /** What the app served, in words (numbers formatted). */
  observed: string;
  /** What the recomputation says, when the check compares two numbers. */
  expected: string | null;
  detail: string | null;
}

export interface VerifySummary {
  pass: number;
  fail: number;
  stale: number;
  unavailable: number;
  skipped: number;
  total: number;
  verdict: "all_pass" | "issues" | "not_connected" | "nothing_checked";
}

const fmt = (n: number | null | undefined, dp = 2): string => (n == null || !Number.isFinite(n) ? "n/a" : n.toFixed(dp));
const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function mk(id: string, panel: string, name: string, state: CheckState, observed: string, expected: string | null = null, detail: string | null = null): Check {
  return { id, panel, name, state, observed, expected, detail };
}

/** Relative closeness for two finite numbers; exact when both are zero. */
export function close(a: number | null | undefined, b: number | null | undefined, relTol = 1e-6, absTol = 1e-9): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (!fin(a) || !fin(b)) return false;
  const diff = Math.abs(a - b);
  return diff <= absTol || diff <= relTol * Math.max(Math.abs(a), Math.abs(b));
}

export const unavailable = (id: string, panel: string, name: string, reason: string): Check => mk(id, panel, name, "unavailable", "unavailable", null, reason);
export const skipped = (id: string, panel: string, name: string, reason: string): Check => mk(id, panel, name, "skipped", "skipped", null, reason);

// ── Quotes ────────────────────────────────────────────────────────────────

export interface QuoteLike { symbol: string; last: number | null; ageMs?: number | null; stale?: boolean | null; feed?: string | null; bid?: number | null; ask?: number | null; volume?: number | null }

/** A quote is present, has a price, and is inside its freshness window during the session. */
export function quoteCheck(panel: string, symbol: string, q: QuoteLike | null | undefined, sessionOpen: boolean, maxAgeMs = 120_000): Check {
  const id = `quote.${symbol.replace(/^\$/, "")}`;
  if (!q) return unavailable(id, panel, `${symbol} quote`, "no quote returned");
  if (!fin(q.last)) return unavailable(id, panel, `${symbol} quote`, "quote has no last price");
  const age = fin(q.ageMs) ? q.ageMs : null;
  const observed = `${fmt(q.last)} via ${q.feed ?? "?"}${age != null ? `, ${Math.round(age / 1000)}s old` : ""}`;
  if (sessionOpen && (q.stale === true || (age != null && age > maxAgeMs))) return mk(id, panel, `${symbol} quote`, "stale", observed, null, `older than ${Math.round(maxAgeMs / 1000)}s during the regular session`);
  return mk(id, panel, `${symbol} quote`, "pass", observed);
}

/** A derived spot must agree with the quote it should have come from. Prices move between two reads, so the tolerance is stated. */
export function spotAgreement(id: string, panel: string, name: string, spot: number | null | undefined, quoteLast: number | null | undefined, tolPct = 0.003): Check {
  if (!fin(spot)) return unavailable(id, panel, name, "no spot in the served output");
  if (!fin(quoteLast)) return skipped(id, panel, name, "no quote to compare against");
  const diff = Math.abs(spot - quoteLast) / quoteLast;
  return mk(id, panel, name, diff <= tolPct ? "pass" : "fail", fmt(spot), fmt(quoteLast), `${(diff * 100).toFixed(3)}% apart; tolerance ${(tolPct * 100).toFixed(1)}%`);
}

/** The scan's spread is (ask - bid) / mid. */
export function spreadCheck(panel: string, symbol: string, q: { bid: number | null; ask: number | null; spreadPct: number | null }): Check {
  const id = `spread.${symbol}`;
  if (!fin(q.bid) || !fin(q.ask) || q.bid <= 0 || q.ask < q.bid) return skipped(id, panel, `${symbol} spread`, "no two-sided quote");
  const expected = (q.ask - q.bid) / ((q.ask + q.bid) / 2);
  return mk(id, panel, `${symbol} spread`, close(q.spreadPct, expected, 1e-6) ? "pass" : "fail", `${fmt((q.spreadPct ?? NaN) * 100, 3)}%`, `${fmt(expected * 100, 3)}%`, "(ask - bid) / mid");
}

// ── 0DTE forward and map ──────────────────────────────────────────────────

export interface ForwardStrikeLike { strike: number; gex: number }
export interface ForwardLikeMin { spot: number; gexValid: boolean; levels: { callWall: number | null; putWall: number | null; pin: number | null }; strikes: ForwardStrikeLike[]; netGex?: number | null }

/** Walls and pin re-derived from the forward's own per-strike exposure. */
export function forwardLevelsChecks(panel: string, f: ForwardLikeMin | null): Check[] {
  if (!f) return [unavailable("forward.levels", panel, "0DTE levels", "forward unavailable")];
  if (!f.gexValid) return [skipped("forward.levels", panel, "0DTE levels", "forward reports gexValid=false (too few priced contracts); levels are null by design")];
  const rows = f.strikes.filter((s) => fin(s.strike) && fin(s.gex));
  if (!rows.length) return [skipped("forward.levels", panel, "0DTE levels", "no strikes in the forward")];
  const pos = rows.filter((s) => s.gex > 0);
  const neg = rows.filter((s) => s.gex < 0);
  const callWall = pos.length ? pos.reduce((a, b) => (b.gex > a.gex ? b : a)).strike : null;
  const putWall = neg.length ? neg.reduce((a, b) => (b.gex < a.gex ? b : a)).strike : null;
  const near = rows.filter((s) => Math.abs(s.strike - f.spot) / f.spot <= 0.015);
  const pin = near.length ? near.reduce((a, b) => (Math.abs(b.gex) > Math.abs(a.gex) ? b : a)).strike : null;
  const out: Check[] = [];
  out.push(mk("forward.callWall", panel, "0DTE call wall", (f.levels.callWall ?? null) === callWall ? "pass" : "fail", fmt(f.levels.callWall, 0), fmt(callWall, 0), "strike with the largest positive exposure"));
  out.push(mk("forward.putWall", panel, "0DTE put wall", (f.levels.putWall ?? null) === putWall ? "pass" : "fail", fmt(f.levels.putWall, 0), fmt(putWall, 0), "strike with the most negative exposure"));
  out.push(mk("forward.pin", panel, "0DTE pin", (f.levels.pin ?? null) === pin ? "pass" : "fail", fmt(f.levels.pin, 0), fmt(pin, 0), "largest |exposure| within 1.5% of spot"));
  if (f.netGex !== undefined) {
    // Served strike exposures are rounded to whole dollars; the sum may differ by up to half a dollar per row.
    const sum = rows.reduce((a, s) => a + s.gex, 0);
    out.push(mk("forward.netGex", panel, "0DTE net exposure", close(f.netGex, sum, 1e-6, rows.length * 0.5 + 1) ? "pass" : "fail", fmt(f.netGex, 0), fmt(sum, 0), "sum of the per-strike exposures"));
  }
  return out;
}

export interface MapStrikeLike { strike: number; gexPct: number; gexPt: number; share: number; side: "above" | "below" | "at" }
export interface MapLikeMin { spot: number; dataState: string; landmarks: { wallAbove: number | null; magnetBelow: number | null; pocketAbove: number | null; pocketBelow: number | null }; strikes: MapStrikeLike[] }

/** Landmarks re-derived from the map's own rows, and each row's per-point figure and share. */
export function mapLandmarkChecks(panel: string, m: MapLikeMin | null): Check[] {
  if (!m) return [unavailable("map.landmarks", panel, "Today landmarks", "map unavailable")];
  if (m.dataState !== "ok") return [skipped("map.landmarks", panel, "Today landmarks", `map dataState ${m.dataState}`)];
  const rows = m.strikes.filter((s) => fin(s.strike) && fin(s.gexPct));
  if (!rows.length) return [skipped("map.landmarks", panel, "Today landmarks", "map has no rows")];
  // The map's own side tag: a strike within 0.03% of spot is "at", on neither side.
  const above = rows.filter((s) => s.side === "above");
  const below = rows.filter((s) => s.side === "below");
  const maxPos = (xs: MapStrikeLike[]) => { const p = xs.filter((s) => s.gexPct > 0); return p.length ? p.reduce((a, b) => (b.gexPct > a.gexPct ? b : a)).strike : null; };
  const minNeg = (xs: MapStrikeLike[]) => { const n = xs.filter((s) => s.gexPct < 0); return n.length ? n.reduce((a, b) => (b.gexPct < a.gexPct ? b : a)).strike : null; };
  const out: Check[] = [];
  const cmp = (id: string, name: string, served: number | null, exp: number | null, how: string) => out.push(mk(id, panel, name, (served ?? null) === exp ? "pass" : "fail", fmt(served, 0), fmt(exp, 0), how));
  cmp("map.wallAbove", "wall above", m.landmarks.wallAbove, maxPos(above), "largest positive row above spot");
  cmp("map.magnetBelow", "magnet below", m.landmarks.magnetBelow, maxPos(below), "largest positive row below spot");
  cmp("map.pocketAbove", "pocket above", m.landmarks.pocketAbove, minNeg(above), "most negative row above spot");
  cmp("map.pocketBelow", "pocket below", m.landmarks.pocketBelow, minNeg(below), "most negative row below spot");
  const badPt = rows.filter((s) => !close(s.gexPt, s.gexPct / (m.spot / 100), 1e-3)).length;
  out.push(mk("map.perPoint", panel, "$ per point", badPt === 0 ? "pass" : "fail", `${rows.length - badPt}/${rows.length} rows agree`, "gexPct / (spot / 100)", badPt ? `${badPt} rows disagree` : null));
  const shareSum = rows.reduce((a, s) => a + s.share, 0);
  out.push(mk("map.shares", panel, "row shares", shareSum <= 1 + 1e-6 && rows.every((s) => s.share >= 0) ? "pass" : "fail", `sum ${fmt(shareSum, 3)}`, "<= 1, each >= 0", "shares are of the forward's gross exposure, so the map's rows sum to at most 1"));
  return out;
}

// ── Flow ──────────────────────────────────────────────────────────────────

export interface FlowContractLike { volume: number; openInterest: number; volOiRatio: number; isNewStrike: boolean; bid: number; ask: number; mid: number; notional: number }

/** Every flagged contract's premium and volume/OI are the stated arithmetic; mid sits inside the quote. */
export function flowContractChecks(panel: string, contracts: FlowContractLike[] | null, label = "unusual flow"): Check[] {
  if (!contracts) return [unavailable("flow.contracts", panel, label, "flow unavailable")];
  if (!contracts.length) return [skipped("flow.contracts", panel, label, "no contracts flagged in this read (observed zero, not an error)")];
  let badNotional = 0, badRatio = 0, badMid = 0;
  for (const c of contracts) {
    if (!close(c.notional, c.volume * c.mid * 100, 1e-6, 1e-3)) badNotional++;
    const expRatio = c.openInterest > 0 ? c.volume / c.openInterest : null;
    if (c.isNewStrike ? c.volOiRatio !== 999 : !close(c.volOiRatio, expRatio, 1e-6, 1e-6)) badRatio++;
    if (c.bid > 0 && c.ask >= c.bid && (c.mid < c.bid - 1e-9 || c.mid > c.ask + 1e-9)) badMid++;
  }
  const n = contracts.length;
  return [
    mk("flow.notional", panel, `${label}: premium`, badNotional ? "fail" : "pass", `${n - badNotional}/${n} agree`, "volume x mid x 100", badNotional ? `${badNotional} disagree` : null),
    mk("flow.volOi", panel, `${label}: volume / OI`, badRatio ? "fail" : "pass", `${n - badRatio}/${n} agree`, "volume / open interest (999 = new strike)", badRatio ? `${badRatio} disagree` : null),
    mk("flow.mid", panel, `${label}: mid inside quote`, badMid ? "fail" : "pass", `${n - badMid}/${n} inside`, "bid <= mid <= ask", badMid ? `${badMid} outside the quote` : null),
  ];
}

export interface PcrTickerLike { symbol: string; putVol: number; callVol: number; putOI: number; callOI: number; pcrVolume: number | null; pcrOI: number | null; dataState?: "ok" | "unavailable" }

/** Per-ticker ratios and the index aggregate (VIX excluded) re-derived from the served volumes. */
export function pcrChecks(panel: string, tickers: PcrTickerLike[] | null, indexPcr: number | null | undefined, excludeSymbols: string[] = ["^VIX"]): Check[] {
  if (!tickers) return [unavailable("pcr.tickers", panel, "put/call ratios", "flow unavailable")];
  const read = tickers.filter((t) => t.dataState !== "unavailable");
  if (!read.length) return [unavailable("pcr.tickers", panel, "put/call ratios", "no ticker's chain was read")];
  let bad = 0;
  for (const t of read) {
    const ev = t.callVol > 0 ? t.putVol / t.callVol : null;
    const eo = t.callOI > 0 ? t.putOI / t.callOI : null;
    if (!close(t.pcrVolume, ev, 1e-6) || !close(t.pcrOI, eo, 1e-6)) bad++;
  }
  const out: Check[] = [mk("pcr.tickers", panel, "put/call per ticker", bad ? "fail" : "pass", `${read.length - bad}/${read.length} agree`, "puts / calls (volume and OI)", bad ? `${bad} disagree` : null)];
  const agg = read.filter((t) => !excludeSymbols.includes(t.symbol));
  const pv = agg.reduce((a, t) => a + t.putVol, 0), cv = agg.reduce((a, t) => a + t.callVol, 0);
  const expected = cv > 0 ? pv / cv : null;
  if (indexPcr === undefined) out.push(skipped("pcr.index", panel, "index put/call", "aggregate not served"));
  else out.push(mk("pcr.index", panel, "index put/call", close(indexPcr, expected, 1e-6) ? "pass" : "fail", fmt(indexPcr, 3), fmt(expected, 3), `sum of puts / sum of calls over ${agg.length} names`));
  return out;
}

// ── Term structure ────────────────────────────────────────────────────────

export interface TermLike { vix9d: number | null; vix: number | null; vix3m: number | null; ratio9dOver30d: number | null; ratio30dOver3m: number | null }

/** The snapshot's term ratios from its own inputs, and those inputs against fresh quotes. */
export function termChecks(panel: string, term: TermLike | null, quotes: { vix9d: number | null; vix: number | null; vix3m: number | null }, tolPct = 0.02): Check[] {
  if (!term) return [unavailable("term.ratios", panel, "VIX term ratios", "snapshot unavailable")];
  const out: Check[] = [];
  const r1 = fin(term.vix9d) && fin(term.vix) && term.vix > 0 ? term.vix9d / term.vix : null;
  const r2 = fin(term.vix) && fin(term.vix3m) && term.vix3m > 0 ? term.vix / term.vix3m : null;
  out.push(mk("term.ratios", panel, "VIX term ratios", close(term.ratio9dOver30d, r1, 1e-4) && close(term.ratio30dOver3m, r2, 1e-4) ? "pass" : "fail", `${fmt(term.ratio9dOver30d, 3)} / ${fmt(term.ratio30dOver3m, 3)}`, `${fmt(r1, 3)} / ${fmt(r2, 3)}`, "vix9d / vix and vix / vix3m"));
  const pairs: Array<[string, number | null, number | null]> = [["VIX9D", term.vix9d, quotes.vix9d], ["VIX", term.vix, quotes.vix], ["VIX3M", term.vix3m, quotes.vix3m]];
  for (const [s, served, q] of pairs) {
    if (!fin(served)) { out.push(unavailable(`term.${s}`, panel, `${s} input`, "snapshot has no value")); continue; }
    if (!fin(q)) { out.push(skipped(`term.${s}`, panel, `${s} input`, "no quote to compare against")); continue; }
    const d = Math.abs(served - q) / q;
    out.push(mk(`term.${s}`, panel, `${s} input`, d <= tolPct ? "pass" : "fail", fmt(served), fmt(q), `${(d * 100).toFixed(2)}% apart; tolerance ${(tolPct * 100).toFixed(0)}% (two reads a moment apart)`));
  }
  return out;
}

// ── Relative volume ───────────────────────────────────────────────────────

export interface RelVolLike { todayVolume: number | null; avg20: number | null; rel: number | null; sessions: number; dataState: string }

/** avg20 and rel recomputed from the daily bars the scan read. */
export function relativeVolumeCheck(panel: string, symbol: string, rv: RelVolLike | null, bars: Array<{ date: string; volume: number | null }>, today: string): Check {
  const id = `relvol.${symbol}`;
  if (!rv) return unavailable(id, panel, `${symbol} relative volume`, "volume section unavailable");
  if (rv.dataState === "no_data" || !fin(rv.todayVolume)) return skipped(id, panel, `${symbol} relative volume`, rv.dataState === "no_data" ? "no daily bars" : "no volume on the quote (closed session or index)");
  const hist = bars.filter((b) => b.date !== today && fin(b.volume) && (b.volume as number) > 0).slice(-20);
  if (!hist.length) return skipped(id, panel, `${symbol} relative volume`, "no prior sessions in the bars");
  const avg = hist.reduce((a, b) => a + (b.volume as number), 0) / hist.length;
  const rel = rv.todayVolume / avg;
  // The scan rounds avg20 to whole shares and rel to 2 dp.
  const ok = close(rv.avg20, Math.round(avg), 0, 0.5) && close(rv.rel, rel, 0, 0.0051) && rv.sessions === hist.length;
  return mk(id, panel, `${symbol} relative volume`, ok ? "pass" : "fail", `${fmt(rv.rel)}x of ${fmt(rv.avg20, 0)} (${rv.sessions} sessions)`, `${fmt(rel)}x of ${fmt(avg, 0)} (${hist.length} sessions)`, "today / mean of the last 20 prior sessions");
}

// ── Raw chain sanity ──────────────────────────────────────────────────────

export interface ChainRowLike { bid: number | null; ask: number | null; iv: number | null; openInterest: number | null; volume: number | null }

/** The raw chain the engines read: rows present, priced, with plausible IV and non-negative OI. */
export function chainSanityChecks(panel: string, symbol: string, rows: ChainRowLike[] | null, meta: { asOfMs?: number | null; stale?: boolean; strikeCount?: number | null } | null, now: number, maxAgeMs = 5 * 60_000): Check[] {
  const id = `chain.${symbol.replace(/^\$/, "")}`;
  if (!rows || !meta) return [unavailable(id, panel, `${symbol} chain`, "chain unavailable")];
  if (!rows.length) return [mk(id, panel, `${symbol} chain`, "fail", "0 rows", "> 0", "Schwab answered with an empty chain")];
  const priced = rows.filter((r) => fin(r.bid) && fin(r.ask) && (r.ask as number) >= (r.bid as number));
  const withIv = priced.filter((r) => fin(r.iv) && (r.iv as number) > 0 && (r.iv as number) < 5);
  const negOi = rows.filter((r) => fin(r.openInterest) && (r.openInterest as number) < 0).length;
  const age = fin(meta.asOfMs) ? now - meta.asOfMs : null;
  const stale = meta.stale === true || (age != null && age > maxAgeMs);
  const pricedShare = priced.length / rows.length;
  const ivShare = priced.length ? withIv.length / priced.length : 0;
  const state: CheckState = stale ? "stale" : pricedShare >= 0.5 && ivShare >= 0.9 && negOi === 0 ? "pass" : "fail";
  return [mk(id, panel, `${symbol} chain`, state, `${rows.length} rows, ${Math.round(pricedShare * 100)}% priced, ${Math.round(ivShare * 100)}% with IV in (0, 500%)${age != null ? `, ${Math.round(age / 1000)}s old` : ""}`, ">= 50% priced, >= 90% plausible IV, no negative OI", stale ? "older than its window or re-served from cache" : negOi ? `${negOi} rows with negative OI` : null)];
}

// ── Reach ─────────────────────────────────────────────────────────────────

/** HTTP status plus the body's dataState, read as the UI would. */
export function classifyReach(status: number, body: any): { state: Check["state"]; observed: string; detail: string | null } {
  const ds: string | undefined = body && typeof body === "object" && typeof body.dataState === "string" ? body.dataState : undefined;
  const reason: string | null = body && typeof body === "object" && typeof (body.reason ?? body.dataStateReason ?? body.message) === "string" ? String(body.reason ?? body.dataStateReason ?? body.message).slice(0, 160) : null;
  if (status === 429) return { state: "skipped", observed: "429 rate limited", detail: "the verifier itself hit a limit; rerun in a minute" };
  if (status === 401 || status === 403) return { state: "fail", observed: `${status}`, detail: "the server refused its own call; check the access key wiring" };
  if (status === 200 || status === 206) {
    if (!ds || ds === "ok" || ds === "live") return { state: "pass", observed: `200 ${ds ?? "ok"}`, detail: null };
    if (ds === "stale" || ds === "partial" || ds === "delayed" || ds === "stale_session") return { state: "stale", observed: `200 ${ds}`, detail: reason };
    if (ds === "no_data" || ds === "no_gex" || ds === "loading" || ds === "empty") return { state: "skipped", observed: `200 ${ds}`, detail: reason ?? "answered with nothing to show (not an error)" };
    if (ds === "unavailable" || ds === "no_spot") return { state: "unavailable", observed: `200 ${ds}`, detail: reason };
    return { state: "pass", observed: `200 ${ds}`, detail: null };
  }
  if (status === 503 || status === 502 || status === 504) return { state: "unavailable", observed: `${status} ${ds ?? ""}`.trim(), detail: reason };
  return { state: "fail", observed: `${status} ${ds ?? ""}`.trim(), detail: reason };
}

// ── Summary ───────────────────────────────────────────────────────────────

export function summarize(checks: Check[], connected: boolean): VerifySummary {
  const c = (s: CheckState) => checks.filter((x) => x.state === s).length;
  const s: VerifySummary = { pass: c("pass"), fail: c("fail"), stale: c("stale"), unavailable: c("unavailable"), skipped: c("skipped"), total: checks.length, verdict: "nothing_checked" };
  if (!connected) s.verdict = "not_connected";
  else if (s.fail || s.stale || s.unavailable) s.verdict = "issues";
  else if (s.pass) s.verdict = "all_pass";
  return s;
}
