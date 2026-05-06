// In-memory cache of the most recent regime prediction.
// Updated by /api/regime/predict route, read by flowAlertEngine.queueHit
// to decorate whale alerts with regime-conditioned conviction (read-only metadata).
//
// This is a pure cache — no DB, no side effects, no network. Stale reads are fine
// (alerts just lose the conviction tag), it never blocks the alert pipeline.

interface RegimeStateSnapshot {
  symbol: string;
  topCandidate: string;
  topProbability: number;
  currentRegime: string | null;
  confidence: number;
  capturedAt: number;
}

let lastSnapshot: RegimeStateSnapshot | null = null;

export function setRegimeSnapshot(snap: RegimeStateSnapshot): void {
  lastSnapshot = snap;
}

export function getRegimeSnapshot(): RegimeStateSnapshot | null {
  if (!lastSnapshot) return null;
  // Stale guard: drop if older than 30 minutes
  if (Date.now() - lastSnapshot.capturedAt > 30 * 60 * 1000) return null;
  return lastSnapshot;
}
