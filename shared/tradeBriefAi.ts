import { z } from "zod";

export const AiBriefRequestSchema = z.object({ snapshot_id: z.string().min(1).max(100) }).strict();
export const AiSelectionSchema = z.object({
  lead_claim_id: z.string().max(40),
  supporting_claim_ids: z.array(z.string().max(40)).max(3),
  caution_ids: z.array(z.string().max(40)).min(1).max(3),
  check_ids: z.array(z.string().max(40)).min(1).max(3),
}).strict();
export const AiCandidateSchema = z.object({
  id: z.string().max(40), text: z.string().max(1600),
  evidence_ids: z.array(z.string().max(100)).max(30),
}).strict();
export const AiCatalogSchema = z.object({
  snapshot_id: z.string().min(1).max(100),
  symbol: z.string().max(12),
  horizon: z.enum(["swing", "intraday"]),
  expires_at: z.string().datetime(),
  claims: z.array(AiCandidateSchema).min(1).max(24),
  cautions: z.array(AiCandidateSchema).min(1).max(12),
  checks: z.array(AiCandidateSchema).min(1).max(12),
}).strict();
export type AiCatalog = z.infer<typeof AiCatalogSchema>;
export type AiSelection = z.infer<typeof AiSelectionSchema>;
export const AiBriefResponseSchema = z.object({
  snapshot_id: z.string(), expires_at: z.string(),
  status: z.enum(["curated", "fallback"]), detail: z.string(),
  model: z.string().nullable(), verdict: z.enum(["WATCH", "INSUFFICIENT DATA"]),
  lead: AiCandidateSchema.nullable(),
  supporting: z.array(AiCandidateSchema).max(3),
  cautions: z.array(AiCandidateSchema).max(3),
  checks: z.array(AiCandidateSchema).max(3),
  limitations: z.array(z.string()),
}).strict();
export type AiBriefResponse = z.infer<typeof AiBriefResponseSchema>;

/** The model can select IDs only. All text is rendered from the server-owned catalog. */
export function validateAiSelection(raw: unknown, catalog: AiCatalog): AiSelection {
  const selected = AiSelectionSchema.parse(raw);
  const assertIds = (ids: string[], allowed: { id: string }[]) => {
    if (new Set(ids).size !== ids.length || ids.some(id => !allowed.some(row => row.id === id))) {
      throw new Error("Unrecognized or repeated selection");
    }
  };
  assertIds([selected.lead_claim_id, ...selected.supporting_claim_ids], catalog.claims);
  assertIds(selected.caution_ids, catalog.cautions);
  assertIds(selected.check_ids, catalog.checks);
  return selected;
}
