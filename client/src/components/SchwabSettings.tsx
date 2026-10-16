/**
 * SchwabSettings.tsx
 * Schwab OAuth connection dialog + data source status indicators.
 * Opened via the gear icon in the header.
 */

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiJson, queryClient, AUTH_REQUIRED_EVENT, API_BASE_STORAGE_KEY, isNativeApp } from "@/lib/queryClient";
import PersonalServerHandoff from "./PersonalServerHandoff";
import type { MarketDataValidation } from "@shared/marketDataValidation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";
import { Switch } from "@/components/ui/switch";
import { premarketGateEnabled, setPremarketGateEnabled } from "@/lib/prefs";
import {
  CheckCircle, XCircle, AlertTriangle, ExternalLink, RefreshCw,
  Wifi, WifiOff, Loader2, Settings, Clock, Copy,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SchwabStatus {
  connected: boolean;
  /** Demo edition: simulated sample data, Schwab sign-in off. */
  demo?: boolean;
  expiresIn: number;        // seconds
  refreshExpiresIn: number; // seconds
  needsReauth: boolean;
  /** Token storage at rest (server/schwabTokenStore.ts). */
  tokenStore?: {
    mode: "encrypted" | "plaintext-local" | "locked";
    encryptedAtRest: boolean;
    reason: string | null;
    keySource?: "env" | "file" | null;
    /** Locked with legacy plaintext tokens still in data.db. */
    plaintextOnDisk?: boolean;
  };
}

interface SchwabDiag {
  tokenOk: boolean;
  cacheEntries: number;
  requestsLastMinute: number;
  maxPerMinute: number;
  cooldowns: { endpoint: string; secondsRemaining: number }[];
  forbiddenStreaks: { endpoint: string; count: number }[];
  /** Per data kind, last 5 min: cached payloads served stale (within max age) and requests left unavailable. */
  degraded?: { kind: string; staleServed: number; unavailable: number; secondsAgo: number; lastReason: string }[];
  /** Max age (ms) per kind at which a cached Schwab payload may still be served. */
  maxServeAgeMs?: Record<string, number>;
  asOf: number;
}

/** /api/schwab/stream/status (subset read here). */
interface StreamStatus {
  state: string;
  mode: "live" | "connecting" | "down";
  lastMessageAgeMs?: number | null;
  reconnects?: number;
  lastError?: string | null;
  reason?: string;
  perService?: Record<string, { lastDataAgeMs: number | null; keys: number }>;
  subscriptions?: { options: string[]; optionsOverCap: string[] };
  delayedSymbols?: string[];
}

/** Feed mode for quotes: Schwab Streamer live, Schwab REST snapshots, or nothing. */
export function streamFeedLabel(connected: boolean, stream: StreamStatus | undefined): { label: string; color: string; detail: string } {
  if (!connected) return { label: "Unavailable", color: "#f87171", detail: "Schwab not connected: no quotes" };
  if (stream?.mode === "live" && stream.lastMessageAgeMs != null && stream.lastMessageAgeMs >= 0 && stream.lastMessageAgeMs <= 60_000
      && (stream.perService?.LEVELONE_EQUITIES?.lastDataAgeMs ?? Infinity) >= 0
      && (stream.perService?.LEVELONE_EQUITIES?.lastDataAgeMs ?? Infinity) <= 60_000) {
    const age = stream.lastMessageAgeMs != null ? `${Math.round(stream.lastMessageAgeMs / 1000)}s since last frame` : "";
    return { label: "Streaming live", color: "#34d399", detail: age };
  }
  const why = stream?.lastError ?? stream?.reason ?? (stream?.mode === "connecting" ? "stream connecting" : "stream down");
  return { label: "Feed not verified", color: "#fbbf24", detail: why };
}

function StreamFeedRow({ connected, stream }: { connected: boolean; stream: StreamStatus | undefined }) {
  const f = streamFeedLabel(connected, stream);
  const svc = stream?.perService ?? {};
  const svcAge = (k: string) => {
    const a = svc[k]?.lastDataAgeMs;
    return a == null ? "no data" : `${Math.round(a / 1000)}s`;
  };
  return (
    <div className="space-y-1 text-[11px]" data-testid="schwab-stream-status">
      <div className="flex items-center gap-1" style={{ color: f.color }} title={f.detail}>
        <span className={`h-1.5 w-1.5 rounded-full ${f.label === "Streaming live" ? "animate-pulse" : ""}`} style={{ background: f.color }} />
        <span className="font-medium">Quotes: {f.label}</span>
        {f.detail && <span className="text-muted-foreground truncate max-w-[220px]">· {f.detail}</span>}
      </div>
      {connected && stream?.mode && stream.mode !== "down" && (
        <div className="text-muted-foreground font-mono">
          L1 eq {svcAge("LEVELONE_EQUITIES")} · chart {svcAge("CHART_EQUITY")} · options {svc.LEVELONE_OPTIONS?.keys ?? 0} keys
          {typeof stream.reconnects === "number" ? ` · reconnects ${stream.reconnects}` : ""}
          {stream.subscriptions?.optionsOverCap?.length ? ` · ${stream.subscriptions.optionsOverCap.length} over cap (REST)` : ""}
          {stream.delayedSymbols?.length ? ` · delayed flag: ${stream.delayedSymbols.join(", ")} (REST used)` : ""}
        </div>
      )}
    </div>
  );
}

// Schwab is the only market-data source (user decision 2026-10-08). When it
// cannot answer, data is served from a short-lived cache with its real age
// (within a stated max age) or shown as unavailable: no CBOE, no Yahoo.
type SourceState = "schwab_live" | "schwab_stale" | "unavailable" | "disconnected" | "offline" | "unverified";

function fmtMaxAge(ms: number | undefined): string {
  if (ms == null) return "";
  return ms >= 3600_000 ? `${Math.round(ms / 3600_000)}h` : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
}

/** Map a UI data-source row to its real live state from the diag feed. */
function deriveEndpointState(
  key: "quotes" | "history" | "chains" | "gamma",
  isConnected: boolean,
  diag: SchwabDiag | undefined,
): { source: SourceState; detail: string } {
  if (!isConnected) {
    return { source: "disconnected", detail: "Schwab disconnected — data unavailable (no other source)" };
  }

  // Endpoint name in cooldown/forbidden maps (matches schwabFetch path keys)
  const ep =
    key === "quotes"  ? "quotes"
    : key === "history" ? "pricehistory"
    : "chains"; // gamma piggybacks on chains
  const kinds = key === "quotes" ? ["quotes"] : key === "history" ? ["minute_bars", "daily_bars"] : ["chains"];

  const cool = diag?.cooldowns?.find((c) => c.endpoint.toLowerCase().includes(ep));
  const deg = (diag?.degraded ?? []).filter((d) => kinds.includes(d.kind));
  const maxAge = fmtMaxAge(diag?.maxServeAgeMs?.[kinds[0]]);
  const unavailable = deg.reduce((a, d) => a + d.unavailable, 0);
  const staleServed = deg.reduce((a, d) => a + d.staleServed, 0);
  const reason = deg[0]?.lastReason ?? (cool ? `cooldown ${cool.secondsRemaining}s` : "");

  if (unavailable > 0) {
    return { source: "unavailable", detail: `Unavailable x${unavailable} in 5 min (${reason})` };
  }
  if (staleServed > 0 || cool) {
    return { source: "schwab_stale", detail: `Cached Schwab, max age ${maxAge}${reason ? ` (${reason})` : ""}` };
  }
  return { source: "unverified", detail: "Authorized; use the data check to verify this endpoint." };
}

// ─── Status pill (used in header) ────────────────────────────────────────────

export function SchwabStatusPill({ onClick }: { onClick: () => void }) {
  const { data } = useQuery<SchwabStatus>({
    queryKey: ["/api/schwab/status"],
    queryFn: async () => {
      return apiJson<SchwabStatus>("GET", "/api/schwab/status");
    },
    refetchInterval: 60_000,
    staleTime: 55_000,
  });

  if (!data) return null;

  if (data.demo) {
    return (
      <button
        onClick={onClick}
        className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-indigo-400/40 bg-indigo-500/10 px-2 py-0.5 transition hover:opacity-80 lg:min-h-0"
        data-testid="schwab-status-pill"
        title="Demo: simulated sample data, not Schwab. Click for details."
      >
        <span className="h-1.5 w-1.5 rounded-full bg-indigo-300" aria-hidden />
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-indigo-200">SAMPLE DATA</span>
      </button>
    );
  }

  const isConnected = data.connected && !data.needsReauth;

  return (
    <button
      onClick={onClick}
      className="flex min-h-[44px] items-center gap-1.5 rounded-full border px-2 py-0.5 transition hover:opacity-80 lg:min-h-0"
      style={{
        borderColor: isConnected ? "rgb(16 185 129 / 0.4)" : "rgb(245 158 11 / 0.4)",
        background: isConnected ? "rgb(16 185 129 / 0.08)" : "rgb(245 158 11 / 0.08)",
      }}
      data-testid="schwab-status-pill"
      title={isConnected ? "Schwab authorized; feed availability is checked separately" : "Schwab disconnected — click to connect"}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isConnected ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
        }`}
        aria-hidden
      />
      <span
        className="font-mono text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: isConnected ? "#34d399" : "#fbbf24" }}
      >
        {isConnected ? "SCHWAB LINKED" : data.connected ? "SCHWAB" : "DISCONNECTED"}
      </span>
    </button>
  );
}

// ─── Source badge ─────────────────────────────────────────────────────────────

function SourceBadge({ source, detail }: { source: SourceState; detail?: string }) {
  const styles: Record<SourceState, { color: string; dot: string; pulse: boolean; label: string }> = {
    schwab_live:    { color: "#34d399", dot: "bg-emerald-400", pulse: true,  label: "Schwab LIVE" },
    schwab_stale:   { color: "#fbbf24", dot: "bg-amber-400",    pulse: false, label: "Schwab cached (stale)" },
    unavailable:    { color: "#f87171", dot: "bg-red-400",      pulse: false, label: "Unavailable" },
    disconnected:   { color: "#fb923c", dot: "bg-orange-400",   pulse: false, label: "Schwab disconnected" },
    offline:        { color: "#f87171", dot: "bg-red-500",      pulse: false, label: "Offline" },
    unverified:     { color: "#fbbf24", dot: "bg-amber-400", pulse: false, label: "Not verified" },
  };
  const s = styles[source];
  return (
    <span className="flex items-center gap-1 text-[11px]" style={{ color: s.color }} title={detail}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot} ${s.pulse ? "animate-pulse" : ""}`} />
      <span>{s.label}</span>
      {detail && source !== "schwab_live" && (
        <span className="text-muted-foreground ml-0.5 truncate max-w-[140px]">· {detail}</span>
      )}
    </span>
  );
}

// ─── Main dialog ──────────────────────────────────────────────────────────────

interface SchwabSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SchwabSettings({ open, onOpenChange }: SchwabSettingsProps) {
  const { toast } = useToast();
  const [redirectedUrl, setRedirectedUrl] = useState("");
  const [step, setStep] = useState<"idle" | "waiting_for_paste">("idle");
  const connectionInFlight = useRef(false);
  const [connectionError, setConnectionError] = useState("");
  const wasConnected = useRef(false);
  // Sandbox-blocked auth: when window.open is silently refused (iframe sandbox,
  // iOS Safari popup blocker, etc.) we surface the URL as a tappable fallback
  // link the user can long-press / open manually. This is the fix for the
  // "Connect button does nothing" bug on iPhone inside the Perplexity webview.
  const [authBlockedFallback, setAuthBlockedFallback] = useState(false);

  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useQuery<SchwabStatus>({
    queryKey: ["/api/schwab/status"],
    queryFn: async () => {
      return apiJson<SchwabStatus>("GET", "/api/schwab/status");
    },
    refetchInterval: open ? 10_000 : false,
    staleTime: 8_000,
    enabled: open,
  });

  const { data: diag } = useQuery<SchwabDiag>({
    queryKey: ["/api/schwab/diag"],
    queryFn: async () => {
      return apiJson<SchwabDiag>("GET", "/api/schwab/diag");
    },
    refetchInterval: open ? 5_000 : false,
    enabled: open,
  });

  const { data: streamStatus } = useQuery<StreamStatus>({
    queryKey: ["/api/schwab/stream/status"],
    queryFn: async () => {
      return apiJson<StreamStatus>("GET", "/api/schwab/stream/status");
    },
    refetchInterval: open ? 5_000 : false,
    enabled: open,
  });

  // The login link carries a one-time state value the server keeps for 15
  // minutes. One link is kept for 14 of them, across closing and reopening
  // the dialog: copying the link, signing in at Schwab, then reopening
  // Settings to paste the callback must find the same state, or the paste is
  // refused as belonging to a different sign-in. A new link is minted only
  // after that, or on the explicit "fresh link" buttons.
  const AUTH_URL_KEEP_MS = 14 * 60_000;
  const { data: authUrlData, error: authUrlError, refetch: refetchAuthUrl } = useQuery<{ url: string; automatic?: boolean }>({
    queryKey: ["/api/schwab/auth-url"],
    queryFn: async () => {
      return apiJson<{ url: string; automatic?: boolean }>("GET", "/api/schwab/auth-url");
    },
    enabled: open,
    staleTime: AUTH_URL_KEEP_MS,
    gcTime: AUTH_URL_KEEP_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const authUrlNeedsKey = !!authUrlError && /^401\b/.test(String((authUrlError as Error).message));

  // Closing the dialog clears the paste box and step, never the link.
  useEffect(() => {
    if (!open) { setRedirectedUrl(""); setConnectionError(""); setStep("idle"); }
  }, [open]);

  useEffect(() => {
    if (status?.connected && !wasConnected.current) {
      setRedirectedUrl("");
      setConnectionError("");
      setStep("idle");
      void queryClient.invalidateQueries({ predicate: q => q.queryKey[0] !== "/api/schwab/auth-url" });
    }
    wasConnected.current = !!status?.connected;
  }, [status?.connected]);

  // Connect mutation
  const connectMut = useMutation({
    mutationFn: async (url: string) => {
      const state = authUrlData?.url ? new URL(authUrlData.url).searchParams.get("state") : null;
      if (!state) throw new Error("Start a fresh sign-in first.");
      return apiJson("POST", "/api/schwab/callback", { redirectedUrl: url.trim(), state });
    },
    onSuccess: () => {
      toast({ title: "Schwab authorization saved", description: "Checking connection and data availability. Authorization alone does not confirm live feed access." });
      setRedirectedUrl("");
      setStep("idle");
      void queryClient.invalidateQueries({ predicate: q => q.queryKey[0] !== "/api/schwab/auth-url" });
      refetchStatus();
    },
    onError: () => {
      // Do not echo provider errors or callback secrets into the page/toast.
      const message = "Connection was not confirmed. Check connection status first. If disconnected, use a fresh login link and its new callback, not a saved code.";
      setConnectionError(message);
      toast({ title: "Connection not confirmed", description: message, variant: "destructive" });
    },
    onSettled: () => { connectionInFlight.current = false; },
  });

  // Disconnect mutation
  const disconnectMut = useMutation({
    mutationFn: async () => {
      return apiJson("POST", "/api/schwab/disconnect");
    },
    onSuccess: () => {
      toast({ title: "Disconnected from Schwab" });
      queryClient.invalidateQueries({ queryKey: ["/api/schwab/status"] });
      refetchStatus();
    },
  });

  // iOS webview reality: window.open is blocked, target="_blank" anchors are
  // silently eaten by the iframe sandbox, and navigator.clipboard often throws.
  // Layered copy: async clipboard -> execCommand on a hidden textarea ->
  // select the visible textarea so the native iOS Copy menu appears.
  const authUrlBoxRef = useRef<HTMLTextAreaElement | null>(null);
  const copyAuthUrl = async () => {
    const url = authUrlData?.url;
    if (!url) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      /* blocked in sandboxed iframe */
    }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, url.length);
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      toast({ title: "Login link copied", description: authUrlData?.automatic
        ? "Open it in your browser, approve at Schwab, then return here and check connection."
        : "Open it in your browser, approve at Schwab, then paste the fresh callback here and tap Complete connection." });
    } else {
      const box = authUrlBoxRef.current;
      if (box) {
        box.focus();
        box.select();
        box.setSelectionRange(0, url.length);
      }
      toast({ title: "Text selected — tap Copy in the iOS menu", description: "Then open Safari and paste it in the address bar." });
    }
  };

  const handleConnect = () => {
    if (connectionInFlight.current || authUrlData?.automatic) return;
    if (!redirectedUrl.trim()) {
      toast({ title: "Paste the redirected URL first", variant: "destructive" });
      return;
    }
    connectionInFlight.current = true;
    setConnectionError("");
    connectMut.mutate(redirectedUrl.trim());
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setRedirectedUrl(text);
        setConnectionError("");
      } else {
        toast({ title: "Clipboard is empty", variant: "destructive" });
      }
    } catch {
      toast({ title: "Can't read clipboard", description: "Paste manually into the box below.", variant: "destructive" });
    }
  };

  const formatDuration = (seconds: number): string => {
    if (seconds <= 0) return "expired";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  const isConnected = status?.connected === true && !status?.needsReauth;

  if (status?.demo) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg grid-cols-[minmax(0,1fr)] [&>*]:min-w-0" data-testid="schwab-settings-dialog">
          <DialogHeader className="pr-12">
            <DialogTitle className="flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Batcave demo
            </DialogTitle>
            <DialogDescription>
              Stock/index prices, option chains and derived market scores use simulated data in this preview. Crypto and news may come from separate public feeds and retain their own source and freshness limits. Nothing here is investment advice.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground" data-testid="demo-settings">
            <p>The stock/options screens demonstrate calculations, not current market conditions. Passing the tests does not establish forecast accuracy or a trading edge.</p>
            <p>Schwab sign-in is turned off. Live use requires rotated developer credentials and a verified protected server. This is not a multi-user brokerage service.</p>
            {!isNativeApp() && <PersonalServerHandoff />}
            <SchwabSelfTest />
            {isNativeApp() && (
              <Button
                variant="outline"
                className="w-full"
                data-testid="demo-use-own-server"
                onClick={() => {
                  try { window.localStorage.removeItem(API_BASE_STORAGE_KEY); } catch { /* storage unavailable */ }
                  window.location.reload();
                }}
              >
                Use my own Batcave server
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg grid-cols-[minmax(0,1fr)] [&>*]:min-w-0 [&_button]:whitespace-normal [&_button]:h-auto [&_button]:max-w-full [&_textarea]:min-w-0" data-testid="schwab-settings-dialog">
        <DialogHeader className="pr-12">
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-4 w-4" />
            Schwab Integration Settings
          </DialogTitle>
          <DialogDescription>
            Connect your Charles Schwab brokerage account to enable live options flow data and real-time market quotes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Connection status card */}
          <div className={`rounded-lg border p-4 ${
            isConnected
              ? "border-emerald-500/30 bg-emerald-500/5"
              : status?.needsReauth
              ? "border-amber-500/30 bg-amber-500/5"
              : "border-border/40 bg-muted/20"
          }`}>
            {statusLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking connection...
              </div>
            ) : isConnected ? (
              <div className="space-y-3">
                {/* Connected state */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-emerald-400" />
                    <span className="text-sm font-medium text-emerald-300">Connected to Schwab</span>
                  </div>
                  <span className="flex items-center gap-1 text-[11px] text-emerald-400 animate-pulse">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    AUTHORIZED
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    <span>Token expires: <span className="text-foreground font-mono">{formatDuration(status?.expiresIn ?? 0)}</span></span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    <span>Refresh valid: <span className="text-foreground font-mono">{formatDuration(status?.refreshExpiresIn ?? 0)}</span></span>
                  </div>
                </div>
                <SchwabSelfTest />
                <div className="flex gap-2 pt-1">
                  {authUrlData?.url ? (
                    <a
                      href={authUrlData.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setStep("waiting_for_paste")}
                      className="inline-flex min-h-[36px] items-center rounded-md border border-amber-500/40 px-3 text-xs text-amber-300 hover:bg-amber-500/10"
                      data-testid="reauth-schwab-btn"
                    >
                      <RefreshCw className="mr-1 h-3 w-3" />
                      Re-authenticate
                    </a>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-500/40 text-red-400 hover:bg-red-500/10 text-[11px]"
                    onClick={() => disconnectMut.mutate()}
                    disabled={disconnectMut.isPending}
                    data-testid="disconnect-schwab-btn"
                  >
                    {disconnectMut.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <XCircle className="mr-1 h-3 w-3" />}
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : status?.needsReauth ? (
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                <div>
                  <div className="text-sm font-medium text-amber-300">Re-authentication required</div>
                  <div className="text-[11px] text-muted-foreground">Refresh token expired. Complete the OAuth flow again below.</div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <WifiOff className="h-4 w-4 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium">Schwab offline</div>
                  <div className="text-[11px] text-muted-foreground">Schwab disconnected — market data is unavailable (Schwab is the only source). Connect Schwab for live data.</div>
                </div>
              </div>
            )}
          </div>

          {/* Token storage at rest: locked (no BATCAVE_TOKEN_KEY on a reachable
              bind, or tokens that cannot be decrypted) blocks the connection;
              plaintext-local is allowed on loopback only and says so. */}
          {status?.tokenStore && (status.tokenStore.mode !== "encrypted" || status.tokenStore.reason) && (
            <div
              className={`rounded-md border p-2 text-[11px] ${
                status.tokenStore.mode === "locked" || (status.tokenStore.reason && status.tokenStore.mode === "encrypted")
                  ? "border-rose-500/40 bg-rose-500/5 text-rose-300"
                  : "border-amber-500/30 bg-amber-500/5 text-amber-300"
              }`}
              data-testid="schwab-token-store"
            >
              <span className="font-semibold">
                {status.tokenStore.plaintextOnDisk
                  ? "Plaintext tokens still on disk: set BATCAVE_TOKEN_KEY or disconnect"
                  : status.tokenStore.mode === "locked" ? "Token storage locked" : status.tokenStore.mode === "plaintext-local" ? "Tokens stored unencrypted (BATCAVE_TOKEN_PLAINTEXT_OK=1)" : "Token storage problem"}
              </span>
              {status.tokenStore.reason ? <span className="text-muted-foreground"> · {status.tokenStore.reason}</span> : null}
              {status.tokenStore.plaintextOnDisk && (
                <div className="mt-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 border-red-500/40 text-[11px] text-red-400 hover:bg-red-500/10"
                    onClick={() => disconnectMut.mutate()}
                    disabled={disconnectMut.isPending}
                    data-testid="token-store-disconnect"
                  >
                    Disconnect and securely delete stored tokens
                  </Button>
                </div>
              )}
            </div>
          )}
          {status?.tokenStore?.mode === "encrypted" && !status.tokenStore.reason && (
            <div className="text-[11px] text-muted-foreground" data-testid="schwab-token-store">Tokens encrypted at rest (AES-256-GCM, key from {status.tokenStore.keySource === "file" ? "local key file" : "BATCAVE_TOKEN_KEY"}).</div>
          )}

          {/* OAuth flow (show if disconnected or needs reauth) */}
          {(!isConnected) && (
            <div className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Connect Your Schwab Account
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground" data-testid="schwab-credential-guidance">
                Your Batcave access key unlocks this app. Schwab authorization is separate.
                Enter your Schwab password only on Schwab's website; never paste it here.
                A callback code is single-use, not a code to save and reuse.
              </p>

              {/* Step 1 */}
              <div className="rounded-md border border-border/40 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[11px] font-bold">1</span>
                  <span className="text-xs font-medium">Open Schwab authorization page</span>
                </div>
                {authUrlError ? (
                  <div className="rounded border border-rose-500/40 bg-rose-500/5 p-2 text-xs leading-snug text-foreground" data-testid="schwab-auth-url-error">
                    {authUrlNeedsKey ? (
                      <>
                        Enter your Batcave access key first; the server rejected this browser.
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2 w-full min-h-[44px] text-xs"
                          onClick={() => window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))}
                          data-testid="schwab-enter-access-key"
                        >
                          Enter access key
                        </Button>
                      </>
                    ) : (
                      <>
                        Can't build the Schwab login link: {friendlyError(authUrlError, "the server did not answer")}
                        <Button size="sm" variant="outline" className="mt-2 w-full min-h-[44px] text-xs" onClick={() => refetchAuthUrl()}>
                          Try again
                        </Button>
                      </>
                    )}
                  </div>
                ) : !authUrlData?.url ? (
                  <div className="text-xs text-muted-foreground">Preparing the Schwab login link...</div>
                ) : (
                  <>
                    {/* A real link, not window.open: Safari and iOS treat a tapped
                        link as a user action and open it in a new tab. */}
                    <a
                      href={authUrlData.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setStep("waiting_for_paste")}
                      className="flex min-h-[44px] w-full items-center justify-center rounded-md bg-amber-500 px-3 text-sm font-semibold text-black hover:bg-amber-400"
                      data-testid="open-schwab-auth-btn"
                    >
                      <ExternalLink className="mr-1.5 h-4 w-4" />
                      Open Schwab Login
                    </a>
                    <button
                      type="button"
                      onClick={() => { setAuthBlockedFallback(true); void copyAuthUrl(); }}
                      className="w-full min-h-[40px] text-xs text-muted-foreground underline underline-offset-2"
                      data-testid="copy-schwab-auth-link"
                    >
                      Didn't open? Copy the link instead
                    </button>
                    <div className="text-xs leading-snug text-muted-foreground">
                      {authUrlData.automatic
                        ? "After you approve, Schwab sends you straight back to Batcave and the connection finishes by itself."
                        : "After you approve, Schwab sends you to your callback address (the page may not load; that is expected). Copy that full address and paste it in step 2."}
                    </div>
                  </>
                )}
                {authBlockedFallback && authUrlData?.url && (
                  <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/5 p-2 space-y-2">
                    <div className="text-[11px] font-semibold text-amber-300 uppercase tracking-wider">
                      Popup blocked here — copy the link, open it in Safari
                    </div>
                    <Button
                      size="sm"
                      className="w-full bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs"
                      onClick={copyAuthUrl}
                      data-testid="copy-schwab-auth-btn"
                    >
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      Copy login link
                    </Button>
                    <textarea
                      ref={authUrlBoxRef}
                      readOnly
                      value={authUrlData.url}
                      rows={3}
                      onFocus={(e) => e.currentTarget.select()}
                      onClick={(e) => e.currentTarget.select()}
                      className="w-full resize-none rounded border border-border/40 bg-background/60 p-1.5 font-mono text-[11px] leading-tight text-blue-300 [user-select:text] [-webkit-user-select:text]"
                      data-testid="schwab-auth-url-box"
                    />
                    <div className="text-[11px] leading-snug text-muted-foreground">
                      {authUrlData.automatic
                        ? "Open the link in your browser, approve at Schwab, then return here and check connection. No callback code is needed."
                        : "Open the link in your browser, approve at Schwab, then copy the complete callback address and paste it in step 2. The callback page itself may not load."}
                    </div>
                    <a
                      href={authUrlData.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-[11px] text-muted-foreground underline underline-offset-2"
                      data-testid="schwab-auth-fallback-link"
                    >
                      or try opening it directly (may be blocked in this app)
                    </a>
                  </div>
                )}
              </div>

              {authUrlData?.automatic ? (
                <div className="rounded-md border border-border p-3 space-y-2" data-testid="schwab-automatic-return">
                  <p className="text-sm">After approving at Schwab, return here. Connection status refreshes automatically while this dialog is open.</p>
                  <Button variant="outline" className="min-h-[44px] w-full" onClick={() => refetchStatus()} data-testid="schwab-check-connection">
                    Check connection
                  </Button>
                </div>
              ) : authUrlData?.url ? (
              <div className={`rounded-md border p-3 space-y-2 ${step === "waiting_for_paste" ? "border-amber-500/40 bg-amber-500/5" : "border-border/40"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[11px] font-bold">2</span>
                    <label htmlFor="schwab-callback-input" className="text-sm font-medium">Paste the fresh callback below</label>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-[44px] text-xs px-2"
                    onClick={handlePasteFromClipboard}
                    disabled={connectMut.isPending}
                    data-testid="paste-clipboard-btn"
                  >
                    Paste from clipboard
                  </Button>
                </div>
                <div className="text-sm text-muted-foreground leading-relaxed">
                  Copy the full callback address from the sign-in you just completed.
                  Paste it here, then tap Complete connection once. Pasting alone will not submit it.
                </div>
                <Textarea
                  id="schwab-callback-input"
                  value={redirectedUrl}
                  onChange={(e) => { setRedirectedUrl(e.target.value); setConnectionError(""); }}
                  disabled={connectMut.isPending}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onPaste={(e) => {
                    const text = e.clipboardData?.getData("text") ?? "";
                    if (text) {
                      e.preventDefault();
                      setRedirectedUrl(text);
                    }
                  }}
                  placeholder="Paste the fresh callback address"
                  className="font-mono text-sm resize-none min-h-[88px]"
                  data-testid="schwab-callback-url-input"
                />
                {connectMut.isPending && (
                  <div role="status" className="flex items-center gap-2 text-sm text-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Connecting to Schwab...
                  </div>
                )}
                <Button
                  size="sm"
                  className="w-full text-sm min-h-[44px]"
                  onClick={handleConnect}
                  disabled={connectMut.isPending || !redirectedUrl.trim()}
                  data-testid="complete-connection-btn"
                >
                  {connectMut.isPending ? "Connecting..." : "Complete connection"}
                </Button>
              </div>
              ) : null}
              {connectionError && <p role="alert" className="text-sm text-foreground rounded-md border border-destructive p-3" data-testid="schwab-connection-error">{connectionError}</p>}
              {authUrlData?.url && (
                <div className="flex flex-wrap gap-2">
                  {!authUrlData.automatic && <Button variant="outline" className="min-h-[44px]" onClick={() => refetchStatus()} data-testid="schwab-check-connection">Check connection</Button>}
                  <Button variant="outline" className="min-h-[44px]" disabled={connectMut.isPending}
                    onClick={() => { setRedirectedUrl(""); setConnectionError(""); setStep("idle"); void refetchAuthUrl(); }}
                    data-testid="schwab-fresh-login">Get a fresh login link</Button>
                </div>
              )}
            </div>
          )}

          <Separator />

          {/* Data source indicators */}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Data Sources
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              {([
                { label: "Quotes (SPY, VIX, indices)", key: "quotes" as const },
                { label: "Price History (charts)", key: "history" as const },
                { label: "Option Chains (flow)", key: "chains" as const },
                { label: "Gamma Levels (models)", key: "gamma" as const },
              ]).map(({ label, key }) => {
                const { source, detail } = deriveEndpointState(key, isConnected, diag);
                return (
                  <div
                    key={key}
                    className="flex items-center justify-between rounded-md border border-border/30 bg-muted/10 px-3 py-1.5"
                    data-testid={`datasource-${key}`}
                  >
                    <span className="text-[11px] text-muted-foreground">{label}</span>
                    <SourceBadge source={source} detail={detail} />
                  </div>
                );
              })}
            </div>
            <div className="rounded-md border border-border/30 bg-muted/10 px-3 py-1.5">
              <StreamFeedRow connected={isConnected} stream={streamStatus} />
            </div>

            {/* Live cooldown / rate-budget banner */}
            {diag && (diag.cooldowns.length > 0 || diag.forbiddenStreaks.length > 0 || diag.requestsLastMinute > diag.maxPerMinute * 0.8) && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200/90 leading-snug space-y-0.5">
                {diag.cooldowns.length > 0 && (
                  <div>
                    <span className="font-semibold">Active cooldowns:</span>{" "}
                    {diag.cooldowns.map((c) => `${c.endpoint} (${c.secondsRemaining}s)`).join(", ")}
                  </div>
                )}
                {diag.forbiddenStreaks.length > 0 && (
                  <div>
                    <span className="font-semibold">403 streaks:</span>{" "}
                    {diag.forbiddenStreaks.map((s) => `${s.endpoint} x${s.count}`).join(", ")}
                    <span className="text-muted-foreground"> · check Schwab Developer entitlement</span>
                  </div>
                )}
                {diag.requestsLastMinute > diag.maxPerMinute * 0.8 && (
                  <div>
                    <span className="font-semibold">Rate budget:</span> {diag.requestsLastMinute}/{diag.maxPerMinute} req/min
                  </div>
                )}
              </div>
            )}
            {diag && diag.cooldowns.length === 0 && diag.forbiddenStreaks.length === 0 && (
              <div className="text-[11px] text-muted-foreground">
                Cache: {diag.cacheEntries} entries · Budget: {diag.requestsLastMinute}/{diag.maxPerMinute} req/min
              </div>
            )}
          </div>

          <PremarketToggle />

          {/* Help text */}
          <div className="rounded-md border border-border/20 bg-muted/10 p-3 text-xs text-muted-foreground leading-relaxed">
            <div className="font-semibold text-foreground/80 mb-1">About the Schwab connection</div>
            You sign in on Schwab's own page; Batcave never sees your Schwab password. Schwab gives Batcave a token:
            access tokens expire every 30 minutes and are refreshed automatically, refresh tokens last 7 days, so you
            reconnect about once a week. Tokens stay on the server (encrypted when BATCAVE_TOKEN_KEY is set) and can be revoked from your Schwab account.
            All stock, index and options data comes from Schwab only; when Schwab can't answer, panels say so.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PremarketToggle() {
  const [on, setOn] = useState(premarketGateEnabled);
  return (
    <label className="flex min-h-[44px] items-center justify-between gap-3 rounded-md border border-border/30 p-3 text-sm">
      <span>
        <span className="block font-medium">Pre-market checklist</span>
        <span className="block text-xs text-muted-foreground">Show your trading checklist when Batcave opens.</span>
      </span>
      <Switch
        checked={on}
        onCheckedChange={(v) => { setOn(v); setPremarketGateEnabled(v); }}
        data-testid="switch-premarket-gate"
      />
    </label>
  );
}

/** On-demand input validation, not an HTTP reachability or prediction certificate. */
function SchwabSelfTest() {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [report, setReport] = useState<MarketDataValidation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!report) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [report]);
  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setReport(null);
    setBusy(true); setErr(null);
    try {
      const j = await apiJson<MarketDataValidation>("GET", "/api/schwab/selftest");
      if (j.version !== 1 || !Array.isArray(j.items) || !Number.isFinite(j.expiresAt) ||
          !j.items.every(item => ["pass", "partial", "fail", "blocked"].includes(item.verdict))) {
        throw new Error("Validation report not supported.");
      }
      setReport(j); setNow(Date.now());
    } catch {
      setErr("No validation result. The server may be unavailable or running an older build; no data-quality pass was issued.");
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };
  const expired = !!report && now >= report.expiresAt;
  return (
    <div className="space-y-2 pt-1" data-testid="schwab-selftest">
      <Button size="sm" variant="outline" className="h-auto min-h-[44px] w-full whitespace-normal py-2 text-sm leading-snug" onClick={run} disabled={busy} data-testid="schwab-selftest-btn">
        {busy ? "Checking real observations..." : "Validate real market data"}
      </Button>
      {err && <div role="status" className="text-sm text-foreground" data-testid="market-validation-error">{err}</div>}
      {report && <>
        <p role="status" className="text-sm text-foreground" data-testid="market-validation-summary">
          {expired ? "Check expired. Run again before relying on these results." : report.marketInputsValid ? "Sampled input checks passed. Full output validation is still required." : "Real-data validation incomplete. Review the gaps below."}
        </p>
        <p className="text-xs text-muted-foreground">{report.cached ? "Recent app-side check" : "Checked"} at {new Date(report.checkedAt).toLocaleTimeString()}. {report.scope}</p>
        <ul className="space-y-1.5">
          {report.items.map((it) => (
            <li key={it.name} className="rounded border border-border/40 p-2 text-xs leading-snug" data-testid={`market-check-${it.name.replace(/\W/g, "-")}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">{it.name}</span>
                <span className="font-semibold uppercase text-foreground">{expired ? "Expired" : it.verdict}</span>
              </div>
              <div className="mt-0.5 text-muted-foreground">{it.detail}</div>
              <div className="mt-1 text-muted-foreground">{it.source}{it.observedAt != null ? ` · Observed ${new Date(it.observedAt).toLocaleString()}` : ""}</div>
            </li>
          ))}
        </ul>
      </>}
    </div>
  );
}
