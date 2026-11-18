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

import { CRYPTO_RULES } from "./cryptoRules";

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
    majors?: { asOf?: number; state: "ok" | "partial" | "unavailable"; rows: Array<{ asset: string; kraken: { state?: string; mid: number | null; vwap24h: number | null }; coinbase: { state?: string; mid: number | null }; cross?: { state: string; reference: number | null } }> } | null;
    derivs?: { state: "ok" | "partial" | "unavailable"; rows: Array<{ asset: string; venue: string; state: string; funding8hPct: number | null; oi1hChangePct: number | null; oiState: string }> } | null;
  } | null;
  health?: { engines: Array<{ name: string; status: string; lastError: string | null }> } | null;
  record?: {
    desk?: { state: "on" | "off" | "unknown"; reason: string } | null;
    coins?: { total: number; hit5m: number; doubled: number; rugged: number; dead: number; noData?: number; open: number; graded?: number } | null;
    /** Share of resolved coins that could not be priced (stats.noDataShare). */
    noDataShare?: number | null;
    enterCoins?: { total: number; graded: number } | null;
    ruggedRateObserved?: number | null;
    rulesVersion?: string | null;
  } | null;
  /** The feed request failed and the payloads are the last successful ones. */
  feedError?: boolean;
  /** Verdict-code meanings (shared/cryptoVerdict.ts VERDICT_CODE_TEXT), passed in by the caller. */
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
const listed = (c: BriefCoin) => c.verdict === "ENTER" || c.verdict === "WATCH";
/** Only listed coins have a card open to jump to (Pass rows sit in a collapsed, truncated section). */
const link = (c: BriefCoin) => (listed(c) ? { coin: ref(c) } : {});
const venueOk = (state?: string) => state == null || state === "ok";
const minutesAgo = (now: number | null | undefined, then: number | null | undefined): number | null => (fin(now) && fin(then) ? Math.max(0, Math.round((now - then) / 60_000)) : null);
/** Older than this against the feed's own time, a context read is labelled with its age. */
const CONTEXT_AGE_MIN = 10;
/** The lists below are capped so the brief stays a brief; the cap is stated when it bites. */
const LIST_CAP = 5;

function backdrop(i: BriefInputs): BriefLine[] {
  const out: BriefLine[] = [];
  const desk = i.record?.desk;
  if (!desk) out.push({ text: "Desk risk state: not read.", tone: "warn" });
  else out.push({
    text: desk.state === "on" ? `Desk risk is on: ${desk.reason}. An ENTER is possible when every other rule is met.`
      : desk.state === "off" ? `Desk risk is off: ${desk.reason}. No ENTER is issued while it is off.`
      : `Desk risk is unknown: ${desk.reason}. No ENTER is issued while it is unknown.`,
    tone: desk.state === "on" ? "good" : desk.state === "off" ? "bad" : "warn",
  });
  const majors = i.feed?.majors;
  if (!majors || majors.state === "unavailable") out.push({ text: "BTC, ETH and SOL prices: not read on this pass.", tone: "warn" });
  else {
    const parts: string[] = [];
    for (const r of majors.rows) {
      // A diverged pair has no reference on purpose: both prints are suspect and neither is shown as the price.
      if (r.cross?.state === "diverge") { out.push({ text: `${r.asset}: Coinbase and Kraken disagree; no reference price is shown.`, tone: "warn" }); continue; }
      const mid = fin(r.cross?.reference) ? r.cross!.reference!
        : r.cross ? null
        : venueOk(r.kraken.state) && fin(r.kraken.mid) ? r.kraken.mid
        : venueOk(r.coinbase.state) && fin(r.coinbase.mid) ? r.coinbase.mid : null;
      if (mid == null) { out.push({ text: `${r.asset} price: not read.`, tone: "warn" }); continue; }
      // Kraken's own mid against Kraken's own 24 h VWAP, and only from a current Kraken read (the desk-risk rule).
      const k = r.kraken;
      const vs = venueOk(k.state) && fin(k.mid) && fin(k.vwap24h) && k.vwap24h > 0 ? ` (Kraken ${sgn(((k.mid - k.vwap24h) / k.vwap24h) * 100, 2)} vs its 24 h VWAP)` : " (Kraken 24 h VWAP not read)";
      parts.push(`${r.asset} ${px(mid)}${vs}`);
    }
    const old = minutesAgo(i.feed?.asOf, majors.asOf);
    if (parts.length) out.push({ text: `${parts.join(" · ")}${old != null && old >= CONTEXT_AGE_MIN ? `. Majors last read ${old} min before this feed` : ""}.`, tone: old != null && old >= CONTEXT_AGE_MIN ? "warn" : null });
  }
  const derivs = i.feed?.derivs;
  if (!derivs || derivs.state === "unavailable") out.push({ text: "Perpetual funding and open interest: not read on this pass.", tone: "warn" });
  else {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    for (const asset of ["BTC", "ETH", "SOL"]) {
      const rows = derivs.rows.filter((r) => r.asset === asset && r.state === "ok");
      if (!rows.length) { out.push({ text: `${asset} perpetuals: no venue read.`, tone: "warn" }); continue; }
      const f = rows.map((r) => r.funding8hPct).filter(fin);
      const oi = rows.filter((r) => r.oiState === "ok").map((r) => r.oi1hChangePct).filter(fin);
      const fTxt = f.length ? `funding ${sgn(avg(f), 4)} per 8 h, average of ${plural(f.length, "venue")} (${avg(f) > 0 ? "longs pay shorts" : avg(f) < 0 ? "shorts pay longs" : "flat"})` : "no 8-hour funding figure (no venue states its interval)";
      const oTxt = oi.length ? `open interest ${sgn(avg(oi), 1)} over about an hour, average of ${plural(oi.length, "venue")}` : "open interest change not available yet";
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
  // "empty" is a source that answered with no headline in the window: read, not failed.
  const readN = srcs.filter((s) => s.state !== "failed").length;
  if (feed.narrativeUpdatedAt == null) return [{ text: "News narratives have not been read yet on this run.", tone: "warn" }];
  const old = minutesAgo(feed.asOf, feed.narrativeUpdatedAt);
  const stamp = old != null && old >= 30 ? ` as of the last read ${old} min before this feed` : "";
  const hot = feed.narrativeHeat.filter((n) => n.hits >= 2).slice(0, 6);
  if (hot.length === 0) out.push({ text: `No term appears in two or more headlines${stamp}${srcs.length ? ` (${readN} of ${srcs.length} news sources answered)` : ""}.`, tone: stamp ? "warn" : null });
  else out.push({ text: `Terms in the most headlines over 24 h${stamp}: ${hot.map((n) => `${n.term} (${plural(n.hits, "headline")}, ${plural(n.sources.length, "source")})`).join(", ")}.`, tone: stamp ? "warn" : null });
  let carried = 0;
  for (const n of hot) {
    const carriers = feed.candidates.filter((c) => c.narrativeHits.includes(n.term) && !c.hardKill).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 3);
    for (const c of carriers) { carried++; out.push({ text: `${c.symbol} carries "${n.term}": ${c.verdict ?? "no verdict"}, score ${c.score ?? "unread"}, cap ${usd(capOf(c))}, ${age(c.ageMinutes)}.`, tone: null, ...link(c) }); }
  }
  if (hot.length && carried === 0) out.push({ text: "No served coin without a hard kill matches a hot term.", tone: null });
  if (failed.length) out.push({ text: `News sources that failed on the last read: ${failed.join(", ")}. Their headlines are missing from the counts, not absent from the news.`, tone: "warn" });
  return out;
}

function desk(i: BriefInputs): BriefLine[] {
  const feed = i.feed;
  if (!feed) return [{ text: "Desk list: feed not read.", tone: "warn" }];
  const cs = feed.candidates;
  const n = (v: string) => cs.filter((c) => c.verdict === v).length;
  const out: BriefLine[] = [{ text: `${plural(feed.trackedCount, "pool")} tracked; among the ${cs.length} highest-ranked served here: ${n("ENTER")} Enter, ${n("WATCH")} Watch, ${n("PASS")} Pass.`, tone: null }];
  const line = (c: BriefCoin): BriefLine => ({
    text: `${c.symbol} · ${c.verdict} · score ${c.score ?? "unread"} · cap ${usd(capOf(c))}, liquidity ${usd(c.liquidityUsd)}, ${age(c.ageMinutes)} · volume pace ${fin(c.volAccel) ? `${c.volAccel.toFixed(1)}x the hour's` : "unread"}, buys ${fin(c.netBuyRatio5m) ? `${Math.round(c.netBuyRatio5m * 100)}% of 5-minute trades` : "unread"}${fin(c.chg1h) ? `, ${sgn(c.chg1h, 0)} in the hour` : ""}${c.verdict === "WATCH" && c.verdictCode ? ` · held by: ${i.codeText?.[c.verdictCode] ?? c.verdictCode}` : ""}.`,
    tone: c.verdict === "ENTER" ? "good" : null, coin: ref(c),
  });
  const top = (v: "ENTER" | "WATCH") => cs.filter((c) => c.verdict === v).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const e = top("ENTER"), w = top("WATCH");
  for (const c of e.slice(0, LIST_CAP)) out.push(line(c));
  if (e.length > LIST_CAP) out.push({ text: `${e.length - LIST_CAP} more on Enter, listed below.`, tone: null });
  for (const c of w.slice(0, LIST_CAP)) out.push(line(c));
  if (w.length > LIST_CAP) out.push({ text: `${w.length - LIST_CAP} more on Watch, listed below.`, tone: null });
  if (!e.length && !w.length) out.push({ text: "Nothing is on Enter or Watch right now.", tone: null });
  const rec = i.record?.enterCoins;
  if (rec) out.push({ text: rec.total === 0 ? "The desk has not issued an Enter on any coin in its record." : `Record: ${plural(rec.total, "coin")} with a first Enter, ${rec.graded} graded.`, tone: rec.total === 0 ? "warn" : null });
  return out;
}

/**
 * A social read the server still stands behind. Only "ok": the server expires an ok read to stale after 15
 * minutes, but a partial one is never aged, so its counts can be old and are treated as not current.
 */
const socialRead = (c: BriefCoin) => c.socialStatus === "ok" && fin(c.bskyMentions1h);

function attention(i: BriefInputs): BriefLine[] {
  const feed = i.feed;
  if (!feed) return [{ text: "Social attention: feed not read.", tone: "warn" }];
  const cs = feed.candidates.filter((c) => !c.hardKill);
  const out: BriefLine[] = [];
  const read = cs.filter(socialRead);
  const bsky = read.filter((c) => (c.bskyMentions1h ?? 0) >= 3).sort((a, b) => (b.bskyMentions1h ?? 0) - (a.bskyMentions1h ?? 0)).slice(0, 4);
  for (const c of bsky) out.push({ text: `${c.symbol}: ${c.bskyCapped ? "at least " : ""}${c.bskyMentions1h} Bluesky mentions in the hour${fin(c.pumpReplyPerHr) ? `, pump.fun replies ${c.pumpReplyPerHr >= 0 ? "+" : "−"}${Math.abs(c.pumpReplyPerHr)} per hour` : ""} (${c.verdict ?? "no verdict"}, cap ${usd(capOf(c))}).`, tone: null, ...link(c) });
  const pump = read.filter((c) => fin(c.pumpReplyPerHr) && c.pumpReplyPerHr >= 20 && !bsky.includes(c)).sort((a, b) => (b.pumpReplyPerHr ?? 0) - (a.pumpReplyPerHr ?? 0)).slice(0, 3);
  for (const c of pump) out.push({ text: `${c.symbol}: pump.fun replies +${c.pumpReplyPerHr} per hour (${c.verdict ?? "no verdict"}, cap ${usd(capOf(c))}).`, tone: null, ...link(c) });
  if (!bsky.length && !pump.length) out.push({ text: read.length ? `No served coin has 3 or more Bluesky mentions in the hour (${read.length} of ${cs.length} served coins without a hard kill have a current social read).` : "No served coin has a current social read.", tone: read.length ? null : "warn" });
  const unread = cs.filter((c) => listed(c) && !socialRead(c));
  if (unread.length) out.push({ text: `No current social read for ${plural(unread.length, "listed coin")} (${unread.slice(0, 4).map((c) => c.symbol).join(", ")}${unread.length > 4 ? ", ..." : ""}): unread or expired, not zero.`, tone: "warn" });
  const boosted = cs.filter((c) => c.boosted);
  if (boosted.length) out.push({ text: `${plural(boosted.length, "served coin")} with a paid DexScreener boost (${boosted.slice(0, 5).map((c) => c.symbol).join(", ")}${boosted.length > 5 ? ", ..." : ""}): bought attention.`, tone: "warn" });
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
    const authUnread = cs.filter((c) => c.securityCheckedAt == null).length;
    const unreadNote = authUnread ? ` Mint and freeze authority are unread on ${authUnread} of ${cs.length} served coins, so an authority kill cannot show on those yet.` : "";
    out.push({ text: (killed.length ? `${plural(killed.length, "served coin")} with a hard kill standing (liquidity missing or under the floor, a drained or collapsing pool, liquidity far out of line with the cap, active mint or freeze authority, honeypot pattern): ${killed.slice(0, 6).map((c) => c.symbol).join(", ")}${killed.length > 6 ? ", ..." : ""}.` : "No served coin has a hard kill standing.") + unreadNote, tone: killed.length ? "bad" : authUnread ? "warn" : null });
    const rows: BriefLine[] = [];
    for (const c of cs.filter(listed)) {
      const gaps: string[] = [];
      if (c.securityCheckedAt == null) gaps.push("mint and freeze authority unread");
      if (!fin(c.top10Pct)) gaps.push("top-10 holders unread");
      if (c.jupState == null || c.jupState === "unchecked" || c.jupState === "failed") gaps.push("Jupiter price check not done");
      // Flags already cover a read that came back bad (holder share over the limit, a diverging price ...): counted once, here.
      if (c.rugFlags.length) gaps.push(`${plural(c.rugFlags.length, "flag")} on its card`);
      if (gaps.length) rows.push({ text: `${c.symbol}: ${gaps.join("; ")}.`, tone: "warn", coin: ref(c) });
    }
    out.push(...rows.slice(0, LIST_CAP));
    if (rows.length > LIST_CAP) out.push({ text: `${rows.length - LIST_CAP} more listed coins have an unread check or a flag; see their cards.`, tone: "warn" });
    if (cs.some(listed) && rows.length === 0) out.push({ text: "Every listed coin has its authority, holder and price checks read, with no flag.", tone: "good" });
  }
  const r = i.record?.coins;
  if (r) {
    const target = usd(CRYPTO_RULES.universe.targetMcapUsd).replace(".00M", "M");
    out.push({ text: `Record over ${plural(r.total, "coin")}: ${r.hit5m} reached the ${target} cap, ${r.doubled} doubled, ${r.rugged} rugged, ${r.dead} died, ${r.noData == null ? "unpriced count not reported" : `${r.noData} could not be priced`}, ${r.open} still open.`, tone: null });
    const share = i.record?.noDataShare;
    const rate = i.record?.ruggedRateObserved;
    const limit = CRYPTO_RULES.grading.maxNoDataShare;
    if (fin(r.graded) && r.graded > 0 && fin(rate)) {
      const minN = CRYPTO_RULES.grading.minSample;
      out.push(r.graded < minN
        ? { text: `${r.rugged} of ${r.graded} graded coins rugged. No rate is quoted under ${minN} graded coins.`, tone: "warn" }
        : fin(share) && share <= limit
        ? { text: `${r.rugged} of ${r.graded} graded coins rugged (${Math.round(rate * 100)}%).`, tone: null }
        : { text: `${r.rugged} of ${r.graded} graded coins rugged. No rate is quoted: ${fin(share) ? `${Math.round(share * 100)}% of resolved coins could not be priced, over the ${Math.round(limit * 100)}% limit, and an unpriced coin is often a rug` : "the share of coins that could not be priced was not reported"}.`, tone: "warn" });
    }
  } else out.push({ text: "The graded record was not read.", tone: "warn" });
  return out;
}

function coverage(i: BriefInputs): BriefLine[] {
  const pre: BriefLine[] = i.feedError ? [{ text: "The last feed request failed: this brief is built from the last successful read, shown with its time above.", tone: "bad" }] : [];
  const h = i.health;
  if (!h) return [...pre, { text: "Collector health: not read.", tone: "warn" }];
  const engines = h.engines.filter((e) => e.name !== "watchdog");
  const bad = engines.filter((e) => e.status !== "ok");
  if (!engines.length) return [...pre, { text: "Collector health: no collector has reported yet.", tone: "warn" }];
  if (!bad.length) return [...pre, { text: `All ${plural(engines.length, "collector")} reporting on time.`, tone: "good" }];
  return [...pre, ...bad.map((e) => ({
    text: e.status === "starting" ? `${e.name}: has not completed its first run yet. Lines above that depend on it are not read, not empty.`
      : `${e.name}: ${e.status}${e.lastError ? ` (${e.lastError})` : ""}. Lines above that depend on it may be older or missing.`,
    tone: "warn" as const,
  }))];
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
