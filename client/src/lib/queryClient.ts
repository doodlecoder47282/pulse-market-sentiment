import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { getNativeSession, nativeRequestTarget } from "./nativeSession";
import { withRequestDeadline } from "./requestDeadline";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
const nativeBuild = import.meta.env.VITE_NATIVE_BUILD === "true";

export async function transportRequest(method: string, path: string, data?: unknown, signal?: AbortSignal): Promise<Response> {
  if (nativeBuild) {
    const session = getNativeSession();
    if (!session) throw new Error("Connect your Batcave server first.");
    if (method !== "GET") throw new Error("This iPhone build is read-only. Use the web terminal for changes.");
    const target = nativeRequestTarget(path, session);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let response: Response;
    try {
      response = await fetch(target.url, {
        method, headers: target.headers, credentials: "omit",
        redirect: "error", cache: "no-store", signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401 || response.status === 503) {
      window.dispatchEvent(new Event("batcave:connection-lost"));
    }
    return response;
  }
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    signal,
  });
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
): Promise<Response> {
  const res = await transportRequest(method, url, data);

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey, signal }) => {
    const path = queryKey.join("/");
    // Bound the web boot-critical read only. Other providers/native remain
    // unchanged, and a body that stalls after HTTP headers is also bounded.
    if (!nativeBuild && path === "/api/snapshot") {
      return withRequestDeadline(async (requestSignal) => {
        const res = await transportRequest("GET", path, undefined, requestSignal);
        if (unauthorizedBehavior === "returnNull" && res.status === 401) return null;
        if (!res.ok) throw new Error(`The data service is unavailable (HTTP ${res.status}). Try again.`);
        return await res.json();
      }, signal);
    }
    const res = await transportRequest("GET", path);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
