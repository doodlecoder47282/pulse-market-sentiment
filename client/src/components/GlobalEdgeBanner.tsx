/**
 * GlobalEdgeBanner — sticky alert strip rendered above tab content.
 *
 * Surfaces the highest-leverage state changes that traders should never miss:
 *   • VIX9D > VIX inversion (short-dated fear premium)
 *   • VVIX > 120 spike (vol-of-vol compression / 0DTE tail risk)
 *   • GEX flip crossover (spot crossed dealer flip strike)
 *
 * Each alert has its own dismiss-this-session state. Reads only from
 * data already fetched elsewhere. The former Kp (geomagnetic) alert was
 * removed: Cosmos output is context, never an alert or trade instruction
 * (review finding 5.3), and the Cosmos "sky" endpoint it called did not exist.
 *
 * No emojis. No localStorage. Touch friendly (≥44px tap targets).
 */
import { useState, useMemo } from "react";
import { AlertTriangle, X, Zap, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  vix?: number | null;
  vix9d?: number | null;
  vvix?: number | null;
  ratio9dOver30d?: number | null;
  /** Spot price (e.g. SPX or SPY ×10) */
  spot?: number | null;
  /** Zero-gamma / dealer flip strike from gamma payload */
  zeroGamma?: number | null;
}

type AlertSpec = {
  id: string;
  tone: "red" | "amber" | "violet";
  icon: React.ReactNode;
  title: string;
  body: string;
};

export default function GlobalEdgeBanner({
  vix,
  vix9d,
  vvix,
  ratio9dOver30d,
  spot,
  zeroGamma,
}: Props) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const alerts = useMemo<AlertSpec[]>(() => {
    const out: AlertSpec[] = [];

    // VIX9D inversion — backwardation in front-end vol curve
    const inverted = ratio9dOver30d != null
      ? ratio9dOver30d > 1.0
      : vix9d != null && vix != null && vix9d > vix;
    if (inverted) {
      const ratio = ratio9dOver30d ?? (vix9d && vix ? vix9d / vix : null);
      out.push({
        id: "vix9d-inversion",
        tone: "red",
        icon: <AlertTriangle className="h-4 w-4" />,
        title: "VIX9D > VIX — front-end backwardation",
        body: `9D/30D ratio ${ratio?.toFixed(3) ?? "—"}. Short-dated fear elevated. Reduce 0DTE long-gamma size; iron flies risky into close.`,
      });
    }

    // VVIX spike — vol-of-vol compression risk
    if (vvix != null && vvix > 120) {
      out.push({
        id: "vvix-spike",
        tone: "amber",
        icon: <Activity className="h-4 w-4" />,
        title: `VVIX ${vvix.toFixed(1)} — vol-of-vol elevated`,
        body: "0DTE tail risk priced in. Expect VIX gap-risk; tighten gamma exposure or hedge with OTM puts.",
      });
    }

    // GEX flip crossover — only if both spot and zeroGamma are present and within 0.3% band
    if (spot != null && zeroGamma != null && spot > 0 && zeroGamma > 0) {
      const distPct = Math.abs(spot - zeroGamma) / spot;
      if (distPct < 0.003) {
        out.push({
          id: "gex-flip",
          tone: "amber",
          icon: <Zap className="h-4 w-4" />,
          title: `Spot ${spot.toFixed(2)} at dealer flip ${zeroGamma.toFixed(2)}`,
          body: "Crossing zero-gamma reverses dealer hedging. Above flip = vol suppression; below = trend amplification. Size accordingly.",
        });
      }
    }

    return out.filter((a) => !dismissed.has(a.id));
  }, [vix, vix9d, vvix, ratio9dOver30d, spot, zeroGamma, dismissed]);

  if (alerts.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="global-edge-banner">
      {alerts.map((a) => (
        <div
          key={a.id}
          data-testid={`alert-${a.id}`}
          className={cn(
            "flex items-start gap-3 rounded-md border px-3 py-2 text-sm",
            a.tone === "red" && "border-red-500/50 bg-red-500/10 text-red-200",
            a.tone === "amber" && "border-amber-500/50 bg-amber-500/10 text-amber-200",
            a.tone === "violet" && "border-violet-500/50 bg-violet-500/10 text-violet-200"
          )}
        >
          <div className="flex-shrink-0 pt-0.5">{a.icon}</div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{a.title}</div>
            <div className="mt-0.5 text-[12px] opacity-90 leading-snug">{a.body}</div>
          </div>
          <button
            type="button"
            onClick={() => setDismissed((s) => new Set(s).add(a.id))}
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md opacity-60 transition hover:bg-black/20 hover:opacity-100 sm:h-8 sm:w-8"
            aria-label={`Dismiss ${a.title}`}
            data-testid={`alert-dismiss-${a.id}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
