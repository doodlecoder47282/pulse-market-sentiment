// alphaEngine.ts
// Deterministic ALPHA brief — rules-based impact ranking from the news feed.
// ALWAYS returns a brief; no external API calls, no key requirements.
// LLM enhancers (Claude/GPT) are layered on separately when keys exist.

export interface AlphaNewsItem {
  title: string;
  source?: string;
  time?: string;
  summary?: string;
  url?: string;
}

type Category = "GEOPOLITICS" | "RATES/FED" | "CORPORATE" | "INSIDER" | "SENTIMENT" | "ENERGY" | "OTHER";
type Direction = "Bullish" | "Bearish" | "Two-sided" | "Mixed";
type Horizon = "Intraday" | "Days" | "Weeks" | "Structural";

interface ScoredItem {
  title: string;
  source: string;
  time: string;
  category: Category;
  impact: number; // 1-10
  direction: Direction;
  horizon: Horizon;
  tickers: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Lexical rules
// ──────────────────────────────────────────────────────────────────────────
// Each rule: regex → { category, baseImpact, direction?, horizon?, tickers? }
// Matches stack additively up to a cap. Direction resolved by dominant sign.
// ──────────────────────────────────────────────────────────────────────────

interface Rule {
  re: { test(text: string): boolean };
  category: Category;
  impact: number;
  direction?: Direction;
  horizon?: Horizon;
  tickers?: string[];
}

// ─── A move word next to a market ────────────────────────────────────────────────────────────────
// Words, not a regex over characters: a move word counts when a market word sits within MOVE_REACH words of
// it in the same clause. A clause ends at ; : , a sentence end, or a joining word (as, while, after, but,
// though, despite, amid), so "Stocks rally as dollar slides" is one up-move and no down-move. Linear in the
// length of the text. Yields, bonds and the dollar are not market words here: "yields jump" is not a bullish
// headline, and a direction tag on them would carry the wrong sign as often as the right one.
export const MOVE_REACH = 4;
const EQUITY = new Set(["stocks", "stock", "shares", "equities", "equity", "nasdaq", "dow", "s&p", "spx", "russell", "nikkei", "ftse", "stoxx", "kospi", "futures", "wallstreet", "chipmakers", "markets", "market", "index", "indexes", "indices"]);
const OTHER_MKT = new Set(["gold", "silver", "copper", "oil", "crude", "brent", "wti", "bitcoin", "ether", "ethereum", "crypto"]);
const JOINERS = new Set(["as", "while", "after", "but", "though", "despite", "amid"]);
const UP = new Set(["rally", "rallies", "rallied", "surge", "surges", "surged", "soar", "soars", "soared", "jump", "jumps", "jumped"]);
const DOWN = new Set(["correction", "plunge", "plunges", "plunged", "crash", "crashes", "crashed", "rout", "tumble", "tumbles", "tumbled", "slump", "slumps", "slumped", "slide", "slides", "slid"]);
/** Only shares and indexes "sink": next to oil or copper the word is a ship. */
const DOWN_EQUITY_ONLY = new Set(["sink", "sinks", "sank"]);
/** A crash beside one of these is not a price. */
const NOT_A_PRICE_CRASH = new Set(["site", "app", "website", "outage", "plane", "car", "tanker", "exchange", "train", "helicopter", "bus"]);
const NOT_THIS_MARKET: Record<string, { before?: string[]; after?: string[] }> = {
  market: { before: ["housing", "job", "jobs", "labor", "labour", "property", "rental"], after: ["share"] },
  markets: { before: ["housing", "job", "jobs", "labor", "labour", "property", "rental"] },
  index: { before: ["dollar", "price", "prices", "volatility", "confidence", "sentiment", "manufacturing", "services", "managers", "managers'"] },
  stock: { after: ["car"] },
  gold: { after: ["coast", "medal", "medals"] },
  silver: { after: ["alert", "medal", "medals"] },
  oil: { after: ["tanker", "spill"] },
  crude: { after: ["tanker"] },
};

function clauses(text: string): string[][] {
  const out: string[][] = [[]];
  const raw = text.toLowerCase().replace(/wall street/g, "wallstreet").split(/\s+/);
  for (const r of raw) {
    const ends = /[;:,!?]$/.test(r) || (/\.$/.test(r) && !/^([a-z]\.)+$/.test(r)); // "u.s." does not end a sentence
    const w = r.replace(/^[^a-z0-9&]+|[^a-z0-9&%']+$/g, "");
    if (JOINERS.has(w)) { out.push([]); continue; }
    if (w) out[out.length - 1].push(w);
    if (ends) out.push([]);
  }
  return out;
}

function moveNearMarket(text: string, moves: Set<string>, equityOnly: Set<string> | null): boolean {
  for (const c of clauses(text)) {
    const mk: Array<{ i: number; equity: boolean }> = [];
    c.forEach((w, i) => {
      const equity = EQUITY.has(w);
      if (!equity && !OTHER_MKT.has(w)) return;
      const not = NOT_THIS_MARKET[w];
      if (not?.before?.includes(c[i - 1] ?? "") || not?.after?.includes(c[i + 1] ?? "")) return;
      mk.push({ i, equity });
    });
    if (!mk.length) continue;
    for (let j = 0; j < c.length; j++) {
      const w = c[j];
      const any = moves.has(w), eq = equityOnly?.has(w) ?? false;
      if (!any && !eq) continue;
      if (w.startsWith("crash") && c.some((x) => NOT_A_PRICE_CRASH.has(x))) continue;
      if (mk.some((m) => Math.abs(m.i - j) <= MOVE_REACH && m.i !== j && (any || m.equity))) return true;
    }
  }
  return false;
}
export const MARKET_UP = { test: (text: string) => moveNearMarket(text, UP, null) };
export const MARKET_DOWN = { test: (text: string) => moveNearMarket(text, DOWN, DOWN_EQUITY_ONLY) };

const RULES: Rule[] = [
  // ---- RATES / FED (broad index impact) ----
  { re: /\b(fomc|fed( decision)?|rate (cut|hike|decision)|powell|fed chair)\b/i, category: "RATES/FED", impact: 9, horizon: "Days", tickers: ["SPY", "TLT", "DXY"] },
  { re: /\bsurprise (cut|hike)\b|\bunexpected (cut|hike)\b/i, category: "RATES/FED", impact: 10, horizon: "Intraday", direction: "Two-sided" },
  { re: /\b(cpi|core cpi|inflation report|pce|core pce)\b/i, category: "RATES/FED", impact: 8, horizon: "Days", tickers: ["SPY", "TLT"] },
  { re: /\b(nfp|non-?farm payrolls?|jobs report|unemployment rate)\b/i, category: "RATES/FED", impact: 8, horizon: "Days", tickers: ["SPY", "TLT"] },
  { re: /\b(ecb|boj|bank of japan|bank of england|pboc)\b/i, category: "RATES/FED", impact: 6, horizon: "Days" },
  { re: /\btreasury (auction|yield)s?\b|\b(10-?year|30-?year) yield\b/i, category: "RATES/FED", impact: 5, horizon: "Days", tickers: ["TLT"] },
  { re: /\b(williams|waller|bostic|brainard|daly|kashkari|mester|bullard) (speech|speaks|says)\b/i, category: "RATES/FED", impact: 5, horizon: "Intraday" },
  { re: /\bhawkish\b/i, category: "RATES/FED", impact: 4, direction: "Bearish", horizon: "Days" },
  { re: /\bdovish\b/i, category: "RATES/FED", impact: 4, direction: "Bullish", horizon: "Days" },

  // ---- GEOPOLITICS ----
  { re: /\b(war|invasion|invades|missile strike|attack on)\b/i, category: "GEOPOLITICS", impact: 9, direction: "Bearish", horizon: "Days", tickers: ["SPY", "CL=F", "GC=F"] },
  { re: /\bceasefire\b|\btruce\b|\bpeace (deal|agreement)\b/i, category: "GEOPOLITICS", impact: 7, direction: "Bullish", horizon: "Days" },
  { re: /\b(opec|opec\+)\b/i, category: "GEOPOLITICS", impact: 7, horizon: "Days", tickers: ["CL=F", "XLE", "USO"] },
  { re: /\b(russia|ukraine|israel|iran|gaza|hamas|hezbollah|houthi|red sea|taiwan|china (invasion|military)|north korea|nuclear)\b/i, category: "GEOPOLITICS", impact: 6, horizon: "Days" },
  { re: /\b(tariff|trade war|sanction|embargo)s?\b/i, category: "GEOPOLITICS", impact: 7, direction: "Two-sided", horizon: "Weeks" },
  { re: /\b(election|presidential race|candidate)\b/i, category: "GEOPOLITICS", impact: 5, horizon: "Weeks" },
  { re: /\b(shutdown|debt ceiling|government default)\b/i, category: "GEOPOLITICS", impact: 8, direction: "Bearish", horizon: "Days" },

  // ---- ENERGY ----
  { re: /\b(oil|crude|brent|wti) (price|rally|plunge|surge|crash)/i, category: "ENERGY", impact: 6, horizon: "Days", tickers: ["CL=F", "XLE"] },
  { re: /\bnat(ural)? gas\b/i, category: "ENERGY", impact: 4, horizon: "Days", tickers: ["NG=F", "UNG"] },
  { re: /\binventor(y|ies)\b.*\b(crude|oil|gas)\b/i, category: "ENERGY", impact: 5, horizon: "Intraday", tickers: ["CL=F"] },

  // ---- CORPORATE ----
  { re: /\b(apple|aapl)\b/i, category: "CORPORATE", impact: 7, tickers: ["AAPL", "QQQ"] },
  { re: /\b(microsoft|msft)\b/i, category: "CORPORATE", impact: 7, tickers: ["MSFT", "QQQ"] },
  { re: /\b(nvidia|nvda)\b/i, category: "CORPORATE", impact: 8, tickers: ["NVDA", "SOXX", "QQQ"] },
  { re: /\b(alphabet|google|googl|goog)\b/i, category: "CORPORATE", impact: 7, tickers: ["GOOGL", "QQQ"] },
  { re: /\b(meta|facebook)\b/i, category: "CORPORATE", impact: 7, tickers: ["META", "QQQ"] },
  { re: /\b(amazon|amzn)\b/i, category: "CORPORATE", impact: 7, tickers: ["AMZN", "QQQ", "XLY"] },
  { re: /\b(tesla|tsla)\b/i, category: "CORPORATE", impact: 7, tickers: ["TSLA", "XLY"] },
  { re: /\bearnings (beat|miss|report)|\b(beat|miss)(es|ed)?\b.*\bestimates?\b/i, category: "CORPORATE", impact: 5, horizon: "Days" },
  { re: /\b(guidance (cut|lowered)|cuts? guidance|slash(es|ed) (forecast|guidance)|profit warning)\b/i, category: "CORPORATE", impact: 7, direction: "Bearish", horizon: "Days" },
  { re: /\b(guidance (raise|raised|boosted)|raises? (guidance|outlook)|boost(s|ed) (guidance|outlook))\b/i, category: "CORPORATE", impact: 6, direction: "Bullish", horizon: "Days" },
  { re: /\b(m&a|merger|acquisition|acquires?)\b/i, category: "CORPORATE", impact: 6, horizon: "Days" },
  { re: /\b(layoffs?|job cuts|firing|workforce reduction)\b/i, category: "CORPORATE", impact: 4, direction: "Mixed", horizon: "Days" },
  { re: /\b(ipo|spin-?off|splits)\b/i, category: "CORPORATE", impact: 4, horizon: "Days" },

  // ---- INSIDER ----
  { re: /\binsider (buying|buy|purchase)\b|\bform 4\b.*\bbuy\b/i, category: "INSIDER", impact: 5, direction: "Bullish", horizon: "Weeks" },
  { re: /\binsider (selling|sell|sale)\b|\bform 4\b.*\bsell\b/i, category: "INSIDER", impact: 4, direction: "Bearish", horizon: "Weeks" },
  { re: /\b(ceo|cfo|cto) (departs?|resigns?|steps down|fired)\b/i, category: "INSIDER", impact: 6, direction: "Bearish", horizon: "Days" },

  // ---- SENTIMENT / POSITIONING ----
  { re: /\bvix (spike|surge|plunge|crash)\b|\bvolatility (spike|surge)\b/i, category: "SENTIMENT", impact: 6, horizon: "Intraday", tickers: ["VIX", "UVXY"] },
  { re: /\b(aaii|naaim|put-?call|gamma (squeeze|exposure)|dealer gamma)\b/i, category: "SENTIMENT", impact: 5, horizon: "Days" },
  { re: /\b(margin (debt|call)|deleveraging|liquidation)\b/i, category: "SENTIMENT", impact: 7, direction: "Bearish", horizon: "Intraday" },
  { re: /\b(record high|all-?time high|new high)s?\b/i, category: "SENTIMENT", impact: 3, direction: "Bullish" },
  { re: /\b(bear market|sell-?\s?offs?)\b/i, category: "SENTIMENT", impact: 6, direction: "Bearish", horizon: "Days" },
  // Move words count only next to a market (moveNearMarket above): "Croatians rally in Zagreb" is a protest,
  // "a correction" can be a newspaper's, and a "crash" can be a car's.
  { re: MARKET_DOWN, category: "SENTIMENT", impact: 6, direction: "Bearish", horizon: "Days" },
  { re: MARKET_UP, category: "SENTIMENT", impact: 3, direction: "Bullish" },
];

// Bias adverbs/qualifiers that bump impact up or down
const QUALIFIERS: { re: RegExp; delta: number; dir?: Direction }[] = [
  { re: /\b(breaking|just in|alert|urgent)\b/i, delta: 2 },
  { re: /\b(surprise|shock|stun)\w*/i, delta: 2 },
  { re: /\b(massive|historic|unprecedented|record)\b/i, delta: 1 },
  { re: /\b(plunge|crash|rout|collapse)\b/i, delta: 1, dir: "Bearish" },
  { re: /\b(soar|rocket|skyrocket)\b/i, delta: 1, dir: "Bullish" },
];

// Bonus: source authority (official prints/big wires land harder)
const SOURCE_AUTHORITY: { re: RegExp; delta: number }[] = [
  { re: /\b(reuters|bloomberg|wsj|ft|wall street journal|financial times|ap|associated press)\b/i, delta: 1 },
  { re: /\b(federal reserve|treasury|sec|bls|bea|eia)\b/i, delta: 2 },
];

// Ticker extractor: picks up $TICKER, (TICKER), or standalone caps 1-5 letters
const TICKER_RE = /\$([A-Z]{1,5})(?:\.[A-Z])?\b|\(([A-Z]{2,5})\)/g;

function extractTickers(s: string): string[] {
  const found = new Set<string>();
  let m;
  while ((m = TICKER_RE.exec(s)) !== null) {
    const t = (m[1] ?? m[2] ?? "").toUpperCase();
    if (t && t.length >= 1 && t.length <= 5) found.add(t);
  }
  return Array.from(found);
}

function scoreItem(item: AlphaNewsItem): ScoredItem | null {
  const text = `${item.title}${item.summary ? " " + item.summary : ""}`;
  let bestCategory: Category | null = null;
  let baseImpact = 0;
  let direction: Direction = "Two-sided";
  let horizon: Horizon = "Days";
  const tickerSet = new Set<string>();

  // Match all rules — take the HIGHEST impact as the primary category,
  // but every matched rule gets to contribute tickers and direction votes.
  const dirVotes: Record<Direction, number> = { Bullish: 0, Bearish: 0, "Two-sided": 0, Mixed: 0 };
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      if (rule.impact > baseImpact) {
        baseImpact = rule.impact;
        bestCategory = rule.category;
        if (rule.horizon) horizon = rule.horizon;
      }
      if (rule.direction) dirVotes[rule.direction] += rule.impact;
      for (const t of rule.tickers ?? []) tickerSet.add(t);
    }
  }
  if (bestCategory == null || baseImpact === 0) return null;

  // Qualifier adjustments
  let adjustedImpact = baseImpact;
  for (const q of QUALIFIERS) {
    if (q.re.test(text)) {
      adjustedImpact += q.delta;
      if (q.dir) dirVotes[q.dir] += 2;
    }
  }
  // Source authority
  for (const s of SOURCE_AUTHORITY) {
    if (s.re.test(item.source ?? "")) adjustedImpact += s.delta;
  }
  adjustedImpact = Math.max(1, Math.min(10, adjustedImpact));

  // Resolve direction
  const sortedDirs = (Object.entries(dirVotes) as [Direction, number][])
    .sort((a, b) => b[1] - a[1]);
  if (sortedDirs[0][1] > 0) direction = sortedDirs[0][0];
  else direction = "Two-sided";
  // If bullish and bearish are nearly tied, call it Mixed
  const bull = dirVotes.Bullish;
  const bear = dirVotes.Bearish;
  if (bull > 0 && bear > 0 && Math.abs(bull - bear) <= 2) direction = "Mixed";

  // Extract tickers from text itself
  for (const t of extractTickers(text)) tickerSet.add(t);

  return {
    title: item.title,
    source: item.source ?? "?",
    time: item.time ?? "?",
    category: bestCategory,
    impact: adjustedImpact,
    direction,
    horizon,
    tickers: Array.from(tickerSet).slice(0, 5),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Brief builder
// ──────────────────────────────────────────────────────────────────────────

function topTapeSummary(scored: ScoredItem[]): string {
  if (scored.length === 0) {
    return "No headline in the feed matched an impact rule.";
  }
  const top = scored[0];
  const catWord: Record<Category, string> = {
    GEOPOLITICS: "geopolitical",
    "RATES/FED": "rates/Fed",
    CORPORATE: "corporate",
    INSIDER: "insider",
    SENTIMENT: "sentiment/positioning",
    ENERGY: "energy",
    OTHER: "macro",
  };
  const dirWord =
    top.direction === "Bullish" ? "risk-on"
    : top.direction === "Bearish" ? "risk-off"
    : top.direction === "Mixed" ? "two-way"
    : "two-sided";
  const highImpact = scored.filter((s) => s.impact >= 8).length;
  const addendum = highImpact > 1
    ? ` ${highImpact} headlines scored 8 or higher.`
    : "";
  return `Highest-scored headline is ${catWord[top.category]} (${top.category}): "${top.title}". Rule score ${top.impact}/10, tagged ${dirWord}, ${top.horizon.toLowerCase()} horizon.${addendum}`;
}

/**
 * What the keyword rules counted in the feed. Counts only: this section used to be "TRADE IMPLICATIONS" and
 * told the reader to tighten stops, buy put spreads and keep size light, from nothing but keyword matches on
 * headlines. The desk does not give instructions; the counts are what the rules actually know.
 */
export function ruleCounts(scored: ReadonlyArray<{ impact: number; direction: string; category: string }>): string[] {
  const n = (f: (s: { impact: number; direction: string; category: string }) => boolean) => scored.filter(f).length;
  const out: string[] = [];
  const bull = n((s) => s.direction === "Bullish" && s.impact >= 6);
  const bear = n((s) => s.direction === "Bearish" && s.impact >= 6);
  const six = n((s) => s.impact >= 6);
  out.push(`${six} of ${scored.length} scored headlines are at 6 or higher: ${bull} tagged bullish, ${bear} tagged bearish, ${six - bull - bear} tagged two-sided or mixed.`);
  const high = n((s) => s.impact >= 7);
  if (high > 0) out.push(`${high} headline${high === 1 ? "" : "s"} scored 7 or higher.`);
  const cats: Array<[string, string, number]> = [
    ["RATES/FED", "rates or Fed", 6], ["GEOPOLITICS", "geopolitics", 6], ["ENERGY", "energy", 5], ["CORPORATE", "single-company", 7],
  ];
  for (const [cat, word, floor] of cats) {
    const c = n((s) => s.category === cat && s.impact >= floor);
    if (c > 0) out.push(`${c} ${word} headline${c === 1 ? "" : "s"} scored ${floor} or higher.`);
  }
  return out;
}

export function buildDeterministicAlphaBrief(items: AlphaNewsItem[]): string {
  const scored = items
    .map(scoreItem)
    .filter((x): x is ScoredItem => x !== null)
    .sort((a, b) => b.impact - a.impact);

  const ranked = scored.slice(0, 12);

  const nowEt = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const lines: string[] = [];
  lines.push(`## ALPHA BRIEF — ${nowEt} ET`);
  lines.push("");
  lines.push(topTapeSummary(scored));
  lines.push("");

  if (ranked.length > 0) {
    lines.push("## RANKED IMPACT");
    lines.push("");
    lines.push("| Rank | Headline | Category | Rule score | Direction tag | Horizon tag | Tickers |");
    lines.push("|------|-------|----------|--------|-----------|---------|---------|");
    ranked.forEach((s, i) => {
      const title = s.title.replace(/\|/g, "\\|").slice(0, 90);
      const tickers = s.tickers.length ? s.tickers.join(", ") : "—";
      lines.push(`| ${i + 1} | ${title} | ${s.category} | ${s.impact}/10 | ${s.direction} | ${s.horizon} | ${tickers} |`);
    });
    lines.push("");
  } else {
    lines.push("## RANKED IMPACT");
    lines.push("");
    lines.push("_No headline in the feed matched an impact rule._");
    lines.push("");
  }

  lines.push("## WHAT THE RULES COUNTED");
  lines.push("");
  for (const b of ruleCounts(scored)) {
    lines.push(`- ${b}`);
  }
  lines.push("");

  lines.push("## CAVEATS");
  lines.push("");
  lines.push("Rules-based summary, no model wrote it. Keyword rules on each headline assign the category, the score and the direction tag; the scores are hand-set and have not been graded against what the market did afterward. A tag is a keyword match, not a forecast; a headline that matches no direction keyword shows Two-sided and one that matches no horizon keyword shows Days.");

  return lines.join("\n");
}
