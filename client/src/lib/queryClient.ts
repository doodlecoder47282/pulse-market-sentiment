import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { withRequestDeadline } from "@shared/requestDeadline";

// API base resolution, highest priority first:
//   1. Server URL saved on this device (native iOS app setup screen)
//   2. VITE_API_BASE baked in at build time (e.g. the hosted backend URL)
//   3. Preview port token (replaced by the legacy preview host; inert otherwise)
//   4. "" = same origin (normal web deployment, backend serves the UI)
// Private-preview bootstrap is injected into HTML, where the host rewrites
// port placeholders. Keep it out of compiled JS: constant folding broke the
// old token check. Normal Railway/native builds use their existing settings.
const PREVIEW_API_BASE = typeof window === "undefined" ? "" : ((window as any).__BATCAVE_PREVIEW_API_BASE__ as string | undefined) || "";
const BUILD_API_BASE = ((import.meta as any).env?.VITE_API_BASE as string | undefined) || "";

export const API_BASE_STORAGE_KEY = "batcave.apiBase";
export const ACCESS_KEY_STORAGE_KEY = "batcave.accessKey";
export const AUTH_REQUIRED_EVENT = "batcave:auth-required";

// The current connection must still work when browser storage is blocked.
// Never persist a secret anywhere else or log it; this fallback lasts only
// until this page closes/reloads.
const connectionSession = new Map<string, string>();

export function readConnectionSetting(key: string): string {
  if (connectionSession.has(key)) return connectionSession.get(key) || "";
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

export function saveConnectionSettings(base: string, key: string): void {
  for (const [name, value] of [[API_BASE_STORAGE_KEY, base], [ACCESS_KEY_STORAGE_KEY, key]]) {
    connectionSession.set(name, value);
    try {
      if (value) window.localStorage.setItem(name, value);
      else window.localStorage.removeItem(name);
    } catch {
      // Session-only connection; do not reload and lose it.
    }
  }
}

export function isNativeApp(): boolean {
  const cap = (window as any).Capacitor;
  return !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
}

export function getApiBase(): string {
  const base = readConnectionSetting(API_BASE_STORAGE_KEY) || BUILD_API_BASE || PREVIEW_API_BASE;
  if (base.startsWith("__PORT_")) throw new Error("Preview backend was not connected. Reopen the deployed Batcave preview.");
  return base.replace(/\/+$/, "");
}

/** Headers every API call carries: the optional shared access key. */
export function authHeaders(): Record<string, string> {
  const key = readConnectionSetting(ACCESS_KEY_STORAGE_KEY);
  return key ? { "x-batcave-key": key } : {};
}

async function signalIfAuthRequired(res: Response) {
  if (res.status !== 401) return;
  try {
    const body = await res.clone().json();
    if (body?.error === "batcave_auth_required") {
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
    }
  } catch {
    /* not a gate response */
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(`${getApiBase()}${url}`, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
    },
    body: data ? JSON.stringify(data) : undefined,
    credentials: "same-origin",
    signal,
  });
  await signalIfAuthRequired(res);

  await throwIfResNotOk(res);
  return res;
}

/** A bounded JSON read/write. The deadline also covers a stalled response body. */
export function apiJson<T = any>(method: string, url: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  return withRequestDeadline(async boundedSignal => {
    const response = await apiRequest(method, url, data, boundedSignal);
    return response.json() as Promise<T>;
  }, 25_000, signal);
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey, signal }) => withRequestDeadline(async boundedSignal => {
    const res = await fetch(`${getApiBase()}${queryKey.join("/")}`, {
      headers: authHeaders(),
      credentials: "same-origin",
      signal: boundedSignal,
    });
    await signalIfAuthRequired(res);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  }, 25_000, signal);

// networkMode "always": react-query's default pauses every query while
// navigator.onLine is false. WKWebView (the iOS app) reports offline for a
// while after a device or simulator boots and does not always fire "online"
// afterwards, so the dashboard sat on its loading skeleton forever even though
// the connection screen's plain fetch had reached the server (CI runs
// 38224381267 and 38317228098: /api/health answered, nothing else was ever
// requested). Real connectivity failures still surface as fetch errors.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
      networkMode: "always",
    },
    mutations: {
      retry: false,
      networkMode: "always",
    },
  },
});
