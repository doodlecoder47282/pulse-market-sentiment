// server/particleFilterDFI.ts
//
// Tier 3 experiment #4 — Particle filter on the DFI signal.
//
// Brier-gated: this module is a pure shadow forecaster. It runs alongside
// the existing scenario probability calc, never replaces it. Once 30 days
// of paired (existing prob, particle prob) data exists, the cusumWatchdog
// determines whether the particle filter beats the existing model. If it
// does, the operator can promote it manually; if not, it stays a shadow.
//
// State: x_t = "true" DFI signal (latent) — assumed to follow a slow-mean-
// reverting AR(1) with state noise.
// Observation: y_t = noisy DFI (what the existing model emits today)
//
// Posterior over x_t → fold into a forward-looking 1-day return prediction
// via a learned slope. We start with a simple linear map y_pred = β·x.
//
// This is intentionally tiny (default 200 particles) so the cost is trivial
// and runs on every snapshot.

export type Particle = { state: number; weight: number };

export type FilterStep = {
  posteriorMean: number;
  posteriorStd: number;
  ess: number; // effective sample size; low ESS triggers resampling
};

/**
 * Initialize a particle cloud uniformly distributed on a sensible DFI range.
 */
export function initParticles(n: number = 200): Particle[] {
  const ps: Particle[] = [];
  for (let i = 0; i < n; i++) {
    // DFI is normalized to [-5, +5]-ish in this codebase
    const state = (Math.random() * 10) - 5;
    ps.push({ state, weight: 1 / n });
  }
  return ps;
}

/**
 * One predict-update step.
 * @param particles  current cloud
 * @param obs        new observed DFI value
 * @param params     model parameters
 */
export function stepFilter(
  particles: Particle[],
  obs: number,
  params: {
    phi: number;        // AR(1) coefficient (0.9 = slow reversion to 0)
    stateStd: number;   // process noise σ
    obsStd: number;     // observation noise σ
  } = { phi: 0.92, stateStd: 0.4, obsStd: 0.6 },
): { particles: Particle[]; step: FilterStep } {
  if (!isFinite(obs)) {
    // pass through unchanged on bad observation
    const { posteriorMean, posteriorStd, ess } = summarize(particles);
    return { particles, step: { posteriorMean, posteriorStd, ess } };
  }

  // ── Predict step: x_t = phi·x_{t-1} + ε
  const predicted: Particle[] = particles.map((p) => ({
    state: params.phi * p.state + params.stateStd * randn(),
    weight: p.weight,
  }));

  // ── Update step: w ∝ p(y | x) under Gaussian observation likelihood
  let wSum = 0;
  for (const p of predicted) {
    const r = obs - p.state;
    const lik = Math.exp(-0.5 * (r * r) / (params.obsStd * params.obsStd));
    p.weight = (p.weight + 1e-12) * lik;
    wSum += p.weight;
  }
  if (wSum > 0) {
    for (const p of predicted) p.weight = p.weight / wSum;
  } else {
    // total degeneracy — reset uniformly
    const w = 1 / predicted.length;
    for (const p of predicted) p.weight = w;
  }

  // ── Effective sample size and resample if needed
  const ess = effectiveSampleSize(predicted);
  let final = predicted;
  if (ess < predicted.length / 2) {
    final = systematicResample(predicted);
  }

  const { posteriorMean, posteriorStd } = summarize(final);
  return {
    particles: final,
    step: { posteriorMean, posteriorStd, ess },
  };
}

/**
 * Translate the posterior over latent DFI into a 1-day directional probability.
 * Uses a simple sigmoid mapping: P(up) = 1 / (1 + exp(-β·x̂))
 * where β is a learned scaling — kept conservative at 0.4 to avoid
 * overconfidence on noisy latent states.
 */
export function directionalProbFromPosterior(
  posteriorMean: number,
  beta: number = 0.4,
): { pUp: number; pDown: number; pBase: number } {
  const z = beta * posteriorMean;
  const pUp = 1 / (1 + Math.exp(-z));
  const pDown = 1 - pUp;
  // Base scenario shrinks as confidence grows; we cap at 33% to avoid
  // stamping out the middle band entirely.
  const conviction = Math.abs(pUp - 0.5) * 2; // 0..1
  const pBase = 0.33 * (1 - conviction);
  // Renormalize so total = 1
  const remaining = 1 - pBase;
  const pUpAdj = remaining * pUp;
  const pDownAdj = remaining * pDown;
  return { pUp: pUpAdj, pDown: pDownAdj, pBase };
}

// ─── helpers ────────────────────────────────────────────────────────────────
function summarize(ps: Particle[]): {
  posteriorMean: number;
  posteriorStd: number;
  ess: number;
} {
  let m = 0, w = 0;
  for (const p of ps) { m += p.state * p.weight; w += p.weight; }
  if (w > 0) m = m / w; else m = 0;
  let v = 0;
  for (const p of ps) v += p.weight * (p.state - m) * (p.state - m);
  if (w > 0) v = v / w;
  return {
    posteriorMean: m,
    posteriorStd: Math.sqrt(Math.max(0, v)),
    ess: effectiveSampleSize(ps),
  };
}

function effectiveSampleSize(ps: Particle[]): number {
  let s = 0;
  for (const p of ps) s += p.weight * p.weight;
  return s > 0 ? 1 / s : 0;
}

function systematicResample(ps: Particle[]): Particle[] {
  const N = ps.length;
  const out: Particle[] = [];
  const u0 = Math.random() / N;
  let c = ps[0].weight;
  let i = 0;
  for (let j = 0; j < N; j++) {
    const u = u0 + j / N;
    while (c < u && i < N - 1) {
      i++;
      c += ps[i].weight;
    }
    out.push({ state: ps[i].state, weight: 1 / N });
  }
  return out;
}

// Box-Muller standard normal
function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
