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
//                          = promotion context only; never positive organic evidence).
//   3. RUG FILTER (inline on refresh) — liquidity floor, liq/mcap sanity,
//                          sell-side existence (honeypot proxy), crash filter,
//                          age gates. Hard kills → PASS regardless of score.
//   4. NARRATIVES (5min) — crypto RSS (CoinDesk/TheBlock/Decrypt) keyword heat.
//                          Keyword matches are context only, not verified token news.
//
//   WATCHDOG (30s) — each engine writes a heartbeat; late/stale/error states
//                    are exposed at /api/crypto/health and shown in the UI.
//
// Free public APIs only, no keys: GeckoTerminal (30 rpm), DexScreener (300 rpm
// for pairs, 60 rpm for boosts). Both budgets respected by design (batching).

import { sqlite } from "./storage";
import { cryptoAuditStats } from "./cryptoAuditStats";
import { CRYPTO_RELIABILITY_VERSION, ensureCryptoGradeSchema, finiteNonnegative, gradeCryptoBatch } from "./cryptoReliability";
import { evaluateMemeScore, MEME_SCORE_VERSION, type MemeScoreBreakdown } from "../shared/memeScoring";
import { parseMintEvidence, rawTop10AccountPct, type MintEvidence } from "../shared/cryptoSecurity";
import { getCryptoNews } from "./cryptoContext";
import { summarizeSocialPosts } from "../shared/cryptoDesk";
import type { DeskSource } from "../shared/cryptoDesk";
import { selectMintBatch, unwrapMintBatch, ProviderBackoff, parsePumpCoin,
  createGradeObserver, type CollectorCheck } from "./cryptoCollectors";
import { readSocialTokenEvidence, selectSocialBatch } from "./cryptoSocial";
import type { SocialTokenEvidence } from "../shared/cryptoSocial";

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
  liquidityEvidence: { provider: "DexScreener" | "GeckoTerminal"; fetchedAt: number; pairAddress: string } | null;
  liquidityRepairAt: number | null;
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

  // on-chain security (public Solana RPC — free, no keys)
  mintAuthorityActive: boolean | null;   // null = unchecked
  freezeAuthorityActive: boolean | null;
  top10Pct: number | null;               // legacy field, null until vault identity is verified
  securityCheckedAt: number | null;
  securityAttemptAt: number | null;
  securityEvidence: MintEvidence | null;
  rawTop10Pct: number | null;            // token accounts including unverified pools, NOT owners
  holderCheckedAt: number | null;
  securitySources?: Record<string, CollectorCheck>;

  // rugcheck.xyz cached report (keyless)
  rcRisks: string[];
  rcLpLockedPct: number | null;
  rcCheckedAt: number | null;

  // social velocity (bluesky keyless search + pump.fun coin object)
  bskyMentions1h: number | null;
  bskyMentions10m: number | null;
  pumpReplies: number | null;
  pumpReplyPerHr: number | null;   // measured between polls
  pumpLive: boolean;               // livestream running = raw attention
  hasSocialLinks: boolean | null;  // twitter/telegram/website on the token
  socialScore: number | null;      // 0-100
  socialCheckedAt: number | null;
  socialAttemptAt: number | null;
  socialCoverage: "pending" | "ok" | "partial" | "unavailable" | "stale";
  socialEvidence: ReturnType<typeof summarizeSocialPosts> | null;
  socialDetail?: SocialTokenEvidence | null;
  prevPumpReplies: { count: number; t: number } | null;
  socialSources?: Record<string, CollectorCheck>;

  // rolling history for sustained-flow gating (whale-blink filter)
  hist: Array<{ t: number; volAccel: number | null; netBuyRatio5m: number | null; mcap: number | null }>;

  // derived
  ageMinutes: number | null;
  volAccel: number | null;        // m5 volume annualized vs h1 baseline
  netBuyRatio5m: number | null;   // buys/(buys+sells)
  fomoScore: number | null;       // legacy API name: pure flow pace/buy-count proxy, no social blend
  memeScore: number | null;       // 0-100
  scoreBreakdown: MemeScoreBreakdown | null;
  narrativeHits: string[];
  rugFlags: string[];
  hardKill: boolean;
  score: number | null;           // provisional research points, budget 70; not comparable to legacy 100
  verdict: "ENTER" | "WATCH" | "PASS" | null;
  verdictReasons: string[];
  risk: RiskParams | null;
}

export interface RiskParams {
  maxPositionUsd: number;      // illustrative liquidity cap, NOT verified executable size
  suggestedStopPct: number;    // fixed research scenario, not an executable stop
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
  status: "ok" | "idle" | "late" | "stale" | "error" | "starting" | "degraded";
  running?: boolean;
  skippedOverlaps?: number;
  degraded?: boolean;
  idle?: boolean;
  coverage?: { attempted: number; usable: number; pending: number; checkedAt: number; issues: string[] };
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
const WATCHDOG_MS = 30_000;
const GRADER_MS = 10 * 60_000;

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const DS_BASE = "https://api.dexscreener.com";

// Descriptive name lexicon retained for context only. No validated predictive
// evidence and no contribution to the research ranking.
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
const providerChecks = new Map<string, CollectorCheck>();
let narrativeHeat: Array<{ term: string; hits: number; sources: string[] }> = [];
let narrativeUpdatedAt: number | null = null;
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
  if (h.running) { h.skippedOverlaps=(h.skippedOverlaps??0)+1; return; }
  h.running=true;
  h.degraded=false;
  h.idle=false;
  h.lastRunAt = Date.now();
  h.runs++;
  try {
    await fn();
    h.lastOkAt = Date.now();
    h.lastError = null;
    h.status = h.degraded ? "degraded" : h.idle ? "idle" : "ok";
  } catch (e: any) {
    h.errors++;
    h.lastError = String(e?.message ?? e).slice(0, 300);
    h.status = "error";
    console.warn(`[crypto:${name}] ${h.lastError}`);
  } finally {
    h.running=false;
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
    outcome TEXT,           -- OPEN | HIT_5M | DOUBLED | RUGGED | DEAD
    graded_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_crypto_signals_outcome ON crypto_signals(outcome);
`);
ensureCryptoGradeSchema(sqlite);
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
        scoreVersion: MEME_SCORE_VERSION, scoreBreakdown: c.scoreBreakdown,
        scoreInputs: { vol5m: c.vol5m, vol1h: c.vol1h, buys5m: c.buys5m, sells5m: c.sells5m,
          lastRefreshAt: c.lastRefreshAt, socialScore: c.socialScore, socialCheckedAt: c.socialCheckedAt,
          socialCoverage: c.socialCoverage, hardKill: c.hardKill, riskFlagCount: c.rugFlags.length },
        volAccel: c.volAccel, netBuyRatio5m: c.netBuyRatio5m, fomo: c.fomoScore,
        meme: c.memeScore, narrativeHits: c.narrativeHits, rugFlags: c.rugFlags,
        boosted: c.boosted, pumpfunGraduate: c.pumpfunGraduate,
        liquidityEvidence: c.liquidityEvidence,
        ageMinutes: c.ageMinutes, reasons: c.verdictReasons,
        mintAuthorityActive: c.mintAuthorityActive, freezeAuthorityActive: c.freezeAuthorityActive,
        top10Pct: c.top10Pct, securityCheckedAt: c.securityCheckedAt,
        securityEvidence: c.securityEvidence, rawTop10Pct: c.rawTop10Pct, holderCheckedAt: c.holderCheckedAt,
        rcRisks: c.rcRisks, rcLpLockedPct: c.rcLpLockedPct,
        socialScore: c.socialScore, bskyMentions1h: c.bskyMentions1h,
        socialCoverage: c.socialCoverage, socialCheckedAt: c.socialCheckedAt,
        socialEvidence: c.socialEvidence,
        socialDetail: c.socialDetail,
        securitySources: c.securitySources, socialSources: c.socialSources,
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
    liquidityEvidence: null, liquidityRepairAt: null,
    vol5m: null, vol1h: null, vol24h: null,
    buys5m: null, sells5m: null, buys1h: null, sells1h: null,
    chg5m: null, chg1h: null, chg24h: null,
    boosted: false, lastRefreshAt: null,
    mintAuthorityActive: null, freezeAuthorityActive: null, top10Pct: null, securityCheckedAt: null,
    securityAttemptAt: null, securityEvidence: null, rawTop10Pct: null, holderCheckedAt: null,
    rcRisks: [], rcLpLockedPct: null, rcCheckedAt: null,
    bskyMentions1h: null, bskyMentions10m: null, pumpReplies: null, pumpReplyPerHr: null,
    pumpLive: false, hasSocialLinks: null, socialScore: null, socialCheckedAt: null,
    socialAttemptAt: null, socialCoverage: "pending", socialEvidence: null, prevPumpReplies: null,
    hist: [],
    ageMinutes: null, volAccel: null, netBuyRatio5m: null,
    fomoScore: null, memeScore: null, scoreBreakdown: null, narrativeHits: [], rugFlags: [],
    hardKill: false, score: null, verdict: null, verdictReasons: [], risk: null,
  };
  // GT gives a coarse first look — momentum engine refines with DexScreener.
  if (c.lastRefreshAt == null) c.marketCap = finiteNonnegative(attrs.market_cap_usd); // FDV is not circulating market cap.
  c.fdv = Number.isFinite(fdv) ? fdv : c.fdv;
  if (c.lastRefreshAt == null) c.priceUsd = finiteNonnegative(attrs.base_token_price_usd);
  const reserve = finiteNonnegative(attrs.reserve_in_usd);
  if (reserve != null) {
    c.liquidityUsd = reserve;
    c.liquidityEvidence = { provider: "GeckoTerminal", fetchedAt: Date.now(), pairAddress };
  }
  if (!existing) tracked.set(key, c);
}

const discoverySources = {
  new_pools: { lastAttemptAt: null as number|null, lastOkAt: null as number|null, error: null as string|null, count: 0 },
  trending: { lastAttemptAt: null as number|null, lastOkAt: null as number|null, error: null as string|null, count: 0 },
};

async function scanSource(kind: keyof typeof discoverySources, url: string) {
  const state=discoverySources[kind];
  state.lastAttemptAt=Date.now();
  try {
    const response=await getJson(url);
    if (!Array.isArray(response?.data)) throw Error("Malformed pool response");
    state.count=response.data.length; state.lastOkAt=Date.now(); state.error=null;
    for (const pool of response.data) upsertFromGtPool(pool,kind);
  } catch (e:any) {
    state.error=String(e?.message??"Discovery unavailable").slice(0,200);
    throw e;
  }
}

async function scannerTick(): Promise<void> {
  // 2 GT calls per tick (well under 30 rpm)
  const [fresh, trending] = await Promise.allSettled([
    scanSource("new_pools", `${GT_BASE}/networks/solana/new_pools?page=1`),
    scanSource("trending", `${GT_BASE}/networks/solana/trending_pools?page=1`),
  ]);
  hb("scanner",SCANNER_MS).degraded = fresh.status==="rejected" || trending.status==="rejected";
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
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    let resp: any;
    try {
      resp = await getJson(`${DS_BASE}/latest/dex/tokens/${chunk.join(",")}`);
    } catch (e: any) {
      throw new Error(`dexscreener batch failed: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    const pairs: any[] = resp?.pairs ?? [];
    for (const p of pairs) {
      const key = `${String(p?.chainId ?? "solana")}:${String(p?.pairAddress ?? "")}`;
      const c = tracked.get(key);
      if (!c) continue;
      c.symbol = String(p?.baseToken?.symbol ?? c.symbol);
      c.name = String(p?.baseToken?.name ?? c.name);
      c.priceUsd = finiteNonnegative(p?.priceUsd);
      c.marketCap = finiteNonnegative(p?.marketCap);
      c.fdv = finiteNonnegative(p?.fdv);
      const liquidity = finiteNonnegative(p?.liquidity?.usd);
      if (liquidity != null) {
        c.liquidityUsd = liquidity;
        c.liquidityEvidence = { provider: "DexScreener", fetchedAt: Date.now(), pairAddress: c.pairAddress };
      } else if (!c.liquidityEvidence || Date.now() - c.liquidityEvidence.fetchedAt > 5 * 60_000) {
        c.liquidityUsd = null; c.liquidityEvidence = null;
      }
      c.vol5m = finiteNonnegative(p?.volume?.m5);
      c.vol1h = finiteNonnegative(p?.volume?.h1);
      c.vol24h = finiteNonnegative(p?.volume?.h24);
      c.buys5m = finiteNonnegative(p?.txns?.m5?.buys);
      c.sells5m = finiteNonnegative(p?.txns?.m5?.sells);
      c.buys1h = finiteNonnegative(p?.txns?.h1?.buys);
      c.sells1h = finiteNonnegative(p?.txns?.h1?.sells);
      c.chg5m = Number(p?.priceChange?.m5 ?? NaN);
      c.chg1h = Number(p?.priceChange?.h1 ?? NaN);
      c.chg24h = Number(p?.priceChange?.h24 ?? NaN);
      if (Number.isNaN(c.chg5m)) c.chg5m = null;
      if (Number.isNaN(c.chg1h)) c.chg1h = null;
      if (Number.isNaN(c.chg24h)) c.chg24h = null;
      if (p?.pairCreatedAt) c.pairCreatedAt = Number(p.pairCreatedAt);
      c.boosted = boostedTokens.has(c.tokenAddress.toLowerCase());
      c.lastRefreshAt = Date.now();
      scoreCandidate(c);
      // history AFTER scoring so volAccel/netBuyRatio are fresh; cap 20 readings
      c.hist.push({ t: c.lastRefreshAt, volAccel: c.volAccel, netBuyRatio5m: c.netBuyRatio5m, mcap: c.marketCap });
      if (c.hist.length > 20) c.hist.shift();
      persistSignal(c);
    }
  }
  // Repair a bounded oldest-attempt batch by exact chain + pool identity.
  // Missing Dex liquidity is common for launchpad pools; reserve is not exit depth.
  const repair = [...tracked.values()].filter(c => c.chain === "solana" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.pairAddress) &&
    (c.liquidityUsd == null || c.liquidityEvidence?.provider === "GeckoTerminal") &&
    (c.liquidityRepairAt == null || Date.now() - c.liquidityRepairAt >= 180000))
    .sort((a, b) => (a.liquidityRepairAt ?? 0) - (b.liquidityRepairAt ?? 0)).slice(0, 60);
  if (repair.length) {
    const attemptedAt = Date.now(); for (const c of repair) c.liquidityRepairAt = attemptedAt;
    for (let offset = 0; offset < repair.length; offset += 20) {
     const chunk = repair.slice(offset, offset + 20);
     try {
      const result = await getJson(`${GT_BASE}/networks/solana/pools/multi/${chunk.map(c => c.pairAddress).join(",")}`);
      if (!Array.isArray(result?.data)) throw new Error("Invalid pool repair payload");
      for (const pool of result.data) {
        const address = pool?.attributes?.address;
        const c = chunk.find(x => x.pairAddress === address && pool?.id === `solana_${address}`);
        const reserve = finiteNonnegative(pool?.attributes?.reserve_in_usd);
        if (!c || reserve == null) continue;
        c.liquidityUsd = reserve;
        c.liquidityEvidence = { provider: "GeckoTerminal", fetchedAt: Date.now(), pairAddress: address };
        scoreCandidate(c); persistSignal(c);
      }
     } catch { hb("momentum", MOMENTUM_MS).degraded = true; break; }
    }
  }
}

// ─── 2b. SECURITY — public Solana RPC on-chain checks ───────────────────
//
// Supported SPL plus immutable, self-referenced Token-2022 metadata subset.
// Unsupported programs and incomplete fields remain unknown and block WATCH.
// Largest-account concentration includes every returned account. It is NOT
// beneficial-owner concentration and is not scored; vault identity is unverified.
// Budget: one batch of eight unique mints per 45s tick, refreshed after 15 minutes,
// with indexed-method cooldown on throttling. Public RPC availability is variable.

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
const rpcBackoffs = new Map<string, ProviderBackoff>();

async function solRpc(method: string, params: any[], urls: string[]): Promise<any> {
  let lastErr: any = null;
  for (const url of urls) {
    const key = `${url}:${method}`;
    const backoff = rpcBackoffs.get(key) ?? new ProviderBackoff();
    rpcBackoffs.set(key, backoff);
    if (!backoff.available(Date.now())) { lastErr = new Error("RPC method in retry cooldown"); continue; }
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
      backoff.success();
      return j.result;
    } catch (e: any) {
      lastErr = e;
      backoff.failure(e, Date.now());
      await sleep(400);
      continue;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr ?? new Error("all solana rpcs failed");
}

async function securityTick(): Promise<void> {
  const now = Date.now();
  const eligible = [...tracked.values()].filter(c => c.chain === "solana" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.tokenAddress) && (c.liquidityUsd ?? 0) >= LIQ_FLOOR_USD);
  const due = selectMintBatch(eligible.filter(c => c.securityAttemptAt == null || now - c.securityAttemptAt > 15 * 60_000));
  const updateCoverage = () => {
    const incomplete = eligible.filter(c => c.securityEvidence?.state !== "CHECKED" ||
      c.securityCheckedAt == null || now - c.securityCheckedAt > 30 * 60_000);
    const h = hb("security", SECURITY_MS);
    h.degraded = incomplete.length > 0;
    h.coverage = { attempted: due.length, usable: eligible.length - incomplete.length, pending: incomplete.length,
      checkedAt: Date.now(), issues: [...new Set(incomplete.map(c => c.securityEvidence?.reason ??
        "Mint check pending or RPC unavailable"))].slice(0, 3) };
  };
  if (!due.length) { hb("security", SECURITY_MS).idle = true; updateCoverage(); return; }
  // One ordered RPC response binds each result to its requested mint.
  const mints = due.map(c => c.tokenAddress);
  const affected = eligible.filter(c => mints.includes(c.tokenAddress));
  for (const c of affected) c.securityAttemptAt = now;
  let accounts;
  try {
    accounts = unwrapMintBatch(await solRpc("getMultipleAccounts",
      [mints, { encoding: "jsonParsed", commitment: "confirmed" }], RPC_ACCOUNT), mints);
    providerChecks.set("solana", { state: "ok", checkedAt: Date.now(), reason: "Ordered mint batch received; parser coverage is reported separately." });
  } catch (e) {
    const check: CollectorCheck = { state: "unavailable", checkedAt: Date.now(), reason: "Mint batch unavailable or malformed; authority fields withheld." };
    providerChecks.set("solana", check);
    for (const c of affected) {
      c.securityEvidence = null; c.securityCheckedAt = null;
      c.mintAuthorityActive = null; c.freezeAuthorityActive = null;
      c.securitySources = { rpc: check }; scoreCandidate(c);
    }
    updateCoverage(); throw e;
  }
  let concentrationDone = false, rugcheckDone = false;
  for (const {mint, account} of accounts) {
    const c = due.find(c => c.tokenAddress === mint)!;
    c.top10Pct = null; // Never infer an AMM vault from account rank.
    c.rawTop10Pct = null; c.holderCheckedAt = null;
      c.securityEvidence = parseMintEvidence(account, mint);
      c.mintAuthorityActive = c.securityEvidence.mintAuthorityActive;
      c.freezeAuthorityActive = c.securityEvidence.freezeAuthorityActive;
      const supply = c.securityEvidence.supplyRaw;
      c.securitySources = { rpc: { state: c.securityEvidence.state === "CHECKED" ? "ok" : "partial",
        checkedAt: Date.now(), reason: c.securityEvidence.reason } };

      // BEST-EFFORT: holder concentration (indexed — mainnet-beta only, gentle)
      if (!concentrationDone && supply != null && BigInt(supply) > 0n && Date.now() > indexedCooldownUntil) {
        concentrationDone = true;
        try {
          await sleep(800);
          const largest = await solRpc("getTokenLargestAccounts", [c.tokenAddress, { commitment: "confirmed" }], RPC_INDEXED);
          const accts: any[] = largest?.value ?? [];
          c.rawTop10Pct = rawTop10AccountPct(accts, supply);
          c.holderCheckedAt = c.rawTop10Pct != null ? Date.now() : null;
        } catch (e: any) {
          if (/429/.test(String(e?.message))) indexedCooldownUntil = Date.now() + 5 * 60_000;
          c.securitySources.holders = { state: "unavailable", checkedAt: Date.now(), reason: "Indexed account coverage unavailable; no owner-concentration conclusion." };
        }
      }

      // ── rugcheck.xyz cached summary (keyless, verified) — LP lock + named risks ──
      if (!rugcheckDone && (c.rcCheckedAt == null || now - c.rcCheckedAt > 15 * 60_000)) {
        rugcheckDone = true;
        try {
          const rc = await getJson(`https://api.rugcheck.xyz/v1/tokens/${c.tokenAddress}/report/summary`);
          if (!Array.isArray(rc?.risks)) throw new Error("Rugcheck risk list missing");
          const risks: any[] = rc.risks;
          c.rcRisks = risks.map((r) => String(r?.name ?? r)).filter(Boolean).slice(0, 6);
          const lp = Number(rc?.lpLockedPct ?? NaN);
          c.rcLpLockedPct = Number.isFinite(lp) && lp >= 0 && lp <= 100 ? Number(lp.toFixed(1)) : null;
          c.rcCheckedAt = Date.now();
          providerChecks.set("rugcheck", { state: "ok", checkedAt: Date.now(), reason: "Supplementary cached risk list received; not a complete safety audit." });
        } catch {
          c.rcRisks = []; c.rcLpLockedPct = null; c.rcCheckedAt = null;
          providerChecks.set("rugcheck", { state: "unavailable", checkedAt: Date.now(), reason: "Supplementary risk report unavailable." });
        }
      }

      c.securityCheckedAt = providerChecks.get("solana")!.checkedAt;
      // Pools of the same mint share the same mint-level evidence, not prices.
      for (const other of affected.filter(p => p.tokenAddress === mint)) {
        Object.assign(other, { securityEvidence: c.securityEvidence, securityCheckedAt: c.securityCheckedAt,
          mintAuthorityActive: c.mintAuthorityActive, freezeAuthorityActive: c.freezeAuthorityActive,
          securitySources: c.securitySources, rawTop10Pct: c.rawTop10Pct, holderCheckedAt: c.holderCheckedAt,
          top10Pct: null, rcRisks: c.rcRisks, rcLpLockedPct: c.rcLpLockedPct, rcCheckedAt: c.rcCheckedAt });
        scoreCandidate(other); persistSignal(other);
      }
  }
  updateCoverage();
}

// ─── 2c. SOCIAL EVIDENCE — bounded public-source samples ──────────────
//
// Public-source coverage is probed at runtime, never assumed from old tests.
// Bounded sampled sources, not validated early-warning predictors:
//   - Bluesky public search: separate contract and ticker-only last-hour samples.
//   - pump.fun /coins/{mint} — reply_count (velocity between polls),
//     livestream flag, twitter/telegram/website links.
// No new Reddit/X account access is configured; neither is polled here.

const SOCIAL_MS = 90_000;
const PUMP = "https://frontend-api-v3.pump.fun";
const pumpBackoff = new ProviderBackoff();
const blueskyBackoff = new ProviderBackoff();

async function socialTick(): Promise<void> {
  // Four unique mints per tick, priority plus fair coverage. ENTER stays disabled.
  // Two requests per mint maximum; one contract query plus optional ticker query.
  const now = Date.now();
  const deadline = now + 25_000;
  const due = selectSocialBatch([...tracked.values()], now, MCAP_CEILING * 2);
  if (due.length === 0) {
    hb("social", SOCIAL_MS).idle = true;
    const stale = [...tracked.values()].filter(c => c.socialAttemptAt != null &&
      (c.socialCoverage !== "ok" || c.socialCheckedAt == null || now - c.socialCheckedAt > 600000));
    hb("social", SOCIAL_MS).degraded = stale.length > 0;
    hb("social", SOCIAL_MS).coverage = { attempted: 0, usable: 0, pending: stale.length, checkedAt: now,
      issues: stale.length ? ["No currently due priority candidate; previous missing/stale coverage remains unresolved."]
        : ["No eligible research candidate due; idle is not a provider-health confirmation."] };
    return;
  }

  let okCount = 0;
  let attempted = 0;
  let lastErr: any = null;
  for (const c of due) {
    if (Date.now() >= deadline) break;
    try {
      attempted++;
      c.socialAttemptAt = now;
      // Do not carry a previous successful count across a failed refresh.
      c.bskyMentions1h = null; c.bskyMentions10m = null;
      c.socialEvidence = null;
      c.socialDetail = null; c.socialScore = null; c.socialCheckedAt = null; c.socialCoverage = "unavailable";
      c.pumpReplies = null; c.pumpReplyPerHr = null;
      c.pumpLive = false; c.hasSocialLinks = null;
      c.socialSources = {};
      let successes = 0;
      let eligible = 0;
      // ── exact-contract evidence; ticker-only mentions are never scored ──
      eligible++;
      const bskyCooldown = blueskyBackoff.snapshot(now);
      if (bskyCooldown) c.socialSources.bluesky = bskyCooldown;
      else {
        try {
          c.socialDetail = await readSocialTokenEvidence(c.symbol, c.tokenAddress, now, async url => {
            const pause = blueskyBackoff.snapshot(Date.now());
            if (pause) throw new Error("Provider cooldown");
            if (Date.now() >= deadline) throw new Error("Social batch deadline");
            try {
              const data = await getJson(url, Math.min(8000, deadline - Date.now()));
              blueskyBackoff.success(); return data;
            } catch (e) { blueskyBackoff.failure(e, Date.now()); throw e; }
          });
          c.socialEvidence = c.socialDetail.contract;
          c.bskyMentions1h = c.socialEvidence.mentions1h;
          c.bskyMentions10m = c.socialEvidence.mentions10m;
          const pause = blueskyBackoff.snapshot(Date.now());
          c.socialSources.bluesky = { state: c.socialDetail.queryGap || c.socialDetail.ticker?.capped ||
            c.socialDetail.ticker?.timestampsComplete === false || c.socialEvidence.capped || !c.socialEvidence.timestampsComplete ? "partial" : "ok",
            checkedAt: Date.now(), retryAt: pause?.retryAt,
            reason: "Exact-contract sample; ticker-only chatter kept separate. Two bounded one-hour queries, not exhaustive or organic-attention proof." +
              (pause ? ` ${pause.reason}` : "") };
          successes++;
        } catch (e) { c.socialSources.bluesky = blueskyBackoff.snapshot(Date.now()) ?? blueskyBackoff.failure(e, Date.now()); }
      }
      providerChecks.set("bluesky", c.socialSources.bluesky);

      // ── pump.fun coin object (only for pump ecosystem tokens) ──
      if (c.tokenAddress.endsWith("pump") || c.pumpfunGraduate) {
        eligible++;
        const pumpCooldown = pumpBackoff.snapshot(now);
        if (pumpCooldown) c.socialSources.pumpfun = pumpCooldown;
        else {
        try {
          if (Date.now() >= deadline) throw new Error("Social batch deadline");
          const coin = parsePumpCoin(await getJson(`${PUMP}/coins/${c.tokenAddress}`, Math.min(8000, deadline - Date.now())), c.tokenAddress);
          const replies = coin.replies;
            if (c.prevPumpReplies && now > c.prevPumpReplies.t) {
              const hrs = (now - c.prevPumpReplies.t) / 3600_000;
              if (hrs > 0.02 && hrs <= 1 / 6 && replies >= c.prevPumpReplies.count)
                c.pumpReplyPerHr = Number(((replies - c.prevPumpReplies.count) / hrs).toFixed(1));
            }
            c.prevPumpReplies = { count: replies, t: now };
            c.pumpReplies = replies;
          c.pumpLive = coin.live;
          c.hasSocialLinks = coin.links;
          c.socialSources.pumpfun = { state: "ok", checkedAt: Date.now(), reason: "Exact mint reply counter received; not unique buyers or organic demand." };
          pumpBackoff.success();
          successes++;
        } catch (e) {
          c.prevPumpReplies = null;
          c.socialSources.pumpfun = pumpBackoff.failure(e, Date.now());
        }
        }
        providerChecks.set("pumpfun", c.socialSources.pumpfun);
      } else {
        c.socialSources.pumpfun = { state: "not_applicable", checkedAt: now, reason: "Not identified as a pump ecosystem mint." };
      }

      // ── social score 0-100 ──
      let s = 0;
      s += Math.min(35, (c.socialEvidence?.uniqueAuthors10m ?? 0) * 12);
      s += Math.min(20, (c.socialEvidence?.uniqueAuthors1h ?? 0) * 2.5);
      s += Math.min(30, Math.max(0, (c.pumpReplyPerHr ?? 0)) * 0.75); // 40 replies/hr = max
      // Links and livestream flags are descriptive, not proof of demand.
      c.socialScore = successes > 0 ? Math.round(Math.min(100, s)) : null;
      c.socialCheckedAt = successes > 0 ? now : null;
      c.socialCoverage = successes === 0 ? "unavailable" : successes === eligible ? "ok" : "partial";
      if (c.socialDetail?.queryGap || c.socialSources.bluesky.state === "partial") c.socialCoverage = "partial";
      if (c.socialCoverage!=="ok") hb("social",SOCIAL_MS).degraded=true;
      if (successes > 0) okCount++;
      else lastErr = new Error("no usable social source response");
      scoreCandidate(c);
      persistSignal(c);
      // Social identity is mint-level, not pool-level. Share the explicit query
      // label too, rather than counting requests/posts once per liquidity pool.
      for (const other of tracked.values()) if (other !== c && other.tokenAddress === c.tokenAddress) {
        for (const key of ["socialDetail", "socialEvidence", "socialScore", "socialCoverage", "socialCheckedAt",
          "socialAttemptAt", "socialSources", "bskyMentions1h", "bskyMentions10m", "pumpReplies",
          "pumpReplyPerHr", "pumpLive", "hasSocialLinks", "prevPumpReplies"] as const) {
          (other as any)[key] = c[key];
        }
        scoreCandidate(other);
      }
    } catch (e: any) {
      lastErr = e;
    }
  }
  const gaps = due.filter(c => c.socialCoverage !== "ok");
  if (attempted < due.length) hb("social", SOCIAL_MS).degraded = true;
  hb("social", SOCIAL_MS).coverage = { attempted, usable: okCount, pending: gaps.length,
    checkedAt: Date.now(), issues: [...new Set(gaps.flatMap(c => Object.values(c.socialSources ?? {})
      .filter(s => !["ok", "not_applicable"].includes(s.state)).map(s => s.reason))
      .concat(attempted < due.length ? ["Batch deadline reached; remaining mints stay eligible for the next fair pass."] : []))].slice(0, 3) };
  if (okCount === 0 && lastErr) {
    throw new Error(`social sources failing: ${String(lastErr?.message ?? lastErr).slice(0, 100)}`);
  }
}

// ─── 3. RUG FILTER + scoring ────────────────────────────────────────────

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
  if (c.rcCheckedAt == null || c.rcCheckedAt > now || now - c.rcCheckedAt > 15 * 60_000) {
    c.rcRisks = []; c.rcLpLockedPct = null;
  }
  if (c.socialCheckedAt != null && now - c.socialCheckedAt > 10 * 60_000) {
    c.socialScore = null;
    c.socialCoverage = "stale";
    c.bskyMentions1h = null; c.bskyMentions10m = null;
    c.pumpReplyPerHr = null; c.pumpLive = false;
  }
  c.ageMinutes = c.pairCreatedAt ? Math.max(0, (now - c.pairCreatedAt) / 60_000) : null;

  // meme score
  const meme = scoreMeme(c.name, c.symbol);
  c.memeScore = meme.score;

  // Unverified keyword context only. No score contribution or confirmation claim.
  c.narrativeHits = (narrativeUpdatedAt != null && now - narrativeUpdatedAt <= 15 * 60_000 ? narrativeHeat : [])
    .filter((n) => n.hits >= 2)
    .filter((n) => new RegExp(`\\b${n.term}\\b`, "i").test(`${c.name} ${c.symbol}`))
    .map((n) => n.term);

  // rug filter
  const flags: string[] = [];
  let hardKill = false;
  if (!c.liquidityEvidence || now - c.liquidityEvidence.fetchedAt > 5 * 60_000 || c.liquidityEvidence.fetchedAt > now) c.liquidityUsd = null;
  const liq = c.liquidityUsd ?? 0;
  const mcap = c.marketCap ?? 0; // Never silently promote FDV to market cap.
  if (c.liquidityUsd != null && liq < LIQ_FLOOR_USD) { flags.push(`liquidity $${(liq / 1000).toFixed(1)}k < $${LIQ_FLOOR_USD / 1000}k research floor`); hardKill = true; }
  if (c.liquidityUsd == null) flags.push("liquidity evidence unavailable or stale; not observed zero");
  if (mcap > 0 && liq > 0 && liq / mcap < 0.03) { flags.push(`liq/mcap ${(100 * liq / mcap).toFixed(1)}% < 3% — exit door too small`); hardKill = true; }
  if (mcap > 0 && liq > mcap * 2) flags.push("liquidity >> mcap — weird pool, likely mispriced data");
  if ((c.buys1h ?? 0) >= 25 && c.sells1h === 0) { flags.push("buys but ZERO observed sells in 1h — honeypot proxy, not proof"); hardKill = true; }
  if ((c.chg1h ?? 0) < -55) { flags.push(`price ${c.chg1h?.toFixed(0)}% in 1h — mid-rug or post-dump`); hardKill = true; }
  if ((c.ageMinutes ?? 1e9) < 10) flags.push("under 10 min old — sniper zone, spreads brutal");
  if (c.boosted) flags.push("paid DexScreener boost: promotion risk, no positive attention points");
  if (c.vol24h != null && c.vol24h < 1000 && (c.ageMinutes ?? 0) > 720) flags.push("aged pool with low observed volume");
  // on-chain security facts (public RPC)
  if (c.mintAuthorityActive === true) { flags.push("MINT AUTHORITY ACTIVE — dev can print supply into your bid"); hardKill = true; }
  if (c.freezeAuthorityActive === true) { flags.push("FREEZE AUTHORITY ACTIVE — dev can lock your tokens"); hardKill = true; }
  // Raw concentration includes vaults and is not verified owner concentration.
  // rugcheck cached report — LP lock + named risks (non-fatal: cached data)
  if (c.rcLpLockedPct != null && c.rcLpLockedPct < 50) flags.push(`LP only ${c.rcLpLockedPct}% locked (rugcheck) — pull risk`);
  for (const r of c.rcRisks) flags.push(`rugcheck: ${r}`);
  c.rugFlags = flags;
  c.hardKill = hardKill;

  c.scoreBreakdown = evaluateMemeScore({ ...c, riskFlagCount: flags.length }, now);
  c.volAccel = c.scoreBreakdown.volAccel;
  c.netBuyRatio5m = c.scoreBreakdown.netBuyRatio5m;
  c.fomoScore = c.scoreBreakdown.flowScore;
  c.score = c.scoreBreakdown.score;

  // verdict
  const reasons: string[] = [];
  let verdict: Candidate["verdict"] = "PASS";
  if (c.scoreBreakdown.inputStatus.market !== "fresh") {
    reasons.push("market observation missing, future-dated or older than five minutes");
  } else if (c.liquidityUsd == null) {
    reasons.push("liquidity evidence missing or stale; reserve coverage required before research qualification");
  } else if (hardKill) {
    reasons.push("hard kill: " + flags.filter((f) => /floor|honeypot|mid-rug|exit door|AUTHORITY ACTIVE/.test(f)).join("; "));
  } else if (!Number.isFinite(mcap) || mcap <= 0 || c.priceUsd == null || !Number.isFinite(c.priceUsd) || c.priceUsd <= 0) {
    reasons.push("no reliable mcap/price yet");
  } else if (c.score == null) {
    reasons.push("flow inputs missing, inconsistent or without a usable volume/trade baseline");
  } else if (c.securityEvidence?.state !== "CHECKED" || c.securityCheckedAt == null ||
      now - c.securityCheckedAt > 30 * 60_000 || c.securityCheckedAt > now) {
    reasons.push("authority checks incomplete, stale or unsupported; no research shortlist qualification");
  } else if (mcap > MCAP_ENTRY_MAX) {
    verdict = c.score >= 55 ? "WATCH" : "PASS";
    reasons.push(`mcap $${(mcap / 1e6).toFixed(2)}M above 1M entry ceiling — watch for retrace only`);
  } else if (c.score >= 50) {
    verdict = "WATCH";
    reasons.push(`${c.score}/70 provisional research points; ENTER disabled pending new-version validation`);
  } else {
    reasons.push(`score ${c.score} below 50`);
  }
  if (verdict === "WATCH") {
    if (c.mintAuthorityActive == null || c.freezeAuthorityActive == null || c.securityCheckedAt == null) {
      reasons.push("authority checks incomplete; WATCH is an observation list, not permission to trade");
    }
    if (c.scoreBreakdown.inputStatus.social !== "sampled") reasons.push("social input missing/partial/stale; no social points or reweighting");
    reasons.push("holder vault identity and executable exits remain unverified");
  }
  c.verdict = verdict;
  c.verdictReasons = reasons;

  // Existing research scenarios, not calculated price targets or executable sizing.
  if (verdict === "WATCH") {
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
        "ILLUSTRATIVE ONLY: 0.5% of reported pool liquidity capped at $400; not a verified executable size",
        "Fixed -35% stop / -30% liquidity-drop scenarios and $5M market-cap milestone, not calculated trade levels",
        "Slippage is a pool-size proxy, not a route quote. Stops and exits are not guaranteed",
        "UNCALIBRATED: sample size alone never authorizes staking; independent outcome and execution validation required",
      ],
    };
  } else {
    c.risk = null;
  }
}

// ─── 4. NARRATIVES — RSS keyword heat ───────────────────────────────────

// Terms worth tracking as narrative heat. Single words only (title matching).
const NARRATIVE_TERMS = [
  "solana", "memecoin", "meme", "dogecoin", "doge", "pepe", "bonk", "wif",
  "trump", "musk", "etf", "ai", "agent", "pump", "pumpfun", "airdrop",
  "cat", "dog", "penguin", "pengu", "rally", "listing", "binance", "coinbase",
];

async function narrativeTick(): Promise<void> {
  const counts = new Map<string, { hits: number; sources: Set<string> }>();
  const news = await getCryptoNews();
  const cryptoSources = news.sources.filter(s => s.role === "crypto headlines");
  if (!cryptoSources.some(s => s.state === "HEALTHY" || s.state === "PARTIAL")) throw new Error("No current usable crypto RSS feeds");
  hb("narratives", NARRATIVE_MS).degraded = cryptoSources.some(s => s.state !== "HEALTHY");
  for (const row of news.rows.filter(r => r.group === "crypto" && r.publishedAt != null &&
      Date.now() - r.publishedAt <= 3 * 86400_000)) {
    for (const term of NARRATIVE_TERMS) {
      if (new RegExp(`\\b${term}\\b`, "i").test(row.title)) {
        const e = counts.get(term) ?? { hits: 0, sources: new Set<string>() };
        e.hits++; e.sources.add(row.publisher); counts.set(term, e);
      }
    }
  }
  narrativeHeat = [...counts.entries()]
    .map(([term, v]) => ({ term, hits: v.hits, sources: [...v.sources] }))
    .sort((a, b) => b.hits - a.hits);
  narrativeUpdatedAt = Date.now();
}

// ─── GRADER — audit outcomes (tracking mode) ────────────────────────────

let lastGradeBatch: Awaited<ReturnType<typeof gradeCryptoBatch>> | null = null;
const gradeFallbackBackoff = new ProviderBackoff();
async function graderTick(): Promise<void> {
  const observeExactPool = createGradeObserver(getJson, Date.now, gradeFallbackBackoff);
  lastGradeBatch=await gradeCryptoBatch(sqlite, async row => {
    const live=tracked.get(`${row.chain}:${row.pair_address}`);
    if (live?.lastRefreshAt && live.tokenAddress === row.token_address &&
        live.lastRefreshAt <= Date.now() && Date.now()-live.lastRefreshAt<10*60_000 &&
        live.liquidityEvidence && live.liquidityEvidence.pairAddress === row.pair_address &&
        live.liquidityEvidence.fetchedAt <= Date.now() && Date.now()-live.liquidityEvidence.fetchedAt<10*60_000 &&
        live.marketCap!=null && live.liquidityUsd!=null) {
      return {mcap:live.marketCap,liq:live.liquidityUsd,
        observedAt:Math.min(live.lastRefreshAt,live.liquidityEvidence.fetchedAt),
        source:`Tracked exact pool; DexScreener cap + ${live.liquidityEvidence.provider} reserve (conservative receipt time)`};
    }
    return observeExactPool(row);
  });
  const pending = lastGradeBatch.unavailable + lastGradeBatch.partial + lastGradeBatch.deferred;
  hb("grader", GRADER_MS).idle = lastGradeBatch.selected === 0;
  hb("grader", GRADER_MS).coverage = { attempted: lastGradeBatch.selected, usable: lastGradeBatch.observed - lastGradeBatch.partial,
    pending, checkedAt: Date.now(), issues: pending ? ["Exact-pool observations missing/partial or in retry backoff; no replacement pool or fabricated loss."] : [] };
  if (pending>0) {
    hb("grader",GRADER_MS).degraded=true;
    if (lastGradeBatch.unavailable>0 && lastGradeBatch.observed===0 && lastGradeBatch.closed===0) throw Error("No usable observations in grading batch");
  }
}

// ─── WATCHDOG ───────────────────────────────────────────────────────────

function watchdogTick(): void {
  const now = Date.now();
  for (const h of health.values()) {
    if (h.name === "watchdog") continue;
    if (h.lastRunAt == null) { h.status = "starting"; continue; }
    const sinceOk = now - (h.lastOkAt ?? 0);
    if (h.lastError) h.status = "error";
    else if (sinceOk > h.cadenceMs * 5) h.status = "stale";
    else if (sinceOk > h.cadenceMs * 2.5) h.status = "late";
    else h.status = h.degraded ? "degraded" : h.idle ? "idle" : "ok";
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
  hb("security", SECURITY_MS); hb("social", SOCIAL_MS); hb("watchdog", WATCHDOG_MS);

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
  scoreVersion: string;
} {
  // Source outages must not leave an old ENTER/WATCH active indefinitely.
  for (const c of tracked.values()) {
    if (c.lastRefreshAt==null || c.lastRefreshAt>Date.now() || Date.now()-c.lastRefreshAt>5*60_000) {
      c.verdict="PASS"; c.risk=null; c.score=null;
      c.scoreBreakdown=null;
      c.verdictReasons=["market observation missing or older than five minutes"];
    } else scoreCandidate(c); // expire social evidence on reads as well as scheduled polls
  }
  const list = [...tracked.values()]
    .sort((a, b) => {
      const rank = (v: Candidate["verdict"]) => (v === "ENTER" ? 0 : v === "WATCH" ? 1 : 2);
      return rank(a.verdict) - rank(b.verdict) || (b.score ?? 0) - (a.score ?? 0);
    })
    .slice(0, MAX_TRACKED);
  return {
    asOf: Date.now(),
    trackedCount: tracked.size,
    candidates: list,
    narrativeHeat: narrativeHeat.slice(0, 14),
    narrativeUpdatedAt,
    scoreVersion: MEME_SCORE_VERSION,
  };
}

export function getCryptoHealth() {
  // Recompute derived status on reads, not only at the next watchdog interval.
  const now=Date.now();
  const engines=[...health.values()].map(h=>({...h,status:h.lastRunAt==null?"starting":
    h.lastError?"error":now-(h.lastOkAt??0)>h.cadenceMs*5?"stale":
    now-(h.lastOkAt??0)>h.cadenceMs*2.5?"late":h.degraded?"degraded":h.idle?"idle":"ok"}));
  return { engines, trackedCount: tracked.size, asOf: now,
    version: CRYPTO_RELIABILITY_VERSION, scoreVersion: MEME_SCORE_VERSION, discoverySources, lastGradeBatch,
    observationNote:"Provider fetch samples, not exchange timestamps. No continuity guarantee while the host is suspended." };
}
export function getCryptoSourceRegister(): DeskSource[] {
  const engines = getCryptoHealth().engines;
  const definitions = [
    ["geckoterminal", "GeckoTerminal", "scanner", "Pool discovery / reserve repair", GT_BASE,
      "60s discovery; bounded 20-pool repair batches", "Solana discovery window is bounded. Exact-pool reserves are not executable depth; FDV is never treated as circulating market cap."],
    ["dexscreener", "DexScreener", "momentum", "Pool price / transactions / reported volume", DS_BASE,
      "75s collector", "Provider receipt time only. No unique-wallet, wash-trading or complete on-chain event claim. Paid boosts are promotion, not organic evidence."],
    ["solana", "Solana public RPC", "security", "Mint program / authorities / raw token accounts", RPC_ACCOUNT[0],
      "8 unique mints per 45s in one RPC batch; priority plus oldest-first", "Original SPL plus a reviewed immutable Token-2022 metadata subset. Transfer-changing, mutable or unknown extensions fail closed. Raw accounts include unverified pools."],
    ["rugcheck", "Rugcheck", "security", "Cached risk flags", "https://api.rugcheck.xyz",
      "Best effort per mint", "Third-party cached summary is supplementary, not independent complete safety verification. Coverage can differ from the RPC routine."],
    ["bluesky", "Bluesky", "social", "Contract mentions + separate ticker-only context", "https://api.bsky.app",
      "4 unique mints per 90s; priority + oldest-first; 2 requests/mint; 25s batch deadline",
      "One-hour sample: up to 100 returned posts per query. Exact contract text/known token links only for scoring; ticker-only posts never confirm a token. Zero matches is not zero activity. No complete social-market or organic-demand claim."],
    ["pumpfun", "pump.fun", "social", "Mint-specific reply counter", PUMP,
      "Bounded collector; 30min cooldown on denied public access", "No access-control or transport bypass. Missing reply counts remain unknown; reply volume is not verified buyers or organic demand."],
  ] as const;
  return [...definitions.map(([id, name, engine, role, url, cadence, limitation]): DeskSource => {
    const h = engines.find(e => e.name === engine);
    const check = providerChecks.get(id);
    if (["solana", "rugcheck", "bluesky", "pumpfun"].includes(id)) return {
      id, name, role, url, cadence, limitation: `${limitation} ${check?.reason ?? "No provider attempt this process yet."}`,
      state: !check ? "UNKNOWN" : nowTooOld(check.checkedAt, engine === "security" ? 1800000 : 600000) ? "STALE" :
        ["ok", "partial"].includes(check.state) ? "PARTIAL" : "UNAVAILABLE",
      fetchedAt: check && ["ok", "partial"].includes(check.state) ? check.checkedAt : null, observedAt: null,
    };
    return { id, name, role, url, cadence, limitation,
      state: !h?.lastOkAt ? "UNKNOWN" : ["stale", "late"].includes(h.status) ? "STALE" :
        h.status === "error" ? "UNAVAILABLE" : "PARTIAL",
      fetchedAt: h?.lastOkAt ?? null, observedAt: null };
  }), { id: "x", name: "X", role: "Social coverage", url: "https://x.com", state: "DISABLED",
    fetchedAt: null, observedAt: null, cadence: "Not connected", limitation: "User dismissed connection. No unofficial scrape, cookies, account creation or complete-X claim." }];
}

function nowTooOld(t: number, ttl: number) { return t > Date.now() || Date.now() - t > ttl; }

export function getCryptoSignals(): {
  signals: any[];
  stats: ReturnType<typeof cryptoAuditStats>;
} {
  const signals = sqlite.prepare(
    `SELECT * FROM crypto_signals ORDER BY detected_at DESC LIMIT 100`,
  ).all() as any[];
  return {
    signals: signals.map((s) => ({
      ...s,
      features: safeParse(s.features_json),
      risk: safeParse(s.risk_json),
    })),
    stats: cryptoAuditStats(sqlite),
  };
}

function safeParse(s: any): any {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}
