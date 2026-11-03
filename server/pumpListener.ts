// server/pumpListener.ts
//
// Free, keyless pump.fun launch listener. One websocket to the public Solana
// RPC, logsSubscribe on the pump.fun program. Every create starts a launch
// record; buys in the launch block and the next two are recorded by wallet;
// later bonding-curve trades by those wallets are followed so the card can
// say what they still hold. Records persist to SQLite (3 days).
//
// The public endpoint closes the socket every 30-45 s (measured 2026-11-03);
// the listener reconnects at once and records each gap, so a launch that
// overlapped a gap is "partial" and a launch inside a gap reads as missed,
// never as "no bundle".
//
// Off switch: BATCAVE_PUMP_LISTENER=off. Inbound traffic is roughly 300
// messages a second per socket (BATCAVE_PUMP_SOCKETS, default 2).

import WebSocket from "ws";
import { sqlite } from "./storage";
import {
  PUMP_PROGRAM_ID, LAUNCH_WINDOW_SLOTS, eventsFromLogs, newLaunch, applyTrade, bundleFromLaunch,
  type LaunchRecord,
} from "../shared/pumpEvents";
import type { CardBundle } from "../shared/cryptoBundle";

const WS_URL = process.env.BATCAVE_PUMP_WS_URL || "wss://api.mainnet-beta.solana.com";
const FOLLOW_MS = 6 * 3600_000;      // follow window buyers for 6 h in memory
const KEEP_MS = 3 * 86400_000;       // keep records 3 days on disk
const MAX_LIVE = 20_000;
const FLUSH_MS = 30_000;

interface Gap { from: number; to: number | null }

const live = new Map<string, LaunchRecord>();
const dirty = new Set<string>();
const gaps: Gap[] = [];
let ws: WebSocket | null = null;
let startedAt: number | null = null;
let connected = false;
let lastMsgAt = 0;
let lastSlot = 0;
let msgs = 0;
let launches = 0;
let reconnects = 0;
let lastError: string | null = null;
let stopped = false;
let ready = false;

function ensureTable(): void {
  if (ready) return;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS pump_launches (
    mint TEXT PRIMARY KEY, launch_slot INTEGER NOT NULL, launched_at INTEGER NOT NULL,
    record_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS pump_listener_gaps (from_ms INTEGER PRIMARY KEY, to_ms INTEGER)`);
  ready = true;
}

function openGap(now: number): void {
  if (gaps.length && gaps[gaps.length - 1].to == null) return;
  gaps.push({ from: now, to: null });
  // Any launch whose window is still open now has a hole in it.
  for (const r of live.values()) if (r.windowClosedSlot == null) { r.gapInWindow = true; dirty.add(r.mint); }
}
function closeGap(now: number): void {
  const g = gaps[gaps.length - 1];
  if (g && g.to == null) {
    g.to = now;
    try { sqlite.prepare("INSERT OR REPLACE INTO pump_listener_gaps (from_ms, to_ms) VALUES (?, ?)").run(g.from, g.to); } catch { /* best effort */ }
  }
  while (gaps.length > 5000 || (gaps.length && gaps[0].to != null && now - (gaps[0].to as number) > KEEP_MS)) gaps.shift();
}

function onNotification(j: any): void {
  const v = j?.params?.result?.value;
  const slot = Number(j?.params?.result?.context?.slot);
  if (!v || !Number.isFinite(slot)) return;
  msgs++;
  const now = Date.now();
  lastMsgAt = now;
  if (slot > lastSlot) lastSlot = slot;
  if (v.err != null) return;
  for (const e of eventsFromLogs(v.logs)) {
    if (e.kind === "create") {
      if (!live.has(e.mint)) { live.set(e.mint, newLaunch(e, slot)); launches++; dirty.add(e.mint); }
    } else {
      const r = live.get(e.mint);
      if (r) { applyTrade(r, e, slot); dirty.add(r.mint); }
    }
  }
  // Close windows the stream has moved past (2 slots of slack for ordering).
  for (const r of live.values()) {
    if (r.windowClosedSlot == null && lastSlot >= r.launchSlot + LAUNCH_WINDOW_SLOTS + 2) { r.windowClosedSlot = lastSlot; dirty.add(r.mint); }
  }
}

// Two overlapping sockets: the public endpoint drops each one every few
// seconds to a minute, at different moments, so a pair covers each other's
// gaps. Messages are de-duplicated by signature; a gap is when both are down.
const SOCKETS = Math.max(1, Math.min(3, Number(process.env.BATCAVE_PUMP_SOCKETS) || 2));
const socks: Array<WebSocket | null> = [];
const up: boolean[] = [];
let seenA = new Set<string>();
let seenB = new Set<string>();
function firstSight(sig: string): boolean {
  if (seenA.has(sig) || seenB.has(sig)) return false;
  seenA.add(sig);
  if (seenA.size > 50_000) { seenB = seenA; seenA = new Set(); }
  return true;
}

function connect(idx: number): void {
  if (stopped) return;
  const sock = new WebSocket(WS_URL, { handshakeTimeout: 10_000 });
  socks[idx] = sock;
  ws = sock;
  let ping: NodeJS.Timeout | null = null;
  sock.on("open", () => {
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: "confirmed" }] }));
    ping = setInterval(() => { try { sock.ping(); } catch { /* closed */ } }, 15_000);
  });
  sock.on("message", (m) => {
    let j: any;
    try { j = JSON.parse(m.toString()); } catch { return; }
    if (j?.error) { lastError = String(j.error?.message ?? "subscribe error").slice(0, 120); return; }
    if (j?.method !== "logsNotification") return;
    if (!up[idx]) { up[idx] = true; if (!connected) { connected = true; closeGap(Date.now()); } }
    const sig = j?.params?.result?.value?.signature;
    if (typeof sig === "string" && !firstSight(sig)) { lastMsgAt = Date.now(); return; }
    onNotification(j);
  });
  sock.on("error", (e) => { lastError = String((e as any)?.message ?? e).slice(0, 120); });
  sock.on("close", () => {
    if (ping) clearInterval(ping);
    up[idx] = false;
    if (connected && !up.some(Boolean)) { connected = false; openGap(lastMsgAt || Date.now()); }
    reconnects++;
    if (!stopped) setTimeout(() => connect(idx), 300);
  });
}

function flush(): void {
  const now = Date.now();
  try {
    ensureTable();
    const up = sqlite.prepare("INSERT OR REPLACE INTO pump_launches (mint, launch_slot, launched_at, record_json, updated_at) VALUES (?, ?, ?, ?, ?)");
    const tx = sqlite.transaction((keys: string[]) => {
      for (const k of keys) { const r = live.get(k); if (r) up.run(r.mint, r.launchSlot, r.launchedAt, JSON.stringify(r), now); }
    });
    tx([...dirty]);
    dirty.clear();
    sqlite.prepare("DELETE FROM pump_launches WHERE launched_at < ?").run(now - KEEP_MS);
  } catch (e: any) { lastError = `store: ${String(e?.message ?? e).slice(0, 100)}`; }
  for (const [k, r] of live) if (now - r.launchedAt > FOLLOW_MS) live.delete(k);
  if (live.size > MAX_LIVE) {
    const sorted = [...live.values()].sort((a, b) => a.launchedAt - b.launchedAt);
    for (const r of sorted.slice(0, live.size - MAX_LIVE)) live.delete(r.mint);
  }
}

export function startPumpListener(): void {
  if (startedAt != null || (process.env.BATCAVE_PUMP_LISTENER ?? "").toLowerCase() === "off") return;
  ensureTable();
  startedAt = Date.now();
  // Restore recent records (so a restart keeps following) and past gaps.
  try {
    const rows = sqlite.prepare("SELECT record_json FROM pump_launches WHERE launched_at > ?").all(Date.now() - FOLLOW_MS) as Array<{ record_json: string }>;
    for (const row of rows) { try { const r = JSON.parse(row.record_json) as LaunchRecord; live.set(r.mint, r); } catch { /* skip */ } }
  } catch { /* fresh table */ }
  for (let i = 0; i < SOCKETS; i++) setTimeout(() => connect(i), i * 7_000);
  setInterval(flush, FLUSH_MS).unref?.();
  console.log(`[pump] listener started (${new URL(WS_URL).hostname}); restored ${live.size} recent launches`);
}

export function stopPumpListener(): void { stopped = true; for (const k of socks) { try { k?.close(); } catch { /* */ } } }

/** Throws when the stream is not delivering; used by the crypto health strip. */
export function pumpListenerCheck(now = Date.now()): void {
  if (startedAt == null) throw new Error("pump.fun listener is off (BATCAVE_PUMP_LISTENER=off)");
  if (now - startedAt < 30_000) return;
  if (!lastMsgAt || now - lastMsgAt > 60_000) throw new Error(`pump.fun stream silent for ${lastMsgAt ? Math.round((now - lastMsgAt) / 1000) + " s" : "since start"}${lastError ? ` (${lastError})` : ""}`);
}

export function pumpListenerStatus(now = Date.now()) {
  const hour = now - 3600_000;
  const recentGaps = gaps.filter((g) => (g.to ?? now) > hour);
  const gapMs = recentGaps.reduce((a, g) => a + Math.max(0, (g.to ?? now) - Math.max(g.from, hour)), 0);
  const span = startedAt == null ? 0 : Math.min(3600_000, now - startedAt);
  return {
    running: startedAt != null, connected, sockets: SOCKETS, socketsUp: up.filter(Boolean).length, startedAt, lastMsgAt: lastMsgAt || null, lastSlot: lastSlot || null,
    messages: msgs, launchesSeen: launches, liveRecords: live.size, reconnects,
    gapsLastHour: recentGaps.length, coverageLastHourPct: span > 0 ? Math.round(1000 * (1 - gapMs / span)) / 10 : null,
    lastError,
  };
}

function inGap(t: number): boolean {
  for (const g of gaps) if (t >= g.from - 2000 && t <= (g.to ?? Date.now()) + 2000) return true;
  try {
    const row = sqlite.prepare("SELECT 1 FROM pump_listener_gaps WHERE from_ms <= ? AND (to_ms IS NULL OR to_ms >= ?) LIMIT 1").get(t + 2000, t - 2000);
    return !!row;
  } catch { return false; }
}

function loadRecord(mint: string): LaunchRecord | null {
  const r = live.get(mint);
  if (r) return r;
  try {
    ensureTable();
    const row = sqlite.prepare("SELECT record_json FROM pump_launches WHERE mint = ?").get(mint) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as LaunchRecord : null;
  } catch { return null; }
}

/**
 * Bundle facts for a mint from the listener's record, or an "unread" result
 * that says exactly why there is none. `launchedAtGuess` is the pair's
 * creation time from DexScreener (ms), used only to explain a miss.
 */
export function launchBundle(mint: string, launchedAtGuess: number | null, graduated: boolean, now = Date.now()): CardBundle {
  const r = loadRecord(mint);
  if (r) return bundleFromLaunch(r, now, graduated);
  const unread = (reason: string): CardBundle => ({
    state: "unread", reason, source: "pump.fun stream", creatorBoughtPct: null, sameBlockWallets: null, sameBlockPct: null,
    windowWallets: null, windowPct: null, stillHeldPct: null, readAt: now, caveats: [],
  });
  if (startedAt == null) return unread("the pump.fun listener is off");
  if (!/pump$/.test(mint)) return unread("not a pump.fun launch; the listener covers pump.fun only");
  if (launchedAtGuess != null && launchedAtGuess < startedAt - 60_000) return unread("launched before the listener started");
  if (launchedAtGuess != null && inGap(launchedAtGuess)) return unread("the stream was reconnecting when this coin launched");
  return unread("no pump.fun launch event was seen for this coin");
}
