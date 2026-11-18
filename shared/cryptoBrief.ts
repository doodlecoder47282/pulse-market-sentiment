// shared/cryptoBrief.ts
//
// The crypto alpha brief: one read of everything the desk already collects, in plain sentences. Pure.
//
// No model writes this and nothing is fetched for it: every line is built from the same feed, health and
// record payloads the tab already shows, so a line can be traced to its number. The brief describes; it
// does not advise. A source that was not read gets a line saying so (missing is never shown as zero or as
// quiet), and a section with nothing to report says that too.
//
// Sections, in reading order:
//   backdrop   desk risk state, BTC / ETH / SOL, perpetual funding and open interest
//   narrative  which news terms are hot and which tracked coins carry them
//   desk       what the desk has listed now and what each Watch is waiting on
//   attention  social attention and paid boosts on tracked coins (low-grade proxies, never in the verdict)
//   risk       hard kills and flags across the tracked list; the record's rug rate
//   coverage   which collectors are late or failing, so the gaps in the lines above are visible

export type BriefTone = "good" | "warn" | "bad" | null;
export interface BriefLine {
  text: string;
  tone: BriefTone;
  /** A tracked coin the line is about, so the UI can jump to its card. */
  coin?: { chain: string; pairAddress: string; symbol: string };
}
export interface BriefSection {
  id: "backdrop" | "narrative" | "desk" | "attention" | "risk" | "coverage";
  title: string;
  lines: BriefLine[];
}
export interface CryptoBrief {
  asOf: number | null;
  /** One sentence for the top of the card. */
  headline: string;
  sections: BriefSection[];
  /** What the brief is and is not, shown under it. */
  basis: string;
}

export interface BriefCoin {
  chain: string; pairAddress: string; symbol: string;
  verdict: "ENTER" | "WATCH" | "PASS" | null;
  verdictCode?: string | null;
  score: number | null;
  marketCap: number | null; fdv?: number | null; liquidityUsd: number | null;
  ageMinutes: number | null;
  volAccel: number | null; netBuyRatio5m: number | null; chg1h: number | null;
  boosted: boolean; hardKill: boolean; rugFlags: string[];
  narrativeHits: string[];
  bskyMentions1h: number | null; bskyCapped?: boolean;
  pumpReplyPerHr: number | null;
  socialStatus?: string | null;
  top10Pct: number | null; securityCheckedAt: number | null;
  jupState?: string | null;
}

export interface BriefInputs {
  feed?: {
    asOf: number; trackedCount: number; candidates: BriefCoin[];
    narrativeHeat: Array<{ term: string; hits: number; sources: string[] }>;
    narrativeUpdatedAt: number | null;
    narrativeSources?: Array<{ name: string; state: "ok" | "empty" | "failed"; titles: number }>;
    majors?: { state: "ok" | "partial" | "unavailable"; rows: Array<{ asset: string; kraken: { state?: string; mid: number | null; vwap24h: number | null }; coinbase: { state?: string; mid: number | null }; cross?: { state: string; reference: number | null } }> } | null;
    derivs?: { state: "ok" | "partial" | "unavailable"; rows: Array<{ asset: string; venue: string; state: string; funding8hPct: number | null; oi1hChangePct: number | null; oiState: string }> } | null;
  } | null;
  health?: { engines: Array<{ name: string; status: string; lastError: string | null }> } | null;
  record?: {
    desk?: { state: "on" | "off" | "unknown"; reason: string } | null;
    coins?: { total: number; hit5m: number; doubled: number; rugged: number; dead: number; noData?: number; open: number } | null;
    enterCoins?: { total: number; graded: number } | null;
    ruggedRateObserved?: number | null;
    rulesVersion?: string | null;
  } | null;
  /** Verdict-code meanings (shared/cryptoVerdict.ts VERDICT_CODE_TEXT), passed in so this module stays dependency-free. */
  codeText?: Record<string, string>;
}

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const usd = (n: number | null | undefined): string => {
  if (!fin(n)) return "unread";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
};
const px = (n: number): string => (n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const sgn = (n: number, d = 1): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}%`;
const age = (m: number | null): string => (!fin(m) ? "age unread" : m < 60 ? `${Math.round(m)} min old` : m < 2880 ? `${(m / 60).toFixed(1)} h old` : `${(m / 1440).toFixed(1)} d old`);
const capOf = (c: BriefCoin): number | null => (fin(c.marketCap) && c.marketCap > 0 ? c.marketCap : fin(c.fdv) && c.fdv > 0 ? c.fdv : null);
const ref = (c: BriefCoin) => ({ chain: c.chain, pairAddress: c.pairAddress, symbol: c.symbol });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function backdrop(i: BriefInputs): BriefLine[] {
  const out: BriefLine[] = [];
  const desk = i.record?.desk;
  if (!desk) out.push({ text: "Desk risk state: not read.", tone: "warn" });
  else out.push({
    text: desk.state === "on" ? `Desk risk is on: ${desk.reason}. An ENTER is possible when every other rule is met.`
      : desk.state === "off" ? `Desk risk is off: ${desk.reason}. Every candidate is held at Watch until it turns on.`
      : `Desk risk is unknown: ${desk.reason}. Every candidate is held at Watch until the majors are readable.`,
    tone: desk.state === "on" ? "good" : desk.state === "off" ? "bad" : "warn",
  });
  const majors = i.feed?.majors;
  if (!majors || majors.state === "unavailable") out.push({ text: "BTC, ETH and SOL prices: not read on this pass.", tone: "warn" });
  else {
    const parts: string[] = [];
    const missing: string[] = [];
    for (const r of majors.rows) {
      const mid = fin(r.cross?.reference) ? r.cross!.reference! : r.kraken.state !== "stale" && r.kraken.state !== "failed" && fin(r.kraken.mid) ? r.kraken.mid : r.coinbase.state !== "stale" && r.coinbase.state !== "failed" && fin(r.coinbase.mid) ? r.coinbase.mid : null;
      if (mid == null) { missing.push(r.asset); continue; }
      const v = r.kraken.vwap24h;
      parts.push(`${r.asset} ${px(mid)}${fin(v) && v > 0 ? ` (${sgn(((mid - v) / v) * 100, 2)} vs its 24 h average price)` : ""}`);
    }
    if (parts.length) out.push({ text: `${parts.join(" · ")}.`, tone: null });
    if (missing.length) out.push({ text: `Not read: ${missing.join(", ")} price.`, tone: "warn" });
  }
  const derivs = i.feed?.derivs;
  if (!derivs || derivs.state === "unavailable") out.push({ text: "Perpetual funding and open interest: not read on this pass.", tone: "warn" });
  else {
    for (const asset of ["BTC", "ETH", "SOL"]) {
      const rows = derivs.rows.filter((r) => r.asset === asset && r.state === "ok");
      const f = rows.map((r) => r.funding8hPct).filter(fin);
      const oi = rows.filter((r) => r.oiState === "ok").map((r) => r.oi1hChangePct).filter(fin);
      if (!f.length && !oi.length) continue;
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const fTxt = f.length ? `funding ${sgn(avg(f), 4)} per 8 h across ${plural(f.length, "venue")} (${avg(f) > 0 ? "longs pay shorts" : avg(f) < 0 ? "shorts pay longs" : "flat"})` : "funding not read";
      const oTxt = oi.length ? `open interest ${sgn(avg(oi), 1)} over the last hour` : "open interest change still building";
      out.push({ text: `${asset} perpetuals: ${fTxt}; ${oTxt}.`, tone: null });
    }
    if (derivs.state === "partial") out.push({ text: "Some perpetual venues were not read; the averages above cover only the ones that were.", tone: "warn" });
  }
  return out;
}

function narrative(i: BriefInputs): BriefLine[] {
  const feed = i.feed;
  if (!feed) return [{ text: "Narrative heat: feed not read.", tone: "warn" }];
  const out: BriefLine[] = [];
  const srcs = feed.narrativeSources ?? [];
  const failed = srcs.filter((s) => s.state === "failed").map((s) => s.name);
  if (feed.narrativeUpdatedAt == null) out.push({ text: "News narratives have not been read yet on this run.", tone: "warn" });
  const hot = feed.narrativeHeat.filter((n) => n.hits >= 2).slice(0, 6);
  if (feed.narrativeUpdatedAt != null && hot.length === 0) out.push({ text: `No term appears in two or more headlines right now${srcs.length ? ` (${srcs.filter((s) => s.state === "ok").length} of ${srcs.length} news sources read)` : ""}.`, tone: null });
  if (hot.length) out.push({ text: `Terms in the most headlines: ${hot.map((n) => `${n.term} (${n.hits}, ${plural(n.sources.length, "source")})`).join(", ")}.`, tone: null });
  for (const n of hot) {
    const carriers = feed.candidates.filter((c) => c.narrativeHits.includes(n.term) && !c.hardKill).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 3);
    for (const c of carriers) out.push({ text: `${c.symbol} carries "${n.term}": ${c.verdict ?? "no verdict"}, score ${c.score ?? "unread"}, cap ${usd(capOf(c))}, ${age(c.ageMinutes)}.`, tone: null, coin: ref(c) });
  }
  if (hot.length && !out.some((l) => l.coin)) out.push({ text: "No tracked coin's name or symbol matches a hot term.", tone: null });
  if (failed.length) out.push({ text: `News sources that failed on the last read: ${failed.join(", ")}. Their headlines are missing from the counts, not absent from the news.`, tone: "warn" });
  return out;
}

function desk(i: BriefInputs): BriefLine[] {
  const feed = i.feed;
  if (!feed) return [{ text: "Desk list: feed not read.", tone: "warn" }];
  const cs = feed.candidates;
  const n = (v: string) => cs.filter((c) => c.verdict === v).length;
  const out: BriefLine[] = [{ text: `${plural(feed.trackedCount, "pool")} tracked: ${n("ENTER")} Enter, ${n("WATCH")} Watch, ${n("PASS")} Pass shown.`, tone: null }];
  const line = (c: BriefCoin): BriefLine => ({
    text: `${c.symbol} · ${c.verdict} · score ${c.score ?? "unread"} · cap ${usd(capOf(c))}, liquidity ${usd(c.liquidityUsd)}, ${age(c.ageMinutes)} · volume pace ${fin(c.volAccel) ? `${c.volAccel.toFixed(1)}x the hour's` : "unread"}, buys ${fin(c.netBuyRatio5m) ? `${Math.round(c.netBuyRatio5m * 100)}% of 5-minute trades` : "unread"}${fin(c.chg1h) ? `, ${sgn(c.chg1h, 0)} in the hour` : ""}${c.verdict === "WATCH" && c.verdictCode ? ` · waiting on: ${i.codeText?.[c.verdictCode] ?? c.verdictCode}` : ""}.`,
    tone: c.verdict === "ENTER" ? "good" : null, coin: ref(c),
  });
  const top = (v: "ENTER" | "WATCH") => cs.filter((c) => c.verdict === v).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const c of top("ENTER").slice(0, 5)) out.push(line(c));
  const w = top("WATCH");
  for (const c of w.slice(0, 5)) out.push(line(c));
  if (w.length > 5) out.push({ text: `${w.length - 5} more on Watch, listed below.`, tone: null });
  if (n("ENTER") === 0 && n("WATCH") === 0) out.push({ text: "Nothing is on Enter or Watch right now.", tone: null });
  const e = i.record?.enterCoins;
  if (e) out.push({ text: e.total === 0 ? "The desk has not issued an Enter on any coin in its record." : `Record: ${plural(e.total, "coin")} with a first Enter, ${e.graded} graded.`, tone: e.total === 0 ? "warn" : null });
  return out;
}

function attention(i: BriefInputs): BriefLine[] {
  const feed = i.feed;
  if (!feed) return [{ text: "Social attention: feed not read.", tone: "warn" }];
  const cs = feed.candidates.filter((c) => !c.hardKill);
  const out: BriefLine[] = [];
  const read = cs.filter((c) => fin(c.bskyMentions1h));
  const bsky = read.filter((c) => (c.bskyMentions1h ?? 0) >= 3).sort((a, b) => (b.bskyMentions1h ?? 0) - (a.bskyMentions1h ?? 0)).slice(0, 4);
  for (const c of bsky) out.push({ text: `${c.symbol}: ${c.bskyCapped ? "at least " : ""}${c.bskyMentions1h} Bluesky mentions in the hour${fin(c.pumpReplyPerHr) ? `, pump.fun replies ${c.pumpReplyPerHr >= 0 ? "+" : "−"}${Math.abs(c.pumpReplyPerHr)}/h` : ""} (${c.verdict ?? "no verdict"}, cap ${usd(capOf(c))}).`, tone: null, coin: ref(c) });
  const pump = cs.filter((c) => fin(c.pumpReplyPerHr) && c.pumpReplyPerHr >= 20 && !bsky.includes(c)).sort((a, b) => (b.pumpReplyPerHr ?? 0) - (a.pumpReplyPerHr ?? 0)).slice(0, 3);
  for (const c of pump) out.push({ text: `${c.symbol}: pump.fun replies +${c.pumpReplyPerHr}/h (${c.verdict ?? "no verdict"}, cap ${usd(capOf(c))}).`, tone: null, coin: ref(c) });
  if (!bsky.length && !pump.length) out.push({ text: read.length ? `No tracked coin has 3 or more Bluesky mentions in the hour (${read.length} of ${cs.length} shown coins were searched).` : "Social attention has not been read for any shown coin yet.", tone: read.length ? null : "warn" });
  const unread = cs.filter((c) => !fin(c.bskyMentions1h) && (c.verdict === "ENTER" || c.verdict === "WATCH"));
  if (unread.length) out.push({ text: `Social not read for ${plural(unread.length, "listed coin")} (${unread.slice(0, 4).map((c) => c.symbol).join(", ")}${unread.length > 4 ? ", ..." : ""}): unread, not zero.`, tone: "warn" });
  const boosted = cs.filter((c) => c.boosted);
  if (boosted.length) out.push({ text: `${plural(boosted.length, "shown coin")} with a paid DexScreener boost (${boosted.slice(0, 5).map((c) => c.symbol).join(", ")}${boosted.length > 5 ? ", ..." : ""}): bought attention.`, tone: "warn" });
  out.push({ text: "Bluesky and pump.fun are low-grade attention proxies; they are shown, never scored.", tone: null });
  return out;
}

function risk(i: BriefInputs): BriefLine[] {
  const feed = i.feed;
  const out: BriefLine[] = [];
  if (!feed) out.push({ text: "Risk across the list: feed not read.", tone: "warn" });
  else {
    const cs = feed.candidates;
    const killed = cs.filter((c) => c.hardKill);
    out.push({ text: killed.length ? `${plural(killed.length, "shown coin")} with a hard kill standing (drained pool, active mint or freeze authority, honeypot pattern or exit door): ${killed.slice(0, 6).map((c) => c.symbol).join(", ")}${killed.length > 6 ? ", ..." : ""}.` : "No shown coin has a hard kill standing.", tone: killed.length ? "bad" : null });
    const listed = cs.filter((c) => c.verdict === "ENTER" || c.verdict === "WATCH");
    for (const c of listed) {
      const gaps: string[] = [];
      if (c.securityCheckedAt == null) gaps.push("mint and freeze authority unread");
      if (!fin(c.top10Pct)) gaps.push("top-10 holders unread");
      else if (c.top10Pct > 45) gaps.push(`top-10 holders ${c.top10Pct}%`);
      if (c.jupState === "diverge" || c.jupState === "no-reliable-price") gaps.push(`Jupiter price check ${c.jupState}`);
      else if (c.jupState == null || c.jupState === "unchecked" || c.jupState === "failed") gaps.push("Jupiter price check not done");
      if (c.rugFlags.length) gaps.push(plural(c.rugFlags.length, "flag"));
      if (gaps.length) out.push({ text: `${c.symbol}: ${gaps.join("; ")}.`, tone: "warn", coin: ref(c) });
    }
    if (listed.length && !out.some((l) => l.coin)) out.push({ text: "Every listed coin has its authority, holder and price checks read, with no flag.", tone: "good" });
  }
  const r = i.record?.coins;
  if (r) {
    const rate = i.record?.ruggedRateObserved;
    out.push({ text: `Record over ${plural(r.total, "coin")}: ${r.hit5m} reached the $5M cap, ${r.doubled} doubled, ${r.rugged} rugged, ${r.dead} died, ${r.noData ?? 0} could not be priced, ${r.open} still open${fin(rate) ? `. Observed rug rate ${Math.round(rate * 100)}% of graded coins` : ""}.`, tone: null });
  } else out.push({ text: "The graded record was not read.", tone: "warn" });
  return out;
}

function coverage(i: BriefInputs): BriefLine[] {
  const h = i.health;
  if (!h) return [{ text: "Collector health: not read.", tone: "warn" }];
  const engines = h.engines.filter((e) => e.name !== "watchdog");
  const bad = engines.filter((e) => e.status !== "ok");
  if (!engines.length) return [{ text: "Collector health: no collector has reported yet.", tone: "warn" }];
  if (!bad.length) return [{ text: `All ${plural(engines.length, "collector")} reporting on time.`, tone: "good" }];
  return bad.map((e) => ({
    text: e.status === "starting" ? `${e.name}: has not completed its first run yet. Lines above that depend on it are not read, not empty.`
      : `${e.name}: ${e.status}${e.lastError ? ` (${e.lastError})` : ""}. Lines above that depend on it may be older or missing.`,
    tone: "warn" as const,
  }));
}

export const CRYPTO_BRIEF_BASIS =
  "Built from the desk's own reads (prices from Coinbase and Kraken, perpetual funding and open interest, news headlines, DexScreener pools, Solana RPC and rugcheck, Jupiter, Bluesky and pump.fun) and its graded record. No model writes it and it places no orders. It describes what was read and says what was not; it is not advice and not a forecast.";

export function buildCryptoBrief(i: BriefInputs): CryptoBrief {
  const cs = i.feed?.candidates ?? [];
  const enters = cs.filter((c) => c.verdict === "ENTER").length;
  const watches = cs.filter((c) => c.verdict === "WATCH").length;
  const desk$ = i.record?.desk?.state;
  const headline = !i.feed ? "The feed has not been read yet."
    : `${enters ? `${plural(enters, "coin")} on Enter` : "Nothing on Enter"}, ${watches} on Watch; desk risk ${desk$ ?? "not read"}${i.feed.narrativeHeat.filter((n) => n.hits >= 2).length ? `; hottest term "${i.feed.narrativeHeat.filter((n) => n.hits >= 2)[0].term}"` : ""}.`;
  return {
    asOf: i.feed?.asOf ?? null,
    headline,
    sections: [
      { id: "backdrop", title: "Market backdrop", lines: backdrop(i) },
      { id: "narrative", title: "What the news is talking about", lines: narrative(i) },
      { id: "desk", title: "On the desk now", lines: desk(i) },
      { id: "attention", title: "Attention", lines: attention(i) },
      { id: "risk", title: "Risk", lines: risk(i) },
      { id: "coverage", title: "What was not read", lines: coverage(i) },
    ],
    basis: CRYPTO_BRIEF_BASIS,
  };
}
