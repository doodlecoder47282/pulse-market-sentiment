import type { TradeBrief, TradeBriefEvidence } from "./tradeBrief";

/** Presentation only. Never changes the underlying verdict, evidence or eligibility. */
export function summarizeTradeBrief(brief: TradeBrief, expired: boolean) {
  const observed = brief.evidence.find(e => e.id === "quote-last" && e.value > 0);
  const live = !expired && !!brief.quote;
  const phase = brief.session.schedule?.phase;
  const outsideCore = phase === "before_core" || phase === "after_core" || phase === "closed";
  const price = live ? brief.quote : observed ? {
    value: observed.value, source: observed.source, observed_at: observed.observed_at,
  } : null;
  const historical = (id: string): TradeBriefEvidence | undefined =>
    brief.evidence.find(e => e.id === id && Number.isFinite(e.value));
  const close = historical("history-session-close");
  const high = historical("history-session-high");
  const low = historical("history-session-low");
  const volume = historical("history-session-volume");
  const known = new Map([...brief.evidence, ...(brief.context_items ?? [])].map(e => [e.id, e]));
  const seen = new Set<string>();
  const findings = (brief.context_items ?? [])
    .filter(c => ["levels", "earnings", "news", "macro", "volume"].includes(c.category)
      && (c.status === "partial" || c.status === "available"))
    .sort((a, b) => ["levels", "earnings", "news", "macro", "volume"].indexOf(a.category)
      - ["levels", "earnings", "news", "macro", "volume"].indexOf(b.category))
    .filter(c => {
      const key = c.text.replace(/\s+/g, " ").trim();
      if (seen.has(key) || c.evidence_ids.some(id => !known.has(id))) return false;
      seen.add(key);
      return true;
    }).slice(0, 3);
  return {
    live, price, close, high, low, volume, findings, outsideCore,
    title: expired ? "Saved research · refresh current checks"
      : live ? "Research ready · trade not confirmed"
      : outsideCore ? "Outside core hours · preparation only" : "Live price not verified",
    takeaway: expired
      ? "This is a dated snapshot. Refresh before comparing current prices or acting."
      : live ? (brief.claims[0]?.text ?? "A timestamped price is available. Entry and risk conditions remain unverified.")
      : outsideCore
        ? "Use the dated observations below to prepare. A live entry cannot be assessed from an old price."
        : "The current-price check did not pass. Dated context can inform research, but not a live entry.",
    next: live
      ? "Confirm news, event timing and execution conditions before defining an entry."
      : "Refresh when a verified quote is available. Do not treat the last observation as an executable price.",
    usableCategories: brief.source_statuses.filter(s => s.contributed).length,
  };
}
