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
    what: "A live detector for heavy contracts: $2.5M+ of cumulative day premium (volume x mid) on one contract, 15x volume vs open interest or a brand-new strike, last print at or above the ask, 1\u20133 days to expiry. The chain snapshot has no trade sizes, so a heavy contract can be thousands of small trades \u2014 it is not a block print.",
    how: "Expand a ticker to see each heavy contract's strike, last-print side, and premium. CONFLUX means several heavy contracts on adjacent strikes lean the same way. Side comes from the latest print vs the quote, not from each trade.",
    edge: "Large same-direction premium in contracts that expire in days is worth a look. Treat it as a lead to check against price and positioning, not as proof of informed money.",
    risk: "The last-print side tags the whole day's volume by one print; on the delayed feed the print and quote can be from different moments. A heavy contract can be one leg of a spread or a closing trade. Never size off one contract.",
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
    title: "Signed Tick Volume (1m, SPY)",
    what: "Each 1-minute SPY bar's whole volume signed by its close-to-close change (tick rule): green if the bar closed up, red if down, with a cumulative line. It does not see individual trades or the bid/ask, so it is not Lee-Ready and not order-book imbalance.",
    how: "Read the cumulative slope against price. Rising price + rising cumulative = healthy. Rising price + falling cumulative = the move is running on fumes.",
    edge: "A divergence between the cumulative line and price is a prompt to look closer. Because the sign comes from price itself, this read partly restates price.",
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
    title: "MM Matrix Scorecard",
    what: "Grades every MM-matrix prediction it ever logged (hand-set priors, not a trained ML model) against what actually happened: hit rate, Brier score, skill vs the base rate, a reliability curve, and trend.",
    how: "Skill is measured against always forecasting the base rate (climatology), on one call per session. The red banner fires when that skill is significantly negative (Diebold-Mariano statistic of +2 or more); the amber one when skill is not demonstrated (DM above -2). Brier mixes calibration with sharpness, so \"calibrated\" appears only when the reliability curve passes its stated test (100+ graded forecasts, Spiegelhalter Z, every bin with 10+ forecasts inside its Wilson interval).",
    edge: "Knowing when your model is broken is worth more than the model. Most people size up exactly when their signal decays \u2014 this panel stops that.",
  },
  backtest: {
    title: "Volatility-Band Backtest \u00b7 5Y",
    what: "How often price touched or reversed at volatility bands (ATR x VIX, sigma bands) and a 20-day EMA over five years. These are stand-ins named after dealer levels: the test contains no options data, so it does not measure the live walls or flip.",
    how: "Read the rates as base rates for volatility bands, and compare each row with the baseline rows. Real dealer-level history needs historical option chains, which are not connected.",
    edge: "Base rates keep you honest, but only for what was tested. A band that holds 60% of the time says nothing yet about today's gamma wall.",
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
  "pivot-bands": {
    title: "Pivot Bands",
    what: "Tight, machine-computed pivot zones for the selected expiry \u2014 each band is a weighted center of gamma notional, today's option volume, open interest, and charm, with sub-strike precision instead of a wide strike-to-strike range.",
    how: "Each band has a role. EXHAUST bands are where rallies or flushes run out of fuel \u2014 fade zones once volume dries up. ACCELERANT bands are short-gamma zones \u2014 breaks through them speed up, never fade the first touch. PIN means price gets pulled back. FLIP is the line where the whole tape changes character. FRESH shows how much of the positioning is today's flow versus stale open interest.",
    edge: "Everyone sees the same wide walls. The edge is precision: knowing the exact 3\u20135 point zone where dealer hedging actually kicks in lets you enter closer, stop tighter, and fade or follow with structure instead of vibes.",
    risk: "Bands move as flow updates \u2014 a band that was exhaust in the morning can flip to accelerant after a big print. Re-check before every entry, and volume expansion through a band overrides its label.",
  },
  "trade-environment": {
    title: "Trade Environment",
    what: "One fused 0\u2013100 convexity index built from seven independent reads: dealer gamma posture, the VIX term structure, realized range expansion, order-flow impulse, cross-asset canaries, whale clustering, and wall proximity.",
    how: "Five states. STAND DOWN and CHOP mean no edge \u2014 don't force trades. NORMAL means standard playbook. LOADED means the ingredients for a big move are stacking \u2014 pre-plan both directions and set alerts. STRIKE means convexity is live: short gamma plus expanding range plus directional flow \u2014 the flushes and squeezes happen here.",
    edge: "Most losses come from trading the wrong days. Knowing when NOT to trade \u2014 and being fully ready the moment conditions flip \u2014 is worth more than any single entry signal. The strip tells you which day type you're in before you commit capital.",
    risk: "A quiet score can jump inside one bar on a headline. LOADED is not a trade signal \u2014 it's a readiness signal. Wait for the trigger.",
  },
  "ml-forecast": {
    title: "Projected Path",
    what: "A volatility cone for SPY over the next hour, extended to the close: base, upper and lower paths from a quantile model. The served model was trained on simulated random-walk minutes with random dealer-level features, not real market data, so treat it as a volatility cone (simulated training), not a learned forecast.",
    how: "Read band width as a rough size of the expected range. The lean of the base path and the dealer lines are not learned from real data in this model version. Coverage of the 10\u201390% band on real outcomes has not been verified yet.",
    edge: "None claimed until the model is retrained on real minute bars and logged greeks and its live 10\u201390% coverage is scored. Use the dealer levels and your own read for direction.",
    risk: "Forecasts decay fast after news or a regime break. If price rips through a wall the whole projection re-anchors \u2014 never hold a trade just because the old path said so.",
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
