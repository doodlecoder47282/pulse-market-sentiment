import type { z } from "zod";
import { ArchivedTradeBriefSchema } from "../shared/tradeBrief";
import { ReplayCheckSchema } from "../shared/evidenceLedger";

// .2 adds separately dated raw session observations and allows the unchanged
// ATR formula without a current quote. Numerical formula definitions are unchanged.
const SUPPORTED = new Set(["stock-brief-2026-10-01.2", "stock-brief-2026-10-01.3", "stock-brief-2026-10-02.1", "stock-brief-2026-10-02.2"]);
/**
 * Pure numerical replay of stored normalized inputs, NOT provider re-ingestion,
 * raw-candle aggregation, text regeneration, a backtest or new market analysis.
 */
export function verifyStoredCalculations(brief: z.infer<typeof ArchivedTradeBriefSchema>): z.infer<typeof ReplayCheckSchema> {
  const mismatch_ids: string[] = [], unsupported_ids: string[] = [];
  let checked_count = 0;
  const check = (id: string, actual: number, expected: number) => {
    checked_count++;
    if (!Number.isFinite(expected) || Math.abs(actual - expected) > 1e-9 * Math.max(1, Math.abs(expected))) mismatch_ids.push(id);
  };
  if (!SUPPORTED.has(brief.calculation_version)) return {
    status: "unsupported", checked_count: 0, mismatch_ids, unsupported_ids: [brief.calculation_version],
    detail: "Stored output preserved, but this calculation version has no numerical replay implementation.",
  };
  const evidence = new Map(brief.evidence.map(e => [e.id, e]));
  const v = (id: string) => evidence.get(id)?.value ?? NaN;
  const h = v("period-h"), l = v("period-l"), c = v("period-c"), pivot = (h + l + c) / 3;
  const references = { support: 2 * pivot - h, pivot, resistance: 2 * pivot - l };
  for (const level of brief.levels) {
    const formula = level.kind === "support" ? "S1=2*PP-H" : level.kind === "pivot" ? "PP=(H+L+C)/3" : "R1=2*PP-L";
    if (level.formula_id !== `${brief.calculation_version}:classic:${formula}`
      || level.evidence_ids.join("|") !== "period-h|period-l|period-c") unsupported_ids.push(`level-${level.kind}`);
    else check(`level-${level.kind}`, level.value, references[level.kind]);
  }
  for (const e of brief.evidence) {
    if (!e.formula_id) continue;
    const prefix = `${brief.calculation_version}:`;
    if (!e.formula_id.startsWith(prefix)) { unsupported_ids.push(e.id); continue; }
    const f = e.formula_id.slice(prefix.length), ids = e.evidence_ids ?? [], x = ids.map(v);
    let expected: number | undefined;
    switch (f) {
      case "TR=max(H-L,abs(H-prevC),abs(L-prevC))":
        expected = x.length === 3 ? Math.max(x[0] - x[1], Math.abs(x[0] - x[2]), Math.abs(x[1] - x[2])) : NaN; break;
      case "ATR14_SMA=sum(TR_last14)/14": expected = x.length === 14 ? x.reduce((a, b) => a + b, 0) / 14 : NaN; break;
      case "100*ATR14/last": expected = x.length === 2 ? 100 * x[0] / x[1] : NaN; break;
      case "sum(prior20DailyVolume)/20": expected = x.length === 20 ? x.reduce((a, b) => a + b, 0) / 20 : NaN; break;
      case "currentCumulativeVolume/prior20DailyMean": expected = x.length === 2 ? x[0] / x[1] : NaN; break;
      case "DGS10-DGS2": expected = x.length === 2 ? x[0] - x[1] : NaN; break;
      case "last-reference":
      case "100*(last-reference)/last":
      case "(last-reference)/ATR14": {
        const kind = e.id.split("-").at(-1) as keyof typeof references;
        const expectedIds = f === "(last-reference)/ATR14"
          ? ["quote-last", "atr14", "period-h", "period-l", "period-c"]
          : ["quote-last", "period-h", "period-l", "period-c"];
        if (ids.join("|") !== expectedIds.join("|") || !brief.levels.some(l => l.kind === kind)) {
          expected = NaN; break;
        }
        const delta = v("quote-last") - references[kind];
        expected = f === "last-reference" ? delta : f.startsWith("100") ? 100 * delta / v("quote-last") : delta / v("atr14");
        break;
      }
    }
    if (expected === undefined) unsupported_ids.push(e.id);
    else check(e.id, e.value, expected);
  }
  return { status: mismatch_ids.length ? "mismatch" : unsupported_ids.length ? "unsupported" : checked_count ? "matched" : "no_calculations",
    checked_count, mismatch_ids, unsupported_ids,
    detail: "Checks stored pivots and supported derived numeric formulas only. Source truth, raw ingestion, prose, execution and historical availability are not verified.",
  };
}
