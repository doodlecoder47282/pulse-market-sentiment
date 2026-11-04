import { z } from "zod";

export const EQUITY_CALENDAR_VERSION = "us-core-schedule-2026-10-02.1";
export const EquityScheduleSchema = z.object({
  version: z.literal(EQUITY_CALENDAR_VERSION),
  timezone: z.literal("America/New_York"),
  coverage_from: z.literal("2026-01-01"), coverage_through: z.literal("2026-12-31"),
  reviewed_at: z.string().datetime(), source_urls: z.array(z.string().url()).length(2),
  coverage: z.enum(["covered", "unsupported"]),
  session_date: z.string(), day_type: z.enum(["regular", "early_close", "holiday", "weekend", "unknown"]),
  phase: z.enum(["before_core", "core_window", "after_core", "closed", "unknown"]),
  open_at: z.string().datetime().nullable(), close_at: z.string().datetime().nullable(),
  session_minutes: z.number().int().positive().nullable(), holiday: z.string().nullable(),
  next_boundary_at: z.string().datetime(),
  live_status_verified: z.literal(false), point_in_time_safe: z.literal(false),
}).strict();
export type EquitySchedule = z.infer<typeof EquityScheduleSchema>;
