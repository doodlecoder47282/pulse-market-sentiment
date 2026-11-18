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
