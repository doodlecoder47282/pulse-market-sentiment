// server/edgeBriefText.ts
// Pure guards for the Edge Lab brief (edgeLabBrief.ts), deterministic and LLM
// paths alike (R3-2 item 7). No network or DB imports.
//
// The brief describes what a panel's data shows. It does not:
//   - give hand-set probabilities or a "confidence" number. The old brief
//     printed base/bull/bear weights of 55/25/20 or 60/25/15 and confidence
//     70 / 65 / 60 that nothing estimated; they read like calibrated odds.
//     Those fields are now null on every path (the client shows no number).
//   - recommend trades, option structures or position sizes ("sell premium
//     structures (iron condors, credit spreads) sized small", "cut size 50%",
//     "size up directional longs"). A score is a heuristic, not an edge
//     (AGENTS.md); sizing belongs to the risk budget, not to a text brief.
//   - claim an edge exists ("real edge", "premium sellers have edge here").
//
// The LLM is told all of this in its prompt; scrubBriefText is the output
// filter that enforces it on whatever comes back: every sentence that
// matches a trade/size/probability/edge-claim pattern is dropped.

/** Patterns that mark a sentence as trade, structure, sizing, probability or edge-claim language. */
export const BRIEF_BANNED: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "structure", re: /\b(iron condors?|credit spreads?|debit spreads?|put spreads?|call spreads?|straddles?|strangles?|calendars?|butterfl(y|ies)|ratio spreads?|put ratio|collars?)\b/i },
  { kind: "trade", re: /\b(sell|buy|short|long|write|own)\s+(the\s+)?(premium|vol|volatility|puts?|calls?|options|downside|upside|the (dip|rip|break|breakout)|wall touches)\b/i },
  { kind: "trade", re: /\b(go|lean|get)\s+(long|short)\b|\blean into (longs|shorts)\b|\bfade (the |wall |extremes|touches)|\bpaper[- ]trade\b|\bdeploy\b|\b(enter|exit) (a |the )?(trade|position)/i },
  { kind: "trade", re: /\b(trade with the trend|trade your (normal )?book|no trade\b|take (small )?(defined-risk )?plays?|protect longs|hedge (your |the )?(longs|book))\b/i },
  { kind: "size", re: /\b(size (up|down|half|small)|sized? small|cut size|reduce (size|equity beta|position|exposure|risk)|trim risk|oversiz\w*|position siz\w*|\d+\s*(-\s*\d+\s*)?% (of )?(normal )?size|kelly|add only|smaller size|full size|half[- ]size|double size)\b|(?<!sample )\bsize\s*[:=]/i },
  { kind: "probability", re: /\b\d{1,3}(\.\d+)?\s?%\s*(chance|probability|odds|likely|likelihood)\b|\bprob(ability|abilities)?\s*(of|=|:|is|at)?\s*\d|\b\d{1,3}\s?%\s*(base|bull|bear) case\b|\bconfidence\s*(of|=|:|is|at)?\s*\d/i },
  { kind: "edge-claim", re: /\b(real|clear|clean|have|has|is an?|with) edge\b|\bedge (here|exists|is real)\b|\bskill signal\b/i },
];

export const REMOVED_NOTE = "(trade, sizing or probability language removed)";

/** Which banned kinds a text contains (empty when clean). */
export function bannedKinds(text: string): string[] {
  const out: string[] = [];
  for (const b of BRIEF_BANNED) if (b.re.test(text) && !out.includes(b.kind)) out.push(b.kind);
  return out;
}

/** Drop every sentence that matches a banned pattern; REMOVED_NOTE when nothing is left. */
export function scrubBriefText(text: string | null | undefined): string {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const sentences = t.split(/(?<=[.!?;])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const kept = sentences.filter((x) => bannedKinds(x).length === 0);
  if (kept.length === sentences.length) return t;
  return kept.length ? kept.join(" ") : REMOVED_NOTE;
}

export interface BriefCaseLike { thesis: string; prob: number | null }
export interface BriefLike {
  confidence: number | null;
  summary: string;
  baseCase: BriefCaseLike;
  bullCase: BriefCaseLike;
  bearCase: BriefCaseLike;
  actionable: string;
  invalidation: string;
  counterargument: string;
  bullets: string[];
}

/**
 * Final guard on any brief: no hand-set numbers (confidence and case
 * weights become null) and every text field scrubbed. Returns the number of
 * sentences/bullets removed so the source can be labelled.
 */
export function scrubBrief<T extends BriefLike>(b: T): T & { removedSentences: number } {
  let removed = 0;
  const s = (x: string) => {
    const before = String(x ?? "").split(/(?<=[.!?;])\s+|\n+/).filter((y) => y.trim()).length;
    const out = scrubBriefText(x);
    const after = out === REMOVED_NOTE ? 0 : out.split(/(?<=[.!?;])\s+|\n+/).filter((y) => y.trim()).length;
    removed += Math.max(0, before - after);
    return out;
  };
  const bullets = (b.bullets ?? []).filter((x) => {
    const bad = bannedKinds(String(x)).length > 0;
    if (bad) removed++;
    return !bad;
  });
  return {
    ...b,
    confidence: null,
    summary: s(b.summary),
    baseCase: { thesis: s(b.baseCase?.thesis ?? ""), prob: null },
    bullCase: { thesis: s(b.bullCase?.thesis ?? ""), prob: null },
    bearCase: { thesis: s(b.bearCase?.thesis ?? ""), prob: null },
    actionable: s(b.actionable),
    invalidation: s(b.invalidation),
    counterargument: s(b.counterargument),
    bullets,
    removedSentences: removed,
  };
}
