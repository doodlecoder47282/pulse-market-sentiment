# The dealer gamma heatmap: what it computes, what it can and cannot tell a user

Status 2026-10-12. Code: `server/thermalHeatmap.ts` (pure, 15 first-principles
tests in `tests/quant/thermal-heatmap.test.ts`), panel
`client/src/components/ThermalHeatmap.tsx`, help text in `EdgeInfo.tsx`.
Every number on the map comes from one Schwab option-chain response.

## 1. The computation, contract by contract

Inputs per contract from Schwab's `/marketdata/v1/chains`: `openInterest`,
`volatility` (implied vol, percent), `bid`, `ask`, strike, expiry, settlement
style (`SPX` AM-settled, `SPXW` PM-settled), plus the underlying's `last`.

1. **Time to settlement, one clock.** T = calendar minutes to the contract's
   settlement instant / 525,600 (`chainClock.contractYears`). An AM-settled
   SPX contract on its expiry morning has T = 0 after 09:30 and is dropped as
   settled; a PM-settled SPXW at 11:00 still has 300 minutes.
2. **Implied vol for that clock.** Schwab's vol is used as is beyond 3 days;
   inside 3 days it is re-solved from the bid/ask mid so sigma and T agree
   (`chainClock.ivForClock`). A contract with no usable vol (Schwab's -999
   sentinel outside the session, or no quote) is counted, not priced.
3. **Gamma.** Black-Scholes with r = 5%, q = the symbol's dividend yield
   (1.3% for S&P 500 underlyings, 0 otherwise):
   gamma = e^(-qT) phi(d1) / (S sigma sqrt T).
4. **Dollar exposure.** For n contracts of 100 shares:
   - GEX = gamma x n x 100 x S^2 x 0.01: the dollars of delta hedge dealers
     must trade per 1% move in spot.
   - Vanna = (dDelta/dSigma) x 0.01 x n x 100 x S per +1 vol point.
   - Charm = [Delta(T - 1 day) - Delta(T)] x n x 100 x S, spot and vol held.
   - Vomma, zomma: `greekExposure.ts` header.
5. **Dealer sign.** +1 per call contract, -1 per put contract. This is the
   SqueezeMetrics convention ("Call options are sold by investors; bought by
   market-makers. Put options are bought by investors; sold by
   market-makers"). It is a modeled assumption, not observed positioning.
6. **Position = open interest only.** Volume is traded contracts, which may
   open or close positions and does not say who is long. It is shown per cell
   as context and never enters a dollar figure.
7. **Levels.** Call wall = largest positive strike total at or above spot;
   put wall = most negative total at or below spot; gamma flip = the spot
   where the re-priced net GEX of the same contracts crosses zero
   (`gammaProfile.repricedFlipFromChain`, same r, q and clock).

The grid shows strikes within 15% of spot and the 12 nearest expiries. The
payload states all of this (`method`), and the legend prints the unit, the
OI timing, r, q and the contract counts (priced / no OI / settled / no vol).

## 2. How to read it (the physics analogy, used carefully)

Treat dealers' aggregate gamma as the stiffness of a spring attached to
price.

- **Positive (green, dealers long gamma).** Their delta rises as price rises,
  so they sell into strength and buy weakness to stay hedged. That is a
  restoring force: moves tend to be damped, realized volatility tends to run
  below implied, and price tends to oscillate around heavy strikes. The
  "spring constant" is the GEX figure: dollars of hedge per 1% move.
- **Negative (red, dealers short gamma).** Hedging goes with the move: they
  buy as price rises and sell as it falls. That is positive feedback, and the
  published evidence is about exactly this: intraday momentum and larger
  moves when dealer gamma is negative (Barbon and Buraschi, "Gamma
  Fragility"; Baltussen, Da, Lammers and Martens, Journal of Financial
  Economics 2021).
- **The flip** is where the spring constant changes sign. Above it the map
  says "damped"; below it, "amplified".
- **Charm** is the drift of that hedge with time: near expiry, delta decays
  toward 0 or 1 and dealers must trade the difference even if nothing moves.
- **Vanna** couples vol to the hedge: when implied vol falls, dealer delta
  changes and they trade spot. Vomma and zomma are the second-order terms.

Where the analogy stops: a spring has a known constant; here the constant is
an estimate built on an assumed inventory, on open interest that is a day
old, and on Black-Scholes greeks. Cboe's own tagged 0DTE data (which shows
who bought and who sold) found market-maker net gamma small and close to
balanced. The map is a description of the terrain under the assumptions
stated on it, not a forecast.

## 3. Risk management: what the map is for

- It tells a user **what kind of day the structure favours**: damped (long
  gamma, levels hold, fading extremes is the structural tendency) or
  amplified (short gamma, breakouts run, stops get hit). That is a volatility
  regime read, which is what the evidence supports.
- It does **not** give direction, entries, size or targets, and Batcave does
  not derive them from it in the investor edition (no-advice check in
  `tests/quant/no-advice-language.test.ts`).
- The honest professional use is: pair the regime read with the user's own
  risk budget. In a red (short gamma) regime, expected ranges are wider than
  implied vol alone suggests, so the same position carries more risk.

## 4. Quant variables, and the ones we do not have

| Variable | Source | Quality |
|---|---|---|
| Open interest | Schwab chain, OCC figure | Prior close, static all day; today's opens invisible |
| Implied vol | Schwab chain | Live in session; -999 outside it (map shows "cannot be priced") |
| Spot | Schwab underlying.last in the chain | Live, same payload as the chain |
| Greeks | Recomputed, one basis | Consistent across cells, flip, Signals profile |
| Dealer inventory | Assumed (long calls, short puts) | The weakest link; vendors disagree |
| Option trade prints (time and sales, aggressor side) | Not available from Schwab | Institutions use OPRA tick data for this |
| Intraday OI change | Not available anywhere until the next morning | Vendors estimate it from trade data; we do not |

"To the tick" data (Bloomberg, OPRA) would change two things: intraday
positioning from prints (whether the 0DTE wall was built today) and
aggressor-side inference for flow. Neither is available through a retail
broker API; the Whale Flow panel's "AT_ASK" is inferred from quote snapshots
and is labelled a heuristic for that reason.

## 5. Is there enough data, news and modelling to make informed decisions?

Enough for **context and regime**, which is what Batcave claims. Not enough
for **execution-grade signals**, which it does not claim.

- **Market data.** Schwab quotes, chains with greeks and OI, minute bars, and
  the streamer when the Trader API is enabled. Sufficient for levels, gamma
  regime, term structure and realized-vs-implied vol. Missing: option prints
  and intraday OI, so flow is inferred, not observed.
- **News.** Fed, SEC, CFTC, BLS and BEA calendars and releases (official,
  keyless), Dow Jones/CNBC/FT RSS, Reuters via Google News, Nasdaq earnings
  and economic calendars, exchange expiration rules. Sufficient for "what is
  scheduled and what just happened"; it is not a newswire and arrives with
  publisher delay.
- **Models.** The Projected Path band is drawn from a baseline volatility cone
  unless a LightGBM quantile model trained on real Schwab data beats it out of
  sample (promotion gate). The LLM narratives (Anthropic or OpenAI keys) only
  summarise; they never produce a number that feeds a level. Grading exists
  for whale alerts, regime calls and 0DTE contracts, but fifty-odd graded
  observations prove nothing; the gates in `docs/BATCAVE_STATE.md` require
  months of graded history before any claim.
- **Patents and institutional methods.** A search of Google Patents and
  Justia found no granted or published patent claiming a dealer gamma
  heatmap or hedging-exposure computation (CBOE's US 7,401,046 is an option
  display patent; Montal's US 10,803,522 an OI/volume/IV indicator; Options
  AI's US 11,908,007 strategy visualisation). The public method is
  SqueezeMetrics' white paper; SpotGamma and Nomura publish levels without
  full methods. Nothing proprietary is being reproduced here.

## 6. Verification status

- Formulas: 15 tests derive gamma, vanna, charm, vomma, zomma, units, signs,
  walls and the flip independently from d1/d2 and agree with the module to
  1e-6 or better; sentinel and settled contracts are rejected; Signals'
  per-strike profile agrees in sign and value.
- Live Schwab: not verifiable from the development environment (no
  credentials, by design). The demo edition runs the identical code on a
  simulated Schwab-shaped chain and CI checks the route end to end. The
  owner's live check is Settings -> Test Schwab data plus the legend's
  contract counts: "N contracts priced, 0 without an implied vol" during the
  session means every OI contract was priced.

## 7. The 3D surface view (added 2026-10-14)

The grid's "3D" button draws the same payload as a height field:
strikes across, expiries into the depth, signed dollar exposure as height
(`client/src/components/ThermalSurface.tsx`, drawing in
`client/src/lib/surfaceDraw.ts`, geometry in `shared/surfaceProjection.ts`).

- One scale across every date (the grid's per-date shading would misstate
  relative size as height). Height is linear by default; "compressed" is
  sign(v)·|v/max|^0.55 and the title says so.
- Orthographic projection with yaw (rotate) and tilt sliders; quads drawn
  back to front; a missing contract leaves a hole rather than an
  interpolated value. The expiry axis is drawn at 45% of the strike axis so a
  120 x 12 grid is not a ribbon.
- Spot and flip are polylines across the surface at the interpolated strike;
  walls are marked above their tallest node. Axis labels are thinned to a
  36 px pitch and the level labels are laid out as boxes so none overlaps the
  strike labels or each other, at any width.
- Flat far strikes (under 1% of the max across every expiry) are trimmed from
  the footprint and the caption says how many; values are never changed.
- Phones: at least 5 px per strike, the canvas scrolls sideways (like the
  grid) and opens centred on spot. Tap a point to read it; the tooltip gives
  the dollar figure, OI and the share of the surface max.
- Verification: `tests/quant/surface-projection.test.ts` (height scaling,
  every corner inside the canvas across a yaw / tilt / size sweep, painter's
  order, holes, label thinning, picking, trimming, label stacking), plus a
  headless render of the sample chain at 375 / 820 / 1180 px (Chromium,
  `drawSurface` on the demo payload: 15-30 ms per frame) inspected by eye for
  overlap and legibility.

## Sources

- SqueezeMetrics, "Gamma Exposure (GEX)", white paper.
- SpotGamma, "Gamma exposure (GEX)" and "Call wall / put wall explained".
- Cboe, "Volatility insights: evaluating the market impact of SPX 0DTE options".
- Barbon, A. and Buraschi, A., "Gamma Fragility".
- Baltussen, G., Da, Z., Lammers, S., Martens, M., "Hedging demand and market intraday momentum", Journal of Financial Economics 142 (2021) 377-403.
- Ni, S., Pearson, N., Poteshman, A., "Stock price clustering on option expiration dates", Journal of Financial Economics 78 (2005) 49-87.
- Ni, Pearson, Poteshman, White, "Does option trading have a pervasive impact on underlying stock prices?", Review of Financial Studies 34 (2021).
- OptionMetrics, "Dealer gamma exposure and overnight gap risk".
- Options Playbook, "Open interest" (OCC posting timing).
