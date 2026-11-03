// shared/cryptoBundle.ts
//
// Launch-block buying for one Solana token ("bundling"), from parsed
// getTransaction results the server collects. Pure functions.
//
// Descriptive only: never a gate, a score input or a rule until the graded
// record shows it separates outcomes (docs/AGENT_FRAMEWORK.md). It states
// what was read:
//   ok       every successful transaction in the launch window was read
//   partial  some were read (cap, failures); the shares are lower bounds
//   unread   nothing usable was read, with the reason
//
// Method. The launch block is the slot of the earliest successful transaction
// that names the mint (shared/cryptoLaunch.ts). In that slot and the next two,
// a "buyer" is a wallet that SIGNED a transaction and whose balance of this
// token rose in it. Accounts that are not signers (the bonding curve, pool
// vaults) are never buyers, so the initial mint to the curve is excluded. The
// creator is the fee payer of the earliest transaction; their buy is reported
// on its own line. Shares are of the supply read at the time of the check.

export type BundleState = "ok" | "partial" | "unread";

/** Slots counted as the launch window: the launch block and the next two. */
export const BUNDLE_WINDOW_SLOTS = 3;
/** Most launch-window transactions fetched per coin (credit budget). */
export const BUNDLE_MAX_TX = 40;

export interface BundleBuyer { wallet: string; slot: number; ui: number; tokenAccounts: string[] }

export interface BundleEvidence {
  state: BundleState;
  reason: string | null;
  launchSlot: number | null;
  /** Successful transactions in the window that were listed / fetched and parsed. */
  txInWindow: number | null;
  txRead: number;
  /** Creator (earliest fee payer) bought in the window, % of supply. */
  creatorBoughtPct: number | null;
  /** Other signing wallets that bought in the launch block itself. */
  sameBlockWallets: number | null;
  sameBlockPct: number | null;
  /** Other signing wallets that bought anywhere in the 3-slot window (includes the launch block). */
  windowWallets: number | null;
  windowPct: number | null;
  /** What those window wallets (excluding the creator) hold now, % of supply. */
  stillHeldPct: number | null;
  readAt: number;
  caveats: string[];
}

/** What a coin card shows: either the stream record or the RPC lookup. */
export interface CardBundle {
  state: BundleState;
  reason: string | null;
  /** "pump.fun stream" (our listener) or "rpc lookup". */
  source?: string;
  creatorBoughtPct: number | null;
  sameBlockWallets: number | null;
  sameBlockPct: number | null;
  windowWallets: number | null;
  windowPct: number | null;
  stillHeldPct: number | null;
  windowSol?: number;
  readAt: number;
  caveats: string[];
}

export const BUNDLE_CAVEATS = [
  "a buyer is a wallet that signed a transaction in which its balance of this token rose; buys through a program that holds the tokens for the wallet are not counted",
  "several wallets buying in the launch block is a pattern worth a look; it does not prove the wallets share an owner",
  "'hold now' counts only the token accounts those wallets bought into; tokens moved to other wallets read as sold",
];

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function uiOf(b: any): number | null {
  const t = b?.uiTokenAmount;
  if (!t) return null;
  if (typeof t.amount === "string" && Number.isFinite(Number(t.decimals))) {
    const raw = Number(t.amount);
    if (Number.isFinite(raw)) return raw / Math.pow(10, Number(t.decimals));
  }
  const n = typeof t.uiAmount === "number" ? t.uiAmount : Number(t.uiAmountString);
  return Number.isFinite(n) ? n : null;
}

function keyOf(k: any): { pubkey: string | null; signer: boolean } {
  if (typeof k === "string") return { pubkey: k, signer: false };
  return { pubkey: typeof k?.pubkey === "string" ? k.pubkey : null, signer: k?.signer === true };
}

/**
 * Wallets that signed `tx` and whose balance of `mint` rose in it, with the
 * token accounts that received it. Returns null when the shape is unexpected.
 */
export function buyersInTx(tx: unknown, mint: string): Array<{ wallet: string; ui: number; tokenAccounts: string[] }> | null {
  const t = tx as any;
  const meta = t?.meta;
  const keys = t?.transaction?.message?.accountKeys;
  if (!meta || !Array.isArray(keys)) return null;
  if (meta.err != null) return [];
  const signers = new Set<string>();
  const pubkeys: (string | null)[] = keys.map((k: any) => {
    const { pubkey, signer } = keyOf(k);
    if (pubkey && signer) signers.add(pubkey);
    return pubkey;
  });
  const pre = Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : [];
  const post = Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : [];
  // Per token account: post - pre (an account missing from pre started at 0).
  const preByIdx = new Map<number, number>();
  for (const b of pre) if (b?.mint === mint && Number.isInteger(b?.accountIndex)) preByIdx.set(b.accountIndex, uiOf(b) ?? 0);
  const byOwner = new Map<string, { ui: number; tokenAccounts: string[] }>();
  for (const b of post) {
    if (b?.mint !== mint || !Number.isInteger(b?.accountIndex)) continue;
    const owner = typeof b?.owner === "string" ? b.owner : null;
    if (!owner || !signers.has(owner)) continue;
    const after = uiOf(b);
    if (after == null) continue;
    const delta = after - (preByIdx.get(b.accountIndex) ?? 0);
    if (!(delta > 0)) continue;
    const acct = pubkeys[b.accountIndex];
    const cur = byOwner.get(owner) ?? { ui: 0, tokenAccounts: [] };
    cur.ui += delta;
    if (acct && !cur.tokenAccounts.includes(acct)) cur.tokenAccounts.push(acct);
    byOwner.set(owner, cur);
  }
  return [...byOwner.entries()].map(([wallet, v]) => ({ wallet, ...v }));
}

const pct = (part: number, supply: number) => {
  const raw = (part / supply) * 100;
  if (part > 0 && raw < 0.01) return 0.01; // a real holding is never shown as 0
  return Math.min(100, Math.round(raw * 100) / 100);
};

/** Aggregates the window's buyers. Pure; the server supplies every read. */
export function bundleEvidence(i: {
  mint: string;
  launchSlot: number | null;
  launchReason?: string | null;
  creator: string | null;
  /** Successful window transactions listed (before the fetch cap). */
  txInWindow: number | null;
  /** Fetched transactions, each with its slot. A null tx failed to fetch. */
  txs: Array<{ slot: number; tx: unknown | null }>;
  supplyUi: number | null;
  /** Current balances of the window buyers' token accounts, summed; null when unread. */
  heldNowUi: number | null;
  now?: number;
}): BundleEvidence & { buyers: BundleBuyer[] } {
  const readAt = i.now ?? Date.now();
  const base = {
    launchSlot: i.launchSlot, txInWindow: i.txInWindow, txRead: 0,
    creatorBoughtPct: null, sameBlockWallets: null, sameBlockPct: null, windowWallets: null, windowPct: null,
    stillHeldPct: null, readAt, caveats: BUNDLE_CAVEATS, buyers: [] as BundleBuyer[],
  };
  if (!MINT_RE.test(i.mint)) return { state: "unread", reason: "not a Solana mint address", ...base };
  if (i.launchSlot == null) return { state: "unread", reason: i.launchReason ?? "the launch block was not established", ...base };
  const supply = i.supplyUi;
  if (supply == null || !Number.isFinite(supply) || supply <= 0) return { state: "unread", reason: "the token supply could not be read", ...base };

  const buyers = new Map<string, BundleBuyer>();
  let read = 0, failed = 0, odd = 0;
  for (const { slot, tx } of i.txs) {
    if (tx == null) { failed++; continue; }
    const bs = buyersInTx(tx, i.mint);
    if (bs == null) { odd++; continue; }
    read++;
    for (const b of bs) {
      const cur = buyers.get(b.wallet);
      if (cur) {
        cur.ui += b.ui; cur.slot = Math.min(cur.slot, slot);
        for (const a of b.tokenAccounts) if (!cur.tokenAccounts.includes(a)) cur.tokenAccounts.push(a);
      } else buyers.set(b.wallet, { wallet: b.wallet, slot, ui: b.ui, tokenAccounts: [...b.tokenAccounts] });
    }
  }
  if (read === 0) {
    return { state: "unread", reason: i.txs.length === 0 ? "no launch-window transactions were listed" : `none of the ${i.txs.length} launch-window transactions could be read`, ...base };
  }
  const all = [...buyers.values()];
  const others = all.filter((b) => b.wallet !== i.creator);
  const same = others.filter((b) => b.slot === i.launchSlot);
  const creatorUi = i.creator ? (buyers.get(i.creator)?.ui ?? 0) : null;
  const sum = (xs: BundleBuyer[]) => xs.reduce((a, b) => a + b.ui, 0);

  const gaps: string[] = [];
  const listed = i.txInWindow ?? i.txs.length;
  if (listed > i.txs.length) gaps.push(`read ${i.txs.length} of ${listed} launch-window transactions (cap ${BUNDLE_MAX_TX}); shares are at least these`);
  if (failed > 0) gaps.push(`${failed} transaction${failed === 1 ? "" : "s"} could not be fetched; shares are at least these`);
  if (odd > 0) gaps.push(`${odd} transaction${odd === 1 ? "" : "s"} had an unexpected shape and were skipped`);
  let held: number | null = null;
  if (i.heldNowUi != null && Number.isFinite(i.heldNowUi) && i.heldNowUi >= 0) held = others.length === 0 ? 0 : pct(i.heldNowUi, supply);
  else if (others.length > 0) gaps.push("what the launch buyers hold now could not be read");

  return {
    ...base,
    state: gaps.length ? "partial" : "ok",
    reason: gaps.length ? gaps.join("; ") : null,
    txRead: read,
    creatorBoughtPct: creatorUi == null ? null : pct(creatorUi, supply),
    sameBlockWallets: same.length,
    sameBlockPct: pct(sum(same), supply),
    windowWallets: others.length,
    windowPct: pct(sum(others), supply),
    stillHeldPct: others.length === 0 ? 0 : held,
    buyers: all,
  };
}

/** One plain-English line for cards. Describes; never predicts. */
export function bundleLine(b: CardBundle | null | undefined): string {
  if (!b) return "Launch buying: not checked yet";
  if (b.state === "unread") return `Launch buying: not read (${b.reason ?? "no reason given"})`;
  const lb = b.state === "partial" ? "at least " : "";
  const parts: string[] = [];
  if (b.sameBlockWallets === 0 && b.windowWallets === 0) parts.push("no other wallet bought in the first 3 blocks");
  else {
    parts.push(`${b.sameBlockWallets} other wallet${b.sameBlockWallets === 1 ? "" : "s"} bought ${lb}${b.sameBlockPct}% of supply in the launch block`);
    if ((b.windowWallets ?? 0) > (b.sameBlockWallets ?? 0)) parts.push(`${b.windowWallets} bought ${lb}${b.windowPct}% in the first 3 blocks`);
    if (b.stillHeldPct != null) parts.push(`they still hold ${b.stillHeldPct}% of it now`);
  }
  if (b.creatorBoughtPct != null && b.creatorBoughtPct > 0) parts.push(`creator bought ${lb}${b.creatorBoughtPct}%`);
  return `Launch buying: ${parts.join("; ")}`;
}
