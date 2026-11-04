import { z } from "zod";

/**
 * Opt-in transport contract, NOT evidence admission or proof of historical availability.
 * Producers must instrument the actual transport/cache branch, not a helper's return.
 *
 * received_at is this app's original successful provider-response body receipt, not a
 * provider observation, HTTP Date header, cache expiry, adapter return or snapshot time.
 * A cache may retain an actually recorded original receipt; it may never refresh it.
 */
export const EVIDENCE_ACQUISITION_VERSION = "evidence-acquisition-v1";
const instant = z.string().datetime({ offset: true });
// Local clocks are represented canonically; upstream observed_at is never normalized here.
const localInstant = z.string().datetime({ precision: 3 }).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value,
"Expected a canonical UTC millisecond timestamp");
const base = {
  schema_version: z.literal(EVIDENCE_ACQUISITION_VERSION),
  read_at: localInstant,
};
const adapterReadProvenance = z.enum([
  "transport_response", "cache_hit", "stale_cache_fallback", "unverified_adapter_return",
]);
export const EvidenceAcquisitionSchema = z.discriminatedUnion("read_provenance", [
  z.object({
    ...base,
    // Only the successful body-read branch of an instrumented transport may assert this.
    read_provenance: z.literal("transport_response"),
    received_at: localInstant,
  }).strict(),
  z.object({
    ...base,
    read_provenance: z.literal("cache_hit"),
    // Non-null means the ORIGINAL instrumented transport receipt survived with these bytes.
    received_at: localInstant.nullable(),
  }).strict(),
  z.object({
    ...base,
    read_provenance: z.literal("stale_cache_fallback"),
    received_at: localInstant.nullable(),
  }).strict(),
  z.object({
    ...base,
    // A successful return from a legacy helper proves neither a network fetch nor a cache hit.
    read_provenance: z.literal("unverified_adapter_return"),
    received_at: z.null(),
  }).strict(),
  z.object({
    ...base,
    // The brief service's completed-read cache is separate from the provider transport cache.
    read_provenance: z.literal("brief_read_cache"),
    received_at: localInstant.nullable(),
    adapter_read_at: localInstant,
    adapter_read_provenance: adapterReadProvenance,
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.received_at !== null && Date.parse(value.received_at) > Date.parse(value.read_at)) {
    ctx.addIssue({ code: "custom", path: ["received_at"], message: "Receipt must not follow read" });
  }
  if (value.read_provenance === "brief_read_cache") {
    if (Date.parse(value.adapter_read_at) > Date.parse(value.read_at)
      || (value.received_at !== null && Date.parse(value.received_at) > Date.parse(value.adapter_read_at))
      || (value.adapter_read_provenance === "transport_response" && value.received_at === null)
      || (value.adapter_read_provenance === "unverified_adapter_return" && value.received_at !== null)) {
      ctx.addIssue({ code: "custom", message: "Invalid retained adapter acquisition" });
    }
  }
});
export type EvidenceAcquisition = z.infer<typeof EvidenceAcquisitionSchema>;

/** Pure construction only: the caller must supply times measured at the stated branch. */
export function makeEvidenceAcquisition(
  read_provenance: z.infer<typeof adapterReadProvenance>, receivedMs: number | null, readMs: number,
): EvidenceAcquisition | undefined {
  try {
    const parsed = EvidenceAcquisitionSchema.safeParse({
      schema_version: EVIDENCE_ACQUISITION_VERSION, read_provenance,
      received_at: receivedMs === null ? null : new Date(receivedMs).toISOString(),
      read_at: new Date(readMs).toISOString(),
    });
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; } // bad clocks must not break a legacy transport or cause retries
}

/** Preserve the original receipt and adapter path across the brief service's own cache. */
export function reuseEvidenceAcquisition(raw: unknown, readMs: number): EvidenceAcquisition | undefined {
  const parsed = EvidenceAcquisitionSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const a = parsed.data;
  try {
    const reused = EvidenceAcquisitionSchema.safeParse({
      schema_version: EVIDENCE_ACQUISITION_VERSION, read_provenance: "brief_read_cache",
      received_at: a.received_at, read_at: new Date(readMs).toISOString(),
      adapter_read_at: a.read_provenance === "brief_read_cache" ? a.adapter_read_at : a.read_at,
      adapter_read_provenance: a.read_provenance === "brief_read_cache" ? a.adapter_read_provenance : a.read_provenance,
    });
    return reused.success ? reused.data : undefined;
  } catch { return undefined; }
}

const ContextSchema = z.object({
  observed_at: z.string().min(1),
  time_precision: z.enum(["instant", "date", "period"]),
  // Existing brief.created_at, NOT a transport time or a ledger persistence time.
  captured_at: localInstant,
  now: z.number().int().finite().min(0).max(8_640_000_000_000_000),
}).strict();
export type EvidenceAcquisitionContext = z.infer<typeof ContextSchema>;
export type AcquisitionIssue =
  | "invalid_context" | "invalid_observation_time" | "invalid_acquisition"
  | "future_capture" | "future_observation" | "future_read" | "future_receipt"
  | "read_after_capture" | "observation_after_capture" | "observation_after_read"
  | "observation_after_receipt";
export type EvidenceAcquisitionReview = {
  status: "accepted" | "absent" | "rejected";
  received_at: string | null;
  read_at: string | null;
  captured_at: string | null;
  read_provenance: EvidenceAcquisition["read_provenance"] | null;
  capture_provenance: "snapshot_assembly" | null;
  first_seen_at: null;
  known_at: null;
  issues: AcquisitionIssue[];
};

/**
 * Validate a proposed acquisition annotation in its evidence/snapshot clock context.
 * `accepted` means contract-consistent, NOT independently verified or point-in-time safe.
 * Missing metadata remains absent; malformed metadata is rejected, never repaired.
 * Date/period observations compare calendar days only, never a fabricated release instant.
 *
 * No default clock, provider I/O, expiry extension, freshness upgrade or first-seen inference.
 */
export function reviewEvidenceAcquisition(raw: unknown, context: EvidenceAcquisitionContext): EvidenceAcquisitionReview {
  const empty: EvidenceAcquisitionReview = {
    status: "rejected", received_at: null, read_at: null, captured_at: null,
    read_provenance: null, capture_provenance: null,
    first_seen_at: null, known_at: null, issues: [],
  };
  const parsedContext = ContextSchema.safeParse(context);
  if (!parsedContext.success) return { ...empty, issues: ["invalid_context"] };
  const c = parsedContext.data;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(c.observed_at);
  const observed = Date.parse(c.observed_at);
  const observationOK = Number.isFinite(observed) && (c.time_precision === "instant"
    ? instant.safeParse(c.observed_at).success
    : dateOnly && new Date(observed).toISOString().slice(0, 10) === c.observed_at);
  if (!observationOK) return { ...empty, issues: ["invalid_observation_time"] };
  // For date/period precision this establishes day order only, not within-day availability.
  const observationAfter = (ms: number) => c.time_precision === "instant"
    ? observed > ms : c.observed_at > new Date(ms).toISOString().slice(0, 10);
  const issues: AcquisitionIssue[] = [];
  const capture = Date.parse(c.captured_at);
  if (capture > c.now) issues.push("future_capture");
  if (observationAfter(c.now)) issues.push("future_observation");
  if (observationAfter(capture)) issues.push("observation_after_capture");
  const captured = { ...empty, captured_at: c.captured_at, capture_provenance: "snapshot_assembly" as const };
  // Undefined is the sole backwards-compatible absent form; null/malformed are explicit errors.
  if (raw === undefined) {
    return { ...captured, status: issues.length ? "rejected" : "absent", issues };
  }
  const parsed = EvidenceAcquisitionSchema.safeParse(raw);
  if (!parsed.success) return { ...captured, issues: [...issues, "invalid_acquisition"] };
  const a = parsed.data, read = Date.parse(a.read_at);
  if (read > c.now) issues.push("future_read");
  if (read > capture) issues.push("read_after_capture");
  if (observationAfter(read)) issues.push("observation_after_read");
  if (a.read_provenance === "brief_read_cache" && observationAfter(Date.parse(a.adapter_read_at))) {
    issues.push("observation_after_read");
  }
  if (a.received_at !== null) {
    const receipt = Date.parse(a.received_at);
    if (receipt > c.now) issues.push("future_receipt");
    if (observationAfter(receipt)) issues.push("observation_after_receipt");
  }
  if (issues.length) return { ...captured, issues };
  return {
    ...captured, status: "accepted", received_at: a.received_at, read_at: a.read_at,
    read_provenance: a.read_provenance, issues,
  };
}
