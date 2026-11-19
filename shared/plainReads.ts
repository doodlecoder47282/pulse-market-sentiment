// shared/plainReads.ts
//
// "In plain words": one or two short sentences per panel, so a reader gets the answer without the vocabulary.
// Pure functions over numbers the panel already shows. Each sentence says what the number means, never what
// to do about it, and a reading that is missing says so instead of reading as zero or as calm.
//
// These sit above the detailed tables; the tables stay for anyone who wants the figures.

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const strike = (n: number) => Math.round(n).toLocaleString("en-US");
const pts = (n: number) => `${Math.abs(n) >= 10 ? Math.round(Math.abs(n)) : Math.abs(n).toFixed(1)} point${Math.abs(n) === 1 ? "" : "s"}`;
const volPts = (dec: number) => `${Math.abs(dec * 100).toFixed(1)} volatility points`;
const minus = (n: number, d = 0) => { const r = Number(n.toFixed(d)); return `${r < 0 ? "−" : ""}${Math.abs(r).toFixed(d)}`; };
const daysOut = (dte: number) => (dte <= 0 ? "expiring today" : `${dte} day${dte === 1 ? "" : "s"} out`);
/** Open-interest state of the read: "live", "held" (carried from an earlier session) or "none" (not available). */
export interface PlainOi { source?: string; sessionDate?: string | null }
const noOi = (oi?: PlainOi | null) => oi?.source === "none";
const held = (oi?: PlainOi | null) => (oi?.source === "held" ? ` Open interest is held from ${oi.sessionDate ?? "an earlier session"}.` : "");
const money = (n: number) => {
  const a = Math.abs(n);
  return `${n < 0 ? "−" : ""}$${a >= 1e12 ? `${(a / 1e12).toFixed(2)} trillion` : a >= 1e9 ? `${(a / 1e9).toFixed(1)} billion` : a >= 1e6 ? `${(a / 1e6).toFixed(1)} million` : Math.round(a).toLocaleString("en-US")}`;
};

/** Term structure: the nearest expiry against the farthest one read. `steepness` = back minus front, as a decimal. */
export function plainTermStructure(t: { contango: boolean | null; steepness: number | null } | null | undefined): string {
  if (!t || t.contango == null) return "Not enough expiries were read to compare near-dated options with later ones.";
  if (fin(t.steepness) && Math.abs(t.steepness) < 0.0005) return "The nearest expiry and the farthest one read are priced for about the same movement.";
  const by = fin(t.steepness) ? `, by ${volPts(t.steepness)}` : "";
  return t.contango
    ? `The nearest expiry is priced for less movement than the farthest one read${by}. That is the usual shape.`
    : `The nearest expiry is priced for more movement than the farthest one read${by}. Near-term movement is being priced above later movement.`;
}

/** Skew: how much more downside protection costs than upside. `skew` = 25-delta put IV minus call IV, decimal. */
export function plainSkew(rows: Array<{ dte: number; skew: number | null; elevatedFear: boolean }> | null | undefined): string {
  const read = (rows ?? []).filter((r) => fin(r.skew));
  if (!read.length) return "The price of downside protection against upside was not read on any expiry.";
  const near = read[0];
  const k = near.skew as number;
  const flagged = read.filter((r) => r.elevatedFear).length;
  const lead = k > 0 ? `Downside protection costs more than upside: on the nearest expiry read (${daysOut(near.dte)}), puts are ${volPts(k)} dearer than calls comparably far from the price.`
    : k < 0 ? `Upside costs more than downside protection on the nearest expiry read (${daysOut(near.dte)}), by ${volPts(k)}. That is unusual for an index.`
    : `Puts and calls comparably far from the price cost the same on the nearest expiry read (${daysOut(near.dte)}).`;
  return `${lead} ${flagged === 0 ? "No expiry is marked as an elevated gap." : `${flagged} of ${read.length} expiries ${flagged === 1 ? "is" : "are"} marked as an elevated gap (over 3 volatility points).`}`;
}

export interface PlainBucket { callWall: number | null; putWall: number | null; zeroGamma: number | null; totalGex: number; contractCount: number }
/** Dealer gamma by time to expiry: where the hedging pressure sits and whether, under the model, it damps or adds to moves. */
export function plainGexLadder(g: { zerodte: PlainBucket; short: PlainBucket; weekly: PlainBucket; monthly: PlainBucket } | null | undefined, spot: number | null | undefined, oi?: PlainOi | null): string {
  if (!g) return "Dealer gamma by expiry was not read.";
  if (noOi(oi)) return "Open interest was not available on this read, so dealer gamma by expiry cannot be read.";
  const named: Array<[string, PlainBucket]> = [["options expiring today", g.zerodte], ["options expiring in 1 to 2 days", g.short], ["options expiring in 3 to 7 days", g.weekly], ["options expiring in 8 days or more", g.monthly]];
  const live = named.filter(([, b]) => b.contractCount > 0 && fin(b.totalGex));
  if (!live.length) return "No bucket had contracts to read, so there is no dealer-gamma picture by expiry.";
  const biggest = [...live].sort((a, b) => Math.abs(b[1].totalGex) - Math.abs(a[1].totalGex))[0];
  const neg = live.filter(([, b]) => b.totalGex < 0).length;
  const sign = neg === live.length ? "Net gamma is negative in every bucket read: under the model's assumption about who holds what, dealer hedging adds to moves instead of damping them."
    : neg === 0 ? "Net gamma is positive in every bucket read: under the model's assumption about who holds what, dealer hedging damps moves."
    : `Net gamma is negative in ${neg} of ${live.length} buckets read and positive in the rest, so the model's hedging effect differs by expiry.`;
  const near = live[0][1];
  // The walls are the strikes with the largest call (above the price) and put (below it) dollar gamma, not the largest open interest.
  const walls = fin(near.callWall) && fin(near.putWall)
    ? ` In the nearest bucket read (${live[0][0]}), the strike above the price where call hedging pressure is largest is ${strike(near.callWall)}, and the strike below it where put hedging pressure is largest is ${strike(near.putWall)}${fin(spot) ? `; price is ${strike(spot)}` : ""}.`
    : "";
  const empty = g.zerodte.contractCount === 0 ? " No unsettled options expiring today are in this read." : "";
  return `The largest dealer hedging exposure is in ${biggest[0]}. ${sign}${walls}${empty}${held(oi)}`;
}

/** Key levels strip: where the running balance of call and put exposure changes side, and which side holds more near the money. */
export function plainKeyLevels(a: { spot: number | null | undefined; flipStrike: number | null | undefined; flipMethod?: string; score: number | null | undefined; dexState?: string; oi?: PlainOi | null }): string {
  // With no deltas or no open interest the server's score is 0 and its strike is a placeholder: neither is a reading.
  if (a.dexState === "unavailable" || noOi(a.oi)) return "The balance of calls against puts, and the strike where it changes side, were not read (no deltas or no open interest on this read).";
  const parts: string[] = [];
  const where = fin(a.spot) && fin(a.flipStrike) ? (a.flipStrike === a.spot ? "at the price" : `${pts(a.flipStrike - a.spot)} ${a.flipStrike > a.spot ? "above" : "below"} the price`) : null;
  if (a.flipMethod === "peak_fallback" && fin(a.flipStrike)) parts.push(`No strike where the running balance of call and put exposure changes side was found; ${strike(a.flipStrike)} is shown because it has the largest net exposure of the strikes above the price.`);
  else if (fin(a.flipStrike) && where) parts.push(`Adding up call and put exposure strike by strike from the lowest, the running balance changes side at ${strike(a.flipStrike)}, ${where}.`);
  else parts.push("No strike where the running balance of call and put exposure changes side was found on this read.");
  if (fin(a.score)) {
    const sc = minus(a.score);
    parts.push(Math.abs(a.score) <= 10 ? `Near the current price, calls and puts are held in about equal weight (${sc} on a scale from −100, all puts, to +100, all calls).`
      : `Near the current price, more ${a.score < 0 ? "put" : "call"} exposure is held than ${a.score < 0 ? "call" : "put"} exposure (${sc} on a scale from −100, all puts, to +100, all calls). This counts positions; it does not say who is long or short them.`);
  } else parts.push("The balance of calls against puts near the price was not read.");
  return parts.join(" ") + held(a.oi);
}

/** Delta exposure: how much stock the open options stand in for, calls against puts. */
export function plainDex(d: { totalNetDex: number; totalCallDex: number; totalPutDex: number; dexState?: string; dexCoverage?: { oiMissingShare: number | null } } | null | undefined, oi?: PlainOi | null): string {
  if (!d || d.dexState === "unavailable" || noOi(oi) || !fin(d.totalNetDex)) return "Delta exposure was not read: no contract had both open interest and a delta.";
  const lean = d.totalNetDex < 0 ? "puts outweigh calls" : d.totalNetDex > 0 ? "calls outweigh puts" : "calls and puts balance";
  const miss = d.dexState === "partial" ? ` Some contracts had no delta${fin(d.dexCoverage?.oiMissingShare) ? ` (${Math.round((d.dexCoverage!.oiMissingShare as number) * 100)}% of open interest)` : ""}, so this covers only the rest.` : "";
  return `Counting how much of the index each open option stands in for, ${lean}: a net ${money(d.totalNetDex)}. The chart shows which strikes carry it.${miss}${held(oi)}`;
}

/** Settlement odds per strike on the nearest expiry (risk-neutral). `prob` is in percent; rows arrive ranked by the server (odds per point). */
export function plainPinning(p: Array<{ strike: number; prob: number; probPerPoint?: number }> | null | undefined, meta: { state: "ok" | "unavailable"; reason: string | null } | null | undefined): string {
  if (meta?.state === "unavailable") return "Where the nearest expiry is priced to settle could not be read; the reason is shown below.";
  const rows = (p ?? []).filter((r) => fin(r.prob) && fin(r.strike));
  if (!rows.length) return "Where the nearest expiry is priced to settle was not read.";
  const top = rows[0], next = rows[1];
  const close = next != null && next.prob >= top.prob * 0.9;
  return `Option prices put the most likely settle near ${strike(top.strike)}, at ${top.prob.toFixed(1)}% for that strike's slice. ${close ? "The next strike is priced almost the same, so no one strike stands out." : "That is clearly above the next strike shown."} These are odds implied by prices, not a forecast of where it will close.`;
}

/** Unusual volume: contracts that traded at least twice their open interest. The server sends at most 20, ranked. */
export function plainUnusualVolume(u: Array<{ strike: number; side: "call" | "put"; expiry: string; dollarVolume: number }> | null | undefined, oi?: PlainOi | null): string {
  if (!u) return "Unusual volume was not read.";
  if (noOi(oi)) return "Open interest was not available on this read, so unusual volume cannot be judged.";
  if (!u.length) return "No contract traded at least twice its open interest on this read.";
  const calls = u.filter((r) => r.side === "call").length;
  const top = [...u].sort((a, b) => b.dollarVolume - a.dollarVolume)[0];
  const sides = `${calls} call${calls === 1 ? "" : "s"}, ${u.length - calls} put${u.length - calls === 1 ? "" : "s"}`;
  const count = u.length >= 20 ? `At least 20 contracts traded at least twice the positions already open in them; of the 20 shown, ${sides}.`
    : `${u.length} contract${u.length === 1 ? "" : "s"} traded at least twice the positions already open in them (${sides}).`;
  return `${count} The largest by dollars${u.length >= 20 ? " among those shown" : ""} is the ${strike(top.strike)} ${top.side} expiring ${top.expiry}, about ${money(top.dollarVolume)}. Heavy volume against open interest points to new positions; it does not show whether they were bought or sold.${held(oi)}`;
}

/**
 * Volatility risk premium: market IV against Schwab's model-vol field. When that field repeats the market
 * figure there is no separate estimate; when it is the same on every expiry it is a default. Either way the
 * rich/cheap labels cannot be relied on.
 */
export function plainVrp(rows: Array<{ marketIV: number | null; theoreticalIV: number | null; signal: string }> | null | undefined): string {
  const r = rows ?? [];
  const model = r.map((x) => x.theoreticalIV).filter(fin);
  if (!r.length || !model.length) return "Schwab's model volatility was not available, so no rich-or-cheap reading can be made.";
  const rich = r.filter((x) => x.signal === "iv_rich").length, cheap = r.filter((x) => x.signal === "iv_cheap").length, fair = r.filter((x) => x.signal === "fair").length;
  if (rich + cheap + fair === 0) return "Schwab's model volatility is the same as the market figure on every expiry read, so it is not a separate estimate and no rich-or-cheap reading can be made.";
  const flat = model.length >= 3 && model.every((v) => Math.abs(v - model[0]) < 0.0005);
  if (flat) return `Schwab's model volatility reads ${(model[0] * 100).toFixed(1)}% on every expiry, which looks like one default value and not an estimate per expiry. The rich and cheap labels below compare against that single number and should not be relied on.`;
  const none = r.length - rich - cheap - fair;
  return `Against Schwab's own model volatility, options are priced above it on ${rich} expir${rich === 1 ? "y" : "ies"}, below it on ${cheap}, and within 2 volatility points on ${fair}${none > 0 ? ` (${none} expir${none === 1 ? "y" : "ies"} had no separate model figure)` : ""}. This compares two volatility figures; it is not a measure of realised movement.`;
}

/** The headline VIX line on the Models header. `ratio` = VIX3M / VIX. */
export function plainVixTerm(vix: number | null | undefined, ratio: number | null | undefined): string {
  const level = !fin(vix) ? "The VIX was not read." : vix >= 30 ? `The VIX is ${vix.toFixed(1)}: options are pricing large daily swings.` : vix >= 20 ? `The VIX is ${vix.toFixed(1)}: options are pricing bigger daily swings than usual.` : vix >= 15 ? `The VIX is ${vix.toFixed(1)}: options are pricing ordinary daily swings.` : `The VIX is ${vix.toFixed(1)}: options are pricing small daily swings.`;
  const term = !fin(ratio) ? "The three-month VIX was not read, so near-term and later volatility cannot be compared."
    : ratio < 1 ? "Volatility over the next month is priced above the next three months: concern is concentrated in the near term."
    : ratio === 1 ? "Volatility over the next month is priced the same as the next three months."
    : "Volatility over the next month is priced below the next three months: the usual shape.";
  return `${level} ${term}`;
}

// ─── Answer first ────────────────────────────────────────────────────────────────────────────────
// A PlainRead is the one short sentence a reader needs (`answer`), with the fuller explanation behind a tap
// (`detail`). The answer must stand on its own and stay short enough to read while scrolling on a phone.

export interface PlainRead { answer: string; detail?: string }
/** Short marker on an answer whose numbers rest on open interest carried from an earlier session. */
const heldTag = (oi?: PlainOi | null) => (oi?.source === "held" ? ` (Open interest from ${oi.sessionDate ?? "an earlier session"}.)` : "");

export function readTermStructure(t: Parameters<typeof plainTermStructure>[0]): PlainRead {
  const answer = !t || t.contango == null ? "Near-dated and later options could not be compared."
    : fin(t.steepness) && Math.abs(t.steepness) < 0.0005 ? "Near-dated and later options are priced for about the same movement."
    : t.contango ? "Near-dated options are priced for less movement than later ones: the usual shape."
    : "Near-dated options are priced for more movement than later ones.";
  return { answer, detail: plainTermStructure(t) };
}

export function readSkew(rows: Parameters<typeof plainSkew>[0]): PlainRead {
  const read = (rows ?? []).filter((r) => fin(r.skew));
  const k = read.length ? (read[0].skew as number) : null;
  const answer = k == null ? "The cost of downside protection against upside was not read."
    : k > 0 ? "Downside protection costs more than upside." : k < 0 ? "Upside costs more than downside protection, which is unusual for an index." : "Downside protection and upside cost the same.";
  return { answer, detail: plainSkew(rows) };
}

/** The two halves of the volatility surface in one read. */
export function readVolSurface(t: Parameters<typeof plainTermStructure>[0], rows: Parameters<typeof plainSkew>[0]): PlainRead {
  const a = readTermStructure(t), b = readSkew(rows);
  return { answer: `${a.answer} ${b.answer}`, detail: `${a.detail} ${b.detail}` };
}

export function readGexLadder(g: Parameters<typeof plainGexLadder>[0], spot: number | null | undefined, oi?: PlainOi | null): PlainRead {
  const detail = plainGexLadder(g, spot, oi);
  if (!g || noOi(oi)) return { answer: "Dealer hedging by expiry was not read.", detail };
  const live = [g.zerodte, g.short, g.weekly, g.monthly].filter((b) => b.contractCount > 0 && fin(b.totalGex));
  if (!live.length) return { answer: "No expiry had contracts to read.", detail };
  const neg = live.filter((b) => b.totalGex < 0).length;
  const answer = neg === live.length ? "Model read: dealer hedging adds to moves at every expiry read."
    : neg === 0 ? "Model read: dealer hedging damps moves at every expiry read."
    : "Model read: dealer hedging adds to moves at some expiries and damps them at others.";
  return { answer: answer + heldTag(oi), detail };
}

export function readKeyLevels(a: Parameters<typeof plainKeyLevels>[0]): PlainRead {
  const detail = plainKeyLevels(a);
  if (a.dexState === "unavailable" || noOi(a.oi)) return { answer: "The balance of calls against puts was not read.", detail };
  const side = !fin(a.score) ? "the balance of calls against puts near the price was not read" : Math.abs(a.score) <= 10 ? "call and put exposure are held in about equal weight near the price" : `more ${a.score < 0 ? "put" : "call"} exposure than ${a.score < 0 ? "call" : "put"} exposure is held near the price`;
  const flip = a.flipMethod !== "peak_fallback" && fin(a.flipStrike) && fin(a.spot)
    ? `Positioning changes side at ${strike(a.flipStrike)} (${a.flipStrike === a.spot ? "at the price" : `${pts(a.flipStrike - a.spot)} ${a.flipStrike > a.spot ? "above" : "below"} the price`}); `
    : "";
  const s = `${flip}${side}.`;
  return { answer: s.charAt(0).toUpperCase() + s.slice(1) + heldTag(a.oi), detail };
}

export function readDex(d: Parameters<typeof plainDex>[0], oi?: PlainOi | null): PlainRead {
  const detail = plainDex(d, oi);
  if (!d || d.dexState === "unavailable" || noOi(oi) || !fin(d.totalNetDex)) return { answer: "Delta exposure was not read.", detail };
  return { answer: (d.totalNetDex < 0 ? "In open positions, puts outweigh calls." : d.totalNetDex > 0 ? "In open positions, calls outweigh puts." : "In open positions, calls and puts balance.") + heldTag(oi), detail };
}

export function readPinning(p: Parameters<typeof plainPinning>[0], meta: Parameters<typeof plainPinning>[1]): PlainRead {
  const detail = plainPinning(p, meta);
  const rows = (p ?? []).filter((r) => fin(r.prob) && fin(r.strike));
  if (meta?.state === "unavailable" || !rows.length) return { answer: "Where the nearest expiry is priced to settle was not read.", detail };
  const close = rows[1] != null && rows[1].prob >= rows[0].prob * 0.9;
  return { answer: close ? "No single strike stands out as the priced settle." : `The single most likely settle strike in option prices is ${strike(rows[0].strike)}; odds from prices, not a forecast.`, detail };
}

export function readUnusualVolume(u: Parameters<typeof plainUnusualVolume>[0], oi?: PlainOi | null): PlainRead {
  const detail = plainUnusualVolume(u, oi);
  if (!u || noOi(oi)) return { answer: "Unusual volume could not be judged on this read.", detail };
  if (!u.length) return { answer: "No contract traded at least twice its open positions.", detail };
  return { answer: `${u.length >= 20 ? "At least 20" : u.length} contract${u.length === 1 ? "" : "s"} traded at least twice their open positions: likely new positions, side unknown.${heldTag(oi)}`, detail };
}

export function readVrp(rows: Parameters<typeof plainVrp>[0]): PlainRead {
  const detail = plainVrp(rows);
  const r = rows ?? [];
  const model = r.map((x) => x.theoreticalIV).filter(fin);
  if (!r.length || !model.length) return { answer: "No rich-or-cheap reading is available.", detail };
  const rich = r.filter((x) => x.signal === "iv_rich").length, cheap = r.filter((x) => x.signal === "iv_cheap").length, fair = r.filter((x) => x.signal === "fair").length;
  if (rich + cheap + fair === 0) return { answer: "No rich-or-cheap reading is available: the model figure just repeats the market's.", detail };
  if (model.length >= 3 && model.every((v) => Math.abs(v - model[0]) < 0.0005)) return { answer: "The rich and cheap labels below are not reliable on this read.", detail };
  return { answer: `Against Schwab's model figure, options are above it on ${rich} expir${rich === 1 ? "y" : "ies"} and below it on ${cheap}.`, detail };
}

export function readVixTerm(vix: number | null | undefined, ratio: number | null | undefined): PlainRead {
  const lvl = !fin(vix) ? null : vix >= 30 ? "large daily swings are priced" : vix >= 20 ? "bigger daily swings than usual are priced" : vix >= 15 ? "ordinary daily swings are priced" : "small daily swings are priced";
  // The term clause stands on its own: tied to the level it read backwards whenever the level was "small".
  const term = !fin(ratio) ? "" : ratio < 1 ? "; near-term volatility is priced above later volatility" : ratio > 1 ? "; near-term volatility is priced below later volatility, the usual shape" : "";
  return { answer: lvl ? `VIX ${(vix as number).toFixed(1)}: ${lvl}${term}.` : "The VIX was not read.", detail: plainVixTerm(vix, ratio) };
}

// ─── The rest of the Models tab ─────────────────────────────────────────────────────────────────

/** The daily model box: which side of the gamma flip price is on, what that means under the model, and the two walls. */
export function readModel(m: { spot: number | null | undefined; zeroGamma: number | null | undefined; callWall: number | null | undefined; putWall: number | null | undefined; gammaZone: "y+" | "y-" | "y?" | string | null | undefined }): PlainRead {
  const zone = m.gammaZone === "y-" ? "Model read: dealer hedging adds to moves here." : m.gammaZone === "y+" ? "Model read: dealer hedging damps moves here." : "The model could not read whether dealer hedging adds to moves or damps them.";
  const rel = (lvl: number, spot: number) => (lvl === spot ? "at the price" : `${pts(lvl - spot)} ${lvl > spot ? "above" : "below"} the price`);
  const parts: string[] = [];
  if (fin(m.spot)) {
    if (fin(m.zeroGamma)) parts.push(`The level where that would switch (the gamma flip) is ${strike(m.zeroGamma)}, ${rel(m.zeroGamma, m.spot)}.`);
    else parts.push("The level where that would switch (the gamma flip) was not found.");
    const walls = [fin(m.callWall) ? `the largest call hedging level at or above the price is ${strike(m.callWall)} (${rel(m.callWall, m.spot)})` : null, fin(m.putWall) ? `the largest put hedging level at or below the price is ${strike(m.putWall)} (${rel(m.putWall, m.spot)})` : null].filter(Boolean) as string[];
    if (walls.length) { const w = walls.join(" and "); parts.push(`${w.charAt(0).toUpperCase()}${w.slice(1)}.`); } else parts.push("The call and put hedging levels were not read.");
  } else parts.push("The price was not read, so the levels cannot be placed against it.");
  parts.push("This is the model's assumption about who holds what, not a measurement, and it says nothing about direction.");
  return { answer: zone, detail: parts.join(" ") };
}

export const READ_MM_MATRIX: PlainRead = {
  answer: "A rule-of-thumb table set by hand, not measured odds.",
  detail: "The highlighted cell is where price and the dealer regime sit now. In each cell the move is the VIX-implied one-standard-deviation move scaled by a hand-set multiplier, and the up, pinned and down weights start from a hand-set table and are nudged by live readings. None of it has been fitted to, or tested against, what actually happened.",
};

export const READ_VOL_BAND_BACKTEST: PlainRead = {
  answer: "This table tests stand-in levels, not the dealer levels: no dealer level has been tested.",
  detail: "Testing a dealer level needs the option chains from past days, and none are connected. Each row here is a stand-in (a volatility band, a moving average or a round number). Compare its touch rate with the two baseline rows: the current price carried forward, and a level placed at random.",
};

/** The 10-session cone: the model's middle four fifths of outcomes (30-session realised volatility scaled by the VIX; coverage untested). */
export function readCone(c: { spot: number | null | undefined; days: number | null | undefined; q10: number | null | undefined; q90: number | null | undefined } | null | undefined): PlainRead {
  const detail = "The cone is built from how much price has moved over the last 30 sessions, scaled up or down by the VIX. It assumes no drift up or down and does not allow for calm and stormy stretches bunching together, so real tails can be wider. Its coverage has not been tested.";
  if (!c || !fin(c.q10) || !fin(c.q90) || !fin(c.days)) return { answer: "The forward range was not read.", detail };
  return { answer: `The model puts 8 in 10 outcomes ${c.days} sessions out between ${strike(c.q10)} and ${strike(c.q90)}, from recent movement scaled by the VIX. No direction is assumed.`, detail };
}

export const READ_PIVOT_PROJECTION: PlainRead = {
  answer: "Price levels from several methods, marked where they agree; the pattern scores are set by hand, not tested.",
  detail: "Each line is a level from one method (monthly and quarterly pivots, moving averages, gamma walls, heavy-volume prices). The count beside a level is how many methods land near it. A higher count means more agreement, not a higher chance of holding.",
};

// ─── Other tabs ─────────────────────────────────────────────────────────────────────────────────

/** Whale follow-through over a window: closed positions that made money after costs. `winRate` and `avgPct` are fractions. */
export function readWhalePerformance(r: { count: number; wins: number; losses: number; winRate: number | null; avgPct: number | null; excludedNoQuote?: number; excludedNoFee?: number } | null | undefined, windowDays: number): PlainRead {
  const detail = "Each flagged whale contract is scored as bought at the logged ask when it was detected and sold at the logged bid at its close or expiry, after fees. It is the result of buying the contract, not of taking the same side as the trader who was flagged. Positions without both quotes, and index positions with no configured fee, are left out and counted, not scored as losses.";
  if (!r) return { answer: "Whale follow-through was not read.", detail };
  const scored = r.wins + r.losses;
  const left = (r.excludedNoQuote ?? 0) + (r.excludedNoFee ?? 0);
  if (scored === 0) return { answer: `No whale position closed with a scoreable result in the last ${windowDays} days${left ? ` (${left} left out for a missing quote or fee)` : ""}.`, detail };
  const a100 = fin(r.avgPct) ? Math.round(r.avgPct * 100) : null;
  const avg = a100 == null ? "" : `; the average result was ${a100 === 0 ? "about 0" : `${a100 > 0 ? "+" : "−"}${Math.abs(a100)}`}%`;
  return { answer: `Buying each flagged whale contract over the last ${windowDays} days: ${r.wins} of ${scored} closed positions made money after costs${avg}.`, detail };
}

/** Edge Lab headline: how many graded whale alerts finished up 30% or more at expiry (held to expiry, not a peak). `hit30Rate` is a fraction. */
export function readEdgeWhale(w: { graded: number; pending: number; hit30Rate: number; ungradedNoMark?: number } | null | undefined, windowDays: number): PlainRead {
  const detail = "An alert counts as a hit when its option, bought at the logged ask, could be sold at expiry for at least 30% more (the last logged bid at or just before the expiry close), before fees. A gain that was given back before expiry is not a hit. Pending alerts have not resolved, and alerts with no usable mark are not graded; neither is counted as a miss.";
  if (!w) return { answer: "The graded record was not read.", detail };
  if (!w.graded) return { answer: `No whale alert has been graded in the last ${windowDays} days (${w.pending} pending).`, detail };
  const hits = Math.round(w.hit30Rate * w.graded);
  return { answer: `Of ${w.graded} graded whale alerts in the last ${windowDays} days, ${hits} finished up 30% or more at expiry (${(w.hit30Rate * 100).toFixed(0)}%).`, detail };
}

/** Flow alerts strip: how many, how many high, and what they are. */
export function readFlowAlerts(a: { total: number; high: number; connected: boolean | null; chainRead?: boolean; lastSession?: boolean; stale?: boolean }): PlainRead {
  const detail = "An alert is a fixed rule being met on the options chain: volume far above open interest, very heavy volume on one strike, a jump in the put/call ratio, or a very large open position at one strike (a wall). The thresholds are set by hand. An alert says something large is there; it does not say who traded or which way.";
  if (a.connected == null) return { answer: "Checking whether the chain feed is connected.", detail };
  if (!a.connected) return { answer: "Flow alerts are not updating: the chain feed is not connected.", detail };
  // Alerts already on screen when the latest read fails are from an earlier read, not "nothing to judge".
  if (a.chainRead === false) return { answer: a.total > 0 ? `${a.total} flow alert${a.total === 1 ? "" : "s"} from an earlier read; the latest chain read failed.` : "The options chain has not been read yet, so there is nothing to judge.", detail };
  // "stale" is the last good chain served in-session after a failed fetch: older, not the last session's.
  const from = a.lastSession ? " from the last session's chain" : a.stale ? " from an older copy of the chain" : "";
  if (a.total === 0) return { answer: `No flow alert is showing${from || " right now"}.`, detail };
  return { answer: `${a.total} flow alert${a.total === 1 ? "" : "s"} showing${from}${a.high ? `, ${a.high} marked high` : ""}. Each flags size on the options chain, not direction.`, detail };
}

export const READ_HEATSEEKER: PlainRead = {
  answer: "A map of where dealer hedging is concentrated, strike by strike, for one expiry (the nearest unless you pick another).",
  detail: "Each row is one strike of the chosen expiry. In the GEX column the green bar is the model's dealer hedging exposure from calls, the red bar from puts, and the number is calls minus puts; bigger bars mean more hedging at that strike. It is built from open interest and the model's assumption about who holds what, not from observed trades.",
};

// ─── Today ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The Today card: what the 0DTE map says in one sentence. `atSpot` is the sign of net dealer gamma at the
 * price for the nearest expiry, under the model. `above` / `below` are what the card's tiles show: the largest
 * strike within 2% of the price on each side where the model has dealer hedging damping moves (positive
 * gamma), or the pin when it fills an empty slot.
 */
export function readToday(m: {
  spot: number | null | undefined; sessionState?: string | null; dataState?: string | null;
  atSpot: "long" | "short" | "indeterminate" | string | null | undefined;
  straddle: number | null | undefined; low: number | null | undefined; high: number | null | undefined;
  above: number | null | undefined; below: number | null | undefined; aboveIsPin?: boolean; belowIsPin?: boolean;
  flip: number | null | undefined;
}): PlainRead {
  if (m.dataState === "no_gex") return { answer: "No dealer levels to read yet: the options chain carries no priced gamma.", detail: "The levels on this card come from dealer gamma at each strike. Until the chain carries it there are no walls or flip to show, and nothing is shown in their place." };
  const closed = m.sessionState === "closed";
  const when = closed ? "on the next session's options, as last read" : "today";
  const move = fin(m.straddle) ? ` Options price a move of about ±${Math.round(m.straddle)} points ${closed ? "by that session's close, from the last price" : "by the close"}.` : "";
  const answer = m.atSpot === "short" ? `Model read: dealer hedging adds to moves ${when}.${move}`
    : m.atSpot === "long" ? `Model read: dealer hedging damps moves ${when}.${move}`
    : `The model could not read whether dealer hedging adds to moves or damps them.${move}`;
  const parts: string[] = ["That read is for the nearest expiry only."];
  if (fin(m.spot)) {
    const rel = (x: number) => (x === m.spot ? "at the price" : `${pts(x - (m.spot as number))} ${x > (m.spot as number) ? "above" : "below"} the price`);
    parts.push(fin(m.flip) ? `The level where hedging would switch from one to the other (the gamma flip) is ${strike(m.flip)}, ${rel(m.flip)}.` : "No level where hedging switches was found inside the range read.");
    const side = (x: number | null | undefined, isPin: boolean | undefined, word: "above" | "below") =>
      !fin(x) ? `No strike ${word} the price within 2% has the model's dealer hedging damping moves.`
      : isPin ? `No such strike stands out ${word} the price, so the pin (${strike(x)}), the largest one near the price, is shown there.`
      : `${word === "above" ? "Above" : "Below"} the price, the largest strike within 2% where the model has dealer hedging damping moves is ${strike(x)}.`;
    parts.push(side(m.above, m.aboveIsPin, "above"), side(m.below, m.belowIsPin, "below"));
    if (fin(m.low) && fin(m.high)) parts.push(`The at-the-money straddle prices a range of ${strike(m.low)} to ${strike(m.high)}.`);
  }
  if (m.dataState === "stale" || m.dataState === "stale_session") parts.push("This is from the last chain read, not a live one.");
  parts.push("Dealer levels come from open interest and an assumption about who holds what. They describe positioning; they do not forecast direction.");
  return { answer, detail: parts.join(" ") };
}
