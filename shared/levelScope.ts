// shared/levelScope.ts
//
// Why the same level has different numbers on different panels: each panel adds up a different set of
// expiries. That is on purpose (a 0DTE map and a monthly model answer different questions), but a reader who
// sees a gamma flip of 7,572 on one tab and 7,531 on another reads it as a fault. Each panel states its own
// scope in one line, and says which card uses the nearest expiry only. Pure text.

export type LevelPanel = "today" | "odteMap" | "models" | "chainAudit" | "pivotProjection" | "heatseeker";
export type ModelHorizonKey = "daily" | "weekly" | "monthly" | "quarterly";

/** Calendar-day limits the Models tab uses per view (server/models.ts DTE_MAX; pinned by test). */
export const MODEL_DTE_MAX: Readonly<Record<ModelHorizonKey, number>> = Object.freeze({ daily: 2, weekly: 7, monthly: 45, quarterly: 100 });

const TODAY_REF = "The Today card on Signals uses the nearest expiry only.";

export function levelScopeText(panel: LevelPanel, horizon?: ModelHorizonKey | string | null): string {
  switch (panel) {
    case "today":
    case "odteMap":
      return "These levels use the nearest expiry only. The daily and weekly SPX models on the Models tab use the same ceiling, floor and turning point (the weekly one for the week's last expiry). The monthly model and the chain audit add up more expiries, so their walls and flip are different numbers.";
    case "models": {
      const d = horizon && horizon in MODEL_DTE_MAX ? MODEL_DTE_MAX[horizon as ModelHorizonKey] : null;
      return `These levels add up every expiry ${d != null ? `within ${d} days` : "inside this view's limit"}, so they differ from other tabs. ${TODAY_REF}`;
    }
    case "chainAudit":
      return `Each column adds up its own group of expiries, so the walls and flip differ column to column and from other tabs. ${TODAY_REF}`;
    case "pivotProjection":
      return `The gamma walls drawn here come from the desk's main gamma snapshot (the SPY chain, expiries within 45 days), not the nearest-expiry map, so they differ from other tabs. ${TODAY_REF}`;
    case "heatseeker":
      return "This map is for one expiry at a time. Panels that add up several expiries show different walls and flip.";
  }
}
