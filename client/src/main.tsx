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

createRoot(document.getElementById("root")!).render(<App />);
