// GammaContextBanner.tsx
// Engine-agnostic GEX context strip that renders above the chart on every engine
// (SVG, Lightweight, and TradingView). Shows each level's price, distance from
// spot, and a tiny positional bar so traders can see where price sits between
// the walls without depending on engine-specific overlays.
//
// Critical for the TradingView engine, where our custom gamma overlay is
// stripped away. This component preserves the GEX context regardless of engine.

import { Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export type GammaLevels = {
  callWall: number;
  callWallGex?: number;
  putWall: number;
  putWallGex?: number;
  zeroGamma: number | null;
  maxPain?: number | null;
  regime: "positive" | "negative";
  totalGex?: number;
};

type Props = {
  spot: number | null | undefined;
  levels: GammaLevels | null | undefined;
  symbol: string;
  supported: boolean;
  asOf?: number;
  timeframe: string;
  engine: "svg" | "lightweight" | "tv";
};

function fmtDist(spot: number, level: number) {
  const diff = level - spot;
  const pct = (diff / spot) * 100;
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff.toFixed(2)} · ${sign}${pct.toFixed(2)}%`;
}

function LevelPill({
  label,
  value,
  color,
  spot,
  hint,
}: {
  label: string;
  value: number | null | undefined;
  color: string;
  spot: number;
  hint?: string;
}) {
  if (value == null) return null;
  const above = value > spot;
  return (
    <div
      className="flex min-w-[120px] flex-col gap-0.5 rounded-md border border-border/40 bg-background/40 px-2 py-1.5"
      data-testid={`gamma-pill-${label.toLowerCase().replace(/\s/g, "-")}`}
    >
      <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">
        <span className={`h-1.5 w-1.5 rounded-sm ${color}`} />
        <span>{label}</span>
        {hint && <span className="text-muted-foreground/60">· {hint}</span>}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-sm font-semibold tabular-nums">
          {value.toFixed(2)}
        </span>
        <span
          className={`font-mono text-[10px] tabular-nums ${
            above ? "text-emerald-400" : "text-rose-400"
          }`}
        >
          {fmtDist(spot, value)}
        </span>
      </div>
    </div>
  );
}

export default function GammaContextBanner({
  spot,
  levels,
  symbol,
  supported,
  asOf,
  timeframe,
  engine,
}: Props) {
  // Non-SPY ticker: show a muted note so user knows why no levels appear
  if (!supported) {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border/40 bg-muted/5 px-3 py-2 text-[11px]"
        data-testid="gamma-banner-unsupported"
      >
        <Zap className="h-3 w-3 text-muted-foreground/60" />
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">
          Gamma walls
        </span>
        <span className="text-muted-foreground">
          not available for {symbol} — options chain wired for SPX/SPY only.
          Switch the watchlist to SPY for live walls, or use TradingView's
          native drawing tools for manual levels on this ticker.
        </span>
      </div>
    );
  }
  if (!levels || spot == null) return null;

  const regimePositive = levels.regime === "positive";
  const tvNote =
    engine === "tv"
      ? "TV engine · overlay stripped, levels shown here"
      : null;

  return (
    <div
      className="space-y-2 rounded-lg border border-amber-500/20 bg-gradient-to-r from-amber-500/5 via-background/40 to-amber-500/5 p-3"
      data-testid="gamma-context-banner"
    >
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Badge
          variant="outline"
          className={
            regimePositive
              ? "border-emerald-500/50 text-emerald-400"
              : "border-rose-500/50 text-rose-400"
          }
        >
          {regimePositive
            ? "POS GAMMA · mean-revert"
            : "NEG GAMMA · trend / breakout"}
        </Badge>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {symbol} · {timeframe}
        </span>
        {tvNote && (
          <span className="text-[10px] text-amber-300/80">{tvNote}</span>
        )}
        {typeof levels.totalGex === "number" && (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            Net GEX{" "}
            <span
              className={
                levels.totalGex >= 0 ? "text-emerald-300" : "text-rose-300"
              }
            >
              {levels.totalGex >= 0 ? "+" : ""}
              {(levels.totalGex / 1e9).toFixed(2)}B
            </span>
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          Spot{" "}
          <span className="text-foreground">{spot.toFixed(2)}</span>
          {asOf && (
            <> · updated {new Date(asOf * 1000).toLocaleTimeString()}</>
          )}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <LevelPill
          label="Call wall"
          value={levels.callWall}
          color="bg-rose-500"
          spot={spot}
          hint={
            levels.callWallGex
              ? `${(levels.callWallGex / 1e6).toFixed(0)}M γ`
              : undefined
          }
        />
        <LevelPill
          label="0γ flip"
          value={levels.zeroGamma}
          color="bg-amber-400"
          spot={spot}
          hint="regime pivot"
        />
        <LevelPill
          label="Put wall"
          value={levels.putWall}
          color="bg-emerald-500"
          spot={spot}
          hint={
            levels.putWallGex
              ? `${(Math.abs(levels.putWallGex) / 1e6).toFixed(0)}M γ`
              : undefined
          }
        />
        <LevelPill
          label="Max pain"
          value={levels.maxPain}
          color="bg-violet-500"
          spot={spot}
          hint="expiry gravity"
        />
      </div>
    </div>
  );
}
