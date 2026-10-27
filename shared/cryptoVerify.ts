/**
 * cryptoVerify.ts: pure cross-checks for the crypto desk inside the live
 * verification pass (server/liveVerify.ts). The served feed and signals
 * payloads are recomputed a second time against the rule book:
 *
 *  - every ENTER candidate clears every gate the book names (no ENTER with
 *    an active authority, an unread top-10, a missing Jupiter check, a desk
 *    that is off or unknown, liquidity under the floor);
 *  - sizing is the book's share of pool liquidity, capped;
 *  - the round-trip cost on the card equals tradeCost at that depth and size;
 *  - desk risk is the stated arithmetic on the majors payload;
 *  - the expectancy summary's own counts are consistent (noData share, gate);
 *  - every feed the desk depends on answered (reach rows are built by the server).
 *
 * Pass means the plumbing and arithmetic of this run agree with the rules,
 * nothing about edge.
 */
import { type Check, close } from "./liveVerify";
import { CRYPTO_RULES, CRYPTO_RULES_VERSION, type CryptoRules } from "./cryptoRules";
import { tradeCost } from "./memeStructure";
import { DERIVS_STALE_MS, fundingDirection, type DerivsSnapshot } from "./cryptoFunding";

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const fmt = (n: number | null | undefined, dp = 2): string => (n == null || !Number.isFinite(n) ? "n/a" : n.toFixed(dp));
const mk = (id: string, name: string, state: Check["state"], observed: string, expected: string | null = null, detail: string | null = null): Check =>
  ({ id, panel: "Crypto", name, state, observed, expected, detail });

export interface CandidateLike {
  symbol?: string | null;
  verdict?: string | null;
  verdictCode?: string | null;
  liquidityUsd?: number | null;
  marketCap?: number | null;
  fdv?: number | null;
  mintAuthorityActive?: boolean | null;
  freezeAuthorityActive?: boolean | null;
  top10Pct?: number | null;
  jupState?: string | null;
  score?: number | null;
  volAccel?: number | null;
  netBuyRatio5m?: number | null;
  securityCheckedAt?: number | null;
  buys1h?: number | null;
  sells1h?: number | null;
  chg1h?: number | null;
  priceUsd?: number | null;
  risk?: { maxPositionUsd?: number | null; estSlippagePct?: number | null } | null;
}

/** Every ENTER row clears every gate; sizing and cost on the card equal the book's arithmetic. */
export function candidateChecks(cands: CandidateLike[] | null, desk: { state: string } | null, rules: CryptoRules = CRYPTO_RULES): Check[] {
  if (!cands) return [mk("crypto.gates", "ENTER gates", "unavailable", "feed unavailable")];
  const enters = cands.filter((c) => c.verdict === "ENTER");
  const out: Check[] = [];
  if (!enters.length) {
    out.push(mk("crypto.gates", "ENTER gates", "skipped", `0 ENTER among ${cands.length} candidates`, null, "nothing to gate-check this run (observed zero ENTER, not an error)"));
  } else {
    const broken: string[] = [];
    for (const c of enters) {
      const why: string[] = [];
      // Fail closed: an authority that was not read (null) is as blocking as an active one.
      if (c.mintAuthorityActive !== false) why.push(c.mintAuthorityActive === true ? "mint authority active" : "mint authority unread");
      if (c.freezeAuthorityActive !== false) why.push(c.freezeAuthorityActive === true ? "freeze authority active" : "freeze authority unread");
      if (c.securityCheckedAt == null) why.push("security never checked");
      if (!fin(c.liquidityUsd) || c.liquidityUsd < rules.universe.liquidityFloorUsd) why.push("liquidity missing or under the floor");
      const cap = c.marketCap ?? c.fdv;
      if (!fin(cap) || cap > rules.universe.enterMcapMaxUsd) why.push("market cap missing or above the entry ceiling");
      if (fin(cap) && fin(c.liquidityUsd) && cap > 0 && c.liquidityUsd > 0 && c.liquidityUsd / cap < rules.hardKills.exitDoorMinLiqToMcap) why.push("exit door: liq/mcap under the kill");
      if (fin(c.chg1h) && c.chg1h <= rules.hardKills.midRugChg1hPct) why.push("mid-rug: 1 h change at or under the kill");
      if (!fin(c.priceUsd) || c.priceUsd <= 0) why.push("no price");
      if (rules.enter.requireSellsObserved) {
        if (!fin(c.sells1h)) why.push("1 h sells missing");
        else if (c.sells1h === 0 && (c.buys1h ?? 0) >= rules.hardKills.honeypotMinBuys1h) why.push("honeypot pattern (buys, zero sells)");
      }
      if (rules.enter.requireTop10Read && !fin(c.top10Pct)) why.push("top-10 unread");
      if (c.jupState !== "agree" && c.jupState !== "watch") why.push(`Jupiter ${c.jupState ?? "unchecked"}`);
      if (!fin(c.score) || c.score < rules.enter.minScore) why.push(`score ${c.score ?? "missing"} < ${rules.enter.minScore}`);
      if (!fin(c.volAccel) || c.volAccel < rules.enter.minVolAccel) why.push("vol accel under floor");
      if (!fin(c.netBuyRatio5m) || c.netBuyRatio5m < rules.enter.minNetBuyRatio5m) why.push("net buy ratio under floor");
      if (rules.enter.requireDeskRiskOn && desk?.state !== "on") why.push(`desk risk ${desk?.state ?? "unknown"}`);
      if (why.length) broken.push(`${c.symbol ?? "?"}: ${why.join(", ")}`);
    }
    out.push(mk("crypto.gates", "ENTER gates", broken.length ? "fail" : "pass", `${enters.length - broken.length}/${enters.length} ENTER rows clear every gate`, `rule book v${CRYPTO_RULES_VERSION}`, broken.length ? broken.slice(0, 5).join(" | ") : null));
  }
  // Sizing and cost on every row that carries risk params.
  const withRisk = cands.filter((c) => c.risk && fin(c.liquidityUsd));
  if (!withRisk.length) out.push(mk("crypto.sizing", "position sizing and round-trip cost", "skipped", "no candidate with risk params"));
  else {
    let badSize = 0, badCost = 0, n = 0;
    for (const c of withRisk) {
      const liq = c.liquidityUsd as number;
      const expSize = Math.max(0, Math.floor(Math.min(liq * rules.sizing.poolShare, rules.sizing.maxPositionUsd)));
      if (!close(c.risk!.maxPositionUsd, expSize, 0, 1)) badSize++;
      const rt = tradeCost({ liquidityUsd: liq, sizeUsd: Math.max(1, expSize) }).roundTripPct;
      if (rt != null) { n++; if (!close(c.risk!.estSlippagePct, rt, 1e-3, 0.011)) badCost++; }
    }
    out.push(mk("crypto.sizing", "position sizing", badSize ? "fail" : "pass", `${withRisk.length - badSize}/${withRisk.length} rows agree`, `floor(min(liq x ${rules.sizing.poolShare}, $${rules.sizing.maxPositionUsd}))`, badSize ? `${badSize} rows disagree` : null));
    out.push(mk("crypto.cost", "round-trip cost", n === 0 ? "skipped" : badCost ? "fail" : "pass", n === 0 ? "no priced row" : `${n - badCost}/${n} rows agree`, "tradeCost(liquidity, size).roundTripPct", badCost ? `${badCost} rows disagree` : null));
  }
  return out;
}

export interface MajorsLikeMin { state: string; rows: Array<{ asset: string; kraken: { state?: string; mid: number | null; vwap24h: number | null }; coinbase: { state?: string; mid: number | null } }> }

/** Desk risk on the signals payload equals the stated arithmetic on the majors payload (same run). */
export function deskRiskCheck(desk: { state: string; btcVsVwap24hPct: number | null; asOf: number | null } | null, majors: MajorsLikeMin | null, now: number, rules: CryptoRules = CRYPTO_RULES): Check {
  const id = "crypto.deskRisk";
  if (!desk) return mk(id, "desk risk", "unavailable", "signals payload has no desk state");
  if (desk.asOf != null && now - desk.asOf > rules.deskRisk.maxAgeMinutes * 60_000) {
    return mk(id, "desk risk", desk.state === "unknown" ? "pass" : "fail", `${desk.state}, read ${Math.round((now - desk.asOf) / 60_000)} min ago`, "unknown past the age limit", `majors read older than ${rules.deskRisk.maxAgeMinutes} min must be unknown`);
  }
  if (!majors || majors.state === "unavailable") return mk(id, "desk risk", desk.state === "unknown" ? "pass" : "fail", desk.state, "unknown (majors unavailable)");
  const btc = majors.rows.find((r) => String(r.asset).toUpperCase() === "BTC");
  const live = (v: { state?: string; mid: number | null } | undefined) => v && (v.state == null || v.state === "ok") && fin(v.mid) ? v.mid : null;
  const mid = live(btc?.kraken) ?? live(btc?.coinbase);
  const vwap = btc && (btc.kraken.state == null || btc.kraken.state === "ok") && fin(btc.kraken.vwap24h) && btc.kraken.vwap24h > 0 ? btc.kraken.vwap24h : null;
  if (mid == null || vwap == null) return mk(id, "desk risk", desk.state === "unknown" ? "pass" : "fail", desk.state, "unknown (no live BTC mid or VWAP)");
  // Same rounding as deskRiskFromMajors (2 dp) before the threshold test.
  const pct = Math.round(((mid - vwap) / vwap) * 10000) / 100;
  const exp = pct <= rules.deskRisk.offBelowPct ? "off" : "on";
  // The signals payload may have been computed a minute before the feed: tolerate the band edge.
  const nearEdge = Math.abs(pct - rules.deskRisk.offBelowPct) < 0.5;
  const ok = desk.state === exp || nearEdge;
  return mk(id, "desk risk", ok ? "pass" : "fail", `${desk.state} (${fmt(desk.btcVsVwap24hPct)}%)`, `${exp} (${fmt(pct)}% vs Kraken VWAP)`, nearEdge ? "within 0.5% of the threshold; two reads a moment apart" : null);
}

export interface ExpectancyLike { n: number; noData: number; noDataShare: number | null; maxNoDataShare: number; minSample: number; sampleReady: boolean; validation: string }

/** The expectancy summary's own bookkeeping is consistent with the rule book. */
export function expectancyChecks(x: { graded: ExpectancyLike; hold: ExpectancyLike; peak: ExpectancyLike } | null, rules: CryptoRules = CRYPTO_RULES): Check[] {
  if (!x) return [mk("crypto.expectancy", "expectancy bookkeeping", "unavailable", "no expectancy in the payload")];
  const out: Check[] = [];
  for (const rule of ["graded", "hold", "peak"] as const) {
    const s = x[rule];
    const share = s.n + s.noData > 0 ? s.noData / (s.n + s.noData) : null;
    const shareOk = close(s.noDataShare, share == null ? null : Math.round(share * 1000) / 1000, 0, 0.0011);
    const gateOk = s.sampleReady === (s.n >= s.minSample) && s.minSample === rules.grading.minSample && s.maxNoDataShare === rules.grading.maxNoDataShare;
    const labelOk = (share != null && share > rules.grading.maxNoDataShare) || s.n < rules.grading.minSample ? s.validation === "INSUFFICIENT DATA" : true;
    out.push(mk(`crypto.expectancy.${rule}`, `expectancy (${rule})`, shareOk && gateOk && labelOk ? "pass" : "fail",
      `n=${s.n}, no-data ${s.noData} (${fmt((s.noDataShare ?? 0) * 100, 1)}%), ${s.validation}`,
      `share = noData/(n+noData); gate ${rules.grading.minSample}; INSUFFICIENT DATA under the gate or over ${Math.round(rules.grading.maxNoDataShare * 100)}% no-data`,
      !shareOk ? "no-data share disagrees" : !gateOk ? "sample gate or thresholds differ from the rule book" : !labelOk ? "label claims a result the sample cannot support" : null));
  }
  return out;
}

/**
 * Funding and open-interest readout: every displayed number re-derived from the
 * row's own fields, and a plausibility bound that catches a unit slip (a percent
 * read as a fraction). The bound is a verification bound, not a trading rule:
 * exchange funding caps sit far inside +/-5% per interval.
 */
export const FUNDING_PLAUSIBLE_ABS_PCT = 5;

export function derivsChecks(d: DerivsSnapshot | null, now: number): Check[] {
  const id = "crypto.derivs";
  if (!d) return [mk(id, "funding and open interest", "unavailable", "no snapshot", null, "the perpetual-futures feed has not answered yet")];
  if (d.state === "unavailable") return [mk(id, "funding and open interest", "unavailable", "unavailable", null, d.rows.map((r) => `${r.venue} ${r.asset}: ${r.reason ?? r.state}`).slice(0, 6).join("; "))];
  const bad: string[] = [];
  let okRows = 0;
  for (const r of d.rows) {
    if (r.state !== "ok") continue;
    okRows++;
    const tag = `${r.venue} ${r.asset}`;
    if (!fin(r.fundingPct)) { bad.push(`${tag}: funding missing on an ok row`); continue; }
    if (Math.abs(r.fundingPct) > FUNDING_PLAUSIBLE_ABS_PCT) bad.push(`${tag}: funding ${fmt(r.fundingPct, 4)}% per interval is outside the plausible band`);
    if (r.direction !== fundingDirection(r.fundingPct)) bad.push(`${tag}: direction "${r.direction}" disagrees with the funding sign`);
    if (fin(r.fundingIntervalHours) && r.fundingIntervalHours > 0) {
      const exp = Math.round(r.fundingPct * (8 / r.fundingIntervalHours) * 1e6) / 1e6;
      if (!fin(r.funding8hPct) || Math.abs(r.funding8hPct - exp) > 1e-6) bad.push(`${tag}: per-8h ${fmt(r.funding8hPct, 6)} expected ${fmt(exp, 6)}`);
    } else if (r.funding8hPct != null) bad.push(`${tag}: per-8h figure shown without a stated interval`);
    if (r.asOf == null || now - r.asOf > DERIVS_STALE_MS) bad.push(`${tag}: ok row older than the stale limit`);
    if (r.oiState === "ok" && !fin(r.oi1hChangePct)) bad.push(`${tag}: open-interest change marked ok but missing`);
    if (r.oiState !== "ok" && r.oi1hChangePct != null) bad.push(`${tag}: open-interest change shown while ${r.oiState}`);
  }
  if (okRows === 0) return [mk(id, "funding and open interest", "stale", `${d.rows.length} rows, none fresh`, null, "every row is stale or unavailable")];
  return [mk(id, "funding and open interest", bad.length ? "fail" : "pass", `${okRows} fresh row${okRows === 1 ? "" : "s"}, state ${d.state}`, "signs, per-8h arithmetic and units consistent", bad.length ? bad.slice(0, 4).join("; ") : d.state === "partial" ? "partial: at least one asset has no fresh venue" : null)];
}
