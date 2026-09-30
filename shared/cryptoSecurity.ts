// Original SPL Token mint parser only. Other programs/extensions fail closed.
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export interface MintEvidence {
  state: "CHECKED" | "UNSUPPORTED" | "UNKNOWN";
  program: string | null; mintAuthorityActive: boolean | null; freezeAuthorityActive: boolean | null;
  supplyRaw: string | null; slot: number | null; reason: string;
}
export function parseMintEvidence(result: any): MintEvidence {
  const value = result?.value, parsed = value?.data?.parsed, info = parsed?.info;
  const base: MintEvidence = { state: "UNKNOWN", program: typeof value?.owner === "string" ? value.owner : null,
    mintAuthorityActive: null, freezeAuthorityActive: null, supplyRaw: null,
    slot: Number.isSafeInteger(result?.context?.slot) && result.context.slot >= 0 ? result.context.slot : null, reason: "Mint response incomplete" };
  if (!value) return base;
  if (value.owner !== SPL_TOKEN_PROGRAM) return { ...base, state: "UNSUPPORTED", reason: "Token program/extensions not supported by this parser; no safety conclusion" };
  if (parsed?.type !== "mint" || info?.isInitialized !== true || value.executable === true) return base;
  const authority = (key: string) => Object.prototype.hasOwnProperty.call(info, key) &&
    (info[key] === null || (typeof info[key] === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(info[key])));
  if (!authority("mintAuthority") || !authority("freezeAuthority") || !/^\d+$/.test(String(info.supply ?? "")) ||
      !Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 255) return base;
  return { ...base, state: "CHECKED", mintAuthorityActive: info.mintAuthority !== null,
    freezeAuthorityActive: info.freezeAuthority !== null, supplyRaw: String(info.supply),
    reason: "Original SPL mint fields checked at confirmed commitment; holder ownership and sell route are not verified" };
}
export function rawTop10AccountPct(rows: any[], supplyRaw: string): number | null {
  try {
    const supply = BigInt(supplyRaw);
    if (supply <= 0n || !rows.length) return null;
    const seen = new Set<string>(); const amounts: bigint[] = [];
    for (const row of rows) {
      if (typeof row?.address !== "string" || seen.has(row.address) || !/^\d+$/.test(String(row.amount ?? ""))) return null;
      seen.add(row.address); amounts.push(BigInt(row.amount));
    }
    amounts.sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
    const total = amounts.slice(0, 10).reduce((a, b) => a + b, 0n);
    if (total > supply) return null;
    return Number(total * 10000n / supply) / 100;
  } catch { return null; }
}
