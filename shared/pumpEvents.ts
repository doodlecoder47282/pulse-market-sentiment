// shared/pumpEvents.ts
//
// Decoder for pump.fun program events carried in transaction logs
// ("Program data: <base64>", Anchor emit!), and the launch-window
// accumulator the free listener uses to record who bought in a coin's first
// blocks. Pure: no network, no clock unless passed in.
//
// Layouts (verified on live mainnet logs 2026-11-03):
//   TradeEvent  disc bddb7fd34ee661ee  mint(32) sol_amount u64 token_amount u64
//               is_buy u8 user(32) timestamp i64 ...
//   CreateEvent disc 1b72a94ddeeb6376  name str symbol str uri str mint(32)
//               bonding_curve(32) user(32) creator(32) timestamp i64
//               virtual_token_reserves u64 virtual_sol_reserves u64
//               real_token_reserves u64 token_total_supply u64 ...
// (str = u32 little-endian length + utf-8 bytes.)

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const TRADE_DISC = "bddb7fd34ee661ee";
const CREATE_DISC = "1b72a94ddeeb6376";
/** pump.fun tokens use 6 decimals. */
export const PUMP_DECIMALS = 6;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  let n = hex ? BigInt("0x" + hex) : 0n;
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}

export interface PumpTrade { kind: "trade"; mint: string; solAmount: number; tokenAmount: number; isBuy: boolean; user: string; timestamp: number }
export interface PumpCreate { kind: "create"; name: string; symbol: string; uri: string; mint: string; bondingCurve: string; user: string; creator: string; timestamp: number; totalSupply: number | null }
export type PumpEvent = PumpTrade | PumpCreate;

function fromBase64(b64: string): Uint8Array | null {
  try {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
    const bin = atob(b64); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

function hex8(b: Uint8Array): string { let s = ""; for (let i = 0; i < 8; i++) s += b[i].toString(16).padStart(2, "0"); return s; }

/** Decodes one "Program data:" payload; null when it is not a pump.fun trade/create or is malformed. */
export function decodePumpEvent(b64: string): PumpEvent | null {
  const b = fromBase64(b64);
  if (!b || b.length < 8) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const d = hex8(b);
  try {
    if (d === TRADE_DISC) {
      if (b.length < 97) return null;
      return {
        kind: "trade",
        mint: base58(b.subarray(8, 40)),
        solAmount: Number(dv.getBigUint64(40, true)) / 1e9,
        tokenAmount: Number(dv.getBigUint64(48, true)) / 10 ** PUMP_DECIMALS,
        isBuy: b[56] === 1,
        user: base58(b.subarray(57, 89)),
        timestamp: Number(dv.getBigInt64(89, true)),
      };
    }
    if (d === CREATE_DISC) {
      let o = 8;
      const str = () => {
        const len = dv.getUint32(o, true); o += 4;
        if (len > 400 || o + len > b.length) throw new Error("bad string");
        const s = new TextDecoder().decode(b.subarray(o, o + len)); o += len; return s;
      };
      const pk = () => { if (o + 32 > b.length) throw new Error("short"); const s = base58(b.subarray(o, o + 32)); o += 32; return s; };
      const name = str(), symbol = str(), uri = str();
      const mint = pk(), bondingCurve = pk(), user = pk(), creator = pk();
      const timestamp = Number(dv.getBigInt64(o, true)); o += 8;
      const totalSupply = o + 32 <= b.length ? Number(dv.getBigUint64(o + 24, true)) / 10 ** PUMP_DECIMALS : null;
      return { kind: "create", name, symbol, uri, mint, bondingCurve, user, creator, timestamp, totalSupply };
    }
  } catch { return null; }
  return null;
}

/** All pump.fun events in one transaction's logs. */
export function eventsFromLogs(logs: unknown): PumpEvent[] {
  if (!Array.isArray(logs)) return [];
  const out: PumpEvent[] = [];
  for (const l of logs) {
    if (typeof l !== "string" || !l.startsWith("Program data: ")) continue;
    const e = decodePumpEvent(l.slice(14));
    if (e) out.push(e);
  }
  return out;
}

// ── Launch window ────────────────────────────────────────────────────────

/** The launch block and the next two. */
export const LAUNCH_WINDOW_SLOTS = 3;

export interface LaunchBuy { wallet: string; slot: number; tokens: number; sol: number }

export interface LaunchRecord {
  mint: string;
  name: string;
  symbol: string;
  launchSlot: number;
  launchedAt: number; // ms
  /** Wallet that signed the create, and the creator field (often the same). */
  deployer: string;
  creator: string;
  totalSupply: number;
  /** Buys in the launch window by wallet (creator side included, flagged by wallet). */
  buys: LaunchBuy[];
  /** Tokens those window buyers (excluding the creator side) sold later, seen on the bonding curve. */
  laterSold: Record<string, number>;
  laterBought: Record<string, number>;
  /** Slot of the last stream message seen when the window closed (proves the window was watched). */
  windowClosedSlot: number | null;
  /** True when the stream dropped while the window was open. */
  gapInWindow: boolean;
}

export function newLaunch(c: PumpCreate, slot: number): LaunchRecord {
  return {
    mint: c.mint, name: c.name.slice(0, 80), symbol: c.symbol.slice(0, 24), launchSlot: slot,
    launchedAt: c.timestamp * 1000, deployer: c.user, creator: c.creator,
    totalSupply: c.totalSupply && c.totalSupply > 0 ? c.totalSupply : 1_000_000_000,
    buys: [], laterSold: {}, laterBought: {}, windowClosedSlot: null, gapInWindow: false,
  };
}

/** Applies one trade to a launch record (window buys, or later activity by window buyers). */
export function applyTrade(r: LaunchRecord, t: PumpTrade, slot: number): void {
  if (t.mint !== r.mint || slot < r.launchSlot) return;
  if (slot < r.launchSlot + LAUNCH_WINDOW_SLOTS) {
    if (t.isBuy) r.buys.push({ wallet: t.user, slot, tokens: t.tokenAmount, sol: t.solAmount });
    else r.laterSold[t.user] = (r.laterSold[t.user] ?? 0) + t.tokenAmount; // sold inside the window
    return;
  }
  if (!r.buys.some((b) => b.wallet === t.user)) return; // only follow window buyers
  if (t.isBuy) r.laterBought[t.user] = (r.laterBought[t.user] ?? 0) + t.tokenAmount;
  else r.laterSold[t.user] = (r.laterSold[t.user] ?? 0) + t.tokenAmount;
}

export interface StreamBundle {
  state: "ok" | "partial";
  reason: string | null;
  source: "pump.fun stream";
  launchSlot: number;
  launchedAt: number;
  creatorBoughtPct: number;
  sameBlockWallets: number;
  sameBlockPct: number;
  windowWallets: number;
  windowPct: number;
  /** Of the window buyers' (non-creator) launch buys, the part still held per bonding-curve trades seen since. */
  stillHeldPct: number;
  /** SOL the non-creator window buyers spent. */
  windowSol: number;
  readAt: number;
  caveats: string[];
}

const STREAM_CAVEATS = [
  "read from pump.fun's own trade events while our listener was connected; a buyer is the wallet named in the trade",
  "several wallets buying in the launch block is a pattern worth a look; it does not prove they share an owner",
  "'hold now' follows only bonding-curve trades; sells after graduation or transfers to other wallets are not seen",
];

const pct = (part: number, total: number) => {
  const raw = (part / total) * 100;
  if (part > 0 && raw < 0.01) return 0.01;
  return Math.min(100, Math.max(0, Math.round(raw * 100) / 100));
};

/** Bundle summary from a launch record. */
export function bundleFromLaunch(r: LaunchRecord, now = Date.now(), graduated = false): StreamBundle {
  const creatorSide = new Set([r.deployer, r.creator]);
  const byWallet = new Map<string, { tokens: number; sol: number; first: number }>();
  for (const b of r.buys) {
    const cur = byWallet.get(b.wallet) ?? { tokens: 0, sol: 0, first: b.slot };
    cur.tokens += b.tokens; cur.sol += b.sol; cur.first = Math.min(cur.first, b.slot);
    byWallet.set(b.wallet, cur);
  }
  let creatorTokens = 0;
  const others: Array<[string, { tokens: number; sol: number; first: number }]> = [];
  for (const [w, v] of byWallet) { if (creatorSide.has(w)) creatorTokens += v.tokens; else others.push([w, v]); }
  const same = others.filter(([, v]) => v.first === r.launchSlot);
  const sum = (xs: typeof others) => xs.reduce((a, [, v]) => a + v.tokens, 0);
  let held = 0;
  // Of what each wallet bought in the window, how much it still holds (later buys do not add).
  for (const [w, v] of others) held += Math.min(v.tokens, Math.max(0, v.tokens + (r.laterBought[w] ?? 0) - (r.laterSold[w] ?? 0)));
  const gaps: string[] = [];
  if (r.gapInWindow) gaps.push("the stream dropped during the launch window; counts are at least these");
  if (r.windowClosedSlot == null) gaps.push("the launch window is still open");
  if (graduated) gaps.push("the coin left the bonding curve; later sells are not followed, so 'hold now' is an upper bound");
  return {
    state: gaps.length ? "partial" : "ok", reason: gaps.length ? gaps.join("; ") : null,
    source: "pump.fun stream", launchSlot: r.launchSlot, launchedAt: r.launchedAt,
    creatorBoughtPct: pct(creatorTokens, r.totalSupply),
    sameBlockWallets: same.length, sameBlockPct: pct(sum(same), r.totalSupply),
    windowWallets: others.length, windowPct: pct(sum(others), r.totalSupply),
    stillHeldPct: others.length ? pct(held, r.totalSupply) : 0,
    windowSol: Math.round(others.reduce((a, [, v]) => a + v.sol, 0) * 1000) / 1000,
    readAt: now, caveats: STREAM_CAVEATS,
  };
}
