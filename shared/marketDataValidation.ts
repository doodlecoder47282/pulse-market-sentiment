export type ValidationVerdict = "pass" | "partial" | "fail" | "blocked";
export interface MarketDataCheck {
  name: string;
  ok: boolean;
  verdict: ValidationVerdict;
  status: number | null;
  detail: string;
  source: "Schwab direct REST" | "none";
  observedAt: number | null;
}
export interface MarketDataValidation {
  version: 1;
  connected: boolean;
  realDataChecked: boolean;
  marketInputsValid: boolean;
  checkedAt: number;
  expiresAt: number;
  cached: boolean;
  scope: string;
  items: MarketDataCheck[];
}
