import { z } from "zod";
import { SpyFeaturesSchema } from "./spyFeatures";

export const SPY_PROJECTION_GUARD_VERSION = "spy-projection-guard-2026-09-30.2";
const Price = z.number().finite().positive();
export const VerifiedSpyCandleSchema = z.object({
  t: z.number().int().positive(), o: Price, h: Price, l: Price, c: Price,
  v: z.number().finite().nonnegative().nullable(),
}).strict().refine(c => c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c) && c.h >= c.l, "Invalid OHLC ordering");
export type VerifiedSpyCandle = z.infer<typeof VerifiedSpyCandleSchema>;
export const SpyProjectionResponseSchema = z.object({
  ok: z.literal(true), version: z.literal(SPY_PROJECTION_GUARD_VERSION),
  symbol: z.literal("SPY"), currency: z.literal("USD"), synthetic: z.literal(false),
  asOf: z.string().datetime(), expiresAt: z.string().datetime(),
  status: z.literal("UNAVAILABLE"),
  projection: z.object({ status: z.literal("UNAVAILABLE"), bands: z.null() }).strict(),
  levels: z.null(),
  features: SpyFeaturesSchema,
  tape: z.object({
    status: z.enum(["available", "missing", "stale", "unavailable", "outside_session", "invalid"]),
    reason: z.string(), source: z.literal("Schwab"),
    observedAt: z.string().datetime().nullable(),
    lastTradeAt: z.string().datetime().nullable(), lastTrade: Price.nullable(),
    candles: z.array(VerifiedSpyCandleSchema).max(78),
    sessionCalendarVerified: z.boolean(),
  }).strict(),
  blockers: z.array(z.string()), requirements: z.array(z.string()),
  predictionValidation: z.literal("not_established"),
}).strict().superRefine((r, ctx) => {
  if (r.tape.status !== "available" && (r.tape.candles.length || r.tape.lastTrade !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unusable tape cannot carry displayed price data" });
  }
  if (r.tape.status === "available" && (!r.tape.candles.length || !r.tape.lastTradeAt || !r.tape.observedAt || !r.tape.lastTrade || !r.tape.sessionCalendarVerified)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Available tape requires observed provenance" });
  }
});
export type SpyProjectionResponse = z.infer<typeof SpyProjectionResponseSchema>;
