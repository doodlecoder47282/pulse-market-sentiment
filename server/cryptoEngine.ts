// server/cryptoEngine.ts
//
// CRYPTO DEGEN DESK — sub-1M meme-coin discovery, scoring, and audit.
//
// Architecture: four deterministic engines on independent schedulers, plus a
// watchdog that heartbeat-checks all of them. No LLM calls — same philosophy
// as the rest of Batcave: rules with disclosed reasoning, honest PASS states,
// and a graded audit log before anything is treated as stakeable.
//
//   1. SCANNER    (60s)  — GeckoTerminal new_pools + trending_pools (Solana).
//                          Pump.fun exposure comes from pools on the pumpswap/
//                          pump.fun DEX ids = bonding-curve GRADUATIONS. That
//                          is the cleanest public window into pump.fun flow.
//   2. MOMENTUM   (75s)  — DexScreener pair enrichment for tracked candidates:
//                          m5/h1/h24 volume + buys/sells + price changes +
//                          liquidity. Computes flow acceleration + FOMO score.
//                          Also pulls DexScreener token-boosts (paid promotion
//                          = manufactured FOMO — flagged, scored both ways).
//   3. RUG FILTER (inline on refresh) — liquidity floor, liq/mcap sanity,
//                          sell-side existence (honeypot proxy), crash filter,
//                          age gates. Hard kills → PASS regardless of score.
//   4. NARRATIVES (5min) — crypto RSS (CoinDesk/TheBlock/Decrypt) keyword heat
//                          over titles published in the last 24 h.
//                          Names that match a hot narrative score higher —
//                          news CONFIRMS, it does not trigger.
//   5. MAJORS     (60s)  — BTC/ETH/SOL exchange-direct from Coinbase Exchange
//                          and Kraken public REST, cross-checked; CoinGecko as
//                          a labeled reference (server/sources/cryptoMajors.ts).
//
// Source tiers (server/sources/registry.ts): DexScreener is the primary DEX
// input, Jupiter Price v3 cross-checks its pool price, Solana RPC gives
// on-chain facts. pump.fun (undocumented frontend API) and Bluesky are
// labeled low-grade attention proxies: shown, logged for later testing, and
// kept out of the score, the verdict and the RUGGED/DEAD grading.
//
//   WATCHDOG (30s) — each engine writes a heartbeat; late/stale/error states
//                    are exposed at /api/crypto/health and shown in the UI.
//
// Free public APIs only, no keys: GeckoTerminal (30 rpm), DexScreener (300 rpm
// for pairs, 60 rpm for boosts). Both budgets respected by design (batching).

import { sqlite } from "./storage";
import { parseFeed } from "./sources/parse";
import { sourceTable, TIER_LABEL } from "./sources/registry";
import { readMajors, type MajorsSnapshot } from "./sources/cryptoMajors";
import { parseJupiterPrices, jupiterCheck, narrativeCounts, JUP_MAX_IDS, type JupState } from "./sources/dexCross";
import {
  computeSocialScore, resolveSocialCollection, expireSocial,
  CRYPTO_SIGNAL_COUNTS_SQL, type SocialStatus, type SocialSourceStatus,
  observedNumber, gradeSignal, cryptoCoinCountsSql, summarizeDeskStats, type CryptoDeskStats,
  holderConcentration, countMentions, socialCoverage, type HolderAccount, type DexPool,
} from "./cryptoStats";

// ─── Types ──────────────────────────────────────────────────────────────

export interface Candidate {
  // identity
  chain: string;
  pairAddress: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  dexId: string;
  pumpfunGraduate: boolean;
  discoveredVia: "new_pools" | "trending" | "boosts";
  firstSeenAt: number;
  pairCreatedAt: number | null;

  // live stats (momentum engine refresh)
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  vol5m: number | null;
  vol1h: number | null;
  vol24h: number | null;
  buys5m: number | null;
  sells5m: number | null;
  buys1h: number | null;
  sells1h: number | null;
  chg5m: number | null;
  chg1h: number | null;
  chg24h: number | null;
  boosted: boolean;
  lastRefreshAt: number | null;

  // Jupiter Price v3 cross-check of the DexScreener pool price
  jupPriceUsd: number | null;
  jupState: JupState;
  jupGapPct: number | null;
  jupCheckedAt: number | null;

  // on-chain security (public Solana RPC — free, no keys)
  mintAuthorityActive: boolean | null;   // null = unchecked
  freezeAuthorityActive: boolean | null;
  top10Pct: number | null;               // top-10 holder share excluding IDENTIFIED pool vaults / burn only
  top10Method: string | null;            // how the pool vault was identified (or that it was not)
  securityCheckedAt: number | null;

  // rugcheck.xyz cached report (keyless)
  rcRisks: string[];
  rcLpLockedPct: number | null;
  rcCheckedAt: number | null;

  // social velocity (bluesky keyless search + pump.fun coin object)
  bskyMentions1h: number | null;
  bskyMentions10m: number | null;
  bskyMentionsByAddress1h: number | null; // posts naming the contract address (identity-safe)
  bskyMentionsByAddress10m: number | null;
  bskyCapped: boolean;                    // search cap hit inside the hour: counts are lower bounds
  pumpReplies: number | null;
  pumpCheckedAt: number | null;           // last successful pump.fun read (values older than this are stale)
  pumpReplyPerHr: number | null;   // measured between polls
  pumpLive: boolean;               // livestream running = raw attention
  hasSocialLinks: boolean | null;  // twitter/telegram/website on the token
  socialScore: number | null;      // 0-100; null = unavailable/failed/stale, never "zero attention"
  socialCheckedAt: number | null;  // last COMPLETE collection (all attempted sources ok)
  socialAttemptAt: number | null;  // last attempt, success or not
  socialStatus: SocialStatus | null;
  socialSources: { bsky: SocialSourceStatus; pump: SocialSourceStatus } | null;
  socialCoverage: string | null;   // which sources the score is normalized over
  prevPumpReplies: { count: number; t: number } | null;

  // rolling history for sustained-flow gating (whale-blink filter)
  hist: Array<{ t: number; volAccel: number | null; netBuyRatio5m: number | null; mcap: number | null }>;

  // derived
  ageMinutes: number | null;
  volAccel: number | null;        // m5 volume annualized vs h1 baseline
  netBuyRatio5m: number | null;   // buys/(buys+sells)
  fomoScore: number | null;       // 0-100
  memeScore: number | null;       // 0-100 name heuristic (hand-set features, no measured link to outcomes)
  narrativeHits: string[];
  rugFlags: string[];
  hardKill: boolean;
  score: number | null;           // composite 0-100
  verdict: "ENTER" | "WATCH" | "PASS" | null;
  verdictReasons: string[];
  risk: RiskParams | null;
}

export interface RiskParams {
  maxPositionUsd: number;      // sized off exit liquidity, not conviction
  suggestedStopPct: number;    // hard stop on position
  liquidityExitStopPct: number;// bail if liquidity drops this much
  targetMcap: number;          // 5M default ride target
  targetMultiple: number | null;
  estSlippagePct: number;
  holdHorizonHours: number;
  notes: string[];
}

interface EngineHealth {
  name: string;
  cadenceMs: number;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  runs: number;
  errors: number;
  status: "ok" | "late" | "stale" | "error" | "starting";
}

// ─── Config ─────────────────────────────────────────────────────────────

const MCAP_CEILING = 1_500_000;    // track a little above 1M so we see the cross
const MCAP_ENTRY_MAX = 1_000_000;  // ENTER only below this
const TARGET_MCAP = 5_000_000;
const LIQ_FLOOR_USD = 8_000;       // below this you cannot exit — hard kill
const MAX_TRACKED = 220;           // memory + rate-budget cap
const CANDIDATE_TTL_MS = 48 * 3600_000; // drop after 48h without a signal
const SCANNER_MS = 60_000;
const MOMENTUM_MS = 75_000;
const NARRATIVE_MS = 5 * 60_000;
const MAJORS_MS = 60_000;
const WATCHDOG_MS = 30_000;
const GRADER_MS = 10 * 60_000;

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const DS_BASE = "https://api.dexscreener.com";
const JUP_BASE = "https://api.jup.ag/price/v3"; // keyless tier, 0.5 req/s

// Meme lexicon for the catchy-name scorer. Weighted by how reliably the theme
// has carried runners. This is a heuristic, not a model — disclosed as such.
const MEME_LEXICON: Array<{ re: RegExp; w: number; tag: string }> = [
  { re: /doge|shib|inu|floki/i, w: 14, tag: "dog meta" },
  { re: /cat|kitty|meow|mog/i, w: 12, tag: "cat meta" },
  { re: /pepe|frog|wojak|chad|gigachad/i, w: 14, tag: "pepe/wojak" },
  { re: /trump|maga|biden|elon|musk|doge?father/i, w: 12, tag: "personality" },
  { re: /\bai\b|gpt|agent|neural|based/i, w: 10, tag: "ai meta" },
  { re: /moon|rocket|pump|lambo|rich|money|cash|print/i, w: 8, tag: "aspiration" },
  { re: /baby|mini|little/i, w: 6, tag: "derivative" },
  { re: /retard|degen|ape|fomo|yolo|gamble/i, w: 10, tag: "degen culture" },
  { re: /penguin|pengu|bonk|wif|hat/i, w: 10, tag: "solana meta" },
  { re: /skibidi|rizz|gyat|ohio|sigma|brainrot|meme/i, w: 12, tag: "brainrot" },
];

// ─── State ──────────────────────────────────────────────────────────────

const tracked = new Map<string, Candidate>(); // key = chain:pairAddress
const health = new Map<string, EngineHealth>();
let narrativeHeat: Array<{ term: string; hits: number; sources: string[] }> = [];
let narrativeUpdatedAt: number | null = null;
let narrativeSources: Array<{ name: string; state: "ok" | "empty" | "failed"; titles: number; undated: number }> = [];
let majors: MajorsSnapshot | null = null;
let timers: NodeJS.Timeout[] = [];
let started = false;

function hb(name: string, cadenceMs: number): EngineHealth {
  let h = health.get(name);
  if (!h) {
    h = { name, cadenceMs, lastRunAt: null, lastOkAt: null, lastError: null, runs: 0, errors: 0, status: "starting" };
    health.set(name, h);
  }
  return h;
}

async function runEngine(name: string, cadenceMs: number, fn: () => Promise<void>): Promise<void> {
  const h = hb(name, cadenceMs);
  h.lastRunAt = Date.now();
  h.runs++;
  try {
    await fn();
    h.lastOkAt = Date.now();
    h.lastError = null;
  } catch (e: any) {
    h.errors++;
    h.lastError = String(e?.message ?? e).slice(0, 300);
    console.warn(`[crypto:${name}] ${h.lastError}`);
  }
}

// ─── SQLite audit log ───────────────────────────────────────────────────

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS crypto_signals (
    id TEXT PRIMARY KEY,
    detected_at INTEGER NOT NULL,
    chain TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    token_address TEXT,
    symbol TEXT,
    name TEXT,
    verdict TEXT NOT NULL,
    score REAL,
    mcap_at_signal REAL,
    price_at_signal REAL,
    liquidity_at_signal REAL,
    features_json TEXT,
    risk_json TEXT,
    peak_mcap REAL,
    peak_at INTEGER,
    last_mcap REAL,
    last_liquidity REAL,
    outcome TEXT,           -- OPEN | HIT_5M | DOUBLED | RUGGED | DEAD | NO_DATA
    graded_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_crypto_signals_outcome ON crypto_signals(outcome);
`);
// MIGRATION: the original per-day dedupe ignored verdict, which silently
// BLOCKED same-day WATCH → ENTER upgrades — the most important signal we
// have. Uniqueness is now (pair, verdict, day) so an upgrade writes its row.
sqlite.exec(`
  DROP INDEX IF EXISTS idx_crypto_signals_pair_day;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_crypto_signals_pair_verdict_day
    ON crypto_signals(pair_address, verdict, detected_at / 86400000);
`);

function persistSignal(c: Candidate): void {
  if (!c.verdict || c.verdict === "PASS") return;
  try {
    sqlite.prepare(`
      INSERT OR IGNORE INTO crypto_signals
        (id, detected_at, chain, pair_address, token_address, symbol, name, verdict,
         score, mcap_at_signal, price_at_signal, liquidity_at_signal,
         features_json, risk_json, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
    `).run(
      `${c.chain}:${c.pairAddress}:${Date.now()}`,
      Date.now(), c.chain, c.pairAddress, c.tokenAddress, c.symbol, c.name,
      c.verdict, c.score, c.marketCap, c.priceUsd, c.liquidityUsd,
      JSON.stringify({
        volAccel: c.volAccel, netBuyRatio5m: c.netBuyRatio5m, fomo: c.fomoScore,
        meme: c.memeScore, memeMethod: MEME_SCORE_METHOD, narrativeHits: c.narrativeHits, rugFlags: c.rugFlags,
        boosted: c.boosted, pumpfunGraduate: c.pumpfunGraduate,
        ageMinutes: c.ageMinutes, reasons: c.verdictReasons,
        mintAuthorityActive: c.mintAuthorityActive, freezeAuthorityActive: c.freezeAuthorityActive,
        top10Pct: c.top10Pct, top10Method: c.top10Method, securityCheckedAt: c.securityCheckedAt,
        rcRisks: c.rcRisks, rcLpLockedPct: c.rcLpLockedPct,
        socialScore: c.socialScore, socialStatus: c.socialStatus, socialCoverage: c.socialCoverage,
        bskyMentions1h: c.bskyMentions1h, bskyMentionsByAddress1h: c.bskyMentionsByAddress1h, bskyCapped: c.bskyCapped,
        pumpReplyPerHr: c.pumpReplyPerHr, pumpLive: c.pumpLive,
      }),
      JSON.stringify(c.risk),
    );
  } catch (e: any) {
    console.warn(`[crypto:persist] ${e?.message ?? e}`);
  }
}

// ─── HTTP helper (no keys, gentle timeouts) ─────────────────────────────

async function getJson(url: string, timeoutMs = 12_000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: "application/json", "user-agent": "batcave-terminal/1.0" },
    });
    if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 90)}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// pump.fun's CDN rejects node's TLS fingerprint (any UA -> 403) but allows
// curl's. Verified live. So pump.fun calls shell out to curl; everything
// else stays on native fetch.
import { execFile } from "child_process";

function curlJson(url: string, timeoutMs = 12_000): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-s", "-m", String(Math.ceil(timeoutMs / 1000)), "-H", "accept: application/json", url],
      { timeout: timeoutMs + 2000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`non-json from ${url.slice(0, 60)}`)); }
      },
    );
  });
}

// ─── 1. SCANNER — GeckoTerminal discovery ───────────────────────────────

function isPumpDex(dexId: string | null | undefined): boolean {
  const d = String(dexId ?? "").toLowerCase();
  return d.includes("pump"); // pumpswap / pump-fun / pumpfun variants
}

function upsertFromGtPool(pool: any, via: Candidate["discoveredVia"]): void {
  const attrs = pool?.attributes ?? {};
  const rel = pool?.relationships ?? {};
  const pairAddress = String(attrs.address ?? "");
  if (!pairAddress) return;
  const chain = String(rel?.network?.data?.id ?? "solana");
  const key = `${chain}:${pairAddress}`;

  const fdv = Number(attrs.fdv_usd ?? NaN);
  const mcap = Number(attrs.market_cap_usd ?? NaN);
  const effMcap = Number.isFinite(mcap) && mcap > 0 ? mcap : (Number.isFinite(fdv) ? fdv : null);
  // Only track the sub-ceiling universe — that IS the strategy.
  if (effMcap != null && effMcap > MCAP_CEILING) {
    if (!tracked.has(key)) return; // never adopt above ceiling; keep existing for cross-tracking
  }

  const dexId = String(rel?.dex?.data?.id ?? "");
  const nameRaw = String(attrs.name ?? ""); // "TOKEN / SOL"
  const baseName = nameRaw.split("/")[0]?.trim() || nameRaw;
  const createdAt = attrs.pool_created_at ? Date.parse(attrs.pool_created_at) : null;

  const existing = tracked.get(key);
  const c: Candidate = existing ?? {
    chain, pairAddress,
    tokenAddress: String(rel?.base_token?.data?.id ?? "").split("_").pop() ?? "",
    symbol: baseName, name: baseName, dexId,
    pumpfunGraduate: isPumpDex(dexId),
    discoveredVia: via,
    firstSeenAt: Date.now(),
    pairCreatedAt: createdAt,
    priceUsd: null, marketCap: null, fdv: null, liquidityUsd: null,
    vol5m: null, vol1h: null, vol24h: null,
    buys5m: null, sells5m: null, buys1h: null, sells1h: null,
    chg5m: null, chg1h: null, chg24h: null,
    boosted: false, lastRefreshAt: null,
    jupPriceUsd: null, jupState: "unchecked", jupGapPct: null, jupCheckedAt: null,
    mintAuthorityActive: null, freezeAuthorityActive: null, top10Pct: null, top10Method: null, securityCheckedAt: null,
    rcRisks: [], rcLpLockedPct: null, rcCheckedAt: null,
    bskyMentions1h: null, bskyMentions10m: null, bskyMentionsByAddress1h: null, bskyMentionsByAddress10m: null, bskyCapped: false,
    pumpReplies: null, pumpCheckedAt: null, pumpReplyPerHr: null,
    pumpLive: false, hasSocialLinks: null, socialScore: null, socialCheckedAt: null, prevPumpReplies: null,
    socialAttemptAt: null, socialStatus: null, socialSources: null, socialCoverage: null,
    hist: [],
    ageMinutes: null, volAccel: null, netBuyRatio5m: null,
    fomoScore: null, memeScore: null, narrativeHits: [], rugFlags: [],
    hardKill: false, score: null, verdict: null, verdictReasons: [], risk: null,
  };
  // GT gives a coarse first look — momentum engine refines with DexScreener.
  c.marketCap = effMcap ?? c.marketCap;
  c.fdv = Number.isFinite(fdv) ? fdv : c.fdv;
  // observed 0 stays 0 (a drained pool); only an absent field keeps the old value
  c.priceUsd = observedNumber(attrs.base_token_price_usd) ?? c.priceUsd;
  c.liquidityUsd = observedNumber(attrs.reserve_in_usd) ?? c.liquidityUsd;
  if (!existing) tracked.set(key, c);
}

async function scannerTick(): Promise<void> {
  // 2 GT calls per tick (well under 30 rpm)
  const [fresh, trending] = await Promise.allSettled([
    getJson(`${GT_BASE}/networks/solana/new_pools?page=1`),
    getJson(`${GT_BASE}/networks/solana/trending_pools?page=1`),
  ]);
  if (fresh.status === "fulfilled") {
    for (const p of fresh.value?.data ?? []) upsertFromGtPool(p, "new_pools");
  }
  if (trending.status === "fulfilled") {
    for (const p of trending.value?.data ?? []) upsertFromGtPool(p, "trending");
  }
  if (fresh.status === "rejected" && trending.status === "rejected") {
    throw new Error(`geckoterminal unreachable: ${String((fresh as any).reason?.message ?? "?").slice(0, 120)}`);
  }

  // Evict: stale, dead, or over cap (keep highest-score / newest)
  const now = Date.now();
  for (const [k, c] of tracked) {
    const stale = now - (c.lastRefreshAt ?? c.firstSeenAt) > CANDIDATE_TTL_MS;
    const grewOut = (c.marketCap ?? 0) > MCAP_CEILING * 4; // 6M+: past our window entirely
    if (stale || grewOut) tracked.delete(k);
  }
  if (tracked.size > MAX_TRACKED) {
    const sorted = [...tracked.entries()].sort(
      (a, b) => (b[1].score ?? -1) - (a[1].score ?? -1) || b[1].firstSeenAt - a[1].firstSeenAt,
    );
    for (const [k] of sorted.slice(MAX_TRACKED)) tracked.delete(k);
  }
}

// ─── 2. MOMENTUM — DexScreener enrichment + scoring ─────────────────────

let boostedTokens = new Set<string>();
let lastBoostFetch = 0;
/** token mint -> its DEX pools with base reserves (from the latest DexScreener read) */
const tokenPools = new Map<string, { at: number; pools: DexPool[] }>();

async function momentumTick(): Promise<void> {
  // Refresh boosts at most every 5 min (60 rpm budget, this uses ~0.2 rpm)
  if (Date.now() - lastBoostFetch > 5 * 60_000) {
    try {
      const boosts = await getJson(`${DS_BASE}/token-boosts/latest/v1`);
      boostedTokens = new Set(
        (Array.isArray(boosts) ? boosts : []).map((b: any) => String(b?.tokenAddress ?? "").toLowerCase()).filter(Boolean),
      );
      lastBoostFetch = Date.now();
    } catch { /* boosts are enhancement, not critical path */ }
  }

  // Refresh oldest-first in batches of 30 token addresses (1 DS call each).
  const list = [...tracked.values()]
    .sort((a, b) => (a.lastRefreshAt ?? 0) - (b.lastRefreshAt ?? 0));
  const batch = list.slice(0, 90); // 3 calls/tick max — far under budget
  const byToken = new Map<string, Candidate[]>();
  for (const c of batch) {
    if (!c.tokenAddress) continue;
    const arr = byToken.get(c.tokenAddress) ?? [];
    arr.push(c);
    byToken.set(c.tokenAddress, arr);
  }
  const addrs = [...byToken.keys()];
  // Jupiter cross-check: one keyless call per tick (<= 50 mints; the keyless
  // limit is 0.5 req/s and the tick is 75 s). A failed call marks the check
  // failed for this tick; it never blocks the DexScreener refresh.
  const jupMints = addrs.slice(0, JUP_MAX_IDS);
  let jup: { prices: Map<string, number>; omitted: Set<string>; failed: boolean; at: number } | null = null;
  if (jupMints.length) {
    try {
      const j = await getJson(`${JUP_BASE}?ids=${jupMints.join(",")}`);
      const r = parseJupiterPrices(j, jupMints);
      jup = { prices: r.prices, omitted: new Set(r.omitted), failed: false, at: Date.now() };
    } catch {
      jup = { prices: new Map(), omitted: new Set(), failed: true, at: Date.now() };
    }
  }
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    let resp: any;
    try {
      resp = await getJson(`${DS_BASE}/latest/dex/tokens/${chunk.join(",")}`);
    } catch (e: any) {
      throw new Error(`dexscreener batch failed: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    const pairs: any[] = resp?.pairs ?? [];
    // Every pool of each token (tracked or not), with its base-token reserve:
    // the security check uses these to identify pool vaults among holders.
    const poolsByToken = new Map<string, DexPool[]>();
    for (const p of pairs) {
      const mint = String(p?.baseToken?.address ?? "");
      if (!mint || !p?.pairAddress) continue;
      const arr = poolsByToken.get(mint) ?? [];
      arr.push({ pairAddress: String(p.pairAddress), baseAmount: observedNumber(p?.liquidity?.base) });
      poolsByToken.set(mint, arr);
    }
    for (const [mint, pools] of Array.from(poolsByToken.entries())) tokenPools.set(mint, { at: Date.now(), pools });
    for (const p of pairs) {
      const key = `${String(p?.chainId ?? "solana")}:${String(p?.pairAddress ?? "")}`;
      const c = tracked.get(key);
      if (!c) continue;
      c.symbol = String(p?.baseToken?.symbol ?? c.symbol);
      c.name = String(p?.baseToken?.name ?? c.name);
      // DexScreener Pair: liquidity (object) and liquidity.usd, marketCap,
      // fdv, priceUsd are nullable. Absent = null (missing); observed 0 = 0
      // (a full liquidity pull must read as $0, not as "unknown").
      c.priceUsd = observedNumber(p?.priceUsd);
      c.marketCap = observedNumber(p?.marketCap);
      c.fdv = observedNumber(p?.fdv);
      c.liquidityUsd = observedNumber(p?.liquidity?.usd);
      c.vol5m = observedNumber(p?.volume?.m5);
      c.vol1h = observedNumber(p?.volume?.h1);
      c.vol24h = observedNumber(p?.volume?.h24);
      c.buys5m = observedNumber(p?.txns?.m5?.buys);
      c.sells5m = observedNumber(p?.txns?.m5?.sells);
      c.buys1h = observedNumber(p?.txns?.h1?.buys);
      c.sells1h = observedNumber(p?.txns?.h1?.sells);
      c.chg5m = Number(p?.priceChange?.m5 ?? NaN);
      c.chg1h = Number(p?.priceChange?.h1 ?? NaN);
      c.chg24h = Number(p?.priceChange?.h24 ?? NaN);
      if (Number.isNaN(c.chg5m)) c.chg5m = null;
      if (Number.isNaN(c.chg1h)) c.chg1h = null;
      if (Number.isNaN(c.chg24h)) c.chg24h = null;
      if (p?.pairCreatedAt) c.pairCreatedAt = Number(p.pairCreatedAt);
      c.boosted = boostedTokens.has(c.tokenAddress.toLowerCase());
      if (jup && jupMints.includes(c.tokenAddress)) {
        const jp = jup.prices.get(c.tokenAddress) ?? null;
        const chk = jupiterCheck(c.priceUsd, { price: jp, omitted: jup.omitted.has(c.tokenAddress), failed: jup.failed });
        c.jupPriceUsd = jp;
        c.jupState = chk.state;
        c.jupGapPct = chk.gapPct != null ? Number(chk.gapPct.toFixed(1)) : null;
        c.jupCheckedAt = jup.at;
      } else {
        c.jupState = "unchecked";
        c.jupGapPct = null;
      }
      c.lastRefreshAt = Date.now();
      scoreCandidate(c);
      // history AFTER scoring so volAccel/netBuyRatio are fresh; cap 20 readings
      c.hist.push({ t: c.lastRefreshAt, volAccel: c.volAccel, netBuyRatio5m: c.netBuyRatio5m, mcap: c.marketCap });
      if (c.hist.length > 20) c.hist.shift();
      persistSignal(c);
    }
  }
}

// ─── 2b. SECURITY — public Solana RPC on-chain checks ───────────────────
//
// The #1 rug vector isn't liquidity — it's authorities and concentration:
//   - mint authority active  = dev can print infinite supply into your bid
//   - freeze authority active = dev can freeze YOUR tokens (can't sell)
//   - top-10 holders > 45%   = coordinated dump risk
// All readable from the free public RPC (api.mainnet-beta.solana.com), no key.
// Concentration = top-10 token accounts over supply, excluding only accounts
// identified as a pool vault (owner = one of the token's DEX pair addresses,
// or balance = the pool's DexScreener base reserve) or burned (incinerator
// owner). The largest holder is no longer excluded by rank (finding 10.3).
//
// Budget: 3 RPC calls per token, 3 tokens per 45s tick — far under public
// RPC limits. Each candidate is checked once; re-checked every 30 min only
// while an authority remains active (revocations happen post-launch).

const SECURITY_MS = 45_000;
// Method-aware routing, verified live:
//   - publicnode serves getAccountInfo keylessly (authorities + supply via
//     parsed mint data) but gates "indexed" methods (getTokenLargestAccounts)
//     behind a personal token.
//   - mainnet-beta serves indexed methods but 429s on bursts — so holder
//     concentration is ONE gentle call per tick with a cooldown after any 429,
//     and it is non-fatal: authorities alone still complete the check.
const RPC_ACCOUNT = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
const RPC_INDEXED = ["https://api.mainnet-beta.solana.com"];
let rpcId = 1;
let indexedCooldownUntil = 0; // set after a 429 — back off 5 min
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function solRpc(method: string, params: any[], urls: string[]): Promise<any> {
  let lastErr: any = null;
  for (const url of urls) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12_000);
    try {
      const r = await fetch(url, {
        method: "POST", signal: ctl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      });
      if (!r.ok) throw new Error(`rpc ${r.status} @ ${new URL(url).hostname}`);
      const j = await r.json();
      if (j.error) throw new Error(`rpc: ${j.error?.message ?? "unknown"}`);
      return j.result;
    } catch (e: any) {
      lastErr = e;
      await sleep(400);
      continue;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr ?? new Error("all solana rpcs failed");
}

async function securityTick(): Promise<void> {
  // oldest-unchecked first; re-check active-authority tokens every 30 min
  const now = Date.now();
  const due = [...tracked.values()]
    .filter((c) => c.chain === "solana" && c.tokenAddress && (c.liquidityUsd ?? 0) >= LIQ_FLOOR_USD)
    .filter((c) =>
      c.securityCheckedAt == null ||
      ((c.mintAuthorityActive || c.freezeAuthorityActive) && now - c.securityCheckedAt > 30 * 60_000))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) // best candidates first — they gate ENTER
    .slice(0, 2); // gentle pace — public RPCs throttle bursts hard
  if (due.length === 0) return;

  let okCount = 0;
  let lastErr: any = null;
  let concentrationDone = false; // max ONE indexed call per tick
  for (const c of due) {
    try {
      // CRITICAL PATH: authorities + supply from one parsed account read
      const acct = await solRpc("getAccountInfo", [c.tokenAddress, { encoding: "jsonParsed" }], RPC_ACCOUNT);
      const info = acct?.value?.data?.parsed?.info;
      if (!info) throw new Error("mint account not parseable");
      c.mintAuthorityActive = info.mintAuthority != null;
      c.freezeAuthorityActive = info.freezeAuthority != null;
      const total = Number(info.supply ?? 0);
      const decimals = Number(info.decimals ?? 0);
      const supplyUi = Number.isFinite(decimals) ? total / Math.pow(10, decimals) : NaN;

      // BEST-EFFORT: holder concentration (indexed — mainnet-beta only, gentle)
      if (!concentrationDone && total > 0 && Date.now() > indexedCooldownUntil) {
        concentrationDone = true;
        try {
          await sleep(800);
          const largest = await solRpc("getTokenLargestAccounts", [c.tokenAddress], RPC_INDEXED);
          const accts: any[] = largest?.value ?? [];
          if (accts.length > 0 && supplyUi > 0) {
            // Exclude only IDENTIFIED pool vaults and burned supply, never
            // "the largest account" by rank (a whale or the deployer at the
            // top is what this flag exists to catch). Owners come from one
            // non-indexed getMultipleAccounts read; reserve matching against
            // DexScreener liquidity.base works even without owners.
            const holders: HolderAccount[] = accts.map((a: any) => ({
              address: String(a?.address ?? ""),
              uiAmount: observedNumber(a?.uiAmountString ?? a?.uiAmount),
            }));
            try {
              const multi = await solRpc("getMultipleAccounts", [holders.map((h) => h.address), { encoding: "jsonParsed" }], RPC_ACCOUNT);
              const vals: any[] = multi?.value ?? [];
              holders.forEach((h, i) => { h.owner = vals[i]?.data?.parsed?.info?.owner ?? null; });
            } catch { /* owners optional */ }
            const known = tokenPools.get(c.tokenAddress)?.pools ?? [];
            const pools = known.some((p) => p.pairAddress === c.pairAddress)
              ? known
              : [...known, { pairAddress: c.pairAddress, baseAmount: null }];
            const conc = holderConcentration(holders, pools, supplyUi);
            c.top10Pct = conc.top10Pct;
            c.top10Method = conc.method;
          }
        } catch (e: any) {
          if (/429/.test(String(e?.message))) indexedCooldownUntil = Date.now() + 5 * 60_000;
          // non-fatal — authorities are the gate, concentration is a bonus flag
        }
      }

      // ── rugcheck.xyz cached summary (keyless, verified) — LP lock + named risks ──
      if (c.rcCheckedAt == null) {
        try {
          const rc = await getJson(`https://api.rugcheck.xyz/v1/tokens/${c.tokenAddress}/report/summary`);
          const risks: any[] = rc?.risks ?? [];
          c.rcRisks = risks.map((r) => String(r?.name ?? r)).filter(Boolean).slice(0, 6);
          const lp = Number(rc?.lpLockedPct ?? NaN);
          c.rcLpLockedPct = Number.isFinite(lp) ? Number(lp.toFixed(1)) : null;
          c.rcCheckedAt = Date.now();
        } catch { /* cached-only source — absence is not a verdict */ }
      }

      c.securityCheckedAt = Date.now();
      okCount++;
      scoreCandidate(c); // re-verdict with security facts
      persistSignal(c);
      await sleep(700);
    } catch (e: any) {
      lastErr = e;
    }
  }
  if (okCount === 0 && lastErr) {
    throw new Error(`solana rpc failing: ${String(lastErr?.message ?? lastErr).slice(0, 100)}`);
  }
}

// ─── 2c. SOCIAL VELOCITY — bluesky + pump.fun (keyless, verified live) ───
//
// FOMO forms on social before it finishes printing on the chart. Free keyless
// sources that actually work from this server (tested):
//   - bluesky search via api.bsky.app (the "public." host CDN-blocks
//     datacenter IPs; the main host serves keyless reads) — mention counts
//     for "$SYMBOL" and for the contract address in the last 10m/60m
//     (app.bsky.feed.searchPosts: q, sort, since, limit <= 100, cursor;
//     https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/searchPosts.json).
//   - pump.fun /coins/{mint} — reply_count (velocity between polls),
//     livestream flag, twitter/telegram/website links.
// Reddit blocks datacenter IPs outright — excluded, disclosed.
// X/twitter is paywalled — excluded, disclosed.

const SOCIAL_MS = 90_000;
const BSKY = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts";
const PUMP = "https://frontend-api-v3.pump.fun";

const BSKY_LIMIT = 100;     // app.bsky.feed.searchPosts max page size
const BSKY_MAX_PAGES = 3;

/** One Bluesky search over the last hour, paginated; `capped` when pages ran out before the hour did. */
async function bskySearchHour(q: string, since: string): Promise<{ posts: Array<{ uri?: string; createdAt?: string; text?: string }>; capped: boolean }> {
  const posts: Array<{ uri?: string; createdAt?: string; text?: string }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < BSKY_MAX_PAGES; page++) {
    const url = `${BSKY}?q=${encodeURIComponent(q)}&sort=latest&limit=${BSKY_LIMIT}&since=${encodeURIComponent(since)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await getJson(url);
    const batch: any[] = r?.posts ?? [];
    for (const p of batch) posts.push({ uri: p?.uri, createdAt: p?.record?.createdAt ?? p?.indexedAt, text: p?.record?.text });
    cursor = typeof r?.cursor === "string" && r.cursor ? r.cursor : undefined;
    if (batch.length < BSKY_LIMIT || !cursor) return { posts, capped: false };
  }
  return { posts, capped: true };
}

async function socialTick(): Promise<void> {
  // refresh the best candidates first (they gate ENTER); 4 per tick,
  // stale after 5 min. ~3 bsky + ~3 pump calls per tick — trivial load.
  const now = Date.now();
  const due = [...tracked.values()]
    .filter((c) => c.lastRefreshAt != null && (c.marketCap ?? 0) <= MCAP_CEILING * 2)
    .filter((c) => c.socialAttemptAt == null || now - c.socialAttemptAt > 5 * 60_000)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 4);
  if (due.length === 0) return;

  let okCount = 0;
  let lastErr: any = null;
  for (const c of due) {
    try {
      c.socialAttemptAt = now;
      let bsky: SocialSourceStatus = "skipped";
      let pump: SocialSourceStatus = "skipped";
      // ── bluesky mentions: "$SYMBOL" cashtag AND the contract address ──
      // A cashtag alone collides with other coins and plain words; the mint
      // address is the token's identity. Both searches use `since` = 1 h ago,
      // limit 100 (the lexicon max) and up to BSKY_MAX_PAGES pages; if a
      // search is still returning full pages inside the hour the counts are
      // a lower bound and flagged as capped (finding 10.2).
      const sym = c.symbol.replace(/[^A-Za-z0-9]/g, "");
      const queries: Array<{ kind: "cashtag" | "address"; q: string }> = [];
      if (sym.length >= 3) queries.push({ kind: "cashtag", q: `$${sym}` });
      if (c.tokenAddress && c.tokenAddress.length >= 32) queries.push({ kind: "address", q: c.tokenAddress });
      if (queries.length) {
        try {
          const since = new Date(now - 3600_000).toISOString();
          const results = [];
          for (const qq of queries) results.push({ kind: qq.kind, ...(await bskySearchHour(qq.q, since)) });
          const mc = countMentions(results, c.tokenAddress, now);
          c.bskyMentions1h = mc.m1h;
          c.bskyMentions10m = mc.m10;
          c.bskyMentionsByAddress1h = mc.byAddress1h;
          c.bskyMentionsByAddress10m = mc.byAddress10m;
          c.bskyCapped = mc.capped;
          bsky = "ok";
        } catch {
          // bsky is enhancement — never blocks the tick. A failed fetch is
          // MISSING data, not zero mentions.
          bsky = "failed";
          c.bskyMentions1h = null;
          c.bskyMentions10m = null;
          c.bskyMentionsByAddress1h = null;
          c.bskyMentionsByAddress10m = null;
          c.bskyCapped = false;
        }
      }

      // ── pump.fun coin object (only for pump ecosystem tokens) ──
      if (c.tokenAddress.endsWith("pump") || c.pumpfunGraduate) {
        try {
          const coin = await curlJson(`${PUMP}/coins/${c.tokenAddress}`);
          const replies = Number(coin?.reply_count ?? NaN);
          if (Number.isFinite(replies)) {
            if (c.prevPumpReplies && now > c.prevPumpReplies.t) {
              const hrs = (now - c.prevPumpReplies.t) / 3600_000;
              if (hrs > 0.02) c.pumpReplyPerHr = Number(((replies - c.prevPumpReplies.count) / hrs).toFixed(1));
            }
            c.prevPumpReplies = { count: replies, t: now };
            c.pumpReplies = replies;
          }
          c.pumpCheckedAt = now;
          c.pumpLive = Boolean(coin?.is_currently_live);
          c.hasSocialLinks = Boolean(coin?.twitter || coin?.telegram || coin?.website);
          pump = "ok";
        } catch {
          // unofficial API — graceful degradation is the contract, but the
          // failure is recorded, never scored as zero replies.
          pump = "failed";
        }
      }

      // ── social score 0-100: published only from a complete collection,
      // normalized over the sources that apply to this token ──
      const applicable = { bsky: bsky !== "skipped", pump: pump !== "skipped" };
      const next = resolveSocialCollection(
        { socialScore: c.socialScore, socialCheckedAt: c.socialCheckedAt, socialStatus: c.socialStatus },
        { bsky, pump },
        computeSocialScore(c, applicable),
        now,
      );
      c.socialCoverage = socialCoverage(applicable) + (applicable.bsky ? "; cashtag-only mentions count half (heuristic), contract-address mentions in full" : "") + (c.bskyCapped ? "; bluesky search capped (counts are lower bounds)" : "");
      c.socialScore = next.socialScore;
      c.socialCheckedAt = next.socialCheckedAt;
      c.socialStatus = next.socialStatus;
      c.socialSources = { bsky, pump };
      if (bsky === "failed" && pump !== "ok") throw new Error("bsky fetch failed");
      if (pump === "failed" && bsky !== "ok") throw new Error("pump.fun fetch failed");
      okCount++;
      scoreCandidate(c);
      persistSignal(c);
    } catch (e: any) {
      lastErr = e;
      // still rescore so FOMO drops a score that just expired or failed
      try { scoreCandidate(c); } catch { /* scoring errors surface on the momentum tick */ }
    }
  }
  if (okCount === 0 && lastErr) {
    throw new Error(`social sources failing: ${String(lastErr?.message ?? lastErr).slice(0, 100)}`);
  }
}

// ─── 3. RUG FILTER + scoring ────────────────────────────────────────────

// Name "virality" (finding 10.5): HAND-SET features (lexicon themes, a
// chantable 3-6 letter ticker +8, all caps +4, a short name +6, an emoji +4).
// A labelled heuristic with no measured link to outcomes yet; it is logged
// in features_json so the graded audit can test it later.
export const MEME_SCORE_METHOD = "heuristic: hand-set name features, not fitted to outcomes";

function scoreMeme(nameIn: string, symbolIn: string): { score: number; tags: string[] } {
  const s = `${nameIn} ${symbolIn}`;
  let score = 0;
  const tags: string[] = [];
  for (const { re, w, tag } of MEME_LEXICON) {
    if (re.test(s)) { score += w; tags.push(tag); }
  }
  const sym = symbolIn.replace(/[^A-Za-z]/g, "");
  if (sym.length >= 3 && sym.length <= 6) score += 8;               // chantable ticker
  if (/^[A-Z]+$/.test(symbolIn) && symbolIn.length <= 6) score += 4; // clean caps
  if (nameIn.length <= 12) score += 6;                               // short = shareable
  if (/\p{Emoji}/u.test(nameIn)) score += 4;                         // emoji in name
  return { score: Math.min(100, score * 2.2), tags: [...new Set(tags)] };
}

function scoreCandidate(c: Candidate): void {
  const now = Date.now();
  c.ageMinutes = c.pairCreatedAt ? Math.max(0, (now - c.pairCreatedAt) / 60_000) : null;

  // meme score
  const meme = scoreMeme(c.name, c.symbol);
  c.memeScore = meme.score;

  // narrative confirmation — name/symbol matches a hot news narrative
  c.narrativeHits = narrativeHeat
    .filter((n) => n.hits >= 2)
    .filter((n) => new RegExp(`\\b${n.term}\\b`, "i").test(`${c.name} ${c.symbol}`))
    .map((n) => n.term);

  // flow: volume acceleration = m5 pace vs h1 pace (null when the source
  // did not report volume: missing is not zero flow)
  if (c.vol5m == null || c.vol1h == null) {
    c.volAccel = null;
  } else {
    const paceM5 = c.vol5m / 5;
    const paceH1 = c.vol1h / 60;
    c.volAccel = paceH1 > 0 ? paceM5 / paceH1 : (paceM5 > 0 ? 5 : 0);
  }
  const t5 = c.buys5m != null && c.sells5m != null ? c.buys5m + c.sells5m : 0;
  c.netBuyRatio5m = t5 > 0 ? (c.buys5m ?? 0) / t5 : null;

  // FOMO score: acceleration + one-sided tape + trending/boost presence
  let fomo = 0;
  if (c.volAccel != null) fomo += Math.min(40, c.volAccel * 10);          // 4x accel = max
  if (c.netBuyRatio5m != null) fomo += Math.max(0, (c.netBuyRatio5m - 0.5) * 100); // up to +50
  if (c.discoveredVia === "trending") fomo += 10;
  if (c.boosted) fomo += 8; // paid promo IS fomo — but it's flagged as manufactured below
  // Social velocity (Bluesky mentions + pump.fun reply rate) is a low-grade
  // attention proxy from social media and an undocumented frontend API
  // (R2-I): it is shown and logged in features_json for later testing, but
  // it no longer blends into FOMO, so it cannot move the score or verdict.
  // An expired score (older than SOCIAL_TTL_MS) is dropped so a stale or
  // failed collection never displays as current.
  const soc = expireSocial(
    { socialScore: c.socialScore, socialCheckedAt: c.socialCheckedAt, socialStatus: c.socialStatus },
    now,
  );
  c.socialScore = soc.socialScore;
  c.socialStatus = soc.socialStatus;
  c.fomoScore = Math.min(100, fomo);

  // rug filter
  const flags: string[] = [];
  let hardKill = false;
  // Liquidity: missing (not reported) and observed $0 (pulled) are different
  // states; both kill, with different reasons.
  const liqObs = c.liquidityUsd;
  const liq = liqObs ?? 0;
  const mcap = c.marketCap ?? c.fdv ?? 0;
  if (liqObs == null) { flags.push("liquidity not reported by the source (missing) — exit cannot be verified"); hardKill = true; }
  else if (liqObs === 0) { flags.push("liquidity $0 observed — pool drained / liquidity pulled"); hardKill = true; }
  else if (liq < LIQ_FLOOR_USD) { flags.push(`liquidity $${(liq / 1000).toFixed(1)}k < $${LIQ_FLOOR_USD / 1000}k floor — cannot exit`); hardKill = true; }
  if (mcap > 0 && liq > 0 && liq / mcap < 0.03) { flags.push(`liq/mcap ${(100 * liq / mcap).toFixed(1)}% < 3% — exit door too small`); hardKill = true; }
  if (mcap > 0 && liq > mcap * 2) flags.push("liquidity >> mcap — weird pool, likely mispriced data");
  if ((c.buys1h ?? 0) >= 25 && (c.sells1h ?? 0) === 0) { flags.push("buys but ZERO sells in 1h — honeypot pattern"); hardKill = true; }
  if ((c.chg1h ?? 0) < -55) { flags.push(`price ${c.chg1h?.toFixed(0)}% in 1h — mid-rug or post-dump`); hardKill = true; }
  if ((c.ageMinutes ?? 1e9) < 10) flags.push("under 10 min old — sniper zone, spreads brutal");
  if (c.boosted) flags.push("paid DexScreener boost — manufactured attention, discount the FOMO");
  if ((c.vol24h ?? 0) < 1000 && (c.ageMinutes ?? 0) > 720) flags.push("aged with no volume — dead pool");
  // on-chain security facts (public RPC)
  if (c.mintAuthorityActive === true) { flags.push("MINT AUTHORITY ACTIVE — dev can print supply into your bid"); hardKill = true; }
  if (c.freezeAuthorityActive === true) { flags.push("FREEZE AUTHORITY ACTIVE — dev can lock your tokens"); hardKill = true; }
  if ((c.top10Pct ?? 0) > 45) flags.push(`top-10 holders ${c.top10Pct}% of supply (${c.top10Method?.startsWith("top-10 holders INCLUDING") ? "pool vault not identified, may include pool" : "ex-pool"}) — coordinated dump risk`);
  // rugcheck cached report — LP lock + named risks (non-fatal: cached data)
  if (c.rcLpLockedPct != null && c.rcLpLockedPct < 50) flags.push(`LP only ${c.rcLpLockedPct}% locked (rugcheck) — pull risk`);
  for (const r of c.rcRisks) flags.push(`rugcheck: ${r}`);
  // Jupiter cross-check of the pool price (aggregator; flags, not hard kills)
  if (c.jupState === "diverge") flags.push(`pool price ${c.jupGapPct}% off Jupiter — price unverified, no entry`);
  else if (c.jupState === "no-reliable-price") flags.push("Jupiter has no reliable price for this mint — price unverified");
  c.rugFlags = flags;
  c.hardKill = hardKill;

  // composite: flow 35, structure 25 (inverse rug pressure), meme 15, narrative 15, fomo 10
  const flow = Math.min(35, (c.fomoScore ?? 0) * 0.35);
  const structure = hardKill ? 0 : Math.max(0, 25 - flags.length * 5);
  const memePts = (c.memeScore ?? 0) * 0.15;
  const narrPts = Math.min(15, c.narrativeHits.length * 7.5);
  const fomoPts = (c.fomoScore ?? 0) * 0.10;
  c.score = Math.round(Math.min(100, flow + structure + memePts + narrPts + fomoPts));

  // verdict
  const reasons: string[] = [];
  let verdict: Candidate["verdict"] = "PASS";
  if (hardKill) {
    reasons.push("hard kill: " + flags.filter((f) => /floor|honeypot|mid-rug|exit door|liquidity not reported|liquidity \$0|AUTHORITY/.test(f)).join("; "));
  } else if (mcap <= 0 || c.priceUsd == null) {
    reasons.push("no reliable mcap/price yet");
  } else if (mcap > MCAP_ENTRY_MAX) {
    verdict = c.score >= 55 ? "WATCH" : "PASS";
    reasons.push(`mcap $${(mcap / 1e6).toFixed(2)}M above 1M entry ceiling — watch for retrace only`);
  } else if (c.score >= 70 && (c.volAccel ?? 0) >= 1.5 && (c.netBuyRatio5m ?? 0) >= 0.58) {
    // WHALE-BLINK FILTER: one hot 5-min window is a single buyer, not a move.
    // ENTER requires sustained flow — at least 2 of the last 3 refreshes with
    // accel >= 1.5 — plus a completed on-chain security check.
    const recent = c.hist.slice(-3);
    const sustained = recent.length >= 2 && recent.filter((h) => (h.volAccel ?? 0) >= 1.5).length >= 2;
    if (!sustained) {
      verdict = "WATCH";
      reasons.push(`score ${c.score}, accel ${c.volAccel?.toFixed(1)}x but not sustained yet (need 2 of last 3 polls) — whale-blink filter`);
    } else if (c.securityCheckedAt == null) {
      verdict = "WATCH";
      reasons.push(`score ${c.score}, flow sustained — held at WATCH pending on-chain security check (mint/freeze/holders)`);
    } else if (c.jupState === "diverge" || c.jupState === "no-reliable-price") {
      verdict = "WATCH";
      reasons.push(`score ${c.score}, flow sustained — held at WATCH: DexScreener price not confirmed by Jupiter (${c.jupState}${c.jupGapPct != null ? ` ${c.jupGapPct}%` : ""})`);
    } else {
      verdict = "ENTER";
      reasons.push(`score ${c.score}, flow sustained ${c.volAccel?.toFixed(1)}x, ${Math.round((c.netBuyRatio5m ?? 0) * 100)}% buys, security checked`);
      reasons.push(c.jupState === "agree" || c.jupState === "watch"
        ? `pool price confirmed by Jupiter (${c.jupGapPct}% gap)`
        : `pool price not cross-checked (Jupiter ${c.jupState})`);
      if (c.top10Pct != null) reasons.push(`top-10 holders ${c.top10Pct}% (${c.top10Method ?? "method unknown"})`);
      if (c.narrativeHits.length) reasons.push(`narrative confirm: ${c.narrativeHits.join(", ")}`);
    }
  } else if (c.score >= 50) {
    verdict = "WATCH";
    reasons.push(`score ${c.score} — setup forming, waiting on flow confirmation`);
  } else {
    reasons.push(`score ${c.score} below 50`);
  }
  c.verdict = verdict;
  c.verdictReasons = reasons;

  // risk params — sized off exit liquidity, never conviction
  if (verdict === "ENTER" || verdict === "WATCH") {
    const maxPos = Math.floor(Math.min(liq * 0.005, 400)); // 0.5% of pool, hard cap
    c.risk = {
      maxPositionUsd: Math.max(0, maxPos),
      suggestedStopPct: -35,
      liquidityExitStopPct: -30,
      targetMcap: TARGET_MCAP,
      targetMultiple: mcap > 0 ? Number((TARGET_MCAP / mcap).toFixed(1)) : null,
      estSlippagePct: liq > 0 ? Number(Math.min(15, (maxPos / liq) * 200).toFixed(1)) : 15,
      holdHorizonHours: 24,
      notes: [
        "size = 0.5% of pool liquidity — the exit is the constraint, not the entry",
        "most signals here still lose; the math needs the 4-5x winners",
        "UNCALIBRATED: tracking mode until at least 50 distinct coins are graded (a minimum sample, not a calibration)",
      ],
    };
  } else {
    c.risk = null;
  }
}

// ─── 4. NARRATIVES — RSS keyword heat ───────────────────────────────────

const RSS_FEEDS = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "TheBlock", url: "https://www.theblock.co/rss.xml" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
];

// Terms worth tracking as narrative heat. Single words only (title matching).
const NARRATIVE_TERMS = [
  "solana", "memecoin", "meme", "dogecoin", "doge", "pepe", "bonk", "wif",
  "trump", "musk", "etf", "ai", "agent", "pump", "pumpfun", "airdrop",
  "cat", "dog", "penguin", "pengu", "rally", "listing", "binance", "coinbase",
];

async function narrativeTick(): Promise<void> {
  // Publisher RSS (titles only), parsed with the shared feed parser so each
  // title has a publish time; only the last 24 h count. A failed feed is
  // "failed", a feed with no recent titles is "empty" (observed zero).
  const feeds = await Promise.all(RSS_FEEDS.map(async (feed) => {
    try {
      const r = await fetch(feed.url, { signal: AbortSignal.timeout(12_000), headers: { "user-agent": "batcave-terminal/1.0" } });
      if (!r.ok) return { name: feed.name, items: null };
      return { name: feed.name, items: parseFeed(await r.text()).slice(0, 80).map((i) => ({ title: i.title, publishedMs: i.publishedMs })) };
    } catch {
      return { name: feed.name, items: null };
    }
  }));
  const now = Date.now();
  const r = narrativeCounts(feeds, NARRATIVE_TERMS, now);
  narrativeSources = r.sources;
  if (r.sources.every((x) => x.state === "failed")) throw new Error("all RSS feeds unreachable");
  narrativeHeat = r.heat;
  narrativeUpdatedAt = now;
}

// ─── GRADER — audit outcomes (tracking mode) ────────────────────────────

// Oldest OPEN rows first: they are the ones due for a verdict. (Newest-first
// with LIMIT 60 starved older rows once more than 60 were open, so they stayed
// OPEN forever and the stats overstated `open`.) A signal past the 72h horizon
// that cannot be priced is NO_DATA: missing, never scored as DEAD or RUGGED.
const GRADE_HORIZON_MS = 72 * 3600_000;
const NO_DATA_AFTER_ERRORS_MS = 7 * 24 * 3600_000; // fetch errors this long after detection → stop retrying

async function graderTick(): Promise<void> {
  const open = sqlite.prepare(
    `SELECT id, pair_address, chain, detected_at, mcap_at_signal, liquidity_at_signal, peak_mcap, peak_at FROM crypto_signals WHERE outcome = 'OPEN' ORDER BY detected_at ASC LIMIT 60`,
  ).all() as any[];
  if (open.length === 0) return;

  const mark = sqlite.prepare(
    `UPDATE crypto_signals SET peak_mcap = ?, peak_at = ?, last_mcap = ?, last_liquidity = ?, outcome = ?, graded_at = ? WHERE id = ?`,
  );
  const markNoData = sqlite.prepare(
    `UPDATE crypto_signals SET outcome = 'NO_DATA', graded_at = ? WHERE id = ? AND outcome = 'OPEN'`,
  );
  const now = Date.now();
  for (const row of open) {
    const key = `${row.chain}:${row.pair_address}`;
    const age = now - Number(row.detected_at);
    let mcap: number | null = null;
    let liq: number | null = null;
    const live = tracked.get(key);
    if (live?.lastRefreshAt && now - live.lastRefreshAt < 10 * 60_000) {
      mcap = live.marketCap; liq = live.liquidityUsd;
    } else {
      try {
        const resp = await getJson(`${DS_BASE}/latest/dex/pairs/${row.chain}/${row.pair_address}`);
        const p = resp?.pairs?.[0] ?? resp?.pair;
        // observed 0 stays 0: a full liquidity pull must grade RUGGED
        mcap = observedNumber(p?.marketCap) ?? observedNumber(p?.fdv);
        liq = observedNumber(p?.liquidity?.usd);
      } catch {
        // transient fetch error: retry next tick, unless it has failed for a week
        if (age > NO_DATA_AFTER_ERRORS_MS) markNoData.run(now, row.id);
        continue;
      }
    }
    // Pure grading rule (cryptoStats.gradeSignal): an observed liquidity pull
    // is RUGGED even without a market cap; no mcap past the horizon is
    // NO_DATA (missing), never DEAD.
    const prevPeak = row.peak_mcap != null ? Number(row.peak_mcap) : null;
    const g = gradeSignal({
      entryMcap: Number(row.mcap_at_signal ?? 0),
      entryLiq: Number(row.liquidity_at_signal ?? 0),
      prevPeak, mcap, liq, ageMs: age,
      targetMcap: TARGET_MCAP, horizonMs: GRADE_HORIZON_MS,
    });
    if (g.outcome === "NO_DATA") { markNoData.run(now, row.id); continue; }
    if (g.outcome === "OPEN" && mcap == null) continue; // nothing new to record
    const peakImproved = g.peak != null && g.peak > (prevPeak ?? 0);
    mark.run(g.peak, peakImproved ? now : row.peak_at ?? null, mcap, liq,
      g.outcome, g.outcome === "OPEN" ? null : now, row.id);
  }
}

// ─── MAJORS — exchange-direct BTC/ETH/SOL ───────────────────────────────

async function majorsTick(): Promise<void> {
  const snap = await readMajors();
  majors = snap;
  if (snap.state === "unavailable") throw new Error("no live exchange quote for BTC/ETH/SOL");
}

/** Crypto source labels for the UI (tier + terms), from the registry. */
function cryptoSourceLabels() {
  return sourceTable().filter((x) => x.area.startsWith("crypto")).map((x) => ({
    id: x.id, name: x.name, tier: x.tier, tierLabel: TIER_LABEL[x.tier], weakReason: x.weakReason ?? null, feeds: x.feeds,
  }));
}

// ─── WATCHDOG ───────────────────────────────────────────────────────────

function watchdogTick(): void {
  const now = Date.now();
  for (const h of health.values()) {
    if (h.name === "watchdog") continue;
    if (h.lastRunAt == null) { h.status = "starting"; continue; }
    const sinceOk = now - (h.lastOkAt ?? 0);
    if (h.lastError && sinceOk > h.cadenceMs * 3) h.status = "error";
    else if (sinceOk > h.cadenceMs * 5) h.status = "stale";
    else if (sinceOk > h.cadenceMs * 2.5) h.status = "late";
    else h.status = "ok";
  }
  const wd = hb("watchdog", WATCHDOG_MS);
  wd.lastRunAt = now; wd.lastOkAt = now; wd.runs++; wd.status = "ok";
}

// ─── Public API ─────────────────────────────────────────────────────────

export function startCryptoEngines(): void {
  if (started) return;
  started = true;
  hb("scanner", SCANNER_MS); hb("momentum", MOMENTUM_MS);
  hb("narratives", NARRATIVE_MS); hb("grader", GRADER_MS);
  hb("security", SECURITY_MS); hb("social", SOCIAL_MS); hb("majors", MAJORS_MS); hb("watchdog", WATCHDOG_MS);

  const arm = (name: string, ms: number, fn: () => Promise<void>, initialDelay: number) => {
    setTimeout(() => {
      void runEngine(name, ms, fn);
      timers.push(setInterval(() => void runEngine(name, ms, fn), ms));
    }, initialDelay);
  };
  arm("scanner", SCANNER_MS, scannerTick, 1_500);
  arm("momentum", MOMENTUM_MS, momentumTick, 8_000);
  arm("narratives", NARRATIVE_MS, narrativeTick, 3_000);
  arm("grader", GRADER_MS, graderTick, 45_000);
  arm("security", SECURITY_MS, securityTick, 20_000);
  arm("social", SOCIAL_MS, socialTick, 30_000);
  arm("majors", MAJORS_MS, majorsTick, 2_500);
  timers.push(setInterval(watchdogTick, WATCHDOG_MS));
  watchdogTick();
  console.log("[crypto] engines started — scanner/momentum/narratives/security/social/grader + watchdog");
}

export function getCryptoFeed(): {
  asOf: number;
  trackedCount: number;
  candidates: Candidate[];
  narrativeHeat: typeof narrativeHeat;
  narrativeUpdatedAt: number | null;
  narrativeSources: typeof narrativeSources;
  majors: MajorsSnapshot | null;
  sourceLabels: ReturnType<typeof cryptoSourceLabels>;
} {
  const list = [...tracked.values()]
    .filter((c) => c.lastRefreshAt != null)
    .sort((a, b) => {
      const rank = (v: Candidate["verdict"]) => (v === "ENTER" ? 0 : v === "WATCH" ? 1 : 2);
      return rank(a.verdict) - rank(b.verdict) || (b.score ?? 0) - (a.score ?? 0);
    })
    .slice(0, 80);
  return {
    asOf: Date.now(),
    trackedCount: tracked.size,
    candidates: list,
    narrativeHeat: narrativeHeat.slice(0, 14),
    narrativeUpdatedAt,
    narrativeSources,
    // null until the first majors read completes (not "no data")
    majors,
    sourceLabels: cryptoSourceLabels(),
  };
}

export function getCryptoHealth(): { engines: EngineHealth[]; trackedCount: number; asOf: number } {
  return { engines: [...health.values()], trackedCount: tracked.size, asOf: Date.now() };
}

export function getCryptoSignals(): {
  signals: any[];
  stats: CryptoDeskStats & { listLimit: number };
} {
  // The list is the latest 100 for display; the stats come from aggregate
  // queries over every logged signal, so total/open/graded share one window.
  // Top-level counts and the sampleReady gate are over DISTINCT COINS (first
  // signal per coin): one coin logs WATCH and ENTER rows on several days,
  // and counting rows overstated the sample. Row counts and first-ENTER-per-
  // coin counts ride along for reference.
  const LIST_LIMIT = 100;
  const signals = sqlite.prepare(
    `SELECT * FROM crypto_signals ORDER BY detected_at DESC LIMIT ?`,
  ).all(LIST_LIMIT) as any[];
  const stats = summarizeDeskStats(
    sqlite.prepare(CRYPTO_SIGNAL_COUNTS_SQL).get() as any,
    sqlite.prepare(cryptoCoinCountsSql()).get() as any,
    sqlite.prepare(cryptoCoinCountsSql("ENTER")).get() as any,
  );
  return {
    signals: signals.map((s) => ({
      ...s,
      features: safeParse(s.features_json),
      risk: safeParse(s.risk_json),
    })),
    stats: { ...stats, listLimit: LIST_LIMIT },
  };
}

function safeParse(s: any): any {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}
