import { lazy, Suspense, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { createNativeSession, setNativeSession } from "@/lib/nativeSession";

const Terminal = lazy(() => import("@/App"));

export default function NativeShell() {
  const [connected, setConnected] = useState(false);
  const [origin, setOrigin] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState("");
  const form = useForm({ defaultValues: { origin: "", token: "" } });

  function disconnect(message = "") {
    setConnected(false);
    setNativeSession(null);
    void queryClient.cancelQueries();
    queryClient.clear();
    form.setValue("token", "");
    setError(message);
  }

  useEffect(() => {
    const offline = () => setOnline(false);
    const refresh = () => {
      setOnline(navigator.onLine);
      if (!document.hidden && navigator.onLine) void queryClient.invalidateQueries();
    };
    const expired = () => disconnect("Your mobile session is unavailable. Reconnect to continue.");
    window.addEventListener("offline", offline);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("batcave:connection-lost", expired);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("batcave:connection-lost", expired);
    };
  }, []);

  async function connect(values: { origin: string; token: string }) {
    setError("");
    try {
      const session = createNativeSession(values.origin, values.token);
      setNativeSession(session);
      const response = await apiRequest("GET", "/api/health");
      const health = await response.json();
      if (health.service !== "batcave-mobile" || health.version !== 1 || health.mode !== "read-only") {
        throw new Error("This server does not provide the Batcave mobile gateway.");
      }
      setOrigin(session.origin);
      form.setValue("token", "");
      setConnected(true);
    } catch (e) {
      setNativeSession(null);
      setError(e instanceof Error && !/fetch|network|load failed/i.test(e.message)
        ? e.message : "Server unreachable. Check HTTPS, mobile gateway configuration, and your connection.");
    }
  }

  if (connected) return (
    <div className="native-terminal">
      <header className="native-toolbar">
        <div>
          <strong data-testid="native-mode">READ-ONLY</strong>
          <span data-testid="native-network-status">{online ? new URL(origin).hostname : "OFFLINE · data may be stale"}</span>
        </div>
        <Button variant="outline" size="sm" data-testid="button-native-disconnect" onClick={() => disconnect()}>Disconnect</Button>
      </header>
      <Suspense fallback={<p className="p-6" role="status">Opening terminal…</p>}><Terminal /></Suspense>
    </div>
  );

  return (
    <main className="native-connect">
      <section className="native-connect-card" aria-labelledby="native-title">
        <svg role="img" aria-label="Batcave" viewBox="0 0 64 48" className="native-mark">
          <path fill="currentColor" d="M3 12 18 17 25 5 32 17 39 5 46 17 61 12 53 32 40 32 32 43 24 32 11 32Z"/>
        </svg>
        <p className="native-eyebrow">BATCAVE / iPHONE</p>
        <h1 id="native-title">Your terminal.<br />Same intelligence.</h1>
        <p className="native-copy">Connect to your secured Batcave backend. Market engines stay on the server; no brokerage credentials belong on this phone.</p>
        <div className="native-status" data-testid="native-setup-status">SETUP REQUIRED · READ-ONLY BUILD</div>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(connect)} className="space-y-5">
            <FormField control={form.control} name="origin" rules={{ required: "Enter your backend origin." }}
              render={({ field }) => <FormItem><FormLabel>Backend HTTPS origin</FormLabel><FormControl>
                <Input {...field} data-testid="input-native-origin" placeholder="https://your-batcave-server.com" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}/>
              </FormControl><FormMessage/></FormItem>}/>
            <FormField control={form.control} name="token" rules={{ required: "Enter your mobile access token." }}
              render={({ field }) => <FormItem><FormLabel>Mobile access token</FormLabel><FormControl>
                <Input {...field} data-testid="input-native-token" type="password" placeholder="Separate from your Schwab credentials" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}/>
              </FormControl><FormMessage/></FormItem>}/>
            {error && <p role="alert" className="native-error" data-testid="native-connection-error">{error}</p>}
            <Button type="submit" className="w-full min-h-12" data-testid="button-native-connect" disabled={form.formState.isSubmitting || !online}>
              {form.formState.isSubmitting ? "Checking secure connection…" : online ? "Connect terminal" : "Offline · connect to the internet"}
            </Button>
          </form>
        </Form>
        <p className="native-note">Session-only access. The token is held in memory and cleared when you disconnect or restart. No live data is loaded until the server authenticates you.</p>
        <p className="native-note">Personal prototype only. Do not connect other users’ brokerage accounts. Trading, account linking, and saved changes are disabled in this build.</p>
      </section>
    </main>
  );
}
