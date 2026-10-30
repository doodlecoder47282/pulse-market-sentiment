// Launch and ownership evidence (shared/cryptoLaunch.ts): what is established,
// what is partial, what is unread; shape parsers fail closed; no verdict language.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { slotEvidence, creatorEvidence, sumOwnerTokenUi, feePayerOf, type SigRow } from "../../shared/cryptoLaunch";

const WALLET = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const r = (slot: number, err: unknown = null, blockTime: number | null = 1_700_000_000 + slot): SigRow => ({ slot, err, blockTime });

test("slot evidence: counts transactions in the earliest slot and the first three slots; failed ones are counted separately, never as buys", () => {
  const rows = [r(105), r(103), r(101), r(101), r(101, { InstructionError: 1 }), r(100), r(100), r(102, { err: 1 })];
  const e = slotEvidence(rows, true, 3000);
  assert.equal(e.state, "ok");
  assert.equal(e.firstSlot, 100);
  assert.equal(e.sameSlotTx, 2);
  assert.equal(e.firstThreeSlotsTx, 4, "slots 100-102, successful only: 100,100,101,101");
  assert.equal(e.failedTxInFirstThreeSlots, 2);
  assert.equal(e.signaturesRead, 8);
  assert.equal(e.firstBlockTime, 1_700_000_100);
});

test("slot evidence: when the earliest transaction was not reached nothing about the launch is stated", () => {
  const e = slotEvidence([r(500), r(499)], false, 3000);
  assert.equal(e.state, "partial");
  assert.equal(e.firstSlot, null);
  assert.equal(e.sameSlotTx, null);
  assert.match(String(e.reason), /earliest was not reached/);
});

test("slot evidence: empty and malformed rows are unread, not zero", () => {
  const empty = slotEvidence([], true, 3000);
  assert.equal(empty.state, "unread");
  assert.equal(empty.sameSlotTx, null);
  assert.match(String(empty.reason), /no transactions/);
  const bad = slotEvidence([{ slot: NaN, err: null }, { slot: -4, err: null }, { slot: 1.5, err: null }] as SigRow[], true, 3000);
  assert.equal(bad.state, "unread");
  assert.match(String(bad.reason), /no usable slot/);
});

test("slot evidence carries its caveats and says nothing about coordination", () => {
  const e = slotEvidence([r(10)], true, 3000);
  assert.ok(e.caveats.some((c) => /not proof of coordination/.test(c)));
  const src = readFileSync(new URL("../../shared/cryptoLaunch.ts", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/**")).join("\n");
  assert.doesNotMatch(code, /bundle[d]?\b.*(detected|confirmed)|rug pull|scam|insider detected|will |should buy|expect/i);
});

test("creator evidence: percent of supply is arithmetic on what was read; every missing input is named", () => {
  const ok = slotEvidence([r(10), r(10)], true, 3000);
  const c = creatorEvidence({ feePayer: WALLET, feePayerTokenUi: 50_000_000, supplyUi: 1_000_000_000, slot: ok });
  assert.equal(c.state, "ok");
  assert.equal(c.holdsPctOfSupply, 5);
  assert.equal(creatorEvidence({ feePayer: WALLET, feePayerTokenUi: 0, supplyUi: 1e9, slot: ok }).holdsPctOfSupply, 0, "observed zero is a zero holding");
  assert.equal(creatorEvidence({ feePayer: WALLET, feePayerTokenUi: 3, supplyUi: 3, slot: ok }).holdsPctOfSupply, 100);
  assert.equal(creatorEvidence({ feePayer: WALLET, feePayerTokenUi: 1e12, supplyUi: 1e9, slot: ok }).holdsPctOfSupply, 100, "never above 100");
  for (const [amt, sup] of [[null, 1e9], [5, null], [5, 0], [-1, 1e9], [NaN, 1e9], [5, NaN]] as const) {
    const x = creatorEvidence({ feePayer: WALLET, feePayerTokenUi: amt as any, supplyUi: sup as any, slot: ok });
    assert.equal(x.state, "partial");
    assert.equal(x.holdsPctOfSupply, null);
    assert.equal(x.feePayer, WALLET, "the wallet is still shown when only the holding is unread");
  }
  assert.equal(creatorEvidence({ feePayer: "not-a-wallet", feePayerTokenUi: 1, supplyUi: 2, slot: ok }).state, "unread");
  assert.equal(creatorEvidence({ feePayer: null, feePayerTokenUi: null, supplyUi: 2, slot: ok }).state, "unread");
});

test("creator evidence is not established when the launch block was not reached", () => {
  const partial = slotEvidence([r(500)], false, 3000);
  const c = creatorEvidence({ feePayer: WALLET, feePayerTokenUi: 5, supplyUi: 10, slot: partial });
  assert.equal(c.state, "partial");
  assert.equal(c.feePayer, null, "a later wallet is never presented as the earliest fee payer");
  assert.equal(creatorEvidence({ feePayer: WALLET, feePayerTokenUi: 5, supplyUi: 10, slot: slotEvidence([], true, 3000) }).state, "unread");
});

test("RPC shape parsers fail closed", () => {
  const acct = (ui: any, s?: any) => ({ account: { data: { parsed: { info: { tokenAmount: { uiAmount: ui, uiAmountString: s } } } } } });
  assert.equal(sumOwnerTokenUi({ value: [acct(2), acct(3.5)] }), 5.5);
  assert.equal(sumOwnerTokenUi({ value: [] }), 0, "a wallet with no token account holds 0 of it: an observed answer");
  assert.equal(sumOwnerTokenUi({ value: [acct(null, "7.25")] }), 7.25);
  assert.equal(sumOwnerTokenUi({ value: [acct(2), acct(null, "x")] }), null);
  assert.equal(sumOwnerTokenUi({ value: [acct(-1)] }), null);
  assert.equal(sumOwnerTokenUi({ value: [{}] }), null);
  for (const bad of [null, undefined, {}, { value: "x" }, 5]) assert.equal(sumOwnerTokenUi(bad), null);

  const tx = (k: any) => ({ transaction: { message: { accountKeys: k } } });
  assert.equal(feePayerOf(tx([{ pubkey: WALLET, signer: true, writable: true }, { pubkey: "x", signer: false }])), WALLET);
  assert.equal(feePayerOf(tx([WALLET])), WALLET);
  assert.equal(feePayerOf(tx([{ pubkey: WALLET, signer: false }])), null, "the first key must be a signer");
  for (const bad of [null, {}, tx([]), tx("x"), tx([{}]), tx([5])]) assert.equal(feePayerOf(bad), null);
});

test("the autopsy reads the launch evidence without storing anything and exposes it on the response", () => {
  const src = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  const fnStart = src.indexOf("async function readLaunchEvidence");
  const fnEnd = src.indexOf("export async function runCryptoAutopsy", fnStart);
  const body = src.slice(fnStart, fnEnd);
  for (const forbidden of [/persistSignal\(/, /sqlite\./, /INSERT/i, /tracked\.set\(/, /hist\.push\(/]) assert.doesNotMatch(body, forbidden, String(forbidden));
  assert.match(body, /indexedRpcAvailable\(\)/, "respects the shared indexed-RPC cooldown");
  assert.match(body, /LAUNCH_MAX_PAGES/, "bounded paging");
  assert.match(src, /launch,\n      sourceNotes,/);
});
