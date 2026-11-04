import { Component, useEffect, type ReactNode } from "react";

export function reloadApplication() {
  const url = new URL(window.location.href);
  url.searchParams.set("wdbust", String(Date.now()));
  window.location.replace(url.href);
}

/** Works without the app's providers, icon library, or downloaded stylesheet. */
export function StartupRecovery({
  title = "Loading your terminal",
  detail = "The application is loading. If this screen persists, reload to request the latest version.",
  code = "BC-APP",
  action = reloadApplication,
  actionLabel = "Reload Batcave",
}: {
  title?: string;
  detail?: string;
  code?: string;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="batcave-recovery" data-testid={`startup-${code}`}>
      <section aria-live="polite">
        <span>BATCAVE</span>
        <h1>{title}</h1>
        <p>{detail}</p>
        <button type="button" onClick={action} data-testid={`button-recover-${code}`}>
          {actionLabel}
        </button>
        <small>{code} · Startup recovery</small>
      </section>
    </div>
  );
}

export class StartupBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch() {
    // No response bodies, credentials or provider messages in recovery output.
    console.error("[startup] BC-RENDER: application render failed");
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.fallback ?? (
      <StartupRecovery
        title="Batcave couldn't finish loading"
        detail="An application file or screen failed to load. Reload to request the latest version. If this repeats, share the BC-RENDER code."
        code="BC-RENDER"
      />
    );
  }
}

/** Only a committed React screen (including a recovery screen) clears HTML boot. */
export function ApplicationMounted() {
  useEffect(() => {
    (window as Window & { __APP_BOOTED__?: boolean }).__APP_BOOTED__ = true;
    document.getElementById("batcave-boot")?.setAttribute("hidden", "");
  }, []);
  return null;
}
