/** Bound the entire operation, including response-body decoding. Never retry a write. */
export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 25_000,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Request timed out. Check status before retrying.")), timeoutMs);
  let onAbort: () => void = () => {};
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason ?? new Error("Request cancelled."));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([
      aborted,
      controller.signal.aborted ? aborted : operation(controller.signal),
    ]);
  } finally {
    clearTimeout(timeout);
    parent?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
