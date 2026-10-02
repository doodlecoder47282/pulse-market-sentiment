import type { Express } from "express";
import { LedgerReadRequestSchema } from "../shared/evidenceLedger";
import type { EvidenceLedger } from "./evidenceLedger";

/** Receipt-scoped retrieval only. No archive listing, arbitrary writes or AI actions. */
export function registerEvidenceLedgerRoutes(app: Express, getLedger: () => EvidenceLedger) {
  let windowAt = Date.now(), count = 0;
  app.post("/api/trade-brief/history/read", (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    if (Date.now() - windowAt >= 60_000) { windowAt = Date.now(); count = 0; }
    if (++count > 30) return res.status(429).json({ message: "History request budget reached. Retry manually later." });
    const request = LedgerReadRequestSchema.safeParse(req.body);
    if (!request.success) return res.status(400).json({ message: "A valid record receipt is required." });
    try {
      const record = getLedger().readWithReceipt(request.data.record_id, request.data.read_token);
      if (!record) return res.status(404).json({ message: "Record unavailable for this receipt or outside retention." });
      return res.json(record);
    } catch {
      return res.status(503).json({ message: "Archive could not be verified. No historical data was substituted." });
    }
  });
}
