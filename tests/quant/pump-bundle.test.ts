import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function fromB58(s: string): Buffer {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  let out = Buffer.from(hex, "hex");
  for (const ch of s) { if (ch === "1") out = Buffer.concat([Buffer.from([0]), out]); else break; }
  return Buffer.concat([Buffer.alloc(Math.max(0, 32 - out.length)), out]).subarray(-32);
}
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const str = (s: string) => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };

const MINT = "5AYq5nYv9VBKFkgohNKducRFQPYitmMsMZntK9Z6pump";
const CURVE = "7J9cdosid6jjDyHio93MHcdoKaEJUMzB2BgC2erERfw2";
const DEV = "4e6CeA9Qhkbt4WoftTJitFq3U7gKhiTeBCMSvsspFXGf";
const W1 = "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s";
const W2 = "41BGcULsZnVrYfCmDAiN11GzriRs53NLpLZDm7LYJEUe";
const W3 = "3PLgUvTZ3tmQYRq8UjyQyQoMPu1a7E8VJNr95MSku5GK";

function createLog(): string {
  const b = Buffer.concat([
    Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]), str("Pear"), str("PEAR"), str("https://ipfs.io/x"),
    fromB58(MINT), fromB58(CURVE), fromB58(DEV), fromB58(DEV), i64(1793750159n),
    u64(1n), u64(2n), u64(3n), u64(1_000_000_000_000_000n), Buffer.alloc(84),
  ]);
  return "Program data: " + b.toString("base64");
}
function tradeLog(user: string, tokens: number, isBuy: boolean, sol = 0.5): string {
  const b = Buffer.concat([
    Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]), fromB58(MINT), u64(BigInt(Math.round(sol * 1e9))),
    u64(BigInt(Math.round(tokens * 1e6))), Buffer.from([isBuy ? 1 : 0]), fromB58(user), i64(1793750160n), Buffer.alloc(120),
  ]);
  return "Program data: " + b.toString("base64");
}

test("pump events: create and trade decode to the verified layout; base58 round-trips", async () => {
  const { eventsFromLogs, base58 } = await import("../../shared/pumpEvents");
  assert.equal(base58(fromB58(MINT)), MINT);
  const [c] = eventsFromLogs(["Program log: Instruction: CreateV2", createLog()]);
  assert.equal(c.kind, "create");
  if (c.kind !== "create") return;
  assert.equal(c.mint, MINT); assert.equal(c.bondingCurve, CURVE); assert.equal(c.creator, DEV);
  assert.equal(c.symbol, "PEAR"); assert.equal(c.totalSupply, 1_000_000_000);
  const [t] = eventsFromLogs([tradeLog(W1, 25_000_000, true, 1.25)]);
  assert.deepEqual({ ...t, timestamp: 0 }, { kind: "trade", mint: MINT, solAmount: 1.25, tokenAmount: 25_000_000, isBuy: true, user: W1, timestamp: 0 });
  assert.deepEqual(eventsFromLogs(["Program data: AAAA", "Program data: !!!", 5 as any]), []);
});

test("launch window: same-block and 3-block buyers, creator apart, later sells followed, never 0 for a real holding", async () => {
  const { eventsFromLogs, newLaunch, applyTrade, bundleFromLaunch } = await import("../../shared/pumpEvents");
  const [c] = eventsFromLogs([createLog()]);
  if (c.kind !== "create") throw new Error("decode");
  const r = newLaunch(c, 100);
  const T = (u: string, tok: number, buy: boolean) => { const [e] = eventsFromLogs([tradeLog(u, tok, buy)]); if (e.kind !== "trade") throw new Error(); return e; };
  applyTrade(r, T(DEV, 30_000_000, true), 100);   // creator buy in the create block
  applyTrade(r, T(W1, 50_000_000, true), 100);    // bundle in the launch block
  applyTrade(r, T(W2, 40_000_000, true), 100);
  applyTrade(r, T(W3, 20_000_000, true), 102);    // within 3 slots
  applyTrade(r, T(W3, 5, true), 103);             // outside the window, not a new buyer entry
  applyTrade(r, T(W1, 50_000_000, false), 140);   // W1 dumps everything later
  r.windowClosedSlot = 105;
  const b = bundleFromLaunch(r, 0);
  assert.equal(b.state, "ok");
  assert.equal(b.creatorBoughtPct, 3);
  assert.equal(b.sameBlockWallets, 2); assert.equal(b.sameBlockPct, 9);
  assert.equal(b.windowWallets, 3); assert.equal(b.windowPct, 11);
  assert.equal(b.stillHeldPct, 6); // W2 40M + W3 20M + 5 later
  // An unrelated wallet trading after the window is ignored.
  applyTrade(r, T("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", 999_000_000, true), 150);
  assert.equal(bundleFromLaunch(r, 0).windowPct, 11);
  // A gap in the window or graduation is stated, never hidden.
  r.gapInWindow = true;
  const g = bundleFromLaunch(r, 0, true);
  assert.equal(g.state, "partial");
  assert.match(g.reason ?? "", /stream dropped/);
  assert.match(g.reason ?? "", /left the bonding curve/);
});

test("card line: describes, never predicts; unread says why; partial says 'at least'", async () => {
  const { bundleLine } = await import("../../shared/cryptoBundle");
  assert.equal(bundleLine(null), "Launch buying: not checked yet");
  assert.match(bundleLine({ state: "unread", reason: "launched before the listener started", creatorBoughtPct: null, sameBlockWallets: null, sameBlockPct: null, windowWallets: null, windowPct: null, stillHeldPct: null, readAt: 0, caveats: [] }), /not read \(launched before the listener started\)/);
  const line = bundleLine({ state: "partial", reason: "x", creatorBoughtPct: 3, sameBlockWallets: 2, sameBlockPct: 9, windowWallets: 3, windowPct: 11, stillHeldPct: 6, readAt: 0, caveats: [] });
  assert.match(line, /2 other wallets bought at least 9% of supply in the launch block/);
  assert.match(line, /3 bought at least 11% in the first 3 blocks/);
  assert.match(line, /they still hold 6% of it now/);
  for (const f of ["shared/cryptoBundle.ts", "shared/pumpEvents.ts", "client/src/components/BundleRow.tsx"]) {
    const src = readFileSync(f, "utf8").toLowerCase();
    for (const w of [" expect", " will ", "edge", "high probability"]) assert.ok(!src.includes(w), `${f} contains banned word '${w.trim()}'`);
  }
});

test("rpc bundle: signers only (curve excluded), creator apart, unread with reason", async () => {
  const { bundleEvidence, buyersInTx } = await import("../../shared/cryptoBundle");
  const tb = (idx: number, owner: string, raw: string) => ({ accountIndex: idx, mint: MINT, owner, uiTokenAmount: { amount: raw, decimals: 6 } });
  const tx = (signer: string, ownerAcct: string, gain: string) => ({
    meta: { err: null, preTokenBalances: [tb(2, CURVE, "1000000000000000")], postTokenBalances: [tb(2, CURVE, "900000000000000"), tb(1, signer, gain)] },
    transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }, { pubkey: ownerAcct, signer: false }, { pubkey: "curveVault", signer: false }] } },
  });
  assert.deepEqual(buyersInTx(tx(W1, "ataW1", "50000000000000"), MINT), [{ wallet: W1, ui: 50_000_000, tokenAccounts: ["ataW1"] }]);
  const b = bundleEvidence({ mint: MINT, launchSlot: 100, creator: DEV, txInWindow: 3,
    txs: [{ slot: 100, tx: tx(DEV, "ataDev", "30000000000000") }, { slot: 100, tx: tx(W1, "ataW1", "50000000000000") }, { slot: 101, tx: tx(W2, "ataW2", "40000000000000") }],
    supplyUi: 1_000_000_000, heldNowUi: 40_000_000 });
  assert.equal(b.state, "ok");
  assert.equal(b.creatorBoughtPct, 3); assert.equal(b.sameBlockWallets, 1); assert.equal(b.sameBlockPct, 5);
  assert.equal(b.windowWallets, 2); assert.equal(b.windowPct, 9); assert.equal(b.stillHeldPct, 4);
  const u = bundleEvidence({ mint: MINT, launchSlot: null, launchReason: "history too long", creator: null, txInWindow: null, txs: [], supplyUi: 1, heldNowUi: null });
  assert.equal(u.state, "unread"); assert.equal(u.windowPct, null); assert.equal(u.reason, "history too long");
});
