/**
 * EdgeInfo — tap-friendly "how to use this" button for every data panel.
 * Renders a small info trigger; tapping opens a professional field-manual
 * dialog: what you're looking at, how to use it, and where the human edge is.
 * Copy is written for a normal person — no quant jargon walls.
 */
import { useState } from "react";
import { Info, Eye, Crosshair, Zap, AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type InfoEntry = {
  title: string;
  what: string;
  how: string;
  edge: string;
  risk?: string;
};

const INFO: Record<string, InfoEntry> = {
  "whale-flow": {
    title: "Whale Flow",
    what: "A live detector for surgical options blocks: $2.5M+ premium, 15x volume vs open interest or a brand-new strike, bought at the ask, 1\u20133 days to expiry.",
    how: "Expand a ticker to see each block's strike, side, and premium. CONFLUX means multiple whales hit adjacent strikes in the same direction \u2014 that clustering is the strongest signal on this panel.",
    edge: "Someone paying millions at the ask for contracts that die in days is not hedging casually. Clustered, same-direction whale money tells you where informed conviction sits before price shows it.",
    risk: "A single block can be one leg of a spread. Never size off one print \u2014 wait for the cluster.",
  },
  "tracked-signals": {
    title: "Tracked Signals",
    what: "Every signal you chose to track, grouped per ticker, with live progress against where it triggered.",
    how: "Track a whale or flow hit when it fires, then watch whether it follows through. Close what's done \u2014 keep the list honest.",
    edge: "A written record of what actually worked beats memory. Your own hit-rate log is the fastest way to learn which signals deserve your money.",
  },
  "pc-flow": {
    title: "Put / Call Flow Ratio",
    what: "Put volume divided by call volume, rolling through the session, for the index and the MAG7 names.",
    how: "Above ~1.2 = fear is bid. Below ~0.8 = call chasing. Watch the direction of change more than the level itself.",
    edge: "Flow shifts often front-run price. A falling ratio while price sits flat means calls are being quietly accumulated \u2014 that's a lean before the move.",
  },
  "mag7": {
    title: "MAG 7 Basket",
    what: "An equal-weight basket of the seven mega caps versus SPY, with a breadth count of how many are up or down.",
    how: "Use breadth to see if a move is broad or one name dragging the tape. Compare the basket line against SPY's move.",
    edge: "The index is roughly a third these seven names. When the basket and SPX disagree, the index usually resolves toward the basket \u2014 that divergence is a tell.",
  },
  "spx-chart": {
    title: "SPX Chart + Dealer Levels",
    what: "Live SPX candles with the three dealer levels overlaid: call wall (resistance), put wall (support), gamma flip (the regime line).",
    how: "Above the flip, dealers dampen moves \u2014 fade pushes into the walls. Below the flip they amplify \u2014 respect momentum and don't fade.",
    edge: "Knowing which side of the flip you're on decides whether fading or following is the right trade. Same chart, opposite playbooks.",
  },
  "order-flow": {
    title: "Order Flow \u00b7 Signed Volume",
    what: "Every minute of SPY tape classified as buy pressure (green, hit at the ask) or sell pressure (red, hit at the bid), with a cumulative line.",
    how: "Read the cumulative slope against price. Rising price + rising cumulative = healthy. Rising price + falling cumulative = the move is running on fumes.",
    edge: "Divergence between tape and price leads price. This is the closest thing to watching real money vote in real time.",
    risk: "Overnight and lunch hours print thin \u2014 don't read conviction into low-volume bars.",
  },
  "thermal-heatmap": {
    title: "Thermal \u00b7 Dealer Gamma Map",
    what: "Gamma notional at every strike and expiry date. Green = dealers long gamma (they defend, price stabilizes). Red = short gamma (they chase, moves accelerate). Per-date scale lights each date at its own max.",
    how: "Find the brightest green band near spot \u2014 that's where dealers defend hardest. Bright red below spot is an air pocket. Hover or tap a cell for exact numbers and its % of that date's max.",
    edge: "Price gravitates toward heavy green and slides fast through red. You're reading the terrain before the battle \u2014 most traders only see the price.",
  },
  "heatseeker-map": {
    title: "0DTE Greek Heatmap",
    what: "Live per-strike exposures for today's expiry: gamma, delta, vanna, and charm, refreshed all session.",
    how: "Hide zero-volume strikes to focus. Tap any strike to drill into that contract's live tape and quotes.",
    edge: "0DTE dealers hedge mechanically. The heaviest gamma strike acts like a magnet into the close \u2014 knowing the magnet beats guessing the direction.",
    risk: "Before the session prints, the chain is empty and every score reads zero \u2014 the panel says so instead of faking a rank.",
  },
  "greek-profile": {
    title: "Greek Profile",
    what: "Exposures across strikes drawn as curves: GEX bars, with delta, vanna, and charm overlaid. Dashed lines are your locked targets, solid is spot.",
    how: "Find where GEX flips sign \u2014 that's the battle line. Vanna and charm tell you the drift direction when IV moves or time passes with nothing else happening.",
    edge: "Flip point plus charm drift is the market's autopilot path. When no news hits, price tends to follow that path \u2014 you know the default route.",
  },
  "sticky-zones": {
    title: "Sticky Zones",
    what: "The top five strikes ranked by magnet strength: 50% gamma size, 30% open-interest density, 20% charm acceleration.",
    how: "Expect chop and pinning around ranks #1\u2013#2. Use them as targets and take-profit levels, not as entry signals.",
    edge: "Pin strikes are where premium sellers park size. Fading a stretch away from a heavy pin into expiry is one of the most repeatable 0DTE trades there is.",
  },
  "odte-tracker": {
    title: "Live 0DTE Tracker",
    what: "Live quotes, session volume, and buy/sell classification for strikes within \u00b120 of the money on today's SPX expiry.",
    how: "Tap a row to open that contract's full tape. \"Last trade\" shows exactly when real money last printed \u2014 not just a stale quote.",
    edge: "Yesterday's open interest is old news. Watching where fresh 0DTE money enters intraday shows conviction as it forms, not after.",
  },
  "depth-skew-flow": {
    title: "Depth \u00b7 Skew \u00b7 Flow",
    what: "Three synchronized views: where size sits in the book, what downside protection costs versus upside, and which way net flow leans.",
    how: "Read them together, never alone. Depth = the walls, skew = the fear price, flow = the lean.",
    edge: "When skew steepens while flow stays call-heavy, someone is buying protection on a rally they expect to continue \u2014 that combination rarely shows up in price yet.",
  },
  "ml-accuracy": {
    title: "ML Scorecard",
    what: "The model grades every prediction it ever logged against what actually happened: hit rate, Brier score (calibration), and trend.",
    how: "Brier under 0.22 = usable. Over 0.27 = the model itself tells you it's noise right now \u2014 the red banner fires automatically.",
    edge: "Knowing when your model is broken is worth more than the model. Most people size up exactly when their signal decays \u2014 this panel stops that.",
  },
  backtest: {
    title: "Backtest Accuracy \u00b7 5Y",
    what: "How often each dealer level actually held or got touched over five years of history, split by daily / weekly / monthly horizons.",
    how: "Use the touch and hold rates as base rates when planning trades around walls and flips. It rebuilds itself automatically when stale.",
    edge: "Base rates keep you honest. A wall that holds 60% of the time is a lean, not a law \u2014 size like it.",
  },
  regime: {
    title: "Regime Panel",
    what: "The current market state condensed into one read: gamma sign, VIX term structure, breadth, and what they add up to.",
    how: "The regime picks the playbook. Long gamma = fade extremes back to the middle. Short gamma = ride momentum and don't step in front.",
    edge: "Most losing trades are right ideas in the wrong regime. Check this before every entry \u2014 it's the cheapest edge on the site.",
  },
  canary: {
    title: "Canary Strip",
    what: "An early-warning monitor that compares market internals against price and flags divergences before they resolve.",
    how: "Treat an alarm as a caution flag on new risk \u2014 tighten stops, skip marginal entries. It is not an instant reversal call.",
    edge: "Canaries chirp before the mine floods. This is cheap insurance on every open position \u2014 the cost of listening is zero.",
  },
  "trade-desk": {
    title: "Trade Desk",
    what: "Position sizing, exit rules, and risk gates in one place, driven by the same data feeding every other panel.",
    how: "Enter your setup and let the desk size it by expected value. If the gate score is below threshold, the trade doesn't clear \u2014 that's the point.",
    edge: "One oversized loser erases ten winners. Sizing discipline is the edge that compounds \u2014 the desk exists to enforce it when you won't.",
  },
  "gex-chart": {
    title: "GEX by Strike",
    what: "Net gamma exposure at each strike \u2014 the same force field behind the thermal map, viewed as a single expiry cross-section.",
    how: "Big positive bars = support shelves. Big negative bars = trapdoors. The zero crossing is the gamma flip.",
    edge: "Dealers hedge these bars mechanically. Price respects the big ones far more often than it respects trendlines.",
  },
};

const SECTIONS: Array<{
  key: keyof Pick<InfoEntry, "what" | "how" | "edge">;
  label: string;
  icon: typeof Eye;
  tone: string;
}> = [
  { key: "what", label: "What you're looking at", icon: Eye, tone: "text-sky-400" },
  { key: "how", label: "How to use it", icon: Crosshair, tone: "text-amber-400" },
  { key: "edge", label: "The edge", icon: Zap, tone: "text-emerald-400" },
];

export default function EdgeInfo({ id, className = "" }: { id: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const info = INFO[id];
  if (!info) return null;
  return (
    <>
      <button
        type="button"
        aria-label={`How to use ${info.title}`}
        data-testid={`edgeinfo-${id}`}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen(true);
        }}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/40 text-muted-foreground/70 transition hover:border-border hover:text-foreground active:scale-95 ${className}`}
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-0 overflow-hidden border-slate-700/70 bg-slate-950 p-0 sm:rounded-xl">
          {/* Header band */}
          <div className="border-b border-slate-800 bg-slate-900/60 px-5 py-4">
            <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-slate-500">
              Field Manual
            </div>
            <DialogTitle className="mt-1 text-base font-semibold tracking-tight text-slate-100">
              {info.title}
            </DialogTitle>
          </div>
          {/* Sections */}
          <div className="space-y-4 px-5 py-4">
            {SECTIONS.map((s) => {
              const IconComponent = s.icon;
              return (
                <div key={s.key}>
                  <div className={`mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest ${s.tone}`}>
                    <IconComponent className="h-3 w-3" />
                    {s.label}
                  </div>
                  <p className="text-[13px] leading-relaxed text-slate-300">{info[s.key]}</p>
                </div>
              );
            })}
            {info.risk && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-rose-400">
                  <AlertTriangle className="h-3 w-3" />
                  What breaks it
                </div>
                <p className="text-[13px] leading-relaxed text-slate-300">{info.risk}</p>
              </div>
            )}
          </div>
          {/* Footer */}
          <div className="border-t border-slate-800 bg-slate-900/40 px-5 py-2.5 text-center font-mono text-[9px] uppercase tracking-widest text-slate-600">
            every read is probabilistic · size accordingly
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
