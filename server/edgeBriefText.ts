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
  // Round 4: order phrasings the R3 list missed ("Buy 0DTE calls above 5800",
  // "Sell the 5750 puts", "Take profits at 5820", "Use a stop at 5790").
  { kind: "order", re: /\b(buy|buying|sell|selling|shorting|go long|go short|load up|scale (in|out)|take (profits?|gains?|the trade)|stop[- ]?loss(es)?|stop(ped)? out|(use|set|place|move|trail) (a |the |your )?stops?|stops? (at|below|above|under|over|near)|price targets?|targets? (at|of|near|around|is|are)|take[- ]profit|(enter|entry|exit) (at|near|around|above|below|on)|add to (the |your |a )?(position|longs|shorts|winners|losers|trade)|average (down|up)|roll (the )?(calls?|puts?|position|up|down|out))\b/i },
  { kind: "size", re: /\brisk(ing)?\s+(\d|no more than|up to|half|a (small|fixed|set))|\b(of|your|the) account\b|\baccount (size|equity|balance|value)\b|\b\d+\s*(contracts?|lots?)\b/i },
  { kind: "probability", re: /\b(odds|chances?|likel(y|ihood)|probab\w*|favou?r(s|ed|ing)?|bet(s|ting)?)\b/i },
];

/**
 * First words that make a sentence an instruction to the reader (imperative
 * mood). "watch" is not here: "watch: X" is a monitoring note, and any order
 * inside it is still caught by BRIEF_BANNED.
 */
const IMPERATIVE_START = /^(?:[-*+>"'(\[]\s*)*(buy|sell|short|go|take|use|risk|consider|load|add|trim|cut|size|hedge|fade|enter|exit|stop|set|place|avoid|wait|play|grab|scale|close|open|roll|lean|target|bet|put|keep|stay|let'?s|try|aim|protect|lock|book|own|write|collect|harvest|get|stack|chase|cover|reduce|increase|double|halve|tighten|widen|hold|look to|you should|you could|you can|we would|i would|i'd|traders should)\b/i;

/**
 * Descriptive-verb allow-list for LLM text (strict mode). A sentence must
 * state what the data shows (a finite indicative verb from this list) or be
 * a short "label: value" note; imperatives ("Buy 0DTE calls above 5800")
 * contain none of these and are dropped whatever their wording. Same design
 * as cosmos.ts filterTradeInstructions: an allow-list does not need to
 * anticipate every paraphrase of an order, and dropping an innocent
 * sentence costs less than letting one order through.
 */
const DESCRIPTIVE_VERB = /\b(is|are|was|were|has|have|had|held|holds|sits|sat|remains|remained|stays|stayed|shows|showed|reads|lies|exceeds|exceeded|trails|trailed|lags|lagged|leads|rose|fell|dropped|climbed|declined|moved|closed|opened|printed|prints|measures|measured|implies|indicates|reflects|means|tends|stands|equals|ranges|spans|covers|includes|contains|came|comes|ended|ends|beat|beats|lost|loses|widened|narrowed|flattened|steepened|inverted|expanded|compressed|rises|falls|increased|decreased|changed|flipped|crossed|broke|touched|tested|rejected|bounced|sits|averages|averaged|peaked|bottomed|diverged|converged|tracks|tracked|matches|matched|differs|depends|carries|carried|prices|priced)\b/i;
const LABEL_NOTE = /^\s*[A-Za-z][\w /&().-]{0,30}:\s*\S/;

/** Strict (LLM) check: true when a sentence is allowed through. */
export function isDescriptiveSentence(sentence: string): boolean {
  const x = String(sentence ?? "").trim();
  if (!x) return false;
  if (bannedKinds(x).length > 0) return false;
  if (IMPERATIVE_START.test(x)) return false;
  return DESCRIPTIVE_VERB.test(x) || LABEL_NOTE.test(x);
}

/** A verdict (1-3 word label) passes only when it is not an order or odds call. */
export function scrubVerdict(v: string | null | undefined): string {
  const x = String(v ?? "").trim();
  if (!x) return "\u2014";
  if (bannedKinds(x).length > 0 || IMPERATIVE_START.test(x)) return VERDICT_REMOVED;
  return x;
}
export const VERDICT_REMOVED = "reading (label removed)";

export const REMOVED_NOTE = "(trade, sizing or probability language removed)";

/** Which banned kinds a text contains (empty when clean). */
export function bannedKinds(text: string): string[] {
  const out: string[] = [];
  for (const b of BRIEF_BANNED) if (b.re.test(text) && !out.includes(b.kind)) out.push(b.kind);
  return out;
}

/**
 * Drop every sentence that matches a banned pattern; REMOVED_NOTE when
 * nothing is left. strict (LLM output): a sentence must also pass the
 * descriptive allow-list (isDescriptiveSentence).
 */
export function scrubBriefText(text: string | null | undefined, opts: { strict?: boolean } = {}): string {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const sentences = t.split(/(?<=[.!?;])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const kept = sentences.filter((x) => opts.strict ? isDescriptiveSentence(x) : (bannedKinds(x).length === 0 && !IMPERATIVE_START.test(x)));
  if (kept.length === sentences.length) return t;
  return kept.length ? kept.join(" ") : REMOVED_NOTE;
}

export interface BriefCaseLike { thesis: string; prob: number | null }
export interface BriefLike {
  verdict?: string;
  verdictColor?: string;
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
export function scrubBrief<T extends BriefLike>(b: T, opts: { strict?: boolean } = {}): T & { removedSentences: number } {
  let removed = 0;
  const s = (x: string) => {
    const before = String(x ?? "").split(/(?<=[.!?;])\s+|\n+/).filter((y) => y.trim()).length;
    const out = scrubBriefText(x, opts);
    const after = out === REMOVED_NOTE ? 0 : out.split(/(?<=[.!?;])\s+|\n+/).filter((y) => y.trim()).length;
    removed += Math.max(0, before - after);
    return out;
  };
  const bullets = (b.bullets ?? []).filter((x) => {
    const bad = opts.strict ? !isDescriptiveSentence(String(x)) : (bannedKinds(String(x)).length > 0 || IMPERATIVE_START.test(String(x)));
    if (bad) removed++;
    return !bad;
  });
  // The verdict is shown as the headline chip: filtered like every other field.
  const verdictIn = b.verdict;
  const verdict = verdictIn === undefined ? undefined : scrubVerdict(verdictIn);
  if (verdict !== undefined && verdict !== String(verdictIn ?? "").trim() && verdict === VERDICT_REMOVED) removed++;
  return {
    ...b,
    ...(verdict !== undefined ? { verdict, ...(verdict === VERDICT_REMOVED ? { verdictColor: "neutral" } : {}) } : {}),
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
