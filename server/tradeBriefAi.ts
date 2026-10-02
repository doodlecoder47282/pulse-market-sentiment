import type { Express } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TradeBrief } from "../shared/tradeBrief";
import { tradeBriefExpired } from "../shared/tradeBrief";
import { reviewTradeBriefEvidence } from "../shared/tradeBriefEvidence";
import {
  AiBriefRequestSchema, AiBriefResponseSchema, AiCatalogSchema, validateAiSelection,
  type AiCatalog, type AiBriefResponse,
} from "../shared/tradeBriefAi";

const limitations = [
  "AI selects and orders prewritten evidence; it does not calculate prices, invent facts or change the research verdict.",
  "This is not a forecast, a validated edge, an execution plan or continuously monitored advice.",
];

export function buildAiCatalog(brief: TradeBrief, now = Date.parse(brief.created_at)): AiCatalog {
  // Recompute: never trust a supplied/stored eligibility summary at the model boundary.
  const review = reviewTradeBriefEvidence(brief, now);
  const usable = new Set(review.eligible_ids);
  const claims = brief.claims.filter(c => c.evidence_ids.length > 0
    && c.evidence_ids.every(id => usable.has(id)))
    .slice(0, 24).map((c, i) => ({ id: `claim-${i}`, text: c.text.slice(0, 1600), evidence_ids: c.evidence_ids }));
  return AiCatalogSchema.parse({
    snapshot_id: brief.snapshot_id, symbol: brief.instrument.symbol, horizon: brief.horizon,
    expires_at: brief.expires_at, claims,
    cautions: [...brief.counterevidence, ...brief.coverage_gaps, ...limitations].slice(0, 12)
      .map((text, i) => ({ id: `caution-${i}`, text: text.slice(0, 1600), evidence_ids: [] })),
    checks: (brief.prerequisites.length ? brief.prerequisites : ["Verify event timing and execution prerequisites before defining a trade."])
      .slice(0, 12).map((text, i) => ({ id: `check-${i}`, text: text.slice(0, 1600), evidence_ids: [] })),
  });
}

async function isolatedCurator(catalog: AiCatalog): Promise<unknown> {
  // Only the isolated worker receives model credentials. Legacy app modules cannot use them.
  const token = readFileSync(resolve("data/brief-ai/ipc-key"), "utf8").trim();
  const result = await fetch("http://127.0.0.1:5002/curate", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(catalog), signal: AbortSignal.timeout(11_000),
  });
  if (!result.ok) throw new Error("Curator unavailable or request budget reached");
  return result.json();
}

export function createTradeBriefAiService(
  getSnapshot: (id: string) => TradeBrief | null | undefined,
  curate: (catalog: AiCatalog) => Promise<unknown> = isolatedCurator,
  now = Date.now,
) {
  const cache = new Map<string, { expires: number; response: Promise<AiBriefResponse> }>();
  let active = 0;
  return {
    async analyze(id: string): Promise<AiBriefResponse | null> {
      for (const [key, item] of cache) if (item.expires <= now()) cache.delete(key);
      const brief = getSnapshot(id);
      if (!brief || tradeBriefExpired(brief, now())) return null;
      if (cache.has(id)) return cache.get(id)!.response;
      const fallback = (detail: string): AiBriefResponse => ({
        snapshot_id: id, expires_at: brief.expires_at, status: "fallback", detail,
        model: null, verdict: brief.verdict, lead: null, supporting: [], cautions: [], checks: [], limitations,
      });
      if (active >= 2 || cache.size >= 100) return fallback("Curator is busy. The deterministic evidence remains available.");
      const promise = (async () => {
        active++;
        try {
          const catalog = buildAiCatalog(brief, now());
          const selected = validateAiSelection(await curate(catalog), catalog);
          if (tradeBriefExpired(brief, now())) return fallback("Snapshot expired during curation. Refresh the brief manually.");
          const pick = (rows: AiCatalog["claims"], ids: string[]) => ids.map(id => rows.find(row => row.id === id)!);
          return AiBriefResponseSchema.parse({
            snapshot_id: id, expires_at: brief.expires_at, status: "curated",
            detail: "AI-prioritized, evidence-locked research. Text and values come from the validated snapshot.",
            model: "Claude Sonnet 4.6", verdict: brief.verdict,
            lead: pick(catalog.claims, [selected.lead_claim_id])[0],
            supporting: pick(catalog.claims, selected.supporting_claim_ids),
            cautions: pick(catalog.cautions, selected.caution_ids),
            checks: pick(catalog.checks, selected.check_ids), limitations,
          });
        } catch {
          return fallback("AI curation unavailable, budget-limited or rejected by validation. No generated claims were substituted; use the deterministic brief.");
        } finally { active--; }
      })();
      cache.set(id, { expires: Date.parse(brief.expires_at), response: promise });
      return promise;
    },
  };
}

export function registerTradeBriefAiRoutes(app: Express, getSnapshot: (id: string) => TradeBrief | null | undefined) {
  const service = createTradeBriefAiService(getSnapshot);
  let windowAt = 0, requests = 0;
  app.post("/api/trade-brief/curate", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (Date.now() - windowAt >= 60_000) { windowAt = Date.now(); requests = 0; }
    if (++requests > 60) return res.status(429).json({ message: "Curation request limit reached." });
    const parsed = AiBriefRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "A server-owned snapshot ID is required." });
    const result = await service.analyze(parsed.data.snapshot_id);
    if (!result) return res.status(409).json({ message: "Snapshot expired or superseded. Refresh the brief manually." });
    res.json(result);
  });
}
