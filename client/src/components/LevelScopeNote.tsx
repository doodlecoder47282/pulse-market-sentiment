// LevelScopeNote — one line saying which expiries a panel's levels add up, so two different numbers for
// "the gamma flip" on two tabs read as two scopes, not a fault (shared/levelScope.ts).
import { levelScopeText, type LevelPanel } from "@shared/levelScope";

export default function LevelScopeNote({ panel, horizon, className = "" }: { panel: LevelPanel; horizon?: string | null; className?: string }) {
  return (
    <p className={`break-words text-[11px] leading-snug text-muted-foreground ${className}`} data-testid={`level-scope-${panel}`}>
      <span className="mr-1 font-semibold uppercase tracking-wide text-[10px] text-amber-300/90">Why levels differ</span>
      {levelScopeText(panel, horizon)}
    </p>
  );
}
