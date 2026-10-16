import { useState } from "react";
import { personalServerHref } from "@/lib/serverUrl";

/** Open the owner's deployment directly; never weaken CORS for an opaque preview. */
export default function PersonalServerHandoff() {
  // Public origin only, not an API key. Real secrets stay on the selected server.
  const [address, setAddress] = useState((import.meta.env.VITE_PERSONAL_SERVER_URL || "").trim());
  const href = personalServerHref(address.trim());
  return (
    <section className="space-y-3 rounded-md border border-border p-4 text-sm text-foreground" data-testid="personal-server-handoff">
      <h3 className="font-semibold">Connect Schwab</h3>
      <p className="text-muted-foreground">Open your protected deployment in a browser, then use Settings → Connect Schwab. Your Schwab password belongs only on Schwab’s sign-in page.</p>
      <label className="block space-y-1">
        <span>Personal server address</span>
        <input type="url" value={address} onChange={event => setAddress(event.target.value)}
          placeholder="https://your-app.up.railway.app" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          className="min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base"
          data-testid="personal-server-address" />
      </label>
      {address && !href && <p role="status" data-testid="personal-server-error">Enter an HTTPS server origin only. Do not paste a callback, access code or secret here.</p>}
      {href ? (
        <a href={`${href}?connect=schwab`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-3 py-2 text-center font-medium text-primary-foreground" data-testid="personal-server-open">
          Connect Schwab on my server
        </a>
      ) : (
        <button disabled className="min-h-11 w-full rounded-md bg-muted px-3 py-2 text-muted-foreground" data-testid="personal-server-open-disabled">Open personal server</button>
      )}
      <p className="text-xs text-muted-foreground">Developer secrets stay on the backend. This opens your server, not a connection to this demo. For embedded-browser problems, copy the address into Safari or Chrome. Previously exposed credentials still need rotation.</p>
    </section>
  );
}
