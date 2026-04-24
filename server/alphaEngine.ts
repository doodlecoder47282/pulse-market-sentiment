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
  re: RegExp;
  category: Category;
  impact: number;
  direction?: Direction;
  horizon?: Horizon;
  tickers?: string[];
}

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
  { re: /\b(bear market|correction|plunge|crash|selloff|rout)\b/i, category: "SENTIMENT", impact: 6, direction: "Bearish", horizon: "Days" },
  { re: /\b(rally|surge|soar|rip)\b/i, category: "SENTIMENT", impact: 3, direction: "Bullish" },
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
    return "News feed is thin. No primary catalysts ranking above noise. Trade the tape, respect levels, and wait for the next print.";
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
    ? ` ${highImpact} high-impact items stacking — expect follow-through.`
    : "";
  return `Dominant catalyst is ${catWord[top.category]} (${top.category}): "${top.title}" — impact ${top.impact}/10, ${dirWord} lean, ${top.horizon.toLowerCase()} horizon.${addendum}`;
}

function tradeImplications(scored: ScoredItem[]): string[] {
  const out: string[] = [];
  const topHigh = scored.filter((s) => s.impact >= 7);
  const bullHeavy = scored.filter((s) => s.direction === "Bullish" && s.impact >= 6).length;
  const bearHeavy = scored.filter((s) => s.direction === "Bearish" && s.impact >= 6).length;
  const hasFed = scored.some((s) => s.category === "RATES/FED" && s.impact >= 6);
  const hasGeo = scored.some((s) => s.category === "GEOPOLITICS" && s.impact >= 6);
  const hasEnergy = scored.some((s) => s.category === "ENERGY" && s.impact >= 5);
  const hasMag7 = scored.some((s) => s.category === "CORPORATE" && s.impact >= 7);

  if (bearHeavy > bullHeavy + 1) {
    out.push("Tape bias bearish. Tighten stops on longs; defensive rotation (XLP, XLU) viable. Consider SPY put spreads if IV hasn't already crushed.");
  } else if (bullHeavy > bearHeavy + 1) {
    out.push("Tape bias bullish. Cyclicals (XLF, XLI, XLY) set up well. Beware of melt-up IV crush — spreads over calls for expressing upside.");
  } else {
    out.push("Crosscurrents. Keep size light. Range-trade SPY between nearest dealer gamma pivots until a catalyst breaks tie.");
  }

  if (hasFed) {
    out.push("Rates/Fed catalyst in play. Watch 2Y yield direction first — that's the cleanest read. TLT moves confirm duration bid/offer.");
  }
  if (hasGeo) {
    out.push("Geopolitics live. Gold (GC=F) + DXY + crude (CL=F) should be on the screen. Risk-parity can get wrecked if all three move together.");
  }
  if (hasEnergy) {
    out.push("Energy catalyst. XLE leads the tape on oil moves; watch USO divergences for exhaustion signals.");
  }
  if (hasMag7) {
    out.push("Mega-cap catalyst. Index impact via QQQ. Pair trade: long/short the moving name vs. the sector ETF to hedge index beta.");
  }
  if (topHigh.length >= 3) {
    out.push("Multiple high-impact items — expect elevated realized vol. Favor defined-risk structures over naked directional exposure.");
  }
  return out.slice(0, 5);
}

function watchList(scored: ScoredItem[]): string[] {
  const out: string[] = [];
  const catalysts = scored
    .filter((s) => /fomc|cpi|nfp|earnings|opec|fed|treasury|auction/i.test(s.title))
    .slice(0, 3);
  for (const c of catalysts) {
    out.push(`${c.time === "?" ? "Upcoming" : c.time} — ${c.title} (${c.category})`);
  }
  if (out.length === 0) {
    out.push("No scheduled catalysts surfaced from feed. Monitor the economic calendar (News tab → Calendar) for next 48h.");
  }
  out.push("Key levels: nearest SPX dealer gamma pivot, 10Y yield 4.20/4.50 pivots, VIX 15/18/22 regime boundaries.");
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
    lines.push("| Rank | Event | Category | Impact | Direction | Horizon | Tickers |");
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
    lines.push("_No items in the feed matched ALPHA's impact rules. Either the feed is stale or nothing is moving the tape right now._");
    lines.push("");
  }

  lines.push("## TRADE IMPLICATIONS");
  lines.push("");
  for (const b of tradeImplications(scored)) {
    lines.push(`- ${b}`);
  }
  lines.push("");

  lines.push("## WATCH LIST");
  lines.push("");
  for (const w of watchList(scored)) {
    lines.push(`- ${w}`);
  }
  lines.push("");

  lines.push("## CAVEATS");
  lines.push("");
  lines.push("Deterministic rules-based brief — no LLM narrative attached. Impact scores are heuristic, not a trade signal. Confluence with price action + positioning required before sizing.");

  return lines.join("\n");
}
