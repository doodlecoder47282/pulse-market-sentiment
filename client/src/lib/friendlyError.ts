import { parseUnavailableError } from "@shared/unavailable";

/**
 * A sentence for the user from any fetch error: the server's reason/message,
 * never a raw status code or JSON body.
 */
export function friendlyError(err: unknown, fallback: string): string {
  if (err == null) return fallback;
  const p = parseUnavailableError(err);
  let text = (p?.reason ?? (err instanceof Error ? err.message : String(err)) ?? "").trim();
  text = text.replace(/^\d{3}:\s*/, "");
  if (/^[{[]/.test(text)) {
    try {
      const j = JSON.parse(text);
      const pick = j?.reason ?? j?.message ?? j?.note ?? j?.error;
      text = typeof pick === "string" ? pick : "";
    } catch {
      text = "";
    }
  }
  if (!text || /^(internal server error|bad gateway|service unavailable|failed to fetch)$/i.test(text)) return fallback;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
