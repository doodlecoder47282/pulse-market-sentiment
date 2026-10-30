// server/solanaToken.ts
//
// On-chain facts about a Solana token from public, keyless RPC: mint and
// freeze authorities, supply, and holder concentration. One implementation
// and one rate budget shared by the meme scanner (cryptoEngine.ts) and the
// community watch (cryptoCommunity.ts).
//
// Method-aware routing, verified live:
//   - publicnode serves getAccountInfo keylessly (authorities + supply via
//     parsed mint data) but gates "indexed" methods (getTokenLargestAccounts)
//     behind a personal token.
//   - mainnet-beta serves indexed methods but 429s on bursts, so holder
//     concentration is one gentle call per caller tick with a shared cooldown
//     after any 429, and it is non-fatal: authorities alone complete a read.
//     The scanner (45 s tick) and the community watch (60 s tick) each make
//     at most one indexed call per tick, so about two a minute in all.
//     The owner-triggered autopsy adds up to six indexed calls per run (gap 20 s,
//     time-boxed to 20 s) and reports any 429 to the same cooldown.
// A fact that could not be read is null with a state, never a value.

import { holderConcentration, observedNumber, type DexPool, type HolderAccount } from "./cryptoStats";

export const RPC_ACCOUNT = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
export const RPC_INDEXED = ["https://api.mainnet-beta.solana.com"];
let rpcId = 1;
let indexedCooldownUntil = 0; // set after a 429: back off 5 min, shared by every caller
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Any caller that sees a 429 from the indexed RPC starts the shared 5-minute back-off. */
export function noteIndexedRateLimit(e: unknown, now = Date.now()): void {
  if (/429/.test(String((e as any)?.message ?? e))) indexedCooldownUntil = now + 5 * 60_000;
}

export function indexedRpcAvailable(now = Date.now()): boolean {
  return now > indexedCooldownUntil;
}

export async function solRpc(method: string, params: any[], urls: string[]): Promise<any> {
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

export interface TokenFacts {
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  supplyUi: number | null;
  /** Top-10 holders' share of supply excluding identified pool vaults and burns; null with the state below. */
  top10Pct: number | null;
  top10Method: string | null;
  /** ok: read; skipped: indexed RPC not attempted this call (budget or cooldown); unavailable: the read failed. */
  concentration: "ok" | "skipped" | "unavailable";
  concentrationError: string | null;
}

/**
 * Authorities and supply from one parsed mint read (critical path), then,
 * when `withConcentration` and the indexed RPC is not cooling down, the
 * largest accounts and their owners for holder concentration (best effort).
 * Throws only when the mint account itself cannot be read.
 */
export async function readTokenFacts(tokenAddress: string, pools: DexPool[], opts: { withConcentration?: boolean } = {}): Promise<TokenFacts> {
  const acct = await solRpc("getAccountInfo", [tokenAddress, { encoding: "jsonParsed" }], RPC_ACCOUNT);
  const info = acct?.value?.data?.parsed?.info;
  if (!info) throw new Error("mint account not parseable");
  const total = Number(info.supply ?? 0);
  const decimals = Number(info.decimals ?? 0);
  const supplyUi = Number.isFinite(decimals) && total > 0 ? total / Math.pow(10, decimals) : null;
  const out: TokenFacts = {
    mintAuthorityActive: info.mintAuthority != null,
    freezeAuthorityActive: info.freezeAuthority != null,
    supplyUi,
    top10Pct: null, top10Method: null, concentration: "skipped", concentrationError: null,
  };
  if (!opts.withConcentration || !(supplyUi && supplyUi > 0) || !indexedRpcAvailable()) return out;
  try {
    await sleep(800);
    const largest = await solRpc("getTokenLargestAccounts", [tokenAddress], RPC_INDEXED);
    const accts: any[] = largest?.value ?? [];
    if (accts.length === 0) { out.concentration = "unavailable"; out.concentrationError = "no token accounts returned"; return out; }
    // Exclude only IDENTIFIED pool vaults and burned supply, never "the
    // largest account" by rank (a whale or the deployer at the top is what
    // this flag exists to catch). Owners come from one non-indexed read.
    const holders: HolderAccount[] = accts.map((a: any) => ({
      address: String(a?.address ?? ""),
      uiAmount: observedNumber(a?.uiAmountString ?? a?.uiAmount),
    }));
    try {
      const multi = await solRpc("getMultipleAccounts", [holders.map((h) => h.address), { encoding: "jsonParsed" }], RPC_ACCOUNT);
      const vals: any[] = multi?.value ?? [];
      holders.forEach((h, i) => { h.owner = vals[i]?.data?.parsed?.info?.owner ?? null; });
    } catch { /* owners optional: reserve matching still identifies pools */ }
    const conc = holderConcentration(holders, pools, supplyUi);
    out.top10Pct = conc.top10Pct;
    out.top10Method = conc.method;
    out.concentration = conc.top10Pct == null ? "unavailable" : "ok";
    if (conc.top10Pct == null) out.concentrationError = conc.method;
  } catch (e: any) {
    if (/429/.test(String(e?.message))) indexedCooldownUntil = Date.now() + 5 * 60_000;
    out.concentration = "unavailable";
    out.concentrationError = String(e?.message ?? e).slice(0, 100);
  }
  return out;
}
