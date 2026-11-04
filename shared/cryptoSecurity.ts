// Reviewed mint subset only. Token-2022 transfer-changing/unknown extensions fail closed.
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const MINT_PARSER_VERSION = "mint-fields-2026-10-01.1";
export interface MintEvidence {
  state: "CHECKED" | "UNSUPPORTED" | "UNKNOWN";
  program: string | null; mintAuthorityActive: boolean | null; freezeAuthorityActive: boolean | null;
  supplyRaw: string | null; slot: number | null; reason: string;
  parserVersion?: string; extensions?: string[];
}
export function parseMintEvidence(result: any, expectedMint?: string): MintEvidence {
  const value = result?.value, parsed = value?.data?.parsed, info = parsed?.info;
  const base: MintEvidence = { state: "UNKNOWN", program: typeof value?.owner === "string" ? value.owner : null,
    mintAuthorityActive: null, freezeAuthorityActive: null, supplyRaw: null,
    slot: Number.isSafeInteger(result?.context?.slot) && result.context.slot >= 0 ? result.context.slot : null,
    parserVersion: MINT_PARSER_VERSION, reason: "Mint response incomplete" };
  if (!value) return base;
  if (![SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(value.owner)) return { ...base, state: "UNSUPPORTED", reason: "Token program not supported; no safety conclusion" };
  if (parsed?.type !== "mint" || info?.isInitialized !== true || value.executable === true) return base;
  const authority = (key: string) => Object.prototype.hasOwnProperty.call(info, key) &&
    (info[key] === null || (typeof info[key] === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(info[key])));
  if (!authority("mintAuthority") || !authority("freezeAuthority") || !/^\d+$/.test(String(info.supply ?? "")) ||
      !Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 255) return base;
  if (base.slot == null) return { ...base, reason: "RPC context slot missing" };
  if (value.owner === TOKEN_2022_PROGRAM) {
    if (!expectedMint || value.data?.program !== "spl-token-2022" || !Array.isArray(info.extensions)) {
      return { ...base, state: "UNSUPPORTED", reason: "Token-2022 extension list or exact mint identity unavailable" };
    }
    const extensions = info.extensions.map((e: any) => e?.extension);
    const unsupported = extensions.filter((e: unknown) => !["metadataPointer", "tokenMetadata"].includes(String(e)));
    if (unsupported.length || new Set(extensions).size !== extensions.length) {
      return { ...base, state: "UNSUPPORTED", extensions: extensions.filter((e: unknown) => typeof e === "string"),
        reason: "Transfer-changing, unknown or duplicate Token-2022 extensions are not approved; no shortlist qualification" };
    }
    // Empty lists are accepted only for an unextended base mint. An extended
    // account with missing parsed extensions must not be silently whitelisted.
    const plain = extensions.length === 0 && (value.space ?? value.data?.space) === 82;
    const pointer = info.extensions.find((e: any) => e.extension === "metadataPointer")?.state;
    const metadata = info.extensions.find((e: any) => e.extension === "tokenMetadata")?.state;
    const immutableSelfMetadata = extensions.length === 2 && pointer?.authority === null &&
      pointer?.metadataAddress === expectedMint && metadata?.mint === expectedMint &&
      metadata?.updateAuthority === null && typeof metadata?.name === "string" &&
      typeof metadata?.symbol === "string" && typeof metadata?.uri === "string" &&
      Array.isArray(metadata?.additionalMetadata);
    if (!plain && !immutableSelfMetadata) return { ...base, state: "UNSUPPORTED", extensions,
      reason: "Token-2022 metadata must be complete, immutable and self-referenced; otherwise qualification is blocked" };
    return { ...base, state: "CHECKED", extensions, mintAuthorityActive: info.mintAuthority !== null,
      freezeAuthorityActive: info.freezeAuthority !== null, supplyRaw: String(info.supply),
      reason: "Token-2022 base mint and reviewed immutable metadata subset checked; holder ownership and sell route remain unverified" };
  }
  if (Array.isArray(info.extensions) && info.extensions.length) return { ...base, state: "UNSUPPORTED", reason: "Unexpected extensions on original SPL mint" };
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
