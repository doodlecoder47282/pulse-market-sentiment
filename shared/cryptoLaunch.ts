// shared/cryptoLaunch.ts
//
// Launch and ownership evidence for one Solana token, from public RPC reads.
// Pure functions: the server collects raw RPC results and passes them in.
//
// Descriptive only. Nothing here is a gate, a score input or a rule. Each
// fact says what was read and what was not:
//   ok        read completely
//   partial   read, but the history is longer than we page through; the
//             earliest transaction was NOT reached, so nothing about "the
//             launch" is stated
//   unread    the read failed or returned nothing usable
// "Same-slot transactions" are transactions that touched the mint in the
// same block as the earliest one we found. That count includes the mint
// creation, pool setup and buys by anyone; it is a clue worth a look, not
// evidence of coordination or common control.

export type EvidenceState = "ok" | "partial" | "unread";

/** One row of getSignaturesForAddress. */
export interface SigRow { slot: number; err: unknown; blockTime?: number | null; signature?: string }

export interface SlotEvidence {
  state: EvidenceState;
  reason: string | null;
  signaturesRead: number;
  /** Slot of the earliest transaction found (null unless the oldest was reached). */
  firstSlot: number | null;
  firstBlockTime: number | null;
  /** Signature of the earliest SUCCESSFUL transaction found (the anchor for the creator lookup). */
  anchorSignature: string | null;
  /** Successful transactions that touched the mint in the first slot / first three slots. */
  sameSlotTx: number | null;
  firstThreeSlotsTx: number | null;
  failedTxInFirstThreeSlots: number | null;
  caveats: string[];
}

const SLOT_CAVEATS = [
  "counts include the mint creation, pool setup and buys by any wallet; a clue to inspect, not proof of coordination or common control",
  "only transactions that name the mint account are listed; buys routed without naming it are not counted",
];

/**
 * `rows` are newest-first as the RPC returns them. `reachedOldest` is true only
 * when the final page was shorter than the page size (the RPC ran out of
 * history); otherwise the earliest transaction was not reached.
 */
export function slotEvidence(rows: SigRow[], reachedOldest: boolean, pageLimit: number): SlotEvidence {
  const base = { signaturesRead: rows.length, firstSlot: null, firstBlockTime: null, anchorSignature: null, sameSlotTx: null, firstThreeSlotsTx: null, failedTxInFirstThreeSlots: null, caveats: SLOT_CAVEATS };
  const valid = rows.filter((r) => r && Number.isInteger(r.slot) && r.slot > 0);
  if (valid.length === 0) return { state: "unread", reason: rows.length ? "the RPC rows carried no usable slot" : "the RPC returned no transactions for this mint", ...base };
  if (!reachedOldest) {
    return { state: "partial", reason: `this mint has more than ${pageLimit} transactions; the earliest was not reached, so nothing about the launch block is stated`, ...base };
  }
  // Anchor on the earliest SUCCESSFUL transaction: a failed attempt that names the mint is not the launch.
  // Rows are newest-first, so among equal slots the later row is the earlier transaction.
  const okRows = valid.filter((r) => r.err == null);
  if (okRows.length === 0) return { state: "unread", reason: "every transaction found for this mint failed; no launch block can be stated", ...base };
  let anchor = okRows[0];
  for (const r of okRows) if (r.slot <= anchor.slot) anchor = r;
  const sig = typeof anchor.signature === "string" && anchor.signature.length > 0 ? anchor.signature : null;
  if (!sig) return { state: "unread", reason: "the earliest transaction carried no signature", ...base };
  const first = anchor.slot;
  const early = valid.filter((r) => r.slot >= first && r.slot <= first + 2);
  const ok = (r: SigRow) => r.err == null;
  const t0 = valid.filter((r) => r.slot === first).map((r) => r.blockTime).find((t) => typeof t === "number") ?? null;
  return {
    state: "ok", reason: null, signaturesRead: rows.length, firstSlot: first, firstBlockTime: t0, anchorSignature: sig,
    sameSlotTx: valid.filter((r) => r.slot === first && ok(r)).length,
    firstThreeSlotsTx: early.filter(ok).length,
    failedTxInFirstThreeSlots: early.filter((r) => !ok(r)).length,
    caveats: SLOT_CAVEATS,
  };
}

export interface CreatorEvidence {
  state: EvidenceState;
  reason: string | null;
  /** Fee payer (first signer) of the earliest transaction found: usually the creator, not proven to be. */
  feePayer: string | null;
  /** Token the fee payer holds now, as a percent of supply (null when unread). */
  holdsPctOfSupply: number | null;
  /** True when the wallet holds something but less than 0.01% (holdsPctOfSupply is then 0.01, shown as "under"). */
  holdsLessThanStep?: boolean;
  caveats: string[];
}

const CREATOR_CAVEATS = [
  "the fee payer of the earliest transaction is usually the creator but is not proof of who controls the token",
  "a wallet's holding now says nothing about what it held earlier or what it holds through other wallets",
];

export function creatorEvidence(i: { feePayer: unknown; feePayerTokenUi: number | null; supplyUi: number | null; slot: SlotEvidence; txFetched?: boolean }): CreatorEvidence {
  const wallet = typeof i.feePayer === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(i.feePayer) ? i.feePayer : null;
  if (i.slot.state !== "ok") return { state: i.slot.state === "partial" ? "partial" : "unread", reason: i.slot.reason, feePayer: null, holdsPctOfSupply: null, caveats: CREATOR_CAVEATS };
  if (!wallet) return { state: "unread", reason: i.txFetched === false ? "the earliest transaction could not be fetched from the RPC" : "the earliest transaction did not expose a fee payer", feePayer: null, holdsPctOfSupply: null, caveats: CREATOR_CAVEATS };
  const sup = i.supplyUi, amt = i.feePayerTokenUi;
  if (sup == null || !Number.isFinite(sup) || sup <= 0 || amt == null || !Number.isFinite(amt) || amt < 0) {
    return { state: "partial", reason: "the wallet was found but its holding or the supply could not be read", feePayer: wallet, holdsPctOfSupply: null, caveats: CREATOR_CAVEATS };
  }
  if (amt > sup * 1.001) {
    return { state: "partial", reason: "the wallet's holding exceeds the supply read (the two reads were taken at different moments); no percentage is stated", feePayer: wallet, holdsPctOfSupply: null, caveats: CREATOR_CAVEATS };
  }
  const raw = (amt / sup) * 100;
  // A real but tiny holding is never shown as 0: report it as the smallest step.
  const pct = amt > 0 && raw < 0.01 ? 0.01 : Math.round(raw * 100) / 100;
  return { state: "ok", reason: null, feePayer: wallet, holdsPctOfSupply: Math.min(100, pct), holdsLessThanStep: amt > 0 && raw < 0.01, caveats: CREATOR_CAVEATS };
}

export interface LaunchEvidence { slot: SlotEvidence; creator: CreatorEvidence }

/** Sum of a parsed getTokenAccountsByOwner result for one mint, in UI units; null when the shape is unexpected. */
export function sumOwnerTokenUi(result: unknown): number | null {
  const value = (result as any)?.value;
  if (!Array.isArray(value)) return null;
  let total = 0;
  for (const a of value) {
    const ui = (a as any)?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    const s = (a as any)?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString;
    const n = typeof ui === "number" ? ui : typeof s === "string" ? Number(s) : NaN;
    if (!Number.isFinite(n) || n < 0) return null;
    total += n;
  }
  return total;
}

/** First signer from a parsed getTransaction result; null when the shape is unexpected. */
export function feePayerOf(tx: unknown): string | null {
  const keys = (tx as any)?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const k = keys[0];
  const pk = typeof k === "string" ? k : k?.pubkey;
  const signer = typeof k === "string" ? true : k?.signer === true;
  return typeof pk === "string" && signer ? pk : null;
}
