import { createRoot } from "react-dom/client";
import App from "./App";
import { ApplicationMounted, StartupBoundary, StartupRecovery } from "./components/StartupBoundary";
import "./index.css";
import "./native.css";

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

// Do not suppress rejected lazy imports: React boundaries must receive them.
// The static HTML fallback covers failures before this module can execute.

const root = createRoot(document.getElementById("root")!);
if ((window as Window & { __APP_STYLE_BLOCKED__?: boolean }).__APP_STYLE_BLOCKED__) {
  root.render(<>
    <StartupRecovery
      title="An application stylesheet didn't load"
      detail="Startup was stopped rather than opening an unstyled, unreliable screen. Reload to try the application files again."
      code="BC-STYLE"
    />
    <ApplicationMounted />
  </>);
} else if (import.meta.env.VITE_NATIVE_BUILD === "true") {
  document.title = "Batcave · iPhone";
  document.documentElement.classList.add("native-app");
  void import("./components/NativeShell").then(({ default: NativeShell }) => {
    root.render(<><StartupBoundary><NativeShell /></StartupBoundary><ApplicationMounted /></>);
  }).catch(() => {
    root.render(<><StartupRecovery title="Batcave couldn't finish loading" code="BC-NATIVE" /><ApplicationMounted /></>);
  });
} else {
  root.render(<><StartupBoundary><App /></StartupBoundary><ApplicationMounted /></>);
}
