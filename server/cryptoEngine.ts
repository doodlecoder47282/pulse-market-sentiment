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
import { signalReturn, summarizeExpectancy, type ExpectancySummary, type GradedSignalLike } from "../shared/cryptoExpectancy";
import { CRYPTO_RULES, CRYPTO_RULES_VERSION, describeCryptoRules } from "../shared/cryptoRules";
import { buildReplay, type ReplayRow, type CryptoReplay } from "../shared/cryptoReplay";
import { parseFeed } from "./sources/parse";
import { sourceTable, TIER_LABEL } from "./sources/registry";
import { readMajors, type MajorsSnapshot } from "./sources/cryptoMajors";
import { readDerivs, lastDerivs } from "./sources/cryptoDerivs";
import { derivsRecord, type DerivsSnapshot } from "../shared/cryptoFunding";
import { parseJupiterPrices, jupiterCheck, narrativeCounts, JUP_MAX_IDS, type JupState } from "./sources/dexCross";
import {
  computeSocialScore, resolveSocialCollection, expireSocial,
  CRYPTO_SIGNAL_COUNTS_SQL, type SocialStatus, type SocialSourceStatus,
  observedNumber, gradeSignal, cryptoCoinCountsSql, summarizeDeskStats, type CryptoDeskStats, CRYPTO_SAMPLE_READY_MIN_GRADED, CRYPTO_NO_DATA_MAX_SHARE,
  CRYPTO_GRADER_BATCH, CRYPTO_PEAK_SAMPLE_SQL, CRYPTO_GRADER_MARK_SQL, CRYPTO_GRADER_NO_DATA_SQL, peakSamplingNote,
  peakSampleParams, graderMarkParams, graderNoDataParams,
  countMentions, socialCoverage, type DexPool,
  momentumPoints, honeypotRead, jupiterAllowsEnter,
} from "./cryptoStats";
import { classifyMeme, linePosition, tradeCost, type LinePosition, type MemeClass, type TradeCost } from "../shared/memeStructure";
import { readTokenFacts, indexedRpcAvailable, noteIndexedRateLimit, solRpc, RPC_INDEXED } from "./solanaToken";
import { slotEvidence, creatorEvidence, sumOwnerTokenUi, feePayerOf, type LaunchEvidence, type SigRow } from "../shared/cryptoLaunch";
import { deskRiskFromMajors, VERDICT_CODE_TEXT, type DeskRisk, type VerdictCode } from "../shared/cryptoVerdict";
import { parseMintInput, autopsyGates, summarizeGates, holderDumpStress, type Gate, type GateSummary, type HolderStress } from "../shared/cryptoAutopsy";

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
  /** Machine-readable reason for the verdict (shared/cryptoVerdict.ts VerdictCode). */
  verdictCode: VerdictCode | null;
  verdictReasons: string[];
  risk: RiskParams | null;

  // structural read (shared/memeStructure.ts): launch order, category, cost of a round trip
  structure: CandidateStructure | null;
}

export interface CandidateStructure {
  line: LinePosition;
  category: MemeClass;
  /** Round trip of the risk-sized position (or $100 when there is none) against the pool's depth. */
  cost: TradeCost;
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

// Thresholds come from the versioned rule book (shared/cryptoRules.ts); a
// change there is a new rule version, pinned by tests/quant.
const MCAP_CEILING = CRYPTO_RULES.universe.trackMcapMaxUsd;    // track a little above the entry ceiling so we see the cross
const MCAP_ENTRY_MAX = CRYPTO_RULES.universe.enterMcapMaxUsd;  // ENTER only below this
const TARGET_MCAP = CRYPTO_RULES.universe.targetMcapUsd;
const LIQ_FLOOR_USD = CRYPTO_RULES.universe.liquidityFloorUsd; // below this you cannot exit — hard kill
const MAX_TRACKED = CRYPTO_RULES.universe.maxTracked;          // memory + rate-budget cap
const CANDIDATE_TTL_MS = CRYPTO_RULES.universe.candidateTtlHours * 3600_000; // drop after this long without a signal
const SCANNER_MS = 60_000;
const MOMENTUM_MS = 75_000;
const MOMENTUM_BATCH = 90; // tracked coins refreshed per momentum tick (3 DexScreener calls)
const NARRATIVE_MS = 5 * 60_000;
const MAJORS_MS = 60_000;
const DERIVS_MS = 120_000;
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
  CREATE TABLE IF NOT EXISTS crypto_desk_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    reason TEXT,
    updated_at INTEGER NOT NULL
  );
`);
// Columns added after the table first shipped (SQLite has no ADD COLUMN IF NOT EXISTS):
//   peak_liquidity      liquidity at the sampled peak, so the peak rule prices its exit at the depth that existed
//   horizon_*           the mark at the 72 h horizon regardless of outcome, so a true hold-to-horizon return exists
//   verdict_code        machine-readable reason for the verdict (rejection reasons are coded, not only prose)
for (const [col, type] of [["peak_liquidity", "REAL"], ["horizon_mcap", "REAL"], ["horizon_liquidity", "REAL"], ["horizon_at", "INTEGER"], ["verdict_code", "TEXT"]] as const) {
  const have = (sqlite.prepare(`PRAGMA table_info(crypto_signals)`).all() as Array<{ name: string }>).some((r) => r.name === col);
  if (!have) sqlite.exec(`ALTER TABLE crypto_signals ADD COLUMN ${col} ${type}`);
}
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
        (id, detected_at, chain, pair_address, token_address, symbol, name, verdict, verdict_code,
         score, mcap_at_signal, price_at_signal, liquidity_at_signal,
         features_json, risk_json, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
    `).run(
      `${c.chain}:${c.pairAddress}:${Date.now()}`,
      Date.now(), c.chain, c.pairAddress, c.tokenAddress, c.symbol, c.name,
      // The same market-cap basis the verdict and the grader use (marketCap,
      // else FDV): a pair with marketCap null and FDV present used to be
      // ENTER-able with mcap_at_signal NULL, which the grader read as 0.
      c.verdict, c.verdictCode, c.score, c.marketCap ?? c.fdv ?? null, c.priceUsd, c.liquidityUsd,
      JSON.stringify({
        rulesVersion: CRYPTO_RULES_VERSION,
        score: c.score,
        mcapBasis: c.marketCap != null ? "marketCap" : c.fdv != null ? "fdv" : "none",
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
        // Funding / open-interest regime at signal time: recorded for the replay to test, never a gate.
        derivs: derivsRecord(lastDerivs()),
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
    hardKill: false, score: null, verdict: null, verdictCode: null, verdictReasons: [], risk: null,
    structure: null,
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

/**
 * DexScreener Pair -> Candidate market fields. One mapping shared by the
 * momentum refresh and the contract autopsy so they can never read a pair two
 * different ways.
 */
function applyDexPair(c: Candidate, p: any): void {
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
}

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
  const batch = list.slice(0, MOMENTUM_BATCH); // 3 calls/tick max — far under budget
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
  // Highest-scoring mints first: with the check fail-closed (an unchecked
  // mint cannot be ENTER), the 50-mint budget goes to the candidates that
  // could reach ENTER.
  const bestScore = (m: string) => Math.max(...(byToken.get(m) ?? []).map((c) => c.score ?? 0));
  const jupMints = addrs.slice().sort((a, b) => bestScore(b) - bestScore(a)).slice(0, JUP_MAX_IDS);
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
      applyDexPair(c, p);
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
      recordPeakSample(c);
    }
  }
}

// Peak sampling on every momentum refresh (round 4): the refresh already has
// the coin's market cap, so its OPEN signal rows get the sample here with no
// extra API call. The grader reads at most CRYPTO_GRADER_BATCH OPEN rows per
// pass (oldest first), so under a backlog new signals used to get no peak
// samples until the old ones resolved. SQLite evaluates every SET expression
// on the pre-update row, so peak_at moves only when the peak does. A missing
// market cap (null) is not a sample; an observed 0 is (it never raises a peak).
let _peakStmt: ReturnType<typeof sqlite.prepare> | null = null;
function recordPeakSample(c: Candidate): void {
  if (c.marketCap == null || !Number.isFinite(c.marketCap)) return;
  try {
    _peakStmt = _peakStmt ?? sqlite.prepare(CRYPTO_PEAK_SAMPLE_SQL);
    _peakStmt.run(peakSampleParams(c.marketCap, c.lastRefreshAt ?? Date.now(), c.liquidityUsd, c.chain, c.pairAddress));
  } catch (e: any) {
    console.warn(`[crypto:peak] ${e?.message ?? e}`);
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
const SECURITY_RETRY_MS = CRYPTO_RULES.security.retryMinutes * 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function securityTick(): Promise<void> {
  // oldest-unchecked first; re-check active-authority tokens every 30 min
  const now = Date.now();
  const due = [...tracked.values()]
    .filter((c) => c.chain === "solana" && c.tokenAddress && (c.liquidityUsd ?? 0) >= LIQ_FLOOR_USD)
    .filter((c) =>
      c.securityCheckedAt == null ||
      ((c.mintAuthorityActive || c.freezeAuthorityActive) && now - c.securityCheckedAt > SECURITY_RETRY_MS) ||
      // Top-10 share still unread (the indexed call was skipped or unavailable
      // on the last pass): retry every 30 min, as the community watch does.
      // Without this the second candidate of every tick stayed "top10 unread"
      // for good and could never ENTER.
      (c.top10Pct == null && now - c.securityCheckedAt > SECURITY_RETRY_MS))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) // best candidates first — they gate ENTER
    .slice(0, 2); // gentle pace — public RPCs throttle bursts hard
  if (due.length === 0) return;

  let okCount = 0;
  let lastErr: any = null;
  let concentrationDone = false; // max ONE indexed call per tick
  for (const c of due) {
    try {
      // CRITICAL PATH: authorities + supply; BEST-EFFORT: holder concentration
      // (indexed, mainnet-beta only, one per tick). Shared with the community
      // watch via server/solanaToken.ts.
      const known = tokenPools.get(c.tokenAddress)?.pools ?? [];
      const pools = known.some((p) => p.pairAddress === c.pairAddress)
        ? known
        : [...known, { pairAddress: c.pairAddress, baseAmount: null }];
      const facts = await readTokenFacts(c.tokenAddress, pools, { withConcentration: !concentrationDone && indexedRpcAvailable() });
      c.mintAuthorityActive = facts.mintAuthorityActive;
      c.freezeAuthorityActive = facts.freezeAuthorityActive;
      if (facts.concentration !== "skipped") concentrationDone = true;
      if (facts.concentration === "ok") {
        c.top10Pct = facts.top10Pct;
        c.top10Method = facts.top10Method;
      } else if (c.top10Pct == null) {
        // Say why it is unread so the card and the verdict show it, instead of
        // showing mint and freeze ticks with no top-10 line at all.
        c.top10Method = facts.concentration === "unavailable"
          ? `unavailable: ${facts.concentrationError ?? "indexed RPC did not answer"}`
          : "skipped: one indexed read per tick; retried within 30 min";
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
  // (displayed). The composite uses its parts once each (round 3:
  // cryptoStats.momentumPoints), not FOMO on top of the flow it contains.
  const mp = momentumPoints({ volAccel: c.volAccel, netBuyRatio5m: c.netBuyRatio5m, trending: c.discoveredVia === "trending", boosted: !!c.boosted });
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
  c.fomoScore = mp.fomoScore;

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
  if (mcap > 0 && liq > 0 && liq / mcap < CRYPTO_RULES.hardKills.exitDoorMinLiqToMcap) { flags.push(`liq/mcap ${(100 * liq / mcap).toFixed(1)}% < ${Math.round(CRYPTO_RULES.hardKills.exitDoorMinLiqToMcap * 100)}% — exit door too small`); hardKill = true; }
  if (mcap > 0 && liq > mcap * CRYPTO_RULES.flags.liqOverMcapMultiple) flags.push("liquidity >> mcap — weird pool, likely mispriced data");
  // Honeypot: an OBSERVED 0 sells is the pattern; a MISSING sell count is
  // an unverifiable sell side (holds ENTER at WATCH below), never "zero".
  const hp = honeypotRead(c.buys1h, c.sells1h);
  if (hp === "honeypot") { flags.push("buys but ZERO sells in 1h (observed) — honeypot pattern"); hardKill = true; }
  else if (hp === "sells_missing") flags.push("1h sell count not reported (missing) — honeypot check not possible");
  if (c.chg1h != null && c.chg1h <= CRYPTO_RULES.hardKills.midRugChg1hPct) { flags.push(`price ${c.chg1h.toFixed(0)}% in 1h — mid-rug or post-dump`); hardKill = true; }
  if ((c.ageMinutes ?? 1e9) < CRYPTO_RULES.flags.sniperZoneMinutes) flags.push(`under ${CRYPTO_RULES.flags.sniperZoneMinutes} min old — sniper zone, spreads brutal`);
  if (c.boosted) flags.push("paid DexScreener boost — manufactured attention, discount the FOMO");
  // Observed low volume only: a missing 24 h volume is not "no volume".
  if (c.vol24h != null && c.vol24h < CRYPTO_RULES.flags.deadPoolMinVolume24hUsd && (c.ageMinutes ?? 0) > CRYPTO_RULES.flags.deadPoolMinAgeMinutes) flags.push("aged with no volume — dead pool");
  else if (c.vol24h == null && (c.ageMinutes ?? 0) > CRYPTO_RULES.flags.deadPoolMinAgeMinutes) flags.push("aged; 24 h volume not reported by the source");
  // on-chain security facts (public RPC)
  if (c.mintAuthorityActive === true) { flags.push("MINT AUTHORITY ACTIVE — dev can print supply into your bid"); hardKill = true; }
  if (c.freezeAuthorityActive === true) { flags.push("FREEZE AUTHORITY ACTIVE — dev can lock your tokens"); hardKill = true; }
  if (c.top10Pct == null && c.top10Method?.startsWith("unavailable")) flags.push("holder concentration unavailable (token-account owners unreadable)");
  if ((c.top10Pct ?? 0) > CRYPTO_RULES.flags.top10MaxPct) flags.push(`top-10 holders ${c.top10Pct}% of supply (${c.top10Method?.startsWith("top-10 holders INCLUDING") ? "pool vault not identified, may include pool" : "ex-pool"}) — coordinated dump risk`);
  // rugcheck cached report — LP lock + named risks (non-fatal: cached data)
  if (c.rcLpLockedPct != null && c.rcLpLockedPct < CRYPTO_RULES.flags.lpLockMinPct) flags.push(`LP only ${c.rcLpLockedPct}% locked (rugcheck) — pull risk`);
  for (const r of c.rcRisks) flags.push(`rugcheck: ${r}`);
  // Jupiter cross-check of the pool price (aggregator; flags, not hard kills)
  if (c.jupState === "diverge") flags.push(`pool price ${c.jupGapPct}% off Jupiter — price unverified, no entry`);
  else if (c.jupState === "no-reliable-price") flags.push("Jupiter has no reliable price for this mint — price unverified");
  else if (c.jupState === "failed" || c.jupState === "unchecked") flags.push(`Jupiter cross-check ${c.jupState} — pool price unverified`);
  c.rugFlags = flags;
  c.hardKill = hardKill;

  // composite: flow 35 (acceleration + tape), structure 25 (inverse rug
  // pressure), meme 15, narrative 15, attention 10 (trending/boost). Each
  // input counted once (round 3; was flow = 0.35 x FOMO plus 0.10 x FOMO).
  const flow = Math.min(35, mp.flowPts);
  const structure = hardKill ? 0 : Math.max(0, 25 - flags.length * 5);
  const memePts = (c.memeScore ?? 0) * 0.15;
  const narrPts = Math.min(15, c.narrativeHits.length * 7.5);
  const attnPts = mp.attentionPts;
  c.score = Math.round(Math.min(100, flow + structure + memePts + narrPts + attnPts));

  // verdict, with a machine-readable code for every branch (shared/cryptoVerdict.ts)
  const reasons: string[] = [];
  let verdict: Candidate["verdict"] = "PASS";
  let code: VerdictCode = "score_low";
  if (hardKill) {
    code = "hard_kill";
    reasons.push("hard kill: " + flags.filter((f) => /floor|honeypot pattern|mid-rug|exit door|liquidity not reported|liquidity \$0|AUTHORITY/.test(f)).join("; "));
  } else if (mcap <= 0 || c.priceUsd == null) {
    code = "no_price";
    reasons.push("no reliable mcap/price yet");
  } else if (mcap > MCAP_ENTRY_MAX) {
    verdict = c.score >= CRYPTO_RULES.mcapCeiling.watchMinScore ? "WATCH" : "PASS";
    code = "mcap_ceiling";
    reasons.push(`mcap $${(mcap / 1e6).toFixed(2)}M above the $${(MCAP_ENTRY_MAX / 1e6).toFixed(0)}M entry ceiling — watch for retrace only`);
  } else if (c.score >= CRYPTO_RULES.enter.minScore && (c.volAccel ?? 0) >= CRYPTO_RULES.enter.minVolAccel && (c.netBuyRatio5m ?? 0) >= CRYPTO_RULES.enter.minNetBuyRatio5m) {
    // WHALE-BLINK FILTER: one hot 5-min window is a single buyer, not a move.
    // ENTER requires sustained flow — at least 2 of the last 3 refreshes with
    // accel >= 1.5 — plus a completed on-chain security check.
    const { window: sWin, need: sNeed } = CRYPTO_RULES.enter.sustainedPolls;
    const recent = c.hist.slice(-sWin);
    const sustained = recent.length >= sNeed && recent.filter((h) => (h.volAccel ?? 0) >= CRYPTO_RULES.enter.minVolAccel).length >= sNeed;
    if (!sustained) {
      verdict = "WATCH"; code = "flow_not_sustained";
      reasons.push(`score ${c.score}, accel ${c.volAccel?.toFixed(1)}x but not sustained yet (need ${sNeed} of last ${sWin} polls) — whale-blink filter`);
    } else if (c.securityCheckedAt == null) {
      verdict = "WATCH"; code = "security_unread";
      reasons.push(`score ${c.score}, flow sustained — held at WATCH pending on-chain security check (mint/freeze/holders)`);
    } else if (!jupiterAllowsEnter(c.jupState)) {
      // Fail-closed (round 3): a failed or skipped Jupiter check is not a
      // pass. Only "agree" or "watch" (<= 15% gap) lets ENTER stand.
      verdict = "WATCH"; code = "price_unconfirmed";
      reasons.push(`score ${c.score}, flow sustained — held at WATCH: DexScreener price not confirmed by Jupiter (${c.jupState}${c.jupGapPct != null ? ` ${c.jupGapPct}%` : ""}${c.jupState === "failed" || c.jupState === "unchecked" ? ", cross-check did not run" : ""})`);
    } else if (hp === "sells_missing") {
      verdict = "WATCH"; code = "sells_missing";
      reasons.push(`score ${c.score}, flow sustained — held at WATCH: 1h sell count missing, honeypot check not possible`);
    } else if (c.top10Pct == null) {
      // Fail-closed like Jupiter / sells (round 4): concentration not read
      // (owners unreadable, RPC cooldown, not yet checked) is not a pass.
      verdict = "WATCH"; code = "top10_unread";
      reasons.push(`score ${c.score}, flow sustained — held at WATCH: top-10 holder concentration unavailable${c.top10Method ? ` (${c.top10Method})` : " (not read yet)"}`);
    } else if (currentDeskRisk().state !== "on") {
      const risk = currentDeskRisk();
      // RISK-OFF (persistent desk state from the majors read): the scanner keeps
      // logging and the candidate stays WATCH; nothing advances to ENTER until
      // the state is on again. Unknown majors block the same way as risk-off.
      verdict = "WATCH"; code = risk.state === "off" ? "risk_off" : "risk_unknown";
      reasons.push(`score ${c.score}, flow sustained, security checked — held at WATCH: desk risk ${risk.state} (${risk.reason})`);
    } else {
      verdict = "ENTER"; code = "enter";
      reasons.push(`score ${c.score}, flow sustained ${c.volAccel?.toFixed(1)}x, ${Math.round((c.netBuyRatio5m ?? 0) * 100)}% buys, security checked`);
      reasons.push(`pool price confirmed by Jupiter (${c.jupGapPct}% gap)`);
      reasons.push(`top-10 holders ${c.top10Pct}% (${c.top10Method ?? "method unknown"})`);
      if (c.narrativeHits.length) reasons.push(`narrative confirm: ${c.narrativeHits.join(", ")}`);
    }
  } else if (c.score >= CRYPTO_RULES.watch.minScore) {
    verdict = "WATCH"; code = "forming";
    reasons.push(`score ${c.score} — setup forming, waiting on flow confirmation`);
  } else {
    code = "score_low";
    reasons.push(`score ${c.score} below ${CRYPTO_RULES.watch.minScore}`);
  }
  c.verdictCode = code;
  c.verdict = verdict;
  c.verdictReasons = reasons;

  // risk params — sized off exit liquidity, never conviction
  if (verdict === "ENTER" || verdict === "WATCH") {
    const maxPos = Math.floor(Math.min(liq * CRYPTO_RULES.sizing.poolShare, CRYPTO_RULES.sizing.maxPositionUsd)); // share of pool, hard cap
    // Execution cost from the pool's depth (constant product, shared/memeStructure.ts),
    // replacing the old (size / liquidity) x 200 guess: the round trip of the
    // sized position when the quote is back at the entry.
    const rt = tradeCost({ liquidityUsd: c.liquidityUsd, sizeUsd: Math.max(1, maxPos) });
    c.risk = {
      maxPositionUsd: Math.max(0, maxPos),
      suggestedStopPct: CRYPTO_RULES.sizing.suggestedStopPct,
      liquidityExitStopPct: CRYPTO_RULES.sizing.liquidityExitStopPct,
      targetMcap: TARGET_MCAP,
      targetMultiple: mcap > 0 ? Number((TARGET_MCAP / mcap).toFixed(1)) : null,
      estSlippagePct: rt.roundTripPct ?? 15,
      holdHorizonHours: CRYPTO_RULES.sizing.holdHorizonHours,
      notes: [
        `size = ${CRYPTO_RULES.sizing.poolShare * 100}% of pool liquidity (max $${CRYPTO_RULES.sizing.maxPositionUsd}) — the exit is the constraint, not the entry`,
        rt.roundTripPct != null
          ? `round trip ${rt.roundTripPct}% of size at this depth (fees ${rt.feesRoundTripPct}% + impact ${rt.impactBuyPct}% / ${rt.impactSellPct}%); break-even move ${rt.breakEvenMovePct ?? "none"}%`
          : "round-trip cost unknown: pool liquidity not reported",
        "a minimum sample, not evidence of edge: the record decides, net of cost",
        `UNCALIBRATED: tracking mode until at least ${CRYPTO_RULES.grading.minSample} first-ENTER coins are graded with a no-data share of ${Math.round(CRYPTO_RULES.grading.maxNoDataShare * 100)}% or less (a minimum sample, not a calibration)`,
      ],
    };
  } else {
    c.risk = null;
  }

  // Structural read: where a public buyer stands in the launch order, which of
  // the three categories the coin is in, and what a round trip costs here.
  c.structure = {
    line: linePosition(c.ageMinutes, c.pumpfunGraduate),
    category: classifyMeme({
      name: c.name, symbol: c.symbol, ageDays: c.ageMinutes == null ? null : c.ageMinutes / 1440,
      liquidityUsd: c.liquidityUsd, top10Pct: c.top10Pct, mintAuthorityActive: c.mintAuthorityActive,
      narrativeHits: c.narrativeHits, history: null,
    }),
    cost: tradeCost({ liquidityUsd: c.liquidityUsd, sizeUsd: c.risk ? Math.max(1, c.risk.maxPositionUsd) : 100 }),
  };
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
const GRADE_HORIZON_MS = CRYPTO_RULES.grading.horizonHours * 3600_000;
const NO_DATA_AFTER_ERRORS_MS = 7 * 24 * 3600_000; // fetch errors this long after detection → stop retrying

async function graderTick(): Promise<void> {
  const open = sqlite.prepare(
    `SELECT id, pair_address, chain, detected_at, mcap_at_signal, liquidity_at_signal, peak_mcap, peak_at FROM crypto_signals WHERE outcome = 'OPEN' ORDER BY detected_at ASC LIMIT ?`,
  ).all(CRYPTO_GRADER_BATCH) as any[];
  if (open.length === 0) return;

  // Monotonic peak + outcome from the max (cryptoStats.CRYPTO_GRADER_MARK_SQL).
  const mark = sqlite.prepare(CRYPTO_GRADER_MARK_SQL);
  const freshPeak = sqlite.prepare(`SELECT peak_mcap FROM crypto_signals WHERE id = ? AND outcome = 'OPEN'`);
  const markNoData = sqlite.prepare(CRYPTO_GRADER_NO_DATA_SQL);
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
        if (age > NO_DATA_AFTER_ERRORS_MS) markNoData.run(graderNoDataParams(now, row.id, TARGET_MCAP));
        continue;
      }
    }
    // Pure grading rule (cryptoStats.gradeSignal): an observed liquidity pull
    // is RUGGED even without a market cap; no mcap past the horizon is
    // NO_DATA (missing), never DEAD.
    // Re-read the peak AFTER the awaits above: a momentum refresh may have
    // raised it since the batch SELECT (synchronous from here to the write).
    const fresh = freshPeak.get(row.id) as { peak_mcap: number | null } | undefined;
    if (!fresh) continue; // resolved meanwhile
    const prevPeak = fresh.peak_mcap != null ? Number(fresh.peak_mcap) : null;
    const g = gradeSignal({
      entryMcap: Number(row.mcap_at_signal ?? 0),
      entryLiq: Number(row.liquidity_at_signal ?? 0),
      prevPeak, mcap, liq, ageMs: age,
      targetMcap: TARGET_MCAP, horizonMs: GRADE_HORIZON_MS,
    });
    if (g.outcome === "NO_DATA") { markNoData.run(graderNoDataParams(now, row.id, TARGET_MCAP)); continue; }
    if (g.outcome === "OPEN" && mcap == null) continue; // nothing new to record
    mark.run(graderMarkParams(g.peak, now, mcap, liq, g.outcome, TARGET_MCAP, row.id));
  }
}

// ─── HORIZON MARKS — the price at the 72 h horizon, whatever the outcome ──
//
// The grader closes HIT_5M rows at the target sample and RUGGED rows at
// rug detection, so their last_mcap is not a horizon mark. This pass
// prices every row that has crossed the horizon exactly once, regardless
// of outcome, so a true hold-to-horizon return exists
// (shared/cryptoExpectancy "hold" rule). A row that cannot be priced a
// week after the horizon keeps horizon_mcap NULL with horizon_at set: tried
// and unavailable, never zero.

const HORIZON_BATCH = 20;
/** The horizon pass shipped on this date; rows detected before it get no mark (their horizon passed before anyone sampled it). */
const HORIZON_PASS_SINCE_MS = Date.UTC(2026, 9, 20, 0, 0, 0);
/** A mark more than this late is not a horizon mark: the row is closed as tried-and-unavailable instead of priced days later. */
const HORIZON_LATE_MAX_MS = 24 * 3600_000;
const horizonRetryAfter = new Map<string, { at: number; attempts: number }>();

// One-time repair: marks written before the lower bound existed (first hours of 2026-10-20) priced old rows days after
// their horizon. They are cleared so the hold rule skips them as documented.
sqlite.prepare(`UPDATE crypto_signals SET horizon_mcap = NULL, horizon_liquidity = NULL, horizon_at = NULL WHERE horizon_at IS NOT NULL AND detected_at < ?`).run(HORIZON_PASS_SINCE_MS);

async function horizonTick(): Promise<void> {
  const now = Date.now();
  const due = sqlite.prepare(
    `SELECT id, pair_address, chain, detected_at FROM crypto_signals WHERE horizon_at IS NULL AND detected_at >= ? AND detected_at + ? <= ? ORDER BY detected_at ASC LIMIT ?`,
  ).all(HORIZON_PASS_SINCE_MS, GRADE_HORIZON_MS, now, HORIZON_BATCH * 3) as any[];
  if (!due.length) return;
  const mark = sqlite.prepare(`UPDATE crypto_signals SET horizon_mcap = @mcap, horizon_liquidity = @liq, horizon_at = @now WHERE id = @id AND horizon_at IS NULL`);
  let budget = HORIZON_BATCH;
  for (const row of due) {
    if (budget <= 0) break;
    const horizonAt = Number(row.detected_at) + GRADE_HORIZON_MS;
    if (now - horizonAt > HORIZON_LATE_MAX_MS) { mark.run({ mcap: null, liq: null, now, id: row.id }); continue; } // tried and unavailable, never priced late
    const r = horizonRetryAfter.get(row.id);
    if (r && now < r.at) continue;
    budget--;
    const key = `${row.chain}:${row.pair_address}`;
    const live = tracked.get(key);
    let mcap: number | null = null, liq: number | null = null;
    if (live?.lastRefreshAt && now - live.lastRefreshAt < 10 * 60_000) { mcap = live.marketCap; liq = live.liquidityUsd; }
    else {
      try {
        const resp = await getJson(`${DS_BASE}/latest/dex/pairs/${row.chain}/${row.pair_address}`);
        const p = resp?.pairs?.[0] ?? resp?.pair;
        mcap = observedNumber(p?.marketCap) ?? observedNumber(p?.fdv);
        liq = observedNumber(p?.liquidity?.usd);
      } catch {
        const attempts = (r?.attempts ?? 0) + 1;
        horizonRetryAfter.set(row.id, { at: now + Math.min(6 * 3600_000, 10 * 60_000 * 2 ** (attempts - 1)), attempts });
        continue;
      }
    }
    horizonRetryAfter.delete(row.id);
    mark.run({ mcap, liq, now, id: row.id });
  }
}

// ─── MAJORS — exchange-direct BTC/ETH/SOL ───────────────────────────────

async function majorsTick(): Promise<void> {
  const snap = await readMajors();
  majors = snap;
  setDeskRisk(deskRiskFromMajors(snap, Date.now()));
  if (snap.state === "unavailable") throw new Error("no live exchange quote for BTC/ETH/SOL");
}

// ─── DERIVATIVES REGIME — funding and open interest (descriptive) ───────

async function derivsTick(): Promise<void> {
  const snap = await readDerivs();
  if (snap.state === "unavailable") throw new Error("no perpetual-futures read from Bybit or OKX");
}

// ─── DESK RISK STATE — persistent, read by the verdict ──────────────────
//
// From the majors read: BTC against its own 24 h VWAP (Kraken) is the one
// number a keyless desk can trust for "is the tape falling out from under
// memes". Off when BTC is 5% or more under its 24 h VWAP; unknown when the
// majors could not be read (stale critical data blocks new exposure, it does
// not pass it). Persisted so a restart does not reset it to "on".

const DESK_RISK_MAX_AGE_MS = CRYPTO_RULES.deskRisk.maxAgeMinutes * 60_000;
let deskRisk: DeskRisk = loadDeskRisk();

function loadDeskRisk(): DeskRisk {
  const row = sqlite.prepare(`SELECT value, reason, updated_at FROM crypto_desk_state WHERE key = 'risk'`).get() as any;
  if (!row) return { state: "unknown", reason: "no majors read yet", asOf: null, btcVsVwap24hPct: null };
  if (Date.now() - Number(row.updated_at) > DESK_RISK_MAX_AGE_MS) return { state: "unknown", reason: `last majors read ${Math.round((Date.now() - Number(row.updated_at)) / 60_000)} min ago (restart)`, asOf: row.updated_at, btcVsVwap24hPct: null };
  return { state: row.value, reason: row.reason ?? "", asOf: row.updated_at, btcVsVwap24hPct: null };
}
function setDeskRisk(r: DeskRisk): void {
  if (r.state !== deskRisk.state) console.log(`[crypto] desk risk ${deskRisk.state} -> ${r.state}: ${r.reason}`);
  deskRisk = r;
  sqlite.prepare(`INSERT INTO crypto_desk_state (key, value, reason, updated_at) VALUES ('risk', @v, @r, @t) ON CONFLICT(key) DO UPDATE SET value = excluded.value, reason = excluded.reason, updated_at = excluded.updated_at`)
    .run({ v: r.state, r: r.reason, t: r.asOf ?? Date.now() });
}
/** The 10-minute rule applies live, not only at restart: a majors read older
 *  than that is unknown for the verdict and for the UI. */
export function currentDeskRisk(now: number = Date.now()): DeskRisk {
  if (deskRisk.asOf != null && now - deskRisk.asOf > DESK_RISK_MAX_AGE_MS) {
    return { ...deskRisk, state: "unknown", reason: `last majors read ${Math.round((now - deskRisk.asOf) / 60_000)} min ago` };
  }
  return deskRisk;
}
export function getDeskRisk(): DeskRisk { return currentDeskRisk(); }

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
  arm("horizon", GRADER_MS, horizonTick, 75_000);
  arm("security", SECURITY_MS, securityTick, 20_000);
  arm("social", SOCIAL_MS, socialTick, 30_000);
  arm("majors", MAJORS_MS, majorsTick, 2_500);
  arm("derivs", DERIVS_MS, derivsTick, 6_000);
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
  derivs: DerivsSnapshot | null;
  sourceLabels: ReturnType<typeof cryptoSourceLabels>;
} {
  // The verdict is re-scored on the momentum tick (up to ~4 min per name); a
  // desk that went off or unknown since then must not serve a stale ENTER.
  const risk = currentDeskRisk();
  const list = [...tracked.values()]
    .filter((c) => c.lastRefreshAt != null)
    .map((c) => c.verdict === "ENTER" && risk.state !== "on"
      ? { ...c, verdict: "WATCH" as const, verdictCode: (risk.state === "off" ? "risk_off" : "risk_unknown") as Candidate["verdictCode"], verdictReasons: [...c.verdictReasons, `held at WATCH at read time: desk risk ${risk.state} (${risk.reason})`] }
      : c)
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
    derivs: lastDerivs(),
    sourceLabels: cryptoSourceLabels(),
  };
}

export function getCryptoHealth(): { engines: EngineHealth[]; trackedCount: number; asOf: number } {
  return { engines: [...health.values()], trackedCount: tracked.size, asOf: Date.now() };
}

/** crypto_signals row -> the shape shared/cryptoExpectancy reads. */
function gradedLike(s: any): GradedSignalLike {
  return {
    outcome: s.outcome, mcapAtSignal: s.mcap_at_signal, liquidityAtSignal: s.liquidity_at_signal,
    peakMcap: s.peak_mcap, lastMcap: s.last_mcap, lastLiquidity: s.last_liquidity,
    peakLiquidity: s.peak_liquidity ?? null, horizonMcap: s.horizon_mcap ?? null, horizonLiquidity: s.horizon_liquidity ?? null, horizonAt: s.horizon_at ?? null,
  };
}

export const EXPECTANCY_SIZE_USD = CRYPTO_RULES.grading.sizeUsd;

/**
 * Net expectancy of the desk's first ENTER signal per coin under the graded
 * rule (buy at the signal, sell when the grader closed the row) and, as the
 * ceiling, the sampled peak. Same coin-identity window as the sample gate
 * (cryptoStats.cryptoCoinCountsSql): one row per coin, its first ENTER by
 * detected_at then id, so a coin re-signalled on several days, or on two
 * pairs in one tick, counts once.
 */
export function getCryptoExpectancy(): { graded: ExpectancySummary; hold: ExpectancySummary; peak: ExpectancySummary; basis: string; versions: Record<string, number>; currentVersion: string } {
  const rows = sqlite.prepare(`
    WITH firsts AS (
      SELECT outcome, mcap_at_signal, liquidity_at_signal, peak_mcap, last_mcap, last_liquidity, peak_liquidity, horizon_mcap, horizon_liquidity, horizon_at,
             COALESCE(json_extract(features_json, '$.rulesVersion'), 'unversioned') AS rules_version,
             ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(token_address, ''), pair_address) ORDER BY detected_at ASC, id ASC) AS rn
      FROM crypto_signals WHERE verdict = 'ENTER'
    )
    SELECT outcome, mcap_at_signal, liquidity_at_signal, peak_mcap, last_mcap, last_liquidity, peak_liquidity, horizon_mcap, horizon_liquidity, horizon_at, rules_version
    FROM firsts WHERE rn = 1 AND outcome IS NOT NULL AND outcome <> 'OPEN'
  `).all() as any[];
  const like = rows.map(gradedLike);
  // Rows logged before 2026-10-27 carry no rule version; they are pooled
  // with the current version and SAID so, until a replay re-labels them.
  const versions: Record<string, number> = {};
  for (const r of rows) versions[String(r.rules_version)] = (versions[String(r.rules_version)] ?? 0) + 1;
  const versionText = Object.entries(versions).map(([v, n]) => `${v}: ${n}`).join(", ") || "none";
  const opts = { sizeUsd: EXPECTANCY_SIZE_USD, minSample: CRYPTO_SAMPLE_READY_MIN_GRADED, targetMcap: TARGET_MCAP, maxNoDataShare: CRYPTO_NO_DATA_MAX_SHARE };
  return {
    graded: summarizeExpectancy(like, "graded", opts),
    hold: summarizeExpectancy(like, "hold", opts),
    peak: summarizeExpectancy(like, "peak", opts),
    versions, currentVersion: CRYPTO_RULES_VERSION,
    basis: `graded first-ENTER rows by rule version: ${versionText} (unversioned rows predate the rule book and are pooled with the current version until a replay re-labels them). ` + "first ENTER signal per coin, graded rows only; entry at the signal's liquidity; pool fees and impact on both legs. graded: HIT_5M rows as a limit sell at the target, filled at min(peak, target) with the depth recorded at the peak sample (not a hold to the horizon); other rows at the liquidity the grader saw when it closed them (RUGGED at rug detection). hold: exit at the 72 h horizon mark, recorded for every row detected since 2026-10-20 within a day of its horizon (older or unpriced rows are skipped); a pool classified rugged is -100 under hold only; graded prices it at the rug-detection depth and peak keeps the pre-rug peak as a ceiling. peak: the sampled peak at its own recorded liquidity, or the entry depth for rows older than the recording. Rows the horizon pass could not price (pair gone from the feeds) are counted and shown; above a 20% share the validation label is INSUFFICIENT DATA. Market-cap multiples stand in for price multiples, which overstates the move when supply grew",
  };
}

export function getCryptoSignals(): {
  signals: any[];
  stats: CryptoDeskStats & { listLimit: number };
  expectancy: { graded: ExpectancySummary; hold: ExpectancySummary; peak: ExpectancySummary; basis: string; versions: Record<string, number>; currentVersion: string };
  desk: DeskRisk;
  rules: { version: string; items: ReturnType<typeof describeCryptoRules> };
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
    peakSamplingNote(tracked.size, MOMENTUM_MS, MOMENTUM_BATCH),
  );
  return {
    signals: signals.map((s) => ({
      ...s,
      features: safeParse(s.features_json),
      risk: safeParse(s.risk_json),
      // What a $100 position opened at this row and sold when the row was graded returned, net of both legs
      // (null while open or unpriced). ENTER rows only: the desk never signalled the others.
      netGraded: s.verdict === "ENTER" ? signalReturn(gradedLike(s), "graded", EXPECTANCY_SIZE_USD) : null,
    })),
    stats: { ...stats, listLimit: LIST_LIMIT },
    expectancy: getCryptoExpectancy(),
    desk: currentDeskRisk(),
    rules: { version: CRYPTO_RULES_VERSION, items: describeCryptoRules() },
  };
}

/** Replay / diagnostics over every logged signal (shared/cryptoReplay.ts). Cached 5 min: it reads the whole table. */
let replayCache: { at: number; data: CryptoReplay } | null = null;
export function getCryptoReplay(now: number = Date.now()): CryptoReplay {
  if (replayCache && now - replayCache.at < 5 * 60_000) return replayCache.data;
  const rows = sqlite.prepare(`SELECT id, detected_at, pair_address, token_address, symbol, verdict, verdict_code, outcome, mcap_at_signal, liquidity_at_signal, peak_mcap, peak_at, peak_liquidity, last_mcap, last_liquidity, horizon_mcap, horizon_liquidity, horizon_at, features_json FROM crypto_signals`).all() as any[];
  const like: ReplayRow[] = rows.map((s) => {
    const f = safeParse(s.features_json) ?? {};
    return {
      id: String(s.id), detectedAt: Number(s.detected_at), verdict: String(s.verdict ?? ""), verdictCode: s.verdict_code ?? null, symbol: s.symbol ?? null,
      coinKey: (s.token_address && String(s.token_address).trim()) || String(s.pair_address),
      outcome: s.outcome, mcapAtSignal: s.mcap_at_signal, liquidityAtSignal: s.liquidity_at_signal,
      peakMcap: s.peak_mcap, peakAt: s.peak_at ?? null, peakLiquidity: s.peak_liquidity ?? null,
      lastMcap: s.last_mcap, lastLiquidity: s.last_liquidity,
      horizonMcap: s.horizon_mcap ?? null, horizonLiquidity: s.horizon_liquidity ?? null, horizonAt: s.horizon_at ?? null,
      rulesVersion: f.rulesVersion ?? null, mcapBasis: f.mcapBasis ?? null,
      features: {
        score: f.score ?? s.score ?? null, volAccel: f.volAccel ?? null, netBuyRatio5m: f.netBuyRatio5m ?? null, ageMinutes: f.ageMinutes ?? null,
        top10Pct: f.top10Pct ?? null, mintAuthorityActive: f.mintAuthorityActive ?? null, freezeAuthorityActive: f.freezeAuthorityActive ?? null,
        securityCheckedAt: f.securityCheckedAt ?? null, rcLpLockedPct: f.rcLpLockedPct ?? null, socialScore: f.socialScore ?? null,
        fomo: f.fomo ?? null, meme: f.meme ?? null, narrativeHits: Array.isArray(f.narrativeHits) ? f.narrativeHits : null,
        boosted: f.boosted ?? null, pumpfunGraduate: f.pumpfunGraduate ?? null, bskyMentions1h: f.bskyMentions1h ?? null,
      },
    };
  });
  const data = buildReplay(like, now);
  replayCache = { at: now, data };
  return data;
}

// ─── CONTRACT AUTOPSY — one fresh snapshot of any Solana token ───────────
//
// Reads the same sources the desk reads (DexScreener, Jupiter, the public
// Solana RPC, rugcheck) for ONE address the owner pastes, applies the desk's own
// scoreCandidate() to a transient candidate, and lays the rules out gate by
// gate (shared/cryptoAutopsy.ts). It never enters `tracked`, never calls
// persistSignal, and is never graded: it is a read, not a signal. A single
// snapshot has no flow history, so the sustained-flow gate is unread and the
// desk verdict can never be ENTER.

export interface CryptoAutopsy {
  dataState: "ok" | "invalid_input" | "not_found" | "rate_limited" | "source_failed";
  reason: string | null;
  retryAfterSec: number | null;
  asOf: number;
  cached: boolean;
  mint: string | null;
  pair: { pairAddress: string; dexId: string; poolsFound: number; selectedBy: string; ageMinutes: number | null } | null;
  snapshot: { symbol: string; name: string; priceUsd: number | null; marketCap: number | null; fdv: number | null; liquidityUsd: number | null; vol24h: number | null; chg1h: number | null } | null;
  gates: Gate[];
  summary: GateSummary | null;
  desk: { verdict: Candidate["verdict"]; verdictCode: VerdictCode | null; verdictText: string | null; score: number | null; hardKill: boolean; reasons: string[]; flags: string[] } | null;
  /** The gate table and the desk's own hard-kill result must agree; false means a defect to report. */
  parity: { agrees: boolean; detail: string | null } | null;
  tracked: { verdict: Candidate["verdict"]; verdictCode: VerdictCode | null; firstSeenAt: number } | null;
  stress: HolderStress | null;
  /** Launch-block and creator evidence from public RPC; descriptive, never a gate. Null when not attempted. */
  launch: LaunchEvidence | null;
  /** Sources that did not answer on this read; their gates read "unread", never pass. */
  sourceNotes: string[];
  notes: string[];
}

const AUTOPSY_MIN_GAP_MS = 20_000; // the Solana public RPC budget is shared with the live scanner
const AUTOPSY_CACHE_MS = 60_000;
const autopsyCache = new Map<string, { at: number; value: CryptoAutopsy }>();
let autopsyLastStart = 0;
let autopsyBusy = false;

function emptyAutopsy(now: number, dataState: CryptoAutopsy["dataState"], reason: string, mint: string | null = null, retryAfterSec: number | null = null): CryptoAutopsy {
  return { dataState, reason, retryAfterSec, asOf: now, cached: false, mint, pair: null, snapshot: null, gates: [], summary: null, desk: null, parity: null, tracked: null, stress: null, launch: null, sourceNotes: [], notes: [] };
}

const LAUNCH_PAGE = 1000;
const LAUNCH_MAX_PAGES = 3;
const LAUNCH_BUDGET_MS = 20_000; // checked between calls; each call also has its own 12 s timeout

/**
 * Pages the mint's transaction signatures back toward the earliest one (public
 * RPC, at most 3 x 1000 rows) and reads that transaction's fee payer and the
 * wallet's holding. Every failure is an "unread" state with its reason.
 */
async function readLaunchEvidence(mint: string, supplyUi: number | null, notes: string[]): Promise<LaunchEvidence> {
  const unread = (reason: string): LaunchEvidence => {
    const slot = slotEvidence([], false, LAUNCH_PAGE * LAUNCH_MAX_PAGES);
    return { slot: { ...slot, state: "unread", reason }, creator: creatorEvidence({ feePayer: null, feePayerTokenUi: null, supplyUi, slot: { ...slot, state: "unread", reason } }) };
  };
  if (!indexedRpcAvailable()) { notes.push("launch evidence skipped: the public indexed RPC is cooling down"); return unread("the public indexed RPC is cooling down; try again in a few minutes"); }
  const deadline = Date.now() + LAUNCH_BUDGET_MS;
  try {
    const rows: SigRow[] = [];
    let before: string | undefined;
    let reachedOldest = false;
    for (let page = 0; page < LAUNCH_MAX_PAGES; page++) {
      if (page > 0 && Date.now() > deadline) throw new Error("time budget spent before the earliest transaction was reached");
      const res = await solRpc("getSignaturesForAddress", [mint, { limit: LAUNCH_PAGE, ...(before ? { before } : {}) }], RPC_INDEXED);
      if (!Array.isArray(res)) throw new Error("unexpected signatures response");
      for (const r of res) rows.push({ slot: Number(r?.slot), err: r?.err ?? null, blockTime: typeof r?.blockTime === "number" ? r.blockTime : null, signature: typeof r?.signature === "string" ? r.signature : undefined });
      const last = res.length ? res[res.length - 1]?.signature : null;
      if (res.length < LAUNCH_PAGE) { reachedOldest = true; break; }
      if (typeof last !== "string" || !last) throw new Error("a page ended without a signature to continue from");
      before = last;
    }
    const slot = slotEvidence(rows, reachedOldest, LAUNCH_PAGE * LAUNCH_MAX_PAGES);
    if (slot.state !== "ok" || !slot.anchorSignature) {
      return { slot, creator: creatorEvidence({ feePayer: null, feePayerTokenUi: null, supplyUi, slot }) };
    }
    let feePayer: string | null = null;
    let held: number | null = null;
    let txFetched = true;
    if (Date.now() < deadline) {
      try {
        const tx = await solRpc("getTransaction", [slot.anchorSignature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], RPC_INDEXED);
        if (tx == null) txFetched = false; else feePayer = feePayerOf(tx);
      } catch (e: any) { txFetched = false; noteIndexedRateLimit(e); notes.push(`creator lookup failed: ${String(e?.message ?? e).slice(0, 80)}`); }
    } else { txFetched = false; }
    if (feePayer && Date.now() < deadline) {
      try {
        const accts = await solRpc("getTokenAccountsByOwner", [feePayer, { mint }, { encoding: "jsonParsed" }], RPC_INDEXED);
        held = sumOwnerTokenUi(accts);
      } catch (e: any) { noteIndexedRateLimit(e); notes.push(`creator holding lookup failed: ${String(e?.message ?? e).slice(0, 80)}`); }
    }
    return { slot, creator: creatorEvidence({ feePayer, feePayerTokenUi: held, supplyUi, slot, txFetched }) };
  } catch (e: any) {
    noteIndexedRateLimit(e);
    const why = String(e?.message ?? e).slice(0, 100);
    notes.push(`launch evidence unavailable: ${why}`);
    return unread(`the public RPC did not answer (${why})`);
  }
}

export async function runCryptoAutopsy(input: unknown, now: number = Date.now()): Promise<CryptoAutopsy> {
  const parsed = parseMintInput(input);
  if (!parsed.ok) return emptyAutopsy(now, "invalid_input", parsed.reason);
  const mint = parsed.mint;

  const hit = autopsyCache.get(mint);
  if (hit && now - hit.at < AUTOPSY_CACHE_MS) return { ...hit.value, cached: true };
  // Public RPCs and DexScreener throttle bursts: one autopsy at a time, spaced.
  if (autopsyBusy || now - autopsyLastStart < AUTOPSY_MIN_GAP_MS) {
    const wait = autopsyBusy ? 20 : Math.ceil((AUTOPSY_MIN_GAP_MS - (now - autopsyLastStart)) / 1000);
    return emptyAutopsy(now, "rate_limited", "another autopsy is running or just ran; public data sources throttle bursts", mint, Math.max(1, wait));
  }
  autopsyBusy = true;
  autopsyLastStart = now;
  try {
    const sourceNotes: string[] = [];
    // 1) DexScreener: every pool of this token
    let pairs: any[] = [];
    try {
      const resp = await getJson(`${DS_BASE}/latest/dex/tokens/${mint}`);
      pairs = (Array.isArray(resp?.pairs) ? resp.pairs : []).filter((p: any) => String(p?.chainId ?? "") === "solana" && String(p?.baseToken?.address ?? "") === mint && p?.pairAddress);
    } catch (e: any) {
      return emptyAutopsy(now, "source_failed", `DexScreener did not answer (${String(e?.message ?? e).slice(0, 80)})`, mint);
    }
    if (pairs.length === 0) {
      return emptyAutopsy(now, "not_found", "no Solana pool found for this address on DexScreener. Paste the token's contract address (mint), not a pair or wallet address. A token still on the pump.fun curve may not be listed yet.", mint);
    }
    const best = pairs.slice().sort((a, b) => (observedNumber(b?.liquidity?.usd) ?? -1) - (observedNumber(a?.liquidity?.usd) ?? -1))[0];

    // 2) transient candidate filled by the same mapping the live refresh uses
    const c: Candidate = {
      chain: "solana", pairAddress: String(best.pairAddress), tokenAddress: mint,
      symbol: String(best?.baseToken?.symbol ?? ""), name: String(best?.baseToken?.name ?? ""), dexId: String(best?.dexId ?? ""),
      pumpfunGraduate: isPumpDex(String(best?.dexId ?? "")), discoveredVia: "new_pools", firstSeenAt: now, pairCreatedAt: null,
      priceUsd: null, marketCap: null, fdv: null, liquidityUsd: null, vol5m: null, vol1h: null, vol24h: null,
      buys5m: null, sells5m: null, buys1h: null, sells1h: null, chg5m: null, chg1h: null, chg24h: null,
      boosted: false, lastRefreshAt: now,
      jupPriceUsd: null, jupState: "unchecked", jupGapPct: null, jupCheckedAt: null,
      mintAuthorityActive: null, freezeAuthorityActive: null, top10Pct: null, top10Method: null, securityCheckedAt: null,
      rcRisks: [], rcLpLockedPct: null, rcCheckedAt: null,
      bskyMentions1h: null, bskyMentions10m: null, bskyMentionsByAddress1h: null, bskyMentionsByAddress10m: null, bskyCapped: false,
      pumpReplies: null, pumpCheckedAt: null, pumpReplyPerHr: null, pumpLive: false, hasSocialLinks: null,
      socialScore: null, socialCheckedAt: null, prevPumpReplies: null, socialAttemptAt: null, socialStatus: null, socialSources: null, socialCoverage: null,
      hist: [], ageMinutes: null, volAccel: null, netBuyRatio5m: null, fomoScore: null, memeScore: null, narrativeHits: [], rugFlags: [],
      hardKill: false, score: null, verdict: null, verdictCode: null, verdictReasons: [], risk: null, structure: null,
    };
    applyDexPair(c, best);
    c.boosted = boostedTokens.has(mint.toLowerCase());

    // 3) Jupiter price cross-check (one mint)
    try {
      const j = await getJson(`${JUP_BASE}?ids=${mint}`);
      const r = parseJupiterPrices(j, [mint]);
      const jp = r.prices.get(mint) ?? null;
      const chk = jupiterCheck(c.priceUsd, { price: jp, omitted: r.omitted.includes(mint), failed: false });
      c.jupPriceUsd = jp; c.jupState = chk.state; c.jupGapPct = chk.gapPct != null ? Number(chk.gapPct.toFixed(1)) : null; c.jupCheckedAt = Date.now();
    } catch (e: any) {
      c.jupState = "failed";
      sourceNotes.push(`Jupiter did not answer (${String(e?.message ?? e).slice(0, 60)})`);
    }

    let supplyUi: number | null = null;
    // 4) on-chain facts via the public Solana RPC (authorities, holder concentration)
    try {
      const pools = pairs.map((p: any) => ({ pairAddress: String(p.pairAddress), baseAmount: observedNumber(p?.liquidity?.base) }));
      const facts = await readTokenFacts(mint, pools, { withConcentration: indexedRpcAvailable() });
      supplyUi = facts.supplyUi;
      c.mintAuthorityActive = facts.mintAuthorityActive;
      c.freezeAuthorityActive = facts.freezeAuthorityActive;
      if (facts.concentration === "ok") { c.top10Pct = facts.top10Pct; c.top10Method = facts.top10Method; }
      else {
        c.top10Method = facts.concentration === "unavailable"
          ? `unavailable: ${facts.concentrationError ?? "indexed RPC did not answer"}`
          : indexedRpcAvailable() ? "skipped: supply was not readable, so no holder share was computed"
          : "skipped: the public indexed RPC is cooling down; try again in a few minutes";
        sourceNotes.push("holder concentration was not read on this pass");
      }
      c.securityCheckedAt = Date.now();
    } catch (e: any) {
      sourceNotes.push(`Solana RPC did not answer (${String(e?.message ?? e).slice(0, 60)}): authorities and holders unread`);
    }

    // 5) rugcheck cached summary (keyless): LP lock and named risks
    try {
      const rc = await getJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
      c.rcRisks = (Array.isArray(rc?.risks) ? rc.risks : []).map((r: any) => String(r?.name ?? r)).filter(Boolean).slice(0, 6);
      const lp = Number(rc?.lpLockedPct ?? NaN);
      c.rcLpLockedPct = Number.isFinite(lp) ? Number(lp.toFixed(1)) : null;
      c.rcCheckedAt = Date.now();
    } catch { sourceNotes.push("rugcheck had no report for this token"); }

    // 5b) launch block and creator evidence (public RPC, descriptive, never a gate)
    const launch = await readLaunchEvidence(mint, supplyUi, sourceNotes);

    // 6) the desk's own scoring on the transient candidate; nothing is stored
    scoreCandidate(c);

    const gates = autopsyGates({
      liquidityUsd: c.liquidityUsd, marketCap: c.marketCap, fdv: c.fdv, priceUsd: c.priceUsd, buys1h: c.buys1h, sells1h: c.sells1h, chg1h: c.chg1h,
      vol24h: c.vol24h, ageMinutes: c.ageMinutes, mintAuthorityActive: c.mintAuthorityActive, freezeAuthorityActive: c.freezeAuthorityActive,
      top10Pct: c.top10Pct, top10Method: c.top10Method, rcLpLockedPct: c.rcLpLockedPct, jupState: c.jupState, jupGapPct: c.jupGapPct,
      volAccel: c.volAccel, netBuyRatio5m: c.netBuyRatio5m, score: c.score,
    });
    const summary = summarizeGates(gates);
    const agrees = summary.killed === c.hardKill;
    if (!agrees) console.warn(`[crypto:autopsy] gate table and desk hard kill disagree for ${mint}: gates ${summary.killed} desk ${c.hardKill}`);
    const trackedHit = [...tracked.values()].find((t) => t.tokenAddress === mint) ?? null;

    const out: CryptoAutopsy = {
      dataState: "ok", reason: null, retryAfterSec: null, asOf: Date.now(), cached: false, mint,
      pair: { pairAddress: c.pairAddress, dexId: c.dexId, poolsFound: pairs.length, selectedBy: "deepest liquidity among this token's Solana pools", ageMinutes: c.ageMinutes == null ? null : Math.round(c.ageMinutes) },
      snapshot: { symbol: c.symbol, name: c.name, priceUsd: c.priceUsd, marketCap: c.marketCap, fdv: c.fdv, liquidityUsd: c.liquidityUsd, vol24h: c.vol24h, chg1h: c.chg1h },
      gates, summary,
      desk: { verdict: c.verdict, verdictCode: c.verdictCode, verdictText: c.verdictCode ? VERDICT_CODE_TEXT[c.verdictCode] ?? null : null, score: c.score, hardKill: c.hardKill, reasons: c.verdictReasons, flags: c.rugFlags },
      parity: { agrees, detail: agrees ? null : `gate table says killed=${summary.killed}, desk says hardKill=${c.hardKill}` },
      tracked: trackedHit ? { verdict: trackedHit.verdict, verdictCode: trackedHit.verdictCode, firstSeenAt: trackedHit.firstSeenAt } : null,
      stress: holderDumpStress({ top10Pct: c.top10Pct, top10Method: c.top10Method, fdv: c.fdv, marketCap: c.marketCap, liquidityUsd: c.liquidityUsd }),
      launch,
      sourceNotes,
      notes: [
        "a single read: not a signal, not logged, not graded",
        "one snapshot has no flow history, so the sustained-flow gate is unread and the desk verdict cannot be ENTER",
        "a pass means a rule is met on this read, not that the token is safe",
      ],
    };
    autopsyCache.set(mint, { at: Date.now(), value: out });
    if (autopsyCache.size > 50) { const oldest = [...autopsyCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) autopsyCache.delete(oldest[0]); }
    return out;
  } finally {
    autopsyBusy = false;
  }
}

function safeParse(s: any): any {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}
