import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Global crash logger — structured, no PII. Catches errors that escape React's
// ErrorBoundaries (event handlers, async, third-party scripts) so a stack trace
// always lands in the console with consistent context for faster debugging.
function logGlobalError(kind: "error" | "unhandledrejection", detail: Record<string, unknown>) {
  console.error("[global]", {
    kind,
    ts: new Date().toISOString(),
    path: window.location.hash || window.location.pathname,
    ...detail,
  });
}

window.addEventListener("error", (e) => {
  logGlobalError("error", {
    message: e.message,
    source: e.filename,
    line: e.lineno,
    col: e.colno,
    stack: e.error?.stack ?? null,
  });
});

window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  logGlobalError("unhandledrejection", {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : null,
  });
});

if (!window.location.hash) {
  window.location.hash = "#/";
}

// Stale lazy chunks (deploy replaced hashed assets under a cached index.html)
// — reload once with a cache-buster instead of dying on a dynamic import error.
window.addEventListener("vite:preloadError", (e) => {
  e.preventDefault();
  if (!/(^|[?&])wdbust=/.test(window.location.search)) {
    const loc = window.location;
    const q = loc.search ? loc.search + "&" : "?";
    loc.replace(loc.pathname + q + "wdbust=" + Date.now() + loc.hash);
  }
});

// Signal the index.html boot watchdog that the bundle executed and mounted.
(window as any).__APP_BOOTED__ = true;

createRoot(document.getElementById("root")!).render(<App />);
