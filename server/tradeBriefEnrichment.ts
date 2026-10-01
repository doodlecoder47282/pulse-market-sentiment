import {
  TRADE_BRIEF_VERSION, type TradeBriefCategory, type TradeBriefContextItem,
  type TradeBriefEvidence, type TradeBriefInstrument, type TradeBriefLevel,
  type TradeBriefSourceStatus,
} from "../shared/tradeBrief";

export type BriefBar = {
  datetime: number; date: string; open: number; high: number; low: number; close: number;
  volume: number | null;
};
type Row = Record<string, unknown>;
const row = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const time = (v: unknown, now: number): v is number => finite(v) && v > 946684800000 && v <= now;
const DAY = 86_400_000;
const SCHWAB_URL = "https://developer.schwab.com/products/trader-api--individual";
const iso = (v: number) => new Date(v).toISOString();
const safeUrl = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface EnrichmentInput {
  instrument: TradeBriefInstrument; now: number; today: string; quoteAge: number;
  usableQuote: boolean; price: number | null; priceTime: number | null; quoteTime: number | null; volume: number | null;
  bars: BriefBar[]; requiredPriorDate: string;
  news?: unknown; earnings?: unknown; options?: unknown;
  optionsState?: "ok" | "unavailable" | "timeout" | "busy";
  statuses: Record<TradeBriefCategory, TradeBriefSourceStatus>;
  observations: TradeBriefEvidence[]; levels: TradeBriefLevel[];
}

/** Pure deterministic enrichment: no transports, caches, models, training or jobs. */
export function enrichStockBrief(input: EnrichmentInput) {
  const { now, today, instrument, statuses, observations, levels } = input;
  const contexts: TradeBriefContextItem[] = [];
  const claims: { text: string; evidence_ids: string[] }[] = [];
  const deadlines: number[] = [];
  const methodology: string[] = [];
  function numeric(id: string, category: TradeBriefCategory, label: string, value: number,
    unit: string, observed: string, formula?: string, evidence_ids?: string[]) {
    if (!finite(value)) return;
    observations.push({ id, category, label, value, unit, observed_at: observed,
      time_precision: /^\d{4}-\d{2}-\d{2}$/.test(observed) ? "period" : "instant",
      status: "partial", source: category === "macro" ? "FRED derived observation" : "Schwab",
      url: category === "macro" ? "https://fred.stlouisfed.org/series/DGS10" : SCHWAB_URL,
      ...(formula ? { formula_id: `${TRADE_BRIEF_VERSION}:${formula}` } : {}),
      ...(evidence_ids ? { evidence_ids } : {}) });
    statuses[category].evidence_ids.push(id);
  }
  function context(id: string, category: TradeBriefCategory, text: string, source: string,
    url: string, observed_at: string, precision: TradeBriefContextItem["time_precision"], evidence_ids: string[] = []) {
    contexts.push({ id, category, text: text.slice(0, 1600), source, url, observed_at,
      time_precision: precision, status: "partial", evidence_ids });
    statuses[category].evidence_ids.push(id);
  }

  // Daily observations strictly before today; never consume today's partial bar.
  const completed = input.bars.filter(b => b.date < today);
  const latest = completed.at(-1);
  const compatible = latest?.date === input.requiredPriorDate && input.usableQuote;
  function contiguousWeekdays(sample: BriefBar[]) {
    if (!sample.length) return false;
    const dates = new Set(sample.map(b => b.date));
    const end = Date.parse(`${sample.at(-1)!.date}T12:00:00Z`);
    let start = Date.parse(`${sample[0].date}T12:00:00Z`);
    if (end - start > 100 * DAY) return false;
    for (; start <= end; start += DAY) {
      const d = new Date(start);
      if (![0, 6].includes(d.getUTCDay()) && !dates.has(iso(start).slice(0, 10))) return false;
    }
    return true;
  }
  if (compatible && completed.length >= 15 && contiguousWeekdays(completed.slice(-15))) {
    const sample = completed.slice(-15);
    const splitLike = sample.slice(1).some((b, i) => Math.abs(b.close / sample[i].close - 1) > 0.5);
    if (!splitLike) {
      const trIds: string[] = [];
      let sum = 0;
      for (let i = 1; i < sample.length; i++) {
        const b = sample[i], prev = sample[i - 1];
        const tr = Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
        const prefix = `atr-${b.date}`;
        numeric(`${prefix}-h`, "levels", "ATR input: daily high", b.high, "USD/share", b.date);
        numeric(`${prefix}-l`, "levels", "ATR input: daily low", b.low, "USD/share", b.date);
        numeric(`${prefix}-pc`, "levels", "ATR input: previous completed close", prev.close, "USD/share", prev.date);
        numeric(prefix, "levels", "Daily true range", tr, "USD/share", b.date,
          "TR=max(H-L,abs(H-prevC),abs(L-prevC))", [`${prefix}-h`, `${prefix}-l`, `${prefix}-pc`]);
        trIds.push(prefix); sum += tr;
      }
      const atr = sum / 14;
      if (atr > 0) {
        numeric("atr14", "levels", "ATR14 · simple mean of 14 completed true ranges (not Wilder)", atr,
          "USD/share", latest.date, "ATR14_SMA=sum(TR_last14)/14", trIds);
        numeric("price-atr-percent", "levels", "ATR14 as percent of verified last trade", 100 * atr / input.price!,
          "percent", iso(input.priceTime!), "100*ATR14/last", ["atr14", "quote-last"]);
        for (const level of levels) {
          numeric(`distance-${level.kind}`, "levels", `Last trade minus ${level.label}`, input.price! - level.value,
            "USD/share", iso(input.priceTime!), "last-reference", ["quote-last", ...level.evidence_ids]);
          numeric(`distance-percent-${level.kind}`, "levels", `Signed distance to ${level.label} / last trade`,
            100 * (input.price! - level.value) / input.price!, "percent", iso(input.priceTime!),
            "100*(last-reference)/last", ["quote-last", ...level.evidence_ids]);
          numeric(`distance-atr-${level.kind}`, "levels", `Distance to ${level.label} / ATR14`,
            (input.price! - level.value) / atr, "ATR14 units", iso(input.priceTime!),
            "(last-reference)/ATR14", ["quote-last", "atr14", ...level.evidence_ids]);
        }
        statuses.levels.status = "partial"; statuses.levels.contributed = true;
        statuses.levels.observed_at ??= latest.date;
        statuses.levels.reason += " ATR14 independently has 15 validated observed daily bars and uses a simple mean of 14 completed true ranges, not Wilder smoothing; price distances are descriptive, not entries or probabilities.";
        context("factor-atr", "levels", `Completed-session ATR14 is ${atr.toFixed(2)} USD/share (${(100 * atr / input.price!).toFixed(2)}% of last trade). Adjustment provenance and exchange-session completeness remain unverified.`,
          "Schwab deterministic calculation", SCHWAB_URL, latest.date, "period", ["atr14", "price-atr-percent"]);
        claims.push({ text: contexts.at(-1)!.text, evidence_ids: ["factor-atr"] });
      }
    } else {
      statuses.levels.reason += " ATR14 withheld: split-like close discontinuity requires corporate-action review.";
    }
    methodology.push("ATR14 is the arithmetic mean of max(H-L, |H-previous completed close|, |L-previous completed close|) for 14 observed completed daily bars, seeded by a 15th close. Not Wilder ATR or adjusted total-return history; split-like jumps suppress ATR.");
  }
  const volumeSample = completed.slice(-20);
  if (compatible && volumeSample.length === 20 && contiguousWeekdays(volumeSample) && volumeSample.every(b => b.volume !== null)
    && input.volume !== null && input.quoteTime !== null
    && input.quoteTime >= Date.parse(`${today}T00:00:00Z`)
    && now - input.quoteTime < input.quoteAge * 1000) {
    const mean = volumeSample.reduce((s, b) => s + b.volume!, 0) / 20;
    if (mean > 0 && statuses.volume.contributed) {
      const ids: string[] = [];
      for (const b of volumeSample) {
        const id = `daily-volume-${b.date}`; ids.push(id);
        numeric(id, "volume", "Completed daily reported volume", b.volume!, "shares", b.date);
      }
      numeric("volume-prior20-mean", "volume", "Mean volume · prior 20 observed completed daily sessions",
        mean, "shares/session", latest!.date, "sum(prior20DailyVolume)/20", ids);
      numeric("volume-session-vs-prior20", "volume", "Cumulative provider volume / prior20 full-day mean · NOT RVOL",
        input.volume / mean, "ratio (not time-of-day normalized)", iso(input.quoteTime),
        "currentCumulativeVolume/prior20DailyMean", ["quote-volume", "volume-prior20-mean"]);
      statuses.volume.reason += " Full-day comparison only, NOT time-of-day RVOL; regular/extended/auction scope may differ, so no unusual-activity or directional inference.";
      context("factor-volume", "volume", `Cumulative reported volume is ${(input.volume / mean).toFixed(2)}× the prior20 full-day mean. This is NOT time-of-day RVOL or evidence of buying/selling pressure.`,
        "Schwab deterministic calculation", SCHWAB_URL, iso(input.quoteTime), "instant",
        ["volume-session-vs-prior20"]);
      claims.push({ text: contexts.at(-1)!.text, evidence_ids: ["factor-volume"] });
    }
  }
  const two = observations.find(e => e.id === "macro-DGS2" && e.status === "partial");
  const ten = observations.find(e => e.id === "macro-DGS10" && e.status === "partial");
  if (two && ten && two.observed_at === ten.observed_at) {
    numeric("macro-10y-2y", "macro", "10y minus 2y Treasury yield · matched observation date",
      ten.value - two.value, "percentage points", ten.observed_at, "DGS10-DGS2", [ten.id, two.id]);
    context("factor-yield-curve", "macro", `The matched-date 10y−2y Treasury spread is ${(ten.value - two.value).toFixed(2)} percentage points. This is dated macro context, not a ticker-direction signal.`,
      "FRED deterministic calculation", "https://fred.stlouisfed.org/series/DGS10",
      ten.observed_at, "date", ["macro-10y-2y"]);
    claims.push({ text: contexts.at(-1)!.text, evidence_ids: ["factor-yield-curve"] });
  }

  const news = row(input.news);
  const cacheTime = finite(news.asOf) ? news.asOf * 1000 : null;
  statuses.news.source = "Existing cached RSS headlines · explicit attribution only";
  statuses.news.max_age_seconds = 86400;
  statuses.news.dependencies = ["recent local snapshot", "healthy per-feed check", "verified publication time", "explicit title cashtag/full issuer-name attribution"];
  if (!time(cacheTime, now) || now - cacheTime > 15 * 60_000) {
    statuses.news.status = input.news == null ? "unavailable" : "stale";
    statuses.news.reason = "No recent cached news snapshot; no per-brief RSS/calendar fetch. No coverage is not no catalysts.";
  } else {
    const feeds = Array.isArray(news.feeds) ? news.feeds.map(row) : [];
    const headlines = Array.isArray(news.headlines) ? news.headlines.slice(0, 80).map(row) : [];
    // Cashtags are explicit. Full issuer names use reviewed aliases; ambiguous brand-only
    // names such as Apple, Ford, Meta and Strategy are NOT accepted by themselves.
    const names: Record<string, string[]> = {
      AAPL: ["Apple Inc"], MSFT: ["Microsoft Corporation"], NVDA: ["NVIDIA Corporation"],
      AMZN: ["Amazon.com Inc"], GOOGL: ["Alphabet Inc"], GOOG: ["Alphabet Inc"],
      META: ["Meta Platforms"], TSLA: ["Tesla Inc"], AMD: ["Advanced Micro Devices"],
      AVGO: ["Broadcom Inc"], INTC: ["Intel Corporation"], PLTR: ["Palantir Technologies"],
      COIN: ["Coinbase Global"], MSTR: ["Strategy Inc", "MicroStrategy Incorporated"],
      NFLX: ["Netflix Inc"], JPM: ["JPMorgan Chase"], BAC: ["Bank of America"],
      F: ["Ford Motor"], XOM: ["Exxon Mobil", "ExxonMobil Corporation"],
    };
    const patterns = [new RegExp(`\\$${escape(instrument.symbol)}(?![A-Za-z0-9])`, "i"),
      ...(names[instrument.symbol] ?? []).map(n => new RegExp(`\\b${escape(n)}\\b`, "i"))];
    let accepted = 0;
    for (const h of headlines) {
      if (accepted >= 5) break;
      const published = finite(h.published) ? h.published * 1000 : null;
      const text = typeof h.title === "string" ? h.title : "";
      const feed = feeds.find(f => f.source === h.source && f.status === "ok");
      const checked = feed && typeof feed.checked_at === "string" ? Date.parse(feed.checked_at) : NaN;
      if (!feed || !time(checked, now) || now - checked > 15 * 60_000
        || h.publication_verified !== true || !time(published, now) || now - published >= DAY
        || !safeUrl(h.url) || typeof h.source !== "string"
        || !patterns.some(p => p.test(text))) continue;
      const id = `news-explicit-${accepted++}`;
      context(id, "news", `${text.slice(0, 900)} · Explicit text attribution only; not confirmation of materiality or exhaustive news coverage.`,
        h.source, h.url, iso(published), "instant");
      deadlines.push(published + DAY, checked + 15 * 60_000);
    }
    statuses.news.status = accepted ? "partial" : "missing";
    statuses.news.contributed = accepted > 0;
    statuses.news.observed_at = contexts.find(c => c.category === "news")?.observed_at ?? null;
    statuses.news.reason = accepted
      ? "Recent cached headlines with healthy source and explicit cashtag/full-issuer text; inferred ticker tags ignored. Coverage remains non-exhaustive; share-class mentions do not establish class-specific impact."
      : "No qualifying explicit issuer/cashtag headline in the bounded recent cache; inferred tags ignored. This does not assert no catalysts.";
    if (accepted) deadlines.push(cacheTime + 15 * 60_000);
    if (accepted) claims.push({
      text: `${accepted} recent explicitly attributed collected headline${accepted === 1 ? "" : "s"} are available; attribution is not confirmation of materiality or complete news coverage.`,
      evidence_ids: contexts.filter(c => c.category === "news").map(c => c.id),
    });
  }

  if (instrument.asset_class === "STOCK") {
    statuses.earnings.source = "Existing cached Nasdaq real rows only";
    statuses.earnings.max_age_seconds = 1800;
    statuses.earnings.dependencies = ["exact ticker", "real-row provenance and calendar URL", "fresh row checked_at", "calendar-reported date; timing may remain unknown"];
    const earnings = row(input.earnings), candidates: Row[] = [];
    const weeks = Array.isArray(earnings.weeks) ? earnings.weeks.slice(0, 6) : [];
    for (const w of weeks) for (const d of (Array.isArray(row(w).days) ? row(w).days as unknown[] : []).slice(0, 31)) {
      const rows = row(d).rows;
      if (Array.isArray(rows)) candidates.push(...rows.slice(0, 1000).map(row));
    }
    const candidate = candidates.filter(r => {
      const p = row(r.provenance), checked = typeof p.checked_at === "string" ? Date.parse(p.checked_at) : NaN;
      const date = typeof r.date === "string" ? r.date : "";
      const stamp = Date.parse(`${date}T00:00:00Z`);
      const expectedUrl = `https://api.nasdaq.com/api/calendar/earnings?date=${date}`;
      return r.ticker === instrument.symbol && r.synthetic !== true && p.synthetic === false
        && p.source === "Nasdaq" && p.url === expectedUrl
        && time(checked, now) && now - checked < 1800_000
        && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(stamp)
        && iso(stamp).slice(0, 10) === date && date >= today
        && stamp <= now + 31 * DAY
        && ["BMO", "AMC", "DMH", "UNK"].includes(String(r.timing));
    }).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    if (candidate) {
      const p = row(candidate.provenance);
      context("earnings-next-collected", "earnings",
        `Nasdaq calendar lists ${instrument.symbol} on ${candidate.date}; timing ${candidate.timing === "UNK" ? "unknown" : candidate.timing}. Calendar-reported, not issuer-confirmed; revisions and dates outside the cache remain unknown.`,
        "Nasdaq calendar", String(p.url), String(p.checked_at), "instant");
      statuses.earnings.status = "partial"; statuses.earnings.contributed = true;
      statuses.earnings.observed_at = String(p.checked_at);
      statuses.earnings.reason = "Real-only, row-provenanced cached event. Timing/date are calendar-reported, not issuer-confirmed; no fetch or synthetic baseline used.";
      claims.push({ text: contexts.at(-1)!.text, evidence_ids: ["earnings-next-collected"] });
      deadlines.push(Date.parse(String(p.checked_at)) + 1800_000);
    } else {
      statuses.earnings.status = "unavailable";
      statuses.earnings.reason = "No fresh exact-ticker, row-provenanced real earnings event in existing cache. Synthetic and unmarked rows rejected; no 7/30-date fetch, and no no-earnings assertion.";
    }
  }

  statuses.options.source = "Raw Schwab sampled chain · descriptive only";
  const optionsAge = Math.min(60, input.quoteAge);
  statuses.options.max_age_seconds = optionsAge;
  statuses.options.dependencies = ["exact chain/underlying/contract identity", "explicit non-delayed chain",
    "usable real-time equity quote", "fresh underlying and contract times", "standard multiplier and uncrossed bid/ask"];
  const chain = row(input.options), underlying = row(chain.underlying);
  const chainTime = underlying.quoteTime;
  const chainFresh = time(chainTime, now) && now - chainTime < optionsAge * 1000;
  if (input.optionsState && input.optionsState !== "ok") {
    statuses.options.status = "unavailable";
    statuses.options.reason = "Bounded raw Schwab chain source unavailable, timed out or busy; no fallback.";
  } else if (input.options == null) {
    statuses.options.status = "unavailable"; statuses.options.reason = "No raw Schwab chain observation; no delayed fallback.";
  } else if (chain.symbol !== instrument.symbol || underlying.symbol !== instrument.symbol
    || chain.synthetic === true || underlying.synthetic === true || chain.status !== "SUCCESS") {
    statuses.options.status = "missing"; statuses.options.reason = "Raw chain fails exact underlying identity or provider success validation.";
  } else if (chain.isDelayed !== false || !input.usableQuote) {
    statuses.options.status = "delayed"; statuses.options.reason = "Explicit non-delayed chain and usable real-time equity quote are mandatory; delayed/unknown entitlement never contributes.";
  } else if (!chainFresh) {
    statuses.options.status = "stale"; statuses.options.reason = "Underlying quote time missing, future or outside horizon freshness limit; fetch time is not observation time.";
  } else {
    const contracts: { contract: Row; side: string; expiry: string; strike: number; timestamp: number }[] = [];
    let rawCount = 0, overflow = false;
    const seenContracts = new Set<string>();
    for (const [map, side] of [[chain.callExpDateMap, "call"], [chain.putExpDateMap, "put"]] as const) {
      const expiryEntries = Object.entries(row(map));
      if (expiryEntries.length > 100) { overflow = true; break; }
      for (const [expiryKey, strikes] of expiryEntries) {
        const expiry = expiryKey.split(":")[0], expiration = Date.parse(`${expiry}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !Number.isFinite(expiration)
          || iso(expiration).slice(0, 10) !== expiry || expiry < today || expiration > now + 45 * DAY) continue;
        const strikeRows = Object.values(row(strikes));
        if (strikeRows.length > 1000) { overflow = true; break; }
        for (const values of strikeRows) {
          if (!Array.isArray(values)) continue;
          rawCount += values.length;
          if (rawCount > 1000) { overflow = true; break; }
          for (const v of values) {
            const c = row(v), timestamp = c.quoteTimeInLong;
            if (c.synthetic === true || c.putCall !== side.toUpperCase()
              || typeof c.symbol !== "string" || !c.symbol.trim().startsWith(`${instrument.symbol} `)
              || !finite(c.strikePrice) || c.strikePrice <= 0
              || !time(timestamp, now) || now - timestamp >= optionsAge * 1000
              || !finite(c.bid) || !finite(c.ask) || c.bid < 0 || c.ask <= 0 || c.ask < c.bid
              || c.nonStandard === true || c.isIndexOption === true
              || c.multiplier !== 100) continue;
            const symbolMatch = new RegExp(`^${escape(instrument.symbol)}\\s+(\\d{6})([CP])(\\d{8})$`).exec(c.symbol.trim());
            if (!symbolMatch || symbolMatch[1] !== expiry.replace(/-/g, "").slice(2)
              || symbolMatch[2] !== (side === "call" ? "C" : "P")
              || Number(symbolMatch[3]) / 1000 !== c.strikePrice) continue;
            if (seenContracts.has(c.symbol)) { overflow = true; break; }
            seenContracts.add(c.symbol);
            contracts.push({ contract: c, side, expiry, strike: c.strikePrice, timestamp });
          }
        }
        if (overflow) break;
      }
      if (overflow) break;
    }
    if (overflow || !contracts.length) {
      statuses.options.status = "missing";
      statuses.options.reason = overflow ? "Chain exceeds the bounded 1000-contract validation budget; no partial scan is presented."
        : "No timestamped standard contracts with valid bid/ask in the bounded raw chain sample.";
    } else {
      const observed = iso(Math.min(chainTime as number, ...contracts.map(c => c.timestamp)));
      numeric("options-sampled-count", "options", "Validated sampled contracts · not whole-market count", contracts.length,
        "contracts", observed);
      const volumeRows = contracts.filter(c => finite(c.contract.totalVolume) && c.contract.totalVolume >= 0);
      numeric("options-volume-observed-count", "options", "Sampled contracts reporting actual volume",
        volumeRows.length, "contracts", observed);
      if (volumeRows.length) numeric("options-sampled-volume", "options",
        "Aggregate actual reported volume · eligible bounded sample, individual contract coverage disclosed by count",
        volumeRows.reduce((s, c) => s + (c.contract.totalVolume as number), 0), "contracts traded", observed);
      const earliestExpiry = contracts.map(c => c.expiry).sort()[0];
      for (const side of ["call", "put"]) {
        const atm = contracts.filter(c => c.side === side && c.expiry === earliestExpiry)
          .sort((a, b) => Math.abs(a.strike - input.price!) - Math.abs(b.strike - input.price!) || a.strike - b.strike)[0];
        if (!atm) continue;
        const prefix = `options-atm-${side}`;
        numeric(`${prefix}-strike`, "options", `Nearest sampled ${side} strike · ${atm.expiry}`, atm.strike,
          "USD/share underlying", iso(atm.timestamp));
        numeric(`${prefix}-bid`, "options", `Sampled ${side} bid · ${atm.expiry}`, atm.contract.bid as number,
          "USD/share premium", iso(atm.timestamp));
        numeric(`${prefix}-ask`, "options", `Sampled ${side} ask · ${atm.expiry}`, atm.contract.ask as number,
          "USD/share premium", iso(atm.timestamp));
        context(prefix, "options", `${atm.contract.symbol}: nearest sampled ${side} to verified equity price, expiry ${atm.expiry}. Bid/ask are observations, not fill guarantees.`,
          "Schwab raw chain", SCHWAB_URL, iso(atm.timestamp), "instant", [`${prefix}-strike`, `${prefix}-bid`, `${prefix}-ask`, "quote-last"]);
      }
      statuses.options.status = "partial"; statuses.options.contributed = true;
      statuses.options.observed_at = observed;
      statuses.options.reason = "Only bounded sampled standard contracts with fresh actual timestamps/bid/ask. No OI age, dealer positioning, GEX walls, directional intent, strategy recommendation or probabilities.";
      claims.push({
        text: `${contracts.length} fresh standard option contracts passed the bounded sample gates; quotes and reported volume are descriptive, not directional intent or dealer positioning.`,
        evidence_ids: ["options-sampled-count", ...contexts.filter(c => c.category === "options").map(c => c.id)],
      });
      deadlines.push((chainTime as number) + optionsAge * 1000,
        ...contracts.map(c => c.timestamp + optionsAge * 1000));
    }
  }
  return { contexts, claims, deadlines, methodology };
}
