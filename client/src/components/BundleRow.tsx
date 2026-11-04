// Launch-buying line for a coin card. Neutral styling on purpose: the desk has
// not graded whether launch-block buying separates outcomes, so no color says
// good or bad. Unread is amber with its reason; never shown as 0%.
import { Layers } from "lucide-react";
import { bundleLine, type CardBundle } from "@shared/cryptoBundle";

export default function BundleRow({ bundle, testId = "crypto-bundle" }: { bundle: CardBundle | null | undefined; testId?: string }) {
  const unread = !bundle || bundle.state === "unread";
  const text = bundleLine(bundle).replace(/^Launch buying: /, "");
  return (
    <div data-testid={testId} className="flex items-start gap-1.5 text-[11px] leading-snug">
      <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 break-words">
        <span className="font-semibold text-foreground">Launch buying</span>{" "}
        <span className={unread ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>{text}</span>
        {bundle && bundle.state !== "unread" && (
          <span className="text-muted-foreground"> · {bundle.source === "rpc lookup" ? "on-chain lookup" : "our pump.fun listener"}{bundle.state === "partial" && bundle.reason ? ` · ${bundle.reason}` : ""}</span>
        )}
      </div>
    </div>
  );
}
