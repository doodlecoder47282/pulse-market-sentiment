/**
 * nativeAuth.ts: Schwab sign-in from inside the iOS app.
 *
 * On the phone the UI is a Capacitor WKWebView, where window.open and
 * target="_blank" are unreliable. The app opens the Schwab login in the
 * system's in-app Safari sheet (@capacitor/browser, SFSafariViewController:
 * shares Safari's cookies and autofill, so a saved Schwab login just works),
 * the server's automatic callback redirects to batcave://schwab?schwab=...
 * (server/schwabOAuth.ts APP_RETURN_URL), iOS hands that URL to the app
 * (@capacitor/app appUrlOpen), the sheet closes, and the dialog refreshes the
 * connection status. No token or secret ever reaches the phone: the code
 * exchange happens on the server, as on the website.
 *
 * The Capacitor plugins are imported lazily so the website bundle never
 * loads them and a missing plugin degrades to the link flow, never to a
 * crash.
 */
import { isNativeApp } from "./queryClient";

export const APP_RETURN_HOST = "schwab";

export type AppReturn = { result: "connected" | "error"; reason: string | null };

/** Parses batcave://schwab?schwab=connected|error&reason=... ; null for any other URL. */
export function parseAppReturn(url: string): AppReturn | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "batcave:") return null;
  // WebKit parses custom schemes without a host; the "host" lands in pathname.
  const host = (u.host || u.pathname.replace(/^\/+/, "").split(/[/?#]/)[0] || "").toLowerCase();
  if (host !== APP_RETURN_HOST) return null;
  const result = u.searchParams.get("schwab");
  if (result !== "connected" && result !== "error") return null;
  return { result, reason: u.searchParams.get("reason") };
}

/** Opens the Schwab login in the in-app Safari sheet. False when the plugin
 *  is unavailable (caller falls back to the link). */
export async function openInAppBrowser(url: string): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url, presentationStyle: "fullscreen" });
    return true;
  } catch {
    return false;
  }
}

export async function closeInAppBrowser(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.close();
  } catch {
    /* already closed or plugin missing */
  }
}

/** Listens for the app being opened by its URL scheme and for the Safari
 *  sheet being dismissed. Returns a cleanup function. */
export function listenForAppReturn(handlers: { onReturn: (r: AppReturn) => void; onSheetClosed: () => void }): () => void {
  if (!isNativeApp()) return () => {};
  const subs: Array<{ remove: () => Promise<void> | void }> = [];
  let active = true;
  void (async () => {
    try {
      const { App } = await import("@capacitor/app");
      const sub = await App.addListener("appUrlOpen", ({ url }: { url: string }) => {
        const r = parseAppReturn(url);
        if (r && active) handlers.onReturn(r);
      });
      if (active) subs.push(sub); else void sub.remove();
    } catch {
      /* plugin missing: the dialog's status polling still picks the result up */
    }
    try {
      const { Browser } = await import("@capacitor/browser");
      const sub = await Browser.addListener("browserFinished", () => { if (active) handlers.onSheetClosed(); });
      if (active) subs.push(sub); else void sub.remove();
    } catch {
      /* plugin missing */
    }
  })();
  return () => {
    active = false;
    for (const s of subs) void s.remove();
  };
}
