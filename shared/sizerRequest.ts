// shared/sizerRequest.ts
//
// One price convention for the position sizer, end to end (pure, no imports):
//   - The card asks for the option's MID price, the stop (a mid level) and the
//     quoted bid-ask spread, all in $ per share.
//   - The server's entryPrice is the FILL: a market buy pays the ask, which is
//     mid + spread / 2. The server's stopSlippage is the extra loss when the
//     stop fills at the bid: spread / 2 below the stop's mid.
// Sending the mid as entryPrice (the old card) never charged the entry half
// spread: $10,000, 2% risk, mid 1.50, stop 1.20, spread 0.10 sized 5 contracts
// whose true loss at the stop was 5 x $41.30 = $206.50 > the $200 budget.

export interface SizerForm {
  accountSize: string | number;
  maxRiskPctPercent: string | number;   // e.g. 2 for 2%
  midPrice: string | number;            // $ per share
  stopPrice: string | number;           // $ per share (mid level)
  spreadDollars: string | number;       // quoted ask - bid, $ per share
  gradeScore: string | number;
  targetPct: string | number;
  kellyPercent: string | number;        // e.g. 25 for quarter Kelly
  feePerContract: string | number;      // $ per contract per side; "" = not given
  product: string;                      // option root, e.g. "SPXW"
  maxGapLossPctPercent?: string | number; // e.g. 5 for 5%
}

export interface SizerRequestBody {
  accountSize: number;
  maxRiskPct: number;
  entryPrice: number;     // ask = mid + spread/2, $ per share
  stopPrice: number;
  stopSlippage: number;   // spread/2, $ per share
  gradeScore: number;
  targetPct: number;
  kellyFraction: number;
  feePerContract?: number;
  product: string;
  maxGapLossPct?: number;
}

const num = (v: string | number | undefined): number => (typeof v === "number" ? v : Number(String(v ?? "").trim()));
const roundCent = (x: number): number => Math.round(x * 100 + 1e-9) / 100;

export function buildSizerRequest(f: SizerForm): SizerRequestBody {
  const mid = num(f.midPrice);
  const half = Math.max(0, num(f.spreadDollars) || 0) / 2;
  const feeRaw = String(f.feePerContract ?? "").trim();
  const gapRaw = f.maxGapLossPctPercent == null ? "" : String(f.maxGapLossPctPercent).trim();
  return {
    accountSize: num(f.accountSize),
    maxRiskPct: num(f.maxRiskPctPercent) / 100,
    // Round the ask to the cent (option quotes are in cents) so 1.50 + 0.05 is exactly 1.55.
    entryPrice: roundCent(mid + half),
    stopPrice: num(f.stopPrice),
    stopSlippage: roundCent(half),
    gradeScore: num(f.gradeScore),
    targetPct: num(f.targetPct),
    kellyFraction: num(f.kellyPercent) / 100,
    ...(feeRaw !== "" && Number.isFinite(Number(feeRaw)) ? { feePerContract: Number(feeRaw) } : {}),
    product: f.product,
    ...(gapRaw !== "" && Number.isFinite(Number(gapRaw)) ? { maxGapLossPct: Number(gapRaw) / 100 } : {}),
  };
}
