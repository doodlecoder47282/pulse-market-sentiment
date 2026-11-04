import type { summarizeSocialPosts } from "./cryptoDesk";

export const SOCIAL_EVIDENCE_VERSION = "social-attribution-2026-10-01.1";
export type SocialLane = ReturnType<typeof summarizeSocialPosts> & {
  returnedPosts: number; query: string; previous10m: number;
};
export interface SocialTokenEvidence {
  version: string; sampledAt: number; windowStart: number; windowEnd: number;
  contract: SocialLane; ticker: SocialLane | null; tickerReason: string;
  queryGap: boolean;
  receipts: { url: string; at: number; match: "contract" | "ticker"; excerpt: string }[];
  pace: {
    current10m: number; previous10m: number; delta: number | null; ratio: number | null;
    state: "sampled" | "insufficient"; reason: string;
  };
}

/** Read-time expiry also protects clients holding a cached response. */
export function socialEvidenceFresh(e: SocialTokenEvidence | null | undefined, now: number) {
  return !!e && e.version === SOCIAL_EVIDENCE_VERSION && Number.isFinite(e.sampledAt) &&
    now >= e.sampledAt && now - e.sampledAt <= 600_000;
}
