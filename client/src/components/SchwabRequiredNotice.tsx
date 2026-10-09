/**
 * One clear notice at the top of a Schwab-fed tab when Schwab is not
 * connected, with the action that fixes it. Panels below still show their own
 * "unavailable" states; this tells a new user why and what to do.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Status { connected: boolean; needsReauth: boolean }

export default function SchwabRequiredNotice({ onConnect, what }: { onConnect: () => void; what: string }) {
  const { data } = useQuery<Status>({
    queryKey: ["/api/schwab/status"],
    queryFn: async () => (await apiRequest("GET", "/api/schwab/status")).json(),
    refetchInterval: 60_000,
    staleTime: 55_000,
  });
  // Unknown status: say nothing rather than guess.
  if (!data || (data.connected && !data.needsReauth)) return null;
  const reauth = data.connected && data.needsReauth;
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-4 sm:flex-row sm:items-center"
      data-testid="schwab-required-notice"
    >
      <Link2 className="hidden h-5 w-5 shrink-0 text-primary sm:block" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">
          {reauth ? "Reconnect Schwab to refresh this tab" : "Connect Schwab to fill this tab"}
        </div>
        <div className="text-sm text-muted-foreground">
          This tab runs on {what} from your Schwab account. You sign in on Schwab's own page; Batcave never sees your password.
        </div>
      </div>
      <Button onClick={onConnect} className="min-h-[44px] shrink-0" data-testid="button-connect-schwab">
        {reauth ? "Reconnect Schwab" : "Connect Schwab"}
      </Button>
    </div>
  );
}
