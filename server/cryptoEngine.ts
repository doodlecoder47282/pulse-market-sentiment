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
//   4. NARRATIVES (5min) — crypto RSS (CoinDesk/TheBlock/Decrypt) keyword heat.
//                          Names that match a hot narrative score higher —
//                          news CONFIRMS, it does not trigger.
//
//   WATCHDOG (30s) — each engine writes a heartbeat; late/stale/error states
//                    are exposed at /api/crypto/health and shown in the UI.
//
// Free public APIs only, no keys: GeckoTerminal (30 rpm), DexScreener (300 rpm
// for pairs, 60 rpm for boosts). Both budgets respected by design (batching).

import { sqlite } from "./storage";

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

  // on-chain security (public Solana RPC — free, no keys)
  mintAuthorityActive: boolean | null;   // null = unchecked
  freezeAuthorityActive: boolean | null;
  top10Pct: number | null;               // top-10 holder share ex-largest (AMM vault heuristic)
  securityCheckedAt: number | null;

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
  prevPumpReplies: { count: number; t: number } | null;

  // rolling history for sustained-flow gating (whale-blink filter)
  hist: Array<{ t: number; volAccel: number | null; netBuyRatio5m: number | null; mcap: number | null }>;

  // derived
  ageMinutes: number | null;
  volAccel: number | null;        // m5 volume annualized vs h1 baseline
  netBuyRatio5m: number | null;   // buys/(buys+sells)
  fomoScore: number | null;       // 0-100
  memeScore: number | null;       // 0-100
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
const WATCHDOG_MS = 30_000;
const GRADER_MS = 10 * 60_000;

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const DS_BASE = "https://api.dexscreener.com";

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
    outcome TEXT,           -- OPEN | HIT_5M | DOUBLED | RUGGED | DEAD
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
        meme: c.memeScore, narrativeHits: c.narrativeHits, rugFlags: c.rugFlags,
        boosted: c.boosted, pumpfunGraduate: c.pumpfunGraduate,
        ageMinutes: c.ageMinutes, reasons: c.verdictReasons,
        mintAuthorityActive: c.mintAuthorityActive, freezeAuthorityActive: c.freezeAuthorityActive,
        top10Pct: c.top10Pct, securityCheckedAt: c.securityCheckedAt,
        rcRisks: c.rcRisks, rcLpLockedPct: c.rcLpLockedPct,
        socialScore: c.socialScore, bskyMentions1h: c.bskyMentions1h,
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
    mintAuthorityActive: null, freezeAuthorityActive: null, top10Pct: null, securityCheckedAt: null,
    rcRisks: [], rcLpLockedPct: null, rcCheckedAt: null,
    bskyMentions1h: null, bskyMentions10m: null, pumpReplies: null, pumpReplyPerHr: null,
    pumpLive: false, hasSocialLinks: null, socialScore: null, socialCheckedAt: null, prevPumpReplies: null,
    hist: [],
    ageMinutes: null, volAccel: null, netBuyRatio5m: null,
    fomoScore: null, memeScore: null, narrativeHits: [], rugFlags: [],
    hardKill: false, score: null, verdict: null, verdictReasons: [], risk: null,
  };
  // GT gives a coarse first look — momentum engine refines with DexScreener.
  c.marketCap = effMcap ?? c.marketCap;
  c.fdv = Number.isFinite(fdv) ? fdv : c.fdv;
  c.priceUsd = Number(attrs.base_token_price_usd ?? NaN) || c.priceUsd;
  c.liquidityUsd = Number(attrs.reserve_in_usd ?? NaN) || c.liquidityUsd;
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
      c.priceUsd = Number(p?.priceUsd ?? NaN) || null;
      c.marketCap = Number(p?.marketCap ?? NaN) || null;
      c.fdv = Number(p?.fdv ?? NaN) || null;
      c.liquidityUsd = Number(p?.liquidity?.usd ?? NaN) || null;
      c.vol5m = Number(p?.volume?.m5 ?? NaN) || 0;
      c.vol1h = Number(p?.volume?.h1 ?? NaN) || 0;
      c.vol24h = Number(p?.volume?.h24 ?? NaN) || 0;
      c.buys5m = Number(p?.txns?.m5?.buys ?? NaN) || 0;
      c.sells5m = Number(p?.txns?.m5?.sells ?? NaN) || 0;
      c.buys1h = Number(p?.txns?.h1?.buys ?? NaN) || 0;
      c.sells1h = Number(p?.txns?.h1?.sells ?? NaN) || 0;
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
}

// ─── 2b. SECURITY — public Solana RPC on-chain checks ───────────────────
//
// The #1 rug vector isn't liquidity — it's authorities and concentration:
//   - mint authority active  = dev can print infinite supply into your bid
//   - freeze authority active = dev can freeze YOUR tokens (can't sell)
//   - top-10 holders > 45%   = coordinated dump risk
// All readable from the free public RPC (api.mainnet-beta.solana.com), no key.
// Heuristic: the single largest token account is almost always the AMM vault,
// so concentration = top-10 EXCLUDING the largest, over total supply. Disclosed.
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

      // BEST-EFFORT: holder concentration (indexed — mainnet-beta only, gentle)
      if (!concentrationDone && total > 0 && Date.now() > indexedCooldownUntil) {
        concentrationDone = true;
        try {
          await sleep(800);
          const largest = await solRpc("getTokenLargestAccounts", [c.tokenAddress], RPC_INDEXED);
          const accts: any[] = largest?.value ?? [];
          if (accts.length > 1) {
            // exclude the single largest account (AMM vault heuristic)
            const rest = accts.slice(1, 11);
            const top = rest.reduce((s: number, a: any) => s + Number(a?.amount ?? 0), 0);
            c.top10Pct = Number(((top / total) * 100).toFixed(1));
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
//     for "$SYMBOL" in the last 10m/60m.
//   - pump.fun /coins/{mint} — reply_count (velocity between polls),
//     livestream flag, twitter/telegram/website links.
// Reddit blocks datacenter IPs outright — excluded, disclosed.
// X/twitter is paywalled — excluded, disclosed.

const SOCIAL_MS = 90_000;
const BSKY = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts";
const PUMP = "https://frontend-api-v3.pump.fun";

async function socialTick(): Promise<void> {
  // refresh the best candidates first (they gate ENTER); 4 per tick,
  // stale after 5 min. ~3 bsky + ~3 pump calls per tick — trivial load.
  const now = Date.now();
  const due = [...tracked.values()]
    .filter((c) => c.lastRefreshAt != null && (c.marketCap ?? 0) <= MCAP_CEILING * 2)
    .filter((c) => c.socialCheckedAt == null || now - c.socialCheckedAt > 5 * 60_000)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 4);
  if (due.length === 0) return;

  let okCount = 0;
  let lastErr: any = null;
  for (const c of due) {
    try {
      // ── bluesky mentions: "$SYMBOL" (cashtag form degens actually post) ──
      const sym = c.symbol.replace(/[^A-Za-z0-9]/g, "");
      if (sym.length >= 3) {
        try {
          const q = encodeURIComponent(`$${sym}`);
          const r = await getJson(`${BSKY}?q=${q}&sort=latest&limit=25`);
          const posts: any[] = r?.posts ?? [];
          const ts = posts
            .map((p) => Date.parse(p?.record?.createdAt ?? p?.indexedAt ?? ""))
            .filter((t) => Number.isFinite(t));
          c.bskyMentions1h = ts.filter((t) => now - t < 3600_000).length;
          c.bskyMentions10m = ts.filter((t) => now - t < 600_000).length;
        } catch { /* bsky is enhancement — never blocks the tick */ }
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
          c.pumpLive = Boolean(coin?.is_currently_live);
          c.hasSocialLinks = Boolean(coin?.twitter || coin?.telegram || coin?.website);
        } catch { /* unofficial API — graceful degradation is the contract */ }
      }

      // ── social score 0-100 ──
      let s = 0;
      s += Math.min(35, (c.bskyMentions10m ?? 0) * 12);          // fresh mentions are gold
      s += Math.min(20, (c.bskyMentions1h ?? 0) * 2.5);
      s += Math.min(30, Math.max(0, (c.pumpReplyPerHr ?? 0)) * 0.75); // 40 replies/hr = max
      if (c.pumpLive) s += 10;
      if (c.hasSocialLinks) s += 5;
      c.socialScore = Math.round(Math.min(100, s));
      c.socialCheckedAt = now;
      okCount++;
      scoreCandidate(c);
      persistSignal(c);
    } catch (e: any) {
      lastErr = e;
    }
  }
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
  c.ageMinutes = c.pairCreatedAt ? Math.max(0, (now - c.pairCreatedAt) / 60_000) : null;

  // meme score
  const meme = scoreMeme(c.name, c.symbol);
  c.memeScore = meme.score;

  // narrative confirmation — name/symbol matches a hot news narrative
  c.narrativeHits = narrativeHeat
    .filter((n) => n.hits >= 2)
    .filter((n) => new RegExp(`\\b${n.term}\\b`, "i").test(`${c.name} ${c.symbol}`))
    .map((n) => n.term);

  // flow: volume acceleration = m5 pace vs h1 pace
  const paceM5 = (c.vol5m ?? 0) / 5;
  const paceH1 = (c.vol1h ?? 0) / 60;
  c.volAccel = paceH1 > 0 ? paceM5 / paceH1 : (paceM5 > 0 ? 5 : 0);
  const t5 = (c.buys5m ?? 0) + (c.sells5m ?? 0);
  c.netBuyRatio5m = t5 > 0 ? (c.buys5m ?? 0) / t5 : null;

  // FOMO score: acceleration + one-sided tape + trending/boost presence
  let fomo = 0;
  if (c.volAccel != null) fomo += Math.min(40, c.volAccel * 10);          // 4x accel = max
  if (c.netBuyRatio5m != null) fomo += Math.max(0, (c.netBuyRatio5m - 0.5) * 100); // up to +50
  if (c.discoveredVia === "trending") fomo += 10;
  if (c.boosted) fomo += 8; // paid promo IS fomo — but it's flagged as manufactured below
  // social velocity (bluesky mentions + pump.fun reply rate) — real crowd
  // attention, weighted in at 30%: flow still leads, social confirms
  if (c.socialScore != null) fomo = fomo * 0.7 + c.socialScore * 0.3;
  c.fomoScore = Math.min(100, fomo);

  // rug filter
  const flags: string[] = [];
  let hardKill = false;
  const liq = c.liquidityUsd ?? 0;
  const mcap = c.marketCap ?? c.fdv ?? 0;
  if (liq < LIQ_FLOOR_USD) { flags.push(`liquidity $${(liq / 1000).toFixed(1)}k < $${LIQ_FLOOR_USD / 1000}k floor — cannot exit`); hardKill = true; }
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
  if ((c.top10Pct ?? 0) > 45) flags.push(`top-10 holders ${c.top10Pct}% of supply (ex-pool) — coordinated dump risk`);
  // rugcheck cached report — LP lock + named risks (non-fatal: cached data)
  if (c.rcLpLockedPct != null && c.rcLpLockedPct < 50) flags.push(`LP only ${c.rcLpLockedPct}% locked (rugcheck) — pull risk`);
  for (const r of c.rcRisks) flags.push(`rugcheck: ${r}`);
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
    reasons.push("hard kill: " + flags.filter((f) => /floor|honeypot|mid-rug|exit door/.test(f)).join("; "));
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
    } else {
      verdict = "ENTER";
      reasons.push(`score ${c.score}, flow sustained ${c.volAccel?.toFixed(1)}x, ${Math.round((c.netBuyRatio5m ?? 0) * 100)}% buys, security checked`);
      if (c.top10Pct != null) reasons.push(`top-10 holders ${c.top10Pct}% ex-pool`);
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
        "UNCALIBRATED: tracking mode until graded hit rate exists (n>=50)",
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
  const counts = new Map<string, { hits: number; sources: Set<string> }>();
  let anyOk = false;
  for (const feed of RSS_FEEDS) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 12_000);
      const r = await fetch(feed.url, { signal: ctl.signal, headers: { "user-agent": "batcave-terminal/1.0" } });
      clearTimeout(t);
      if (!r.ok) continue;
      const xml = await r.text();
      anyOk = true;
      const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gis)]
        .map((m) => m[1] ?? "").slice(1, 60); // skip channel title
      for (const title of titles) {
        for (const term of NARRATIVE_TERMS) {
          if (new RegExp(`\\b${term}\\b`, "i").test(title)) {
            const e = counts.get(term) ?? { hits: 0, sources: new Set<string>() };
            e.hits++;
            e.sources.add(feed.name);
            counts.set(term, e);
          }
        }
      }
    } catch { /* individual feed failure is fine */ }
  }
  if (!anyOk) throw new Error("all RSS feeds unreachable");
  narrativeHeat = [...counts.entries()]
    .map(([term, v]) => ({ term, hits: v.hits, sources: [...v.sources] }))
    .sort((a, b) => b.hits - a.hits);
  narrativeUpdatedAt = Date.now();
}

// ─── GRADER — audit outcomes (tracking mode) ────────────────────────────

async function graderTick(): Promise<void> {
  const open = sqlite.prepare(
    `SELECT id, pair_address, chain, detected_at, mcap_at_signal, liquidity_at_signal, peak_mcap FROM crypto_signals WHERE outcome = 'OPEN' ORDER BY detected_at DESC LIMIT 60`,
  ).all() as any[];
  if (open.length === 0) return;

  const mark = sqlite.prepare(
    `UPDATE crypto_signals SET peak_mcap = ?, peak_at = ?, last_mcap = ?, last_liquidity = ?, outcome = ?, graded_at = ? WHERE id = ?`,
  );
  const now = Date.now();
  for (const row of open) {
    const key = `${row.chain}:${row.pair_address}`;
    let mcap: number | null = null;
    let liq: number | null = null;
    const live = tracked.get(key);
    if (live?.lastRefreshAt && now - live.lastRefreshAt < 10 * 60_000) {
      mcap = live.marketCap; liq = live.liquidityUsd;
    } else {
      try {
        const resp = await getJson(`${DS_BASE}/latest/dex/pairs/${row.chain}/${row.pair_address}`);
        const p = resp?.pairs?.[0] ?? resp?.pair;
        mcap = Number(p?.marketCap ?? p?.fdv ?? NaN) || null;
        liq = Number(p?.liquidity?.usd ?? NaN) || null;
      } catch { continue; }
    }
    if (mcap == null) continue;
    const peak = Math.max(Number(row.peak_mcap ?? 0), mcap);
    const entryMcap = Number(row.mcap_at_signal ?? 0);
    const entryLiq = Number(row.liquidity_at_signal ?? 0);
    let outcome = "OPEN";
    if (peak >= TARGET_MCAP) outcome = "HIT_5M";
    else if (entryLiq > 0 && liq != null && liq < entryLiq * 0.15) outcome = "RUGGED";
    else if (entryMcap > 0 && mcap < entryMcap * 0.1) outcome = "RUGGED";
    else if (now - Number(row.detected_at) > 72 * 3600_000) outcome = peak >= entryMcap * 2 ? "DOUBLED" : "DEAD";
    mark.run(peak, peak > Number(row.peak_mcap ?? 0) ? now : row.peak_at ?? null, mcap, liq,
      outcome, outcome === "OPEN" ? null : now, row.id);
  }
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
  };
}

export function getCryptoHealth(): { engines: EngineHealth[]; trackedCount: number; asOf: number } {
  return { engines: [...health.values()], trackedCount: tracked.size, asOf: Date.now() };
}

export function getCryptoSignals(): {
  signals: any[];
  stats: { total: number; open: number; hit5m: number; doubled: number; rugged: number; dead: number; calibrated: boolean };
} {
  const signals = sqlite.prepare(
    `SELECT * FROM crypto_signals ORDER BY detected_at DESC LIMIT 100`,
  ).all() as any[];
  const cnt = (o: string) => signals.filter((s) => s.outcome === o).length;
  const total = (sqlite.prepare(`SELECT count(*) c FROM crypto_signals`).get() as any)?.c ?? 0;
  const graded = total - cnt("OPEN");
  return {
    signals: signals.map((s) => ({
      ...s,
      features: safeParse(s.features_json),
      risk: safeParse(s.risk_json),
    })),
    stats: {
      total, open: cnt("OPEN"), hit5m: cnt("HIT_5M"), doubled: cnt("DOUBLED"),
      rugged: cnt("RUGGED"), dead: cnt("DEAD"),
      calibrated: graded >= 50,
    },
  };
}

function safeParse(s: any): any {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}
