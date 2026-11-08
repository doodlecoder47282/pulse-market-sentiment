// client/src/lib/asOf.ts
//
// Pure helpers behind AsOfNote: accepts epoch ms, epoch seconds or an ISO
// string; a missing or unparsable asOf reads "read time unknown", never now.

export function asOfMs(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e12 ? v * 1000 : v; // seconds vs ms
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function asOfText(v: number | string | null | undefined, nowMs: number = Date.now()): string {
  const t = asOfMs(v);
  if (t == null) return "read time unknown";
  const age = Math.max(0, nowMs - t);
  const ago = age < 60_000 ? `${Math.round(age / 1000)} s ago`
    : age < 3600_000 ? `${Math.round(age / 60_000)} min ago`
    : age < 86_400_000 ? `${(age / 3600_000).toFixed(1)} h ago`
    : `${Math.round(age / 86_400_000)} d ago`;
  return `read ${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${ago}`;
}
