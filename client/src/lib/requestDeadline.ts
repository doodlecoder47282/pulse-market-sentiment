/** Covers connection AND body parsing. Aborts the transport on timeout/cancel. */
export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new Error("Request cancelled."));
      controller.abort();
    };
    if (parentSignal?.aborted) { onAbort(); return; }
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      reject(new Error("The data service did not respond within 15 seconds. Try again."));
      controller.abort();
    }, timeoutMs);
  });
  try {
    // Cancellation before invocation must not start another network request.
    return await Promise.race([
      deadline,
      controller.signal.aborted ? deadline : operation(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) parentSignal?.removeEventListener("abort", onAbort);
  }
}
