/**
 * SchwabSettings.tsx
 * Schwab OAuth connection dialog + data source status indicators.
 * Opened via the gear icon in the header.
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
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
import {
  CheckCircle, XCircle, AlertTriangle, ExternalLink, RefreshCw,
  Wifi, WifiOff, Loader2, Settings, Clock,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SchwabStatus {
  connected: boolean;
  expiresIn: number;        // seconds
  refreshExpiresIn: number; // seconds
  needsReauth: boolean;
}

interface SchwabDiag {
  tokenOk: boolean;
  cacheEntries: number;
  requestsLastMinute: number;
  maxPerMinute: number;
  cooldowns: { endpoint: string; secondsRemaining: number }[];
  forbiddenStreaks: { endpoint: string; count: number }[];
  cboeFallbackHits?: { symbol: string; count: number; secondsAgo: number }[];
  asOf: number;
}

// Bug #6 fix: removed misleading "yahoo" state. The disconnected fallback is
// either cached Schwab snapshots or CBOE delayed chains — never Yahoo data.
type SourceState = "schwab_live" | "schwab_cached" | "cboe_fallback" | "disconnected" | "offline";

/** Map a UI data-source row to its real live state from the diag feed. */
function deriveEndpointState(
  key: "quotes" | "history" | "chains" | "gamma",
  isConnected: boolean,
  diag: SchwabDiag | undefined,
): { source: SourceState; detail: string } {
  if (!isConnected) {
    if (key === "chains") return { source: "cboe_fallback", detail: "CBOE delayed (~15min)" };
    // Bug #6: quotes/history have no Yahoo fallback — they're cached Schwab
    // snapshots or stale. Surface the truth, not a fake Yahoo label.
    return { source: "disconnected", detail: "Schwab disconnected — cached / stale" };
  }

  // Endpoint name in cooldown/forbidden maps (matches schwabFetch path keys)
  const ep =
    key === "quotes"  ? "quotes"
    : key === "history" ? "pricehistory"
    : key === "chains" ? "chains"
    : "chains"; // gamma piggybacks on chains

  const cool = diag?.cooldowns?.find((c) => c.endpoint.toLowerCase().includes(ep));
  const streak = diag?.forbiddenStreaks?.find((s) => s.endpoint.toLowerCase().includes(ep));

  // Chains: if we've actually fallen back to CBOE in the last 5 min, that's the real source
  if (key === "chains" || key === "gamma") {
    const cboeHits = diag?.cboeFallbackHits ?? [];
    if (cboeHits.length > 0) {
      const total = cboeHits.reduce((acc, h) => acc + h.count, 0);
      const symbols = cboeHits.slice(0, 3).map((h) => h.symbol).join(", ");
      const more = cboeHits.length > 3 ? ` +${cboeHits.length - 3} more` : "";
      return { source: "cboe_fallback", detail: `CBOE delayed · ${total} hits (${symbols}${more})` };
    }
    if (streak && streak.count >= 2) {
      return { source: "cboe_fallback", detail: `CBOE delayed (Schwab 403 x${streak.count})` };
    }
    if (cool) {
      return { source: "cboe_fallback", detail: `CBOE delayed (Schwab cooldown ${cool.secondsRemaining}s)` };
    }
    return { source: "schwab_live", detail: "Schwab live" };
  }

  // Quotes / history: cooldown means we're serving cached
  if (cool) {
    return { source: "schwab_cached", detail: `Cached (cooldown ${cool.secondsRemaining}s)` };
  }
  if (streak && streak.count >= 2) {
    return { source: "schwab_cached", detail: `Cached (403 x${streak.count})` };
  }
  return { source: "schwab_live", detail: "Schwab live" };
}

// ─── Status pill (used in header) ────────────────────────────────────────────

export function SchwabStatusPill({ onClick }: { onClick: () => void }) {
  const { data } = useQuery<SchwabStatus>({
    queryKey: ["/api/schwab/status"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/schwab/status");
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 55_000,
  });

  if (!data) return null;

  const isConnected = data.connected && !data.needsReauth;

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition hover:opacity-80"
      style={{
        borderColor: isConnected ? "rgb(16 185 129 / 0.4)" : "rgb(245 158 11 / 0.4)",
        background: isConnected ? "rgb(16 185 129 / 0.08)" : "rgb(245 158 11 / 0.08)",
      }}
      data-testid="schwab-status-pill"
      title={isConnected ? "Schwab Live — click to manage" : "Schwab disconnected — click to connect"}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isConnected ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
        }`}
        aria-hidden
      />
      <span
        className="font-mono text-[9px] font-semibold uppercase tracking-wider"
        style={{ color: isConnected ? "#34d399" : "#fbbf24" }}
      >
        {isConnected ? "SCHWAB LIVE" : data.connected ? "SCHWAB" : "DISCONNECTED"}
      </span>
    </button>
  );
}

// ─── Source badge ─────────────────────────────────────────────────────────────

function SourceBadge({ source, detail }: { source: SourceState; detail?: string }) {
  const styles: Record<SourceState, { color: string; dot: string; pulse: boolean; label: string }> = {
    schwab_live:    { color: "#34d399", dot: "bg-emerald-400", pulse: true,  label: "Schwab LIVE" },
    schwab_cached:  { color: "#a3e635", dot: "bg-lime-400",     pulse: false, label: "Schwab cached" },
    cboe_fallback:  { color: "#fbbf24", dot: "bg-amber-400",    pulse: false, label: "CBOE delayed" },
    disconnected:   { color: "#fb923c", dot: "bg-orange-400",   pulse: false, label: "Schwab disconnected" },
    offline:        { color: "#f87171", dot: "bg-red-500",      pulse: false, label: "Offline" },
  };
  const s = styles[source];
  return (
    <span className="flex items-center gap-1 text-[10px]" style={{ color: s.color }} title={detail}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot} ${s.pulse ? "animate-pulse" : ""}`} />
      <span>{s.label}</span>
      {detail && source !== "schwab_live" && (
        <span className="text-muted-foreground/70 ml-0.5 truncate max-w-[140px]">· {detail}</span>
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

  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useQuery<SchwabStatus>({
    queryKey: ["/api/schwab/status"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/schwab/status");
      return r.json();
    },
    refetchInterval: open ? 10_000 : false,
    staleTime: 8_000,
    enabled: open,
  });

  const { data: diag } = useQuery<SchwabDiag>({
    queryKey: ["/api/schwab/diag"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/schwab/diag");
      return r.json();
    },
    refetchInterval: open ? 5_000 : false,
    enabled: open,
  });

  const { data: authUrlData } = useQuery<{ url: string }>({
    queryKey: ["/api/schwab/auth-url"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/schwab/auth-url");
      return r.json();
    },
    enabled: open,
    staleTime: Infinity,
  });

  // Normalize whatever the user pastes into a full redirect URL the server understands.
  // Accepts: full URL, code= fragment, or raw code string.
  const normalizeInput = (raw: string): string => {
    const s = raw.trim();
    if (!s) return "";
    if (s.startsWith("http")) return s;
    if (s.includes("code=")) return `https://127.0.0.1/?${s.replace(/^[?&]/, "")}`;
    // Assume raw code
    return `https://127.0.0.1/?code=${encodeURIComponent(s)}`;
  };

  // Connect mutation
  const connectMut = useMutation({
    mutationFn: async (url: string) => {
      const normalized = normalizeInput(url);
      const r = await apiRequest("POST", "/api/schwab/callback", { redirectedUrl: normalized });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message ?? "Connection failed");
      return data;
    },
    onSuccess: () => {
      toast({ title: "Schwab connected", description: "Live market data is now active." });
      setRedirectedUrl("");
      setStep("idle");
      queryClient.invalidateQueries({ queryKey: ["/api/schwab/status"] });
      refetchStatus();
    },
    onError: (e: Error) => {
      toast({ title: "Connection failed", description: e.message, variant: "destructive" });
    },
  });

  // Auto-submit when a valid-looking URL is pasted
  useEffect(() => {
    const s = redirectedUrl.trim();
    if (!s || connectMut.isPending) return;
    const looksValid =
      (s.startsWith("http") && s.includes("code=")) ||
      (s.includes("code=") && s.length > 10);
    if (looksValid) {
      const t = setTimeout(() => connectMut.mutate(s), 250);
      return () => clearTimeout(t);
    }
  }, [redirectedUrl]);

  // Disconnect mutation
  const disconnectMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/schwab/disconnect");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Disconnected from Schwab" });
      queryClient.invalidateQueries({ queryKey: ["/api/schwab/status"] });
      refetchStatus();
    },
  });

  const handleOpenAuth = () => {
    if (authUrlData?.url) {
      window.open(authUrlData.url, "_blank", "noopener,noreferrer");
      setStep("waiting_for_paste");
    }
  };

  const handleConnect = () => {
    if (!redirectedUrl.trim()) {
      toast({ title: "Paste the redirected URL first", variant: "destructive" });
      return;
    }
    connectMut.mutate(redirectedUrl.trim());
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setRedirectedUrl(text);
        // effect will auto-submit if valid
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="schwab-settings-dialog">
        <DialogHeader>
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
                  <span className="flex items-center gap-1 text-[10px] text-emerald-400 animate-pulse">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    LIVE
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    <span>Token expires: <span className="text-foreground font-mono">{formatDuration(status?.expiresIn ?? 0)}</span></span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    <span>Refresh valid: <span className="text-foreground font-mono">{formatDuration(status?.refreshExpiresIn ?? 0)}</span></span>
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-[11px]"
                    onClick={handleOpenAuth}
                    data-testid="reauth-schwab-btn"
                  >
                    <RefreshCw className="mr-1 h-3 w-3" />
                    Re-authenticate
                  </Button>
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
                  <div className="text-sm font-medium">Not connected</div>
                  <div className="text-[11px] text-muted-foreground">Schwab disconnected — serving cached snapshots or CBOE delayed data. Connect Schwab for live data.</div>
                </div>
              </div>
            )}
          </div>

          {/* OAuth flow (show if disconnected or needs reauth) */}
          {(!isConnected) && (
            <div className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Connect Your Schwab Account
              </div>

              {/* Step 1 */}
              <div className="rounded-md border border-border/40 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold">1</span>
                  <span className="text-xs font-medium">Open Schwab authorization page</span>
                </div>
                <Button
                  size="sm"
                  className="w-full bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs"
                  onClick={handleOpenAuth}
                  disabled={!authUrlData?.url}
                  data-testid="open-schwab-auth-btn"
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Open Schwab Login
                </Button>
              </div>

              {/* Step 2 */}
              <div className={`rounded-md border p-3 space-y-2 transition-opacity ${step === "waiting_for_paste" ? "border-amber-500/40 bg-amber-500/5 opacity-100" : "border-border/40 opacity-60"}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold">2</span>
                    <span className="text-xs font-medium">Paste anywhere on the page</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px] px-2"
                    onClick={handlePasteFromClipboard}
                    disabled={connectMut.isPending}
                    data-testid="paste-clipboard-btn"
                  >
                    Paste from clipboard
                  </Button>
                </div>
                <div className="text-[10px] text-muted-foreground leading-snug">
                  After logging in, Schwab redirects to{" "}
                  <code className="rounded bg-muted px-1 text-amber-300">https://127.0.0.1/?code=...</code>.{" "}
                  Paste the full URL, just the code, or <span className="text-foreground">code=...</span> — we'll auto-connect.
                </div>
                <Textarea
                  value={redirectedUrl}
                  onChange={(e) => setRedirectedUrl(e.target.value)}
                  onPaste={(e) => {
                    // Immediate update from paste event for fastest auto-submit
                    const text = e.clipboardData?.getData("text") ?? "";
                    if (text) {
                      e.preventDefault();
                      setRedirectedUrl(text);
                    }
                  }}
                  placeholder="Paste URL or code here — auto-connects"
                  className="font-mono text-[10px] resize-none h-16"
                  data-testid="schwab-callback-url-input"
                />
                {connectMut.isPending && (
                  <div className="flex items-center gap-2 text-[10px] text-amber-300">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Connecting to Schwab...
                  </div>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full text-[10px] h-7"
                  onClick={handleConnect}
                  disabled={connectMut.isPending || !redirectedUrl.trim()}
                  data-testid="complete-connection-btn"
                >
                  {connectMut.isPending ? "Connecting..." : "Connect manually"}
                </Button>
              </div>
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

            {/* Live cooldown / rate-budget banner */}
            {diag && (diag.cooldowns.length > 0 || diag.forbiddenStreaks.length > 0 || diag.requestsLastMinute > diag.maxPerMinute * 0.8) && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-200/90 leading-snug space-y-0.5">
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
              <div className="text-[10px] text-muted-foreground/70">
                Cache: {diag.cacheEntries} entries · Budget: {diag.requestsLastMinute}/{diag.maxPerMinute} req/min
              </div>
            )}
          </div>

          {/* Help text */}
          <div className="rounded-md border border-border/20 bg-muted/10 p-3 text-[10px] text-muted-foreground leading-relaxed">
            <div className="font-semibold text-foreground/70 mb-1">About Schwab Integration</div>
            Schwab access tokens expire every 30 minutes and are silently refreshed. Refresh tokens last 7 days — re-authenticate when prompted.
            Your credentials are stored locally in the app's SQLite database and never transmitted to third parties.
            Option chains require Schwab — Yahoo Finance does not provide reliable chain data.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
