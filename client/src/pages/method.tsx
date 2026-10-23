/**
 * method.tsx: Method & disclosures (#/method).
 *
 * What a reader who did not build the app needs before using a number from
 * it: what each tab measures, where the data comes from, what the states
 * mean, what the app deliberately does not do, and what is sample in the
 * public edition. Written once, kept with the code, linked from the demo
 * strip and the header. Descriptive; no instruction to trade.
 */
import { Link } from "wouter";
import { useEdition } from "@/lib/useEdition";
import { ArrowLeft } from "lucide-react";

const H = ({ children }: { children: React.ReactNode }) => <h2 className="mt-8 text-base font-semibold tracking-tight">{children}</h2>;
const P = ({ children }: { children: React.ReactNode }) => <p className="mt-2 text-sm leading-6 text-muted-foreground">{children}</p>;
const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)] gap-3 border-t border-border/40 py-2 text-sm">
    <span className="font-mono text-xs uppercase tracking-wider text-foreground">{k}</span>
    <span className="text-muted-foreground">{v}</span>
  </div>
);

export default function MethodPage() {
  const edition = useEdition();
  return (
    <div className="min-h-screen bg-background text-foreground" data-testid="method-page">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Link href="/" className="inline-flex min-h-[44px] items-center gap-1.5 text-sm text-amber-300" data-testid="method-back"><ArrowLeft className="h-4 w-4" /> back to the terminal</Link>
        <h1 className="mt-4 text-2xl font-bold tracking-tight">Method and disclosures</h1>
        <P>Batcave shows what the market's own data says about positioning, flow and cost, and grades its own calls afterwards. It gives no advice, places no orders, and labels every number with where it came from and how fresh it is. This page says exactly what each number is and is not.</P>

        {edition === "demo" && (
          <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200" data-testid="method-demo-note">
            This is the public preview. Every stock and option figure is simulated: the sample market has the shape of a real session but none of its prices. Crypto and news come from real public feeds and carry their own states. Nothing here should be read as a live level.
          </div>
        )}

        <H>What the tabs measure</H>
        <Row k="Today / Signals" v="Spot, the dealer gamma wall above, the gamma flip and the magnet below from the day's option chain; large option prints that lifted the ask or hit the bid; a scan of any ticker: instrument, quote with spread, volume against its 20-session pace, per-name gamma, most active contracts." />
        <Row k="Trade Desk" v="The 0DTE map (dealer gamma per strike, $ per 1% or per point), your own chart levels tagged against it, the setup log and its rule book, releases against the record, and a position sizer that caps size by displayed liquidity." />
        <Row k="Models" v="A composite path projection from option-implied odds. Probabilities shown are risk-neutral and options-implied, labelled as such; they are not the app's forecast." />
        <Row k="Heatseeker / Regime" v="Gamma exposure across strikes and expiries as a heat map and a 3D surface; the regime read (long or short gamma, VIX term, canaries) with the inputs it had and the ones it did not." />
        <Row k="Crypto" v="A launch scanner with coded verdicts and a persistent desk risk state, a community watch of settled tokens with on-chain facts (mint and freeze authority, top-10 holder share), majors from exchange-direct quotes, and an expectancy card that grades the desk's own signals net of pool cost." />
        <Row k="News / Cosmos / Take Five / Edge Lab" v="Context: headlines and feeds, cross-asset reads, a daily brief, and the graded edge loop over past calls." />

        <H>Where the data comes from</H>
        <Row k="Stocks and options" v="Schwab, through the owner's own login, and nothing else: quotes, option chains with open interest and greeks, price history. When Schwab cannot answer, the number is unavailable, never estimated from another source." />
        <Row k="Crypto" v="Public, keyless feeds: GeckoTerminal and DexScreener for pools, Coinbase and Kraken for the majors, public Solana RPC for on-chain facts, rugcheck for named risks. No exchange keys, no paid data." />
        <Row k="Calendar" v="Tier-1 release dates from the agencies' own schedules (BLS, BEA, Federal Reserve), loaded through the end of the year and reported as unknown after that." />

        <H>What the states mean</H>
        <Row k="ok" v="Read in full, inside its refresh window." />
        <Row k="partial" v="Some inputs missing; what is shown is a lower bound, and the chip says what is missing." />
        <Row k="stale" v="Read in full but older than its window; the age is on the chip." />
        <Row k="unavailable" v="The source could not answer. The card keeps its place and names the source." />
        <Row k="no data" v="The source answered and there was nothing to show (no expiry in the window, no contract with volume). Not an error." />
        <Row k="observed zero" v="Collected fully and the count was zero. Different from no data and from a failed read." />
        <Row k="sample" v="Simulated data in the public preview. Never shown as a health state." />

        <H>How the main numbers are computed</H>
        <P><span className="text-foreground">Dealer gamma per strike.</span> Open interest plus a third of the day's volume, each contract's gamma repriced from Schwab's implied volatility, signed on the convention that customers are long calls and short puts (dealers the reverse). The wall above is the largest positive exposure above spot, the magnet below the largest below, the flip the strike where cumulative exposure changes sign. These are exact arithmetic on a stated model; the convention is an assumption, and the method notes say so.</P>
        <P><span className="text-foreground">Flow.</span> A print counts when its premium at observed prices clears the floor, its volume is at least fifteen times open interest or the strike is new, it sits one to three days from expiry, and it was bought at the ask (calls for an up move, puts for a down move). The first scan of a session prices premium at volume times mid and says so.</P>
        <P><span className="text-foreground">Setups.</span> A setup is a stated condition met at an instant: spot at a landmark, the gamma sign the rule needs, a confirming print, a quiet calendar, a session window, a target that clears the modelled cost by three times and the invalidation distance by two. Every one is logged with its rule version and graded afterwards on minute bars with an achievable exit. No grade letter exists until a rule version has one hundred graded setups; before that the log shows counts and says so.</P>
        <P><span className="text-foreground">Cost.</span> For an index or a stock, the quoted spread round trip. For a token, the constant-product impact of the stated size against the pool's depth plus fees, on both legs. A return is always shown net of that.</P>
        <P><span className="text-foreground">Crypto grading.</span> Every signal is graded three ways: when the grader closed the row, at the sampled peak (a ceiling, not an exit), and at the 72-hour horizon mark. Below fifty graded first-signals (one per coin) the card reads counts only and the label is INSUFFICIENT DATA.</P>

        <P><span className="text-foreground">Live verification.</span> Settings → Verify live data, once Schwab is connected, reaches every Schwab-fed panel the way the app does and recomputes the key numbers a second time from the raw chain, quotes and daily bars: 0DTE walls and pin, the Today landmarks and their per-point figures, flow premium and volume over open interest, put/call ratios and the index aggregate, the VIX term ratios, the scan's spread and relative volume. Each check reports pass, fail, stale, unavailable or skipped with the served and recomputed values. It proves the plumbing and the arithmetic of that run, nothing about edge.</P>

        <H>What the app does not do</H>
        <P>It does not recommend, rank by predicted edge, or place orders. It does not show a probability it has not measured. It does not fill a missing input with an assumption and call the result healthy. It does not read dark-pool prints, because its data carries no venue; it measures relative volume, quiet volume and block-sized prints and says so. A score is a heuristic. Fifty graded observations alone do not prove a tradable edge, and passing a historical test does not establish future profitability.</P>

        <H>Disclosures</H>
        <P>Nothing on this site is investment advice or an offer to buy or sell any security or token. Market data is provided by the sources named above under their terms and may be delayed or unavailable. Option and token trading carries substantial risk of loss. The owner may hold positions in instruments shown. Use the data states; when a chip says unavailable, the number is not there.</P>
        <p className="mt-8 font-mono text-[11px] text-muted-foreground">Batcave · edition {edition ?? "unknown"}</p>
      </div>
    </div>
  );
}
