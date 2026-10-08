import { QueryClient, QueryFunction } from "@tanstack/react-query";

// API base resolution, highest priority first:
//   1. Server URL saved on this device (native iOS app setup screen)
//   2. VITE_API_BASE baked in at build time (e.g. the hosted backend URL)
//   3. Preview port token (replaced by the legacy preview host; inert otherwise)
//   4. "" = same origin (normal web deployment, backend serves the UI)
const PORT_TOKEN_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
const BUILD_API_BASE = ((import.meta as any).env?.VITE_API_BASE as string | undefined) || "";

export const API_BASE_STORAGE_KEY = "batcave.apiBase";
export const ACCESS_KEY_STORAGE_KEY = "batcave.accessKey";
export const AUTH_REQUIRED_EVENT = "batcave:auth-required";

function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

export function isNativeApp(): boolean {
  const cap = (window as any).Capacitor;
  return !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
}

export function getApiBase(): string {
  const base = readStored(API_BASE_STORAGE_KEY) || BUILD_API_BASE || PORT_TOKEN_BASE;
  return base.replace(/\/+$/, "");
}

/** Headers every API call carries: the optional shared access key. */
export function authHeaders(): Record<string, string> {
  const key = readStored(ACCESS_KEY_STORAGE_KEY);
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
): Promise<Response> {
  const res = await fetch(`${getApiBase()}${url}`, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  await signalIfAuthRequired(res);

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${getApiBase()}${queryKey.join("/")}`, {
      headers: authHeaders(),
    });
    await signalIfAuthRequired(res);

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
