import { useEffect, useState } from "react";
import {
  ACCESS_KEY_STORAGE_KEY,
  API_BASE_STORAGE_KEY,
  AUTH_REQUIRED_EVENT,
  getApiBase,
  isNativeApp,
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

type Mode = "hidden" | "setup" | "key" | "unreachable" | "locked";

interface Health {
  ok: boolean;
  authRequired: boolean;
  /** Server refuses /api until BATCAVE_ACCESS_KEY is configured on it. */
  locked: boolean;
}


async function probe(base: string, key?: string): Promise<Health | "unreachable" | "no-health"> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/health`, {
      headers: key ? { "x-batcave-key": key } : {},
      cache: "no-store",
    });
    if (res.status === 404) return "no-health";
    if (!res.ok) return "unreachable";
    const body = await res.json();
    return { ok: !!body?.ok, authRequired: !!body?.authRequired, locked: !!body?.locked };
  } catch {
    return "unreachable";
  }
}

async function checkKey(base: string, key: string): Promise<boolean> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/health/auth`, {
      headers: { "x-batcave-key": key },
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

function read(key: string): string {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function write(key: string, value: string) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable: settings apply to this session only */
  }
}

export default function ConnectionGate() {
  const native = isNativeApp();
  const [mode, setMode] = useState<Mode>("hidden");
  const [server, setServer] = useState(read(API_BASE_STORAGE_KEY) || getApiBase());
  const [accessKey, setAccessKey] = useState(read(ACCESS_KEY_STORAGE_KEY));
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const base = getApiBase();
    if (native && !base) {
      setMode("setup");
      return;
    }
    probe(base, read(ACCESS_KEY_STORAGE_KEY)).then((h) => {
      if (cancelled) return;
      if (h === "unreachable") {
        // On the web the page itself came from the server, so a failed probe is
        // a transient server issue the dashboard already surfaces. On iOS it
        // usually means the saved server URL is wrong or the server is down.
        if (native) setMode("unreachable");
        return;
      }
      if (h === "no-health") return; // older server without the health route
      if (h.locked) { setMode("locked"); return; }
      if (h.authRequired && !read(ACCESS_KEY_STORAGE_KEY)) setMode("key");
    });
    const onAuth = () => {
      setStatus("The server rejected the access key. Enter the current key.");
      setMode("key");
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuth);
    return () => {
      cancelled = true;
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuth);
    };
  }, [native]);

  if (mode === "hidden") return null;

  const showServer = native || mode === "unreachable";

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
      if (!(await checkKey(base, accessKey.trim()))) {
        setStatus("Access key rejected.");
        setBusy(false);
        return;
      }
    }
    if (showServer) write(API_BASE_STORAGE_KEY, base);
    write(ACCESS_KEY_STORAGE_KEY, accessKey.trim());
    setStatus("Connected. Loading...");
    window.location.reload();
  };

  const title =
    mode === "setup"
      ? "Connect to your Batcave server"
      : mode === "unreachable"
        ? "Batcave server not reachable"
        : mode === "locked"
          ? "Server locked: no access key configured"
          : "Access key required";

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/95 p-4 font-sans">
      <div className="w-full max-w-sm rounded-lg border border-yellow-500/30 bg-zinc-950 p-5 text-zinc-100 shadow-2xl">
        <div className="mb-1 text-2xl tracking-wider text-yellow-400" style={{ fontFamily: "'Bebas Neue', Impact, sans-serif" }}>BATCAVE</div>
        <h2 className="mb-3 text-base font-semibold">{title}</h2>
        <p className="mb-4 text-xs leading-relaxed text-zinc-400">
          {mode === "locked"
            ? "This server is reachable from the network but has no BATCAVE_ACCESS_KEY, so it refuses data requests. Set BATCAVE_ACCESS_KEY on the server (or BATCAVE_ALLOW_OPEN=1 to run it open on purpose), restart it, then reload."
            : showServer
              ? "The app runs its data engine on your hosted server. Enter that server's address, for example https://your-app.up.railway.app."
              : "This server is protected. Enter the access key set as BATCAVE_ACCESS_KEY on the server."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void save();
          }}
          className="space-y-3"
        >
          {showServer && (
            <label className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">Server URL</span>
              <input
                type="url"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="https://your-app.up.railway.app"
                className="w-full rounded border border-zinc-700 bg-black px-3 py-2 font-mono text-sm outline-none focus:border-yellow-500"
                data-testid="gate-server-url"
              />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
              Access key {mode === "key" ? "" : "(if the server uses one)"}
            </span>
            <input
              type="password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
              className="w-full rounded border border-zinc-700 bg-black px-3 py-2 font-mono text-sm outline-none focus:border-yellow-500"
              data-testid="gate-access-key"
            />
          </label>
          {status && <p className="text-xs text-zinc-300">{status}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-yellow-400 py-2 text-sm font-semibold text-black disabled:opacity-60"
            data-testid="gate-connect"
          >
            {busy ? "Connecting..." : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}
