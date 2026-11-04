import type { Request, Response } from "express";
import { SPY_PROJECTION_GUARD_VERSION, SpyProjectionResponseSchema,
  type SpyProjectionResponse, type VerifiedSpyCandle } from "../shared/spyProjection";
import { type SpyRawInputs, blockedSpyFeatures } from "../shared/spyFeatures";
import { buildSpyFeatureRun, readSpyFeatureInputs, archiveSpyFeatureRun, type SpyFeatureRun } from "./spyFeaturePipeline";

const TTL = 30_000, MINUTE = 60_000;
const iso = (n: number) => new Date(n).toISOString();
function unavailableRun(): SpyFeatureRun {
  return { input: null, quote: null, outsideSession: false,
    features: blockedSpyFeatures("Bounded provider read unavailable or timed out. No substitute values.") };
}
function responseFromRun(run: SpyFeatureRun, now: number): SpyProjectionResponse {
  const { input, quote, features } = run;
  const candles: VerifiedSpyCandle[] = [];
  if (input && quote && features.status !== "BLOCKED") {
    // Display only full five-minute groups derived from the SAME verified 1m input.
    for (let i = 0; i + 5 <= input.bars.length; i += 5) {
      const b = input.bars.slice(i, i + 5);
      candles.push({ t: b[0].start / 1000, o: b[0].open, h: Math.max(...b.map(x => x.high)),
        l: Math.min(...b.map(x => x.low)), c: b[4].close,
        v: b.every(x => x.volume !== null) ? b.reduce((sum, x) => sum + x.volume!, 0) : null });
    }
  }
  const usable = candles.length >= 3 && !!input && !!quote;
  const expiry = Math.min(now + TTL, quote ? quote.time + MINUTE : Infinity, input ? input.asOf + MINUTE : Infinity);
  return SpyProjectionResponseSchema.parse({
    ok: true, version: SPY_PROJECTION_GUARD_VERSION, symbol: "SPY", currency: "USD", synthetic: false,
    asOf: iso(now), expiresAt: iso(expiry), status: "UNAVAILABLE",
    projection: { status: "UNAVAILABLE", bands: null }, levels: null, features,
    tape: {
      status: usable ? "available" : run.outsideSession ? "outside_session" : input ? "missing" : "unavailable",
      reason: usable ? "Completed SPY one-minute observations passed exact-identity, session, quote-age and no-gap checks. Five-minute display bars use those same inputs; halt status is unverified."
        : input ? "Warmup: at least 15 completed minutes are required for the observational five-minute display."
        : features.issues.join(" "),
      source: "Schwab", observedAt: usable ? iso((candles.at(-1)!.t + 300) * 1000) : null,
      lastTradeAt: usable ? iso(quote!.time) : null, lastTrade: usable ? quote!.price : null,
      candles: usable ? candles : [], sessionCalendarVerified: !!input,
    },
    blockers: [
      "Forecast remains disabled. The new SPY-only contract is deliberately incompatible with legacy SPX/synthetic feature names and stored models.",
      "No model has been trained and forward-validated on the repaired real-observation contract. READY features do not mean a prediction is approved.",
      "Native-SPY options/level provenance, halt feed, corporate-action treatment and point-in-time training data remain separate gates. No fixed SPX divisor or guessed dealer levels.",
    ],
    requirements: [
      "Collect versioned real SPY snapshots with explicit missingness and provider timestamps; resolve any feature-level gaps.",
      "Use the shared live/replay function for training rows; no synthetic backfill, future-bar leakage or legacy-model substitution.",
      "Add timestamped native-SPY options inputs only under a reviewed unit/expiry contract if the declared model needs them.",
      "Evaluate chronological holdouts and forward results against simple baselines before restoring any directional forecast or confidence language.",
    ],
    predictionValidation: "not_established",
  });
}
export function buildSpyProjectionResponse(raw: SpyRawInputs | null, now: number): SpyProjectionResponse {
  return responseFromRun(raw ? buildSpyFeatureRun(raw, now) : unavailableRun(), now);
}
export interface SpyProjectionDependencies {
  read: () => Promise<SpyRawInputs>;
  archive?: (run: SpyFeatureRun) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}
const defaults: SpyProjectionDependencies = { read: readSpyFeatureInputs, archive: archiveSpyFeatureRun };
export function createSpyProjectionService(deps: SpyProjectionDependencies = defaults) {
  const now = deps.now ?? Date.now;
  let cached: SpyProjectionResponse | null = null, pending: Promise<SpyProjectionResponse> | null = null;
  let readPending: Promise<SpyRawInputs | null> | null = null;
  async function get(): Promise<SpyProjectionResponse> {
    if (cached && now() < Date.parse(cached.expiresAt)) return cached;
    if (pending) return pending;
    if (!readPending) {
      const read = Promise.resolve().then(deps.read).catch(() => null);
      readPending = read;
      // Existing provider helper cannot be canceled. Keep its slot until settled.
      void read.then(() => { if (readPending === read) readPending = null; });
    }
    const read = readPending;
    pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([read, new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), Math.min(8_000, Math.max(1, deps.timeoutMs ?? 8_000)));
        })]);
        const evaluatedAt = now(), run = result ? buildSpyFeatureRun(result, evaluatedAt) : unavailableRun();
        if (deps.archive && run.input) {
          try { await deps.archive(run); } catch { run.features.archived = false; run.features.archiveReason = "Local archive unavailable."; }
        }
        cached = responseFromRun(run, evaluatedAt);
        return cached;
      } finally { if (timer) clearTimeout(timer); }
    })();
    try { return await pending; } finally { pending = null; }
  }
  return { get };
}
const service = createSpyProjectionService();
export async function spyProjectionRoute(req: Request, res: Response): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (Object.keys(req.query).length) { res.status(400).json({ error: "spy_projection_accepts_no_query_parameters" }); return; }
  try { res.json(await service.get()); }
  catch { res.status(503).json({ error: "spy_projection_unavailable" }); }
}
