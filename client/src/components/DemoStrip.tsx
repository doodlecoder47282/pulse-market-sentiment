import { useIsDemo } from "@/lib/useEdition";

/**
 * Always-visible label on the public demo (BATCAVE_EDITION=demo). Sits inside
 * the sticky header. Stocks/options are simulated; public crypto/news adapters
 * retain their separately sourced data and availability states.
 */
export default function DemoStrip() {
  const demo = useIsDemo();
  if (!demo) return null;
  return (
    <div
      role="status"
      data-testid="demo-strip"
      className="border-b border-border bg-muted px-3 py-1 text-center font-mono text-xs uppercase tracking-wider text-foreground"
    >
      <span className="font-semibold">Test preview</span>
      <span> · stocks/options simulated · Schwab off</span>
      <span className="hidden sm:inline"> · crypto/news use separate public feeds · not investment advice</span>
      <a href="#/method" className="ml-2 inline-flex min-h-[24px] items-center underline underline-offset-2" data-testid="demo-strip-method">method &amp; disclosures</a>
    </div>
  );
}
