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
const money = (n: number) => {
  const a = Math.abs(n);
  return `${n < 0 ? "−" : ""}$${a >= 1e12 ? `${(a / 1e12).toFixed(2)} trillion` : a >= 1e9 ? `${(a / 1e9).toFixed(1)} billion` : a >= 1e6 ? `${(a / 1e6).toFixed(1)} million` : Math.round(a).toLocaleString("en-US")}`;
};

/** Term structure: are options that expire soon cheaper or dearer than later ones. `steepness` = back minus front, as a decimal. */
export function plainTermStructure(t: { contango: boolean | null; steepness: number | null } | null | undefined): string {
  if (!t || t.contango == null) return "Not enough expiries were read to compare near-dated options with later ones.";
  const by = fin(t.steepness) ? ` by ${volPts(t.steepness)}` : "";
  return t.contango
    ? `Options that expire soon are priced for less movement than later ones${by}. That is the usual shape when nothing urgent is priced in.`
    : `Options that expire soon are priced for more movement than later ones${by}. The market is paying up for the next few days in particular.`;
}

/** Skew: how much more downside protection costs than upside. `skew` = 25-delta put IV minus call IV, decimal. */
export function plainSkew(rows: Array<{ dte: number; skew: number | null; elevatedFear: boolean }> | null | undefined): string {
  const read = (rows ?? []).filter((r) => fin(r.skew));
  if (!read.length) return "The price of downside protection against upside was not read on any expiry.";
  const near = read[0];
  const flagged = read.filter((r) => r.elevatedFear).length;
  const lead = (near.skew as number) > 0
    ? `Downside protection costs more than upside: on the nearest expiry read (${near.dte} day${near.dte === 1 ? "" : "s"} out), puts are ${volPts(near.skew as number)} dearer than equally distant calls.`
    : (near.skew as number) < 0
    ? `Upside costs more than downside protection on the nearest expiry read (${near.dte} day${near.dte === 1 ? "" : "s"} out), by ${volPts(near.skew as number)}. That is unusual for an index.`
    : `Puts and calls cost the same on the nearest expiry read (${near.dte} day${near.dte === 1 ? "" : "s"} out).`;
  return `${lead} ${flagged === 0 ? "No expiry is marked as an elevated gap." : `${flagged} of ${read.length} expiries are marked as an elevated gap (over 3 volatility points).`}`;
}

export interface PlainBucket { callWall: number | null; putWall: number | null; zeroGamma: number | null; totalGex: number; contractCount: number }
/** Dealer gamma by time to expiry: where the hedging pressure sits and whether, under the model, it damps or adds to moves. */
export function plainGexLadder(g: { zerodte: PlainBucket; short: PlainBucket; weekly: PlainBucket; monthly: PlainBucket } | null | undefined, spot: number | null | undefined): string {
  if (!g) return "Dealer gamma by expiry was not read.";
  const named: Array<[string, PlainBucket]> = [["options expiring today", g.zerodte], ["options expiring in 1 to 2 days", g.short], ["options expiring in 3 to 7 days", g.weekly], ["options expiring in 8 days or more", g.monthly]];
  const live = named.filter(([, b]) => b.contractCount > 0 && fin(b.totalGex));
  if (!live.length) return "No bucket had contracts to read, so there is no dealer-gamma picture by expiry.";
  const biggest = [...live].sort((a, b) => Math.abs(b[1].totalGex) - Math.abs(a[1].totalGex))[0];
  const neg = live.filter(([, b]) => b.totalGex < 0).length;
  const sign = neg === live.length ? "Net gamma is negative in every bucket read: under the model's assumption about who holds what, dealer hedging adds to moves instead of damping them."
    : neg === 0 ? "Net gamma is positive in every bucket read: under the model's assumption about who holds what, dealer hedging damps moves."
    : `Net gamma is negative in ${neg} of ${live.length} buckets read and positive in the rest, so the model's hedging effect differs by expiry.`;
  const near = live[0][1];
  const walls = fin(near.callWall) && fin(near.putWall)
    ? ` In the nearest bucket read (${live[0][0]}), the largest call position is at ${strike(near.callWall)} and the largest put position at ${strike(near.putWall)}${fin(spot) ? `; price is ${strike(spot)}` : ""}.`
    : "";
  const empty = g.zerodte.contractCount === 0 ? " Nothing expiring today was read, so the same-day bucket is empty, not zero." : "";
  return `The largest dealer hedging exposure is in ${biggest[0]}. ${sign}${walls}${empty}`;
}

/** Key levels strip: where price sits against the strike where positioning changes side, and which side holds more near the money. */
export function plainKeyLevels(a: { spot: number | null | undefined; flipStrike: number | null | undefined; flipMethod?: string; score: number | null | undefined }): string {
  const parts: string[] = [];
  // A fallback strike is the largest exposure, not a change of side: it is not described as one.
  if (a.flipMethod === "peak_fallback" && fin(a.flipStrike)) parts.push(`No strike where open positions change from put-heavy to call-heavy was found; ${strike(a.flipStrike)} is shown because it carries the largest exposure.`);
  else if (fin(a.spot) && fin(a.flipStrike)) {
    const d = a.spot - a.flipStrike;
    parts.push(d === 0 ? `Price is at ${strike(a.flipStrike)}, the strike where open positions tip from put-heavy to call-heavy.`
      : `Price is ${pts(d)} ${d < 0 ? "below" : "above"} ${strike(a.flipStrike)}, the strike where open positions tip from put-heavy to call-heavy.`);
  } else parts.push("The strike where open positions tip from put-heavy to call-heavy was not found on this read.");
  if (fin(a.score)) {
    parts.push(Math.abs(a.score) <= 10 ? `Near the current price, calls and puts are held in about equal weight (${a.score.toFixed(0)} on a scale from −100, all puts, to +100, all calls).`
      : `Near the current price, more ${a.score < 0 ? "put" : "call"} exposure is held than ${a.score < 0 ? "call" : "put"} exposure (${a.score.toFixed(0)} on a scale from −100, all puts, to +100, all calls). This counts positions; it does not say who is long or short them.`);
  } else parts.push("The balance of calls against puts near the price was not read.");
  return parts.join(" ");
}

/** Delta exposure: how much stock the open options stand in for, calls against puts. */
export function plainDex(d: { totalNetDex: number; totalCallDex: number; totalPutDex: number; dexState?: string; dexCoverage?: { oiMissingShare: number | null } } | null | undefined): string {
  if (!d || d.dexState === "unavailable" || !fin(d.totalNetDex)) return "Delta exposure was not read: the chain did not carry deltas.";
  const lean = d.totalNetDex < 0 ? "puts outweigh calls" : d.totalNetDex > 0 ? "calls outweigh puts" : "calls and puts balance";
  const miss = d.dexState === "partial" ? ` Some contracts had no delta${fin(d.dexCoverage?.oiMissingShare) ? ` (${Math.round((d.dexCoverage!.oiMissingShare as number) * 100)}% of open interest)` : ""}, so this covers only the rest.` : "";
  return `Counting how much of the index each open option stands in for, ${lean}: a net ${money(d.totalNetDex)}. The chart shows which strikes carry it.${miss}`;
}

/** Settlement odds per strike on the nearest expiry (risk-neutral). `prob` is in percent. */
export function plainPinning(p: Array<{ strike: number; prob: number }> | null | undefined, meta: { state: "ok" | "unavailable"; reason: string | null } | null | undefined): string {
  if (meta?.state === "unavailable") return `Where the nearest expiry is priced to settle could not be read${meta.reason ? `: ${meta.reason}` : ""}.`;
  const rows = (p ?? []).filter((r) => fin(r.prob) && fin(r.strike));
  if (!rows.length) return "Where the nearest expiry is priced to settle was not read.";
  const top = [...rows].sort((a, b) => b.prob - a.prob)[0];
  const spread = rows.length > 1 && top.prob - [...rows].sort((a, b) => b.prob - a.prob)[1].prob < 0.5;
  return `Option prices put the single most likely settle near ${strike(top.strike)}, at ${top.prob.toFixed(1)}% for that strike's slice. ${spread ? "The strikes beside it are priced almost the same, so no one strike stands out." : "That is the highest of the strikes shown."} These are odds implied by prices, not a forecast of where it will close.`;
}

/** Unusual volume: contracts that traded well above their open interest. */
export function plainUnusualVolume(u: Array<{ strike: number; side: "call" | "put"; expiry: string; dollarVolume: number }> | null | undefined): string {
  if (!u) return "Unusual volume was not read.";
  if (!u.length) return "No contract traded more than twice its open interest on this read.";
  const calls = u.filter((r) => r.side === "call").length;
  const top = [...u].sort((a, b) => b.dollarVolume - a.dollarVolume)[0];
  return `${u.length} contract${u.length === 1 ? "" : "s"} traded more than twice the positions already open in them (${calls} call${calls === 1 ? "" : "s"}, ${u.length - calls} put${u.length - calls === 1 ? "" : "s"}). The largest by dollars is the ${strike(top.strike)} ${top.side} expiring ${top.expiry}, about ${money(top.dollarVolume)}. Heavy volume against open interest points to new positions; it does not show whether they were bought or sold.`;
}

/**
 * Volatility risk premium: market IV against Schwab's model-vol field. When that field is the same on every
 * expiry it is a default, not an estimate per expiry, and the rich/cheap labels cannot be relied on.
 */
export function plainVrp(rows: Array<{ marketIV: number | null; theoreticalIV: number | null; signal: string }> | null | undefined): string {
  const r = rows ?? [];
  const model = r.map((x) => x.theoreticalIV).filter(fin);
  if (!r.length || !model.length) return "Schwab's model volatility was not available, so no rich-or-cheap reading can be made.";
  const flat = model.length >= 3 && model.every((v) => Math.abs(v - model[0]) < 0.0005);
  if (flat) return `Schwab's model volatility reads ${(model[0] * 100).toFixed(1)}% on every expiry, which looks like one default value and not an estimate per expiry. The rich and cheap labels below compare against that single number and should not be relied on.`;
  const rich = r.filter((x) => x.signal === "iv_rich").length, cheap = r.filter((x) => x.signal === "iv_cheap").length, fair = r.filter((x) => x.signal === "fair").length;
  return `Against Schwab's own model volatility, options are priced above it on ${rich} expir${rich === 1 ? "y" : "ies"}, below it on ${cheap}, and within 2 volatility points on ${fair}. This compares two volatility figures; it is not a measure of realised movement.`;
}

/** The headline VIX line on the Models header. `ratio` = VIX3M / VIX. */
export function plainVixTerm(vix: number | null | undefined, ratio: number | null | undefined): string {
  const level = !fin(vix) ? "The VIX was not read." : vix >= 30 ? `The VIX is ${vix.toFixed(1)}: options are pricing large daily swings.` : vix >= 20 ? `The VIX is ${vix.toFixed(1)}: options are pricing bigger daily swings than usual.` : vix >= 15 ? `The VIX is ${vix.toFixed(1)}: options are pricing ordinary daily swings.` : `The VIX is ${vix.toFixed(1)}: options are pricing small daily swings.`;
  const term = !fin(ratio) ? "The three-month VIX was not read, so near-term and later volatility cannot be compared."
    : ratio < 1 ? "Volatility over the next month is priced above the next three months: concern is concentrated in the near term."
    : "Volatility over the next month is priced below the next three months: the usual shape.";
  return `${level} ${term}`;
}
