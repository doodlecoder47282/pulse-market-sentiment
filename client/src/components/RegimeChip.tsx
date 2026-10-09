// RegimeChip.tsx
// Compact cross-tab regime context chip.
// Displays the highest-conviction axis (e.g. "Regime: cyclical-led +1.8sigma")
// so traders never lose macro context when on Signals / Models / Trade Desk.
//
// Reads /api/regime (4w window) — TanStack Query dedupes the call across tabs.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Activity } from "lucide-react";

interface AxisSummary {
  axis: "risk" | "growth" | "cyclical" | "size";
  label: string;
  compositeZ: number;
  direction: 1 | -1 | 0;
  stage: string;
  conviction: number;
  narrative: string;
  readings?: unknown[];
}
interface RegimeResp {
  capturedAt: number;
  window: string;
  headline: string;
  narrative: string;
  axes: AxisSummary[];
  dataState?: "ok" | "partial" | "unavailable";
}

const POS_COPY: Record<AxisSummary["axis"], string> = {
  risk: "risk-on",
  growth: "growth-led",
  cyclical: "cyclical-led",
  size: "small-cap-led",
};
const NEG_COPY: Record<AxisSummary["axis"], string> = {
  risk: "risk-off",
  growth: "value-led",
  cyclical: "defensive-led",
  size: "large-cap-led",
};

export function RegimeChip({ origin }: { origin?: string }) {
  const { data } = useQuery<RegimeResp>({
    queryKey: ["/api/regime", "w4"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/regime?window=w4");
      return r.json();
    },
    refetchInterval: 5 * 60_000,
    staleTime: 4 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (!data || !data.axes?.length) return null;
  const testId = `regime-chip${origin ? `-${origin}` : ""}`;
  const chipBase = "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider";

  // This is the sector/style ROTATION read, distinct from the dealer-gamma
  // regime in the banner, so it is labelled "Rotation". Axes without readings
  // are missing data and never count as balanced.
  const measured = data.axes.filter((a) => !Array.isArray(a.readings) || a.readings.length > 0);
  if (data.dataState === "unavailable" || !measured.length) {
    return (
      <span
        className={`${chipBase} border-border/40 bg-muted/30 text-muted-foreground`}
        data-testid={testId}
        title="Sector rotation read unavailable: no price history from Schwab"
      >
        <Activity className="h-2.5 w-2.5" />
        Rotation: unavailable
      </span>
    );
  }

  // Pick axis with strongest |compositeZ|
  const top = [...measured].sort(
    (a, b) => Math.abs(b.compositeZ) - Math.abs(a.compositeZ)
  )[0];
  if (!top || Math.abs(top.compositeZ) < 0.5) {
    // Balanced — show neutral chip
    return (
      <span
        className={`${chipBase} border-border/40 bg-muted/30 text-muted-foreground`}
        data-testid={testId}
        title="Sector rotation balanced: no dominant axis"
      >
        <Activity className="h-2.5 w-2.5" />
        Rotation: balanced
      </span>
    );
  }

  const dirCopy = top.direction === 1 ? POS_COPY[top.axis] : top.direction === -1 ? NEG_COPY[top.axis] : "neutral";
  const sign = top.compositeZ > 0 ? "+" : "";
  const tone =
    top.direction === 1
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : top.direction === -1
        ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
        : "border-border/40 bg-muted/30 text-muted-foreground";

  return (
    <span
      className={`${chipBase} ${tone}`}
      data-testid={testId}
      title={`${top.label} ${dirCopy} · z=${sign}${top.compositeZ.toFixed(2)} · ${data.headline}`}
    >
      <Activity className="h-2.5 w-2.5" />
      Rotation: {dirCopy} {sign}{top.compositeZ.toFixed(1)}σ
    </span>
  );
}
