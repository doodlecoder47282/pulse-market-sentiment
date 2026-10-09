// server/feeConfig.ts
//
// One fee rule for every R2-C dollar figure (T1 projection, exit brain,
// whale scoreboard): sizingMath.resolveFeePerContract, the rule the 0DTE
// sizer already uses.
//   - Equity/ETF options: Schwab's $0.65 per contract per side
//     ("$0 base commission, plus $0.65 per contract",
//     https://www.schwab.com/public/file/P-3346815).
//   - Index option roots (SPX, SPXW, XSP, NDX, RUT, VIX, ...): Schwab adds
//     exchange index fees on top of the commission, so no default is assumed.
//     The all-in $ per contract per side comes from INDEX_OPTION_FEE_PER_CONTRACT
//     (ODTE_FEE_PER_CONTRACT is accepted as an alias); without it, dollar
//     P&L for index roots is UNAVAILABLE, never computed on a guessed fee.

import { isIndexOptionProduct, resolveFeePerContract } from "./sizingMath";

export interface FeeResolution {
  fee: number | null;
  basis: string;
}

function envNum(name: string): number | null {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw == null || raw === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** Fee per contract per side for an option root or symbol, or null (index root with no configured fee). */
export function feeForProduct(product: string | null | undefined, env: { indexFee?: number | null } = {}): FeeResolution {
  const index = isIndexOptionProduct(product ?? null);
  const indexFee = env.indexFee !== undefined ? env.indexFee : (envNum("INDEX_OPTION_FEE_PER_CONTRACT") ?? envNum("ODTE_FEE_PER_CONTRACT"));
  const fee = resolveFeePerContract(index ? indexFee : null, product ?? null);
  return {
    fee,
    basis: !index
      ? "Schwab $0.65 per contract per side"
      : fee != null
        ? `configured all-in index fee $${fee.toFixed(2)} per contract per side`
        : "index option: exchange fees not configured (set INDEX_OPTION_FEE_PER_CONTRACT); dollar P&L unavailable",
  };
}
