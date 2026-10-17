import type { TradeBrief } from "./tradeBrief";
import { reviewEvidenceAcquisition } from "./evidenceAcquisition";
import {
  EVIDENCE_POLICY_VERSION, getSourceContract, reviewEvidence,
  type EvidenceEnvelope, type ResearchIdentity,
} from "./evidencePolicy";

/** Reuses already validated adapter output; cannot manufacture missing upstream timestamps. */
export function tradeBriefEnvelopes(brief: Pick<TradeBrief, "instrument" | "created_at" | "expires_at" | "evidence" | "context_items">) {
  const identity: ResearchIdentity = { kind: "listed", id: brief.instrument.id, symbol: brief.instrument.symbol,
    asset_class: brief.instrument.asset_class, currency: brief.instrument.currency };
  const rows: EvidenceEnvelope[] = [...brief.evidence, ...(brief.context_items ?? [])].map(e => {
    const sourceId = e.source_id ?? "unregistered";
    // Capture is snapshot assembly. A later read/capture never refreshes original receipt.
    const acquisition = reviewEvidenceAcquisition("acquisition" in e ? e.acquisition : undefined, {
      observed_at: e.observed_at, time_precision: e.time_precision,
      captured_at: brief.created_at, now: Date.parse(brief.created_at),
    });
    const acquiredSource = ["schwab.quote", "schwab.history", "schwab.options"].includes(sourceId) && !e.formula_id;
    return {
      schema_version: EVIDENCE_POLICY_VERSION, evidence_id: e.id, research_identity: identity,
      category: e.category, source_id: sourceId, upstream_lineage_id: getSourceContract(sourceId)?.lineage ?? "unknown",
      datum: "value" in e ? e.value : e.text, unit: "unit" in e ? e.unit : "text",
      observed_at: e.observed_at, time_precision: e.time_precision,
      source_time_role: sourceId === "batcave.calculation" ? "derived_input"
        : e.category === "earnings" ? "calendar_checked" : e.category === "news" ? "publication"
        : e.time_precision === "instant" ? "market_observation" : "historical_period",
      captured_at: brief.created_at,
      received_at: acquiredSource && acquisition.status === "accepted" ? acquisition.received_at : null,
      first_seen_at: null, known_at: null,
      expires_at: brief.expires_at, status: e.status, citation_url: e.url,
      formula_id: e.formula_id ?? null, dependency_ids: e.evidence_ids ?? [],
      adjustment_basis: "unverified", correction_of: null,
    };
  });
  return { identity, rows };
}
export function reviewTradeBriefEvidence(brief: Parameters<typeof tradeBriefEnvelopes>[0], now: number) {
  const { identity, rows } = tradeBriefEnvelopes(brief);
  return reviewEvidence(rows, identity, now);
}
