import { useIsDemo } from "@/lib/useEdition";

/**
 * Always-visible label on the public demo (BATCAVE_EDITION=demo). Sits inside
 * the sticky header so it never scrolls away: every number on the page comes
 * from the simulated market in server/demoMarket.ts, not from Schwab.
 */
export default function DemoStrip() {
  const demo = useIsDemo();
  if (!demo) return null;
  return (
    <div
      role="status"
      data-testid="demo-strip"
      className="border-b border-indigo-400/30 bg-indigo-500/15 px-3 py-1 text-center font-mono text-[11px] uppercase tracking-wider text-indigo-100"
    >
      <span className="font-semibold">Sample data</span>
      <span className="opacity-90"> · simulated market, not real prices</span>
      <span className="hidden opacity-90 sm:inline"> · demo of Batcave · not investment advice</span>
    </div>
  );
}
