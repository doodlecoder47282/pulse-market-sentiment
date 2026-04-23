/**
 * FlowAlertsPanel.tsx
 * Live flow alert subsystem — ONLY shown inside the Flow tab, nowhere else.
 * Polls Schwab option chain data every 30s, computes alerts client-side.
 * If Schwab is disconnected, shows a prompt to connect.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Bell, X, ChevronDown, ChevronUp, AlertTriangle, Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FlowAlertType = "UNUSUAL_VOL" | "BLOCK" | "MAGNET" | "PC_SHIFT" | "WALL";
export type AlertSeverity = "low" | "med" | "high";

export interface FlowAlert {
  id: string;
  ts: number;
  type: FlowAlertType;
  symbol: string;
  strike?: number;
  expiry?: string;
  side?: "C" | "P";
  message: string;
  severity: AlertSeverity;
}

interface SchwabStatus {
  connected: boolean;
  expiresIn: number;
  refreshExpiresIn: number;
  needsReauth: boolean;
}

interface OptionContract {
  bid: number;
  ask: number;
  last: number;
  mark: number;
  totalVolume: number;
  openInterest: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  volatility?: number;
  strikePrice?: number;
}

// ─── Alert computation ────────────────────────────────────────────────────────

function generateAlertId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function computeAlerts(
  prevChainRef: Record<string, Record<string, OptionContract[]>> | null,
  callMap: Record<string, Record<string, OptionContract[]>>,
  putMap: Record<string, Record<string, OptionContract[]>>,
  symbol: string,
  prevPcr: number | null,
  currentPcr: number | null,
): FlowAlert[] {
  const alerts: FlowAlert[] = [];
  const now = Date.now();

  // Helper: get total vol / OI for a strike across an expiry map
  function getStrikeStats(map: Record<string, Record<string, OptionContract[]>>) {
    const strikeVol: Record<string, number> = {};
    const strikeOI: Record<string, number> = {};
    for (const expKey of Object.keys(map)) {
      for (const strike of Object.keys(map[expKey])) {
        const contracts = map[expKey][strike];
        const vol = contracts.reduce((s, c) => s + (c.totalVolume ?? 0), 0);
        const oi = contracts.reduce((s, c) => s + (c.openInterest ?? 0), 0);
        strikeVol[strike] = (strikeVol[strike] ?? 0) + vol;
        strikeOI[strike] = (strikeOI[strike] ?? 0) + oi;
      }
    }
    return { strikeVol, strikeOI };
  }

  const callStats = getStrikeStats(callMap);
  const putStats = getStrikeStats(putMap);

  // 1. UNUSUAL_VOLUME — contract volume ≥ 3× OI AND volume ≥ 500
  for (const [strikeStr, vol] of Object.entries(callStats.strikeVol)) {
    const oi = callStats.strikeOI[strikeStr] ?? 0;
    if (oi > 0 && vol >= 3 * oi && vol >= 500) {
      alerts.push({
        id: generateAlertId(),
        ts: now,
        type: "UNUSUAL_VOL",
        symbol,
        strike: parseFloat(strikeStr),
        side: "C",
        message: `Unusual call volume at ${strikeStr} — ${vol.toLocaleString()} contracts vs ${oi.toLocaleString()} OI (${(vol / oi).toFixed(1)}×)`,
        severity: vol >= 2000 ? "high" : vol >= 1000 ? "med" : "low",
      });
    }
  }
  for (const [strikeStr, vol] of Object.entries(putStats.strikeVol)) {
    const oi = putStats.strikeOI[strikeStr] ?? 0;
    if (oi > 0 && vol >= 3 * oi && vol >= 500) {
      alerts.push({
        id: generateAlertId(),
        ts: now,
        type: "UNUSUAL_VOL",
        symbol,
        strike: parseFloat(strikeStr),
        side: "P",
        message: `Unusual put volume at ${strikeStr} — ${vol.toLocaleString()} contracts vs ${oi.toLocaleString()} OI (${(vol / oi).toFixed(1)}×)`,
        severity: vol >= 2000 ? "high" : vol >= 1000 ? "med" : "low",
      });
    }
  }

  // 2. BLOCK_TRADE — single strike with volume ≥ 500 (institutional size)
  const allStrikes = new Set([...Object.keys(callStats.strikeVol), ...Object.keys(putStats.strikeVol)]);
  for (const strikeStr of Array.from(allStrikes)) {
    const callVol = callStats.strikeVol[strikeStr] ?? 0;
    const putVol = putStats.strikeVol[strikeStr] ?? 0;
    const totalVol = callVol + putVol;
    if (totalVol >= 2000) {
      const dominant: "C" | "P" = callVol >= putVol ? "C" : "P";
      alerts.push({
        id: generateAlertId(),
        ts: now,
        type: "BLOCK",
        symbol,
        strike: parseFloat(strikeStr),
        side: dominant,
        message: `Block-level activity at ${strikeStr} — ${totalVol.toLocaleString()} total contracts (${callVol.toLocaleString()}C / ${putVol.toLocaleString()}P)`,
        severity: totalVol >= 5000 ? "high" : "med",
      });
    }
  }

  // 3. P/C SKEW SHIFT — ratio moved > 0.2 since last poll
  if (prevPcr !== null && currentPcr !== null) {
    const shift = Math.abs(currentPcr - prevPcr);
    if (shift > 0.2) {
      const direction = currentPcr > prevPcr ? "increasing (bearish shift)" : "decreasing (bullish shift)";
      alerts.push({
        id: generateAlertId(),
        ts: now,
        type: "PC_SHIFT",
        symbol,
        message: `P/C ratio shifted ${shift.toFixed(2)} — now ${currentPcr.toFixed(2)}, ${direction}`,
        severity: shift > 0.4 ? "high" : "med",
      });
    }
  }

  // 4. WALL_BUILD — check for large gamma concentration at any single strike
  // (proxied via large OI at strikes not previously dominant)
  for (const [strikeStr, oi] of Object.entries(callStats.strikeOI)) {
    if (oi >= 10000) {
      alerts.push({
        id: generateAlertId(),
        ts: now,
        type: "WALL",
        symbol,
        strike: parseFloat(strikeStr),
        side: "C",
        message: `Call wall building at ${strikeStr} — ${oi.toLocaleString()} open interest`,
        severity: oi >= 50000 ? "high" : oi >= 25000 ? "med" : "low",
      });
    }
  }
  for (const [strikeStr, oi] of Object.entries(putStats.strikeOI)) {
    if (oi >= 10000) {
      alerts.push({
        id: generateAlertId(),
        ts: now,
        type: "WALL",
        symbol,
        strike: parseFloat(strikeStr),
        side: "P",
        message: `Put wall building at ${strikeStr} — ${oi.toLocaleString()} open interest`,
        severity: oi >= 50000 ? "high" : oi >= 25000 ? "med" : "low",
      });
    }
  }

  // Deduplicate: keep only the highest-severity per (type+strike+side)
  const seen = new Set<string>();
  const deduped: FlowAlert[] = [];
  for (const a of alerts) {
    const key = `${a.type}-${a.strike ?? "x"}-${a.side ?? "x"}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(a);
    }
  }
  return deduped.slice(0, 15); // cap at 15 per poll
}

// ─── Alert row component ──────────────────────────────────────────────────────

const SEVERITY_CLASSES: Record<AlertSeverity, { dot: string; border: string; bg: string; text: string }> = {
  low: { dot: "bg-amber-400", border: "border-amber-500/30", bg: "bg-amber-500/5", text: "text-amber-300" },
  med: { dot: "bg-orange-400", border: "border-orange-500/30", bg: "bg-orange-500/5", text: "text-orange-300" },
  high: { dot: "bg-red-500", border: "border-red-500/40", bg: "bg-red-500/8", text: "text-red-300" },
};

const TYPE_LABELS: Record<FlowAlertType, string> = {
  UNUSUAL_VOL: "UNUSUAL VOL",
  BLOCK: "BLOCK TRADE",
  MAGNET: "STRIKE MAGNET",
  PC_SHIFT: "P/C SHIFT",
  WALL: "WALL BUILD",
};

function AlertRow({ alert, onDismiss }: { alert: FlowAlert; onDismiss: (id: string) => void }) {
  const s = SEVERITY_CLASSES[alert.severity];
  const time = new Date(alert.ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/New_York",
  });

  return (
    <div
      className={`flex items-start gap-2 rounded-md border ${s.border} ${s.bg} px-3 py-2`}
      data-testid={`flow-alert-${alert.id}`}
    >
      {/* Severity dot */}
      <div className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${s.dot}`} aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        {/* Header row */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`font-mono text-[9px] font-semibold uppercase tracking-wider ${s.text}`}>
            {TYPE_LABELS[alert.type]}
          </span>
          <span className="font-mono text-[9px] text-muted-foreground">{alert.symbol}</span>
          {alert.strike && (
            <span className="font-mono text-[9px] text-muted-foreground">
              ${alert.strike.toFixed(0)}{alert.side && ` ${alert.side}`}
            </span>
          )}
          <span className="font-mono text-[8px] text-muted-foreground/60 ml-auto">{time} ET</span>
        </div>
        {/* Message */}
        <div className="text-[10px] leading-snug text-muted-foreground">{alert.message}</div>
      </div>
      {/* Dismiss */}
      <button
        onClick={() => onDismiss(alert.id)}
        className="mt-0.5 flex-shrink-0 rounded p-0.5 text-muted-foreground/50 hover:text-muted-foreground transition"
        aria-label="Dismiss alert"
        data-testid={`dismiss-alert-${alert.id}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface FlowAlertsPanelProps {
  symbol: string;
  onOpenSettings?: () => void;
}

export function FlowAlertsPanel({ symbol, onOpenSettings }: FlowAlertsPanelProps) {
  const [alerts, setAlerts] = useState<FlowAlert[]>([]);
  const [isOpen, setIsOpen] = useState(true);
  const prevPcrRef = useRef<number | null>(null);
  const prevChainRef = useRef<any>(null);

  // Check Schwab connection
  const { data: statusData } = useQuery<SchwabStatus>({
    queryKey: ["/api/schwab/status"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/schwab/status");
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const isConnected = statusData?.connected === true;

  // Poll option chain every 30s when connected
  const { data: chainData } = useQuery<any>({
    queryKey: ["/api/market/option-chain", symbol],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/market/option-chain/${symbol}?dte=7`);
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
    enabled: isConnected,
  });

  // Compute P/C ratio from chain data
  const computePcr = useCallback((chain: any): number | null => {
    if (!chain || chain.error) return null;
    let totalCallVol = 0;
    let totalPutVol = 0;
    if (chain.callExpDateMap) {
      for (const expKey of Object.keys(chain.callExpDateMap)) {
        for (const strikes of Object.values(chain.callExpDateMap[expKey] as any)) {
          for (const c of strikes as any[]) totalCallVol += c.totalVolume ?? 0;
        }
      }
    }
    if (chain.putExpDateMap) {
      for (const expKey of Object.keys(chain.putExpDateMap)) {
        for (const strikes of Object.values(chain.putExpDateMap[expKey] as any)) {
          for (const c of strikes as any[]) totalPutVol += c.totalVolume ?? 0;
        }
      }
    }
    return totalCallVol > 0 ? totalPutVol / totalCallVol : null;
  }, []);

  // Run alert engine whenever chain data updates
  useEffect(() => {
    if (!chainData || chainData.error || !isConnected) return;
    const currentPcr = computePcr(chainData);
    const newAlerts = computeAlerts(
      prevChainRef.current,
      chainData.callExpDateMap ?? {},
      chainData.putExpDateMap ?? {},
      symbol,
      prevPcrRef.current,
      currentPcr,
    );
    if (newAlerts.length > 0) {
      setAlerts((prev) => {
        // Prepend new, keep max 30, avoid exact duplicates
        const existingIds = new Set(prev.map((a) => a.id));
        const fresh = newAlerts.filter((a) => !existingIds.has(a.id));
        return [...fresh, ...prev].slice(0, 30);
      });
    }
    prevPcrRef.current = currentPcr;
    prevChainRef.current = chainData;
  }, [chainData, symbol, isConnected, computePcr]);

  const dismissAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const dismissAll = useCallback(() => setAlerts([]), []);

  const highCount = alerts.filter((a) => a.severity === "high").length;
  const totalCount = alerts.length;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5">
        {/* Header */}
        <CollapsibleTrigger asChild>
          <button
            className="flex w-full items-center justify-between px-4 py-3 text-left"
            data-testid="flow-alerts-toggle"
          >
            <div className="flex items-center gap-2">
              <Bell className={`h-3.5 w-3.5 ${totalCount > 0 ? "text-amber-400" : "text-muted-foreground"}`} />
              <span className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                Flow Alerts
              </span>
              {totalCount > 0 && (
                <div className="flex items-center gap-1">
                  <span className="flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-500 px-1 font-mono text-[9px] font-bold text-black">
                    {totalCount}
                  </span>
                  {highCount > 0 && (
                    <span className="flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 font-mono text-[9px] font-bold text-white">
                      {highCount} HIGH
                    </span>
                  )}
                </div>
              )}
              {/* Connection status indicator */}
              <div className="flex items-center gap-1 ml-2">
                {isConnected ? (
                  <span className="flex items-center gap-1 text-[9px] text-emerald-400">
                    <Wifi className="h-2.5 w-2.5" /> SCHWAB LIVE
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-[9px] text-muted-foreground/60">
                    <WifiOff className="h-2.5 w-2.5" /> OFFLINE
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {totalCount > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); dismissAll(); }}
                  className="rounded px-2 py-0.5 text-[9px] text-muted-foreground hover:text-foreground transition border border-border/40 hover:border-border"
                  data-testid="dismiss-all-alerts"
                >
                  clear all
                </button>
              )}
              {isOpen ? (
                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t border-amber-500/10 px-4 pb-4 pt-3 space-y-2">
            {!isConnected ? (
              /* Disconnected state */
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <WifiOff className="h-8 w-8 text-muted-foreground/40" />
                <div>
                  <div className="text-sm font-medium text-muted-foreground">Connect Schwab for live flow alerts</div>
                  <div className="text-xs text-muted-foreground/60 mt-1">
                    Real-time option chain data required to detect unusual volume, block trades, and wall formation.
                  </div>
                </div>
                {onOpenSettings && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                    onClick={onOpenSettings}
                    data-testid="connect-schwab-flow-btn"
                  >
                    Connect Schwab
                  </Button>
                )}
              </div>
            ) : alerts.length === 0 ? (
              /* Connected, no alerts yet */
              <div className="flex flex-col items-center gap-2 py-4 text-center">
                <Bell className="h-6 w-6 text-muted-foreground/30" />
                <div className="text-xs text-muted-foreground/60">
                  Monitoring {symbol} flow — no alerts yet
                </div>
                <div className="text-[9px] text-muted-foreground/40">
                  Polling every 30s · alerts fire on unusual volume, block trades, P/C shifts, wall formation
                </div>
              </div>
            ) : (
              /* Alert rows */
              <div className="space-y-1.5 max-h-60 overflow-y-auto">
                {alerts.map((alert) => (
                  <AlertRow key={alert.id} alert={alert} onDismiss={dismissAlert} />
                ))}
              </div>
            )}

            {/* Alert type legend */}
            {isConnected && (
              <div className="flex flex-wrap gap-2 pt-2 border-t border-border/20">
                {(["UNUSUAL_VOL", "BLOCK", "PC_SHIFT", "WALL"] as FlowAlertType[]).map((type) => (
                  <span key={type} className="text-[8px] uppercase tracking-wider text-muted-foreground/40">
                    {TYPE_LABELS[type]}
                  </span>
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
