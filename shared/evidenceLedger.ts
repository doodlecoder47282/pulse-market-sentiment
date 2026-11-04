import { z } from "zod";

export const LEDGER_VERSION = "evidence-ledger-v1";
export const LEDGER_RETENTION_DAYS = 30;
export const ArchiveReceiptSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("saved"), record_id: z.string().uuid(), stored_at: z.string().datetime(),
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/), read_token: z.string().regex(/^[a-f0-9]{64}$/),
    retention_days: z.literal(LEDGER_RETENTION_DAYS),
  }).strict(),
  z.object({ status: z.literal("unavailable"), detail: z.string().max(300) }).strict(),
]);
export type ArchiveReceipt = z.infer<typeof ArchiveReceiptSchema>;
export const LedgerReadRequestSchema = z.object({
  record_id: z.string().uuid(), read_token: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const ReplayCheckSchema = z.object({
  status: z.enum(["matched", "mismatch", "no_calculations", "unsupported"]),
  checked_count: z.number().int().nonnegative(),
  mismatch_ids: z.array(z.string()), unsupported_ids: z.array(z.string()),
  detail: z.string(),
}).strict();
export const LedgerReadResponseSchema = z.object({
  schema_version: z.literal(LEDGER_VERSION), record_id: z.string().uuid(),
  recorded_at: z.string().datetime(), payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
  integrity: z.literal("checksum_verified"), mode: z.literal("historical_only"),
  actionable: z.literal(false), point_in_time_safe: z.literal(false),
  predecessor_record_id: z.string().uuid().nullable(),
  changes: z.object({
    kind: z.literal("new_capture_not_provider_correction"), changed_ids: z.array(z.string()),
    same_observation_changed_ids: z.array(z.string()),
    calculation_version_changed: z.boolean(),
  }).strict(),
  writer_session: z.object({
    id: z.string().uuid(), opened_at: z.string().datetime(),
    previous_activity_at: z.string().datetime().nullable(),
    continuity: z.enum(["first_session", "unverified_between_writer_sessions"]),
  }).strict(),
  // The separate archive decoder validates the stored snapshot, not the live decoder.
  snapshot: z.unknown(), evidence_count: z.number().int().nonnegative(),
  replay: ReplayCheckSchema, limitations: z.array(z.string()),
}).strict();
export type LedgerReadResponse = z.infer<typeof LedgerReadResponseSchema>;
