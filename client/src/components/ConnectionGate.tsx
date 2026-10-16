import { useEffect, useState, type ReactNode } from "react";
import {
  ACCESS_KEY_STORAGE_KEY,
  API_BASE_STORAGE_KEY,
  AUTH_REQUIRED_EVENT,
  getApiBase,
  isNativeApp,
  queryClient,
  readConnectionSetting,
  saveConnectionSettings,
} from "@/lib/queryClient";
import { serverUrlProblem } from "@/lib/serverUrl";

/**
 * Connection setup for the Batcave client.
 *
 * - iOS app (Capacitor): the UI is bundled on the phone, so it needs the URL of
 *   the hosted Batcave server. Asked once, saved on the device.
 * - Any client: if the server has BATCAVE_ACCESS_KEY set, the key is asked once
 *   and sent as the x-batcave-key header. Brokerage secrets never live here.
 */

type Mode = "checking" | "hidden" | "setup" | "key" | "unreachable" | "locked";

/** Public sample-data demo (BATCAVE_EDITION=demo), baked in at build time. Empty = no demo button. */
export const DEMO_URL = (((import.meta as any).env?.VITE_DEMO_URL as string | undefined) || "").trim().replace(/\/+$/, "");

interface Health {
  ok: boolean;
  authRequired: boolean;
  /** Server refuses /api until BATCAVE_ACCESS_KEY is configured on it. */
  locked: boolean;
}


async function probe(base: string, key?: string): Promise<Health | "unreachable" | "no-health"> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/health`, {
      headers: key ? { "x-batcave-key": key } : {},
      cache: "no-store",
      signal: controller.signal,
    });
    if (res.status === 404) return "no-health";
    if (!res.ok) return "unreachable";
    const body = await res.json();
    if (body?.ok !== true || typeof body?.authRequired !== "boolean" || typeof body?.locked !== "boolean") return "unreachable";
    return { ok: true, authRequired: body.authRequired, locked: body.locked };
  } catch {
    return "unreachable";
  } finally {
    window.clearTimeout(timeout);
  }
}

async function checkKey(base: string, key: string): Promise<"valid" | "rejected" | "unreachable"> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/health/auth`, {
      headers: { "x-batcave-key": key },
      cache: "no-store",
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return "rejected";
    if (!res.ok) return "unreachable";
    const body = await res.json();
    return body?.ok === true ? "valid" : "unreachable";
  } catch {
    return "unreachable";
  } finally {
    window.clearTimeout(timeout);
  }
}

export default function ConnectionGate({ children }: { children: ReactNode }) {
  const native = isNativeApp();
  const [mode, setMode] = useState<Mode>("checking");
  const [server, setServer] = useState(readConnectionSetting(API_BASE_STORAGE_KEY) || getApiBase());
  const [accessKey, setAccessKey] = useState(readConnectionSetting(ACCESS_KEY_STORAGE_KEY));
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const base = getApiBase();
    if (native && !base) {
      setMode("setup");
      return;
    }
    const key = readConnectionSetting(ACCESS_KEY_STORAGE_KEY);
    probe(base).then(async (h) => {
      if (cancelled) return;
      if (h === "unreachable") {
        setMode("unreachable");
        return;
      }
      if (h === "no-health") { setMode("hidden"); return; } // legacy server compatibility
      if (h.locked) { setMode("locked"); return; }
      if (!h.authRequired) { setMode("hidden"); return; }
      if (!key) { setMode("key"); return; }
      const result = await checkKey(base, key);
      if (cancelled) return;
      if (result === "valid") setMode("hidden");
      else if (result === "unreachable") setMode("unreachable");
      else {
        setStatus("The saved access key was rejected. Enter the current key.");
        setMode("key");
      }
    });
    const onAuth = () => {
      cancelled = true; // an older health response must not reopen the dashboard
      setStatus(readConnectionSetting(ACCESS_KEY_STORAGE_KEY)
        ? "The server rejected the access key. Enter the current key."
        : "");
      setMode("key");
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuth);
    return () => {
      cancelled = true;
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuth);
    };
  }, [native]);

  if (mode === "hidden") return <>{children}</>;

  const showServer = native;

  const save = async () => {
    setBusy(true);
    setStatus("Checking connection...");
    const base = (showServer ? server : getApiBase()).trim().replace(/\/+$/, "");
    const urlProblem = showServer ? serverUrlProblem(base) : null;
    if (urlProblem) {
      setStatus(urlProblem);
      setBusy(false);
      return;
    }
    const h = await probe(base, accessKey.trim());
    if (h === "unreachable") {
      setStatus("Server not reachable. Check the URL and that the server is running.");
      setBusy(false);
      return;
    }
    if (h !== "no-health" && h.locked) {
      setStatus("The server has no access key configured and refuses requests. Set BATCAVE_ACCESS_KEY on the server.");
      setBusy(false);
      return;
    }
    if (h !== "no-health" && h.authRequired) {
      if (!accessKey.trim()) {
        setStatus("This server requires an access key.");
        setBusy(false);
        return;
      }
      const result = await checkKey(base, accessKey.trim());
      if (result !== "valid") {
        setStatus(result === "rejected" ? "Access key rejected." : "Connection check failed. Try again; your key has not been rejected.");
        setBusy(false);
        return;
      }
    }
    saveConnectionSettings(base, accessKey.trim());
    queryClient.clear();
    setStatus("");
    setBusy(false);
    setMode("hidden");
  };

  const tryDemo = async () => {
    setBusy(true);
    setStatus("Opening the sample-data demo...");
    const h = await probe(DEMO_URL);
    if (h === "unreachable" || h === "no-health" || h.locked || h.authRequired) {
      setStatus("The demo is not reachable right now. Try again in a minute.");
      setBusy(false);
      return;
    }
    saveConnectionSettings(DEMO_URL, "");
    queryClient.clear();
    setBusy(false);
    setMode("hidden");
  };

  const title =
    mode === "checking"
      ? "Checking your connection"
      : mode === "setup"
      ? "Connect to your Batcave server"
      : mode === "unreachable"
        ? "Batcave server not reachable"
        : mode === "locked"
          ? "Server locked: no access key configured"
          : "Access key required";

  return (
    <div
      className="fixed inset-0 z-[10000] flex flex-col overflow-y-auto bg-black p-4 font-sans"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      data-testid="connection-gate"
    >
      <div className="m-auto w-full max-w-sm shrink-0 rounded-lg border border-yellow-500/30 bg-zinc-950 p-5 text-zinc-100 shadow-2xl">
        <div className="mb-1 text-2xl tracking-wider text-yellow-400" style={{ fontFamily: "'Bebas Neue', Impact, sans-serif" }}>BATCAVE</div>
        <h1 className="mb-3 text-base font-semibold" data-testid="gate-title">{title}</h1>
        <p className="mb-4 text-xs leading-relaxed text-zinc-400">
          {mode === "checking"
            ? "Confirming server access before loading market data."
            : mode === "locked"
            ? "This server has no access key configured and is refusing data requests. The owner must set BATCAVE_ACCESS_KEY on the server, restart it, then retry."
            : mode === "unreachable"
              ? "The connection check did not finish. Check your network and retry. No market data has been loaded."
            : showServer
              ? "Batcave reads the market through your own Batcave server, connected to your Schwab account. Enter its address, for example https://your-app.up.railway.app."
              : "This server is protected. Enter the access key set as BATCAVE_ACCESS_KEY on the server."}
        </p>
        {mode !== "checking" && <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void save();
          }}
          className="space-y-3"
        >
          {showServer && (
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-400">Server URL</span>
              <input
                type="url"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="https://your-app.up.railway.app"
                className="min-h-11 w-full rounded border border-zinc-700 bg-black px-3 py-2 font-mono text-base outline-none focus:border-yellow-500"
                data-testid="gate-server-url"
              />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-400">
              Access key {mode === "key" ? "" : "(if the server uses one)"}
            </span>
            <input
              type="password"
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
              className="min-h-11 w-full rounded border border-zinc-700 bg-black px-3 py-2 font-mono text-base outline-none focus:border-yellow-500"
              data-testid="gate-access-key"
            />
          </label>
          {status && <p role="status" aria-live="polite" className="text-xs text-zinc-300" data-testid="gate-status">{status}</p>}
          <button
            type="submit"
            disabled={busy}
            className="min-h-11 w-full rounded bg-yellow-400 py-2 text-sm font-semibold text-black outline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-yellow-400 disabled:opacity-60"
            data-testid="gate-connect"
          >
            {busy ? "Connecting..." : mode === "unreachable" || mode === "locked" ? "Retry connection" : "Connect"}
          </button>
        </form>}
        {showServer && DEMO_URL && (
          <div className="mt-4 border-t border-zinc-800 pt-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => void tryDemo()}
              className="min-h-11 w-full rounded border border-zinc-600 py-2 text-sm font-semibold text-zinc-100 disabled:opacity-60"
              data-testid="gate-try-demo"
            >
              Try the demo
            </button>
            <p className="mt-2 text-center text-xs text-zinc-400">Sample data from a simulated market. No account needed.</p>
          </div>
        )}
      </div>
    </div>
  );
}
