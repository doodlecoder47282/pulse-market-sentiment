// ThresholdTuner — runtime whale-gate config (premium floor, vol/OI, DTE, delta window).
// Uses /api/flow/config (GET / PATCH / POST reset). NO localStorage.

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sliders, RotateCcw, Save } from "lucide-react";

interface FlowConfig {
  priority: string[];
  watchlist: string[];
  premiumFloor: number;
  volOiRatio: number;
  minDte: number;
  requiredTag: "ABOVE_ASK" | "AT_ASK" | "ANY";
  deltaMin: number;
  deltaMax: number;
}

interface ConfigResponse {
  ok: boolean;
  config?: FlowConfig;
  error?: string;
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

export function ThresholdTuner() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<ConfigResponse>({
    queryKey: ["/api/flow/config"],
    refetchInterval: 30_000,
  });

  // Local form state — only mutates on Save
  const [premiumFloor, setPremiumFloor] = useState<string>("");
  const [volOiRatio, setVolOiRatio] = useState<string>("");
  const [minDte, setMinDte] = useState<string>("");
  const [deltaMin, setDeltaMin] = useState<string>("");
  const [deltaMax, setDeltaMax] = useState<string>("");
  const [watchlist, setWatchlist] = useState<string>("");
  const [requiredTag, setRequiredTag] = useState<FlowConfig["requiredTag"]>("ABOVE_ASK");
  const [statusMsg, setStatusMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Hydrate form from server config when it arrives
  useEffect(() => {
    if (data?.config) {
      setPremiumFloor(String(data.config.premiumFloor));
      setVolOiRatio(String(data.config.volOiRatio));
      setMinDte(String(data.config.minDte));
      setDeltaMin(String(data.config.deltaMin));
      setDeltaMax(String(data.config.deltaMax));
      setWatchlist(data.config.watchlist.join(","));
      setRequiredTag(data.config.requiredTag);
    }
  }, [data?.config?.premiumFloor, data?.config?.volOiRatio, data?.config?.minDte, data?.config?.deltaMin, data?.config?.deltaMax]);

  const saveMut = useMutation({
    mutationFn: async (patch: Partial<FlowConfig>) => {
      const res = await apiRequest("PATCH", "/api/flow/config", patch);
      return (await res.json()) as ConfigResponse;
    },
    onSuccess: (r) => {
      if (r.ok) {
        setStatusMsg({ kind: "ok", text: "saved — engine picks it up next cycle" });
        qc.invalidateQueries({ queryKey: ["/api/flow/config"] });
      } else {
        setStatusMsg({ kind: "err", text: r.error ?? "save failed" });
      }
    },
    onError: (e: any) => setStatusMsg({ kind: "err", text: e?.message ?? "save failed" }),
  });

  const resetMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/flow/config/reset", {});
      return (await res.json()) as ConfigResponse;
    },
    onSuccess: (r) => {
      if (r.ok) {
        setStatusMsg({ kind: "ok", text: "reset to defaults" });
        qc.invalidateQueries({ queryKey: ["/api/flow/config"] });
      }
    },
  });

  const handleSave = () => {
    setStatusMsg(null);
    const patch: Partial<FlowConfig> = {};
    const pf = Number(premiumFloor);
    const vo = Number(volOiRatio);
    const md = Number(minDte);
    const dmin = Number(deltaMin);
    const dmax = Number(deltaMax);
    if (Number.isFinite(pf) && pf !== data?.config?.premiumFloor) patch.premiumFloor = pf;
    if (Number.isFinite(vo) && vo !== data?.config?.volOiRatio) patch.volOiRatio = vo;
    if (Number.isFinite(md) && md !== data?.config?.minDte) patch.minDte = md;
    if (Number.isFinite(dmin) && dmin !== data?.config?.deltaMin) patch.deltaMin = dmin;
    if (Number.isFinite(dmax) && dmax !== data?.config?.deltaMax) patch.deltaMax = dmax;
    if (requiredTag !== data?.config?.requiredTag) patch.requiredTag = requiredTag;
    const wl = watchlist.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (wl.length > 0 && wl.join(",") !== (data?.config?.watchlist ?? []).join(",")) {
      patch.watchlist = wl;
    }
    if (Object.keys(patch).length === 0) {
      setStatusMsg({ kind: "ok", text: "no changes" });
      return;
    }
    saveMut.mutate(patch);
  };

  if (isLoading) {
    return (
      <Card data-testid="card-threshold-tuner">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sliders className="w-4 h-4" /> Whale gate thresholds
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </CardContent>
      </Card>
    );
  }

  if (error || !data?.config) {
    return (
      <Card data-testid="card-threshold-tuner">
        <CardHeader>
          <CardTitle className="text-base">Whale gate thresholds</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground" data-testid="text-tuner-error">
            config unavailable — engine running with defaults
          </p>
        </CardContent>
      </Card>
    );
  }

  const cfg = data.config;
  return (
    <Card data-testid="card-threshold-tuner">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <Sliders className="w-4 h-4" /> Whale gate thresholds
          </span>
          <Badge variant="outline" className="text-xs" data-testid="badge-active-config">
            live: {fmtMoney(cfg.premiumFloor)} · {cfg.volOiRatio}x · Δ{cfg.deltaMin.toFixed(2)}-{cfg.deltaMax.toFixed(2)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">premium floor ($)</span>
            <Input
              type="number"
              value={premiumFloor}
              onChange={(e) => setPremiumFloor(e.target.value)}
              data-testid="input-premium-floor"
              min={100000}
              max={100000000}
              step={100000}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">vol/OI ratio</span>
            <Input
              type="number"
              value={volOiRatio}
              onChange={(e) => setVolOiRatio(e.target.value)}
              data-testid="input-vol-oi"
              min={1}
              max={100}
              step={1}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">min DTE</span>
            <Input
              type="number"
              value={minDte}
              onChange={(e) => setMinDte(e.target.value)}
              data-testid="input-min-dte"
              min={0}
              max={60}
              step={1}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">aggressor tag</span>
            <select
              value={requiredTag}
              onChange={(e) => setRequiredTag(e.target.value as FlowConfig["requiredTag"])}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              data-testid="select-required-tag"
            >
              <option value="ABOVE_ASK">ABOVE_ASK</option>
              <option value="AT_ASK">AT_ASK</option>
              <option value="ANY">ANY</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">delta min (|Δ|)</span>
            <Input
              type="number"
              value={deltaMin}
              onChange={(e) => setDeltaMin(e.target.value)}
              data-testid="input-delta-min"
              min={0}
              max={1}
              step={0.05}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">delta max (|Δ|)</span>
            <Input
              type="number"
              value={deltaMax}
              onChange={(e) => setDeltaMax(e.target.value)}
              data-testid="input-delta-max"
              min={0}
              max={1}
              step={0.05}
            />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">watchlist (comma-separated)</span>
          <Input
            value={watchlist}
            onChange={(e) => setWatchlist(e.target.value)}
            data-testid="input-watchlist"
            placeholder="NVDA,TSLA,AAPL,MSFT,META,GOOGL,AMZN,AMD,AVGO,PLTR,COIN,MSTR"
          />
        </label>
        <div className="text-xs text-muted-foreground" data-testid="text-priority-list">
          priority (locked): {cfg.priority.join(", ")}
        </div>
        <div className="flex items-center gap-2 pt-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saveMut.isPending}
            data-testid="button-save-thresholds"
          >
            <Save className="w-3 h-3 mr-1" />
            {saveMut.isPending ? "saving..." : "save"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => resetMut.mutate()}
            disabled={resetMut.isPending}
            data-testid="button-reset-thresholds"
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            reset
          </Button>
          {statusMsg && (
            <span
              className={`text-xs ${statusMsg.kind === "ok" ? "text-green-500" : "text-red-500"}`}
              data-testid="text-tuner-status"
            >
              {statusMsg.text}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
