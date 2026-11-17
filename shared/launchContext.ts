// shared/launchContext.ts
//
// What the desk already knows about a pump.fun launch's name and deployer, from its own listener. Pure.
//
// The listener stores every pump.fun create it sees (name, symbol, deployer) for LAUNCH_CONTEXT_DAYS. Two
// things a trader checks before touching a new coin are read from that store at no extra cost: how many
// other coins launched under the same symbol in the last day (serial relaunches of one ticker are a
// rug pattern), and how many other coins the same deployer wallet launched in the kept window, with what
// the desk's own record says became of the ones it logged.
//
// Measurements only. Nothing here moves a verdict, score or exit level; the figures are stored on the
// signal row for the replay to test. Counts are LOWER bounds: the listener misses launches while it is
// reconnecting, keeps LAUNCH_CONTEXT_DAYS, and a deployer can use a fresh wallet per coin.

export const LAUNCH_CONTEXT_DAYS = 3;
export const SAME_SYMBOL_HOURS = 24;

export const LAUNCH_CONTEXT_METHOD =
  `pump.fun creates seen by the desk's listener (kept ${LAUNCH_CONTEXT_DAYS} days): other mints with the same symbol launched in the ${SAME_SYMBOL_HOURS} h before this one; other mints created by the same deployer wallet before this one, and the desk's own graded outcome for those it logged; lower bounds; measurements only, no gate`;

export interface DeployerOutcomes { logged: number; won: number; rugged: number; dead: number; open: number; noData: number }

export interface LaunchContext {
  state: "ok" | "unread";
  /** Why there is no read (listener off, not a pump.fun mint, launch not seen). Null when ok. */
  reason: string | null;
  /** Other mints with this symbol launched in the SAME_SYMBOL_HOURS before this one. */
  sameSymbol24h: number | null;
  /** Other mints this deployer created before this one, within the kept window. */
  deployerPrior: number | null;
  /** The desk's record for those prior mints (only the ones it logged). */
  deployerOutcomes: DeployerOutcomes | null;
  readAt: number;
  method: string;
  text: string;
}

/** Symbol comparison key: trimmed, lower-cased, leading "$" dropped. Empty when there is no symbol. */
export function normSymbol(s: string | null | undefined): string {
  return String(s ?? "").trim().replace(/^\$+/, "").toLowerCase();
}

export function unreadLaunchContext(reason: string, now: number): LaunchContext {
  return { state: "unread", reason, sameSymbol24h: null, deployerPrior: null, deployerOutcomes: null, readAt: now, method: LAUNCH_CONTEXT_METHOD, text: `launch context not read: ${reason}` };
}

/** Outcome rows (outcome, distinct coins) from the desk's signal log, folded into counts. */
export function foldOutcomes(rows: Array<{ outcome: string | null; n: number }>): DeployerOutcomes {
  const o: DeployerOutcomes = { logged: 0, won: 0, rugged: 0, dead: 0, open: 0, noData: 0 };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    o.logged += n;
    const k = String(r.outcome ?? "");
    if (k === "HIT_5M" || k === "DOUBLED") o.won += n;
    else if (k === "RUGGED") o.rugged += n;
    else if (k === "DEAD") o.dead += n;
    else if (k === "NO_DATA") o.noData += n;
    else o.open += n;
  }
  return o;
}

export function buildLaunchContext(input: { sameSymbol24h: number; deployerPrior: number; outcomes: DeployerOutcomes | null; symbol: string; now: number }): LaunchContext {
  const { sameSymbol24h, deployerPrior, outcomes, now } = input;
  const sym = input.symbol ? `"${input.symbol}"` : "this symbol";
  const parts: string[] = [];
  parts.push(sameSymbol24h === 0
    ? `no other ${sym} launch seen in the last ${SAME_SYMBOL_HOURS} h`
    : `${sameSymbol24h} other ${sym} launch${sameSymbol24h === 1 ? "" : "es"} seen in the last ${SAME_SYMBOL_HOURS} h`);
  if (deployerPrior === 0) parts.push(`no earlier launch by this deployer in ${LAUNCH_CONTEXT_DAYS} days`);
  else {
    let s = `this deployer launched ${deployerPrior} other coin${deployerPrior === 1 ? "" : "s"} in ${LAUNCH_CONTEXT_DAYS} days`;
    if (outcomes && outcomes.logged > 0) {
      const bits = [
        outcomes.rugged ? `${outcomes.rugged} rugged` : null,
        outcomes.dead ? `${outcomes.dead} dead` : null,
        outcomes.won ? `${outcomes.won} hit the target or doubled` : null,
        outcomes.open ? `${outcomes.open} open` : null,
        outcomes.noData ? `${outcomes.noData} no data` : null,
      ].filter(Boolean);
      s += ` (the desk logged ${outcomes.logged}: ${bits.join(", ")})`;
    } else s += " (none logged by the desk)";
    parts.push(s);
  }
  return {
    state: "ok", reason: null, sameSymbol24h, deployerPrior, deployerOutcomes: outcomes, readAt: now, method: LAUNCH_CONTEXT_METHOD,
    text: `${parts.join("; ")}; lower bounds`,
  };
}
