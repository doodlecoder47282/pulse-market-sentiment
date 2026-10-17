// shared/waitFor.ts
//
// Wait for a shared promise with a bounded patience. The promise itself is
// not cancelled (other waiters, or the next request, may still want its
// result); only this waiter gives up. Pure: no timers are left behind once
// the promise settles or the wait ends.

export class WaitTimeoutError extends Error {
  readonly waitedMs: number;
  constructor(what: string, waitedMs: number) {
    super(`${what} still running after ${Math.round(waitedMs / 1000)} s`);
    this.name = "WaitTimeoutError";
    this.waitedMs = waitedMs;
  }
}

/**
 * Resolves or rejects with `p` when it settles within `ms`; otherwise rejects
 * with WaitTimeoutError. `p` keeps running either way.
 */
export function waitFor<T>(p: Promise<T>, ms: number, what = "operation"): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return p;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const gaveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WaitTimeoutError(what, ms)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, gaveUp]).finally(() => { if (timer) clearTimeout(timer); }) as Promise<T>;
}
