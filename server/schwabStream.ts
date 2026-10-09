// server/schwabStream.ts
//
// One server-side Schwab Streamer connection (WebSocket). Login, subscribe,
// watch the heartbeat, reconnect with backoff, log in again with a fresh
// access token on every reconnect, resubscribe, and keep dynamic option
// subscriptions in sync. Parsed data goes to server/streamStore.ts.
//
// Protocol (Schwab Trader API Streamer; shapes as implemented by schwab-py,
// https://github.com/alexgolec/schwab-py/blob/main/schwab/streaming.py and
// https://schwab-py.readthedocs.io/en/latest/streaming.html):
//   - Connection info: GET /trader/v1/userPreference -> streamerInfo[0]
//     { streamerSocketUrl, schwabClientCustomerId, schwabClientCorrelId,
//       schwabClientChannel, schwabClientFunctionId } (schwab.ts getStreamerInfo).
//   - Every request: {"requests":[{service, command, requestid,
//     SchwabClientCustomerId, SchwabClientCorrelId, parameters}]}.
//   - LOGIN: service ADMIN, parameters {Authorization: <access token>,
//     SchwabClientChannel, SchwabClientFunctionId}. Response code 0 = success;
//     code 3 = LOGIN_DENIED (also how the docs.rs `schwab` crate stops retrying,
//     https://docs.rs/crate/schwab/0.3.0).
//   - SUBS replaces a service's subscription, ADD extends it, UNSUBS removes
//     keys; parameters {keys: "A,B", fields: "0,1,2"}. A SUBS sent to extend
//     a subscription drops everything not in it, so additions use ADD
//     (https://repo.hex.pm/preview/dp_exchange_schwab/0.1.7/usage-rules.md).
//   - Server frames: {"response":[...]} (command acks), {"notify":[{"heartbeat":
//     "<ms>"}]} (keep-alive) or notify with content.code (session events), and
//     {"data":[{service, timestamp, content:[{key, delayed, "1": ...}]}]}.
//   - Limits: one streamer session per user at a time, about 500 concurrently
//     streamed keys (schwabdev docs, https://tylerebowers.github.io/Schwabdev/,
//     summarised at https://docsearch.algolia.com/mcp/docs/repo/tylerebowers/schwabdev).
//     Batcave subscribes ~16 equity/index keys, 3 chart keys and caps options
//     (default 120), far below that.
//   - Dead-socket detection: no frame (data or heartbeat) for 75 s; that is the
//     threshold Wealth-Lab's Schwab provider reports for "NoMessageReceived"
//     (https://wealth-lab.com/Discussion/Schwab-streaming-1-minute-SPX-data-missing-9-58-through-10-01-June-1-2026-13070).
//
// Not verified against a live Schwab session from this environment: index keys
// on LEVELONE_EQUITIES ($SPX, $VIX, $VIX9D) and CHART_EQUITY for $SPX. $SPX is
// added to CHART_EQUITY in its own ADD request so a rejection cannot drop
// SPY/QQQ; $SPX 1-minute bars are also synthesized from LEVELONE last prices
// (source "l1_synth"), and a chart_equity bar wins for the same minute.
//
// Security: the access token is sent only inside the LOGIN frame. Nothing here
// logs request payloads, the token, the socket URL query, or account ids.

import {
  StreamStore, fieldList, L1_EQUITY_FIELDS, L1_OPTION_FIELDS, CHART_EQUITY_FIELDS,
  setActiveStreamStore, wantedOptionSymbols, onOptionWantsChanged, DEFAULT_VALIDITY,
  type StreamBar, type StreamValidityOptions,
} from "./streamStore";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StreamerInfo {
  socketUrl: string;
  customerId: string;
  correlId: string;
  channel: string;
  functionId: string;
}

/** Parse GET /trader/v1/userPreference into streamer connection info; null when absent. */
export function parseStreamerInfo(prefs: any): StreamerInfo | null {
  const raw = Array.isArray(prefs?.streamerInfo) ? prefs.streamerInfo[0] : prefs?.streamerInfo;
  if (!raw || typeof raw !== "object") return null;
  const socketUrl = String(raw.streamerSocketUrl ?? "");
  if (!/^wss?:\/\//i.test(socketUrl)) return null;
  const info: StreamerInfo = {
    socketUrl,
    customerId: String(raw.schwabClientCustomerId ?? ""),
    correlId: String(raw.schwabClientCorrelId ?? ""),
    channel: String(raw.schwabClientChannel ?? ""),
    functionId: String(raw.schwabClientFunctionId ?? ""),
  };
  if (!info.customerId || !info.correlId) return null;
  return info;
}

/** The subset of the WebSocket API used (Node 22 global WebSocket and the `ws` package both provide it). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
}

export interface StreamDeps {
  /** Current access token (refreshing when near expiry); null when Schwab is not connected. */
  getAccessToken(): Promise<string | null>;
  /** Force a refresh check with a long lookahead (used once after LOGIN_DENIED). */
  forceTokenRefresh?(): Promise<string | null>;
  getStreamerInfo(): Promise<StreamerInfo | null>;
  createSocket(url: string): WebSocketLike;
  now?(): number;
  /** Final 1-minute bars (persistence sink). */
  onFinalBars?(bars: StreamBar[]): void;
  /** Every new last price of an equity/index (quote shield observer). */
  onLastPrice?(symbol: string, price: number, tMs: number): void;
  log?(msg: string): void;
  /** Jitter multiplier in [0.5, 1]; injectable for deterministic tests. */
  jitter?(): number;
}

export interface StreamConfig {
  equities: string[];
  tickSymbols: string[];
  synthBarSymbols: string[];
  chartSymbols: string[];
  /** Chart keys added in their own ADD (support unconfirmed). */
  chartOptionalSymbols: string[];
  maxOptionSymbols: number;
  /** Total keys across services; schwabdev reports ~500 concurrent. */
  maxTotalKeys: number;
  heartbeatTimeoutMs: number;
  loginTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** A session live this long resets the failure count. */
  stableAfterMs: number;
  /** Wait after repeated LOGIN_DENIED or a "close connection" notice. */
  deniedBackoffMs: number;
  /** Watchdog / bar flush cadence. */
  tickMs: number;
  /** Debounce for option subscription changes. */
  optionDebounceMs: number;
  tickCapacity: number;
  validity: StreamValidityOptions;
}

export const MAG7 = ["AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "TSLA"];

export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  equities: ["$SPX", "$VIX", "$VIX9D", "SPY", "QQQ", "IWM", "DIA", ...MAG7],
  tickSymbols: ["$SPX", "SPY", "$VIX"],
  synthBarSymbols: ["$SPX"],
  chartSymbols: ["SPY", "QQQ"],
  chartOptionalSymbols: ["$SPX"],
  maxOptionSymbols: 120,
  maxTotalKeys: 400,
  heartbeatTimeoutMs: 75_000,
  loginTimeoutMs: 15_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  stableAfterMs: 60_000,
  deniedBackoffMs: 5 * 60_000,
  tickMs: 5_000,
  optionDebounceMs: 250,
  tickCapacity: 120_000,
  validity: DEFAULT_VALIDITY,
};

/** Config from env (comma lists); unknown or empty values keep the defaults. */
export function streamConfigFromEnv(env: Record<string, string | undefined>): StreamConfig {
  const list = (v: string | undefined, d: string[]) => {
    const xs = String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return xs.length ? xs : d;
  };
  const int = (v: string | undefined, d: number, lo: number, hi: number) => {
    // An unset or blank variable means "use the default" (Number("") is 0, not missing).
    if (v == null || String(v).trim() === "") return d;
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : d;
  };
  const d = DEFAULT_STREAM_CONFIG;
  return {
    ...d,
    equities: list(env.BATCAVE_STREAM_EQUITIES, d.equities),
    chartSymbols: list(env.BATCAVE_STREAM_CHARTS, d.chartSymbols),
    maxOptionSymbols: int(env.BATCAVE_STREAM_MAX_OPTIONS, d.maxOptionSymbols, 0, 400),
  };
}

export type StreamState =
  | "idle" | "connecting" | "logging_in" | "live" | "backoff" | "stopped"
  | "no_token" | "no_streamer_info" | "login_denied";

/** Exponential backoff with jitter: min(max, base * 2^failures) * jitter, jitter in [0.5, 1]. */
export function backoffDelayMs(failures: number, baseMs: number, maxMs: number, jitter: number): number {
  const raw = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, failures)));
  const j = Math.min(1, Math.max(0.5, jitter));
  return Math.round(raw * j);
}

// Streamer response codes acted on (Schwab Streamer guide; 0 and 3 confirmed
// by the libraries above, the others are the guide's session-ending codes and
// are treated conservatively: any non-zero ADMIN notice ends the session).
const CODE_SUCCESS = 0;
const CODE_LOGIN_DENIED = 3;

// ─── Connection manager ──────────────────────────────────────────────────────

export class SchwabStreamer {
  readonly store: StreamStore;
  readonly cfg: StreamConfig;
  private deps: StreamDeps;
  state: StreamState = "idle";
  private ws: WebSocketLike | null = null;
  private requestId = 0;
  private loginRequestId: string | null = null;
  private loginTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private optionTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private failures = 0;
  private deniedStreak = 0;
  private liveSinceMs: number | null = null;
  private subscribedOptions = new Set<string>();
  private optionsSubscribedThisSession = false;
  private connectSeq = 0;
  reconnects = 0;
  logins = 0;
  lastError: string | null = null;
  lastErrorAtMs: number | null = null;
  nextAttemptAtMs: number | null = null;
  overCapOptions: string[] = [];
  /** Last ack per service/command: code and message (no payloads). */
  acks: Record<string, { code: number; msg: string; atMs: number }> = {};
  notices: Array<{ code: number; msg: string; atMs: number }> = [];

  constructor(deps: StreamDeps, cfg: Partial<StreamConfig> = {}) {
    this.deps = deps;
    this.cfg = { ...DEFAULT_STREAM_CONFIG, ...cfg };
    this.store = new StreamStore({
      tickSymbols: this.cfg.tickSymbols,
      synthBarSymbols: this.cfg.synthBarSymbols,
      tickCapacity: this.cfg.tickCapacity,
    });
    if (deps.onLastPrice) this.store.onLastPrice = deps.onLastPrice;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.log(m)))(`[schwab-stream] ${msg}`);
  }

  private fail(reason: string): void {
    this.lastError = reason;
    this.lastErrorAtMs = this.now();
  }

  /** Register as the active store and connect. */
  start(): void {
    this.stopped = false;
    setActiveStreamStore(this.store, this.cfg.validity);
    onOptionWantsChanged(() => this.scheduleOptionSync());
    if (!this.tickTimer) this.tickTimer = setInterval(() => this.onTick(), this.cfg.tickMs);
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.state = "stopped";
    for (const t of [this.loginTimer, this.reconnectTimer, this.optionTimer]) if (t) clearTimeout(t);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.loginTimer = this.reconnectTimer = this.optionTimer = null;
    this.tickTimer = null;
    onOptionWantsChanged(null);
    const ws = this.ws;
    this.ws = null;
    this.store.endSession(this.now());
    if (ws) {
      try { ws.close(1000, "stop"); } catch { /* already closed */ }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const seq = ++this.connectSeq;
    this.state = "connecting";
    this.nextAttemptAtMs = null;
    let token: string | null = null;
    let info: StreamerInfo | null = null;
    try {
      token = await this.deps.getAccessToken();
    } catch (e: any) {
      token = null;
      this.fail(`token error: ${e?.message ?? "unknown"}`);
    }
    if (seq !== this.connectSeq || this.stopped) return;
    if (!token) {
      this.state = "no_token";
      this.fail("Schwab not connected (no access token)");
      this.scheduleReconnect(this.cfg.backoffMaxMs);
      return;
    }
    try {
      info = await this.deps.getStreamerInfo();
    } catch (e: any) {
      info = null;
      this.fail(`userPreference error: ${e?.message ?? "unknown"}`);
    }
    if (seq !== this.connectSeq || this.stopped) return;
    if (!info) {
      this.state = "no_streamer_info";
      if (!this.lastError?.startsWith("userPreference")) this.fail("Schwab userPreference returned no streamerInfo");
      this.scheduleReconnect();
      return;
    }
    let ws: WebSocketLike;
    try {
      ws = this.deps.createSocket(info.socketUrl);
    } catch (e: any) {
      this.fail(`socket create failed: ${e?.message ?? "unknown"}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const streamerInfo = info;
    const accessToken = token;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.state = "logging_in";
      this.loginRequestId = this.send("ADMIN", "LOGIN", {
        Authorization: accessToken,
        SchwabClientChannel: streamerInfo.channel,
        SchwabClientFunctionId: streamerInfo.functionId,
      }, streamerInfo);
      this.loginTimer = setTimeout(() => {
        if (this.ws === ws && this.state === "logging_in") {
          this.fail("LOGIN timed out");
          this.dropSocket("login timeout");
        }
      }, this.cfg.loginTimeoutMs);
    };
    ws.onmessage = (ev: any) => {
      if (this.ws !== ws) return;
      this.onMessage(ev?.data, streamerInfo);
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.fail("socket error");
    };
    ws.onclose = (ev: any) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onSocketClosed(`socket closed${ev?.code ? ` (${ev.code})` : ""}`);
    };
    this.info = streamerInfo;
  }

  private info: StreamerInfo | null = null;

  private send(service: string, command: string, parameters: Record<string, string>, info: StreamerInfo | null = this.info): string | null {
    const ws = this.ws;
    if (!ws || !info) return null;
    const requestid = String(++this.requestId);
    const frame = {
      requests: [{
        service, command, requestid,
        SchwabClientCustomerId: info.customerId,
        SchwabClientCorrelId: info.correlId,
        parameters,
      }],
    };
    try {
      ws.send(JSON.stringify(frame));
    } catch (e: any) {
      this.fail(`send failed (${service} ${command})`);
      return null;
    }
    return requestid;
  }

  private onMessage(raw: unknown, info: StreamerInfo): void {
    const now = this.now();
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
    else if (raw && typeof (raw as any).toString === "function") text = String(raw);
    else return;
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      this.fail("unparseable frame");
      return;
    }
    this.store.noteMessage(now);
    for (const r of Array.isArray(msg?.response) ? msg.response : []) this.onResponse(r, info, now);
    for (const n of Array.isArray(msg?.notify) ? msg.notify : []) this.onNotify(n, now);
    if (this.state === "live") {
      for (const d of Array.isArray(msg?.data) ? msg.data : []) this.store.applyData(d, now);
    }
  }

  private onResponse(r: any, info: StreamerInfo, now: number): void {
    const service = String(r?.service ?? "");
    const command = String(r?.command ?? "");
    const code = Number(r?.content?.code);
    const msg = String(r?.content?.msg ?? "").slice(0, 160);
    this.acks[`${service}/${command}`] = { code, msg, atMs: now };
    if (service === "ADMIN" && command === "LOGIN") {
      if (this.loginTimer) clearTimeout(this.loginTimer);
      this.loginTimer = null;
      if (code === CODE_SUCCESS) {
        this.state = "live";
        this.logins++;
        this.deniedStreak = 0;
        this.liveSinceMs = now;
        this.store.beginSession(now);
        this.subscribeAll(info);
        this.log(`live (login ${this.logins}, reconnects ${this.reconnects})`);
      } else {
        this.state = "login_denied";
        this.deniedStreak++;
        this.fail(`LOGIN ${code === CODE_LOGIN_DENIED ? "denied" : "failed"} (code ${code})`);
        const ws = this.ws;
        this.ws = null;
        try { ws?.close(1000, "login failed"); } catch { /* ignore */ }
        this.store.endSession(now);
        // One forced refresh check, then retry; repeated denial waits longer.
        void (async () => {
          if (this.deniedStreak === 1 && this.deps.forceTokenRefresh) {
            try { await this.deps.forceTokenRefresh(); } catch { /* reported via next attempt */ }
          }
          this.scheduleReconnect(this.deniedStreak >= 2 ? this.cfg.deniedBackoffMs : undefined);
        })();
      }
      return;
    }
    if (Number.isFinite(code) && code !== CODE_SUCCESS) {
      this.fail(`${service} ${command} rejected (code ${code}${msg ? `: ${msg}` : ""})`);
      if (service === "LEVELONE_OPTIONS" && (command === "SUBS" || command === "ADD")) {
        // Treat rejected option keys as not subscribed; consumers stay on REST.
        this.subscribedOptions.clear();
        this.optionsSubscribedThisSession = false;
      }
    }
  }

  private onNotify(n: any, now: number): void {
    if (n && "heartbeat" in n) return; // keep-alive; noteMessage already recorded it
    const code = Number(n?.content?.code);
    if (!Number.isFinite(code)) return;
    const msg = String(n?.content?.msg ?? "").slice(0, 160);
    this.notices.push({ code, msg, atMs: now });
    if (this.notices.length > 20) this.notices.shift();
    if (code !== CODE_SUCCESS) {
      // Session-ending notice (e.g. another session took the stream, or the
      // server stopped streaming): reconnect after the long backoff.
      this.fail(`server notice code ${code}${msg ? `: ${msg}` : ""}`);
      const ws = this.ws;
      this.ws = null;
      try { ws?.close(1000, "server notice"); } catch { /* ignore */ }
      this.onSocketClosed(`server notice ${code}`, this.cfg.deniedBackoffMs);
    }
  }

  private subscribeAll(info: StreamerInfo): void {
    const eq = this.cfg.equities;
    if (eq.length) this.send("LEVELONE_EQUITIES", "SUBS", { keys: eq.join(","), fields: fieldList(L1_EQUITY_FIELDS) }, info);
    if (this.cfg.chartSymbols.length) {
      this.send("CHART_EQUITY", "SUBS", { keys: this.cfg.chartSymbols.join(","), fields: fieldList(CHART_EQUITY_FIELDS) }, info);
      if (this.cfg.chartOptionalSymbols.length) {
        this.send("CHART_EQUITY", "ADD", { keys: this.cfg.chartOptionalSymbols.join(","), fields: fieldList(CHART_EQUITY_FIELDS) }, info);
      }
    }
    this.subscribedOptions.clear();
    this.optionsSubscribedThisSession = false;
    this.syncOptionsNow();
  }

  private optionCap(): number {
    const used = this.cfg.equities.length + this.cfg.chartSymbols.length + this.cfg.chartOptionalSymbols.length;
    return Math.max(0, Math.min(this.cfg.maxOptionSymbols, this.cfg.maxTotalKeys - used));
  }

  private scheduleOptionSync(): void {
    if (this.optionTimer) return;
    this.optionTimer = setTimeout(() => {
      this.optionTimer = null;
      this.syncOptionsNow();
    }, this.cfg.optionDebounceMs);
  }

  /** Diff wanted vs subscribed option keys and send SUBS/ADD/UNSUBS. */
  syncOptionsNow(): void {
    const { symbols, overCap } = wantedOptionSymbols(this.optionCap());
    this.overCapOptions = overCap;
    if (this.state !== "live" || !this.ws) return;
    const want = new Set(symbols);
    const add = symbols.filter((s) => !this.subscribedOptions.has(s));
    const remove = Array.from(this.subscribedOptions).filter((s) => !want.has(s));
    const fields = fieldList(L1_OPTION_FIELDS);
    if (add.length) {
      const cmd = this.optionsSubscribedThisSession ? "ADD" : "SUBS";
      if (this.send("LEVELONE_OPTIONS", cmd, { keys: add.join(","), fields })) {
        for (const s of add) this.subscribedOptions.add(s);
        this.optionsSubscribedThisSession = true;
      }
    }
    if (remove.length) {
      if (this.send("LEVELONE_OPTIONS", "UNSUBS", { keys: remove.join(",") })) {
        for (const s of remove) {
          this.subscribedOptions.delete(s);
          this.store.options.delete(s);
        }
      }
    }
  }

  private dropSocket(reason: string): void {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(4000, reason); } catch { /* ignore */ }
    this.onSocketClosed(reason);
  }

  private onSocketClosed(reason: string, delayOverrideMs?: number): void {
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = null;
    const wasLive = this.state === "live";
    this.store.endSession(this.now());
    this.subscribedOptions.clear();
    this.optionsSubscribedThisSession = false;
    if (this.stopped) return;
    if (!this.lastError || wasLive) this.fail(reason);
    this.scheduleReconnect(delayOverrideMs);
  }

  private scheduleReconnect(delayOverrideMs?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    if (this.state === "live" || this.state === "connecting" || this.state === "logging_in") this.state = "backoff";
    const delay = delayOverrideMs ?? backoffDelayMs(this.failures, this.cfg.backoffBaseMs, this.cfg.backoffMaxMs, this.deps.jitter ? this.deps.jitter() : 0.5 + Math.random() * 0.5);
    this.failures++;
    this.liveSinceMs = null;
    this.nextAttemptAtMs = this.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnects++;
      void this.connect();
    }, delay);
  }

  private onTick(): void {
    const now = this.now();
    if (this.state === "live") {
      const last = this.store.lastMessageAtMs ?? 0;
      if (now - last > this.cfg.heartbeatTimeoutMs) {
        this.fail(`no frame for ${Math.round((now - last) / 1000)} s`);
        this.dropSocket("heartbeat timeout");
        return;
      }
      if (this.liveSinceMs != null && now - this.liveSinceMs >= this.cfg.stableAfterMs) this.failures = 0;
    }
    const bars = this.store.drainFinalBars(now);
    if (bars.length && this.deps.onFinalBars) {
      try { this.deps.onFinalBars(bars); } catch (e: any) { this.fail(`bar sink failed: ${e?.message ?? "unknown"}`); }
    }
  }

  /** Run the watchdog/bar flush once (tests). */
  tickOnce(): void {
    this.onTick();
  }

  status(now = this.now()) {
    const s = this.store;
    const age = (t: number | null | undefined) => (t == null ? null : Math.max(0, now - t));
    const perService: Record<string, { lastDataAgeMs: number | null; keys: number }> = {
      LEVELONE_EQUITIES: { lastDataAgeMs: age(s.lastDataAtMs.LEVELONE_EQUITIES), keys: this.cfg.equities.length },
      CHART_EQUITY: { lastDataAgeMs: age(s.lastDataAtMs.CHART_EQUITY), keys: this.cfg.chartSymbols.length + this.cfg.chartOptionalSymbols.length },
      LEVELONE_OPTIONS: { lastDataAgeMs: age(s.lastDataAtMs.LEVELONE_OPTIONS), keys: this.subscribedOptions.size },
    };
    const silentFor = age(s.lastMessageAtMs);
    const live = this.state === "live" && silentFor != null && silentFor <= this.cfg.validity.maxSilenceMs;
    const ticks: Record<string, { held: number; dropped: number; continuousSinceMs: number | null }> = {};
    for (const [sym, ring] of Array.from(s.ticks.entries())) {
      ticks[sym] = { held: ring.length, dropped: ring.dropped, continuousSinceMs: s.continuousSince.get(sym) ?? null };
    }
    const bars: Record<string, { held: number; lastBarT: number | null; sources: string[] }> = {};
    for (const [sym, arr] of Array.from(s.bars.entries())) {
      bars[sym] = { held: arr.length, lastBarT: arr.length ? arr[arr.length - 1].t : null, sources: Array.from(new Set(arr.map((b) => b.source))) };
    }
    const delayedSymbols = Array.from(s.equities.values()).filter((q) => q.delayed === true && q.epoch === s.epoch).map((q) => q.symbol);
    return {
      state: this.state,
      /** "live": usable for current quotes; "connecting": session not up yet; "down": not streaming. */
      mode: live ? "live" : this.state === "connecting" || this.state === "logging_in" ? "connecting" : "down",
      connected: s.connected,
      connectedAtMs: s.connectedAtMs,
      lastMessageAgeMs: silentFor,
      perService,
      subscriptions: {
        equities: this.cfg.equities,
        charts: this.cfg.chartSymbols.concat(this.cfg.chartOptionalSymbols),
        options: Array.from(this.subscribedOptions),
        optionsOverCap: this.overCapOptions,
        optionCap: this.optionCap(),
      },
      reconnects: this.reconnects,
      logins: this.logins,
      nextAttemptInMs: this.nextAttemptAtMs != null ? Math.max(0, this.nextAttemptAtMs - now) : null,
      lastError: this.lastError,
      lastErrorAgeMs: age(this.lastErrorAtMs),
      acks: this.acks,
      notices: this.notices.slice(-5),
      delayedSymbols,
      ticks,
      bars,
      counters: { ...s.counters },
      validity: this.cfg.validity,
      heartbeatTimeoutMs: this.cfg.heartbeatTimeoutMs,
    };
  }
}

export type StreamStatus = ReturnType<SchwabStreamer["status"]>;

// ─── Singleton ───────────────────────────────────────────────────────────────

let _streamer: SchwabStreamer | null = null;

export function startSchwabStream(deps: StreamDeps, cfg: Partial<StreamConfig> = {}): SchwabStreamer {
  if (_streamer) return _streamer;
  _streamer = new SchwabStreamer(deps, cfg);
  _streamer.start();
  return _streamer;
}

export function getSchwabStreamer(): SchwabStreamer | null {
  return _streamer;
}

/** Status for /api/schwab/stream/status; a stable "not started" shape when off. */
export function getStreamStatus(): StreamStatus | { state: "not_started"; mode: "down"; reason: string } {
  if (!_streamer) return { state: "not_started", mode: "down", reason: "streamer not started (BATCAVE_STREAM=0 or server starting)" };
  return _streamer.status();
}
