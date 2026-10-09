// server/internalApi.ts
//
// In-process calls between engines (finding 11.3). The engines used to call
// their own API over local HTTP (trade environment -> /api/heatseeker, exit
// brain -> /api/quotes and /api/models, Discord cards -> /api/models, ...).
// That path depended on the global fetch override that attaches the access
// key, on the server listening on 127.0.0.1:PORT (it does not when HOST is a
// specific external address), and sent every call through the socket, the
// CORS/gate/logging middleware and a JSON parse.
//
// Now the route handler for each trading-critical endpoint is registered here
// when routes.ts defines it (`internalRoute(path, handler)`), and engines call
// it directly with `callInternal` / `internalJson` / `internalFetch`:
//   - same handler, same caches and in-flight dedup, same status codes and
//     error bodies, so behaviour is identical to the HTTP call;
//   - the body is passed through one JSON round trip, exactly what the wire
//     did (NaN/Infinity -> null, undefined dropped, Dates -> strings) and so
//     callers can never mutate a route's cached object;
//   - timeouts are kept where callers had them (AbortSignal.timeout before);
//   - an allow-listed route that is not registered yet answers 503
//     "internal_route_not_registered" (the old HTTP call failed the same way
//     before the server was listening). Never a silent fallback to HTTP.
//
// Alternative considered: extracting each route body into a plain builder
// function. /api/models (post-processing chain), /api/heatseeker (chain
// acquisition inline) and /api/quotes (snapshot fallback) keep their logic in
// the route body, and other workstreams are changing those bodies; wrapping
// the handler changes only its first and last line and keeps one code path.
// Endpoints whose builder is already a plain function (getOdteSnapshot,
// buildTradeEnvironment) are called directly where the call site allows.
//
// No express import: the request/response objects are minimal structural
// stand-ins covering what the registered handlers use (query, params, body,
// status/json/send/sendStatus/setHeader/end).

export const INTERNAL_ROUTES = [
  "/api/models",
  "/api/heatseeker",
  "/api/quotes",
  "/api/odte-tracker",
] as const;
export type InternalRoutePath = (typeof INTERNAL_ROUTES)[number];

type Handler = (req: any, res: any, next?: (err?: unknown) => void) => unknown;

const registry = new Map<string, Handler>();

/** Registers `handler` for in-process calls and returns it unchanged (for app.get). */
export function internalRoute<H extends Handler>(path: InternalRoutePath, handler: H): H {
  registry.set(path, handler);
  return handler;
}

export function isInternalRoute(pathWithQuery: string): boolean {
  const p = splitPath(pathWithQuery).path;
  return (INTERNAL_ROUTES as readonly string[]).includes(p);
}

export interface InternalResult<T = any> {
  ok: boolean;
  status: number;
  /** JSON body as the HTTP client would have parsed it (null when none). */
  body: T | null;
  /** Set when the call itself failed (timeout, not registered, threw). */
  error?: string;
}

export interface InternalCallOptions {
  timeoutMs?: number;
  method?: string;
  body?: unknown;
}

function splitPath(pathWithQuery: string): { path: string; query: Record<string, string | string[]> } {
  const qi = pathWithQuery.indexOf("?");
  const path = qi >= 0 ? pathWithQuery.slice(0, qi) : pathWithQuery;
  const query: Record<string, string | string[]> = {};
  if (qi >= 0) {
    const sp = new URLSearchParams(pathWithQuery.slice(qi + 1));
    sp.forEach((v, k) => {
      const cur = query[k];
      if (cur === undefined) query[k] = v;
      else query[k] = Array.isArray(cur) ? [...cur, v] : [cur, v];
    });
  }
  return { path, query };
}

function wireCopy(body: unknown): unknown {
  if (body === undefined) return null;
  const s = JSON.stringify(body);
  return s === undefined ? null : JSON.parse(s);
}

/** Runs the registered handler for `pathWithQuery` in-process. Never throws. */
export function callInternal<T = any>(pathWithQuery: string, opts: InternalCallOptions = {}): Promise<InternalResult<T>> {
  const { path, query } = splitPath(pathWithQuery);
  const handler = registry.get(path);
  if (!handler) {
    return Promise.resolve({ ok: false, status: 503, body: { error: "internal_route_not_registered", path } as any, error: "internal_route_not_registered" });
  }
  return new Promise<InternalResult<T>>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: InternalResult<T>) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const res: any = {
      statusCode: 200,
      headersSent: false,
      locals: {},
      status(code: number) { res.statusCode = code; return res; },
      setHeader() { return res; },
      set() { return res; },
      header() { return res; },
      type() { return res; },
      json(b: unknown) {
        res.headersSent = true;
        let body: unknown;
        try { body = wireCopy(b); } catch (e: any) {
          finish({ ok: false, status: 500, body: null, error: `unserializable_body: ${e?.message ?? e}` });
          return res;
        }
        finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: body as T });
        return res;
      },
      send(b: unknown) {
        if (typeof b === "string") {
          let parsed: unknown = b;
          try { parsed = JSON.parse(b); } catch { /* plain text body */ }
          return res.json(parsed);
        }
        return res.json(b);
      },
      sendStatus(code: number) { res.statusCode = code; res.headersSent = true; finish({ ok: code >= 200 && code < 300, status: code, body: null }); return res; },
      end() { res.headersSent = true; finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: null }); return res; },
    };
    const req = {
      method: (opts.method ?? "GET").toUpperCase(),
      path,
      url: pathWithQuery,
      originalUrl: pathWithQuery,
      query,
      params: {},
      body: opts.body,
      headers: {} as Record<string, string>,
      ip: "127.0.0.1",
      get: () => undefined,
      header: () => undefined,
    };
    if (opts.timeoutMs != null && opts.timeoutMs > 0) {
      timer = setTimeout(() => finish({ ok: false, status: 504, body: null, error: "timeout" }), opts.timeoutMs);
    }
    const next = (err?: unknown) => {
      const msg = err instanceof Error ? err.message : err != null ? String(err) : "route_not_handled";
      finish({ ok: false, status: err ? 500 : 404, body: { message: msg } as any, error: msg });
    };
    Promise.resolve()
      .then(() => handler(req, res, next))
      .then(
        () => {
          // An async handler that returned without responding (express would hang the client).
          if (!done) queueMicrotask(() => { if (!done && !timer) finish({ ok: false, status: 500, body: null, error: "no_response" }); });
        },
        (e: any) => finish({ ok: false, status: 500, body: { message: e?.message ?? String(e) } as any, error: e?.message ?? String(e) }),
      );
  });
}

/** Body when the call succeeded (2xx), else null: the `r.ok ? r.json() : null` pattern. */
export async function internalJson<T = any>(pathWithQuery: string, opts: InternalCallOptions = {}): Promise<T | null> {
  const r = await callInternal<T>(pathWithQuery, opts);
  return r.ok ? r.body : null;
}

/**
 * WHATWG Response for call sites that consume a fetch Response (ok, status,
 * json()). A timeout rejects with a TimeoutError, as fetch with
 * AbortSignal.timeout did.
 */
export async function internalFetch(pathWithQuery: string, opts: InternalCallOptions = {}): Promise<Response> {
  const r = await callInternal(pathWithQuery, opts);
  if (r.error === "timeout") {
    const e = new Error(`internal call timed out after ${opts.timeoutMs} ms: ${pathWithQuery}`);
    e.name = "TimeoutError";
    throw e;
  }
  return new Response(r.body === null ? null : JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}

/** Test helper: clears registrations. */
export function _resetInternalRoutes(): void {
  registry.clear();
}
