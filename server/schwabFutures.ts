// server/schwabFutures.ts
//
// Reading a futures quote out of Schwab's /marketdata/v1/quotes answer. A root such as /ES is asked for as the
// root; Schwab may key its answer by the root or by the contract it resolved the root to (/ESZ26: root, month
// letter, two-digit year). Both are accepted, and nothing else is: an entry is only taken for a root when its
// key (or its own symbol field) is that root or that root plus one month code. Pure, no I/O.

const MONTHS = "FGHJKMNQUVXZ";

/** True for a root future symbol as this app asks for it: a slash and 1-4 letters or digits (/ES, /NQ, /MES). */
export function isFutureRoot(symbol: string): boolean {
  return /^\/[A-Z0-9]{1,4}$/.test(symbol);
}

/** True when `key` is `root` itself or `root` plus a month letter and a two-digit year. */
export function isContractOf(root: string, key: string): boolean {
  if (key === root) return true;
  if (!key.startsWith(root) || key.length !== root.length + 3) return false;
  const tail = key.slice(root.length);
  return MONTHS.includes(tail[0]) && /^\d{2}$/.test(tail.slice(1));
}

/**
 * The entry of a quotes answer that belongs to a root future, with the key it was found under. Null when the
 * answer has none, or more than one candidate contract (the root is then ambiguous and no price is chosen).
 */
export function futuresQuoteEntry(data: unknown, root: string): { key: string; entry: any } | null {
  if (!data || typeof data !== "object" || Array.isArray(data) || !isFutureRoot(root)) return null;
  const obj = data as Record<string, any>;
  if (obj[root] && typeof obj[root] === "object") return { key: root, entry: obj[root] };
  const found: Array<{ key: string; entry: any }> = [];
  for (const [key, entry] of Object.entries(obj)) {
    if (key === "errors" || !entry || typeof entry !== "object") continue;
    const own = typeof entry.symbol === "string" ? entry.symbol : null;
    if (isContractOf(root, key) || (own != null && isContractOf(root, own))) found.push({ key, entry });
  }
  return found.length === 1 ? found[0] : null;
}

/** The symbols Schwab's answer names as not recognised (errors.invalidSymbols), empty when it names none. */
export function invalidSymbolsOf(data: unknown): string[] {
  const list = (data as any)?.errors?.invalidSymbols;
  return Array.isArray(list) ? list.filter((s) => typeof s === "string") : [];
}
