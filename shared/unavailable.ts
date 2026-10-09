// shared/unavailable.ts
//
// One contract for "the upstream could not answer" (user rule 1: Schwab only;
// when Schwab cannot answer the output is unavailable with a reason, never
// older or delayed data). Pure: no DB, no network, no React, so the server
// routes and the client panels share it and it is unit-tested on plain Node.
//
// HTTP contract (RFC 9110 section 15.6.4, "503 Service Unavailable": the
// server is currently unable to handle the request due to a temporary
// overload or scheduled maintenance, which will likely be alleviated after
// some delay; https://www.rfc-editor.org/rfc/rfc9110#name-503-service-unavailable):
//   - upstream missing (Schwab not connected, empty quotes/candles/chain):
//       503 { dataState: "unavailable", reason, source, message }
//   - partial (some Schwab sections missing, context sections present):
//       200 { dataState: "partial", dataStateReason, sections: {...} }
//   - a real bug (TypeError, bad state): 500 { message }
// A missing upstream is never a 500 and never a 200 with zeros.

export type UpstreamSource = "schwab";

/** Thrown by builders when an upstream (Schwab) could not answer. `partial`
 *  carries whatever non-Schwab context the builder still assembled. */
export class UpstreamUnavailableError extends Error {
  readonly dataState = "unavailable" as const;
  readonly upstream: UpstreamSource;
  readonly reason: string;
  readonly partial?: unknown;
  constructor(reason: string, opts: { upstream?: UpstreamSource; partial?: unknown } = {}) {
    super(reason);
    this.name = "UpstreamUnavailableError";
    this.reason = reason;
    this.upstream = opts.upstream ?? "schwab";
    if (opts.partial !== undefined) this.partial = opts.partial;
  }
}

/** True for an UpstreamUnavailableError, also across module instances
 *  (dynamic imports can load a second copy of a module). */
export function isUpstreamUnavailable(e: unknown): e is UpstreamUnavailableError {
  if (e instanceof UpstreamUnavailableError) return true;
  const x = e as { name?: unknown; dataState?: unknown; reason?: unknown } | null;
  return !!x && x.name === "UpstreamUnavailableError" && x.dataState === "unavailable" && typeof x.reason === "string";
}

export interface UnavailableBody {
  dataState: "unavailable";
  reason: string;
  source: UpstreamSource;
  /** Same text as reason: older client code prints `message`. */
  message: string;
}

export function unavailableBody(reason: string, source: UpstreamSource = "schwab"): UnavailableBody {
  return { dataState: "unavailable", reason, source, message: reason };
}

export interface RouteErrorContext {
  /** Schwab connection state at the time of the error (getSchwabStatus().connected).
   *  false: the route depends on Schwab and Schwab is not connected, so its
   *  failure is the missing upstream, not a code bug. null/undefined: unknown. */
  schwabConnected?: boolean | null;
  /** Body key for the 500 message ("message" or "error"; routes differ). */
  key?: "message" | "error";
}

export type RouteErrorResponse =
  | { status: 503; body: UnavailableBody; kind: "unavailable" }
  | { status: 500; body: Record<string, string>; kind: "bug" };

function messageOf(e: unknown): string | null {
  if (e == null) return null;
  if (typeof e === "string") return e;
  const m = (e as { message?: unknown }).message;
  return typeof m === "string" && m ? m : null;
}

// JS engine errors are code bugs whatever the upstream state is.
const BUG_NAMES = new Set(["TypeError", "ReferenceError", "SyntaxError", "RangeError", "EvalError", "URIError"]);

/**
 * Maps a caught route error to an HTTP status and body.
 *  1. UpstreamUnavailableError -> 503 with its reason.
 *  2. Schwab not connected (ctx.schwabConnected === false) and not an engine
 *     error -> 503 "Schwab not connected: <message>" (the route depends on
 *     Schwab; with no session its failure is the missing upstream).
 *  3. Anything else -> 500 (a real bug), message kept.
 */
export function classifyRouteError(e: unknown, fallback: string, ctx: RouteErrorContext = {}): RouteErrorResponse {
  if (isUpstreamUnavailable(e)) {
    return { status: 503, body: unavailableBody(e.reason, e.upstream), kind: "unavailable" };
  }
  const msg = messageOf(e) ?? fallback;
  const name = (e as { name?: unknown } | null)?.name;
  const isEngineBug = typeof name === "string" && BUG_NAMES.has(name);
  if (ctx.schwabConnected === false && !isEngineBug) {
    return { status: 503, body: unavailableBody(`Schwab not connected: ${msg}`), kind: "unavailable" };
  }
  return { status: 500, body: { [ctx.key ?? "message"]: msg }, kind: "bug" };
}

export interface ParsedUnavailable {
  /** "unavailable" for a 503 with a dataState body; "failed" for any other error. */
  dataState: "unavailable" | "failed";
  reason: string;
  status: number | null;
}

/**
 * Client side: turns a react-query error from apiRequest/getQueryFn
 * ("<status>: <body text>") into a state and reason for DataStateChip.
 * A 503 whose JSON body carries dataState is "unavailable" with its reason;
 * anything else is "failed" (never "ok", never a blank panel).
 */
export function parseUnavailableError(err: unknown): ParsedUnavailable | null {
  if (err == null) return null;
  const raw = messageOf(err) ?? String(err);
  const m = /^(\d{3}):\s*([\s\S]*)$/.exec(raw);
  const status = m ? Number(m[1]) : null;
  const text = m ? m[2] : raw;
  let body: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") body = j as Record<string, unknown>;
  } catch { /* not JSON */ }
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = body?.[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return null;
  };
  const reason = pick("reason", "note", "message", "error") ?? (text.trim() || raw);
  if (status === 503 && body && body.dataState === "unavailable") {
    return { dataState: "unavailable", reason, status };
  }
  return { dataState: "failed", reason, status };
}
