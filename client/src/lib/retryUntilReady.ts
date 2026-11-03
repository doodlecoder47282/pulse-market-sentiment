// Panels that refresh every 15-30 min must not sit on a failed read that long:
// a Schwab read refused during a startup burst would otherwise leave "not
// built" up for half an hour. While the last read errored or the payload says
// it is not ready, poll every RETRY_MS; once ready, back to the normal cadence.
import type { Query } from "@tanstack/react-query";

export const NOT_READY_RETRY_MS = 30_000;

export function refetchUntilReady<T>(normalMs: number, notReady?: (data: T) => boolean) {
  return (query: Query<T, any, any, any>): number => {
    const { status, data } = query.state;
    if (status === "error") return NOT_READY_RETRY_MS;
    if (data !== undefined && notReady?.(data)) return NOT_READY_RETRY_MS;
    return normalMs;
  };
}
