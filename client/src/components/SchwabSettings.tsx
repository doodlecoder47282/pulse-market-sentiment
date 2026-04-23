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
        {isConnected ? "SCHWAB LIVE" : data.connected ? "SCHWAB" : "YAHOO"}
      </span>
    </button>
  );
}

// ─── Source badge ─────────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: "schwab" | "yahoo" | "offline" }) {
  if (source === "schwab") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
        Schwab LIVE
      </span>
    );
  }
  if (source === "yahoo") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Yahoo (fallback)
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[10px] text-red-400">
      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      Offline
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

  const { data: authUrlData } = useQuery<{ url: string }>({
    queryKey: ["/api/schwab/auth-url"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/schwab/auth-url");
      return r.json();
    },
    enabled: open,
    staleTime: Infinity,
  });

  // Connect mutation
  const connectMut = useMutation({
    mutationFn: async (url: string) => {
      const r = await apiRequest("POST", "/api/schwab/callback", { redirectedUrl: url });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message ?? "Connection failed");
      return data;
    },
    onSuccess: () => {
      toast({ title: "Schwab connected!", description: "Live market data is now active." });
      setRedirectedUrl("");
      setStep("idle");
      queryClient.invalidateQueries({ queryKey: ["/api/schwab/status"] });
      refetchStatus();
    },
    onError: (e: Error) => {
      toast({ title: "Connection failed", description: e.message, variant: "destructive" });
    },
  });

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
                  <div className="text-[11px] text-muted-foreground">Data sourced from Yahoo Finance (delayed). Connect Schwab for live data.</div>
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
              <div className={`rounded-md border p-3 space-y-2 transition-opacity ${step === "waiting_for_paste" ? "border-amber-500/40 bg-amber-500/5 opacity-100" : "border-border/40 opacity-50"}`}>
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold">2</span>
                  <span className="text-xs font-medium">Paste the redirected URL</span>
                </div>
                <div className="text-[10px] text-muted-foreground leading-snug">
                  After logging in and approving access, Schwab will redirect your browser to a URL starting with{" "}
                  <code className="rounded bg-muted px-1 text-amber-300">https://127.0.0.1/?code=...</code>
                  {" "}— copy that entire URL and paste it here.
                </div>
                <Textarea
                  value={redirectedUrl}
                  onChange={(e) => setRedirectedUrl(e.target.value)}
                  placeholder="https://127.0.0.1/?code=C0...&session=..."
                  className="font-mono text-[10px] resize-none h-16"
                  data-testid="schwab-callback-url-input"
                />
                <Button
                  size="sm"
                  className="w-full text-xs"
                  onClick={handleConnect}
                  disabled={connectMut.isPending || !redirectedUrl.trim()}
                  data-testid="complete-connection-btn"
                >
                  {connectMut.isPending ? (
                    <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Connecting...</>
                  ) : (
                    "Complete Connection"
                  )}
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
              {[
                { label: "Quotes (SPY, VIX, indices)", key: "quotes" },
                { label: "Price History (charts)", key: "history" },
                { label: "Option Chains (flow)", key: "chains" },
                { label: "Gamma Levels (models)", key: "gamma" },
              ].map(({ label, key }) => (
                <div
                  key={key}
                  className="flex items-center justify-between rounded-md border border-border/30 bg-muted/10 px-3 py-1.5"
                  data-testid={`datasource-${key}`}
                >
                  <span className="text-[11px] text-muted-foreground">{label}</span>
                  <SourceBadge
                    source={
                      key === "chains"
                        ? (isConnected ? "schwab" : "offline")
                        : (isConnected ? "schwab" : "yahoo")
                    }
                  />
                </div>
              ))}
            </div>
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
